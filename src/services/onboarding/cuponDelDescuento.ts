/**
 * El id del cupón de un descuento de Stripe, en cualquiera de sus formas.
 *
 * 🔴 Desde la API `2025-09-30.clover` (la que fija el SDK que usamos) el cupón vive en
 * `discount.source.coupon`; antes vivía en `discount.coupon`. Leer sólo el campo viejo hacía que la
 * recuperación de un cobro juzgara «sin cupón» a TODA suscripción con descuento (26-sep).
 * Un descuento sin expandir (sólo su id `di_…`) no dice su cupón: se devuelve `null`, nunca se adivina.
 */
type CuponCrudo = string | { id?: string | null } | null | undefined

export function idDelCuponDelDescuento(descuento: unknown): string | null {
  if (!descuento || typeof descuento !== 'object') return null
  const d = descuento as { source?: { coupon?: CuponCrudo } | null; coupon?: CuponCrudo }
  const cupon = d.source?.coupon ?? d.coupon
  if (!cupon) return null
  if (typeof cupon === 'string') return cupon
  return typeof cupon.id === 'string' ? cupon.id : null
}
