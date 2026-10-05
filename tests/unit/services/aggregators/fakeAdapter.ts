import { PassAdapter } from '@/services/aggregators/core/types'
export function fakeAdapter(over: Partial<PassAdapter> = {}): jest.Mocked<PassAdapter> {
  return {
    provider: 'TOTALPASS',
    parseWebhook: jest.fn(),
    dedupKey: jest.fn((_k, b: any) => `k:${JSON.stringify(b)}`),
    publishSession: jest.fn().mockResolvedValue({ ok: true, externalOccurrenceId: 'occ-1' }),
    updateSpots: jest.fn().mockResolvedValue({ ok: true }),
    updateSessionDetails: jest.fn().mockResolvedValue({ ok: true }),
    unpublishSession: jest.fn().mockResolvedValue({ ok: true }),
    respondBooking: jest.fn().mockResolvedValue({ ok: true }),
    cancelBooking: jest.fn().mockResolvedValue({ ok: true }),
    validateVisit: jest.fn().mockResolvedValue({ ok: true }),
    identify: jest.fn().mockResolvedValue({ ok: true, externalPlaceId: 'place-1', externalPlaceName: 'Estudio Prueba' }),
    setup: jest.fn().mockResolvedValue({ ok: true, externalPlaceId: 'place-1' }),
    ...over,
  } as unknown as jest.Mocked<PassAdapter>
}
