import {
  AreaTicketFulfillmentMethod,
  AreaTicketInventoryReservationMode,
  AreaTicketInventoryReservationStatus,
  AreaTicketStatus,
  InventoryMethod,
  PaymentMethod,
  PaymentSource,
  Prisma,
  StaffRole,
  TerminalStatus,
  TerminalType,
  TransactionStatus,
  Unit,
} from '@prisma/client'

import {
  addTicketToCheckout,
  createAreaTicketCheckout,
  finalizeAreaTicketPaymentInTransaction,
  fulfillAreaTicket,
  issueAreaTicket,
  lockAreaTicketCheckoutForPayment,
  materializeAreaTicketCheckout,
  resolveAreaTicketFulfillment,
} from '@/services/mobile/areaTicketV7.mobile.service'
import { payCashOrder } from '@/services/mobile/order.mobile.service'
import prisma from '@/utils/prismaClient'

describe('Area tickets v7 — PostgreSQL state machine', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let organizationId: string
  let venueId: string
  let staffId: string
  let areaId: string
  let productId: string
  let normalProductId: string
  let inventoryId: string
  let issueDeviceUid: string
  let checkoutDeviceUidA: string
  let checkoutDeviceUidB: string
  let deliveryDeviceUid: string

  beforeAll(async () => {
    const organization = await prisma.organization.create({
      data: {
        name: `Area tickets integration ${suffix}`,
        email: `area-tickets-${suffix}@example.com`,
        phone: '5555555555',
      },
    })
    organizationId = organization.id

    const venue = await prisma.venue.create({
      data: {
        organizationId,
        name: `Area tickets venue ${suffix}`,
        slug: `area-tickets-${suffix}`,
        seatCapExempt: true,
      },
    })
    venueId = venue.id

    const staff = await prisma.staff.create({
      data: {
        email: `area-tickets-staff-${suffix}@example.com`,
        firstName: 'Area',
        lastName: 'Tester',
      },
    })
    staffId = staff.id
    await prisma.staffVenue.create({
      data: { staffId, venueId, role: StaffRole.MANAGER },
    })

    const area = await prisma.fulfillmentArea.create({
      data: {
        venueId,
        name: `Cremería ${suffix}`,
        fulfillmentMode: 'HOLD_UNTIL_PAID',
      },
    })
    areaId = area.id

    issueDeviceUid = `issue-${suffix}`
    checkoutDeviceUidA = `checkout-a-${suffix}`
    checkoutDeviceUidB = `checkout-b-${suffix}`
    deliveryDeviceUid = `delivery-${suffix}`
    await prisma.terminal.createMany({
      data: [
        {
          venueId,
          name: 'Cremería',
          type: TerminalType.POS_ANDROID,
          status: TerminalStatus.ACTIVE,
          deviceUid: issueDeviceUid,
          fulfillmentAreaId: areaId,
          canIssueAreaTickets: true,
        },
        {
          venueId,
          name: 'Caja A',
          type: TerminalType.POS_ANDROID,
          status: TerminalStatus.ACTIVE,
          deviceUid: checkoutDeviceUidA,
          canCheckoutAreaTickets: true,
        },
        {
          venueId,
          name: 'Caja B',
          type: TerminalType.POS_IOS,
          status: TerminalStatus.ACTIVE,
          deviceUid: checkoutDeviceUidB,
          canCheckoutAreaTickets: true,
        },
        {
          venueId,
          name: 'Entrega cremería',
          type: TerminalType.POS_ANDROID,
          status: TerminalStatus.ACTIVE,
          deviceUid: deliveryDeviceUid,
          fulfillmentAreaId: areaId,
          canDeliverAreaTickets: true,
        },
      ],
    })

    await prisma.venueAreaTicketSettings.create({
      data: {
        venueId,
        enabled: true,
        inventoryReservationMode: AreaTicketInventoryReservationMode.HOLD_AVAILABLE_STOCK,
      },
    })

    const category = await prisma.menuCategory.create({
      data: {
        venueId,
        name: 'Cremería',
        slug: `cremeria-${suffix}`,
        availableDays: [],
      },
    })
    const product = await prisma.product.create({
      data: {
        venueId,
        categoryId: category.id,
        sku: `JAMON-${suffix}`,
        name: 'Jamón por kilo',
        price: new Prisma.Decimal('164.00'),
        taxRate: new Prisma.Decimal(0),
        tags: [],
        allergens: [],
        soldByWeight: true,
        trackInventory: true,
        inventoryMethod: InventoryMethod.QUANTITY,
        unit: Unit.KILOGRAM,
      },
    })
    productId = product.id
    const normalProduct = await prisma.product.create({
      data: {
        venueId,
        categoryId: category.id,
        sku: `PAPAS-${suffix}`,
        name: 'Papas de caja',
        price: new Prisma.Decimal('15.00'),
        taxRate: new Prisma.Decimal(0),
        tags: [],
        allergens: [],
        soldByWeight: false,
        trackInventory: false,
        inventoryMethod: InventoryMethod.QUANTITY,
        unit: Unit.PIECE,
      },
    })
    normalProductId = normalProduct.id
    const inventory = await prisma.inventory.create({
      data: {
        venueId,
        productId,
        currentStock: new Prisma.Decimal('10.000'),
      },
    })
    inventoryId = inventory.id
  })

  afterAll(async () => {
    if (!venueId) return
    await prisma.areaTicketFulfillment.deleteMany({ where: { fulfillmentArea: { venueId } } })
    await prisma.areaTicketPrintAttempt.deleteMany({ where: { areaTicket: { venueId } } })
    await prisma.areaTicketPaymentAttempt.deleteMany({ where: { checkoutSession: { venueId } } })
    await prisma.paymentAllocation.deleteMany({ where: { payment: { venueId } } })
    await prisma.payment.deleteMany({ where: { venueId } })
    await prisma.inventoryMovement.deleteMany({ where: { inventory: { venueId } } })
    await prisma.areaTicketInventoryReservation.deleteMany({ where: { venueId } })
    await prisma.orderItemModifier.deleteMany({ where: { orderItem: { order: { venueId } } } })
    await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
    await prisma.areaTicket.deleteMany({ where: { venueId } })
    await prisma.areaTicketCheckoutSession.deleteMany({ where: { venueId } })
    await prisma.order.deleteMany({ where: { venueId } })
    await prisma.inventory.deleteMany({ where: { venueId } })
    await prisma.product.deleteMany({ where: { venueId } })
    await prisma.menuCategory.deleteMany({ where: { venueId } })
    await prisma.terminal.deleteMany({ where: { venueId } })
    await prisma.fulfillmentArea.deleteMany({ where: { venueId } })
    await prisma.venueAreaTicketSettings.deleteMany({ where: { venueId } })
    await prisma.venueScaleSettings.deleteMany({ where: { venueId } })
    await prisma.staffVenue.deleteMany({ where: { venueId } })
    await prisma.venue.delete({ where: { id: venueId } })
    if (staffId) await prisma.staff.delete({ where: { id: staffId } })
    if (organizationId) await prisma.organization.delete({ where: { id: organizationId } })
    await prisma.$disconnect()
  })

  it('emite sin crear Order, resuelve la carrera de claims y consume inventario sólo al pago total', async () => {
    const ticket = await issueAreaTicket(venueId, {
      idempotencyKey: `issue-${suffix}`,
      deviceUid: issueDeviceUid,
      staffId,
      lines: [
        {
          clientLineId: `line-${suffix}`,
          productId,
          quantity: '1',
          weightKg: '0.224',
        },
      ],
    })
    const duplicate = await issueAreaTicket(venueId, {
      idempotencyKey: `issue-${suffix}`,
      deviceUid: issueDeviceUid,
      staffId,
      lines: [
        {
          clientLineId: `line-${suffix}`,
          productId,
          quantity: '1',
          weightKg: '0.224',
        },
      ],
    })

    expect(duplicate.id).toBe(ticket.id)
    await expect(
      issueAreaTicket(venueId, {
        idempotencyKey: `issue-${suffix}`,
        deviceUid: issueDeviceUid,
        staffId,
        lines: [
          {
            clientLineId: `line-${suffix}`,
            productId,
            quantity: '1',
            weightKg: '0.225',
          },
        ],
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'AREA_TICKET_IDEMPOTENCY_CONFLICT',
    })
    expect(ticket.total).toBe('36.74')
    expect(await prisma.order.count({ where: { venueId } })).toBe(0)
    expect(
      await prisma.areaTicketInventoryReservation.count({
        where: {
          areaTicketId: ticket.id,
          status: AreaTicketInventoryReservationStatus.ACTIVE,
        },
      }),
    ).toBe(1)

    const [checkoutA, checkoutB] = await Promise.all([
      createAreaTicketCheckout(venueId, {
        idempotencyKey: `checkout-a-${suffix}`,
        deviceUid: checkoutDeviceUidA,
        staffId,
      }),
      createAreaTicketCheckout(venueId, {
        idempotencyKey: `checkout-b-${suffix}`,
        deviceUid: checkoutDeviceUidB,
        staffId,
      }),
    ])
    const claims = await Promise.allSettled([
      addTicketToCheckout(venueId, checkoutA.id, ticket.code, {
        idempotencyKey: `claim-a-${suffix}`,
        deviceUid: checkoutDeviceUidA,
        staffId,
      }),
      addTicketToCheckout(venueId, checkoutB.id, ticket.code, {
        idempotencyKey: `claim-b-${suffix}`,
        deviceUid: checkoutDeviceUidB,
        staffId,
      }),
    ])
    expect(claims.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(claims.filter(result => result.status === 'rejected')).toHaveLength(1)
    const rejectedClaim = claims.find(result => result.status === 'rejected') as PromiseRejectedResult
    expect(rejectedClaim.reason).toMatchObject({
      statusCode: 409,
      code: 'AREA_TICKET_ALREADY_CLAIMED',
    })

    const winningCheckout =
      claims[0].status === 'fulfilled'
        ? { session: claims[0].value, deviceUid: checkoutDeviceUidA }
        : { session: (claims[1] as PromiseFulfilledResult<any>).value, deviceUid: checkoutDeviceUidB }

    const materialized = await materializeAreaTicketCheckout(venueId, winningCheckout.session.id, {
      idempotencyKey: `materialize-${suffix}`,
      deviceUid: winningCheckout.deviceUid,
      staffId,
      source: 'AVOQADO_ANDROID',
      normalItems: [{ productId: normalProductId, quantity: 1 }],
    })
    expect(materialized.order.total).toBe('51.74')
    expect(materialized.tickets).toHaveLength(1)
    const materializedItems = await prisma.orderItem.findMany({
      where: { orderId: materialized.order.id },
      select: { areaTicketLineId: true, fulfillmentAreaId: true, productId: true },
    })
    expect(materializedItems).toHaveLength(2)
    expect(materializedItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          areaTicketLineId: expect.any(String),
          fulfillmentAreaId: areaId,
          productId,
        }),
        expect.objectContaining({
          areaTicketLineId: null,
          fulfillmentAreaId: null,
          productId: normalProductId,
        }),
      ]),
    )

    const firstAmount = new Prisma.Decimal('10.00')
    const firstLocked = await prisma.$transaction(tx =>
      lockAreaTicketCheckoutForPayment(tx, {
        venueId,
        orderId: materialized.order.id,
        idempotencyKey: `payment-1-${suffix}`,
        amount: firstAmount,
        method: PaymentMethod.CASH,
      }),
    )
    const firstPayment = await prisma.payment.create({
      data: {
        venueId,
        orderId: materialized.order.id,
        processedById: staffId,
        amount: firstAmount,
        method: PaymentMethod.CASH,
        source: PaymentSource.APP,
        status: TransactionStatus.COMPLETED,
        feePercentage: new Prisma.Decimal(0),
        feeAmount: new Prisma.Decimal(0),
        netAmount: firstAmount,
        idempotencyKey: `payment-1-${suffix}`,
      },
    })
    await prisma.order.update({
      where: { id: materialized.order.id },
      data: {
        paidAmount: firstAmount,
        remainingBalance: new Prisma.Decimal('41.74'),
        paymentStatus: 'PARTIAL',
      },
    })
    await prisma.$transaction(tx =>
      finalizeAreaTicketPaymentInTransaction(tx, {
        venueId,
        orderId: materialized.order.id,
        paymentId: firstPayment.id,
        fullyPaid: false,
        staffId,
        locked: firstLocked,
      }),
    )
    expect(
      await prisma.areaTicketInventoryReservation.count({
        where: { areaTicketId: ticket.id, status: AreaTicketInventoryReservationStatus.ACTIVE },
      }),
    ).toBe(1)

    const remainder = new Prisma.Decimal('41.74')
    const secondLocked = await prisma.$transaction(tx =>
      lockAreaTicketCheckoutForPayment(tx, {
        venueId,
        orderId: materialized.order.id,
        idempotencyKey: `payment-2-${suffix}`,
        amount: remainder,
        method: PaymentMethod.CASH,
      }),
    )
    const secondPayment = await prisma.payment.create({
      data: {
        venueId,
        orderId: materialized.order.id,
        processedById: staffId,
        amount: remainder,
        method: PaymentMethod.CASH,
        source: PaymentSource.APP,
        status: TransactionStatus.COMPLETED,
        feePercentage: new Prisma.Decimal(0),
        feeAmount: new Prisma.Decimal(0),
        netAmount: remainder,
        idempotencyKey: `payment-2-${suffix}`,
      },
    })
    await prisma.order.update({
      where: { id: materialized.order.id },
      data: {
        paidAmount: new Prisma.Decimal('51.74'),
        remainingBalance: new Prisma.Decimal(0),
        paymentStatus: 'PAID',
      },
    })
    await prisma.$transaction(tx =>
      finalizeAreaTicketPaymentInTransaction(tx, {
        venueId,
        orderId: materialized.order.id,
        paymentId: secondPayment.id,
        fullyPaid: true,
        staffId,
        locked: secondLocked,
      }),
    )

    const [paidTicket, inventory, reservation, movements] = await Promise.all([
      prisma.areaTicket.findUniqueOrThrow({ where: { id: ticket.id } }),
      prisma.inventory.findUniqueOrThrow({ where: { id: inventoryId } }),
      prisma.areaTicketInventoryReservation.findFirstOrThrow({ where: { areaTicketId: ticket.id } }),
      prisma.inventoryMovement.findMany({ where: { inventoryId } }),
    ])
    expect(paidTicket.status).toBe(AreaTicketStatus.PAID)
    expect(inventory.currentStock.toFixed(3)).toBe('9.776')
    expect(reservation.status).toBe(AreaTicketInventoryReservationStatus.CONSUMED)
    expect(movements).toHaveLength(1)

    const resolved = await resolveAreaTicketFulfillment(venueId, materialized.order.areaDeliveryCode, deliveryDeviceUid)
    expect(resolved.tickets.map(candidate => candidate.id)).toEqual([ticket.id])

    const firstDelivery = await fulfillAreaTicket(venueId, ticket.id, {
      idempotencyKey: `deliver-${suffix}`,
      deviceUid: deliveryDeviceUid,
      staffId,
      method: AreaTicketFulfillmentMethod.PAPER_CONFIRMATION,
    })
    const repeatedDelivery = await fulfillAreaTicket(venueId, ticket.id, {
      idempotencyKey: `deliver-retry-${suffix}`,
      deviceUid: deliveryDeviceUid,
      staffId,
      method: AreaTicketFulfillmentMethod.PAPER_CONFIRMATION,
    })
    expect(firstDelivery.fulfillment.id).toBe(repeatedDelivery.fulfillment.id)
    expect(await prisma.areaTicketFulfillment.count({ where: { areaTicketId: ticket.id } })).toBe(1)
    expect((await prisma.areaTicket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe(AreaTicketStatus.DELIVERED)
  })

  it('payCashOrder persiste el paidAmount acumulado de una orden materializada', async () => {
    const ticket = await issueAreaTicket(venueId, {
      idempotencyKey: `cash-issue-${suffix}`,
      deviceUid: issueDeviceUid,
      staffId,
      lines: [
        {
          clientLineId: `cash-line-${suffix}`,
          productId,
          quantity: '1',
          weightKg: '0.100',
        },
      ],
    })
    const checkout = await createAreaTicketCheckout(venueId, {
      idempotencyKey: `cash-checkout-${suffix}`,
      deviceUid: checkoutDeviceUidA,
      staffId,
    })
    await addTicketToCheckout(venueId, checkout.id, ticket.code, {
      idempotencyKey: `cash-claim-${suffix}`,
      deviceUid: checkoutDeviceUidA,
      staffId,
    })
    const materialized = await materializeAreaTicketCheckout(venueId, checkout.id, {
      idempotencyKey: `cash-materialize-${suffix}`,
      deviceUid: checkoutDeviceUidA,
      staffId,
      source: 'AVOQADO_ANDROID',
    })

    expect(materialized.order.total).toBe('16.40')
    const payment = await payCashOrder(venueId, materialized.order.id, {
      amount: 1640,
      tip: 0,
      staffId,
      idempotencyKey: `cash-payment-${suffix}`,
    })
    expect(payment.status).toBe('COMPLETED')

    const [paidOrder, paidTicket, paymentCount] = await Promise.all([
      prisma.order.findUniqueOrThrow({ where: { id: materialized.order.id } }),
      prisma.areaTicket.findUniqueOrThrow({ where: { id: ticket.id } }),
      prisma.payment.count({ where: { orderId: materialized.order.id } }),
    ])
    expect(paidOrder.paymentStatus).toBe('PAID')
    expect(paidOrder.paidAmount.toFixed(2)).toBe('16.40')
    expect(paidOrder.remainingBalance.toFixed(2)).toBe('0.00')
    expect(paidTicket.status).toBe(AreaTicketStatus.PAID)
    expect(paymentCount).toBe(1)
  })
})
