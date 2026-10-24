/** Foto del descuento guardada en `PaymentLink.discount`. */
export type DescuentoDeLiga = {
  v: 1
  origen: 'MANUAL' | 'CATALOGO'
  discountId: string | null
  type: 'PERCENTAGE' | 'FIXED_AMOUNT'
  value: number
  name: string
}
