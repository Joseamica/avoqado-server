import AppError from '../../errors/AppError'
import logger from '../../config/logger'
import { stripe, STRIPE_DENTRO_DEL_CANDADO, planLookupKey, type PlanTierCode } from '../stripe.service'

export const MENSAJE_PLAN_NO_CONFIGURADO =
  'No pudimos activar tu plan por un problema nuestro de configuración. No se te cobró nada. Escríbenos y lo resolvemos.'

/**
 * Resuelve UNA vez el precio de Stripe de un plan (por su llave) para que quien cobra lo haga con ese `priceId`
 * y no vuelva a listar la llave después. Sin precio: el mismo 503 `PLAN_NOT_CONFIGURED` del alta.
 */
export async function resolverPrecioDelPlan(
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
