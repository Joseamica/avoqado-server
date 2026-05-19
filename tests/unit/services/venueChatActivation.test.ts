import { handleActivationCommand } from '@/services/venueChatActivation.service'
import { hashActivationToken } from '@/utils/activationToken'

import { prismaMock } from '../../__helpers__/setup'

const VENUE_ID = 'test-venue-id'
const SENDER = '+525511112222'
const TOKEN = 'ABCDEFGHJKMN'
const TOKEN_HASH = hashActivationToken(TOKEN)

describe('handleActivationCommand', () => {
  it('returns ACTIVATED, marks consumed, sets venue to RELAY (fresh activation)', async () => {
    prismaMock.venueWhatsappActivation.findUnique.mockResolvedValue({
      id: 'act-1',
      venueId: VENUE_ID,
      tokenHash: TOKEN_HASH,
      tokenLast4: 'JKMN',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 60_000),
      consumedAt: null,
      consumedByPhone: null,
      invalidatedAt: null,
      venue: {
        id: VENUE_ID,
        whatsappContactMode: 'WA_ME_FALLBACK',
        whatsappOptInPhone: null,
      },
    })
    prismaMock.$transaction.mockImplementation((cb: any) => cb(prismaMock))

    const result = await handleActivationCommand({ token: TOKEN, senderPhone: SENDER })

    expect(result.outcome).toBe('ACTIVATED')
    expect(result.venueId).toBe(VENUE_ID)
    expect(prismaMock.venueWhatsappActivation.update).toHaveBeenCalledWith({
      where: { id: 'act-1' },
      data: expect.objectContaining({ consumedByPhone: SENDER }),
    })
    expect(prismaMock.venue.update).toHaveBeenCalledWith({
      where: { id: VENUE_ID },
      data: expect.objectContaining({
        whatsappContactMode: 'RELAY',
        whatsappOptInPhone: SENDER,
      }),
    })
  })

  it('returns REPLAY_OK when same phone re-sends after consumption while venue still RELAY', async () => {
    prismaMock.venueWhatsappActivation.findUnique.mockResolvedValue({
      id: 'act-2',
      venueId: VENUE_ID,
      tokenHash: TOKEN_HASH,
      tokenLast4: 'JKMN',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: new Date(),
      consumedByPhone: SENDER,
      invalidatedAt: null,
      venue: {
        id: VENUE_ID,
        whatsappContactMode: 'RELAY',
        whatsappOptInPhone: SENDER,
      },
    })

    const result = await handleActivationCommand({ token: TOKEN, senderPhone: SENDER })

    expect(result.outcome).toBe('REPLAY_OK')
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(prismaMock.venue.update).not.toHaveBeenCalled()
  })

  it('returns INVALID for expired token', async () => {
    prismaMock.venueWhatsappActivation.findUnique.mockResolvedValue({
      id: 'act-3',
      venueId: VENUE_ID,
      tokenHash: TOKEN_HASH,
      tokenLast4: 'JKMN',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() - 1000),
      consumedAt: null,
      consumedByPhone: null,
      invalidatedAt: null,
      venue: { id: VENUE_ID, whatsappContactMode: 'WA_ME_FALLBACK', whatsappOptInPhone: null },
    })

    const result = await handleActivationCommand({ token: TOKEN, senderPhone: SENDER })

    expect(result.outcome).toBe('INVALID')
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('returns INVALID for invalidated token', async () => {
    prismaMock.venueWhatsappActivation.findUnique.mockResolvedValue({
      id: 'act-4',
      venueId: VENUE_ID,
      tokenHash: TOKEN_HASH,
      tokenLast4: 'JKMN',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
      consumedByPhone: null,
      invalidatedAt: new Date(),
      venue: { id: VENUE_ID, whatsappContactMode: 'WA_ME_FALLBACK', whatsappOptInPhone: null },
    })

    const result = await handleActivationCommand({ token: TOKEN, senderPhone: SENDER })
    expect(result.outcome).toBe('INVALID')
  })

  it('returns INVALID when token consumed but venue is no longer in RELAY (deactivated since)', async () => {
    prismaMock.venueWhatsappActivation.findUnique.mockResolvedValue({
      id: 'act-5',
      venueId: VENUE_ID,
      tokenHash: TOKEN_HASH,
      tokenLast4: 'JKMN',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: new Date(),
      consumedByPhone: SENDER,
      invalidatedAt: null,
      venue: { id: VENUE_ID, whatsappContactMode: 'WA_ME_FALLBACK', whatsappOptInPhone: null },
    })

    const result = await handleActivationCommand({ token: TOKEN, senderPhone: SENDER })
    expect(result.outcome).toBe('INVALID')
  })

  it('returns INVALID when token unknown', async () => {
    prismaMock.venueWhatsappActivation.findUnique.mockResolvedValue(null)
    const result = await handleActivationCommand({ token: 'UNKNOWN12345', senderPhone: SENDER })
    expect(result.outcome).toBe('INVALID')
  })
})
