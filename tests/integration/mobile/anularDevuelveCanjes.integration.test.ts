/**
 * 🔴 LEALTAD (pizarrón hz:a8104ac8:D1, 31-oct). Anular una venta SIN cobrar le devuelve al cliente lo que canjeó en ella: el
 * premio de su cartilla de sellos y sus puntos. Antes la venta quedaba CANCELLED con el premio REDEEMED y los puntos gastados,
 * sin salida desde el mostrador. Anular hace con cada canje lo mismo que «quitar el descuento»: devuelve y la fila sale de la
 * venta, para que el premio y su descuento nunca existan a la vez (Codex r1).
 * Promesa y mapa de entradas: docs/audit/2026-10-31-anular-devuelve-canjes/promesa.md (workspace).
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import {
  applyStampRewardToNewOrder,
  cancelOrder,
  createOrderWithItems,
  ensureStampRewardOnExistingOrder,
  removeOrderDiscount,
} from '@/services/mobile/order.mobile.service'
import { deleteOrder, updateOrder } from '@/services/dashboard/order.dashboard.service'
import { voidItems } from '@/services/tpv/order.tpv.service'
import { redeemPointsToOrder } from '@/services/mobile/loyalty.mobile.service'
import { redeemStampReward } from '@/services/wallet/redeemStampReward.service'
import { AbandonedOrdersCleanupJob } from '@/jobs/abandoned-orders-cleanup.job'
import { cancelAreaTicketCheckout } from '@/services/mobile/areaTicketV7.mobile.service'
import { rejectOnlineOrder } from '@/services/online-ordering/transitions.service'
import * as avisosEnLinea from '@/services/online-ordering/notifications.service'
import { recordOrderPayment } from '@/services/tpv/payment.tpv.service'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => ({ broadcastToVenue: jest.fn(() => true) })) },
}))
jest.mock('@/communication/sockets/managers/socketManager', () => {
  const manager = { broadcastToVenue: jest.fn(), getServer: jest.fn(), getBroadcastingService: jest.fn(() => null) }
  return { __esModule: true, default: manager, socketManager: manager }
})
jest.mock('@/communication/rabbitmq/publisher', () => ({ publishCommand: jest.fn() }))

const venueId = `itest-canjes-${randomUUID()}`
let staffId: string
let productId: string
let cycle = 0

beforeAll(async () => {
  await prisma.organization.create({ data: { id: venueId, name: venueId, email: `${venueId}@test.example`, phone: '5500000000' } })
  await prisma.venue.create({ data: { id: venueId, organizationId: venueId, name: venueId, slug: venueId } })
  staffId = (await prisma.staff.create({ data: { email: `${venueId}@staff.test`, firstName: 'Canjes', lastName: 'Anular' } })).id
  await prisma.staffVenue.create({ data: { venueId, staffId, role: 'MANAGER' } })
  const category = await prisma.menuCategory.create({ data: { venueId, name: 'Catálogo', slug: 'catalogo' } })
  productId = (await prisma.product.create({ data: { venueId, categoryId: category.id, name: 'Café', sku: 'CANJE-1', price: 100 } })).id
  await prisma.loyaltyConfig.create({ data: { venueId, active: true, redemptionRate: 0.01, minPointsRedeem: 100 } })
})

afterAll(async () => {
  if (!venueId) return
  await prisma.inventoryPosting.deleteMany({ where: { venueId } })
  await prisma.commissionCalculation.deleteMany({ where: { venueId } })
  await prisma.payment.deleteMany({ where: { venueId } })
  await prisma.onlineOrder.deleteMany({ where: { venueId } })
  await prisma.areaTicket.deleteMany({ where: { venueId } })
  await prisma.areaTicketCheckoutSession.deleteMany({ where: { venueId } })
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.terminal.deleteMany({ where: { venueId } })
  await prisma.fulfillmentArea.deleteMany({ where: { venueId } })
  await prisma.stampReward.deleteMany({ where: { venueId } })
  await prisma.stampCard.deleteMany({ where: { venueId } })
  await prisma.loyaltyTransaction.deleteMany({ where: { customer: { venueId } } })
  await prisma.activityLog.deleteMany({ where: { venueId } })
  await prisma.customer.deleteMany({ where: { venueId } })
  await prisma.loyaltyConfig.deleteMany({ where: { venueId } })
  await prisma.product.deleteMany({ where: { venueId } })
  await prisma.menuCategory.deleteMany({ where: { venueId } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  await prisma.staff.deleteMany({ where: { id: staffId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: venueId } })
})

async function newCustomer(points = 10_000) {
  return (await prisma.customer.create({ data: { venueId, firstName: 'Cliente', loyaltyPoints: points } })).id
}

async function newOrder(customerId: string, extra: { type?: 'TAKEOUT'; createdAt?: Date } = {}) {
  return (
    await prisma.order.create({
      data: {
        venueId,
        orderNumber: randomUUID(),
        customerId,
        subtotal: 100,
        discountAmount: 0,
        taxAmount: 0,
        total: 100,
        remainingBalance: 100,
        ...extra,
        items: { create: [{ productId, productName: 'Café', quantity: 1, unitPrice: 100, taxAmount: 0, total: 100 }] },
      },
    })
  ).id
}

async function newReward(customerId: string) {
  const card = await prisma.stampCard.create({
    data: { customerId, venueId, cycle: ++cycle, stampsRequired: 1, stampsEarned: 1, completedAt: new Date() },
  })
  const reward = await prisma.stampReward.create({
    data: { stampCardId: card.id, customerId, venueId, rewardType: 'FIXED_AMOUNT', rewardValue: 30, rewardLabel: 'Café gratis' },
  })
  return { rewardId: reward.id, cardId: card.id }
}

/** Un premio canjeado de verdad (la misma función que usa el POS al crear la venta con premio). */
async function withStampReward(orderId: string, customerId: string) {
  const r = await newReward(customerId)
  await redeemStampReward(venueId, orderId, r.rewardId, { staffId })
  return r
}

const reward = (id: string) => prisma.stampReward.findUniqueOrThrow({ where: { id } })
const points = async (customerId: string) => (await prisma.customer.findUniqueOrThrow({ where: { id: customerId } })).loyaltyPoints
const adjustments = (orderId: string) => prisma.loyaltyTransaction.count({ where: { orderId, type: 'ADJUST' } })
const orderOf = (id: string) => prisma.order.findUniqueOrThrow({ where: { id }, include: { orderDiscounts: true } })

async function voidAll(orderId: string) {
  const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } })
  return voidItems(venueId, orderId, { itemIds: o.items.map(i => i.id), reason: 'FULLTEST', staffId, expectedVersion: o.version })
}

const caminos: Array<[string, (orderId: string) => Promise<unknown>]> = [
  ['POS (cancelOrder)', id => cancelOrder(venueId, id, 'FULLTEST', staffId)],
  ['panel: eliminar (deleteOrder)', id => deleteOrder(venueId, id, staffId)],
  ['panel: editar el estado (updateOrder)', id => updateOrder(venueId, id, { status: 'CANCELLED' }, { staffId })],
  ['terminal: anular todos los renglones (voidItems)', voidAll],
]

describe('Anular una venta sin cobrar le devuelve al cliente sus canjes', () => {
  it.each(caminos)('%s: el premio de sellos vuelve a estar por cobrar y su descuento sale de la venta', async (_, anular) => {
    const customerId = await newCustomer()
    const orderId = await newOrder(customerId)
    const { rewardId } = await withStampReward(orderId, customerId)
    expect(await reward(rewardId)).toMatchObject({ status: 'REDEEMED' })

    await anular(orderId)

    const o = await orderOf(orderId)
    expect(o.status).toBe('CANCELLED')
    expect(o.orderDiscounts).toHaveLength(0)
    expect(await reward(rewardId)).toMatchObject({ status: 'PENDING', redeemedAt: null, orderDiscountId: null })
    expect(await prisma.activityLog.count({ where: { venueId, entityId: orderId, action: 'ORDER_CANCEL_LOYALTY_RETURNED' } })).toBe(1)
  })

  it.each(caminos)('%s: los puntos canjeados regresan, una sola vez', async (_, anular) => {
    const customerId = await newCustomer(10_000)
    const orderId = await newOrder(customerId)
    await redeemPointsToOrder(venueId, orderId, customerId, 1_000, staffId)
    expect(await points(customerId)).toBe(9_000)

    await anular(orderId)

    expect(await points(customerId)).toBe(10_000)
    expect(await adjustments(orderId)).toBe(1)
    expect((await orderOf(orderId)).orderDiscounts).toHaveLength(0)
  })

  it('la limpieza automática no borra una venta vacía con canjes: los devuelve y la anula (Codex r1 #3, r2 #2)', async () => {
    const customerId = await newCustomer(10_000)
    // La más vieja de la base: es la primera candidata aunque otras suites tengan las suyas.
    const orderId = await newOrder(customerId, { type: 'TAKEOUT' })
    await redeemPointsToOrder(venueId, orderId, customerId, 1_000, staffId)
    const { rewardId } = await withStampReward(orderId, customerId)
    // Le quitan los renglones (el descuento de CUENTA sobrevive) y queda abandonada.
    await prisma.orderItem.deleteMany({ where: { orderId } })
    const viejo = new Date('1999-01-01T00:00:00Z')
    await prisma.$executeRaw`UPDATE "Order" SET "createdAt" = ${viejo}, "updatedAt" = ${viejo} WHERE id = ${orderId}`

    await new AbandonedOrdersCleanupJob({ lote: 1 }).cleanupNow()

    const o = await orderOf(orderId)
    expect(o.status).toBe('CANCELLED')
    expect(o.orderDiscounts).toHaveLength(0)
    expect(await points(customerId)).toBe(10_000)
    expect(await reward(rewardId)).toMatchObject({ status: 'PENDING', orderDiscountId: null })
  })

  it('anular y luego «quitar el descuento» desde otro aparato no devuelve los puntos dos veces (Codex r1 #1)', async () => {
    const customerId = await newCustomer(10_000)
    const orderId = await newOrder(customerId)
    await redeemPointsToOrder(venueId, orderId, customerId, 1_000, staffId)
    const [fila] = (await orderOf(orderId)).orderDiscounts

    await cancelOrder(venueId, orderId, 'FULLTEST', staffId)
    await expect(removeOrderDiscount(venueId, orderId, fila.id, staffId)).rejects.toThrow()

    expect(await points(customerId)).toBe(10_000)
    expect(await adjustments(orderId)).toBe(1)
  })

  it('repetir la creación con premio después de anular no lo vuelve a quemar (Codex r1 #2)', async () => {
    const customerId = await newCustomer()
    const orderId = await newOrder(customerId)
    const { rewardId } = await withStampReward(orderId, customerId)
    await cancelOrder(venueId, orderId, 'FULLTEST', staffId)

    const intento = await applyStampRewardToNewOrder(venueId, orderId, rewardId, staffId)

    expect(intento.applied).toBe(false)
    expect(await reward(rewardId)).toMatchObject({ status: 'PENDING', orderDiscountId: null })
    expect((await orderOf(orderId)).orderDiscounts).toHaveLength(0)
  })

  it('una venta anulada no acepta canjes de puntos nuevos (Codex r1 #2)', async () => {
    const customerId = await newCustomer(10_000)
    const orderId = await newOrder(customerId)
    await cancelOrder(venueId, orderId, 'FULLTEST', staffId)

    await expect(redeemPointsToOrder(venueId, orderId, customerId, 1_000, staffId)).rejects.toThrow('cancelada')
    expect(await points(customerId)).toBe(10_000)
  })

  it('anular otra vez por el POS (reintento o cola sin red) no devuelve los puntos dos veces', async () => {
    const customerId = await newCustomer(10_000)
    const orderId = await newOrder(customerId)
    await redeemPointsToOrder(venueId, orderId, customerId, 1_000, staffId)

    await cancelOrder(venueId, orderId, 'FULLTEST', staffId)
    await cancelOrder(venueId, orderId, 'FULLTEST reintento', staffId)

    expect(await points(customerId)).toBe(10_000)
    expect(await adjustments(orderId)).toBe(1)
  })

  it('devuelve TODOS los canjes aunque pasen de una página (Codex r2 #3)', async () => {
    const customerId = await newCustomer(0)
    const orderId = await newOrder(customerId)
    const N = 101 // una página es de 100
    for (let i = 0; i < N; i++) {
      const tx = await prisma.loyaltyTransaction.create({ data: { customerId, type: 'REDEEM', points: -10, orderId } })
      await prisma.orderDiscount.create({
        data: { orderId, type: 'FIXED_AMOUNT', name: 'Recompensa', value: 0.1, amount: 0.1, isManual: true, loyaltyTransactionId: tx.id },
      })
    }

    await cancelOrder(venueId, orderId, 'FULLTEST', staffId)

    expect(await points(customerId)).toBe(N * 10)
    expect(await adjustments(orderId)).toBe(N)
    expect((await orderOf(orderId)).orderDiscounts).toHaveLength(0)
  })

  it('si una devolución dejó la cartilla incompleta, el premio se cancela y la cartilla se reabre (D3, «como Square»)', async () => {
    const customerId = await newCustomer()
    const orderId = await newOrder(customerId)
    const { rewardId, cardId } = await withStampReward(orderId, customerId)
    await prisma.stampCard.update({ where: { id: cardId }, data: { stampsEarned: 0 } })

    await cancelOrder(venueId, orderId, 'FULLTEST', staffId)

    expect(await reward(rewardId)).toMatchObject({ status: 'CANCELLED', orderDiscountId: null })
    expect((await prisma.stampCard.findUniqueOrThrow({ where: { id: cardId } })).completedAt).toBeNull()
  })

  it('la venta anulada queda calculada SIN el canje: un cobro tardío que la reviva ve el precio completo (Codex r1 #4)', async () => {
    const customerId = await newCustomer()
    const orderId = await newOrder(customerId)
    await withStampReward(orderId, customerId)
    expect(Number((await orderOf(orderId)).total)).toBe(70)

    await cancelOrder(venueId, orderId, 'FULLTEST', staffId)

    const o = await orderOf(orderId)
    expect(Number(o.discountAmount)).toBe(0)
    expect(Number(o.total)).toBe(100)
  })

  it('vales: cancelar la venta de vales libera sus vales y devuelve puntos y premio UNA vez, aunque se reintente (Codex código r1 y r2)', async () => {
    const customerId = await newCustomer(10_000)
    const orderId = await newOrder(customerId)
    await redeemPointsToOrder(venueId, orderId, customerId, 1_000, staffId)
    const { rewardId } = await withStampReward(orderId, customerId)
    const deviceUid = `canjes-uid-${randomUUID().slice(0, 8)}`
    const area = await prisma.fulfillmentArea.create({ data: { venueId, name: `Cremería ${randomUUID().slice(0, 6)}` } })
    const terminal = await prisma.terminal.create({
      data: {
        venueId,
        name: 'caja de vales',
        serialNumber: `canjes-${randomUUID().slice(0, 8)}`,
        type: 'TPV_ANDROID',
        deviceUid,
        canCheckoutAreaTickets: true,
      } as never,
    })
    const sesion = await prisma.areaTicketCheckoutSession.create({
      data: {
        venueId,
        terminalId: terminal.id,
        idempotencyKey: randomUUID(),
        expiresAt: new Date(Date.now() + 3_600_000),
        orderId,
        status: 'MATERIALIZED',
      } as never,
    })
    // Un vale tomado por esta venta (CLAIMED), como lo deja escanearlo en la caja.
    const vale = await prisma.areaTicket.create({
      data: {
        venueId,
        fulfillmentAreaId: area.id,
        fulfillmentModeSnapshot: 'HOLD_UNTIL_PAID',
        code: `V-${randomUUID().slice(0, 8)}`,
        idempotencyKey: randomUUID(),
        status: 'CLAIMED',
        sourceTerminalId: terminal.id,
        checkoutSessionId: sesion.id,
        claimedAt: new Date(),
        subtotal: 100,
        taxAmount: 0,
        total: 100,
        pricingSnapshotHash: 'x'.repeat(64),
      },
    })
    const llave = randomUUID()

    await cancelAreaTicketCheckout(venueId, sesion.id, { idempotencyKey: llave, deviceUid } as never)
    // El POS perdió la respuesta y reintenta con la MISMA llave: responde lo mismo y no vuelve a devolver.
    await cancelAreaTicketCheckout(venueId, sesion.id, { idempotencyKey: llave, deviceUid } as never)
    // Otra llave sobre la venta ya cancelada: responde la venta cancelada (como hoy) y tampoco devuelve otra vez.
    await expect(cancelAreaTicketCheckout(venueId, sesion.id, { idempotencyKey: randomUUID(), deviceUid } as never)).resolves.toMatchObject(
      {
        status: 'CANCELLED',
      },
    )

    const o = await orderOf(orderId)
    expect(o.status).toBe('CANCELLED')
    expect(o.orderDiscounts).toHaveLength(0)
    expect(await points(customerId)).toBe(10_000)
    expect(await adjustments(orderId)).toBe(1)
    expect(await reward(rewardId)).toMatchObject({ status: 'PENDING', orderDiscountId: null })
    expect(await prisma.areaTicket.findUniqueOrThrow({ where: { id: vale.id } })).toMatchObject({
      status: 'ISSUED',
      checkoutSessionId: null,
    })
    expect(await prisma.activityLog.count({ where: { venueId, entityId: orderId, action: 'ORDER_CANCEL_LOYALTY_RETURNED' } })).toBe(1)
  })

  describe('pedidos en línea', () => {
    beforeEach(() => jest.spyOn(avisosEnLinea, 'notifyOrderEvent').mockResolvedValue(undefined))

    async function pedidoEnLinea(status: 'PENDING_ACCEPTANCE' | 'ACCEPTED' = 'PENDING_ACCEPTANCE') {
      const customerId = await newCustomer(10_000)
      const orderId = await newOrder(customerId)
      await redeemPointsToOrder(venueId, orderId, customerId, 1_000, staffId)
      const { rewardId } = await withStampReward(orderId, customerId)
      await prisma.onlineOrder.create({
        data: {
          orderId,
          venueId,
          status,
          paymentMode: 'PAY_AT_PICKUP',
          trackingToken: randomUUID(),
          acceptDeadlineAt: new Date(Date.now() + 3_600_000),
        },
      })
      return { customerId, orderId, rewardId }
    }

    it('rechazar el pedido anula la venta y devuelve sus canjes (Codex código r1)', async () => {
      const { customerId, orderId, rewardId } = await pedidoEnLinea()

      await expect(rejectOnlineOrder({ venueId, orderId, staffId: null, reason: 'TOO_BUSY' })).resolves.toMatchObject({ outcome: 'OK' })

      expect((await orderOf(orderId)).status).toBe('CANCELLED')
      expect(await points(customerId)).toBe(10_000)
      expect(await reward(rewardId)).toMatchObject({ status: 'PENDING', orderDiscountId: null })
    })

    it('si el pedido ya cambió (STALE), la venta y sus canjes quedan como estaban', async () => {
      const { customerId, orderId, rewardId } = await pedidoEnLinea('ACCEPTED')

      await expect(rejectOnlineOrder({ venueId, orderId, staffId: null, reason: 'TOO_BUSY' })).resolves.toMatchObject({ outcome: 'STALE' })

      expect((await orderOf(orderId)).orderDiscounts).toHaveLength(2)
      expect(await points(customerId)).toBe(9_000)
      expect(await reward(rewardId)).toMatchObject({ status: 'REDEEMED' })
    })

    it('si gana el CAS pero la venta no se puede anular (OrderNotWritten), la reversión deja canjes, descuentos y bitácora como estaban (Codex código r2)', async () => {
      const { customerId, orderId, rewardId } = await pedidoEnLinea()
      // La cuenta ya se cerró sin dinero (p. ej. una cortesía): la regla no la cancela y la transacción se revierte entera.
      await prisma.order.update({ where: { id: orderId }, data: { status: 'COMPLETED' } })

      await expect(rejectOnlineOrder({ venueId, orderId, staffId: null, reason: 'TOO_BUSY' })).resolves.toMatchObject({ outcome: 'STALE' })

      const o = await orderOf(orderId)
      expect(o.status).toBe('COMPLETED')
      expect(o.orderDiscounts).toHaveLength(2)
      expect(await points(customerId)).toBe(9_000)
      expect(await adjustments(orderId)).toBe(0)
      expect(await reward(rewardId)).toMatchObject({ status: 'REDEEMED' })
      expect(await prisma.activityLog.count({ where: { venueId, entityId: orderId, action: 'ORDER_CANCEL_LOYALTY_RETURNED' } })).toBe(0)
      expect((await prisma.onlineOrder.findUniqueOrThrow({ where: { orderId } })).status).toBe('PENDING_ACCEPTANCE')
    })

    it('si la cuenta ya tiene dinero (HAS_PAYMENTS), la venta y sus canjes quedan como estaban', async () => {
      const { customerId, orderId, rewardId } = await pedidoEnLinea()
      await prisma.order.update({ where: { id: orderId }, data: { paymentStatus: 'PARTIAL', paidAmount: 10 } })

      await expect(rejectOnlineOrder({ venueId, orderId, staffId: null, reason: 'TOO_BUSY' })).resolves.toMatchObject({
        outcome: 'HAS_PAYMENTS',
      })

      expect((await orderOf(orderId)).orderDiscounts).toHaveLength(2)
      expect(await points(customerId)).toBe(9_000)
      expect(await reward(rewardId)).toMatchObject({ status: 'REDEEMED' })
    })
  })

  it('cobro tardío de verdad: $70 de tarjeta ya capturados reabren la venta de $100 y queda debiendo $30, sin otra devolución (Codex r1 #4)', async () => {
    const customerId = await newCustomer()
    const orderId = await newOrder(customerId)
    const { rewardId } = await withStampReward(orderId, customerId)
    expect(Number((await orderOf(orderId)).total)).toBe(70)
    await cancelOrder(venueId, orderId, 'FULLTEST', staffId)

    await recordOrderPayment(
      venueId,
      orderId,
      {
        venueId,
        amount: 7000,
        tip: 0,
        status: 'COMPLETED',
        method: 'CREDIT_CARD',
        source: 'TPV',
        splitType: 'CUSTOMAMOUNT',
        tpvId: venueId,
        staffId,
        paidProductsId: [],
        idempotencyKey: randomUUID(),
        currency: 'MXN',
        isInternational: false,
        authorizationNumber: 'TEST-AUTH-ONLY',
        referenceNumber: randomUUID(),
        typeOfCard: 'CREDIT',
      } as never,
      staffId,
    )

    const o = await orderOf(orderId)
    expect(o.status).not.toBe('CANCELLED')
    expect(Number(o.total)).toBe(100)
    expect(Number(o.remainingBalance)).toBe(30)
    expect(await reward(rewardId)).toMatchObject({ status: 'PENDING', orderDiscountId: null })
    expect(await prisma.activityLog.count({ where: { venueId, entityId: orderId, action: 'ORDER_CANCEL_LOYALTY_RETURNED' } })).toBe(1)
  })

  it('terminal con un cargo fijo: anular todo deja total, saldo, impuesto y cargo en cero, y la versión que responde es la guardada (Codex r2 #1)', async () => {
    const customerId = await newCustomer(10_000)
    const orderId = await newOrder(customerId)
    await prisma.orderServiceCharge.create({ data: { orderId, name: 'Servicio', type: 'FIXED_AMOUNT', value: 15, amount: 15 } })
    await prisma.order.update({ where: { id: orderId }, data: { serviceChargeAmount: 15, total: 115, remainingBalance: 115 } })
    await redeemPointsToOrder(venueId, orderId, customerId, 1_000, staffId)

    const respuesta = await voidAll(orderId)

    const o = await orderOf(orderId)
    expect(o.status).toBe('CANCELLED')
    expect([Number(o.total), Number(o.remainingBalance), Number(o.taxAmount), Number(o.serviceChargeAmount)]).toEqual([0, 0, 0, 0])
    expect(respuesta.version).toBe(o.version)
    expect(await points(customerId)).toBe(10_000)
  })

  it('limpieza y luego el reintento de la creación (misma externalId): la encuentra anulada y no vuelve a quemar el premio (Codex r2 #2)', async () => {
    const customerId = await newCustomer()
    const orderId = await newOrder(customerId, { type: 'TAKEOUT' })
    const externalId = `ext-${randomUUID()}`
    await prisma.order.update({ where: { id: orderId }, data: { externalId } })
    const { rewardId } = await withStampReward(orderId, customerId)
    await prisma.orderItem.deleteMany({ where: { orderId } })
    const viejo = new Date('1999-01-02T00:00:00Z')
    await prisma.$executeRaw`UPDATE "Order" SET "createdAt" = ${viejo}, "updatedAt" = ${viejo} WHERE id = ${orderId}`
    await new AbandonedOrdersCleanupJob({ lote: 1 }).cleanupNow()

    // El POS reenvía la creación original (misma externalId, mismo premio) por el camino público.
    const reintento = await createOrderWithItems(venueId, {
      staffId,
      externalId,
      source: 'AVOQADO_ANDROID',
      orderType: 'TAKEOUT',
      stampRewardId: rewardId,
      items: [{ productId, quantity: 1 }],
    } as never)

    expect(reintento).toMatchObject({ id: orderId, stampReward: { applied: false } })
    expect(await prisma.order.count({ where: { venueId, externalId } })).toBe(1)
    expect((await orderOf(orderId)).status).toBe('CANCELLED')
    expect(await reward(rewardId)).toMatchObject({ status: 'PENDING', orderDiscountId: null })
    // El ayudante del reintento, directo: tampoco lo quema.
    expect((await ensureStampRewardOnExistingOrder(venueId, orderId, rewardId, staffId)).applied).toBe(false)
  })

  // Regresión: lo de siempre sigue igual.
  it('una venta sin canjes se anula como hoy, sin movimientos de lealtad ni bitácora de canjes', async () => {
    const customerId = await newCustomer(10_000)
    const orderId = await newOrder(customerId)

    await cancelOrder(venueId, orderId, 'FULLTEST', staffId)

    expect((await orderOf(orderId)).status).toBe('CANCELLED')
    expect(await points(customerId)).toBe(10_000)
    expect(await prisma.loyaltyTransaction.count({ where: { orderId } })).toBe(0)
    expect(await prisma.activityLog.count({ where: { venueId, entityId: orderId, action: 'ORDER_CANCEL_LOYALTY_RETURNED' } })).toBe(0)
  })

  it('un descuento normal (no canje) se queda en la venta anulada como historia', async () => {
    const customerId = await newCustomer(10_000)
    const orderId = await newOrder(customerId)
    await prisma.orderDiscount.create({ data: { orderId, type: 'FIXED_AMOUNT', name: 'Cortesía', value: 10, amount: 10, isManual: true } })
    await redeemPointsToOrder(venueId, orderId, customerId, 1_000, staffId)

    await cancelOrder(venueId, orderId, 'FULLTEST', staffId)

    const o = await orderOf(orderId)
    expect(o.orderDiscounts.map(d => d.name)).toEqual(['Cortesía'])
    expect(await points(customerId)).toBe(10_000)
  })
})
