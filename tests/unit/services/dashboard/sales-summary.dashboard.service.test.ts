/**
 * Canonical-mapping guard for the Sales Summary payment-method / card-type filter.
 *
 * Two code reviewers flagged that the whole feature rests on canonical mappings
 * (which Payment counts as CASH / CARD-CREDIT / CARD-DEBIT / CARD-AMEX /
 * CARD-INTERNATIONAL / OTHER, and which MindForm legacy QR rows a filter admits)
 * with NO automated guard. These pure-function tests lock that logic in so a
 * future refactor can't silently break the cross-driver invariants:
 *
 *   - buildPaymentWhereFilter  (Prisma `where` fragment for the ORM queries)
 *   - buildPaymentSqlClause    (raw-SQL twin for the period queries)
 *   - legacyAdmission          (single source of truth for legacy QR admission)
 *   - legacyMatchesFilter      (row-level twin — must agree with legacyAdmission)
 *   - bucketOf                 (mirrors determineTransactionCardType precedence)
 *
 * The invariants under guard:
 *   1. The Prisma fragment and the SQL clause select the SAME set of payments.
 *   2. legacyMatchesFilter never drifts from legacyAdmission.
 *   3. bucketOf uses the same precedence (international → AMEX → method) as
 *      transactionCost.service.ts:determineTransactionCardType, so a payment
 *      that counts as AMEX in the breakdown counts as AMEX everywhere.
 *
 * All tests here are deterministic and hit NO database — the service module's
 * `prisma` import is the global mock from tests/__helpers__/setup.ts, but these
 * functions are pure and never touch it. End-to-end coverage of getSalesSummary
 * against seeded rows is deferred to integration (see the describe.skip block at
 * the bottom for why it can't run under the mocked-Prisma unit harness).
 */

import { Prisma } from '@prisma/client'

import {
  buildPaymentWhereFilter,
  buildPaymentSqlClause,
  legacyAdmission,
  legacyMatchesFilter,
  bucketOf,
  computeMerchantAccountBreakdown,
  computeSettlementProjection,
  type PaymentMethodFilter,
  type CardTypeFilter,
} from '@/services/dashboard/sales-summary.dashboard.service'
import { prismaMock } from '@tests/__helpers__/setup'

// NULL-safe "not international" OR-form shared by CREDIT / DEBIT / AMEX.
// Mirrors buildPaymentWhereFilter so the expected shapes stay in one place.
// REGRESSION GUARD: a naive `NOT: { processorData: { path, equals: true } }`
// (the original bug) drops rows with NULL / absent processorData. Real payments
// frequently lack the flag, so the report under-counted CREDIT/DEBIT badly
// (incident 2026-06-02). These three OR branches restore those rows.
const NOT_INTERNATIONAL = {
  OR: [
    { processorData: { equals: Prisma.DbNull } },
    { processorData: { path: ['isInternational'], equals: Prisma.AnyNull } },
    { NOT: { processorData: { path: ['isInternational'], equals: true } } },
  ],
}
// NULL-safe "not AMEX brand": includes rows with no captured cardBrand.
const NOT_AMEX_BRAND = {
  OR: [{ cardBrand: null }, { cardBrand: { not: 'AMERICAN_EXPRESS' } }],
}

// ============================================================
// buildPaymentWhereFilter — Prisma where fragment
// ============================================================

describe('buildPaymentWhereFilter', () => {
  it('returns an empty object when no payment method is given (no narrowing)', () => {
    expect(buildPaymentWhereFilter(undefined)).toEqual({})
    expect(buildPaymentWhereFilter(undefined, 'CREDIT')).toEqual({})
  })

  it('maps CASH to a single-method equality', () => {
    expect(buildPaymentWhereFilter('CASH')).toEqual({ method: 'CASH' })
  })

  it('maps OTHER to the non-card / non-cash method set', () => {
    expect(buildPaymentWhereFilter('OTHER')).toEqual({
      method: { in: ['DIGITAL_WALLET', 'BANK_TRANSFER', 'CRYPTOCURRENCY', 'OTHER'] },
    })
  })

  it('throws on QR_LEGACY (defense-in-depth — must be short-circuited upstream)', () => {
    expect(() => buildPaymentWhereFilter('QR_LEGACY')).toThrow(/QR_LEGACY should be short-circuited/)
  })

  it('maps CARD without a card type to both card methods', () => {
    expect(buildPaymentWhereFilter('CARD')).toEqual({
      method: { in: ['CREDIT_CARD', 'DEBIT_CARD'] },
    })
  })

  it('maps CARD + INTERNATIONAL to card methods + isInternational JSON path', () => {
    expect(buildPaymentWhereFilter('CARD', 'INTERNATIONAL')).toEqual({
      method: { in: ['CREDIT_CARD', 'DEBIT_CARD'] },
      processorData: { path: ['isInternational'], equals: true },
    })
  })

  it('maps CARD + AMEX to AMEX brand, card methods, and NULL-safe NOT-international', () => {
    expect(buildPaymentWhereFilter('CARD', 'AMEX')).toEqual({
      method: { in: ['CREDIT_CARD', 'DEBIT_CARD'] },
      cardBrand: 'AMERICAN_EXPRESS',
      AND: [NOT_INTERNATIONAL],
    })
  })

  it('maps CARD + CREDIT to CREDIT_CARD with NULL-safe AMEX + international exclusions', () => {
    expect(buildPaymentWhereFilter('CARD', 'CREDIT')).toEqual({
      method: 'CREDIT_CARD',
      AND: [NOT_AMEX_BRAND, NOT_INTERNATIONAL],
    })
  })

  it('maps CARD + DEBIT to DEBIT_CARD with NULL-safe AMEX + international exclusions', () => {
    expect(buildPaymentWhereFilter('CARD', 'DEBIT')).toEqual({
      method: 'DEBIT_CARD',
      AND: [NOT_AMEX_BRAND, NOT_INTERNATIONAL],
    })
  })
})

// ============================================================
// buildPaymentSqlClause — raw-SQL twin of the Prisma fragment
// ============================================================

describe('buildPaymentSqlClause', () => {
  it('returns an empty string when no payment method is given', () => {
    expect(buildPaymentSqlClause(undefined, undefined)).toBe('')
    expect(buildPaymentSqlClause(undefined, 'AMEX')).toBe('')
  })

  it('emits a method equality for CASH', () => {
    const clause = buildPaymentSqlClause('CASH', undefined)
    expect(clause).toContain("method = 'CASH'")
  })

  it('emits the non-card method set for OTHER', () => {
    const clause = buildPaymentSqlClause('OTHER', undefined)
    expect(clause).toContain("method IN ('DIGITAL_WALLET','BANK_TRANSFER','CRYPTOCURRENCY','OTHER')")
  })

  it('throws on QR_LEGACY (defense-in-depth — must be short-circuited upstream)', () => {
    expect(() => buildPaymentSqlClause('QR_LEGACY', undefined)).toThrow(/QR_LEGACY should be short-circuited/)
  })

  it('emits both card methods for CARD without a card type', () => {
    const clause = buildPaymentSqlClause('CARD', undefined)
    expect(clause).toContain("method IN ('CREDIT_CARD','DEBIT_CARD')")
  })

  it('emits card methods AND the isInternational JSON path for CARD + INTERNATIONAL', () => {
    const clause = buildPaymentSqlClause('CARD', 'INTERNATIONAL')
    expect(clause).toContain("method IN ('CREDIT_CARD','DEBIT_CARD')")
    expect(clause).toContain('"processorData"->>\'isInternational\')::boolean = true')
  })

  it('emits AMEX brand AND card methods AND not-international for CARD + AMEX', () => {
    const clause = buildPaymentSqlClause('CARD', 'AMEX')
    expect(clause).toContain("method IN ('CREDIT_CARD','DEBIT_CARD')")
    expect(clause).toContain('"cardBrand" = \'AMERICAN_EXPRESS\'')
    // not-international guard (NULL-safe)
    expect(clause).toContain('"processorData"->>\'isInternational\')::boolean = false')
  })

  it('emits CREDIT_CARD, AMEX exclusion, and not-international for CARD + CREDIT', () => {
    const clause = buildPaymentSqlClause('CARD', 'CREDIT')
    expect(clause).toContain("method = 'CREDIT_CARD'")
    expect(clause).toContain('"cardBrand" <> \'AMERICAN_EXPRESS\'')
    expect(clause).toContain('"processorData"->>\'isInternational\')::boolean = false')
  })

  it('emits DEBIT_CARD, AMEX exclusion, and not-international for CARD + DEBIT', () => {
    const clause = buildPaymentSqlClause('CARD', 'DEBIT')
    expect(clause).toContain("method = 'DEBIT_CARD'")
    expect(clause).toContain('"cardBrand" <> \'AMERICAN_EXPRESS\'')
    expect(clause).toContain('"processorData"->>\'isInternational\')::boolean = false')
  })

  it('prefixes every column with the supplied table alias', () => {
    const clause = buildPaymentSqlClause('CASH', undefined, 'p')
    expect(clause).toContain('p.method')
    expect(clause).not.toContain(' method =') // bare (un-prefixed) column must not appear
  })

  it('prefixes the processorData JSON column with the table alias too', () => {
    const clause = buildPaymentSqlClause('CARD', 'INTERNATIONAL', 'p')
    expect(clause).toContain('p."processorData"')
    expect(clause).toContain("p.method IN ('CREDIT_CARD','DEBIT_CARD')")
  })

  it('starts each non-empty clause with " AND " so it can be concatenated onto a WHERE', () => {
    expect(buildPaymentSqlClause('CASH', undefined).startsWith(' AND ')).toBe(true)
    expect(buildPaymentSqlClause('CARD', 'AMEX').startsWith(' AND ')).toBe(true)
  })
})

// ============================================================
// buildPaymentWhereFilter <-> buildPaymentSqlClause parity
// ============================================================
//
// The Prisma fragment and the SQL clause must select the SAME payments for
// every filter combination. We can't run SQL here, but we CAN assert that the
// two builders agree on which dimensions they constrain (method set, card
// brand, international flag) — a cheap structural cross-check that catches the
// most likely drift (one builder updated, the other forgotten).

describe('buildPaymentWhereFilter <-> buildPaymentSqlClause parity', () => {
  const cardTypes: Array<CardTypeFilter | undefined> = [undefined, 'CREDIT', 'DEBIT', 'AMEX', 'INTERNATIONAL']
  const combos: Array<[PaymentMethodFilter | undefined, CardTypeFilter | undefined]> = [
    [undefined, undefined],
    ['CASH', undefined],
    ['OTHER', undefined],
    ...cardTypes.map(ct => ['CARD', ct] as [PaymentMethodFilter, CardTypeFilter | undefined]),
  ]

  it.each(combos)('agree on whether a filter is active for (%s, %s)', (pm, ct) => {
    const where = buildPaymentWhereFilter(pm, ct)
    const clause = buildPaymentSqlClause(pm, ct)
    const whereIsEmpty = Object.keys(where).length === 0
    const clauseIsEmpty = clause === ''
    expect(whereIsEmpty).toBe(clauseIsEmpty)
  })

  // The Prisma fragment nests its exclusions inside AND/OR/NOT arrays (the
  // NULL-safe forms), so a shallow `key in where` check misses them. Walk the
  // whole tree and report which column keys appear anywhere.
  const keyAppears = (node: unknown, key: string): boolean => {
    if (Array.isArray(node)) return node.some(n => keyAppears(n, key))
    if (node && typeof node === 'object') {
      return Object.entries(node as Record<string, unknown>).some(([k, v]) => k === key || keyAppears(v, key))
    }
    return false
  }

  it.each(combos)('agree on constraining the AMEX brand for (%s, %s)', (pm, ct) => {
    const where = buildPaymentWhereFilter(pm, ct)
    const clause = buildPaymentSqlClause(pm, ct)
    expect(keyAppears(where, 'cardBrand')).toBe(clause.includes('"cardBrand"'))
  })

  it.each(combos)('agree on constraining the international flag for (%s, %s)', (pm, ct) => {
    const where = buildPaymentWhereFilter(pm, ct)
    const clause = buildPaymentSqlClause(pm, ct)
    expect(keyAppears(where, 'processorData')).toBe(clause.includes('isInternational'))
  })
})

// ============================================================
// Regression guard — NULL / absent fields must NOT be dropped
// (incident 2026-06-02: CREDIT 157→20, DEBIT 117→0, negative totals)
// ============================================================

describe('buildPaymentWhereFilter NULL-safety (regression)', () => {
  // A deep walk that asserts the buggy naive shapes are NOT used, and the
  // NULL-inclusive OR branches ARE present, for CREDIT / DEBIT / AMEX.
  const json = (v: unknown) => JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? String(val) : val))

  it('CREDIT includes a NULL cardBrand branch (not a bare `not` that drops NULLs)', () => {
    const where = buildPaymentWhereFilter('CARD', 'CREDIT')
    // The fix lives in an OR with an explicit { cardBrand: null } branch.
    expect(json(where)).toContain('"cardBrand":null')
    // The naive top-level form { cardBrand: { not: 'AMERICAN_EXPRESS' } } (which
    // silently excludes NULL brands in Postgres) must NOT be the whole story.
    expect((where as Record<string, unknown>).cardBrand).toBeUndefined()
  })

  it('CREDIT/DEBIT/AMEX all carry the NULL-safe NOT_INTERNATIONAL OR (DbNull + AnyNull + NOT)', () => {
    for (const ct of ['CREDIT', 'DEBIT', 'AMEX'] as const) {
      const where = buildPaymentWhereFilter('CARD', ct)
      // Must reach the int'l flag via the 3-branch OR, never a bare top-level NOT.
      expect((where as Record<string, unknown>).NOT).toBeUndefined()
      expect(json(where)).toContain('isInternational')
    }
  })

  it('INTERNATIONAL stays a positive match (no NULL hazard)', () => {
    expect(buildPaymentWhereFilter('CARD', 'INTERNATIONAL')).toEqual({
      method: { in: ['CREDIT_CARD', 'DEBIT_CARD'] },
      processorData: { path: ['isInternational'], equals: true },
    })
  })
})

// ============================================================
// legacyAdmission — single source of truth for legacy QR admission
// ============================================================

describe('legacyAdmission', () => {
  const allCardTypes: Array<CardTypeFilter | undefined> = [undefined, 'CREDIT', 'DEBIT', 'AMEX', 'INTERNATIONAL']

  it('includes all legacy rows (no method narrowing) when no payment method is set', () => {
    for (const ct of allCardTypes) {
      expect(legacyAdmission(undefined, ct)).toEqual({ include: true })
    }
  })

  it('includes all legacy rows for QR_LEGACY regardless of card type', () => {
    for (const ct of allCardTypes) {
      expect(legacyAdmission('QR_LEGACY', ct)).toEqual({ include: true })
    }
  })

  it('includes only CASH-method legacy rows for the CASH filter', () => {
    for (const ct of allCardTypes) {
      expect(legacyAdmission('CASH', ct)).toEqual({ include: true, method: 'CASH' })
    }
  })

  it('excludes all legacy rows for the OTHER filter (legacy is only CASH/CARD)', () => {
    for (const ct of allCardTypes) {
      expect(legacyAdmission('OTHER', ct)).toEqual({ include: false })
    }
  })

  it('includes CARD-method legacy rows for CARD with no card type', () => {
    expect(legacyAdmission('CARD', undefined)).toEqual({ include: true, method: 'CARD' })
  })

  it('includes CARD-method legacy rows for CARD + CREDIT (legacy cards are treated as credit)', () => {
    expect(legacyAdmission('CARD', 'CREDIT')).toEqual({ include: true, method: 'CARD' })
  })

  it('excludes legacy rows for CARD + DEBIT (legacy lacks a reliable debit signal)', () => {
    expect(legacyAdmission('CARD', 'DEBIT')).toEqual({ include: false })
  })

  it('excludes legacy rows for CARD + AMEX (legacy lacks cardBrand)', () => {
    expect(legacyAdmission('CARD', 'AMEX')).toEqual({ include: false })
  })

  it('excludes legacy rows for CARD + INTERNATIONAL (legacy lacks the international flag)', () => {
    expect(legacyAdmission('CARD', 'INTERNATIONAL')).toEqual({ include: false })
  })
})

// ============================================================
// legacyMatchesFilter — row-level twin of legacyAdmission
// ============================================================

describe('legacyMatchesFilter', () => {
  it('keeps a CASH legacy row under the CASH filter, drops a CARD legacy row', () => {
    expect(legacyMatchesFilter('CASH', 'CASH', undefined)).toBe(true)
    expect(legacyMatchesFilter('CARD', 'CASH', undefined)).toBe(false)
  })

  it('keeps a CARD legacy row under CARD and CARD+CREDIT, drops it under CARD+DEBIT', () => {
    expect(legacyMatchesFilter('CARD', 'CARD', undefined)).toBe(true)
    expect(legacyMatchesFilter('CARD', 'CARD', 'CREDIT')).toBe(true)
    expect(legacyMatchesFilter('CARD', 'CARD', 'DEBIT')).toBe(false)
  })

  it('keeps any legacy row when there is no filter, drops everything under OTHER', () => {
    expect(legacyMatchesFilter('CASH', undefined, undefined)).toBe(true)
    expect(legacyMatchesFilter('CARD', undefined, undefined)).toBe(true)
    expect(legacyMatchesFilter('CASH', 'OTHER', undefined)).toBe(false)
    expect(legacyMatchesFilter('CARD', 'OTHER', undefined)).toBe(false)
  })

  // Property-style guard: legacyMatchesFilter must agree with the manual
  // derivation from legacyAdmission for EVERY (legacyMethod, paymentMethod,
  // cardType) combination. This is the test that stops the two from drifting.
  it('never drifts from legacyAdmission for any combination', () => {
    const legacyMethods = ['CASH', 'CARD']
    // Exclude QR_LEGACY: it never reaches the filter builders (short-circuited
    // upstream) and is the only value whose admission is trivially "include all".
    const paymentMethods: Array<PaymentMethodFilter | undefined> = [undefined, 'CASH', 'CARD', 'OTHER', 'QR_LEGACY']
    const cardTypes: Array<CardTypeFilter | undefined> = [undefined, 'CREDIT', 'DEBIT', 'AMEX', 'INTERNATIONAL']

    for (const legacyMethod of legacyMethods) {
      for (const pm of paymentMethods) {
        for (const ct of cardTypes) {
          const admission = legacyAdmission(pm, ct)
          // Manual derivation of the expected row-level result.
          const expected = !admission.include ? false : !admission.method ? true : legacyMethod === admission.method
          expect(legacyMatchesFilter(legacyMethod, pm, ct)).toBe(expected)
        }
      }
    }
  })
})

// ============================================================
// bucketOf — mirrors determineTransactionCardType precedence
// ============================================================
//
// Precedence (see transactionCost.service.ts determineTransactionCardType,
// lines ~33-58): international wins first, then AMEX brand, then the card
// method (credit/debit). bucketOf MUST follow the same order so a payment that
// counts as AMEX / INTERNATIONAL in cost calc counts the same in the breakdown.

describe('bucketOf', () => {
  it('classifies CASH as the CASH bucket (no sub-bucket)', () => {
    expect(bucketOf('CASH', null, false)).toEqual({ bucket: 'CASH' })
  })

  it('classifies a domestic credit card as CARD / CREDIT', () => {
    expect(bucketOf('CREDIT_CARD', 'VISA', false)).toEqual({ bucket: 'CARD', sub: 'CREDIT' })
  })

  it('classifies a domestic debit card as CARD / DEBIT', () => {
    expect(bucketOf('DEBIT_CARD', 'VISA', false)).toEqual({ bucket: 'CARD', sub: 'DEBIT' })
  })

  it('classifies a domestic AMEX card as CARD / AMEX', () => {
    expect(bucketOf('CREDIT_CARD', 'AMERICAN_EXPRESS', false)).toEqual({ bucket: 'CARD', sub: 'AMEX' })
  })

  it('lets international win over the card brand (VISA international → INTERNATIONAL)', () => {
    expect(bucketOf('CREDIT_CARD', 'VISA', true)).toEqual({ bucket: 'CARD', sub: 'INTERNATIONAL' })
  })

  it('lets international win over AMEX (AMEX international → INTERNATIONAL, not AMEX)', () => {
    expect(bucketOf('CREDIT_CARD', 'AMERICAN_EXPRESS', true)).toEqual({ bucket: 'CARD', sub: 'INTERNATIONAL' })
    expect(bucketOf('DEBIT_CARD', 'AMERICAN_EXPRESS', true)).toEqual({ bucket: 'CARD', sub: 'INTERNATIONAL' })
  })

  it('classifies a digital wallet as the OTHER bucket', () => {
    expect(bucketOf('DIGITAL_WALLET', null, false)).toEqual({ bucket: 'OTHER' })
  })

  it('classifies a bank transfer as the OTHER bucket', () => {
    expect(bucketOf('BANK_TRANSFER', null, false)).toEqual({ bucket: 'OTHER' })
  })

  it('classifies crypto and unknown methods as the OTHER fallthrough', () => {
    // OTHER is the silent fallthrough; guard it so a future PaymentMethod enum
    // value that should bucket elsewhere can't land here unnoticed.
    expect(bucketOf('CRYPTOCURRENCY', null, false)).toEqual({ bucket: 'OTHER' })
    expect(bucketOf('SOME_FUTURE_METHOD', null, false)).toEqual({ bucket: 'OTHER' })
  })

  it('keeps the international flag winning even with a null card brand', () => {
    expect(bucketOf('DEBIT_CARD', null, true)).toEqual({ bucket: 'CARD', sub: 'INTERNATIONAL' })
  })
})

// ============================================================
// Integration coverage of getSalesSummary — deferred
// ============================================================
//
// End-to-end coverage of getSalesSummary (seed a venue + ~6 payments across
// every bucket, then assert the filtered/unfiltered summary, the byPaymentMethod
// skip-under-filter, and the byPaymentMethodDetailed sub-buckets) requires a
// REAL Postgres: the service issues `prisma.$queryRawUnsafe` for platform fees
// and period metrics, and the canonical card-type buckets depend on JSON
// `processorData->>'isInternational'` evaluation — neither of which the unit
// harness can reproduce (tests/__helpers__/setup.ts replaces prisma with an
// in-memory jest mock whose `$queryRaw*` returns whatever you tell it, so an
// integration test built on it would assert the mock, not the SQL).
//
// This is intentionally a `describe.skip` rather than a brittle mock-driven
// fake. The pure-function tests above are the high-value guard the reviewers
// asked for — they pin the canonical mappings that every query path derives
// from. Full DB-backed assertions are deferred to manual / Phase 10
// verification against a seeded venue.
describe.skip('getSalesSummary (integration — needs a seeded Postgres, deferred to Phase 10)', () => {
  it('no filter → filtered=false, grossSales not null', () => {
    /* requires real DB */
  })
  it('CASH filter → filtered=true, grossSales null, only cash transactions', () => {
    /* requires real DB */
  })
  it('CARD+AMEX filter → only the AMEX transaction', () => {
    /* requires real DB */
  })
  it('CARD+INTERNATIONAL filter → only the international transaction', () => {
    /* requires real DB */
  })
  it('byPaymentMethod skipped under filter; byPaymentMethodDetailed present + CARD subBuckets correct when unfiltered', () => {
    /* requires real DB */
  })
})

// ---------------------------------------------------------------------------
// computeMerchantAccountBreakdown — focused, mock-friendly (touches prisma via
// $queryRaw + merchantAccount.findMany, both mocked). Unlike getSalesSummary,
// this helper IS unit-testable under the mocked-Prisma harness.
// ---------------------------------------------------------------------------
describe('computeMerchantAccountBreakdown', () => {
  const VENUE = 'venue-amaena'
  const START = new Date('2026-05-01T00:00:00.000Z')
  const END = new Date('2026-05-31T23:59:59.999Z')

  it('groups card payments by merchant, computes net = collected - fee, sorted by collected desc', async () => {
    ;(prismaMock.$queryRaw as jest.Mock).mockResolvedValue([
      { merchantAccountId: 'ma-A', collected: 1823, fee: 65.6, txns: 5 },
      { merchantAccountId: 'ma-ext', collected: 13827, fee: 497.7, txns: 17 },
    ])
    ;(prismaMock.merchantAccount.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'ma-A',
        displayName: 'Amaena - A',
        alias: null,
        angelpayAffiliation: '7494104',
        displayOrder: 0,
        provider: { name: 'AngelPay (Nexgo)' },
      },
      {
        id: 'ma-ext',
        displayName: 'Amaena - Externo',
        alias: null,
        angelpayAffiliation: null,
        displayOrder: 2,
        provider: { name: 'Blumon PAX' },
      },
    ])

    const result = await computeMerchantAccountBreakdown(VENUE, START, END)

    expect(result).toHaveLength(2)
    // sorted by collectedOnCard desc → Externo first
    expect(result[0].merchantAccountId).toBe('ma-ext')
    expect(result[0].displayName).toBe('Amaena - Externo')
    expect(result[0].provider).toBe('Blumon PAX')
    expect(result[0].affiliation).toBeNull()
    expect(result[0].collectedOnCard).toBe(13827)
    expect(result[0].platformFee).toBeCloseTo(497.7, 2)
    expect(result[0].netToReceive).toBeCloseTo(13329.3, 2)
    expect(result[0].transactionCount).toBe(17)

    expect(result[1].merchantAccountId).toBe('ma-A')
    expect(result[1].affiliation).toBe('7494104')
    expect(result[1].netToReceive).toBeCloseTo(1757.4, 2)
  })

  it('returns [] when there are no card payments (and skips the label query)', async () => {
    ;(prismaMock.$queryRaw as jest.Mock).mockResolvedValue([])
    const result = await computeMerchantAccountBreakdown(VENUE, START, END)
    expect(result).toEqual([])
    expect(prismaMock.merchantAccount.findMany).not.toHaveBeenCalled()
  })

  it('falls back to alias, then a generic label, when displayName is missing', async () => {
    ;(prismaMock.$queryRaw as jest.Mock).mockResolvedValue([{ merchantAccountId: 'ma-x', collected: 100, fee: 4, txns: 1 }])
    ;(prismaMock.merchantAccount.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'ma-x',
        displayName: null,
        alias: 'Cuenta vieja',
        angelpayAffiliation: null,
        displayOrder: 0,
        provider: { name: 'AngelPay (Nexgo)' },
      },
    ])
    const result = await computeMerchantAccountBreakdown(VENUE, START, END)
    expect(result[0].displayName).toBe('Cuenta vieja')
  })
})

// ---------------------------------------------------------------------------
// computeSettlementProjection (Entrega 2) — projects WHEN card money lands.
// Touches prisma via payment/settlementConfiguration/merchantAccount findMany
// (all mocked) and runs the REAL settlement engine (calculateSettlementDate +
// business-day/MX-holiday math). System time is pinned so day status is stable.
// ---------------------------------------------------------------------------
describe('computeSettlementProjection', () => {
  const VENUE = 'venue-amaena'
  const TZ = 'America/Mexico_City'
  const START = new Date('2026-06-01T00:00:00.000Z')
  const END = new Date('2026-06-30T23:59:59.999Z')

  // Pin "today" well after the projected dates so every day reads as 'settled'.
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-30T12:00:00.000Z'))
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  const baseConfig = {
    settlementDays: 1,
    settlementDayType: 'BUSINESS_DAYS',
    cutoffTime: '23:00',
    cutoffTimezone: TZ,
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    effectiveTo: null,
  }

  function mockRows() {
    ;(prismaMock.payment.findMany as jest.Mock).mockResolvedValue([
      // Two ma-A CREDIT payments on Thu 2026-06-04 → settle next business day (Fri 06-05), grouped together.
      {
        amount: 1000,
        tipAmount: 100,
        createdAt: new Date('2026-06-04T15:00:00.000Z'),
        merchantAccountId: 'ma-A',
        transactionCost: { transactionType: 'CREDIT', venueChargeAmount: 30, venueFixedFee: 5 },
      },
      {
        amount: 500,
        tipAmount: 0,
        createdAt: new Date('2026-06-04T16:00:00.000Z'),
        merchantAccountId: 'ma-A',
        transactionCost: { transactionType: 'CREDIT', venueChargeAmount: 15, venueFixedFee: 5 },
      },
      // ma-ext DEBIT on Fri 2026-06-05 → +1 business day skips the weekend → Mon 06-08.
      {
        amount: 2000,
        tipAmount: 0,
        createdAt: new Date('2026-06-05T10:00:00.000Z'),
        merchantAccountId: 'ma-ext',
        transactionCost: { transactionType: 'DEBIT', venueChargeAmount: 60, venueFixedFee: 0 },
      },
      // No settlement config for this merchant → must be excluded (honest "—").
      {
        amount: 999,
        tipAmount: 0,
        createdAt: new Date('2026-06-04T15:00:00.000Z'),
        merchantAccountId: 'ma-noconf',
        transactionCost: { transactionType: 'CREDIT', venueChargeAmount: 10, venueFixedFee: 0 },
      },
    ])
    ;(prismaMock.settlementConfiguration.findMany as jest.Mock).mockResolvedValue([
      { merchantAccountId: 'ma-A', cardType: 'CREDIT', ...baseConfig },
      { merchantAccountId: 'ma-ext', cardType: 'DEBIT', ...baseConfig },
    ])
    ;(prismaMock.merchantAccount.findMany as jest.Mock).mockResolvedValue([
      { id: 'ma-A', displayName: 'Amaena - A', alias: null },
      { id: 'ma-ext', displayName: 'Amaena - Externo', alias: null },
      { id: 'ma-noconf', displayName: 'Sin config', alias: null },
    ])
  }

  it('groups by (settlement date, merchant), nets fee+fixed, and projects per-merchant dates', async () => {
    mockRows()
    const { calendar, nextByMerchant } = await computeSettlementProjection(VENUE, START, END, TZ)

    // Two settlement days: Fri 06-05 (ma-A) before Mon 06-08 (ma-ext), sorted ascending.
    expect(calendar.map(d => d.date)).toEqual(['2026-06-05', '2026-06-08'])
    expect(calendar.every(d => d.status === 'settled')).toBe(true)

    // Day 1 — ma-A, both payments merged: net = (1000+100-35) + (500-20) = 1545, fee 55, 2 txns.
    const day1 = calendar[0]
    expect(day1.byMerchant).toHaveLength(1)
    expect(day1.byMerchant[0].merchantAccountId).toBe('ma-A')
    expect(day1.byMerchant[0].displayName).toBe('Amaena - A')
    expect(day1.byMerchant[0].netToReceive).toBeCloseTo(1545, 2)
    expect(day1.byMerchant[0].platformFee).toBeCloseTo(55, 2)
    expect(day1.byMerchant[0].transactionCount).toBe(2)
    expect(day1.totalNet).toBeCloseTo(1545, 2)

    // Day 2 — ma-ext: net = 2000 - 60 = 1940, fee 60, 1 txn.
    const day2 = calendar[1]
    expect(day2.byMerchant[0].merchantAccountId).toBe('ma-ext')
    expect(day2.byMerchant[0].netToReceive).toBeCloseTo(1940, 2)
    expect(day2.totalNet).toBeCloseTo(1940, 2)

    // The merchant with no config never appears.
    const allMerchants = calendar.flatMap(d => d.byMerchant.map(m => m.merchantAccountId))
    expect(allMerchants).not.toContain('ma-noconf')

    // Per-merchant soonest date for the breakdown "Cae" column.
    expect(nextByMerchant.get('ma-A')).toEqual({ nextDate: '2026-06-05', settlementDays: 1 })
    expect(nextByMerchant.get('ma-ext')).toEqual({ nextDate: '2026-06-08', settlementDays: 1 })
    expect(nextByMerchant.has('ma-noconf')).toBe(false)
  })

  it('returns an empty projection when there are no card payments', async () => {
    ;(prismaMock.payment.findMany as jest.Mock).mockResolvedValue([])
    const { calendar, nextByMerchant } = await computeSettlementProjection(VENUE, START, END, TZ)
    expect(calendar).toEqual([])
    expect(nextByMerchant.size).toBe(0)
    expect(prismaMock.settlementConfiguration.findMany).not.toHaveBeenCalled()
  })
})
