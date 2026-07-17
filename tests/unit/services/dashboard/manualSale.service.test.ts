import { Prisma } from '@prisma/client'

// ── Mocks ──────────────────────────────────────────────────────────────────
// prismaClient: only the members createOneManualSale touches. $transaction runs
// the callback with a mocked tx client; the custody event is written post-tx on
// the real client.
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    serializedItemCustodyEvent: { create: jest.fn() },
  },
}))

// Resolvers (Task 3) — each stubbed per-test so we can drive happy vs error paths.
const resolveIccidMock = jest.fn()
const resolveVenueMock = jest.fn()
const resolveStaffByCodeMock = jest.fn()
const resolveCategoryMock = jest.fn()
const mapPaymentFormMock = jest.fn()
const parseAmountMock = jest.fn()
jest.mock('@/services/dashboard/manualSale.resolvers', () => ({
  __esModule: true,
  resolveIccid: (...a: any[]) => resolveIccidMock(...a),
  resolveVenue: (...a: any[]) => resolveVenueMock(...a),
  resolveStaffByCode: (...a: any[]) => resolveStaffByCodeMock(...a),
  resolveCategory: (...a: any[]) => resolveCategoryMock(...a),
  mapPaymentForm: (...a: any[]) => mapPaymentFormMock(...a),
  parseAmount: (...a: any[]) => parseAmountMock(...a),
}))

// serializedInventoryService.markAsSold — returns { item }.
const markAsSoldMock = jest.fn()
jest.mock('@/services/serialized-inventory/serializedInventory.service', () => ({
  __esModule: true,
  serializedInventoryService: {
    markAsSold: (...a: any[]) => markAsSoldMock(...a),
  },
}))

// logAction — fire-and-forget audit; assert it's called, never throws.
const logActionMock = jest.fn().mockResolvedValue(undefined)
jest.mock('@/services/dashboard/activity-log.service', () => ({
  __esModule: true,
  logAction: (...a: any[]) => logActionMock(...a),
}))

import { createOneManualSale } from '@/services/dashboard/manualSale.service'
import prisma from '@/utils/prismaClient'
import type { ManualSaleRowInput } from '@/schemas/dashboard/manualSale.schema'

const prismaMock = prisma as jest.Mocked<typeof prisma>

const ORG_ID = 'org-1'
const ACTOR_STAFF_ID = 'actor-staff-1'
const STORE_VENUE_ID = 'store-venue-1'
const SELLER_STAFF_ID = 'seller-staff-1'

const baseRow: ManualSaleRowInput = {
  iccid: '8952140064323812041F',
  promoterCode: 'P123',
  promoterName: 'Ana López',
  storeId: '898',
  storeName: 'BAE MUÑOZ SLP (898)',
  saleDate: '2026-04-24',
  saleType: 'Línea nueva',
  paymentForm: 'Efectivo',
  amount: 150,
  simType: 'SIM de Evento',
}

/** Build a fresh tx-client mock whose create() calls return stable ids. */
function makeTxClient() {
  return {
    order: { create: jest.fn().mockResolvedValue({ id: 'order-1' }) },
    orderItem: { create: jest.fn().mockResolvedValue({ id: 'orderitem-1' }) },
    payment: { create: jest.fn().mockResolvedValue({ id: 'payment-1' }) },
    saleVerification: { create: jest.fn().mockResolvedValue({ id: 'verification-1' }) },
  }
}

/** Wire $transaction to run the callback against a given tx client. */
function wireTx(tx: ReturnType<typeof makeTxClient>) {
  ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(tx))
}

/** Happy-path resolver stubs: every resolver resolves cleanly. */
function stubResolversHappy() {
  resolveIccidMock.mockResolvedValue({
    item: {
      id: 'sim-1',
      serialNumber: '8952140064323812041F',
      categoryId: 'cat-1',
      custodyState: 'SUPERVISOR_HELD',
      assignedSupervisorId: 'sup-1',
    },
  })
  resolveVenueMock.mockResolvedValue({
    venue: { id: STORE_VENUE_ID, name: 'BAE MUÑOZ SLP', slug: 'bae-munoz-slp', timezone: 'America/Mexico_City' },
  })
  resolveStaffByCodeMock.mockResolvedValue({ staff: { id: SELLER_STAFF_ID, firstName: 'Ana', lastName: 'López', employeeCode: 'P123' } })
  resolveCategoryMock.mockResolvedValue({ categoryId: 'cat-1' })
  mapPaymentFormMock.mockReturnValue({ method: 'CASH', amountApplies: true })
  parseAmountMock.mockReturnValue(new Prisma.Decimal(150))
}

describe('manualSale.service — createOneManualSale', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    logActionMock.mockResolvedValue(undefined)
    markAsSoldMock.mockResolvedValue({ item: { id: 'sim-1', serialNumber: '8952140064323812041F' } })
  })

  // ── NEW FEATURE ──────────────────────────────────────────────────────────
  it('creates Order + OrderItem + Payment + COMPLETED SaleVerification and returns ok', async () => {
    stubResolversHappy()
    const tx = makeTxClient()
    wireTx(tx)

    const result = await createOneManualSale(ORG_ID, ACTOR_STAFF_ID, baseRow)

    expect(result).toEqual({ ok: true, orderId: 'order-1', verificationId: 'verification-1', venueId: STORE_VENUE_ID })

    // Order created once, MANUAL_ENTRY / DASHBOARD_MANUAL, COMPLETED, pesos amount.
    expect(tx.order.create).toHaveBeenCalledTimes(1)
    const orderData = (tx.order.create as jest.Mock).mock.calls[0][0].data
    expect(orderData).toMatchObject({
      venueId: STORE_VENUE_ID,
      type: 'MANUAL_ENTRY',
      source: 'DASHBOARD_MANUAL',
      status: 'COMPLETED',
    })
    expect(new Prisma.Decimal(orderData.total).toString()).toBe('150')
    expect(orderData.posRawData.manualSerializedSale).toBe(true)

    // OrderItem carries the serial in productSku.
    expect(tx.orderItem.create).toHaveBeenCalledTimes(1)
    const itemData = (tx.orderItem.create as jest.Mock).mock.calls[0][0].data
    expect(itemData.orderId).toBe('order-1')
    expect(itemData.productSku).toBe('8952140064323812041F')

    // markAsSold called with the STORE venueId + the created orderItem.id + seller staffId.
    expect(markAsSoldMock).toHaveBeenCalledTimes(1)
    const [venueArg, serialArg, orderItemIdArg, txArg, optsArg] = markAsSoldMock.mock.calls[0]
    expect(venueArg).toBe(STORE_VENUE_ID)
    expect(serialArg).toBe('8952140064323812041F')
    expect(orderItemIdArg).toBe('orderitem-1')
    expect(txArg).toBe(tx)
    // Manual sales bypass the TPV custody precheck — these SIMs are sold outside the TPV
    // and sit in SUPERVISOR_HELD, which the precheck (PROMOTER_HELD-only) would reject.
    expect(optsArg).toEqual({ staffId: SELLER_STAFF_ID, skipCustodyCheck: true })

    // Payment COMPLETED, pesos, zero fees, net == amount.
    expect(tx.payment.create).toHaveBeenCalledTimes(1)
    const payData = (tx.payment.create as jest.Mock).mock.calls[0][0].data
    expect(payData).toMatchObject({ venueId: STORE_VENUE_ID, orderId: 'order-1', method: 'CASH', status: 'COMPLETED' })
    expect(new Prisma.Decimal(payData.amount).toString()).toBe('150')
    expect(new Prisma.Decimal(payData.netAmount).toString()).toBe('150')
    expect(new Prisma.Decimal(payData.feeAmount).toString()).toBe('0')

    // SaleVerification created COMPLETED with reviewer = actor.
    expect(tx.saleVerification.create).toHaveBeenCalledTimes(1)
    const svData = (tx.saleVerification.create as jest.Mock).mock.calls[0][0].data
    expect(svData).toMatchObject({
      venueId: STORE_VENUE_ID,
      paymentId: 'payment-1',
      staffId: SELLER_STAFF_ID,
      status: 'COMPLETED',
      reviewedById: ACTOR_STAFF_ID,
    })
    expect(svData.serialNumbers).toContain('8952140064323812041F')
    expect(svData.reviewedAt).toBeInstanceOf(Date)
  })

  it('classifies a portabilidad sale via isPortabilidad', async () => {
    stubResolversHappy()
    const tx = makeTxClient()
    wireTx(tx)

    await createOneManualSale(ORG_ID, ACTOR_STAFF_ID, { ...baseRow, saleType: 'Portabilidad' })

    const svData = (tx.saleVerification.create as jest.Mock).mock.calls[0][0].data
    expect(svData.isPortabilidad).toBe(true)
  })

  it('writes the audit log and custody event AFTER the tx (fire-and-forget)', async () => {
    stubResolversHappy()
    const tx = makeTxClient()
    wireTx(tx)

    await createOneManualSale(ORG_ID, ACTOR_STAFF_ID, baseRow)

    // ActivityLog dual-write with MANUAL_SALE_CREATED.
    expect(logActionMock).toHaveBeenCalledTimes(1)
    const logArg = logActionMock.mock.calls[0][0]
    expect(logArg).toMatchObject({
      action: 'MANUAL_SALE_CREATED',
      entity: 'Order',
      entityId: 'order-1',
      staffId: ACTOR_STAFF_ID,
      venueId: STORE_VENUE_ID,
    })

    // Custody event on the top-level (post-tx) client, MARKED_SOLD, actor set.
    expect(prismaMock.serializedItemCustodyEvent.create as jest.Mock).toHaveBeenCalledTimes(1)
    const custodyData = (prismaMock.serializedItemCustodyEvent.create as jest.Mock).mock.calls[0][0].data
    expect(custodyData).toMatchObject({ eventType: 'MARKED_SOLD', toState: 'SOLD', actorStaffId: ACTOR_STAFF_ID })
    expect(custodyData.serialNumber).toBe('8952140064323812041F')
  })

  // ── ERROR PATH ────────────────────────────────────────────────────────────
  it('returns { ok:false } and creates NOTHING when a resolver returns { error }', async () => {
    stubResolversHappy()
    // Make the ICCID resolver fail.
    resolveIccidMock.mockResolvedValue({ error: 'ICCID ya vendido' })
    const tx = makeTxClient()
    wireTx(tx)

    const result = await createOneManualSale(ORG_ID, ACTOR_STAFF_ID, baseRow)

    expect(result).toEqual({ ok: false, error: 'ICCID ya vendido' })
    // Nothing created; nothing sold; no audit.
    expect(tx.order.create).not.toHaveBeenCalled()
    expect(tx.orderItem.create).not.toHaveBeenCalled()
    expect(tx.payment.create).not.toHaveBeenCalled()
    expect(tx.saleVerification.create).not.toHaveBeenCalled()
    expect(markAsSoldMock).not.toHaveBeenCalled()
    expect(logActionMock).not.toHaveBeenCalled()
    expect(prismaMock.serializedItemCustodyEvent.create as jest.Mock).not.toHaveBeenCalled()
  })

  it('returns { ok:false } when the venue resolver fails (later step) and creates nothing', async () => {
    stubResolversHappy()
    resolveVenueMock.mockResolvedValue({ error: 'Tienda no encontrada' })
    const tx = makeTxClient()
    wireTx(tx)

    const result = await createOneManualSale(ORG_ID, ACTOR_STAFF_ID, baseRow)

    expect(result).toEqual({ ok: false, error: 'Tienda no encontrada' })
    expect(tx.order.create).not.toHaveBeenCalled()
    expect(markAsSoldMock).not.toHaveBeenCalled()
  })
})
