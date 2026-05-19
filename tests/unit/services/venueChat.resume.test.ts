import { resumeSessionWithEmail } from '@/services/venueChat.service'
import { hashAccessToken } from '@/utils/sessionToken'

import { prismaMock } from '../../__helpers__/setup'

const SESSION_ID = 'sess-1'

describe('resumeSessionWithEmail', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('returns OK with a fresh accessToken and rotates the stored hash on email match', async () => {
    prismaMock.venueChatSession.findUnique.mockResolvedValue({
      id: SESSION_ID,
      customerEmail: 'juan@example.com',
      status: 'OPEN',
    })
    prismaMock.venueChatSession.update.mockResolvedValue({} as any)

    const result = await resumeSessionWithEmail({ sessionId: SESSION_ID, email: 'juan@example.com' })

    expect(result.kind).toBe('OK')
    if (result.kind !== 'OK') throw new Error('unreachable')
    expect(result.accessToken).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(prismaMock.venueChatSession.update).toHaveBeenCalledWith({
      where: { id: SESSION_ID },
      data: { accessTokenHash: hashAccessToken(result.accessToken) },
    })
  })

  it('returns OK on case-insensitive email match', async () => {
    prismaMock.venueChatSession.findUnique.mockResolvedValue({
      id: SESSION_ID,
      customerEmail: 'JUAN@Example.com',
      status: 'OPEN',
    })
    prismaMock.venueChatSession.update.mockResolvedValue({} as any)

    const result = await resumeSessionWithEmail({ sessionId: SESSION_ID, email: '  juan@example.com  ' })

    expect(result.kind).toBe('OK')
  })

  it('returns NOT_FOUND when session does not exist (no token mint)', async () => {
    prismaMock.venueChatSession.findUnique.mockResolvedValue(null)
    const result = await resumeSessionWithEmail({ sessionId: SESSION_ID, email: 'juan@example.com' })
    expect(result.kind).toBe('NOT_FOUND')
    expect(prismaMock.venueChatSession.update).not.toHaveBeenCalled()
  })

  it('returns NOT_FOUND when session has no customerEmail on file', async () => {
    prismaMock.venueChatSession.findUnique.mockResolvedValue({
      id: SESSION_ID,
      customerEmail: null,
      status: 'OPEN',
    })
    const result = await resumeSessionWithEmail({ sessionId: SESSION_ID, email: 'juan@example.com' })
    expect(result.kind).toBe('NOT_FOUND')
    expect(prismaMock.venueChatSession.update).not.toHaveBeenCalled()
  })

  it('returns NOT_FOUND when session is closed', async () => {
    prismaMock.venueChatSession.findUnique.mockResolvedValue({
      id: SESSION_ID,
      customerEmail: 'juan@example.com',
      status: 'CLOSED_BY_INACTIVITY',
    })
    const result = await resumeSessionWithEmail({ sessionId: SESSION_ID, email: 'juan@example.com' })
    expect(result.kind).toBe('NOT_FOUND')
    expect(prismaMock.venueChatSession.update).not.toHaveBeenCalled()
  })

  it('returns NOT_FOUND on email mismatch (no token mint)', async () => {
    prismaMock.venueChatSession.findUnique.mockResolvedValue({
      id: SESSION_ID,
      customerEmail: 'juan@example.com',
      status: 'OPEN',
    })
    const result = await resumeSessionWithEmail({ sessionId: SESSION_ID, email: 'pedro@example.com' })
    expect(result.kind).toBe('NOT_FOUND')
    expect(prismaMock.venueChatSession.update).not.toHaveBeenCalled()
  })

  it('returns NOT_FOUND for emails of different lengths (defensive timing-equal path)', async () => {
    prismaMock.venueChatSession.findUnique.mockResolvedValue({
      id: SESSION_ID,
      customerEmail: 'a@b.co',
      status: 'OPEN',
    })
    const result = await resumeSessionWithEmail({ sessionId: SESSION_ID, email: 'longer@example.com' })
    expect(result.kind).toBe('NOT_FOUND')
  })
})
