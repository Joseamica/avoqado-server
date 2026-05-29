/**
 * Verifies that the MP OAuth `initiate` controller propagates the optional
 * `?from=wizard` query param into the signed state's `returnTo` field.
 *
 * The callback uses `returnTo` to decide between the legacy
 * `/integrations/mercadopago` redirect and the V2 setup wizard #step-7.
 */
import { initiate } from '@/controllers/dashboard/mercadoPagoOAuth.controller'
import * as oauthService from '@/services/mercado-pago/oauth.service'
import * as guardService from '@/services/mercado-pago/merchant-guard.service'
import { userHasVenueAccess } from '@/services/staffOrganization.service'
import type { Response } from 'express'

jest.mock('@/services/mercado-pago/oauth.service')
jest.mock('@/services/mercado-pago/merchant-guard.service')
jest.mock('@/services/staffOrganization.service')

function buildRes(): Response {
  const res: any = {}
  res.redirect = jest.fn().mockReturnValue(res)
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res as Response
}

const baseQuery = { venueId: 'v_1', ecommerceMerchantId: 'em_1' }

beforeEach(() => {
  jest.clearAllMocks()
  ;(userHasVenueAccess as jest.Mock).mockResolvedValue(true)
  ;(guardService.getMercadoPagoMerchant as jest.Mock).mockResolvedValue({ id: 'em_1' })
  ;(oauthService.signState as jest.Mock).mockReturnValue('fake-state-token')
  ;(oauthService.buildAuthUrl as jest.Mock).mockReturnValue('https://auth.mercadopago.com.mx/authorization?state=fake-state-token')
})

describe('MP OAuth initiate — from=wizard', () => {
  it('passes returnTo:"wizard" to signState when ?from=wizard is present', async () => {
    const req: any = {
      query: { ...baseQuery, from: 'wizard' },
      authContext: { userId: 's_1' },
    }
    await initiate(req, buildRes())
    expect(oauthService.signState).toHaveBeenCalledWith(expect.objectContaining({ returnTo: 'wizard' }))
  })

  it('omits returnTo when from query param is absent', async () => {
    const req: any = {
      query: { ...baseQuery },
      authContext: { userId: 's_1' },
    }
    await initiate(req, buildRes())
    const arg = (oauthService.signState as jest.Mock).mock.calls[0][0]
    expect(arg.returnTo).toBeUndefined()
  })

  it('omits returnTo when from is any value other than "wizard"', async () => {
    const req: any = {
      query: { ...baseQuery, from: 'somewhere-else' },
      authContext: { userId: 's_1' },
    }
    await initiate(req, buildRes())
    const arg = (oauthService.signState as jest.Mock).mock.calls[0][0]
    expect(arg.returnTo).toBeUndefined()
  })
})
