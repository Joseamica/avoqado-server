import { calculateDiscountAmount } from '@/services/dashboard/discountEngine.service'

const descuento = (over: Record<string, any> = {}) =>
  ({
    id: 'd1',
    name: '20% automático',
    type: 'PERCENTAGE',
    value: 20,
    scope: 'ORDER',
    targetItemIds: [],
    targetCategoryIds: [],
    targetModifierIds: [],
    targetModifierGroupIds: [],
    customerGroupId: null,
    isAutomatic: true,
    priority: 0,
    minPurchaseAmount: null,
    maxDiscountAmount: null,
    minQuantity: null,
    buyQuantity: null,
    getQuantity: null,
    getDiscountPercent: null,
    buyItemIds: [],
    getItemIds: [],
    validFrom: null,
    validUntil: null,
    daysOfWeek: [],
    timeFrom: null,
    timeUntil: null,
    maxTotalUses: null,
    maxUsesPerCustomer: null,
    currentUses: 0,
    isStackable: false,
    stackPriority: 0,
    requiresApproval: false,
    applyBeforeTax: true,
    ...over,
  }) as any

const contexto = (items: any[]) => ({
  orderId: 'order-1',
  venueId: 'venue-1',
  subtotal: items.reduce((s, i) => s + i.total, 0),
  items,
  appliedDiscounts: [],
})

describe('los descuentos automáticos no alcanzan las líneas de promoción', () => {
  it('🔴 un 20% de orden se calcula SOLO sobre lo que no es promoción', () => {
    // El bug que evita: artículo normal $100 + combo $99 → el 20% subía de $20
    // a $39.80 y alcanzaba la promoción por la puerta de atrás.
    const result = calculateDiscountAmount(
      descuento(),
      contexto([
        { id: 'i1', productId: 'p1', categoryId: 'c1', quantity: 1, unitPrice: 100, total: 100, modifiers: [], orderPromotionId: null },
        { id: 'i2', productId: 'p2', categoryId: 'c1', quantity: 1, unitPrice: 99, total: 99, modifiers: [], orderPromotionId: 'op-1' },
      ]),
    )

    expect(result.amount).toBe(20)
  })

  it('sin líneas de promoción el cálculo no cambia', () => {
    const result = calculateDiscountAmount(
      descuento(),
      contexto([
        { id: 'i1', productId: 'p1', categoryId: 'c1', quantity: 1, unitPrice: 100, total: 100, modifiers: [], orderPromotionId: null },
      ]),
    )

    expect(result.amount).toBe(20)
  })

  it('una cuenta que es SÓLO promoción no recibe descuento automático', () => {
    const result = calculateDiscountAmount(
      descuento(),
      contexto([
        { id: 'i1', productId: 'p1', categoryId: 'c1', quantity: 1, unitPrice: 99, total: 99, modifiers: [], orderPromotionId: 'op-1' },
      ]),
    )

    expect(result.amount).toBe(0)
  })

  it('un descuento por ARTÍCULO tampoco toca una línea de promoción', () => {
    const result = calculateDiscountAmount(
      descuento({ scope: 'ITEM', targetItemIds: ['p2'] }),
      contexto([
        { id: 'i2', productId: 'p2', categoryId: 'c1', quantity: 1, unitPrice: 99, total: 99, modifiers: [], orderPromotionId: 'op-1' },
      ]),
    )

    expect(result.amount).toBe(0)
  })
})
