import {
  BindingSnapshotRetryError,
  createPlatformWebhookClassifier,
  deriveBindings,
  type BindingRelationship,
  type BindingWriteResult,
  type DurableSignedWebhookEvent,
  type FallbackInspection,
  type PlatformWebhookClassificationRepository,
  type PlatformWebhookClassificationTransaction,
  type StoredStripeObjectBinding,
} from '@/services/stripe-webhooks/platformWebhookClassifier.service'
import type {
  ExtractedSignedPlatformEvent,
  SignedPlatformEvent,
  StripeBindingReference,
} from '@/services/stripe-webhooks/platformWebhookClassifier.extractor'
import type { StripeAuthorityTuple, StripeObjectType } from '@/services/stripe-webhooks/platformWebhookInbox.service'

const commercial = (subjectId = 'acceptance-1'): StripeAuthorityTuple => ({
  ownerKind: 'COMMERCIAL_V2',
  routeKey: 'COMMERCIAL_SUBSCRIPTION_LIFECYCLE',
  subjectKind: 'COMMERCIAL_ACCEPTANCE',
  subjectId,
})
const legacyOrigin = (subjectId = 'cs_legacy'): StripeAuthorityTuple => ({
  ownerKind: 'LEGACY',
  routeKey: 'LEGACY_PLAN_CHECKOUT',
  subjectKind: 'STRIPE_CHECKOUT_ORIGIN',
  subjectId,
})
const legacyFeature = (subjectId = 'venue-feature-1'): StripeAuthorityTuple => ({
  ownerKind: 'LEGACY',
  routeKey: 'LEGACY_SUBSCRIPTION_LIFECYCLE',
  subjectKind: 'VENUE_FEATURE',
  subjectId,
})
const terminal = (subjectId = 'terminal-order-1'): StripeAuthorityTuple => ({
  ownerKind: 'INDEPENDENT',
  routeKey: 'TERMINAL_ORDER_CHECKOUT',
  subjectKind: 'TERMINAL_ORDER',
  subjectId,
})
const tokenInvoice = (subjectId = 'token-purchase-1'): StripeAuthorityTuple => ({
  ownerKind: 'INDEPENDENT',
  routeKey: 'TOKEN_INVOICE',
  subjectKind: 'TOKEN_PURCHASE',
  subjectId,
})
const tokenPaymentIntent = (subjectId = 'token-purchase-1'): StripeAuthorityTuple => ({
  ownerKind: 'INDEPENDENT',
  routeKey: 'TOKEN_PAYMENT_INTENT',
  subjectKind: 'TOKEN_PURCHASE',
  subjectId,
})

function event(type: string, object: unknown, webhookEventId = 'webhook-current'): SignedPlatformEvent {
  return { webhookEventId, stripeEventId: `evt_${webhookEventId}`, type, object }
}

function binding(
  objectType: StripeObjectType,
  stripeObjectId: string,
  authority: StripeAuthorityTuple,
  sourceWebhookEventId: string | null = null,
): StoredStripeObjectBinding {
  return { objectType, stripeObjectId, authority, sourceWebhookEventId }
}

function key(reference: StripeBindingReference): string {
  return `${reference.objectType}|${reference.stripeObjectId}`
}

class MemoryTransaction implements PlatformWebhookClassificationTransaction {
  readonly bindings = new Map<string, StoredStripeObjectBinding>()
  readonly fallbacks = new Map<string, FallbackInspection>()
  readonly relationships = new Map<string, BindingRelationship>()
  readonly durableEvents = new Map<string, DurableSignedWebhookEvent>()
  readonly lookupLog: string[][] = []
  readonly batchLog: string[][] = []

  async findBindings(references: StripeBindingReference[], excludedKeys: ReadonlySet<string>) {
    this.lookupLog.push(references.map(key))
    return references
      .filter(reference => !excludedKeys.has(key(reference)))
      .map(reference => this.bindings.get(key(reference)))
      .filter((row): row is StoredStripeObjectBinding => Boolean(row))
  }

  async findFallbackAuthorities(extracted: Extract<ExtractedSignedPlatformEvent, { kind: 'EXTRACTED' }>) {
    return this.fallbacks.get(`${extracted.family}|${extracted.references.rootId}`) ?? { candidates: [], creditPackDrain: false }
  }

  async inspectBindingRelationship(row: StoredStripeObjectBinding) {
    return this.relationships.get(key(row)) ?? 'DIRECT_LOCAL_REFERENCE'
  }

  async loadDurableSignedEvent(webhookEventId: string) {
    return this.durableEvents.get(webhookEventId) ?? null
  }

  async createOrCompareBindings(rows: StoredStripeObjectBinding[]) {
    const sortedKeys = rows.map(key)
    this.batchLog.push(sortedKeys)
    const statuses = new Map(rows.map(row => [key(row), this.bindings.has(key(row)) ? 'EXISTING' : 'CREATED'] as const))
    rows.forEach(row => {
      if (!this.bindings.has(key(row))) this.bindings.set(key(row), row)
    })
    return rows.map(
      row =>
        ({
          status: statuses.get(key(row)),
          binding: this.bindings.get(key(row)) as StoredStripeObjectBinding,
        }) as BindingWriteResult,
    )
  }
}

class MemoryRepository implements PlatformWebhookClassificationRepository {
  transactionAttempts = 0
  constructor(readonly tx = new MemoryTransaction()) {}

  async runInTransaction<T>(work: (tx: PlatformWebhookClassificationTransaction) => Promise<T>): Promise<T> {
    this.transactionAttempts += 1
    const before = new Map(this.tx.bindings)
    try {
      return await work(this.tx)
    } catch (error) {
      this.tx.bindings.clear()
      before.forEach((value, keyValue) => this.tx.bindings.set(keyValue, value))
      throw error
    }
  }
}

function fallback(repository: MemoryRepository, family: string, rootId: string, ...authorities: StripeAuthorityTuple[]) {
  repository.tx.fallbacks.set(`${family}|${rootId}`, {
    candidates: authorities.map((authority, index) => ({ authority, source: `FALLBACK_${index + 1}` })),
    creditPackDrain: false,
  })
}

describe('P3-1A1b local platform webhook classifier', () => {
  describe('new classifier behavior', () => {
    it('returns PENDING for a valid signed ID whose local authority is not ready', async () => {
      const repository = new MemoryRepository()
      const result = await createPlatformWebhookClassifier({ repository }).classify(
        event('checkout.session.completed', { id: 'cs_missing', metadata: { acceptanceId: 'fake' } }),
      )

      expect(result).toMatchObject({
        state: 'PENDING',
        code: 'LOCAL_REFERENCE_NOT_READY',
        candidateCount: 0,
        candidateSources: [],
        bindings: [],
      })
      expect(repository.tx.lookupLog).toEqual([['CHECKOUT_SESSION|cs_missing']])
    })

    it.each([
      ['CHECKOUT', 'checkout.session.completed', { id: 'cs_commercial' }, commercial()],
      ['CHECKOUT', 'checkout.session.completed', { id: 'cs_legacy' }, legacyOrigin()],
      ['CHECKOUT', 'checkout.session.completed', { id: 'cs_terminal' }, terminal()],
      ['SUBSCRIPTION', 'customer.subscription.updated', { id: 'sub_legacy' }, legacyFeature()],
      ['INVOICE', 'invoice.paid', { id: 'in_token' }, tokenInvoice()],
      ['PAYMENT_INTENT', 'payment_intent.succeeded', { id: 'pi_token' }, tokenPaymentIntent()],
      [
        'CUSTOMER_DELETED',
        'customer.deleted',
        { id: 'cus_venue' },
        {
          ownerKind: 'LEGACY',
          routeKey: 'VENUE_BILLING_PROFILE',
          subjectKind: 'VENUE',
          subjectId: 'venue-1',
        },
      ],
    ] as const)('classifies the authorized %s route from one exact local tuple', async (family, type, object, authority) => {
      const repository = new MemoryRepository()
      fallback(repository, family, String(object.id), authority)

      const result = await createPlatformWebhookClassifier({ repository }).classify(event(type, object))

      expect(result.state).toBe('CLASSIFIED')
      if (result.state !== 'CLASSIFIED') throw new Error('Expected classified webhook fixture')
      expect(result.authority).toEqual(authority)
      expect(result.candidateCount).toBe(1)
    })

    it('collapses duplicate fallback rows for the same exact authority but reports distinct subjects as ambiguous', async () => {
      const duplicateRepository = new MemoryRepository()
      fallback(duplicateRepository, 'CHECKOUT', 'cs_same', commercial(), commercial())
      const duplicate = await createPlatformWebhookClassifier({ repository: duplicateRepository }).classify(
        event('checkout.session.completed', { id: 'cs_same' }),
      )

      const ambiguousRepository = new MemoryRepository()
      fallback(ambiguousRepository, 'CHECKOUT', 'cs_ambiguous', commercial('acceptance-a'), commercial('acceptance-b'))
      const ambiguous = await createPlatformWebhookClassifier({ repository: ambiguousRepository }).classify(
        event('checkout.session.completed', { id: 'cs_ambiguous' }),
      )

      expect(duplicate).toMatchObject({ state: 'CLASSIFIED', candidateCount: 1 })
      expect(ambiguous).toMatchObject({
        state: 'UNRESOLVED',
        code: 'MULTIPLE_LOCAL_AUTHORITIES',
        candidateCount: 2,
      })
    })

    it('collapses a binding and fallback with the same tuple but rejects any immutable disagreement', async () => {
      const sameRepository = new MemoryRepository()
      sameRepository.tx.bindings.set('SUBSCRIPTION|sub_same', binding('SUBSCRIPTION', 'sub_same', legacyFeature(), null))
      fallback(sameRepository, 'SUBSCRIPTION', 'sub_same', legacyFeature())
      const same = await createPlatformWebhookClassifier({ repository: sameRepository }).classify(
        event('customer.subscription.updated', { id: 'sub_same' }),
      )

      const conflictRepository = new MemoryRepository()
      conflictRepository.tx.bindings.set(
        'SUBSCRIPTION|sub_conflict',
        binding('SUBSCRIPTION', 'sub_conflict', commercial('acceptance-a'), null),
      )
      fallback(conflictRepository, 'SUBSCRIPTION', 'sub_conflict', legacyFeature('venue-feature-b'))
      const conflict = await createPlatformWebhookClassifier({ repository: conflictRepository }).classify(
        event('customer.subscription.updated', { id: 'sub_conflict' }),
      )

      expect(same).toMatchObject({ state: 'CLASSIFIED', authority: legacyFeature(), candidateCount: 1 })
      expect(conflict).toMatchObject({
        state: 'UNRESOLVED',
        code: 'IMMUTABLE_BINDING_CONFLICT',
        candidateCount: 2,
      })
      expect(conflictRepository.tx.batchLog).toEqual([])
    })

    it('rejects a stored binding whose object/route combination is not authorized', async () => {
      const repository = new MemoryRepository()
      repository.tx.bindings.set('CHARGE|ch_bad', binding('CHARGE', 'ch_bad', tokenPaymentIntent(), 'webhook-source'))

      const result = await createPlatformWebhookClassifier({ repository }).classify(event('charge.refunded', { id: 'ch_bad' }))

      expect(result).toMatchObject({ state: 'UNRESOLVED', code: 'BINDING_ROUTE_INCOMPATIBLE' })
      expect(repository.tx.batchLog).toEqual([])
    })

    it('rejects deleted subjects and impossible direct relationships before writing', async () => {
      const deletedRepository = new MemoryRepository()
      const deleted = binding('SUBSCRIPTION', 'sub_deleted', legacyFeature(), null)
      deletedRepository.tx.bindings.set(key(deleted), deleted)
      deletedRepository.tx.relationships.set(key(deleted), 'SUBJECT_MISSING')

      const impossibleRepository = new MemoryRepository()
      const impossible = binding('SUBSCRIPTION', 'sub_wrong', legacyFeature(), null)
      impossibleRepository.tx.bindings.set(key(impossible), impossible)
      impossibleRepository.tx.relationships.set(key(impossible), 'DIRECT_RELATION_INVALID')

      await expect(
        createPlatformWebhookClassifier({ repository: deletedRepository }).classify(
          event('customer.subscription.updated', { id: 'sub_deleted' }),
        ),
      ).resolves.toMatchObject({ state: 'UNRESOLVED', code: 'BINDING_SUBJECT_INVALID' })
      await expect(
        createPlatformWebhookClassifier({ repository: impossibleRepository }).classify(
          event('customer.subscription.updated', { id: 'sub_wrong' }),
        ),
      ).resolves.toMatchObject({ state: 'UNRESOLVED', code: 'BINDING_SUBJECT_INVALID' })
      expect(deletedRepository.tx.batchLog).toEqual([])
      expect(impossibleRepository.tx.batchLog).toEqual([])
    })

    it('replays commercial checkout provenance for a subscription whose direct column is still null', async () => {
      const repository = new MemoryRepository()
      const propagated = binding('SUBSCRIPTION', 'sub_propagated', commercial(), 'webhook-checkout-source')
      repository.tx.bindings.set(key(propagated), propagated)
      repository.tx.relationships.set(key(propagated), 'PROPAGATED_SIGNED_REFERENCE_REQUIRED')
      repository.tx.durableEvents.set('webhook-checkout-source', {
        id: 'webhook-checkout-source',
        stripeEventId: 'evt_checkout_source',
        eventType: 'checkout.session.completed',
        payload: { data: { object: { id: 'cs_source', subscription: 'sub_propagated' } } },
      })
      fallback(repository, 'CHECKOUT', 'cs_source', commercial())

      const result = await createPlatformWebhookClassifier({ repository }).classify(
        event('customer.subscription.updated', { id: 'sub_propagated' }),
      )

      expect(result).toMatchObject({ state: 'CLASSIFIED', authority: commercial() })
      expect(repository.tx.lookupLog).toContainEqual(['CHECKOUT_SESSION|cs_source'])
    })

    it('replays invoice provenance for a token PaymentIntent whose direct column is still null', async () => {
      const repository = new MemoryRepository()
      const propagated = binding('PAYMENT_INTENT', 'pi_token_propagated', tokenPaymentIntent(), 'webhook-invoice-source')
      repository.tx.bindings.set(key(propagated), propagated)
      repository.tx.relationships.set(key(propagated), 'PROPAGATED_SIGNED_REFERENCE_REQUIRED')
      repository.tx.durableEvents.set('webhook-invoice-source', {
        id: 'webhook-invoice-source',
        stripeEventId: 'evt_invoice_source',
        eventType: 'invoice.paid',
        payload: {
          data: {
            object: {
              id: 'in_source',
              payments: { data: [{ payment: { type: 'payment_intent', payment_intent: 'pi_token_propagated' } }] },
            },
          },
        },
      })
      fallback(repository, 'INVOICE', 'in_source', tokenInvoice())

      const result = await createPlatformWebhookClassifier({ repository }).classify(
        event('payment_intent.succeeded', { id: 'pi_token_propagated' }),
      )

      expect(result).toMatchObject({ state: 'CLASSIFIED', authority: tokenPaymentIntent() })
    })

    it.each([
      ['missing provenance', null, undefined],
      [
        'manipulated provenance',
        'webhook-manipulated',
        {
          id: 'webhook-manipulated',
          stripeEventId: 'evt_manipulated',
          eventType: 'checkout.session.completed',
          payload: { data: { object: { id: 'cs_other', subscription: 'sub_other' } } },
        },
      ],
    ] as const)('rejects %s instead of allowing a binding to prove itself', async (_name, sourceId, durable) => {
      const repository = new MemoryRepository()
      const row = binding('SUBSCRIPTION', 'sub_unproven', commercial(), sourceId)
      repository.tx.bindings.set(key(row), row)
      repository.tx.relationships.set(key(row), 'PROPAGATED_SIGNED_REFERENCE_REQUIRED')
      if (durable) repository.tx.durableEvents.set(durable.id, durable)

      const result = await createPlatformWebhookClassifier({ repository }).classify(
        event('customer.subscription.updated', { id: 'sub_unproven' }),
      )

      expect(result).toMatchObject({ state: 'UNRESOLVED', code: 'BINDING_SUBJECT_INVALID' })
      expect(repository.tx.batchLog).toEqual([])
    })

    it.each([
      ['missing token provenance', null, undefined],
      [
        'manipulated token provenance',
        'webhook-token-manipulated',
        {
          id: 'webhook-token-manipulated',
          stripeEventId: 'evt_token_manipulated',
          eventType: 'invoice.paid',
          payload: {
            data: {
              object: {
                id: 'in_other',
                payment_intent: 'pi_other',
              },
            },
          },
        },
      ],
    ] as const)('rejects %s when a token PI direct column is null', async (_name, sourceId, durable) => {
      const repository = new MemoryRepository()
      const row = binding('PAYMENT_INTENT', 'pi_token_unproven', tokenPaymentIntent(), sourceId)
      repository.tx.bindings.set(key(row), row)
      repository.tx.relationships.set(key(row), 'PROPAGATED_SIGNED_REFERENCE_REQUIRED')
      if (durable) repository.tx.durableEvents.set(durable.id, durable)

      const result = await createPlatformWebhookClassifier({ repository }).classify(
        event('payment_intent.succeeded', { id: 'pi_token_unproven' }),
      )

      expect(result).toMatchObject({ state: 'UNRESOLVED', code: 'BINDING_SUBJECT_INVALID' })
      expect(repository.tx.batchLog).toEqual([])
    })

    it.each([
      ['missing', null],
      ['manipulated', 'webhook-target-manipulated'],
    ] as const)('rejects an existing derived target with %s provenance and rolls back the complete batch', async (_name, sourceId) => {
      const repository = new MemoryRepository()
      const target = binding('PAYMENT_INTENT', 'pi_existing_target', tokenPaymentIntent(), sourceId)
      repository.tx.bindings.set(key(target), target)
      repository.tx.relationships.set(key(target), 'PROPAGATED_SIGNED_REFERENCE_REQUIRED')
      if (sourceId) {
        repository.tx.durableEvents.set(sourceId, {
          id: sourceId,
          stripeEventId: `evt_${sourceId}`,
          eventType: 'invoice.paid',
          payload: { data: { object: { id: 'in_manipulated', payment_intent: 'pi_different' } } },
        })
      }
      fallback(repository, 'INVOICE', 'in_target', tokenInvoice())

      const result = await createPlatformWebhookClassifier({ repository }).classify(
        event('invoice.paid', { id: 'in_target', payment_intent: 'pi_existing_target' }),
      )

      expect(result).toMatchObject({ state: 'UNRESOLVED', code: 'BINDING_SUBJECT_INVALID' })
      expect(repository.tx.bindings.has('INVOICE|in_target')).toBe(false)
    })

    it('reports an invalid existing target matrix before comparing its authority and rolls back', async () => {
      const repository = new MemoryRepository()
      const target = binding('PAYMENT_INTENT', 'pi_invalid_target_route', legacyOrigin(), null)
      repository.tx.bindings.set(key(target), target)
      fallback(repository, 'INVOICE', 'in_invalid_target_route', tokenInvoice())

      const result = await createPlatformWebhookClassifier({ repository }).classify(
        event('invoice.paid', { id: 'in_invalid_target_route', payment_intent: 'pi_invalid_target_route' }),
      )

      expect(result).toMatchObject({ state: 'UNRESOLVED', code: 'BINDING_ROUTE_INCOMPATIBLE' })
      expect(repository.tx.bindings.has('INVOICE|in_invalid_target_route')).toBe(false)
    })

    it('returns the post-fulfillment credit-pack drain marker without creating authority or binding', async () => {
      const repository = new MemoryRepository()
      repository.tx.fallbacks.set('CHECKOUT|cs_credit_pack', { candidates: [], creditPackDrain: true })

      const result = await createPlatformWebhookClassifier({ repository }).classify(
        event('checkout.session.completed', {
          id: 'cs_credit_pack',
          metadata: { type: 'credit_pack_purchase', purchaseId: 'attacker-controlled' },
        }),
      )

      expect(result).toMatchObject({
        state: 'UNRESOLVED',
        code: 'LEGACY_PLATFORM_CREDIT_PACK_DRAIN',
        candidateCount: 0,
        bindings: [],
      })
      expect(repository.tx.batchLog).toEqual([])
    })

    it('prefers a valid local authority over the legacy credit-pack drain marker', async () => {
      const repository = new MemoryRepository()
      repository.tx.fallbacks.set('CHECKOUT|cs_credit_and_terminal', {
        candidates: [{ authority: terminal(), source: 'TERMINAL_ORDER' }],
        creditPackDrain: true,
      })

      const result = await createPlatformWebhookClassifier({ repository }).classify(
        event('checkout.session.completed', { id: 'cs_credit_and_terminal' }),
      )

      expect(result).toMatchObject({ state: 'CLASSIFIED', authority: terminal() })
    })

    it('classifies malformed signed input before opening a transaction or writing a partial batch', async () => {
      const repository = new MemoryRepository()
      const result = await createPlatformWebhookClassifier({ repository }).classify(
        event('invoice.paid', {
          id: 'in_malformed',
          payments: {
            data: [{ payment: { type: 'payment_intent', payment_intent: 'pi_valid' } }, { payment: { type: 'charge' } }],
          },
        }),
      )

      expect(result).toEqual({
        state: 'UNRESOLVED',
        code: 'SIGNED_EVENT_SHAPE_INVALID',
        candidateCount: 0,
        candidateSources: [],
        bindings: [],
      })
      expect(repository.transactionAttempts).toBe(0)
    })

    it('rejects an expanded root ID before opening a transaction', async () => {
      const repository = new MemoryRepository()

      const result = await createPlatformWebhookClassifier({ repository }).classify(
        event('checkout.session.completed', { id: { id: 'cs_expanded_root' } }),
      )

      expect(result).toMatchObject({ state: 'UNRESOLVED', code: 'SIGNED_EVENT_SHAPE_INVALID' })
      expect(repository.transactionAttempts).toBe(0)
    })

    it('rolls back the logical result when any immutable batch key conflicts', async () => {
      const repository = new MemoryRepository()
      fallback(repository, 'INVOICE', 'in_conflict', commercial())
      const conflictingWinner = binding('CHARGE', 'ch_conflict', legacyFeature(), 'webhook-winner')
      repository.tx.bindings.set(key(conflictingWinner), conflictingWinner)
      repository.tx.relationships.set(key(conflictingWinner), 'DIRECT_LOCAL_REFERENCE')

      const result = await createPlatformWebhookClassifier({ repository }).classify(
        event('invoice.paid', {
          id: 'in_conflict',
          payment_intent: 'pi_new',
          charge: 'ch_conflict',
        }),
      )

      expect(result).toMatchObject({ state: 'UNRESOLVED', code: 'IMMUTABLE_BINDING_CONFLICT' })
      expect(result).toMatchObject({
        candidateCount: 2,
        candidateSources: ['DERIVED_BINDING', 'IMMUTABLE_BINDING'],
      })
      expect(repository.tx.batchLog[0]).toEqual(['CHARGE|ch_conflict', 'INVOICE|in_conflict', 'PAYMENT_INTENT|pi_new'])
    })

    it('retries the complete transaction from a fresh snapshot when a unique winner is not visible yet', async () => {
      const memory = new MemoryRepository()
      fallback(memory, 'CHECKOUT', 'cs_fresh_snapshot', commercial())
      let attempts = 0
      const repository: PlatformWebhookClassificationRepository = {
        async runInTransaction(work) {
          attempts += 1
          if (attempts === 1) throw new BindingSnapshotRetryError('CHECKOUT_SESSION', 'cs_fresh_snapshot')
          return work(memory.tx)
        },
      }

      const result = await createPlatformWebhookClassifier({ repository, maxTransactionAttempts: 2 }).classify(
        event('checkout.session.completed', { id: 'cs_fresh_snapshot' }),
      )

      expect(result).toMatchObject({ state: 'CLASSIFIED', authority: commercial() })
      expect(attempts).toBe(2)
    })

    it('rejects circular provenance when a binding can only rediscover itself', async () => {
      const repository = new MemoryRepository()
      const circular = binding('SUBSCRIPTION', 'sub_cycle', commercial(), 'webhook-cycle')
      repository.tx.bindings.set(key(circular), circular)
      repository.tx.relationships.set(key(circular), 'PROPAGATED_SIGNED_REFERENCE_REQUIRED')
      repository.tx.durableEvents.set('webhook-cycle', {
        id: 'webhook-cycle',
        stripeEventId: 'evt_cycle',
        eventType: 'customer.subscription.updated',
        payload: { data: { object: { id: 'sub_cycle' } } },
      })

      const result = await createPlatformWebhookClassifier({ repository }).classify(
        event('customer.subscription.updated', { id: 'sub_cycle' }),
      )

      expect(result).toMatchObject({ state: 'UNRESOLVED', code: 'BINDING_SUBJECT_INVALID' })
      expect(repository.tx.batchLog).toEqual([])
    })
  })

  describe('binding derivation', () => {
    it('propagates a commercial checkout to its signed subscription', () => {
      const extracted = {
        kind: 'EXTRACTED',
        family: 'CHECKOUT',
        event: event('checkout.session.completed', { id: 'cs_1', subscription: 'sub_1' }),
        references: {
          rootId: 'cs_1',
          subscriptionIds: ['sub_1'],
          invoiceIds: [],
          paymentIntentIds: [],
          chargeIds: [],
          customerIds: [],
        },
        lookupBindings: [{ objectType: 'CHECKOUT_SESSION', stripeObjectId: 'cs_1' }],
      } satisfies Extract<ExtractedSignedPlatformEvent, { kind: 'EXTRACTED' }>

      expect(deriveBindings(extracted, commercial())).toEqual([
        binding('CHECKOUT_SESSION', 'cs_1', commercial(), 'webhook-current'),
        binding('SUBSCRIPTION', 'sub_1', commercial(), 'webhook-current'),
      ])
    })

    it.each([
      ['legacy', legacyOrigin()],
      ['terminal', terminal()],
    ] as const)('binds only the checkout session for %s checkout', (_name, authority) => {
      const extracted = {
        kind: 'EXTRACTED',
        family: 'CHECKOUT',
        event: event('checkout.session.completed', { id: 'cs_1', subscription: 'sub_ignored' }),
        references: {
          rootId: 'cs_1',
          subscriptionIds: ['sub_ignored'],
          invoiceIds: [],
          paymentIntentIds: [],
          chargeIds: [],
          customerIds: [],
        },
        lookupBindings: [{ objectType: 'CHECKOUT_SESSION', stripeObjectId: 'cs_1' }],
      } satisfies Extract<ExtractedSignedPlatformEvent, { kind: 'EXTRACTED' }>

      expect(deriveBindings(extracted, authority)).toEqual([binding('CHECKOUT_SESSION', 'cs_1', authority, 'webhook-current')])
    })

    it('transforms token invoice authority to token PaymentIntent and never creates CHARGE', () => {
      const extracted = {
        kind: 'EXTRACTED',
        family: 'INVOICE',
        event: event('invoice.paid', { id: 'in_1' }),
        references: {
          rootId: 'in_1',
          subscriptionIds: [],
          invoiceIds: ['in_1'],
          paymentIntentIds: ['pi_1'],
          chargeIds: ['ch_must_not_bind'],
          customerIds: [],
        },
        lookupBindings: [{ objectType: 'INVOICE', stripeObjectId: 'in_1' }],
      } satisfies Extract<ExtractedSignedPlatformEvent, { kind: 'EXTRACTED' }>

      expect(deriveBindings(extracted, tokenInvoice())).toEqual([
        binding('INVOICE', 'in_1', tokenInvoice(), 'webhook-current'),
        binding('PAYMENT_INTENT', 'pi_1', tokenPaymentIntent(), 'webhook-current'),
      ])
    })

    it('derives all distinct invoice payments and PaymentIntent latest_charge for commercial and legacy lifecycle routes', () => {
      const invoice = {
        kind: 'EXTRACTED',
        family: 'INVOICE',
        event: event('invoice.paid', { id: 'in_1' }),
        references: {
          rootId: 'in_1',
          subscriptionIds: [],
          invoiceIds: ['in_1'],
          paymentIntentIds: ['pi_1', 'pi_2'],
          chargeIds: ['ch_1', 'ch_2'],
          customerIds: [],
        },
        lookupBindings: [{ objectType: 'INVOICE', stripeObjectId: 'in_1' }],
      } satisfies Extract<ExtractedSignedPlatformEvent, { kind: 'EXTRACTED' }>
      const paymentIntent = {
        ...invoice,
        family: 'PAYMENT_INTENT',
        event: event('payment_intent.succeeded', { id: 'pi_1' }),
        references: { ...invoice.references, rootId: 'pi_1', invoiceIds: [], paymentIntentIds: ['pi_1'], chargeIds: ['ch_1'] },
        lookupBindings: [{ objectType: 'PAYMENT_INTENT', stripeObjectId: 'pi_1' }],
      } satisfies Extract<ExtractedSignedPlatformEvent, { kind: 'EXTRACTED' }>

      expect(deriveBindings(invoice, legacyFeature()).map(key)).toEqual([
        'CHARGE|ch_1',
        'CHARGE|ch_2',
        'INVOICE|in_1',
        'PAYMENT_INTENT|pi_1',
        'PAYMENT_INTENT|pi_2',
      ])
      expect(deriveBindings(paymentIntent, commercial()).map(key)).toEqual(['CHARGE|ch_1', 'PAYMENT_INTENT|pi_1'])
      expect(deriveBindings(paymentIntent, tokenPaymentIntent()).map(key)).toEqual(['PAYMENT_INTENT|pi_1'])
    })
  })

  describe('regressions', () => {
    it('does not allow a caller or metadata to inject final authority', async () => {
      const repository = new MemoryRepository()
      const result = await createPlatformWebhookClassifier({ repository }).classify(
        event('checkout.session.completed', {
          id: 'cs_real',
          authority: commercial('caller-injected'),
          metadata: { acceptanceId: 'caller-injected', ownerKind: 'COMMERCIAL_V2' },
        }),
      )

      expect(result).toMatchObject({ state: 'PENDING', code: 'LOCAL_REFERENCE_NOT_READY' })
      expect(repository.tx.lookupLog).toEqual([['CHECKOUT_SESSION|cs_real']])
    })

    it('keeps first provenance when the same tuple is observed again', async () => {
      const repository = new MemoryRepository()
      const first = binding('SUBSCRIPTION', 'sub_same', commercial(), 'webhook-first')
      repository.tx.bindings.set(key(first), first)
      repository.tx.relationships.set(key(first), 'DIRECT_LOCAL_REFERENCE')
      fallback(repository, 'SUBSCRIPTION', 'sub_same', commercial())

      const result = await createPlatformWebhookClassifier({ repository }).classify(
        event('customer.subscription.updated', { id: 'sub_same' }, 'webhook-second'),
      )

      expect(result.state).toBe('CLASSIFIED')
      expect(repository.tx.bindings.get(key(first))?.sourceWebhookEventId).toBe('webhook-first')
    })
  })
})
