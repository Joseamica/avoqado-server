import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'
import prisma from '@/utils/prismaClient'
import AppError from '@/errors/AppError'

const mockGetOrCreateStripeCustomer = jest.fn()
const mockCreatePlanCheckoutSession = jest.fn()
const mockGetVenueBaseTier = jest.fn()

jest.mock('@/services/stripe.service', () => ({
  getOrCreateStripeCustomer: (...args: unknown[]) => mockGetOrCreateStripeCustomer(...args),
  createPlanCheckoutSession: (...args: unknown[]) => mockCreatePlanCheckoutSession(...args),
  updatePaymentMethod: jest.fn(),
  createTrialSubscriptions: jest.fn(),
  createCustomerPortalSession: jest.fn(),
  syncFeaturesToStripe: jest.fn(),
  listPaymentMethods: jest.fn(),
  detachPaymentMethod: jest.fn(),
  setDefaultPaymentMethod: jest.fn(),
  createTrialSetupIntent: jest.fn(),
}))

jest.mock('@/services/access/basePlan.service', () => ({
  getVenueBaseTier: (...args: unknown[]) => mockGetVenueBaseTier(...args),
  getVenuePlanInfo: jest.fn(),
}))

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import { createVenuePlanCheckoutSession } from '@/controllers/dashboard/venue.dashboard.controller'

const prismaMock = prisma as any

function app() {
  const server = express()
  server.use(express.json())
  server.post(
    '/api/v1/dashboard/venues/:venueId/plan/checkout',
    (req: Request, _res: Response, next: NextFunction) => {
      req.authContext = { userId: 'staff-1', orgId: 'org-1', venueId: req.params.venueId, role: 'OWNER' }
      next()
    },
    createVenuePlanCheckoutSession,
  )
  server.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({ message: error.message, ...(error.code ? { code: error.code } : {}) })
    }
    return res.status(500).json({ message: 'Unexpected error' })
  })
  return server
}

function venue(status: 'LIVE_DEMO' | 'TRIAL' | 'ACTIVE') {
  return {
    id: 'venue-1',
    name: 'Sucursal Uno',
    slug: 'sucursal-uno',
    stripeCustomerId: null,
    organizationId: 'org-1',
    status,
  }
}

describe('legacy plan checkout venue eligibility HTTP contract', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.venue.findFirst.mockResolvedValue(venue('ACTIVE'))
    prismaMock.organization.findUnique.mockResolvedValue({ id: 'org-1', name: 'Org Uno', email: 'owner@example.test' })
    prismaMock.staffVenue.findFirst.mockResolvedValue({
      staff: { email: 'owner@example.test', firstName: 'Ada', lastName: 'Lovelace' },
    })
    prismaMock.venue.update.mockResolvedValue({})
    mockGetVenueBaseTier.mockResolvedValue(null)
    mockGetOrCreateStripeCustomer.mockResolvedValue('cus_active')
    mockCreatePlanCheckoutSession.mockResolvedValue('https://checkout.stripe.test/cs_active')
  })

  it.each(['LIVE_DEMO', 'TRIAL'] as const)('returns stable 403 for %s before customer, Stripe or origin boundary', async status => {
    prismaMock.venue.findFirst.mockResolvedValueOnce(venue(status))

    const response = await request(app())
      .post('/api/v1/dashboard/venues/venue-1/plan/checkout')
      .send({ interval: 'monthly', tier: 'PRO' })
      .expect(403)

    expect(response.body.code).toBe('LEGACY_PLAN_CHECKOUT_DEMO_VENUE_FORBIDDEN')
    expect(prismaMock.venue.findFirst).toHaveBeenCalledWith(expect.objectContaining({ select: expect.objectContaining({ status: true }) }))
    expect(mockGetVenueBaseTier).not.toHaveBeenCalled()
    expect(mockGetOrCreateStripeCustomer).not.toHaveBeenCalled()
    expect(prismaMock.venue.update).not.toHaveBeenCalled()
    expect(mockCreatePlanCheckoutSession).not.toHaveBeenCalled()
  })

  it('keeps ACTIVE venues on the existing customer and checkout path', async () => {
    const response = await request(app())
      .post('/api/v1/dashboard/venues/venue-1/plan/checkout')
      .send({ interval: 'annual', tier: 'PREMIUM' })
      .expect(200)

    expect(mockGetOrCreateStripeCustomer).toHaveBeenCalledTimes(1)
    expect(mockCreatePlanCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ venueId: 'venue-1', customerId: 'cus_active', interval: 'annual', tierCode: 'PLAN_PREMIUM' }),
    )
    expect(response.body).toEqual({ success: true, url: 'https://checkout.stripe.test/cs_active' })
  })
})
