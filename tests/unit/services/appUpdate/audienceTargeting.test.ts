import { normalizeTargeting, buildAudienceConditions } from '@/services/appUpdate/audienceTargeting'

describe('AppUpdate audience targeting', () => {
  // ──────────────────────────────────────────────────────────────────────────
  // normalizeTargeting — used by the superadmin create/update controllers
  // ──────────────────────────────────────────────────────────────────────────
  describe('normalizeTargeting (payload validation)', () => {
    it('defaults to ALL with empty lists when targetType is omitted (regression: old behavior)', () => {
      expect(normalizeTargeting({})).toEqual({ targetType: 'ALL', targetVenueIds: [], targetTerminalIds: [] })
    })

    it('ALL clears any provided venue/terminal lists', () => {
      expect(normalizeTargeting({ targetType: 'ALL', targetVenueIds: ['v1'], targetTerminalIds: ['t1'] })).toEqual({
        targetType: 'ALL',
        targetVenueIds: [],
        targetTerminalIds: [],
      })
    })

    it('VENUES keeps venue ids and clears terminal ids', () => {
      expect(normalizeTargeting({ targetType: 'VENUES', targetVenueIds: ['v1', 'v2'], targetTerminalIds: ['t1'] })).toEqual({
        targetType: 'VENUES',
        targetVenueIds: ['v1', 'v2'],
        targetTerminalIds: [],
      })
    })

    it('TERMINALS keeps terminal ids and clears venue ids', () => {
      expect(normalizeTargeting({ targetType: 'TERMINALS', targetVenueIds: ['v1'], targetTerminalIds: ['t1', 't2'] })).toEqual({
        targetType: 'TERMINALS',
        targetVenueIds: [],
        targetTerminalIds: ['t1', 't2'],
      })
    })

    it('drops non-string entries from the arrays', () => {
      const result = normalizeTargeting({ targetType: 'VENUES', targetVenueIds: ['v1', 42, null, 'v2', {}] as unknown[] })
      expect(result).toEqual({ targetType: 'VENUES', targetVenueIds: ['v1', 'v2'], targetTerminalIds: [] })
    })

    it('rejects an unknown targetType', () => {
      expect(normalizeTargeting({ targetType: 'EVERYONE' })).toEqual({
        error: 'Invalid targetType. Must be ALL, VENUES, or TERMINALS',
      })
    })

    it('rejects VENUES with an empty venue list', () => {
      expect(normalizeTargeting({ targetType: 'VENUES', targetVenueIds: [] })).toEqual({
        error: 'targetType VENUES requiere al menos un venue en targetVenueIds',
      })
    })

    it('rejects TERMINALS with an empty terminal list', () => {
      expect(normalizeTargeting({ targetType: 'TERMINALS', targetTerminalIds: [] })).toEqual({
        error: 'targetType TERMINALS requiere al menos una terminal en targetTerminalIds',
      })
    })

    it('rejects VENUES when every entry is filtered out as non-string', () => {
      expect(normalizeTargeting({ targetType: 'VENUES', targetVenueIds: [1, 2, null] as unknown[] })).toEqual({
        error: 'targetType VENUES requiere al menos un venue en targetVenueIds',
      })
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // buildAudienceConditions — used by the public GET /tpv/check-update resolver
  // ──────────────────────────────────────────────────────────────────────────
  describe('buildAudienceConditions (check-update resolver)', () => {
    it('unknown terminal (no venue, no serial) → ONLY ALL [fail-safe]', () => {
      expect(buildAudienceConditions(undefined, undefined)).toEqual([{ targetType: 'ALL' }])
    })

    it('known venue → ALL + VENUES has venue', () => {
      expect(buildAudienceConditions('venue-A')).toEqual([
        { targetType: 'ALL' },
        { targetType: 'VENUES', targetVenueIds: { has: 'venue-A' } },
      ])
    })

    it('known terminal (no venue) → ALL + TERMINALS has terminal', () => {
      expect(buildAudienceConditions(undefined, 'term-X')).toEqual([
        { targetType: 'ALL' },
        { targetType: 'TERMINALS', targetTerminalIds: { has: 'term-X' } },
      ])
    })

    it('both venue and terminal → all three conditions', () => {
      expect(buildAudienceConditions('venue-A', 'term-X')).toEqual([
        { targetType: 'ALL' },
        { targetType: 'VENUES', targetVenueIds: { has: 'venue-A' } },
        { targetType: 'TERMINALS', targetTerminalIds: { has: 'term-X' } },
      ])
    })

    it('ALWAYS includes ALL first — a general release reaches every requester (convergence)', () => {
      for (const conds of [buildAudienceConditions(), buildAudienceConditions('v'), buildAudienceConditions('v', 't')]) {
        expect(conds[0]).toEqual({ targetType: 'ALL' })
      }
    })
  })
})
