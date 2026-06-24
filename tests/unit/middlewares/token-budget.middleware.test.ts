/**
 * tokenBudget Middleware Tests
 *
 * NEW FEATURE focus: a transient DB rejection (P1017/P2024) from the token-budget service
 * must NOT escape as a process-level unhandledRejection (the 2026-06-23 crash class).
 *
 * IMPORTANT — this middleware is deliberately DIFFERENT from the auth middlewares: it is a
 * non-blocking SOFT limit, so on ANY error it SWALLOWS and continues via `next()` (no error
 * forwarded), rather than `next(error)`. These tests pin that intentional behavior: the
 * request still proceeds and nothing escapes. (Forwarding the error here would turn a
 * telemetry blip into a 500 — a regression.)
 */
import { Request, Response, NextFunction } from 'express'
import { tokenBudgetMiddleware, tokenBudgetCheckMiddleware } from '@/middlewares/token-budget.middleware'
import { tokenBudgetService } from '@/services/dashboard/token-budget.service'

jest.mock('@/services/dashboard/token-budget.service', () => ({
  tokenBudgetService: {
    getBudgetStatus: jest.fn(),
    checkTokensAvailable: jest.fn(),
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

const dbError = (code: string) => Object.assign(new Error(`prisma ${code}`), { code })

describe('tokenBudget Middlewares', () => {
  let req: Partial<Request>
  let res: Partial<Response>
  let next: jest.Mock
  let setHeader: jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()
    setHeader = jest.fn()
    req = { authContext: { venueId: 'venue_123' } } as any
    res = { setHeader }
    next = jest.fn()
  })

  // ──────────────────────────────────────────────────────────────────
  // NEW FEATURE: transient rejection is swallowed (non-blocking), never crashed
  // ──────────────────────────────────────────────────────────────────
  describe('async rejection containment (the crash class)', () => {
    it('tokenBudgetMiddleware swallows a P2024 error and continues via next() (no error forwarded)', async () => {
      ;(tokenBudgetService.getBudgetStatus as jest.Mock).mockRejectedValueOnce(dbError('P2024'))

      await expect(tokenBudgetMiddleware(req as Request, res as Response, next)).resolves.toBeUndefined()
      expect(next).toHaveBeenCalledTimes(1)
      expect(next).toHaveBeenCalledWith() // by design: soft limit, request proceeds
    })

    it('tokenBudgetCheckMiddleware swallows a P2024 error and continues via next()', async () => {
      ;(tokenBudgetService.checkTokensAvailable as jest.Mock).mockRejectedValueOnce(dbError('P2024'))

      await expect(tokenBudgetCheckMiddleware(req as Request, res as Response, next)).resolves.toBeUndefined()
      expect(next).toHaveBeenCalledTimes(1)
      expect(next).toHaveBeenCalledWith()
    })
  })

  // ──────────────────────────────────────────────────────────────────
  // REGRESSION: existing behavior unchanged
  // ──────────────────────────────────────────────────────────────────
  describe('regression: normal flows', () => {
    it('sets budget headers and calls next() on success', async () => {
      ;(tokenBudgetService.getBudgetStatus as jest.Mock).mockResolvedValueOnce({
        totalAvailable: 1000,
        freeTokensRemaining: 800,
        extraTokensBalance: 200,
        warning: null,
        isInOverage: false,
        percentageUsed: 20,
      })

      await tokenBudgetMiddleware(req as Request, res as Response, next)

      expect(setHeader).toHaveBeenCalledWith('X-Token-Budget-Available', '1000')
      expect(next).toHaveBeenCalledWith()
    })

    it('short-circuits to next() when there is no venueId (no service call)', async () => {
      ;(req as any).authContext = {}

      await tokenBudgetMiddleware(req as Request, res as Response, next)

      expect(tokenBudgetService.getBudgetStatus).not.toHaveBeenCalled()
      expect(next).toHaveBeenCalledWith()
    })
  })
})
