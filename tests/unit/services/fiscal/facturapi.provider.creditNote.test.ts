// El CONTRATO con el PAC para una nota de crédito (CFDI de Egreso).
//
// Es el punto donde más caro sale equivocarse: si `related_documents` va con la forma
// incorrecta, el SAT recibe un egreso SUELTO (sin relacionar a la factura original), que es
// exactamente lo que la decisión del founder quiere evitar — la devolución debe quedar atada
// al CFDI de ingreso, sin cancelarlo.
//
// Forma verificada en docs.facturapi.io (Guías → Facturas → Egreso / Relacionados, 2026-08-18)
// y contra los enums del SDK (`InvoiceType.EGRESO='E'`, `InvoiceRelation.NOTA_DE_CREDITO='01'`,
// `InvoiceUse.DEVOLUCIONES_DESCUENTOS_BONIFICACIONES='G02'`):
//   { type:'E', related_documents:[{ relationship:'01', documents:['<uuid>'] }], use:'G02', ... }
//
// El transporte HTTP va mockeado: un test NUNCA timbra de verdad.

import { FacturapiProvider } from '@/services/fiscal/providers/facturapi.provider'
import type { CreditNoteParams } from '@/services/fiscal/providers/fiscal-provider.interface'

const MOCK_INVOICE_RESPONSE = {
  id: 'fa_egreso_1',
  uuid: 'UUID-EGRESO',
  series: 'F',
  folio_number: 77,
  total: 116.0,
  stamp: { date: '2026-08-18T10:00:00Z' },
  status: 'valid',
}

const baseParams: CreditNoteParams = {
  receptor: {
    rfc: 'EKU9003173C9',
    razonSocial: '  escuela kemper   urgate sa de cv ',
    regimenFiscal: '601',
    codigoPostal: '64000',
    usoCfdi: 'G02',
    email: 'cliente@example.com',
  },
  items: [
    {
      satProductKey: '01010101',
      satUnitKey: 'ACT',
      description: 'Devolución sobre factura F12',
      quantity: 1,
      unitPriceCents: 11600,
      discountCents: 0,
      objetoImp: '02',
      taxes: [{ type: 'IVA', factor: 'Tasa', rate: 0.16, withholding: false }],
      taxIncluded: true,
    },
  ],
  formaPago: '04',
  metodoPago: 'PUE',
  serie: 'F',
  idempotencyKey: 'cfdi-refund-pay1',
  externalId: 'cfdi-refund-pay1',
  relationship: '01',
  relatedUuids: ['UUID-INGRESO-1'],
}

describe('FacturapiProvider.createCreditNote — contrato con el PAC', () => {
  let fetchMock: jest.SpyInstance
  const payload = () => JSON.parse(fetchMock.mock.calls[0][1].body)
  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(MOCK_INVOICE_RESPONSE), { status: 200 }))
  })

  afterEach(() => fetchMock.mockRestore())

  it('🔴 manda type "E" (EGRESO), no "I"', async () => {
    await new FacturapiProvider('sk_test_x').createCreditNote(baseParams)
    expect(payload().type).toBe('E')
  })

  it('🔴 relaciona el CFDI original: related_documents[{ relationship:"01", documents:[uuid] }]', async () => {
    await new FacturapiProvider('sk_test_x').createCreditNote(baseParams)
    const body = payload()
    expect(body.related_documents).toEqual([{ relationship: '01', documents: ['UUID-INGRESO-1'] }])
    // `documents` DEBE ser arreglo: un string suelto es la forma que el PAC rechaza.
    expect(Array.isArray(body.related_documents[0].documents)).toBe(true)
  })

  it('usa G02 (Devoluciones, descuentos o bonificaciones)', async () => {
    await new FacturapiProvider('sk_test_x').createCreditNote(baseParams)
    expect(payload().use).toBe('G02')
  })

  it('normaliza el nombre del receptor (el padrón del SAT lo guarda en MAYÚSCULAS)', async () => {
    await new FacturapiProvider('sk_test_x').createCreditNote(baseParams)
    expect(payload().customer.legal_name).toBe('ESCUELA KEMPER URGATE SA DE CV')
  })

  it('🔴 los conceptos van en PESOS y con tax_included, para que el total sea lo devuelto al cliente', async () => {
    await new FacturapiProvider('sk_test_x').createCreditNote(baseParams)
    const item = payload().items[0]
    expect(item.product.price).toBe(116) // 11600 centavos → 116 pesos
    expect(item.product.tax_included).toBe(true)
    expect(item.product.taxes).toEqual([{ type: 'IVA', rate: 0.16, factor: 'Tasa', withholding: false }])
  })

  it('estampa external_id (rescate determinista) y la serie del emisor', async () => {
    await new FacturapiProvider('sk_test_x').createCreditNote(baseParams)
    const body = payload()
    expect(body.external_id).toBe('cfdi-refund-pay1')
    expect(body.series).toBe('F')
  })

  it('devuelve el timbre normalizado (uuid, serie, folio, total en centavos)', async () => {
    const res = await new FacturapiProvider('sk_test_x').createCreditNote(baseParams)
    expect(res).toMatchObject({ providerInvoiceId: 'fa_egreso_1', uuid: 'UUID-EGRESO', serie: 'F', folio: '77', totalCents: 11600 })
  })

  it('un concepto EXENTO viaja sin traslados (nunca se inventa un 16%)', async () => {
    await new FacturapiProvider('sk_test_x').createCreditNote({
      ...baseParams,
      items: [{ ...baseParams.items[0], objetoImp: '01', taxes: [] }],
    })
    expect(payload().items[0].product.taxes).toEqual([])
  })

  it('sólo protocolo1 envía idempotency_key y conserva HTTP/code', async () => {
    await new FacturapiProvider('sk_test_x').createCreditNote({
      ...baseParams,
      protocoloIva: 1,
      idempotencyKey: 'refund#2',
      externalId: 'refund#2',
    })
    expect(payload()).toMatchObject({ external_id: 'refund#2', idempotency_key: 'refund#2' })
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 'invalid_request', message: 'bad' }), { status: 422 }))
    await expect(new FacturapiProvider('sk_test_x').createCreditNote(baseParams)).rejects.toMatchObject({
      status: 422,
      code: 'invalid_request',
    })
  })
  it('legacy conserva payload sin idempotency_key', async () => {
    await new FacturapiProvider('sk_test_x').createCreditNote(baseParams)
    expect(payload().idempotency_key).toBeUndefined()
  })
  it('202 pending conserva id sin inventar UUID', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: 'pending', status: 'pending' }), { status: 202 }))
    expect(await new FacturapiProvider('sk_test_x').createCreditNote(baseParams)).toMatchObject({
      providerInvoiceId: 'pending',
      status: 'pending',
      uuid: null,
    })
  })
  it('el error del PAC se propaga (no se traga)', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: 'invalid_request', message: 'related uuid not found' }), { status: 400 }),
    )
    await expect(new FacturapiProvider('sk_test_x').createCreditNote(baseParams)).rejects.toThrow(/related uuid not found/)
  })

  // ── C1 (Tarea 4): sku, base y precio a 6 decimales también en la nota ────────────────────────────────────

  // 🔴 «Los payloads de hoy no cambian»: el cuerpo CRUDO (texto, con el orden de las llaves) de una nota sin sku ni base
  // es el de antes de la Tarea 4. El esperado se escribió contra el código SIN tocar.
  it('control — el cuerpo de la nota de hoy sale byte a byte igual (IVA incluido, y un concepto exento)', async () => {
    await new FacturapiProvider('sk_test_x').createCreditNote({
      ...baseParams,
      items: [
        baseParams.items[0],
        { ...baseParams.items[0], description: 'Devolución exenta', unitPriceCents: 5000, objetoImp: '01', taxes: [] },
      ],
    })
    const esperado = {
      type: 'E',
      customer: {
        legal_name: 'ESCUELA KEMPER URGATE SA DE CV',
        tax_id: 'EKU9003173C9',
        tax_system: '601',
        address: { zip: '64000' },
        email: 'cliente@example.com',
      },
      use: 'G02',
      payment_form: '04',
      payment_method: 'PUE',
      series: 'F',
      external_id: 'cfdi-refund-pay1',
      related_documents: [{ relationship: '01', documents: ['UUID-INGRESO-1'] }],
      items: [
        {
          quantity: 1,
          discount: 0,
          product: {
            description: 'Devolución sobre factura F12',
            product_key: '01010101',
            unit_key: 'ACT',
            price: 116,
            tax_included: true,
            taxability: '02',
            taxes: [{ type: 'IVA', rate: 0.16, factor: 'Tasa', withholding: false }],
          },
        },
        {
          quantity: 1,
          discount: 0,
          product: {
            description: 'Devolución exenta',
            product_key: '01010101',
            unit_key: 'ACT',
            price: 50,
            tax_included: true,
            taxability: '01',
            taxes: [],
          },
        },
      ],
    }
    expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify(esperado))
  })

  it('🔴 C1: la nota manda sku, la base de cada traslado y el precio con 6 decimales', async () => {
    await new FacturapiProvider('sk_test_x').createCreditNote({
      ...baseParams,
      items: [
        {
          ...baseParams.items[0],
          unitPriceCents: 28793,
          unitPriceDecimal: '287.931034',
          taxIncluded: false,
          sku: 'F-9',
          taxes: [
            { type: 'IVA', factor: 'Tasa', rate: 0.16, withholding: false, base: '137.931034' },
            { type: 'IVA', factor: 'Exento', rate: 0, withholding: false, base: '50.000000' },
          ],
        },
      ],
    })
    const product = payload().items[0].product
    expect(product.sku).toBe('F-9')
    expect(product.price).toBe(287.931034)
    expect(product.taxes).toEqual([
      { type: 'IVA', rate: 0.16, factor: 'Tasa', withholding: false, base: 137.931034 },
      { type: 'IVA', rate: 0, factor: 'Exento', withholding: false, base: 50 },
    ])
  })

  it('control — la nota sin `unitPriceDecimal` sigue mandando los centavos', async () => {
    await new FacturapiProvider('sk_test_x').createCreditNote({ ...baseParams, items: [{ ...baseParams.items[0], unitPriceCents: 4500 }] })
    expect(payload().items[0].product.price).toBe(45)
  })
})
