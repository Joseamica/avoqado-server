import { Prisma } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { BadRequestError, ConflictError, NotFoundError } from '../../../errors/AppError'
import { writeLegacyActivityAuditTx } from '../../activityAudit.service'
import { assertPermisoEnTodasLasSedes, sedesConServicePay } from './acceso'
import { bloquearOrganizacion, bloquearSedesDeLaOrganizacion } from './participacion'
import { lockPeriodosDeOrganizacion, periodoQueContieneFecha } from './periodosGuardados'
import { transaccionConPresupuesto } from '../../../utils/esperaDeCandados'
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
 * `inicioEsperado`: la fecha que el dueño vio en la vista previa; si bajo el candado sale otra (pasó la medianoche del
 * cambio de periodo), 409 INICIO_CAMBIO sin escribir: la fecha ya no se cambia después (Codex bloque B #3). B14-fix F5
 * (Codex participación r1 #5) y su ronda 1 (R1): «hoy» se calcula DESPUÉS de tomar los TRES candados, como `activarSede` (B11):
 * calculado antes, una confirmación del 30-sep a las 23:59:59 que obtiene un candado el 1-oct conservaba septiembre y abría las
 * ventanas desde el 1-sep (también esperando la fila de la organización, que un traslado retiene sin el candado de periodos).
 *
 * B9 (diseño r6.1, r6.6.2) + B11 (r3.3): al activar de verdad abre una ventana `[startDate, ∞)` por cada sede ELEGIDA
 * (`sedes`; sin ellas, todas las que hoy tienen el plan, resueltas antes de la transacción con el mismo resolver del
 * cierre). Elegidas: al menos una (400 FALTA_SEDE), todas de la organización (404) y con el plan hoy (409 SEDE_SIN_PLAN).
 * Las demás no reciben ventana: se activan después, sede por sede, con su fecha. Candados: el de periodos de la
 * organización → su fila → cada sede (`FOR KEY SHARE`, revalidando que siga siendo de la organización), todos con el
 * presupuesto de la transacción. Si un traslado ganó la sede, 409 SEDE_EN_OTRA_ORGANIZACION completo: no se salta.
 */
export async function activarPagoAlPersonal(input: {
  userId: string
  venueId: string
  periodicidad: Periodicidad
  inicioEsperado?: string
  sedes?: string[]
  ahora?: Date
}): Promise<{ startDate: string; yaActivado: boolean }> {
  if (input.periodicidad !== 'MONTHLY' && input.periodicidad !== 'SEMIMONTHLY') throw new BadRequestError('Elige mensual o quincenal')
  const v = await prisma.venue.findUniqueOrThrow({ where: { id: input.venueId }, select: { organizationId: true, timezone: true } })
  await assertPermisoEnTodasLasSedes(input.userId, v.organizationId, 'staffpay:close')
  // Con el cliente GLOBAL, antes de la transacción (como el cierre): dentro sólo se bloquean y se revalidan.
  const sedes = await sedesElegidas(v.organizationId, input.sedes)
  return transaccionConPresupuesto(async (tx, presupuesto) => {
    // Candados en el orden de siempre: periodos de la organización → su fila → cada sede.
    await lockPeriodosDeOrganizacion(tx, v.organizationId, presupuesto)
    await bloquearOrganizacion(tx, v.organizationId, presupuesto)
    const org = await tx.organization.findUniqueOrThrow({
      where: { id: v.organizationId },
      select: { staffPayStartDate: true, servicePayPeriodicity: true },
    })
    if (org.staffPayStartDate) return { startDate: dbDateComoFecha(org.staffPayStartDate), yaActivado: true }
    if (org.servicePayPeriodicity !== input.periodicidad && (await hayPeriodos(tx, v.organizationId))) {
      throw new ConflictError(
        'La periodicidad ya no se puede cambiar: ya hay periodos guardados. Activa con la que ya tienes.',
        'PERIODICIDAD_FIJA',
      )
    }
    await bloquearSedesDeLaOrganizacion(tx, v.organizationId, sedes, presupuesto)
    // F5 + ronda 1 (R1): el día DESPUÉS de los TRES candados (cada reintento los vuelve a tomar), como `activarSede`. Un traslado
    // retiene la fila de la organización sin el candado de periodos: calculado antes de ella, una espera que cruza la medianoche
    // activaba desde el mes anterior. `ahora`, sólo pruebas.
    const hoy = hoyLocal(v.timezone || TZ_DEFAULT, input.ahora ?? new Date())
    const startDate = await inicioAlActivar(tx, v.organizationId, hoy, input.periodicidad)
    if (input.inicioEsperado !== undefined && input.inicioEsperado !== startDate)
      throw new ConflictError('La fecha de inicio cambió; vuelve a revisar.', 'INICIO_CAMBIO')
    await tx.organization.update({
      where: { id: v.organizationId },
      data: { staffPayStartDate: fechaComoDbDate(startDate), servicePayPeriodicity: input.periodicidad },
    })
    if (sedes.length) {
      await tx.staffPayVenueWindow.createMany({
        data: sedes.map(venueId => ({
          organizationId: v.organizationId,
          venueId,
          desde: fechaComoDbDate(startDate),
          activadaPor: input.userId,
        })),
      })
    }
    await writeLegacyActivityAuditTx(tx, {
      staffId: input.userId,
      venueId: input.venueId,
      action: 'SERVICE_PAY_ACTIVATED',
      entity: 'Organization',
      entityId: v.organizationId,
      data: { startDate, periodicidad: input.periodicidad, periodicidadAntes: org.servicePayPeriodicity, sedes },
    })
    return { startDate, yaActivado: false }
  })
}

/**
 * Las sedes que reciben ventana al activar (B11, r3.3): las elegidas —al menos una, todas de la organización y con el plan
 * hoy— o, sin elegir, todas las que tienen el plan (lo de B9). Ordenadas y sin repetidos.
 */
async function sedesElegidas(organizationId: string, elegidas: string[] | undefined): Promise<string[]> {
  const activas = [...new Set(await sedesConServicePay(organizationId))].sort()
  if (elegidas === undefined) return activas
  const pedidas = [...new Set(elegidas)].sort()
  if (!pedidas.length) throw new BadRequestError('Elige al menos una sede para activar', 'FALTA_SEDE')
  const sinPlan = pedidas.filter(id => !activas.includes(id))
  if (sinPlan.length) {
    const deLaOrg = await prisma.venue.findMany({
      where: { id: { in: sinPlan }, organizationId },
      select: { id: true, name: true },
      orderBy: { id: 'asc' },
      take: sinPlan.length,
    })
    if (deLaOrg.length !== sinPlan.length) throw new NotFoundError('Sede no encontrada')
    const nombres = deLaOrg.map(x => x.name).join(', ')
    throw new ConflictError(
      `${deLaOrg.length === 1 ? 'La sede' : 'Las sedes'} ${nombres} no ${deLaOrg.length === 1 ? 'tiene' : 'tienen'} Pago al personal en su plan: contrátalo para activarla`,
      'SEDE_SIN_PLAN',
      { venueIds: sinPlan },
    )
  }
  return pedidas
}

/** Las sedes de la organización con y sin el plan, para la vista previa de activar (MCP): los nombres, con tope. */
export async function sedesParaActivar(organizationId: string): Promise<{
  conPlan: Array<{ venueId: string; nombre: string }>
  sinPlan: Array<{ venueId: string; nombre: string }>
  sinPlanTotal: number
}> {
  const activas = [...new Set(await sedesConServicePay(organizationId))].sort()
  const nombre = (x: { id: string; name: string }) => ({ venueId: x.id, nombre: x.name })
  const [conPlan, sinPlan, sinPlanTotal] = await Promise.all([
    prisma.venue.findMany({
      where: { id: { in: activas }, organizationId },
      select: { id: true, name: true },
      orderBy: { id: 'asc' },
      take: activas.length,
    }),
    prisma.venue.findMany({
      where: { organizationId, id: { notIn: activas } },
      select: { id: true, name: true },
      orderBy: { id: 'asc' },
      take: TOPE_SIN_PLAN,
    }),
    prisma.venue.count({ where: { organizationId, id: { notIn: activas } } }),
  ])
  return { conPlan: conPlan.map(nombre), sinPlan: sinPlan.map(nombre), sinPlanTotal }
}
/** Cuántas sedes SIN plan nombra la vista previa (el total va aparte: nunca se esconde cuántas hay). */
const TOPE_SIN_PLAN = 50

/** Con periodos guardados la periodicidad ya no cambia (D3 de la fase 2). */
async function hayPeriodos(db: Db, organizationId: string): Promise<boolean> {
  return (await db.servicePayPeriod.count({ where: { organizationId } })) > 0
}

/**
 * El inicio del periodo ABIERTO hoy (spec §7.1). Si el que contiene «hoy» ya se cerró (otra sede, más al oeste, fuera de
 * su alcance), se empieza el día siguiente a su fin: el siguiente cierre nunca barre lo que ya se cerró.
 */
async function inicioAlActivar(db: Db, organizationId: string, hoy: string, periodicidad: Periodicidad): Promise<string> {
  const fila = await periodoQueContieneFecha(db, organizationId, hoy)
  if (!fila) return periodoQueContiene(hoy, periodicidad).start
  return fila.status === 'CLOSED' ? diaCivilSiguiente(dbDateComoFecha(fila.periodEnd)) : dbDateComoFecha(fila.periodStart)
}

/**
 * Lo que haría «activar» hoy, sin escribir ni tomar candados (vista previa del MCP, B6 ronda 1): la periodicidad guardada,
 * si ya es fija y el inicio que tendría con la pedida. Misma regla que `activarPagoAlPersonal`, que la vuelve a revisar
 * bajo candado al confirmar. B9 (r6.4): la periodicidad es fija con periodos guardados O ya activado.
 */
export async function previewActivacion(input: {
  venueId: string
  periodicidad: Periodicidad
  ahora?: Date
}): Promise<{ periodicidad: Periodicidad; periodicidadFija: boolean; startDate: string }> {
  const v = await prisma.venue.findUniqueOrThrow({ where: { id: input.venueId }, select: { organizationId: true, timezone: true } })
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: v.organizationId },
    select: { servicePayPeriodicity: true, staffPayStartDate: true },
  })
  const hoy = hoyLocal(v.timezone || TZ_DEFAULT, input.ahora)
  return {
    periodicidad: org.servicePayPeriodicity,
    periodicidadFija: org.staffPayStartDate !== null || (await hayPeriodos(prisma, v.organizationId)),
    startDate: await inicioAlActivar(prisma, v.organizationId, hoy, input.periodicidad),
  }
}

/**
 * Interruptor «Pagar las propinas en el recibo» (spec fase 3 §6.3, §7.1, D2): prender abre una ventana [ahora, ∞);
 * apagar cierra la abierta en `ahora`. Lo que ya ganó el derecho a entrar no se pierde (Codex r1-5). Repetir el estado
 * actual no escribe ni audita. Mismo permiso y candado que activar. B14-fix F5 (hermano): `ahora` es el instante en que se
 * OBTIENE el candado, no el de la petición: dos cambios se escriben en el orden del candado, nunca con un instante anterior al
 * del cambio que ya confirmó (una ventana que empezara antes de que la otra cerrara).
 */
export async function cambiarPropinas(input: {
  userId: string
  venueId: string
  encender: boolean
  ahora?: Date
}): Promise<{ encendidas: boolean; cambio: boolean }> {
  if (typeof input.encender !== 'boolean') throw new BadRequestError('Indica si las propinas se pagan en el recibo')
  const v = await prisma.venue.findUniqueOrThrow({ where: { id: input.venueId }, select: { organizationId: true } })
  await assertPermisoEnTodasLasSedes(input.userId, v.organizationId, 'staffpay:close')
  return transaccionConPresupuesto(async (tx, presupuesto) => {
    await lockPeriodosDeOrganizacion(tx, v.organizationId, presupuesto)
    const ahora = input.ahora ?? new Date() // F5: bajo el candado (cada reintento lo vuelve a tomar); `input.ahora`, sólo pruebas
    const org = await tx.organization.findUniqueOrThrow({ where: { id: v.organizationId }, select: { staffPayStartDate: true } })
    if (!org.staffPayStartDate) throw new ConflictError('Activa primero el pago al personal', 'NO_ACTIVADO')
    const abierta = await tx.staffPayTipWindow.findFirst({
      where: { organizationId: v.organizationId, endsAt: null },
      select: { id: true, startsAt: true },
    })
    // `cambio`: el MCP audita sólo lo que de verdad cambió (otra persona pudo hacerlo entre la vista previa y el confirmar).
    if (input.encender === (abierta !== null)) return { encendidas: input.encender, cambio: false }
    if (abierta) {
      // El reloj de otra instancia puede ir atrás: nunca antes del inicio (CHECK StaffPayTipWindow_rango). Queda una ventana
      // vacía [inicio, inicio), que no pesca nada.
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
    return { encendidas: input.encender, cambio: true }
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
