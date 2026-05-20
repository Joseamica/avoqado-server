import { initiate, callback, disconnect } from '@/controllers/dashboard/mercadoPagoOAuth.controller'
import * as guardService from '@/services/mercado-pago/merchant-guard.service'
import * as oauthService from '@/services/mercado-pago/oauth.service'
import * as connectionService from '@/services/mercado-pago/connection.service'
import { UnauthorizedError, NotFoundError } from '@/errors/AppError'
import type { Response } from 'express'
import { prismaMock } from '../../../__helpers__/setup'

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

beforeEach(() => {
  jest.clearAllMocks()
  process.env.PUBLIC_DASHBOARD_URL = 'https://dashboard.avoqado.io'
})

describe('initiate', () => {
  it('redirects to MP authorize URL when guard + auth pass', async () => {
    ;(guardService.getMercadoPagoMerchant as jest.Mock).mockResolvedValue({ id: 'em_1' })
    ;(oauthService.signState as jest.Mock).mockReturnValue('state-jwt')
    ;(oauthService.buildAuthUrl as jest.Mock).mockReturnValue('https://auth.mercadopago.com.mx/authorization?...')

    const req: any = {
      query: { venueId: 'v_1', ecommerceMerchantId: 'em_1' },
      authContext: { userId: 's_1', venueId: 'v_1', orgId: 'o_1', role: 'OWNER' },
    }
    const res = buildRes()

    await initiate(req, res)

    expect(guardService.getMercadoPagoMerchant).toHaveBeenCalledWith('v_1', 'em_1')
    expect(oauthService.signState).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: 'connect_merchant',
        ecommerceMerchantId: 'em_1',
        venueId: 'v_1',
        staffId: 's_1',
      }),
    )
    expect(res.redirect).toHaveBeenCalledWith('https://auth.mercadopago.com.mx/authorization?...')
  })

  it('rejects 400 when query params are missing', async () => {
    const req: any = {
      query: {},
      authContext: { userId: 's_1' },
    }
    const res = buildRes()
    await initiate(req, res)
    expect(res.status).toHaveBeenCalledWith(400)
  })

  it('rejects 401 when not authenticated', async () => {
    const req: any = {
      query: { venueId: 'v_1', ecommerceMerchantId: 'em_1' },
      authContext: {}, // no userId
    }
    const res = buildRes()
    await initiate(req, res)
    expect(res.status).toHaveBeenCalledWith(401)
  })

  it('rejects 401 when authVenueId mismatches query venueId', async () => {
    const req: any = {
      query: { venueId: 'v_1', ecommerceMerchantId: 'em_1' },
      authContext: { userId: 's_1', venueId: 'v_OTHER' },
    }
    const res = buildRes()
    await initiate(req, res)
    expect(res.status).toHaveBeenCalledWith(401)
  })

  it('propagates tenant guard rejection (NotFoundError → 404)', async () => {
    ;(guardService.getMercadoPagoMerchant as jest.Mock).mockRejectedValue(new NotFoundError('Afiliación no encontrada'))

    const req: any = {
      query: { venueId: 'v_1', ecommerceMerchantId: 'em_x' },
      authContext: { userId: 's_1' },
    }
    const res = buildRes()
    await initiate(req, res)
    expect(res.status).toHaveBeenCalledWith(404)
  })

  it('propagates UnauthorizedError → 401', async () => {
    ;(guardService.getMercadoPagoMerchant as jest.Mock).mockRejectedValue(new UnauthorizedError('No tienes acceso'))

    const req: any = {
      query: { venueId: 'v_1', ecommerceMerchantId: 'em_1' },
      authContext: { userId: 's_1' },
    }
    const res = buildRes()
    await initiate(req, res)
    expect(res.status).toHaveBeenCalledWith(401)
  })
})

describe('callback', () => {
  it('exchanges code, persists tokens, redirects to dashboard success', async () => {
    ;(oauthService.verifyState as jest.Mock).mockReturnValue({
      intent: 'connect_merchant',
      ecommerceMerchantId: 'em_1',
      venueId: 'v_1',
      staffId: 's_1',
    })
    ;(guardService.getMercadoPagoMerchant as jest.Mock).mockResolvedValue({ id: 'em_1' })
    ;(oauthService.exchangeCodeForTokens as jest.Mock).mockResolvedValue({
      access_token: 'TEST-access',
      refresh_token: 'TEST-refresh',
      user_id: 12345678,
      expires_in: 15552000,
      scope: 'offline_access read write',
      token_type: 'bearer',
      public_key: 'pk',
      live_mode: false,
    })
    ;(connectionService.persistTokens as jest.Mock).mockResolvedValue(undefined)
    prismaMock.venue.findUnique.mockResolvedValue({ slug: 'venue-one' })

    const req: any = { query: { code: 'auth-code-123', state: 'state-jwt' } }
    const res = buildRes()
    await callback(req, res)

    expect(connectionService.persistTokens).toHaveBeenCalledWith('em_1', expect.objectContaining({ access_token: 'TEST-access' }))
    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('/venues/venue-one/edit/integrations'))
    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('mp_status=connected'))
    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('ecommerceMerchantId=em_1'))
  })

  it('redirects with error when MP returns error param (e.g. user cancelled)', async () => {
    const req: any = {
      query: {
        error: 'access_denied',
        error_description: 'User denied access',
        state: 'state-jwt',
      },
    }
    const res = buildRes()
    await callback(req, res)
    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('mp_status=error'))
    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('access_denied'))
  })

  it('redirects with error when state JWT is invalid', async () => {
    ;(oauthService.verifyState as jest.Mock).mockImplementation(() => {
      throw new Error('invalid signature')
    })

    const req: any = { query: { code: 'c', state: 'bad' } }
    const res = buildRes()
    await callback(req, res)
    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('reason=invalid_state'))
  })

  it('redirects with error when tenant guard rejects (e.g. state was tampered)', async () => {
    ;(oauthService.verifyState as jest.Mock).mockReturnValue({
      intent: 'connect_merchant',
      ecommerceMerchantId: 'em_1',
      venueId: 'v_TAMPERED',
      staffId: 's_1',
    })
    ;(guardService.getMercadoPagoMerchant as jest.Mock).mockRejectedValue(new UnauthorizedError('No tienes acceso'))

    const req: any = { query: { code: 'c', state: 'state-jwt' } }
    const res = buildRes()
    await callback(req, res)
    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('reason=tenant_check_failed'))
  })

  it('redirects with error when token exchange fails', async () => {
    ;(oauthService.verifyState as jest.Mock).mockReturnValue({
      intent: 'connect_merchant',
      ecommerceMerchantId: 'em_1',
      venueId: 'v_1',
      staffId: 's_1',
    })
    ;(guardService.getMercadoPagoMerchant as jest.Mock).mockResolvedValue({ id: 'em_1' })
    ;(oauthService.exchangeCodeForTokens as jest.Mock).mockRejectedValue(new Error('MP OAuth authorization_code failed: invalid_grant'))

    const req: any = { query: { code: 'expired-code', state: 'state-jwt' } }
    const res = buildRes()
    await callback(req, res)
    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('reason=token_exchange_failed'))
  })

  it('redirects with error when code is missing (MP didnt return code)', async () => {
    const req: any = { query: { state: 'state-jwt' } } // no code, no error
    const res = buildRes()
    await callback(req, res)
    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('reason=missing_code'))
  })
})

describe('disconnect', () => {
  it('clears credentials after tenant guard passes', async () => {
    ;(guardService.getMercadoPagoMerchant as jest.Mock).mockResolvedValue({ id: 'em_1' })
    ;(connectionService.clearCredentials as jest.Mock).mockResolvedValue(undefined)

    const req: any = { params: { venueId: 'v_1', merchantId: 'em_1' } }
    const res = buildRes()
    await disconnect(req, res)

    expect(guardService.getMercadoPagoMerchant).toHaveBeenCalledWith('v_1', 'em_1')
    expect(connectionService.clearCredentials).toHaveBeenCalledWith('em_1')
    expect(res.json).toHaveBeenCalledWith({ success: true })
  })

  it('rejects 400 when params are missing', async () => {
    const req: any = { params: {} }
    const res = buildRes()
    await disconnect(req, res)
    expect(res.status).toHaveBeenCalledWith(400)
  })

  it('propagates tenant guard rejection', async () => {
    ;(guardService.getMercadoPagoMerchant as jest.Mock).mockRejectedValue(new UnauthorizedError('No tienes acceso'))

    const req: any = { params: { venueId: 'v_1', merchantId: 'em_OTHER' } }
    const res = buildRes()
    await disconnect(req, res)
    expect(res.status).toHaveBeenCalledWith(401)
    expect(connectionService.clearCredentials).not.toHaveBeenCalled()
  })
})
