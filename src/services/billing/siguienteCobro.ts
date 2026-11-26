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
 * suscripción NUEVA del mismo cliente (su saldo y sus cupones) con los mismos renglones y los CUPONES de los descuentos propios de la
 * suscripción (p. ej. la oferta de retención; Stripe rechaza el `di_…` de otra suscripción en una vista previa, visto el 26-nov). Sólo para
 * esa prueba viva que terminaría cancelada por no tener método; si al terminar no se cobrará (`noHabraCobro`: cancelada, con cancelación o
 * pausa que llega al fin) o no es la prueba sin tarjeta del alta, `null`: no se inventa un cobro.
 * 🔴 La vista previa hipotética no sabe de la suscripción real: si en medio alguien la cancela o le cambia el descuento (Codex b2-mac r1 #4 y
 * r2 #2), se relee DESPUÉS de la vista previa y el monto sólo vale si la prueba sigue igual. Lo que pase después de esa relectura es la
 * misma carrera que tiene la vista previa clásica entre leer y avisar.
 * ponytail: sin tasas de impuesto propias (los planes llevan el IVA dentro del precio); si un día las llevan, `default_tax_rates`.
 */
async function montoDeLaPruebaSinMetodo(stripe: Stripe, subscriptionId: string, opciones?: Stripe.RequestOptions): Promise<number | null> {
  try {
    const leer = () => {
      const conDescuentos = { expand: ['discounts'] }
      return opciones
        ? stripe.subscriptions.retrieve(subscriptionId, conDescuentos, opciones)
        : stripe.subscriptions.retrieve(subscriptionId, conDescuentos)
    }
    const sub = await leer()
    const cupones = cuponesSiSeCobrara(sub)
    if (cupones === null) return null
    const customer = typeof sub.customer === 'string' ? sub.customer : sub.customer.id
    const params = {
      customer,
      subscription_details: { items: sub.items.data.map(i => ({ price: i.price.id, quantity: i.quantity ?? 1 })) },
      ...(cupones.length > 0 ? { discounts: cupones.map(coupon => ({ coupon })) } : {}),
    }
    const preview = opciones ? await stripe.invoices.createPreview(params, opciones) : await stripe.invoices.createPreview(params)
    if (typeof preview.amount_due !== 'number') return null
    const despues = await leer()
    const igual = JSON.stringify(cuponesSiSeCobrara(despues)) === JSON.stringify(cupones) && despues.trial_end === sub.trial_end
    return igual ? preview.amount_due : null
  } catch (err) {
    logger.warn(`siguienteCobro: falló la vista previa de respaldo de ${subscriptionId}`, {
      error: err instanceof Error ? err.message : 'Unknown error',
    })
    return null
  }
}

/**
 * Los cupones de la prueba sin tarjeta del alta (B2) si al terminar se cobrará con tarjeta; `null` si no es esa prueba, si ya no se cobrará
 * (cancelada, con cancelación o pausa que llega al fin) o si un descuento no se puede leer («no se sabe», nunca el precio sin él).
 */
function cuponesSiSeCobrara(sub: Stripe.Subscription): string[] | null {
  const seCancelaSinMetodo = sub.trial_settings?.end_behavior?.missing_payment_method === 'cancel'
  const esLaPruebaSinTarjeta = sub.metadata?.sinTarjeta === 'true'
  if (sub.status !== 'trialing' || !seCancelaSinMetodo || !esLaPruebaSinTarjeta || !sub.trial_end) return null
  if (noHabraCobro(sub, sub.trial_end * 1000)) return null
  // Codex b2-mac r3 #1: sólo los descuentos que siguen vigentes en el primer cobro (al fin de la prueba); uno que vence antes no se cobra.
  const fin = sub.trial_end
  const venceAntes = (d: unknown) => {
    const end = typeof d === 'object' && d !== null ? (d as { end?: number | null }).end : undefined
    return typeof end === 'number' && end <= fin
  }
  const cupones = (sub.discounts ?? []).filter(d => !venceAntes(d)).map(cuponDelDescuento)
  return cupones.every((c): c is string => c !== null) ? cupones : null
}

/** El cupón de un descuento expandido: `source.coupon` (API clover) o `coupon` (la de antes); `null` si no se puede leer. */
function cuponDelDescuento(d: unknown): string | null {
  const x = d as { coupon?: string | { id?: string } | null; source?: { coupon?: string | { id?: string } | null } | null } | string | null
  if (!x || typeof x === 'string') return null
  const c = x.source?.coupon ?? x.coupon
  return typeof c === 'string' ? c : (c?.id ?? null)
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
