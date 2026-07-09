import { prismaMock } from '../../__helpers__/setup'
import { recordPromoterPing, getPromoterTrack, getPromoterTrackForVenue } from '@/services/promoters/promoterLocation.service'

describe('promoterLocation.service', () => {
  // ── NEW FEATURE: ingest ────────────────────────────────────────────────
  describe('recordPromoterPing', () => {
    it('writes a ping with the given fields and returns its id', async () => {
      prismaMock.venueSettings.findUnique.mockResolvedValue({ trackPromoterLocation: true })
      prismaMock.promoterLocationPing.create.mockResolvedValue({ id: 'ping_1' })
      const capturedAt = new Date('2026-07-01T17:00:00.000Z')

      const result = await recordPromoterPing({
        venueId: 'v1',
        staffId: 's1',
        latitude: 19.4326,
        longitude: -99.1332,
        accuracy: 12,
        capturedAt,
      })

      expect(result).toEqual({ id: 'ping_1' })
      expect(prismaMock.promoterLocationPing.create).toHaveBeenCalledWith({
        data: {
          venueId: 'v1',
          staffId: 's1',
          latitude: 19.4326,
          longitude: -99.1332,
          accuracy: 12,
          capturedAt,
          source: 'PERIODIC',
          terminalId: null,
        },
        select: { id: true },
      })
    })

    // Task 2 (Ubicación de TPVs): attribute each ping to the Terminal that sent it.
    it('persists terminalId when provided', async () => {
      prismaMock.venueSettings.findUnique.mockResolvedValue({ trackPromoterLocation: true })
      prismaMock.promoterLocationPing.create.mockResolvedValue({ id: 'ping_3' })

      await recordPromoterPing({
        venueId: 'v1',
        staffId: 's1',
        latitude: 1,
        longitude: 2,
        capturedAt: new Date('2026-07-08T18:00:00Z'),
        terminalId: 't1',
      })

      expect(prismaMock.promoterLocationPing.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ terminalId: 't1' }) }),
      )
    })

    it('defaults terminalId to null when absent', async () => {
      prismaMock.venueSettings.findUnique.mockResolvedValue({ trackPromoterLocation: true })
      prismaMock.promoterLocationPing.create.mockResolvedValue({ id: 'ping_4' })

      await recordPromoterPing({
        venueId: 'v1',
        staffId: 's1',
        latitude: 1,
        longitude: 2,
        capturedAt: new Date('2026-07-08T18:00:00Z'),
      })

      expect(prismaMock.promoterLocationPing.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ terminalId: null }) }),
      )
    })

    it('defaults source to PERIODIC and accuracy to null when omitted', async () => {
      prismaMock.venueSettings.findUnique.mockResolvedValue({ trackPromoterLocation: true })
      prismaMock.promoterLocationPing.create.mockResolvedValue({ id: 'ping_2' })
      await recordPromoterPing({ venueId: 'v1', staffId: 's1', latitude: 1, longitude: 2, capturedAt: new Date('2026-07-01T17:00:00Z') })
      const arg = prismaMock.promoterLocationPing.create.mock.calls[0][0]
      expect(arg.data.source).toBe('PERIODIC')
      expect(arg.data.accuracy).toBeNull()
    })

    it('throws and writes nothing when tracking is disabled for the venue (backend gate)', async () => {
      prismaMock.venueSettings.findUnique.mockResolvedValue({ trackPromoterLocation: false })

      await expect(
        recordPromoterPing({ venueId: 'v1', staffId: 's1', latitude: 1, longitude: 2, capturedAt: new Date('2026-07-01T17:00:00Z') }),
      ).rejects.toThrow()

      expect(prismaMock.promoterLocationPing.create).not.toHaveBeenCalled()
    })

    // Per-terminal override (tri-state): a terminal-level true/false wins over the venue flag.
    it('creates the ping when terminalTrackOverride=true even though the venue flag is off', async () => {
      prismaMock.venueSettings.findUnique.mockResolvedValue({ trackPromoterLocation: false })
      prismaMock.promoterLocationPing.create.mockResolvedValue({ id: 'ping_5' })

      const result = await recordPromoterPing({
        venueId: 'v1',
        staffId: 's1',
        latitude: 1,
        longitude: 2,
        capturedAt: new Date('2026-07-01T17:00:00Z'),
        terminalTrackOverride: true,
      })

      expect(result).toEqual({ id: 'ping_5' })
      expect(prismaMock.promoterLocationPing.create).toHaveBeenCalled()
    })

    it('throws and writes nothing when terminalTrackOverride=false even though the venue flag is on', async () => {
      prismaMock.venueSettings.findUnique.mockResolvedValue({ trackPromoterLocation: true })

      await expect(
        recordPromoterPing({
          venueId: 'v1',
          staffId: 's1',
          latitude: 1,
          longitude: 2,
          capturedAt: new Date('2026-07-01T17:00:00Z'),
          terminalTrackOverride: false,
        }),
      ).rejects.toThrow()

      expect(prismaMock.promoterLocationPing.create).not.toHaveBeenCalled()
    })

    it('falls back to the venue flag when there is no per-terminal override (existing behavior)', async () => {
      prismaMock.venueSettings.findUnique.mockResolvedValue({ trackPromoterLocation: true })
      prismaMock.promoterLocationPing.create.mockResolvedValue({ id: 'ping_6' })

      const result = await recordPromoterPing({
        venueId: 'v1',
        staffId: 's1',
        latitude: 1,
        longitude: 2,
        capturedAt: new Date('2026-07-01T17:00:00Z'),
      })

      expect(result).toEqual({ id: 'ping_6' })
      expect(prismaMock.promoterLocationPing.create).toHaveBeenCalled()
    })
  })

  // ── NEW FEATURE: read (live pin + day route) ───────────────────────────
  describe('getPromoterTrack', () => {
    it('returns points ordered by capturedAt and latest = last point', async () => {
      const p1 = { latitude: 19.1, longitude: -99.1, accuracy: 10, capturedAt: new Date('2026-07-01T17:00:00Z'), source: 'PERIODIC' }
      const p2 = { latitude: 19.2, longitude: -99.2, accuracy: 8, capturedAt: new Date('2026-07-01T18:00:00Z'), source: 'PERIODIC' }
      prismaMock.promoterLocationPing.findMany.mockResolvedValue([p1, p2])

      const track = await getPromoterTrack({ venueId: 'v1', promoterId: 's1', date: '2026-07-01', timezone: 'America/Mexico_City' })

      expect(track.points).toHaveLength(2)
      expect(track.points[0]).toEqual({ lat: 19.1, lng: -99.1, accuracy: 10, capturedAt: p1.capturedAt, source: 'PERIODIC' })
      expect(track.latest).toEqual(track.points[1])
    })

    it('returns empty points and null latest when there are no pings', async () => {
      prismaMock.promoterLocationPing.findMany.mockResolvedValue([])
      const track = await getPromoterTrack({ venueId: 'v1', promoterId: 's1', date: '2026-07-01', timezone: 'America/Mexico_City' })
      expect(track).toEqual({ points: [], latest: null })
    })

    // Critical: the day range MUST be venue-local and host-tz independent (run under TZ=UTC).
    it('queries a VENUE-LOCAL day range regardless of host timezone', async () => {
      prismaMock.promoterLocationPing.findMany.mockResolvedValue([])

      await getPromoterTrack({ venueId: 'v1', promoterId: 's1', date: '2026-07-01', timezone: 'America/Mexico_City' })

      const where = prismaMock.promoterLocationPing.findMany.mock.calls[0][0].where
      // Mexico is UTC-6 (no DST): July 1 local midnight → 06:00Z; end-of-day → next day 05:59:59.999Z
      expect(where.capturedAt.gte.toISOString()).toBe('2026-07-01T06:00:00.000Z')
      expect(where.capturedAt.lte.toISOString()).toBe('2026-07-02T05:59:59.999Z')
      expect(where.venueId).toBe('v1')
      expect(where.staffId).toBe('s1')
    })
  })

  // ── NEW FEATURE: read resolving venue timezone (dashboard entrypoint) ───
  describe('getPromoterTrackForVenue', () => {
    it('resolves the venue timezone and returns the venue-local day track', async () => {
      prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
      prismaMock.promoterLocationPing.findMany.mockResolvedValue([])

      const track = await getPromoterTrackForVenue({ venueId: 'v1', promoterId: 's1', date: '2026-07-01' })

      expect(track).toEqual({ points: [], latest: null })
      const where = prismaMock.promoterLocationPing.findMany.mock.calls[0][0].where
      expect(where.capturedAt.gte.toISOString()).toBe('2026-07-01T06:00:00.000Z')
      expect(where.venueId).toBe('v1')
      expect(where.staffId).toBe('s1')
    })

    it('falls back to America/Mexico_City when the venue has no timezone', async () => {
      prismaMock.venue.findUnique.mockResolvedValue(null)
      prismaMock.promoterLocationPing.findMany.mockResolvedValue([])

      await getPromoterTrackForVenue({ venueId: 'v1', promoterId: 's1', date: '2026-07-01' })

      const where = prismaMock.promoterLocationPing.findMany.mock.calls[0][0].where
      expect(where.capturedAt.gte.toISOString()).toBe('2026-07-01T06:00:00.000Z')
    })
  })
})
