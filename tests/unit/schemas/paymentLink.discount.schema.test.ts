import { createPaymentLinkBodySchema, updatePaymentLinkBodySchema } from '@/schemas/dashboard/paymentLink.schema'

const base = { title: 'Liga', amountType: 'FIXED' as const, amount: 1000 }
const cuid = 'cjld2cjxh0000qzrmn831i7rn'

describe('paymentLink discount schema', () => {
  it('acepta MANUAL 15 %', () => {
    const r = createPaymentLinkBodySchema.safeParse({ ...base, discount: { mode: 'MANUAL', type: 'PERCENTAGE', value: 15 } })
    expect(r.success).toBe(true)
  })

  it('acepta MANUAL $150 con name', () => {
    const r = createPaymentLinkBodySchema.safeParse({
      ...base,
      discount: { mode: 'MANUAL', type: 'FIXED_AMOUNT', value: 150, name: 'Amigos' },
    })
    expect(r.success).toBe(true)
    if (r.success) expect((r.data.discount as any).name).toBe('Amigos')
  })

  it('name por default «Descuento»', () => {
    const r = createPaymentLinkBodySchema.parse({ ...base, discount: { mode: 'MANUAL', type: 'PERCENTAGE', value: 10 } })
    expect((r.discount as any).name).toBe('Descuento')
  })

  it('rechaza PERCENTAGE 0 y 100', () => {
    for (const value of [0, 100]) {
      expect(createPaymentLinkBodySchema.safeParse({ ...base, discount: { mode: 'MANUAL', type: 'PERCENTAGE', value } }).success).toBe(
        false,
      )
    }
  })

  it('rechaza FIXED_AMOUNT <= 0 y más de 2 decimales', () => {
    for (const value of [0, -5, 10.123]) {
      expect(createPaymentLinkBodySchema.safeParse({ ...base, discount: { mode: 'MANUAL', type: 'FIXED_AMOUNT', value } }).success).toBe(
        false,
      )
    }
  })

  it('rechaza name vacío o de más de 60 caracteres', () => {
    for (const name of ['', 'x'.repeat(61)]) {
      expect(
        createPaymentLinkBodySchema.safeParse({ ...base, discount: { mode: 'MANUAL', type: 'FIXED_AMOUNT', value: 5, name } }).success,
      ).toBe(false)
    }
  })

  it('acepta CATALOG con cuid y rechaza si no es cuid', () => {
    expect(createPaymentLinkBodySchema.safeParse({ ...base, discount: { mode: 'CATALOG', discountId: cuid } }).success).toBe(true)
    expect(createPaymentLinkBodySchema.safeParse({ ...base, discount: { mode: 'CATALOG', discountId: 'no-es-cuid' } }).success).toBe(false)
  })

  it('null quita el descuento y ausente = sin cambio (update)', () => {
    const quitar = updatePaymentLinkBodySchema.parse({ discount: null })
    expect(quitar.discount).toBeNull()
    const sinCambio = updatePaymentLinkBodySchema.parse({ title: 'x' })
    expect('discount' in sinCambio).toBe(false)
    expect(createPaymentLinkBodySchema.parse(base).discount).toBeUndefined()
  })
})
