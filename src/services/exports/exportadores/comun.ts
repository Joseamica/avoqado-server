import { BadRequestError } from '@/errors/AppError'
import { parseCsv } from '@/services/dashboard/listSummary.shared'
import type { Bloqueo, Cursor } from './types'

/** Forma concreta del keyset: asignable a `PaymentWhereInput` y a `OrderWhereInput` (los dos modelos tienen `createdAt` e `id`). */
export type WhereKeyset = { OR?: [{ createdAt: { lt: Date } }, { createdAt: Date; id: { lt: string } }] }

/** Keyset descendente: después de (t, id) vienen createdAt < t, o = t con id < id. Sin cursor, nada. */
export function construirWhereKeyset(despuesDe: Cursor | null): WhereKeyset {
  if (!despuesDe) return {}
  const t = new Date(despuesDe.createdAt)
  return { OR: [{ createdAt: { lt: t } }, { createdAt: t, id: { lt: despuesDe.id } }] }
}

/** El 403 de feature-gate de toda la plataforma (forma de `checkFeatureAccess.middleware.ts`), el que mandan los GET viejos. */
export function sinFuncion(featureCode: string): Bloqueo {
  return {
    status: 403,
    body: {
      error: 'Feature not available',
      message: `This venue does not have access to the ${featureCode} feature. Please subscribe to enable this feature.`,
      featureCode,
      subscriptionRequired: true,
    },
  }
}

export const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** Fecha opcional, leída como la lee el servicio (`new Date(s)`): si no es fecha, 400 al pedir y no un pedido que truena después. */
export function fecha(v: unknown, nombre: string): string | undefined {
  const s = str(v)
  if (s && Number.isNaN(new Date(s).getTime())) throw new BadRequestError(`${nombre} must be a valid ISO date string`)
  return s
}

/** Lista de un filtro: arreglo de strings o CSV (los dos llegan del DASHBOARD). */
export const lista = (v: unknown): string[] | undefined =>
  parseCsv(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? v : undefined)
