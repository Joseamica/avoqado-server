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
// El SDK va mockeado: un test NUNCA timbra de verdad.

const mockCreate = jest.fn()

jest.mock('facturapi', () => {
  return jest.fn().mockImplementation(() => ({
    invoices: { create: mockCreate },
  }))
})

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
  beforeEach(() => {
    mockCreate.mockReset()
    mockCreate.mockResolvedValue(MOCK_INVOICE_RESPONSE)
  })

  it('🔴 manda type "E" (EGRESO), no "I"', async () => {
    await new FacturapiProvider('sk_test_x').createCreditNote(baseParams)
    expect(mockCreate.mock.calls[0][0].type).toBe('E')
  })

  it('🔴 relaciona el CFDI original: related_documents[{ relationship:"01", documents:[uuid] }]', async () => {
    await new FacturapiProvider('sk_test_x').createCreditNote(baseParams)
    const payload = mockCreate.mock.calls[0][0]
    expect(payload.related_documents).toEqual([{ relationship: '01', documents: ['UUID-INGRESO-1'] }])
    // `documents` DEBE ser arreglo: un string suelto es la forma que el PAC rechaza.
    expect(Array.isArray(payload.related_documents[0].documents)).toBe(true)
  })

  it('usa G02 (Devoluciones, descuentos o bonificaciones)', async () => {
    await new FacturapiProvider('sk_test_x').createCreditNote(baseParams)
    expect(mockCreate.mock.calls[0][0].use).toBe('G02')
  })

  it('normaliza el nombre del receptor (el padrón del SAT lo guarda en MAYÚSCULAS)', async () => {
    await new FacturapiProvider('sk_test_x').createCreditNote(baseParams)
    expect(mockCreate.mock.calls[0][0].customer.legal_name).toBe('ESCUELA KEMPER URGATE SA DE CV')
  })

  it('🔴 los conceptos van en PESOS y con tax_included, para que el total sea lo devuelto al cliente', async () => {
    await new FacturapiProvider('sk_test_x').createCreditNote(baseParams)
    const item = mockCreate.mock.calls[0][0].items[0]
    expect(item.product.price).toBe(116) // 11600 centavos → 116 pesos
    expect(item.product.tax_included).toBe(true)
    expect(item.product.taxes).toEqual([{ type: 'IVA', rate: 0.16, factor: 'Tasa', withholding: false }])
  })

  it('estampa external_id (rescate determinista) y la serie del emisor', async () => {
    await new FacturapiProvider('sk_test_x').createCreditNote(baseParams)
    const payload = mockCreate.mock.calls[0][0]
    expect(payload.external_id).toBe('cfdi-refund-pay1')
    expect(payload.series).toBe('F')
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
    expect(mockCreate.mock.calls[0][0].items[0].product.taxes).toEqual([])
  })

  it('el error del PAC se propaga (no se traga)', async () => {
    mockCreate.mockRejectedValue(new Error('PAC 400: related uuid not found'))
    await expect(new FacturapiProvider('sk_test_x').createCreditNote(baseParams)).rejects.toThrow(/related uuid not found/)
  })
})
