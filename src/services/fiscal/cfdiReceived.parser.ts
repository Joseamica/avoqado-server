import { XMLParser } from 'fast-xml-parser'

import { BadRequestError } from '../../errors/AppError'
import type { CreateExpenseInput } from './expense.service'

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

const pesos = (s: string | number | undefined): number => Math.round(parseFloat(String(s ?? '0')) * 100)
const toArray = <T>(x: T | T[] | undefined): T[] => (x == null ? [] : Array.isArray(x) ? x : [x])

/** Parsea un CFDI 4.0 recibido. `ourRfc` = RFC del contribuyente receptor (debe coincidir). */
export function parseCfdiXml(xml: string, ourRfc: string): CreateExpenseInput {
  if (!xml || !xml.trim()) throw new BadRequestError('El XML del CFDI está vacío.')

  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true })
  let doc: any
  try {
    doc = parser.parse(xml)
  } catch {
    throw new BadRequestError('El archivo no es un XML válido.')
  }

  const c = doc?.Comprobante
  if (!c) throw new BadRequestError('El XML no es un CFDI (no se encontró el nodo Comprobante).')

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

  return {
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
}
