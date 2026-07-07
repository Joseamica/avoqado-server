import { manualSaleRowSchema } from '@/schemas/dashboard/manualSale.schema'

describe('manualSaleRowSchema', () => {
  it('accepts a valid row', () => {
    const r = {
      iccid: '8952140063677014972F',
      promoterCode: 'BSCLOXH0405',
      storeName: 'BAE MUÑOZ SLP (898)',
      saleDate: '2026-06-24',
      saleType: 'Línea nueva',
      paymentForm: 'No aplica',
      amount: 'No aplica',
      simType: 'SIM de intercambio',
    }
    expect(manualSaleRowSchema.parse(r).iccid).toBe('8952140063677014972F')
  })

  it('rejects an empty iccid with a Spanish message', () => {
    expect(() =>
      manualSaleRowSchema.parse({
        iccid: '',
        storeName: 'X',
        saleDate: '2026-06-24',
        saleType: 'Línea nueva',
        paymentForm: 'No aplica',
        amount: '0',
      }),
    ).toThrow(/ICCID/i)
  })
})
