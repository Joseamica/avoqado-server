/**
 * authenticateSDK Middleware Tests
 *
 * NEW FEATURE focus: a transient DB rejection (P1017/P2024) on the EcommerceMerchant
 * lookup must be forwarded to next(error) — never escape as a process-level
 * unhandledRejection (the 2026-06-23 crash class). This middleware already wraps its
 * awaits in try/catch; these tests LOCK IN that containment.
 *
 * REGRESSION: malformed keys are rejected before any DB hit; a valid active merchant
 * attaches req.sdkContext and calls next().
 */
import { Request, Response, NextFunction } from 'express'
import { authenticateSDK } from '@/middlewares/sdk-auth.middleware'
import prisma from '@/utils/prismaClient'
import { UnauthorizedError } from '@/errors/AppError'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    ecommerceMerchant: { findUnique: jest.fn() },
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

const dbError = (code: string) => Object.assign(new Error(`prisma ${code}`), { code })
const VALID_PK = `pk_test_${'a'.repeat(24)}`

describe('authenticateSDK Middleware', () => {
  let req: Partial<Request>
  let res: Partial<Response>
  let next: jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()
    req = { headers: { authorization: `Bearer ${VALID_PK}` } }
    res = {}
    next = jest.fn()
  })

  // ──────────────────────────────────────────────────────────────────
  // NEW FEATURE: transient DB rejection is forwarded, not crashed
  // ──────────────────────────────────────────────────────────────────
  describe('async rejection containment (the crash class)', () => {
    it.each(['P1017', 'P2024'])('forwards a %s rejection from the merchant lookup to next(error)', async code => {
      ;(prisma.ecommerceMerchant.findUnique as jest.Mock).mockRejectedValueOnce(dbError(code))

      const mw = authenticateSDK(false)

      await expect(mw(req as Request, res as Response, next)).resolves.toBeUndefined()
      expect(next).toHaveBeenCalledTimes(1)
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ code }))
    })
  })

  // ──────────────────────────────────────────────────────────────────
  // REGRESSION: existing behavior unchanged
  // ──────────────────────────────────────────────────────────────────
  describe('regression: normal flows', () => {
    it('rejects a malformed key with UnauthorizedError and never touches the DB', async () => {
      ;(req.headers as any).authorization = 'Bearer not-a-valid-key'

      const mw = authenticateSDK(false)
      await mw(req as Request, res as Response, next)

      expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedError))
      expect(prisma.ecommerceMerchant.findUnique).not.toHaveBeenCalled()
    })

    it('attaches sdkContext and calls next() for a valid active merchant', async () => {
      ;(prisma.ecommerceMerchant.findUnique as jest.Mock).mockResolvedValueOnce({
        id: 'm1',
        businessName: 'Shop',
        venueId: 'v1',
        active: true,
        sandboxMode: true, // matches pk_test_ (test mode)
        providerId: 'p1',
        provider: { code: 'STRIPE' },
        venue: { id: 'v1', status: 'ACTIVE' }, // operational
      })

      const mw = authenticateSDK(false)
      await mw(req as Request, res as Response, next)

      expect(next).toHaveBeenCalledWith()
      expect((req as any).sdkContext).toMatchObject({ merchantId: 'm1', venueId: 'v1', keyType: 'public' })
    })
  })
})
