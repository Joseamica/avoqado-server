/**
 * Delivery Activation — endpoints del dueño (Task 3 del plan delivery-activation-backend).
 * Prueba que requestActivation/getActivation son wrappers delgados: extraen `authContext`
 * (JAMÁS `req.user`) y delegan al service (Task 2), sin lógica de negocio propia. Los
 * handlers NO llevan try/catch (patrón ya usado en deliverect.webhook.controller.ts del mismo
 * dominio) — dependen de `express-async-errors` (montado en app.ts) para propagar errores.
 */
jest.mock('@/services/delivery-channels/core/deliveryActivation.service', () => ({
  createActivationRequest: jest.fn(),
  getActivationRequest: jest.fn(),
}))

import type { Request, Response } from 'express'
import * as activationService from '@/services/delivery-channels/core/deliveryActivation.service'
import { requestActivation, getActivation } from '@/controllers/delivery-channels/deliveryChannels.controller'

function mkRes(): Response {
  const res: Record<string, jest.Mock> = {}
  res.status = jest.fn(() => res)
  res.json = jest.fn(() => res)
  return res as unknown as Response
}

function mkReq(overrides: Partial<any> = {}): Request {
  return {
    params: { venueId: 'venue1' },
    body: {},
    authContext: { venueId: 'venue1', userId: 'staff1' },
    ...overrides,
  } as unknown as Request
}

beforeEach(() => jest.clearAllMocks())

describe('requestActivation (POST /venues/:venueId/activation-request)', () => {
  it('llama createActivationRequest(venueId, authContext.userId, req.body) y responde 200 con la solicitud', async () => {
    const created = { id: 'req1', venueId: 'venue1', status: 'PENDING', requestedChannels: ['UBER_EATS'] }
    ;(activationService.createActivationRequest as jest.Mock).mockResolvedValue(created)
    const req = mkReq({ body: { requestedChannels: ['UBER_EATS'], note: 'Ya tengo cuenta en Uber Eats' } })
    const res = mkRes()

    await requestActivation(req, res)

    expect(activationService.createActivationRequest).toHaveBeenCalledWith('venue1', 'staff1', {
      requestedChannels: ['UBER_EATS'],
      note: 'Ya tengo cuenta en Uber Eats',
    })
    expect(res.json).toHaveBeenCalledWith({ success: true, data: created })
  })

  it('idempotente: cuando el service devuelve la solicitud viva existente, el controller la reenvía tal cual', async () => {
    const existing = { id: 'existing1', venueId: 'venue1', status: 'PENDING', requestedChannels: ['RAPPI'] }
    ;(activationService.createActivationRequest as jest.Mock).mockResolvedValue(existing)
    const req = mkReq({ body: { requestedChannels: ['DIDI_FOOD'] } })
    const res = mkRes()

    await requestActivation(req, res)

    // El controller no distingue "creó nueva" vs "devolvió existente" — eso lo decide el service (Task 2).
    expect(res.json).toHaveBeenCalledWith({ success: true, data: existing })
  })

  it('usa authContext.userId como requestedById — JAMÁS req.user ni otro campo del body', async () => {
    ;(activationService.createActivationRequest as jest.Mock).mockResolvedValue({ id: 'req1' })
    // params.venueId === authContext.venueId aquí — este test aísla el origen del userId, no del venueId.
    const req = mkReq({
      params: { venueId: 'venue9' },
      authContext: { venueId: 'venue9', userId: 'staff9' },
      body: { requestedChannels: ['RAPPI'] },
    })
    const res = mkRes()

    await requestActivation(req, res)

    expect(activationService.createActivationRequest).toHaveBeenCalledWith('venue9', 'staff9', expect.anything())
  })

  it('tenant scoping: escribe en req.params.venueId (el venue que autorizó el middleware), NO authContext.venueId — cierra el hueco cross-tenant si el token queda stale tras switchVenue', async () => {
    ;(activationService.createActivationRequest as jest.Mock).mockResolvedValue({ id: 'req1' })
    // checkFeatureAccess/checkPermission autorizan el venue de la URL vía resolveRequestVenueId
    // (params > header > token). El JWT (authContext.venueId) puede quedar stale tras switchVenue,
    // así que el handler DEBE escribir en el venue autorizado (params), nunca en el del token.
    const req = mkReq({
      params: { venueId: 'venue-URL-autorizado' },
      authContext: { venueId: 'venue-TOKEN-stale', userId: 'staff1' },
      body: { requestedChannels: ['UBER_EATS'] },
    })
    const res = mkRes()

    await requestActivation(req, res)

    expect(activationService.createActivationRequest).toHaveBeenCalledWith('venue-URL-autorizado', 'staff1', expect.anything())
    // Jamás debe filtrarse el venue del token en la llamada.
    expect(activationService.createActivationRequest).not.toHaveBeenCalledWith('venue-TOKEN-stale', expect.anything(), expect.anything())
  })

  it('propaga errores del service (sin try/catch propio — depende de express-async-errors)', async () => {
    const err = new Error('db down')
    ;(activationService.createActivationRequest as jest.Mock).mockRejectedValue(err)
    const req = mkReq({ body: { requestedChannels: ['UBER_EATS'] } })
    const res = mkRes()

    await expect(requestActivation(req, res)).rejects.toThrow('db down')
    expect(res.json).not.toHaveBeenCalled()
  })
})

describe('getActivation (GET /venues/:venueId/activation-request)', () => {
  it('llama getActivationRequest(venueId) y responde 200 con la solicitud viva', async () => {
    const live = { id: 'req1', venueId: 'venue1', status: 'CONTACTED' }
    ;(activationService.getActivationRequest as jest.Mock).mockResolvedValue(live)
    const req = mkReq()
    const res = mkRes()

    await getActivation(req, res)

    expect(activationService.getActivationRequest).toHaveBeenCalledWith('venue1')
    expect(res.json).toHaveBeenCalledWith({ success: true, data: live })
  })

  it('responde 200 con data: null cuando el venue no tiene solicitud viva', async () => {
    ;(activationService.getActivationRequest as jest.Mock).mockResolvedValue(null)
    const req = mkReq()
    const res = mkRes()

    await getActivation(req, res)

    expect(res.json).toHaveBeenCalledWith({ success: true, data: null })
  })

  it('tenant scoping: lee req.params.venueId (el autorizado), NO authContext.venueId — mismo hueco cross-tenant que el POST', async () => {
    ;(activationService.getActivationRequest as jest.Mock).mockResolvedValue(null)
    const req = mkReq({ params: { venueId: 'venue-URL-autorizado' }, authContext: { venueId: 'venue-TOKEN-stale', userId: 'staff1' } })
    const res = mkRes()

    await getActivation(req, res)

    expect(activationService.getActivationRequest).toHaveBeenCalledWith('venue-URL-autorizado')
    expect(activationService.getActivationRequest).not.toHaveBeenCalledWith('venue-TOKEN-stale')
  })

  it('propaga errores del service (sin try/catch propio)', async () => {
    const err = new Error('db down')
    ;(activationService.getActivationRequest as jest.Mock).mockRejectedValue(err)
    const req = mkReq()
    const res = mkRes()

    await expect(getActivation(req, res)).rejects.toThrow('db down')
  })
})
