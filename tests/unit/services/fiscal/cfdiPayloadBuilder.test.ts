// tests/unit/services/fiscal/cfdiPayloadBuilder.test.ts
import { buildCreateInvoiceParams, AvoqadoSaleInput } from '../../../../src/services/fiscal/cfdiPayloadBuilder'

const baseInput: AvoqadoSaleInput = {
  venueType: 'RESTAURANT',
  receptor: { rfc: 'EKU9003173C9', razonSocial: 'X', regimenFiscal: '601', codigoPostal: '64000', usoCfdi: 'G03' },
  paymentMethod: 'CASH',
  metodoPago: 'PUE',
  tipCents: 1500, // excluded from CFDI
  idempotencyKey: 'k1',
  items: [
    {
      description: 'Tacos',
      quantity: 2,
      unitPriceCents: 5000,
      discountCents: 0,
      taxRate: 0.16,
      satProductKey: null,
      satUnitKey: null,
      categoryDefaultProductKey: null,
      categoryDefaultUnitKey: null,
      objetoImp: null,
      taxExempt: false,
    },
  ],
}

describe('buildCreateInvoiceParams', () => {
  it('maps NET cents straight to ValorUnitario and adds IVA traslado', () => {
    const p = buildCreateInvoiceParams(baseInput)
    expect(p.formaPago).toBe('01')
    expect(p.metodoPago).toBe('PUE')
    expect(p.items).toHaveLength(1)
    const it = p.items[0]
    expect(it.unitPriceCents).toBe(5000) // NET, unchanged
    expect(it.taxes).toEqual([{ type: 'IVA', factor: 'Tasa', rate: 0.16, withholding: false }])
    expect(it.objetoImp).toBe('02')
  })

  it('resolves SAT keys: product override ?? category default ?? sector default', () => {
    const override = buildCreateInvoiceParams({
      ...baseInput,
      items: [{ ...baseInput.items[0], satProductKey: '12345678', satUnitKey: 'KGM' }],
    })
    expect(override.items[0].satProductKey).toBe('12345678')
    expect(override.items[0].satUnitKey).toBe('KGM')

    const cat = buildCreateInvoiceParams({
      ...baseInput,
      items: [{ ...baseInput.items[0], categoryDefaultProductKey: '99999999', categoryDefaultUnitKey: 'E48' }],
    })
    expect(cat.items[0].satProductKey).toBe('99999999')

    const sector = buildCreateInvoiceParams(baseInput) // nothing set → RESTAURANT sector default
    expect(sector.items[0].satProductKey).toBe('90101500')
    expect(sector.items[0].satUnitKey).toBe('E48')
  })

  it('NEVER includes the tip in the items (D2 — propina excluida)', () => {
    const p = buildCreateInvoiceParams(baseInput)
    const total = p.items.reduce((s, it) => s + it.unitPriceCents * it.quantity - it.discountCents, 0)
    expect(total).toBe(10000) // 2 × 5000, tip 1500 NOT included
  })

  it('exento item → objetoImp 01 and no traslado', () => {
    const p = buildCreateInvoiceParams({
      ...baseInput,
      items: [{ ...baseInput.items[0], taxRate: 0, taxExempt: true }],
    })
    expect(p.items[0].objetoImp).toBe('01')
    expect(p.items[0].taxes).toEqual([])
  })
})
