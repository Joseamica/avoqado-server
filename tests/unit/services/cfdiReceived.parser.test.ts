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

const CAFE =
  '<cfdi:Concepto ClaveProdServ="50201706" NoIdentificacion="CAF-001" Cantidad="10" ClaveUnidad="KGM" Unidad="Kilogramo" Descripcion="Café tostado grano" ValorUnitario="80.00" Importe="800.00"/>'
const AZUCAR =
  '<cfdi:Concepto ClaveProdServ="50161509" NoIdentificacion="AZU-500" Cantidad="4" ClaveUnidad="KGM" Descripcion="Azúcar refinada" ValorUnitario="50.00" Importe="200.00"/>'

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
    const sinCodigo =
      '<cfdi:Concepto ClaveProdServ="50201706" Cantidad="1" ClaveUnidad="H87" Descripcion="Flete" ValorUnitario="150.00" Importe="150.00"/>'
    const { conceptos } = parseCfdiReceived(cfdiConConceptos(sinCodigo), OUR_RFC)

    expect(conceptos[0].supplierItemCode).toBeNull()
    expect(conceptos[0].descripcion).toBe('Flete')
  })

  it('lee el descuento por renglón cuando viene', () => {
    const conDescuento =
      '<cfdi:Concepto ClaveProdServ="50201706" NoIdentificacion="CAF-001" Cantidad="10" ClaveUnidad="KGM" Descripcion="Café" ValorUnitario="80.00" Importe="800.00" Descuento="50.00"/>'
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

describe('frontera de XML no confiable', () => {
  it('rechaza DTD/entidades ANTES de procesarlas', () => {
    expect(() => parseCfdiXml('<!DOCTYPE Comprobante [<!ENTITY dato "contenido">]><Comprobante/>', 'AAA010101AAA')).toThrow(/DTD|entidades/)
  })
  it('rechaza documentos excesivos antes de validar XML', () => {
    expect(() => parseCfdiXml(' '.repeat(2 * 1024 * 1024 + 1), 'AAA010101AAA')).toThrow(/2 MiB/)
  })
})

// ─── C2 · Tarea 5 (Codex C2-13, C2-14): lo fiscal del XML timbrado, concepto por concepto ─────────────────────────────────────────
// `Cfdi.taxBreakdown` sólo guarda el resumen de traslados: con eso no se pueden cotejar los conceptos del modelo contra los timbrados
// ni distinguir el no objeto (que sólo aparece en el `ObjetoImp` de su concepto) de un redondeo. `xmlConceptos` guarda los textos del
// XML tal cual, en su orden; lo lee `leerXmlConceptos` (T4) y, si no tiene la forma exacta, la nota se queda esperando el XML.
import { conceptosFiscalesDesdeXml } from '../../../src/services/fiscal/cfdiReceived.parser'
import { desgloseDesdeXml } from '../../../src/services/fiscal/finalizadorCfdi'
import { leerXmlConceptos, unidadesDelXml } from '../../../src/services/fiscal/saldoFiscal'

const comprobante = (p: { SubTotal: string; Descuento?: string; Total: string; conceptos: string[]; resumen: string }) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" SubTotal="${p.SubTotal}"${
    p.Descuento !== undefined ? ` Descuento="${p.Descuento}"` : ''
  } Total="${p.Total}" TipoDeComprobante="I" Moneda="MXN">
  <cfdi:Conceptos>${p.conceptos.join('')}</cfdi:Conceptos>${p.resumen}
</cfdi:Comprobante>`

const TRASLADO_16 = (base: string, importe: string) =>
  `<cfdi:Traslado Base="${base}" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="${importe}"/>`
const RESUMEN_16 = (base: string, importe: string) =>
  `<cfdi:Impuestos TotalImpuestosTrasladados="${importe}"><cfdi:Traslados>${TRASLADO_16(base, importe)}</cfdi:Traslados></cfdi:Impuestos>`
const conTraslados = (attrs: string, traslados: string) =>
  `<cfdi:Concepto ${attrs}><cfdi:Impuestos><cfdi:Traslados>${traslados}</cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto>`

describe('C2 · conceptosFiscalesDesdeXml', () => {
  it('🔴 lee totales y cada concepto con su ObjetoImp, su descuento y sus traslados (también varios traslados en un concepto); el no objeto sin traslados', () => {
    const xml = comprobante({
      SubTotal: '250.01',
      Descuento: '0.00',
      Total: '258.01',
      conceptos: [
        '<cfdi:Concepto NoIdentificacion="F-1" ObjetoImp="02" Importe="250.000000" Descuento="0.000000"><cfdi:Impuestos><cfdi:Traslados>' +
          '<cfdi:Traslado Base="50.000000" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="8.000000"/>' +
          '<cfdi:Traslado Base="200.000000" Impuesto="002" TipoFactor="Exento"/></cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto>',
        '<cfdi:Concepto ObjetoImp="01" Importe="0.010000"/>',
      ],
      resumen:
        '<cfdi:Impuestos TotalImpuestosTrasladados="8.00"><cfdi:Traslados><cfdi:Traslado Base="50.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="8.00"/><cfdi:Traslado Base="200.00" Impuesto="002" TipoFactor="Exento"/></cfdi:Traslados></cfdi:Impuestos>',
    })
    expect(conceptosFiscalesDesdeXml(xml)).toEqual({
      version: 1,
      subTotal: '250.01',
      descuento: '0.00',
      total: '258.01',
      totalImpuestosTrasladados: '8.00',
      conceptos: [
        {
          noIdentificacion: 'F-1',
          objetoImp: '02',
          importe: '250.000000',
          descuento: '0.000000',
          traslados: [
            { impuesto: '002', tipoFactor: 'Tasa', tasa: '0.160000', base: '50.000000', importe: '8.000000' },
            { impuesto: '002', tipoFactor: 'Exento', tasa: null, base: '200.000000', importe: null },
          ],
        },
        { noIdentificacion: null, objetoImp: '01', importe: '0.010000', descuento: '0', traslados: [] },
      ],
    })
  })

  it('🔴 un traslado de IVA incompleto en un CONCEPTO ⇒ el mismo error que hoy da el resumen (aunque el resumen esté completo)', () => {
    const conceptoSinBase = comprobante({
      SubTotal: '100.00',
      Total: '116.00',
      conceptos: [
        conTraslados(
          'ObjetoImp="02" Importe="100.000000"',
          '<cfdi:Traslado Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="16.000000"/>',
        ),
      ],
      resumen: RESUMEN_16('100.00', '16.00'),
    })
    const resumenSinBase = comprobante({
      SubTotal: '100.00',
      Total: '116.00',
      conceptos: [],
      resumen:
        '<cfdi:Impuestos TotalImpuestosTrasladados="16.00"><cfdi:Traslados><cfdi:Traslado Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="16.00"/></cfdi:Traslados></cfdi:Impuestos>',
    })
    expect(() => desgloseDesdeXml(resumenSinBase)).toThrow('El XML contiene un traslado de IVA incompleto.') // el de hoy
    expect(() => conceptosFiscalesDesdeXml(conceptoSinBase)).toThrow('El XML contiene un traslado de IVA incompleto.')
    // Una tasa sin importe y un factor desconocido, igual que en el resumen.
    const sinImporte = conceptoSinBase.replace(
      '<cfdi:Traslado Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="16.000000"/>',
      '<cfdi:Traslado Base="100.000000" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000"/>',
    )
    expect(() => conceptosFiscalesDesdeXml(sinImporte)).toThrow(/incompleto/)
    const cuota = sinImporte.replace('TipoFactor="Tasa" TasaOCuota="0.160000"', 'TipoFactor="Cuota" TasaOCuota="1.000000" Importe="1.00"')
    expect(() => conceptosFiscalesDesdeXml(cuota)).toThrow(/incompleto/)
  })

  it('🔴 lo que exige la T4: el 0 % con Importe "0" tal cual, el exento con tasa e importe null EXPLÍCITOS, sin Descuento ⇒ "0", sin total de impuestos ⇒ null; un solo concepto y un solo traslado', () => {
    const xml = comprobante({
      SubTotal: '100.00',
      Total: '100.00',
      conceptos: [
        conTraslados(
          'NoIdentificacion="  " ObjetoImp="02" Importe="100.000000"',
          '<cfdi:Traslado Base="100.000000" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.000000" Importe="0"/>',
        ),
      ],
      resumen: '',
    })
    const x = conceptosFiscalesDesdeXml(xml)
    expect(x).toEqual({
      version: 1,
      subTotal: '100.00',
      descuento: '0.00',
      total: '100.00',
      totalImpuestosTrasladados: null,
      conceptos: [
        {
          noIdentificacion: null,
          objetoImp: '02',
          importe: '100.000000',
          descuento: '0',
          traslados: [{ impuesto: '002', tipoFactor: 'Tasa', tasa: '0.000000', base: '100.000000', importe: '0' }],
        },
      ],
    })
    // JSON no guarda `undefined`: un exento sin `tasa`/`importe` explícitos lo rechazaría `leerXmlConceptos`.
    const exento = conceptosFiscalesDesdeXml(
      comprobante({
        SubTotal: '50.00',
        Total: '50.00',
        conceptos: [
          conTraslados('ObjetoImp="02" Importe="50.000000"', '<cfdi:Traslado Base="50.000000" Impuesto="002" TipoFactor="Exento"/>'),
        ],
        resumen: '',
      }),
    )
    const viaJson = JSON.parse(JSON.stringify(exento))
    expect(viaJson.conceptos[0].traslados[0]).toEqual({
      impuesto: '002',
      tipoFactor: 'Exento',
      tasa: null,
      base: '50.000000',
      importe: null,
    })
    expect(leerXmlConceptos(viaJson)).toEqual(exento)
    expect(leerXmlConceptos(JSON.parse(JSON.stringify(x)))).toEqual(x)
  })

  it('🔴 conserva el ORDEN del XML (el cotejo es posicional) y sólo lee los traslados del concepto, nunca sus retenciones', () => {
    const xml = comprobante({
      SubTotal: '300.00',
      Total: '332.00',
      conceptos: [
        conTraslados('NoIdentificacion="B" ObjetoImp="02" Importe="200.000000"', TRASLADO_16('200.000000', '32.000000')),
        '<cfdi:Concepto NoIdentificacion="A" ObjetoImp="02" Importe="100.000000"><cfdi:Impuestos><cfdi:Traslados>' +
          '<cfdi:Traslado Base="100.000000" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.000000" Importe="0.000000"/></cfdi:Traslados>' +
          '<cfdi:Retenciones><cfdi:Retencion Base="100.000000" Impuesto="001" TipoFactor="Tasa" TasaOCuota="0.012500" Importe="1.250000"/></cfdi:Retenciones>' +
          '</cfdi:Impuestos></cfdi:Concepto>',
      ],
      resumen: RESUMEN_16('200.00', '32.00'),
    })
    const x = conceptosFiscalesDesdeXml(xml)
    expect(x.conceptos.map(c => c.noIdentificacion)).toEqual(['B', 'A'])
    expect(x.conceptos[1].traslados).toEqual([
      { impuesto: '002', tipoFactor: 'Tasa', tasa: '0.000000', base: '100.000000', importe: '0.000000' },
    ])
  })

  it('control — un traslado que NO es IVA conserva su código (nunca se etiqueta como 002); la T4 lo rechaza y el resumen sigue siendo sólo IVA', () => {
    // Avoqado no emite IEPS; si un XML lo trajera, la nota se detiene («objeto no soportado») en vez de leerlo como IVA.
    const xml = comprobante({
      SubTotal: '100.00',
      Total: '124.00',
      conceptos: [
        conTraslados(
          'ObjetoImp="02" Importe="100.000000"',
          TRASLADO_16('100.000000', '16.000000') +
            '<cfdi:Traslado Base="100.000000" Impuesto="003" TipoFactor="Tasa" TasaOCuota="0.080000" Importe="8.000000"/>',
        ),
      ],
      resumen:
        '<cfdi:Impuestos TotalImpuestosTrasladados="24.00"><cfdi:Traslados>' +
        TRASLADO_16('100.00', '16.00') +
        '<cfdi:Traslado Base="100.00" Impuesto="003" TipoFactor="Tasa" TasaOCuota="0.080000" Importe="8.00"/></cfdi:Traslados></cfdi:Impuestos>',
    })
    const x = conceptosFiscalesDesdeXml(xml)
    expect(x.conceptos[0].traslados.map(t => t.impuesto)).toEqual(['002', '003'])
    expect(unidadesDelXml(x)).toEqual({ invalido: expect.stringContaining('objeto de impuesto') })
    expect(desgloseDesdeXml(xml).map(t => t.impuesto)).toEqual(['002'])
  })

  it('🔴 contrato con la T4: `unidadesDelXml` saca el no objeto de su concepto `ObjetoImp 01` (nunca del resumen) y cada tratamiento de su traslado', () => {
    // $116 al 16 % + $0.01 no objeto (Review Focus 7): el no objeto NO aparece en el resumen de traslados.
    const xml = comprobante({
      SubTotal: '100.01',
      Total: '116.01',
      conceptos: [
        conTraslados('NoIdentificacion="T-1" ObjetoImp="02" Importe="100.000000"', TRASLADO_16('100.000000', '16.000000')),
        '<cfdi:Concepto NoIdentificacion="T-2" ObjetoImp="01" Importe="0.010000"/>',
      ],
      resumen: RESUMEN_16('100.00', '16.00'),
    })
    const unidades = unidadesDelXml(conceptosFiscalesDesdeXml(xml))
    expect(Array.isArray(unidades) && unidades.map(u => [u.clave, u.tratamiento, u.totalMicros])).toEqual([
      ['c0', 'IVA_16', 116_000_000],
      ['c1', 'NO_OBJETO', 10_000],
    ])
  })
})

// ─── C2 · Tarea 5, ronda 1 (M3): un atributo obligatorio que falta o no es número NO se inventa ─────────────────────────────────
// Antes: sin `SubTotal`, `Total`, `Importe` u `ObjetoImp` se guardaba `'0'` (evidencia que miente), y un `Importe=""` se guardaba `''`.
// Ahora se detiene con su motivo (el mismo `BadRequestError` de un traslado incompleto). `Descuento` y `TotalImpuestosTrasladados` son
// opcionales: ausentes valen `'0'`/`null`, pero si vienen tienen que ser números.
describe('C2 · ronda 1 (M3) · conceptosFiscalesDesdeXml no inventa atributos obligatorios', () => {
  const COMPLETO = comprobante({
    SubTotal: '100.00',
    Total: '116.00',
    conceptos: [conTraslados('ObjetoImp="02" Importe="100.000000"', TRASLADO_16('100.000000', '16.000000'))],
    resumen: RESUMEN_16('100.00', '16.00'),
  })

  it('control — el comprobante completo se lee; sin Descuento ⇒ "0.00"/"0" y sin TotalImpuestosTrasladados ⇒ null', () => {
    const x = conceptosFiscalesDesdeXml(COMPLETO.replace(' TotalImpuestosTrasladados="16.00"', ''))
    expect(x).toMatchObject({ subTotal: '100.00', total: '116.00', descuento: '0.00', totalImpuestosTrasladados: null })
    expect(x.conceptos[0]).toMatchObject({ objetoImp: '02', importe: '100.000000', descuento: '0' })
  })

  it.each([
    ['sin SubTotal', [' SubTotal="100.00"', ''], /«SubTotal»/],
    ['SubTotal vacío', ['SubTotal="100.00"', 'SubTotal=""'], /«SubTotal»/],
    ['sin Total', [' Total="116.00"', ''], /«Total»/],
    ['Total que no es número', ['Total="116.00"', 'Total="ciento"'], /«Total»/],
    ['Descuento del comprobante que no es número', ['SubTotal="100.00"', 'SubTotal="100.00" Descuento="x"'], /«Descuento»/],
    [
      'TotalImpuestosTrasladados vacío',
      ['TotalImpuestosTrasladados="16.00"', 'TotalImpuestosTrasladados=""'],
      /«TotalImpuestosTrasladados»/,
    ],
    ['concepto sin Importe', [' Importe="100.000000"', ''], /«Importe» válido en el concepto 1/],
    ['concepto con Importe vacío', ['Importe="100.000000"', 'Importe=""'], /«Importe» válido en el concepto 1/],
    ['concepto sin ObjetoImp', ['ObjetoImp="02" ', ''], /«ObjetoImp» válido en el concepto 1/],
    ['concepto con Descuento vacío', ['Importe="100.000000"', 'Importe="100.000000" Descuento=""'], /«Descuento» válido en el concepto 1/],
  ])('🔴 %s ⇒ se detiene con su motivo (nunca guarda "0" ni "")', (_caso, [de, a], motivo) => {
    const xml = COMPLETO.replace(de as string, a as string)
    expect(xml).not.toBe(COMPLETO)
    expect(() => conceptosFiscalesDesdeXml(xml)).toThrow(BadRequestError)
    expect(() => conceptosFiscalesDesdeXml(xml)).toThrow(motivo as RegExp)
  })
})

// ─── C2 · Tarea 8 (M7 de la T5): el tope del XML PROPIO (el que se baja del PAC después de timbrar) ya no es el del buzón ─────────────
import {
  lecturaFiscalDelXml,
  TOPE_XML_RECIBIDO_BYTES,
  TOPE_XML_TIMBRADO_PROPIO_BYTES,
} from '../../../src/services/fiscal/cfdiReceived.parser'

describe('C2 · Tarea 8 · el tope del XML propio', () => {
  /** Un CFDI propio (el del PAC) de EXACTAMENTE `bytes`, inflado con un complemento de relleno: el lector lo valida entero como XML. */
  const inflado = (bytes: number) => {
    const base = comprobante({
      SubTotal: '100.00',
      Total: '116.00',
      conceptos: [conTraslados('NoIdentificacion="F-1" ObjetoImp="02" Importe="100.000000"', TRASLADO_16('100.000000', '16.000000'))],
      resumen: RESUMEN_16('100.00', '16.00'),
    })
    const envoltura = '<cfdi:Complemento><r></r></cfdi:Complemento>'
    const sobra = bytes - Buffer.byteLength(base, 'utf8') - envoltura.length
    return base.replace('</cfdi:Comprobante>', `<cfdi:Complemento><r>${'A'.repeat(sobra)}</r></cfdi:Complemento></cfdi:Comprobante>`)
  }

  it('🔴 un XML propio de 2.06 MiB (una global de ~4,800 tickets con dos tasas, M7) se lee; el buzón sigue topado en 2 MiB', () => {
    const xml = inflado(2_155_273)
    expect(Buffer.byteLength(xml, 'utf8')).toBe(2_155_273)
    expect(() => lecturaFiscalDelXml(xml)).not.toThrow()
    expect(lecturaFiscalDelXml(xml).conceptos).toMatchObject({
      subTotal: '100.00',
      conceptos: [expect.objectContaining({ noIdentificacion: 'F-1', importe: '100.000000' })],
    })
    expect(() => parseCfdiXml(xml, OUR_RFC)).toThrow(/2 MiB/)
    expect(TOPE_XML_RECIBIDO_BYTES).toBe(2 * 1024 * 1024)
  })

  it('🔴 el tope del XML propio es acotado y con nombre (4 MiB): justo en el tope se lee; un byte más, no', () => {
    expect(TOPE_XML_TIMBRADO_PROPIO_BYTES).toBe(4 * 1024 * 1024)
    expect(() => lecturaFiscalDelXml(inflado(TOPE_XML_TIMBRADO_PROPIO_BYTES))).not.toThrow()
    expect(() => lecturaFiscalDelXml(inflado(TOPE_XML_TIMBRADO_PROPIO_BYTES + 1))).toThrow(/4 MiB/)
  })
})
