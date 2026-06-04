import { Decimal } from '@prisma/client/runtime/library'
import { createCommissionForPayment } from '../../../../src/services/dashboard/commission/commission-calculation.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE_ID = 'venue-mindform'
const STAFF_ID = 'staff-1'

function payment(amount = 500, orderId: string | null = 'order-1') {
  return {
    id: 'pay-1',
    type: 'CARD',
    status: 'COMPLETED',
    venueId: VENUE_ID,
    orderId,
    processedById: STAFF_ID,
    createdAt: new Date('2026-06-03T18:00:00Z'),
    amount: new Decimal(amount),
    tipAmount: new Decimal(0),
    order: {
      id: orderId,
      createdById: STAFF_ID,
      servedById: STAFF_ID,
      subtotal: new Decimal(amount),
      discountAmount: new Decimal(0),
      taxAmount: new Decimal(0),
    },
    shift: { id: 'shift-1' },
    venue: { id: VENUE_ID, timezone: 'America/Mexico_City' },
  }
}

const baseCfg = {
  venueId: VENUE_ID,
  orgId: null,
  recipient: 'SERVER',
  trigger: 'PER_PAYMENT',
  minAmount: null,
  maxAmount: null,
  includeTips: false,
  includeDiscount: false,
  includeTax: false,
  roleRates: null,
  useGoalAsTier: false,
  goalBonusRate: null,
  effectiveFrom: new Date('2026-01-01'),
  effectiveTo: null,
  tiers: [],
}
const HIDROGENO = {
  ...baseCfg,
  id: 'cfg-hid',
  name: 'Hidrógeno',
  priority: 100,
  calcType: 'PERCENTAGE',
  defaultRate: new Decimal(0.04),
  filterByCategories: true,
  categoryIds: ['cat-hid', 'cat-iyashi'],
}
const LAGREE = {
  ...baseCfg,
  id: 'cfg-lag',
  name: 'Lagree',
  priority: 50,
  calcType: 'PERCENTAGE',
  defaultRate: new Decimal(0.03),
  filterByCategories: true,
  categoryIds: ['cat-lagree'],
}
const GENERAL = {
  ...baseCfg,
  id: 'cfg-gen',
  name: 'General',
  priority: 1,
  calcType: 'PERCENTAGE',
  defaultRate: new Decimal(0.02),
  filterByCategories: false,
  categoryIds: [] as string[],
}

const ACTIVE_STAFF = { staffId: STAFF_ID, role: 'WAITER', staff: { id: STAFF_ID, active: true } }

// orderItem.findMany is called once per category-scoped config (and once for leftover).
// Branch on the where clause to return the right items per category set.
function mockOrderItemsByCategory(map: Record<string, Array<{ unitPrice: number }>>) {
  prismaMock.orderItem.findMany.mockImplementation(async (args: any) => {
    const inList: string[] | undefined = args?.where?.product?.categoryId?.in
    const key = inList ? inList.join(',') : 'leftover'
    const items = map[key] ?? []
    return items.map(i => ({ quantity: 1, unitPrice: new Decimal(i.unitPrice), taxAmount: new Decimal(0), discountAmount: new Decimal(0) }))
  })
}

beforeEach(() => {
  prismaMock.commissionCalculation.findFirst.mockResolvedValue(null) // idempotency: none yet
  prismaMock.staffVenue.findFirst.mockResolvedValue(ACTIVE_STAFF)
  prismaMock.commissionOverride.findFirst.mockResolvedValue(null)
  prismaMock.commissionCalculation.create.mockImplementation(async (args: any) => ({ id: 'calc', ...args.data }))
})

describe('multi-scheme commission engine', () => {
  it('pays BOTH schemes on a mixed ticket (Hidrógeno 4% + Lagree 3%)', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(payment())
    prismaMock.commissionConfig.findMany.mockResolvedValue([HIDROGENO, LAGREE])
    mockOrderItemsByCategory({ 'cat-hid,cat-iyashi': [{ unitPrice: 1000 }], 'cat-lagree': [{ unitPrice: 500 }] })

    const results = await createCommissionForPayment('pay-1')

    expect(results).toHaveLength(2)
    const hid = results.find(r => r.netCommission === 40) // 4% of 1000
    const lag = results.find(r => r.netCommission === 15) // 3% of 500
    expect(hid).toBeTruthy()
    expect(lag).toBeTruthy()
  })

  it('pays Lagree 3% on a Lagree-only ticket even though Hidrógeno has higher priority', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(payment())
    prismaMock.commissionConfig.findMany.mockResolvedValue([HIDROGENO, LAGREE])
    mockOrderItemsByCategory({ 'cat-hid,cat-iyashi': [], 'cat-lagree': [{ unitPrice: 500 }] })

    const results = await createCommissionForPayment('pay-1')

    expect(results).toHaveLength(1)
    expect(results[0].netCommission).toBe(15)
    expect(results[0].effectiveRate).toBe(0.03)
  })

  it("REGRESSION: single catch-all config bills the whole payment (today's behavior)", async () => {
    prismaMock.payment.findUnique.mockResolvedValue(payment(500))
    prismaMock.commissionConfig.findMany.mockResolvedValue([GENERAL])

    const results = await createCommissionForPayment('pay-1')

    expect(results).toHaveLength(1)
    expect(results[0].netCommission).toBe(10) // 2% of 500
    // orderItem.findMany NOT used for a catch-all-only venue
    expect(prismaMock.orderItem.findMany).not.toHaveBeenCalled()
  })

  it('catch-all bills only the leftover when a category-scoped config also exists', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(payment(500))
    prismaMock.commissionConfig.findMany.mockResolvedValue([LAGREE, GENERAL])
    mockOrderItemsByCategory({ 'cat-lagree': [{ unitPrice: 300 }], leftover: [{ unitPrice: 200 }] })

    const results = await createCommissionForPayment('pay-1')

    expect(results).toHaveLength(2)
    expect(results.find(r => r.netCommission === 9)).toBeTruthy() // Lagree 3% of 300
    expect(results.find(r => r.netCommission === 4)).toBeTruthy() // General 2% of 200 (leftover)
  })

  it('idempotency: a config that already has a calc for this payment+staff is skipped', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(payment())
    prismaMock.commissionConfig.findMany.mockResolvedValue([LAGREE])
    mockOrderItemsByCategory({ 'cat-lagree': [{ unitPrice: 500 }] })
    prismaMock.commissionCalculation.findFirst.mockResolvedValue({ id: 'already' })

    const results = await createCommissionForPayment('pay-1')

    expect(results).toHaveLength(0)
    expect(prismaMock.commissionCalculation.create).not.toHaveBeenCalled()
  })
})
