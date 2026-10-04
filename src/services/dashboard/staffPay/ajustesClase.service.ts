import { ClassSessionPayState, Prisma } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { BadRequestError, NotFoundError } from '../../../errors/AppError'
import { withSerializableRetry } from '../../../utils/serializableRetry'
import { writeLegacyActivityAuditTx } from '../../activityAudit.service'
import { venueDayKey } from '../../../utils/venueDateKeys'
import { exigirPermisoEnSedes, sedesConPermiso } from './acceso'
import { origenDeClase } from './diferencias.service'
import { dbDateComoFecha } from './periodos'
import { bloquearPeriodo, lockClase, lockPeriodosDeOrganizacion, periodoQueContieneFecha } from './periodosGuardados'
import { valorarClases } from './valoracion'

export interface AjusteDeClase {
  payCountOverride: number | null
  payAmountOverride: string | null
  payExcluded: boolean
  reason: string | null
  at: Date | null
}

/** Una línea ya contabilizada de la clase (spec §6.6): su devengo, el periodo donde quedó y si su recibo se pagó. */
export interface LineaContabilizada {
  concepto: 'SERVICE' | 'RECONCILE'
  staffId: string
  staffName: string
  monto: string
  periodo: { start: string; end: string }
  pagadoEn: string | null
}

export interface PagoDeClase {
  classSessionId: string
  estado: 'OK' | 'EXCLUIDA' | 'EXCEPCION' | 'NO_TERMINADA' | 'CANCELADA'
  motivo: string | null
  monto: string | null
  conteo: number | null
  conteoCalculado: number | null
  maxCount: number | null
  countMode: string | null
  staffName: string | null
  payLevelName: string | null
  ajuste: AjusteDeClase | null
  anclada: boolean
  /** Sin ancla, ya terminada, no cancelada y su fecha cae en un periodo CERRADO: se paga como diferencia de ése (spec §6.4). */
  llegoTarde: boolean
  /** El periodo donde la clase se contabilizó por primera vez (su ancla), o null si aún no. */
  periodoOrigen: { id: string; start: string; end: string; estado: 'OPEN' | 'CLOSED' } | null
  lineas: LineaContabilizada[]
}

export interface GuardarAjusteInput {
  venueId: string
  classSessionId: string
  payCountOverride: number | null
  payAmountOverride: number | null
  payExcluded: boolean
  reason: string
  actorId: string
}

const MAX_CONTEO = 500
const MAX_MONTO = 1_000_000

const tieneAjuste = (p: ClassSessionPayState | null): p is ClassSessionPayState =>
  !!p && (p.payCountOverride !== null || p.payAmountOverride !== null || p.payExcluded)

/** Lo que la auditoría guarda de un ajuste: null cuando la clase va por el cálculo. */
function resumenDeAjuste(p: { payCountOverride: number | null; payAmountOverride: Prisma.Decimal | null; payExcluded: boolean } | null) {
  if (!p || (p.payCountOverride === null && p.payAmountOverride === null && !p.payExcluded)) return null
  return { payCountOverride: p.payCountOverride, payAmountOverride: p.payAmountOverride?.toFixed(2) ?? null, payExcluded: p.payExcluded }
}

/**
 * Revalida la forma aunque la ruta ya pase por Zod: el MCP (Tarea 11) llamará a este service sin la ruta.
 * Devuelve el motivo recortado.
 */
function validarForma(input: GuardarAjusteInput): string {
  const c = input.payCountOverride
  if (c !== null && (typeof c !== 'number' || !Number.isInteger(c) || c < 0 || c > MAX_CONTEO)) {
    throw new BadRequestError(`El conteo debe ser un número entero entre 0 y ${MAX_CONTEO}`)
  }
  const m = input.payAmountOverride
  if (m !== null && (typeof m !== 'number' || !Number.isFinite(m) || m < 0 || m > MAX_MONTO)) {
    throw new BadRequestError('El monto debe ser un número entre 0 y 1,000,000')
  }
  if (typeof input.payExcluded !== 'boolean') throw new BadRequestError('Excluir: valor inválido (sí o no)')
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  if (reason.length < 3) throw new BadRequestError('Escribe el motivo (mínimo 3 letras)')
  if (reason.length > 300) throw new BadRequestError('Máximo 300 caracteres')
  return reason
}

async function lineasDeClase(
  db: Prisma.TransactionClient | typeof prisma,
  organizationId: string,
  classSessionId: string,
): Promise<LineaContabilizada[]> {
  const es = await db.serviceEarning.findMany({
    where: { organizationId, sourceType: 'CLASS_SESSION', sourceId: classSessionId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 100,
    include: { period: { select: { periodStart: true, periodEnd: true } } },
  })
  if (!es.length) return []
  const staffIds = [...new Set(es.map(e => e.staffId))]
  const staff = await db.staff.findMany({
    where: { id: { in: staffIds } },
    select: { id: true, firstName: true, lastName: true },
    take: staffIds.length,
  })
  const recibos = await db.staffPayStatement.findMany({
    where: { period: { organizationId }, OR: es.map(e => ({ periodId: e.periodId, staffId: e.staffId })) },
    select: { periodId: true, staffId: true, paidAt: true },
    take: es.length,
  })
  const nombre = new Map(staff.map(s => [s.id, `${s.firstName} ${s.lastName}`.trim()]))
  const pagado = new Map(recibos.map(r => [`${r.periodId}:${r.staffId}`, r.paidAt]))
  return es.map(e => ({
    concepto: e.concept as 'SERVICE' | 'RECONCILE',
    staffId: e.staffId,
    staffName: nombre.get(e.staffId) ?? '—',
    monto: e.amount.toFixed(2),
    periodo: { start: dbDateComoFecha(e.period.periodStart), end: dbDateComoFecha(e.period.periodEnd) },
    pagadoEn: pagado.get(`${e.periodId}:${e.staffId}`)?.toISOString() ?? null,
  }))
}

/**
 * Tarjeta de pago de UNA clase (spec §6.1). La clase se busca por id Y sede: nunca se lee la de otra sede.
 * Usa la misma valoración que el reporte; los estados NO_TERMINADA y CANCELADA son sólo de la tarjeta.
 */
export async function pagoDeClase(
  venueId: string,
  classSessionId: string,
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<PagoDeClase> {
  const cs = await db.classSession.findFirst({
    where: { id: classSessionId, venueId },
    select: {
      id: true,
      startsAt: true,
      endsAt: true,
      status: true,
      venue: { select: { organizationId: true, timezone: true } },
      payState: true,
    },
  })
  if (!cs) throw new NotFoundError('Clase no encontrada')
  const ps = cs.payState
  const ajuste: AjusteDeClase | null = tieneAjuste(ps)
    ? {
        payCountOverride: ps.payCountOverride,
        payAmountOverride: ps.payAmountOverride?.toFixed(2) ?? null,
        payExcluded: ps.payExcluded,
        reason: ps.overrideReason,
        at: ps.overrideAt,
      }
    : null
  const origen = ps?.originPeriodId
    ? await db.servicePayPeriod.findFirst({
        where: { id: ps.originPeriodId, organizationId: cs.venue.organizationId },
        select: { id: true, periodStart: true, periodEnd: true, status: true },
      })
    : null
  const periodoOrigen = origen
    ? { id: origen.id, start: dbDateComoFecha(origen.periodStart), end: dbDateComoFecha(origen.periodEnd), estado: origen.status }
    : null
  const lineas = origen ? await lineasDeClase(db, cs.venue.organizationId, cs.id) : []
  const ahora = new Date()
  const llegoTarde = !ps?.originPeriodId && cs.status !== 'CANCELLED' && !!(await origenDeClase(db, venueId, cs, ahora))
  const base = {
    classSessionId: cs.id,
    motivo: null,
    monto: null,
    conteo: null,
    conteoCalculado: null,
    maxCount: null,
    countMode: null,
    staffName: null,
    payLevelName: null,
    ajuste,
    anclada: !!ps?.originPeriodId,
    llegoTarde,
    periodoOrigen,
    lineas,
  }
  if (cs.status === 'CANCELLED') return { ...base, estado: 'CANCELADA' }
  if (cs.endsAt > ahora) return { ...base, estado: 'NO_TERMINADA' }
  const [v] = await valorarClases(
    db,
    {
      venueId,
      organizationId: cs.venue.organizationId,
      tz: cs.venue.timezone || 'America/Mexico_City',
      desde: new Date(cs.startsAt.getTime() - 1),
      hasta: new Date(cs.startsAt.getTime() + 1),
      ahora,
      claseIds: [cs.id],
      // Una clase anclada se valora con su ancla (spec §5.4): «lo que corresponde hoy» con la versión y fecha congeladas.
      ...(origen ? { modo: 'periodo' as const, periodId: origen.id } : {}),
    },
    { limite: 1 },
  )
  if (!v) return { ...base, estado: 'EXCEPCION', motivo: 'SIN_TABLA' }
  return {
    ...base,
    estado: v.estado,
    motivo: v.motivo,
    monto: v.monto !== null ? new Prisma.Decimal(v.monto).toFixed(2) : null,
    conteo: v.conteo,
    conteoCalculado: v.conteoCalculado,
    maxCount: v.maxCount,
    countMode: v.countMode,
    staffName: v.staffName,
    payLevelName: v.payLevelName,
  }
}

/**
 * Corregir conteo / ajustar monto / excluir una clase (spec §5.4), con el protocolo único de escritura (spec §5):
 * transacción serializable con reintento → candado del PERIODO (el de origen si la clase está anclada; si no, el que
 * contiene su fecha, o el de periodos de la organización si aún no existe) → candado de la CLASE (el mismo de la
 * liquidación) y su fila → releer el ancla DENTRO. Si está anclada, corregirla pide `staffpay:close` en su sede, y lo
 * congelado nunca se toca: sólo cambia «lo que corresponde hoy». ActivityLog DENTRO con el antes y el después. Mandar
 * los tres en null/false quita el ajuste y la clase vuelve al cálculo.
 */
export async function guardarAjusteDeClase(input: GuardarAjusteInput): Promise<PagoDeClase> {
  // El permiso con el cliente GLOBAL, ANTES de la transacción (como el cierre y marcar pagado, A8): dentro sólo se compara.
  const permitidas = new Set(await sedesConPermiso(input.actorId, [input.venueId], 'staffpay:close'))
  return withSerializableRetry(async tx => {
    // Primero la sede: a otra sede se le contesta «no encontrada» antes de revisar nada más.
    const info = await tx.classSession.findFirst({
      where: { id: input.classSessionId, venueId: input.venueId },
      select: {
        startsAt: true,
        venue: { select: { organizationId: true, timezone: true } },
        payState: { select: { originPeriodId: true } },
      },
    })
    if (!info) throw new NotFoundError('Clase no encontrada')
    const reason = validarForma(input)
    // 1) Periodo primero (spec §5): el de origen si está anclada; si no, el que contiene su fecha, si ya existe.
    const fechaLocal = venueDayKey(info.startsAt, info.venue.timezone || 'America/Mexico_City')
    const periodo = info.payState?.originPeriodId ?? (await periodoQueContieneFecha(tx, info.venue.organizationId, fechaLocal))?.id
    // Si todavía no existe, el candado de periodos de la organización: un cierre que lo está creando lo tiene hasta su
    // commit, así que el ajuste lo espera en vez de cruzarse con él (Codex R1-6: sin esto, ajuste y cierre podían
    // bloquearse mutuamente sobre ClassSession / ClassSessionPayState, y 40P01 no se reintenta).
    if (periodo) await bloquearPeriodo(tx, periodo)
    else await lockPeriodosDeOrganizacion(tx, info.venue.organizationId)
    // 2) Luego la clase: el candado compartido con la liquidación, y su fila. `FOR NO KEY UPDATE`: serializa las ediciones
    // de la clase sin chocar con el `FOR KEY SHARE` de la llave foránea cuando el cierre la ancla (misma familia que el periodo).
    await lockClase(tx, input.classSessionId)
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM "ClassSession" WHERE id = ${input.classSessionId} AND "venueId" = ${input.venueId} FOR NO KEY UPDATE`,
    )
    // 3) Releer el ancla DENTRO: si un cierre ganó la carrera, el reintento la ve y exige staffpay:close.
    const antes = await tx.classSessionPayState.findUnique({ where: { classSessionId: input.classSessionId } })
    if (antes?.originPeriodId) {
      exigirPermisoEnSedes(permitidas, [input.venueId], 'Esta clase ya se contabilizó: corregirla necesita el permiso de cerrar periodos')
    }
    // Sólo los campos del ajuste: el ancla (originPeriodId, valuationDate, valuationVersionId) nunca se toca aquí.
    const datos = {
      payCountOverride: input.payCountOverride,
      payAmountOverride: input.payAmountOverride === null ? null : new Prisma.Decimal(input.payAmountOverride),
      payExcluded: input.payExcluded,
      overrideReason: reason,
      overrideById: input.actorId,
      overrideAt: new Date(),
    }
    await tx.classSessionPayState.upsert({
      where: { classSessionId: input.classSessionId },
      create: { classSessionId: input.classSessionId, ...datos },
      update: datos,
    })
    await writeLegacyActivityAuditTx(tx, {
      staffId: input.actorId,
      venueId: input.venueId,
      action: 'SERVICE_PAY_CLASS_ADJUSTED',
      entity: 'ClassSession',
      entityId: input.classSessionId,
      data: { antes: resumenDeAjuste(antes), despues: resumenDeAjuste(datos), motivo: reason },
    })
    return pagoDeClase(input.venueId, input.classSessionId, tx)
  })
}
