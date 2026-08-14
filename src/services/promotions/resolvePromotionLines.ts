import { allocateByWeights } from '@/services/fiscal/ivaMath'

/** Una opción ya elegida, con el precio de catálogo del producto congelado. */
export interface PromotionOptionSnapshot {
  productId: string
  /** Unidades que ENTRAN al carrito. El inventario descuenta por aquí. */
  quantity: number
  /** Unidades que se COBRAN. En un 2x1: quantity 2, chargedQuantity 1. */
  chargedQuantity: number
  /** Sobreprecio de esta opción, en centavos. Sólo se usa en FIXED_TOTAL. */
  priceDeltaCents: number
  /** Precio de lista del producto, en centavos. */
  listPriceCents: number
}

export interface PromotionPricingInput {
  pricingMode: 'FIXED_TOTAL' | 'PER_UNIT'
  /** Precio base de la promoción, en centavos. Sólo se usa en FIXED_TOTAL. */
  priceCents: number
  selections: PromotionOptionSnapshot[]
}

export interface ResolvedPromotionLine {
  productId: string
  quantity: number
  /** Precio de lista unitario. La línea SIEMPRE conserva su bruto de catálogo. */
  unitPriceCents: number
  /** Lo que se le descuenta a esta línea. */
  discountCents: number
  /** unitPriceCents × quantity − discountCents */
  totalCents: number
}

export interface ResolvedPromotion {
  lines: ResolvedPromotionLine[]
  grossCents: number
  discountCents: number
  netCents: number
}

/**
 * Convierte una promoción y lo que la persona eligió en líneas de venta.
 *
 * 🔑 Cada línea conserva su precio BRUTO de catálogo y carga su parte del
 * descuento. Nunca se inventa un "precio promocional" por unidad: si se
 * hiciera, el regalo dejaría de ser visible como regalo (nadie podría reportar
 * cuánto se regaló en promociones) y el precio de venta del producto quedaría
 * sucio en los reportes.
 *
 * 🔴 El descuento se reparte PROPORCIONAL al bruto, no en partes iguales.
 * Partes iguales le movería la base gravable a un producto 0% frente a uno
 * 16%. `allocateByWeights` garantiza que las partes sumen el total EXACTO.
 */
export function resolvePromotionLines(input: PromotionPricingInput): ResolvedPromotion {
  const { pricingMode, priceCents, selections } = input

  if (selections.length === 0) {
    return { lines: [], grossCents: 0, discountCents: 0, netCents: 0 }
  }

  const grossPerLine = selections.map(s => s.listPriceCents * s.quantity)
  const grossCents = grossPerLine.reduce((a, b) => a + b, 0)

  // Cuánto DEBE cobrar la promoción.
  const targetNet =
    pricingMode === 'FIXED_TOTAL'
      ? priceCents + selections.reduce((sum, s) => sum + s.priceDeltaCents, 0)
      : selections.reduce((sum, s) => sum + s.listPriceCents * s.chargedQuantity, 0)

  // Una promoción no puede cobrar MÁS que el catálogo: si alguien la configura
  // por encima, se cobra el catálogo y no se genera un descuento negativo.
  const discountCents = Math.max(0, grossCents - targetNet)
  const shares = allocateByWeights(discountCents, grossPerLine)

  const lines: ResolvedPromotionLine[] = selections.map((s, i) => ({
    productId: s.productId,
    quantity: s.quantity,
    unitPriceCents: s.listPriceCents,
    discountCents: shares[i],
    totalCents: grossPerLine[i] - shares[i],
  }))

  return {
    lines,
    grossCents,
    discountCents,
    netCents: grossCents - discountCents,
  }
}
