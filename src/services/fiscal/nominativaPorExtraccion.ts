/**
 * IVA por producto, bloque C3 (spec §4.5, D6; Guía del CFDI global, ejemplo III d: el nominativo lleva los productos y unidades
 * específicos): la factura del cliente de un ticket extraído de la global, con sus PRODUCTOS REALES que quedan, cuadrada al centavo
 * con lo extraído y concordante —base, IVA y total por tratamiento— con la asignación de la extracción, con cada centavo registrado. Sin
 * evidencia de qué quedó, se detiene: no hay respaldo genérico (C3-P2). Puro.
 */
import { Prisma } from '@prisma/client'
import type { CfdiItemInput } from './providers/fiscal-provider.interface'
import {
  aplicarAjustes,
  cuadrarPorTasa,
  filasD16DeReales,
  montosDesdeDocumento,
  MOTIVO_ARMADO_NO_CUADRA,
  type ConceptoReal,
} from './globalPorTratamiento'
import { conceptoDesdeElPayload, MOTIVO_OCHO_SIN_REGLA } from './reglaDelPac'
import {
  asignacionFiscal,
  documentoDeConceptos,
  resumenDeConceptos,
  unidadesDeConceptos,
  REDONDEO_PERMITIDO_CENTS,
  TRATAMIENTOS_DE_NOTA,
  type FiscalPorTratamiento,
  type TratamientoDeNota,
} from './saldoFiscal'
import { asignacionDeReales } from './cfdiCreditNote.service'
import { clasificarOrden, impuestosSatDe } from './ivaDeRenglon'
import type { IvaTratamiento } from './ivaTratamiento'
import type { DiferenciaDeConcordancia } from './entradaDocumental'

export const MOTIVO_REMANENTE_NO_TRAZABLE =
  'Esta venta tuvo una devolución parcial de un artículo o por importe dentro de la factura global: no se puede comprobar qué productos quedaron. Factúrala con tu contador.'
export const MOTIVO_SIN_CONCEPTOS_REALES =
  'No se pudo comprobar qué productos tenía esta venta en la factura global; factúrala con tu contador.'
export const MOTIVO_NO_CONCUERDA =
  'Los productos que quedan de esta venta no coinciden, tasa por tasa, con lo que se sacó de la factura global; requiere revisión de soporte.'

/** v7 (C1-43): los reales del ticket con sus filas D16 (congeladas en la global v2). */
export type RealesDelTicket = { reales: ConceptoReal[]; filasD16: string[][] }
/** M7: lo que un artículo devuelto completo difiere de lo facturado de él (acreditado − facturado, con signo), dentro del |ajuste| de su tasa. */
export type RedondeoDeRemanentes = { orderItemId: string; tratamiento: TratamientoDeNota; cents: number }

/** Las claves SAT del catálogo actual de un real; la Tarea 4 las resuelve por su `OrderItem` (el concepto de la factura individual, B11). */
type Claves = (productId: string | null, descripcion: string, orderItemId: string | null) => { satProductKey: string; satUnitKey: string }

/**
 * El concepto de la factura del cliente para un real: sus claves del catálogo actual y su dinero congelado (precio, cantidad, descuento
 * ORIGINAL). Un tratamiento que no se puede timbrar (objeto 03/04) da su motivo, nunca lanza (el lector de la global no lo admite: defensa).
 */
function itemDeReal(r: ConceptoReal, claves: Claves): CfdiItemInput | { motivo: string } {
  const sat = impuestosSatDe(r.tratamiento)
  if ('bloqueado' in sat) return { motivo: sat.motivo }
  const precio = new Prisma.Decimal(r.precio)
  return {
    ...claves(r.productId, r.descripcion, r.orderItemId),
    description: r.descripcion,
    quantity: r.cantidad,
    unitPriceCents: precio.mul(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber(),
    // D9: el precio con más de 2 decimales viaja tal cual (el mismo criterio que `assembleSaleInput`).
    ...(precio.decimalPlaces() > 2 ? { unitPriceDecimal: precio.toFixed(6) } : {}),
    discountCents: r.descuentoCents,
    objetoImp: sat.objetoImp,
    taxes: sat.taxes,
    taxIncluded: r.ivaIncluido,
  }
}

/**
 * Lo que queda del ticket, artículo por artículo. Una nota sin rastro por artículo (por importe, elegida, delivery, v1 o ilegible) ⇒ se
 * detiene (C3-P6). Un artículo sale sólo si se devolvió COMPLETO en cada tratamiento; 🔴 M7 (medido en el reporte de la Tarea 3):
 * «completo» ⇔ |acreditado − facturado| ≤ |ajuste| de su tasa en la asignación de los reales (C2 deja que una nota por artículos lleve
 * hasta ese ajuste de más, y la devolución por lo cobrado queda ese centavo abajo cuando el ajuste del PAC cayó en el artículo). Esa
 * diferencia se devuelve en `redondeo` (sólo si hay). Lo facturado sale de los reales ORIGINALES con lo cobrado del ticket por tasa y sus
 * filas D16 (C2 v6/v7).
 */
export function conceptosRemanentes(
  reales: ConceptoReal[],
  devuelto: { porRenglon: Map<string, Partial<Record<TratamientoDeNota, number>>>; sinTrazaPorArticulo: boolean },
  cobradoPorTasa: Partial<Record<TratamientoDeNota, number>>,
  filasD16: string[][],
): { reales: ConceptoReal[]; redondeo?: RedondeoDeRemanentes[] } | { motivo: string } {
  if (devuelto.sinTrazaPorArticulo) return { motivo: MOTIVO_REMANENTE_NO_TRAZABLE }
  const f = asignacionDeReales(reales, cobradoPorTasa, filasD16)
  if (!f) return { motivo: MOTIVO_SIN_CONCEPTOS_REALES }
  const redondeo: RedondeoDeRemanentes[] = []
  for (const [orderItemId, acreditado] of devuelto.porRenglon) {
    const facturado = f.montos.get(orderItemId)
    if (!facturado) return { motivo: MOTIVO_REMANENTE_NO_TRAZABLE }
    for (const tratamiento of TRATAMIENTOS_DE_NOTA) {
      const cents = (acreditado[tratamiento] ?? 0) - (facturado.porTratamiento[tratamiento] ?? 0)
      if (Math.abs(cents) > Math.abs(f.ajustePorTratamiento[tratamiento] ?? 0)) return { motivo: MOTIVO_REMANENTE_NO_TRAZABLE }
      if (cents) redondeo.push({ orderItemId, tratamiento, cents })
    }
  }
  return {
    reales: reales.filter(r => !r.orderItemId || !devuelto.porRenglon.has(r.orderItemId)),
    ...(redondeo.length ? { redondeo } : {}),
  }
}

export type NominativaPorExtraccion = {
  items: CfdiItemInput[]
  renglones: Array<{ orderItemId: string; tratamiento: IvaTratamiento }>
  montosPorRenglon: Array<{ orderItemId: string; totalCents: number; porTratamiento: Partial<Record<TratamientoDeNota, number>> }>
  clasificacion: 'TODO_16' | 'MIXTA'
  montos: { subtotalCents: number; taxCents: number; totalCents: number }
  diferencias: DiferenciaDeConcordancia[]
}

const COMPONENTES = [
  ['baseCents', 'BASE'],
  ['ivaCents', 'IVA'],
  ['totalCents', 'TOTAL'],
] as const

/**
 * La factura del cliente con los productos que quedan. 🔴 C3-18: ANTES de cualquier ajuste, lo de cada tasa (monto comercial, con el
 * descuento original) tiene que ser lo extraído de ESA tasa (barrera N3 de `cuadrarPorTasa`); si no, no es redondeo y se detiene sin
 * buscar centavos. El ajuste sólo absorbe el redondeo del PAC, en su tasa. C3-9 (sólo con `porTratamiento`: F6 no tiene extracción): con la
 * asignación de C2 (ninguna suma propia), tiene exactamente los tratamientos de la extracción y por tratamiento su base, IVA y total difieren
 * de la extracción a lo más 1 ¢ cada uno; cada diferencia distinta de cero se devuelve (factura del cliente − extracción).
 */
export function nominativaPorExtraccion(p: {
  reales: ConceptoReal[]
  /** v7 (C1-43): las filas D16 del ticket; `filasD16DeReales` cuenta sólo las que tocan estos reales (una fila de un artículo devuelto no). */
  filasD16: string[][]
  claves: Claves
  extraido: { brutoPorTratamiento: Partial<Record<TratamientoDeNota, number>>; porTratamiento?: FiscalPorTratamiento }
}): NominativaPorExtraccion | { motivo: string } {
  if (!p.reales.length) return { motivo: MOTIVO_SIN_CONCEPTOS_REALES }
  const bruto = p.extraido.brutoPorTratamiento
  if (bruto.IVA_8) return { motivo: MOTIVO_OCHO_SIN_REGLA } // la 6b no tiene regla para el 8 % (el mismo freno que la nota y la global)
  const base: CfdiItemInput[] = []
  for (const r of p.reales) {
    const it = itemDeReal(r, p.claves)
    if ('motivo' in it) return it
    base.push(it)
  }
  const extraidoCents = Object.values(bruto).reduce((s, c) => s + (c ?? 0), 0)
  const opts = { cobradoPorTasa: bruto, filasD16: filasD16DeReales(p.filasD16, p.reales) }
  const cuadre = cuadrarPorTasa(base.map(conceptoDesdeElPayload), extraidoCents, opts)
  if (!cuadre.ok) return { motivo: cuadre.motivo.startsWith(MOTIVO_ARMADO_NO_CUADRA) ? MOTIVO_NO_CONCUERDA : cuadre.motivo }
  const items = aplicarAjustes(base, cuadre.ajustes, extraidoCents, opts) // C1-36: confinado por tasa
  if (!items) return { motivo: MOTIVO_NO_CONCUERDA }
  const a = asignacionFiscal(
    unidadesDeConceptos(items, i => p.reales[i].orderItemId ?? `__${i}`),
    documentoDeConceptos(items),
    resumenDeConceptos(items),
  )
  if ('invalido' in a) return { motivo: MOTIVO_NO_CONCUERDA }
  const diferencias: DiferenciaDeConcordancia[] = []
  // F6: sin la asignación de una extracción (`porTratamiento`) no hay documento con qué concordar. `cuadrarPorTasa` sólo cuadra los
  // remanentes con su propio monto comercial (el `bruto` de F6 sale de ellos): no los compara con lo cobrado menos lo devuelto. Eso lo acota
  // el tope de redondeo de `facturaConDevolucion` (I-1: nunca arriba de lo que el cliente se quedó). C3 siempre pasa `porTratamiento`.
  const ext = p.extraido.porTratamiento
  if (ext) {
    const tratamientos = (f: FiscalPorTratamiento) => TRATAMIENTOS_DE_NOTA.filter(t => f[t]).join(',')
    if (tratamientos(a.porTratamiento) !== tratamientos(ext)) return { motivo: MOTIVO_NO_CONCUERDA }
    for (const t of TRATAMIENTOS_DE_NOTA.filter(x => a.porTratamiento[x]))
      for (const [k, componente] of COMPONENTES) {
        const cents = a.porTratamiento[t]![k] - ext[t]![k]
        if (Math.abs(cents) > REDONDEO_PERMITIDO_CENTS) return { motivo: MOTIVO_NO_CONCUERDA }
        if (cents) diferencias.push({ tratamiento: t, componente, cents })
      }
  }
  // La forma de C2 (`entradaDocumental`): un renglón por artículo, ordenado; un concepto sin artículo no es renglón.
  const montosPorRenglon = [...a.porClave]
    .filter(([k]) => !k.startsWith('__'))
    .map(([orderItemId, m]) => {
      const porTratamiento: Partial<Record<TratamientoDeNota, number>> = {}
      for (const t of TRATAMIENTOS_DE_NOTA) if (m[t]) porTratamiento[t] = m[t]!.totalCents
      return { orderItemId, totalCents: Object.values(porTratamiento).reduce((s, c) => s + c, 0), porTratamiento }
    })
    .sort((x, y) => (x.orderItemId < y.orderItemId ? -1 : x.orderItemId > y.orderItemId ? 1 : 0))
  const renglones = montosPorRenglon.map(m => ({
    orderItemId: m.orderItemId,
    tratamiento: p.reales.find(r => r.orderItemId === m.orderItemId)!.tratamiento,
  }))
  return {
    items,
    renglones,
    montosPorRenglon,
    clasificacion: clasificarOrden(p.reales.map(r => r.tratamiento)), // por el contenido (C3-3)
    montos: montosDesdeDocumento(cuadre.documento),
    diferencias,
  }
}
