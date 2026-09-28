/**
 * Plan 3b — how the provider's answer to «no tengo este artículo» is applied (`enviarYAplicar`).
 *
 * Contract: delivery advisory → Order. On the apply tx, the venue-scoped Order lock comes BEFORE the reservation CAS
 * (`soltarReserva`), the attempt CAS stays as it is, and the line is marked only when the Order is still this venue's,
 * the reservation is ours and the attempt is the current one. `Order.status` is deliberately not an input (T5-R1).
 * The open tx, the apply tx and the global client are DIFFERENT objects: an escape to the global client fails here.
 */
import { prismaMock } from '../../../__helpers__/setup'
import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'
import { withDeliveryOrderLock } from '@/services/delivery-channels/core/deliveryOrderLock'
import { applyLineRemoval } from '@/services/delivery-channels/core/lineRemoval.service'
import { contexto } from '@/services/delivery-channels/core/respondToDeliveryOrder.service'
import { reportOutOfStock } from '@/services/mobile/kdsOutOfStock.mobile.service'

jest.mock('@/services/delivery-channels/core/deliveryOrderLock', () => ({
  ...jest.requireActual('@/services/delivery-channels/core/deliveryOrderLock'),
  withDeliveryOrderLock: jest.fn(),
}))
jest.mock('@/services/delivery-channels/core/lineRemoval.service', () => ({ applyLineRemoval: jest.fn() }))
jest.mock('@/services/delivery-channels/core/deliveryReconciliation.service', () => ({
  reconcileDeliveryOrderFromProvider: jest.fn().mockResolvedValue({ outcome: 'READ_FAILED' }),
}))
jest.mock('@/services/delivery-channels/core/respondToDeliveryOrder.service', () => ({
  contexto: jest.fn(),
  recuperarAceptacionDesdeProveedor: jest.fn(),
}))
jest.mock('@/services/mobile/kds.mobile.service', () => ({ formatKdsOrderConVenta: jest.fn(() => ({ id: 'kds-1' })) }))
jest.mock('@/services/mobile/kdsCapacidades', () => ({
  ...jest.requireActual('@/services/mobile/kdsCapacidades'),
  ventasDeComandas: jest.fn(async () => new Map()),
}))

const VENUE = 'venue-1'
const ORDER = 'order-1'
let openTx: any
let applyTx: any
let resolveFulfillmentIssues: jest.Mock

const report = () => reportOutOfStock(VENUE, 'kds-1', 'kitem-1', 'staff-1')

beforeEach(() => {
  resolveFulfillmentIssues = jest.fn().mockResolvedValue({ ok: true, status: 200, raw: '{}' })
  ;(contexto as jest.Mock).mockResolvedValue({
    provider: 'UBER_EATS',
    externalOrderId: 'ext-1',
    storeId: 'store-1',
    adapter: { resolveFulfillmentIssues },
  })
  // Step 1 (ownership chain) and the final response read are global reads.
  prismaMock.kdsOrderItem.findFirst.mockResolvedValue({ orderItemId: 'oi-b', kdsOrder: { orderId: ORDER } })
  prismaMock.order.findFirst.mockResolvedValue({ type: 'DELIVERY' })
  prismaMock.orderItem.findFirst.mockResolvedValue({ externalLineId: 'b' })
  prismaMock.orderItem.findUnique.mockResolvedValue({ removedAt: null })
  prismaMock.kdsOrder.findFirstOrThrow.mockResolvedValue({ id: 'kds-1', venueId: VENUE, orderId: ORDER, items: [] })
  ;(prismaMock as any).deliveryLineAction = {
    findUnique: jest
      .fn()
      .mockResolvedValue({ id: 'dla-1', status: 'CONFIRMED', attempts: 1, lastAttemptAt: new Date(), providerBody: '{}' }),
    // Applying the answer outside the lock would be an escape.
    updateMany: jest.fn().mockRejectedValue(new Error('GLOBAL deliveryLineAction.updateMany')),
  }
  prismaMock.order.updateMany.mockRejectedValue(new Error('GLOBAL order.updateMany'))

  // Steps 2-4 (open the attempt and take the reservation) on their own tx.
  openTx = {
    deliveryLineAction: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'dla-1' }),
    },
    orderItem: { findUnique: jest.fn().mockResolvedValue({ removedAt: null }) },
    order: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        providerAcceptedAt: new Date(),
        readyReportedAt: null,
        deliveryOpInFlight: null,
        deliveryOpInFlightAt: null,
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    kdsOrder: { findUniqueOrThrow: jest.fn().mockResolvedValue({ status: 'NEW' }) },
    activityLog: { create: jest.fn().mockResolvedValue({}) },
  }
  // Step 5: apply the provider's answer.
  applyTx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: ORDER }]),
    order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    deliveryLineAction: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  }
  let lockCalls = 0
  ;(withDeliveryOrderLock as jest.Mock).mockImplementation(async (orderId: string, fn: (tx: any) => unknown) => {
    expect(orderId).toBe(ORDER)
    return fn(lockCalls++ === 0 ? openTx : applyTx)
  })
})

describe('enviarYAplicar — the provider answer is applied under delivery advisory → Order', () => {
  it('takes the venue-scoped Order lock on the apply tx BEFORE the reservation CAS and marks the line on that tx', async () => {
    const result = await report()

    expect(result.kind).toBe('HECHO')
    expect(resolveFulfillmentIssues).toHaveBeenCalledWith('ext-1', 'store-1', ['b'])
    // Tagged template: [strings, ...values] — the KDS line's Order, scoped to the ROUTE venue.
    expect(applyTx.$queryRaw.mock.calls.map((call: any[]) => call.slice(1))).toEqual([[ORDER, VENUE]])
    expect(applyTx.$queryRaw.mock.calls[0][0].join('?')).toMatch(/FROM "Order"[\s\S]*FOR UPDATE/)
    expect(applyTx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(applyTx.order.updateMany.mock.invocationCallOrder[0])
    expect(applyTx.order.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      applyTx.deliveryLineAction.updateMany.mock.invocationCallOrder[0],
    )
    expect(applyLineRemoval).toHaveBeenCalledWith(applyTx, { orderId: ORDER, orderItemId: 'oi-b', origin: 'STAFF', staffId: 'staff-1' })
  })

  it('an Order the lock cannot see: records the answer on OUR attempt, releases OUR token, never marks the line, no throw', async () => {
    applyTx.$queryRaw.mockResolvedValue([])

    const result = await report()

    expect(result.kind).toBe('HECHO')
    expect(applyLineRemoval).not.toHaveBeenCalled()
    // Our token (the one the open step wrote) is released; the provider's answer lands on our attempt.
    const token = openTx.order.update.mock.calls[0][0].data.deliveryOpToken
    expect(applyTx.order.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: ORDER, deliveryOpToken: token } }))
    expect(applyTx.deliveryLineAction.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'dla-1', status: 'PENDING', attempts: 1 },
        data: expect.objectContaining({ status: 'CONFIRMED', providerStatus: 200 }),
      }),
    )
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('ya no es de este negocio'),
      expect.objectContaining({ orderId: ORDER, venueId: VENUE, orderItemId: 'oi-b', attempt: 1 }),
    )
  })

  it('with the reservation taken by another operation the answer is recorded, the line is not marked and the late result is audited', async () => {
    applyTx.order.updateMany.mockResolvedValue({ count: 0 })

    await report()

    expect(applyTx.$queryRaw).toHaveBeenCalledTimes(1)
    expect(applyTx.deliveryLineAction.updateMany).toHaveBeenCalledTimes(1)
    expect(applyLineRemoval).not.toHaveBeenCalled()
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'DELIVERY_OP_LATE_RESULT', entityId: ORDER }))
  })

  it('an attempt that is no longer current is not applied to the order (attempt CAS unchanged)', async () => {
    applyTx.deliveryLineAction.updateMany.mockResolvedValue({ count: 0 })

    await report()

    expect(applyLineRemoval).not.toHaveBeenCalled()
  })
})
