/**
 * IVA por producto, bloque C1 (spec §4.3, D4): los conceptos de UN ticket en la factura global, la forma de la global y la regla del
 * founder (la global da exactamente lo cobrado, con la función de la 6b). Todo al 16 %: la línea de hoy con su folio. Un solo
 * tratamiento distinto: un concepto normal. Mezclado: UN concepto NETO con una base por tratamiento (sin descuento, nunca ajustable:
 * variante 4) y lo «no objeto» aparte. Puro: sin base, sin reloj.
 */
import { Prisma } from '@prisma/client'
import type { CfdiItemInput, CfdiItemTax, GlobalInvoiceParams } from './providers/fiscal-provider.interface'
import { formaPagoDeLaGlobal, itemDeLineaGlobal, type GlobalInvoiceLine } from './cfdiPayloadBuilder'
import {
  conceptoDesdeElPayload,
  conceptoMultitasaValido,
  conceptosDesdeElPayload,
  conceptoValidoAnteElSat,
  cotaDeRedondeoCents, // 🔴 la cota de B3a, firma final: (conceptos, filasD16). C1 la llama por tasa y por documento; no copia su fórmula
  cuadrarConElPac,
  documentoSegunElPac,
  MOTIVO_CONCEPTO_INVALIDO_ANTE_EL_SAT,
  type AjusteAlCobro,
  type ConceptoParaElPac,
  type DocumentoSegunElPac,
  type TrasladoParaElPac,
} from './reglaDelPac'
import type { ClosedPeriod } from './globalPeriod'
import type { IvaTratamiento } from './ivaTratamiento'

export type TratamientoGlobal = 'IVA_16' | 'IVA_0' | 'EXENTO' | 'NO_OBJETO'
export const TRATAMIENTOS_GLOBAL: readonly TratamientoGlobal[] = ['IVA_16', 'IVA_0', 'EXENTO', 'NO_OBJETO']
/** Lo cobrado (con IVA) por tratamiento, en centavos. */
export type PorTratamientoGlobal = Partial<Record<TratamientoGlobal, number>>

/**
 * C1 → C3: un concepto REAL del ticket (el de la factura individual, B3a), congelado al capturar la global, ya cuadrado con lo cobrado
 * del ticket. C3 factura aparte con esto: productos, cantidades, precios y descuentos que se cobraron. Las claves SAT se resuelven al
 * facturar (son clasificación del catálogo, no dinero).
 */
export interface ConceptoReal {
  orderItemId: string | null
  productId: string | null
  descripcion: string
  /** Precio unitario con hasta 6 decimales (el mismo que usa la 6b en el cargador). */
  precio: string
  cantidad: number
  descuentoCents: number
  ivaIncluido: boolean
  tratamiento: IvaTratamiento
}

/** La foto de UN ticket dentro de la entrada v2 de la global. */
export interface OrdenGlobalV2 {
  orderId: string
  huella: string
  /** NoIdentificacion de sus conceptos (H3): el folio del ticket. */
  folio: string
  /** c_FormaPago del ticket: la forma con que se cobró la mayor cantidad, sumada por forma (ronda 1 de la T6, I3; nunca '99': ese ticket no entra). */
  formaPago: string
  paidCents: number
  /** Lo que se sella (un renglón por `OrderItem`). */
  renglones: Array<{ orderItemId: string; tratamiento: IvaTratamiento }>
  /** Σ = paidCents. */
  porTratamiento: PorTratamientoGlobal
  /** Ticket todo al 16 %: sus líneas de hoy (`globalLinesFromOrder`). */
  lineas?: GlobalInvoiceLine[]
  /** C3: sus conceptos reales, con su descuento ORIGINAL (v5: sin el ajuste del PAC, que cada uso recalcula detrás de la barrera N3);
   * `null` si no cuadran con `paidCents` (la extracción de ese ticket se detendrá con motivo). */
  conceptosReales: ConceptoReal[] | null
  /** v7 (Codex C1-43): sus filas D16 —las que cuenta el cargador individual (`cfdi.service.ts:1759`: IVA aparte y `reduceImpuesto`)—, cada una
   * con los `orderItemId` que toca (llaves de su `reparto.renglones`). `[]` si no tiene. Congeladas: todo lector cuenta con éstas, nunca
   * con lo que diga hoy la orden. */
  filasD16: string[][]
}

const D = Prisma.Decimal
const a6 = (d: Prisma.Decimal) => d.toDecimalPlaces(6, D.ROUND_HALF_UP)
const pesos = (cents: number) => new D(cents).div(100)
const IVA = (rate: number, factor: 'Tasa' | 'Exento' = 'Tasa'): CfdiItemTax => ({ type: 'IVA', factor, rate, withholding: false })

/** C1-P10: cómo va un ticket mezclado. La elige la medición de la Tarea 3 (Paso 7); cada entrada congela la suya. */
export type FormaDelMezclado = 'UN_CONCEPTO' | 'POR_TRATAMIENTO'
export const FORMA_DEL_MEZCLADO: FormaDelMezclado = 'UN_CONCEPTO'

export function conceptosDeOrdenGlobal(
  o: Pick<OrdenGlobalV2, 'folio' | 'porTratamiento' | 'lineas'>,
  forma: FormaDelMezclado = FORMA_DEL_MEZCLADO,
): CfdiItemInput[] {
  if (o.lineas) return o.lineas.map(itemDeLineaGlobal)
  const comun = { satProductKey: '01010101', satUnitKey: 'ACT', description: 'Venta', quantity: 1, discountCents: 0, sku: o.folio }
  const p = o.porTratamiento
  const partes = (
    [
      ['IVA_16', IVA(0.16)],
      ['IVA_0', IVA(0)],
      ['EXENTO', IVA(0, 'Exento')],
    ] as const
  ).filter(([t]) => (p[t] ?? 0) > 0)
  const items: CfdiItemInput[] = []
  if (partes.length > 1 && forma === 'POR_TRATAMIENTO') {
    // Respaldo de D4: un concepto normal por tratamiento, con el mismo folio; todos ajustables.
    for (const [t, tax] of partes) items.push({ ...comun, unitPriceCents: p[t]!, objetoImp: '02', taxIncluded: true, taxes: [tax] })
  } else if (partes.length === 1) {
    // Un solo tratamiento: concepto normal (IVA incluido), ajustable.
    const [t, tax] = partes[0]
    items.push({ ...comun, unitPriceCents: p[t]!, objetoImp: '02', taxIncluded: true, taxes: [tax] })
  } else if (partes.length > 1) {
    // Mezclado: UN concepto neto con una base por tratamiento (Guía del CFDI global p. 17: «se debe expresar en diferentes apartados»).
    let precio = new D(0)
    const taxes = partes.map(([t, tax]) => {
      const base = t === 'IVA_16' ? a6(pesos(p[t]!).div(1.16)) : pesos(p[t]!)
      precio = precio.plus(base)
      return { ...tax, base: base.toFixed(6) }
    })
    items.push({
      ...comun,
      unitPriceCents: precio.mul(100).toDecimalPlaces(0, D.ROUND_HALF_UP).toNumber(),
      ...(precio.decimalPlaces() > 2 ? { unitPriceDecimal: precio.toFixed(6) } : {}),
      objetoImp: '02',
      taxes,
      taxIncluded: false,
    })
  }
  if (p.NO_OBJETO) items.push({ ...comun, unitPriceCents: p.NO_OBJETO, objetoImp: '01', taxes: [], taxIncluded: false })
  return items
}

export function paramsDeLaGlobal(
  emisor: { lugarExpedicion: string; serie?: string | null },
  ordenes: Array<Pick<OrdenGlobalV2, 'orderId' | 'paidCents' | 'formaPago' | 'folio' | 'porTratamiento' | 'lineas'>>,
  period: Pick<ClosedPeriod, 'facturaPeriodicity' | 'meses' | 'anio'>,
  forma: FormaDelMezclado = FORMA_DEL_MEZCLADO,
): GlobalInvoiceParams {
  return {
    receptor: { legal_name: 'PÚBLICO EN GENERAL', tax_id: 'XAXX010101000', tax_system: '616', address: { zip: emisor.lugarExpedicion } },
    items: ordenes.flatMap(o => conceptosDeOrdenGlobal(o, forma)),
    payment_form: formaPagoDeLaGlobal(ordenes),
    use: 'S01',
    ...(emisor.serie ? { serie: emisor.serie } : {}),
    global: { periodicity: period.facturaPeriodicity, months: period.meses, year: period.anio },
  }
}

/** Lo que guarda la fila `Cfdi` (contrato de la 6b): base neta del descuento, el IVA de cada tasa y el total. */
export function montosDesdeDocumento(d: DocumentoSegunElPac): { subtotalCents: number; taxCents: number; totalCents: number } {
  return { subtotalCents: d.subtotalCents - d.descuentoCents, taxCents: d.ivaCents, totalCents: d.totalCents }
}

const conBase = (it: CfdiItemInput) => it.taxes.some(t => t.base !== undefined)
/**
 * Cada concepto, válido ante el SAT: el mezclado con su regla (`conceptoMultitasaValido`: cantidad 1, sin descuento, bases que suman el
 * precio…); los demás con la de la 6b. Nunca lanza (ronda 1 de la Tarea 3): un concepto que no se puede leer —p. ej. dos traslados de IVA
 * sin `base`, que la guarda de `conceptoDesdeElPayload` rechaza— no es válido.
 */
export function conceptosValidos(items: CfdiItemInput[]): boolean {
  try {
    return items.every(it => (conBase(it) ? conceptoMultitasaValido(it) : conceptoValidoAnteElSat(conceptoDesdeElPayload(it))))
  } catch {
    return false
  }
}
/** Ronda 1 (Tarea 3): las partes de la 6b de cada item y de qué item salió cada una, sin lanzar; `null` si algún item no se puede leer. */
function partesDeLosItems(items: CfdiItemInput[]): { conceptos: ConceptoParaElPac[]; mapa: number[] } | null {
  try {
    const mapa: number[] = []
    const conceptos = items.flatMap((it, i) => conceptosDesdeElPayload(it).map(c => (mapa.push(i), c)))
    return { conceptos, mapa }
  } catch {
    return null
  }
}
const SIN_MONTOS = Object.freeze({ subtotalCents: 0, taxCents: 0, totalCents: 0 })

/** El traslado de la 6b de un tratamiento (B3a no exporta uno por tratamiento: éste es el único). */
export function trasladoDeTratamiento(t: IvaTratamiento): TrasladoParaElPac {
  return t === 'IVA_16'
    ? { factor: 'Tasa', tasa: 0.16 }
    : t === 'IVA_8'
      ? { factor: 'Tasa', tasa: 0.08 }
      : t === 'IVA_0'
        ? { factor: 'Tasa', tasa: 0 }
        : t === 'EXENTO'
          ? { factor: 'Exento' }
          : null
}
/** Un concepto real (C1 → C2/C3) como concepto de la 6b, con su descuento ORIGINAL. */
export const conceptoDeReal = (r: ConceptoReal): ConceptoParaElPac => ({
  precio: new D(r.precio),
  cantidad: r.cantidad,
  descuentoCents: r.descuentoCents,
  ivaIncluido: r.ivaIncluido,
  traslado: trasladoDeTratamiento(r.tratamiento),
  nombre: r.descripcion,
})

export type TasaDeCuadre = 'IVA_16' | 'IVA_8' | 'IVA_0' | 'EXENTO' | 'NO_OBJETO'
const tasaDeCuadre = (c: ConceptoParaElPac): TasaDeCuadre =>
  !c.traslado
    ? 'NO_OBJETO'
    : c.traslado.factor === 'Exento'
      ? 'EXENTO'
      : c.traslado.tasa === 0.16
        ? 'IVA_16'
        : c.traslado.tasa === 0.08
          ? 'IVA_8'
          : 'IVA_0'
const ETIQUETA_DE_TASA: Record<TasaDeCuadre, string> = {
  IVA_16: '16 %',
  IVA_8: '8 %',
  IVA_0: '0 %',
  EXENTO: 'exento',
  NO_OBJETO: 'no objeto',
}
const $ = (c: number) => `$${(c / 100).toFixed(2)}`

/**
 * C1 v7 (Codex C1-39, C1-43): las filas D16 que participan en unos conceptos. D16 redondea UNA VEZ POR FILA, por eso la cota de B3a las
 * recibe (`cotaDeRedondeoCents(conceptos, filasD16)`). `documento` = esas filas, una vez cada una (como el cargador individual); `porTasa` =
 * en cada tasa, las filas que tocan algún renglón de esa tasa (una fila de otra tasa no ensancha la tolerancia de ésta).
 */
export type FilasD16 = { documento: number; porTasa: Partial<Record<TasaDeCuadre, number>> }
/**
 * Para un documento sin filas D16 que participen; cada uso dice por qué (notas, extracción, conceptos armados de lo cobrado). Congelado:
 * es compartido por todas las llamadas, y una escritura accidental cambiaría la cota de todas.
 */
export const SIN_FILAS_D16: FilasD16 = Object.freeze({ documento: 0, porTasa: Object.freeze({}) }) as FilasD16

/**
 * `filas`: una entrada por fila D16 con los `orderItemId` que toca. `tasaDelRenglon`: la tasa de cada renglón de ESTOS conceptos. Una fila que
 * sólo toca renglones ajenos (un subconjunto: los remanentes de C3) no cuenta. Una fila sin renglones no se puede atribuir: cuenta en el
 * documento y en cada tasa presente (sólo ensancha la entrada; el resultado sigue exacto). Así el ticket entero cuenta EXACTAMENTE las mismas
 * filas que el cargador individual.
 */
export function filasD16De(filas: string[][], tasaDelRenglon: Map<string, TasaDeCuadre>): FilasD16 {
  const presentes = new Set(tasaDelRenglon.values())
  const r: FilasD16 = { documento: 0, porTasa: {} }
  for (const ids of filas) {
    const tocadas = new Set(ids.flatMap(id => (tasaDelRenglon.has(id) ? [tasaDelRenglon.get(id)!] : [])))
    if (ids.length && !tocadas.size) continue
    r.documento++
    for (const t of tocadas.size ? tocadas : presentes) r.porTasa[t] = (r.porTasa[t] ?? 0) + 1
  }
  return r
}
/** Las de unos conceptos reales (el ticket entero, o sus remanentes en C3). */
export const filasD16DeReales = (filas: string[][], reales: ConceptoReal[]): FilasD16 =>
  filasD16De(filas, new Map(reales.flatMap(r => (r.orderItemId ? [[r.orderItemId, tasaDeCuadre(conceptoDeReal(r))] as const] : []))))
/**
 * Las de un ticket DENTRO de la global. Sólo cuentan si sus conceptos son sus líneas (`lineas`): con IVA aparte el precio de la línea es la base
 * de sus artículos y el redondeo de D16 sigue ahí. Sin `lineas`, `conceptosDeOrdenGlobal` arma los conceptos con lo cobrado por tratamiento:
 * su monto comercial es exactamente lo cobrado por construcción (también el mezclado: r6(g / 1.16) × 1.16 redondeado da g), así que las
 * filas D16 ya están dentro del precio y no abren diferencia ⇒ cero.
 */
export const filasD16DeOrdenGlobal = (o: Pick<OrdenGlobalV2, 'filasD16' | 'renglones' | 'lineas'>): FilasD16 =>
  o.lineas ? filasD16De(o.filasD16, new Map(o.renglones.map(r => [r.orderItemId, r.tratamiento as TasaDeCuadre] as const))) : SIN_FILAS_D16
export function sumarFilasD16(fs: FilasD16[]): FilasD16 {
  const r: FilasD16 = { documento: 0, porTasa: {} }
  for (const f of fs) {
    r.documento += f.documento
    for (const [t, n] of Object.entries(f.porTasa) as Array<[TasaDeCuadre, number]>) r.porTasa[t] = (r.porTasa[t] ?? 0) + n
  }
  return r
}

/**
 * C1 v5 (Codex C1-30): monto COMERCIAL de los conceptos, en centavos, ANTES de la regla del PAC —la barrera N3 del cargador individual,
 * `cfdi.service.ts:1070` (`totalDelDocumentoCents`, usada en `:1757`)—: IVA incluido ⇒ precio × cantidad (redondeado una vez) − descuento;
 * neto ⇒ eso con su IVA; una parte de un concepto con varias bases (`ajustable: false`) ⇒ su base a 6 decimales con su IVA, sin redondear antes.
 */
export function montoComercialCents(cs: ConceptoParaElPac[]): number {
  return cs.reduce((suma, c) => {
    const t = c.traslado?.factor === 'Tasa' ? new D(c.traslado.tasa) : new D(0)
    const bruto = new D(String(c.precio)).mul(String(c.cantidad)).mul(100)
    if (c.ajustable === false) return suma + bruto.minus(c.descuentoCents).mul(t.plus(1)).toDecimalPlaces(0, D.ROUND_HALF_UP).toNumber()
    const neto = bruto.toDecimalPlaces(0, D.ROUND_HALF_UP).minus(c.descuentoCents)
    return suma + (c.ivaIncluido ? neto : neto.mul(t.plus(1)).toDecimalPlaces(0, D.ROUND_HALF_UP)).toNumber()
  }, 0)
}

export const MOTIVO_ARMADO_NO_CUADRA =
  'Los conceptos de esta factura no suman lo cobrado: no es un redondeo, es un error al armarla. No se timbró; repórtalo a soporte.'
export const MOTIVO_REDONDEO_ENTRE_TASAS =
  'Cada tasa cuadra por separado, pero el documento completo no da lo cobrado por un redondeo entre tasas. No se timbró; repórtalo a soporte.'
export const MOTIVO_REDONDEO_SIN_TASA =
  'La diferencia de redondeo no se puede atribuir a una tasa sin saber lo cobrado de cada una. No se timbró; repórtalo a soporte.'
export type CuadrePorTasa = { ok: true; ajustes: AjusteAlCobro[]; documento: DocumentoSegunElPac } | { ok: false; motivo: string }
type Objetivos = { ok: true; grupos: Map<TasaDeCuadre, number[]>; objetivo: Map<TasaDeCuadre, number> } | { ok: false; motivo: string }

/**
 * C1 v6 (Codex C1-35, C1-36; respuesta del controlador a la v5): LO COBRADO de cada tasa —el objetivo de la búsqueda Y de la reproducción—
 * con la barrera N3 a la entrada. Con `cobradoPorTasa`, ése es el objetivo (y tiene que sumar `cobradoCents`); sin él, el monto comercial de
 * cada tasa si el documento ya da lo cobrado, o lo cobrado entero si hay UNA sola tasa; con varias tasas y una diferencia, no se adivina a
 * cuál le toca. La barrera, con la cota de B3a (`cotaDeRedondeoCents(conceptos, filasD16)`): en el documento, |comercial − cobrado| ≤ la cota de
 * TODOS los conceptos con TODAS las filas; 🔴 v7 (Codex C1-39) en cada tasa, |comercial − objetivo| ≤ la cota de LOS CONCEPTOS DE ESA TASA con
 * SUS filas (`filasD16.porTasa`): 120 conceptos al 0 % no le prestan tolerancia a un concepto al 16 %. La cota sólo deja ENTRAR a la búsqueda:
 * el resultado final es exacto.
 */
function objetivosPorTasa(
  conceptos: ConceptoParaElPac[],
  cobradoCents: number,
  cobradoPorTasa: Partial<Record<TasaDeCuadre, number>> | undefined,
  filasD16: FilasD16,
): Objetivos {
  const grupos = new Map<TasaDeCuadre, number[]>()
  conceptos.forEach((c, i) => grupos.set(tasaDeCuadre(c), [...(grupos.get(tasaDeCuadre(c)) ?? []), i]))
  const comercial = new Map([...grupos].map(([t, is]) => [t, montoComercialCents(is.map(i => conceptos[i]))] as const))
  const total = [...comercial.values()].reduce((a, b) => a + b, 0)
  const armado = (detalle: string) => ({ ok: false as const, motivo: `${MOTIVO_ARMADO_NO_CUADRA} (${detalle})` })
  // C1-43: una cuenta que no es un entero ≥ 0 haría NaN la cota, y `diferencia > NaN` es falso: la barrera dejaría de operar. Se detiene.
  if (![filasD16.documento, ...Object.values(filasD16.porTasa)].every(n => Number.isSafeInteger(n) && n! >= 0))
    return armado('las filas D16 no son una cuenta válida')
  let objetivo: Map<TasaDeCuadre, number>
  if (cobradoPorTasa) {
    const llaves = new Set([...grupos.keys(), ...(Object.keys(cobradoPorTasa) as TasaDeCuadre[])])
    if ([...llaves].some(t => !grupos.has(t) && (cobradoPorTasa[t] ?? 0) !== 0)) return armado('se cobró una tasa que no tiene conceptos')
    objetivo = new Map([...grupos.keys()].map(t => [t, cobradoPorTasa[t] ?? 0] as const))
    if ([...objetivo.values()].reduce((a, b) => a + b, 0) !== cobradoCents) return armado('lo cobrado por tasa no suma lo cobrado')
  } else if (total === cobradoCents) objetivo = comercial
  else if (grupos.size === 1) objetivo = new Map([[[...grupos.keys()][0], cobradoCents]])
  else return { ok: false, motivo: MOTIVO_REDONDEO_SIN_TASA }
  if (Math.abs(total - cobradoCents) > cotaDeRedondeoCents(conceptos, filasD16.documento))
    return armado(`suman ${$(total)}; se cobró ${$(cobradoCents)}`)
  for (const [t, o] of objetivo) {
    const cota = cotaDeRedondeoCents(
      grupos.get(t)!.map(i => conceptos[i]),
      filasD16.porTasa[t] ?? 0,
    ) // C1-39: sólo los conceptos y las filas de ESTA tasa
    if (Math.abs(comercial.get(t)! - o) > cota) return armado(`al ${ETIQUETA_DE_TASA[t]} suman ${$(comercial.get(t)!)}; le toca ${$(o)}`)
  }
  return { ok: true, grupos, objetivo }
}

/**
 * C1 v5/v6 (Codex C1-30, C1-35, C2-23, C3-18): la ÚNICA puerta a `cuadrarConElPac` en C1, C2 y C3.
 * 1. Barrera N3 (`objetivosPorTasa`): sólo una diferencia de REDONDEO, dentro de la cota de B3a, entra a la búsqueda; más allá, error de armado.
 * 2. Cada tasa se cuadra SOLA, sólo con los descuentos de SUS conceptos, contra LO COBRADO de esa tasa (nunca contra su monto comercial).
 * 3. El documento completo tiene que dar EXACTAMENTE lo cobrado (el redondeo de SubTotal y Descuento cruza tasas); si no, se detiene.
 * Los índices de `ajustes` son de `conceptos`.
 * v7 (C1-43): `filasD16` es OBLIGATORIO: cada llamada declara las suyas (el compilador no deja olvidarlas).
 */
export function cuadrarPorTasa(
  conceptos: ConceptoParaElPac[],
  cobradoCents: number,
  opts: { cobradoPorTasa?: Partial<Record<TasaDeCuadre, number>>; filasD16: FilasD16 },
): CuadrePorTasa {
  const o = objetivosPorTasa(conceptos, cobradoCents, opts.cobradoPorTasa, opts.filasD16)
  if (!o.ok) return o
  const ajustes: AjusteAlCobro[] = []
  const nuevos = [...conceptos]
  for (const [t, is] of o.grupos) {
    const r = cuadrarConElPac(
      is.map(i => conceptos[i]),
      o.objetivo.get(t)!,
      { desbloqueado: false },
    ) // C1-35: contra lo COBRADO de la tasa
    if (!r.ok) return { ok: false, motivo: r.motivo }
    for (const a of r.ajustes) {
      ajustes.push({ ...a, indice: is[a.indice] })
      nuevos[is[a.indice]] = { ...nuevos[is[a.indice]], descuentoCents: a.aCents }
    }
  }
  const documento = documentoSegunElPac(nuevos)
  if (documento.totalCents !== cobradoCents) return { ok: false, motivo: MOTIVO_REDONDEO_ENTRE_TASAS }
  return { ok: true, ajustes: ajustes.sort((a, b) => a.indice - b.indice), documento }
}

export type CuadreDeLaGlobal =
  | { ok: true; items: CfdiItemInput[]; ajustes: AjusteAlCobro[]; montos: ReturnType<typeof montosDesdeDocumento> }
  | { ok: false; motivo: string; montos: ReturnType<typeof montosDesdeDocumento> }

/**
 * 🔴 Regla del founder (5-oct) en la global: el documento da exactamente lo cobrado. v5: por `cuadrarPorTasa` (barrera N3 y cada tasa
 * sola); los mezclados entran como partes no ajustables. Los índices de `ajustes` son de `items` (un concepto ajustable es uno solo: el
 * mapa es 1 a 1).
 */
export function cuadrarLaGlobal(
  items: CfdiItemInput[],
  cobradoCents: number,
  opts: { cobradoPorTasa?: PorTratamientoGlobal; filasD16: FilasD16 },
): CuadreDeLaGlobal {
  // Ronda 1: un item que no se puede leer no tiene documento (montos en cero: la captura diagnóstica no lo reproduce y va a soporte).
  const partes = partesDeLosItems(items)
  if (!partes) return { ok: false, motivo: MOTIVO_CONCEPTO_INVALIDO_ANTE_EL_SAT, montos: { ...SIN_MONTOS } }
  const { conceptos, mapa } = partes
  const montos = montosDesdeDocumento(documentoSegunElPac(conceptos))
  if (!conceptosValidos(items)) return { ok: false, motivo: MOTIVO_CONCEPTO_INVALIDO_ANTE_EL_SAT, montos }
  const c = cuadrarPorTasa(conceptos, cobradoCents, opts) // C1-30/C1-35/C1-39: barrera N3 (cota por tasa) y cada tasa sola, contra lo cobrado de cada una
  if (!c.ok) return { ok: false, motivo: c.motivo, montos }
  const ajustes = c.ajustes.map(a => ({ ...a, indice: mapa[a.indice] }))
  const nuevos = items.map((it, i) => {
    const a = ajustes.find(x => x.indice === i)
    return a ? { ...it, discountCents: a.aCents } : it
  })
  return { ok: true, items: nuevos, ajustes, montos: montosDesdeDocumento(c.documento) }
}

/**
 * El lector, la recuperación y el saldo reproducen lo congelado SIN volver a buscar (si la 6b cambia de algoritmo, las globales ya
 * timbradas se siguen leyendo). Sin techo de centavos (Codex C1-11: la v4 despeja los lineales sin tope): cada ajuste sobre un concepto
 * de un solo traslado, una vez, con el descuento de origen que tenía, y el concepto que resulta válido ante el SAT. Que el documento dé
 * lo cobrado lo comprueba el lector (modo «para enviar»), no esta función. `null` = la entrada no corresponde a sus tickets.
 * 🔴 v5/v6 (Codex C1-30, C1-36): la misma barrera N3 antes de reproducir (`objetivosPorTasa`) y, DESPUÉS, el confinamiento: el documento
 * de cada tasa tiene que dar lo cobrado de ESA tasa y el documento completo, lo cobrado. Unos ajustes que compensan entre tasas (16 % +1 ¢,
 * 0 % −1 ¢) dan el mismo total y aun así se rechazan.
 */
export function aplicarAjustes(
  items: CfdiItemInput[],
  ajustes: AjusteAlCobro[],
  cobradoCents: number,
  opts: { cobradoPorTasa?: Partial<Record<TasaDeCuadre, number>>; filasD16: FilasD16 },
): CfdiItemInput[] | null {
  // Ronda 1 (revisión de la Tarea 3, Important #2): la entrada se valida ENTERA antes de reproducir, como hace `cuadrarLaGlobal` al
  // capturarla: un mezclado alterado (descuento, precio ≠ Σ bases, cantidad ≠ 1) el PAC lo timbraría distinto, y un item ilegible da `null`.
  const partes = partesDeLosItems(items)
  if (!partes || !conceptosValidos(items)) return null
  const o = objetivosPorTasa(partes.conceptos, cobradoCents, opts.cobradoPorTasa, opts.filasD16)
  if (!o.ok) return null
  const vistos = new Set<number>()
  const nuevos = [...items]
  for (const a of ajustes) {
    const it = items[a.indice]
    if (!it || vistos.has(a.indice) || conBase(it) || it.discountCents !== a.deCents || !Number.isSafeInteger(a.aCents) || a.aCents < 0)
      return null
    vistos.add(a.indice)
    nuevos[a.indice] = { ...it, discountCents: a.aCents }
    if (!conceptoValidoAnteElSat(conceptoDesdeElPayload(nuevos[a.indice]))) return null
  }
  // C1-36: confinamiento. Las partes van en el mismo orden que antes (sólo cambió un descuento), así que los grupos de `o` siguen valiendo.
  const cs = nuevos.flatMap(conceptosDesdeElPayload)
  for (const [t, is] of o.grupos) if (documentoSegunElPac(is.map(i => cs[i])).totalCents !== o.objetivo.get(t)) return null
  return documentoSegunElPac(cs).totalCents === cobradoCents ? nuevos : null
}

/**
 * C1 (Codex C1-8): de qué emisor es una venta y si entra a SU global. `SIN_TERMINAL` (ajuste del founder, 7-oct): cobrada sólo fuera de la
 * terminal, con un solo RFC, y el dueño no pidió esas ventas en su global.
 */
export type Pertenencia = 'CANDIDATA' | 'AJENA' | 'EFECTIVO' | 'COMERCIO_FUERA' | 'SIN_EMISOR' | 'SIN_TERMINAL'
/** La configuración fiscal del comercio de un cobro (`MerchantFiscalConfig`). */
export type ConfigFiscal = { fiscalEmisorId: string; facturacionEnabled: boolean; includeInGlobal: boolean }

/**
 * C1 (Codex C1-8): de quién es una venta y si entra a la global de este emisor. La MISMA regla que `dondePertenece` (SQL).
 * Precondición: `pagos` son SÓLO los cobros elegibles (`COBRO` de `cfdiGlobal.service.ts`: completados, tipo `REGULAR`/`FAST`/nulo; nunca `TEST` ni reembolsos).
 */
export function pertenenciaAlEmisor(
  pagos: Array<{ method: string; conComercio: boolean; config: ConfigFiscal | null }>,
  emisor: { id: string; invoiceCashSales: boolean; includeOffTerminalSalesInGlobal: boolean },
  unSoloEmisor: boolean,
): Pertenencia {
  const conComercio = pagos.filter(p => p.conComercio)
  const efectivoFuera = !emisor.invoiceCashSales && pagos.some(p => p.method === 'CASH')
  // Sin cobros con comercio (efectivo, transferencia, vales, tipos propios): con varios RFC, nadie sabe de quién es. Con uno solo es de él
  // (P3), pero 🔴 ajuste del founder (7-oct): la configuración del dueño manda; sólo entra a su global si pidió esas ventas
  // (`includeOffTerminalSalesInGlobal`, apagado de fábrica), y el efectivo además con «Facturar efectivo».
  if (!conComercio.length) {
    if (!unSoloEmisor) return 'SIN_EMISOR'
    if (!emisor.includeOffTerminalSalesInGlobal) return 'SIN_TERMINAL'
    return efectivoFuera ? 'EFECTIVO' : 'CANDIDATA'
  }
  const nuestros = conComercio.filter(p => p.config?.fiscalEmisorId === emisor.id)
  // Ningún comercio nuestro: si alguno está configurado, es de otro RFC (no se lista aquí); si no, de nadie (se lista a todos).
  if (!nuestros.length) return conComercio.some(p => p.config) ? 'AJENA' : 'SIN_EMISOR'
  const compatible = (p: (typeof conComercio)[number]) =>
    p.config?.fiscalEmisorId === emisor.id && p.config.facturacionEnabled && p.config.includeInGlobal
  if (!conComercio.every(compatible)) return 'COMERCIO_FUERA'
  return efectivoFuera ? 'EFECTIVO' : 'CANDIDATA'
}

/**
 * C1 (§4.3): por qué una venta del periodo NO entra a la factura global. Lista CERRADA: una venta, un motivo.
 * - De configuración (`dondePertenece`, antes de leer la venta): `EFECTIVO`, `COMERCIO_FUERA`, `SIN_EMISOR`, `SIN_TERMINAL`
 *   (`MOTIVOS_DE_CONFIGURACION`; los cuenta `contarExcluidasPorConfiguracion`).
 * - De contenido (`ticketParaGlobal`, `cfdiGlobal.service.ts`): `SIN_PAGAR`, `SIN_IMPORTE`, `FORMA_DE_PAGO_SIN_DEFINIR`,
 *   `PRODUCTO_POR_REVISAR`, `CARGO_POR_SERVICIO`, `OCHO_SIN_REGLA`, `IVA_APARTE_MIXTA`, `CONTRATO_DESCONOCIDO`, `DESCUENTO_SIN_REPARTO`,
 *   `NO_CUADRA` y `OTRO` (el detalle dice cuál).
 * - Del listado y la complementaria: `CORREGIDA_DESPUES` (Tareas 11 y 12) y `YA_EXTRAIDO` (C3).
 */
export type MotivoExclusionGlobal =
  | 'EFECTIVO'
  | 'COMERCIO_FUERA'
  | 'SIN_EMISOR'
  | 'SIN_TERMINAL'
  | 'SIN_PAGAR'
  | 'FORMA_DE_PAGO_SIN_DEFINIR'
  | 'PRODUCTO_POR_REVISAR'
  | 'DESCUENTO_SIN_REPARTO'
  | 'CONTRATO_DESCONOCIDO'
  | 'IVA_APARTE_MIXTA'
  | 'OCHO_SIN_REGLA'
  | 'CARGO_POR_SERVICIO'
  | 'SIN_IMPORTE'
  | 'NO_CUADRA'
  | 'CORREGIDA_DESPUES'
  | 'YA_EXTRAIDO'
  | 'OTRO'

/** Lo que ve quien factura (pantalla y MCP), en español llano: qué pasó y qué hacer. */
export const TEXTO_EXCLUSION_GLOBAL: Readonly<Record<MotivoExclusionGlobal, string>> = Object.freeze({
  EFECTIVO:
    'Se cobró (toda o en parte) en efectivo y este RFC no incluye el efectivo en su factura global. Si quieres incluirlo, activa «Facturar ventas en efectivo» en la configuración fiscal.',
  COMERCIO_FUERA:
    'Se cobró con un comercio que no entra a la factura global de este RFC (facturación apagada, «Incluir en la global» apagado o configurado a otro RFC). Revisa la configuración fiscal del comercio.',
  SIN_EMISOR:
    'Se cobró sin comercio o con un comercio sin configuración fiscal, y el negocio tiene varios RFC: no se sabe a cuál pertenece. Configura el comercio o factúrala aparte.',
  // Ajuste del founder (7-oct): la configuración del dueño manda; el texto dice dónde prenderlo.
  SIN_TERMINAL:
    'Se cobró fuera de la terminal y tu configuración no incluye esas ventas en la factura global. Puedes activarlo en Facturación → tu RFC.',
  SIN_PAGAR: 'No tiene cobros que cuenten como venta (sólo pruebas, ajustes o devoluciones, o ninguno): no hay nada que facturar.',
  FORMA_DE_PAGO_SIN_DEFINIR:
    'La mayor parte de esta venta se cobró con un tipo de pago sin forma del SAT: asígnala en Configuración → Tipos de pago para las próximas ventas; para ésta, escríbenos a soporte.',
  PRODUCTO_POR_REVISAR:
    'Tiene un producto con el IVA por revisar (objeto de impuesto 03 o 04); corrígelo en el catálogo y la venta entrará a la siguiente factura global.',
  DESCUENTO_SIN_REPARTO:
    'Tiene un descuento de toda la cuenta sin constancia de a qué productos se aplicó, y sus productos llevan IVA distinto: no se sabe cuánto descontar de cada tasa. Factúrala aparte o repórtala a soporte.',
  CONTRATO_DESCONOCIDO:
    'Tiene productos con IVA distinto de 16 % y no consta que se cobró con IVA incluido; confírmalo en la venta y entrará a la siguiente factura global.',
  IVA_APARTE_MIXTA:
    'Cobró el IVA aparte y tiene productos con IVA distinto de 16 %: no se puede facturar desde Avoqado. Si necesitas factura, escríbenos a soporte.',
  OCHO_SIN_REGLA:
    'Lleva productos al 8 % (frontera) y todavía no está comprobado cómo redondea el SAT esa tasa, así que no se puede asegurar que la factura dé exactamente lo cobrado. Factúrala con tu contador.',
  CARGO_POR_SERVICIO: 'La cuenta lleva cargo por servicio; la facturación de cargos por servicio llega en una versión siguiente.',
  SIN_IMPORTE: 'No tiene importe que facturar: todos sus artículos son cortesía o tienen descuento completo, o se cobró $0.',
  NO_CUADRA:
    'Lo cobrado no coincide con sus productos, o no hay forma de que la factura dé exactamente lo cobrado con el redondeo del SAT. No se declara con centavos inventados; revísala o repórtala a soporte.',
  // T11: ahora tiene camino (la complementaria del periodo, que pide una persona).
  CORREGIDA_DESPUES:
    'No está en ninguna factura global vigente de su periodo (se corrigió después de timbrarla, o su global se canceló). Emite una global complementaria del periodo.',
  // v9 (Codex C1-47): menciona soporte; la prueba del listado (Tarea 12) y la de C3 (Tarea 5) lo comprueban en `texto`.
  YA_EXTRAIDO:
    'Ya está documentada por una nota de extracción de su factura nominativa (viva o cancelada) y no vuelve sola a ninguna factura global; pídelo a soporte.',
  OTRO: 'No se pudo armar su concepto para la factura global; el detalle dice por qué. Si no sabes cómo corregirla, repórtala a soporte.',
})

/**
 * Ronda 1 (I2): el texto de `FORMA_DE_PAGO_SIN_DEFINIR` cuando la parte sin forma SAT NO es un tipo de pago propio (monedero, cripto, un `OTHER`
 * sin tipo del catálogo): esos no aparecen en Configuración → Tipos de pago, así que mandar ahí sería un callejón sin salida.
 */
export const TEXTO_FORMA_DE_PAGO_SIN_CATALOGO =
  'Este tipo de cobro no tiene una forma de pago del SAT, así que no puede ir en la factura global. Escríbenos a soporte para facturarla.'

/** Cuántas ventas quedaron fuera, por motivo (sólo los que aparecieron). */
export type ExcluidasPorMotivo = Partial<Record<MotivoExclusionGlobal, number>>

/**
 * Los motivos que la respuesta vieja contaba como `excluidasPorIvaMixto` (el campo se conserva: nunca se quita uno de una respuesta).
 * Son los que vienen del IVA de los productos o del contrato con que se cobró.
 */
export const MOTIVOS_DE_IVA: readonly MotivoExclusionGlobal[] = Object.freeze([
  'PRODUCTO_POR_REVISAR',
  'DESCUENTO_SIN_REPARTO',
  'CONTRATO_DESCONOCIDO',
  'IVA_APARTE_MIXTA',
  'OCHO_SIN_REGLA',
] as const)

/**
 * C1 (Tarea 10): los motivos de CONFIGURACIÓN (las clases de `Pertenencia` que no entran y sí se listan a este emisor; `AJENA` es de otro RFC).
 * Una venta cae en a lo más una; los cuenta `contarExcluidasPorConfiguracion` y el listado (Tarea 12) los revisa antes que el contenido.
 */
export const MOTIVOS_DE_CONFIGURACION: readonly Extract<Pertenencia, MotivoExclusionGlobal>[] = Object.freeze([
  'COMERCIO_FUERA',
  'EFECTIVO',
  'SIN_EMISOR',
  'SIN_TERMINAL',
] as const)

/** Suma una venta excluida a su motivo (muta y devuelve el mismo objeto). */
export function sumarExcluida(e: ExcluidasPorMotivo, m: MotivoExclusionGlobal): ExcluidasPorMotivo {
  e[m] = (e[m] ?? 0) + 1
  return e
}
