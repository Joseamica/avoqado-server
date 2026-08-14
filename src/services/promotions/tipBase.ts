export interface TipBaseLine {
  grossCents: number
  discountCents: number
}

/**
 * La base canónica de la propina: **el subtotal NETO, después de promociones y
 * descuentos, antes de propina.**
 *
 * 🔴 Sin una base única, un combo de $99 cuyo catálogo suma $200 produce "15%"
 * de $14.85 en un cliente y de $30 en otro — y el mesero cobra distinto según
 * con qué aparato lo atendieron. El server la calcula y los clientes la
 * muestran; ninguno la deriva por su cuenta.
 *
 * ⚠️ AÚN SIN CONSUMIDOR DE PRODUCCIÓN, a propósito: se cablea en el plan 3
 * (clientes) dentro de la respuesta de la orden, cuando exista la pantalla de
 * propina que la lea. Si el plan 3 muere, borrar este módulo con su test.
 */
export function netSubtotalForTipCents(items: TipBaseLine[]): number {
  return items.reduce((sum, item) => sum + Math.max(0, item.grossCents - item.discountCents), 0)
}
