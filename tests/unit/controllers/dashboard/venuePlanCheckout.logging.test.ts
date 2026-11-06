/**
 * D7 (5-nov-2026): a plan purchase the server refuses on purpose (an AppError under 500, like «este negocio ya tiene un
 * plan…» 409) is a warn, not an error: in production every refusal was landing in Better Stack as an error.
 */
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: {} }))
jest.mock('@/services/dashboard/venue.dashboard.service', () => ({ createVenuePlanCheckoutSession: jest.fn() }))
jest.mock('@/services/access/rolVigente', () => ({ esSuperadminDeLaSesion: jest.fn().mockResolvedValue(false) }))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

import AppError from '@/errors/AppError'
import logger from '@/config/logger'
import * as venueDashboardService from '@/services/dashboard/venue.dashboard.service'
import { createVenuePlanCheckoutSession } from '@/controllers/dashboard/venue.dashboard.controller'

const checkout = venueDashboardService.createVenuePlanCheckoutSession as jest.Mock
const req = (): any => ({ authContext: { orgId: 'org_1' }, params: { venueId: 'venue_1' }, body: { tier: 'PRO', interval: 'monthly' } })
const res = (): any => {
  const r: any = {}
  r.status = jest.fn().mockReturnValue(r)
  r.json = jest.fn().mockReturnValue(r)
  return r
}

describe('plan checkout: a refusal on purpose is not an error', () => {
  beforeEach(() => jest.clearAllMocks())

  it('a 409 refusal is logged as warn and still reaches the error middleware', async () => {
    const refusal = new AppError('Este negocio ya tiene un plan que Stripe sigue cobrando.', 409)
    checkout.mockRejectedValue(refusal)
    const next = jest.fn()
    await createVenuePlanCheckoutSession(req(), res(), next)
    expect(logger.error).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith('Plan checkout refused', expect.objectContaining({ venueId: 'venue_1', statusCode: 409 }))
    expect(next).toHaveBeenCalledWith(refusal)
  })

  it('an unexpected failure is still an error', async () => {
    const boom = new Error('Stripe is down')
    checkout.mockRejectedValue(boom)
    const next = jest.fn()
    await createVenuePlanCheckoutSession(req(), res(), next)
    expect(logger.error).toHaveBeenCalledWith('Error creating plan checkout session', expect.objectContaining({ error: 'Stripe is down' }))
    expect(next).toHaveBeenCalledWith(boom)
  })
})
