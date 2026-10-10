/**
 * IVA por producto, bloque C2 (spec §4.4, D5; Codex C2-3/C2-4/C2-8/C2-9/C2-10/C2-12/C2-14/C2-15/C2-17/C2-18/C2-19/C2-23): lo fiscal de
 * un documento —por tratamiento y por clave (artículo, ticket o concepto)— con la MISMA regla del PAC de la 6b: el documento se
 * REPARTE, no se recalcula, así que la suma de las asignaciones es el documento y la base/IVA de cada tasa es su resumen. Lo que
 * queda, si una nota cabe y cómo se reparte una devolución. Puro.
 */
import { Prisma } from '@prisma/client'
import { repartirProporcional } from './ivaMath'
import {
  conceptosDesdeElPayload,
  conceptoSegunElPac,
  documentoSegunElPac,
  resumenSegunElPac,
  type ConceptoParaElPac,
  type TrasladoParaElPac,
} from './reglaDelPac'
import type { CfdiItemInput } from './providers/fiscal-provider.interface'

export type TratamientoDeNota = 'IVA_16' | 'IVA_8' | 'IVA_0' | 'EXENTO' | 'NO_OBJETO'
export const TRATAMIENTOS_DE_NOTA: readonly TratamientoDeNota[] = ['IVA_16', 'IVA_8', 'IVA_0', 'EXENTO', 'NO_OBJETO']
type ConObjeto = Exclude<TratamientoDeNota, 'NO_OBJETO'>
export type Componentes = { baseCents: number; ivaCents: number; totalCents: number }
/** Base, IVA y total por tratamiento (de un documento, de una clave, de una nota o de lo que queda). */
export type FiscalDeNota = Partial<Record<TratamientoDeNota, Componentes>>
/**
 * El nombre del plan. 🔴 `deliveryFiscalDelta.ts` exporta OTRO `FiscalPorTratamiento` (`{ v: 2; porTratamiento }`, B4b): quien
 * importe de los dos módulos usa `FiscalDeNota` (o un alias).
 */
export type FiscalPorTratamiento = FiscalDeNota
/**
 * Una parte de un documento: un concepto (o la parte de un concepto con varias bases, C1). `totalMicros` = lo que cobró (neto + su
 * traslado; en una parte de varias bases, su base + su traslado): es el peso del reparto del total de su tasa (C2-17). `importeMicros`
 * y `descuentoMicros` arman el documento que su tasa formaría sola (C2-23).
 */
export type Unidad = {
  clave: string
  tratamiento: TratamientoDeNota
  baseMicros: number
  ivaMicros: number
  totalMicros: number
  importeMicros: number
  descuentoMicros: number
}
/** El `DocumentoSegunElPac` de la 6b: lo que dice (o dirá) el XML, en centavos. */
export type DocumentoFiscal = { subtotalCents: number; descuentoCents: number; ivaCents: number; totalCents: number }
export type ResumenFiscal = Partial<Record<ConObjeto, { baseCents: number; ivaCents: number }>>
export type Asignacion = {
  porTratamiento: FiscalDeNota
  porClave: Map<string, FiscalDeNota>
  /** C2-23: el centavo del documento que se queda en la tasa que lo produce (total − base − IVA de esa tasa). */
  ajustePorTratamiento: Partial<Record<TratamientoDeNota, number>>
}
export type Ambito = 'FACTURA' | 'TICKET' | 'DOCUMENTO_GLOBAL'
/**
 * Lo que una nota lleva de más, declarado (P8, C2-15): `BASE`/`IVA` en un ámbito (la nota que agota un tratamiento). C2 T7, (B) del
 * controlador: `ARTICULO` = lo que un artículo devuelto excede lo que le quedaba, hasta el |ajuste| de SU tasa en la original (`orderItemId`).
 */
export type Redondeo = {
  tratamiento: TratamientoDeNota
  componente: 'BASE' | 'IVA' | 'ARTICULO'
  cents: number
  ambito: Ambito
  orderItemId?: string
}
export type MontosDeArticulo = { totalCents: number; porTratamiento: Partial<Record<TratamientoDeNota, number>> }
export type TrasladoDelXml = { impuesto: string; tipoFactor: 'Tasa' | 'Exento'; tasa: string | null; base: string; importe: string | null }
export type ConceptoDelXml = {
  noIdentificacion: string | null
  objetoImp: string
  importe: string
  descuento: string
  traslados: TrasladoDelXml[]
}
/** Los conceptos del XML timbrado tal como los guarda `Cfdi.xmlConceptos` (lo escribe la Tarea 5). */
export type XmlConceptos = {
  version: 1
  subTotal: string
  descuento: string
  total: string
  totalImpuestosTrasladados: string | null
  conceptos: ConceptoDelXml[]
}

/** C2 (P8): lo que puede llevar de más —en base y en IVA, por separado— la nota que AGOTA un tratamiento en un ámbito. */
export const REDONDEO_PERMITIDO_CENTS = 1
/** El centavo en que el documento de una tasa (SubTotal y Descuento redondeados aparte) difiere de su base + IVA; más, no cuadra. */
export const MAX_AJUSTE_DOCUMENTO_CENTS = 2

export const MOTIVO_ESPERA_XML =
  'Falta el XML de la factura original; lo estamos recuperando. La nota de crédito se podrá emitir en unos minutos.'
export const MOTIVO_XML_NO_CUADRA = 'El XML de la factura original no coincide con lo que Avoqado registró; requiere revisión de soporte.'
export const MOTIVO_OBJETO_NO_SOPORTADO =
  'La factura original tiene un concepto con un tipo de objeto de impuesto que Avoqado no maneja; la nota de crédito hazla con tu contador.'
export const MOTIVO_ARTICULO_SIN_EVIDENCIA =
  'No se puede comprobar cuánto se facturó de un artículo de esta devolución. Puedes acreditar lo devuelto por importe o hacer la nota con tu contador.'
export const MOTIVO_ARTICULOS_NO_CUADRAN =
  'Los artículos de esta devolución no suman lo devuelto; la nota de crédito no se emite por importe a ciegas. Revisa la devolución o hazla con tu contador.'
export const MOTIVO_SIN_MONTO_POR_ARTICULO =
  'Esta factura no registró cuánto se facturó de cada artículo, así que la nota no se puede emitir por artículos. Puedes acreditar lo devuelto por importe (repartido por tasa en proporción a lo que queda) o hacerla con tu contador.'
export const MOTIVO_REPARTO_DE_ENTREGA_INVALIDO =
  'El ajuste de la plataforma de entregas no trae un reparto por IVA que se pueda usar; la nota de crédito hazla con tu contador.'
export const MOTIVO_MODALIDAD_NO_PERMITIDA =
  '«Acreditar por importe» sólo se puede elegir cuando no hay forma de comprobar lo facturado de cada artículo.'
export const MOTIVO_SALDO_DEL_DOCUMENTO =
  'Lo que se devuelve excede lo que queda por acreditar en la factura global; requiere revisión de soporte.'
/**
 * Ronda 1 (revisión de la T4, #4): un concepto de cobro 0 (descuento del 100 %) en la original. Medido (B3a T1b, control G
 * `6ac3eea0d7fa32314f5e6785`): el PAC lo timbra con `ObjetoImp 01`, sin traslado y `Descuento = Importe`. D9 ya no lo emite; si aparece una
 * original anterior, la nota se DETIENE (0 casos en producción al 8-oct).
 */
export const MOTIVO_CONCEPTO_REGALADO =
  'La factura original tiene un artículo regalado (con descuento del 100 %). Avoqado no emite notas de crédito sobre esa factura: hazla con tu contador o escríbenos a soporte.'
/** Ronda 2 (M-B1): el importe devuelto tiene que ser centavos enteros ≥ 0; si no, la nota se detiene con motivo, nunca con un error. */
export const MOTIVO_IMPORTE_DEVUELTO_INVALIDO =
  'El importe devuelto de este reembolso no es un monto válido (centavos enteros, cero o más); la nota de crédito no se emite. Revisa el reembolso o escríbenos a soporte.'
/**
 * C2 T7 (investigación bruto vs neto, ajuste del controlador): lo devuelto DE VERDAD de un artículo (`amountCents`) contra lo facturado de
 * él menos lo ya acreditado; nunca se reescala. Si excede, la nota se detiene con este texto, que dice cuánto se devolvió de más
 * (A-R6). Con la decisión A el escritor devuelve lo cobrado, así que sólo queda para devoluciones históricas (0 en producción, 9-oct).
 */
export function motivoArticuloExcede(
  nombre: string | undefined,
  devueltoCents: number,
  quedaCents: number,
  facturadoCents: number,
): string {
  const de = nombre ? `«${nombre}»` : 'un artículo'
  const queda = quedaCents === facturadoCents ? '' : ` y al que le quedan ${pesos(quedaCents)} por acreditar`
  return (
    // C2 · OF-2 (nit N-a): el número es lo FACTURADO del artículo (con A, lo cobrado y lo facturado difieren a lo más en 1 ¢).
    `Se devolvieron ${pesos(devueltoCents)} de ${de} que se facturó en ${pesos(facturadoCents)}${queda}: ${pesos(devueltoCents - quedaCents)} de más. ` +
    'La nota no acredita más de lo facturado de ese artículo; revisa la devolución con tu contador.'
  )
}
/**
 * C2 T7, ronda 1 (I3): un exceso de centavos (≤ `MAX_AJUSTE_DOCUMENTO_CENTS`) en una original con varias tasas. Sin dato para saber si la 6b
 * movió ese centavo a otra tasa ((B′) descartada) —ni si es redondeo o una devolución de más—, el texto no afirma nada que no se sepa: dice
 * que una diferencia así SUELE venir del redondeo. Se cuenta en el log.
 * `deQue`: lo facturado del ARTÍCULO, o lo que queda de su TASA.
 */
export function motivoCentavosDeRedondeo(
  nombre: string | undefined,
  cents: number,
  deQue: 'ARTICULO' | 'TASA',
  componente: ComponenteQueSePasa = 'TOTAL',
): string {
  const de = nombre ? ` de ${nombre}` : deQue === 'ARTICULO' ? ' de un artículo' : ''
  // C2 · OF-2 (T7 N2): de una TASA, dice qué se pasa —su base o su IVA— en vez de «la devolución excede» (con el total cabiendo).
  const [sujeto, contra] =
    deQue === 'ARTICULO'
      ? [`La devolución${de}`, 'lo que se facturó de él']
      : componente === 'BASE'
        ? [`La base de la devolución${de}`, 'la base que queda por acreditar de su tasa']
        : componente === 'IVA'
          ? [`El IVA de la devolución${de}`, 'el IVA que queda por acreditar de su tasa']
          : [`La devolución${de}`, 'lo que queda por acreditar de su tasa']
  return `${sujeto} excede por ${cents} ¢ ${contra}. Una diferencia de centavos así suele venir del redondeo de la factura original; esta nota no se puede timbrar aquí: hazla con tu contador.`
}
export type ComponenteQueSePasa = 'TOTAL' | 'BASE' | 'IVA'
/**
 * C2 · OF-2 (T7 N2): con UNA sola tasa, la base o el IVA de la nota se pasan por centavos de lo que queda (el total sí cabe: el tope por el
 * total va antes). No hay otra tasa adonde la 6b haya movido el centavo: es el reparto base/IVA que dejaron las notas anteriores (o, sin
 * notas, la factura original). No se cuenta como `C2_CENTAVOS_DE_REDONDEO` (ese contador es para revisar las mixtas).
 */
export function motivoRedondeoDeUnaTasa(componente: 'BASE' | 'IVA', cents: number, hayNotasAnteriores: boolean): string {
  const quien = hayNotasAnteriores ? 'El redondeo de las notas anteriores dejó' : 'El redondeo de la factura original deja'
  const que = componente === 'BASE' ? 'la base que queda por acreditar' : 'el IVA que queda por acreditar'
  const de = componente === 'BASE' ? 'de la de esta devolución' : 'del de esta devolución'
  return `${quien} ${que} ${cents} ¢ por debajo ${de}; no se puede timbrar aquí: hazla con tu contador o escríbenos a soporte.`
}
/** C2 T7, ronda 1 (I1): el tope por el TOTAL —lo devuelto contra el total de la original menos TODO lo acreditado—, con su ámbito. */
export function motivoExcedeElTotal(cents: number, quedaCents: number, ambito: Ambito): string {
  if (ambito === 'DOCUMENTO_GLOBAL') return MOTIVO_SALDO_DEL_DOCUMENTO
  // La misma redacción que `proporcional` (T8): el ámbito dice DÓNDE se acabó.
  if (quedaCents <= 0) return `Ya no queda nada por acreditar ${DONDE[ambito]}.`
  return `Lo que se devuelve (${pesos(cents)}) excede lo que queda por acreditar ${DONDE[ambito]} (${pesos(Math.max(0, quedaCents))}).`
}
/** Ronda 1 (M-5): una tasa de IVA fuera de 16 %, 8 % y 0 % se detiene con motivo, nunca con un error. */
export const MOTIVO_TASA_NO_SOPORTADA =
  'La factura original tiene un concepto con una tasa de IVA que Avoqado no maneja en notas de crédito (sólo 16 %, 8 % y 0 %); hazla con tu contador o escríbenos a soporte.'
/**
 * Ronda 1 (I-3; P8 se queda como la aprobó el founder): la nota que AGOTA el total de un tratamiento pero cuyo reparto base/IVA se aleja
 * más de 1 ¢ del que queda, por el redondeo que fueron dejando las notas anteriores.
 */
export const motivoRedondeoAcumulado = (cents: number): string =>
  `El redondeo de las notas anteriores movió ${cents} ¢ entre base e IVA; esta última devolución no se puede timbrar aquí: hazla con tu contador o escríbenos a soporte.`

/** Lo que no se puede asignar, con su motivo en español llano (la nota se detiene; nunca un error). */
export type Invalido = { invalido: string }
const esInvalido = (v: unknown): v is Invalido => !!v && typeof v === 'object' && !Array.isArray(v) && 'invalido' in v

const ETIQUETA: Record<TratamientoDeNota, string> = { IVA_16: '16 %', IVA_8: '8 %', IVA_0: '0 %', EXENTO: 'exento', NO_OBJETO: 'no objeto' }
const TASA: Record<string, ConObjeto> = { '0.160000': 'IVA_16', '0.080000': 'IVA_8', '0.000000': 'IVA_0' }
const D = Prisma.Decimal
const esDecimal = (s: unknown): s is string => typeof s === 'string' && /^\d+(\.\d+)?$/.test(s)
const micros = (d: Prisma.Decimal | string | number) => new D(d).mul(1_000_000).toDecimalPlaces(0, D.ROUND_HALF_UP).toNumber()
const centavosDeMicros = (m: number) => Math.floor((m + 5_000) / 10_000) // mitad arriba; las sumas son ≥ 0
const centavos = (s: string | null | undefined) => new D(s ?? 0).mul(100).toDecimalPlaces(0, D.ROUND_HALF_UP).toNumber()
const pesos = (c: number) => `$${(c / 100).toFixed(2)}`
const cero = (): Componentes => ({ baseCents: 0, ivaCents: 0, totalCents: 0 })
const sumaDe = (us: Unidad[], k: 'baseMicros' | 'ivaMicros' | 'importeMicros' | 'descuentoMicros') => us.reduce((s, u) => s + u[k], 0)

/** El tratamiento de un traslado del payload; `null` con una tasa fuera de 16/8/0 (ronda 1, M-5: nunca lanza). */
export function tratamientoDeTraslado(t: TrasladoParaElPac): TratamientoDeNota | null {
  if (!t) return 'NO_OBJETO'
  if (t.factor === 'Exento') return 'EXENTO'
  if (!tasaLegible(t)) return null // ronda 2 (M-B2): una tasa null, ausente o NaN no se lee
  return TASA[new D(t.tasa).toFixed(6)] ?? null
}
/** Ronda 2 (M-B2): la tasa de un traslado del payload es un número finito (el tipo dice `number`, pero llega de datos guardados). */
function tasaLegible(t: TrasladoParaElPac): boolean {
  return t?.factor !== 'Tasa' || (typeof t.tasa === 'number' && Number.isFinite(t.tasa))
}
const conceptosLegibles = (cs: ConceptoParaElPac[]) => cs.every(c => tasaLegible(c.traslado))
/** El tratamiento de un traslado del XML o de `taxBreakdown`; la tasa se compara como NÚMERO (el 0 % puede venir "0"), nunca como texto. */
function tratamientoDelXml(impuesto: unknown, tipoFactor: unknown, tasa: unknown): ConObjeto | 'TASA_NO_SOPORTADA' | null {
  if (impuesto !== '002') return null
  if (tipoFactor === 'Exento') return 'EXENTO'
  if (tipoFactor !== 'Tasa' || !esDecimal(tasa)) return null
  return TASA[new D(tasa).toFixed(6)] ?? 'TASA_NO_SOPORTADA'
}
/**
 * Ronda 1 (#4): una unidad REGALADA —con importe y sin cobro (descuento del 100 %)—. En el XML es la forma medida (control G):
 * `ObjetoImp 01`, sin traslado, `Descuento = Importe`; en el payload, el concepto con descuento igual a su total.
 */
const esRegalada = (u: Unidad) => u.importeMicros > 0 && Math.abs(u.totalMicros) < 5_000

// ── Del payload: la regla del PAC de la 6b tal cual (este módulo nunca fija millonésimas a mano) ────────────────────────────────

export function unidadesDeConceptosParaElPac(cs: ConceptoParaElPac[], claveDe: (i: number) => string): Unidad[] | Invalido {
  const u: Unidad[] = []
  for (const [i, c] of cs.entries()) {
    const tratamiento = tratamientoDeTraslado(c.traslado)
    if (!tratamiento) return { invalido: MOTIVO_TASA_NO_SOPORTADA }
    const x = conceptoSegunElPac(c)
    const neto = x.importe.minus(x.descuento)
    const ivaMicros = c.traslado?.factor === 'Tasa' ? micros(x.traslado) : 0
    u.push({
      clave: claveDe(i),
      tratamiento,
      baseMicros: micros(c.traslado ? x.base : neto),
      ivaMicros,
      totalMicros: micros(neto) + ivaMicros,
      importeMicros: micros(x.importe),
      descuentoMicros: micros(x.descuento),
    })
  }
  return u
}
/** Las unidades de un payload; las partes de un concepto con varias bases (C1) comparten su clave. */
export function unidadesDeConceptos(items: CfdiItemInput[], claveDe: (i: number) => string): Unidad[] | Invalido {
  const u: Unidad[] = []
  for (const [i, it] of items.entries()) {
    const partes = unidadesDeConceptosParaElPac(conceptosDesdeElPayload(it), () => claveDe(i))
    if (esInvalido(partes)) return partes
    u.push(...partes)
  }
  return u
}
export function documentoDeConceptos(items: CfdiItemInput[]): DocumentoFiscal | Invalido {
  const cs = items.flatMap(conceptosDesdeElPayload)
  return conceptosLegibles(cs) ? documentoSegunElPac(cs) : { invalido: MOTIVO_TASA_NO_SOPORTADA }
}
export function resumenDeConceptosParaElPac(cs: ConceptoParaElPac[]): ResumenFiscal | Invalido {
  if (!conceptosLegibles(cs)) return { invalido: MOTIVO_TASA_NO_SOPORTADA }
  const r: ResumenFiscal = {}
  for (const m of resumenSegunElPac(cs)) {
    const t = m.tipoFactor === 'Exento' ? 'EXENTO' : TASA[m.tasa ?? '']
    if (!t) return { invalido: MOTIVO_TASA_NO_SOPORTADA }
    r[t] = { baseCents: m.baseCents, ivaCents: m.importeCents ?? 0 }
  }
  return r
}
export const resumenDeConceptos = (items: CfdiItemInput[]): ResumenFiscal | Invalido =>
  resumenDeConceptosParaElPac(items.flatMap(conceptosDesdeElPayload))

// ── Del XML (la histórica, y el cotejo de toda original con entrada) ───────────────────────────────────────────────────────────

/**
 * Las unidades del XML timbrado (Codex C2-14): el no objeto sale de los conceptos con `ObjetoImp 01`; el tratamiento de los demás, del
 * traslado de cada uno (nunca de «impuesto cero» ni de un residuo). Un traslado: la unidad cobró su neto + su IVA. Varios (concepto de
 * la global con varias bases, C1): cada parte es su base + su IVA, sin descuento.
 */
export function unidadesDelXml(
  x: XmlConceptos,
  claveDe: (i: number, c: ConceptoDelXml) => string = i => `c${i}`, // ronda 1 (M-4): la T8 agrupa por folio
): Unidad[] | Invalido {
  const u: Unidad[] = []
  for (const [i, c] of x.conceptos.entries()) {
    const clave = claveDe(i, c)
    const importeMicros = micros(c.importe)
    const descuentoMicros = micros(c.descuento || 0)
    const neto = importeMicros - descuentoMicros
    if (c.objetoImp === '01') {
      if (c.traslados.length) return { invalido: MOTIVO_XML_NO_CUADRA } // un no objeto con traslados no es un CFDI que el PAC timbre
      u.push({ clave, tratamiento: 'NO_OBJETO', baseMicros: neto, ivaMicros: 0, totalMicros: neto, importeMicros, descuentoMicros })
      continue
    }
    if (c.objetoImp !== '02' || !c.traslados.length) return { invalido: MOTIVO_OBJETO_NO_SOPORTADO }
    const uno = c.traslados.length === 1
    for (const t of c.traslados) {
      const tratamiento = tratamientoDelXml(t.impuesto, t.tipoFactor, t.tasa)
      if (tratamiento === 'TASA_NO_SOPORTADA') return { invalido: MOTIVO_TASA_NO_SOPORTADA }
      if (!tratamiento) return { invalido: MOTIVO_OBJETO_NO_SOPORTADO }
      const ivaMicros = tratamiento === 'EXENTO' ? 0 : micros(t.importe ?? '0')
      const baseMicros = micros(t.base)
      u.push({
        clave,
        tratamiento,
        baseMicros,
        ivaMicros,
        totalMicros: (uno ? neto : baseMicros) + ivaMicros,
        importeMicros: uno ? importeMicros : baseMicros,
        descuentoMicros: uno ? descuentoMicros : 0, // si un concepto de varias bases trae descuento, el documento no cuadra (asignacionFiscal)
      })
    }
  }
  return u
}
export const documentoDelXml = (x: XmlConceptos): DocumentoFiscal => ({
  subtotalCents: centavos(x.subTotal),
  descuentoCents: centavos(x.descuento),
  ivaCents: centavos(x.totalImpuestosTrasladados),
  totalCents: centavos(x.total),
})
/** El resumen de traslados de `Cfdi.taxBreakdown` (lo escribe `desgloseDesdeXml`), por tratamiento; uno repetido o ilegible ⇒ inválido. */
export function resumenDelXml(taxBreakdown: unknown): ResumenFiscal | { invalido: string } {
  if (!Array.isArray(taxBreakdown)) return { invalido: MOTIVO_XML_NO_CUADRA }
  const r: ResumenFiscal = {}
  for (const t of taxBreakdown as unknown[]) {
    const x = (t ?? {}) as { impuesto?: unknown; tipoFactor?: unknown; tasa?: unknown; base?: unknown; importe?: unknown }
    const k = tratamientoDelXml(x.impuesto, x.tipoFactor, x.tasa)
    if (k === 'TASA_NO_SOPORTADA') return { invalido: MOTIVO_TASA_NO_SOPORTADA }
    if (!k || r[k] || !esDecimal(x.base) || (k !== 'EXENTO' && !esDecimal(x.importe))) return { invalido: MOTIVO_XML_NO_CUADRA }
    r[k] = { baseCents: centavos(x.base), ivaCents: k === 'EXENTO' ? 0 : centavos(x.importe as string) }
  }
  return r
}
/** `Cfdi.xmlConceptos` si tiene la forma que escribe la Tarea 5; si no, `null` (y la nota espera el XML). */
export function leerXmlConceptos(json: unknown): XmlConceptos | null {
  const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  const trasladoOk = (t: unknown) =>
    obj(t) &&
    typeof t.impuesto === 'string' &&
    esDecimal(t.base) &&
    (t.tipoFactor === 'Exento'
      ? t.tasa === null && t.importe === null
      : t.tipoFactor === 'Tasa' && esDecimal(t.tasa) && esDecimal(t.importe))
  const conceptoOk = (c: unknown) =>
    obj(c) &&
    (c.noIdentificacion == null || typeof c.noIdentificacion === 'string') &&
    typeof c.objetoImp === 'string' &&
    esDecimal(c.importe) &&
    esDecimal(c.descuento) &&
    Array.isArray(c.traslados) &&
    c.traslados.every(trasladoOk)
  const ok =
    obj(json) &&
    json.version === 1 &&
    esDecimal(json.subTotal) &&
    esDecimal(json.descuento) &&
    esDecimal(json.total) &&
    (json.totalImpuestosTrasladados === null || esDecimal(json.totalImpuestosTrasladados)) &&
    Array.isArray(json.conceptos) &&
    json.conceptos.every(conceptoOk)
  return ok ? (json as unknown as XmlConceptos) : null
}

// ── El reparto ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * C2 (Codex C2-17): UN solo reparto por tasa. El total de la tasa se reparte por lo que cobró cada unidad; el IVA de la tasa, sobre esos
 * totales; la base es total − IVA. Así cada unidad conserva su total (dos tickets de $100 siguen en $100 y $100) y la suma de bases e IVAs
 * es la de la tasa. Con IVA ≤ total, ninguna parte de IVA rebasa su total (garantía de `repartirProporcional`): ninguna base negativa.
 */
export function repartirPorTasa(tasa: { totalCents: number; ivaCents: number }, pesosMicros: number[]): Componentes[] {
  const totales = repartirProporcional(tasa.totalCents, pesosMicros)
  const ivas = repartirProporcional(tasa.ivaCents, totales)
  return totales.map((t, i) => ({ baseCents: t - ivas[i], ivaCents: ivas[i], totalCents: t }))
}

/** C2 (Codex C2-19): el ÚNICO repartidor de una devolución entre tratamientos: en proporción a lo que QUEDA de cada uno. */
export function repartirSobreLoQueQueda(
  cents: number,
  queda: Partial<Record<TratamientoDeNota, number>>,
): Partial<Record<TratamientoDeNota, number>> {
  const ts = TRATAMIENTOS_DE_NOTA.filter(t => (queda[t] ?? 0) > 0)
  const partes = repartirProporcional(
    cents,
    ts.map(t => queda[t]!),
  )
  const r: Partial<Record<TratamientoDeNota, number>> = {}
  ts.forEach((t, i) => {
    if (partes[i] !== 0) r[t] = partes[i]
  })
  return r
}

/**
 * C2 (Codex C2-10): reparte el documento entre sus unidades con la regla del PAC; la suma de las asignaciones ES el documento.
 * 1. El documento y el resumen tienen que ser los de ESTAS unidades (SubTotal y Descuento = suma de importes y descuentos; base e IVA de
 *    cada tasa = su resumen); si no, no se reparte a ciegas.
 * 2. C2-23: el total de cada tasa es el documento que ELLA formaría sola (`round(Σ Importe) − round(Σ Descuento) + su IVA`); su diferencia
 *    con base + IVA es SU ajuste (declarado, ≤ `MAX_AJUSTE_DOCUMENTO_CENTS`). Si la suma de los totales de las tasas no es el total del
 *    documento (el redondeo cruzó tasas), no se adivina a cuál le toca: inválido.
 * 3. C2-17: dentro de la tasa, base e IVA de UN solo reparto (`repartirPorTasa`) y el total por lo que cobró cada unidad.
 * Ronda 1: recibe tal cual lo que dan los lectores (del payload o del XML) y propaga su motivo si es inválido (M-5); un artículo regalado
 * (descuento del 100 %) detiene con `MOTIVO_CONCEPTO_REGALADO` (#4).
 */
export function asignacionFiscal(
  unidades: Unidad[] | Invalido,
  documento: DocumentoFiscal | Invalido,
  resumen: ResumenFiscal | Invalido,
): Asignacion | Invalido {
  if (esInvalido(unidades)) return unidades
  if (esInvalido(documento)) return documento
  if (unidades.some(esRegalada)) return { invalido: MOTIVO_CONCEPTO_REGALADO }
  if (esInvalido(resumen)) return resumen
  const noCuadra = { invalido: MOTIVO_XML_NO_CUADRA }
  const presentes = new Set(unidades.map(u => u.tratamiento))
  if ((Object.keys(resumen) as ConObjeto[]).some(t => !presentes.has(t))) return noCuadra
  if (
    centavosDeMicros(sumaDe(unidades, 'importeMicros')) !== documento.subtotalCents ||
    centavosDeMicros(sumaDe(unidades, 'descuentoMicros')) !== documento.descuentoCents
  )
    return noCuadra
  const porTratamiento: FiscalDeNota = {}
  const ajustePorTratamiento: Partial<Record<TratamientoDeNota, number>> = {}
  const asignadas: Array<{ u: Unidad; c: Componentes }> = []
  for (const t of TRATAMIENTOS_DE_NOTA) {
    const us = unidades.filter(u => u.tratamiento === t)
    if (!us.length) continue
    let base = centavosDeMicros(sumaDe(us, 'baseMicros'))
    let iva = 0
    if (t !== 'NO_OBJETO') {
      const r = resumen[t]
      if (!r || r.baseCents !== base || r.ivaCents !== centavosDeMicros(sumaDe(us, 'ivaMicros'))) return noCuadra
      base = r.baseCents
      iva = r.ivaCents
    }
    const totalT = centavosDeMicros(sumaDe(us, 'importeMicros')) - centavosDeMicros(sumaDe(us, 'descuentoMicros')) + iva
    const ajusteT = totalT - (base + iva)
    if (Math.abs(ajusteT) > MAX_AJUSTE_DOCUMENTO_CENTS) return noCuadra
    const pesosT = us.map(u => u.totalMicros)
    const partes = repartirPorTasa({ totalCents: base + iva, ivaCents: iva }, pesosT)
    const totales = repartirProporcional(totalT, pesosT) // cada unidad, lo que cobró (con el centavo de SU tasa)
    us.forEach((u, i) => asignadas.push({ u, c: { baseCents: partes[i].baseCents, ivaCents: partes[i].ivaCents, totalCents: totales[i] } }))
    porTratamiento[t] = { baseCents: base, ivaCents: iva, totalCents: totalT }
    if (ajusteT) ajustePorTratamiento[t] = ajusteT
  }
  const tasas = Object.values(porTratamiento) as Componentes[]
  if (
    tasas.reduce((s, c) => s + c.ivaCents, 0) !== documento.ivaCents ||
    tasas.reduce((s, c) => s + c.totalCents, 0) !== documento.totalCents
  )
    return noCuadra
  const porClave = new Map<string, FiscalDeNota>()
  for (const { u, c } of asignadas) {
    const m = porClave.get(u.clave) ?? {}
    const a = m[u.tratamiento] ?? cero()
    m[u.tratamiento] = { baseCents: a.baseCents + c.baseCents, ivaCents: a.ivaCents + c.ivaCents, totalCents: a.totalCents + c.totalCents }
    porClave.set(u.clave, m)
  }
  return { porTratamiento, porClave, ajustePorTratamiento }
}

// ── El cotejo con el XML (D5, Codex C2-13/C2-18) ───────────────────────────────────────────────────────────────────────────────

const seis = (v: Prisma.Decimal | string | number | null | undefined) => (v === null || v === undefined ? null : new D(v).toFixed(6))
function conceptoCoincide(it: CfdiItemInput, xc: ConceptoDelXml): boolean {
  if (xc.objetoImp !== it.objetoImp) return false
  // Sin `sku`, Facturapi no escribe NoIdentificacion (medido en los XML de la T1): la identificación se compara en los dos sentidos.
  if ((xc.noIdentificacion ?? null) !== (it.sku || null)) return false
  const partes = conceptosDesdeElPayload(it).map(c => ({ c, x: conceptoSegunElPac(c) }))
  const suma = (k: 'importe' | 'descuento') => partes.reduce((s, p) => s.plus(p.x[k]), new D(0))
  if (seis(xc.importe) !== seis(suma('importe')) || seis(xc.descuento || 0) !== seis(suma('descuento'))) return false
  const locales = partes.filter(p => p.c.traslado)
  if (locales.length !== xc.traslados.length) return false
  return locales.every(({ c, x }, k) => {
    const t = xc.traslados[k]
    const tr = c.traslado!
    const exento = tr.factor === 'Exento'
    return (
      t.impuesto === '002' &&
      t.tipoFactor === tr.factor &&
      seis(t.tasa) === (tr.factor === 'Exento' ? null : seis(tr.tasa)) &&
      seis(t.base) === seis(x.base) &&
      seis(t.importe) === (exento ? null : seis(x.traslado))
    )
  })
}
/**
 * El modelo local coincide con el XML timbrado CONCEPTO POR CONCEPTO —ObjetoImp, identificación, Importe, Descuento y cada traslado
 * (impuesto, factor, tasa, base, importe) a 6 decimales, en orden— y después en documento y resumen; si no, el modelo no se usa. Es la
 * salvaguarda: un intercambio de conceptos que conserva los totales también se rechaza (C2-18).
 */
export function cotejarConElXml(items: CfdiItemInput[], taxBreakdown: unknown, xml: XmlConceptos): true | Invalido {
  const noCuadra = { invalido: MOTIVO_XML_NO_CUADRA }
  // Ronda 1: primero lo que detiene con su propio motivo (una tasa fuera de 16/8/0, M-5; un artículo regalado, #4), luego el cotejo.
  const up = unidadesDeConceptos(items, String)
  if (esInvalido(up)) return up
  const regaladoEnXml = xml.conceptos.some(
    c => esDecimal(c.importe) && micros(c.importe) > 0 && micros(c.importe) === micros(c.descuento || 0),
  )
  if (regaladoEnXml || up.some(esRegalada)) return { invalido: MOTIVO_CONCEPTO_REGALADO }
  if (xml.conceptos.length !== items.length || !items.every((it, i) => conceptoCoincide(it, xml.conceptos[i]))) return noCuadra
  const doc = documentoDeConceptos(items)
  if (esInvalido(doc)) return doc
  const dx = documentoDelXml(xml)
  const rx = resumenDelXml(taxBreakdown)
  const rm = resumenDeConceptos(items)
  if (esInvalido(rm)) return rm
  if (esInvalido(rx)) return rx
  const mismoResumen =
    Object.keys(rx).length === Object.keys(rm).length &&
    (Object.keys(rm) as ConObjeto[]).every(t => rx[t]?.baseCents === rm[t]!.baseCents && rx[t]?.ivaCents === rm[t]!.ivaCents)
  const mismoDocumento =
    doc.subtotalCents === dx.subtotalCents &&
    doc.descuentoCents === dx.descuentoCents &&
    doc.ivaCents === dx.ivaCents &&
    doc.totalCents === dx.totalCents
  return mismoResumen && mismoDocumento ? true : noCuadra
}

// ── Lo que queda, y si una nota cabe ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * Lo que queda por acreditar: la original menos las notas vivas; lo ilegible (`desconocidoCents`) baja TODO, por conservador. C2 · OF-2
 * (T7 N3): salvo el IVA de una tasa SIN IVA (0 %, exento, no objeto), que es cero siempre: restarle dejaba su IVA negativo y detenía toda
 * nota de esa tasa con «excede … IVA $0.00».
 */
export function restar(original: FiscalDeNota, notas: FiscalDeNota[], desconocidoCents: number): FiscalDeNota {
  const r: FiscalDeNota = {}
  for (const t of Object.keys(original) as TratamientoDeNota[]) {
    const o = original[t]!
    const conIva = t === 'IVA_16' || t === 'IVA_8'
    const menos = (k: keyof Componentes) =>
      notas.reduce((s, n) => s + (n[t]?.[k] ?? 0), 0) + (k === 'ivaCents' && !conIva ? 0 : desconocidoCents)
    r[t] = {
      baseCents: o.baseCents - menos('baseCents'),
      ivaCents: o.ivaCents - menos('ivaCents'),
      totalCents: o.totalCents - menos('totalCents'),
    }
  }
  return r
}

const DONDE: Record<Ambito, string> = {
  FACTURA: 'en la factura original',
  TICKET: 'de este ticket en la factura global',
  DOCUMENTO_GLOBAL: 'en la factura global',
}
/**
 * C2 (P8, Codex C2-15): la nota cabe si, por tratamiento, su total, su IVA y su base caben en lo que queda. Sólo la nota que AGOTA el
 * total de un tratamiento puede llevar hasta `REDONDEO_PERMITIDO_CENTS` de más en base y en IVA, y cada exceso se registra por componente
 * y ámbito.
 */
export function cabeEnElSaldo(
  nota: FiscalDeNota,
  saldo: FiscalDeNota,
  ambito: Ambito,
): { ok: true; redondeo: Redondeo[] } | { ok: false; message: string } {
  const redondeo: Redondeo[] = []
  for (const t of Object.keys(nota) as TratamientoDeNota[]) {
    const n = nota[t]!
    const s = saldo[t] ?? cero()
    const tolerancia = n.totalCents === s.totalCents ? REDONDEO_PERMITIDO_CENTS : 0 // P8: sólo la nota que agota
    const agota = n.totalCents === s.totalCents
    if (agota && (n.ivaCents > s.ivaCents + tolerancia || n.baseCents > s.baseCents + tolerancia))
      // Ronda 1 (I-3): el total cuadra exacto; lo que se movió es el reparto base/IVA que fueron dejando las notas anteriores.
      return { ok: false, message: motivoRedondeoAcumulado(Math.max(n.baseCents - s.baseCents, n.ivaCents - s.ivaCents)) }
    if (n.totalCents > s.totalCents || n.ivaCents > s.ivaCents + tolerancia || n.baseCents > s.baseCents + tolerancia)
      return {
        ok: false,
        message:
          ambito === 'DOCUMENTO_GLOBAL'
            ? MOTIVO_SALDO_DEL_DOCUMENTO
            : `Lo que se devuelve al ${ETIQUETA[t]} (${pesos(n.totalCents)}, IVA ${pesos(n.ivaCents)}) excede lo que queda por acreditar de esa tasa ${DONDE[ambito]} (${pesos(Math.max(0, s.totalCents))}, IVA ${pesos(Math.max(0, s.ivaCents))}).`,
      }
    if (n.baseCents > s.baseCents) redondeo.push({ tratamiento: t, componente: 'BASE', cents: n.baseCents - s.baseCents, ambito })
    if (n.ivaCents > s.ivaCents) redondeo.push({ tratamiento: t, componente: 'IVA', cents: n.ivaCents - s.ivaCents, ambito })
  }
  return { ok: true, redondeo }
}

/**
 * Ronda 1 de la T8 (I2): lo que las notas a una global YA usaron de la tolerancia de P8 en el ámbito de su TICKET (sus excesos de base y de
 * IVA declarados con `ambito: 'TICKET'`), por tratamiento.
 */
export type ToleranciaDeTickets = Partial<Record<TratamientoDeNota, { baseCents: number; ivaCents: number }>>
/**
 * Ronda 1 de la T8 (I2; decisión del controlador sobre la regla P8 del founder): en una global, P8 se aplica POR TICKET —cada ticket es como su
 * propia factura: total exacto y, sólo la nota que lo agota, a lo más 1 ¢ de más en base y en IVA (`cabeEnElSaldo(…, 'TICKET')`)—. En el
 * documento entero se suman N redondeos independientes (cada nota la parte el PAC sola; los tramos salen de UN reparto), así que aquí sólo se
 * exige, por tratamiento:
 * - que el TOTAL nunca pase lo que queda del documento;
 * - que la base y el IVA no pasen lo que queda más la suma de las tolerancias por ticket YA usadas (`tolerancia`: lo declarado en el ámbito
 *   `TICKET` por las notas vivas y por ésta). Lo que pasan se registra como redondeo con su ámbito (`DOCUMENTO_GLOBAL`, C2-15).
 * Si los tickets cumplen P8, la deriva del documento es a lo más esa suma (Σ notas ≤ Σ tramos + Σ tolerancias, y Σ tramos = el documento);
 * pasarla sólo puede venir de algo que no declaró su centavo (una nota ilegible ya baja todo por `desconocido`) ⇒ se detiene.
 */
export function cabeEnElDocumentoGlobal(
  nota: FiscalDeNota,
  saldo: FiscalDeNota,
  tolerancia: ToleranciaDeTickets,
): { ok: true; redondeo: Redondeo[] } | { ok: false; message: string } {
  const redondeo: Redondeo[] = []
  for (const t of Object.keys(nota) as TratamientoDeNota[]) {
    const n = nota[t]!
    const s = saldo[t] ?? cero()
    const tol = tolerancia[t] ?? { baseCents: 0, ivaCents: 0 }
    const base = n.baseCents - s.baseCents
    const iva = n.ivaCents - s.ivaCents
    if (n.totalCents > s.totalCents || base > tol.baseCents || iva > tol.ivaCents) return { ok: false, message: MOTIVO_SALDO_DEL_DOCUMENTO }
    // Ronda 2 de la T8 (N1): se registra sólo lo que ESTA nota AGREGA a la deriva —`max(0, n − s) − max(0, −s)`, con `s` lo que quedaba antes
    // de ella—, no la deriva acumulada (que ya trae la de las notas anteriores). Siempre 0 ≤ incremento ≤ lo de la nota, así que el tope del
    // lector (no más que su propia base o IVA) es verdad; la suma de los incrementos de las notas vivas ES la deriva del documento, y una nota
    // con IVA 0 no registra IVA. La comprobación de arriba sigue siendo la acumulada.
    const incrementoBase = Math.max(0, base) - Math.max(0, -s.baseCents)
    const incrementoIva = Math.max(0, iva) - Math.max(0, -s.ivaCents)
    if (incrementoBase > 0) redondeo.push({ tratamiento: t, componente: 'BASE', cents: incrementoBase, ambito: 'DOCUMENTO_GLOBAL' })
    if (incrementoIva > 0) redondeo.push({ tratamiento: t, componente: 'IVA', cents: incrementoIva, ambito: 'DOCUMENTO_GLOBAL' })
  }
  return { ok: true, redondeo }
}

// ── El reparto de una devolución, por modalidad (C2-4, C2-12, C2-19, P10) ─────────────────────────────────────────────────────

export type Modalidad = 'POR_ARTICULOS' | 'POR_IMPORTE' | 'POR_IMPORTE_ELEGIDO' | 'DELIVERY'
export const FALTA_DE_EVIDENCIA = ['SIN_MONTO_POR_ARTICULO', 'ARTICULO_SIN_EVIDENCIA'] as const
export type BrutoPorTratamiento = Partial<Record<TratamientoDeNota, number>>
export type BloqueoDeReparto = {
  reason:
    | 'ARTICULOS_NO_CUADRAN'
    | 'ARTICULO_SIN_EVIDENCIA'
    | 'ARTICULO_EXCEDE_LO_FACTURADO'
    | 'SIN_MONTO_POR_ARTICULO'
    | 'REPARTO_DE_ENTREGA_INVALIDO'
    | 'EXCEEDS_REMAINING'
    | 'MODALIDAD_NO_PERMITIDA'
    | 'IMPORTE_DEVUELTO_INVALIDO'
    | 'CENTAVOS_DE_REDONDEO'
  message: string
}
export type RepartoDeDevolucion = {
  modalidad: Modalidad
  brutoPorTratamiento: BrutoPorTratamiento
  porRenglon?: Array<{ orderItemId: string; totalCents: number; porTratamiento: BrutoPorTratamiento }>
  /** C2 T7, (B): lo que algún artículo excedió de lo que le quedaba, dentro del |ajuste| de su tasa (componente `ARTICULO`). */
  redondeo?: Redondeo[]
}
export type DevolucionARepartir = {
  /** Magnitud (≥ 0, centavos enteros) de la VENTA devuelta: la propina nunca entra. */
  salesRefundCents: number
  refundedItems: Array<{ orderItemId: string; amountCents: number; nombre?: string }>
  /** El reparto congelado de un ajuste de delivery (`repartoCongeladoDeAjuste`): `null` si no es ajuste; `'INVALIDO'` si no se lee. */
  congelado: BrutoPorTratamiento | null | 'INVALIDO'
  modalidadElegida?: 'POR_IMPORTE'
}
export type ContextoDeReparto = {
  /** C2-P4: lo facturado de cada artículo (`montosPorRenglon` de la factura o los conceptos reales del ticket en la global). */
  montosPorRenglon: Map<string, MontosDeArticulo> | null
  /** C2-19: lo acreditado de cada artículo, POR TRATAMIENTO. */
  acreditadoPorRenglon: Map<string, BrutoPorTratamiento>
  saldo: FiscalDeNota
  /**
   * C2 T7, (B) del controlador: el ajuste de cada tasa en la asignación de la ORIGINAL (cotejada con su XML). Un artículo puede exceder lo
   * que le queda hasta |ajuste| de SU tasa, acumulado (`acreditado + nota ≤ facturado + |ajuste|`); la tasa sigue topada por `cabeEnElSaldo`.
   */
  ajustePorTratamiento?: Partial<Record<TratamientoDeNota, number>>
  /** El ámbito con que se registra ese exceso (por omisión, la factura). */
  ambito?: Ambito
}

/** C2 · Tarea 8: el texto dice DÓNDE se acabó el saldo (la factura, o el ticket dentro de la global); con la factura, el de siempre. */
function proporcional(
  cents: number,
  saldo: FiscalDeNota,
  modalidad: Modalidad,
  ambito: Ambito = 'FACTURA',
): RepartoDeDevolucion | BloqueoDeReparto {
  const queda: BrutoPorTratamiento = {}
  for (const t of TRATAMIENTOS_DE_NOTA) queda[t] = Math.max(0, saldo[t]?.totalCents ?? 0)
  const total = Object.values(queda).reduce((s, c) => s + (c ?? 0), 0)
  if (total === 0) return { reason: 'EXCEEDS_REMAINING', message: `Ya no queda nada por acreditar ${DONDE[ambito]}.` }
  // Nunca se reparte de más: sin esto, `repartirProporcional` le daría a un tratamiento más de lo que le queda.
  if (cents > total)
    return {
      reason: 'EXCEEDS_REMAINING',
      message: `Lo que se devuelve (${pesos(cents)}) excede lo que queda por acreditar ${DONDE[ambito]} (${pesos(total)}).`,
    }
  return { modalidad, brutoPorTratamiento: repartirSobreLoQueQueda(cents, queda) }
}

function porArticulos(d: DevolucionARepartir, ctx: ContextoDeReparto): RepartoDeDevolucion | BloqueoDeReparto {
  const enteros = d.refundedItems.every(x => Number.isInteger(x.amountCents) && x.amountCents >= 0)
  if (!enteros || d.refundedItems.reduce((s, x) => s + x.amountCents, 0) !== d.salesRefundCents)
    return { reason: 'ARTICULOS_NO_CUADRAN', message: MOTIVO_ARTICULOS_NO_CUADRAN }
  const porId = new Map<string, number>()
  const nombres = new Map<string, string>()
  for (const x of d.refundedItems) {
    porId.set(x.orderItemId, (porId.get(x.orderItemId) ?? 0) + x.amountCents)
    if (x.nombre && !nombres.has(x.orderItemId)) nombres.set(x.orderItemId, x.nombre)
  }
  // Ronda 1 (I-1): un artículo devuelto en $0 (la cortesía que D9 dejó fuera de la factura) no acredita nada: ni participa ni detiene.
  for (const [id, cents] of porId) if (cents === 0) porId.delete(id)
  if (!porId.size) return { modalidad: 'POR_ARTICULOS', brutoPorTratamiento: {}, porRenglon: [] }
  if (!ctx.montosPorRenglon) return { reason: 'SIN_MONTO_POR_ARTICULO', message: MOTIVO_SIN_MONTO_POR_ARTICULO } // C2-12: también con una sola tasa
  const bruto: BrutoPorTratamiento = {}
  const porRenglon: NonNullable<RepartoDeDevolucion['porRenglon']> = []
  const redondeo: Redondeo[] = []
  // Ronda 1 (I-2): se revisan TODOS los artículos; si uno con evidencia excede, eso manda sobre la falta de evidencia de otro (así P10 no
  // depende del orden).
  let excede: BloqueoDeReparto | null = null
  let sinEvidencia = false
  for (const [id, cents] of porId) {
    const m = ctx.montosPorRenglon.get(id)
    if (!m) {
      sinEvidencia = true
      continue
    }
    // C2-19: lo que queda del artículo, POR TRATAMIENTO (facturado − acreditado de ese tratamiento); nunca su reparto original.
    // T7 (investigación bruto vs neto): se compara lo devuelto DE VERDAD (`amountCents`), nunca reescalado.
    const acreditado = ctx.acreditadoPorRenglon.get(id) ?? {}
    const queda: BrutoPorTratamiento = {}
    for (const t of TRATAMIENTOS_DE_NOTA) queda[t] = Math.max(0, (m.porTratamiento[t] ?? 0) - (acreditado[t] ?? 0))
    const total = Object.values(queda).reduce((s, c) => s + (c ?? 0), 0)
    let partes: BrutoPorTratamiento
    if (cents <= total) partes = repartirSobreLoQueQueda(cents, queda)
    else {
      // (B) del controlador: hasta el |ajuste| de SU tasa en la original, ACUMULADO por artículo (acreditado + nota ≤ facturado + |ajuste|).
      const extra = toleranciaDelArticulo(cents - total, m, acreditado, ctx.ajustePorTratamiento ?? {})
      if (!extra) {
        excede ??= bloqueoPorExceso(cents, total, m, nombres.get(id), Object.keys(ctx.saldo).length > 1)
        continue
      }
      partes = { ...queda }
      for (const [t, c] of Object.entries(extra) as Array<[TratamientoDeNota, number]>) {
        partes[t] = (partes[t] ?? 0) + c
        redondeo.push({ tratamiento: t, componente: 'ARTICULO', cents: c, ambito: ctx.ambito ?? 'FACTURA', orderItemId: id })
      }
      for (const t of TRATAMIENTOS_DE_NOTA) if (!partes[t]) delete partes[t]
    }
    for (const [t, c] of Object.entries(partes) as Array<[TratamientoDeNota, number]>) bruto[t] = (bruto[t] ?? 0) + c
    porRenglon.push({ orderItemId: id, totalCents: cents, porTratamiento: partes })
  }
  if (excede) return excede
  if (sinEvidencia) return { reason: 'ARTICULO_SIN_EVIDENCIA', message: MOTIVO_ARTICULO_SIN_EVIDENCIA }
  return { modalidad: 'POR_ARTICULOS', brutoPorTratamiento: bruto, porRenglon, ...(redondeo.length ? { redondeo } : {}) }
}

/**
 * (B) del controlador (9-oct): el exceso de un artículo sobre lo que le queda, repartido entre SUS tratamientos (los que facturó) hasta el
 * |ajuste| de cada uno en la asignación de la original, contando lo que ese artículo ya tomó de tolerancia en notas anteriores. `null` si no
 * cabe entero. La guarda por tasa (`cabeEnElSaldo`) no se relaja: la nota además tiene que caber en lo que queda de su tasa.
 */
function toleranciaDelArticulo(
  exceso: number,
  m: MontosDeArticulo,
  acreditado: BrutoPorTratamiento,
  ajuste: Partial<Record<TratamientoDeNota, number>>,
): BrutoPorTratamiento | null {
  const extra: BrutoPorTratamiento = {}
  let falta = exceso
  for (const t of TRATAMIENTOS_DE_NOTA) {
    if (!falta) break
    if (!(m.porTratamiento[t] ?? 0)) continue // sólo la tasa de ESE artículo
    const tomado = Math.max(0, (acreditado[t] ?? 0) - (m.porTratamiento[t] ?? 0))
    const cabe = Math.min(falta, Math.max(0, Math.abs(ajuste[t] ?? 0) - tomado))
    if (cabe) {
      extra[t] = cabe
      falta -= cabe
    }
  }
  return falta ? null : extra
}

/** El exceso que no cabe: el texto de lo devuelto de verdad, o (B′, descartada) el centavo que la 6b dejó en OTRA tasa. */
function bloqueoPorExceso(
  cents: number,
  queda: number,
  m: MontosDeArticulo,
  nombre: string | undefined,
  variasTasas: boolean,
): BloqueoDeReparto {
  const exceso = cents - queda
  // Ronda 1 (I3): el ajuste por tasa no dice a qué tasa movió la 6b el centavo (medido: con esa pista, 37 % de los casos reales salía con
  // «excede»). Sin dato para distinguirlo, todo exceso de centavos en una original con varias tasas se dice como lo que es: redondeo.
  if (exceso <= MAX_AJUSTE_DOCUMENTO_CENTS && variasTasas)
    return { reason: 'CENTAVOS_DE_REDONDEO', message: motivoCentavosDeRedondeo(nombre, exceso, 'ARTICULO') }
  return { reason: 'ARTICULO_EXCEDE_LO_FACTURADO', message: motivoArticuloExcede(nombre, cents, queda, m.totalCents) }
}

/**
 * C2 (Codex C2-4/C2-12, P10): una sola política para repartir una devolución entre tratamientos.
 * - delivery: su reparto congelado; inválido ⇒ se detiene (nunca cae a proporcional);
 * - por artículos: con evidencia de lo facturado de cada uno y sobre lo que QUEDA de él (C2-19); sin evidencia ⇒ se detiene;
 * - por importe (sin artículos): en proporción a lo que queda de cada tratamiento;
 * - por importe ELEGIDO: la misma cuenta, sólo si por artículos se detuvo por falta de evidencia (`FALTA_DE_EVIDENCIA`).
 */
export function repartoDeLaDevolucion(d: DevolucionARepartir, ctx: ContextoDeReparto): RepartoDeDevolucion | BloqueoDeReparto {
  const noPermitida: BloqueoDeReparto = { reason: 'MODALIDAD_NO_PERMITIDA', message: MOTIVO_MODALIDAD_NO_PERMITIDA }
  const entregaInvalida: BloqueoDeReparto = { reason: 'REPARTO_DE_ENTREGA_INVALIDO', message: MOTIVO_REPARTO_DE_ENTREGA_INVALIDO }
  // Ronda 2 (M-B1): centavos enteros ≥ 0 en toda modalidad; sin esto, sin artículos, un NaN o una fracción lanzaban (BigInt) y un
  // negativo salía como reparto negativo.
  if (!Number.isInteger(d.salesRefundCents) || d.salesRefundCents < 0)
    return { reason: 'IMPORTE_DEVUELTO_INVALIDO', message: MOTIVO_IMPORTE_DEVUELTO_INVALIDO }
  if (d.congelado === 'INVALIDO') return entregaInvalida
  if (d.congelado) {
    if (d.modalidadElegida) return noPermitida
    const partes = Object.entries(d.congelado) as Array<[TratamientoDeNota, number]>
    if (partes.some(([, c]) => !Number.isInteger(c) || c < 0) || partes.reduce((s, [, c]) => s + c, 0) !== d.salesRefundCents)
      return entregaInvalida
    return { modalidad: 'DELIVERY', brutoPorTratamiento: Object.fromEntries(partes.filter(([, c]) => c > 0)) }
  }
  if (!d.refundedItems.length)
    return d.modalidadElegida ? noPermitida : proporcional(d.salesRefundCents, ctx.saldo, 'POR_IMPORTE', ctx.ambito)
  const r = porArticulos(d, ctx)
  if (!d.modalidadElegida) return r
  // P10: «por importe» elegido sólo cuando lo que falta es la EVIDENCIA de lo facturado de cada artículo.
  return 'reason' in r && (FALTA_DE_EVIDENCIA as readonly string[]).includes(r.reason)
    ? proporcional(d.salesRefundCents, ctx.saldo, 'POR_IMPORTE_ELEGIDO', ctx.ambito)
    : noPermitida
}
