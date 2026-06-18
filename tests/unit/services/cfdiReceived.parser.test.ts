/**
 * Unit tests para el parser de CFDI 4.0 recibido → CreateExpenseInput (Buzón).
 *  - extrae emisor/fechas/importes/impuestos por tasa/UUID;
 *  - guard: el RECEPTOR debe ser nuestro RFC (no importar CFDI ajeno);
 *  - retenciones (ISR/IVA), tipo de comprobante, namespaces con prefijo cfdi:.
 */
import { BadRequestError } from '../../../src/errors/AppError'
import { parseCfdiXml } from '../../../src/services/fiscal/cfdiReceived.parser'

const OUR_RFC = 'EKU9003173C9'

const cfdi = (over: { receptor?: string; ret?: string; tipo?: string; metodo?: string } = {}) => `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital"
  Version="4.0" Fecha="2026-06-10T14:30:00" Serie="A" Folio="123" SubTotal="1000.00" Descuento="0.00"
  Moneda="MXN" Total="1160.00" TipoDeComprobante="${over.tipo ?? 'I'}" MetodoPago="${over.metodo ?? 'PUE'}" FormaPago="03">
  <cfdi:Emisor Rfc="CACO850101AB1" Nombre="Café del Centro SA" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="${over.receptor ?? OUR_RFC}" Nombre="Mi Negocio" UsoCFDI="G03"/>
  <cfdi:Conceptos><cfdi:Concepto ClaveProdServ="01010101" Cantidad="1" Descripcion="Servicio" Importe="1000.00"/></cfdi:Conceptos>
  <cfdi:Impuestos TotalImpuestosTrasladados="160.00">
    <cfdi:Traslados>
      <cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.00"/>
    </cfdi:Traslados>
    ${over.ret ?? ''}
  </cfdi:Impuestos>
  <cfdi:Complemento>
    <tfd:TimbreFiscalDigital Version="1.1" UUID="A1B2C3D4-0001-0002-0003-ABCDEF123456"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`

describe('parseCfdiXml', () => {
  it('extrae emisor, fechas, importes, IVA 16% y UUID', () => {
    const r = parseCfdiXml(cfdi(), OUR_RFC)
    expect(r.proveedorRfc).toBe('CACO850101AB1')
    expect(r.proveedorNombre).toBe('Café del Centro SA')
    expect(r.fechaEmision).toBe('2026-06-10')
    expect(r.subtotalCents).toBe(1000_00)
    expect(r.totalCents).toBe(1160_00)
    expect(r.ivaCents).toBe(160_00)
    expect(r.iva16Cents).toBe(160_00)
    expect(r.metodoPago).toBe('PUE')
    expect(r.comprobanteTipo).toBe('INGRESO')
    expect(r.uuid).toBe('A1B2C3D4-0001-0002-0003-ABCDEF123456')
    expect(r.folio).toBe('123')
    expect(r.source).toBe('XML_UPLOAD')
  })

  it('guard: si el RECEPTOR no es nuestro RFC → BadRequestError', () => {
    expect(() => parseCfdiXml(cfdi({ receptor: 'XAXX010101000' }), OUR_RFC)).toThrow(BadRequestError)
    expect(() => parseCfdiXml(cfdi({ receptor: 'XAXX010101000' }), OUR_RFC)).toThrow(/no es de tu RFC|a nombre de/i)
  })

  it('extrae retenciones de ISR y de IVA (servicios profesionales)', () => {
    const ret = `<cfdi:Retenciones>
      <cfdi:Retencion Impuesto="001" Importe="100.00"/>
      <cfdi:Retencion Impuesto="002" Importe="106.67"/>
    </cfdi:Retenciones>`
    const r = parseCfdiXml(cfdi({ ret }), OUR_RFC)
    expect(r.isrRetenidoCents).toBe(100_00)
    expect(r.ivaRetenidoCents).toBe(106_67)
  })

  it('PPD se detecta', () => {
    expect(parseCfdiXml(cfdi({ metodo: 'PPD' }), OUR_RFC).metodoPago).toBe('PPD')
  })

  it('comprobante EGRESO (nota de crédito) se detecta', () => {
    expect(parseCfdiXml(cfdi({ tipo: 'E' }), OUR_RFC).comprobanteTipo).toBe('EGRESO')
  })

  it('XML inválido → BadRequestError', () => {
    expect(() => parseCfdiXml('no soy xml <<<', OUR_RFC)).toThrow(BadRequestError)
    expect(() => parseCfdiXml('<root><a/></root>', OUR_RFC)).toThrow(/no es un CFDI/i)
  })

  it('XML vacío → BadRequestError', () => {
    expect(() => parseCfdiXml('', OUR_RFC)).toThrow(BadRequestError)
  })
})
