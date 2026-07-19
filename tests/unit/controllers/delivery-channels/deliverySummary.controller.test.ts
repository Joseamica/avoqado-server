/**
 * getSummary — GET /venues/:venueId/delivery/summary (Task 5 del plan delivery-activation-backend).
 * Prueba que es un wrapper delgado: lee venueId de req.params (NO authContext — mismo hueco
 * cross-tenant ya cerrado en Task 3, ver deliveryActivation.controller.test.ts) y delega al
 * servicio compartido (deliverySummary.service, también usado por el MCP tool delivery_channels).
 * Sin try/catch propio — depende de express-async-errors (montado en app.ts).
 */
jest.mock('@/services/delivery-channels/core/deliverySummary.service', () => ({
  getDeliveryDailySummary: jest.fn(),
}))

import type { Request, Response } from 'express'
import * as deliverySummaryService from '@/services/delivery-channels/core/deliverySummary.service'
import { getSummary } from '@/controllers/delivery-channels/deliveryChannels.controller'

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

describe('getSummary (GET /venues/:venueId/delivery/summary)', () => {
  it('llama getDeliveryDailySummary(venueId) y responde 200 con el resumen', async () => {
    const summary = { channels: [{ channel: 'UBER_EATS', orders: 3, totalPesos: 452.5 }], generatedAt: '2026-07-18T12:00:00.000Z' }
    ;(deliverySummaryService.getDeliveryDailySummary as jest.Mock).mockResolvedValue(summary)
    const req = mkReq()
    const res = mkRes()

    await getSummary(req, res)

    expect(deliverySummaryService.getDeliveryDailySummary).toHaveBeenCalledWith('venue1')
    expect(res.json).toHaveBeenCalledWith({ success: true, data: summary })
  })

  it('tenant scoping: lee req.params.venueId (el autorizado por el middleware), NO authContext.venueId — mismo hueco cross-tenant cerrado en Task 3', async () => {
    ;(deliverySummaryService.getDeliveryDailySummary as jest.Mock).mockResolvedValue({
      channels: [],
      generatedAt: '2026-07-18T12:00:00.000Z',
    })
    const req = mkReq({ params: { venueId: 'venue-URL-autorizado' }, authContext: { venueId: 'venue-TOKEN-stale', userId: 'staff1' } })
    const res = mkRes()

    await getSummary(req, res)

    expect(deliverySummaryService.getDeliveryDailySummary).toHaveBeenCalledWith('venue-URL-autorizado')
    expect(deliverySummaryService.getDeliveryDailySummary).not.toHaveBeenCalledWith('venue-TOKEN-stale')
  })

  it('propaga errores del service (sin try/catch propio)', async () => {
    const err = new Error('db down')
    ;(deliverySummaryService.getDeliveryDailySummary as jest.Mock).mockRejectedValue(err)
    const req = mkReq()
    const res = mkRes()

    await expect(getSummary(req, res)).rejects.toThrow('db down')
    expect(res.json).not.toHaveBeenCalled()
  })
})
