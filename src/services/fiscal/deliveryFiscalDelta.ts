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
  const antes = splitPaymentIvaByOrderRates(cobradoGrossCents, grossByRateFromItems(cobrada)).taxByRate
  const despues = splitPaymentIvaByOrderRates(supervivienteGrossCents, grossByRateFromItems(superviviente)).taxByRate
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
 */
export function ivaDeDevolucion(
  paymentId: string,
  salesCents: number,
  processorData: unknown,
  grossByRate: { rate: number; grossCents: number }[],
): { netCents: number; taxCents: number; taxByRate: Record<string, number> } {
  const pd = processorData as { provenance?: unknown; fiscalByRateCents?: unknown } | null | undefined
  if (pd?.provenance !== 'PROVIDER_ADJUSTMENT') return splitPaymentIvaByOrderRates(salesCents, grossByRate)
  const f = pd.fiscalByRateCents
  if (!f || typeof f !== 'object' || Array.isArray(f) || !Object.values(f).every(Number.isInteger)) {
    logger.error(`🚨 [fiscal] ajuste del proveedor ${paymentId} sin fiscalByRateCents válido: se usa la mezcla de la orden`)
    return splitPaymentIvaByOrderRates(salesCents, grossByRate)
  }
  const taxByRate = { ...(f as FiscalByRateCents) }
  const taxCents = Object.values(taxByRate).reduce((a, b) => a + b, 0)
  if (taxCents < 0 || taxCents > salesCents) {
    logger.error(
      `🚨 [fiscal] ajuste del proveedor ${paymentId}: IVA ${taxCents} fuera de [0, ${salesCents}] centavos — se usa la mezcla de la orden`,
    )
    return splitPaymentIvaByOrderRates(salesCents, grossByRate)
  }
  return { netCents: salesCents - taxCents, taxCents, taxByRate }
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
