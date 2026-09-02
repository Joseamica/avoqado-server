import { createPlatformWebhookClassifier } from '@/services/stripe-webhooks/platformWebhookClassifier.service'
import { createPrismaPlatformWebhookClassificationRepository } from '@/services/stripe-webhooks/platformWebhookClassifier.prisma'
import { persistSignedEvent, withClassifierDatabase } from './platform-webhook-classifier-harness'

jest.setTimeout(180_000)

describe('P3-1A1b classifier — real PostgreSQL', () => {
  it('resolves every local authority with DISTINCT-before-LIMIT ambiguity and non-unique indexes', async () => {
    const proof = await withClassifierDatabase(async ({ first, sql }) => {
      await sql.query(`
        INSERT INTO "CommercialQuoteAcceptance" (id) VALUES ('acceptance-a'), ('acceptance-b');
        INSERT INTO "CommercialStripeOperation" (id, "acceptanceId", "stripeCheckoutSessionId", "stripeSubscriptionId") VALUES
          ('op-checkout', 'acceptance-a', 'cs_commercial', NULL),
          ('op-same-1', 'acceptance-a', NULL, 'sub_same'),
          ('op-same-2', 'acceptance-a', NULL, 'sub_same'),
          ('op-amb-a1', 'acceptance-a', NULL, 'sub_ambiguous'),
          ('op-amb-a2', 'acceptance-a', NULL, 'sub_ambiguous'),
          ('op-amb-b', 'acceptance-b', NULL, 'sub_ambiguous');
        INSERT INTO "StripeCheckoutOrigin" (
          "stripeCheckoutSessionId", "ownerKind", "routeKey", "venueId", "featureId", "stripeCustomerId", "billingInterval"
        ) VALUES ('cs_legacy', 'LEGACY', 'LEGACY_PLAN_CHECKOUT', 'venue-1', 'feature-1', 'cus_venue_1', 'MONTHLY');
        INSERT INTO "TerminalOrder" (id, "stripeCheckoutSessionId") VALUES
          ('terminal-1', 'cs_terminal'),
          ('terminal-duplicate-a', 'cs_terminal_duplicate'),
          ('terminal-duplicate-b', 'cs_terminal_duplicate');
        INSERT INTO "TokenPurchase" (id, "stripeInvoiceId", "stripePaymentIntentId") VALUES
          ('token-invoice', 'in_token', NULL),
          ('token-pi', NULL, 'pi_token'),
          ('token-duplicate-a', 'in_token_duplicate', NULL),
          ('token-duplicate-b', 'in_token_duplicate', NULL);
      `)
      const classifier = createPlatformWebhookClassifier({
        repository: createPrismaPlatformWebhookClassificationRepository(first),
      })
      const classify = async (type: string, object: unknown, suffix: string) =>
        classifier.classify(await persistSignedEvent(sql, type, object, suffix))

      const commercial = await classify(
        'checkout.session.completed',
        { id: 'cs_commercial', metadata: { acceptanceId: 'acceptance-b' } },
        'commercial',
      )
      const legacy = await classify('checkout.session.completed', { id: 'cs_legacy', subscription: 'sub_must_not_bind' }, 'legacy')
      const terminal = await classify('checkout.session.completed', { id: 'cs_terminal' }, 'terminal')
      const subscriptionBeforeFulfill = await classify('customer.subscription.created', { id: 'sub_after_fulfill' }, 'subscription_pending')
      await sql.query(`INSERT INTO "VenueFeature" (id, "stripeSubscriptionId") VALUES ('vf-after-fulfill', 'sub_after_fulfill')`)
      const subscriptionAfterFulfill = await classifier.classify({
        webhookEventId: 'we_subscription_pending',
        stripeEventId: 'evt_subscription_pending',
        type: 'customer.subscription.created',
        object: { id: 'sub_after_fulfill' },
      })
      const invoicePendingEvent = await persistSignedEvent(
        sql,
        'invoice.paid',
        { id: 'in_after_fulfill', subscription: 'sub_invoice_after_fulfill' },
        'invoice_pending',
      )
      const invoiceBeforeFulfill = await classifier.classify(invoicePendingEvent)
      await sql.query(
        `INSERT INTO "VenueFeature" (id, "stripeSubscriptionId") VALUES ('vf-invoice-after-fulfill', 'sub_invoice_after_fulfill')`,
      )
      const invoiceAfterFulfill = await classifier.classify(invoicePendingEvent)
      const sameAcceptance = await classify('customer.subscription.updated', { id: 'sub_same' }, 'sub_same')
      const distinctAcceptance = await classify('customer.subscription.updated', { id: 'sub_ambiguous' }, 'sub_ambiguous')
      const terminalAmbiguous = await classify('checkout.session.completed', { id: 'cs_terminal_duplicate' }, 'terminal_ambiguous')
      const tokenInvoice = await classify('invoice.paid', { id: 'in_token' }, 'token_invoice')
      const tokenPaymentIntent = await classify('payment_intent.succeeded', { id: 'pi_token' }, 'token_pi')
      const tokenInvoiceAmbiguous = await classify('invoice.paid', { id: 'in_token_duplicate' }, 'token_invoice_ambiguous')
      const customerDeleted = await classify('customer.deleted', { id: 'cus_venue_1' }, 'customer_deleted')
      const paymentMethod = await classify('payment_method.attached', { id: 'pm_1', customer: { id: 'cus_venue_2' } }, 'payment_method')
      const metadataOnly = await classify(
        'checkout.session.completed',
        { id: 'cs_unknown', metadata: { acceptanceId: 'acceptance-a', terminalOrderId: 'terminal-1' } },
        'metadata_only',
      )
      const legacyBindings = await sql.query(
        `SELECT "objectType", "stripeObjectId" FROM "StripeObjectBinding" WHERE "sourceWebhookEventId" = 'we_legacy' ORDER BY 1, 2`,
      )
      const indexes = await sql.query(`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE indexname IN ('TerminalOrder_stripeCheckoutSessionId_idx', 'TokenPurchase_stripeInvoiceId_idx')
        ORDER BY indexname
      `)
      const duplicates = await sql.query(`
        SELECT
          (SELECT count(*)::integer FROM "TerminalOrder" WHERE "stripeCheckoutSessionId" = 'cs_terminal_duplicate') terminal_count,
          (SELECT count(*)::integer FROM "TokenPurchase" WHERE "stripeInvoiceId" = 'in_token_duplicate') token_count
      `)

      return {
        commercial,
        legacy,
        terminal,
        subscriptionBeforeFulfill,
        subscriptionAfterFulfill,
        invoiceBeforeFulfill,
        invoiceAfterFulfill,
        sameAcceptance,
        distinctAcceptance,
        terminalAmbiguous,
        tokenInvoice,
        tokenPaymentIntent,
        tokenInvoiceAmbiguous,
        customerDeleted,
        paymentMethod,
        metadataOnly,
        legacyBindings: legacyBindings.rows,
        indexes: indexes.rows,
        duplicates: duplicates.rows[0],
      }
    })

    expect(proof.cleanupConfirmed).toBe(true)
    expect(proof.residualCount).toBe(0)
    expect(proof.result.commercial).toMatchObject({
      state: 'CLASSIFIED',
      authority: { ownerKind: 'COMMERCIAL_V2', subjectId: 'acceptance-a' },
    })
    expect(proof.result.legacy).toMatchObject({
      state: 'CLASSIFIED',
      authority: { routeKey: 'LEGACY_PLAN_CHECKOUT', subjectKind: 'STRIPE_CHECKOUT_ORIGIN' },
    })
    expect(proof.result.terminal).toMatchObject({ state: 'CLASSIFIED', authority: { subjectId: 'terminal-1' } })
    expect(proof.result.subscriptionBeforeFulfill).toMatchObject({ state: 'PENDING', code: 'LOCAL_REFERENCE_NOT_READY' })
    expect(proof.result.subscriptionAfterFulfill).toMatchObject({
      state: 'CLASSIFIED',
      authority: { routeKey: 'LEGACY_SUBSCRIPTION_LIFECYCLE', subjectId: 'vf-after-fulfill' },
    })
    expect(proof.result.invoiceBeforeFulfill).toMatchObject({ state: 'PENDING', code: 'LOCAL_REFERENCE_NOT_READY' })
    expect(proof.result.invoiceAfterFulfill).toMatchObject({
      state: 'CLASSIFIED',
      authority: { routeKey: 'LEGACY_SUBSCRIPTION_LIFECYCLE', subjectId: 'vf-invoice-after-fulfill' },
    })
    expect(proof.result.sameAcceptance).toMatchObject({ state: 'CLASSIFIED', candidateCount: 1 })
    expect(proof.result.distinctAcceptance).toMatchObject({ state: 'UNRESOLVED', code: 'MULTIPLE_LOCAL_AUTHORITIES' })
    expect(proof.result.terminalAmbiguous).toMatchObject({ state: 'UNRESOLVED', code: 'MULTIPLE_LOCAL_AUTHORITIES' })
    expect(proof.result.tokenInvoice).toMatchObject({ state: 'CLASSIFIED', authority: { routeKey: 'TOKEN_INVOICE' } })
    expect(proof.result.tokenPaymentIntent).toMatchObject({
      state: 'CLASSIFIED',
      authority: { routeKey: 'TOKEN_PAYMENT_INTENT' },
    })
    expect(proof.result.tokenInvoiceAmbiguous).toMatchObject({ state: 'UNRESOLVED', code: 'MULTIPLE_LOCAL_AUTHORITIES' })
    expect(proof.result.customerDeleted).toMatchObject({ state: 'CLASSIFIED', authority: { subjectId: 'venue-1' } })
    expect(proof.result.paymentMethod).toMatchObject({ state: 'CLASSIFIED', authority: { subjectId: 'venue-2' } })
    expect(proof.result.metadataOnly).toMatchObject({ state: 'PENDING', code: 'LOCAL_REFERENCE_NOT_READY' })
    expect(proof.result.legacyBindings).toEqual([{ objectType: 'CHECKOUT_SESSION', stripeObjectId: 'cs_legacy' }])
    expect(proof.result.indexes).toHaveLength(2)
    expect(proof.result.indexes.every((index: { indexdef: string }) => !index.indexdef.includes('UNIQUE'))).toBe(true)
    expect(proof.result.duplicates).toEqual({ terminal_count: 2, token_count: 2 })
  })

  it('validates durable provenance, current invoice shapes, refunds/disputes, token transforms and credit-pack drain', async () => {
    const proof = await withClassifierDatabase(async ({ first, sql }) => {
      await sql.query(`
        INSERT INTO "CommercialQuoteAcceptance" (id) VALUES
          ('acceptance-provenance'), ('acceptance-bad'), ('acceptance-null-provenance');
        INSERT INTO "CommercialStripeOperation" (id, "acceptanceId", "stripeCheckoutSessionId", "stripeSubscriptionId") VALUES
          ('op-provenance', 'acceptance-provenance', 'cs_provenance', NULL),
          ('op-bad', 'acceptance-bad', 'cs_bad_source', NULL),
          ('op-null-provenance', 'acceptance-null-provenance', 'cs_null_provenance', NULL);
        INSERT INTO "VenueFeature" (id, "stripeSubscriptionId") VALUES ('vf-invoice', 'sub_invoice');
        INSERT INTO "TokenPurchase" (id, "stripeInvoiceId", "stripePaymentIntentId") VALUES
          ('token-provenance', 'in_token_provenance', NULL),
          ('token-refund', NULL, 'pi_token_refund');
      `)
      const classifier = createPlatformWebhookClassifier({
        repository: createPrismaPlatformWebhookClassificationRepository(first),
      })
      const classify = async (type: string, object: unknown, suffix: string) =>
        classifier.classify(await persistSignedEvent(sql, type, object, suffix))

      const currentInvoice = await classify(
        'invoice.paid',
        {
          id: 'in_current',
          parent: { subscription_details: { subscription: { id: 'sub_invoice' } } },
          payments: {
            data: [
              { payment: { type: 'payment_intent', payment_intent: 'pi_invoice_1' } },
              { payment: { type: 'payment_intent', payment_intent: 'pi_invoice_2' } },
              { payment: { type: 'charge', charge: 'ch_invoice_1' } },
            ],
          },
        },
        'current_invoice',
      )
      const refundByInvoice = await classify('charge.refunded', { id: 'ch_refund', invoice: 'in_current' }, 'refund_by_invoice')
      const refundByCharge = await classify('charge.refunded', { id: 'ch_invoice_1' }, 'refund_by_charge')
      const refundByPi = await classify('charge.refunded', { id: 'ch_refund_by_pi', payment_intent: 'pi_invoice_2' }, 'refund_by_pi')
      const disputeByPi = await classify(
        'charge.dispute.created',
        { id: 'dp_1', charge: { id: 'ch_dispute', payment_intent: 'pi_invoice_1' } },
        'dispute_by_pi',
      )
      const tokenInvoice = await classify(
        'invoice.payment_succeeded',
        {
          id: 'in_token_provenance',
          payment_intent: 'pi_token_provenance',
          charge: 'ch_token_must_not_exist',
        },
        'token_invoice_provenance',
      )
      const tokenPiReplay = await classify(
        'payment_intent.succeeded',
        { id: 'pi_token_provenance', latest_charge: 'ch_token_still_must_not_exist' },
        'token_pi_replay',
      )
      const commercialCheckout = await classify(
        'checkout.session.completed',
        { id: 'cs_provenance', subscription: 'sub_provenance' },
        'commercial_checkout_provenance',
      )
      const commercialSubscriptionReplay = await classify(
        'customer.subscription.updated',
        { id: 'sub_provenance' },
        'commercial_subscription_replay',
      )
      const creditPendingEvent = await persistSignedEvent(
        sql,
        'checkout.session.completed',
        { id: 'cs_credit_pack', metadata: { type: 'credit_pack_purchase' } },
        'credit_pack',
      )
      const creditPending = await classifier.classify(creditPendingEvent)
      await sql.query(`INSERT INTO "CreditPackPurchase" (id, "stripeCheckoutSessionId") VALUES ('credit-1', 'cs_credit_pack')`)
      const creditDrain = await classifier.classify(creditPendingEvent)
      await sql.query(`
        INSERT INTO "TerminalOrder" (id, "stripeCheckoutSessionId") VALUES ('terminal-credit-overlap', 'cs_credit_with_authority');
        INSERT INTO "CreditPackPurchase" (id, "stripeCheckoutSessionId") VALUES ('credit-overlap', 'cs_credit_with_authority');
      `)
      const creditWithAuthority = await classify('checkout.session.completed', { id: 'cs_credit_with_authority' }, 'credit_with_authority')

      const badSource = await persistSignedEvent(
        sql,
        'checkout.session.completed',
        { id: 'cs_bad_source', subscription: 'sub_different' },
        'bad_provenance_source',
      )
      await sql.query(
        `INSERT INTO "StripeObjectBinding" (
          "objectType", "stripeObjectId", "ownerKind", "routeKey", "subjectKind", "subjectId", "sourceWebhookEventId"
        ) VALUES
          ('SUBSCRIPTION', 'sub_bad_provenance', 'COMMERCIAL_V2', 'COMMERCIAL_SUBSCRIPTION_LIFECYCLE', 'COMMERCIAL_ACCEPTANCE', 'acceptance-bad', $1),
          ('SUBSCRIPTION', 'sub_null_provenance', 'COMMERCIAL_V2', 'COMMERCIAL_SUBSCRIPTION_LIFECYCLE', 'COMMERCIAL_ACCEPTANCE', 'acceptance-null-provenance', NULL),
          ('SUBSCRIPTION', 'sub_missing_subject', 'COMMERCIAL_V2', 'COMMERCIAL_SUBSCRIPTION_LIFECYCLE', 'COMMERCIAL_ACCEPTANCE', 'acceptance-missing', NULL)`,
        [badSource.webhookEventId],
      )
      const badProvenance = await classify('customer.subscription.updated', { id: 'sub_bad_provenance' }, 'bad_provenance_current')
      const commercialNullBefore = await sql.query(
        `SELECT "objectType", "stripeObjectId", "ownerKind", "routeKey", "subjectKind", "subjectId", "sourceWebhookEventId"
         FROM "StripeObjectBinding" WHERE "objectType" = 'SUBSCRIPTION' AND "stripeObjectId" = 'sub_null_provenance'`,
      )
      const bindingSetBeforeCommercialNull = await sql.query(
        `SELECT "objectType", "stripeObjectId", "ownerKind", "routeKey", "subjectKind", "subjectId", "sourceWebhookEventId"
         FROM "StripeObjectBinding" ORDER BY "objectType", "stripeObjectId"`,
      )
      const commercialMissingProvenance = await classify(
        'customer.subscription.updated',
        { id: 'sub_null_provenance' },
        'missing_provenance_current',
      )
      const commercialNullAfter = await sql.query(
        `SELECT "objectType", "stripeObjectId", "ownerKind", "routeKey", "subjectKind", "subjectId", "sourceWebhookEventId"
         FROM "StripeObjectBinding" WHERE "objectType" = 'SUBSCRIPTION' AND "stripeObjectId" = 'sub_null_provenance'`,
      )
      const bindingSetAfterCommercialNull = await sql.query(
        `SELECT "objectType", "stripeObjectId", "ownerKind", "routeKey", "subjectKind", "subjectId", "sourceWebhookEventId"
         FROM "StripeObjectBinding" ORDER BY "objectType", "stripeObjectId"`,
      )
      const commercialNullWrites = await sql.query(
        `SELECT "objectType", "stripeObjectId" FROM "StripeObjectBinding"
         WHERE "sourceWebhookEventId" = 'we_missing_provenance_current'`,
      )
      const missingSubject = await classify('customer.subscription.updated', { id: 'sub_missing_subject' }, 'missing_subject_current')
      await classify('payment_intent.succeeded', { id: 'pi_token_refund' }, 'token_refund_binding')
      const tokenRefund = await classify('charge.refunded', { id: 'ch_token_refund', payment_intent: 'pi_token_refund' }, 'token_refund')

      await classify(
        'invoice.paid',
        { id: 'in_commercial_conflict_source', subscription: 'sub_provenance', charge: 'ch_conflicting_refund' },
        'commercial_conflict_source',
      )
      await classify('invoice.paid', { id: 'in_conflicting_refund', subscription: 'sub_invoice' }, 'legacy_conflict_source')
      const refundConflict = await classify(
        'charge.refunded',
        { id: 'ch_conflicting_refund', invoice: 'in_conflicting_refund' },
        'refund_conflict',
      )
      const bindingRows = await sql.query(
        `SELECT "objectType", "stripeObjectId", "routeKey", "sourceWebhookEventId" FROM "StripeObjectBinding" ORDER BY 1, 2`,
      )

      return {
        currentInvoice,
        refundByInvoice,
        refundByCharge,
        refundByPi,
        disputeByPi,
        tokenInvoice,
        tokenPiReplay,
        commercialCheckout,
        commercialSubscriptionReplay,
        creditPending,
        creditDrain,
        creditWithAuthority,
        badProvenance,
        commercialMissingProvenance,
        commercialNullBefore: commercialNullBefore.rows,
        commercialNullAfter: commercialNullAfter.rows,
        bindingSetBeforeCommercialNull: bindingSetBeforeCommercialNull.rows,
        bindingSetAfterCommercialNull: bindingSetAfterCommercialNull.rows,
        commercialNullWrites: commercialNullWrites.rows,
        missingSubject,
        tokenRefund,
        refundConflict,
        bindings: bindingRows.rows,
      }
    })

    expect(proof.cleanupConfirmed).toBe(true)
    expect(proof.residualCount).toBe(0)
    expect(proof.result.currentInvoice).toMatchObject({ state: 'CLASSIFIED', authority: { subjectId: 'vf-invoice' } })
    expect(proof.result.refundByInvoice).toMatchObject({ state: 'CLASSIFIED', authority: { subjectId: 'vf-invoice' } })
    expect(proof.result.refundByCharge).toMatchObject({ state: 'CLASSIFIED', authority: { subjectId: 'vf-invoice' } })
    expect(proof.result.refundByPi).toMatchObject({ state: 'CLASSIFIED', authority: { subjectId: 'vf-invoice' } })
    expect(proof.result.disputeByPi).toMatchObject({ state: 'CLASSIFIED', authority: { subjectId: 'vf-invoice' } })
    expect(proof.result.tokenInvoice).toMatchObject({ state: 'CLASSIFIED', authority: { routeKey: 'TOKEN_INVOICE' } })
    expect(proof.result.tokenPiReplay).toMatchObject({
      state: 'CLASSIFIED',
      authority: { routeKey: 'TOKEN_PAYMENT_INTENT' },
    })
    expect(proof.result.commercialCheckout).toMatchObject({ state: 'CLASSIFIED' })
    expect(proof.result.commercialSubscriptionReplay).toMatchObject({ state: 'CLASSIFIED' })
    expect(proof.result.creditPending).toMatchObject({ state: 'PENDING', code: 'LOCAL_REFERENCE_NOT_READY' })
    expect(proof.result.creditDrain).toMatchObject({ state: 'UNRESOLVED', code: 'LEGACY_PLATFORM_CREDIT_PACK_DRAIN' })
    expect(proof.result.creditWithAuthority).toMatchObject({
      state: 'CLASSIFIED',
      authority: { routeKey: 'TERMINAL_ORDER_CHECKOUT', subjectId: 'terminal-credit-overlap' },
    })
    expect(proof.result.badProvenance).toMatchObject({ state: 'UNRESOLVED', code: 'BINDING_SUBJECT_INVALID' })
    expect(proof.result.commercialMissingProvenance).toMatchObject({
      state: 'UNRESOLVED',
      code: 'BINDING_SUBJECT_INVALID',
      bindings: [],
    })
    expect(proof.result.commercialNullBefore).toEqual([
      {
        objectType: 'SUBSCRIPTION',
        stripeObjectId: 'sub_null_provenance',
        ownerKind: 'COMMERCIAL_V2',
        routeKey: 'COMMERCIAL_SUBSCRIPTION_LIFECYCLE',
        subjectKind: 'COMMERCIAL_ACCEPTANCE',
        subjectId: 'acceptance-null-provenance',
        sourceWebhookEventId: null,
      },
    ])
    expect(proof.result.commercialNullAfter).toEqual(proof.result.commercialNullBefore)
    expect(proof.result.bindingSetAfterCommercialNull).toEqual(proof.result.bindingSetBeforeCommercialNull)
    expect(proof.result.commercialNullWrites).toEqual([])
    expect(proof.result.missingSubject).toMatchObject({ state: 'UNRESOLVED', code: 'BINDING_SUBJECT_INVALID' })
    expect(proof.result.tokenRefund).toMatchObject({ state: 'UNRESOLVED', code: 'BINDING_ROUTE_INCOMPATIBLE' })
    expect(proof.result.refundConflict).toMatchObject({ state: 'UNRESOLVED', code: 'IMMUTABLE_BINDING_CONFLICT' })
    expect(proof.result.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ objectType: 'INVOICE', stripeObjectId: 'in_current' }),
        expect.objectContaining({ objectType: 'PAYMENT_INTENT', stripeObjectId: 'pi_invoice_1' }),
        expect.objectContaining({ objectType: 'PAYMENT_INTENT', stripeObjectId: 'pi_invoice_2' }),
        expect.objectContaining({ objectType: 'CHARGE', stripeObjectId: 'ch_invoice_1' }),
        expect.objectContaining({ objectType: 'CHARGE', stripeObjectId: 'ch_refund' }),
        expect.objectContaining({ objectType: 'CHARGE', stripeObjectId: 'ch_dispute' }),
        expect.objectContaining({ objectType: 'INVOICE', stripeObjectId: 'in_token_provenance', routeKey: 'TOKEN_INVOICE' }),
        expect.objectContaining({
          objectType: 'PAYMENT_INTENT',
          stripeObjectId: 'pi_token_provenance',
          routeKey: 'TOKEN_PAYMENT_INTENT',
        }),
      ]),
    )
    expect(proof.result.bindings.some((row: { stripeObjectId: string }) => row.stripeObjectId.startsWith('ch_token'))).toBe(false)
  })

  it('rejects unproven token PI inputs and derived targets with total rollback', async () => {
    const proof = await withClassifierDatabase(async ({ first, sql }) => {
      await sql.query(`
        INSERT INTO "TokenPurchase" (id, "stripeInvoiceId", "stripePaymentIntentId") VALUES
          ('token-target-null', 'in_target_null', NULL),
          ('token-target-bad', 'in_target_bad', NULL),
          ('token-input-null', NULL, NULL),
          ('token-input-bad', NULL, NULL);
      `)
      const badSource = await persistSignedEvent(
        sql,
        'invoice.paid',
        { id: 'in_unrelated', payment_intent: 'pi_unrelated' },
        'token_bad_source',
      )
      await sql.query(
        `INSERT INTO "StripeObjectBinding" (
          "objectType", "stripeObjectId", "ownerKind", "routeKey", "subjectKind", "subjectId", "sourceWebhookEventId"
        ) VALUES
          ('PAYMENT_INTENT', 'pi_target_null', 'INDEPENDENT', 'TOKEN_PAYMENT_INTENT', 'TOKEN_PURCHASE', 'token-target-null', NULL),
          ('PAYMENT_INTENT', 'pi_target_bad', 'INDEPENDENT', 'TOKEN_PAYMENT_INTENT', 'TOKEN_PURCHASE', 'token-target-bad', $1),
          ('PAYMENT_INTENT', 'pi_input_null', 'INDEPENDENT', 'TOKEN_PAYMENT_INTENT', 'TOKEN_PURCHASE', 'token-input-null', NULL),
          ('PAYMENT_INTENT', 'pi_input_bad', 'INDEPENDENT', 'TOKEN_PAYMENT_INTENT', 'TOKEN_PURCHASE', 'token-input-bad', $1)`,
        [badSource.webhookEventId],
      )
      const classifier = createPlatformWebhookClassifier({
        repository: createPrismaPlatformWebhookClassificationRepository(first),
      })
      const classify = async (type: string, object: unknown, suffix: string) =>
        classifier.classify(await persistSignedEvent(sql, type, object, suffix))

      const targetNull = await classify('invoice.paid', { id: 'in_target_null', payment_intent: 'pi_target_null' }, 'target_null_current')
      const targetBad = await classify('invoice.paid', { id: 'in_target_bad', payment_intent: 'pi_target_bad' }, 'target_bad_current')
      const inputNull = await classify('payment_intent.succeeded', { id: 'pi_input_null' }, 'input_null_current')
      const inputBad = await classify('payment_intent.succeeded', { id: 'pi_input_bad' }, 'input_bad_current')
      const leaked = await sql.query(
        `SELECT "objectType", "stripeObjectId" FROM "StripeObjectBinding"
         WHERE "stripeObjectId" IN ('in_target_null', 'in_target_bad') ORDER BY 1,2`,
      )

      return { targetNull, targetBad, inputNull, inputBad, leaked: leaked.rows }
    })

    expect(proof.cleanupConfirmed).toBe(true)
    expect(proof.residualCount).toBe(0)
    for (const result of [proof.result.targetNull, proof.result.targetBad, proof.result.inputNull, proof.result.inputBad]) {
      expect(result).toMatchObject({ state: 'UNRESOLVED', code: 'BINDING_SUBJECT_INVALID' })
    }
    expect(proof.result.leaked).toEqual([])
  })

  it('writes sorted batches atomically and converges across concurrent workers and crash/retry', async () => {
    const proof = await withClassifierDatabase(async ({ first, second, sql }) => {
      await sql.query(`
        INSERT INTO "CommercialQuoteAcceptance" (id) VALUES ('acceptance-a'), ('acceptance-b');
        INSERT INTO "CommercialStripeOperation" (id, "acceptanceId", "stripeCheckoutSessionId", "stripeSubscriptionId") VALUES
          ('op-race-a', 'acceptance-a', 'cs_race', NULL),
          ('op-invoice-a', 'acceptance-a', NULL, 'sub_race_a'),
          ('op-invoice-b', 'acceptance-b', NULL, 'sub_race_b');
      `)
      const classifierA = createPlatformWebhookClassifier({
        repository: createPrismaPlatformWebhookClassificationRepository(first),
      })
      const classifierB = createPlatformWebhookClassifier({
        repository: createPrismaPlatformWebhookClassificationRepository(second),
      })
      const raceEvent = await persistSignedEvent(
        sql,
        'checkout.session.completed',
        { id: 'cs_race', subscription: 'sub_race' },
        'exact_race',
      )
      const exactRace = await Promise.all([classifierA.classify(raceEvent), classifierB.classify(raceEvent)])
      const exactRows = await sql.query(
        `SELECT "objectType", "stripeObjectId", "sourceWebhookEventId" FROM "StripeObjectBinding" WHERE "stripeObjectId" IN ('cs_race', 'sub_race') ORDER BY 1,2`,
      )
      const crashRetry = await classifierA.classify(raceEvent)

      await sql.query(`
        INSERT INTO "TokenPurchase" (id, "stripeInvoiceId", "stripePaymentIntentId")
        VALUES ('token-target-race', 'in_token_target_race', NULL)
      `)
      const targetRaceEvent = await persistSignedEvent(
        sql,
        'invoice.paid',
        { id: 'in_token_target_race', payment_intent: 'pi_token_target_race' },
        'token_target_race',
      )
      const targetWinnerRace = await Promise.all([classifierA.classify(targetRaceEvent), classifierB.classify(targetRaceEvent)])
      const targetWinnerRows = await sql.query(
        `SELECT "objectType", "stripeObjectId", "sourceWebhookEventId" FROM "StripeObjectBinding"
         WHERE "stripeObjectId" IN ('in_token_target_race', 'pi_token_target_race') ORDER BY 1,2`,
      )

      const conflictSource = await persistSignedEvent(
        sql,
        'invoice.paid',
        { id: 'in_batch_conflict_source', subscription: 'sub_race_a', payment_intent: 'pi_preexisting_conflict' },
        'preexisting_conflict_source',
      )
      await sql.query(
        `INSERT INTO "StripeObjectBinding" (
          "objectType", "stripeObjectId", "ownerKind", "routeKey", "subjectKind", "subjectId", "sourceWebhookEventId"
        ) VALUES ('PAYMENT_INTENT', 'pi_preexisting_conflict', 'COMMERCIAL_V2', 'COMMERCIAL_SUBSCRIPTION_LIFECYCLE', 'COMMERCIAL_ACCEPTANCE', 'acceptance-a', $1)`,
        [conflictSource.webhookEventId],
      )
      const rollbackEvent = await persistSignedEvent(
        sql,
        'invoice.paid',
        { id: 'in_batch_conflict', subscription: 'sub_race_b', payment_intent: 'pi_preexisting_conflict' },
        'rollback_event',
      )
      const rollbackResult = await classifierB.classify(rollbackEvent)
      const rollbackRows = await sql.query(
        `SELECT "objectType", "stripeObjectId" FROM "StripeObjectBinding" WHERE "stripeObjectId" = 'in_batch_conflict'`,
      )

      const conflictingA = await persistSignedEvent(
        sql,
        'invoice.paid',
        { id: 'in_concurrent_conflict', subscription: 'sub_race_a', payment_intent: 'pi_concurrent_a' },
        'concurrent_conflict_a',
      )
      const conflictingB = await persistSignedEvent(
        sql,
        'invoice.paid',
        { id: 'in_concurrent_conflict', subscription: 'sub_race_b', payment_intent: 'pi_concurrent_b' },
        'concurrent_conflict_b',
      )
      const differentRace = await Promise.all([classifierA.classify(conflictingA), classifierB.classify(conflictingB)])
      const differentRows = await sql.query(
        `SELECT "objectType", "stripeObjectId", "subjectId", "sourceWebhookEventId"
         FROM "StripeObjectBinding"
         WHERE "stripeObjectId" IN ('in_concurrent_conflict', 'pi_concurrent_a', 'pi_concurrent_b')
         ORDER BY 1,2`,
      )

      const inverseA = await persistSignedEvent(
        sql,
        'invoice.paid',
        {
          id: 'in_inverse',
          subscription: 'sub_race_a',
          payments: {
            data: [{ payment: { type: 'charge', charge: 'ch_inverse_2' } }, { payment: { type: 'charge', charge: 'ch_inverse_1' } }],
          },
        },
        'inverse_a',
      )
      const inverseB = await persistSignedEvent(
        sql,
        'invoice.paid',
        {
          id: 'in_inverse',
          subscription: 'sub_race_a',
          payments: {
            data: [{ payment: { type: 'charge', charge: 'ch_inverse_1' } }, { payment: { type: 'charge', charge: 'ch_inverse_2' } }],
          },
        },
        'inverse_b',
      )
      const inverseOrder = await Promise.all([classifierA.classify(inverseA), classifierB.classify(inverseB)])
      const inverseRows = await sql.query(
        `SELECT "objectType", "stripeObjectId", "sourceWebhookEventId" FROM "StripeObjectBinding" WHERE "stripeObjectId" IN ('in_inverse', 'ch_inverse_1', 'ch_inverse_2') ORDER BY 1,2`,
      )

      return {
        exactRace,
        exactRows: exactRows.rows,
        crashRetry,
        targetWinnerRace,
        targetWinnerRows: targetWinnerRows.rows,
        rollbackResult,
        rollbackRows: rollbackRows.rows,
        differentRace,
        differentRows: differentRows.rows,
        inverseOrder,
        inverseRows: inverseRows.rows,
      }
    })

    expect(proof.cleanupConfirmed).toBe(true)
    expect(proof.residualCount).toBe(0)
    expect(proof.result.exactRace.every(result => result.state === 'CLASSIFIED')).toBe(true)
    expect(proof.result.exactRows).toEqual([
      { objectType: 'CHECKOUT_SESSION', stripeObjectId: 'cs_race', sourceWebhookEventId: 'we_exact_race' },
      { objectType: 'SUBSCRIPTION', stripeObjectId: 'sub_race', sourceWebhookEventId: 'we_exact_race' },
    ])
    expect(proof.result.crashRetry).toMatchObject({ state: 'CLASSIFIED' })
    expect(proof.result.targetWinnerRace.every(result => result.state === 'CLASSIFIED')).toBe(true)
    expect(proof.result.targetWinnerRows).toEqual([
      { objectType: 'INVOICE', stripeObjectId: 'in_token_target_race', sourceWebhookEventId: 'we_token_target_race' },
      { objectType: 'PAYMENT_INTENT', stripeObjectId: 'pi_token_target_race', sourceWebhookEventId: 'we_token_target_race' },
    ])
    expect(proof.result.rollbackResult).toMatchObject({ state: 'UNRESOLVED', code: 'IMMUTABLE_BINDING_CONFLICT' })
    expect(proof.result.rollbackRows).toEqual([])
    expect(proof.result.differentRace.map(result => result.state).sort()).toEqual(['CLASSIFIED', 'UNRESOLVED'])
    expect(proof.result.differentRows).toHaveLength(2)
    expect(proof.result.differentRows.filter((row: { objectType: string }) => row.objectType === 'INVOICE')).toHaveLength(1)
    expect(proof.result.differentRows.filter((row: { objectType: string }) => row.objectType === 'PAYMENT_INTENT')).toHaveLength(1)
    expect(proof.result.inverseOrder.every(result => result.state === 'CLASSIFIED')).toBe(true)
    expect(proof.result.inverseRows).toHaveLength(3)
    expect(new Set(proof.result.inverseRows.map((row: { sourceWebhookEventId: string }) => row.sourceWebhookEventId)).size).toBe(1)
  })
})
