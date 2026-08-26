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

/**
 * Lectura de los CONCEPTOS (renglones) del CFDI.
 *
 * El parser original sólo leía emisor, fechas e importes: para el Buzón de gastos con los
 * totales basta. Conciliar una factura contra una orden de compra necesita el detalle, y
 * sobre todo el `NoIdentificacion` — el codigo con el que el proveedor llama a ESE producto,
 * que es lo unico estable entre una factura y la siguiente. La descripcion es texto libre y
 * cambia; el codigo no.
 *
 * `parseCfdiXml` NO cambia: sigue devolviendo `CreateExpenseInput` tal cual, para que el
 * camino de gastos que ya corre en produccion quede intacto.
 */
import { parseCfdiReceived } from '../../../src/services/fiscal/cfdiReceived.parser'

const cfdiConConceptos = (conceptos: string) => `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital"
  Version="4.0" Fecha="2026-06-10T14:30:00" Serie="A" Folio="123" SubTotal="1000.00" Descuento="0.00"
  Moneda="MXN" Total="1160.00" TipoDeComprobante="I" MetodoPago="PUE" FormaPago="03">
  <cfdi:Emisor Rfc="CACO850101AB1" Nombre="Café del Centro SA" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="${OUR_RFC}" Nombre="Mi Negocio" UsoCFDI="G03"/>
  <cfdi:Conceptos>${conceptos}</cfdi:Conceptos>
  <cfdi:Impuestos TotalImpuestosTrasladados="160.00">
    <cfdi:Traslados>
      <cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.00"/>
    </cfdi:Traslados>
  </cfdi:Impuestos>
  <cfdi:Complemento>
    <tfd:TimbreFiscalDigital Version="1.1" UUID="A1B2C3D4-0001-0002-0003-ABCDEF123456"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`

const CAFE = '<cfdi:Concepto ClaveProdServ="50201706" NoIdentificacion="CAF-001" Cantidad="10" ClaveUnidad="KGM" Unidad="Kilogramo" Descripcion="Café tostado grano" ValorUnitario="80.00" Importe="800.00"/>'
const AZUCAR = '<cfdi:Concepto ClaveProdServ="50161509" NoIdentificacion="AZU-500" Cantidad="4" ClaveUnidad="KGM" Descripcion="Azúcar refinada" ValorUnitario="50.00" Importe="200.00"/>'

describe('parseCfdiReceived — conceptos', () => {
  it('lee un renglón con su código de proveedor, cantidad e importes', () => {
    const { conceptos } = parseCfdiReceived(cfdiConConceptos(CAFE), OUR_RFC)

    expect(conceptos).toHaveLength(1)
    expect(conceptos[0]).toEqual({
      supplierItemCode: 'CAF-001',
      descripcion: 'Café tostado grano',
      claveProdServ: '50201706',
      claveUnidad: 'KGM',
      cantidad: 10,
      valorUnitarioCents: 80_00,
      importeCents: 800_00,
      descuentoCents: 0,
    })
  })

  it('lee varios renglones conservando su orden', () => {
    const { conceptos } = parseCfdiReceived(cfdiConConceptos(CAFE + AZUCAR), OUR_RFC)

    expect(conceptos.map(c => c.supplierItemCode)).toEqual(['CAF-001', 'AZU-500'])
    expect(conceptos.map(c => c.importeCents)).toEqual([800_00, 200_00])
  })

  it('un solo concepto no llega como objeto suelto sino como lista', () => {
    // fast-xml-parser colapsa un unico hijo a objeto; si no se normaliza, `.map` truena.
    const { conceptos } = parseCfdiReceived(cfdiConConceptos(CAFE), OUR_RFC)
    expect(Array.isArray(conceptos)).toBe(true)
  })

  it('tolera un renglón sin código de proveedor', () => {
    // `NoIdentificacion` es OPCIONAL en el CFDI. Sin el, ese renglon no puede casarse solo:
    // queda a mano. Lo que no puede pasar es que reviente la lectura entera.
    const sinCodigo = '<cfdi:Concepto ClaveProdServ="50201706" Cantidad="1" ClaveUnidad="H87" Descripcion="Flete" ValorUnitario="150.00" Importe="150.00"/>'
    const { conceptos } = parseCfdiReceived(cfdiConConceptos(sinCodigo), OUR_RFC)

    expect(conceptos[0].supplierItemCode).toBeNull()
    expect(conceptos[0].descripcion).toBe('Flete')
  })

  it('lee el descuento por renglón cuando viene', () => {
    const conDescuento = '<cfdi:Concepto ClaveProdServ="50201706" NoIdentificacion="CAF-001" Cantidad="10" ClaveUnidad="KGM" Descripcion="Café" ValorUnitario="80.00" Importe="800.00" Descuento="50.00"/>'
    const { conceptos } = parseCfdiReceived(cfdiConDescuentoWrap(conDescuento), OUR_RFC)

    expect(conceptos[0].descuentoCents).toBe(50_00)
  })

  it('devuelve una lista vacía si el CFDI no trae conceptos', () => {
    const sinConceptos = cfdiConConceptos('')
    expect(parseCfdiReceived(sinConceptos, OUR_RFC).conceptos).toEqual([])
  })

  it('mantiene el guard del receptor: un CFDI ajeno no se lee', () => {
    const ajeno = cfdiConConceptos(CAFE).replace(OUR_RFC, 'XAXX010101000')
    expect(() => parseCfdiReceived(ajeno, OUR_RFC)).toThrow(BadRequestError)
  })

  it('devuelve además el gasto, idéntico a lo que da parseCfdiXml', () => {
    const xml = cfdiConConceptos(CAFE)
    expect(parseCfdiReceived(xml, OUR_RFC).expense).toEqual(parseCfdiXml(xml, OUR_RFC))
  })
})

function cfdiConDescuentoWrap(concepto: string) {
  return cfdiConConceptos(concepto)
}
