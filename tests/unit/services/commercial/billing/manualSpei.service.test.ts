import {
  approveCommercialManualSpeiCase,
  createCommercialManualSpeiCase,
  evaluateManualSpeiApprovalPolicy,
  registerCommercialManualSpeiEvidence,
  reviewCommercialManualSpeiEvidence,
  supersedeCommercialManualSpeiEvidence,
  transitionManualSpeiEvidence,
} from '@/services/commercial/billing/manualSpei.service'

const policy = {
  policyVersionId: 'spei-policy-mx-v1',
  dualApprovalThresholdMinor: 2_500_000n,
} as const

function exactInput(amountMinor: bigint) {
  return {
    policy,
    observedAmountMinor: amountMinor,
    referencePresent: true,
    approvingActorIds: ['finance-1'],
    attributedCommercialActorIds: [],
  }
}

describe('evaluateManualSpeiApprovalPolicy', () => {
  it('requires one financial actor for an exact deposit below MXN 25,000', () => {
    expect(evaluateManualSpeiApprovalPolicy(exactInput(2_499_900n))).toEqual({
      policyVersionId: 'spei-policy-mx-v1',
      requiredApprovals: 1,
      validApprovals: 1,
      exceptionReasons: [],
      readyToReconcile: true,
    })
  })

  it('requires two distinct actors at the MXN 25,000 threshold', () => {
    const result = evaluateManualSpeiApprovalPolicy(exactInput(2_500_000n))

    expect(result.requiredApprovals).toBe(2)
    expect(result.validApprovals).toBe(1)
    expect(result.exceptionReasons).toEqual(['DUAL_APPROVAL_THRESHOLD'])
    expect(result.readyToReconcile).toBe(false)
  })

  it('requires dual approval when the bank reference is missing', () => {
    const result = evaluateManualSpeiApprovalPolicy({
      ...exactInput(100_000n),
      referencePresent: false,
      approvingActorIds: ['finance-1', 'finance-2'],
    })

    expect(result).toMatchObject({
      requiredApprovals: 2,
      validApprovals: 2,
      exceptionReasons: ['MISSING_REFERENCE'],
      readyToReconcile: true,
    })
  })

  it('never counts the attributed seller or the same approver twice', () => {
    const result = evaluateManualSpeiApprovalPolicy({
      ...exactInput(2_500_000n),
      approvingActorIds: ['seller-1', 'finance-1', 'finance-1'],
      attributedCommercialActorIds: ['seller-1'],
    })

    expect(result.validApprovals).toBe(1)
    expect(result.readyToReconcile).toBe(false)
  })
})

describe('transitionManualSpeiEvidence', () => {
  it('moves submitted proof to review without creating cash', () => {
    expect(transitionManualSpeiEvidence({ currentStatus: 'NOT_SUBMITTED', action: 'SUBMIT' })).toEqual({
      status: 'PENDING_REVIEW',
      createsCashReceipt: false,
    })
  })

  it('keeps accepted and rejected proof separate from deposit reconciliation', () => {
    expect(transitionManualSpeiEvidence({ currentStatus: 'PENDING_REVIEW', action: 'ACCEPT' })).toEqual({
      status: 'ACCEPTED',
      createsCashReceipt: false,
    })
    expect(transitionManualSpeiEvidence({ currentStatus: 'PENDING_REVIEW', action: 'REJECT' })).toEqual({
      status: 'REJECTED',
      createsCashReceipt: false,
    })
  })
})

describe('createCommercialManualSpeiCase', () => {
  it('pins the active policy and records a missing-reference exception without creating cash', async () => {
    const tx = {
      commercialManualSpeiCase: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'spei-case-1', status: 'PENDING_REVIEW' }),
      },
      commercialManualSpeiPolicyActivation: {
        findUnique: jest.fn().mockResolvedValue({
          policyVersion: {
            id: 'spei-policy-mx-v1',
            dualApprovalThresholdMinor: 2_500_000n,
            currency: 'MXN',
          },
        }),
      },
      $queryRawUnsafe: jest.fn().mockResolvedValue([
        {
          id: 'attempt-spei-1',
          receivableId: 'ar-spei-1',
          provider: 'MANUAL_SPEI',
          status: 'PENDING',
          amountMinor: 100_000n,
          currency: 'MXN',
          organizationId: 'org-1',
          venueId: 'venue-1',
        },
      ]),
      commercialCashReceipt: { create: jest.fn() },
      activityLog: { create: jest.fn().mockResolvedValue({ id: 'activity-spei-case-1' }) },
    }
    const host = {
      $transaction: jest.fn(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx)),
    }

    const result = await createCommercialManualSpeiCase(
      {
        organizationId: 'org-1',
        venueId: 'venue-1',
        receivableId: 'ar-spei-1',
        paymentAttemptId: 'attempt-spei-1',
        observedAmountMinor: 100_000n,
        bankReference: null,
        receivingAccountFingerprint: 'c'.repeat(64),
        observedAt: new Date('2026-09-01T16:00:00.000Z'),
        attributedCommercialActorIds: ['seller-1'],
        createdById: 'finance-creator-1',
      },
      { host: host as never },
    )

    expect(result).toEqual({
      decision: 'CREATED',
      caseId: 'spei-case-1',
      status: 'PENDING_REVIEW',
      policyVersionId: 'spei-policy-mx-v1',
      requiredApprovals: 2,
      exceptionReasons: ['MISSING_REFERENCE'],
    })
    expect(tx.commercialManualSpeiCase.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          policyVersionId: 'spei-policy-mx-v1',
          requiredApprovals: 2,
          exceptionReasons: ['MISSING_REFERENCE'],
          createdById: 'finance-creator-1',
        }),
      }),
    )
    expect(tx.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorType: 'HUMAN',
          staffId: 'finance-creator-1',
          actorStaffId: 'finance-creator-1',
        }),
      }),
    )
    expect(tx.commercialCashReceipt.create).not.toHaveBeenCalled()
  })
})

describe('manual SPEI persisted evidence and approval', () => {
  it('rejects a private proof key that is not bound to the same organization and case', async () => {
    const host = { $transaction: jest.fn() }

    await expect(
      registerCommercialManualSpeiEvidence(
        {
          caseId: 'spei-case-1',
          organizationId: 'org-1',
          venueId: 'venue-1',
          uploadedById: 'owner-1',
          storageObjectKey: 'private/commercial-spei/other-org/other-case/proof.pdf',
          contentSha256: 'd'.repeat(64),
          mimeType: 'application/pdf',
          sizeBytes: 50_000,
        },
        { host: host as never },
      ),
    ).rejects.toThrow('COMMERCIAL_BILLING_SPEI_STORAGE_KEY_TENANT_MISMATCH')
    expect(host.$transaction).not.toHaveBeenCalled()
  })

  it('stores only private proof metadata and review acceptance still creates no cash', async () => {
    let caseStatus = 'PENDING_REVIEW'
    const tx = {
      $queryRawUnsafe: jest
        .fn()
        .mockResolvedValueOnce([{ id: 'spei-case-1', organizationId: 'org-1', venueId: 'venue-1', status: 'PENDING_REVIEW' }])
        .mockResolvedValueOnce([
          {
            evidenceId: 'spei-evidence-1',
            caseId: 'spei-case-1',
            organizationId: 'org-1',
            venueId: 'venue-1',
            caseStatus: 'PENDING_REVIEW',
          },
        ]),
      commercialManualSpeiEvidence: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'spei-evidence-1', sequence: 1 }),
      },
      commercialManualSpeiEvidenceReview: {
        create: jest.fn().mockResolvedValue({ id: 'spei-review-1', action: 'ACCEPT' }),
      },
      commercialManualSpeiCase: {
        update: jest.fn(async ({ data }: any) => {
          caseStatus = data.status
          return { id: 'spei-case-1', status: caseStatus }
        }),
      },
      commercialCashReceipt: { create: jest.fn() },
      activityLog: { create: jest.fn().mockResolvedValue({ id: 'activity-spei-evidence-1' }) },
    }
    const host = {
      $transaction: jest.fn(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx)),
    }

    await expect(
      registerCommercialManualSpeiEvidence(
        {
          caseId: 'spei-case-1',
          organizationId: 'org-1',
          venueId: 'venue-1',
          uploadedById: 'owner-1',
          storageObjectKey: 'private/commercial-spei/org-1/spei-case-1/proof.pdf',
          contentSha256: 'd'.repeat(64),
          mimeType: 'application/pdf',
          sizeBytes: 50_000,
        },
        { host: host as never },
      ),
    ).resolves.toEqual({ evidenceId: 'spei-evidence-1', sequence: 1, status: 'PENDING_REVIEW' })

    await expect(
      reviewCommercialManualSpeiEvidence(
        {
          evidenceId: 'spei-evidence-1',
          organizationId: 'org-1',
          venueId: 'venue-1',
          actorId: 'finance-1',
          action: 'ACCEPT',
          reason: null,
        },
        { host: host as never },
      ),
    ).resolves.toEqual({ evidenceId: 'spei-evidence-1', caseId: 'spei-case-1', status: 'AWAITING_APPROVAL' })

    expect(caseStatus).toBe('AWAITING_APPROVAL')
    expect(tx.commercialCashReceipt.create).not.toHaveBeenCalled()
  })

  it('keeps a dual-approval case pending after one actor and reconciles once after a second', async () => {
    let caseStatus = 'AWAITING_APPROVAL'
    const approvals = new Map<string, { actorId: string }>()
    const caseRow = () => ({
      id: 'spei-case-dual-1',
      organizationId: 'org-1',
      venueId: 'venue-1',
      receivableId: 'ar-spei-dual-1',
      paymentAttemptId: 'attempt-spei-dual-1',
      policyVersionId: 'spei-policy-mx-v1',
      dualApprovalThresholdMinor: 2_500_000n,
      observedAmountMinor: 2_500_000n,
      bankReference: 'SPEI-REF-1',
      receivingAccountFingerprint: 'e'.repeat(64),
      observedAt: new Date('2026-09-01T17:00:00.000Z'),
      attributedCommercialActorIds: ['seller-1'],
      requiredApprovals: 2,
      exceptionReasons: ['DUAL_APPROVAL_THRESHOLD'],
      status: caseStatus,
      reconciledReceiptId: null,
      createdById: 'finance-creator-1',
    })
    const tx = {
      $queryRawUnsafe: jest.fn(async () => [caseRow()]),
      commercialManualSpeiEvidenceReview: {
        findMany: jest.fn().mockResolvedValue([{ actorId: 'finance-reviewer-1' }]),
      },
      commercialManualSpeiApproval: {
        findUnique: jest.fn(async ({ where }: any) => approvals.get(where.caseId_actorId.actorId) ?? null),
        findMany: jest.fn(async () => [...approvals.values()]),
        create: jest.fn(async ({ data }: any) => {
          approvals.set(data.actorId, { actorId: data.actorId })
          return { id: `approval-${data.actorId}`, actorId: data.actorId }
        }),
      },
      commercialManualSpeiCase: {
        update: jest.fn(async ({ data }: any) => {
          caseStatus = data.status
          return { id: 'spei-case-dual-1', status: caseStatus }
        }),
      },
      activityLog: { create: jest.fn().mockResolvedValue({ id: 'activity-spei-approval-1' }) },
    }
    const host = {
      $transaction: jest.fn(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx)),
    }
    const reconcileCash = jest.fn().mockResolvedValue({
      decision: 'RECONCILED',
      receiptId: 'receipt-spei-dual-1',
      allocatedMinor: 2_500_000n,
      receivableStatus: 'PAID',
      periodStatus: 'PAID',
      eventId: 'event-spei-dual-1',
    })

    await expect(
      approveCommercialManualSpeiCase(
        {
          caseId: 'spei-case-dual-1',
          organizationId: 'org-1',
          venueId: 'venue-1',
          actorId: 'finance-1',
          now: new Date('2026-09-01T17:02:00.000Z'),
        },
        { host: host as never, reconcileCash },
      ),
    ).resolves.toMatchObject({ decision: 'PENDING_SECOND_APPROVAL', validApprovals: 1, requiredApprovals: 2 })
    expect(tx.commercialManualSpeiApproval.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        actorId: 'finance-1',
        policyVersionId: 'spei-policy-mx-v1',
        exceptionReasons: ['DUAL_APPROVAL_THRESHOLD'],
      }),
    })
    expect(reconcileCash).not.toHaveBeenCalled()

    await expect(
      approveCommercialManualSpeiCase(
        {
          caseId: 'spei-case-dual-1',
          organizationId: 'org-1',
          venueId: 'venue-1',
          actorId: 'finance-2',
          now: new Date('2026-09-01T17:03:00.000Z'),
        },
        { host: host as never, reconcileCash },
      ),
    ).resolves.toMatchObject({
      decision: 'RECONCILED',
      validApprovals: 2,
      requiredApprovals: 2,
      receiptId: 'receipt-spei-dual-1',
    })
    expect(reconcileCash).toHaveBeenCalledTimes(1)
    expect(caseStatus).toBe('RECONCILED')
  })

  it.each([
    ['the case creator', 'finance-creator-1'],
    ['the accepted-evidence reviewer', 'finance-reviewer-1'],
  ])('rejects %s as a financial approver', async (_label, actorId) => {
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([
        {
          id: 'spei-case-independent-1',
          organizationId: 'org-1',
          venueId: 'venue-1',
          receivableId: 'ar-spei-independent-1',
          paymentAttemptId: 'attempt-spei-independent-1',
          policyVersionId: 'spei-policy-mx-v1',
          dualApprovalThresholdMinor: 2_500_000n,
          observedAmountMinor: 100_000n,
          bankReference: 'SPEI-INDEPENDENT-1',
          receivingAccountFingerprint: 'f'.repeat(64),
          observedAt: new Date('2026-09-01T18:00:00.000Z'),
          attributedCommercialActorIds: [],
          createdById: 'finance-creator-1',
          requiredApprovals: 1,
          exceptionReasons: [],
          status: 'AWAITING_APPROVAL',
          reconciledReceiptId: null,
        },
      ]),
      commercialManualSpeiEvidenceReview: {
        findMany: jest.fn().mockResolvedValue([{ actorId: 'finance-reviewer-1' }]),
      },
      commercialManualSpeiApproval: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: 'approval-forbidden-1' }),
      },
      commercialManualSpeiCase: { update: jest.fn() },
      activityLog: { create: jest.fn() },
    }
    const host = {
      $transaction: jest.fn(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx)),
    }

    await expect(
      approveCommercialManualSpeiCase(
        {
          caseId: 'spei-case-independent-1',
          organizationId: 'org-1',
          venueId: 'venue-1',
          actorId,
          now: new Date('2026-09-01T18:01:00.000Z'),
        },
        { host: host as never, reconcileCash: jest.fn() },
      ),
    ).rejects.toThrow('COMMERCIAL_BILLING_SPEI_APPROVER_NOT_INDEPENDENT')
    expect(tx.commercialManualSpeiApproval.create).not.toHaveBeenCalled()
  })

  it('supersedes rejected evidence and reopens the case for a replacement proof', async () => {
    let caseStatus = 'REJECTED'
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([
        {
          evidenceId: 'spei-evidence-rejected-1',
          caseId: 'spei-case-rejected-1',
          organizationId: 'org-1',
          venueId: 'venue-1',
          caseStatus: 'REJECTED',
          isLatest: true,
          hasReject: true,
          hasSupersede: false,
        },
      ]),
      commercialManualSpeiEvidenceReview: {
        create: jest.fn().mockResolvedValue({ id: 'spei-review-supersede-1' }),
      },
      commercialManualSpeiCase: {
        update: jest.fn(async ({ data }: { data: { status: string } }) => {
          caseStatus = data.status
          return { id: 'spei-case-rejected-1', status: caseStatus }
        }),
      },
      activityLog: { create: jest.fn().mockResolvedValue({ id: 'activity-spei-supersede-1' }) },
    }
    const host = {
      $transaction: jest.fn(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx)),
    }

    await expect(
      supersedeCommercialManualSpeiEvidence(
        {
          evidenceId: 'spei-evidence-rejected-1',
          organizationId: 'org-1',
          venueId: 'venue-1',
          actorId: 'finance-reviewer-2',
          reason: 'El cliente entregará un comprobante corregido.',
        },
        { host: host as never },
      ),
    ).resolves.toEqual({
      evidenceId: 'spei-evidence-rejected-1',
      caseId: 'spei-case-rejected-1',
      status: 'PENDING_REVIEW',
    })
    expect(tx.commercialManualSpeiEvidenceReview.create).toHaveBeenCalledWith({
      data: {
        evidenceId: 'spei-evidence-rejected-1',
        action: 'SUPERSEDE',
        actorId: 'finance-reviewer-2',
        reason: 'El cliente entregará un comprobante corregido.',
      },
    })
    expect(caseStatus).toBe('PENDING_REVIEW')
  })
})
