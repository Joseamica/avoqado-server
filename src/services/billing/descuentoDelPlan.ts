/**
 * D5 (5-nov-2026): «Tu plan» en Facturación mostraba el precio de lista aunque el negocio pagara con cupón (Stripe sí
 * cobraba con el descuento). Aquí se lee el descuento vigente de la suscripción y se calcula lo que paga.
 *
 * Los precios de los planes ya incluyen el IVA (tax_behavior inclusive), así que el cupón descuenta sobre ese precio.
 * Sólo se calcula lo que se entiende sin adivinar: UN descuento, con su cupón expandido, en porcentaje o en pesos
 * mexicanos. Cualquier otra forma devuelve `null` y la pantalla muestra el precio de lista, como antes.
 */
export interface DescuentoDelPlan {
  percentOff: number | null
  amountOffCents: number | null
  /** `once`: sólo el siguiente cobro · `repeating`: hasta `endsAt` · `forever`: sin fin. */
  duration: 'once' | 'repeating' | 'forever'
  /** Fin del descuento (sólo `repeating`). */
  endsAt: Date | null
}

type Cupon = {
  percent_off?: number | null
  amount_off?: number | null
  currency?: string | null
  duration?: string
  /** Productos a los que se limita el cupón (expandido). Sin él, aplica a todos. */
  applies_to?: { products?: string[] } | null
}

/**
 * `productId`: el producto del plan de la suscripción. Un cupón limitado a otros productos (los de campaña valen sólo para
 * Pro) no descuenta nada de este plan (Codex D5 r1 #1). Residuo declarado: un cupón puesto AL CLIENTE en Stripe (Avoqado
 * nunca lo hace; sólo a mano) no se ve aquí y la pantalla muestra el precio de lista.
 */
export function descuentoDelPlan(sub: { discounts?: unknown; discount?: unknown }, productId?: string | null): DescuentoDelPlan | null {
  const lista = Array.isArray(sub.discounts) ? sub.discounts : sub.discount ? [sub.discount] : []
  if (lista.length !== 1) return null
  const d = lista[0] as { source?: { coupon?: unknown }; coupon?: unknown; end?: number | null } | string
  if (!d || typeof d === 'string') return null
  const cupon = (d.source?.coupon ?? d.coupon) as Cupon | string | null | undefined
  if (!cupon || typeof cupon === 'string') return null
  const productos = cupon.applies_to?.products ?? []
  if (productos.length > 0 && (!productId || !productos.includes(productId))) return null
  const duration = cupon.duration === 'repeating' || cupon.duration === 'forever' ? cupon.duration : 'once'
  const endsAt = duration === 'repeating' && d.end ? new Date(d.end * 1000) : null
  if (cupon.percent_off != null && cupon.percent_off > 0) return { percentOff: cupon.percent_off, amountOffCents: null, duration, endsAt }
  if (cupon.amount_off != null && cupon.amount_off > 0 && (cupon.currency ?? '').toLowerCase() === 'mxn')
    return { percentOff: null, amountOffCents: cupon.amount_off, duration, endsAt }
  return null
}

/** Lo que se paga con el descuento, en centavos con IVA; nunca negativo. */
export function precioConDescuentoCents(precioCents: number, d: DescuentoDelPlan): number {
  if (d.percentOff != null) return Math.max(0, Math.round(precioCents * (1 - d.percentOff / 100)))
  return Math.max(0, precioCents - (d.amountOffCents ?? 0))
}
