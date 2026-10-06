import { Prisma } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { BadRequestError, ConflictError } from '../../../errors/AppError'
import { withSerializableRetry } from '../../../utils/serializableRetry'
import { writeLegacyActivityAuditTx } from '../../activityAudit.service'
import { assertPermisoEnTodasLasSedes } from './acceso'
import { lockPeriodosDeOrganizacion, periodoQueContieneFecha } from './periodosGuardados'
import { dbDateComoFecha, diaCivilSiguiente, fechaComoDbDate, hoyLocal, Periodicidad, periodoQueContiene } from './periodos'

type Db = Prisma.TransactionClient | typeof prisma
const TZ_DEFAULT = 'America/Mexico_City'

/** ¿Está activado pago al personal, desde cuándo, y van hoy las propinas en el recibo? (spec fase 3 §7.1, §10). */
export async function estadoActivacion(
  db: Db,
  organizationId: string,
): Promise<{ activado: boolean; startDate: string | null; propinasEncendidas: boolean }> {
  const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { staffPayStartDate: true } })
  const abierta = await db.staffPayTipWindow.findFirst({ where: { organizationId, endsAt: null }, select: { id: true } })
  return {
    activado: org.staffPayStartDate !== null,
    startDate: org.staffPayStartDate ? dbDateComoFecha(org.staffPayStartDate) : null,
    propinasEncendidas: abierta !== null,
  }
}

/**
 * «Activar pago al personal» (spec fase 3 §7.1, Codex r1-9): fija `staffPayStartDate` = inicio civil del periodo abierto
 * HOY (zona de la sede que lo pide) y la periodicidad que confirmó el dueño, también la mensual de fábrica. Exige
 * `staffpay:close` en todas las sedes; candado de periodos de la organización (como `cambiarPeriodicidad`). Idempotente:
 * activado ya, devuelve su fecha y no cambia nada. Con periodos guardados la periodicidad ya no cambia (D3 de la fase 2).
 */
export async function activarPagoAlPersonal(input: {
  userId: string
  venueId: string
  periodicidad: Periodicidad
  ahora?: Date
}): Promise<{ startDate: string; yaActivado: boolean }> {
  if (input.periodicidad !== 'MONTHLY' && input.periodicidad !== 'SEMIMONTHLY') throw new BadRequestError('Elige mensual o quincenal')
  const v = await prisma.venue.findUniqueOrThrow({ where: { id: input.venueId }, select: { organizationId: true, timezone: true } })
  await assertPermisoEnTodasLasSedes(input.userId, v.organizationId, 'staffpay:close')
  const hoy = hoyLocal(v.timezone || TZ_DEFAULT, input.ahora)
  return withSerializableRetry(async tx => {
    await lockPeriodosDeOrganizacion(tx, v.organizationId)
    const org = await tx.organization.findUniqueOrThrow({
      where: { id: v.organizationId },
      select: { staffPayStartDate: true, servicePayPeriodicity: true },
    })
    if (org.staffPayStartDate) return { startDate: dbDateComoFecha(org.staffPayStartDate), yaActivado: true }
    if (
      org.servicePayPeriodicity !== input.periodicidad &&
      (await tx.servicePayPeriod.count({ where: { organizationId: v.organizationId } })) > 0
    ) {
      throw new ConflictError(
        'La periodicidad ya no se puede cambiar: ya hay periodos guardados. Activa con la que ya tienes.',
        'PERIODICIDAD_FIJA',
      )
    }
    // El inicio del periodo ABIERTO (spec §7.1). Si el que contiene «hoy» ya se cerró (otra sede, más al oeste, fuera de
    // su alcance), se empieza el día siguiente a su fin: el siguiente cierre nunca barre lo que ya se cerró.
    const fila = await periodoQueContieneFecha(tx, v.organizationId, hoy)
    const startDate = !fila
      ? periodoQueContiene(hoy, input.periodicidad).start
      : fila.status === 'CLOSED'
        ? diaCivilSiguiente(dbDateComoFecha(fila.periodEnd))
        : dbDateComoFecha(fila.periodStart)
    await tx.organization.update({
      where: { id: v.organizationId },
      data: { staffPayStartDate: fechaComoDbDate(startDate), servicePayPeriodicity: input.periodicidad },
    })
    await writeLegacyActivityAuditTx(tx, {
      staffId: input.userId,
      venueId: input.venueId,
      action: 'SERVICE_PAY_ACTIVATED',
      entity: 'Organization',
      entityId: v.organizationId,
      data: { startDate, periodicidad: input.periodicidad, periodicidadAntes: org.servicePayPeriodicity },
    })
    return { startDate, yaActivado: false }
  })
}

/**
 * Interruptor «Pagar las propinas en el recibo» (spec fase 3 §6.3, §7.1, D2): prender abre una ventana [ahora, ∞);
 * apagar cierra la abierta en `ahora`. Lo que ya ganó el derecho a entrar no se pierde (Codex r1-5). Repetir el estado
 * actual no escribe ni audita. Mismo permiso y candado que activar.
 */
export async function cambiarPropinas(input: {
  userId: string
  venueId: string
  encender: boolean
  ahora?: Date
}): Promise<{ encendidas: boolean }> {
  if (typeof input.encender !== 'boolean') throw new BadRequestError('Indica si las propinas se pagan en el recibo')
  const v = await prisma.venue.findUniqueOrThrow({ where: { id: input.venueId }, select: { organizationId: true } })
  await assertPermisoEnTodasLasSedes(input.userId, v.organizationId, 'staffpay:close')
  const ahora = input.ahora ?? new Date()
  return withSerializableRetry(async tx => {
    await lockPeriodosDeOrganizacion(tx, v.organizationId)
    const org = await tx.organization.findUniqueOrThrow({ where: { id: v.organizationId }, select: { staffPayStartDate: true } })
    if (!org.staffPayStartDate) throw new ConflictError('Activa primero el pago al personal', 'NO_ACTIVADO')
    const abierta = await tx.staffPayTipWindow.findFirst({
      where: { organizationId: v.organizationId, endsAt: null },
      select: { id: true, startsAt: true },
    })
    if (input.encender === (abierta !== null)) return { encendidas: input.encender }
    if (abierta) {
      // `ahora` se fija antes de la tx (lo reusa cada reintento) y el reloj de otra instancia puede ir atrás: nunca antes
      // del inicio (CHECK StaffPayTipWindow_rango). Queda una ventana vacía [inicio, inicio), que no pesca nada.
      const endsAt = ahora < abierta.startsAt ? abierta.startsAt : ahora
      await tx.staffPayTipWindow.update({ where: { id: abierta.id }, data: { endsAt, endedById: input.userId } })
    } else {
      await tx.staffPayTipWindow.create({ data: { organizationId: v.organizationId, startsAt: ahora, startedById: input.userId } })
    }
    await writeLegacyActivityAuditTx(tx, {
      staffId: input.userId,
      venueId: input.venueId,
      action: 'SERVICE_PAY_TIPS_SET',
      entity: 'Organization',
      entityId: v.organizationId,
      data: { antes: abierta !== null, despues: input.encender, en: ahora.toISOString() },
    })
    return { encendidas: input.encender }
  })
}

/** Las últimas ventanas del interruptor, la más nueva primero (para que el MCP y la pantalla digan desde cuándo). */
export async function ventanasDePropinas(organizationId: string, limite = 20): Promise<Array<{ desde: string; hasta: string | null }>> {
  const vs = await prisma.staffPayTipWindow.findMany({
    where: { organizationId },
    select: { startsAt: true, endsAt: true },
    orderBy: { startsAt: 'desc' },
    take: Number.isInteger(limite) ? Math.min(Math.max(limite, 1), 100) : 20,
  })
  return vs.map(x => ({ desde: x.startsAt.toISOString(), hasta: x.endsAt?.toISOString() ?? null }))
}
