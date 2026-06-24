/**
 * validateRequest Middleware Tests
 *
 * NEW FEATURE focus: a rejected `schema.safeParseAsync(...)` (e.g. an async Zod refinement
 * that hits a transient DB error) must be forwarded to next(error) — never escape as a
 * process-level unhandledRejection. This middleware already wraps its await in try/catch;
 * these tests LOCK IN that containment so a future edit can't regress it into the
 * 2026-06-23 crash class.
 *
 * REGRESSION: valid payloads pass through (next()) and invalid ones become a Spanish
 * BadRequestError — unchanged.
 */
import { Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { validateRequest } from '@/middlewares/validation'
import { BadRequestError, InternalServerError } from '@/errors/AppError'

const dbError = (code: string) => Object.assign(new Error(`prisma ${code}`), { code })

describe('validateRequest Middleware', () => {
  let req: Partial<Request>
  let res: Partial<Response>
  let next: jest.Mock

  beforeEach(() => {
    req = { body: {}, query: {}, params: {} }
    res = {}
    next = jest.fn()
  })

  // ──────────────────────────────────────────────────────────────────
  // NEW FEATURE: transient rejection is contained, not crashed
  // ──────────────────────────────────────────────────────────────────
  describe('async rejection containment (the crash class)', () => {
    it('forwards a rejected safeParseAsync (P2024) to next(error) instead of escaping', async () => {
      const schema = z.object({ body: z.object({}) })
      jest.spyOn(schema, 'safeParseAsync').mockRejectedValueOnce(dbError('P2024'))

      const mw = validateRequest(schema)

      // Must not reject the returned promise (no unhandledRejection escapes).
      await expect(mw(req as Request, res as Response, next)).resolves.toBeUndefined()
      expect(next).toHaveBeenCalledTimes(1)
      // A non-ZodError is wrapped as InternalServerError by the catch — but still forwarded.
      expect(next).toHaveBeenCalledWith(expect.any(InternalServerError))
    })
  })

  // ──────────────────────────────────────────────────────────────────
  // REGRESSION: normal validation behavior unchanged
  // ──────────────────────────────────────────────────────────────────
  describe('regression: normal flows', () => {
    it('calls next() with no error on a valid payload', async () => {
      const schema = z.object({ body: z.object({ name: z.string() }) })
      req.body = { name: 'ok' }

      const mw = validateRequest(schema)
      await mw(req as Request, res as Response, next)

      expect(next).toHaveBeenCalledWith()
    })

    it('forwards a Zod validation failure as a BadRequestError', async () => {
      const schema = z.object({ body: z.object({ name: z.string({ required_error: 'El nombre es requerido' }) }) })
      req.body = {}

      const mw = validateRequest(schema)
      await mw(req as Request, res as Response, next)

      expect(next).toHaveBeenCalledTimes(1)
      expect(next).toHaveBeenCalledWith(expect.any(BadRequestError))
    })
  })
})
