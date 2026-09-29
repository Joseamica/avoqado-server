// src/services/fiscal/deliveryFiscalDelta.ts
//
// IVA de las devoluciones de reparto (spec KDS Uber §3.1 paso 4, [N-13]): la regla única de una devolución
// (`ivaDeDevolucion`) y, desde el plan 4b, el saldo en libros y el reparto que se congela, por tratamiento.
// `IVA original − Σ compensaciones = IVA superviviente` también en retiros sucesivos (lo prueba `reconciliacionDinero.test.ts`).

import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import {
  desglosePorTratamiento,
  mezclaDesdeTasas,
  splitPaymentIvaByOrderRates,
  tasasDe,
  type DesgloseDeCobro,
  type DesglosePorTratamiento,
  type MezclaPorTratamiento,
} from './ivaMath'
import type { IvaTratamiento } from './ivaTratamiento'

/**
 * IVA en centavos por tasa (forma VIEJA, hasta el plan 4b; sólo se lee). Llaves = las de `taxByRate` de ivaMath:
 * `String(tasa)` (`"0.16"`, `"0.08"`); nunca aparece una tasa sin diferencia (en particular, `"0"` no aparece: el 0 % no
 * causa IVA). Un valor puede ser negativo si el reparto proporcional mueve IVA entre tasas.
 */
export type FiscalByRateCents = Record<string, number>

/** Forma NUEVA (plan 4b, Ruling 4b-R2): base e IVA por tratamiento, con versión. Base + IVA = venta devuelta exacta. */
export type FiscalPorTratamiento = { v: 2; porTratamiento: DesglosePorTratamiento }
/** Lo que un ajuste del proveedor guarda en `processorData.fiscalByRateCents`, en cualquiera de sus dos formas. */
export type FiscalCongelado = FiscalByRateCents | FiscalPorTratamiento

/** Los tratamientos que un mapa v2 admite: los de catálogo. Un BLOQUEADO no se congela (Ruling 4b-R4). */
const TRATAMIENTOS_CONGELABLES: readonly string[] = ['IVA_16', 'IVA_8', 'IVA_0', 'EXENTO', 'NO_OBJETO']

/**
 * El reparto congelado de un ajuste del proveedor, leído en cualquiera de sus dos formas; `null` si no es válido.
 * Forma vieja (Ruling 4b-R3): el IVA guardado va a su tratamiento por la llave ("0.08" ⇒ IVA_8; cualquier otra ⇒ IVA_16) y
 * TODA la base a IVA_16 —nunca dijo si era tasa 0, exenta o no objeto, y hasta hoy toda contaba como gravable—; su `taxByRate`
 * se conserva tal cual.
 */
function leerCongelado(
  f: unknown,
  salesCents: number,
): { porTratamiento: DesglosePorTratamiento; taxByRate: Record<string, number> } | null {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return null
  const x = f as Record<string, unknown>
  if (x.v === 2) {
    const p = x.porTratamiento
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null
    const porTratamiento: DesglosePorTratamiento = {}
    let suma = 0
    for (const [t, v] of Object.entries(p as Record<string, unknown>)) {
      const e = v as { baseCents?: unknown; ivaCents?: unknown } | null
      if (!TRATAMIENTOS_CONGELABLES.includes(t) || !e || !Number.isInteger(e.baseCents) || !Number.isInteger(e.ivaCents)) return null
      const valor = { baseCents: e.baseCents as number, ivaCents: e.ivaCents as number }
      porTratamiento[t as IvaTratamiento] = valor
      suma += valor.baseCents + valor.ivaCents
    }
    return suma === salesCents ? { porTratamiento, taxByRate: tasasDe(porTratamiento) } : null
  }
  if (!Object.values(x).every(Number.isInteger)) return null
  const taxByRate = { ...(x as FiscalByRateCents) }
  const iva8 = taxByRate['0.08'] ?? 0
  const iva16 = Object.entries(taxByRate).reduce((s, [k, v]) => (k === '0.08' ? s : s + v), 0)
  const porTratamiento: DesglosePorTratamiento = { IVA_16: { baseCents: salesCents - iva16 - iva8, ivaCents: iva16 } }
  if (iva8 !== 0) porTratamiento.IVA_8 = { baseCents: 0, ivaCents: iva8 }
  return { porTratamiento, taxByRate }
}

/**
 * IVA de una DEVOLUCIÓN — la ÚNICA regla, compartida por la póliza (`autoPosting`) y el estado de
 * resultados (`accounting.dashboard`), que así cuadran al centavo. Un ajuste del proveedor
 * (`processorData.provenance = 'PROVIDER_ADJUSTMENT'`) con `fiscalByRateCents` válido (valores enteros)
 * cuyo IVA total cae en [0, venta devuelta] usa ESE reparto; todo lo demás usa la mezcla de la orden
 * (`mezcla`). Un ajuste sin reparto válido, o fuera de rango, grita 🚨 con su id: una devolución
 * nunca se queda sin cifra. La mezcla es la de la orden por tratamiento; el mapa de un ajuste se lee
 * en cualquiera de sus dos formas.
 *
 * @param salesCents magnitud (≥ 0) de la venta devuelta, sin propina.
 * @param opts.avisar `false` en los caminos de LECTURA (estado de resultados): la cifra es la misma, pero el
 *   🚨 lo da una sola vez la póliza — si no, cada vez que alguien abre un reporte gritaría de nuevo.
 */
export function ivaDeDevolucion(
  paymentId: string,
  salesCents: number,
  processorData: unknown,
  mezcla: MezclaPorTratamiento,
  { avisar = true }: { avisar?: boolean } = {},
): DesgloseDeCobro {
  const pd = processorData as { provenance?: unknown; fiscalByRateCents?: unknown } | null | undefined
  if (pd?.provenance !== 'PROVIDER_ADJUSTMENT') return desglosePorTratamiento(salesCents, mezcla)
  const congelado = leerCongelado(pd.fiscalByRateCents, salesCents)
  if (!congelado) {
    if (avisar) logger.error(`🚨 [fiscal] ajuste del proveedor ${paymentId} sin fiscalByRateCents válido: se usa la mezcla de la orden`)
    return desglosePorTratamiento(salesCents, mezcla)
  }
  const taxCents = Object.values(congelado.porTratamiento).reduce((s, v) => s + (v?.ivaCents ?? 0), 0)
  if (taxCents < 0 || taxCents > salesCents) {
    if (avisar) {
      logger.error(
        `🚨 [fiscal] ajuste del proveedor ${paymentId}: IVA ${taxCents} fuera de [0, ${salesCents}] centavos — se usa la mezcla de la orden`,
      )
    }
    return desglosePorTratamiento(salesCents, mezcla)
  }
  return { netCents: salesCents - taxCents, taxCents, taxByRate: congelado.taxByRate, porTratamiento: congelado.porTratamiento }
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
      ? ivaDeDevolucion(c.id, g, c.processorData, mezclaDesdeTasas(grossByRate), { avisar: false })
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
