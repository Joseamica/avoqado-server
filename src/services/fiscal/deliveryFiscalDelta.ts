// src/services/fiscal/deliveryFiscalDelta.ts
//
// IVA por tasa de un retiro de reparto (spec KDS Uber §3.1 paso 4, [N-13]): la DIFERENCIA entre el IVA
// de la composición cobrada y el de la superviviente, cada una calculada con los MISMOS helpers que la
// póliza de la venta (`grossByRateFromItems` + `splitPaymentIvaByOrderRates`) y, por tanto, con su
// desempate (el residual al bucket de MAYOR importe, que puede ser el de tasa cero). Por construcción,
// `IVA original − Σ compensaciones = IVA superviviente` también en retiros sucesivos.

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
