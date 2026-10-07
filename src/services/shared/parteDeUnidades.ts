/**
 * Cuánto de `totalCents` les toca a `cuantas` unidades de un renglón de `cantidad`, empezando en la unidad `desde`: el piso por unidad
 * y el residuo a las primeras unidades. Lo usan el escritor de devoluciones (sobre el total bruto, `refund.dashboard.service.ts`) y el
 * libro de la orden (sobre lo que el renglón cobró, B4b). Pura.
 */
export function parteDeUnidades(totalCents: number, cantidad: number, desde: number, cuantas: number): number {
  if (cantidad <= 0 || cuantas <= 0) return 0
  const baseUnit = Math.floor(totalCents / cantidad)
  const remainder = totalCents % cantidad
  const end = desde + cuantas
  const bonusUnits = Math.max(0, Math.min(remainder, end) - Math.min(remainder, desde))
  return baseUnit * cuantas + bonusUnits
}
