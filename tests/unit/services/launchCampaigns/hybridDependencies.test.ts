import { assertDependencyTerms, dependencyTermIssues, HYBRID_DEPENDENCIES } from '@/services/launchCampaigns/hybridDependencies'
import {
  addUtcMonths,
  assertCartDependencyTerms,
  lineCoverage,
  MAX_START_DELAY_MS,
  retainedCoverage,
} from '@/services/launchCampaigns/hybridCoverage'

const DEPS = { AUTO_REORDER: ['INVENTORY_TRACKING'] }
const d = (iso: string) => new Date(`${iso}T12:00:00.000Z`)
const line = (id: string) => ({ kind: 'LINE' as const, publicationId: id })
const kept = (source: string) => ({ kind: 'RETAINED' as const, source })
const day = 86400000

describe('spec §4.2 rule 2: a function never outlives its dependency', () => {
  it('permanent dependent with a 1-month END dependency fails, naming the unit that provides it', () => {
    const issues = dependencyTermIssues(
      [
        { featureCode: 'AUTO_REORDER', endsAt: null, unit: line('a') },
        { featureCode: 'INVENTORY_TRACKING', endsAt: d('2026-11-01'), unit: line('i') },
      ],
      DEPS,
    )
    expect(issues).toEqual([
      { featureCode: 'AUTO_REORDER', requiredFeatureCode: 'INVENTORY_TRACKING', requiredUntil: null, unit: line('i') },
    ])
  })

  it('two END offers: dependent ending later than its dependency fails', () => {
    expect(
      dependencyTermIssues(
        [
          { featureCode: 'AUTO_REORDER', endsAt: d('2027-01-01'), unit: line('a') },
          { featureCode: 'INVENTORY_TRACKING', endsAt: d('2026-11-01'), unit: line('i') },
        ],
        DEPS,
      ),
    ).toHaveLength(1)
  })

  it('missing dependency fails with unit null; equal ends pass; latest source wins', () => {
    expect(dependencyTermIssues([{ featureCode: 'AUTO_REORDER', endsAt: null, unit: line('a') }], DEPS)[0].unit).toBeNull()
    expect(
      dependencyTermIssues(
        [
          { featureCode: 'AUTO_REORDER', endsAt: d('2026-11-01'), unit: line('a') },
          { featureCode: 'INVENTORY_TRACKING', endsAt: d('2026-11-01'), unit: line('i') },
        ],
        DEPS,
      ),
    ).toEqual([])
    expect(
      dependencyTermIssues(
        [
          { featureCode: 'AUTO_REORDER', endsAt: null, unit: line('a') },
          { featureCode: 'INVENTORY_TRACKING', endsAt: d('2026-11-01'), unit: line('i') },
          { featureCode: 'INVENTORY_TRACKING', endsAt: null, unit: kept('sub_1') },
        ],
        DEPS,
      ),
    ).toEqual([])
  })

  it('the dependent keeps its latest end too: a short and a permanent source of it still need a permanent dependency', () => {
    const issues = dependencyTermIssues(
      [
        { featureCode: 'AUTO_REORDER', endsAt: d('2026-10-15'), unit: line('a') },
        { featureCode: 'AUTO_REORDER', endsAt: null, unit: kept('sub_a') },
        { featureCode: 'INVENTORY_TRACKING', endsAt: d('2026-11-01'), unit: kept('sub_i') },
      ],
      DEPS,
    )
    expect(issues).toEqual([
      { featureCode: 'AUTO_REORDER', requiredFeatureCode: 'INVENTORY_TRACKING', requiredUntil: null, unit: kept('sub_i') },
    ])
  })

  it('a dependency ending AFTER its dependent passes; functions without dependencies are never issues', () => {
    expect(
      dependencyTermIssues(
        [
          { featureCode: 'AUTO_REORDER', endsAt: d('2026-11-01'), unit: line('a') },
          { featureCode: 'INVENTORY_TRACKING', endsAt: d('2027-01-01'), unit: line('i') },
          { featureCode: 'CFDI', endsAt: null, unit: line('c') },
        ],
        DEPS,
      ),
    ).toEqual([])
  })

  it('keeps the dependency map the offer hash was built from', () => {
    expect(HYBRID_DEPENDENCIES).toEqual({ AUTO_REORDER: ['INVENTORY_TRACKING'], UPSELL_AI: ['UPSELL'] })
  })

  it('throws HYBRID_DEPENDENCY_TERM in Spanish, with the issues as details and dates serialized', () => {
    let error: any
    try {
      assertDependencyTerms([
        { featureCode: 'AUTO_REORDER', endsAt: null, unit: line('a') },
        { featureCode: 'INVENTORY_TRACKING', endsAt: d('2026-11-01'), unit: line('i') },
      ])
    } catch (caught) {
      error = caught
    }
    expect(error).toMatchObject({
      statusCode: 409,
      code: 'HYBRID_DEPENDENCY_TERM',
      message:
        'Reorden automático necesita Inventario FIFO, recetas y costeo mientras la conserves: agrégalo con precio de lista o consérvalo.',
      details: [{ featureCode: 'AUTO_REORDER', requiredFeatureCode: 'INVENTORY_TRACKING', requiredUntil: null, unit: line('i') }],
    })
    try {
      assertDependencyTerms([
        { featureCode: 'UPSELL_AI', endsAt: d('2027-01-01'), unit: line('a') },
        { featureCode: 'UPSELL', endsAt: d('2026-11-01'), unit: kept('sub_pro') },
      ])
    } catch (caught) {
      error = caught
    }
    expect(error.message).toBe(
      'Sugerencias escritas con IA necesita Sugerencias «¿algo más?» al cobrar al menos hasta el 1 de enero de 2027: agrégalo con precio de lista o consérvalo.',
    )
    expect(error.details).toEqual([
      { featureCode: 'UPSELL_AI', requiredFeatureCode: 'UPSELL', requiredUntil: '2027-01-01T12:00:00.000Z', unit: kept('sub_pro') },
    ])
    expect(() => assertDependencyTerms([{ featureCode: 'CFDI', endsAt: null, unit: line('c') }])).not.toThrow()
  })
})

describe('new cart lines as coverage', () => {
  const now = new Date()
  const terms = (renewal: object, promotionCycles: number | null) => ({
    currency: 'MXN' as const,
    interval: 'MONTHLY' as const,
    price: 199,
    taxIncluded: true as const,
    promotionCycles,
    renewal: renewal as any,
  })
  it('an END line ends after its promotion cycles; SAME_PRICE and REPRICE never end', () => {
    expect(
      lineCoverage(
        [
          { publicationId: 'end', featureCodes: ['INVENTORY_TRACKING'], terms: terms({ kind: 'END' }, 3) },
          { publicationId: 'same', featureCodes: ['AUTO_REORDER', 'CFDI'], terms: terms({ kind: 'SAME_PRICE' }, null) },
          { publicationId: 'reprice', featureCodes: ['UPSELL'], terms: terms({ kind: 'REPRICE', price: 299 }, 2) },
        ],
        now,
      ),
    ).toEqual([
      { featureCode: 'INVENTORY_TRACKING', endsAt: addUtcMonths(now, 3), unit: line('end') },
      { featureCode: 'AUTO_REORDER', endsAt: null, unit: line('same') },
      { featureCode: 'CFDI', endsAt: null, unit: line('same') },
      { featureCode: 'UPSELL', endsAt: null, unit: line('reprice') },
    ])
  })
})

// Codex round 2 (R-C2c): month ends clip (29–31 Jan → 28 Feb), so an END line's end is not monotone in its start across
// a midnight. Since round 3 (R-C2d) the months and the midnights are UTC, as Stripe's: the same answer under any TZ.
describe('the start window of a cart is cut at every UTC midnight', () => {
  const upsellAi = {
    publicationId: 'end',
    featureCodes: ['UPSELL_AI'],
    terms: {
      currency: 'MXN' as const,
      interval: 'MONTHLY' as const,
      price: 99,
      taxIncluded: true as const,
      promotionCycles: 1,
      renewal: { kind: 'END' as const },
    },
  }
  const accepted = new Date('2027-01-29T20:00:00.000Z')
  const kept = [
    { featureCode: 'UPSELL', endsAt: new Date('2027-02-28T21:00:00.000Z'), unit: { kind: 'RETAINED' as const, source: 'sub_pro' } },
  ]
  const issuesAt = (start: Date) => dependencyTermIssues([...kept, ...lineCoverage([upsellAi], start)], HYBRID_DEPENDENCIES)

  it('a recovered start between the two ends outlives the dependency although both ends pass, and the cart is refused', () => {
    expect(issuesAt(accepted)).toEqual([])
    expect(issuesAt(new Date(accepted.getTime() + MAX_START_DELAY_MS))).toEqual([])
    // Codex's start: 30 Jan 23:45 UTC ends 28 Feb 23:45 UTC, past the dependency.
    expect(issuesAt(new Date('2027-01-30T23:45:00.000Z'))).toHaveLength(1)
    let error: unknown
    try {
      assertCartDependencyTerms(kept, [upsellAi], accepted)
    } catch (caught) {
      error = caught
    }
    expect(error).toMatchObject({
      code: 'HYBRID_DEPENDENCY_TERM',
      details: [expect.objectContaining({ featureCode: 'UPSELL_AI', requiredFeatureCode: 'UPSELL' })],
    })
  })

  it('a dependency kept past every start in the window holds the line', () => {
    const longer = [{ ...kept[0], endsAt: new Date('2027-03-03T00:00:00.000Z') }]
    expect(() => assertCartDependencyTerms(longer, [upsellAi], accepted)).not.toThrow()
  })
})

// Codex round 3 (R-C2d): Stripe advances a monthly cycle from its UTC anchor, clipping to the month's end. Every month
// addition here is that one, never the process zone's: the same cart must give the same answer under any TZ (run these
// under TZ=UTC and TZ=America/Mexico_City).
describe("month arithmetic is Stripe's, in UTC", () => {
  it('adds calendar months in UTC from the anchor, clipping to the month end and keeping the time', () => {
    const plus = (iso: string, months: number) => addUtcMonths(new Date(iso), months).toISOString()
    expect(plus('2027-01-31T05:00:00.000Z', 1)).toBe('2027-02-28T05:00:00.000Z')
    expect(plus('2028-01-31T05:00:00.000Z', 1)).toBe('2028-02-29T05:00:00.000Z')
    expect(plus('2027-01-31T05:00:00.000Z', 3)).toBe('2027-04-30T05:00:00.000Z')
    expect(plus('2027-12-31T23:59:59.999Z', 2)).toBe('2028-02-29T23:59:59.999Z')
    // From the anchor, not month after month: the 31st comes back after a short month.
    expect(plus('2027-01-31T05:00:00.000Z', 2)).toBe('2027-03-31T05:00:00.000Z')
    expect(plus('2027-02-28T05:00:00.000Z', 1)).toBe('2027-03-28T05:00:00.000Z')
    expect(plus('2027-01-15T00:30:00.000Z', 12)).toBe('2028-01-15T00:30:00.000Z')
  })

  const upsell = (cycles: number) => ({
    publicationId: 'end',
    featureCodes: ['UPSELL'],
    terms: {
      currency: 'MXN' as const,
      interval: 'MONTHLY' as const,
      price: 99,
      taxIncluded: true as const,
      promotionCycles: cycles,
      renewal: { kind: 'END' as const },
    },
  })
  // A kept UPSELL_AI (its scheduled cancellation) needs UPSELL until then; the cart brings UPSELL as an END line.
  it.each([
    ['Codex: 31 Jan → 28 Feb', '2027-01-31T05:00:00.000Z', 1, '2027-02-28T05:30:00.000Z'],
    ['leap February', '2028-01-31T05:00:00.000Z', 1, '2028-02-29T05:30:00.000Z'],
    ['three months', '2028-01-31T05:00:00.000Z', 3, '2028-04-30T05:30:00.000Z'],
    ['twelve months', '2028-01-31T05:00:00.000Z', 12, '2029-01-31T05:30:00.000Z'],
  ])(
    '%s: a Stripe start at acceptance ends the new dependency 30 min before the kept function, so it is refused',
    (_label, at, cycles, keptUntil) => {
      const kept = [{ featureCode: 'UPSELL_AI', endsAt: new Date(keptUntil), unit: { kind: 'RETAINED' as const, source: 'sub_kept' } }]
      let error: unknown
      try {
        assertCartDependencyTerms(kept, [upsell(cycles)], new Date(at))
      } catch (caught) {
        error = caught
      }
      expect(error).toMatchObject({
        code: 'HYBRID_DEPENDENCY_TERM',
        details: [expect.objectContaining({ featureCode: 'UPSELL_AI', requiredFeatureCode: 'UPSELL' })],
      })
    },
  )
})

describe('what the venue keeps, with end dates', () => {
  const now = Date.now()
  const at = (days: number) => new Date(now + days * day)
  const definition = (renewal: object, promotionCycles: number | null) => ({
    schemaVersion: 1,
    kind: 'FEATURES',
    featureCodes: ['INVENTORY_TRACKING'],
    terms: { currency: 'MXN', interval: 'MONTHLY', price: 499, taxIncluded: true, promotionCycles, renewal },
  })
  const empty = { contracts: [], legacy: [], grants: [] }
  const ends = (items: ReturnType<typeof retainedCoverage>) =>
    Object.fromEntries(items.map(item => [`${item.featureCode}@${(item.unit as any).source}`, item.endsAt?.toISOString() ?? null]))

  it('a kept classic subscription covers its projection until its scheduled end; a replaced one covers nothing', () => {
    const items = retainedCoverage({
      inventory: {
        vivas: [
          { subscriptionId: 'sub_pro', proyecciones: [{ tipo: 'PLAN', tier: 'PRO' }] },
          { subscriptionId: 'sub_cfdi', proyecciones: [{ tipo: 'FUNCION', featureCode: 'CFDI' }] },
          { subscriptionId: 'sub_gone', proyecciones: [{ tipo: 'FUNCION', featureCode: 'INVENTORY_TRACKING' }] },
        ],
        detalle: {
          sub_pro: { terminaEn: at(10).toISOString() },
          sub_cfdi: { terminaEn: null },
          sub_gone: { terminaEn: null },
        } as any,
      },
      replaceSubscriptionIds: ['sub_gone'],
      ...empty,
    })
    const covered = ends(items)
    expect(covered['UPSELL@sub_pro']).toBe(at(10).toISOString())
    expect(covered['CFDI@sub_cfdi']).toBeNull()
    expect(Object.keys(covered).some(key => key.endsWith('@sub_gone'))).toBe(false)
  })

  it('a kept hybrid contract ends at the earliest of its subscription end, its cancelAt and its END promotion', () => {
    const startsAt = at(-20)
    const contract = (sub: string, renewal: object, cycles: number | null, cancelAt: Date | null) => ({
      stripeSubscriptionId: sub,
      featureCodes: ['INVENTORY_TRACKING'],
      startsAt,
      cancelAt,
      publication: { definition: definition(renewal, cycles) },
    })
    const viva = (sub: string) => ({
      subscriptionId: sub,
      proyecciones: [{ tipo: 'PAQUETE' as const, featureCodes: ['INVENTORY_TRACKING'] }],
    })
    const items = retainedCoverage({
      inventory: {
        vivas: ['sub_end', 'sub_cancel', 'sub_same', 'sub_reprice_stripe'].map(viva),
        detalle: {
          sub_end: { terminaEn: null },
          sub_cancel: { terminaEn: null },
          sub_same: { terminaEn: null },
          sub_reprice_stripe: { terminaEn: at(3).toISOString() },
        } as any,
      },
      replaceSubscriptionIds: [],
      contracts: [
        contract('sub_end', { kind: 'END' }, 2, null),
        contract('sub_cancel', { kind: 'END' }, 6, at(5)),
        contract('sub_same', { kind: 'SAME_PRICE' }, null, null),
        contract('sub_reprice_stripe', { kind: 'REPRICE', price: 599 }, 2, at(30)),
      ],
      legacy: [],
      grants: [],
    })
    expect(ends(items)).toEqual({
      'INVENTORY_TRACKING@sub_end': addUtcMonths(startsAt, 2).toISOString(),
      // cancelAt limits ANY contract, also SAME_PRICE and REPRICE (spec §4.2).
      'INVENTORY_TRACKING@sub_cancel': at(5).toISOString(),
      'INVENTORY_TRACKING@sub_same': null,
      'INVENTORY_TRACKING@sub_reprice_stripe': at(3).toISOString(),
    })
  })

  it('legacy rows end at endDate, never past their live subscription; a manual plan row covers its plan; manual grants end at endsAt', () => {
    const items = retainedCoverage({
      inventory: {
        vivas: [{ subscriptionId: 'sub_inv', proyecciones: [{ tipo: 'FUNCION', featureCode: 'INVENTORY_TRACKING' }] }],
        detalle: { sub_inv: { terminaEn: at(7).toISOString() } } as any,
      },
      replaceSubscriptionIds: [],
      contracts: [],
      legacy: [
        { stripeSubscriptionId: 'sub_inv', endDate: null, feature: { code: 'INVENTORY_TRACKING' } },
        { stripeSubscriptionId: null, endDate: at(12), feature: { code: 'AUTO_REORDER' } },
        { stripeSubscriptionId: null, endDate: null, feature: { code: 'PLAN_PRO' } },
      ],
      grants: [
        { featureCode: 'CFDI', endsAt: at(40), contractId: null },
        { featureCode: 'COMMISSIONS', endsAt: at(40), contractId: 'contract_kept' },
      ],
    })
    const covered = ends(items)
    expect(covered['INVENTORY_TRACKING@sub_inv']).toBe(at(7).toISOString())
    expect(covered['AUTO_REORDER@manual']).toBe(at(12).toISOString())
    expect(covered['UPSELL@manual']).toBeNull()
    expect(covered['PLAN_PRO@manual']).toBeUndefined()
    expect(covered['CFDI@manual']).toBe(at(40).toISOString())
    // A contract's own grants are represented by the contract (its subscription and its limits), not twice.
    expect(items.some(item => item.featureCode === 'COMMISSIONS')).toBe(false)
  })
})
