export interface CommercialBillingAllocationTarget {
  receivableId: string
  amountMinor: bigint
  allocatedMinor: bigint
}

export interface CommercialBillingAllocationPlanInput {
  receiptAmountMinor: bigint
  receiptAllocatedMinor: bigint
  targets: readonly CommercialBillingAllocationTarget[]
}

export interface PlannedCommercialBillingAllocation {
  receivableId: string
  amountMinor: bigint
  receivableOutstandingMinor: bigint
  becomesCovered: boolean
}

export interface CommercialBillingAllocationPlan {
  allocations: PlannedCommercialBillingAllocation[]
  newlyAllocatedMinor: bigint
  receiptUnallocatedMinor: bigint
}

export type CommercialSubscriptionPeriodStatus = 'OPEN' | 'PAST_DUE' | 'EXPIRED' | 'PAID'

export type CommercialSubscriptionPeriodTransition = 'NONE' | 'PAYMENT_RECONCILED' | 'PAYMENT_COVERAGE_REVERSED'

export interface CommercialSubscriptionPeriodCoverageInput {
  previousStatus: CommercialSubscriptionPeriodStatus
  amountDueMinor: bigint
  activeAllocatedMinor: bigint
  dueAt: Date
  graceEndsAt: Date
  now: Date
}

export interface CommercialSubscriptionPeriodCoverage {
  status: CommercialSubscriptionPeriodStatus
  outstandingMinor: bigint
  transition: CommercialSubscriptionPeriodTransition
}

export interface CommercialManualSpeiPolicy {
  policyVersionId: string
  dualApprovalThresholdMinor: bigint
}

export type CommercialManualSpeiExceptionReason = 'DUAL_APPROVAL_THRESHOLD' | 'MISSING_REFERENCE'

export interface CommercialManualSpeiApprovalInput {
  policy: CommercialManualSpeiPolicy
  observedAmountMinor: bigint
  referencePresent: boolean
  approvingActorIds: readonly string[]
  attributedCommercialActorIds: readonly string[]
}

export interface CommercialManualSpeiApprovalResult {
  policyVersionId: string
  requiredApprovals: 1 | 2
  validApprovals: number
  exceptionReasons: CommercialManualSpeiExceptionReason[]
  readyToReconcile: boolean
}

export type CommercialBillingCadence = 'MONTHLY' | 'ANNUAL' | 'MIXED'

export interface CommercialSubscriptionPeriodDraftInput {
  cadence: CommercialBillingCadence
  startsAt: Date
  timezone: string
  firstPeriodAmountMinor: bigint
  renewalAmountMinor: bigint
  periodCount: number
  graceDays: number
}

export interface CommercialSubscriptionPeriodDraft {
  sequence: number
  startsAt: Date
  endsAt: Date
  dueAt: Date
  graceEndsAt: Date
  amountDueMinor: bigint
}

export type CommercialManualSpeiEvidenceStatus = 'NOT_SUBMITTED' | 'PENDING_REVIEW' | 'ACCEPTED' | 'REJECTED' | 'SUPERSEDED'

export type CommercialManualSpeiEvidenceAction = 'SUBMIT' | 'ACCEPT' | 'REJECT' | 'SUPERSEDE'

export interface CommercialCashReceiptObservation {
  provider: 'STRIPE' | 'MANUAL_SPEI' | 'AUTOMATIC_SPEI'
  providerEventId: string
  amountMinor: bigint
  currency: 'MXN'
  receivingAccountFingerprint: string
  observedAt: Date
}

export interface ExistingCommercialCashReceipt extends CommercialCashReceiptObservation {
  id: string
}

export interface ReconcileCommercialCashReceiptInput {
  organizationId: string
  venueId: string
  receivableId: string
  paymentAttemptId?: string
  paymentAttemptProviderId?: string
  idempotencyKey: string
  observation: CommercialCashReceiptObservation
  providerObjectReferences?: readonly CommercialBillingProviderObjectReference[]
  reconciledById?: string
  now: Date
}

export interface CommercialBillingProviderObjectReference {
  objectType: 'INVOICE' | 'PAYMENT_INTENT' | 'CHARGE'
  objectId: string
}

export interface ReconciledCommercialCashReceiptResult {
  decision: 'RECONCILED' | 'REPLAY'
  receiptId: string
  allocatedMinor: bigint
  receivableStatus: 'OPEN' | 'PARTIALLY_PAID' | 'PAID' | 'PAST_DUE' | 'EXPIRED' | 'CANCELED'
  periodStatus: CommercialSubscriptionPeriodStatus
  eventId: string | null
}

export type CommercialBillingScheduleKeyV1 = 'SAAS_MONTHLY' | 'SAAS_ANNUAL'

export interface CommercialBillingScheduleV1 {
  scheduleKey: CommercialBillingScheduleKeyV1
  cadence: 'MONTHLY' | 'ANNUAL'
  firstPeriodAmountMinor: string
  renewalAmountMinor: string
}

export interface CommercialBillingEntitlementRequirementV1 {
  featureCode: string
  requiredScheduleKeys: CommercialBillingScheduleKeyV1[]
}

export interface CommercialSubscriptionContractSnapshotV1 {
  schemaVersion: 1
  contractVersion: '1.0.0'
  acceptanceId: string
  quoteId: string
  quoteChecksum: string
  organizationId: string
  venueId: string
  currency: 'MXN'
  timezone: string
  startsAt: string
  cadence: CommercialBillingCadence
  schedules: CommercialBillingScheduleV1[]
  entitlements: CommercialBillingEntitlementRequirementV1[]
}

export interface CreateCommercialSubscriptionContractInput {
  snapshot: CommercialSubscriptionContractSnapshotV1
  idempotencyKey: string
  graceDays: number
}

export interface CommercialSubscriptionContractPeriodResult {
  periodId: string
  receivableId: string
  scheduleKey: CommercialBillingScheduleKeyV1
  amountDueMinor: bigint
}

export interface CreateCommercialSubscriptionContractResult {
  decision: 'CREATED' | 'REPLAY'
  contractId: string
  contractChecksum: string
  periods: CommercialSubscriptionContractPeriodResult[]
}

export interface CommercialSubscriptionEntitlementPeriod {
  id: string
  scheduleKey: CommercialBillingScheduleKeyV1
  sequence: number
  startsAt: Date
  endsAt: Date
  status: CommercialSubscriptionPeriodStatus
}

export interface CommercialEntitlementProjectionGrant {
  featureCode: string
  coverageStartsAt: Date
  coverageEndsAt: Date
  requiredScheduleKeys: CommercialBillingScheduleKeyV1[]
  sourcePeriodIds: string[]
}

export interface CommercialEntitlementProjectionPlan {
  grants: CommercialEntitlementProjectionGrant[]
}

export interface ProjectCommercialPaidEntitlementsInput {
  eventId: string
  now: Date
}

export interface ProjectCommercialPaidEntitlementsResult {
  decision: 'PROJECTED' | 'REPLAY' | 'NO_CHANGE'
  eventId: string
  grants: Array<{
    featureCode: string
    coverageStartsAt: Date
    coverageEndsAt: Date
  }>
}

export interface ProjectCommercialReversedEntitlementsInput {
  eventId: string
  now: Date
}

export interface ProjectCommercialReversedEntitlementsResult {
  decision: 'PROJECTED' | 'REPLAY' | 'NO_CHANGE'
  eventId: string
  revocations: Array<{
    featureCode: string
    coverageStartsAt: Date
    coverageEndsAt: Date
  }>
}

export interface ReserveCommercialBillingPaymentAttemptInput {
  organizationId: string
  venueId: string
  receivableId: string
  provider: CommercialCashReceiptObservation['provider']
  idempotencyKey: string
  requestFingerprint: string
}

export interface ReserveCommercialBillingPaymentAttemptResult {
  decision: 'CREATED' | 'REPLAY'
  paymentAttemptId: string
  status: 'PENDING' | 'SUCCEEDED' | 'OUTCOME_UNKNOWN' | 'FAILED' | 'CANCELED'
  amountMinor: bigint
  currency: 'MXN'
}

export interface CreateCommercialManualSpeiCaseInput {
  organizationId: string
  venueId: string
  receivableId: string
  paymentAttemptId: string
  observedAmountMinor: bigint
  bankReference: string | null
  receivingAccountFingerprint: string
  observedAt: Date
  attributedCommercialActorIds: string[]
  createdById: string
}

export interface CreateCommercialManualSpeiCaseResult {
  decision: 'CREATED' | 'REPLAY'
  caseId: string
  status: 'PENDING_REVIEW'
  policyVersionId: string
  requiredApprovals: 1 | 2
  exceptionReasons: CommercialManualSpeiExceptionReason[]
}

export interface RegisterCommercialManualSpeiEvidenceInput {
  caseId: string
  organizationId: string
  venueId: string
  uploadedById: string
  storageObjectKey: string
  contentSha256: string
  mimeType: 'application/pdf' | 'image/jpeg' | 'image/png'
  sizeBytes: number
}

export interface ReviewCommercialManualSpeiEvidenceInput {
  evidenceId: string
  organizationId: string
  venueId: string
  actorId: string
  action: 'ACCEPT' | 'REJECT'
  reason: string | null
}

export interface SupersedeCommercialManualSpeiEvidenceInput {
  evidenceId: string
  organizationId: string
  venueId: string
  actorId: string
  reason: string
}

export interface ApproveCommercialManualSpeiCaseInput {
  caseId: string
  organizationId: string
  venueId: string
  actorId: string
  now: Date
}

export interface ApproveCommercialManualSpeiCaseResult {
  decision: 'PENDING_SECOND_APPROVAL' | 'RECONCILED' | 'REPLAY'
  caseId: string
  validApprovals: number
  requiredApprovals: 1 | 2
  receiptId: string | null
  eventId: string | null
}

export interface CommercialCashAdjustmentObservation {
  provider: CommercialCashReceiptObservation['provider']
  providerEventId: string
  entryType: 'REFUND' | 'REVERSAL'
  amountMinor: bigint
  currency: 'MXN'
  receivingAccountFingerprint: string
  observedAt: Date
}

export interface ReconcileCommercialCashAdjustmentInput {
  organizationId: string
  venueId: string
  originalReceiptId: string
  idempotencyKey: string
  observation: CommercialCashAdjustmentObservation
  reconciledById?: string
  now: Date
}

export interface ReconcileCommercialCashAdjustmentResult {
  decision: 'ADJUSTED' | 'REPLAY'
  adjustmentReceiptId: string
  debitMinor: bigint
  receivableStatus: 'OPEN' | 'PARTIALLY_PAID' | 'PAID' | 'PAST_DUE' | 'EXPIRED' | 'CANCELED'
  periodStatus: CommercialSubscriptionPeriodStatus
  eventId: string | null
}
