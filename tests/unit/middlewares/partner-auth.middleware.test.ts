/**
 * authenticatePartner Middleware Tests
 *
 * NEW FEATURE focus: a transient DB rejection (P1017/P2024) on the PartnerAPIKey lookup
 * must be forwarded to next(error) — never escape as a process-level unhandledRejection
 * (the 2026-06-23 crash class). The middleware already wraps its await in try/catch;
 * these tests LOCK IN that containment.
 *
 * REGRESSION: a missing/invalid key is rejected; a valid active partner attaches
 * req.partnerContext and calls next().
 */
import { Request, Response, NextFunction } from 'express'
import { authenticatePartner } from '@/middlewares/partner-auth.middleware'
import prisma from '@/utils/prismaClient'
import { UnauthorizedError } from '@/errors/AppError'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    partnerAPIKey: { findUnique: jest.fn(), update: jest.fn() },
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

const dbError = (code: string) => Object.assign(new Error(`prisma ${code}`), { code })
const VALID_SK = `sk_test_${'a'.repeat(24)}`

describe('authenticatePartner Middleware', () => {
  let req: Partial<Request>
  let res: Partial<Response>
  let next: jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()
    req = { headers: { authorization: `Bearer ${VALID_SK}` }, ip: '127.0.0.1', socket: {} as any }
    res = {}
    next = jest.fn()
    // The success path fires a non-blocking lastUsed update — make it a resolved promise so
    // `.catch()` is callable.
    ;(prisma.partnerAPIKey.update as jest.Mock).mockResolvedValue({})
  })

  // ──────────────────────────────────────────────────────────────────
  // NEW FEATURE: transient DB rejection is forwarded, not crashed
  // ──────────────────────────────────────────────────────────────────
  describe('async rejection containment (the crash class)', () => {
    it.each(['P1017', 'P2024'])('forwards a %s rejection from the partner key lookup to next(error)', async code => {
      ;(prisma.partnerAPIKey.findUnique as jest.Mock).mockRejectedValueOnce(dbError(code))

      const mw = authenticatePartner()

      await expect(mw(req as Request, res as Response, next)).resolves.toBeUndefined()
      expect(next).toHaveBeenCalledTimes(1)
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ code }))
    })
  })

  // ──────────────────────────────────────────────────────────────────
  // REGRESSION: existing behavior unchanged
  // ──────────────────────────────────────────────────────────────────
  describe('regression: normal flows', () => {
    it('rejects a missing Authorization header with UnauthorizedError', async () => {
      req.headers = {}

      const mw = authenticatePartner()
      await mw(req as Request, res as Response, next)

      expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedError))
      expect(prisma.partnerAPIKey.findUnique).not.toHaveBeenCalled()
    })

    it('attaches partnerContext and calls next() for a valid active partner', async () => {
      ;(prisma.partnerAPIKey.findUnique as jest.Mock).mockResolvedValueOnce({
        id: 'pk1',
        name: 'PlayTelecom',
        organizationId: 'org1',
        active: true,
        sandboxMode: true, // matches sk_test_
        organization: { id: 'org1', name: 'PlayTelecom' },
      })

      const mw = authenticatePartner()
      await mw(req as Request, res as Response, next)

      expect(next).toHaveBeenCalledWith()
      expect((req as any).partnerContext).toMatchObject({ partnerId: 'pk1', organizationId: 'org1' })
    })
  })
})
