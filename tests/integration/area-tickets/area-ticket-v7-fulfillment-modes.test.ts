import {
  AreaTicketDeliveryVerificationMode,
  AreaTicketFulfillmentMethod,
  AreaTicketStatus,
  FulfillmentMode,
  PaymentMethod,
  PaymentSource,
  Prisma,
  StaffRole,
  TerminalStatus,
  TerminalType,
  TransactionStatus,
} from '@prisma/client'

import {
  addTicketToCheckout,
  createAreaTicketCheckout,
  finalizeAreaTicketPaymentInTransaction,
  fulfillAreaTicket,
  issueAreaTicket,
  listPendingAreaTicketFulfillment,
  lockAreaTicketCheckoutForPayment,
  materializeAreaTicketCheckout,
  resolveAreaTicketFulfillment,
  resolveAreaTicketScan,
} from '@/services/mobile/areaTicketV7.mobile.service'
import prisma from '@/utils/prismaClient'

describe('Area tickets v7 — fulfillment modes and delivery verification', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const areaIds = {} as Record<FulfillmentMode, string>
  const issueDeviceUids = {} as Record<FulfillmentMode, string>
  const issueTerminalIds = {} as Record<FulfillmentMode, string>
  const deliveryDeviceUids = {} as Record<FulfillmentMode, string>
  let sequence = 0
  let organizationId: string
  let venueId: string
  let staffId: string
  let productId: string
  let productSku: string
  let checkoutDeviceUid: string

  function key(prefix: string): string {
    sequence += 1
    return `${prefix}-${sequence}-${suffix}`.slice(0, 64)
  }

  beforeAll(async () => {
    const organization = await prisma.organization.create({
      data: {
        name: `Area fulfillment ${suffix}`,
        email: `area-fulfillment-${suffix}@example.com`,
        phone: '5555555555',
      },
    })
    organizationId = organization.id

    const venue = await prisma.venue.create({
      data: {
        organizationId,
        name: `Area fulfillment venue ${suffix}`,
        slug: `area-fulfillment-${suffix}`,
        seatCapExempt: true,
      },
    })
    venueId = venue.id

    const staff = await prisma.staff.create({
      data: {
        email: `area-fulfillment-staff-${suffix}@example.com`,
        firstName: 'Area',
        lastName: 'Fulfillment',
      },
    })
    staffId = staff.id
    await prisma.staffVenue.create({ data: { staffId, venueId, role: StaffRole.MANAGER } })

    for (const mode of Object.values(FulfillmentMode)) {
      const area = await prisma.fulfillmentArea.create({
        data: { venueId, name: `${mode}-${suffix}`, fulfillmentMode: mode },
      })
      areaIds[mode] = area.id
      issueDeviceUids[mode] = `issue-${mode}-${suffix}`
      deliveryDeviceUids[mode] = `delivery-${mode}-${suffix}`

      const issueTerminal = await prisma.terminal.create({
        data: {
          venueId,
          name: `Issue ${mode}`,
          type: TerminalType.POS_ANDROID,
          status: TerminalStatus.ACTIVE,
          deviceUid: issueDeviceUids[mode],
          fulfillmentAreaId: area.id,
          canIssueAreaTickets: true,
        },
      })
      issueTerminalIds[mode] = issueTerminal.id
      await prisma.terminal.create({
        data: {
          venueId,
          name: `Delivery ${mode}`,
          type: TerminalType.POS_ANDROID,
          status: TerminalStatus.ACTIVE,
          deviceUid: deliveryDeviceUids[mode],
          fulfillmentAreaId: area.id,
          canDeliverAreaTickets: true,
        },
      })
    }

    checkoutDeviceUid = `checkout-${suffix}`
    await prisma.terminal.create({
      data: {
        venueId,
        name: 'Checkout',
        type: TerminalType.POS_ANDROID,
        status: TerminalStatus.ACTIVE,
        deviceUid: checkoutDeviceUid,
        canCheckoutAreaTickets: true,
      },
    })
    await prisma.venueAreaTicketSettings.create({
      data: {
        venueId,
        enabled: true,
        deliveryVerificationMode: AreaTicketDeliveryVerificationMode.PAPER_OR_SCAN,
      },
    })

    const category = await prisma.menuCategory.create({
      data: {
        venueId,
        name: `Area fulfillment ${suffix}`,
        slug: `area-fulfillment-${suffix}`,
        availableDays: [],
      },
    })
    const product = await prisma.product.create({
      data: {
        venueId,
        categoryId: category.id,
        sku: `FULFILL-${suffix}`,
        name: 'Producto de vale',
        price: new Prisma.Decimal('10.00'),
        taxRate: new Prisma.Decimal(0),
        tags: [],
        allergens: [],
        trackInventory: false,
      },
    })
    productId = product.id
    productSku = product.sku!
  })

  afterAll(async () => {
    if (!venueId) return
    await prisma.areaTicketFulfillment.deleteMany({ where: { fulfillmentArea: { venueId } } })
    await prisma.areaTicketPrintAttempt.deleteMany({ where: { areaTicket: { venueId } } })
    await prisma.areaTicketPaymentAttempt.deleteMany({ where: { checkoutSession: { venueId } } })
    await prisma.paymentAllocation.deleteMany({ where: { payment: { venueId } } })
    await prisma.payment.deleteMany({ where: { venueId } })
    await prisma.areaTicketInventoryReservation.deleteMany({ where: { venueId } })
    await prisma.orderItemModifier.deleteMany({ where: { orderItem: { order: { venueId } } } })
    await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
    await prisma.areaTicket.deleteMany({ where: { venueId } })
    await prisma.areaTicketCheckoutSession.deleteMany({ where: { venueId } })
    await prisma.order.deleteMany({ where: { venueId } })
    await prisma.product.deleteMany({ where: { venueId } })
    await prisma.menuCategory.deleteMany({ where: { venueId } })
    await prisma.terminal.deleteMany({ where: { venueId } })
    await prisma.fulfillmentArea.deleteMany({ where: { venueId } })
    await prisma.venueAreaTicketSettings.deleteMany({ where: { venueId } })
    await prisma.staffVenue.deleteMany({ where: { venueId } })
    await prisma.venue.delete({ where: { id: venueId } })
    if (staffId) await prisma.staff.delete({ where: { id: staffId } })
    if (organizationId) await prisma.organization.delete({ where: { id: organizationId } })
    await prisma.$disconnect()
  })

  async function materialize(modes: FulfillmentMode[]) {
    const tickets = []
    for (const mode of modes) {
      tickets.push(
        await issueAreaTicket(venueId, {
          idempotencyKey: key('issue'),
          deviceUid: issueDeviceUids[mode],
          staffId,
          lines: [{ clientLineId: key('line'), productId, quantity: '1' }],
        }),
      )
    }
    const checkout = await createAreaTicketCheckout(venueId, {
      idempotencyKey: key('checkout'),
      deviceUid: checkoutDeviceUid,
      staffId,
    })
    for (const ticket of tickets) {
      await addTicketToCheckout(venueId, checkout.id, ticket.code, {
        idempotencyKey: key('claim'),
        deviceUid: checkoutDeviceUid,
        staffId,
      })
    }
    const checkoutResult = await materializeAreaTicketCheckout(venueId, checkout.id, {
      idempotencyKey: key('materialize'),
      deviceUid: checkoutDeviceUid,
      staffId,
      source: 'AVOQADO_ANDROID',
    })
    return { checkout: checkoutResult, tickets }
  }

  async function payInFull(checkout: Awaited<ReturnType<typeof materialize>>['checkout']) {
    const idempotencyKey = key('payment')
    const amount = new Prisma.Decimal(checkout.order.total)
    await prisma.$transaction(async tx => {
      const locked = await lockAreaTicketCheckoutForPayment(tx, {
        venueId,
        orderId: checkout.order.id,
        idempotencyKey,
        amount,
        method: PaymentMethod.CASH,
      })
      const payment = await tx.payment.create({
        data: {
          venueId,
          orderId: checkout.order.id,
          processedById: staffId,
          amount,
          method: PaymentMethod.CASH,
          source: PaymentSource.APP,
          status: TransactionStatus.COMPLETED,
          feePercentage: new Prisma.Decimal(0),
          feeAmount: new Prisma.Decimal(0),
          netAmount: amount,
          idempotencyKey,
        },
      })
      await tx.order.update({
        where: { id: checkout.order.id },
        data: { paidAmount: amount, remainingBalance: new Prisma.Decimal(0), paymentStatus: 'PAID' },
      })
      await finalizeAreaTicketPaymentInTransaction(tx, {
        venueId,
        orderId: checkout.order.id,
        paymentId: payment.id,
        fullyPaid: true,
        staffId,
        locked,
      })
    })
  }

  async function createPaidTicket({
    mode = FulfillmentMode.HOLD_UNTIL_PAID,
    snapshotMode = mode,
    deliveryCode = key('receipt'),
  }: {
    mode?: FulfillmentMode
    snapshotMode?: FulfillmentMode
    deliveryCode?: string
  } = {}) {
    const order = await prisma.order.create({
      data: {
        venueId,
        orderNumber: key('order'),
        status: 'CONFIRMED',
        paymentStatus: 'PAID',
        subtotal: new Prisma.Decimal('10.00'),
        taxAmount: new Prisma.Decimal(0),
        total: new Prisma.Decimal('10.00'),
        paidAmount: new Prisma.Decimal('10.00'),
        remainingBalance: new Prisma.Decimal(0),
        areaDeliveryCode: deliveryCode,
      },
    })
    const ticket = await prisma.areaTicket.create({
      data: {
        venueId,
        fulfillmentAreaId: areaIds[mode],
        fulfillmentModeSnapshot: snapshotMode,
        code: key('ticket'),
        idempotencyKey: key('paid-ticket'),
        status: AreaTicketStatus.PAID,
        sourceTerminalId: issueTerminalIds[mode],
        orderId: order.id,
        subtotal: new Prisma.Decimal('10.00'),
        taxAmount: new Prisma.Decimal(0),
        total: new Prisma.Decimal('10.00'),
        pricingSnapshotHash: '0'.repeat(64),
        paidAt: new Date(),
      },
    })
    return { order, ticket, deliveryCode }
  }

  describe('FulfillmentMode', () => {
    it('no genera código de entrega cuando todos los vales son IMMEDIATE', async () => {
      const { checkout } = await materialize([FulfillmentMode.IMMEDIATE])

      expect(checkout.order.areaDeliveryCode).toBeNull()
    })

    it('entrega automáticamente un vale IMMEDIATE al completar el pago', async () => {
      const { checkout, tickets } = await materialize([FulfillmentMode.IMMEDIATE])

      await payInFull(checkout)

      const paidTicket = await prisma.areaTicket.findUniqueOrThrow({ where: { id: tickets[0].id }, include: { fulfillment: true } })
      expect(paidTicket.status).toBe(AreaTicketStatus.DELIVERED)
      expect(paidTicket.fulfillment).toBeNull()
      const pending = await listPendingAreaTicketFulfillment(venueId, {
        deviceUid: deliveryDeviceUids[FulfillmentMode.IMMEDIATE],
      })
      expect(pending.tickets).toEqual([])
    })

    it('mantiene un vale HOLD_UNTIL_PAID en PAID y pendiente de entrega manual', async () => {
      const { checkout, tickets } = await materialize([FulfillmentMode.HOLD_UNTIL_PAID])
      expect(checkout.order.areaDeliveryCode).toEqual(expect.any(String))

      await payInFull(checkout)

      const paidTicket = await prisma.areaTicket.findUniqueOrThrow({ where: { id: tickets[0].id }, include: { fulfillment: true } })
      expect(paidTicket.status).toBe(AreaTicketStatus.PAID)
      expect(paidTicket.fulfillment).toBeNull()
      const pending = await listPendingAreaTicketFulfillment(venueId, {
        deviceUid: deliveryDeviceUids[FulfillmentMode.HOLD_UNTIL_PAID],
      })
      expect(pending.tickets.map(ticket => ticket.id)).toEqual([tickets[0].id])
    })

    it('en un checkout mixto sólo entrega IMMEDIATE y deja PREPARE_ON_PAID pendiente', async () => {
      const { checkout, tickets } = await materialize([FulfillmentMode.IMMEDIATE, FulfillmentMode.PREPARE_ON_PAID])
      expect(checkout.order.areaDeliveryCode).toEqual(expect.any(String))

      await payInFull(checkout)

      const persisted = await prisma.areaTicket.findMany({
        where: { id: { in: tickets.map(ticket => ticket.id) } },
        select: { id: true, status: true, fulfillmentArea: { select: { fulfillmentMode: true } } },
      })
      expect(Object.fromEntries(persisted.map(ticket => [ticket.fulfillmentArea.fulfillmentMode, ticket.status]))).toEqual({
        [FulfillmentMode.IMMEDIATE]: AreaTicketStatus.DELIVERED,
        [FulfillmentMode.PREPARE_ON_PAID]: AreaTicketStatus.PAID,
      })
      const pending = await listPendingAreaTicketFulfillment(venueId, {
        deviceUid: deliveryDeviceUids[FulfillmentMode.PREPARE_ON_PAID],
      })
      expect(pending.tickets.map(ticket => ticket.id)).toEqual([tickets[1].id])
      expect((await prisma.order.findUniqueOrThrow({ where: { id: checkout.order.id } })).kitchenStatus).toBe('PENDING')
    })

    it('congela IMMEDIATE si el área cambia a HOLD_UNTIL_PAID entre materialización y pago', async () => {
      const { checkout, tickets } = await materialize([FulfillmentMode.IMMEDIATE])
      expect(checkout.order.areaDeliveryCode).toBeNull()
      expect(
        await prisma.areaTicket.findUniqueOrThrow({
          where: { id: tickets[0].id },
          select: { fulfillmentModeSnapshot: true },
        }),
      ).toEqual({ fulfillmentModeSnapshot: FulfillmentMode.IMMEDIATE })

      await prisma.fulfillmentArea.update({
        where: { id: areaIds[FulfillmentMode.IMMEDIATE] },
        data: { fulfillmentMode: FulfillmentMode.HOLD_UNTIL_PAID },
      })
      try {
        await payInFull(checkout)

        const persisted = await prisma.areaTicket.findUniqueOrThrow({ where: { id: tickets[0].id } })
        expect(persisted.status).toBe(AreaTicketStatus.DELIVERED)
      } finally {
        await prisma.fulfillmentArea.update({
          where: { id: areaIds[FulfillmentMode.IMMEDIATE] },
          data: { fulfillmentMode: FulfillmentMode.IMMEDIATE },
        })
      }
    })

    it('congela HOLD_UNTIL_PAID si el área cambia a IMMEDIATE entre materialización y pago', async () => {
      const { checkout, tickets } = await materialize([FulfillmentMode.HOLD_UNTIL_PAID])
      expect(checkout.order.areaDeliveryCode).toEqual(expect.any(String))

      await prisma.fulfillmentArea.update({
        where: { id: areaIds[FulfillmentMode.HOLD_UNTIL_PAID] },
        data: { fulfillmentMode: FulfillmentMode.IMMEDIATE },
      })
      try {
        await payInFull(checkout)

        const persisted = await prisma.areaTicket.findUniqueOrThrow({ where: { id: tickets[0].id } })
        expect(persisted.status).toBe(AreaTicketStatus.PAID)
        const pending = await listPendingAreaTicketFulfillment(venueId, {
          deviceUid: deliveryDeviceUids[FulfillmentMode.HOLD_UNTIL_PAID],
        })
        expect(pending.tickets.map(ticket => ticket.id)).toContain(tickets[0].id)
      } finally {
        await prisma.fulfillmentArea.update({
          where: { id: areaIds[FulfillmentMode.HOLD_UNTIL_PAID] },
          data: { fulfillmentMode: FulfillmentMode.HOLD_UNTIL_PAID },
        })
      }
    })

    it('excluye y rechaza un PAID legacy cuyo snapshot era IMMEDIATE', async () => {
      const { ticket } = await createPaidTicket({ mode: FulfillmentMode.IMMEDIATE })

      const pending = await listPendingAreaTicketFulfillment(venueId, {
        deviceUid: deliveryDeviceUids[FulfillmentMode.IMMEDIATE],
      })
      expect(pending.tickets.map(candidate => candidate.id)).not.toContain(ticket.id)
      await expect(
        fulfillAreaTicket(venueId, ticket.id, {
          idempotencyKey: key('legacy-immediate'),
          deviceUid: deliveryDeviceUids[FulfillmentMode.IMMEDIATE],
          staffId,
          method: AreaTicketFulfillmentMethod.PAPER_CONFIRMATION,
        }),
      ).rejects.toMatchObject({ statusCode: 409, code: 'AREA_TICKET_FULFILLMENT_NOT_REQUIRED' })
      expect(await prisma.areaTicketFulfillment.count({ where: { areaTicketId: ticket.id } })).toBe(0)
    })
  })

  describe('deliveryVerificationMode', () => {
    it.each([
      [AreaTicketDeliveryVerificationMode.PAPER_CONFIRMATION, AreaTicketFulfillmentMethod.PAPER_CONFIRMATION, true],
      [AreaTicketDeliveryVerificationMode.PAPER_CONFIRMATION, AreaTicketFulfillmentMethod.RECEIPT_SCAN, false],
      [AreaTicketDeliveryVerificationMode.RECEIPT_SCAN, AreaTicketFulfillmentMethod.PAPER_CONFIRMATION, false],
      [AreaTicketDeliveryVerificationMode.RECEIPT_SCAN, AreaTicketFulfillmentMethod.RECEIPT_SCAN, true],
      [AreaTicketDeliveryVerificationMode.PAPER_OR_SCAN, AreaTicketFulfillmentMethod.PAPER_CONFIRMATION, true],
      [AreaTicketDeliveryVerificationMode.PAPER_OR_SCAN, AreaTicketFulfillmentMethod.RECEIPT_SCAN, true],
    ])('%s con método %s => permitido=%s', async (verificationMode, method, allowed) => {
      await prisma.venueAreaTicketSettings.update({ where: { venueId }, data: { deliveryVerificationMode: verificationMode } })
      const { ticket } = await createPaidTicket()
      const delivery = fulfillAreaTicket(venueId, ticket.id, {
        idempotencyKey: key('fulfill'),
        deviceUid: deliveryDeviceUids[FulfillmentMode.HOLD_UNTIL_PAID],
        staffId,
        method,
      })

      if (allowed) {
        await expect(delivery).resolves.toMatchObject({ alreadyFulfilled: false, fulfillment: { method } })
      } else {
        await expect(delivery).rejects.toMatchObject({ statusCode: 409, code: 'AREA_TICKET_DELIVERY_METHOD_NOT_ALLOWED' })
        expect((await prisma.areaTicket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe(AreaTicketStatus.PAID)
        expect(await prisma.areaTicketFulfillment.count({ where: { areaTicketId: ticket.id } })).toBe(0)
      }
    })

    it('devuelve el fulfillment existente antes de validar un método ahora deshabilitado', async () => {
      await prisma.venueAreaTicketSettings.update({
        where: { venueId },
        data: { deliveryVerificationMode: AreaTicketDeliveryVerificationMode.PAPER_OR_SCAN },
      })
      const { ticket } = await createPaidTicket()
      const input = {
        idempotencyKey: key('fulfill-idempotent'),
        deviceUid: deliveryDeviceUids[FulfillmentMode.HOLD_UNTIL_PAID],
        staffId,
        method: AreaTicketFulfillmentMethod.RECEIPT_SCAN,
      }
      const first = await fulfillAreaTicket(venueId, ticket.id, input)
      await prisma.venueAreaTicketSettings.update({
        where: { venueId },
        data: { deliveryVerificationMode: AreaTicketDeliveryVerificationMode.PAPER_CONFIRMATION },
      })

      const retried = await fulfillAreaTicket(venueId, ticket.id, input)

      expect(retried).toMatchObject({ alreadyFulfilled: true, fulfillment: { id: first.fulfillment.id } })
    })

    it('rechaza el retry idempotente desde una terminal de otra área', async () => {
      await prisma.venueAreaTicketSettings.update({
        where: { venueId },
        data: { deliveryVerificationMode: AreaTicketDeliveryVerificationMode.PAPER_OR_SCAN },
      })
      const { ticket } = await createPaidTicket()
      const input = {
        idempotencyKey: key('fulfill-own-area'),
        deviceUid: deliveryDeviceUids[FulfillmentMode.HOLD_UNTIL_PAID],
        staffId,
        method: AreaTicketFulfillmentMethod.RECEIPT_SCAN,
      }
      await fulfillAreaTicket(venueId, ticket.id, input)

      await expect(
        fulfillAreaTicket(venueId, ticket.id, {
          ...input,
          idempotencyKey: key('fulfill-wrong-area'),
          deviceUid: deliveryDeviceUids[FulfillmentMode.PREPARE_ON_PAID],
        }),
      ).rejects.toMatchObject({ statusCode: 403, code: 'TERMINAL_AREA_MISMATCH' })
      expect(await prisma.areaTicketFulfillment.count({ where: { areaTicketId: ticket.id } })).toBe(1)
    })

    it('rechaza resolver un comprobante cuando el local sólo permite confirmación en papel', async () => {
      await prisma.venueAreaTicketSettings.update({
        where: { venueId },
        data: { deliveryVerificationMode: AreaTicketDeliveryVerificationMode.PAPER_CONFIRMATION },
      })
      const { deliveryCode } = await createPaidTicket()

      await expect(
        resolveAreaTicketFulfillment(venueId, deliveryCode, deliveryDeviceUids[FulfillmentMode.HOLD_UNTIL_PAID]),
      ).rejects.toMatchObject({ statusCode: 409, code: 'AREA_TICKET_DELIVERY_METHOD_NOT_ALLOWED' })
    })

    it('resuelve un comprobante cuando el local permite escaneo', async () => {
      await prisma.venueAreaTicketSettings.update({
        where: { venueId },
        data: { deliveryVerificationMode: AreaTicketDeliveryVerificationMode.RECEIPT_SCAN },
      })
      const { deliveryCode, ticket } = await createPaidTicket()

      const result = await resolveAreaTicketFulfillment(venueId, deliveryCode, deliveryDeviceUids[FulfillmentMode.HOLD_UNTIL_PAID])

      expect(result.tickets.map(candidate => candidate.id)).toEqual([ticket.id])
    })

    it('rechaza el resolver genérico de escaneo para un comprobante en modo papel', async () => {
      await prisma.venueAreaTicketSettings.update({
        where: { venueId },
        data: { deliveryVerificationMode: AreaTicketDeliveryVerificationMode.PAPER_CONFIRMATION },
      })
      const { deliveryCode } = await createPaidTicket()

      await expect(
        resolveAreaTicketScan(venueId, deliveryCode, 'AREA_DELIVERY', deliveryDeviceUids[FulfillmentMode.HOLD_UNTIL_PAID]),
      ).rejects.toMatchObject({ statusCode: 409, code: 'AREA_TICKET_DELIVERY_METHOD_NOT_ALLOWED' })
    })

    it('una colisión producto/comprobante no invade CHECKOUT ni PRODUCT_LOOKUP', async () => {
      await prisma.venueAreaTicketSettings.update({
        where: { venueId },
        data: { deliveryVerificationMode: AreaTicketDeliveryVerificationMode.PAPER_CONFIRMATION },
      })
      await createPaidTicket({ deliveryCode: productSku })

      for (const context of ['CHECKOUT', 'PRODUCT_LOOKUP'] as const) {
        await expect(resolveAreaTicketScan(venueId, productSku, context, checkoutDeviceUid)).resolves.toMatchObject({
          type: 'PRODUCT',
          product: { id: productId },
        })
      }
    })
  })
})
