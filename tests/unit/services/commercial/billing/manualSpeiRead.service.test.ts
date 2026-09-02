import {
  getCommercialManualSpeiCase,
  getCommercialManualSpeiEvidenceAccess,
  listCommercialManualSpeiCases,
} from '@/services/commercial/billing/manualSpeiRead.service'

describe('commercial manual SPEI read model', () => {
  it('lists review cases with money serialized exactly and no private object coordinates', async () => {
    const findMany = jest.fn().mockResolvedValue([
      {
        id: 'case-1',
        organizationId: 'org-1',
        venueId: 'venue-1',
        receivableId: 'receivable-1',
        paymentAttemptId: 'attempt-1',
        policyVersionId: 'policy-1',
        observedAmountMinor: 28884n,
        currency: 'MXN',
        bankReference: 'SPEI-123',
        observedAt: new Date('2026-09-01T18:00:00.000Z'),
        createdById: 'staff-creator-1',
        requiredApprovals: 1,
        exceptionReasons: [],
        status: 'AWAITING_APPROVAL',
        reconciledReceiptId: null,
        createdAt: new Date('2026-09-01T18:01:00.000Z'),
        updatedAt: new Date('2026-09-01T18:02:00.000Z'),
        _count: { evidence: 1, approvals: 0 },
      },
    ])
    const client = { commercialManualSpeiCase: { findMany } }

    const result = await listCommercialManualSpeiCases(
      { organizationId: 'org-1', status: 'AWAITING_APPROVAL', limit: 25 },
      { client: client as never },
    )

    expect(result.items).toEqual([
      expect.objectContaining({
        id: 'case-1',
        observedAmountMinor: '28884',
        evidenceCount: 1,
        approvalCount: 0,
        createdById: 'staff-creator-1',
      }),
    ])
    expect(JSON.stringify(result)).not.toContain('storageObjectKey')
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: 'org-1', status: 'AWAITING_APPROVAL' }),
        take: 26,
      }),
    )
  })

  it('returns review history without ever selecting the private storage key', async () => {
    const findUnique = jest.fn().mockResolvedValue({
      id: 'case-1',
      organizationId: 'org-1',
      venueId: 'venue-1',
      receivableId: 'receivable-1',
      paymentAttemptId: 'attempt-1',
      policyVersionId: 'policy-1',
      observedAmountMinor: 28884n,
      currency: 'MXN',
      bankReference: 'SPEI-123',
      receivingAccountFingerprint: 'a'.repeat(64),
      observedAt: new Date('2026-09-01T18:00:00.000Z'),
      attributedCommercialActorIds: [],
      createdById: 'staff-creator-1',
      requiredApprovals: 1,
      exceptionReasons: [],
      status: 'AWAITING_APPROVAL',
      reconciledReceiptId: null,
      createdAt: new Date('2026-09-01T18:01:00.000Z'),
      updatedAt: new Date('2026-09-01T18:02:00.000Z'),
      _count: { evidence: 1, approvals: 0 },
      evidence: [
        {
          id: 'evidence-1',
          sequence: 1,
          contentSha256: 'b'.repeat(64),
          mimeType: 'application/pdf',
          sizeBytes: 1024,
          uploadedById: 'staff-1',
          createdAt: new Date('2026-09-01T18:01:00.000Z'),
          reviews: [],
        },
      ],
      approvals: [],
    })
    const client = { commercialManualSpeiCase: { findUnique } }

    const result = await getCommercialManualSpeiCase('case-1', { client: client as never })

    expect(result).toEqual(expect.objectContaining({ id: 'case-1', observedAmountMinor: '28884', createdById: 'staff-creator-1' }))
    expect(JSON.stringify(result)).not.toContain('storageObjectKey')
    const query = findUnique.mock.calls[0][0]
    expect(query.select.evidence.select).not.toHaveProperty('storageObjectKey')
  })

  it('signs evidence only after scoping it to the requested organization and venue, then audits the view', async () => {
    const findFirst = jest.fn().mockResolvedValue({
      id: 'evidence-1',
      caseId: 'case-1',
      storageObjectKey: 'private/commercial-spei/org-1/case-1/proof.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
    })
    const create = jest.fn().mockResolvedValue({ id: 'activity-1' })
    const signUrl = jest.fn().mockResolvedValue('https://storage.test/signed-proof')
    const client = {
      commercialManualSpeiEvidence: { findFirst },
      activityLog: { create },
    }

    const result = await getCommercialManualSpeiEvidenceAccess(
      {
        evidenceId: 'evidence-1',
        organizationId: 'org-1',
        venueId: 'venue-1',
        actorId: 'staff-1',
      },
      { client: client as never, signUrl },
    )

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: 'evidence-1',
        case: { organizationId: 'org-1', venueId: 'venue-1' },
      },
      select: {
        id: true,
        caseId: true,
        storageObjectKey: true,
        mimeType: true,
        sizeBytes: true,
      },
    })
    expect(signUrl).toHaveBeenCalledWith('private/commercial-spei/org-1/case-1/proof.pdf', 10)
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org-1',
        venueId: 'venue-1',
        actorType: 'HUMAN',
        staffId: 'staff-1',
        actorStaffId: 'staff-1',
        action: 'COMMERCIAL_MANUAL_SPEI_EVIDENCE_VIEWED',
        entity: 'CommercialManualSpeiEvidence',
        entityId: 'evidence-1',
      }),
    })
    expect(result).toEqual({
      url: 'https://storage.test/signed-proof',
      expiresInMinutes: 10,
      mimeType: 'application/pdf',
      sizeBytes: 1024,
    })
  })

  it('does not sign or audit evidence outside the requested tenant scope', async () => {
    const findFirst = jest.fn().mockResolvedValue(null)
    const create = jest.fn()
    const signUrl = jest.fn()
    const client = {
      commercialManualSpeiEvidence: { findFirst },
      activityLog: { create },
    }

    await expect(
      getCommercialManualSpeiEvidenceAccess(
        {
          evidenceId: 'evidence-1',
          organizationId: 'org-other',
          venueId: 'venue-other',
          actorId: 'staff-1',
        },
        { client: client as never, signUrl },
      ),
    ).resolves.toBeNull()
    expect(signUrl).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })
})
