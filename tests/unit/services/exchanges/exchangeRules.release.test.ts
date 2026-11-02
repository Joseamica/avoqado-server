import { RELEASE_NO_REQUEST_MS, RELEASE_QUIET_MS, releaseIsDue } from '@/services/exchanges/exchangeRules'

const createdAt = new Date('2026-10-25T12:00:00.000Z')
const after = (ms: number) => new Date(createdAt.getTime() + ms)

describe('releaseIsDue', () => {
  it('keeps the agreed quiet and no-request windows', () => {
    expect(RELEASE_QUIET_MS).toBe(10 * 60_000)
    expect(RELEASE_NO_REQUEST_MS).toBe(30 * 60_000)
  })

  it.each([
    [29 * 60_000, false],
    [30 * 60_000 - 1, false],
    [30 * 60_000, true],
    [31 * 60_000, true],
  ])('without requests, age %i ms is due: %s', (age, due) => {
    expect(releaseIsDue({ requestCount: 0, lastActivityAt: null }, createdAt, after(age))).toBe(due)
  })

  it.each([
    [9 * 60_000, false],
    [10 * 60_000 - 1, false],
    [10 * 60_000, true],
    [11 * 60_000, true],
  ])('with requests, quiet time %i ms is due: %s', (quiet, due) => {
    const lastActivityAt = after(60 * 60_000)
    expect(releaseIsDue({ requestCount: 2, lastActivityAt }, createdAt, new Date(lastActivityAt.getTime() + quiet))).toBe(due)
  })

  it('never becomes due for requests with unknown last activity', () => {
    expect(releaseIsDue({ requestCount: 1, lastActivityAt: null }, createdAt, after(24 * 60 * 60_000))).toBe(false)
  })

  it('uses creation time rather than last activity when there are no requests', () => {
    expect(releaseIsDue({ requestCount: 0, lastActivityAt: after(29 * 60_000) }, createdAt, after(30 * 60_000))).toBe(true)
  })
})
