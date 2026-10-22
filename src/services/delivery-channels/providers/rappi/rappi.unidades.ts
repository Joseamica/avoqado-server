/**
 * Las unidades del dinero de Rappi, en UN lugar: lo que llega en los pedidos y lo que se publica en el menú.
 *
 * 🔴 Su documentación nunca dice si los montos son pesos o centavos (`doc-rappi-menu-stock-horarios-dinero.md`, D13: «NO
 * ENCONTRÉ»). Lo midió el recorrido real en el sandbox (M2, 21-oct-2026): un pedido de NUESTRO menú con 2 × Coca-Cola de
 * $25 y Papas de $49 llegó con `price` 25 y 49 y `total_products` 99. O sea, PESOS.
 *
 * Si algún día Rappi cambiara a centavos, se cambia ESTE número y nada más: el mapeo de pedidos y el publicador del menú
 * pasan por estas dos funciones.
 *
 * 🔴 OJO: el cuadre del mapeo contra `total_products` NO descubre un factor equivocado. Los renglones y `total_products` pasan
 * por el MISMO factor, así que un factor mal puesto y parejo SÍ cuadra: todo el dinero saldría 100 veces mayor o menor y nada
 * lo gritaría. La red real es la medición M2 más la prueba que fija `FACTOR_MONEDA_RAPPI` en 1 (`rappi.mapper.test.ts`): cambiar
 * el número obliga a romperla a propósito.
 */
import { Prisma } from '@prisma/client'

/** Cuántas unidades de Rappi hay en un peso. Medido en M2: 1. */
export const FACTOR_MONEDA_RAPPI: 1 | 100 = 1

/**
 * Un monto de Rappi → pesos, en decimal exacto. Ausente o ilegible es 0. El cuadre sólo vigila los renglones contra
 * `total_products`: un descuento, un envío o una propina ilegibles se leen como 0 sin que el cuadre lo note (a lo más, en un
 * pedido pagado en línea, `vigilarTotalDelPedido` grita 🚨 si lo liquidado no es `total_order`).
 */
export function deRappiAPesos(n: number | string | null | undefined): Prisma.Decimal {
  if (typeof n === 'number' && Number.isFinite(n)) return new Prisma.Decimal(n).div(FACTOR_MONEDA_RAPPI)
  if (typeof n === 'string' && n.trim() !== '') {
    try {
      const d = new Prisma.Decimal(n.trim())
      if (d.isFinite()) return d.div(FACTOR_MONEDA_RAPPI)
    } catch {
      // Ilegible: cae al cero de abajo.
    }
  }
  return new Prisma.Decimal(0)
}

/**
 * Pesos → el número que Rappi espera. Con decimal exacto: `19.99 × 100` en punto flotante da `1998.9999999999998`. El
 * redondeo a lo que Rappi acepta lo decide quien publica, no esta función.
 */
export function dePesosARappi(pesos: number): number {
  return new Prisma.Decimal(pesos).mul(FACTOR_MONEDA_RAPPI).toNumber()
}
