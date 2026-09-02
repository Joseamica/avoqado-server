import { Prisma, type PrismaClient } from '@prisma/client'

import { MAX_COMMERCIAL_MONEY_MINOR } from '@/contracts/commercial/commercialContractV2.constants'
import type {
  CreateCommercialManualSpeiCaseInput,
  CreateCommercialManualSpeiCaseResult,
  ApproveCommercialManualSpeiCaseInput,
  ApproveCommercialManualSpeiCaseResult,
  CommercialManualSpeiApprovalInput,
  CommercialManualSpeiApprovalResult,
  CommercialManualSpeiEvidenceAction,
  CommercialManualSpeiEvidenceStatus,
  CommercialManualSpeiExceptionReason,
  RegisterCommercialManualSpeiEvidenceInput,
  ReviewCommercialManualSpeiEvidenceInput,
  SupersedeCommercialManualSpeiEvidenceInput,
} from '@/types/commercialBilling'
import prisma from '@/utils/prismaClient'
import { reconcileCommercialCashReceipt, type CommercialBillingTransactionHost } from './cashReceipt.service'

function assertMoney(value: bigint, code: string): void {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_COMMERCIAL_MONEY_MINOR) {
    throw new Error(code)
  }
}

function validActorIds(values: readonly string[], code: string): string[] {
  if (!Array.isArray(values)) throw new Error(code)
  return values.map(value => {
    if (typeof value !== 'string' || value.trim() === '') throw new Error(code)
    return value
  })
}

/**
 * Evaluates the published approval policy only. It does not create a receipt:
 * reconciliation must still re-read money and approvals under database locks.
 */
export function evaluateManualSpeiApprovalPolicy(input: CommercialManualSpeiApprovalInput): CommercialManualSpeiApprovalResult {
  if (typeof input.policy?.policyVersionId !== 'string' || input.policy.policyVersionId.trim() === '') {
    throw new Error('COMMERCIAL_BILLING_SPEI_POLICY_INVALID')
  }
  assertMoney(input.policy.dualApprovalThresholdMinor, 'COMMERCIAL_BILLING_SPEI_THRESHOLD_INVALID')
  if (input.policy.dualApprovalThresholdMinor === 0n) {
    throw new Error('COMMERCIAL_BILLING_SPEI_THRESHOLD_INVALID')
  }
  assertMoney(input.observedAmountMinor, 'COMMERCIAL_BILLING_SPEI_OBSERVED_AMOUNT_INVALID')
  if (typeof input.referencePresent !== 'boolean') throw new Error('COMMERCIAL_BILLING_SPEI_REFERENCE_INVALID')

  const attributedActors = new Set(validActorIds(input.attributedCommercialActorIds, 'COMMERCIAL_BILLING_SPEI_ATTRIBUTION_INVALID'))
  const validApprovers = new Set(
    validActorIds(input.approvingActorIds, 'COMMERCIAL_BILLING_SPEI_APPROVER_INVALID').filter(actorId => !attributedActors.has(actorId)),
  )

  const exceptionReasons: CommercialManualSpeiExceptionReason[] = []
  if (input.observedAmountMinor >= input.policy.dualApprovalThresholdMinor) {
    exceptionReasons.push('DUAL_APPROVAL_THRESHOLD')
  }
  if (!input.referencePresent) exceptionReasons.push('MISSING_REFERENCE')

  const requiredApprovals: 1 | 2 = exceptionReasons.length === 0 ? 1 : 2
  return {
    policyVersionId: input.policy.policyVersionId,
    requiredApprovals,
    validApprovals: validApprovers.size,
    exceptionReasons,
    readyToReconcile: validApprovers.size >= requiredApprovals,
  }
}

const EVIDENCE_TRANSITIONS: Readonly<
  Partial<
    Record<CommercialManualSpeiEvidenceStatus, Partial<Record<CommercialManualSpeiEvidenceAction, CommercialManualSpeiEvidenceStatus>>>
  >
> = Object.freeze({
  NOT_SUBMITTED: Object.freeze({ SUBMIT: 'PENDING_REVIEW' }),
  PENDING_REVIEW: Object.freeze({ ACCEPT: 'ACCEPTED', REJECT: 'REJECTED' }),
  ACCEPTED: Object.freeze({ SUPERSEDE: 'SUPERSEDED' }),
  REJECTED: Object.freeze({ SUPERSEDE: 'SUPERSEDED' }),
})

export function transitionManualSpeiEvidence(input: {
  currentStatus: CommercialManualSpeiEvidenceStatus
  action: CommercialManualSpeiEvidenceAction
}): { status: CommercialManualSpeiEvidenceStatus; createsCashReceipt: false } {
  const status = EVIDENCE_TRANSITIONS[input.currentStatus]?.[input.action]
  if (!status) throw new Error('COMMERCIAL_BILLING_SPEI_EVIDENCE_TRANSITION_INVALID')
  return { status, createsCashReceipt: false }
}

interface LockedManualSpeiAttemptRow {
  id: string
  receivableId: string
  provider: string
  status: string
  amountMinor: bigint
  currency: string
  organizationId: string
  venueId: string
}

function validDate(value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('COMMERCIAL_BILLING_SPEI_OBSERVED_AT_INVALID')
  }
}

function requiredId(value: string, code: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(code)
  return value
}

function assertCreateCaseInput(input: CreateCommercialManualSpeiCaseInput): void {
  requiredId(input.organizationId, 'COMMERCIAL_BILLING_SPEI_ORGANIZATION_INVALID')
  requiredId(input.venueId, 'COMMERCIAL_BILLING_SPEI_VENUE_INVALID')
  requiredId(input.receivableId, 'COMMERCIAL_BILLING_SPEI_RECEIVABLE_INVALID')
  requiredId(input.paymentAttemptId, 'COMMERCIAL_BILLING_SPEI_PAYMENT_ATTEMPT_INVALID')
  requiredId(input.createdById, 'COMMERCIAL_BILLING_SPEI_CREATOR_INVALID')
  assertMoney(input.observedAmountMinor, 'COMMERCIAL_BILLING_SPEI_OBSERVED_AMOUNT_INVALID')
  if (input.observedAmountMinor === 0n) throw new Error('COMMERCIAL_BILLING_SPEI_OBSERVED_AMOUNT_INVALID')
  if (input.bankReference !== null && (input.bankReference.trim() === '' || input.bankReference.length > 128)) {
    throw new Error('COMMERCIAL_BILLING_SPEI_BANK_REFERENCE_INVALID')
  }
  if (!/^[0-9a-f]{64}$/u.test(input.receivingAccountFingerprint)) {
    throw new Error('COMMERCIAL_BILLING_RECEIVING_ACCOUNT_FINGERPRINT_INVALID')
  }
  validDate(input.observedAt)
  const actors = validActorIds(input.attributedCommercialActorIds, 'COMMERCIAL_BILLING_SPEI_ATTRIBUTION_INVALID')
  if (new Set(actors).size !== actors.length) throw new Error('COMMERCIAL_BILLING_SPEI_ATTRIBUTION_DUPLICATED')
}

export async function createCommercialManualSpeiCase(
  input: CreateCommercialManualSpeiCaseInput,
  dependencies: { host?: CommercialBillingTransactionHost } = {},
): Promise<CreateCommercialManualSpeiCaseResult> {
  assertCreateCaseInput(input)
  const host = dependencies.host ?? (prisma as PrismaClient)

  return host.$transaction(
    async tx => {
      const existing = await tx.commercialManualSpeiCase.findUnique({
        where: { paymentAttemptId: input.paymentAttemptId },
        select: {
          id: true,
          organizationId: true,
          venueId: true,
          receivableId: true,
          observedAmountMinor: true,
          bankReference: true,
          receivingAccountFingerprint: true,
          observedAt: true,
          attributedCommercialActorIds: true,
          createdById: true,
          policyVersionId: true,
          requiredApprovals: true,
          exceptionReasons: true,
          status: true,
        },
      })
      if (existing) {
        if (
          existing.organizationId !== input.organizationId ||
          existing.venueId !== input.venueId ||
          existing.receivableId !== input.receivableId ||
          existing.observedAmountMinor !== input.observedAmountMinor ||
          existing.bankReference !== input.bankReference ||
          existing.receivingAccountFingerprint !== input.receivingAccountFingerprint ||
          existing.observedAt.getTime() !== input.observedAt.getTime() ||
          JSON.stringify(existing.attributedCommercialActorIds) !== JSON.stringify(input.attributedCommercialActorIds) ||
          existing.createdById !== input.createdById ||
          existing.status !== 'PENDING_REVIEW'
        ) {
          throw new Error('COMMERCIAL_BILLING_SPEI_CASE_REPLAY_CONFLICT')
        }
        return {
          decision: 'REPLAY',
          caseId: existing.id,
          status: 'PENDING_REVIEW',
          policyVersionId: existing.policyVersionId,
          requiredApprovals: existing.requiredApprovals as 1 | 2,
          exceptionReasons: existing.exceptionReasons as CommercialManualSpeiExceptionReason[],
        }
      }

      const [attempt] = await tx.$queryRawUnsafe<LockedManualSpeiAttemptRow[]>(
        `SELECT attempt."id", attempt."receivableId", attempt."provider", attempt."status",
              attempt."amountMinor", attempt."currency", receivable."organizationId", receivable."venueId"
         FROM "CommercialBillingPaymentAttempt" AS attempt
         JOIN "CommercialAccountReceivable" AS receivable ON receivable."id" = attempt."receivableId"
        WHERE attempt."id" = $1
        FOR UPDATE OF attempt, receivable`,
        input.paymentAttemptId,
      )
      if (!attempt) throw new Error('COMMERCIAL_BILLING_SPEI_PAYMENT_ATTEMPT_NOT_FOUND')
      if (
        attempt.provider !== 'MANUAL_SPEI' ||
        !['PENDING', 'OUTCOME_UNKNOWN'].includes(attempt.status) ||
        attempt.receivableId !== input.receivableId ||
        attempt.organizationId !== input.organizationId ||
        attempt.venueId !== input.venueId ||
        attempt.amountMinor !== input.observedAmountMinor ||
        attempt.currency !== 'MXN'
      ) {
        throw new Error('COMMERCIAL_BILLING_SPEI_PAYMENT_ATTEMPT_MISMATCH')
      }

      const activation = await tx.commercialManualSpeiPolicyActivation.findUnique({
        where: { market: 'MX' },
        include: {
          policyVersion: {
            select: { id: true, dualApprovalThresholdMinor: true, currency: true },
          },
        },
      })
      if (!activation || activation.policyVersion.currency !== 'MXN') {
        throw new Error('COMMERCIAL_BILLING_SPEI_POLICY_NOT_ACTIVE')
      }
      const policy = evaluateManualSpeiApprovalPolicy({
        policy: {
          policyVersionId: activation.policyVersion.id,
          dualApprovalThresholdMinor: activation.policyVersion.dualApprovalThresholdMinor,
        },
        observedAmountMinor: input.observedAmountMinor,
        referencePresent: input.bankReference !== null,
        approvingActorIds: [],
        attributedCommercialActorIds: input.attributedCommercialActorIds,
      })
      const created = await tx.commercialManualSpeiCase.create({
        data: {
          organizationId: input.organizationId,
          venueId: input.venueId,
          receivableId: input.receivableId,
          paymentAttemptId: input.paymentAttemptId,
          policyVersionId: activation.policyVersion.id,
          observedAmountMinor: input.observedAmountMinor,
          currency: 'MXN',
          bankReference: input.bankReference,
          receivingAccountFingerprint: input.receivingAccountFingerprint,
          observedAt: input.observedAt,
          attributedCommercialActorIds: input.attributedCommercialActorIds as Prisma.InputJsonValue,
          createdById: input.createdById,
          requiredApprovals: policy.requiredApprovals,
          exceptionReasons: policy.exceptionReasons as Prisma.InputJsonValue,
          status: 'PENDING_REVIEW',
        },
        select: { id: true, status: true },
      })
      await tx.activityLog.create({
        data: {
          organizationId: input.organizationId,
          venueId: input.venueId,
          actorType: 'HUMAN',
          staffId: input.createdById,
          actorStaffId: input.createdById,
          action: 'COMMERCIAL_MANUAL_SPEI_CASE_CREATED',
          entity: 'CommercialManualSpeiCase',
          entityId: created.id,
          data: {
            schemaVersion: 1,
            paymentAttemptId: input.paymentAttemptId,
            policyVersionId: activation.policyVersion.id,
            requiredApprovals: policy.requiredApprovals,
            exceptionReasons: policy.exceptionReasons,
          },
        },
      })

      return {
        decision: 'CREATED',
        caseId: created.id,
        status: 'PENDING_REVIEW',
        policyVersionId: activation.policyVersion.id,
        requiredApprovals: policy.requiredApprovals,
        exceptionReasons: policy.exceptionReasons,
      }
    },
    {
      maxWait: 5_000,
      timeout: 30_000,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    },
  )
}

interface LockedManualSpeiCaseEvidenceRow {
  id: string
  organizationId: string
  venueId: string
  status: string
}

interface LockedManualSpeiEvidenceReviewRow {
  evidenceId: string
  caseId: string
  organizationId: string
  venueId: string
  caseStatus: string
}

interface LockedManualSpeiEvidenceSupersedeRow extends LockedManualSpeiEvidenceReviewRow {
  isLatest: boolean
  hasReject: boolean
  hasSupersede: boolean
}

interface LockedManualSpeiApprovalCaseRow {
  id: string
  organizationId: string
  venueId: string
  receivableId: string
  paymentAttemptId: string
  policyVersionId: string
  dualApprovalThresholdMinor: bigint
  observedAmountMinor: bigint
  bankReference: string | null
  receivingAccountFingerprint: string
  observedAt: Date
  attributedCommercialActorIds: string[]
  createdById: string
  requiredApprovals: number
  exceptionReasons: CommercialManualSpeiExceptionReason[]
  status: string
  reconciledReceiptId: string | null
}

export async function registerCommercialManualSpeiEvidence(
  input: RegisterCommercialManualSpeiEvidenceInput,
  dependencies: { host?: CommercialBillingTransactionHost } = {},
): Promise<{ evidenceId: string; sequence: number; status: 'PENDING_REVIEW' }> {
  requiredId(input.caseId, 'COMMERCIAL_BILLING_SPEI_CASE_ID_INVALID')
  requiredId(input.organizationId, 'COMMERCIAL_BILLING_SPEI_ORGANIZATION_INVALID')
  requiredId(input.venueId, 'COMMERCIAL_BILLING_SPEI_VENUE_INVALID')
  requiredId(input.uploadedById, 'COMMERCIAL_BILLING_SPEI_UPLOADER_INVALID')
  if (!/^private\/[A-Za-z0-9._/-]{1,503}$/u.test(input.storageObjectKey) || input.storageObjectKey.split('/').includes('..')) {
    throw new Error('COMMERCIAL_BILLING_SPEI_STORAGE_KEY_INVALID')
  }
  const requiredStoragePrefix = `private/commercial-spei/${input.organizationId}/${input.caseId}/`
  if (!input.storageObjectKey.startsWith(requiredStoragePrefix) || input.storageObjectKey.length === requiredStoragePrefix.length) {
    throw new Error('COMMERCIAL_BILLING_SPEI_STORAGE_KEY_TENANT_MISMATCH')
  }
  if (!/^[0-9a-f]{64}$/u.test(input.contentSha256)) {
    throw new Error('COMMERCIAL_BILLING_SPEI_CONTENT_HASH_INVALID')
  }
  if (!['application/pdf', 'image/jpeg', 'image/png'].includes(input.mimeType)) {
    throw new Error('COMMERCIAL_BILLING_SPEI_MIME_INVALID')
  }
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > 10 * 1024 * 1024) {
    throw new Error('COMMERCIAL_BILLING_SPEI_SIZE_INVALID')
  }
  const host = dependencies.host ?? (prisma as PrismaClient)

  return host.$transaction(
    async tx => {
      const [speiCase] = await tx.$queryRawUnsafe<LockedManualSpeiCaseEvidenceRow[]>(
        `SELECT "id", "organizationId", "venueId", "status"::text
         FROM "CommercialManualSpeiCase"
        WHERE "id" = $1
        FOR UPDATE`,
        input.caseId,
      )
      if (!speiCase) throw new Error('COMMERCIAL_BILLING_SPEI_CASE_NOT_FOUND')
      if (speiCase.organizationId !== input.organizationId || speiCase.venueId !== input.venueId) {
        throw new Error('COMMERCIAL_BILLING_SPEI_CASE_TENANT_MISMATCH')
      }
      if (speiCase.status !== 'PENDING_REVIEW') throw new Error('COMMERCIAL_BILLING_SPEI_CASE_NOT_UPLOADABLE')

      const latest = await tx.commercialManualSpeiEvidence.findFirst({
        where: { caseId: input.caseId },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      })
      const sequence = (latest?.sequence ?? 0) + 1
      const evidence = await tx.commercialManualSpeiEvidence.create({
        data: {
          caseId: input.caseId,
          sequence,
          storageObjectKey: input.storageObjectKey,
          contentSha256: input.contentSha256,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          uploadedById: input.uploadedById,
        },
        select: { id: true, sequence: true },
      })
      await tx.activityLog.create({
        data: {
          organizationId: input.organizationId,
          venueId: input.venueId,
          actorType: 'HUMAN',
          staffId: input.uploadedById,
          actorStaffId: input.uploadedById,
          action: 'COMMERCIAL_MANUAL_SPEI_EVIDENCE_REGISTERED',
          entity: 'CommercialManualSpeiEvidence',
          entityId: evidence.id,
          data: { schemaVersion: 1, caseId: input.caseId, sequence },
        },
      })
      return { evidenceId: evidence.id, sequence: evidence.sequence, status: 'PENDING_REVIEW' }
    },
    {
      maxWait: 5_000,
      timeout: 30_000,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    },
  )
}

export async function reviewCommercialManualSpeiEvidence(
  input: ReviewCommercialManualSpeiEvidenceInput,
  dependencies: { host?: CommercialBillingTransactionHost } = {},
): Promise<{ evidenceId: string; caseId: string; status: 'AWAITING_APPROVAL' | 'REJECTED' }> {
  requiredId(input.evidenceId, 'COMMERCIAL_BILLING_SPEI_EVIDENCE_ID_INVALID')
  requiredId(input.organizationId, 'COMMERCIAL_BILLING_SPEI_ORGANIZATION_INVALID')
  requiredId(input.venueId, 'COMMERCIAL_BILLING_SPEI_VENUE_INVALID')
  requiredId(input.actorId, 'COMMERCIAL_BILLING_SPEI_REVIEWER_INVALID')
  if (!['ACCEPT', 'REJECT'].includes(input.action)) throw new Error('COMMERCIAL_BILLING_SPEI_REVIEW_ACTION_INVALID')
  if (input.action === 'REJECT' && (!input.reason || input.reason.trim() === '')) {
    throw new Error('COMMERCIAL_BILLING_SPEI_REVIEW_REASON_REQUIRED')
  }
  if (input.reason !== null && input.reason.length > 500) throw new Error('COMMERCIAL_BILLING_SPEI_REVIEW_REASON_INVALID')
  const host = dependencies.host ?? (prisma as PrismaClient)

  return host.$transaction(
    async tx => {
      const [evidence] = await tx.$queryRawUnsafe<LockedManualSpeiEvidenceReviewRow[]>(
        `SELECT evidence."id" AS "evidenceId", spei_case."id" AS "caseId",
              spei_case."organizationId", spei_case."venueId", spei_case."status"::text AS "caseStatus"
         FROM "CommercialManualSpeiEvidence" AS evidence
         JOIN "CommercialManualSpeiCase" AS spei_case ON spei_case."id" = evidence."caseId"
        WHERE evidence."id" = $1
        FOR UPDATE OF evidence, spei_case`,
        input.evidenceId,
      )
      if (!evidence) throw new Error('COMMERCIAL_BILLING_SPEI_EVIDENCE_NOT_FOUND')
      if (evidence.organizationId !== input.organizationId || evidence.venueId !== input.venueId) {
        throw new Error('COMMERCIAL_BILLING_SPEI_CASE_TENANT_MISMATCH')
      }
      if (evidence.caseStatus !== 'PENDING_REVIEW') throw new Error('COMMERCIAL_BILLING_SPEI_EVIDENCE_NOT_REVIEWABLE')

      await tx.commercialManualSpeiEvidenceReview.create({
        data: {
          evidenceId: input.evidenceId,
          action: input.action,
          actorId: input.actorId,
          reason: input.reason,
        },
      })
      const status = input.action === 'ACCEPT' ? 'AWAITING_APPROVAL' : 'REJECTED'
      await tx.commercialManualSpeiCase.update({
        where: { id: evidence.caseId },
        data: { status },
      })
      await tx.activityLog.create({
        data: {
          organizationId: input.organizationId,
          venueId: input.venueId,
          actorType: 'HUMAN',
          staffId: input.actorId,
          actorStaffId: input.actorId,
          action: `COMMERCIAL_MANUAL_SPEI_EVIDENCE_${input.action}ED`,
          entity: 'CommercialManualSpeiEvidence',
          entityId: input.evidenceId,
          data: { schemaVersion: 1, caseId: evidence.caseId, reason: input.reason },
        },
      })
      return { evidenceId: input.evidenceId, caseId: evidence.caseId, status }
    },
    {
      maxWait: 5_000,
      timeout: 30_000,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    },
  )
}

export async function supersedeCommercialManualSpeiEvidence(
  input: SupersedeCommercialManualSpeiEvidenceInput,
  dependencies: { host?: CommercialBillingTransactionHost } = {},
): Promise<{ evidenceId: string; caseId: string; status: 'PENDING_REVIEW' }> {
  requiredId(input.evidenceId, 'COMMERCIAL_BILLING_SPEI_EVIDENCE_ID_INVALID')
  requiredId(input.organizationId, 'COMMERCIAL_BILLING_SPEI_ORGANIZATION_INVALID')
  requiredId(input.venueId, 'COMMERCIAL_BILLING_SPEI_VENUE_INVALID')
  requiredId(input.actorId, 'COMMERCIAL_BILLING_SPEI_REVIEWER_INVALID')
  if (typeof input.reason !== 'string' || input.reason.trim() === '' || input.reason.length > 500) {
    throw new Error('COMMERCIAL_BILLING_SPEI_SUPERSEDE_REASON_INVALID')
  }
  const host = dependencies.host ?? (prisma as PrismaClient)

  return host.$transaction(
    async tx => {
      const [evidence] = await tx.$queryRawUnsafe<LockedManualSpeiEvidenceSupersedeRow[]>(
        `SELECT evidence."id" AS "evidenceId", spei_case."id" AS "caseId",
              spei_case."organizationId", spei_case."venueId", spei_case."status"::text AS "caseStatus",
              NOT EXISTS (
                SELECT 1 FROM "CommercialManualSpeiEvidence" AS later
                 WHERE later."caseId" = evidence."caseId" AND later."sequence" > evidence."sequence"
              ) AS "isLatest",
              EXISTS (
                SELECT 1 FROM "CommercialManualSpeiEvidenceReview" AS review
                 WHERE review."evidenceId" = evidence."id" AND review."action" = 'REJECT'
              ) AS "hasReject",
              EXISTS (
                SELECT 1 FROM "CommercialManualSpeiEvidenceReview" AS review
                 WHERE review."evidenceId" = evidence."id" AND review."action" = 'SUPERSEDE'
              ) AS "hasSupersede"
         FROM "CommercialManualSpeiEvidence" AS evidence
         JOIN "CommercialManualSpeiCase" AS spei_case ON spei_case."id" = evidence."caseId"
        WHERE evidence."id" = $1
        FOR UPDATE OF evidence, spei_case`,
        input.evidenceId,
      )
      if (!evidence) throw new Error('COMMERCIAL_BILLING_SPEI_EVIDENCE_NOT_FOUND')
      if (evidence.organizationId !== input.organizationId || evidence.venueId !== input.venueId) {
        throw new Error('COMMERCIAL_BILLING_SPEI_CASE_TENANT_MISMATCH')
      }
      if (evidence.caseStatus !== 'REJECTED' || !evidence.isLatest || !evidence.hasReject || evidence.hasSupersede) {
        throw new Error('COMMERCIAL_BILLING_SPEI_EVIDENCE_NOT_SUPERSEDEABLE')
      }

      await tx.commercialManualSpeiEvidenceReview.create({
        data: {
          evidenceId: input.evidenceId,
          action: 'SUPERSEDE',
          actorId: input.actorId,
          reason: input.reason,
        },
      })
      await tx.commercialManualSpeiCase.update({
        where: { id: evidence.caseId },
        data: { status: 'PENDING_REVIEW' },
      })
      await tx.activityLog.create({
        data: {
          organizationId: input.organizationId,
          venueId: input.venueId,
          actorType: 'HUMAN',
          staffId: input.actorId,
          actorStaffId: input.actorId,
          action: 'COMMERCIAL_MANUAL_SPEI_EVIDENCE_SUPERSEDED',
          entity: 'CommercialManualSpeiEvidence',
          entityId: input.evidenceId,
          data: { schemaVersion: 1, caseId: evidence.caseId, reason: input.reason },
        },
      })
      return { evidenceId: input.evidenceId, caseId: evidence.caseId, status: 'PENDING_REVIEW' }
    },
    {
      maxWait: 5_000,
      timeout: 30_000,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    },
  )
}

type ManualSpeiCashReconciler = typeof reconcileCommercialCashReceipt

export async function approveCommercialManualSpeiCase(
  input: ApproveCommercialManualSpeiCaseInput,
  dependencies: { host?: CommercialBillingTransactionHost; reconcileCash?: ManualSpeiCashReconciler } = {},
): Promise<ApproveCommercialManualSpeiCaseResult> {
  requiredId(input.caseId, 'COMMERCIAL_BILLING_SPEI_CASE_ID_INVALID')
  requiredId(input.organizationId, 'COMMERCIAL_BILLING_SPEI_ORGANIZATION_INVALID')
  requiredId(input.venueId, 'COMMERCIAL_BILLING_SPEI_VENUE_INVALID')
  requiredId(input.actorId, 'COMMERCIAL_BILLING_SPEI_APPROVER_INVALID')
  validDate(input.now)
  const host = dependencies.host ?? (prisma as PrismaClient)
  const reconcileCash = dependencies.reconcileCash ?? reconcileCommercialCashReceipt

  return host.$transaction(
    async tx => {
      const [speiCase] = await tx.$queryRawUnsafe<LockedManualSpeiApprovalCaseRow[]>(
        `SELECT spei_case."id", spei_case."organizationId", spei_case."venueId",
              spei_case."receivableId", spei_case."paymentAttemptId", spei_case."policyVersionId",
              policy."dualApprovalThresholdMinor", spei_case."observedAmountMinor",
              spei_case."bankReference",
              spei_case."receivingAccountFingerprint", spei_case."observedAt",
              spei_case."attributedCommercialActorIds", spei_case."createdById", spei_case."requiredApprovals",
              spei_case."exceptionReasons", spei_case."status"::text,
              spei_case."reconciledReceiptId"
         FROM "CommercialManualSpeiCase" AS spei_case
         JOIN "CommercialManualSpeiPolicyVersion" AS policy ON policy."id" = spei_case."policyVersionId"
         JOIN "CommercialBillingPaymentAttempt" AS attempt ON attempt."id" = spei_case."paymentAttemptId"
        WHERE spei_case."id" = $1
        FOR UPDATE OF spei_case, attempt`,
        input.caseId,
      )
      if (!speiCase) throw new Error('COMMERCIAL_BILLING_SPEI_CASE_NOT_FOUND')
      if (speiCase.organizationId !== input.organizationId || speiCase.venueId !== input.venueId) {
        throw new Error('COMMERCIAL_BILLING_SPEI_CASE_TENANT_MISMATCH')
      }
      if (speiCase.status === 'RECONCILED' && speiCase.reconciledReceiptId) {
        const approvals = await tx.commercialManualSpeiApproval.findMany({
          where: { caseId: input.caseId },
          select: { actorId: true },
        })
        return {
          decision: 'REPLAY',
          caseId: input.caseId,
          validApprovals: approvals.length,
          requiredApprovals: speiCase.requiredApprovals as 1 | 2,
          receiptId: speiCase.reconciledReceiptId,
          eventId: null,
        }
      }
      if (!['AWAITING_APPROVAL', 'READY_TO_RECONCILE'].includes(speiCase.status)) {
        throw new Error('COMMERCIAL_BILLING_SPEI_CASE_NOT_APPROVABLE')
      }
      const acceptedEvidence = await tx.commercialManualSpeiEvidenceReview.findMany({
        where: {
          action: 'ACCEPT',
          evidence: { caseId: input.caseId, reviews: { none: { action: 'SUPERSEDE' } } },
        },
        select: { actorId: true },
      })
      if (acceptedEvidence.length === 0) throw new Error('COMMERCIAL_BILLING_SPEI_ACCEPTED_EVIDENCE_REQUIRED')
      const disqualifiedActorIds = new Set([
        ...speiCase.attributedCommercialActorIds,
        speiCase.createdById,
        ...acceptedEvidence.map(review => review.actorId),
      ])
      if (disqualifiedActorIds.has(input.actorId)) {
        throw new Error('COMMERCIAL_BILLING_SPEI_APPROVER_NOT_INDEPENDENT')
      }

      const pinnedPolicy = evaluateManualSpeiApprovalPolicy({
        policy: {
          policyVersionId: speiCase.policyVersionId,
          dualApprovalThresholdMinor: speiCase.dualApprovalThresholdMinor,
        },
        observedAmountMinor: speiCase.observedAmountMinor,
        referencePresent: speiCase.bankReference !== null,
        approvingActorIds: [],
        attributedCommercialActorIds: [...disqualifiedActorIds],
      })
      if (
        pinnedPolicy.requiredApprovals !== speiCase.requiredApprovals ||
        JSON.stringify(pinnedPolicy.exceptionReasons) !== JSON.stringify(speiCase.exceptionReasons)
      ) {
        throw new Error('COMMERCIAL_BILLING_SPEI_POLICY_SNAPSHOT_MISMATCH')
      }

      const existingApproval = await tx.commercialManualSpeiApproval.findUnique({
        where: { caseId_actorId: { caseId: input.caseId, actorId: input.actorId } },
        select: { id: true },
      })
      if (!existingApproval) {
        await tx.commercialManualSpeiApproval.create({
          data: {
            caseId: input.caseId,
            actorId: input.actorId,
            policyVersionId: speiCase.policyVersionId,
            exceptionReasons: pinnedPolicy.exceptionReasons as Prisma.InputJsonValue,
          },
        })
      }
      const approvals = await tx.commercialManualSpeiApproval.findMany({
        where: { caseId: input.caseId },
        select: { actorId: true },
      })
      const policy = evaluateManualSpeiApprovalPolicy({
        policy: {
          policyVersionId: speiCase.policyVersionId,
          dualApprovalThresholdMinor: speiCase.dualApprovalThresholdMinor,
        },
        observedAmountMinor: speiCase.observedAmountMinor,
        referencePresent: speiCase.bankReference !== null,
        approvingActorIds: approvals.map(approval => approval.actorId),
        attributedCommercialActorIds: [...disqualifiedActorIds],
      })

      if (!policy.readyToReconcile) {
        await tx.activityLog.create({
          data: {
            organizationId: input.organizationId,
            venueId: input.venueId,
            actorType: 'HUMAN',
            staffId: input.actorId,
            actorStaffId: input.actorId,
            action: 'COMMERCIAL_MANUAL_SPEI_APPROVAL_RECORDED',
            entity: 'CommercialManualSpeiCase',
            entityId: input.caseId,
            data: {
              schemaVersion: 1,
              policyVersionId: speiCase.policyVersionId,
              validApprovals: policy.validApprovals,
              requiredApprovals: policy.requiredApprovals,
            },
          },
        })
        return {
          decision: 'PENDING_SECOND_APPROVAL',
          caseId: input.caseId,
          validApprovals: policy.validApprovals,
          requiredApprovals: policy.requiredApprovals,
          receiptId: null,
          eventId: null,
        }
      }

      await tx.commercialManualSpeiCase.update({
        where: { id: input.caseId },
        data: { status: 'READY_TO_RECONCILE' },
      })
      const nestedHost: CommercialBillingTransactionHost = {
        $transaction: async operation => operation(tx),
      }
      const reconciled = await reconcileCash(
        {
          organizationId: input.organizationId,
          venueId: input.venueId,
          receivableId: speiCase.receivableId,
          paymentAttemptId: speiCase.paymentAttemptId,
          paymentAttemptProviderId: `manual-spei:${input.caseId}`,
          idempotencyKey: `manual-spei:case:${input.caseId}`,
          observation: {
            provider: 'MANUAL_SPEI',
            providerEventId: `manual-spei:${input.caseId}`,
            amountMinor: speiCase.observedAmountMinor,
            currency: 'MXN',
            receivingAccountFingerprint: speiCase.receivingAccountFingerprint,
            observedAt: speiCase.observedAt,
          },
          reconciledById: input.actorId,
          now: input.now,
        },
        { host: nestedHost },
      )
      await tx.commercialManualSpeiCase.update({
        where: { id: input.caseId },
        data: { status: 'RECONCILED', reconciledReceiptId: reconciled.receiptId },
      })
      await tx.activityLog.create({
        data: {
          organizationId: input.organizationId,
          venueId: input.venueId,
          actorType: 'HUMAN',
          staffId: input.actorId,
          actorStaffId: input.actorId,
          action: 'COMMERCIAL_MANUAL_SPEI_RECONCILED',
          entity: 'CommercialManualSpeiCase',
          entityId: input.caseId,
          data: {
            schemaVersion: 1,
            receiptId: reconciled.receiptId,
            eventId: reconciled.eventId,
            validApprovals: policy.validApprovals,
            requiredApprovals: policy.requiredApprovals,
          },
        },
      })
      return {
        decision: 'RECONCILED',
        caseId: input.caseId,
        validApprovals: policy.validApprovals,
        requiredApprovals: policy.requiredApprovals,
        receiptId: reconciled.receiptId,
        eventId: reconciled.eventId,
      }
    },
    {
      maxWait: 5_000,
      timeout: 30_000,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    },
  )
}
