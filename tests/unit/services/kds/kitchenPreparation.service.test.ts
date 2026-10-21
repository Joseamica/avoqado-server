import { prismaMock } from '../../../__helpers__/setup'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { applyKitchenPreparation, listKitchenPreparation, preparationCapabilities } from '@/services/kds/kitchenPreparation.service'
import { initialPreparation } from '@/services/kds/kitchenPreparation'

jest.mock('@/services/access/basePlan.service', () => ({ venueHasFeatureAccess: jest.fn() }))
const line = {
  id: 'line-a',
  kdsOrderId: 'ticket-a',
  orderItemId: 'item-a',
  externalLineId: 'sync:round-a:0',
  quantity: 2,
  preparation: initialPreparation(2, 'STANDARD'),
  preparationRevision: 0,
  kdsOrder: { id: 'ticket-a', venueId: 'venue-a', orderId: 'order-a', printStationId: 'station-a', preparationVersion: 1 },
}
const input = { action: 'RELEASE', items: [{ id: 'line-a', expectedRevision: 0, quantity: 1 }] }
const preparationIntent = { updateMany: jest.fn() }

describe('persisted kitchen preparation', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    Object.assign(prismaMock, { posSyncIntent: preparationIntent })
    ;(venueHasFeatureAccess as jest.Mock).mockResolvedValue(true)
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
    prismaMock.$queryRaw.mockResolvedValue([{ id: 'venue-a' }])
    prismaMock.order.findFirst.mockResolvedValue({ id: 'order-a', status: 'PENDING' })
    prismaMock.kdsOrderItem.findMany.mockResolvedValue([line])
    prismaMock.kdsOrderItem.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.kdsOrder.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.activityLog.create.mockResolvedValue({ id: 'audit-a' })
    prismaMock.kdsOrderItem.groupBy.mockResolvedValue([{ orderItemId: 'item-a', _count: { _all: 2 } }])
    prismaMock.kdsOrderItem.count.mockResolvedValue(0)
  })
  it('updates selected quantities using a revision CAS and audits the actor in the same transaction', async () => {
    const result = await applyKitchenPreparation('venue-a', 'order-a', input, 'staff-a')
    expect(result.items[0]).toMatchObject({ id: 'line-a', preparationRevision: 1, preparation: { HELD: 1, PENDING: 1 } })
    expect(prismaMock.kdsOrderItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'line-a', preparationRevision: 0, kdsOrder: { venueId: 'venue-a', orderId: 'order-a' } }),
      }),
    )
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ venueId: 'venue-a', staffId: 'staff-a', action: 'KITCHEN_RELEASE' }) }),
    )
  })
  it('checks Pro before entering a mutation transaction', async () => {
    ;(venueHasFeatureAccess as jest.Mock).mockResolvedValue(false)
    await expect(applyKitchenPreparation('venue-a', 'order-a', input, 'staff-a')).rejects.toMatchObject({ statusCode: 403 })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })
  it('retains an unresolved provisional account before entering a mutation transaction', async () => {
    const provisional = {
      action: 'START',
      items: [{ externalId: 'sync:round-a:0', sourceKey: 'round:round-a:station-a', expectedRevision: 0, quantity: 1 }],
    }
    await expect(applyKitchenPreparation('venue-a', '', provisional, 'staff-a', 'intent-a')).rejects.toMatchObject({
      code: 'PREPARATION_DEPENDENCY_PENDING',
    })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })
  it('does not defer missing canonical accounts or invalid payloads', async () => {
    prismaMock.order.findFirst.mockResolvedValue(null)
    await expect(applyKitchenPreparation('venue-a', '', input, 'staff-a', 'intent-a')).rejects.toMatchObject({ statusCode: 404 })
    await expect(applyKitchenPreparation('venue-a', '', { ...input, action: 'INVALID' }, 'staff-a', 'intent-a')).rejects.toMatchObject({
      code: 'PREPARATION_PAYLOAD_INVALID',
    })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })
  it('checks Pro even when the provisional account is not authored yet', async () => {
    ;(venueHasFeatureAccess as jest.Mock).mockResolvedValue(false)
    await expect(
      applyKitchenPreparation(
        'venue-a',
        '',
        {
          action: 'START',
          items: [{ externalId: 'sync:round-a:0', sourceKey: 'round:round-a:station-a', expectedRevision: 0, quantity: 1 }],
        },
        'staff-a',
        'intent-a',
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: 'FEATURE_ACCESS_REQUIRED' })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })
  it('advertises independent replay explicitly while retaining the Pro capability gate', async () => {
    await expect(preparationCapabilities('venue-a')).resolves.toMatchObject({
      version: 1,
      replayLaneVersion: 1,
      enabled: true,
      maxItems: 100,
    })
    ;(venueHasFeatureAccess as jest.Mock).mockResolvedValue(false)
    await expect(preparationCapabilities('venue-a')).resolves.toMatchObject({
      version: 1,
      replayLaneVersion: 1,
      enabled: false,
    })
  })
  it('rejects obsolete revision, missing lines and wrong tenant before writing anything', async () => {
    await expect(
      applyKitchenPreparation('venue-a', 'order-a', { ...input, items: [{ ...input.items[0], expectedRevision: 2 }] }, 'staff-a'),
    ).rejects.toMatchObject({ code: 'PREPARATION_CONFLICT' })
    prismaMock.kdsOrderItem.findMany.mockResolvedValue([])
    await expect(applyKitchenPreparation('venue-a', 'order-a', input, 'staff-a')).rejects.toMatchObject({
      code: 'PREPARATION_ITEMS_CHANGED',
    })
    expect(prismaMock.kdsOrderItem.updateMany).not.toHaveBeenCalled()
  })
  it('a failed CAS throws so the whole transaction rolls back', async () => {
    prismaMock.kdsOrderItem.updateMany.mockResolvedValue({ count: 0 })
    await expect(applyKitchenPreparation('venue-a', 'order-a', input, 'staff-a')).rejects.toMatchObject({ code: 'PREPARATION_CONFLICT' })
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })
  it('keeps an offline action pending while its earlier product revision has not arrived', async () => {
    await expect(
      applyKitchenPreparation(
        'venue-a',
        'order-a',
        {
          ...input,
          items: [{ ...input.items[0], expectedRevision: 2 }],
        },
        'staff-a',
        'intent-a',
      ),
    ).rejects.toMatchObject({ code: 'PREPARATION_REVISION_PENDING' })
    expect(prismaMock.kdsOrderItem.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })
  it('keeps a provisional offline product pending until its kitchen ticket is authored', async () => {
    prismaMock.kdsOrderItem.findMany.mockResolvedValue([])
    await expect(
      applyKitchenPreparation(
        'venue-a',
        'order-a',
        {
          action: 'RELEASE',
          items: [
            {
              externalId: 'sync:round-a:0',
              sourceKey: 'round:round-a:station-a',
              stationId: 'station-a',
              expectedRevision: 0,
              quantity: 1,
            },
          ],
        },
        'staff-a',
        'intent-a',
      ),
    ).rejects.toMatchObject({ code: 'PREPARATION_DEPENDENCY_PENDING' })
    expect(prismaMock.kdsOrderItem.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })
  it('keeps provisional preparation pending before its account arrives, without weakening canonical tenant checks', async () => {
    prismaMock.order.findFirst.mockResolvedValue(null)
    await expect(
      applyKitchenPreparation(
        'venue-a',
        'local-order-a',
        {
          action: 'START',
          items: [
            {
              externalId: 'sync:round-a:0',
              sourceKey: 'round:round-a:station-a',
              stationId: 'station-a',
              expectedRevision: 0,
              quantity: 1,
            },
          ],
        },
        'staff-a',
        'intent-a',
      ),
    ).rejects.toMatchObject({ code: 'PREPARATION_DEPENDENCY_PENDING' })
    await expect(applyKitchenPreparation('venue-a', 'order-other-venue', input, 'staff-a', 'intent-a')).rejects.toMatchObject({
      statusCode: 404,
    })
    expect(prismaMock.kdsOrderItem.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })
  it('does not retry forever when a provisional product was authored into a different station', async () => {
    prismaMock.kdsOrderItem.findMany.mockResolvedValue([])
    prismaMock.kdsOrderItem.count.mockResolvedValue(1)
    await expect(
      applyKitchenPreparation(
        'venue-a',
        'order-a',
        {
          action: 'START',
          items: [
            {
              externalId: 'sync:round-a:0',
              sourceKey: 'round:round-a:old-station',
              stationId: 'old-station',
              expectedRevision: 0,
              quantity: 1,
            },
          ],
        },
        'staff-a',
        'intent-a',
      ),
    ).rejects.toMatchObject({ code: 'PREPARATION_ITEMS_CHANGED' })
    expect(prismaMock.kdsOrderItem.updateMany).not.toHaveBeenCalled()
  })
  it('still rejects a missing canonical product and an obsolete offline revision permanently', async () => {
    prismaMock.kdsOrderItem.findMany.mockResolvedValue([])
    await expect(applyKitchenPreparation('venue-a', 'order-a', input, 'staff-a', 'intent-a')).rejects.toMatchObject({
      code: 'PREPARATION_ITEMS_CHANGED',
    })
    prismaMock.kdsOrderItem.findMany.mockResolvedValue([{ ...line, preparationRevision: 2 }])
    await expect(applyKitchenPreparation('venue-a', 'order-a', input, 'staff-a', 'intent-a')).rejects.toMatchObject({
      code: 'PREPARATION_CONFLICT',
    })
    expect(prismaMock.kdsOrderItem.updateMany).not.toHaveBeenCalled()
  })
  it('financially completed orders retain their held products', async () => {
    prismaMock.order.findFirst.mockResolvedValue({ id: 'order-a', status: 'COMPLETED' })
    await expect(applyKitchenPreparation('venue-a', 'order-a', input, 'staff-a')).resolves.toBeDefined()
    expect(prismaMock.order.update).not.toHaveBeenCalled()
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })
  it('requires every station for floor actions, preventing premature delivery', async () => {
    prismaMock.kdsOrderItem.findMany.mockResolvedValueOnce([line]).mockResolvedValueOnce([{ id: line.id }, { id: 'line-b' }])
    await expect(applyKitchenPreparation('venue-a', 'order-a', input, 'staff-a')).rejects.toMatchObject({
      code: 'PREPARATION_STATIONS_REQUIRED',
    })
    expect(prismaMock.kdsOrderItem.updateMany).not.toHaveBeenCalled()
  })
  it('does not treat a legacy ticket as per-product preparation', async () => {
    prismaMock.kdsOrderItem.findMany.mockResolvedValue([
      { ...line, preparation: null, kdsOrder: { ...line.kdsOrder, preparationVersion: 0 } },
    ])
    await expect(applyKitchenPreparation('venue-a', 'order-a', input, 'staff-a')).rejects.toMatchObject({
      code: 'PREPARATION_VERSION_REQUIRED',
    })
  })
  it('requires the same floor quantity at every station of a product', async () => {
    const second = { ...line, id: 'line-b', kdsOrderId: 'ticket-b' }
    prismaMock.kdsOrderItem.findMany.mockResolvedValueOnce([line, second]).mockResolvedValueOnce([line, second])
    await expect(
      applyKitchenPreparation(
        'venue-a',
        'order-a',
        {
          action: 'RELEASE',
          items: [input.items[0], { id: 'line-b', expectedRevision: 0, quantity: 2 }],
        },
        'staff-a',
      ),
    ).rejects.toMatchObject({ code: 'PREPARATION_STATION_QUANTITY' })
    expect(prismaMock.kdsOrderItem.updateMany).not.toHaveBeenCalled()
  })
  it('uses server-clamped, stable pagination with a true total', async () => {
    prismaMock.kdsOrderItem.count.mockResolvedValue(120)
    const result = await listKitchenPreparation('venue-a', { orderId: 'order-a', limit: 99999, cursor: 'previous' })
    expect(result).toMatchObject({ total: 120, limit: 100 })
    expect(result.items[0]).toMatchObject({ stationCount: 2 })
    expect(prismaMock.kdsOrderItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 101,
        orderBy: { id: 'asc' },
        cursor: { id: 'previous' },
        skip: 1,
        where: expect.objectContaining({ kdsOrder: expect.objectContaining({ venueId: 'venue-a', orderId: 'order-a' }) }),
      }),
    )
  })
  it('rejects malformed and oversized batches without silently dropping products', async () => {
    await expect(applyKitchenPreparation('venue-a', 'order-a', { action: 'RELEASE', items: [] }, 'staff-a')).rejects.toMatchObject({
      statusCode: 400,
    })
    await expect(
      applyKitchenPreparation('venue-a', 'order-a', { action: 'RELEASE', items: Array(101).fill(input.items[0]) }, 'staff-a'),
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })
  it('returns modifier names as an array for the native clients', async () => {
    prismaMock.kdsOrderItem.findMany.mockResolvedValue([{ ...line, modifiers: '["Sin azúcar","Leche de avena"]' }])
    prismaMock.kdsOrderItem.count.mockResolvedValue(1)
    const result = await listKitchenPreparation('venue-a')
    expect(result.items[0].modifiers).toEqual(['Sin azúcar', 'Leche de avena'])
  })
  it('keeps active and completed history in separate, tenant-scoped pages', async () => {
    prismaMock.kdsOrderItem.count.mockResolvedValue(1)
    await listKitchenPreparation('venue-a', { history: true } as any)
    expect(prismaMock.kdsOrderItem.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { kdsOrder: { venueId: 'venue-a', preparationVersion: 1, status: 'COMPLETED' } },
        take: 51,
      }),
    )
  })
  it('commits the durable ACK in the same transaction as preparation, before the outer replay response', async () => {
    preparationIntent.updateMany.mockResolvedValue({ count: 1 })
    const result = await (applyKitchenPreparation as any)('venue-a', 'order-a', input, 'staff-a', 'intent-a')
    expect(preparationIntent.updateMany).toHaveBeenCalledWith({
      where: { venueId: 'venue-a', idempotencyKey: 'intent-a', staffId: 'staff-a', type: 'KDS_ITEM_PROGRESS', status: 'PROCESSING' },
      data: { status: 'ACKED', errorCode: null, resultJson: result },
    })
  })
  it('advertises urgency separately so a newer POS does not enqueue it against an older backend', async () => {
    await expect(preparationCapabilities('venue-a')).resolves.toMatchObject({ version: 1, urgencyVersion: 1, enabled: true })
  })
  it('persists an exact urgent selection, its original request and actor with the same durable ACK', async () => {
    preparationIntent.updateMany.mockResolvedValue({ count: 1 })
    const result = await applyKitchenPreparation('venue-a', 'order-a', { ...input, action: 'URGENT' }, 'staff-a', 'urgent-a')
    expect(result.items[0]).toMatchObject({
      preparationRevision: 1,
      preparation: { HELD: 0, PENDING: 2, urgency: { requestId: 'urgent-a', acknowledged: false } },
    })
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          staffId: 'staff-a',
          venueId: 'venue-a',
          action: 'KITCHEN_URGENT',
        }),
      }),
    )
    expect(preparationIntent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'ACKED',
          resultJson: result,
        }),
      }),
    )
  })
  it('changes only priority when a selected station is already preparing', async () => {
    const preparing = { ...line, preparation: { HELD: 0, PENDING: 0, PREPARING: 2, READY: 0, DELIVERED: 0, CANCELLED: 0 } }
    prismaMock.kdsOrderItem.findMany.mockResolvedValue([preparing])
    const result = await applyKitchenPreparation('venue-a', 'order-a', { ...input, action: 'URGENT' }, 'staff-a')
    expect(result.items[0].preparation).toMatchObject(preparing.preparation)
    expect(result.items[0].preparation.urgency).toMatchObject({ acknowledged: false })
    expect(prismaMock.order.update).not.toHaveBeenCalled()
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })
  it('does not allow urgency to silently finish a ready product', async () => {
    prismaMock.kdsOrderItem.findMany.mockResolvedValue([
      { ...line, preparation: { HELD: 0, PENDING: 0, PREPARING: 0, READY: 2, DELIVERED: 0, CANCELLED: 0 } },
    ])
    await expect(applyKitchenPreparation('venue-a', 'order-a', { ...input, action: 'URGENT' }, 'staff-a')).rejects.toMatchObject({
      code: 'PREPARATION_CONFLICT',
    })
    expect(prismaMock.kdsOrderItem.updateMany).not.toHaveBeenCalled()
  })
})
