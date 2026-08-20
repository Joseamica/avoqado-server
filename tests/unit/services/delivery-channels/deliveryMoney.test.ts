import { assertDeliveryMoneyInvariants, DeliveryMoneyMismatchError } from '@/services/delivery-channels/core/money'

const base = {
  currency: 'MXN' as const,
  saleAmount: '100.00',
  merchantFees: '20.00',
  tipAmount: '15.00',
  externallyPaidSale: '120.00',
  externallyPaidTip: '15.00',
  cashDueSale: '0.00',
  cashDueTip: '0.00',
}

describe('delivery money invariants', () => {
  it('acepta un reparto que cuadra al centavo', () => {
    expect(() => assertDeliveryMoneyInvariants(base)).not.toThrow()
  })

  it('acepta el reparto mixto: parte en plataforma, parte en efectivo', () => {
    expect(() => assertDeliveryMoneyInvariants({ ...base, externallyPaidSale: '70.00', cashDueSale: '50.00' })).not.toThrow()
  })

  it('🔴 RECHAZA si la venta no cuadra — jamás estima', () => {
    expect(() => assertDeliveryMoneyInvariants({ ...base, cashDueSale: '0.01' })).toThrow(DeliveryMoneyMismatchError)
  })

  it('🔴 RECHAZA si la propina no cuadra', () => {
    expect(() => assertDeliveryMoneyInvariants({ ...base, externallyPaidTip: '14.99' })).toThrow(DeliveryMoneyMismatchError)
  })

  it('🔴 RECHAZA cualquier monto negativo', () => {
    expect(() => assertDeliveryMoneyInvariants({ ...base, tipAmount: '-1.00' })).toThrow(DeliveryMoneyMismatchError)
  })

  it('🔴 RECHAZA moneda distinta de MXN', () => {
    expect(() => assertDeliveryMoneyInvariants({ ...base, currency: 'USD' as never })).toThrow(DeliveryMoneyMismatchError)
  })

  it('el mensaje del error dice qué lado no cuadró, con los dos montos', () => {
    try {
      assertDeliveryMoneyInvariants({ ...base, cashDueSale: '5.00' })
      throw new Error('debió lanzar')
    } catch (e) {
      expect((e as Error).message).toMatch(/120\.00/)
      expect((e as Error).message).toMatch(/125\.00/)
    }
  })
})
