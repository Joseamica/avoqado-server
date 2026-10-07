import { Prisma, ServiceEarning } from '@prisma/client'
import { createHash } from 'crypto'
import { formatInTimeZone } from 'date-fns-tz'
import prisma from '../../../utils/prismaClient'
import { BadRequestError, ConflictError, NotFoundError } from '../../../errors/AppError'
import { writeLegacyActivityAuditTx } from '../../activityAudit.service'
import { assertPermisoEnSedes, sedesConPermiso, sedesConServicePay, sedesLegiblesDe } from './acceso'
import { COMO_SE_CONSIGUE_EL_PLAN } from './textos'
import { ampliarAlcance, asegurarPeriodo, assertFechaEnRango, bloquearPeriodo, periodoQueContieneFecha } from './periodosGuardados'
import { transaccionConPresupuesto } from '../../../utils/esperaDeCandados'
import { bloquearSedesDeLaOrganizacion, sedesConVentana } from './participacion'
import { enUnaFoto } from './foto'
import { devolucionesPendientes } from './devolucionesPendientes'
import { dbDateComoFecha, fechaComoDbDate, hoyLocal, Periodicidad, periodoQueContiene, sumarMeses } from './periodos'

const TZ_DEFAULT = 'America/Mexico_City'

export interface AjusteManualInput {
  userId: string
  venueId: string
  sede: string
  staffId: string
  amount: number
  reason: string
  fecha?: string
  clientKey: string
  /** Huella del preview (`previewAjusteManual`): fija el periodo destino que vio quien confirmó (Codex R1-10, R2-Nuevo 3). */
  huellaEsperada?: string
  /** Sólo pruebas: el «hoy» del rango de fechas (la ruta y el MCP no lo pasan). */
  ahora?: Date
}
export interface AjusteManualDto {
  id: string
  periodId: string
  periodo: { start: string; end: string }
  staffId: string
  sede: string
  amount: string
  reason: string
  yaExistia: boolean
}

const MAX_MONTO = 1_000_000

function validarForma(input: AjusteManualInput): { monto: Prisma.Decimal; reason: string } {
  if (typeof input.amount !== 'number' || !Number.isFinite(input.amount)) throw new BadRequestError('Monto inválido')
  const monto = new Prisma.Decimal(input.amount)
  if (monto.isZero()) throw new BadRequestError('El monto no puede ser cero')
  if (monto.abs().gt(MAX_MONTO)) throw new BadRequestError('Monto demasiado grande')
  if (monto.decimalPlaces() > 2) throw new BadRequestError('El monto admite hasta 2 decimales')
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  if (reason.length < 3) throw new BadRequestError('Escribe el motivo (mínimo 3 letras)')
  if (reason.length > 300) throw new BadRequestError('Máximo 300 caracteres')
  if (typeof input.clientKey !== 'string' || !/^[A-Za-z0-9_.-]{8,120}$/.test(input.clientKey)) {
    throw new BadRequestError('Clave de solicitud inválida')
  }
  return { monto, reason }
}

/** Huella del EFECTO de un ajuste: a qué periodo cae y qué escribe (Codex R1-10). */
export function huellaDeAjuste(p: {
  start: string
  end: string
  staffId: string
  sede: string
  amount: Prisma.Decimal
  reason: string
}): string {
  return createHash('sha256')
    .update([p.start, p.end, p.staffId, p.sede, p.amount.toFixed(2), p.reason].join('|'))
    .digest('hex')
}

/**
 * full-testing A6: la fecha de un ajuste va de hoy − 12 meses al fin del periodo que contiene hoy (hoy en la zona de la sede).
 * Aceptaba 1900 y 2999 y creaba esos periodos (el de 2999 salía primero en el selector como «Abierto»). Se revisa ANTES de
 * crear ningún periodo, en la vista previa y al confirmar.
 */
function assertFechaDelAjuste(fecha: string, tz: string, periodicidad: Periodicidad, ahora: Date | undefined): void {
  const hoy = hoyLocal(tz, ahora)
  assertFechaEnRango(fecha, { desde: sumarMeses(hoy, -12), hasta: periodoQueContiene(hoy, periodicidad).end }, 'La fecha del ajuste')
}

/**
 * La persona trabaja (o trabajó) en alguna sede de la organización; devuelve su nombre (nunca el de alguien de otro
 * negocio). La comparten el preview y la confirmación.
 */
async function personaDeLaOrg(staffId: string, organizationId: string): Promise<string> {
  const staff = await prisma.staff.findFirst({
    where: { id: staffId, venues: { some: { venue: { organizationId } } } },
    select: { firstName: true, lastName: true },
  })
  if (!staff) throw new BadRequestError('Esa persona no trabaja en este negocio', 'PERSONA_AJENA')
  return `${staff.firstName} ${staff.lastName}`.trim()
}

/** `soloSedes` (B13, revisión de B12 #7): el aviso se acota además a esas sedes (el alcance de una conexión MCP). */
export async function previewAjusteManual(input: Omit<AjusteManualInput, 'clientKey' | 'huellaEsperada'> & { soloSedes?: string[] }) {
  const { monto, reason } = validarForma({ ...input, clientKey: 'preview-sin-clave' })
  const sede = await prisma.venue.findUnique({
    where: { id: input.sede },
    select: { organizationId: true, timezone: true, name: true, organization: { select: { servicePayPeriodicity: true } } },
  })
  const quien = await prisma.venue.findUnique({ where: { id: input.venueId }, select: { organizationId: true } })
  if (!sede || !quien || sede.organizationId !== quien.organizationId) throw new NotFoundError('Sede no encontrada')
  await assertPermisoEnSedes(
    input.userId,
    [input.sede],
    'staffpay:close',
    'Para agregar un ajuste necesitas el permiso de cerrar periodos en esa sede',
  )
  // Nombre y sede en el preview: es lo que el humano revisa antes de autorizar un pago (dos «Ana» en el estudio).
  const persona = await personaDeLaOrg(input.staffId, sede.organizationId)
  const fecha = input.fecha ?? hoyLocal(sede.timezone || TZ_DEFAULT, input.ahora)
  assertFechaDelAjuste(fecha, sede.timezone || TZ_DEFAULT, sede.organization.servicePayPeriodicity, input.ahora)
  // B12 (r6.2, r5.1): el aviso de devoluciones pendientes de esta persona, de las sedes donde quien pregunta tiene
  // `staffpay:read` (las candidatas: con el plan, con historia de pago al personal y la del ajuste), resueltas ANTES; el periodo
  // destino y las pendientes se leen en la MISMA foto.
  const activas = await sedesConServicePay(sede.organizationId)
  const candidatas = [...activas, ...(await sedesConVentana(prisma, sede.organizationId)), input.sede]
  const conexion = input.soloSedes ? new Set(input.soloSedes) : null // ronda 1 (R2): con SUPERADMIN, todas las sedes
  const enAlcance = conexion ? candidatas.filter(v => conexion.has(v)) : candidatas
  const { venueIds: legibles } = await sedesLegiblesDe(input.userId, enAlcance)
  const { fila, avisoPendientes } = await enUnaFoto(async tx => ({
    fila: await periodoQueContieneFecha(tx, sede.organizationId, fecha),
    avisoPendientes: await devolucionesPendientes(tx, { organizationId: sede.organizationId, sedes: legibles, staffId: input.staffId }),
  }))
  // Lo mismo que exigirá `ampliarAlcance` al confirmar: la sede ya está en el alcance guardado o hoy tiene el módulo.
  if (!fila?.venueIds.includes(input.sede) && !activas.includes(input.sede)) {
    throw new BadRequestError(`Esa sede no tiene Pago por servicio en su plan: ${COMO_SE_CONSIGUE_EL_PLAN}.`, 'SEDE_SIN_MODULO')
  }
  const periodo = fila
    ? { start: dbDateComoFecha(fila.periodStart), end: dbDateComoFecha(fila.periodEnd), estado: fila.status }
    : { ...periodoQueContiene(fecha, sede.organization.servicePayPeriodicity), estado: 'OPEN' as const }
  return {
    periodo,
    staffId: input.staffId,
    persona,
    sede: input.sede,
    sedeNombre: sede.name,
    amount: monto.toFixed(2),
    reason,
    huella: huellaDeAjuste({ start: periodo.start, end: periodo.end, staffId: input.staffId, sede: input.sede, amount: monto, reason }),
    /** «Ana tiene −$50 en devoluciones que se descontarán solas al cerrar octubre»: no entra a la huella del ajuste. */
    avisoPendientes,
  }
}

async function aDto(db: Prisma.TransactionClient, e: ServiceEarning, yaExistia: boolean): Promise<AjusteManualDto> {
  const p = await db.servicePayPeriod.findUniqueOrThrow({ where: { id: e.periodId }, select: { periodStart: true, periodEnd: true } })
  return {
    id: e.id,
    periodId: e.periodId,
    periodo: { start: dbDateComoFecha(p.periodStart), end: dbDateComoFecha(p.periodEnd) },
    staffId: e.staffId,
    sede: e.venueId,
    amount: e.amount.toFixed(2),
    reason: e.reason ?? '',
    yaExistia,
  }
}

/**
 * Bono, descuento o corrección libre (spec §6.4 «Ajuste libre»), con el protocolo único (§5): SERIALIZABLE → candado
 * del periodo → releer el periodo dentro → decidir ahí. Un cierre que gana el candado deja el periodo CLOSED y el
 * reintento del bono recibe PERIODO_CERRADO; si gana el bono, el cierre ve otra huella. Nunca queda fuera del recibo.
 */
export async function agregarAjusteManual(input: AjusteManualInput): Promise<AjusteManualDto> {
  const { monto, reason } = validarForma(input)
  const quien = await prisma.venue.findUnique({ where: { id: input.venueId }, select: { organizationId: true } })
  const sede = await prisma.venue.findUnique({
    where: { id: input.sede },
    select: { organizationId: true, timezone: true, name: true, organization: { select: { servicePayPeriodicity: true } } },
  })
  if (!quien || !sede || sede.organizationId !== quien.organizationId) throw new NotFoundError('Sede no encontrada')
  const organizationId = sede.organizationId
  const tz = sede.timezone || TZ_DEFAULT
  await assertPermisoEnSedes(
    input.userId,
    [input.sede],
    'staffpay:close',
    'Para agregar un ajuste necesitas el permiso de cerrar periodos en esa sede',
  )
  const persona = await personaDeLaOrg(input.staffId, organizationId)
  const fecha = input.fecha ?? hoyLocal(tz, input.ahora)
  fechaComoDbDate(fecha) // valida la forma ANTES de compararla como texto con el periodo de un reintento
  assertFechaDelAjuste(fecha, tz, sede.organization.servicePayPeriodicity, input.ahora)
  // Módulos y permisos con el cliente GLOBAL, ANTES de la transacción, como el cierre (Codex bloque A #3): dentro, con el
  // pool lleno, la ganadora del candado esperaría otra conexión mientras las demás esperan su candado. Candidatas: el
  // alcance del periodo como está ahora ∪ las sedes con el módulo ∪ la sede del ajuste. Dentro sólo se COMPARA; una sede
  // que entró al alcance entretanto no tiene permiso resuelto y se niega (conservador).
  const activas = await sedesConServicePay(organizationId)
  const filaAntes = await periodoQueContieneFecha(prisma, organizationId, fecha)
  const permitidas = new Set(
    await sedesConPermiso(input.userId, [...(filaAntes?.venueIds ?? []), ...activas, input.sede], 'staffpay:close'),
  )

  return transaccionConPresupuesto(async (tx, presupuesto) => {
    const previa = await tx.serviceEarning.findFirst({
      where: { clientKey: input.clientKey, organizationId },
      include: { period: { select: { periodStart: true, periodEnd: true } } },
    })
    if (previa) {
      // Un reintento devuelve SU operación; la misma clave con otro contenido —persona, sede, monto, motivo o PERIODO
      // destino— es un error, no el éxito de otra (Codex R1-4 / R2-R1-4: un bono idéntico pedido para septiembre no
      // puede devolver el de agosto). Los periodos no se traslapan: «mismo destino» = su periodo contiene `fecha`.
      const mismoDestino = dbDateComoFecha(previa.period.periodStart) <= fecha && fecha <= dbDateComoFecha(previa.period.periodEnd)
      const igual =
        previa.concept === 'MANUAL' &&
        previa.staffId === input.staffId &&
        previa.venueId === input.sede &&
        previa.amount.equals(monto) &&
        previa.reason === reason &&
        mismoDestino
      if (!igual) throw new ConflictError('Esta solicitud ya se usó para otro ajuste. Vuelve a abrir el formulario.', 'CLAVE_REUTILIZADA')
      return aDto(tx, previa, true)
    }
    const fila = await asegurarPeriodo(tx, organizationId, fecha, presupuesto, activas)
    let p = await bloquearPeriodo(tx, fila.id, presupuesto)
    if (p.status !== 'OPEN') {
      throw new ConflictError('Ese periodo ya está cerrado: agrega el ajuste al periodo abierto', 'PERIODO_CERRADO')
    }
    if (input.huellaEsperada) {
      const h = huellaDeAjuste({
        start: dbDateComoFecha(p.periodStart),
        end: dbDateComoFecha(p.periodEnd),
        staffId: input.staffId,
        sede: input.sede,
        amount: monto,
        reason,
      })
      if (h !== input.huellaEsperada)
        throw new ConflictError('El periodo destino cambió desde la vista previa: revisa de nuevo', 'HUELLA_CAMBIO')
    }
    // D2: la sede de la línea entra al alcance con el módulo activo y permiso de cerrar en TODA la unión (Codex R2-R1-9).
    p = await ampliarAlcance(tx, p, [input.sede], input.userId, { activas, permitidas })
    // B9 (r7.1): la fila de la sede en `FOR KEY SHARE` (periodo → sede) y revalidar que sigue siendo de la organización,
    // aunque ya esté en el alcance: un borrado o un traslado que ganó la fila no deja $50 en una sede que ya no es suya.
    await bloquearSedesDeLaOrganizacion(tx, organizationId, [input.sede], presupuesto)
    const ahoraLocal = formatInTimeZone(new Date(), tz, 'yyyy-MM-dd HH:mm')
    const e = await tx.serviceEarning.create({
      data: {
        organizationId,
        venueId: input.sede,
        periodId: p.id,
        staffId: input.staffId,
        concept: 'MANUAL',
        amount: monto,
        reason,
        // Fecha y hora LOCALES (Codex R1-24): el recibo no puede leer `createdAt` en UTC y fecharlo al día siguiente.
        // El nombre visible de la persona: su recibo abre aunque la borren (spec fase 3 §6.1, Codex r1-17).
        descriptor: { motivo: reason, sede: sede.name, persona, fecha: ahoraLocal.slice(0, 10), hora: ahoraLocal.slice(11) },
        clientKey: input.clientKey,
        createdById: input.userId,
      },
    })
    await writeLegacyActivityAuditTx(tx, {
      staffId: input.userId,
      venueId: input.sede,
      action: 'SERVICE_PAY_MANUAL_ADJUSTMENT',
      entity: 'ServiceEarning',
      entityId: e.id,
      data: { periodId: p.id, staffId: input.staffId, amount: monto.toFixed(2), motivo: reason },
    })
    return aDto(tx, e, false)
  })
}
