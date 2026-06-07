// tests/unit/services/fiscal/cfdiPayloadBuilder.test.ts
import {
  buildCreateInvoiceParams,
  buildGlobalInvoiceParams,
  groupOrderIntoGlobalLines,
  AvoqadoSaleInput,
  GlobalInvoiceLine,
  GlobalLineItemInput,
} from '../../../../src/services/fiscal/cfdiPayloadBuilder'

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
  it('maps the unit price straight to ValorUnitario and adds IVA traslado (NET by default)', () => {
    const p = buildCreateInvoiceParams(baseInput)
    expect(p.formaPago).toBe('01')
    expect(p.metodoPago).toBe('PUE')
    expect(p.items).toHaveLength(1)
    const it = p.items[0]
    expect(it.unitPriceCents).toBe(5000) // unchanged
    expect(it.taxes).toEqual([{ type: 'IVA', factor: 'Tasa', rate: 0.16, withholding: false }])
    expect(it.objetoImp).toBe('02')
    expect(it.taxIncluded).toBe(false) // no flag → NET
  })

  it('carries taxIncluded:true through for IVA-included (gross) sales', () => {
    const p = buildCreateInvoiceParams({
      ...baseInput,
      items: [{ ...baseInput.items[0], taxIncluded: true }],
    })
    expect(p.items[0].taxIncluded).toBe(true)
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

describe('buildGlobalInvoiceParams', () => {
  const emisor = { lugarExpedicion: '83000', serie: null }
  const period = { facturaPeriodicity: 'month', meses: '05', anio: 2026 } as any

  it('gross order (priceIncludesIva) → sends the IVA-included total with tax_included so the stamp == paid', () => {
    const lines: GlobalInvoiceLine[] = [
      { orderId: 'o1', subtotalCents: 10000, taxCents: 1600, totalCents: 11600, formaPago: '01', priceIncludesIva: true },
    ]
    const params = buildGlobalInvoiceParams(emisor, lines, period)
    const item = params.items[0]
    expect(item.unitPriceCents).toBe(11600) // gross total — what the customer paid
    expect(item.taxIncluded).toBe(true)
    expect(item.satProductKey).toBe('01010101')
  })

  it('net order (separated tax) → sends the base with tax_included:false (unchanged legacy behaviour)', () => {
    const lines: GlobalInvoiceLine[] = [
      { orderId: 'o1', subtotalCents: 10000, taxCents: 1600, totalCents: 11600, formaPago: '01', priceIncludesIva: false },
    ]
    const params = buildGlobalInvoiceParams(emisor, lines, period)
    const item = params.items[0]
    expect(item.unitPriceCents).toBe(10000) // NET base — PAC adds IVA → 11600
    expect(item.taxIncluded).toBe(false)
  })

  it('uses the line REAL rate, not a hard-coded 16% (8% frontera)', () => {
    const lines: GlobalInvoiceLine[] = [
      {
        orderId: 'o1',
        subtotalCents: 10000,
        taxCents: 800,
        totalCents: 10800,
        formaPago: '01',
        priceIncludesIva: true,
        taxRate: 0.08,
        objetoImp: '02',
      },
    ]
    const item = buildGlobalInvoiceParams(emisor, lines, period).items[0]
    expect(item.objetoImp).toBe('02')
    expect(item.taxes).toEqual([{ type: 'IVA', factor: 'Tasa', rate: 0.08, withholding: false }])
  })

  it('exento group → objetoImp 01 and NO traslado (never invents 16% IVA on exempt sales)', () => {
    const lines: GlobalInvoiceLine[] = [
      {
        orderId: 'o1',
        subtotalCents: 10000,
        taxCents: 0,
        totalCents: 10000,
        formaPago: '01',
        priceIncludesIva: true,
        taxRate: 0,
        objetoImp: '01',
      },
    ]
    const item = buildGlobalInvoiceParams(emisor, lines, period).items[0]
    expect(item.objetoImp).toBe('01')
    expect(item.taxes).toEqual([])
  })
})

describe('groupOrderIntoGlobalLines (derive real IVA per product, not assumed 16%)', () => {
  const meta = { orderId: 'o1', orderNumber: '42', formaPago: '01', priceIncludesIva: true }

  it('uniform 16% order → ONE 16% line, total stays == paid', () => {
    const items: GlobalLineItemInput[] = [
      { grossCents: 11600, taxRate: 0.16, objetoImp: '02' },
      { grossCents: 5800, taxRate: 0.16, objetoImp: '02' },
    ]
    const lines = groupOrderIntoGlobalLines(items, meta)
    expect(lines).toHaveLength(1)
    expect(lines[0].totalCents).toBe(17400) // 11600 + 5800 = exactly what was paid
    expect(lines[0].subtotalCents + lines[0].taxCents).toBe(17400)
    expect(lines[0].taxRate).toBe(0.16)
  })

  it('mixed cart (16% + exento) → TWO lines, each with its own rate; exento carries no IVA', () => {
    const items: GlobalLineItemInput[] = [
      { grossCents: 11600, taxRate: 0.16, objetoImp: '02' },
      { grossCents: 10000, taxRate: 0, objetoImp: '01' },
    ]
    const lines = groupOrderIntoGlobalLines(items, meta)
    expect(lines).toHaveLength(2)
    const taxable = lines.find(l => l.taxRate === 0.16)!
    const exempt = lines.find(l => l.taxRate === 0)!
    expect(taxable.taxCents).toBe(1600)
    expect(exempt.taxCents).toBe(0)
    expect(exempt.objetoImp).toBe('01')
    // grand total across lines == what the customer paid
    expect(lines.reduce((s, l) => s + l.totalCents, 0)).toBe(21600)
  })

  it('fully exempt order → ONE exento line, zero IVA (not 16%)', () => {
    const lines = groupOrderIntoGlobalLines([{ grossCents: 10000, taxRate: 0, objetoImp: '01' }], meta)
    expect(lines).toHaveLength(1)
    expect(lines[0].taxCents).toBe(0)
    expect(lines[0].objetoImp).toBe('01')
    expect(lines[0].totalCents).toBe(10000)
  })
})
