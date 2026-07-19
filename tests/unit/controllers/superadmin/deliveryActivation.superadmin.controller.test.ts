/**
 * Delivery Activation — endpoints de ops superadmin (Task 4 del plan delivery-activation-backend).
 * Prueba que listRequests/updateRequest son wrappers delgados: extraen `authContext` (JAMÁS
 * `req.user`) y delegan al service (Tasks 2 y 4), sin lógica de negocio propia. Los handlers NO
 * llevan try/catch (mismo patrón que deliveryChannels.controller.ts, dueño de este dominio) —
 * dependen de `express-async-errors` (montado en app.ts) para propagar errores.
 */
jest.mock('@/services/delivery-channels/core/deliveryActivation.service', () => ({
  listActivationRequests: jest.fn(),
  updateActivationStatus: jest.fn(),
}))

import type { Request, Response } from 'express'
import { DeliveryActivationStatus } from '@prisma/client'
import * as activationService from '@/services/delivery-channels/core/deliveryActivation.service'
import { listRequests, updateRequest } from '@/controllers/superadmin/deliveryActivation.superadmin.controller'

function mkRes(): Response {
  const res: Record<string, jest.Mock> = {}
  res.status = jest.fn(() => res)
  res.json = jest.fn(() => res)
  return res as unknown as Response
}

function mkReq(overrides: Partial<any> = {}): Request {
  return {
    params: {},
    query: {},
    body: {},
    authContext: { userId: 'ops-staff1' },
    ...overrides,
  } as unknown as Request
}

beforeEach(() => jest.clearAllMocks())

describe('listRequests (GET /api/v1/superadmin/delivery-activation)', () => {
  it('sin ?status: llama listActivationRequests(undefined) y responde 200 con la cola completa', async () => {
    const rows = [
      { id: 'req1', venueId: 'v1', status: 'PENDING', venue: { name: 'Venue Uno', slug: 'venue-uno' } },
      { id: 'req2', venueId: 'v2', status: 'CONTACTED', venue: { name: 'Venue Dos', slug: 'venue-dos' } },
    ]
    ;(activationService.listActivationRequests as jest.Mock).mockResolvedValue(rows)
    const req = mkReq()
    const res = mkRes()

    await listRequests(req, res)

    expect(activationService.listActivationRequests).toHaveBeenCalledWith(undefined)
    expect(res.json).toHaveBeenCalledWith({ success: true, data: rows })
  })

  it('con ?status=CONTACTED: llama listActivationRequests({ status: CONTACTED })', async () => {
    ;(activationService.listActivationRequests as jest.Mock).mockResolvedValue([])
    const req = mkReq({ query: { status: DeliveryActivationStatus.CONTACTED } })
    const res = mkRes()

    await listRequests(req, res)

    expect(activationService.listActivationRequests).toHaveBeenCalledWith({ status: DeliveryActivationStatus.CONTACTED })
  })

  it('propaga errores del service (sin try/catch propio — depende de express-async-errors)', async () => {
    const err = new Error('db down')
    ;(activationService.listActivationRequests as jest.Mock).mockRejectedValue(err)
    const req = mkReq()
    const res = mkRes()

    await expect(listRequests(req, res)).rejects.toThrow('db down')
    expect(res.json).not.toHaveBeenCalled()
  })
})

describe('updateRequest (PATCH /api/v1/superadmin/delivery-activation/:id)', () => {
  it('llama updateActivationStatus(params.id, body.status, authContext.userId) y responde 200', async () => {
    const updated = { id: 'req1', venueId: 'v1', status: 'CONTACTED', contactedAt: new Date() }
    ;(activationService.updateActivationStatus as jest.Mock).mockResolvedValue(updated)
    const req = mkReq({
      params: { id: 'req1' },
      body: { status: DeliveryActivationStatus.CONTACTED },
      authContext: { userId: 'ops-staff1' },
    })
    const res = mkRes()

    await updateRequest(req, res)

    expect(activationService.updateActivationStatus).toHaveBeenCalledWith('req1', DeliveryActivationStatus.CONTACTED, 'ops-staff1')
    expect(res.json).toHaveBeenCalledWith({ success: true, data: updated })
  })

  it('usa authContext.userId como performedBy — JAMÁS req.user ni otro campo del body', async () => {
    ;(activationService.updateActivationStatus as jest.Mock).mockResolvedValue({ id: 'req1' })
    const req = mkReq({
      params: { id: 'req1' },
      body: { status: DeliveryActivationStatus.DISMISSED },
      authContext: { userId: 'ops-staff9' },
      user: { uid: 'debe-ser-ignorado' },
    })
    const res = mkRes()

    await updateRequest(req, res)

    expect(activationService.updateActivationStatus).toHaveBeenCalledWith('req1', DeliveryActivationStatus.DISMISSED, 'ops-staff9')
  })

  it('propaga errores del service (sin try/catch propio)', async () => {
    const err = new Error('not found')
    ;(activationService.updateActivationStatus as jest.Mock).mockRejectedValue(err)
    const req = mkReq({ params: { id: 'missing' }, body: { status: DeliveryActivationStatus.CONNECTED } })
    const res = mkRes()

    await expect(updateRequest(req, res)).rejects.toThrow('not found')
    expect(res.json).not.toHaveBeenCalled()
  })
})
