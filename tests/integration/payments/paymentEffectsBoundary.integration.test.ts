/** Real PostgreSQL financial boundary; only the post-commit process-death point is injected. */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { recordOrderPayment, recordFastPayment, ensureDigitalReceiptResponse } from '@/services/tpv/payment.tpv.service'
import { postCashSaleToDrawer } from '@/services/shared/cashDrawerPosting'

jest.mock('@/services/shared/cashDrawerPosting', () => ({ postCashSaleToDrawer: jest.fn() }))
jest.mock('@/communication/rabbitmq/publisher', () => ({ publishCommand: jest.fn() }))
jest.mock('@/communication/sockets/managers/socketManager', () => {
  const manager = { broadcastToVenue: jest.fn(), getServer: jest.fn() }
  return { __esModule: true, default: manager, socketManager: manager }
})

const fixture = 'effects-' + randomUUID()
const crash = new Error('SIMULATED_PROCESS_DEATH_AFTER_FINANCIAL_COMMIT')
let venueId: string
let staffId: string
let orderId: string

beforeAll(async () => {
  const url = new URL(process.env.TEST_DATABASE_URL ?? '')
  expect(['localhost', '127.0.0.1']).toContain(url.hostname)
  // La base de este trabajo en la Mac, o la de CI (`avoqado_*_test_*`): nunca otra.
  // 🔴 Con el prefijo ÚNICO de una sola sesión, estas suites fallaban SIEMPRE en CI
  // (su base es `avoqado_h1a_test_20260808`): 38 pruebas en rojo el 12-sep. La guarda
  // debe cerrar el paso a una base real, no a la del CI.
  expect(url.pathname).toMatch(/^\/(codex_testarudo_test_|avoqado_[a-z0-9]+_test_)/)
  await prisma.organization.create({ data: { id: fixture, name: fixture, email: fixture + '@example.test', phone: '5500000000' } })
  const venue = await prisma.venue.create({ data: { organizationId: fixture, name: fixture, slug: fixture } })
  venueId = venue.id
  const staff = await prisma.staff.create({ data: { email: fixture + '@example.test', firstName: 'Payment', lastName: 'Fixture' } })
  staffId = staff.id
  await prisma.staffVenue.create({ data: { venueId, staffId, role: 'CASHIER' } })
})

beforeEach(async () => {
  jest.clearAllMocks()
  ;(postCashSaleToDrawer as jest.Mock).mockRejectedValue(crash)
  const order = await prisma.order.create({
    data: {
      venueId,
      orderNumber: randomUUID(),
      source: 'TPV',
      createdById: staffId,
      subtotal: new Prisma.Decimal(100),
      taxAmount: new Prisma.Decimal(0),
      total: new Prisma.Decimal(100),
      remainingBalance: new Prisma.Decimal(100),
    },
  })
  orderId = order.id
})

afterAll(async () => {
  // Only this suite's random tenant, never global fixture cleanup.
  if (venueId) {
    await prisma.inventoryPosting.deleteMany({ where: { venueId } })
    await prisma.commissionCalculation.deleteMany({ where: { venueId } })
    await prisma.commissionConfig.deleteMany({ where: { venueId } })
    await prisma.review.deleteMany({ where: { venueId } })
    await prisma.payment.deleteMany({ where: { venueId } })
    await prisma.order.deleteMany({ where: { venueId } })
    await prisma.inventory.deleteMany({ where: { venueId } })
    await prisma.product.deleteMany({ where: { venueId } })
    await prisma.menuCategory.deleteMany({ where: { venueId } })
    await prisma.staffVenue.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
  }
  if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
  await prisma.organization.deleteMany({ where: { id: fixture } })
})

const input = (amount: number) => ({
  venueId,
  amount,
  tip: 0,
  status: 'COMPLETED' as const,
  method: 'CASH' as const,
  source: 'TPV',
  splitType: 'FULLPAYMENT' as const,
  tpvId: fixture,
  staffId,
  paidProductsId: [],
  idempotencyKey: randomUUID(),
  currency: 'MXN',
  isInternational: false,
})

async function commitThenStop(amount: number) {
  await expect(recordOrderPayment(venueId, orderId, input(amount), staffId)).rejects.toBe(crash)
  // A precondition failure is not evidence for the financial boundary.
  expect(postCashSaleToDrawer).toHaveBeenCalledTimes(1)
  return prisma.payment.findFirstOrThrow({ where: { venueId, orderId } })
}

describe('New financial boundary crash regressions', () => {
  it('commits full paid balance and inventory obligation before post-commit work can crash', async () => {
    const payment = await commitThenStop(10000)
    expect(payment.status).toBe('COMPLETED')
    expect(await prisma.paymentAllocation.count({ where: { paymentId: payment.id, orderId } })).toBe(1)
    const order = await prisma.order.findFirstOrThrow({ where: { id: orderId, venueId } })
    expect(order.paymentStatus).toBe('PAID')
    expect(order.paidAmount.toString()).toBe('100')
    expect(order.remainingBalance.toString()).toBe('0')
    // Amount-only order needs an explicit no-stock obligation, not silent disappearance.
    expect(await prisma.inventoryPosting.findFirst({ where: { venueId, orderId, effectKind: 'SALE' } })).toMatchObject({
      status: 'SKIPPED',
      skipReason: 'NO_ITEMS',
    })
  })

  it('commits partial balance without creating a full-settlement inventory obligation', async () => {
    await commitThenStop(4000)
    const order = await prisma.order.findFirstOrThrow({ where: { id: orderId, venueId } })
    expect(order.paymentStatus).toBe('PARTIAL')
    expect(order.paidAmount.toString()).toBe('40')
    expect(order.remainingBalance.toString()).toBe('60')
    expect(await prisma.inventoryPosting.count({ where: { venueId, orderId, effectKind: 'SALE' } })).toBe(0)
  })

  it('keeps legacy null-type payments and excludes refunds in the committed balance', async () => {
    await prisma.payment.create({
      data: {
        venueId,
        orderId,
        amount: 40,
        feePercentage: 0,
        feeAmount: 0,
        netAmount: 40,
        tipAmount: 0,
        method: 'CASH',
        status: 'COMPLETED',
        type: null,
      },
    })
    await prisma.payment.create({
      data: {
        venueId,
        orderId,
        amount: -20,
        feePercentage: 0,
        feeAmount: 0,
        netAmount: -20,
        tipAmount: 0,
        method: 'CASH',
        status: 'COMPLETED',
        type: 'REFUND',
      },
    })
    await expect(recordOrderPayment(venueId, orderId, input(6000), staffId)).rejects.toBe(crash)
    expect(postCashSaleToDrawer).toHaveBeenCalledTimes(1)
    const order = await prisma.order.findFirstOrThrow({ where: { id: orderId, venueId } })
    expect(order.paymentStatus).toBe('PAID')
    expect(order.paidAmount.toString()).toBe('100')
    expect(order.remainingBalance.toString()).toBe('0')
  })

  it('concurrent receipt recovery after process death reuses one stable public access key', async () => {
    const payment = await commitThenStop(10000)
    const receipts = await Promise.all([
      ensureDigitalReceiptResponse(payment.id, undefined),
      ensureDigitalReceiptResponse(payment.id, undefined),
    ])
    expect(receipts[0]).not.toBeNull()
    expect(receipts[1]).not.toBeNull()
    expect(receipts[0]?.accessKey).toBe(receipts[1]?.accessKey)
    expect(await prisma.digitalReceipt.count({ where: { paymentId: payment.id } })).toBe(1)
    const receipt = await prisma.digitalReceipt.findFirstOrThrow({ where: { paymentId: payment.id } })
    expect(receipt.dataSnapshot).toMatchObject({ payment: { id: payment.id, amount: 100 }, venue: { id: venueId } })
  })
})

for (const path of ['order', 'fast'] as const) {
  it(`${path}: financial commit durably records review, receipt, referral and frozen commission obligations`, async () => {
    await prisma.commissionConfig.create({
      data: {
        venueId,
        name: 'Producer snapshot',
        createdById: staffId,
        recipient: 'PROCESSOR',
        defaultRate: 0.1,
        categoryIds: [],
        effectiveFrom: new Date('2020-01-01T00:00:00Z'),
      },
    })
    const data = { ...input(10000), reviewRating: 'EXCELLENT', tip: 1000 }
    await expect(
      path === 'order' ? recordOrderPayment(venueId, orderId, data, staffId) : recordFastPayment(venueId, data, staffId),
    ).rejects.toBe(crash)
    expect(postCashSaleToDrawer).toHaveBeenCalledTimes(1)
    const payment = await prisma.payment.findFirstOrThrow({ where: { venueId, idempotencyKey: data.idempotencyKey } })
    const effects = await prisma.paymentEffect.findMany({ where: { venueId, paymentId: payment.id }, take: 10 })
    expect(effects.map(effect => effect.kind).sort()).toEqual(['COMMISSION', 'RECEIPT', 'REFERRAL', 'REVIEW'])
    expect(effects.find(effect => effect.kind === 'REVIEW')?.payload).toMatchObject({ rating: 5, servedById: staffId })
    const paidOrder = await prisma.order.findUniqueOrThrow({ where: { id: payment.orderId } })
    expect(paidOrder.loyaltyEligibleAt).not.toBeNull()
    expect(paidOrder.loyaltyStaffId).toBe(staffId)
  })
}

it('captured card with tracked stock commits one source payment/posting and replay preserves the receipt', async () => {
  const category = await prisma.menuCategory.create({ data: { venueId, name: 'Tracked', slug: randomUUID() } })
  const product = await prisma.product.create({
    data: {
      venueId,
      categoryId: category.id,
      name: 'Tracked unit',
      sku: randomUUID(),
      price: 100,
      taxRate: 0,
      trackInventory: true,
      inventoryMethod: 'QUANTITY',
    },
  })
  await prisma.inventory.create({ data: { venueId, productId: product.id, currentStock: 10 } })
  const item = await prisma.orderItem.create({
    data: { orderId, productId: product.id, quantity: 1, unitPrice: 100, taxAmount: 0, total: 100 },
  })
  const captured = {
    ...input(10000),
    method: 'CREDIT_CARD' as const,
    authorizationNumber: 'TEST-AUTH-ONLY',
    referenceNumber: randomUUID(),
    typeOfCard: 'CREDIT' as const,
  }
  // recordOrderPayment records an already captured result. No SDK/processor call is involved.
  await expect(recordOrderPayment(venueId, orderId, captured, staffId)).rejects.toBe(crash)
  expect(postCashSaleToDrawer).toHaveBeenCalledTimes(1)
  const payment = await prisma.payment.findFirstOrThrow({ where: { venueId, idempotencyKey: captured.idempotencyKey } })
  expect(payment.method).toBe('CREDIT_CARD')
  expect(Number(payment.amount)).toBe(100)
  expect(await prisma.order.findUnique({ where: { id: orderId } })).toMatchObject({
    paymentStatus: 'PAID',
    remainingBalance: new Prisma.Decimal(0),
  })
  const posting = await prisma.inventoryPosting.findFirstOrThrow({
    where: { venueId, orderId, effectKind: 'SALE' },
    include: { lines: true },
  })
  expect(posting.status).toBe('PENDING')
  expect(posting.lines).toHaveLength(1)
  expect(posting.lines[0]).toMatchObject({ orderItemId: item.id, productId: product.id, expectedQuantityBase: new Prisma.Decimal(1) })
  const firstReplay = await recordOrderPayment(venueId, orderId, captured, staffId)
  const secondReplay = await recordOrderPayment(venueId, orderId, captured, staffId)
  expect(firstReplay.id).toBe(payment.id)
  expect(secondReplay.id).toBe(payment.id)
  expect(firstReplay.digitalReceipt?.accessKey).toBeTruthy()
  expect(secondReplay.digitalReceipt?.accessKey).toBe(firstReplay.digitalReceipt?.accessKey)
  expect(await prisma.payment.count({ where: { venueId, orderId } })).toBe(1)
  expect(await prisma.inventoryPosting.count({ where: { venueId, orderId, effectKind: 'SALE' } })).toBe(1)
  expect(await prisma.digitalReceipt.count({ where: { paymentId: payment.id } })).toBe(1)
})
