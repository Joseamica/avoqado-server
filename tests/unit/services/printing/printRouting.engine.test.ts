import { buildTicketPlans, resolveStationId, RoutingConfig, RoutingItemInput } from '../../../../src/services/printing/printRouting.engine'

const COCINA = 'st_cocina'
const BARRA = 'st_barra'
const DEFAULT_ST = 'st_default'

const cfg = (overrides: Partial<RoutingConfig> = {}): RoutingConfig => ({
  defaultStationId: null,
  activeStationIds: new Set([COCINA, BARRA, DEFAULT_ST]),
  ...overrides,
})

const item = (o: Partial<RoutingItemInput> = {}): RoutingItemInput => ({
  orderItemId: o.orderItemId ?? 'oi_1',
  productId: o.productId ?? 'p_1',
  productStationId: o.productStationId ?? null,
  categoryStationId: o.categoryStationId ?? null,
  productName: o.productName ?? 'Taco',
  quantity: o.quantity ?? 1,
  modifiers: o.modifiers ?? [],
  notes: o.notes ?? null,
})

describe('printRouting.engine', () => {
  // ── NEW FEATURE: cascade resolution ────────────────────────────────
  describe('resolveStationId (cascade)', () => {
    it('product override wins over category default (AC2)', () => {
      expect(resolveStationId(item({ productStationId: BARRA, categoryStationId: COCINA }), cfg())).toBe(BARRA)
    })

    it('category default applies when no product override', () => {
      expect(resolveStationId(item({ productStationId: null, categoryStationId: COCINA }), cfg())).toBe(COCINA)
    })

    it('venue default applies when neither product nor category resolve', () => {
      expect(resolveStationId(item(), cfg({ defaultStationId: DEFAULT_ST }))).toBe(DEFAULT_ST)
    })

    it('returns null (unrouted) when nothing resolves and there is no default (I9 — NOT fail-open-to-all)', () => {
      expect(resolveStationId(item(), cfg())).toBeNull()
    })

    it('a station id that is not active falls through the cascade (deleted/deactivated never drops the item)', () => {
      // product points to an inactive station → fall through to category
      expect(resolveStationId(item({ productStationId: 'st_gone', categoryStationId: COCINA }), cfg())).toBe(COCINA)
      // category points to an inactive station and no default → unrouted
      expect(resolveStationId(item({ categoryStationId: 'st_gone' }), cfg())).toBeNull()
    })

    it('an inactive default station is treated as no default', () => {
      expect(resolveStationId(item(), cfg({ defaultStationId: 'st_inactive_default' }))).toBeNull()
    })
  })

  // ── NEW FEATURE: grouping into one ticket per station (AC1) ─────────
  describe('buildTicketPlans (grouping)', () => {
    it('splits an order into one ticket per station, each with ONLY its items (AC1)', () => {
      const plans = buildTicketPlans(
        [
          item({ orderItemId: 'oi_taco1', productName: 'Taco', quantity: 2, categoryStationId: COCINA }),
          item({ orderItemId: 'oi_cerveza', productName: 'Cerveza', quantity: 1, categoryStationId: BARRA }),
        ],
        cfg(),
      )
      expect(plans).toHaveLength(2)
      const cocina = plans.find(p => p.stationId === COCINA)!
      const barra = plans.find(p => p.stationId === BARRA)!
      expect(cocina.lines.map(l => l.productName)).toEqual(['Taco'])
      expect(cocina.lines[0].quantity).toBe(2)
      expect(barra.lines.map(l => l.productName)).toEqual(['Cerveza'])
      expect(cocina.unrouted).toBe(false)
    })

    it('groups unrouted items into a SINGLE unrouted plan (stationId null), never fanned out (I9)', () => {
      const plans = buildTicketPlans(
        [
          item({ orderItemId: 'a', productId: 'p_a', productName: 'Misterio1' }),
          item({ orderItemId: 'b', productId: 'p_b', productName: 'Misterio2' }),
        ],
        cfg(), // no default
      )
      expect(plans).toHaveLength(1)
      expect(plans[0].stationId).toBeNull()
      expect(plans[0].unrouted).toBe(true)
      expect(plans[0].lines).toHaveLength(2)
    })

    it('routes unrouted items to the venue default when one exists (no unrouted plan)', () => {
      const plans = buildTicketPlans([item({ productName: 'Misterio' })], cfg({ defaultStationId: DEFAULT_ST }))
      expect(plans).toHaveLength(1)
      expect(plans[0].stationId).toBe(DEFAULT_ST)
      expect(plans[0].unrouted).toBe(false)
    })
  })

  // ── NEW FEATURE: identical-line consolidation ──────────────────────
  describe('buildTicketPlans (consolidation)', () => {
    it('consolidates identical lines into Nx and preserves all source orderItemIds (delta ledger)', () => {
      const plans = buildTicketPlans(
        [
          item({ orderItemId: 'oi_1', productName: 'Taco', quantity: 1, categoryStationId: COCINA }),
          item({ orderItemId: 'oi_2', productName: 'Taco', quantity: 3, categoryStationId: COCINA }),
        ],
        cfg(),
      )
      expect(plans[0].lines).toHaveLength(1)
      expect(plans[0].lines[0].quantity).toBe(4)
      expect(plans[0].lines[0].orderItemIds.sort()).toEqual(['oi_1', 'oi_2'])
    })

    it('does NOT consolidate lines with different modifiers or notes', () => {
      const plans = buildTicketPlans(
        [
          item({ orderItemId: 'oi_1', productName: 'Taco', modifiers: ['sin cebolla'], categoryStationId: COCINA }),
          item({ orderItemId: 'oi_2', productName: 'Taco', modifiers: ['extra queso'], categoryStationId: COCINA }),
          item({ orderItemId: 'oi_3', productName: 'Taco', notes: 'bien dorado', categoryStationId: COCINA }),
        ],
        cfg(),
      )
      expect(plans[0].lines).toHaveLength(3)
    })

    it('empty-string productId is name-keyed (parity with Kotlin), so two blank-id products do NOT merge', () => {
      // Anti-drift edge case: '' must behave like absent (name-keyed), NOT collapse to a single 'id:' bucket.
      const plans = buildTicketPlans(
        [
          item({ orderItemId: 'a', productId: '', productName: 'A', categoryStationId: COCINA }),
          item({ orderItemId: 'b', productId: '', productName: 'B', categoryStationId: COCINA }),
        ],
        cfg(),
      )
      expect(plans).toHaveLength(1)
      expect(plans[0].lines).toHaveLength(2) // A and B stay separate, not merged under one key
      expect(plans[0].lines.map(l => l.productName)).toEqual(['A', 'B'])
    })

    it('treats modifier order as insignificant (same set consolidates) and sorts them deterministically', () => {
      const plans = buildTicketPlans(
        [
          item({ orderItemId: 'oi_1', productName: 'Taco', modifiers: ['b', 'a'], categoryStationId: COCINA }),
          item({ orderItemId: 'oi_2', productName: 'Taco', modifiers: ['a', 'b'], categoryStationId: COCINA }),
        ],
        cfg(),
      )
      expect(plans[0].lines).toHaveLength(1)
      expect(plans[0].lines[0].quantity).toBe(2)
      expect(plans[0].lines[0].modifiers).toEqual(['a', 'b'])
    })
  })

  // ── EDGE / REGRESSION ──────────────────────────────────────────────
  describe('edge cases', () => {
    it('returns no plans for an empty order', () => {
      expect(buildTicketPlans([], cfg())).toEqual([])
    })

    it('defensively skips zero/negative-quantity lines', () => {
      const plans = buildTicketPlans(
        [
          item({ orderItemId: 'oi_ok', productName: 'Taco', quantity: 2, categoryStationId: COCINA }),
          item({ orderItemId: 'oi_void', productName: 'Taco', quantity: 0, categoryStationId: COCINA }),
        ],
        cfg(),
      )
      expect(plans).toHaveLength(1)
      expect(plans[0].lines[0].quantity).toBe(2)
      expect(plans[0].lines[0].orderItemIds).toEqual(['oi_ok'])
    })

    it('keeps an item routed even when it is the only one and has an explicit product station', () => {
      const plans = buildTicketPlans([item({ productStationId: BARRA })], cfg())
      expect(plans).toHaveLength(1)
      expect(plans[0].stationId).toBe(BARRA)
    })
  })
})
