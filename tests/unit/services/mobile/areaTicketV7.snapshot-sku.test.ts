import { buildSnapshotLines, canonicalSnapshotHash } from '@/services/mobile/areaTicketV7.mobile.service'

const itemsData = [
  {
    productId: 'p-latte',
    productName: 'Latte',
    productSku: 'P000500',
    categoryName: 'Bebidas',
    quantity: 2,
    unitPrice: 55,
    weightQuantity: null,
    discountAmount: 0,
    appliedDiscountId: null,
    taxAmount: 0,
    total: 140,
    notes: null,
    modifiers: {
      create: [
        { modifierId: 'm-shot', name: 'Shot de espresso', quantity: 1, price: 15 },
        { modifierId: 'm-sin', name: 'Sin azúcar', quantity: 1, price: 0 },
      ],
    },
  },
]
const inputs = [{ clientLineId: 'l1', productId: 'p-latte', quantity: '2', modifierIds: ['m-shot', 'm-sin'] }]

describe('Snapshot del vale: SKU de cada extra', () => {
  it('congela el SKU de cada extra; el que no tiene queda null', () => {
    const [line] = buildSnapshotLines(inputs as any, itemsData, { 'm-shot': 'P000672', 'm-sin': null })
    expect(line.modifiersSnapshot).toEqual([
      { modifierId: 'm-shot', name: 'Shot de espresso', quantity: 1, price: '15.00', sku: 'P000672' },
      { modifierId: 'm-sin', name: 'Sin azúcar', quantity: 1, price: '0.00', sku: null },
    ])
  })

  it('el SKU no entra al hash: los vales ya emitidos no cambian de huella', () => {
    const conSku = buildSnapshotLines(inputs as any, itemsData, { 'm-shot': 'P000672' })
    const sinSku = buildSnapshotLines(inputs as any, itemsData, {})
    expect(canonicalSnapshotHash('MXN', conSku)).toBe(canonicalSnapshotHash('MXN', sinSku))
  })
})
