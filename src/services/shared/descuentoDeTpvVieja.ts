/**
 * D2 · B (coordinador, 12-nov): en la venta sin red, el SERVIDOR registra lo que la terminal YA cobró. La TPV 2.14.0–2.16.1 (builds
 * 123–126) sube su «Cobrar» sin red a `POST /mobile/orders` con `orderDiscountId`, y calculó ese % de catálogo TRUNCANDO
 * (`RoundingMode.DOWN`) y sin conocer el tope (`Discount.calculateAmount` de esos tags); aquí se respeta el tope (ver abajo). Desde 2.16.2 (build 127) redondea mitad hacia
 * arriba con tope, como el SERVIDOR (`calculateDiscountPesos`). Producción el 12-nov: 24 TPV 2.16.0 vistas hoy, ninguna ≥ 2.16.2.
 * La TPV no manda `X-Device-Platform`; los POS sí, y nunca truncan.
 */
import type { IncomingHttpHeaders } from 'http'
import { Prisma } from '@prisma/client'
import { parseVersionCode } from '@/utils/appHeaders'
import { aCentavos } from './repartoDescuento'

/** El último build de la TPV que trunca el descuento de catálogo (2.16.1). */
const ULTIMO_BUILD_TPV_QUE_TRUNCA = 126

export function esTpvQueTruncaElDescuento(headers: IncomingHttpHeaders | Record<string, unknown> | undefined): boolean {
  if (headers?.['x-device-platform'] != null) return false
  const build = parseVersionCode(headers?.['x-app-version-code'] as string | string[] | undefined)
  return build !== undefined && build <= ULTIMO_BUILD_TPV_QUE_TRUNCA
}

/**
 * El % de catálogo como lo cobró esa TPV: base a centavos, % exacto, TRUNCADO, nunca más que la base. `null` si no es un % (el fijo y
 * la cortesía se quedan con la regla de hoy).
 *
 * 🔴 El tope del catálogo SÍ se aplica, con la misma regla que `calculateDiscountPesos` (un tope no nulo y distinto de 0), aunque esa TPV
 * no lo conocía (Codex r2 #1 y r3 #1): así este camino NUNCA descuenta más que la regla exacta (truncar ≤ redondear, mismo tope y misma
 * base), y quien se haga pasar por una TPV vieja sólo puede descontar un centavo MENOS. Una TPV vieja que cobró un % por encima del
 * tope sigue dejando la diferencia por cobrar, como hoy (deuda aparte).
 */
export function descuentoComoLoCobroLaTpvVieja(
  discount: { type: string; value: Prisma.Decimal.Value; maxDiscountAmount?: Prisma.Decimal.Value | null },
  basePesos: number,
): number | null {
  if (discount.type !== 'PERCENTAGE') return null
  const baseCents = aCentavos(basePesos)
  let cents = new Prisma.Decimal(baseCents).mul(discount.value).div(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_DOWN).toNumber()
  if (discount.maxDiscountAmount) cents = Math.min(cents, aCentavos(discount.maxDiscountAmount))
  return Math.max(0, Math.min(cents, baseCents)) / 100
}
