import cuid from 'cuid'
import { DeliveryProvider, Prisma, type DeliveryChannelLink } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import * as orders from '@/services/mobile/order.mobile.service'
import { ingestDeliveryOrder } from '@/services/delivery-channels/core/deliveryOrderIngestion.service'
import { normalizeRappiOrder } from '@/services/delivery-channels/providers/rappi/rappi.mapper'
import rappiOrder from '../../unit/services/delivery-channels/fixtures/rappi/sandbox/new-order-marketplace-efectivo.json'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))

// Integration setup already rejects shared/remote databases, before any fixture hook runs.
const lookup = (venueId: string, key: string): Promise<Record<string, any> | null> =>
  (orders as unknown as { getCashPaymentByKey: (venueId: string, key: string) => Promise<Record<string, any> | null> }).getCashPaymentByKey(
    venueId,
    key,
  )

describe('cash payment by key — real unique lookup and zero business state changes', () => {
  const suffix = cuid()
  let orgId: string | undefined
  const venueIds: string[] = []
  let orderId: string
  let regularId: string
  let fastId: string
  let staffId: string | undefined
  let link: DeliveryChannelLink
  let sequence = 0
  const sharedKey = `q15-${suffix}`

  beforeAll(async () => {
    orgId = (await prisma.organization.create({ data: { name: `Q15 ${suffix}`, email: `${suffix}@q15.test`, phone: '5555555555' } })).id
    for (const part of ['a', 'b']) {
      venueIds.push((await prisma.venue.create({ data: { organizationId: orgId, name: `Q15 ${part}`, slug: `q15-${part}-${suffix}` } })).id)
    }
    for (const [index, venueId] of venueIds.entries()) {
      const order = await prisma.order.create({
        data: {
          venueId,
          orderNumber: `Q15-${suffix}-${index}`,
          externalId: `local-${suffix}-${index}`,
          subtotal: 175,
          taxAmount: 0,
          total: 205,
          tipAmount: 20,
          thirdPartyCashDue: 10,
          paidAmount: 205,
          remainingBalance: 0,
          paymentStatus: 'PAID',
          status: 'COMPLETED',
        },
      })
      const payment = await prisma.payment.create({
        data: {
          venueId,
          orderId: order.id,
          idempotencyKey: sharedKey,
          type: index === 0 ? 'REGULAR' : 'FAST',
          status: 'COMPLETED',
          method: 'CASH',
          amount: 175,
          tipAmount: 20,
          thirdPartyCashAmount: 10,
          feePercentage: 0,
          feeAmount: 0,
          netAmount: 175,
        },
      })
      if (index === 0) {
        orderId = order.id
        regularId = payment.id
      } else fastId = payment.id
    }
    staffId = (await prisma.staff.create({ data: { email: `${suffix}@cashier.q15.test`, firstName: 'Q15', lastName: 'Caja' } })).id
    await prisma.staffVenue.create({ data: { staffId, venueId: venueIds[0], role: 'OWNER' } })
    link = await prisma.deliveryChannelLink.create({
      data: {
        venueId: venueIds[0],
        provider: DeliveryProvider.RAPPI,
        externalLocationId: `q15-${suffix}`,
        webhookSecret: 'test-only',
      },
    })
  })

  afterAll(async () => {
    // Every deletion remains bound to IDs this fixture actually created, even on setup failure.
    if (venueIds.length) {
      const ownPayments = await prisma.payment.findMany({ where: { venueId: { in: venueIds } }, select: { id: true }, take: 100 })
      await prisma.deliveryOrderEvent.deleteMany({ where: { venueId: { in: venueIds } } })
      await prisma.notification.deleteMany({ where: { venueId: { in: venueIds } } })
      await prisma.activityLog.deleteMany({ where: { venueId: { in: venueIds } } })
      await prisma.venueTransaction.deleteMany({ where: { venueId: { in: venueIds } } })
      await prisma.paymentEffect.deleteMany({ where: { paymentId: { in: ownPayments.map(payment => payment.id) } } })
      await prisma.paymentAllocation.deleteMany({ where: { paymentId: { in: ownPayments.map(payment => payment.id) } } })
      await prisma.digitalReceipt.deleteMany({ where: { paymentId: { in: ownPayments.map(payment => payment.id) } } })
      await prisma.payment.deleteMany({ where: { venueId: { in: venueIds } } })
      await prisma.inventoryPosting.deleteMany({ where: { venueId: { in: venueIds } } })
      await prisma.orderItemModifier.deleteMany({ where: { orderItem: { order: { venueId: { in: venueIds } } } } })
      await prisma.kdsOrder.deleteMany({ where: { venueId: { in: venueIds } } })
      await prisma.orderItem.deleteMany({ where: { order: { venueId: { in: venueIds } } } })
      await prisma.order.deleteMany({ where: { venueId: { in: venueIds } } })
      await prisma.deliveryChannelLink.deleteMany({ where: { venueId: { in: venueIds } } })
      await prisma.venueTenderTypeRevision.deleteMany({ where: { venueId: { in: venueIds } } })
      await prisma.venueTenderType.deleteMany({ where: { venueId: { in: venueIds } } })
      await prisma.product.deleteMany({ where: { venueId: { in: venueIds } } })
      await prisma.menuCategory.deleteMany({ where: { venueId: { in: venueIds } } })
      await prisma.staffVenue.deleteMany({ where: { venueId: { in: venueIds } } })
      if (staffId) await prisma.staff.delete({ where: { id: staffId } })
      await prisma.venue.deleteMany({ where: { id: { in: venueIds } } })
    }
    if (orgId) await prisma.organization.delete({ where: { id: orgId } })
  })

  async function collectRappi(amount: number, zeroThirdParty = false) {
    const raw = JSON.parse(JSON.stringify(rappiOrder))
    raw.order_detail.order_id = `${raw.order_detail.order_id}-${suffix}-${++sequence}`
    if (zeroThirdParty) {
      raw.order_detail.totals.charges.service_fee = 0
      raw.order_detail.totals.total_to_pay = 195
      raw.order_detail.totals.total_order = 195
    }
    const { order } = await ingestDeliveryOrder(normalizeRappiOrder(raw), link)
    const idempotencyKey = cuid()
    await orders.payCashOrder(venueIds[0], order.id, { amount, tip: 0, staffId: staffId!, idempotencyKey })
    const payment = await prisma.payment.findUniqueOrThrow({ where: { venueId_idempotencyKey: { venueId: venueIds[0], idempotencyKey } } })
    return { order, payment, idempotencyKey }
  }

  it.each([false, true])(
    'recovers a real ingested/collected Rappi order after live tender settings change (zero third party: %s)',
    async zero => {
      const { order, payment, idempotencyKey } = await collectRappi(zero ? 19500 : 20500, zero)
      expect(payment).toMatchObject({ method: 'CASH', type: 'REGULAR', fundsFlow: 'CASH_DRAWER' })
      expect(payment.tenderTypeId).toBeTruthy()
      expect(payment.tenderRevision).toBeGreaterThan(0)
      expect(String(payment.thirdPartyCashAmount)).toBe(zero ? '0' : '10')
      const first = await lookup(venueIds[0], idempotencyKey)
      expect(first).toMatchObject({
        paymentId: payment.id,
        orderId: order.id,
        tenderTypeId: payment.tenderTypeId,
        tenderRevision: payment.tenderRevision,
        fundsFlow: 'CASH_DRAWER',
        amountCents: 17500,
        tipCents: 2000,
        cashRetainedCents: zero ? 19500 : 20500,
        deliveryCashAllocation: { saleCents: 17500, tipCents: 2000, thirdPartyCents: zero ? 0 : 1000 },
        remainingBalanceCents: 0,
        orderPaymentStatus: 'PAID',
      })
      await prisma.venueTenderType.update({
        where: { id: payment.tenderTypeId! },
        data: {
          active: false,
          countsAsPhysicalCash: false,
          captureTip: false,
          commissionPercent: 99,
        },
      })
      const before = await snapshot()
      expect(await lookup(venueIds[0], idempotencyKey)).toEqual(first)
      expect(await lookup(venueIds[0], idempotencyKey)).toEqual(first)
      expect(await prisma.payment.count({ where: { venueId: venueIds[0], idempotencyKey } })).toBe(1)
      expect(await snapshot()).toEqual(before)
      await prisma.venueTenderType.update({
        where: { id: payment.tenderTypeId! },
        data: { active: true, countsAsPhysicalCash: true, captureTip: true, commissionPercent: null },
      })
    },
  )

  const snapshot = async () => ({
    payments: await prisma.payment.findMany({ where: { venueId: { in: venueIds } }, orderBy: { id: 'asc' }, take: 100 }),
    orders: await prisma.order.findMany({ where: { venueId: { in: venueIds } }, orderBy: { id: 'asc' }, take: 100 }),
    receipts: await prisma.digitalReceipt.count({ where: { payment: { venueId: { in: venueIds } } } }),
    effects: await prisma.paymentEffect.count({ where: { payment: { venueId: { in: venueIds } } } }),
    stock: await prisma.inventoryPosting.count({ where: { venueId: { in: venueIds } } }),
    audit: await prisma.activityLog.count({ where: { venueId: { in: venueIds } } }),
  })

  it('resolves the same exact key independently in both venues (REGULAR and FAST)', async () => {
    const before = await snapshot()
    const a = await lookup(venueIds[0], sharedKey)
    const b = await lookup(venueIds[1], sharedKey)
    expect(a).toMatchObject({
      venueId: venueIds[0],
      paymentId: regularId,
      type: 'REGULAR',
      orderId,
      amountCents: 17500,
      tipCents: 2000,
      cashRetainedCents: 20500,
      deliveryCashAllocation: { saleCents: 17500, tipCents: 2000, thirdPartyCents: 1000 },
    })
    expect(b).toMatchObject({ venueId: venueIds[1], paymentId: fastId, type: 'FAST' })
    expect(a?.orderExternalId).toBe(`local-${suffix}-0`)
    expect(await lookup(venueIds[0], 'missing')).toBeNull()
    expect(await lookup(cuid(), sharedKey)).toBeNull()
    expect(await snapshot()).toEqual(before)
  })

  it('repeated reads after a later installment cannot change the stored payment or claim current totals as historical', async () => {
    await prisma.order.update({
      where: { id: orderId },
      data: { total: 215, paidAmount: 205, remainingBalance: 10, paymentStatus: 'PARTIAL' },
    })
    const original = await lookup(venueIds[0], sharedKey)
    expect(original).toMatchObject({ remainingBalanceCents: 1000, orderPaymentStatus: 'PARTIAL' })
    await prisma.order.update({ where: { id: orderId }, data: { paidAmount: 215, remainingBalance: 0, paymentStatus: 'PAID' } })
    const before = await snapshot()
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await lookup(venueIds[0], sharedKey)
      expect(result).toEqual({ ...original, remainingBalanceCents: 0, orderPaymentStatus: 'PAID' })
      for (const field of ['orderTotalCents', 'totalPaidCents', 'changeCents']) {
        expect(result).not.toHaveProperty(field)
      }
    }
    expect(await prisma.payment.count({ where: { venueId: venueIds[0], idempotencyKey: sharedKey } })).toBe(1)
    expect(await snapshot()).toEqual(before)
  })

  it.each([
    ['0.00', 0],
    ['0.01', 1],
    ['19.99', 1999],
  ] as const)('round-trips stored Decimal %s to %i integer cents', async (amount, cents) => {
    const uniqueKey = cuid()
    await prisma.payment.create({
      data: {
        venueId: venueIds[0],
        orderId,
        idempotencyKey: uniqueKey,
        method: 'CASH',
        type: 'REGULAR',
        status: 'COMPLETED',
        amount: new Prisma.Decimal(amount),
        feePercentage: 0,
        feeAmount: 0,
        netAmount: new Prisma.Decimal(amount),
      },
    })
    expect(await lookup(venueIds[0], uniqueKey)).toMatchObject({ amountCents: cents, tipCents: 0, cashRetainedCents: cents })
  })
})
