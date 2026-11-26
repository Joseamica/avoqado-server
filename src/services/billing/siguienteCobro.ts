import type Stripe from 'stripe'
import logger from '@/config/logger'

/**
 * Lo que Stripe de verdad cobrará en la próxima factura de la suscripción: `amount_due` de la vista previa
 * (cupón de campaña, saldo a favor e impuestos ya aplicados). `0` es un monto válido.
 *
 * 🔴 `null` = no se sabe. Quien llama NO anuncia un monto ni recae en el precio de lista (`price.unit_amount`):
 * con una campaña de $10 eso anunciaba $1,158.84.
 */
export async function montoDelSiguienteCobro(
  stripe: Stripe,
  subscriptionId: string,
  /**
   * Planes editables (B2, Task 7): las opciones de la lectura. «Tu plan» la acota (`LECTURA_ACOTADA`: sólo informa y la espera una
   * respuesta); sin ellas, la llamada de siempre (los recordatorios y el aviso de Stripe).
   */
  opciones?: Stripe.RequestOptions,
): Promise<number | null> {
  try {
    const preview = opciones
      ? await stripe.invoices.createPreview({ subscription: subscriptionId }, opciones)
      : await stripe.invoices.createPreview({ subscription: subscriptionId })
    if (typeof preview.amount_due === 'number') return preview.amount_due
    logger.warn(`siguienteCobro: la vista previa de ${subscriptionId} no trae amount_due`)
  } catch (err) {
    // 🔴 Stripe no da vista previa de una prueba sin método con `missing_payment_method: cancel` (`invoice_upcoming_none`, visto con
    // Stripe de pruebas el 26-nov): sin este respaldo, la prueba sin tarjeta nunca tenía monto y «Tu plan» nunca ofrecía «Poner mi tarjeta».
    if ((err as { code?: unknown } | null)?.code === 'invoice_upcoming_none') {
      const monto = await montoDeLaPruebaSinMetodo(stripe, subscriptionId, opciones)
      if (monto !== null) return monto
    }
    logger.warn(`siguienteCobro: falló la vista previa de ${subscriptionId}`, {
      error: err instanceof Error ? err.message : 'Unknown error',
    })
  }
  return null
}

/**
 * Lo que se cobrará en cuanto la prueba sin tarjeta del alta (B2, `metadata.sinTarjeta`) tenga tarjeta: la vista previa de una
 * suscripción NUEVA del mismo cliente (su saldo y sus cupones) con los mismos renglones y los descuentos propios de la suscripción (p. ej.
 * la oferta de retención). Sólo para esa prueba viva que terminaría cancelada por no tener método; si ya no se cobrará (cancelada, con
 * cancelación programada o con la cobranza en pausa) o no es la prueba sin tarjeta del alta, `null`: no se inventa un cobro.
 * ponytail: sin tasas de impuesto propias (los planes llevan el IVA dentro del precio); si un día las llevan, `default_tax_rates`.
 */
async function montoDeLaPruebaSinMetodo(stripe: Stripe, subscriptionId: string, opciones?: Stripe.RequestOptions): Promise<number | null> {
  try {
    const sub = opciones
      ? await stripe.subscriptions.retrieve(subscriptionId, opciones)
      : await stripe.subscriptions.retrieve(subscriptionId)
    const seCancelaSinMetodo = sub.trial_settings?.end_behavior?.missing_payment_method === 'cancel'
    const esLaPruebaSinTarjeta = sub.metadata?.sinTarjeta === 'true'
    if (
      sub.status !== 'trialing' ||
      !seCancelaSinMetodo ||
      !esLaPruebaSinTarjeta ||
      sub.cancel_at_period_end ||
      sub.cancel_at ||
      pausaDe(sub)
    )
      return null
    const customer = typeof sub.customer === 'string' ? sub.customer : sub.customer.id
    const descuentos = (sub.discounts ?? []).map(d => ({ discount: typeof d === 'string' ? d : d.id }))
    const params = {
      customer,
      subscription_details: { items: sub.items.data.map(i => ({ price: i.price.id, quantity: i.quantity ?? 1 })) },
      ...(descuentos.length > 0 ? { discounts: descuentos } : {}),
    }
    const preview = opciones ? await stripe.invoices.createPreview(params, opciones) : await stripe.invoices.createPreview(params)
    return typeof preview.amount_due === 'number' ? preview.amount_due : null
  } catch (err) {
    logger.warn(`siguienteCobro: falló la vista previa de respaldo de ${subscriptionId}`, {
      error: err instanceof Error ? err.message : 'Unknown error',
    })
    return null
  }
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
