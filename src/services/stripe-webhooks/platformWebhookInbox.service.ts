import { Prisma, type PrismaClient } from '@prisma/client'
import cuid from 'cuid'
import { randomUUID } from 'node:crypto'
import { utcTs, utcTsOrNull } from '@/utils/sqlDates'

export type WebhookClaimPhase = 'CLASSIFICATION' | 'EFFECT'

export const PLATFORM_WEBHOOK_LIMITS = Object.freeze({
  maxAttempts: 5,
  batchSize: 25,
  classificationLeaseMs: 2 * 60_000,
  effectLeaseMs: 15 * 60_000,
  effectHeartbeatMs: 5 * 60_000,
  operationalAlertLeaseMs: 2 * 60_000,
})
export type StripeEventOwnerKind = 'COMMERCIAL_V2' | 'LEGACY' | 'INDEPENDENT'
export type StripeEventRouteKey =
  | 'COMMERCIAL_SUBSCRIPTION_LIFECYCLE'
  | 'LEGACY_PLAN_CHECKOUT'
  | 'LEGACY_SUBSCRIPTION_LIFECYCLE'
  | 'TERMINAL_ORDER_CHECKOUT'
  | 'TOKEN_PAYMENT_INTENT'
  | 'TOKEN_INVOICE'
  | 'CREDIT_PACK_CHECKOUT'
  | 'VENUE_BILLING_PROFILE'
export type StripeEventSubjectKind =
  | 'COMMERCIAL_ACCEPTANCE'
  | 'STRIPE_CHECKOUT_ORIGIN'
  | 'VENUE_FEATURE'
  | 'TERMINAL_ORDER'
  | 'TOKEN_PURCHASE'
  | 'VENUE'
export type StripeObjectType = 'CHECKOUT_SESSION' | 'SUBSCRIPTION' | 'INVOICE' | 'PAYMENT_INTENT' | 'CHARGE'

export interface StripeAuthorityTuple {
  ownerKind: StripeEventOwnerKind
  routeKey: StripeEventRouteKey
  subjectKind: StripeEventSubjectKind
  subjectId: string
}

export interface WebhookLease {
  eventId: string
  phase: WebhookClaimPhase
  claimToken: string
  claimedBy: string
  claimedAt: Date
  claimExpiresAt: Date
  attempt: number
}

export interface ManualEffectAuditIntentInput {
  intentId: string
  requestActivityLogId: string
  resultActivityLogId: string
  actorId: string
  venueId: string | null
  eventId: string
  reason: string
}

export interface ManualRetryIntent extends ManualEffectAuditIntentInput {
  lease: WebhookLease
}

export interface ObservedWebhookEvent {
  id: string
  stripeEventId: string
  eventType: string
  payload: unknown
}

export interface WebhookShadowState {
  classificationState: string
  authority: StripeAuthorityTuple | null
}

export interface WebhookDispatchObservationInput {
  webhookEventId: string
  effectAttempt: number
  steps: unknown[]
  effectOutcome: string
  failureStep?: string | null
  comparisonCode: string
}

export interface WebhookTerminalization {
  eventId: string
  phase: WebhookClaimPhase
  attempt: number
  terminalReason: string
}

export interface OperationalAlertLease {
  alertId: string
  webhookEventId: string
  phase: WebhookClaimPhase
  terminalReason: string
  attempt: number
  payload: unknown
  deliveryAttempt: number
  claimToken: string
  claimedBy: string
  claimedAt: Date
  claimExpiresAt: Date
}

export type ClassificationResolution =
  | { state: 'CLASSIFIED'; authority: StripeAuthorityTuple }
  | { state: 'IGNORED'; code?: string; message?: string }
  | { state: 'UNRESOLVED'; code: string; message?: string }

export interface PhaseEligibilityRow {
  classificationState: string
  classificationAttempts: number
  classificationNextAttemptAt: Date | null
  status: string
  effectAttempts: number
  effectNextAttemptAt: Date | null
  claimPhase: string | null
  claimExpiresAt: Date | null
}

export type WebhookPhaseEligibility = 'ELIGIBLE' | 'PHASE_TERMINAL' | 'NOT_SCHEDULED' | 'NOT_DUE' | 'BUDGET_EXHAUSTED' | 'LIVE_LEASE'

interface ObserveCommand {
  id: string
  stripeEventId: string
  eventType: string
  payload: unknown
  now: Date
}

interface ObserveResult {
  event: ObservedWebhookEvent
  created: boolean
  eventTypeMatches: boolean
  payloadMatches: boolean
}

interface AcquireLeaseCommand {
  eventId: string
  phase: WebhookClaimPhase
  claimToken: string
  claimedBy: string
  now: Date
  claimExpiresAt: Date
  maxAttempts: number
  manual: boolean
}

interface AcquireLeaseBatchCommand {
  phase: WebhookClaimPhase
  claimTokenPrefix: string
  claimedBy: string
  now: Date
  claimExpiresAt: Date
  maxAttempts: number
  limit: number
}

interface AcquireManualEffectAuditIntentCommand extends ManualEffectAuditIntentInput {
  claimToken: string
  claimedBy: string
  claimedAt: Date
  claimExpiresAt: Date
  maxAttempts: number
  manual: true
}

interface LeaseCasCommand {
  lease: WebhookLease
  now: Date
}

interface RetryLeaseCommand extends LeaseCasCommand {
  nextAttemptAt: Date
  errorCode: string
  errorMessage: string
  maxAttempts: number
}

interface RenewLeaseCommand {
  lease: WebhookLease
  leaseMs: number
}

interface TerminalizePhaseCommand {
  eventId?: string
  phase: WebhookClaimPhase
  now: Date
  maxAttempts: number
}

interface FinalizeEffectWithObservationCommand extends LeaseCasCommand {
  observation: WebhookDispatchObservationInput
  outcome: 'SUCCESS' | 'FAILED'
  processingTime?: number
  nextAttemptAt: Date | null
  errorCode: string | null
  errorMessage: string | null
  maxAttempts: number
}

interface OperationalAlertClaimCommand {
  claimTokenPrefix: string
  claimedBy: string
  now: Date
  claimExpiresAt: Date
  limit: number
}

interface OperationalAlertCasCommand {
  lease: OperationalAlertLease
  now: Date
}

interface OperationalAlertRetryCommand extends OperationalAlertCasCommand {
  nextAttemptAt: Date
}

interface BindingCommand {
  objectType: StripeObjectType
  stripeObjectId: string
  authority: StripeAuthorityTuple
  sourceWebhookEventId: string | null
  now: Date
}

interface BindingResult {
  status: 'CREATED' | 'EXISTING'
  binding: BindingCommand
  authorityMatches: boolean
}

export interface PlatformWebhookRepository {
  insertOrObserve(command: ObserveCommand): Promise<ObserveResult>
  loadCanonical(eventId: string): Promise<ObservedWebhookEvent | null>
  loadShadowState(eventId: string): Promise<WebhookShadowState | null>
  acquireLease(command: AcquireLeaseCommand): Promise<WebhookLease | null>
  acquireLeaseBatch(command: AcquireLeaseBatchCommand): Promise<WebhookLease[]>
  acquireManualEffectWithAuditIntent(command: AcquireManualEffectAuditIntentCommand): Promise<ManualRetryIntent | null>
  renewLease(command: RenewLeaseCommand): Promise<WebhookLease | null>
  terminalizeExhaustedPhase(command: TerminalizePhaseCommand): Promise<WebhookTerminalization[]>
  finalizeClassification(command: LeaseCasCommand & { resolution: ClassificationResolution }): Promise<boolean>
  retryLease(command: RetryLeaseCommand): Promise<boolean>
  releaseLease(command: LeaseCasCommand): Promise<boolean>
  completeEffect(command: LeaseCasCommand & { processingTime?: number }): Promise<boolean>
  finalizeEffectWithObservation(command: FinalizeEffectWithObservationCommand): Promise<boolean>
  enrichVenue(command: { eventId: string; venueId: string; now: Date }): Promise<boolean>
  createDispatchObservation(command: WebhookDispatchObservationInput & { id: string; now: Date }): Promise<{
    status: 'CREATED' | 'EXISTING'
    observation: WebhookDispatchObservationInput & { id: string; now: Date }
  }>
  acquireOperationalAlertBatch(command: OperationalAlertClaimCommand): Promise<OperationalAlertLease[]>
  completeOperationalAlert(command: OperationalAlertCasCommand): Promise<boolean>
  retryOperationalAlert(command: OperationalAlertRetryCommand): Promise<boolean>
  createOrCompareBinding(command: BindingCommand): Promise<BindingResult>
}

export class StaleWebhookLeaseError extends Error {
  readonly code = 'STALE_WEBHOOK_LEASE'

  constructor(lease: WebhookLease) {
    super(`Webhook lease is stale for ${lease.eventId}/${lease.phase}`)
    this.name = 'StaleWebhookLeaseError'
  }
}

export class StripeObjectBindingConflictError extends Error {
  readonly code = 'STRIPE_OBJECT_BINDING_CONFLICT'

  constructor(objectType: StripeObjectType, stripeObjectId: string) {
    super(`Stripe object already has different local authority: ${objectType}/${stripeObjectId}`)
    this.name = 'StripeObjectBindingConflictError'
  }
}

export class WebhookEventConflictError extends Error {
  readonly code = 'WEBHOOK_EVENT_CONFLICT'

  constructor(stripeEventId: string) {
    super(`Stripe event ID was observed with different immutable content: ${stripeEventId}`)
    this.name = 'WebhookEventConflictError'
  }
}

export class WebhookCanonicalPayloadError extends Error {
  readonly code = 'WEBHOOK_CANONICAL_PAYLOAD_MISMATCH'

  constructor(eventId: string) {
    super(`Stored Stripe webhook payload does not match its durable identity: ${eventId}`)
    this.name = 'WebhookCanonicalPayloadError'
  }
}

export class StaleOperationalAlertLeaseError extends Error {
  readonly code = 'STALE_OPERATIONAL_ALERT_LEASE'

  constructor(alertId: string) {
    super(`Operational alert lease is stale for ${alertId}`)
    this.name = 'StaleOperationalAlertLeaseError'
  }
}

const ALLOWED_AUTHORITY = new Set([
  'COMMERCIAL_V2|COMMERCIAL_SUBSCRIPTION_LIFECYCLE|COMMERCIAL_ACCEPTANCE',
  'LEGACY|LEGACY_PLAN_CHECKOUT|STRIPE_CHECKOUT_ORIGIN',
  'LEGACY|LEGACY_SUBSCRIPTION_LIFECYCLE|VENUE_FEATURE',
  'INDEPENDENT|TERMINAL_ORDER_CHECKOUT|TERMINAL_ORDER',
  'INDEPENDENT|TOKEN_PAYMENT_INTENT|TOKEN_PURCHASE',
  'INDEPENDENT|TOKEN_INVOICE|TOKEN_PURCHASE',
  'LEGACY|VENUE_BILLING_PROFILE|VENUE',
])

const ALLOWED_BINDING_AUTHORITY = new Set([
  'CHECKOUT_SESSION|COMMERCIAL_V2|COMMERCIAL_SUBSCRIPTION_LIFECYCLE|COMMERCIAL_ACCEPTANCE',
  'CHECKOUT_SESSION|LEGACY|LEGACY_PLAN_CHECKOUT|STRIPE_CHECKOUT_ORIGIN',
  'CHECKOUT_SESSION|INDEPENDENT|TERMINAL_ORDER_CHECKOUT|TERMINAL_ORDER',
  'SUBSCRIPTION|COMMERCIAL_V2|COMMERCIAL_SUBSCRIPTION_LIFECYCLE|COMMERCIAL_ACCEPTANCE',
  'SUBSCRIPTION|LEGACY|LEGACY_SUBSCRIPTION_LIFECYCLE|VENUE_FEATURE',
  'INVOICE|COMMERCIAL_V2|COMMERCIAL_SUBSCRIPTION_LIFECYCLE|COMMERCIAL_ACCEPTANCE',
  'INVOICE|LEGACY|LEGACY_SUBSCRIPTION_LIFECYCLE|VENUE_FEATURE',
  'INVOICE|INDEPENDENT|TOKEN_INVOICE|TOKEN_PURCHASE',
  'PAYMENT_INTENT|COMMERCIAL_V2|COMMERCIAL_SUBSCRIPTION_LIFECYCLE|COMMERCIAL_ACCEPTANCE',
  'PAYMENT_INTENT|LEGACY|LEGACY_SUBSCRIPTION_LIFECYCLE|VENUE_FEATURE',
  'PAYMENT_INTENT|INDEPENDENT|TOKEN_PAYMENT_INTENT|TOKEN_PURCHASE',
  'CHARGE|COMMERCIAL_V2|COMMERCIAL_SUBSCRIPTION_LIFECYCLE|COMMERCIAL_ACCEPTANCE',
  'CHARGE|LEGACY|LEGACY_SUBSCRIPTION_LIFECYCLE|VENUE_FEATURE',
])

export function isAllowedStripeAuthorityTuple(authority: StripeAuthorityTuple): boolean {
  return (
    authority.subjectId.trim().length > 0 && ALLOWED_AUTHORITY.has(`${authority.ownerKind}|${authority.routeKey}|${authority.subjectKind}`)
  )
}

export function isAllowedStripeObjectBindingAuthority(objectType: StripeObjectType, authority: StripeAuthorityTuple): boolean {
  return (
    isAllowedStripeAuthorityTuple(authority) &&
    ALLOWED_BINDING_AUTHORITY.has(`${objectType}|${authority.ownerKind}|${authority.routeKey}|${authority.subjectKind}`)
  )
}

export function getWebhookPhaseEligibility(
  row: PhaseEligibilityRow,
  phase: WebhookClaimPhase,
  now: Date,
  maxAttempts: { classification: number; effect: number },
): WebhookPhaseEligibility {
  if (row.claimPhase !== null && row.claimExpiresAt !== null && row.claimExpiresAt.getTime() > now.getTime()) return 'LIVE_LEASE'

  const classification = phase === 'CLASSIFICATION'
  const terminal = classification
    ? row.classificationState !== 'PENDING_CLASSIFICATION'
    : !['PENDING', 'FAILED', 'RETRYING'].includes(row.status)
  if (terminal) return 'PHASE_TERMINAL'

  const nextAttemptAt = classification ? row.classificationNextAttemptAt : row.effectNextAttemptAt
  if (nextAttemptAt === null) return 'NOT_SCHEDULED'

  const attempts = classification ? row.classificationAttempts : row.effectAttempts
  const maximum = classification ? maxAttempts.classification : maxAttempts.effect
  if (attempts >= maximum) return 'BUDGET_EXHAUSTED'
  if (nextAttemptAt.getTime() > now.getTime()) return 'NOT_DUE'
  return 'ELIGIBLE'
}

export function nextWebhookRetryAt(now: Date, attempt: number, policy: { baseMs: number; maxMs: number }): Date {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('Webhook retry attempt must be a positive integer')
  if (!Number.isFinite(policy.baseMs) || !Number.isFinite(policy.maxMs) || policy.baseMs <= 0 || policy.maxMs < policy.baseMs) {
    throw new Error('Webhook retry policy is invalid')
  }
  const multiplier = 2 ** Math.min(attempt - 1, 30)
  return new Date(now.getTime() + Math.min(policy.maxMs, policy.baseMs * multiplier))
}

function boundedText(value: string | undefined, maxBytes: number, fallback: string): string {
  const source = value?.trim() || fallback
  if (Buffer.byteLength(source, 'utf8') <= maxBytes) return source
  const characters = [...source]
  while (characters.length > 0 && Buffer.byteLength(characters.join(''), 'utf8') > maxBytes) characters.pop()
  return characters.join('') || fallback.slice(0, maxBytes)
}

function assertLeasePhase(lease: WebhookLease, phase: WebhookClaimPhase) {
  if (lease.phase !== phase) throw new Error(`Expected ${phase} lease, received ${lease.phase}`)
}

const OBSERVATION_ADAPTER_OUTCOMES = new Set(['MATCHED_APPLIED', 'MATCHED_NOOP', 'NOT_MATCHED'])
const OBSERVATION_ENRICHMENT_OUTCOMES = new Set(['APPLIED', 'NOT_APPLICABLE', 'SKIPPED_INVALID', 'FAILED_NON_FATAL'])
const OBSERVATION_LEGACY_STEPS = new Set([
  'SUBSCRIPTION_CREATED',
  'SUBSCRIPTION_UPDATED',
  'SUBSCRIPTION_DELETED',
  'SUBSCRIPTION_TRIAL_WILL_END',
  'INVOICE_PAYMENT_SUCCEEDED',
  'INVOICE_PAYMENT_FAILED',
  'CUSTOMER_DELETED',
  'PAYMENT_METHOD_ATTACHED',
  'PAYMENT_INTENT_SUCCEEDED',
  'PAYMENT_INTENT_FAILED',
  'CHECKOUT_CREDIT_PACK',
  'CHECKOUT_TERMINAL_ORDER',
  'CHECKOUT_LEGACY_PLAN',
])
const OBSERVATION_FAILURE_STEPS = new Set(['COMMERCIAL_ADAPTER', 'VENUE_ENRICHMENT', ...OBSERVATION_LEGACY_STEPS])
const OBSERVATION_COMPARISONS = new Set([
  'MATCH',
  'CLASSIFIED_CURRENT_NO_MATCH',
  'CLASSIFIED_CURRENT_ROUTE_MISMATCH',
  'CURRENT_EFFECT_WITHOUT_AUTHORITY',
  'MULTIPLE_CURRENT_BRANCHES',
  'CLASSIFICATION_PENDING',
  'NO_AUTHORITY_NO_CURRENT_EFFECT',
])

function assertDispatchObservation(input: WebhookDispatchObservationInput): void {
  const validStep = (value: unknown): boolean => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const step = value as Record<string, unknown>
    if (Object.keys(step).sort().join('|') !== 'outcome|step') return false
    if (typeof step.step !== 'string' || typeof step.outcome !== 'string') return false
    if (step.step === 'COMMERCIAL_ADAPTER') return OBSERVATION_ADAPTER_OUTCOMES.has(step.outcome)
    if (step.step === 'VENUE_ENRICHMENT') return OBSERVATION_ENRICHMENT_OUTCOMES.has(step.outcome)
    return OBSERVATION_LEGACY_STEPS.has(step.step) && (step.outcome === 'ATTEMPTED' || step.outcome === 'COMPLETED')
  }

  if (
    !input.webhookEventId.trim() ||
    !Number.isInteger(input.effectAttempt) ||
    input.effectAttempt < 1 ||
    !Array.isArray(input.steps) ||
    !input.steps.every(validStep) ||
    (input.effectOutcome !== 'SUCCESS' && input.effectOutcome !== 'FAILED') ||
    (input.failureStep !== undefined && input.failureStep !== null && !OBSERVATION_FAILURE_STEPS.has(input.failureStep)) ||
    !OBSERVATION_COMPARISONS.has(input.comparisonCode)
  ) {
    throw new Error('Webhook dispatch observation contains an unknown or data-bearing value')
  }
}

export function createPlatformWebhookInboxService(dependencies: {
  repository: PlatformWebhookRepository
  now?: () => Date
  workerId: string
  newClaimToken?: () => string
  leaseMs?: number
  leaseMsByPhase?: { classification: number; effect: number }
  operationalAlertLeaseMs?: number
  maxAttempts?: { classification: number; effect: number }
  retryBackoff?: { baseMs: number; maxMs: number }
}) {
  const now = dependencies.now ?? (() => new Date())
  const newClaimToken = dependencies.newClaimToken ?? randomUUID
  const leaseMsByPhase = dependencies.leaseMsByPhase ?? {
    classification: dependencies.leaseMs ?? PLATFORM_WEBHOOK_LIMITS.classificationLeaseMs,
    effect: dependencies.leaseMs ?? PLATFORM_WEBHOOK_LIMITS.effectLeaseMs,
  }
  const operationalAlertLeaseMs = dependencies.operationalAlertLeaseMs ?? PLATFORM_WEBHOOK_LIMITS.operationalAlertLeaseMs
  const maxAttempts = dependencies.maxAttempts ?? {
    classification: PLATFORM_WEBHOOK_LIMITS.maxAttempts,
    effect: PLATFORM_WEBHOOK_LIMITS.maxAttempts,
  }
  const retryBackoff = dependencies.retryBackoff ?? { baseMs: 2_000, maxMs: 5 * 60_000 }

  if (!dependencies.workerId.trim()) throw new Error('Webhook workerId is required')
  if (
    !Number.isFinite(leaseMsByPhase.classification) ||
    !Number.isFinite(leaseMsByPhase.effect) ||
    leaseMsByPhase.classification <= 0 ||
    leaseMsByPhase.effect <= 0
  ) {
    throw new Error('Webhook leaseMs must be positive')
  }

  async function requireCas(applied: Promise<boolean>, lease: WebhookLease): Promise<void> {
    if (!(await applied)) throw new StaleWebhookLeaseError(lease)
  }

  return {
    async observe(input: { stripeEventId: string; eventType: string; payload: unknown }) {
      if (!input.stripeEventId.trim() || !input.eventType.trim()) throw new Error('Stripe event ID and type are required')
      if (JSON.stringify(input.payload) === undefined) throw new Error('Stripe event payload must be JSON serializable')
      const result = await dependencies.repository.insertOrObserve({ id: cuid(), ...input, now: now() })
      if (!result.eventTypeMatches || !result.payloadMatches) throw new WebhookEventConflictError(input.stripeEventId)
      return { event: result.event, created: result.created }
    },

    async load(eventId: string): Promise<ObservedWebhookEvent> {
      const event = await dependencies.repository.loadCanonical(eventId)
      if (!event) throw new Error(`Webhook event not found: ${eventId}`)
      const payload = event.payload
      if (
        typeof payload !== 'object' ||
        payload === null ||
        Array.isArray(payload) ||
        (payload as { id?: unknown }).id !== event.stripeEventId ||
        (payload as { type?: unknown }).type !== event.eventType
      ) {
        throw new WebhookCanonicalPayloadError(eventId)
      }
      return event
    },

    async loadShadowState(eventId: string): Promise<WebhookShadowState> {
      const state = await dependencies.repository.loadShadowState(eventId)
      if (!state) throw new Error(`Webhook event not found: ${eventId}`)
      return state
    },

    acquire(eventId: string, phase: WebhookClaimPhase, options: { manual?: boolean } = {}): Promise<WebhookLease | null> {
      const claimedAt = now()
      const leaseMs = phase === 'CLASSIFICATION' ? leaseMsByPhase.classification : leaseMsByPhase.effect
      return dependencies.repository.acquireLease({
        eventId,
        phase,
        claimToken: newClaimToken(),
        claimedBy: dependencies.workerId,
        now: claimedAt,
        claimExpiresAt: new Date(claimedAt.getTime() + leaseMs),
        maxAttempts: phase === 'CLASSIFICATION' ? maxAttempts.classification : maxAttempts.effect,
        manual: options.manual ?? false,
      })
    },

    async acquireManualEffectWithAuditIntent(input: ManualEffectAuditIntentInput): Promise<ManualRetryIntent | null> {
      const claimedAt = now()
      const command: AcquireManualEffectAuditIntentCommand = {
        ...input,
        claimToken: newClaimToken(),
        claimedBy: dependencies.workerId,
        claimedAt,
        claimExpiresAt: new Date(claimedAt.getTime() + leaseMsByPhase.effect),
        maxAttempts: maxAttempts.effect,
        manual: true,
      }
      try {
        return await dependencies.repository.acquireManualEffectWithAuditIntent(command)
      } catch {
        // The first statement may have committed while its acknowledgement was
        // lost. Retrying the exact command converges through the stable intent,
        // result-log and EFFECT claim identities; it never spends attempt N+1.
        return dependencies.repository.acquireManualEffectWithAuditIntent(command)
      }
    },

    acquireBatch(phase: WebhookClaimPhase): Promise<WebhookLease[]> {
      const claimedAt = now()
      const leaseMs = phase === 'CLASSIFICATION' ? leaseMsByPhase.classification : leaseMsByPhase.effect
      return dependencies.repository.acquireLeaseBatch({
        phase,
        claimTokenPrefix: newClaimToken(),
        claimedBy: dependencies.workerId,
        now: claimedAt,
        claimExpiresAt: new Date(claimedAt.getTime() + leaseMs),
        maxAttempts: phase === 'CLASSIFICATION' ? maxAttempts.classification : maxAttempts.effect,
        limit: PLATFORM_WEBHOOK_LIMITS.batchSize,
      })
    },

    async acquireNext(phase: WebhookClaimPhase): Promise<WebhookLease | null> {
      const claimedAt = now()
      const leaseMs = phase === 'CLASSIFICATION' ? leaseMsByPhase.classification : leaseMsByPhase.effect
      const leases = await dependencies.repository.acquireLeaseBatch({
        phase,
        claimTokenPrefix: newClaimToken(),
        claimedBy: dependencies.workerId,
        now: claimedAt,
        claimExpiresAt: new Date(claimedAt.getTime() + leaseMs),
        maxAttempts: phase === 'CLASSIFICATION' ? maxAttempts.classification : maxAttempts.effect,
        limit: 1,
      })
      return leases[0] ?? null
    },

    async renew(lease: WebhookLease): Promise<WebhookLease> {
      const leaseMs = lease.phase === 'CLASSIFICATION' ? leaseMsByPhase.classification : leaseMsByPhase.effect
      const renewed = await dependencies.repository.renewLease({ lease, leaseMs })
      if (!renewed) throw new StaleWebhookLeaseError(lease)
      return renewed
    },

    async heartbeat(lease: WebhookLease): Promise<WebhookLease> {
      assertLeasePhase(lease, 'EFFECT')
      return this.renew(lease)
    },

    terminalizeExhausted(phase: WebhookClaimPhase, eventId?: string): Promise<WebhookTerminalization[]> {
      return dependencies.repository.terminalizeExhaustedPhase({
        eventId,
        phase,
        now: now(),
        maxAttempts: phase === 'CLASSIFICATION' ? maxAttempts.classification : maxAttempts.effect,
      })
    },

    async finalizeClassification(lease: WebhookLease, resolution: ClassificationResolution): Promise<void> {
      assertLeasePhase(lease, 'CLASSIFICATION')
      if (resolution.state === 'CLASSIFIED' && !isAllowedStripeAuthorityTuple(resolution.authority)) {
        throw new Error('Stripe authority tuple is not authorizable')
      }
      await requireCas(dependencies.repository.finalizeClassification({ lease, resolution, now: now() }), lease)
    },

    async retry(lease: WebhookLease, error: { code?: string; message?: string }): Promise<void> {
      const retryAt = now()
      await requireCas(
        dependencies.repository.retryLease({
          lease,
          now: retryAt,
          nextAttemptAt: nextWebhookRetryAt(retryAt, lease.attempt, retryBackoff),
          errorCode: boundedText(error.code, 64, 'WEBHOOK_PHASE_RETRY'),
          errorMessage: boundedText(error.message, 1024, 'Webhook phase failed and will retry'),
          maxAttempts: lease.phase === 'CLASSIFICATION' ? maxAttempts.classification : maxAttempts.effect,
        }),
        lease,
      )
    },

    async release(lease: WebhookLease): Promise<void> {
      await requireCas(dependencies.repository.releaseLease({ lease, now: now() }), lease)
    },

    async completeEffect(lease: WebhookLease, input: { processingTime?: number } = {}): Promise<void> {
      assertLeasePhase(lease, 'EFFECT')
      await requireCas(dependencies.repository.completeEffect({ lease, now: now(), processingTime: input.processingTime }), lease)
    },

    async finalizeEffectWithObservation(
      lease: WebhookLease,
      observation: WebhookDispatchObservationInput,
      result:
        | { outcome: 'SUCCESS'; processingTime?: number }
        | { outcome: 'FAILED'; processingTime?: number; error?: { code?: string; message?: string } },
    ): Promise<void> {
      assertLeasePhase(lease, 'EFFECT')
      assertDispatchObservation(observation)
      if (
        observation.webhookEventId !== lease.eventId ||
        observation.effectAttempt !== lease.attempt ||
        observation.effectOutcome !== result.outcome ||
        !Array.isArray(observation.steps) ||
        !observation.comparisonCode.trim()
      ) {
        throw new Error('Webhook effect observation does not match its lease/result')
      }
      const settledAt = now()
      const failed = result.outcome === 'FAILED'
      await requireCas(
        dependencies.repository.finalizeEffectWithObservation({
          lease,
          observation,
          outcome: result.outcome,
          processingTime: result.processingTime,
          now: settledAt,
          nextAttemptAt: failed ? nextWebhookRetryAt(settledAt, lease.attempt, retryBackoff) : null,
          errorCode: failed ? boundedText(result.error?.code, 64, 'WEBHOOK_EFFECT_FAILED') : null,
          errorMessage: failed ? boundedText(result.error?.message, 1024, 'Webhook effect dispatch failed') : null,
          maxAttempts: maxAttempts.effect,
        }),
        lease,
      )
    },

    enrichVenueId(eventId: string, venueId: string): Promise<boolean> {
      if (!eventId.trim() || !venueId.trim()) throw new Error('Webhook event ID and venue ID are required')
      return dependencies.repository.enrichVenue({ eventId, venueId, now: now() })
    },

    recordDispatchObservation(input: WebhookDispatchObservationInput) {
      assertDispatchObservation(input)
      return dependencies.repository.createDispatchObservation({ ...input, id: cuid(), now: now() })
    },

    claimOperationalAlerts(): Promise<OperationalAlertLease[]> {
      const claimedAt = now()
      return dependencies.repository.acquireOperationalAlertBatch({
        claimTokenPrefix: newClaimToken(),
        claimedBy: dependencies.workerId,
        now: claimedAt,
        claimExpiresAt: new Date(claimedAt.getTime() + operationalAlertLeaseMs),
        limit: PLATFORM_WEBHOOK_LIMITS.batchSize,
      })
    },

    async acknowledgeOperationalAlert(lease: OperationalAlertLease): Promise<void> {
      const applied = await dependencies.repository.completeOperationalAlert({ lease, now: now() })
      if (!applied) throw new StaleOperationalAlertLeaseError(lease.alertId)
    },

    async retryOperationalAlert(lease: OperationalAlertLease): Promise<void> {
      const retryAt = now()
      const applied = await dependencies.repository.retryOperationalAlert({
        lease,
        now: retryAt,
        nextAttemptAt: nextWebhookRetryAt(retryAt, lease.deliveryAttempt, retryBackoff),
      })
      if (!applied) throw new StaleOperationalAlertLeaseError(lease.alertId)
    },

    async bind(input: {
      objectType: StripeObjectType
      stripeObjectId: string
      authority: StripeAuthorityTuple
      sourceWebhookEventId?: string | null
    }) {
      if (!input.stripeObjectId.trim() || !isAllowedStripeObjectBindingAuthority(input.objectType, input.authority)) {
        throw new Error('Stripe binding authority is not authorizable')
      }
      const result = await dependencies.repository.createOrCompareBinding({
        ...input,
        sourceWebhookEventId: input.sourceWebhookEventId ?? null,
        now: now(),
      })
      if (!result.authorityMatches) throw new StripeObjectBindingConflictError(input.objectType, input.stripeObjectId)
      return { status: result.status, binding: result.binding }
    },
  }
}

type RawPrisma = Pick<PrismaClient, '$queryRaw'>

function leaseCasSql(command: LeaseCasCommand): Prisma.Sql {
  return Prisma.sql`
    id = ${command.lease.eventId}
    AND "claimPhase" = ${command.lease.phase}::"WebhookClaimPhase"
    AND "claimToken" = ${command.lease.claimToken}
    AND "claimedBy" = ${command.lease.claimedBy}
    AND "claimExpiresAt" > ${utcTs(command.now)}
  `
}

const clearLeaseSql = Prisma.sql`
  "claimPhase" = NULL,
  "claimToken" = NULL,
  "claimedBy" = NULL,
  "claimedAt" = NULL,
  "claimExpiresAt" = NULL
`

export function createPrismaPlatformWebhookRepository(prisma: RawPrisma): PlatformWebhookRepository {
  return {
    async insertOrObserve(command) {
      const serializedPayload = JSON.stringify(command.payload)
      const inserted = await prisma.$queryRaw<ObservedWebhookEvent[]>(Prisma.sql`
        INSERT INTO "WebhookEvent" (
          id, "stripeEventId", "eventType", payload, status,
          "classificationState", "classificationAttempts", "classificationNextAttemptAt",
          "effectAttempts", "effectNextAttemptAt", "retryCount", "createdAt", "updatedAt"
        ) VALUES (
          ${command.id}, ${command.stripeEventId}, ${command.eventType}, ${serializedPayload}::jsonb, 'PENDING',
          'PENDING_CLASSIFICATION', 0, ${utcTs(command.now)},
          0, ${utcTs(command.now)}, 0, ${utcTs(command.now)}, ${utcTs(command.now)}
        )
        ON CONFLICT ("stripeEventId") DO NOTHING
        RETURNING id, "stripeEventId", "eventType", payload
      `)
      if (inserted[0]) {
        return {
          event: inserted[0],
          created: true,
          eventTypeMatches: true,
          payloadMatches: true,
        }
      }

      // A single INSERT/UNION statement keeps its initial snapshot after
      // waiting on a concurrent unique-key winner and can therefore see zero
      // rows. This second statement gets a fresh READ COMMITTED snapshot.
      const observed = await prisma.$queryRaw<
        Array<ObservedWebhookEvent & { eventTypeMatches: boolean; payloadMatches: boolean }>
      >(Prisma.sql`
        SELECT id, "stripeEventId", "eventType", payload,
               "eventType" = ${command.eventType} AS "eventTypeMatches",
               payload = ${serializedPayload}::jsonb AS "payloadMatches"
        FROM "WebhookEvent"
        WHERE "stripeEventId" = ${command.stripeEventId}
        LIMIT 1
      `)
      const row = observed[0]
      if (!row) throw new Error(`Webhook insert-or-observe produced no durable row for ${command.stripeEventId}`)
      return {
        event: { id: row.id, stripeEventId: row.stripeEventId, eventType: row.eventType, payload: row.payload },
        created: false,
        eventTypeMatches: row.eventTypeMatches,
        payloadMatches: row.payloadMatches,
      }
    },

    async loadCanonical(eventId) {
      const rows = await prisma.$queryRaw<ObservedWebhookEvent[]>(Prisma.sql`
        SELECT id, "stripeEventId", "eventType", payload
        FROM "WebhookEvent"
        WHERE id = ${eventId}
        LIMIT 1
      `)
      return rows[0] ?? null
    },

    async loadShadowState(eventId) {
      const rows = await prisma.$queryRaw<
        Array<{
          classificationState: string
          ownerKind: StripeEventOwnerKind | null
          routeKey: StripeEventRouteKey | null
          subjectKind: StripeEventSubjectKind | null
          subjectId: string | null
        }>
      >(Prisma.sql`
        SELECT "classificationState", "ownerKind", "routeKey", "subjectKind", "subjectId"
        FROM "WebhookEvent"
        WHERE id = ${eventId}
        LIMIT 1
      `)
      const row = rows[0]
      if (!row) return null
      const authority =
        row.ownerKind && row.routeKey && row.subjectKind && row.subjectId
          ? { ownerKind: row.ownerKind, routeKey: row.routeKey, subjectKind: row.subjectKind, subjectId: row.subjectId }
          : null
      return { classificationState: row.classificationState, authority }
    },

    async acquireLease(command) {
      const duePredicate = command.manual
        ? Prisma.empty
        : command.phase === 'CLASSIFICATION'
          ? Prisma.sql`AND "classificationNextAttemptAt" <= ${utcTs(command.now)}`
          : Prisma.sql`AND "effectNextAttemptAt" <= ${utcTs(command.now)}`
      const eligibility =
        command.phase === 'CLASSIFICATION'
          ? Prisma.sql`
              "classificationState" = 'PENDING_CLASSIFICATION'
              AND "classificationNextAttemptAt" IS NOT NULL
              ${duePredicate}
              AND "classificationAttempts" < ${command.maxAttempts}
            `
          : Prisma.sql`
              status IN ('PENDING', 'FAILED', 'RETRYING')
              AND "effectNextAttemptAt" IS NOT NULL
              ${duePredicate}
              AND "effectAttempts" < ${command.maxAttempts}
            `
      const counterUpdate =
        command.phase === 'CLASSIFICATION'
          ? Prisma.sql`"classificationAttempts" = event."classificationAttempts" + 1`
          : Prisma.sql`
              "effectAttempts" = event."effectAttempts" + 1,
              "retryCount" = event."retryCount" + 1,
              status = 'RETRYING'
            `
      const attemptColumn = Prisma.raw(command.phase === 'CLASSIFICATION' ? '"classificationAttempts"' : '"effectAttempts"')
      const rows = await prisma.$queryRaw<Array<Omit<WebhookLease, 'phase'> & { attempt: number }>>(Prisma.sql`
        WITH candidate AS (
          SELECT id
          FROM "WebhookEvent"
          WHERE id = ${command.eventId}
            AND ${eligibility}
            AND ("claimPhase" IS NULL OR "claimExpiresAt" <= ${utcTs(command.now)})
          FOR UPDATE SKIP LOCKED
        )
        UPDATE "WebhookEvent" event
        SET ${counterUpdate},
            "claimPhase" = ${command.phase}::"WebhookClaimPhase",
            "claimToken" = ${command.claimToken},
            "claimedBy" = ${command.claimedBy},
            "claimedAt" = ${utcTs(command.now)},
            "claimExpiresAt" = ${utcTs(command.claimExpiresAt)},
            "updatedAt" = ${utcTs(command.now)}
        FROM candidate
        WHERE event.id = candidate.id
        RETURNING event.id AS "eventId", event."claimToken", event."claimedBy", event."claimedAt", event."claimExpiresAt",
                  event.${attemptColumn} AS attempt
      `)
      const row = rows[0]
      return row ? { ...row, phase: command.phase } : null
    },

    async acquireLeaseBatch(command) {
      const limit = Math.min(PLATFORM_WEBHOOK_LIMITS.batchSize, Math.max(1, Math.trunc(command.limit)))
      const eligibility =
        command.phase === 'CLASSIFICATION'
          ? Prisma.sql`
              "classificationState" = 'PENDING_CLASSIFICATION'
              AND "classificationNextAttemptAt" IS NOT NULL
              AND "classificationNextAttemptAt" <= ${utcTs(command.now)}
              AND "classificationAttempts" < ${command.maxAttempts}
            `
          : Prisma.sql`
              status IN ('PENDING', 'FAILED', 'RETRYING')
              AND "effectNextAttemptAt" IS NOT NULL
              AND "effectNextAttemptAt" <= ${utcTs(command.now)}
              AND "effectAttempts" < ${command.maxAttempts}
            `
      const dueColumn = Prisma.raw(command.phase === 'CLASSIFICATION' ? '"classificationNextAttemptAt"' : '"effectNextAttemptAt"')
      const counterUpdate =
        command.phase === 'CLASSIFICATION'
          ? Prisma.sql`"classificationAttempts" = event."classificationAttempts" + 1`
          : Prisma.sql`
              "effectAttempts" = event."effectAttempts" + 1,
              "retryCount" = event."retryCount" + 1,
              status = 'RETRYING'
            `
      const attemptColumn = Prisma.raw(command.phase === 'CLASSIFICATION' ? '"classificationAttempts"' : '"effectAttempts"')
      const rows = await prisma.$queryRaw<Array<Omit<WebhookLease, 'phase'> & { attempt: number }>>(Prisma.sql`
        WITH candidate AS MATERIALIZED (
          SELECT id, ${dueColumn} AS due_at, "createdAt" AS created_at
          FROM "WebhookEvent"
          WHERE ${eligibility}
            AND ("claimPhase" IS NULL OR "claimExpiresAt" <= ${utcTs(command.now)})
          ORDER BY ${dueColumn} ASC, "createdAt" ASC, id ASC
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        ), updated AS (
          UPDATE "WebhookEvent" event
          SET ${counterUpdate},
              "claimPhase" = ${command.phase}::"WebhookClaimPhase",
              "claimToken" = ${command.claimTokenPrefix} || ':' || event.id,
              "claimedBy" = ${command.claimedBy},
              "claimedAt" = ${utcTs(command.now)},
              "claimExpiresAt" = ${utcTs(command.claimExpiresAt)},
              "updatedAt" = ${utcTs(command.now)}
          FROM candidate
          WHERE event.id = candidate.id
          RETURNING event.id AS "eventId", event."claimToken", event."claimedBy", event."claimedAt", event."claimExpiresAt",
                    event.${attemptColumn} AS attempt
        )
        SELECT updated.*
        FROM updated
        JOIN candidate ON candidate.id = updated."eventId"
        ORDER BY candidate.due_at ASC, candidate.created_at ASC, candidate.id ASC
      `)
      return rows.map(row => ({ ...row, phase: command.phase }))
    },

    async acquireManualEffectWithAuditIntent(command) {
      type IntentRow = Omit<ManualRetryIntent, 'lease'> & {
        effectAttempt: number
        effectClaimToken: string
        effectClaimedBy: string
        effectClaimedAt: Date
        effectClaimExpiresAt: Date
      }
      const rows = await prisma.$queryRaw<IntentRow[]>(Prisma.sql`
        WITH existing AS MATERIALIZED (
          SELECT
            outbox.id AS "intentId",
            outbox."requestActivityLogId",
            outbox."resultActivityLogId",
            outbox."actorId",
            outbox."venueId",
            outbox."webhookEventId" AS "eventId",
            outbox.reason,
            outbox."effectAttempt",
            outbox."effectClaimToken",
            outbox."effectClaimedBy",
            outbox."effectClaimedAt",
            outbox."effectClaimExpiresAt"
          FROM "WebhookManualRetryResultOutbox" outbox
          WHERE outbox.id = ${command.intentId}
            AND outbox."requestActivityLogId" = ${command.requestActivityLogId}
            AND outbox."resultActivityLogId" = ${command.resultActivityLogId}
            AND outbox."actorId" = ${command.actorId}
            AND outbox."venueId" IS NOT DISTINCT FROM ${command.venueId}
            AND outbox."webhookEventId" = ${command.eventId}
            AND outbox.reason = ${command.reason}
            AND outbox."effectClaimToken" = ${command.claimToken}
            AND outbox."effectClaimedBy" = ${command.claimedBy}
            AND outbox."effectClaimedAt" = ${utcTs(command.claimedAt)}
            AND outbox."effectClaimExpiresAt" = ${utcTs(command.claimExpiresAt)}
        ), candidate AS MATERIALIZED (
          SELECT event.id
          FROM "WebhookEvent" event
          WHERE NOT EXISTS (SELECT 1 FROM existing)
            AND event.id = ${command.eventId}
            AND event.status IN ('PENDING', 'FAILED', 'RETRYING')
            AND event."effectNextAttemptAt" IS NOT NULL
            AND event."effectAttempts" < ${command.maxAttempts}
            AND (event."claimPhase" IS NULL OR event."claimExpiresAt" <= ${utcTs(command.claimedAt)})
          FOR UPDATE SKIP LOCKED
        ), claimed AS (
          UPDATE "WebhookEvent" event
          SET "effectAttempts" = event."effectAttempts" + 1,
              "retryCount" = event."retryCount" + 1,
              status = 'RETRYING',
              "claimPhase" = 'EFFECT',
              "claimToken" = ${command.claimToken},
              "claimedBy" = ${command.claimedBy},
              "claimedAt" = ${utcTs(command.claimedAt)},
              "claimExpiresAt" = ${utcTs(command.claimExpiresAt)},
              "updatedAt" = ${utcTs(command.claimedAt)}
          FROM candidate
          WHERE event.id = candidate.id
          RETURNING event.id, event."effectAttempts"
        ), inserted AS (
          INSERT INTO "WebhookManualRetryResultOutbox" (
            id, "webhookEventId", "actorId", "venueId", reason,
            "requestActivityLogId", "resultActivityLogId",
            "effectAttempt", "effectClaimToken", "effectClaimedBy", "effectClaimedAt", "effectClaimExpiresAt",
            "nextAttemptAt", "createdAt", "updatedAt"
          )
          SELECT
            ${command.intentId}, claimed.id, ${command.actorId}, ${command.venueId}, ${command.reason},
            ${command.requestActivityLogId}, ${command.resultActivityLogId},
            claimed."effectAttempts", ${command.claimToken}, ${command.claimedBy},
            ${utcTs(command.claimedAt)}, ${utcTs(command.claimExpiresAt)},
            ${utcTs(command.claimedAt)}, ${utcTs(command.claimedAt)}, ${utcTs(command.claimedAt)}
          FROM claimed
          RETURNING
            id AS "intentId", "requestActivityLogId", "resultActivityLogId", "actorId", "venueId",
            "webhookEventId" AS "eventId", reason, "effectAttempt", "effectClaimToken", "effectClaimedBy",
            "effectClaimedAt", "effectClaimExpiresAt"
        ), resolved AS (
          SELECT * FROM existing
          UNION ALL
          SELECT * FROM inserted
        )
        SELECT resolved.*
        FROM resolved
        LIMIT 1
      `)
      const row = rows[0]
      if (row) {
        return {
          intentId: row.intentId,
          requestActivityLogId: row.requestActivityLogId,
          resultActivityLogId: row.resultActivityLogId,
          actorId: row.actorId,
          venueId: row.venueId,
          eventId: row.eventId,
          reason: row.reason,
          lease: {
            eventId: row.eventId,
            phase: 'EFFECT',
            attempt: row.effectAttempt,
            claimToken: row.effectClaimToken,
            claimedBy: row.effectClaimedBy,
            claimedAt: row.effectClaimedAt,
            claimExpiresAt: row.effectClaimExpiresAt,
          },
        }
      }

      const conflict = await prisma.$queryRaw<Array<{ exists: boolean }>>(Prisma.sql`
        SELECT EXISTS (SELECT 1 FROM "WebhookManualRetryResultOutbox" WHERE id = ${command.intentId}) AS exists
      `)
      if (conflict[0]?.exists) throw new Error(`Manual retry intent conflict: ${command.intentId}`)
      return null
    },

    async renewLease(command) {
      const rows = await prisma.$queryRaw<Array<Omit<WebhookLease, 'phase'> & { attempt: number }>>(Prisma.sql`
        WITH db_clock AS MATERIALIZED (
          SELECT timezone('UTC', clock_timestamp())::timestamp AS now
        ), renewed AS (
          UPDATE "WebhookEvent" event
          SET "claimExpiresAt" = db_clock.now + (${command.leaseMs} * interval '1 millisecond'),
              "updatedAt" = db_clock.now
          FROM db_clock
          WHERE event.id = ${command.lease.eventId}
            AND event."claimPhase" = ${command.lease.phase}::"WebhookClaimPhase"
            AND event."claimToken" = ${command.lease.claimToken}
            AND event."claimedBy" = ${command.lease.claimedBy}
            AND event."claimExpiresAt" > db_clock.now
          RETURNING event.id AS "eventId", event."claimToken", event."claimedBy", event."claimedAt", event."claimExpiresAt",
                    CASE WHEN event."claimPhase" = 'CLASSIFICATION'
                         THEN event."classificationAttempts" ELSE event."effectAttempts" END AS attempt
        )
        SELECT * FROM renewed
      `)
      return rows[0] ? { ...rows[0], phase: command.lease.phase } : null
    },

    async terminalizeExhaustedPhase(command) {
      const phaseState =
        command.phase === 'CLASSIFICATION'
          ? Prisma.sql`
              "classificationState" = 'UNRESOLVED',
              "classificationNextAttemptAt" = NULL,
              "classificationResolvedAt" = ${utcTs(command.now)},
              "classificationErrorCode" = 'CLASSIFICATION_ATTEMPTS_EXHAUSTED',
              "classificationErrorMessage" = 'Webhook classification attempt budget exhausted',
            `
          : Prisma.sql`
              status = 'FAILED',
              "effectNextAttemptAt" = NULL,
              "errorMessage" = COALESCE("errorMessage", 'Webhook effect attempt budget exhausted'),
            `
      const phaseEligibility =
        command.phase === 'CLASSIFICATION'
          ? Prisma.sql`
              "classificationState" = 'PENDING_CLASSIFICATION'
              AND "classificationAttempts" >= ${command.maxAttempts}
            `
          : Prisma.sql`
              status IN ('PENDING', 'FAILED', 'RETRYING')
              AND "effectAttempts" >= ${command.maxAttempts}
              AND (status <> 'FAILED' OR "effectNextAttemptAt" IS NOT NULL)
            `
      const attemptColumn = Prisma.raw(command.phase === 'CLASSIFICATION' ? '"classificationAttempts"' : '"effectAttempts"')
      const terminalReason = command.phase === 'CLASSIFICATION' ? 'CLASSIFICATION_ATTEMPTS_EXHAUSTED' : 'EFFECT_ATTEMPTS_EXHAUSTED'
      return prisma.$queryRaw<WebhookTerminalization[]>(Prisma.sql`
        WITH terminalized AS (
          UPDATE "WebhookEvent" event
          SET ${phaseState}
              "claimPhase" = CASE
                WHEN event."claimPhase" = ${command.phase}::"WebhookClaimPhase"
                  AND event."claimExpiresAt" <= ${utcTs(command.now)} THEN NULL
                ELSE event."claimPhase"
              END,
              "claimToken" = CASE
                WHEN event."claimPhase" = ${command.phase}::"WebhookClaimPhase"
                  AND event."claimExpiresAt" <= ${utcTs(command.now)} THEN NULL
                ELSE event."claimToken"
              END,
              "claimedBy" = CASE
                WHEN event."claimPhase" = ${command.phase}::"WebhookClaimPhase"
                  AND event."claimExpiresAt" <= ${utcTs(command.now)} THEN NULL
                ELSE event."claimedBy"
              END,
              "claimedAt" = CASE
                WHEN event."claimPhase" = ${command.phase}::"WebhookClaimPhase"
                  AND event."claimExpiresAt" <= ${utcTs(command.now)} THEN NULL
                ELSE event."claimedAt"
              END,
              "claimExpiresAt" = CASE
                WHEN event."claimPhase" = ${command.phase}::"WebhookClaimPhase"
                  AND event."claimExpiresAt" <= ${utcTs(command.now)} THEN NULL
                ELSE event."claimExpiresAt"
              END,
              "updatedAt" = ${utcTs(command.now)}
          WHERE (${command.eventId ?? null}::text IS NULL OR event.id = ${command.eventId ?? null})
            AND ${phaseEligibility}
            AND NOT COALESCE((
              event."claimPhase" = ${command.phase}::"WebhookClaimPhase"
              AND event."claimExpiresAt" > ${utcTs(command.now)}
            ), false)
          RETURNING event.id, event.${attemptColumn} AS attempt
        ), alert_insert AS (
          INSERT INTO "WebhookOperationalAlert" (
            "webhookEventId", phase, "terminalReason", attempt, payload, "nextAttemptAt", "createdAt", "updatedAt"
          )
          SELECT
            id,
            ${command.phase}::"WebhookClaimPhase",
            ${terminalReason},
            attempt,
            jsonb_build_object(
              'webhookEventId', id,
              'phase', ${command.phase},
              'terminalReason', ${terminalReason},
              'attempt', attempt
            ),
            ${utcTs(command.now)},
            ${utcTs(command.now)},
            ${utcTs(command.now)}
          FROM terminalized
          ON CONFLICT ("webhookEventId", phase, "terminalReason") DO NOTHING
          RETURNING "webhookEventId"
        )
        SELECT id AS "eventId", ${command.phase}::text AS phase, attempt, ${terminalReason}::text AS "terminalReason"
        FROM terminalized
        ORDER BY id ASC
      `)
    },

    async finalizeClassification(command) {
      const errorCode =
        command.resolution.state === 'CLASSIFIED'
          ? null
          : boundedText(command.resolution.code, 64, `CLASSIFICATION_${command.resolution.state}`)
      const errorMessage =
        command.resolution.state === 'CLASSIFIED'
          ? null
          : boundedText(command.resolution.message, 1024, `Webhook classification ${command.resolution.state.toLowerCase()}`)
      const authority =
        command.resolution.state === 'CLASSIFIED'
          ? Prisma.sql`
              "ownerKind" = ${command.resolution.authority.ownerKind}::"StripeEventOwnerKind",
              "routeKey" = ${command.resolution.authority.routeKey}::"StripeEventRouteKey",
              "subjectKind" = ${command.resolution.authority.subjectKind}::"StripeEventSubjectKind",
              "subjectId" = ${command.resolution.authority.subjectId},
            `
          : Prisma.sql`
              "ownerKind" = NULL,
              "routeKey" = NULL,
              "subjectKind" = NULL,
              "subjectId" = NULL,
            `
      const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        UPDATE "WebhookEvent"
        SET "classificationState" = ${command.resolution.state}::"WebhookClassificationState",
            "classificationNextAttemptAt" = NULL,
            "classificationResolvedAt" = ${utcTs(command.now)},
            "classificationErrorCode" = ${errorCode},
            "classificationErrorMessage" = ${errorMessage},
            ${authority}
            ${clearLeaseSql},
            "updatedAt" = ${utcTs(command.now)}
        WHERE ${leaseCasSql(command)}
        RETURNING id
      `)
      return rows.length === 1
    },

    async retryLease(command) {
      const terminal = command.lease.attempt >= command.maxAttempts
      const phaseUpdate =
        command.lease.phase === 'CLASSIFICATION'
          ? terminal
            ? Prisma.sql`
                "classificationState" = 'UNRESOLVED',
                "classificationNextAttemptAt" = NULL,
                "classificationResolvedAt" = ${utcTs(command.now)},
                "classificationErrorCode" = 'CLASSIFICATION_ATTEMPTS_EXHAUSTED',
                "classificationErrorMessage" = 'Webhook classification attempt budget exhausted',
              `
            : Prisma.sql`
                "classificationNextAttemptAt" = ${utcTs(command.nextAttemptAt)},
                "classificationErrorCode" = ${command.errorCode},
                "classificationErrorMessage" = ${command.errorMessage},
              `
          : Prisma.sql`
              status = 'FAILED',
              "effectNextAttemptAt" = ${utcTsOrNull(terminal ? null : command.nextAttemptAt)},
              "errorMessage" = ${command.errorMessage},
            `
      const terminalReason = command.lease.phase === 'CLASSIFICATION' ? 'CLASSIFICATION_ATTEMPTS_EXHAUSTED' : 'EFFECT_ATTEMPTS_EXHAUSTED'
      const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        WITH transitioned AS (
          UPDATE "WebhookEvent"
          SET ${phaseUpdate}
              ${clearLeaseSql},
              "updatedAt" = ${utcTs(command.now)}
          WHERE ${leaseCasSql(command)}
          RETURNING id
        ), alert_insert AS (
          INSERT INTO "WebhookOperationalAlert" (
            "webhookEventId", phase, "terminalReason", attempt, payload, "nextAttemptAt", "createdAt", "updatedAt"
          )
          SELECT
            id,
            ${command.lease.phase}::"WebhookClaimPhase",
            ${terminalReason},
            ${command.lease.attempt},
            jsonb_build_object(
              'webhookEventId', id,
              'phase', ${command.lease.phase},
              'terminalReason', ${terminalReason},
              'attempt', ${command.lease.attempt}
            ),
            ${utcTs(command.now)},
            ${utcTs(command.now)},
            ${utcTs(command.now)}
          FROM transitioned
          WHERE ${terminal}
          ON CONFLICT ("webhookEventId", phase, "terminalReason") DO NOTHING
          RETURNING "webhookEventId"
        )
        SELECT id FROM transitioned
      `)
      return rows.length === 1
    },

    async releaseLease(command) {
      const terminal = command.lease.attempt >= PLATFORM_WEBHOOK_LIMITS.maxAttempts
      const phaseUpdate =
        command.lease.phase === 'CLASSIFICATION'
          ? terminal
            ? Prisma.sql`
                "classificationState" = 'UNRESOLVED',
                "classificationNextAttemptAt" = NULL,
                "classificationResolvedAt" = ${utcTs(command.now)},
                "classificationErrorCode" = 'CLASSIFICATION_ATTEMPTS_EXHAUSTED',
                "classificationErrorMessage" = 'Webhook classification attempt budget exhausted',
              `
            : Prisma.sql`"classificationNextAttemptAt" = ${utcTs(command.now)},`
          : Prisma.sql`
              status = 'FAILED',
              "effectNextAttemptAt" = ${utcTsOrNull(terminal ? null : command.now)},
              "errorMessage" = COALESCE("errorMessage", 'Webhook effect lease released'),
            `
      const terminalReason = command.lease.phase === 'CLASSIFICATION' ? 'CLASSIFICATION_ATTEMPTS_EXHAUSTED' : 'EFFECT_ATTEMPTS_EXHAUSTED'
      const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        WITH transitioned AS (
          UPDATE "WebhookEvent"
          SET ${phaseUpdate}
              ${clearLeaseSql},
              "updatedAt" = ${utcTs(command.now)}
          WHERE ${leaseCasSql(command)}
          RETURNING id
        ), alert_insert AS (
          INSERT INTO "WebhookOperationalAlert" (
            "webhookEventId", phase, "terminalReason", attempt, payload, "nextAttemptAt", "createdAt", "updatedAt"
          )
          SELECT
            id,
            ${command.lease.phase}::"WebhookClaimPhase",
            ${terminalReason},
            ${command.lease.attempt},
            jsonb_build_object(
              'webhookEventId', id,
              'phase', ${command.lease.phase},
              'terminalReason', ${terminalReason},
              'attempt', ${command.lease.attempt}
            ),
            ${utcTs(command.now)},
            ${utcTs(command.now)},
            ${utcTs(command.now)}
          FROM transitioned
          WHERE ${terminal}
          ON CONFLICT ("webhookEventId", phase, "terminalReason") DO NOTHING
          RETURNING "webhookEventId"
        )
        SELECT id FROM transitioned
      `)
      return rows.length === 1
    },

    async completeEffect(command) {
      const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        UPDATE "WebhookEvent"
        SET status = 'SUCCESS',
            "effectNextAttemptAt" = NULL,
            "errorMessage" = NULL,
            "processedAt" = ${utcTs(command.now)},
            "processingTime" = ${command.processingTime ?? null},
            ${clearLeaseSql},
            "updatedAt" = ${utcTs(command.now)}
        WHERE ${leaseCasSql(command)}
        RETURNING id
      `)
      return rows.length === 1
    },

    async finalizeEffectWithObservation(command) {
      const terminal = command.outcome === 'FAILED' && command.lease.attempt >= command.maxAttempts
      const effectState =
        command.outcome === 'SUCCESS'
          ? Prisma.sql`
              status = 'SUCCESS',
              "effectNextAttemptAt" = NULL,
              "errorMessage" = NULL,
              "processedAt" = ${utcTs(command.now)},
              "processingTime" = ${command.processingTime ?? null},
            `
          : Prisma.sql`
              status = 'FAILED',
              "effectNextAttemptAt" = ${utcTsOrNull(terminal ? null : command.nextAttemptAt!)},
              "errorMessage" = ${command.errorMessage},
              "processingTime" = ${command.processingTime ?? null},
            `
      const serializedSteps = JSON.stringify(command.observation.steps)
      const rows = await prisma.$queryRaw<Array<{ transitioned: boolean; observed: boolean }>>(Prisma.sql`
        WITH transitioned AS (
          UPDATE "WebhookEvent"
          SET ${effectState}
              ${clearLeaseSql},
              "updatedAt" = ${utcTs(command.now)}
          WHERE ${leaseCasSql(command)}
          RETURNING id
        ), observation_insert AS (
          INSERT INTO "WebhookDispatchObservation" (
            "webhookEventId", "effectAttempt", steps, "effectOutcome", "failureStep", "comparisonCode", "createdAt"
          )
          SELECT
            transitioned.id,
            ${command.observation.effectAttempt},
            ${serializedSteps}::jsonb,
            ${command.observation.effectOutcome},
            ${command.observation.failureStep ?? null},
            ${command.observation.comparisonCode},
            ${utcTs(command.now)}
          FROM transitioned
          WHERE transitioned.id = ${command.observation.webhookEventId}
          ON CONFLICT ("webhookEventId", "effectAttempt") DO NOTHING
          RETURNING "webhookEventId"
        ), observation_existing AS (
          SELECT observation."webhookEventId"
          FROM "WebhookDispatchObservation" observation
          JOIN transitioned ON transitioned.id = observation."webhookEventId"
          WHERE observation."effectAttempt" = ${command.observation.effectAttempt}
            AND observation.steps = ${serializedSteps}::jsonb
            AND observation."effectOutcome" = ${command.observation.effectOutcome}
            AND observation."failureStep" IS NOT DISTINCT FROM ${command.observation.failureStep ?? null}
            AND observation."comparisonCode" = ${command.observation.comparisonCode}
        ), observation_valid AS (
          SELECT "webhookEventId" FROM observation_insert
          UNION ALL
          SELECT "webhookEventId" FROM observation_existing
        ), observation_guard AS MATERIALIZED (
          SELECT 1 / CASE
            WHEN EXISTS (SELECT 1 FROM transitioned)
             AND NOT EXISTS (SELECT 1 FROM observation_valid)
            THEN 0
            ELSE 1
          END AS valid
        ), alert_insert AS (
          INSERT INTO "WebhookOperationalAlert" (
            "webhookEventId", phase, "terminalReason", attempt, payload, "nextAttemptAt", "createdAt", "updatedAt"
          )
          SELECT
            transitioned.id,
            'EFFECT',
            'EFFECT_ATTEMPTS_EXHAUSTED',
            ${command.lease.attempt},
            jsonb_build_object(
              'webhookEventId', transitioned.id,
              'phase', 'EFFECT',
              'terminalReason', 'EFFECT_ATTEMPTS_EXHAUSTED',
              'attempt', ${command.lease.attempt}
            ),
            ${utcTs(command.now)},
            ${utcTs(command.now)},
            ${utcTs(command.now)}
          FROM transitioned
          WHERE ${terminal}
          ON CONFLICT ("webhookEventId", phase, "terminalReason") DO NOTHING
          RETURNING "webhookEventId"
        )
        SELECT EXISTS(SELECT 1 FROM transitioned) AS transitioned,
               EXISTS(SELECT 1 FROM observation_valid) AS observed,
               (SELECT valid FROM observation_guard)
      `)
      if (rows[0]?.transitioned === true && rows[0]?.observed === true) return true

      // Two identical finalize calls can race on the same live lease. The
      // loser waits for the winner's UPDATE, then its original statement sees
      // no transitioned row. Re-read in a fresh READ COMMITTED snapshot and
      // converge only on the exact attempt, terminal state and observation.
      // A genuinely stale lease has a different attempt after reacquisition,
      // so it cannot satisfy this comparison and still fails closed.
      const terminalAlertRequired = command.outcome === 'FAILED' && terminal
      const converged = await prisma.$queryRaw<Array<{ converged: boolean }>>(Prisma.sql`
        SELECT EXISTS (
          SELECT 1
          FROM "WebhookEvent" event
          JOIN "WebhookDispatchObservation" observation
            ON observation."webhookEventId" = event.id
           AND observation."effectAttempt" = ${command.observation.effectAttempt}
          WHERE event.id = ${command.lease.eventId}
            AND event."effectAttempts" = ${command.lease.attempt}
            AND event."retryCount" = ${command.lease.attempt}
            AND event."claimPhase" IS NULL
            AND event."claimToken" IS NULL
            AND event."claimedBy" IS NULL
            AND event."claimedAt" IS NULL
            AND event."claimExpiresAt" IS NULL
            AND (
              (${command.outcome === 'SUCCESS'} AND event.status = 'SUCCESS' AND event."effectNextAttemptAt" IS NULL
                AND event."processedAt" IS NOT NULL AND event."errorMessage" IS NULL)
              OR
              (${command.outcome === 'FAILED'} AND event.status = 'FAILED'
                AND event."effectNextAttemptAt" IS ${terminal ? Prisma.sql`NULL` : Prisma.sql`NOT NULL`}
                AND event."errorMessage" IS NOT DISTINCT FROM ${command.errorMessage})
            )
            AND event."processingTime" IS NOT DISTINCT FROM ${command.processingTime ?? null}
            AND observation.steps = ${serializedSteps}::jsonb
            AND observation."effectOutcome" = ${command.observation.effectOutcome}
            AND observation."failureStep" IS NOT DISTINCT FROM ${command.observation.failureStep ?? null}
            AND observation."comparisonCode" = ${command.observation.comparisonCode}
            AND (
              NOT ${terminalAlertRequired}
              OR EXISTS (
                SELECT 1 FROM "WebhookOperationalAlert" alert
                WHERE alert."webhookEventId" = event.id
                  AND alert.phase = 'EFFECT'
                  AND alert."terminalReason" = 'EFFECT_ATTEMPTS_EXHAUSTED'
                  AND alert.attempt = ${command.lease.attempt}
              )
            )
        ) AS converged
      `)
      return converged[0]?.converged === true
    },

    async enrichVenue(command) {
      const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        UPDATE "WebhookEvent" event
        SET "venueId" = ${command.venueId},
            "updatedAt" = ${utcTs(command.now)}
        WHERE event.id = ${command.eventId}
          AND (event."venueId" IS NULL OR event."venueId" = ${command.venueId})
          AND EXISTS (SELECT 1 FROM "Venue" venue WHERE venue.id = ${command.venueId})
        RETURNING event.id
      `)
      return rows.length === 1
    },

    async createDispatchObservation(command) {
      const serializedSteps = JSON.stringify(command.steps)
      const inserted = await prisma.$queryRaw<Array<{ createdAt: Date }>>(Prisma.sql`
        INSERT INTO "WebhookDispatchObservation" (
          "webhookEventId", "effectAttempt", steps, "effectOutcome", "failureStep", "comparisonCode", "createdAt"
        ) VALUES (
          ${command.webhookEventId}, ${command.effectAttempt}, ${serializedSteps}::jsonb,
          ${command.effectOutcome}, ${command.failureStep ?? null}, ${command.comparisonCode}, ${utcTs(command.now)}
        )
        ON CONFLICT ("webhookEventId", "effectAttempt") DO NOTHING
        RETURNING "createdAt"
      `)
      const created = Boolean(inserted[0])
      const observed = created
        ? {
            stepsMatches: true,
            effectOutcomeMatches: true,
            failureStepMatches: true,
            comparisonCodeMatches: true,
            createdAt: inserted[0].createdAt,
          }
        : (
            await prisma.$queryRaw<
              Array<{
                stepsMatches: boolean
                effectOutcomeMatches: boolean
                failureStepMatches: boolean
                comparisonCodeMatches: boolean
                createdAt: Date
              }>
            >(Prisma.sql`
              SELECT
                steps = ${serializedSteps}::jsonb AS "stepsMatches",
                "effectOutcome" = ${command.effectOutcome} AS "effectOutcomeMatches",
                "failureStep" IS NOT DISTINCT FROM ${command.failureStep ?? null} AS "failureStepMatches",
                "comparisonCode" = ${command.comparisonCode} AS "comparisonCodeMatches",
                "createdAt"
              FROM "WebhookDispatchObservation"
              WHERE "webhookEventId" = ${command.webhookEventId}
                AND "effectAttempt" = ${command.effectAttempt}
              LIMIT 1
            `)
          )[0]
      if (
        !observed ||
        !observed.stepsMatches ||
        !observed.effectOutcomeMatches ||
        !observed.failureStepMatches ||
        !observed.comparisonCodeMatches
      ) {
        throw new Error(`Webhook dispatch observation conflict: ${command.webhookEventId}/${command.effectAttempt}`)
      }
      return {
        status: created ? 'CREATED' : 'EXISTING',
        observation: { ...command, now: observed.createdAt },
      }
    },

    async acquireOperationalAlertBatch(command) {
      const limit = Math.min(PLATFORM_WEBHOOK_LIMITS.batchSize, Math.max(1, Math.trunc(command.limit)))
      return prisma.$queryRaw<OperationalAlertLease[]>(Prisma.sql`
        WITH candidate AS MATERIALIZED (
          SELECT "webhookEventId", phase, "terminalReason", "nextAttemptAt" AS due_at, "createdAt" AS created_at
          FROM "WebhookOperationalAlert"
          WHERE "deliveredAt" IS NULL
            AND "nextAttemptAt" <= ${utcTs(command.now)}
            AND ("claimToken" IS NULL OR "claimExpiresAt" <= ${utcTs(command.now)})
          ORDER BY "nextAttemptAt" ASC, "createdAt" ASC, "webhookEventId" ASC, phase ASC, "terminalReason" ASC
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        ), updated AS (
          UPDATE "WebhookOperationalAlert" alert
          SET "deliveryAttempts" = alert."deliveryAttempts" + 1,
              "claimToken" = ${command.claimTokenPrefix} || ':' || alert."webhookEventId" || ':' || alert.phase::text,
              "claimedBy" = ${command.claimedBy},
              "claimedAt" = ${utcTs(command.now)},
              "claimExpiresAt" = ${utcTs(command.claimExpiresAt)},
              "updatedAt" = ${utcTs(command.now)}
          FROM candidate
          WHERE alert."webhookEventId" = candidate."webhookEventId"
            AND alert.phase = candidate.phase
            AND alert."terminalReason" = candidate."terminalReason"
          RETURNING
            alert."webhookEventId", alert.phase, alert."terminalReason", alert.attempt, alert.payload,
            alert."deliveryAttempts" AS "deliveryAttempt", alert."claimToken", alert."claimedBy",
            alert."claimedAt", alert."claimExpiresAt"
        )
        SELECT
          updated."webhookEventId" || '|' || updated.phase::text || '|' || updated."terminalReason" AS "alertId",
          updated.*
        FROM updated
        JOIN candidate USING ("webhookEventId", phase, "terminalReason")
        ORDER BY candidate.due_at ASC, candidate.created_at ASC,
                 candidate."webhookEventId" ASC, candidate.phase ASC, candidate."terminalReason" ASC
      `)
    },

    async completeOperationalAlert(command) {
      const rows = await prisma.$queryRaw<Array<{ webhookEventId: string }>>(Prisma.sql`
        UPDATE "WebhookOperationalAlert"
        SET "deliveredAt" = ${utcTs(command.now)},
            "nextAttemptAt" = NULL,
            "claimToken" = NULL,
            "claimedBy" = NULL,
            "claimedAt" = NULL,
            "claimExpiresAt" = NULL,
            "updatedAt" = ${utcTs(command.now)}
        WHERE "webhookEventId" = ${command.lease.webhookEventId}
          AND phase = ${command.lease.phase}::"WebhookClaimPhase"
          AND "terminalReason" = ${command.lease.terminalReason}
          AND "claimToken" = ${command.lease.claimToken}
          AND "claimedBy" = ${command.lease.claimedBy}
          AND "claimExpiresAt" > ${utcTs(command.now)}
        RETURNING "webhookEventId"
      `)
      return rows.length === 1
    },

    async retryOperationalAlert(command) {
      const rows = await prisma.$queryRaw<Array<{ webhookEventId: string }>>(Prisma.sql`
        UPDATE "WebhookOperationalAlert"
        SET "nextAttemptAt" = ${utcTs(command.nextAttemptAt)},
            "claimToken" = NULL,
            "claimedBy" = NULL,
            "claimedAt" = NULL,
            "claimExpiresAt" = NULL,
            "updatedAt" = ${utcTs(command.now)}
        WHERE "webhookEventId" = ${command.lease.webhookEventId}
          AND phase = ${command.lease.phase}::"WebhookClaimPhase"
          AND "terminalReason" = ${command.lease.terminalReason}
          AND "claimToken" = ${command.lease.claimToken}
          AND "claimedBy" = ${command.lease.claimedBy}
          AND "claimExpiresAt" > ${utcTs(command.now)}
          AND "deliveredAt" IS NULL
        RETURNING "webhookEventId"
      `)
      return rows.length === 1
    },

    async createOrCompareBinding(command) {
      type BindingRow = {
        objectType: StripeObjectType
        stripeObjectId: string
        ownerKind: StripeEventOwnerKind
        routeKey: StripeEventRouteKey
        subjectKind: StripeEventSubjectKind
        subjectId: string
        sourceWebhookEventId: string | null
        createdAt: Date
      }
      const inserted = await prisma.$queryRaw<BindingRow[]>(Prisma.sql`
        INSERT INTO "StripeObjectBinding" (
          "objectType", "stripeObjectId", "ownerKind", "routeKey", "subjectKind", "subjectId", "sourceWebhookEventId", "createdAt"
        ) VALUES (
          ${command.objectType}::"StripeObjectType", ${command.stripeObjectId},
          ${command.authority.ownerKind}::"StripeEventOwnerKind", ${command.authority.routeKey}::"StripeEventRouteKey",
          ${command.authority.subjectKind}::"StripeEventSubjectKind", ${command.authority.subjectId},
          ${command.sourceWebhookEventId}, ${utcTs(command.now)}
        )
        ON CONFLICT ("objectType", "stripeObjectId") DO NOTHING
        RETURNING "objectType", "stripeObjectId", "ownerKind", "routeKey", "subjectKind", "subjectId", "sourceWebhookEventId", "createdAt"
      `)
      let row = inserted[0]
      let authorityMatches = true
      const created = Boolean(row)
      if (!row) {
        const observed = await prisma.$queryRaw<Array<BindingRow & { authorityMatches: boolean }>>(Prisma.sql`
          SELECT existing.*,
                 existing."ownerKind" = ${command.authority.ownerKind}::"StripeEventOwnerKind"
                 AND existing."routeKey" = ${command.authority.routeKey}::"StripeEventRouteKey"
                 AND existing."subjectKind" = ${command.authority.subjectKind}::"StripeEventSubjectKind"
                 AND existing."subjectId" = ${command.authority.subjectId} AS "authorityMatches"
          FROM "StripeObjectBinding" existing
          WHERE existing."objectType" = ${command.objectType}::"StripeObjectType"
            AND existing."stripeObjectId" = ${command.stripeObjectId}
          LIMIT 1
        `)
        row = observed[0]
        authorityMatches = observed[0]?.authorityMatches ?? false
      }
      if (!row) throw new Error(`Stripe binding create-or-compare produced no row for ${command.stripeObjectId}`)
      return {
        status: created ? 'CREATED' : 'EXISTING',
        binding: {
          objectType: row.objectType,
          stripeObjectId: row.stripeObjectId,
          authority: {
            ownerKind: row.ownerKind,
            routeKey: row.routeKey,
            subjectKind: row.subjectKind,
            subjectId: row.subjectId,
          },
          sourceWebhookEventId: row.sourceWebhookEventId,
          now: row.createdAt,
        },
        authorityMatches,
      }
    },
  }
}
