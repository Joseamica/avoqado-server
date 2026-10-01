import { addMonths } from 'date-fns'
import { assertDependencyTerms, dependencyTermIssues, HYBRID_DEPENDENCIES } from '@/services/launchCampaigns/hybridDependencies'
import { lineCoverage, retainedCoverage } from '@/services/launchCampaigns/hybridCoverage'

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
      { featureCode: 'INVENTORY_TRACKING', endsAt: addMonths(now, 3), unit: line('end') },
      { featureCode: 'AUTO_REORDER', endsAt: null, unit: line('same') },
      { featureCode: 'CFDI', endsAt: null, unit: line('same') },
      { featureCode: 'UPSELL', endsAt: null, unit: line('reprice') },
    ])
  })
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
      'INVENTORY_TRACKING@sub_end': addMonths(startsAt, 2).toISOString(),
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
