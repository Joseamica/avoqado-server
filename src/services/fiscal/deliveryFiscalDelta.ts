// src/services/fiscal/deliveryFiscalDelta.ts
//
// IVA por tasa de un retiro de reparto (spec KDS Uber §3.1 paso 4, [N-13]): la DIFERENCIA entre el IVA
// de la composición cobrada y el de la superviviente, cada una calculada con los MISMOS helpers que la
// póliza de la venta (`grossByRateFromItems` + `splitPaymentIvaByOrderRates`) y, por tanto, con su
// desempate (el residual al bucket de MAYOR importe, que puede ser el de tasa cero). Por construcción,
// `IVA original − Σ compensaciones = IVA superviviente` también en retiros sucesivos.

import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import { grossByRateFromItems, splitPaymentIvaByOrderRates } from './ivaMath'

type Linea = Parameters<typeof grossByRateFromItems>[0][number]

/**
 * IVA en centavos por tasa. Llaves = las de `taxByRate` de ivaMath: `String(tasa)` (`"0.16"`, `"0.08"`);
 * nunca aparece una tasa sin diferencia (en particular, `"0"` no aparece: el 0 % no causa IVA).
 * Un valor puede ser negativo si el reparto proporcional mueve IVA entre tasas.
 */
export type FiscalByRateCents = Record<string, number>

export function fiscalByRateCents(
  cobrada: Linea[],
  superviviente: Linea[],
  cobradoGrossCents: number,
  supervivienteGrossCents: number,
): FiscalByRateCents {
  return fiscalByRateCentsPorTasa(
    grossByRateFromItems(cobrada),
    grossByRateFromItems(superviviente),
    cobradoGrossCents,
    supervivienteGrossCents,
  )
}

type PorTasa = { rate: number; grossCents: number }[]

/**
 * El mismo cálculo con las composiciones YA agrupadas por tasa. El reconciliador las arma con
 * `grossByRateForOrder` —el mapeo de campos de la póliza de la venta— para que no exista un segundo
 * mapeo que pueda divergir en silencio.
 */
export function fiscalByRateCentsPorTasa(
  cobrada: PorTasa,
  superviviente: PorTasa,
  cobradoGrossCents: number,
  supervivienteGrossCents: number,
): FiscalByRateCents {
  const antes = splitPaymentIvaByOrderRates(cobradoGrossCents, cobrada).taxByRate
  const despues = splitPaymentIvaByOrderRates(supervivienteGrossCents, superviviente).taxByRate
  const delta: FiscalByRateCents = {}
  for (const tasa of new Set([...Object.keys(antes), ...Object.keys(despues)])) {
    const d = (antes[tasa] ?? 0) - (despues[tasa] ?? 0)
    if (d !== 0) delta[tasa] = d
  }
  return delta
}

/**
 * IVA de una DEVOLUCIÓN — la ÚNICA regla, compartida por la póliza (`autoPosting`) y el estado de
 * resultados (`accounting.dashboard`), que así cuadran al centavo. Un ajuste del proveedor
 * (`processorData.provenance = 'PROVIDER_ADJUSTMENT'`) con `fiscalByRateCents` válido (valores enteros)
 * cuyo IVA total cae en [0, venta devuelta] usa ESE reparto; todo lo demás usa la mezcla de la orden
 * (`grossByRate`). Un ajuste sin reparto válido, o fuera de rango, grita 🚨 con su id: una devolución
 * nunca se queda sin cifra.
 *
 * @param salesCents magnitud (≥ 0) de la venta devuelta, sin propina.
 * @param opts.avisar `false` en los caminos de LECTURA (estado de resultados): la cifra es la misma, pero el
 *   🚨 lo da una sola vez la póliza — si no, cada vez que alguien abre un reporte gritaría de nuevo.
 */
export function ivaDeDevolucion(
  paymentId: string,
  salesCents: number,
  processorData: unknown,
  grossByRate: { rate: number; grossCents: number }[],
  { avisar = true }: { avisar?: boolean } = {},
): { netCents: number; taxCents: number; taxByRate: Record<string, number> } {
  const pd = processorData as { provenance?: unknown; fiscalByRateCents?: unknown } | null | undefined
  if (pd?.provenance !== 'PROVIDER_ADJUSTMENT') return splitPaymentIvaByOrderRates(salesCents, grossByRate)
  const f = pd.fiscalByRateCents
  if (!f || typeof f !== 'object' || Array.isArray(f) || !Object.values(f).every(Number.isInteger)) {
    if (avisar) logger.error(`🚨 [fiscal] ajuste del proveedor ${paymentId} sin fiscalByRateCents válido: se usa la mezcla de la orden`)
    return splitPaymentIvaByOrderRates(salesCents, grossByRate)
  }
  const taxByRate = { ...(f as FiscalByRateCents) }
  const taxCents = Object.values(taxByRate).reduce((a, b) => a + b, 0)
  if (taxCents < 0 || taxCents > salesCents) {
    if (avisar) {
      logger.error(
        `🚨 [fiscal] ajuste del proveedor ${paymentId}: IVA ${taxCents} fuera de [0, ${salesCents}] centavos — se usa la mezcla de la orden`,
      )
    }
    return splitPaymentIvaByOrderRates(salesCents, grossByRate)
  }
  return { netCents: salesCents - taxCents, taxCents, taxByRate }
}

/**
 * IVA por tasa QUE HOY ESTÁ EN LIBROS para los cobros de una orden: el de cada venta (como la póliza,
 * `splitPaymentIvaByOrderRates` con la mezcla de la orden) menos el de cada devolución (`ivaDeDevolucion`,
 * la misma regla de la póliza: mezcla para las manuales, `fiscalByRateCents` para los ajustes del
 * proveedor). Es el saldo del que un retiro nuevo descuenta — NO la composición cobrada, que deja de
 * representar el IVA registrado en cuanto entra una devolución manual (auditoría final de Codex, P1-1).
 */
export function ivaEnLibrosPorTasa(
  cobros: { id: string; type: string | null; amountCents: number; processorData: unknown }[],
  grossByRate: { rate: number; grossCents: number }[],
): FiscalByRateCents {
  const saldo: FiscalByRateCents = {}
  for (const c of cobros) {
    const g = Math.abs(c.amountCents)
    const devolucion = c.type === 'REFUND'
    const { taxByRate } = devolucion
      ? ivaDeDevolucion(c.id, g, c.processorData, grossByRate, { avisar: false })
      : splitPaymentIvaByOrderRates(g, grossByRate)
    for (const [tasa, v] of Object.entries(taxByRate)) saldo[tasa] = (saldo[tasa] ?? 0) + (devolucion ? -v : v)
  }
  return saldo
}

/**
 * `processorData` de las devoluciones indicadas, en UNA consulta acotada: el de cada venta del periodo
 * no hace falta, así que quien lista pagos no lo trae en su consulta principal.
 */
export async function processorDataDeDevoluciones(venueId: string, ids: string[]): Promise<Map<string, unknown>> {
  if (ids.length === 0) return new Map()
  const filas = await prisma.payment.findMany({
    where: { venueId, id: { in: ids } },
    select: { id: true, processorData: true },
    take: ids.length,
  })
  return new Map(filas.map(f => [f.id, f.processorData]))
}
