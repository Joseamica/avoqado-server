import type { CommercialManualSpeiCaseStatus, PrismaClient } from '@prisma/client'

import type { CommercialManualSpeiExceptionReason } from '@/types/commercialBilling'
import prisma from '@/utils/prismaClient'
import { signPrivateFileUrl } from '@/services/privateStorage.service'

const MANUAL_SPEI_CASE_STATUSES = new Set<CommercialManualSpeiCaseStatus>([
  'PENDING_REVIEW',
  'AWAITING_APPROVAL',
  'READY_TO_RECONCILE',
  'RECONCILED',
  'REJECTED',
])
const EVIDENCE_SIGNED_URL_MINUTES = 10

const caseSummarySelect = {
  id: true,
  organizationId: true,
  venueId: true,
  receivableId: true,
  paymentAttemptId: true,
  policyVersionId: true,
  observedAmountMinor: true,
  currency: true,
  bankReference: true,
  observedAt: true,
  createdById: true,
  requiredApprovals: true,
  exceptionReasons: true,
  status: true,
  reconciledReceiptId: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { evidence: true, approvals: true } },
} as const

function requiredId(value: string, code: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(code)
  return value
}

function projectCaseSummary(row: {
  id: string
  organizationId: string
  venueId: string
  receivableId: string
  paymentAttemptId: string
  policyVersionId: string
  observedAmountMinor: bigint
  currency: string
  bankReference: string | null
  observedAt: Date
  createdById: string
  requiredApprovals: number
  exceptionReasons: unknown
  status: CommercialManualSpeiCaseStatus
  reconciledReceiptId: string | null
  createdAt: Date
  updatedAt: Date
  _count: { evidence: number; approvals: number }
}) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    venueId: row.venueId,
    receivableId: row.receivableId,
    paymentAttemptId: row.paymentAttemptId,
    policyVersionId: row.policyVersionId,
    observedAmountMinor: row.observedAmountMinor.toString(),
    currency: row.currency,
    bankReference: row.bankReference,
    observedAt: row.observedAt,
    createdById: row.createdById,
    requiredApprovals: row.requiredApprovals,
    exceptionReasons: row.exceptionReasons as CommercialManualSpeiExceptionReason[],
    status: row.status,
    reconciledReceiptId: row.reconciledReceiptId,
    evidenceCount: row._count.evidence,
    approvalCount: row._count.approvals,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function listCommercialManualSpeiCases(
  input: {
    organizationId?: string
    venueId?: string
    status?: CommercialManualSpeiCaseStatus
    cursor?: string
    limit?: number
  },
  dependencies: { client?: PrismaClient } = {},
) {
  if (input.organizationId !== undefined) requiredId(input.organizationId, 'COMMERCIAL_BILLING_SPEI_ORGANIZATION_INVALID')
  if (input.venueId !== undefined) requiredId(input.venueId, 'COMMERCIAL_BILLING_SPEI_VENUE_INVALID')
  if (input.cursor !== undefined) requiredId(input.cursor, 'COMMERCIAL_BILLING_SPEI_CURSOR_INVALID')
  if (input.status !== undefined && !MANUAL_SPEI_CASE_STATUSES.has(input.status)) {
    throw new Error('COMMERCIAL_BILLING_SPEI_STATUS_INVALID')
  }
  const limit = input.limit ?? 50
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('COMMERCIAL_BILLING_SPEI_LIMIT_INVALID')
  }
  const client = dependencies.client ?? prisma
  const rows = await client.commercialManualSpeiCase.findMany({
    where: {
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
      ...(input.venueId ? { venueId: input.venueId } : {}),
      ...(input.status ? { status: input.status } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    take: limit + 1,
    select: caseSummarySelect,
  })
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  return {
    items: page.map(projectCaseSummary),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  }
}

export async function getCommercialManualSpeiCase(caseId: string, dependencies: { client?: PrismaClient } = {}) {
  requiredId(caseId, 'COMMERCIAL_BILLING_SPEI_CASE_ID_INVALID')
  const client = dependencies.client ?? prisma
  const row = await client.commercialManualSpeiCase.findUnique({
    where: { id: caseId },
    select: {
      ...caseSummarySelect,
      receivingAccountFingerprint: true,
      attributedCommercialActorIds: true,
      evidence: {
        orderBy: [{ sequence: 'asc' }],
        select: {
          id: true,
          sequence: true,
          contentSha256: true,
          mimeType: true,
          sizeBytes: true,
          uploadedById: true,
          createdAt: true,
          reviews: {
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: { id: true, action: true, actorId: true, reason: true, createdAt: true },
          },
        },
      },
      approvals: {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, actorId: true, policyVersionId: true, exceptionReasons: true, createdAt: true },
      },
    },
  })
  if (!row) return null
  return {
    ...projectCaseSummary(row),
    receivingAccountFingerprint: row.receivingAccountFingerprint,
    attributedCommercialActorIds: row.attributedCommercialActorIds as string[],
    evidence: row.evidence,
    approvals: row.approvals.map(approval => ({
      ...approval,
      exceptionReasons: approval.exceptionReasons as CommercialManualSpeiExceptionReason[],
    })),
  }
}

export async function getCommercialManualSpeiEvidenceAccess(
  input: {
    evidenceId: string
    organizationId: string
    venueId: string
    actorId: string
  },
  dependencies: {
    client?: PrismaClient
    signUrl?: typeof signPrivateFileUrl
  } = {},
) {
  requiredId(input.evidenceId, 'COMMERCIAL_BILLING_SPEI_EVIDENCE_ID_INVALID')
  requiredId(input.organizationId, 'COMMERCIAL_BILLING_SPEI_ORGANIZATION_INVALID')
  requiredId(input.venueId, 'COMMERCIAL_BILLING_SPEI_VENUE_INVALID')
  requiredId(input.actorId, 'COMMERCIAL_BILLING_SPEI_ACTOR_INVALID')

  const client = dependencies.client ?? prisma
  const evidence = await client.commercialManualSpeiEvidence.findFirst({
    where: {
      id: input.evidenceId,
      case: { organizationId: input.organizationId, venueId: input.venueId },
    },
    select: {
      id: true,
      caseId: true,
      storageObjectKey: true,
      mimeType: true,
      sizeBytes: true,
    },
  })
  if (!evidence) return null

  const signUrl = dependencies.signUrl ?? signPrivateFileUrl
  const url = await signUrl(evidence.storageObjectKey, EVIDENCE_SIGNED_URL_MINUTES)
  await client.activityLog.create({
    data: {
      organizationId: input.organizationId,
      venueId: input.venueId,
      actorType: 'HUMAN',
      staffId: input.actorId,
      actorStaffId: input.actorId,
      action: 'COMMERCIAL_MANUAL_SPEI_EVIDENCE_VIEWED',
      entity: 'CommercialManualSpeiEvidence',
      entityId: evidence.id,
      data: { schemaVersion: 1, caseId: evidence.caseId },
    },
  })

  return {
    url,
    expiresInMinutes: EVIDENCE_SIGNED_URL_MINUTES,
    mimeType: evidence.mimeType,
    sizeBytes: evidence.sizeBytes,
  }
}
