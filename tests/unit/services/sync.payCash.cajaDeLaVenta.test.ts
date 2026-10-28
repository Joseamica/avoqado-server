/**
 * S3 «Efectivo sin red en el turno correcto»: el intent PAY_CASH de la mesa abierta sin red (ANDROID/iOS) lleva en su payload la caja
 * que el aparato tenía abierta al cobrar (`cashDrawerSessionId`). El reducer la valida (texto ≤ 64; otra cosa es REJECTED visible) y
 * la pasa a `payCashOrder`, que la convierte en el turno de la venta. Dobles copiados de `sync.mobile.service.test.ts`.
 */

import { processIntents } from '@/services/mobile/sync.mobile.service'
import prisma from '@/utils/prismaClient'
import * as tableService from '@/services/tpv/table.tpv.service'
import * as orderMobileService from '@/services/mobile/order.mobile.service'
import * as featureAccess from '@/middlewares/checkFeatureAccess.middleware'
import * as tableOwnership from '@/middlewares/checkTableOwnership.middleware'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    $queryRaw: jest.fn(),
    posSyncIntent: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
    order: { findFirst: jest.fn() },
    payment: { findUnique: jest.fn() },
    orderItem: { findMany: jest.fn() },
    kdsOrder: { findFirst: jest.fn() },
  },
}))

jest.mock('@/services/tpv/table.tpv.service', () => ({
  assignTable: jest.fn(),
  moveOrderToTable: jest.fn(),
  assignOrderWaiter: jest.fn(),
  clearTable: jest.fn(),
}))
jest.mock('@/services/tpv/order.tpv.service', () => ({ addItemsToOrder: jest.fn() }))
jest.mock('@/services/mobile/order.mobile.service', () => ({
  payCashOrder: jest.fn(),
  applyOrderDiscount: jest.fn(),
  updateOrderDetails: jest.fn(),
  cancelOrder: jest.fn(),
  splitOrderItems: jest.fn(),
  splitOrderBySeat: jest.fn(),
  mergeOrders: jest.fn(),
}))
jest.mock('@/services/mobile/comp-item.mobile.service', () => ({ compWholeOrder: jest.fn() }))
jest.mock('@/services/mobile/service-charge.mobile.service', () => ({ applyServiceCharge: jest.fn() }))
jest.mock('@/services/promotions/promotion.service', () => ({ applyPromotionToOrder: jest.fn(), removeIntentPromotions: jest.fn() }))
jest.mock('@/middlewares/checkFeatureAccess.middleware', () => ({ hasFeatureAccess: jest.fn() }))
jest.mock('@/middlewares/checkTableOwnership.middleware', () => ({
  isTableOwnershipEnforced: jest.fn(),
  staffCanManageAllTables: jest.fn(),
  // Las dos listas de override son datos, no comportamiento: se exponen tal cual para
  // poder afirmar CUÁL monta cada intent (el cobro usa la acotada).
  DEFAULT_OWNERSHIP_OVERRIDES: ['tables:manage-all'],
  PAYMENT_OWNERSHIP_OVERRIDES: ['tables:manage-all', 'tables:pay-any'],
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/services/kds/kitchenTicketAuthoring.service', () => ({ markKitchenTicket: jest.fn() }))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

// Cierres y borrados de la reserva van condicionados a su turno (plan 2026-10-13-sync-retoma-por-llave): por defecto
// el turno sigue siendo de este request.
beforeEach(() => {
  ;(prisma.posSyncIntent.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
  ;(prisma.posSyncIntent.deleteMany as jest.Mock).mockResolvedValue({ count: 1 })
})

const VENUE = 'venue-1'
const STAFF = 'staff-juan'

const baseParams = (intents: any[]) => ({
  venueId: VENUE,
  staffId: STAFF,
  deviceId: 'device-a',
  intents,
  authorizeIntent: jest.fn((_intent: any, _permission: string) => true),
})

const CAJA = 'cmcajaa00000000000000000'

describe('PAY_CASH — cashDrawerSessionId del payload', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prisma.posSyncIntent.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
    ;(prisma.posSyncIntent.deleteMany as jest.Mock).mockResolvedValue({ count: 1 })
    ;(prisma.posSyncIntent.findUnique as jest.Mock).mockResolvedValue(null)
    ;(prisma.posSyncIntent.findFirst as jest.Mock).mockResolvedValue(null)
    ;(prisma.posSyncIntent.create as jest.Mock).mockResolvedValue({})
    ;(prisma.posSyncIntent.update as jest.Mock).mockResolvedValue({})
    ;(featureAccess.hasFeatureAccess as jest.Mock).mockResolvedValue({ hasAccess: true })
    ;(tableOwnership.isTableOwnershipEnforced as jest.Mock).mockResolvedValue(false)
    ;(prisma.payment.findUnique as jest.Mock).mockResolvedValue(null)
    ;(orderMobileService.payCashOrder as jest.Mock).mockResolvedValue({ paymentId: 'pay-1', orderNumber: 'A-1', digitalReceipt: null })
  })

  it('con la caja en el payload, llega a payCashOrder', async () => {
    const acks = await processIntents(
      baseParams([{ id: 'i-caja', type: 'PAY_CASH', payload: { orderId: 'order-1', amountCents: 10000, cashDrawerSessionId: CAJA } }]),
    )
    expect(acks[0]).toMatchObject({ status: 'ACKED' })
    expect(orderMobileService.payCashOrder).toHaveBeenCalledWith(
      VENUE,
      'order-1',
      expect.objectContaining({ isOfflineReplay: true, cashDrawerSessionId: CAJA }),
    )
  })

  it('sin la caja, payCashOrder no la recibe (como hoy)', async () => {
    await processIntents(baseParams([{ id: 'i-sin', type: 'PAY_CASH', payload: { orderId: 'order-1', amountCents: 10000 } }]))
    expect((orderMobileService.payCashOrder as jest.Mock).mock.calls[0][2].cashDrawerSessionId).toBeUndefined()
  })

  it('una caja que no es texto de hasta 64 ⇒ REJECTED INVALID_PAYLOAD, sin tocar payCashOrder', async () => {
    for (const cashDrawerSessionId of [42, 'x'.repeat(65), { id: CAJA }]) {
      jest.clearAllMocks()
      ;(prisma.posSyncIntent.findUnique as jest.Mock).mockResolvedValue(null)
      ;(prisma.posSyncIntent.create as jest.Mock).mockResolvedValue({})
      ;(featureAccess.hasFeatureAccess as jest.Mock).mockResolvedValue({ hasAccess: true })
      const acks = await processIntents(
        baseParams([
          {
            id: `i-mala-${typeof cashDrawerSessionId}`,
            type: 'PAY_CASH',
            payload: { orderId: 'order-1', amountCents: 10000, cashDrawerSessionId },
          },
        ]),
      )
      expect(acks[0]).toMatchObject({ status: 'REJECTED', errorCode: 'INVALID_PAYLOAD' })
      expect(orderMobileService.payCashOrder).not.toHaveBeenCalled()
    }
  })
})

describe('OPEN_TABLE — cashDrawerSessionId del payload', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prisma.posSyncIntent.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
    ;(prisma.posSyncIntent.findUnique as jest.Mock).mockResolvedValue(null)
    ;(prisma.posSyncIntent.findFirst as jest.Mock).mockResolvedValue(null)
    ;(prisma.posSyncIntent.create as jest.Mock).mockResolvedValue({})
    ;(featureAccess.hasFeatureAccess as jest.Mock).mockResolvedValue({ hasAccess: true })
    ;(tableOwnership.isTableOwnershipEnforced as jest.Mock).mockResolvedValue(false)
    ;(tableService.assignTable as jest.Mock).mockResolvedValue({
      order: { id: 'order-1', orderNumber: 'A-1', version: 1 },
      isNewOrder: true,
    })
  })

  it('con la caja, assignTable la recibe como venta de la cola', async () => {
    const acks = await processIntents(
      baseParams([{ id: 'i-mesa', type: 'OPEN_TABLE', payload: { tableId: 't1', covers: 2, cashDrawerSessionId: CAJA } }]),
    )
    expect(acks[0]).toMatchObject({ status: 'ACKED' })
    expect((tableService.assignTable as jest.Mock).mock.calls[0][6]).toEqual({ cashDrawerSessionId: CAJA })
  })

  it('sin la caja, la llamada de hoy (seis argumentos)', async () => {
    await processIntents(baseParams([{ id: 'i-mesa-sin', type: 'OPEN_TABLE', payload: { tableId: 't1', covers: 2 } }]))
    expect((tableService.assignTable as jest.Mock).mock.calls[0]).toHaveLength(6)
  })

  it('una caja que no es texto de hasta 64 ⇒ REJECTED INVALID_PAYLOAD, sin abrir la mesa', async () => {
    const acks = await processIntents(
      baseParams([{ id: 'i-mesa-mala', type: 'OPEN_TABLE', payload: { tableId: 't1', covers: 2, cashDrawerSessionId: 42 } }]),
    )
    expect(acks[0]).toMatchObject({ status: 'REJECTED', errorCode: 'INVALID_PAYLOAD' })
    expect(tableService.assignTable).not.toHaveBeenCalled()
  })
})
