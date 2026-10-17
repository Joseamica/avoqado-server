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

/**
 * 🔴 Codex N3: la pausa de cobranza vigente de una suscripción. Una pausa SIN `resumes_at` (indefinida) cuenta como
 * vigente: es la más peligrosa de todas, no la más inocente.
 */
export function pausaDe(sub: Stripe.Subscription): Date | null {
  const pausa = (sub as unknown as { pause_collection?: { resumes_at?: number | null } | null }).pause_collection
  if (!pausa) return null
  return pausa.resumes_at ? new Date(pausa.resumes_at * 1000) : new Date(8640000000000000)
}

/**
 * `true` si al llegar a `finMs` NO se cobrará: cancelada al fin del periodo, con `cancel_at` antes, o con la cobranza en
 * pausa (la oferta de retención, `mark_uncollectible`) que no se reanuda antes de esa fecha.
 */
export function noHabraCobro(sub: Stripe.Subscription, finMs: number): boolean {
  const pausadaHasta = pausaDe(sub)
  return (
    sub.cancel_at_period_end === true ||
    (typeof sub.cancel_at === 'number' && sub.cancel_at <= finMs / 1000) ||
    (pausadaHasta !== null && pausadaHasta.getTime() >= finMs)
  )
}
