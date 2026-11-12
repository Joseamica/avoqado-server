/**
 * D2 · B (coordinador, 12-nov): en la venta sin red, el SERVIDOR registra lo que la terminal YA cobró. La TPV 2.14.0–2.16.1 (builds
 * 123–126) sube su «Cobrar» sin red a `POST /mobile/orders` con `orderDiscountId`, y calculó ese % de catálogo TRUNCANDO
 * (`RoundingMode.DOWN`) y sin conocer el tope (`Discount.calculateAmount` de esos tags). Desde 2.16.2 (build 127) redondea mitad hacia
 * arriba con tope, como el SERVIDOR (`calculateDiscountPesos`). Producción el 12-nov: 24 TPV 2.16.0 vistas hoy, ninguna ≥ 2.16.2.
 * La TPV no manda `X-Device-Platform`; los POS sí, y nunca truncan.
 */
import type { IncomingHttpHeaders } from 'http'
import { Prisma } from '@prisma/client'
import { parseVersionCode } from '@/utils/appHeaders'

/** El último build de la TPV que trunca el descuento de catálogo (2.16.1). */
const ULTIMO_BUILD_TPV_QUE_TRUNCA = 126

export function esTpvQueTruncaElDescuento(headers: IncomingHttpHeaders | Record<string, unknown> | undefined): boolean {
  if (headers?.['x-device-platform'] != null) return false
  const build = parseVersionCode(headers?.['x-app-version-code'] as string | string[] | undefined)
  return build !== undefined && build <= ULTIMO_BUILD_TPV_QUE_TRUNCA
}

/**
 * El % de catálogo como lo cobró esa TPV: base a centavos, % exacto, truncado, sin tope, nunca más que la base. `null` si no es un %
 * (el fijo y la cortesía se quedan con la regla de hoy).
 */
export function descuentoComoLoCobroLaTpvVieja(
  discount: { type: string; value: Prisma.Decimal.Value; maxDiscountAmount?: unknown },
  basePesos: number,
): number | null {
  if (discount.type !== 'PERCENTAGE') return null
  const base = new Prisma.Decimal(basePesos).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
  const monto = base.mul(discount.value).div(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN)
  return Prisma.Decimal.max(0, Prisma.Decimal.min(monto, base)).toNumber()
}
