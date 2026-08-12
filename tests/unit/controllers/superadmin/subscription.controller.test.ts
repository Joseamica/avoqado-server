import type { NextFunction, Request, Response } from 'express'
import { activate, adjustEndDate, deactivate, grantTrial } from '@/controllers/superadmin/subscription.controller'
import * as subscriptionService from '@/services/superadmin/subscription.service'
import { MASTER_ADMIN_PRINCIPAL_ID } from '@/lib/authPrincipals'

jest.mock('@/services/superadmin/subscription.service', () => ({
  activateVenuePlan: jest.fn(),
  deactivateVenuePlan: jest.fn(),
  grantVenuePlanTrial: jest.fn(),
  adjustVenuePlanEndDate: jest.fn(),
  getSubscriptionOverview: jest.fn(),
  getSubscriptionsForSuperadmin: jest.fn(),
}))

function request(body: Record<string, unknown> = {}): Request {
  return {
    params: { venueId: 'venue-1' },
    body,
    authContext: { userId: MASTER_ADMIN_PRINCIPAL_ID },
  } as unknown as Request
}

function response(): Response {
  const res = { json: jest.fn() } as unknown as Response
  ;(res.json as jest.Mock).mockReturnValue(res)
  return res
}

describe('superadmin subscription mutation controller', () => {
  const next = jest.fn() as unknown as NextFunction
  const result = { venueId: 'venue-1', state: 'active' }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it.each([
    {
      handler: activate,
      body: {},
      service: subscriptionService.activateVenuePlan as jest.Mock,
      expected: ['venue-1', MASTER_ADMIN_PRINCIPAL_ID],
    },
    {
      handler: deactivate,
      body: {},
      service: subscriptionService.deactivateVenuePlan as jest.Mock,
      expected: ['venue-1', MASTER_ADMIN_PRINCIPAL_ID],
    },
    {
      handler: grantTrial,
      body: { days: 14 },
      service: subscriptionService.grantVenuePlanTrial as jest.Mock,
      expected: ['venue-1', 14, MASTER_ADMIN_PRINCIPAL_ID],
    },
    {
      handler: adjustEndDate,
      body: { deltaDays: -7 },
      service: subscriptionService.adjustVenuePlanEndDate as jest.Mock,
      expected: ['venue-1', -7, MASTER_ADMIN_PRINCIPAL_ID],
    },
  ])('delegates $handler.name to the audited service with authContext.userId', async ({ handler, body, service, expected }) => {
    service.mockResolvedValue(result)
    const res = response()

    await handler(request(body), res, next)

    expect(service).toHaveBeenCalledWith(...expected)
    expect(res.json).toHaveBeenCalledWith({ success: true, data: result })
    expect(next).not.toHaveBeenCalled()
  })

  it('does not send a success response when the atomic service rejects', async () => {
    const error = new Error('audit unavailable')
    ;(subscriptionService.activateVenuePlan as jest.Mock).mockRejectedValue(error)
    const res = response()

    await activate(request(), res, next)

    expect(next).toHaveBeenCalledWith(error)
    expect(res.json).not.toHaveBeenCalled()
  })
})
