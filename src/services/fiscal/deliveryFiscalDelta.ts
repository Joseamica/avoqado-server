// src/services/fiscal/deliveryFiscalDelta.ts
//
// IVA de las devoluciones de reparto (spec KDS Uber §3.1 paso 4, [N-13]): la regla única de una devolución
// (`ivaDeDevolucion`) y, desde el plan 4b, el saldo en libros y el reparto que se congela, por tratamiento.
// `IVA original − Σ compensaciones = IVA superviviente` también en retiros sucesivos (lo prueba `reconciliacionDinero.test.ts`).

import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import {
  desglosePorTratamiento,
  repartirProporcional,
  sumarDesglose,
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
/** Los que no causan IVA: en un mapa v2 su IVA es cero, o `tasasDe` inventaría la llave "0" que el contrato no tiene. */
const SIN_IVA: readonly string[] = ['IVA_0', 'EXENTO', 'NO_OBJETO']

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
      if (SIN_IVA.includes(t) && e.ivaCents !== 0) return null
      const valor = { baseCents: e.baseCents as number, ivaCents: e.ivaCents as number }
      porTratamiento[t as IvaTratamiento] = valor
      suma += valor.baseCents + valor.ivaCents
    }
    return suma === salesCents ? { porTratamiento, taxByRate: tasasDe(porTratamiento) } : null
  }
  // Una versión que este servidor no conoce no es un mapa viejo de tasas: su `v` se sumaría como IVA.
  if ('v' in x) return null
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
 * Base e IVA por tratamiento QUE HOY ESTÁN EN LIBROS para los cobros de una orden: cada venta con la mezcla de la orden (como
 * el estado de resultados) menos cada devolución (`ivaDeDevolucion`: mezcla para las manuales, su reparto congelado —en
 * cualquiera de sus dos formas— para los ajustes del proveedor). Es el saldo del que un retiro nuevo descuenta.
 */
export function enLibrosPorTratamiento(
  cobros: { id: string; type: string | null; amountCents: number; processorData: unknown }[],
  mezcla: MezclaPorTratamiento,
): DesglosePorTratamiento {
  const saldo: DesglosePorTratamiento = {}
  for (const c of cobros) {
    const g = Math.abs(c.amountCents)
    const devolucion = c.type === 'REFUND'
    const { porTratamiento } = devolucion
      ? ivaDeDevolucion(c.id, g, c.processorData, mezcla, { avisar: false })
      : desglosePorTratamiento(g, mezcla)
    sumarDesglose(saldo, porTratamiento, devolucion ? -1 : 1)
  }
  return saldo
}

/**
 * El reparto que se congela en un ajuste nuevo (Ruling 4b-R2): los tratamientos con algo que devolver, y la base ajustada para
 * que base + IVA sume EXACTAMENTE la venta devuelta (la forma vieja lo daba implícito). El resto —el centavo de deriva que el
 * conciliador quitó del IVA, o lo que ya no está en libros porque un reembolso independiente se lo llevó (N-6)— va a la BASE,
 * sin IVA (como antes del plan 4b), de los tratamientos de lo `retirado` en proporción a su importe (Ruling F-2: una devolución
 * exenta no baja la base gravable). Sin renglones retirados con importe, a la base del tratamiento de mayor importe (empate: el
 * primero) y, si no queda ninguno, a IVA_16. Nunca recibe un BLOQUEADO: la conciliación no congela esas órdenes (Ruling 4b-R4).
 */
export function congelarPorTratamiento(
  delta: DesglosePorTratamiento,
  ventaCents: number,
  retirado: MezclaPorTratamiento = [],
): FiscalPorTratamiento {
  type Entrada = [IvaTratamiento, { baseCents: number; ivaCents: number }]
  const porTratamiento: DesglosePorTratamiento = {}
  for (const [t, v] of Object.entries(delta) as Entrada[]) if (v.baseCents !== 0 || v.ivaCents !== 0) porTratamiento[t] = { ...v }
  const importe = (v: { baseCents: number; ivaCents: number }) => v.baseCents + v.ivaCents
  const vivos = Object.entries(porTratamiento) as Entrada[]
  const faltante = ventaCents - vivos.reduce((s, [, v]) => s + importe(v), 0)
  const destinos = retirado.filter(m => m.grossCents > 0)
  if (faltante !== 0 && destinos.length > 0) {
    repartirProporcional(
      faltante,
      destinos.map(m => m.grossCents),
    ).forEach((parte, i) => {
      if (parte !== 0) (porTratamiento[destinos[i].tratamiento] ??= { baseCents: 0, ivaCents: 0 }).baseCents += parte
    })
  } else if (faltante !== 0) {
    const mayor = vivos.reduce<Entrada | null>((m, e) => (!m || importe(e[1]) > importe(m[1]) ? e : m), null)
    if (mayor) mayor[1].baseCents += faltante
    else porTratamiento.IVA_16 = { baseCents: faltante, ivaCents: 0 }
  }
  return { v: 2, porTratamiento }
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
    orderBy: { id: 'asc' },
  })
  return new Map(filas.map(f => [f.id, f.processorData]))
}
