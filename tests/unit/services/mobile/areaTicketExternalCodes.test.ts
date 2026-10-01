import { externalRouteBlockers } from '@/services/mobile/areaTicketExternalCodes'

const line = (overrides: Record<string, unknown> = {}) => ({
  productNameSnapshot: 'Latte',
  skuSnapshot: 'P000500',
  weightKg: null,
  discountAmount: '0.00',
  modifiersSnapshot: [] as Array<{ name: string; price: string; sku?: string | null }>,
  ...overrides,
})

describe('Caja externa: qué impide emitir el vale', () => {
  it('un vale con SKU en todo no tiene bloqueos', () => {
    expect(externalRouteBlockers([line({ modifiersSnapshot: [{ name: 'Shot de espresso', price: '15.00', sku: 'P000672' }] })])).toEqual({
      missingCodes: [],
      weighted: [],
      discounted: [],
    })
  })

  it('un extra CON precio y sin SKU bloquea; uno de $0 sin SKU no', () => {
    const result = externalRouteBlockers([
      line({
        modifiersSnapshot: [
          { name: 'Leche de almendra', price: '10.00', sku: null },
          { name: 'Sin azúcar', price: '0.00' },
        ],
      }),
    ])
    expect(result.missingCodes).toEqual(['Leche de almendra (extra)'])
  })

  it('un SKU de producto vacío o en blanco bloquea', () => {
    expect(externalRouteBlockers([line({ skuSnapshot: '  ' })]).missingCodes).toEqual(['Latte'])
  })

  it('por peso y con descuento bloquean, sin repetir nombres', () => {
    const result = externalRouteBlockers([
      line({ productNameSnapshot: 'Jamón', weightKg: '0.250' }),
      line({ productNameSnapshot: 'Jamón', weightKg: '0.300' }),
      line({ productNameSnapshot: 'Pan', discountAmount: '5.00' }),
    ])
    expect(result.weighted).toEqual(['Jamón'])
    expect(result.discounted).toEqual(['Pan'])
  })
})
