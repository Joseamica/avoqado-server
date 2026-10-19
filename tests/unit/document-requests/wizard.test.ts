import cuid from 'cuid'
jest.mock('@/services/access/basePlan.service', () => ({ PAID_PLAN_TIER_CODES: [] }))
jest.mock('@/services/access/concederPlan', () => ({ exigirQueSePuedaConceder: jest.fn() }))
jest.mock('@/services/access/concederPlanDecision', () => ({ planesPedidos: jest.fn() }))
jest.mock('@/services/superadmin/settlementConfiguration.service', () => ({ bulkCreateSettlementConfigurations: jest.fn() }))
jest.mock('@/services/organization-payment-config.service', () => ({ getEffectivePaymentConfig: jest.fn() }))
jest.mock('@/services/modules/module.service', () => ({ moduleService: { enableModule: jest.fn() } }))
jest.mock('@/services/email.service', () => ({ __esModule: true, default: { sendTeamInvitation: jest.fn() } }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/services/privateStorage.service', () => ({ signPrivateAttachmentUrl: jest.fn() }))
import prisma from '@/utils/prismaClient'
import { createVenueWizard } from '@/controllers/superadmin/onboarding.controller'
import { moduleService } from '@/services/modules/module.service'
import { wizardHash } from '@/services/document-requests/venueLinks.service'
const actorId = cuid(),
  requestId = cuid(),
  venueId = cuid(),
  organizationId = cuid()
const payload = {
  organization: { mode: 'new', name: 'Barbería', email: 'a@example.org', phone: '5512345678' },
  venue: { name: 'Barbería', venueType: 'SALON' },
  documentRequest: { id: requestId, submissionVersion: 1, confirmed: true },
  modules: [{ code: 'ANY' }],
}
const previous = {
  success: true,
  venueId,
  venueSlug: 'barberia',
  organizationId,
  steps: [{ step: 'modules', status: 'error', message: 'Original failure' }],
}
let tx: any, res: any, next: jest.Mock
beforeEach(() => {
  jest.clearAllMocks()
  const link = {
    venueId,
    organizationId,
    requestId,
    venue: { id: venueId, organizationId, slug: 'barberia' },
    request: { organizationId },
    submission: { requestId },
    onboardingResult: previous,
  }
  tx = {
    $executeRaw: jest.fn(),
    documentRequestVenueLink: { findUnique: jest.fn().mockResolvedValue(link) },
    organization: { create: jest.fn().mockResolvedValue({ id: organizationId }) },
    venue: { create: jest.fn().mockResolvedValue({ id: venueId }) },
    venueSettings: { create: jest.fn() },
  }
  ;(prisma.$transaction as jest.Mock).mockImplementation(fn => fn(tx))
  ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue(null)
  res = { status: jest.fn().mockReturnThis(), json: jest.fn() }
  next = jest.fn()
})
test('replay returns original failure and stops before org creation or extras even if request was renewed', async () => {
  await createVenueWizard({ body: payload, authContext: { userId: actorId } } as any, res, next)
  expect(next).not.toHaveBeenCalled()
  expect(res.json).toHaveBeenCalledWith({ ...previous, replayed: true })
  expect(tx.organization.create).not.toHaveBeenCalled()
  expect(moduleService.enableModule).not.toHaveBeenCalled()
})
test('in-progress/dead process response honestly marks pending configuration', async () => {
  const link = await tx.documentRequestVenueLink.findUnique()
  link.onboardingResult = null
  await createVenueWizard({ body: payload, authContext: { userId: actorId } } as any, res, next)
  expect(res.json).toHaveBeenCalledWith(
    expect.objectContaining({
      replayed: true,
      configurationPending: true,
      steps: expect.arrayContaining([expect.objectContaining({ step: 'configuration', status: 'error' })]),
    }),
  )
  expect(moduleService.enableModule).not.toHaveBeenCalled()
})
test('stable hash is key-order independent but preserves changed intent', () => {
  expect(wizardHash({ a: 1, b: { d: 2, c: 3 } })).toBe(wizardHash({ b: { c: 3, d: 2 }, a: 1 }))
  expect(wizardHash({ ...payload, activateImmediately: true })).not.toBe(wizardHash(payload))
})
test('regression: no selection still creates venue and respects explicit approval', async () => {
  const { documentRequest: _, ...body } = payload
  await createVenueWizard({ body: { ...body, activateImmediately: true }, authContext: { userId: actorId } } as any, res, next)
  expect(next).not.toHaveBeenCalled()
  expect(tx.venue.create).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ status: 'ACTIVE', kycStatus: 'VERIFIED' }) }),
  )
})
