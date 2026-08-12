jest.mock('@/services/access/basePlan.service', () => ({
  venueHasFeatureAccess: jest.fn(),
}))

import {
  AreaTicketCheckoutStatus,
  AreaTicketDeliveryVerificationMode,
  AreaTicketFulfillmentMethod,
  AreaTicketPaymentAttemptStatus,
  AreaTicketStatus,
  FulfillmentMode,
  Prisma,
} from '@prisma/client'

import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import {
  finalizeAreaTicketPaymentInTransaction,
  fulfillAreaTicket,
  listPendingAreaTicketFulfillment,
  materializeAreaTicketCheckout,
  resolveAreaTicketFulfillment,
  resolveAreaTicketScan,
} from '@/services/mobile/areaTicketV7.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const venueId = 'venue-fulfillment'
const checkoutDeviceUid = 'checkout-device'
const deliveryDeviceUid = 'delivery-device'
const emptySnapshotHash = '33f4d66fbc9d807862fbd5f70ce55445d0b95e8925bf460c7ad8a2a18e0fc385'
const accessMock = venueHasFeatureAccess as jest.MockedFunction<typeof venueHasFeatureAccess>

function terminal({ areaId, fulfillmentMode }: { areaId?: string; fulfillmentMode?: FulfillmentMode } = {}) {
  const resolvedAreaId = areaId ?? 'area-hold'
  return {
    id: 'terminal-delivery',
    name: 'Entrega',
    fulfillmentAreaId: resolvedAreaId,
    canIssueAreaTickets: false,
    canCheckoutAreaTickets: false,
    canDeliverAreaTickets: true,
    defaultWorkspace: 'AREA_OPERATIONS',
    scaleProfile: null,
    fulfillmentArea: {
      id: resolvedAreaId,
      name: 'Cremería',
      fulfillmentMode: fulfillmentMode ?? FulfillmentMode.HOLD_UNTIL_PAID,
      active: true,
    },
  }
}

function paidTicket(method?: AreaTicketFulfillmentMethod) {
  return {
    id: 'ticket-paid',
    fulfillmentAreaId: 'area-hold',
    fulfillmentModeSnapshot: FulfillmentMode.HOLD_UNTIL_PAID,
    status: AreaTicketStatus.PAID,
    version: 1,
    order: { id: 'order-paid', paymentStatus: 'PAID', status: 'CONFIRMED' },
    fulfillment: method
      ? {
          id: 'fulfillment-existing',
          method,
          deliveredAt: new Date('2026-08-07T12:00:00.000Z'),
          deliveredByStaff: null,
          terminal: { id: 'terminal-delivery', name: 'Entrega' },
        }
      : null,
  }
}

function primeFulfillment(verificationMode: AreaTicketDeliveryVerificationMode) {
  prismaMock.terminal.findFirst.mockResolvedValue(terminal())
  prismaMock.venueAreaTicketSettings.findUnique.mockResolvedValue({ deliveryVerificationMode: verificationMode })
  prismaMock.areaTicket.findFirst.mockResolvedValue(paidTicket())
  prismaMock.areaTicketFulfillment.create.mockImplementation(async ({ data }: any) => ({
    id: 'fulfillment-created',
    ...data,
    deliveredAt: new Date('2026-08-07T12:00:00.000Z'),
    deliveredByStaff: null,
    terminal: { id: 'terminal-delivery', name: 'Entrega' },
  }))
  prismaMock.areaTicket.updateMany.mockResolvedValue({ count: 1 })
}

function primeMaterialization(snapshotMode: FulfillmentMode, currentMode: FulfillmentMode) {
  const now = new Date()
  const ticket = {
    id: 'ticket-materialization',
    code: '9000000000',
    status: AreaTicketStatus.CLAIMED,
    fulfillmentAreaId: 'area-issued',
    fulfillmentModeSnapshot: snapshotMode,
    fulfillmentArea: { id: 'area-issued', name: 'Panadería', fulfillmentMode: currentMode },
    sourceTerminalId: 'terminal-issue',
    sourceTerminal: { id: 'terminal-issue', name: 'Panadería' },
    currency: 'MXN',
    subtotal: new Prisma.Decimal('10.00'),
    discountAmount: new Prisma.Decimal(0),
    taxAmount: new Prisma.Decimal(0),
    total: new Prisma.Decimal('10.00'),
    pricingSnapshotHash: emptySnapshotHash,
    printStatus: 'NOT_PRINTED',
    version: 1,
    issuedAt: now,
    printedAt: null,
    claimedAt: now,
    claimExpiresAt: new Date(now.getTime() + 60_000),
    paidAt: null,
    expiresAt: null,
    orderId: null,
    checkoutSessionId: 'checkout-session',
    lines: [],
    fulfillment: null,
  }
  const session = {
    id: 'checkout-session',
    status: AreaTicketCheckoutStatus.OPEN,
    terminalId: 'terminal-checkout',
    terminal: { id: 'terminal-checkout', name: 'Caja' },
    staffId: null,
    orderId: null,
    order: null,
    materializeIdempotencyKey: null,
    activePaymentAttemptId: null,
    version: 1,
    lastHeartbeatAt: now,
    expiresAt: new Date(now.getTime() + 60_000),
    createdAt: now,
    tickets: [ticket],
    paymentAttempts: [],
  }
  let createdOrder: any
  prismaMock.areaTicketCheckoutSession.findFirst.mockResolvedValue(session)
  prismaMock.terminal.findFirst.mockResolvedValue({
    ...terminal(),
    id: 'terminal-checkout',
    fulfillmentAreaId: null,
    fulfillmentArea: null,
    canCheckoutAreaTickets: true,
    canDeliverAreaTickets: false,
  })
  prismaMock.venueAreaTicketSettings.findUnique.mockResolvedValue({ allowMixedCart: true })
  prismaMock.order.create.mockImplementation(async ({ data }: any) => {
    createdOrder = { id: 'order-created', ...data }
    return createdOrder
  })
  prismaMock.areaTicket.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.areaTicketCheckoutSession.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.areaTicketCheckoutSession.findUniqueOrThrow.mockImplementation(async () => ({
    ...session,
    status: AreaTicketCheckoutStatus.MATERIALIZED,
    orderId: createdOrder.id,
    order: createdOrder,
  }))
  return session
}

describe('AreaTicket v7 fulfillment decisions', () => {
  it('conserva IMMEDIATE al materializar aunque el área cambie a HOLD_UNTIL_PAID', async () => {
    const session = primeMaterialization(FulfillmentMode.IMMEDIATE, FulfillmentMode.HOLD_UNTIL_PAID)

    const result = await materializeAreaTicketCheckout(venueId, session.id, {
      idempotencyKey: 'materialize-immediate',
      deviceUid: checkoutDeviceUid,
    })

    expect(result.order.areaDeliveryCode).toBeNull()
  })

  it('conserva HOLD_UNTIL_PAID al materializar aunque el área cambie a IMMEDIATE', async () => {
    const session = primeMaterialization(FulfillmentMode.HOLD_UNTIL_PAID, FulfillmentMode.IMMEDIATE)

    const result = await materializeAreaTicketCheckout(venueId, session.id, {
      idempotencyKey: 'materialize-hold',
      deviceUid: checkoutDeviceUid,
    })

    expect(result.order.areaDeliveryCode).toEqual(expect.any(String))
  })

  it('usa el snapshot al pagar aunque ambos modos del área cambien en sentido contrario', async () => {
    const statusById: Record<string, AreaTicketStatus> = {
      immediate: AreaTicketStatus.CLAIMED,
      hold: AreaTicketStatus.CLAIMED,
    }
    const snapshotModeById = {
      immediate: FulfillmentMode.IMMEDIATE,
      hold: FulfillmentMode.HOLD_UNTIL_PAID,
    }
    const currentModeById = {
      immediate: FulfillmentMode.HOLD_UNTIL_PAID,
      hold: FulfillmentMode.IMMEDIATE,
    }
    prismaMock.areaTicket.findMany.mockResolvedValue(
      Object.keys(snapshotModeById).map(id => ({
        id,
        fulfillmentModeSnapshot: snapshotModeById[id as keyof typeof snapshotModeById],
        fulfillmentArea: { fulfillmentMode: currentModeById[id as keyof typeof currentModeById] },
      })),
    )
    prismaMock.order.findFirst.mockResolvedValue({ paymentStatus: 'PAID', status: 'CONFIRMED' })
    prismaMock.areaTicketPaymentAttempt.findFirst.mockResolvedValue({
      id: 'attempt',
      status: AreaTicketPaymentAttemptStatus.PENDING,
    })
    prismaMock.areaTicketInventoryReservation.findMany.mockResolvedValue([])
    prismaMock.orderItem.findMany.mockResolvedValue([])
    prismaMock.areaTicket.updateMany.mockImplementation(async ({ where, data }: any) => {
      const ids = where.id?.in ?? Object.keys(statusById)
      let count = 0
      for (const id of ids) {
        if (where.status && statusById[id] !== where.status) continue
        statusById[id] = data.status
        count += 1
      }
      return { count }
    })

    await finalizeAreaTicketPaymentInTransaction(prismaMock, {
      venueId,
      orderId: 'order-paid',
      paymentId: 'payment-paid',
      fullyPaid: true,
      locked: { sessionId: 'checkout-session', attemptId: 'attempt' },
    })

    expect(statusById).toEqual({ immediate: AreaTicketStatus.DELIVERED, hold: AreaTicketStatus.PAID })
  })

  it.each([
    [AreaTicketDeliveryVerificationMode.PAPER_CONFIRMATION, AreaTicketFulfillmentMethod.PAPER_CONFIRMATION, true],
    [AreaTicketDeliveryVerificationMode.PAPER_CONFIRMATION, AreaTicketFulfillmentMethod.RECEIPT_SCAN, false],
    [AreaTicketDeliveryVerificationMode.RECEIPT_SCAN, AreaTicketFulfillmentMethod.PAPER_CONFIRMATION, false],
    [AreaTicketDeliveryVerificationMode.RECEIPT_SCAN, AreaTicketFulfillmentMethod.RECEIPT_SCAN, true],
    [AreaTicketDeliveryVerificationMode.PAPER_OR_SCAN, AreaTicketFulfillmentMethod.PAPER_CONFIRMATION, true],
    [AreaTicketDeliveryVerificationMode.PAPER_OR_SCAN, AreaTicketFulfillmentMethod.RECEIPT_SCAN, true],
  ])('%s con %s => permitido=%s', async (verificationMode, method, allowed) => {
    primeFulfillment(verificationMode)
    const result = fulfillAreaTicket(venueId, 'ticket-paid', {
      idempotencyKey: 'fulfillment-attempt',
      deviceUid: deliveryDeviceUid,
      method,
    })

    if (allowed) {
      await expect(result).resolves.toMatchObject({ alreadyFulfilled: false, fulfillment: { method } })
    } else {
      await expect(result).rejects.toMatchObject({ statusCode: 409, code: 'AREA_TICKET_DELIVERY_METHOD_NOT_ALLOWED' })
    }
  })

  it('preserva un fulfillment idempotente antes del guard de método', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue(terminal())
    prismaMock.areaTicket.findFirst.mockResolvedValue(paidTicket(AreaTicketFulfillmentMethod.RECEIPT_SCAN))
    prismaMock.venueAreaTicketSettings.findUnique.mockRejectedValue(new Error('el guard no debe evaluarse'))

    await expect(
      fulfillAreaTicket(venueId, 'ticket-paid', {
        idempotencyKey: 'same-fulfillment-attempt',
        deviceUid: deliveryDeviceUid,
        method: AreaTicketFulfillmentMethod.RECEIPT_SCAN,
      }),
    ).resolves.toMatchObject({ alreadyFulfilled: true, fulfillment: { id: 'fulfillment-existing' } })
  })

  it('valida el área antes de devolver un fulfillment idempotente', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue(terminal())
    prismaMock.areaTicket.findFirst.mockResolvedValue({
      ...paidTicket(AreaTicketFulfillmentMethod.RECEIPT_SCAN),
      fulfillmentAreaId: 'area-other',
    })

    await expect(
      fulfillAreaTicket(venueId, 'ticket-paid', {
        idempotencyKey: 'wrong-area-retry',
        deviceUid: deliveryDeviceUid,
        method: AreaTicketFulfillmentMethod.RECEIPT_SCAN,
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'TERMINAL_AREA_MISMATCH' })
    expect(prismaMock.venueAreaTicketSettings.findUnique).not.toHaveBeenCalled()
  })

  it('no permite entregar manualmente un PAID cuyo snapshot era IMMEDIATE', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue(terminal({ areaId: 'area-immediate', fulfillmentMode: FulfillmentMode.IMMEDIATE }))
    prismaMock.areaTicket.findFirst.mockResolvedValue({
      ...paidTicket(),
      fulfillmentAreaId: 'area-immediate',
      fulfillmentModeSnapshot: FulfillmentMode.IMMEDIATE,
    })
    prismaMock.venueAreaTicketSettings.findUnique.mockResolvedValue({
      deliveryVerificationMode: AreaTicketDeliveryVerificationMode.PAPER_OR_SCAN,
    })

    await expect(
      fulfillAreaTicket(venueId, 'ticket-paid', {
        idempotencyKey: 'legacy-immediate',
        deviceUid: deliveryDeviceUid,
        method: AreaTicketFulfillmentMethod.PAPER_CONFIRMATION,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'AREA_TICKET_FULFILLMENT_NOT_REQUIRED' })
    expect(prismaMock.areaTicketFulfillment.create).not.toHaveBeenCalled()
  })

  it('excluye snapshots IMMEDIATE del query de pendientes aunque sigan en PAID', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue(terminal({ areaId: 'area-immediate', fulfillmentMode: FulfillmentMode.IMMEDIATE }))
    prismaMock.areaTicket.findMany.mockResolvedValue([])

    await listPendingAreaTicketFulfillment(venueId, { deviceUid: deliveryDeviceUid })

    expect(prismaMock.areaTicket.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          fulfillmentModeSnapshot: { not: FulfillmentMode.IMMEDIATE },
        }),
      }),
    )
  })

  it('rechaza resolver por comprobante cuando sólo permite confirmación en papel', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue(terminal())
    prismaMock.venueAreaTicketSettings.findUnique.mockResolvedValue({
      deliveryVerificationMode: AreaTicketDeliveryVerificationMode.PAPER_CONFIRMATION,
    })
    prismaMock.order.findUnique.mockResolvedValue({
      id: 'order-paid',
      orderNumber: 'ORD-1',
      paymentStatus: 'PAID',
      status: 'CONFIRMED',
      areaDeliveryCode: '8000000000',
      areaTickets: [],
    })

    await expect(resolveAreaTicketFulfillment(venueId, '8000000000', deliveryDeviceUid)).rejects.toMatchObject({
      statusCode: 409,
      code: 'AREA_TICKET_DELIVERY_METHOD_NOT_ALLOWED',
    })
  })

  it('rechaza el resolver genérico de escaneo para un comprobante en modo papel', async () => {
    accessMock.mockResolvedValue(true)
    prismaMock.terminal.findFirst.mockResolvedValue(terminal())
    prismaMock.venueAreaTicketSettings.findUnique.mockResolvedValue({
      enabled: true,
      deliveryVerificationMode: AreaTicketDeliveryVerificationMode.PAPER_CONFIRMATION,
    })
    prismaMock.product.findFirst.mockResolvedValue(null)
    prismaMock.areaTicket.findUnique.mockResolvedValue(null)
    prismaMock.order.findUnique.mockResolvedValue({
      id: 'order-paid',
      orderNumber: 'ORD-1',
      paymentStatus: 'PAID',
      status: 'CONFIRMED',
      areaDeliveryCode: '8000000000',
    })

    await expect(resolveAreaTicketScan(venueId, '8000000000', 'AREA_DELIVERY', deliveryDeviceUid)).rejects.toMatchObject({
      statusCode: 409,
      code: 'AREA_TICKET_DELIVERY_METHOD_NOT_ALLOWED',
    })
  })

  it.each(['CHECKOUT', 'PRODUCT_LOOKUP'] as const)(
    'una colisión producto/comprobante en %s conserva el flujo de producto',
    async context => {
      accessMock.mockResolvedValue(true)
      prismaMock.terminal.findFirst.mockResolvedValue(terminal())
      prismaMock.venueAreaTicketSettings.findUnique.mockResolvedValue({
        enabled: true,
        deliveryVerificationMode: AreaTicketDeliveryVerificationMode.PAPER_CONFIRMATION,
      })
      prismaMock.product.findFirst.mockResolvedValue({
        id: 'product-collision',
        name: 'Producto',
        sku: '8000000000',
        gtin: null,
        soldByWeight: false,
        price: new Prisma.Decimal('10.00'),
      })
      prismaMock.areaTicket.findUnique.mockResolvedValue(null)
      prismaMock.order.findUnique.mockResolvedValue({
        id: 'order-paid',
        orderNumber: 'ORD-1',
        paymentStatus: 'PAID',
        status: 'CONFIRMED',
        areaDeliveryCode: '8000000000',
      })

      await expect(resolveAreaTicketScan(venueId, '8000000000', context, deliveryDeviceUid)).resolves.toMatchObject({
        type: 'PRODUCT',
        product: { id: 'product-collision' },
      })
    },
  )
})
