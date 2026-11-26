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
 * 🔴 Codex b2-mac r4 #2: la suscripción se lee con la versión basil de la API, la única que conserva los términos de un cupón que
 * Operaciones retiró en Stripe (`coupon.valid: false`, con su `percent_off` o `amount_off`); en clover ese descuento sólo trae el id,
 * que ya no existe. Medido con Stripe de pruebas el 26-nov. Sólo cambia la forma del descuento: lo demás que se lee aquí es igual.
 * ponytail: si Stripe deja ver en clover los términos de un cupón retirado, se quita.
 */
const VERSION_CON_TERMINOS_DEL_CUPON = '2025-08-27.basil'

/**
 * Lo que se cobrará en cuanto la prueba sin tarjeta del alta (B2, `metadata.sinTarjeta`) tenga tarjeta: la vista previa de una
 * suscripción NUEVA del mismo cliente (su saldo y sus cupones) con los mismos renglones y los CUPONES de los descuentos propios de la
 * suscripción (p. ej. la oferta de retención; Stripe rechaza el `di_…` de otra suscripción en una vista previa, visto el 26-nov). Sólo para
 * esa prueba viva que terminaría cancelada por no tener método; si al terminar no se cobrará (`noHabraCobro`: cancelada, con cancelación o
 * pausa que llega al fin) o no es la prueba sin tarjeta del alta, `null`: no se inventa un cobro.
 * Un cupón RETIRADO sigue descontando, pero ya no se puede aplicar en una vista previa («No such coupon»): su descuento se resta del
 * subtotal de una vista previa sin descuentos, redondeado como Stripe (medio centavo hacia arriba, medido el 26-nov), antes del saldo.
 * 🔴 La vista previa hipotética no sabe de la suscripción real: si en medio alguien la cancela o le cambia el descuento (Codex b2-mac r1 #4 y
 * r2 #2), se relee DESPUÉS de la vista previa y el monto sólo vale si la prueba sigue igual. Lo que pase después de esa relectura es la
 * misma carrera que tiene la vista previa clásica entre leer y avisar.
 * ponytail: sin tasas de impuesto propias (los planes llevan el IVA dentro del precio); si un día las llevan, `default_tax_rates`.
 */
async function montoDeLaPruebaSinMetodo(stripe: Stripe, subscriptionId: string, opciones?: Stripe.RequestOptions): Promise<number | null> {
  try {
    const leer = () =>
      stripe.subscriptions.retrieve(subscriptionId, { expand: ['discounts'] }, { ...opciones, apiVersion: VERSION_CON_TERMINOS_DEL_CUPON })
    const sub = await leer()
    const plan = descuentosSiSeCobrara(sub)
    if (plan === null) return null
    const customer = typeof sub.customer === 'string' ? sub.customer : sub.customer.id
    const params = {
      customer,
      subscription_details: { items: sub.items.data.map(i => ({ price: i.price.id, quantity: i.quantity ?? 1 })) },
      // Con un retirado, sin descuentos (cadena vacía: tampoco el del cliente, que no aplica sobre el de la suscripción).
      ...(plan.retirado
        ? { discounts: '' as const }
        : plan.cupones.length > 0
          ? { discounts: plan.cupones.map(coupon => ({ coupon })) }
          : {}),
    }
    const preview = opciones ? await stripe.invoices.createPreview(params, opciones) : await stripe.invoices.createPreview(params)
    const monto = plan.retirado ? conElRetirado(preview, plan.retirado) : preview.amount_due
    if (typeof monto !== 'number') return null
    const despues = await leer()
    const igual = JSON.stringify(descuentosSiSeCobrara(despues)) === JSON.stringify(plan) && despues.trial_end === sub.trial_end
    return igual ? monto : null
  } catch (err) {
    logger.warn(`siguienteCobro: falló la vista previa de respaldo de ${subscriptionId}`, {
      error: err instanceof Error ? err.message : 'Unknown error',
    })
    return null
  }
}

interface Retirado {
  percentOff: number | null
  amountOff: number | null
  currency: string | null
}

/** La vista previa sin descuentos menos el cupón retirado y luego el saldo (a favor resta, adeudo suma); `null` si no cuadra. */
function conElRetirado(preview: Stripe.Invoice, r: Retirado): number | null {
  const { subtotal, total, starting_balance: saldo, currency } = preview
  if (typeof subtotal !== 'number' || total !== subtotal || typeof saldo !== 'number') return null
  const descuento =
    r.percentOff !== null
      ? Math.round(Number(((subtotal * r.percentOff) / 100).toFixed(6)))
      : r.amountOff !== null && r.currency === currency
        ? Math.min(r.amountOff, subtotal)
        : null
  return descuento === null ? null : Math.max(0, subtotal - descuento + saldo)
}

/**
 * Los descuentos de la prueba sin tarjeta del alta (B2) si al terminar se cobrará con tarjeta: los cupones vivos o UN cupón retirado
 * solo. `null` si no es esa prueba, si ya no se cobrará (cancelada, con cancelación o pausa que llega al fin) o si un descuento no se
 * puede leer o reproducir («no se sabe», nunca el precio sin él).
 * ponytail: un retirado junto con otros descuentos, o limitado a ciertos productos, sale `null`; si llega a pasar, se simula su orden.
 */
function descuentosSiSeCobrara(sub: Stripe.Subscription): { cupones: string[]; retirado: Retirado | null } | null {
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
  const vigentes = (sub.discounts ?? []).filter(d => !venceAntes(d)).map(cuponDelDescuento)
  if (vigentes.some(c => c === null)) return null
  const cupones = vigentes as Cupon[]
  const retirados = cupones.filter(c => c.retirado)
  if (retirados.length === 0) return { cupones: cupones.map(c => c.id), retirado: null }
  const r = retirados[0].retirado
  if (cupones.length > 1 || !r) return null
  return { cupones: [], retirado: r }
}

interface Cupon {
  id: string
  retirado: Retirado | null
}

/**
 * El cupón de un descuento expandido: `source.coupon` (API clover) o `coupon` (basil, con sus términos); `null` si no se puede leer
 * o si está retirado y no se puede reproducir (ni % ni monto, o limitado a ciertos productos).
 */
function cuponDelDescuento(d: unknown): Cupon | null {
  type Terminos = { id?: string; valid?: boolean; percent_off?: number | null; amount_off?: number | null; currency?: string | null }
  const x = d as
    | {
        coupon?: string | (Terminos & { applies_to?: { products?: string[] } | null }) | null
        source?: { coupon?: string | Terminos | null } | null
      }
    | string
    | null
  if (!x || typeof x === 'string') return null
  const c = x.source?.coupon ?? x.coupon
  if (typeof c === 'string') return { id: c, retirado: null }
  if (!c?.id) return null
  if (c.valid !== false) return { id: c.id, retirado: null }
  const percentOff = typeof c.percent_off === 'number' ? c.percent_off : null
  const amountOff = typeof c.amount_off === 'number' ? c.amount_off : null
  const soloAlgunos = ((c as { applies_to?: { products?: string[] } | null }).applies_to?.products?.length ?? 0) > 0
  if ((percentOff === null && amountOff === null) || soloAlgunos) return null
  return { id: c.id, retirado: { percentOff, amountOff, currency: c.currency ?? null } }
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
