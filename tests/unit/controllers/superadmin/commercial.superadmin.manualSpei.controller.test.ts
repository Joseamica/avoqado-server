const createCase = jest.fn()
const supersedeEvidence = jest.fn()
const getEvidenceAccess = jest.fn()

jest.mock('@/security', () => ({ getRealUserId: jest.fn(() => 'staff-session-1') }))
jest.mock('@/services/commercial/billing/manualSpei.service', () => ({
  approveCommercialManualSpeiCase: jest.fn(),
  createCommercialManualSpeiCase: (...args: unknown[]) => createCase(...args),
  registerCommercialManualSpeiEvidence: jest.fn(),
  reviewCommercialManualSpeiEvidence: jest.fn(),
  supersedeCommercialManualSpeiEvidence: (...args: unknown[]) => supersedeEvidence(...args),
}))
jest.mock('@/services/commercial/billing/manualSpeiRead.service', () => ({
  getCommercialManualSpeiCase: jest.fn(),
  getCommercialManualSpeiEvidenceAccess: (...args: unknown[]) => getEvidenceAccess(...args),
  listCommercialManualSpeiCases: jest.fn(),
}))

import {
  createManualSpeiCase,
  getManualSpeiEvidenceAccess,
  supersedeManualSpeiEvidence,
} from '@/controllers/superadmin/commercial.superadmin.controller'

function response() {
  return {
    setHeader: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  }
}

describe('commercial superadmin manual SPEI actor authority', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('derives the case creator from the authenticated session instead of the request body', async () => {
    createCase.mockResolvedValue({ decision: 'CREATED', caseId: 'spei-case-1' })
    const req = {
      body: {
        organizationId: 'org-1',
        venueId: 'venue-1',
        createdById: 'spoofed-body-actor',
      },
      authContext: { userId: 'staff-session-1' },
      ip: '127.0.0.1',
      get: jest.fn(),
    }
    const res = response()
    const next = jest.fn()

    await createManualSpeiCase(req as never, res as never, next)

    expect(createCase).toHaveBeenCalledWith({
      organizationId: 'org-1',
      venueId: 'venue-1',
      createdById: 'staff-session-1',
    })
    expect(res.status).toHaveBeenCalledWith(201)
    expect(next).not.toHaveBeenCalled()
  })

  it('derives the supersede reviewer from the authenticated session', async () => {
    supersedeEvidence.mockResolvedValue({
      evidenceId: 'spei-evidence-1',
      caseId: 'spei-case-1',
      status: 'PENDING_REVIEW',
    })
    const req = {
      params: { evidenceId: 'spei-evidence-1' },
      body: {
        organizationId: 'org-1',
        venueId: 'venue-1',
        actorId: 'spoofed-body-actor',
        reason: 'El cliente entregará evidencia corregida.',
      },
      authContext: { userId: 'staff-session-1' },
      ip: '127.0.0.1',
      get: jest.fn(),
    }
    const res = response()
    const next = jest.fn()

    await supersedeManualSpeiEvidence(req as never, res as never, next)

    expect(supersedeEvidence).toHaveBeenCalledWith({
      evidenceId: 'spei-evidence-1',
      organizationId: 'org-1',
      venueId: 'venue-1',
      actorId: 'staff-session-1',
      reason: 'El cliente entregará evidencia corregida.',
    })
    expect(res.status).toHaveBeenCalledWith(200)
    expect(next).not.toHaveBeenCalled()
  })

  it('derives the evidence viewer from the authenticated session', async () => {
    getEvidenceAccess.mockResolvedValue({
      url: 'https://storage.test/signed-proof',
      expiresInMinutes: 10,
      mimeType: 'application/pdf',
      sizeBytes: 1024,
    })
    const req = {
      params: { evidenceId: 'spei-evidence-1' },
      query: { organizationId: 'org-1', venueId: 'venue-1', actorId: 'spoofed-query-actor' },
      authContext: { userId: 'staff-session-1' },
      ip: '127.0.0.1',
      get: jest.fn(),
    }
    const res = response()
    const next = jest.fn()

    await getManualSpeiEvidenceAccess(req as never, res as never, next)

    expect(getEvidenceAccess).toHaveBeenCalledWith({
      evidenceId: 'spei-evidence-1',
      organizationId: 'org-1',
      venueId: 'venue-1',
      actorId: 'staff-session-1',
    })
    expect(res.status).toHaveBeenCalledWith(200)
    expect(next).not.toHaveBeenCalled()
  })
})
