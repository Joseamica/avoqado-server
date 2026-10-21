/**
 * Cuánto de `totalCents` les toca a `cuantas` unidades de un renglón de `cantidad`, empezando en la unidad `desde`: el piso por unidad
 * y el residuo a las primeras unidades. Lo usan el escritor de devoluciones (`refund.dashboard.service.ts`) y el libro de la orden (B4b),
 * los dos sobre lo que el renglón COBRÓ (C2 A-R2: `cobradoDeLaOrden.ts`), no sobre su total bruto. Pura.
 */
export function parteDeUnidades(totalCents: number, cantidad: number, desde: number, cuantas: number): number {
  if (cantidad <= 0 || cuantas <= 0) return 0
  const baseUnit = Math.floor(totalCents / cantidad)
  const remainder = totalCents % cantidad
  const end = desde + cuantas
  const bonusUnits = Math.max(0, Math.min(remainder, end) - Math.min(remainder, desde))
  return baseUnit * cuantas + bonusUnits
}
