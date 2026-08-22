import { assertDeliveryMoneyInvariants, DeliveryMoneyMismatchError } from '@/services/delivery-channels/core/money'
import type { NormalizedDeliveryItem } from '@/services/delivery-channels/core/types'

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

// Renglones que cuadran contra `base.saleAmount` (100.00). HALLAZGO 2 (auditoría externa,
// 2026-08-20) exige que `assertDeliveryMoneyInvariants` reciba también los items para poder
// compararlos contra la venta declarada — antes sólo recibía `payment`.
const baseItems: NormalizedDeliveryItem[] = [
  { externalId: 'X', name: 'Item', quantity: 1, unitPrice: '100.00', total: '100.00', modifiers: [] },
]

describe('delivery money invariants', () => {
  it('acepta un reparto que cuadra al centavo', () => {
    expect(() => assertDeliveryMoneyInvariants(base, baseItems)).not.toThrow()
  })

  it('acepta el reparto mixto: parte en plataforma, parte en efectivo', () => {
    expect(() => assertDeliveryMoneyInvariants({ ...base, externallyPaidSale: '70.00', cashDueSale: '50.00' }, baseItems)).not.toThrow()
  })

  it('🔴 RECHAZA si la venta no cuadra — jamás estima', () => {
    expect(() => assertDeliveryMoneyInvariants({ ...base, cashDueSale: '0.01' }, baseItems)).toThrow(DeliveryMoneyMismatchError)
  })

  it('🔴 RECHAZA si la propina no cuadra', () => {
    expect(() => assertDeliveryMoneyInvariants({ ...base, externallyPaidTip: '14.99' }, baseItems)).toThrow(DeliveryMoneyMismatchError)
  })

  it('🔴 RECHAZA cualquier monto negativo', () => {
    expect(() => assertDeliveryMoneyInvariants({ ...base, tipAmount: '-1.00' }, baseItems)).toThrow(DeliveryMoneyMismatchError)
  })

  it('🔴 RECHAZA moneda distinta de MXN', () => {
    expect(() => assertDeliveryMoneyInvariants({ ...base, currency: 'USD' as never }, baseItems)).toThrow(DeliveryMoneyMismatchError)
  })

  it('el mensaje del error dice qué lado no cuadró, con los dos montos', () => {
    try {
      assertDeliveryMoneyInvariants({ ...base, cashDueSale: '5.00' }, baseItems)
      throw new Error('debió lanzar')
    } catch (e) {
      expect((e as Error).message).toMatch(/120\.00/)
      expect((e as Error).message).toMatch(/125\.00/)
    }
  })

  // ============================================================
  // HALLAZGO 2 (auditoría externa, 2026-08-20): las verificaciones de arriba sólo prueban que
  // el reparto (externallyPaid* + cashDue*) cuadra CONSIGO MISMO — nunca contra los renglones
  // reales. Un pedido con saleAmount de $90 y renglones que suman $110 pasaba sin queja: el
  // ticket, los reportes y el pago dirían cosas distintas.
  // ============================================================
  describe('renglones vs. venta declarada (Hallazgo 2)', () => {
    it('🔴 RECHAZA cuando los items NO cuadran contra saleAmount — $90 declarado con $110 en líneas', () => {
      const items: NormalizedDeliveryItem[] = [
        { externalId: 'A', name: 'Item caro', quantity: 1, unitPrice: '110.00', total: '110.00', modifiers: [] },
      ]
      expect(() =>
        assertDeliveryMoneyInvariants({ ...base, saleAmount: '90.00', merchantFees: '0.00', externallyPaidSale: '90.00' }, items),
      ).toThrow(DeliveryMoneyMismatchError)
    })

    it('el mensaje dice cuánto suman los items y cuánto declara saleAmount', () => {
      const items: NormalizedDeliveryItem[] = [
        { externalId: 'A', name: 'Item caro', quantity: 1, unitPrice: '110.00', total: '110.00', modifiers: [] },
      ]
      try {
        assertDeliveryMoneyInvariants({ ...base, saleAmount: '90.00', merchantFees: '0.00', externallyPaidSale: '90.00' }, items)
        throw new Error('debió lanzar')
      } catch (e) {
        expect((e as Error).message).toMatch(/110\.00/)
        expect((e as Error).message).toMatch(/90\.00/)
      }
    })

    it('acepta cuando la suma de VARIOS items cuadra al centavo contra saleAmount', () => {
      const items: NormalizedDeliveryItem[] = [
        { externalId: 'A', name: 'Item 1', quantity: 1, unitPrice: '60.00', total: '60.00', modifiers: [] },
        { externalId: 'B', name: 'Item 2', quantity: 1, unitPrice: '40.00', total: '40.00', modifiers: [] },
      ]
      expect(() => assertDeliveryMoneyInvariants(base, items)).not.toThrow()
    })

    it('🔴 tolerancia CERO: un centavo de diferencia también rechaza', () => {
      const items: NormalizedDeliveryItem[] = [
        { externalId: 'A', name: 'Item', quantity: 1, unitPrice: '100.01', total: '100.01', modifiers: [] },
      ]
      expect(() => assertDeliveryMoneyInvariants(base, items)).toThrow(DeliveryMoneyMismatchError)
    })

    it('🔴 RECHAZA si el total de un item no es un decimal válido', () => {
      const items: NormalizedDeliveryItem[] = [
        { externalId: 'A', name: 'Item', quantity: 1, unitPrice: '100.00', total: 'no-es-numero', modifiers: [] },
      ]
      expect(() => assertDeliveryMoneyInvariants(base, items)).toThrow(DeliveryMoneyMismatchError)
    })

    it('sin items (lista vacía) y saleAmount en cero: no hay nada que comparar, no rechaza', () => {
      expect(() =>
        assertDeliveryMoneyInvariants({ ...base, saleAmount: '0.00', merchantFees: '0.00', externallyPaidSale: '0.00' }, []),
      ).not.toThrow()
    })
  })
})
