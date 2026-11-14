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
import { logAction } from '@/services/dashboard/activity-log.service'

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

  it('D51: con la hora de encolar y sin caja, assignTable recibe esa hora (8.º) y la caja vacía (7.º)', async () => {
    const abiertaSinRed = Date.now() - 60_000
    await processIntents(
      baseParams([{ id: 'i-mesa-hora', type: 'OPEN_TABLE', payload: { tableId: 't1', covers: 2 }, createdAtLocal: abiertaSinRed }]),
    )
    const llamada = (tableService.assignTable as jest.Mock).mock.calls[0]
    expect(llamada).toHaveLength(8)
    expect(llamada[6]).toBeUndefined()
    expect(llamada[7]).toEqual(new Date(abiertaSinRed))
  })

  it('D51: una hora adelantada se acota a ahora (se comporta como hoy)', async () => {
    const antes = Date.now()
    await processIntents(
      baseParams([{ id: 'i-mesa-futuro', type: 'OPEN_TABLE', payload: { tableId: 't1', covers: 2 }, createdAtLocal: antes + 3_600_000 }]),
    )
    const hora = (tableService.assignTable as jest.Mock).mock.calls[0][7] as Date
    expect(hora.getTime()).toBeGreaterThanOrEqual(antes)
    expect(hora.getTime()).toBeLessThanOrEqual(Date.now())
  })

  it('D51: una hora de hace más de un día NO se sube a 24 h (Codex r1 #2)', async () => {
    const haceDosDias = Date.now() - 48 * 3_600_000
    await processIntents(
      baseParams([{ id: 'i-mesa-vieja', type: 'OPEN_TABLE', payload: { tableId: 't1', covers: 2 }, createdAtLocal: haceDosDias }]),
    )
    expect((tableService.assignTable as jest.Mock).mock.calls[0][7]).toEqual(new Date(haceDosDias))
  })

  it('D51: si assignTable la deja junto a otras cuentas, la nota MESA_SIN_RED_EN_CUENTA_APARTE va DENTRO de su transacción', async () => {
    const tx = {
      activityLog: { create: jest.fn().mockResolvedValue({}) },
      posSyncIntent: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    }
    ;(tableService.assignTable as jest.Mock).mockImplementation(async (...args: any[]) => {
      await args[5](tx, { orderId: 'cuenta-propia', isNewOrder: true, otrasCuentas: ['cuenta-B'] })
      return { order: { id: 'cuenta-propia', orderNumber: 'A-2', version: 1 }, isNewOrder: true }
    })
    const acks = await processIntents(
      baseParams([
        {
          id: 'i-mesa-aparte',
          type: 'OPEN_TABLE',
          payload: { tableId: 't1', covers: 2, localOrderId: 'L-1' },
          createdAtLocal: Date.now() - 60_000,
        },
      ]),
    )
    expect(acks[0]).toMatchObject({ status: 'ACKED', result: { orderId: 'cuenta-propia', localOrderId: 'L-1', isNewOrder: true } })
    expect(tx.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'MESA_SIN_RED_EN_CUENTA_APARTE',
        venueId: VENUE,
        staffId: STAFF,
        entityId: 'cuenta-propia',
        data: expect.objectContaining({ tableId: 't1', otrasCuentas: ['cuenta-B'], localOrderId: 'L-1', intentId: 'i-mesa-aparte' }),
      }),
    })
    // La huella de la retoma sigue en la misma transacción.
    expect(tx.posSyncIntent.updateMany).toHaveBeenCalledTimes(1)
    expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'MESA_SIN_RED_EN_CUENTA_APARTE' }))
  })

  // D71 (hz:8024bc1c:D71, founder 13-nov: «A, cuenta propia»): con «propiedad de mesa» encendida, la mesa abierta SIN red sobre una
  // mesa que ya es de otro mesero ya no se rechaza (su efectivo quedaba en cuarentena): nace en su cuenta propia, a su nombre.
  // Reemplaza a «D51 · Codex r2 #2» (que rechazaba bajo el candado): ahora assignTable nunca adopta una cuenta ajena.
  describe('D71 · propiedad de mesa encendida', () => {
    const tx = () => ({
      activityLog: { create: jest.fn().mockResolvedValue({}) },
      posSyncIntent: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      order: { findMany: jest.fn().mockResolvedValue([{ id: 'cuenta-de-pedro' }]) },
    })
    beforeEach(() => {
      ;(tableOwnership.isTableOwnershipEnforced as jest.Mock).mockResolvedValue(true)
      ;(tableOwnership.staffCanManageAllTables as jest.Mock).mockResolvedValue(false)
      // La revisión de antes del candado SÍ ve la cuenta de otro mesero.
      ;(prisma.order.findFirst as jest.Mock).mockResolvedValue({ servedBy: { firstName: 'Pedro', lastName: 'Mesa' } })
    })

    it('con la hora, la mesa de otro mesero ya no rechaza: assignTable sólo puede adoptar cuentas de ESTE mesero (9.º)', async () => {
      const t = tx()
      ;(tableService.assignTable as jest.Mock).mockImplementation(async (...args: any[]) => {
        await args[5](t, { orderId: 'cuenta-propia', isNewOrder: true, otrasCuentas: ['cuenta-de-pedro'] })
        return { order: { id: 'cuenta-propia', orderNumber: 'A-2', version: 1 }, isNewOrder: true }
      })
      const acks = await processIntents(
        baseParams([
          {
            id: 'i-mesa-pedro',
            type: 'OPEN_TABLE',
            payload: { tableId: 't1', covers: 2, localOrderId: 'L-9' },
            createdAtLocal: Date.now() - 60_000,
          },
        ]),
      )
      expect(acks[0]).toMatchObject({ status: 'ACKED', result: { orderId: 'cuenta-propia', localOrderId: 'L-9', isNewOrder: true } })
      const llamada = (tableService.assignTable as jest.Mock).mock.calls[0]
      expect(llamada).toHaveLength(9)
      expect(llamada[8]).toBe(STAFF)
      // La nota dice cuáles de las otras cuentas son de otro mesero (medido bajo el candado, en la misma transacción).
      expect(t.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { venueId: VENUE, id: { in: ['cuenta-de-pedro'] }, servedById: { not: STAFF } } }),
      )
      expect(t.activityLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'MESA_SIN_RED_EN_CUENTA_APARTE',
          staffId: STAFF,
          entityId: 'cuenta-propia',
          data: expect.objectContaining({ otrasCuentas: ['cuenta-de-pedro'], cuentasDeOtroMesero: ['cuenta-de-pedro'] }),
        }),
      })
      expect(t.posSyncIntent.updateMany).toHaveBeenCalledTimes(1)
    })

    it('sin la hora (petición a mano, cliente sin createdAtLocal) sigue rechazando como hoy, sin abrir nada', async () => {
      const acks = await processIntents(baseParams([{ id: 'i-mesa-sin-hora', type: 'OPEN_TABLE', payload: { tableId: 't1', covers: 2 } }]))
      expect(acks[0]).toMatchObject({ status: 'REJECTED', errorCode: 'TABLE_OWNED_BY_OTHER' })
      expect(tableService.assignTable).not.toHaveBeenCalled()
    })

    it('un gerente (tables:manage-all) sigue con la regla de D51: assignTable no recibe el 9.º', async () => {
      ;(tableOwnership.staffCanManageAllTables as jest.Mock).mockResolvedValue(true)
      ;(tableService.assignTable as jest.Mock).mockResolvedValue({
        order: { id: 'cuenta-A', orderNumber: 'A-1', version: 1 },
        isNewOrder: false,
      })
      const acks = await processIntents(
        baseParams([
          { id: 'i-mesa-gerente', type: 'OPEN_TABLE', payload: { tableId: 't1', covers: 2 }, createdAtLocal: Date.now() - 60_000 },
        ]),
      )
      expect(acks[0].status).toBe('ACKED')
      expect((tableService.assignTable as jest.Mock).mock.calls[0]).toHaveLength(8)
    })
  })

  it('D51: adoptada (sin otras cuentas), no deja nota', async () => {
    const tx = { activityLog: { create: jest.fn() }, posSyncIntent: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } }
    ;(tableService.assignTable as jest.Mock).mockImplementation(async (...args: any[]) => {
      await args[5](tx, { orderId: 'cuenta-A', isNewOrder: false })
      return { order: { id: 'cuenta-A', orderNumber: 'A-1', version: 1 }, isNewOrder: false }
    })
    await processIntents(
      baseParams([{ id: 'i-mesa-adopta', type: 'OPEN_TABLE', payload: { tableId: 't1', covers: 2 }, createdAtLocal: Date.now() - 60_000 }]),
    )
    expect(tx.activityLog.create).not.toHaveBeenCalled()
  })

  it('una caja que no es texto de hasta 64 ⇒ REJECTED INVALID_PAYLOAD, sin abrir la mesa', async () => {
    const acks = await processIntents(
      baseParams([{ id: 'i-mesa-mala', type: 'OPEN_TABLE', payload: { tableId: 't1', covers: 2, cashDrawerSessionId: 42 } }]),
    )
    expect(acks[0]).toMatchObject({ status: 'REJECTED', errorCode: 'INVALID_PAYLOAD' })
    expect(tableService.assignTable).not.toHaveBeenCalled()
  })
})

/**
 * D5 · bloque P (11-nov-2026): el `PAY_CASH` de una mesa cobrada sin red puede traer `expectedBalanceBeforeCents`, el saldo que la
 * tablet creía que debía la cuenta ANTES de este cobro. Es sólo un rastro para la bitácora (`COBRO_SIN_RED_CON_DIFERENCIA`): nunca
 * cambia ni rechaza el cobro. Las apps viejas no lo mandan y todo sigue igual; un valor que no sirve se ignora (el efectivo ya está
 * en el cajón: rechazarlo por un dato de diagnóstico lo dejaría sin registrar).
 */
describe('PAY_CASH — saldo que la tablet esperaba (expectedBalanceBeforeCents)', () => {
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

  const cobrar = (id: string, extra: Record<string, unknown>) =>
    processIntents(baseParams([{ id, type: 'PAY_CASH', payload: { orderId: 'order-1', amountCents: 10000, ...extra } }]))

  it('🔴 con el saldo esperado, payCashOrder lo recibe junto con el aparato del lote', async () => {
    const acks = await cobrar('i-saldo', { expectedBalanceBeforeCents: 12345 })
    expect(acks[0]).toMatchObject({ status: 'ACKED' })
    expect(orderMobileService.payCashOrder).toHaveBeenCalledWith(
      VENUE,
      'order-1',
      expect.objectContaining({ isOfflineReplay: true, saldoEsperadoSinRed: { antesCents: 12345, deviceId: 'device-a' } }),
    )
  })

  it('$0 también es un saldo esperado válido (la tablet creía que ya no debía nada)', async () => {
    await cobrar('i-cero', { expectedBalanceBeforeCents: 0 })
    expect((orderMobileService.payCashOrder as jest.Mock).mock.calls[0][2].saldoEsperadoSinRed).toEqual({
      antesCents: 0,
      deviceId: 'device-a',
    })
  })

  it('sin el campo (apps viejas), payCashOrder recibe exactamente lo de hoy', async () => {
    await cobrar('i-viejo', {})
    expect('saldoEsperadoSinRed' in (orderMobileService.payCashOrder as jest.Mock).mock.calls[0][2]).toBe(false)
  })

  it.each([
    ['negativo', -1],
    ['con fracción de centavo', 100.5],
    ['texto', '12345'],
    ['objeto', { cents: 1 }],
    ['arriba del tope del teclado', 100_000_001],
    ['null', null],
  ])('🔴 un saldo esperado %s se ignora: el cobro se registra igual (ACKED) y sin el dato', async (_caso, valor) => {
    const acks = await cobrar(`i-malo-${String(_caso)}`, { expectedBalanceBeforeCents: valor })
    expect(acks[0]).toMatchObject({ status: 'ACKED' })
    expect(orderMobileService.payCashOrder).toHaveBeenCalledTimes(1)
    expect('saldoEsperadoSinRed' in (orderMobileService.payCashOrder as jest.Mock).mock.calls[0][2]).toBe(false)
  })
})
