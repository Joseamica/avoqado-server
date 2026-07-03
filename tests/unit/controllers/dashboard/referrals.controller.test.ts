/**
 * activate / updateConfig controllers — Spanish/known-error → 4xx mapping.
 *
 * `activateReferralProgram`/`updateReferralConfig` (referralProgram.service.ts)
 * throw sentinel-string errors for validation failures (ascending-tier
 * thresholds, non-negative fields, PRODUCTO_NO_PERTENECE_AL_VENUE,
 * PORCENTAJE_INVALIDO) and a not-found error (REFERRAL_PROGRAM_NOT_CONFIGURED).
 * Before this fix these all bubbled to `next(e)` → a generic 500. This mirrors
 * the existing `manualVoid`/`fulfillGrantHandler` pattern in the same file:
 * known errors → mapped 4xx with `{ error: <message> }`; anything else still
 * bubbles to `next(e)`.
 */
jest.mock('@/services/referrals/referralProgram.service', () => ({
  activateReferralProgram: jest.fn(),
  updateReferralConfig: jest.fn(),
}))

import type { NextFunction, Request, Response } from 'express'
import * as program from '@/services/referrals/referralProgram.service'
import { activate, updateConfig } from '@/controllers/dashboard/referrals/referrals.controller'

const mockActivate = program.activateReferralProgram as jest.Mock
const mockUpdateConfig = program.updateReferralConfig as jest.Mock

function makeRes(): Response {
  const res: Record<string, jest.Mock> = {}
  res.status = jest.fn(() => res)
  res.json = jest.fn(() => res)
  return res as unknown as Response
}

const makeReq = (venueId: string, body: any = {}) =>
  ({ params: { venueId }, body, authContext: { userId: 'staff-1' } }) as unknown as Request

beforeEach(() => jest.clearAllMocks())

describe('referrals.controller — activate/updateConfig 4xx error mapping', () => {
  describe.each([
    ['activate', () => mockActivate, (req: Request, res: Response, next: NextFunction) => activate(req, res, next)],
    ['updateConfig', () => mockUpdateConfig, (req: Request, res: Response, next: NextFunction) => updateConfig(req, res, next)],
  ])('%s', (_name, getMock, handler) => {
    it.each([
      ['PRODUCTO_NO_PERTENECE_AL_VENUE'],
      ['PORCENTAJE_INVALIDO'],
      ['Tier requirements must be ascending: tier2 > tier1'],
      ['Tier requirements must be ascending: tier3 > tier2'],
      ['Field tier1ReferralsRequired must be non-negative'],
    ])('maps %s to 400 with { error: message }', async message => {
      getMock().mockRejectedValue(new Error(message))
      const res = makeRes()
      const next = jest.fn() as unknown as NextFunction

      await handler(makeReq('venue-1'), res, next)

      expect(res.status).toHaveBeenCalledWith(400)
      expect(res.json).toHaveBeenCalledWith({ error: message })
      expect(next).not.toHaveBeenCalled()
    })

    it('maps REFERRAL_PROGRAM_NOT_CONFIGURED to 404', async () => {
      getMock().mockRejectedValue(new Error('REFERRAL_PROGRAM_NOT_CONFIGURED'))
      const res = makeRes()
      const next = jest.fn() as unknown as NextFunction

      await handler(makeReq('venue-1'), res, next)

      expect(res.status).toHaveBeenCalledWith(404)
      expect(res.json).toHaveBeenCalledWith({ error: 'REFERRAL_PROGRAM_NOT_CONFIGURED' })
      expect(next).not.toHaveBeenCalled()
    })

    it('forwards unknown errors to next() (still a 500, no regression)', async () => {
      const err = new Error('unexpected boom')
      getMock().mockRejectedValue(err)
      const res = makeRes()
      const next = jest.fn() as unknown as NextFunction

      await handler(makeReq('venue-1'), res, next)

      expect(next).toHaveBeenCalledWith(err)
      expect(res.status).not.toHaveBeenCalled()
    })

    it('succeeds and responds ok:true when the service resolves', async () => {
      getMock().mockResolvedValue(undefined)
      const res = makeRes()
      const next = jest.fn() as unknown as NextFunction

      await handler(makeReq('venue-1', { newCustomerDiscountPercent: 10 }), res, next)

      expect(res.json).toHaveBeenCalledWith({ ok: true })
      expect(next).not.toHaveBeenCalled()
    })
  })
})
