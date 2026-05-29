import { callback } from '@/controllers/dashboard/mercadoPagoOAuth.controller'
import * as guardService from '@/services/mercado-pago/merchant-guard.service'
import * as oauthService from '@/services/mercado-pago/oauth.service'
import * as connectionService from '@/services/mercado-pago/connection.service'
import type { Response } from 'express'
import { prismaMock } from '../../__helpers__/setup'

jest.mock('@/services/mercado-pago/merchant-guard.service')
jest.mock('@/services/mercado-pago/oauth.service')
jest.mock('@/services/mercado-pago/connection.service')

function buildRes(): Response {
  const res: any = {}
  res.redirect = jest.fn().mockReturnValue(res)
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  res.send = jest.fn().mockReturnValue(res)
  return res as Response
}

describe('MP OAuth callback — returnTo routing', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    process.env.PUBLIC_DASHBOARD_URL = 'https://app.example.com'
    ;(guardService.getMercadoPagoMerchant as jest.Mock).mockResolvedValue({ id: 'em_1' })
    ;(oauthService.exchangeCodeForTokens as jest.Mock).mockResolvedValue({
      access_token: 't',
      refresh_token: 'r',
      expires_in: 3600,
      user_id: 1,
    })
    ;(connectionService.persistTokens as jest.Mock).mockResolvedValue(undefined)
    prismaMock.venue.findUnique.mockResolvedValue({ slug: 'foo' })
  })

  it('redirects to /setup#step-7 when state.returnTo === "wizard"', async () => {
    ;(oauthService.verifyState as jest.Mock).mockReturnValue({
      intent: 'connect_merchant',
      venueId: 'venue-1',
      ecommerceMerchantId: 'merch-1',
      staffId: 'staff-1',
      returnTo: 'wizard',
    })
    const res = buildRes()
    await callback({ query: { code: 'abc', state: 'xyz' } } as any, res)
    const redirected = (res.redirect as jest.Mock).mock.calls[0][0]
    expect(redirected).toContain('/setup')
    expect(redirected).toContain('step-7')
    expect(redirected).toContain('mp_status=connected')
    expect(redirected).toContain('ecommerceMerchantId=merch-1')
  })

  it('redirects to legacy venue integrations page when returnTo is absent', async () => {
    ;(oauthService.verifyState as jest.Mock).mockReturnValue({
      intent: 'connect_merchant',
      venueId: 'venue-1',
      ecommerceMerchantId: 'merch-1',
      staffId: 'staff-1',
    })
    const res = buildRes()
    await callback({ query: { code: 'abc', state: 'xyz' } } as any, res)
    const redirected = (res.redirect as jest.Mock).mock.calls[0][0]
    expect(redirected).toContain('/venues/foo/edit/integrations')
    expect(redirected).not.toContain('/setup')
  })
})
