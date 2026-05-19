import { deactivateVenueChat, generateActivationForVenue, getVenueChatStatus } from '@/services/venueChatAdmin.service'
import { hashActivationToken, last4 } from '@/utils/activationToken'

import { prismaMock } from '../../__helpers__/setup'

const VENUE_ID = 'venue-1'

describe('generateActivationForVenue', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('invalidates open tokens, creates a fresh token, returns raw token + last4 + expiresAt', async () => {
    prismaMock.venueWhatsappActivation.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.venueWhatsappActivation.create.mockResolvedValue({} as any)

    const result = await generateActivationForVenue(VENUE_ID)

    expect(prismaMock.venueWhatsappActivation.updateMany).toHaveBeenCalledWith({
      where: { venueId: VENUE_ID, consumedAt: null, invalidatedAt: null },
      data: expect.objectContaining({ invalidatedAt: expect.any(Date) }),
    })
    expect(prismaMock.venueWhatsappActivation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        venueId: VENUE_ID,
        tokenHash: hashActivationToken(result.token),
        tokenLast4: last4(result.token),
        expiresAt: expect.any(Date),
      }),
    })
    expect(result.last4).toBe(last4(result.token))
    expect(result.expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * 60 * 1000)
    expect(result.expiresAt.getTime() - Date.now()).toBeLessThan(31 * 60 * 1000)
  })

  it('retries on P2002 collision and eventually succeeds', async () => {
    prismaMock.venueWhatsappActivation.updateMany.mockResolvedValue({ count: 0 })
    const p2002 = Object.assign(new Error('Unique'), { code: 'P2002' })
    prismaMock.venueWhatsappActivation.create
      .mockRejectedValueOnce(p2002)
      .mockRejectedValueOnce(p2002)
      .mockResolvedValueOnce({} as any)

    const result = await generateActivationForVenue(VENUE_ID)

    expect(prismaMock.venueWhatsappActivation.create).toHaveBeenCalledTimes(3)
    expect(result.token).toBeTruthy()
  })

  it('throws after MAX_RETRIES P2002 collisions in a row', async () => {
    prismaMock.venueWhatsappActivation.updateMany.mockResolvedValue({ count: 0 })
    const p2002 = Object.assign(new Error('Unique'), { code: 'P2002' })
    prismaMock.venueWhatsappActivation.create.mockRejectedValue(p2002)

    await expect(generateActivationForVenue(VENUE_ID)).rejects.toThrow('exhausted retries')
  })

  it('rethrows non-P2002 errors from create()', async () => {
    prismaMock.venueWhatsappActivation.updateMany.mockResolvedValue({ count: 0 })
    prismaMock.venueWhatsappActivation.create.mockRejectedValue(new Error('connection refused'))

    await expect(generateActivationForVenue(VENUE_ID)).rejects.toThrow('connection refused')
  })
})

describe('getVenueChatStatus', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('returns the full status snapshot including pending activation', async () => {
    prismaMock.venue.findUnique.mockResolvedValue({
      whatsappContactMode: 'RELAY',
      whatsappOptInPhone: '+525567976805',
      whatsappOptInAt: new Date('2026-05-19T10:00:00Z'),
      phone: '+525500001234',
    })
    prismaMock.venueWhatsappActivation.findFirst.mockResolvedValue({
      tokenLast4: 'JKMN',
      expiresAt: new Date('2026-05-19T11:00:00Z'),
    })

    const status = await getVenueChatStatus(VENUE_ID)

    expect(status).toEqual({
      mode: 'RELAY',
      optInPhone: '+525567976805',
      optInAt: new Date('2026-05-19T10:00:00Z'),
      fallbackPhone: '+525500001234',
      pendingActivation: { tokenLast4: 'JKMN', expiresAt: new Date('2026-05-19T11:00:00Z') },
    })
  })

  it('returns pendingActivation=null when no open token exists', async () => {
    prismaMock.venue.findUnique.mockResolvedValue({
      whatsappContactMode: 'WA_ME_FALLBACK',
      whatsappOptInPhone: null,
      whatsappOptInAt: null,
      phone: '+525500001234',
    })
    prismaMock.venueWhatsappActivation.findFirst.mockResolvedValue(null)

    const status = await getVenueChatStatus(VENUE_ID)
    expect(status?.pendingActivation).toBeNull()
    expect(status?.mode).toBe('WA_ME_FALLBACK')
  })

  it('returns null when the venue does not exist', async () => {
    prismaMock.venue.findUnique.mockResolvedValue(null)
    const status = await getVenueChatStatus(VENUE_ID)
    expect(status).toBeNull()
    expect(prismaMock.venueWhatsappActivation.findFirst).not.toHaveBeenCalled()
  })
})

describe('deactivateVenueChat', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('reverts venue to WA_ME_FALLBACK, closes OPEN sessions, invalidates open tokens (single tx)', async () => {
    prismaMock.venue.update.mockResolvedValue({} as any)
    prismaMock.venueChatSession.updateMany.mockResolvedValue({ count: 3 })
    prismaMock.venueWhatsappActivation.updateMany.mockResolvedValue({ count: 1 })

    await deactivateVenueChat(VENUE_ID)

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(prismaMock.venue.update).toHaveBeenCalledWith({
      where: { id: VENUE_ID },
      data: {
        whatsappContactMode: 'WA_ME_FALLBACK',
        whatsappOptInPhone: null,
        whatsappOptInAt: null,
      },
    })
    expect(prismaMock.venueChatSession.updateMany).toHaveBeenCalledWith({
      where: { venueId: VENUE_ID, status: 'OPEN' },
      data: expect.objectContaining({
        status: 'CLOSED_BY_VENUE_DEACTIVATION',
        closedAt: expect.any(Date),
      }),
    })
    expect(prismaMock.venueWhatsappActivation.updateMany).toHaveBeenCalledWith({
      where: { venueId: VENUE_ID, consumedAt: null, invalidatedAt: null },
      data: expect.objectContaining({ invalidatedAt: expect.any(Date) }),
    })
  })
})
