/**
 * Commission Engine — Multi-Config Limitation (EMPIRICAL PROOF)
 *
 * Scenario from a real client (Mindform): they want TWO commission schemes
 * running at the same time in one venue:
 *   - "Hidrógeno + Iyashi": tiered 4% / 6% / 8%
 *   - "Lagree": flat 3%
 *
 * The dashboard UI lets an admin CREATE both configs (priority + category
 * filter are exposed). The question is whether the calculation ENGINE honors
 * both at runtime.
 *
 * It does NOT. `createCommissionForPayment` resolves exactly ONE config per
 * payment via `findActiveCommissionConfig` (a `findFirst` ordered by
 * `priority desc`). If that single winning config is category-filtered and the
 * order has no matching items, the base amount is 0 and the commission is
 * SKIPPED — the engine never falls through to a second (lower-priority) config.
 *
 * These tests prove it with the same Lagree-only ticket:
 *   - Test 1: Hidrógeno config wins (higher priority) → Lagree ticket earns $0.
 *   - Test 2: Lagree config is the active one        → same ticket earns 3%.
 *
 * Same cart, different "winning" config → completely different outcome. That is
 * the limitation, and the reason a second simultaneous scheme can't work today.
 */

import { Decimal } from '@prisma/client/runtime/library'
import { createCommissionForPayment } from '../../../../src/services/dashboard/commission/commission-calculation.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE_ID = 'venue-mindform'
const STAFF_ID = 'staff-1'

// A Lagree-only ticket: one $500 item whose product lives in the Lagree category.
function lagreePayment() {
  return {
    id: 'pay-lagree-1',
    type: 'CARD', // anything except PaymentType.TEST
    status: 'COMPLETED',
    venueId: VENUE_ID,
    orderId: 'order-lagree-1',
    processedById: STAFF_ID,
    createdAt: new Date('2026-06-03T18:00:00Z'),
    amount: new Decimal(500),
    tipAmount: new Decimal(0),
    order: {
      id: 'order-lagree-1',
      createdById: STAFF_ID,
      servedById: STAFF_ID,
      subtotal: new Decimal(500),
      discountAmount: new Decimal(0),
      taxAmount: new Decimal(0),
    },
    shift: { id: 'shift-1' },
    venue: { id: VENUE_ID, timezone: 'America/Mexico_City' },
  }
}

// Hidrógeno+Iyashi scheme: tiered, scoped to its own categories. Highest priority.
const HIDROGENO_CONFIG = {
  id: 'cfg-hidrogeno',
  venueId: VENUE_ID,
  orgId: null,
  name: 'Hidrógeno + Iyashi (escalonado)',
  priority: 100,
  recipient: 'SERVER',
  trigger: 'PER_PAYMENT',
  calcType: 'TIERED',
  defaultRate: new Decimal(0.04),
  minAmount: null,
  maxAmount: null,
  includeTips: false,
  includeDiscount: false,
  includeTax: false,
  roleRates: null,
  filterByCategories: true,
  categoryIds: ['cat-hidrogeno', 'cat-iyashi'],
  useGoalAsTier: false,
  goalBonusRate: null,
  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  effectiveTo: null,
  tiers: [],
}

// Lagree scheme: flat 3%, scoped to the Lagree category. Lower priority.
const LAGREE_CONFIG = {
  ...HIDROGENO_CONFIG,
  id: 'cfg-lagree',
  name: 'Lagree (3% fijo)',
  priority: 50,
  calcType: 'PERCENTAGE',
  defaultRate: new Decimal(0.03),
  categoryIds: ['cat-lagree'],
  tiers: [],
}

const ACTIVE_STAFF_VENUE = {
  staffId: STAFF_ID,
  role: 'WAITER',
  staff: { id: STAFF_ID, active: true },
}

describe('Commission engine — multi-config limitation', () => {
  it('TEST 1 (the limitation): when the Hidrógeno config wins by priority, a Lagree-only ticket earns $0 — not 3%', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(lagreePayment())
    // Idempotency check: no existing commission for this payment.
    prismaMock.commissionCalculation.findFirst.mockResolvedValue(null)
    // findActiveCommissionConfig is a findFirst ordered by priority desc → it
    // returns the single highest-priority config (Hidrógeno) for ANY payment in
    // this venue, including a Lagree-only ticket. This is the crux.
    prismaMock.commissionConfig.findFirst.mockResolvedValue(HIDROGENO_CONFIG)
    prismaMock.staffVenue.findFirst.mockResolvedValue(ACTIVE_STAFF_VENUE)
    prismaMock.commissionOverride.findFirst.mockResolvedValue(null)
    // The order has NO items in the Hidrógeno/Iyashi categories (it's Lagree).
    prismaMock.orderItem.findMany.mockResolvedValue([])

    const result = await createCommissionForPayment('pay-lagree-1')

    // No commission is produced for the Lagree ticket.
    expect(result).toBeNull()
    expect(prismaMock.commissionCalculation.create).not.toHaveBeenCalled()

    // Root cause: the engine fetches ONE config (findFirst), never a list. It
    // never even looks at the lower-priority Lagree config.
    expect(prismaMock.commissionConfig.findFirst).toHaveBeenCalledTimes(1)
    expect(prismaMock.commissionConfig.findMany).not.toHaveBeenCalled()
  })

  it('TEST 2 (control): the SAME Lagree ticket earns 3% when the Lagree config is the active one', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(lagreePayment())
    prismaMock.commissionCalculation.findFirst.mockResolvedValue(null)
    // Now Lagree is the winning config (e.g. it's the only one, or highest priority).
    prismaMock.commissionConfig.findFirst.mockResolvedValue(LAGREE_CONFIG)
    prismaMock.staffVenue.findFirst.mockResolvedValue(ACTIVE_STAFF_VENUE)
    prismaMock.commissionOverride.findFirst.mockResolvedValue(null)
    // The order's $500 item IS in the Lagree category → it counts.
    prismaMock.orderItem.findMany.mockResolvedValue([
      {
        quantity: 1,
        unitPrice: new Decimal(500),
        taxAmount: new Decimal(0),
        discountAmount: new Decimal(0),
      },
    ])
    prismaMock.commissionCalculation.create.mockResolvedValue({ id: 'calc-lagree-1' })

    const result = await createCommissionForPayment('pay-lagree-1')

    // Commission IS produced: 3% of $500 = $15. The ticket itself was always
    // fine — the ONLY thing that changed is which config won.
    expect(result).not.toBeNull()
    expect(result?.effectiveRate).toBe(0.03)
    expect(result?.netCommission).toBe(15)
    expect(prismaMock.commissionCalculation.create).toHaveBeenCalledTimes(1)
    const created = prismaMock.commissionCalculation.create.mock.calls[0][0].data
    expect(created.netCommission).toBe(15)
    expect(created.effectiveRate).toBe(0.03)
  })
})
