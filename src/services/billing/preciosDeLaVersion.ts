/**
 * Precios de Stripe de una versión de la oferta (B1, Task 5).
 *
 * Crea o recupera el precio de UNA ranura (plan × periodicidad). No escribe en la base: quien llama guarda el
 * `priceId` y el `intento`. Nunca se llama bajo `plan-offer-publish` (ninguna llamada a Stripe ocurre con ese candado).
 */
import type Stripe from 'stripe'
import { stripe } from '@/services/stripe.service'
import type { Periodicidad, PlanPagado, Ranura } from './planOffer'

const OPCIONES_DE_STRIPE = { timeout: 15_000, maxNetworkRetries: 0 }

export type MotivoDePreparacion = 'INCIERTO' | 'RECHAZADO' | 'NO_COINCIDE' | 'DUPLICADO'

export class ErrorDePreparacion extends Error {
  motivo: MotivoDePreparacion
  ranura: Ranura
  stripeCode?: string
  constructor(motivo: MotivoDePreparacion, ranura: Ranura, message: string, stripeCode?: string) {
    super(message)
    this.name = 'ErrorDePreparacion'
    this.motivo = motivo
    this.ranura = ranura
    this.stripeCode = stripeCode
  }
}

function partes(ranura: Ranura): { tier: PlanPagado; interval: Periodicidad } {
  const [tier, interval] = ranura.split(':') as [PlanPagado, Periodicidad]
  return { tier, interval }
}

export function llaveDeBusqueda(versionId: string, ranura: Ranura): string {
  const { tier, interval } = partes(ranura)
  return `po_${versionId}_${tier.toLowerCase()}_${interval}`
}

export function llaveDeIdempotencia(versionId: string, ranura: Ranura, intento: number): string {
  const { tier, interval } = partes(ranura)
  return `plan-offer-price:${versionId}:${tier}:${interval}:${intento}`
}

function statusDe(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const s = (error as { statusCode?: unknown }).statusCode
  return typeof s === 'number' ? s : undefined
}

/** Lo desconocido es incierto: sólo un 4xx conocido es un rechazo definitivo. */
export function clasificarErrorDeStripe(error: unknown): 'INCIERTO' | 'DEFINITIVO' {
  const status = statusDe(error)
  if (status === undefined) return 'INCIERTO'
  return [400, 401, 402, 403, 404].includes(status) ? 'DEFINITIVO' : 'INCIERTO'
}

function deError(error: unknown, ranura: Ranura): ErrorDePreparacion {
  if (error instanceof ErrorDePreparacion) return error
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  const stripeCode = typeof code === 'string' ? code : undefined
  const motivo = clasificarErrorDeStripe(error) === 'DEFINITIVO' ? 'RECHAZADO' : 'INCIERTO'
  return new ErrorDePreparacion(
    motivo,
    ranura,
    `Stripe ${motivo === 'RECHAZADO' ? 'rechazó' : 'no confirmó'} el precio de ${ranura}.`,
    stripeCode,
  )
}

function validar(price: Stripe.Price, a: { versionId: string; ranura: Ranura; grossCents: number; productId: string }): void {
  const { tier, interval } = partes(a.ranura)
  const producto = typeof price.product === 'string' ? price.product : price.product?.id
  const md = price.metadata ?? {}
  const ok =
    price.active === true &&
    price.unit_amount === a.grossCents &&
    price.currency === 'mxn' &&
    price.tax_behavior === 'inclusive' &&
    price.recurring?.interval === (interval === 'monthly' ? 'month' : 'year') &&
    price.recurring?.interval_count === 1 &&
    producto === a.productId &&
    price.lookup_key === llaveDeBusqueda(a.versionId, a.ranura) &&
    md.kind === 'PLAN_OFFER_PRICE' &&
    md.planOfferVersionId === a.versionId &&
    md.tier === tier &&
    md.interval === interval
  if (!ok) throw new ErrorDePreparacion('NO_COINCIDE', a.ranura, `El precio de Stripe de ${a.ranura} no coincide con la versión.`)
}

export async function asegurarPrecioDeLaRanura(args: {
  versionId: string
  ranura: Ranura
  grossCents: number
  productId: string
  intento: number
}): Promise<{ priceId: string }> {
  const { versionId, ranura, grossCents, productId, intento } = args
  const { tier, interval } = partes(ranura)
  const lookupKey = llaveDeBusqueda(versionId, ranura)

  let found: Stripe.ApiList<Stripe.Price>
  try {
    found = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 2 }, OPCIONES_DE_STRIPE)
  } catch (error) {
    throw deError(error, ranura)
  }
  if (found.has_more || found.data.length > 1) {
    throw new ErrorDePreparacion('DUPLICADO', ranura, `Hay más de un precio con la llave ${lookupKey}.`)
  }

  let price: Stripe.Price | undefined = found.data[0]
  if (!price) {
    try {
      price = await stripe.prices.create(
        {
          product: productId,
          lookup_key: lookupKey,
          currency: 'mxn',
          unit_amount: grossCents,
          tax_behavior: 'inclusive',
          recurring: { interval: interval === 'monthly' ? 'month' : 'year', interval_count: 1 },
          metadata: { kind: 'PLAN_OFFER_PRICE', planOfferVersionId: versionId, tier, interval },
        },
        { ...OPCIONES_DE_STRIPE, idempotencyKey: llaveDeIdempotencia(versionId, ranura, intento) },
      )
    } catch (error) {
      throw deError(error, ranura)
    }
  }
  validar(price, { versionId, ranura, grossCents, productId })
  return { priceId: price.id }
}
