// src/services/fiscal/ivaMath.ts
//
// Pure money helpers for the IVA-included (GROSS) pricing convention used across Avoqado.
//
// In Mexico, POS / menu prices are quoted IVA-included: the customer's out-of-pocket already
// contains the tax (a "$100" item is paid as $100, with ~$13.79 of that being IVA at 16%).
// A CFDI, however, must itemize base + IVA = total — and that total MUST equal what the
// customer actually paid. So before handing a gross price to the PAC we either tell it the
// price is tax-included (preferred) or split it ourselves for our own stored breakdown.

import { hayBloqueados, resolverTratamiento } from './ivaDeRenglon'
import { tratamientoDesdeTupla, tuplaDesdeTratamiento, type IvaTratamiento } from './ivaTratamiento'

/**
 * Splits an IVA-included (gross) integer-cent amount into its net base + tax for a given rate.
 *
 * The tax absorbs the rounding remainder so `netCents + taxCents === grossCents` EXACTLY,
 * which guarantees the stored breakdown cuadra al centavo and the total equals what was paid.
 * A non-positive rate (exempt / 0%) means there is no IVA to extract: everything is base.
 *
 * @param grossCents IVA-included amount in integer cents (what the customer paid for the line)
 * @param rate       tax rate as a fraction, e.g. 0.16 / 0.08 / 0
 */
export function splitIvaIncluded(grossCents: number, rate: number): { netCents: number; taxCents: number } {
  if (!Number.isFinite(rate) || rate <= 0) return { netCents: grossCents, taxCents: 0 }
  const netCents = Math.round(grossCents / (1 + rate))
  return { netCents, taxCents: grossCents - netCents }
}

/**
 * D19 (spec planes 6-7): reparte `totalCents` entre `pesos` en proporción, al centavo EXACTO. Toma el piso exacto (BigInt) de
 * total·peso/Σ y los centavos que sobran van a los mayores remanentes (empate: el de mayor peso; luego, el primero). Nunca da
 * una parte negativa (H17: el viejo redondeaba hacia arriba y le restaba al más grande) ni pierde un centavo, y con total ≤ Σ
 * ninguna parte rebasa su peso. Total negativo (ajuste de reparto): reparte la magnitud y le devuelve el signo. Pesos negativos
 * cuentan como cero; sin pesos ⇒ `[]`; todos en cero ⇒ el primero se lleva todo (no hay proporción que respetar).
 * Precondición: total y pesos en CENTAVOS ENTEROS (así llegan de sus cinco llamadores); un peso con fracción se redondea.
 */
export function repartirProporcional(totalCents: number, pesos: number[]): number[] {
  if (pesos.length === 0) return []
  const ps = pesos.map(p => (p > 0 ? BigInt(Math.round(p)) : 0n))
  const suma = ps.reduce((a, b) => a + b, 0n)
  if (suma === 0n) return pesos.map((_, i) => (i === 0 ? totalCents : 0))
  const magnitud = BigInt(Math.abs(totalCents))
  const partes = ps.map(p => (magnitud * p) / suma)
  const resto = ps.map((p, i) => magnitud * p - partes[i] * suma)
  let sobran = magnitud - partes.reduce((a, b) => a + b, 0n)
  const orden = ps
    .map((_, i) => i)
    .sort((a, b) => (resto[a] !== resto[b] ? (resto[b] > resto[a] ? 1 : -1) : ps[a] !== ps[b] ? (ps[b] > ps[a] ? 1 : -1) : a - b))
  for (const i of orden) {
    if (sobran === 0n) break
    partes[i] += 1n
    sobran -= 1n
  }
  const signo = totalCents < 0 ? -1 : 1
  return partes.map(p => signo * Number(p) || 0)
}

/**
 * Split an IVA-included total across MULTIPLE tax rates (the real per-product rates of an order),
 * instead of assuming a single flat rate. Each `portions[i].grossCents` is split at its own `rate`
 * via {@link splitIvaIncluded} (exact), so `Σnet + Σtax === Σgross` EXACTLY — the póliza and the IVA
 * declaration cuadran al centavo. Returns the summed net + tax PLUS a per-rate tax map (the SAT IVA
 * declaration reports 16% and 8% separately, so callers need the breakdown, not just the total).
 *
 * `taxByRate` keys are the rate as a string (e.g. `"0.16"`, `"0.08"`); 0%/exempt lines add no key.
 */
export function splitIvaByRate(portions: { grossCents: number; rate: number }[]): {
  netCents: number
  taxCents: number
  taxByRate: Record<string, number>
} {
  let netCents = 0
  let taxCents = 0
  const taxByRate: Record<string, number> = {}
  for (const { grossCents, rate } of portions) {
    const s = splitIvaIncluded(grossCents, rate)
    netCents += s.netCents
    taxCents += s.taxCents
    if (s.taxCents !== 0) {
      const key = String(rate)
      taxByRate[key] = (taxByRate[key] ?? 0) + s.taxCents
    }
  }
  return { netCents, taxCents, taxByRate }
}

/**
 * Split ONE payment's IVA-included amount using the order's REAL per-rate mix. `grossByRate` is the
 * order's gross grouped by tax rate (from its line items). The payment amount is allocated across
 * those rates in proportion to each rate's share of the order (so partial / split payments work),
 * then split at each real rate. Guarantees `netCents + taxCents === paymentGrossCents` EXACTLY.
 *
 * Fallback: when the order has NO line items (e.g. a custom-amount / importe-libre sale), there is
 * no rate to read, so the whole amount is split at `fallbackRate` (default 16%) — the legacy behavior.
 */
export function splitPaymentIvaByOrderRates(
  paymentGrossCents: number,
  grossByRate: { rate: number; grossCents: number }[],
  fallbackRate = 0.16,
): { netCents: number; taxCents: number; taxByRate: Record<string, number> } {
  const meaningful = grossByRate.filter(r => r.grossCents !== 0)
  if (meaningful.length === 0) return splitIvaByRate([{ grossCents: paymentGrossCents, rate: fallbackRate }])
  const alloc = repartirProporcional(
    paymentGrossCents,
    meaningful.map(r => r.grossCents),
  )
  return splitIvaByRate(meaningful.map((r, i) => ({ grossCents: alloc[i], rate: r.rate })))
}

/**
 * Agrupa importes YA NORMALIZADOS y tasas YA RESUELTAS (primitiva aritmética).
 * Para una Order persistida usar `grossByRateFromOrder` en ivaDeOrden: total, cortesías, B2, cargos y
 * tratamiento sellado no se pueden reconstruir sólo con unitPrice y taxRate. El resultado alimenta
 * {@link splitPaymentIvaByOrderRates}. Sin importes devuelve []; el llamador conserva el 16 % de
 * ventas de importe libre. Los valores de entrada son pesos numéricos, la salida es en centavos.
 */
export function grossByRateFromItems(
  items: { unitPrice: number; quantity: number; discountAmount: number; taxRate: number | null }[],
  defaultRate = 0.16,
): { rate: number; grossCents: number }[] {
  const byRate = new Map<number, number>()
  for (const it of items) {
    const rate = it.taxRate != null ? it.taxRate : defaultRate
    const grossCents = Math.round((it.unitPrice * it.quantity - it.discountAmount) * 100)
    if (grossCents === 0) continue
    byRate.set(rate, (byRate.get(rate) ?? 0) + grossCents)
  }
  return [...byRate.entries()].map(([rate, grossCents]) => ({ rate, grossCents }))
}

// ── Plan 4b: el desglose por TRATAMIENTO (spec 4b §4) ──────────────────────────────────────────────────────────────

/** Base e IVA (centavos) por tratamiento. Un tratamiento ausente vale cero. */
export type DesglosePorTratamiento = Partial<Record<IvaTratamiento, { baseCents: number; ivaCents: number }>>
/**
 * La venta de una orden por tratamiento y tasa (IVA incluido, centavos), en el orden en que aparece cada par. La tasa es la del
 * tratamiento (0.16 · 0.08 · 0) y, en un BLOQUEADO, la de su producto TAL CUAL (Ruling 4b-R4).
 */
export type MezclaPorTratamiento = { tratamiento: IvaTratamiento; tasa: number; grossCents: number }[]
/** Lo que se reparte de UN cobro: los totales y `taxByRate` de siempre, más la base e IVA por tratamiento. */
export type DesgloseDeCobro = {
  netCents: number
  taxCents: number
  taxByRate: Record<string, number>
  porTratamiento: DesglosePorTratamiento
}

type Numero = number | { toString(): string }
/** Un renglón tal como sale de Prisma (`OrderItem` con su producto; los Decimal se aceptan tal cual). */
export type RenglonConIva = {
  quantity: number
  unitPrice: Numero
  discountAmount: Numero
  ivaTratamiento: IvaTratamiento | null
  product: { taxRate: Numero | null; ivaTratamiento: IvaTratamiento } | null
}

type Entrada = [IvaTratamiento, { baseCents: number; ivaCents: number }]

/**
 * La mezcla de una orden por tratamiento: el ÚNICO mapeo de renglón a IVA que usan el estado de resultados y el conciliador
 * de reparto. Cada renglón resuelve su tratamiento con `resolverTratamiento` (sellado > producto > IVA_16) y lleva la tasa de
 * ese tratamiento; un BLOQUEADO, la de su producto sin tocar (hoy la reporta así: Ruling 4b-R4). El importe de cada renglón se
 * calcula como en `grossByRateFromItems`.
 */
export function mezclaPorTratamiento(items: RenglonConIva[]): MezclaPorTratamiento {
  const por = new Map<string, MezclaPorTratamiento[number]>()
  for (const it of items) {
    const tratamiento = resolverTratamiento({
      selladoIva: it.ivaTratamiento,
      productoIva: it.product?.ivaTratamiento,
      tieneProducto: it.product != null,
    })
    const tasa = hayBloqueados([tratamiento]) ? Number(it.product?.taxRate ?? 0.16) : tuplaDesdeTratamiento(tratamiento, 0).taxRate
    const grossCents = Math.round((Number(it.unitPrice) * it.quantity - Number(it.discountAmount)) * 100)
    if (grossCents === 0) continue
    const parte = por.get(`${tratamiento}|${tasa}`)
    if (parte) parte.grossCents += grossCents
    else por.set(`${tratamiento}|${tasa}`, { tratamiento, tasa, grossCents })
  }
  return [...por.values()]
}

/**
 * Una mezcla por tasa (la de la póliza, `grossByRateForOrder`) como mezcla por tratamiento, cada parte con SU tasa: 0.16 →
 * IVA_16, 0.08 → IVA_8, 0 → IVA_0; una tasa fuera de ésas sólo la tiene un producto BLOQUEADO y así se etiqueta (la póliza sólo
 * lee las cifras, y las cifras salen de la tasa).
 */
export function mezclaDesdeTasas(g: { rate: number; grossCents: number }[]): MezclaPorTratamiento {
  return g.map(({ rate, grossCents }) => ({ tratamiento: tratamientoDesdeTupla(rate, '02') ?? 'BLOQUEADO_03', tasa: rate, grossCents }))
}

/**
 * El desglose de UN cobro (IVA incluido) con la mezcla de su orden, por tratamiento: el mismo reparto que
 * `splitPaymentIvaByOrderRates` (proporcional al centavo exacto, `repartirProporcional`), cada parte cortada con
 * `splitIvaIncluded` a SU tasa y `taxByRate` con la llave de siempre (`String(tasa)`, sólo con IVA). Sin renglones ⇒ todo al
 * 16 %, como siempre.
 */
export function desglosePorTratamiento(cobroCents: number, mezcla: MezclaPorTratamiento): DesgloseDeCobro {
  const meaningful = mezcla.filter(m => m.grossCents !== 0)
  const partes: MezclaPorTratamiento =
    meaningful.length === 0
      ? [{ tratamiento: 'IVA_16', tasa: 0.16, grossCents: cobroCents }]
      : repartirProporcional(
          cobroCents,
          meaningful.map(m => m.grossCents),
        ).map((grossCents, i) => ({ ...meaningful[i], grossCents }))
  let netCents = 0
  let taxCents = 0
  const taxByRate: Record<string, number> = {}
  const porTratamiento: DesglosePorTratamiento = {}
  for (const p of partes) {
    const s = splitIvaIncluded(p.grossCents, p.tasa)
    netCents += s.netCents
    taxCents += s.taxCents
    if (s.taxCents !== 0) taxByRate[String(p.tasa)] = (taxByRate[String(p.tasa)] ?? 0) + s.taxCents
    const acc = (porTratamiento[p.tratamiento] ??= { baseCents: 0, ivaCents: 0 })
    acc.baseCents += s.netCents
    acc.ivaCents += s.taxCents
  }
  return { netCents, taxCents, taxByRate, porTratamiento }
}

/**
 * El IVA por tasa de un desglose de tratamientos DE CATÁLOGO (16, 8, 0, exento, no objeto), en la forma de `taxByRate` de
 * siempre: llaves "0.16"/"0.08", sin ceros. Un BLOQUEADO no tiene tasa de catálogo y nunca llega aquí: el mapa v2 no lo admite y
 * la conciliación no lo congela (Ruling 4b-R4).
 */
export function tasasDe(d: DesglosePorTratamiento): Record<string, number> {
  const r: Record<string, number> = {}
  for (const [t, v] of Object.entries(d) as Entrada[]) {
    if (v.ivaCents === 0) continue
    const llave = String(tuplaDesdeTratamiento(t, 0).taxRate)
    r[llave] = (r[llave] ?? 0) + v.ivaCents
  }
  return r
}

/** `destino += signo × origen`, tratamiento por tratamiento. */
export function sumarDesglose(destino: DesglosePorTratamiento, origen: DesglosePorTratamiento, signo: 1 | -1): void {
  for (const [t, v] of Object.entries(origen) as Entrada[]) {
    const acc = (destino[t] ??= { baseCents: 0, ivaCents: 0 })
    acc.baseCents += signo * v.baseCents
    acc.ivaCents += signo * v.ivaCents
  }
}
