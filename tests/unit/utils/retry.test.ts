import { retry, shouldRetryDbConnectionError, shouldRetryStripeError } from '@/utils/retry'

// Keep test output clean — retry() logs on every retry/failure.
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

describe('retry utility', () => {
  // ──────────────────────────────────────────────────────────────────
  // NEW FEATURE: shouldRetryDbConnectionError predicate
  // ──────────────────────────────────────────────────────────────────
  describe('shouldRetryDbConnectionError', () => {
    it.each(['P1001', 'P1002', 'P1008', 'P1017'])('retries Prisma connection error %s', code => {
      expect(shouldRetryDbConnectionError({ code })).toBe(true)
    })

    it.each(['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET', 'EPIPE'])('retries socket error %s', code => {
      expect(shouldRetryDbConnectionError({ code })).toBe(true)
    })

    // The whole point: data/constraint errors must FAIL FAST, never retry.
    it.each(['P2002', 'P2025', 'P2003', 'P2000'])('does NOT retry Prisma data error %s', code => {
      expect(shouldRetryDbConnectionError({ code })).toBe(false)
    })

    it('does NOT retry an error with no code', () => {
      expect(shouldRetryDbConnectionError(new Error('boom'))).toBe(false)
    })

    it('does NOT throw on null/undefined', () => {
      expect(shouldRetryDbConnectionError(null)).toBe(false)
      expect(shouldRetryDbConnectionError(undefined)).toBe(false)
    })
  })

  // ──────────────────────────────────────────────────────────────────
  // NEW FEATURE: retry() driven by the DB predicate
  // ──────────────────────────────────────────────────────────────────
  describe('retry() with shouldRetryDbConnectionError', () => {
    const opts = { retries: 2, initialDelay: 1, shouldRetry: shouldRetryDbConnectionError, context: 'test' }

    it('retries a transient P1001 then succeeds', async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error("Can't reach database server"), { code: 'P1001' }))
        .mockResolvedValueOnce('ok')

      await expect(retry(fn, opts)).resolves.toBe('ok')
      expect(fn).toHaveBeenCalledTimes(2)
    })

    it('fails fast (no retry) on a P2002 constraint error', async () => {
      const fn = jest.fn().mockRejectedValue(Object.assign(new Error('unique constraint'), { code: 'P2002' }))

      await expect(retry(fn, opts)).rejects.toMatchObject({ code: 'P2002' })
      expect(fn).toHaveBeenCalledTimes(1) // never retried
    })

    it('throws after exhausting retries on persistent P1001', async () => {
      const fn = jest.fn().mockRejectedValue(Object.assign(new Error('down'), { code: 'P1001' }))

      await expect(retry(fn, opts)).rejects.toMatchObject({ code: 'P1001' })
      expect(fn).toHaveBeenCalledTimes(3) // initial + 2 retries
    })
  })

  // ──────────────────────────────────────────────────────────────────
  // REGRESSION: existing Stripe predicate behavior unchanged
  // ──────────────────────────────────────────────────────────────────
  describe('shouldRetryStripeError (regression)', () => {
    it('still retries network + 5xx + 429', () => {
      expect(shouldRetryStripeError({ code: 'ECONNRESET' })).toBe(true)
      expect(shouldRetryStripeError({ type: 'StripeConnectionError' })).toBe(true)
      expect(shouldRetryStripeError({ statusCode: 503 })).toBe(true)
      expect(shouldRetryStripeError({ statusCode: 429 })).toBe(true)
    })

    it('still does NOT retry 4xx client errors', () => {
      expect(shouldRetryStripeError({ statusCode: 400 })).toBe(false)
      expect(shouldRetryStripeError({ statusCode: 401 })).toBe(false)
    })
  })
})
