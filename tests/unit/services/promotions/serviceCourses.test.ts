import { prismaMock } from '../../../__helpers__/setup'
import { applyPromotionToOrder } from '@/services/promotions/promotion.service'
import { DEFAULT_SERVICE_COURSES } from '@/services/service-courses/serviceCourseContract'

const immediate = { ...DEFAULT_SERVICE_COURSES[0], label: 'Al momento' }
const later = { id: 'old-desserts', label: 'Con el postre', kind: 'STANDARD' as const }
const option = (id: string) => ({
  id,
  productId: 'coffee',
  quantity: 1,
  chargedQuantity: 1,
  priceDeltaCents: 0,
  product: { price: 80, venueId: 'venue', name: 'Café', sku: null, category: null },
})
const params = (withCourses = true) => ({
  venueId: 'venue',
  orderId: 'order',
  promotionId: 'promo',
  instanceId: 'sale-id',
  soldAt: new Date('2026-10-07T12:00:00Z'),
  selections: [
    { groupId: 'g1', optionId: 'o1', ...(withCourses ? { serviceCourse: immediate } : {}) },
    { groupId: 'g2', optionId: 'o2', ...(withCourses ? { serviceCourse: later } : {}) },
  ],
})

describe('combo components retain historical service courses without changing price', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
    prismaMock.$queryRaw.mockResolvedValue([{ id: 'order' }])
    prismaMock.orderPromotion.findUnique.mockResolvedValue(null)
    prismaMock.orderPromotion.create.mockResolvedValue({ id: 'instance' })
    prismaMock.order.findFirst.mockResolvedValue({ status: 'CONFIRMED', paymentStatus: 'PENDING', discountAmount: 0, paidAmount: 0 })
    prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
    prismaMock.promotion.findFirst.mockResolvedValue({
      id: 'promo',
      venueId: 'venue',
      name: 'Dos cafés',
      type: 'BUNDLE',
      status: 'PUBLISHED',
      pricingMode: 'FIXED_TOTAL',
      priceCents: 9900,
      daysOfWeek: [],
      timeFrom: null,
      timeUntil: null,
      validFrom: null,
      validUntil: null,
      groups: [
        { id: 'g1', name: 'Ahora', options: [option('o1')] },
        { id: 'g2', name: 'Después', options: [option('o2')] },
      ],
    })
    prismaMock.orderItem.findMany.mockResolvedValue([])
    prismaMock.orderDiscount.findMany.mockResolvedValue([])
    prismaMock.orderServiceCharge.findMany.mockResolvedValue([])
    prismaMock.order.update.mockResolvedValue({})
  })
  it('distinguishes groups with the same product and preserves renamed immediate semantics', async () => {
    await applyPromotionToOrder(params())
    const lines = prismaMock.orderItem.createMany.mock.calls[0][0].data
    expect(lines.map((line: any) => [line.productId, line.course, line.serviceCourse])).toEqual([
      ['coffee', null, immediate],
      ['coffee', 'Con el postre', later],
    ])
    expect(lines.every((line: any) => line.orderPromotionId === 'instance')).toBe(true)
  })
  it('assigns distinct component keys beneath the table-round wrapper before kitchen planning', async () => {
    await applyPromotionToOrder(params(), prismaMock as any, {
      deferTotalsToCaller: true,
      sentToKitchenAt: new Date('2026-10-07T12:00:00Z'),
      componentExternalIdPrefix: 'sync:round-1:0',
    })
    const lines = prismaMock.orderItem.createMany.mock.calls[0][0].data
    expect(lines.map((line: any) => line.externalId)).toEqual(['sync:round-1:0:g:g1', 'sync:round-1:0:g:g2'])
    expect(lines.every((line: any) => line.sentToKitchenAt.toISOString() === '2026-10-07T12:00:00.000Z')).toBe(true)
  })
  // hz:ce654971:D4 (Codex r1 #1): la marca de cocina de una ronda de combos sin red persiste JUNTO con el combo.
  it('marcarCocina: writes the kitchen marker inside the SAME transaction that stores the combo; without it, never', async () => {
    prismaMock.order.updateMany.mockResolvedValue({ count: 1 })
    // La mesa se lee BAJO el candado de la cuenta (Codex r2 #2): otra caja pudo asignarla después de que la cola la leyó.
    prismaMock.order.findFirst.mockResolvedValue({
      status: 'CONFIRMED',
      paymentStatus: 'PENDING',
      discountAmount: 0,
      paidAmount: 0,
      tableId: 'mesa-1',
    })
    await applyPromotionToOrder(params(), prismaMock as any, {
      deferTotalsToCaller: true,
      sentToKitchenAt: new Date('2026-10-07T12:00:00Z'),
      marcarCocina: true,
    })
    expect(prismaMock.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order', venueId: 'venue' },
      data: { kitchenPendingAt: expect.any(Date) },
    })
    expect(prismaMock.order.updateMany.mock.invocationCallOrder[0]).toBeGreaterThan(
      prismaMock.orderItem.createMany.mock.invocationCallOrder[0],
    )

    prismaMock.order.updateMany.mockClear()
    await applyPromotionToOrder({ ...params(), instanceId: 'otra' }, prismaMock as any, { deferTotalsToCaller: true })
    expect(prismaMock.order.updateMany).not.toHaveBeenCalled()
  })

  it('marcarCocina on a counter order (no table): no marker, the counter ticket is born at payment', async () => {
    await applyPromotionToOrder(params(), prismaMock as any, { deferTotalsToCaller: true, marcarCocina: true })
    expect(prismaMock.orderItem.createMany).toHaveBeenCalled()
    expect(prismaMock.order.updateMany).not.toHaveBeenCalled()
  })

  it('marcarCocina on a replay (combo already applied): nothing new to cook, no marker write', async () => {
    prismaMock.orderPromotion.findUnique.mockResolvedValue({ id: 'instance', netCents: 9900 })
    const r = await applyPromotionToOrder(params(), prismaMock as any, { deferTotalsToCaller: true, marcarCocina: true })
    expect(r.created).toBe(false)
    expect(prismaMock.order.updateMany).not.toHaveBeenCalled()
  })

  it('adds group/option identity and the operator choice to the sale snapshot', async () => {
    await applyPromotionToOrder(params())
    expect(prismaMock.orderPromotion.create.mock.calls[0][0].data.snapshotJson.selections).toEqual([
      expect.objectContaining({ groupId: 'g1', optionId: 'o1', serviceCourse: immediate }),
      expect.objectContaining({ groupId: 'g2', optionId: 'o2', serviceCourse: later }),
    ])
  })
  it('legacy and new payloads produce exactly the same money and quantities', async () => {
    const legacy = await applyPromotionToOrder(params(false))
    const money = prismaMock.orderItem.createMany.mock.calls[0][0].data.map(
      ({ productId, quantity, unitPrice, discountAmount, total, taxAmount }: any) => ({
        productId,
        quantity,
        unitPrice,
        discountAmount,
        total,
        taxAmount,
      }),
    )
    prismaMock.orderItem.createMany.mockClear()
    const modern = await applyPromotionToOrder(params())
    expect(modern.netCents).toBe(legacy.netCents)
    expect(
      prismaMock.orderItem.createMany.mock.calls[0][0].data.map(
        ({ productId, quantity, unitPrice, discountAmount, total, taxAmount }: any) => ({
          productId,
          quantity,
          unitPrice,
          discountAmount,
          total,
          taxAmount,
        }),
      ),
    ).toEqual(money)
  })
  it('replay does not re-resolve choices against the current catalog or duplicate a combo', async () => {
    prismaMock.orderPromotion.findUnique.mockResolvedValue({ id: 'previous', netCents: 9900 })
    expect(await applyPromotionToOrder(params())).toMatchObject({ created: false, orderPromotionId: 'previous' })
    expect(prismaMock.orderItem.createMany).not.toHaveBeenCalled()
    expect(prismaMock.venueSettings.findUnique).not.toHaveBeenCalled()
  })
  it('rejects malformed service metadata before creating any sale rows', async () => {
    const input = params()
    input.selections[1].serviceCourse = { ...later, label: ' ' }
    await expect(applyPromotionToOrder(input)).rejects.toMatchObject({ statusCode: 400 })
    expect(prismaMock.orderPromotion.create).not.toHaveBeenCalled()
    expect(prismaMock.orderItem.createMany).not.toHaveBeenCalled()
  })
})
