import { encodeCursor, decodeCursor } from '@/utils/chatCursor'

describe('chat cursor', () => {
  it('round-trips encode/decode', () => {
    const ts = new Date('2026-05-17T20:01:25.000Z')
    const id = 'ckxyz1234'
    const cursor = encodeCursor({ createdAt: ts, id })
    const decoded = decodeCursor(cursor)
    expect(decoded.createdAt.toISOString()).toBe(ts.toISOString())
    expect(decoded.id).toBe(id)
  })

  it('produces opaque base64url-safe strings', () => {
    const cursor = encodeCursor({ createdAt: new Date(), id: 'ck1' })
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('rejects malformed cursor with explicit error', () => {
    expect(() => decodeCursor('not-base64url!')).toThrow()
    expect(() => decodeCursor('aGVsbG8')).toThrow()
  })
})
