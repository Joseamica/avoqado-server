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

import {
  buildPaymentWhereFilter,
  buildPaymentSqlClause,
  legacyAdmission,
  legacyMatchesFilter,
  bucketOf,
  type PaymentMethodFilter,
  type CardTypeFilter,
} from '@/services/dashboard/sales-summary.dashboard.service'

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

  it('maps CARD + AMEX to AMEX brand, card methods, and NOT-international', () => {
    expect(buildPaymentWhereFilter('CARD', 'AMEX')).toEqual({
      method: { in: ['CREDIT_CARD', 'DEBIT_CARD'] },
      cardBrand: 'AMERICAN_EXPRESS',
      NOT: { processorData: { path: ['isInternational'], equals: true } },
    })
  })

  it('maps CARD + CREDIT to CREDIT_CARD, excluding AMEX brand and international', () => {
    expect(buildPaymentWhereFilter('CARD', 'CREDIT')).toEqual({
      method: 'CREDIT_CARD',
      cardBrand: { not: 'AMERICAN_EXPRESS' },
      NOT: { processorData: { path: ['isInternational'], equals: true } },
    })
  })

  it('maps CARD + DEBIT to DEBIT_CARD, excluding AMEX brand and international', () => {
    expect(buildPaymentWhereFilter('CARD', 'DEBIT')).toEqual({
      method: 'DEBIT_CARD',
      cardBrand: { not: 'AMERICAN_EXPRESS' },
      NOT: { processorData: { path: ['isInternational'], equals: true } },
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

  it.each(combos)('agree on constraining the AMEX brand for (%s, %s)', (pm, ct) => {
    const where = buildPaymentWhereFilter(pm, ct) as Record<string, unknown>
    const clause = buildPaymentSqlClause(pm, ct)
    const whereTouchesBrand = 'cardBrand' in where
    const clauseTouchesBrand = clause.includes('"cardBrand"')
    expect(whereTouchesBrand).toBe(clauseTouchesBrand)
  })

  it.each(combos)('agree on constraining the international flag for (%s, %s)', (pm, ct) => {
    const where = buildPaymentWhereFilter(pm, ct) as Record<string, unknown>
    const clause = buildPaymentSqlClause(pm, ct)
    // Prisma encodes international either as a positive `processorData` match
    // (INTERNATIONAL) or a `NOT` exclusion (AMEX / CREDIT / DEBIT).
    const whereTouchesIntl = 'processorData' in where || 'NOT' in where
    const clauseTouchesIntl = clause.includes('isInternational')
    expect(whereTouchesIntl).toBe(clauseTouchesIntl)
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
