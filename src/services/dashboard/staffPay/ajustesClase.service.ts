import { ClassSessionPayState, Prisma } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { BadRequestError, NotFoundError } from '../../../errors/AppError'
import { withSerializableRetry } from '../../../utils/serializableRetry'
import { writeLegacyActivityAuditTx } from '../../activityAudit.service'
import { valorarClases } from './valoracion'

export interface AjusteDeClase {
  payCountOverride: number | null
  payAmountOverride: string | null
  payExcluded: boolean
  reason: string | null
  at: Date | null
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
  }
  if (cs.status === 'CANCELLED') return { ...base, estado: 'CANCELADA' }
  const ahora = new Date()
  if (cs.endsAt > ahora) return { ...base, estado: 'NO_TERMINADA' }
  // Fase 2: una clase anclada se lee de su devengo congelado y de su valoración con el ancla.
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
 * transacción serializable con reintento, candado de la fila de la clase (filtrada por sede) y ActivityLog DENTRO
 * de la transacción con el antes y el después. Mandar los tres en null/false quita el ajuste y la clase vuelve al
 * cálculo. En la fase 1 no hay periodos ni anclas, así que el candado de la clase es todo el protocolo.
 */
export async function guardarAjusteDeClase(input: GuardarAjusteInput): Promise<PagoDeClase> {
  return withSerializableRetry(async tx => {
    // Primero la sede: a otra sede se le contesta «no encontrada» antes de revisar nada más.
    const cs = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM "ClassSession" WHERE id = ${input.classSessionId} AND "venueId" = ${input.venueId} FOR UPDATE`)
    if (cs.length === 0) throw new NotFoundError('Clase no encontrada')
    const reason = validarForma(input)
    const antes = await tx.classSessionPayState.findUnique({ where: { classSessionId: input.classSessionId } })
    // Fase 2 (protocolo único, spec §5): si `antes?.originPeriodId` existe, exigir staffpay:close aquí dentro.
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
