import { extractSignedPlatformEvent, type SignedPlatformEvent } from '@/services/stripe-webhooks/platformWebhookClassifier.extractor'

function event(type: string, object: unknown): SignedPlatformEvent {
  return { webhookEventId: 'webhook-local-1', stripeEventId: 'evt_signed_1', type, object }
}

const registeredFixtures: Array<[string, Record<string, unknown>]> = [
  ['checkout.session.completed', { id: 'cs_1' }],
  ['checkout.session.async_payment_succeeded', { id: 'cs_1' }],
  ['checkout.session.async_payment_failed', { id: 'cs_1' }],
  ['customer.subscription.created', { id: 'sub_1' }],
  ['customer.subscription.updated', { id: 'sub_1' }],
  ['customer.subscription.deleted', { id: 'sub_1' }],
  ['customer.subscription.trial_will_end', { id: 'sub_1' }],
  ['invoice.paid', { id: 'in_1' }],
  ['invoice.payment_succeeded', { id: 'in_1' }],
  ['invoice.payment_failed', { id: 'in_1' }],
  ['payment_intent.succeeded', { id: 'pi_1' }],
  ['payment_intent.payment_failed', { id: 'pi_1' }],
  ['charge.refunded', { id: 'ch_1' }],
  ['charge.dispute.created', { id: 'dp_1', charge: 'ch_1' }],
  ['charge.dispute.closed', { id: 'dp_1', charge: 'ch_1' }],
  ['customer.deleted', { id: 'cus_1' }],
  ['payment_method.attached', { id: 'pm_1', customer: 'cus_1' }],
]

describe('P3-1A1b signed Stripe event extraction', () => {
  describe('new classifier contract', () => {
    it.each(registeredFixtures)('recognizes registered event %s without consulting metadata', (type, object) => {
      const result = extractSignedPlatformEvent(event(type, { ...object, metadata: { acceptanceId: 'attacker' } }))

      expect(result.kind).toBe('EXTRACTED')
    })

    it('ignores an unregistered event instead of leaving it pending forever', () => {
      expect(extractSignedPlatformEvent(event('product.created', { id: 'prod_1' }))).toEqual({
        kind: 'IGNORED',
        code: 'EVENT_TYPE_NOT_HANDLED',
      })
    })

    it.each(['constructor', 'toString'])('treats inherited Object key %s as an unregistered event', type => {
      expect(extractSignedPlatformEvent(event(type, { id: 'obj_1' }))).toEqual({
        kind: 'IGNORED',
        code: 'EVENT_TYPE_NOT_HANDLED',
      })
    })

    it('separates a missing signed reference from a malformed signed shape', () => {
      expect(extractSignedPlatformEvent(event('checkout.session.completed', {}))).toEqual({
        kind: 'UNRESOLVED',
        code: 'SIGNED_REFERENCE_MISSING',
      })
      expect(extractSignedPlatformEvent(event('checkout.session.completed', { id: 123 }))).toEqual({
        kind: 'UNRESOLVED',
        code: 'SIGNED_EVENT_SHAPE_INVALID',
      })
      expect(extractSignedPlatformEvent(event('checkout.session.completed', 'cs_1'))).toEqual({
        kind: 'UNRESOLVED',
        code: 'SIGNED_EVENT_SHAPE_INVALID',
      })
      expect(extractSignedPlatformEvent(event('checkout.session.completed', { id: { id: 'cs_expanded_root' } }))).toEqual({
        kind: 'UNRESOLVED',
        code: 'SIGNED_EVENT_SHAPE_INVALID',
      })
    })

    it('rejects a root or expanded reference whose Stripe object discriminator contradicts its signed path', () => {
      expect(extractSignedPlatformEvent(event('checkout.session.completed', { id: 'cs_1', object: 'invoice' }))).toEqual({
        kind: 'UNRESOLVED',
        code: 'SIGNED_EVENT_SHAPE_INVALID',
      })
      expect(
        extractSignedPlatformEvent(
          event('checkout.session.completed', {
            id: 'cs_1',
            object: 'checkout.session',
            subscription: { id: 'sub_1', object: 'customer' },
          }),
        ),
      ).toEqual({ kind: 'UNRESOLVED', code: 'SIGNED_EVENT_SHAPE_INVALID' })
      expect(
        extractSignedPlatformEvent(
          event('checkout.session.completed', {
            id: 'cs_1',
            object: 'checkout.session',
            subscription: { id: 'sub_1', object: 'subscription' },
          }),
        ).kind,
      ).toBe('EXTRACTED')
    })

    it('accepts nullable optional references and string or expanded IDs', () => {
      const absent = extractSignedPlatformEvent(event('checkout.session.completed', { id: 'cs_1' }))
      const nullable = extractSignedPlatformEvent(event('checkout.session.completed', { id: 'cs_1', subscription: null }))
      const stringId = extractSignedPlatformEvent(event('checkout.session.completed', { id: 'cs_1', subscription: 'sub_1' }))
      const expandedId = extractSignedPlatformEvent(event('checkout.session.completed', { id: 'cs_1', subscription: { id: 'sub_1' } }))

      expect(absent.kind).toBe('EXTRACTED')
      expect(nullable.kind).toBe('EXTRACTED')
      expect(stringId.kind === 'EXTRACTED' ? stringId.references.subscriptionIds : []).toEqual(['sub_1'])
      expect(expandedId.kind === 'EXTRACTED' ? expandedId.references.subscriptionIds : []).toEqual(['sub_1'])
    })

    it('extracts old and current invoice references, deduplicating every distinct payment ID', () => {
      const result = extractSignedPlatformEvent(
        event('invoice.paid', {
          id: 'in_1',
          subscription: 'sub_old',
          payment_intent: 'pi_old',
          charge: { id: 'ch_old' },
          subscription_details: { subscription: { id: 'sub_mid' } },
          parent: { subscription_details: { subscription: 'sub_current' } },
          payments: {
            data: [
              { payment: { type: 'payment_intent', payment_intent: 'pi_old' } },
              { payment: { type: 'payment_intent', payment_intent: { id: 'pi_new' } } },
              { payment: { type: 'charge', charge: 'ch_old' } },
              { payment: { type: 'charge', charge: { id: 'ch_new' } } },
            ],
          },
        }),
      )

      expect(result.kind).toBe('EXTRACTED')
      if (result.kind !== 'EXTRACTED') return
      expect(result.references.subscriptionIds).toEqual(['sub_current', 'sub_mid', 'sub_old'])
      expect(result.references.paymentIntentIds).toEqual(['pi_new', 'pi_old'])
      expect(result.references.chargeIds).toEqual(['ch_new', 'ch_old'])
      expect(result.lookupBindings).toEqual([
        { objectType: 'INVOICE', stripeObjectId: 'in_1' },
        { objectType: 'SUBSCRIPTION', stripeObjectId: 'sub_current' },
        { objectType: 'SUBSCRIPTION', stripeObjectId: 'sub_mid' },
        { objectType: 'SUBSCRIPTION', stripeObjectId: 'sub_old' },
      ])
    })

    it('rejects a partially malformed payments array before any local lookup can start', () => {
      expect(
        extractSignedPlatformEvent(
          event('invoice.paid', {
            id: 'in_1',
            payments: { data: [{ payment: { type: 'payment_intent' } }] },
          }),
        ),
      ).toEqual({ kind: 'UNRESOLVED', code: 'SIGNED_EVENT_SHAPE_INVALID' })
      expect(extractSignedPlatformEvent(event('invoice.paid', { id: 'in_1', payments: {} }))).toEqual({
        kind: 'UNRESOLVED',
        code: 'SIGNED_EVENT_SHAPE_INVALID',
      })
    })

    it('extracts PaymentIntent latest_charge and expanded dispute charge without metadata fallbacks', () => {
      const paymentIntent = extractSignedPlatformEvent(
        event('payment_intent.succeeded', {
          id: 'pi_real',
          latest_charge: { id: 'ch_real' },
          metadata: { paymentIntentId: 'pi_fake', chargeId: 'ch_fake' },
        }),
      )
      const dispute = extractSignedPlatformEvent(
        event('charge.dispute.created', {
          id: 'dp_1',
          charge: { id: 'ch_real', payment_intent: { id: 'pi_real' }, metadata: { paymentIntentId: 'pi_fake' } },
        }),
      )

      expect(paymentIntent.kind === 'EXTRACTED' ? paymentIntent.references : null).toMatchObject({
        paymentIntentIds: ['pi_real'],
        chargeIds: ['ch_real'],
      })
      expect(dispute.kind === 'EXTRACTED' ? dispute.lookupBindings : null).toEqual([
        { objectType: 'CHARGE', stripeObjectId: 'ch_real' },
        { objectType: 'PAYMENT_INTENT', stripeObjectId: 'pi_real' },
      ])
    })
  })

  describe('regressions', () => {
    it('never turns an ID found only in metadata into a signed lookup reference', () => {
      const result = extractSignedPlatformEvent(
        event('checkout.session.completed', {
          id: 'cs_real',
          metadata: {
            checkoutSessionId: 'cs_fake',
            subscriptionId: 'sub_fake',
            invoiceId: 'in_fake',
            paymentIntentId: 'pi_fake',
            chargeId: 'ch_fake',
          },
        }),
      )

      expect(result.kind === 'EXTRACTED' ? result.lookupBindings : null).toEqual([
        { objectType: 'CHECKOUT_SESSION', stripeObjectId: 'cs_real' },
      ])
      expect(result.kind === 'EXTRACTED' ? result.references.subscriptionIds : null).toEqual([])
    })
  })
})
