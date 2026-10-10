import { XMLParser, XMLValidator } from 'fast-xml-parser'

import { BadRequestError } from '../../errors/AppError'
import type { CreateExpenseInput } from './expense.service'
import type { TrasladoDelXml, XmlConceptos } from './saldoFiscal'

/**
 * Parser de un CFDI 4.0 RECIBIDO (el que nos emite un proveedor) → CreateExpenseInput para el Buzón.
 *
 * Lee el XML timbrado, valida que el RECEPTOR sea nuestro contribuyente (guard anti-error: no importar
 * un CFDI ajeno), y extrae emisor, fechas, importes y el desglose de impuestos por tasa (IVA 16/8/0,
 * IEPS, retenciones de ISR/IVA) + el folio fiscal (UUID). Money en pesos del CFDI → centavos enteros.
 */

const IMP_IVA = '002'
const IMP_ISR = '001'
const IMP_IEPS = '003'

const TIPO_COMPROBANTE: Record<string, CreateExpenseInput['comprobanteTipo']> = {
  I: 'INGRESO',
  E: 'EGRESO',
  N: 'NOMINA',
  P: 'PAGO',
  T: 'TRASLADO',
}

/**
 * Un renglón del CFDI, tal como lo necesita la conciliación contra una orden de compra.
 *
 * `supplierItemCode` es el `NoIdentificacion` del SAT: el código con el que el PROVEEDOR llama
 * a ese producto. Es lo único estable entre una factura y la siguiente — la descripción es
 * texto libre y cambia. Es opcional en el CFDI: sin él, ese renglón no se puede casar solo.
 */
export interface CfdiConcepto {
  supplierItemCode: string | null
  descripcion: string
  claveProdServ: string | null
  /** Catálogo de unidades del SAT (`KGM`, `H87`…), NO nuestro enum `Unit`. */
  claveUnidad: string | null
  cantidad: number
  valorUnitarioCents: number
  importeCents: number
  descuentoCents: number
}

export interface CfdiReceived {
  expense: CreateExpenseInput
  conceptos: CfdiConcepto[]
}

/** El tope de un XML de un TERCERO (buzón de gastos, factura de un proveedor): lo sube una persona. */
export const TOPE_XML_RECIBIDO_BYTES = 2 * 1024 * 1024
/**
 * C2 · Tarea 8 (M7 de la T5): el tope del XML PROPIO que se baja del PAC después de timbrar (`lecturaFiscalDelXml`): **4 MiB = 4,194,304
 * bytes**. Medido el 9-oct con la plantilla real del sandbox (folio de 15, ~399 B por concepto de una tasa, ~497 B de dos, ~4.9 KB fijos):
 * 4,800 tickets con la mitad de dos tasas = 2,155,273 B (el tope del buzón la rechazaba) se lee en 171 ms; 9,000 = 4,036,873 B en 298 ms;
 * 9,600 = 4,305,673 B se rechaza. Cubre ~10,500 tickets de una tasa (~8,400 de dos): ~2.2× el máximo mensual de hoy (3,909 tickets ≈ 1.5
 * MiB). 🔴 Techo conocido: arriba del tope el XML no se lee: la global guarda su archivo (`xmlUrl`, C2 · OF-2 T8 M4) pero no
 * `xmlConceptos` (sólo la marca de ilegible), y sus notas se detienen con «XML ilegible»; congelar lo de cada ticket al leer el XML es del
 * plan aparte de capacidad.
 */
export const TOPE_XML_TIMBRADO_PROPIO_BYTES = 4 * 1024 * 1024

const pesos = (s: string | number | undefined): number => Math.round(parseFloat(String(s ?? '0')) * 100)
const toArray = <T>(x: T | T[] | undefined): T[] => (x == null ? [] : Array.isArray(x) ? x : [x])

/**
 * Comparte el lector del comprobante; nunca suma impuestos de cada concepto. `topeBytes`: el del buzón por omisión (XML de terceros); el XML
 * propio que se baja del PAC pasa `TOPE_XML_TIMBRADO_PROPIO_BYTES` (C2 · Tarea 8). El tope se revisa ANTES de validar o parsear.
 */
function comprobanteDesdeXml(xml: string, topeBytes: number = TOPE_XML_RECIBIDO_BYTES): any {
  if (typeof xml !== 'string') throw new BadRequestError('El XML del CFDI debe ser texto.')
  if (Buffer.byteLength(xml ?? '', 'utf8') > topeBytes)
    throw new BadRequestError(`El XML del CFDI excede ${topeBytes / (1024 * 1024)} MiB.`)
  // CFDI never needs a DTD. Refuse it before even the validator sees untrusted entities.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new BadRequestError('El CFDI no admite DTD ni declaraciones de entidades.')
  if (!xml?.trim()) throw new BadRequestError('El XML del CFDI está vacío.')
  if (XMLValidator.validate(xml) !== true) throw new BadRequestError('El archivo no es un XML válido.')
  const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true }).parse(xml)
  if (doc?.Comprobante === undefined) throw new BadRequestError('El XML no es un CFDI (no se encontró el nodo Comprobante).')
  return doc.Comprobante
}

export function trasladosDesdeXml(xml: string): Array<Record<string, string>> {
  return toArray(comprobanteDesdeXml(xml).Impuestos?.Traslados?.Traslado)
}

const esDecimal = (x: unknown): x is string => typeof x === 'string' && /^\d+(?:\.\d+)?$/.test(x)

/**
 * Un traslado del XML con la forma de `Cfdi.taxBreakdown`: valida y mapea igual en el resumen (`desgloseDesdeXml`) y en cada concepto
 * (`conceptosFiscalesDesdeXml`). Los textos se guardan tal cual (se comparan como número, a 6 decimales); el exento lleva `tasa` e
 * `importe` en `null` explícitos (JSON no guarda `undefined`). Conserva el código de impuesto: nunca etiqueta como IVA otro impuesto.
 */
export function trasladoDeIva(tr: Record<string, unknown>): TrasladoDelXml {
  const tipoFactor = tr['@_TipoFactor']
  if (
    !esDecimal(tr['@_Base']) ||
    (tipoFactor !== 'Tasa' && tipoFactor !== 'Exento') ||
    (tipoFactor === 'Tasa' && (!esDecimal(tr['@_TasaOCuota']) || !esDecimal(tr['@_Importe'])))
  ) {
    throw new BadRequestError('El XML contiene un traslado de IVA incompleto.')
  }
  return {
    impuesto: String(tr['@_Impuesto'] ?? ''),
    tipoFactor,
    base: tr['@_Base'] as string,
    tasa: tipoFactor === 'Exento' ? null : (tr['@_TasaOCuota'] as string),
    importe: tipoFactor === 'Exento' ? null : (tr['@_Importe'] as string),
  }
}

/**
 * C2 · ronda 1 (M3): un atributo numérico del XML timbrado, tal cual. Si es obligatorio y falta, o si viene y no es un número, se detiene
 * con su motivo: nunca se inventa un `'0'` ni se guarda un `''`. Uno opcional ausente vale lo que dice `siFalta`.
 */
function numeroDelXml(nodo: any, nombre: string, donde: string, siFalta?: string): string {
  const v = nodo?.[`@_${nombre}`]
  if (v == null && siFalta !== undefined) return siFalta
  if (!esDecimal(v)) throw new BadRequestError(`El XML timbrado no trae un «${nombre}» válido${donde}.`)
  return v
}

/** C2 (D5): lo fiscal de un comprobante ya leído, concepto por concepto (ObjetoImp, descuento y traslados), y sus totales. Nunca suma nada. */
function conceptosDelComprobante(c: any): XmlConceptos {
  const totalImpuestos = c?.Impuestos?.['@_TotalImpuestosTrasladados']
  return {
    version: 1,
    subTotal: numeroDelXml(c, 'SubTotal', ''),
    descuento: numeroDelXml(c, 'Descuento', '', '0.00'),
    total: numeroDelXml(c, 'Total', ''),
    totalImpuestosTrasladados: totalImpuestos == null ? null : numeroDelXml(c.Impuestos, 'TotalImpuestosTrasladados', ''),
    // En el orden del XML (el cotejo es posicional); de cada concepto sólo sus traslados, nunca sus retenciones.
    conceptos: toArray<any>(c?.Conceptos?.Concepto).map((co, i) => {
      const donde = ` en el concepto ${i + 1}`
      const objetoImp = co?.['@_ObjetoImp']
      if (typeof objetoImp !== 'string' || !/^\d{2}$/.test(objetoImp))
        throw new BadRequestError(`El XML timbrado no trae un «ObjetoImp» válido${donde}.`)
      return {
        noIdentificacion: co['@_NoIdentificacion'] != null ? String(co['@_NoIdentificacion']).trim() || null : null,
        objetoImp,
        importe: numeroDelXml(co, 'Importe', donde),
        descuento: numeroDelXml(co, 'Descuento', donde, '0'),
        traslados: toArray<any>(co.Impuestos?.Traslados?.Traslado).map(tr => trasladoDeIva(tr)),
      }
    }),
  }
}

/** C2 (D5): lo fiscal del XML timbrado, concepto por concepto. Lanza `BadRequestError` con su motivo si algo obligatorio no se lee. */
export function conceptosFiscalesDesdeXml(xml: string): XmlConceptos {
  return conceptosDelComprobante(comprobanteDesdeXml(xml))
}

/**
 * C2 · ronda 1 (M2): lo fiscal del XML timbrado leído UNA sola vez (validar y parsear un XML de una global grande toma ~130 ms síncronos).
 * Devuelve los traslados del resumen (para `taxBreakdown`) y los conceptos, o por qué no se pueden guardar (M3). Un XML ilegible lanza.
 */
export function lecturaFiscalDelXml(xml: string): {
  resumen: Array<Record<string, string>>
  conceptos: XmlConceptos | { invalido: string }
} {
  const c = comprobanteDesdeXml(xml, TOPE_XML_TIMBRADO_PROPIO_BYTES) // C2 · Tarea 8 (M7): el XML propio, no el del buzón
  let conceptos: XmlConceptos | { invalido: string }
  try {
    conceptos = conceptosDelComprobante(c)
  } catch (err) {
    if (!(err instanceof BadRequestError)) throw err
    conceptos = { invalido: err.message }
  }
  return { resumen: toArray(c?.Impuestos?.Traslados?.Traslado), conceptos }
}

/**
 * Parsea un CFDI 4.0 recibido. `ourRfc` = RFC del contribuyente receptor (debe coincidir).
 *
 * Se mantiene con la MISMA firma y el MISMO valor de retorno que antes de que existieran los
 * conceptos: el Buzón de gastos, que sólo necesita totales, no cambia una línea.
 */
export function parseCfdiXml(xml: string, ourRfc: string): CreateExpenseInput {
  return parseCfdiReceived(xml, ourRfc).expense
}

/** Igual que `parseCfdiXml`, más el detalle de renglones que la conciliación necesita. */
export function parseCfdiReceived(xml: string, ourRfc: string): CfdiReceived {
  const c = comprobanteDesdeXml(xml)

  const emisor = c.Emisor
  const receptor = c.Receptor
  if (!emisor?.['@_Rfc'] || !receptor?.['@_Rfc']) throw new BadRequestError('El CFDI no tiene Emisor/Receptor.')

  const receptorRfc = String(receptor['@_Rfc']).toUpperCase().trim()
  if (receptorRfc !== ourRfc.toUpperCase().trim()) {
    throw new BadRequestError(`Este CFDI está a nombre de ${receptorRfc}, no de tu RFC (${ourRfc}). No puedes importarlo como tu gasto.`)
  }

  // Fecha de emisión = parte de fecha del atributo Fecha (ISO sin zona).
  const fechaEmision = String(c['@_Fecha'] ?? '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaEmision)) throw new BadRequestError('El CFDI no tiene una fecha de emisión válida.')

  // Impuestos: traslados (IVA por tasa, IEPS) + retenciones (ISR, IVA).
  let iva16 = 0
  let iva8 = 0
  let iva0Base = 0
  let exentoBase = 0
  let ieps = 0
  let ivaRetenido = 0
  let isrRetenido = 0

  const imp = c.Impuestos
  for (const tr of toArray<any>(imp?.Traslados?.Traslado)) {
    const code = String(tr['@_Impuesto'] ?? '')
    const importe = pesos(tr['@_Importe'])
    const base = pesos(tr['@_Base'])
    const tasa = parseFloat(String(tr['@_TasaOCuota'] ?? '0'))
    const factor = String(tr['@_TipoFactor'] ?? '')
    if (code === IMP_IVA) {
      if (factor === 'Exento') exentoBase += base
      else if (tasa >= 0.155 && tasa <= 0.165) iva16 += importe
      else if (tasa >= 0.075 && tasa <= 0.085) iva8 += importe
      else if (tasa === 0) iva0Base += base
      else iva16 += importe // tasa atípica → al 16% por defecto (el contador ajusta)
    } else if (code === IMP_IEPS) {
      ieps += importe
    }
  }
  for (const re of toArray<any>(imp?.Retenciones?.Retencion)) {
    const code = String(re['@_Impuesto'] ?? '')
    const importe = pesos(re['@_Importe'])
    if (code === IMP_IVA) ivaRetenido += importe
    else if (code === IMP_ISR) isrRetenido += importe
  }

  // Complemento → TimbreFiscalDigital → UUID (folio fiscal).
  const tfd = c.Complemento?.TimbreFiscalDigital
  const uuid = tfd ? String((Array.isArray(tfd) ? tfd[0] : tfd)['@_UUID'] ?? '').trim() || null : null

  const ivaCents = iva16 + iva8
  const subtotalCents = pesos(c['@_SubTotal'])
  const descuentoCents = pesos(c['@_Descuento'])
  const totalCents = pesos(c['@_Total'])

  // Renglones. `Conceptos.Concepto` llega como objeto cuando hay uno solo: toArray lo normaliza.
  const conceptos: CfdiConcepto[] = toArray<any>(c.Conceptos?.Concepto).map(co => ({
    supplierItemCode: co['@_NoIdentificacion'] != null ? String(co['@_NoIdentificacion']).trim() || null : null,
    descripcion: String(co['@_Descripcion'] ?? '').trim(),
    claveProdServ: co['@_ClaveProdServ'] != null ? String(co['@_ClaveProdServ']).trim() : null,
    claveUnidad: co['@_ClaveUnidad'] != null ? String(co['@_ClaveUnidad']).trim() : null,
    cantidad: parseFloat(String(co['@_Cantidad'] ?? '0')) || 0,
    valorUnitarioCents: pesos(co['@_ValorUnitario']),
    importeCents: pesos(co['@_Importe']),
    descuentoCents: pesos(co['@_Descuento']),
  }))

  const expense: CreateExpenseInput = {
    proveedorRfc: String(emisor['@_Rfc']).toUpperCase().trim(),
    proveedorNombre: String(emisor['@_Nombre'] ?? emisor['@_Rfc']).trim(),
    proveedorRegimen: emisor['@_RegimenFiscal'] ? String(emisor['@_RegimenFiscal']) : null,
    comprobanteTipo: TIPO_COMPROBANTE[String(c['@_TipoDeComprobante'] ?? 'I')] ?? 'INGRESO',
    usoCfdi: receptor['@_UsoCFDI'] ? String(receptor['@_UsoCFDI']) : null,
    metodoPago: String(c['@_MetodoPago'] ?? 'PUE') === 'PPD' ? 'PPD' : 'PUE',
    formaPago: c['@_FormaPago'] ? String(c['@_FormaPago']) : null,
    fechaEmision,
    subtotalCents,
    descuentoCents,
    ivaCents,
    iva16Cents: iva16,
    iva8Cents: iva8,
    iva0BaseCents: iva0Base,
    exentoBaseCents: exentoBase,
    iepsCents: ieps,
    ivaRetenidoCents: ivaRetenido,
    isrRetenidoCents: isrRetenido,
    totalCents,
    uuid,
    serie: c['@_Serie'] ? String(c['@_Serie']) : null,
    folio: c['@_Folio'] ? String(c['@_Folio']) : null,
    source: 'XML_UPLOAD',
  }

  return { expense, conceptos }
}
