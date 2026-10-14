/**
 * Replay de la cola sin red (POST /mobile|tpv/venues/:venueId/sync/intents) cuando cambió QUIÉN opera o QUÉ
 * puede hacer entre el momento en que se encoló la venta y el momento en que vuelve la red.
 *
 * Recorre el camino REAL controller → getUserAccess (simulado: es la base) → hasPermission real → processIntents real.
 * Sólo se simulan la base y los servicios de efecto (el cobro). Cubre lo que el laboratorio de 40 negocios no cubría
 * (sus fixtures apagan PIN y turnos):
 *   1. permiso revocado al cajero que encoló;
 *   2. cajero desactivado mientras el aparato estaba sin red;
 *   3. otra persona inició sesión en el aparato antes de que volviera la red (con y sin `staffId` en el intent).
 *
 * Cierre Mesas40 §9 «PIN/aparato», 14-oct-2026.
 */
import type { Request, Response } from 'express'
import { StaffRole } from '@prisma/client'
import { syncIntents } from '@/controllers/mobile/sync.mobile.controller'
import { getUserAccess } from '@/services/access/access.service'
import prisma from '@/utils/prismaClient'
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
jest.mock('@/services/access/access.service', () => ({
  ...jest.requireActual('@/services/access/access.service'),
  getUserAccess: jest.fn(),
}))
jest.mock('@/services/mobile/sync-recovery.mobile.service', () => ({ lookupSyncRecovery: jest.fn() }))
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
  DEFAULT_OWNERSHIP_OVERRIDES: ['tables:manage-all'],
  PAYMENT_OWNERSHIP_OVERRIDES: ['tables:manage-all', 'tables:pay-any'],
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/services/kds/kitchenTicketAuthoring.service', () => ({ markKitchenTicket: jest.fn() }))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

const VENUE = 'venue-mesas40'
const CAJERA_A = 'staff-ana' // encoló la venta sin red
const CAJERO_B = 'staff-beto' // inició sesión después en el mismo aparato
const DEVICE = 'device-caja-1'

const accesoCon = (userId: string, corePermissions: string[]) => ({
  userId,
  venueId: VENUE,
  organizationId: 'org-1',
  role: StaffRole.CASHIER,
  corePermissions,
  whiteLabelEnabled: false,
  enabledFeatures: [],
  featureAccess: {},
  featureMetadata: {},
})

/** Venta en efectivo cobrada SIN red por la cajera A (Android manda `staffId`; TPV/iOS hoy no). */
const cobroEnEfectivo = (id: string, conActor: boolean) => ({
  id,
  seq: 7,
  type: 'PAY_CASH',
  ...(conActor ? { staffId: CAJERA_A } : {}),
  payload: { orderId: 'order-mesa-4', amountCents: 25000 },
})

function replay(autenticado: string, intents: unknown[]) {
  const req = {
    params: { venueId: VENUE },
    body: { deviceId: DEVICE, intents },
    authContext: { userId: autenticado, venueId: VENUE },
  } as unknown as Request
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() }
  return syncIntents(req, res as unknown as Response).then(() => ({
    status: res.status.mock.calls[0]?.[0] as number,
    body: res.json.mock.calls[0]?.[0] as { success: boolean; data?: any[] },
  }))
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(prisma.posSyncIntent.findUnique as jest.Mock).mockResolvedValue(null)
  ;(prisma.posSyncIntent.findFirst as jest.Mock).mockResolvedValue(null)
  ;(prisma.posSyncIntent.create as jest.Mock).mockResolvedValue({})
  ;(prisma.posSyncIntent.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
  ;(prisma.posSyncIntent.deleteMany as jest.Mock).mockResolvedValue({ count: 1 })
  ;(prisma.payment.findUnique as jest.Mock).mockResolvedValue(null)
  ;(featureAccess.hasFeatureAccess as jest.Mock).mockResolvedValue({ hasAccess: true })
  ;(tableOwnership.isTableOwnershipEnforced as jest.Mock).mockResolvedValue(false)
  ;(tableOwnership.staffCanManageAllTables as jest.Mock).mockResolvedValue(false)
  ;(orderMobileService.payCashOrder as jest.Mock).mockResolvedValue({ paymentId: 'pay-1', orderNumber: 'A-1', digitalReceipt: null })
})

describe('replay de la cola: permisos VIGENTES de quien está autenticado', () => {
  it('control: misma cajera con su permiso vigente → ACKED y el cobro se atribuye a ella', async () => {
    ;(getUserAccess as jest.Mock).mockResolvedValue(accesoCon(CAJERA_A, ['payments:create']))

    const { status, body } = await replay(CAJERA_A, [cobroEnEfectivo('cash-ok', true)])

    expect(status).toBe(200)
    expect(getUserAccess).toHaveBeenCalledWith(CAJERA_A, VENUE)
    expect(body.data?.[0]).toMatchObject({ id: 'cash-ok', status: 'ACKED' })
    expect(orderMobileService.payCashOrder).toHaveBeenCalledWith(
      VENUE,
      'order-mesa-4',
      expect.objectContaining({ staffId: CAJERA_A, idempotencyKey: 'cash-ok', isOfflineReplay: true }),
    )
  })

  it('permiso revocado mientras estaba sin red → REJECTED PERMISSION_DENIED, sin cobro, y el rechazo queda guardado', async () => {
    // El gerente le quitó `payments:create` a la cajera ANTES de que volviera la red.
    ;(getUserAccess as jest.Mock).mockResolvedValue(accesoCon(CAJERA_A, ['orders:create']))

    const { status, body } = await replay(CAJERA_A, [cobroEnEfectivo('cash-revocado', true)])

    expect(status).toBe(200)
    expect(body.data?.[0]).toMatchObject({ id: 'cash-revocado', status: 'REJECTED', errorCode: 'PERMISSION_DENIED' })
    expect(orderMobileService.payCashOrder).not.toHaveBeenCalled()
    expect(prisma.posSyncIntent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'REJECTED', errorCode: 'PERMISSION_DENIED' }) }),
    )
  })

  it('LÍMITE: devolverle el permiso después NO revive la venta — la llave quedó REJECTED para siempre', async () => {
    ;(getUserAccess as jest.Mock).mockResolvedValue(accesoCon(CAJERA_A, ['payments:create']))
    ;(prisma.posSyncIntent.findUnique as jest.Mock).mockResolvedValue({
      type: 'PAY_CASH',
      status: 'REJECTED',
      errorCode: 'PERMISSION_DENIED',
      resultJson: null,
      createdAt: new Date(Date.now() - 60_000),
    })

    const { body } = await replay(CAJERA_A, [cobroEnEfectivo('cash-revocado', true)])

    expect(body.data?.[0]).toMatchObject({ id: 'cash-revocado', status: 'REJECTED', errorCode: 'PERMISSION_DENIED' })
    expect(orderMobileService.payCashOrder).not.toHaveBeenCalled()
  })
})

describe('replay de la cola: cajero desactivado mientras el aparato estaba sin red', () => {
  // getUserAccess lanza un Error plano (access.service.ts: «User … has no access to venue …») cuando la persona o su
  // fila de sucursal están inactivas. El controller lo atrapa como error de INFRAESTRUCTURA.
  const desactivado = () =>
    (getUserAccess as jest.Mock).mockRejectedValue(new Error(`User ${CAJERA_A} has no access to venue ${VENUE}`))

  // Arreglado el 14-oct (antes: 500 ⇒ Android lo trata como red caída y reintenta el lote ENTERO para siempre, con los
  // cobros de los demás cajeros atorados detrás). Ahora es un rechazo de negocio por intent: queda visible para el gerente.
  it('cajero desactivado → cada intent REJECTED PERMISSION_DENIED (cuarentena visible), sin cobro, y el rechazo queda guardado', async () => {
    desactivado()

    const { status, body } = await replay(CAJERA_A, [cobroEnEfectivo('cash-desactivada', true)])

    expect(status).toBe(200)
    expect(body.data?.[0]).toMatchObject({ id: 'cash-desactivada', status: 'REJECTED', errorCode: 'PERMISSION_DENIED' })
    expect(orderMobileService.payCashOrder).not.toHaveBeenCalled()
    expect(prisma.posSyncIntent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'REJECTED', errorCode: 'PERMISSION_DENIED' }) }),
    )
  })

  it('un error de INFRAESTRUCTURA al leer permisos sigue siendo 500 (transitorio: el aparato reintenta)', async () => {
    ;(getUserAccess as jest.Mock).mockRejectedValue(new Error('Can\'t reach database server'))

    const { status } = await replay(CAJERA_A, [cobroEnEfectivo('cash-infra', true)])

    expect(status).toBe(500)
    expect(orderMobileService.payCashOrder).not.toHaveBeenCalled()
  })
})

describe('replay de la cola: otra persona inició sesión en el aparato antes de que volviera la red', () => {
  it('intent CON staffId (Android/Windows) → REJECTED ACTOR_MISMATCH: no se cobra a nombre de quien no cobró', async () => {
    ;(getUserAccess as jest.Mock).mockResolvedValue(accesoCon(CAJERO_B, ['payments:create']))

    const { status, body } = await replay(CAJERO_B, [cobroEnEfectivo('cash-relevo', true)])

    expect(status).toBe(200)
    expect(body.data?.[0]).toMatchObject({ id: 'cash-relevo', status: 'REJECTED', errorCode: 'ACTOR_MISMATCH' })
    expect(orderMobileService.payCashOrder).not.toHaveBeenCalled()
    expect(prisma.posSyncIntent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'REJECTED', errorCode: 'ACTOR_MISMATCH' }) }),
    )
  })

  it('LÍMITE: si después vuelve la cajera original con la MISMA llave, recibe el mismo REJECTED (no se cobra dos veces ni se recupera solo)', async () => {
    ;(getUserAccess as jest.Mock).mockResolvedValue(accesoCon(CAJERA_A, ['payments:create']))
    ;(prisma.posSyncIntent.findUnique as jest.Mock).mockResolvedValue({
      type: 'PAY_CASH',
      status: 'REJECTED',
      errorCode: 'ACTOR_MISMATCH',
      staffId: CAJERO_B,
      resultJson: null,
      createdAt: new Date(Date.now() - 60_000),
    })

    const { body } = await replay(CAJERA_A, [cobroEnEfectivo('cash-relevo', true)])

    expect(body.data?.[0]).toMatchObject({ id: 'cash-relevo', status: 'REJECTED', errorCode: 'ACTOR_MISMATCH' })
    expect(orderMobileService.payCashOrder).not.toHaveBeenCalled()
  })

  // HALLAZGO (reportado): la TPV (SyncIntentDto.kt) no manda `staffId` en ningún intent e iOS sólo lo manda en
  // KDS_ITEM_PROGRESS. El servidor sólo compara actor cuando el intent lo trae (sync.mobile.service.ts:632), así que
  // sin él no puede notar el relevo: el cobro se registra a nombre de quien esté autenticado al volver la red.
  it('HALLAZGO: intent SIN staffId (TPV hoy, iOS hoy) → se aplica y se ATRIBUYE a quien inició sesión después', async () => {
    ;(getUserAccess as jest.Mock).mockResolvedValue(accesoCon(CAJERO_B, ['payments:create']))

    const { body } = await replay(CAJERO_B, [cobroEnEfectivo('cash-sin-actor', false)])

    expect(body.data?.[0]).toMatchObject({ id: 'cash-sin-actor', status: 'ACKED' })
    expect(orderMobileService.payCashOrder).toHaveBeenCalledWith(
      VENUE,
      'order-mesa-4',
      expect.objectContaining({ staffId: CAJERO_B, idempotencyKey: 'cash-sin-actor' }),
    )
    expect(prisma.posSyncIntent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ staffId: CAJERO_B }) }))
  })
})
