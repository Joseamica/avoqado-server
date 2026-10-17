import type Stripe from 'stripe'
import logger from '@/config/logger'

/**
 * Lo que Stripe de verdad cobrará en la próxima factura de la suscripción: `amount_due` de la vista previa
 * (cupón de campaña, saldo a favor e impuestos ya aplicados). `0` es un monto válido.
 *
 * 🔴 `null` = no se sabe. Quien llama NO anuncia un monto ni recae en el precio de lista (`price.unit_amount`):
 * con una campaña de $10 eso anunciaba $1,158.84.
 */
export async function montoDelSiguienteCobro(stripe: Stripe, subscriptionId: string): Promise<number | null> {
  try {
    const preview = await stripe.invoices.createPreview({ subscription: subscriptionId })
    if (typeof preview.amount_due === 'number') return preview.amount_due
    logger.warn(`siguienteCobro: la vista previa de ${subscriptionId} no trae amount_due`)
  } catch (err) {
    logger.warn(`siguienteCobro: falló la vista previa de ${subscriptionId}`, {
      error: err instanceof Error ? err.message : 'Unknown error',
    })
  }
  return null
}

/** `true` si la suscripción termina sin cobrar al llegar a `finMs` (cancelada al fin del periodo o con `cancel_at` antes). */
export function seCancelaAntesDe(sub: Stripe.Subscription, finMs: number): boolean {
  return sub.cancel_at_period_end === true || (typeof sub.cancel_at === 'number' && sub.cancel_at <= finMs / 1000)
}
