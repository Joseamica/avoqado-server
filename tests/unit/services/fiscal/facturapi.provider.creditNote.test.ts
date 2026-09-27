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
})
