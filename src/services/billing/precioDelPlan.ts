import type Stripe from 'stripe'
import AppError from '../../errors/AppError'
import logger from '../../config/logger'
import { stripe, STRIPE_DENTRO_DEL_CANDADO, planLookupKey, stripeAfirmaQueNoExiste, type PlanTierCode } from '../stripe.service'
import { precioDeLaOferta, versionQueCobra, type PlanPagado } from './planOffer'

export const MENSAJE_PLAN_NO_CONFIGURADO =
  'No pudimos activar tu plan por un problema nuestro de configuración. No se te cobró nada. Escríbenos y lo resolvemos.'

/**
 * B0, tal cual: el precio de Stripe de un plan por su LLAVE (`plan_pro_monthly`…). Sin precio: el 503 `PLAN_NOT_CONFIGURED`
 * del alta. Es el camino de hoy sin versiones o con sólo la v1, y la relectura de quien verificó por la llave.
 */
export async function resolverPrecioPorLlave(
  tierCode: PlanTierCode,
  interval: 'monthly' | 'annual',
): Promise<{ priceId: string; unitAmount: number }> {
  const lookupKey = planLookupKey(tierCode, interval)
  // 🔴 Corre bajo el candado de la regla común (Codex C3): tiempo propio y sin reintentos del SDK.
  const prices = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 }, STRIPE_DENTRO_DEL_CANDADO)
  const price = prices.data[0]
  if (!price) {
    logger.error('🚨 resolverPrecioDelPlan: no hay precio de Stripe para la llave — NO se cobra', { lookupKey, tierCode })
    throw new AppError(MENSAJE_PLAN_NO_CONFIGURADO, 503, true, 'PLAN_NOT_CONFIGURED', { tierCode })
  }
  return { priceId: price.id, unitAmount: price.unit_amount ?? 0 }
}

/**
 * Resuelve UNA vez el precio de Stripe de un plan para que quien cobra lo haga con ese `priceId` y no lo vuelva a buscar.
 *
 * - **Sin una versión publicada por el editor** (tablas vacías o sólo la v1, que es una foto de lo de hoy): por la llave,
 *   exactamente como B0 (`resolverPrecioPorLlave`).
 * - **Con ella** (`versionQueCobra()`): el `priceId` de su ranura, leído con `prices.retrieve`. Se exige `active` y que el
 *   monto sea el bruto de la versión; si no, o si Stripe dice que no existe (404), 503 `PLAN_NOT_CONFIGURED`: no se cobra
 *   un precio que no es el publicado. Otro error de Stripe (tiempo agotado, 5xx) sube tal cual, como el de la llave.
 */
export async function resolverPrecioDelPlan(
  tierCode: PlanTierCode,
  interval: 'monthly' | 'annual',
): Promise<{ priceId: string; unitAmount: number }> {
  const version = await versionQueCobra()
  if (!version) return resolverPrecioPorLlave(tierCode, interval)

  const tier: PlanPagado = tierCode === 'PLAN_PREMIUM' ? 'PREMIUM' : 'PRO'
  const ranura = precioDeLaOferta(version.definition, tier, interval)
  const noConfigurado = (motivo: string, stripeAmount: number | null) => {
    // 🚨 a propósito: la versión vigente apunta a un precio de Stripe que no sirve para cobrar.
    logger.error('🚨 resolverPrecioDelPlan: el precio de la versión vigente no sirve para cobrar — NO se cobra', {
      tierCode,
      interval,
      versionId: version.versionId,
      number: version.number,
      priceId: ranura.stripePriceId,
      esperado: ranura.grossCents,
      stripe: stripeAmount,
      motivo,
    })
    return new AppError(MENSAJE_PLAN_NO_CONFIGURADO, 503, true, 'PLAN_NOT_CONFIGURED', { tierCode })
  }
  if (!ranura.stripePriceId) throw noConfigurado('SIN_PRECIO', null)

  let price: Stripe.Price
  try {
    // 🔴 Mismo trato que la llave: bajo el candado de la regla común, tiempo propio y sin reintentos del SDK.
    price = await stripe.prices.retrieve(ranura.stripePriceId, STRIPE_DENTRO_DEL_CANDADO)
  } catch (error) {
    if (stripeAfirmaQueNoExiste(error)) throw noConfigurado('NO_EXISTE', null)
    throw error
  }
  if (!price.active) throw noConfigurado('INACTIVO', price.unit_amount ?? null)
  if (price.unit_amount !== ranura.grossCents) throw noConfigurado('OTRO_MONTO', price.unit_amount ?? null)
  return { priceId: ranura.stripePriceId, unitAmount: ranura.grossCents }
}
