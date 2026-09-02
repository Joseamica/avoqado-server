import type { ExtractedSignedPlatformEvent, SignedPlatformEvent, StripeBindingReference } from './platformWebhookClassifier.extractor'
import { extractSignedPlatformEvent } from './platformWebhookClassifier.extractor'
import {
  isAllowedStripeAuthorityTuple,
  isAllowedStripeObjectBindingAuthority,
  type StripeAuthorityTuple,
  type StripeObjectType,
} from './platformWebhookInbox.service'

export interface StoredStripeObjectBinding {
  objectType: StripeObjectType
  stripeObjectId: string
  authority: StripeAuthorityTuple
  sourceWebhookEventId: string | null
}

export interface LocalAuthorityCandidate {
  authority: StripeAuthorityTuple
  source: string
}

export interface FallbackInspection {
  candidates: LocalAuthorityCandidate[]
  creditPackDrain: boolean
}

export type BindingRelationship =
  | 'DIRECT_LOCAL_REFERENCE'
  | 'PROPAGATED_SIGNED_REFERENCE_REQUIRED'
  | 'SUBJECT_MISSING'
  | 'DIRECT_RELATION_INVALID'

export interface DurableSignedWebhookEvent {
  id: string
  stripeEventId: string
  eventType: string
  payload: unknown
}

export interface PlatformWebhookClassificationTransaction {
  findBindings(references: StripeBindingReference[], excludedKeys: ReadonlySet<string>): Promise<StoredStripeObjectBinding[]>
  findFallbackAuthorities(extracted: Extract<ExtractedSignedPlatformEvent, { kind: 'EXTRACTED' }>): Promise<FallbackInspection>
  inspectBindingRelationship(binding: StoredStripeObjectBinding): Promise<BindingRelationship>
  loadDurableSignedEvent(webhookEventId: string): Promise<DurableSignedWebhookEvent | null>
  createOrCompareBindings(bindings: StoredStripeObjectBinding[]): Promise<BindingWriteResult[]>
}

export interface BindingWriteResult {
  status: 'CREATED' | 'EXISTING'
  binding: StoredStripeObjectBinding
}

export interface PlatformWebhookClassificationRepository {
  runInTransaction<T>(work: (tx: PlatformWebhookClassificationTransaction) => Promise<T>): Promise<T>
}

export class BindingBatchConflictError extends Error {
  constructor(
    readonly winner: StoredStripeObjectBinding,
    readonly proposal: StoredStripeObjectBinding,
  ) {
    super(`Immutable Stripe object binding conflicts for ${winner.objectType}/${winner.stripeObjectId}`)
    this.name = 'BindingBatchConflictError'
  }
}

export class BindingValidationError extends Error {
  constructor(
    readonly code: 'BINDING_SUBJECT_INVALID' | 'BINDING_ROUTE_INCOMPATIBLE',
    readonly binding: StoredStripeObjectBinding,
  ) {
    super(`Invalid existing Stripe object binding ${binding.objectType}/${binding.stripeObjectId}: ${code}`)
    this.name = 'BindingValidationError'
  }
}

export class BindingSnapshotRetryError extends Error {
  constructor(objectType: StripeObjectType, stripeObjectId: string) {
    super(`Concurrent binding winner was not visible for ${objectType}/${stripeObjectId}`)
    this.name = 'BindingSnapshotRetryError'
  }
}

export type PlatformWebhookClassificationResult =
  | {
      state: 'CLASSIFIED'
      authority: StripeAuthorityTuple
      candidateCount: number
      candidateSources: string[]
      bindings: StoredStripeObjectBinding[]
    }
  | {
      state: 'PENDING'
      code: 'LOCAL_REFERENCE_NOT_READY'
      candidateCount: number
      candidateSources: string[]
      bindings: StoredStripeObjectBinding[]
    }
  | {
      state: 'IGNORED'
      code: 'EVENT_TYPE_NOT_HANDLED'
      candidateCount: number
      candidateSources: string[]
      bindings: StoredStripeObjectBinding[]
    }
  | {
      state: 'UNRESOLVED'
      code:
        | 'SIGNED_REFERENCE_MISSING'
        | 'SIGNED_EVENT_SHAPE_INVALID'
        | 'MULTIPLE_LOCAL_AUTHORITIES'
        | 'IMMUTABLE_BINDING_CONFLICT'
        | 'BINDING_SUBJECT_INVALID'
        | 'BINDING_ROUTE_INCOMPATIBLE'
        | 'LEGACY_PLATFORM_CREDIT_PACK_DRAIN'
      candidateCount: number
      candidateSources: string[]
      bindings: StoredStripeObjectBinding[]
    }

function authorityKey(authority: StripeAuthorityTuple): string {
  return `${authority.ownerKind}|${authority.routeKey}|${authority.subjectKind}|${authority.subjectId}`
}

function bindingKey(binding: StripeBindingReference): string {
  return `${binding.objectType}|${binding.stripeObjectId}`
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort()
}

function sameAuthority(left: StripeAuthorityTuple, right: StripeAuthorityTuple): boolean {
  return authorityKey(left) === authorityKey(right)
}

function transformedTokenPaymentIntent(authority: StripeAuthorityTuple): StripeAuthorityTuple {
  return {
    ownerKind: 'INDEPENDENT',
    routeKey: 'TOKEN_PAYMENT_INTENT',
    subjectKind: 'TOKEN_PURCHASE',
    subjectId: authority.subjectId,
  }
}

function makeBinding(
  extracted: Extract<ExtractedSignedPlatformEvent, { kind: 'EXTRACTED' }>,
  objectType: StripeObjectType,
  stripeObjectId: string,
  authority: StripeAuthorityTuple,
): StoredStripeObjectBinding {
  return {
    objectType,
    stripeObjectId,
    authority,
    sourceWebhookEventId: extracted.event.webhookEventId,
  }
}

export function deriveBindings(
  extracted: Extract<ExtractedSignedPlatformEvent, { kind: 'EXTRACTED' }>,
  authority: StripeAuthorityTuple,
): StoredStripeObjectBinding[] {
  const bindings: StoredStripeObjectBinding[] = []
  const add = (objectType: StripeObjectType, ids: string[], derivedAuthority = authority) => {
    ids.forEach(stripeObjectId => {
      if (isAllowedStripeObjectBindingAuthority(objectType, derivedAuthority)) {
        bindings.push(makeBinding(extracted, objectType, stripeObjectId, derivedAuthority))
      }
    })
  }

  if (extracted.family === 'CHECKOUT') {
    add('CHECKOUT_SESSION', [extracted.references.rootId])
    if (authority.ownerKind === 'COMMERCIAL_V2') add('SUBSCRIPTION', extracted.references.subscriptionIds)
  }
  if (extracted.family === 'SUBSCRIPTION') add('SUBSCRIPTION', [extracted.references.rootId])
  if (extracted.family === 'INVOICE') {
    add('INVOICE', [extracted.references.rootId])
    if (authority.routeKey === 'TOKEN_INVOICE') {
      add('PAYMENT_INTENT', extracted.references.paymentIntentIds, transformedTokenPaymentIntent(authority))
    } else {
      add('PAYMENT_INTENT', extracted.references.paymentIntentIds)
      add('CHARGE', extracted.references.chargeIds)
    }
  }
  if (extracted.family === 'PAYMENT_INTENT') {
    add('PAYMENT_INTENT', [extracted.references.rootId])
    if (authority.ownerKind !== 'INDEPENDENT') add('CHARGE', extracted.references.chargeIds)
  }
  if (extracted.family === 'CHARGE_REFUND' || extracted.family === 'DISPUTE') {
    if (authority.ownerKind !== 'INDEPENDENT') add('CHARGE', extracted.references.chargeIds)
  }

  const deduplicated = new Map<string, StoredStripeObjectBinding>()
  bindings.forEach(binding => deduplicated.set(bindingKey(binding), binding))
  return [...deduplicated.values()].sort((left, right) => bindingKey(left).localeCompare(bindingKey(right)))
}

interface ResolutionOptions {
  readOnly: boolean
  excludedKeys: ReadonlySet<string>
  visitedKeys: ReadonlySet<string>
  depth: number
}

function emptyResult(
  state: 'PENDING' | 'IGNORED' | 'UNRESOLVED',
  code: Exclude<PlatformWebhookClassificationResult, { state: 'CLASSIFIED' }>['code'],
): PlatformWebhookClassificationResult {
  return { state, code, candidateCount: 0, candidateSources: [], bindings: [] } as PlatformWebhookClassificationResult
}

function durableObject(payload: unknown): unknown | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const data = (payload as Record<string, unknown>).data
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  return (data as Record<string, unknown>).object
}

function eventAcceptsAuthority(
  extracted: Extract<ExtractedSignedPlatformEvent, { kind: 'EXTRACTED' }>,
  binding: StoredStripeObjectBinding,
): boolean {
  if (extracted.family === 'CHARGE_REFUND' || extracted.family === 'DISPUTE') {
    return binding.authority.ownerKind !== 'INDEPENDENT'
  }
  return true
}

async function validatePropagatedBinding(
  tx: PlatformWebhookClassificationTransaction,
  binding: StoredStripeObjectBinding,
  options: ResolutionOptions,
): Promise<boolean> {
  const currentKey = bindingKey(binding)
  if (!binding.sourceWebhookEventId || options.visitedKeys.has(currentKey) || options.depth >= 5) return false
  const durable = await tx.loadDurableSignedEvent(binding.sourceWebhookEventId)
  if (!durable) return false
  const object = durableObject(durable.payload)
  if (object === undefined) return false
  const extracted = extractSignedPlatformEvent({
    webhookEventId: durable.id,
    stripeEventId: durable.stripeEventId,
    type: durable.eventType,
    object,
  })
  if (extracted.kind !== 'EXTRACTED') return false

  const excludedKeys = new Set(options.excludedKeys)
  excludedKeys.add(currentKey)
  const visitedKeys = new Set(options.visitedKeys)
  visitedKeys.add(currentKey)
  const sourceResolution = await resolveWithinTransaction(tx, extracted, {
    readOnly: true,
    excludedKeys,
    visitedKeys,
    depth: options.depth + 1,
  })
  if (sourceResolution.state !== 'CLASSIFIED') return false
  return deriveBindings(extracted, sourceResolution.authority).some(
    candidate => bindingKey(candidate) === currentKey && sameAuthority(candidate.authority, binding.authority),
  )
}

async function bindingValidationCode(
  tx: PlatformWebhookClassificationTransaction,
  extracted: Extract<ExtractedSignedPlatformEvent, { kind: 'EXTRACTED' }>,
  binding: StoredStripeObjectBinding,
  options: ResolutionOptions,
): Promise<'BINDING_SUBJECT_INVALID' | 'BINDING_ROUTE_INCOMPATIBLE' | null> {
  if (!isAllowedStripeObjectBindingAuthority(binding.objectType, binding.authority) || !eventAcceptsAuthority(extracted, binding)) {
    return 'BINDING_ROUTE_INCOMPATIBLE'
  }
  const relationship = await tx.inspectBindingRelationship(binding)
  if (relationship === 'SUBJECT_MISSING' || relationship === 'DIRECT_RELATION_INVALID') {
    return 'BINDING_SUBJECT_INVALID'
  }
  if (relationship === 'PROPAGATED_SIGNED_REFERENCE_REQUIRED' && !(await validatePropagatedBinding(tx, binding, options))) {
    return 'BINDING_SUBJECT_INVALID'
  }
  return null
}

async function resolveWithinTransaction(
  tx: PlatformWebhookClassificationTransaction,
  extracted: Extract<ExtractedSignedPlatformEvent, { kind: 'EXTRACTED' }>,
  options: ResolutionOptions,
): Promise<PlatformWebhookClassificationResult> {
  const [bindings, fallbackInspection] = await Promise.all([
    tx.findBindings(extracted.lookupBindings, options.excludedKeys),
    tx.findFallbackAuthorities(extracted),
  ])

  for (const binding of bindings) {
    const validationCode = await bindingValidationCode(tx, extracted, binding, options)
    if (validationCode) {
      return {
        state: 'UNRESOLVED',
        code: validationCode,
        candidateCount: 0,
        candidateSources: ['IMMUTABLE_BINDING'],
        bindings: [],
      }
    }
  }

  const validFallbacks = fallbackInspection.candidates.filter(candidate => isAllowedStripeAuthorityTuple(candidate.authority))
  const allCandidates = [
    ...bindings.map(binding => ({ authority: binding.authority, source: 'IMMUTABLE_BINDING', binding: true })),
    ...validFallbacks.map(candidate => ({ ...candidate, binding: false })),
  ]
  const uniqueAuthorities = new Map<string, StripeAuthorityTuple>()
  allCandidates.forEach(candidate => uniqueAuthorities.set(authorityKey(candidate.authority), candidate.authority))
  const candidateSources = sortedUnique(allCandidates.map(candidate => candidate.source))
  const candidateCount = uniqueAuthorities.size

  if (candidateCount === 0) {
    if (fallbackInspection.creditPackDrain) {
      return emptyResult('UNRESOLVED', 'LEGACY_PLATFORM_CREDIT_PACK_DRAIN')
    }
    return { state: 'PENDING', code: 'LOCAL_REFERENCE_NOT_READY', candidateCount, candidateSources, bindings: [] }
  }
  if (candidateCount > 1) {
    return {
      state: 'UNRESOLVED',
      code: bindings.length > 0 ? 'IMMUTABLE_BINDING_CONFLICT' : 'MULTIPLE_LOCAL_AUTHORITIES',
      candidateCount,
      candidateSources,
      bindings: [],
    }
  }

  const authority = uniqueAuthorities.values().next().value as StripeAuthorityTuple
  if (options.readOnly) return { state: 'CLASSIFIED', authority, candidateCount, candidateSources, bindings: [] }

  const derived = deriveBindings(extracted, authority)
  const writeResults = derived.length > 0 ? await tx.createOrCompareBindings(derived) : []
  const proposals = new Map(derived.map(binding => [bindingKey(binding), binding]))
  for (const writeResult of writeResults) {
    if (writeResult.status !== 'EXISTING') continue
    const validationCode = await bindingValidationCode(tx, extracted, writeResult.binding, options)
    if (validationCode) throw new BindingValidationError(validationCode, writeResult.binding)
    const proposal = proposals.get(bindingKey(writeResult.binding))
    if (!proposal) throw new Error(`Binding writer returned an unexpected key ${bindingKey(writeResult.binding)}`)
    if (!sameAuthority(writeResult.binding.authority, proposal.authority)) {
      throw new BindingBatchConflictError(writeResult.binding, proposal)
    }
  }
  return {
    state: 'CLASSIFIED',
    authority,
    candidateCount,
    candidateSources,
    bindings: writeResults.map(result => result.binding),
  }
}

export function createPlatformWebhookClassifier(dependencies: {
  repository: PlatformWebhookClassificationRepository
  maxTransactionAttempts?: number
}) {
  const maxTransactionAttempts = dependencies.maxTransactionAttempts ?? 3
  if (!Number.isInteger(maxTransactionAttempts) || maxTransactionAttempts < 1 || maxTransactionAttempts > 10) {
    throw new Error('Classifier transaction attempt limit must be between 1 and 10')
  }

  return {
    async classify(event: SignedPlatformEvent): Promise<PlatformWebhookClassificationResult> {
      const extracted = extractSignedPlatformEvent(event)
      if (extracted.kind === 'IGNORED') return emptyResult('IGNORED', extracted.code)
      if (extracted.kind === 'UNRESOLVED') return emptyResult('UNRESOLVED', extracted.code)

      for (let attempt = 1; attempt <= maxTransactionAttempts; attempt += 1) {
        try {
          return await dependencies.repository.runInTransaction(tx =>
            resolveWithinTransaction(tx, extracted, {
              readOnly: false,
              excludedKeys: new Set(),
              visitedKeys: new Set(),
              depth: 0,
            }),
          )
        } catch (error) {
          if (error instanceof BindingBatchConflictError) {
            const authorities = new Map<string, StripeAuthorityTuple>()
            authorities.set(authorityKey(error.winner.authority), error.winner.authority)
            authorities.set(authorityKey(error.proposal.authority), error.proposal.authority)
            return {
              state: 'UNRESOLVED',
              code: 'IMMUTABLE_BINDING_CONFLICT',
              candidateCount: authorities.size,
              candidateSources: ['DERIVED_BINDING', 'IMMUTABLE_BINDING'],
              bindings: [],
            }
          }
          if (error instanceof BindingValidationError) {
            return {
              state: 'UNRESOLVED',
              code: error.code,
              candidateCount: 0,
              candidateSources: ['DERIVED_BINDING', 'IMMUTABLE_BINDING'],
              bindings: [],
            }
          }
          if (error instanceof BindingSnapshotRetryError && attempt < maxTransactionAttempts) continue
          throw error
        }
      }
      throw new Error('Classifier transaction retry budget exhausted')
    },
  }
}
