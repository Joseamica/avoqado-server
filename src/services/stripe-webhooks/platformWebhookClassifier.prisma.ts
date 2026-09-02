import { Prisma, type PrismaClient } from '@prisma/client'
import type { ExtractedSignedPlatformEvent, StripeBindingReference } from './platformWebhookClassifier.extractor'
import {
  BindingSnapshotRetryError,
  type BindingRelationship,
  type BindingWriteResult,
  type DurableSignedWebhookEvent,
  type FallbackInspection,
  type LocalAuthorityCandidate,
  type PlatformWebhookClassificationRepository,
  type PlatformWebhookClassificationTransaction,
  type StoredStripeObjectBinding,
} from './platformWebhookClassifier.service'
import type { StripeAuthorityTuple, StripeObjectType } from './platformWebhookInbox.service'

type RawPrisma = Pick<Prisma.TransactionClient, '$queryRaw'>

interface RawBindingRow {
  objectType: StripeObjectType
  stripeObjectId: string
  ownerKind: StripeAuthorityTuple['ownerKind']
  routeKey: StripeAuthorityTuple['routeKey']
  subjectKind: StripeAuthorityTuple['subjectKind']
  subjectId: string
  sourceWebhookEventId: string | null
}

interface RawCandidateRow {
  ownerKind: StripeAuthorityTuple['ownerKind']
  routeKey: StripeAuthorityTuple['routeKey']
  subjectKind: StripeAuthorityTuple['subjectKind']
  subjectId: string
  source: string
}

function authorityFromRow(row: RawCandidateRow | RawBindingRow): StripeAuthorityTuple {
  return {
    ownerKind: row.ownerKind,
    routeKey: row.routeKey,
    subjectKind: row.subjectKind,
    subjectId: row.subjectId,
  }
}

function storedBinding(row: RawBindingRow): StoredStripeObjectBinding {
  return {
    objectType: row.objectType,
    stripeObjectId: row.stripeObjectId,
    authority: authorityFromRow(row),
    sourceWebhookEventId: row.sourceWebhookEventId,
  }
}

function bindingKey(reference: StripeBindingReference): string {
  return `${reference.objectType}|${reference.stripeObjectId}`
}

function candidateRows(rows: RawCandidateRow[]): LocalAuthorityCandidate[] {
  return rows.map(row => ({ authority: authorityFromRow(row), source: row.source }))
}

async function commercialCandidates(
  tx: RawPrisma,
  column: 'stripeCheckoutSessionId' | 'stripeSubscriptionId',
  ids: string[],
): Promise<RawCandidateRow[]> {
  if (ids.length === 0) return []
  const columnSql = Prisma.raw(column === 'stripeCheckoutSessionId' ? '"stripeCheckoutSessionId"' : '"stripeSubscriptionId"')
  return tx.$queryRaw<RawCandidateRow[]>(Prisma.sql`
    SELECT 'COMMERCIAL_V2'::"StripeEventOwnerKind" AS "ownerKind",
           'COMMERCIAL_SUBSCRIPTION_LIFECYCLE'::"StripeEventRouteKey" AS "routeKey",
           'COMMERCIAL_ACCEPTANCE'::"StripeEventSubjectKind" AS "subjectKind",
           distinct_subject."subjectId",
           'COMMERCIAL_OPERATION'::text AS source
    FROM (
      SELECT DISTINCT operation."acceptanceId" AS "subjectId"
      FROM "CommercialStripeOperation" operation
      WHERE operation.${columnSql} IN (${Prisma.join(ids)})
    ) distinct_subject
    ORDER BY distinct_subject."subjectId"
    LIMIT 2
  `)
}

async function legacyOriginCandidates(tx: RawPrisma, sessionId: string): Promise<RawCandidateRow[]> {
  return tx.$queryRaw<RawCandidateRow[]>(Prisma.sql`
    SELECT origin."ownerKind", origin."routeKey",
           'STRIPE_CHECKOUT_ORIGIN'::"StripeEventSubjectKind" AS "subjectKind",
           origin."stripeCheckoutSessionId" AS "subjectId",
           'STRIPE_CHECKOUT_ORIGIN'::text AS source
    FROM "StripeCheckoutOrigin" origin
    WHERE origin."stripeCheckoutSessionId" = ${sessionId}
    ORDER BY origin."stripeCheckoutSessionId"
    LIMIT 2
  `)
}

async function terminalCandidates(tx: RawPrisma, sessionId: string): Promise<RawCandidateRow[]> {
  return tx.$queryRaw<RawCandidateRow[]>(Prisma.sql`
    SELECT 'INDEPENDENT'::"StripeEventOwnerKind" AS "ownerKind",
           'TERMINAL_ORDER_CHECKOUT'::"StripeEventRouteKey" AS "routeKey",
           'TERMINAL_ORDER'::"StripeEventSubjectKind" AS "subjectKind",
           distinct_subject."subjectId",
           'TERMINAL_ORDER'::text AS source
    FROM (
      SELECT DISTINCT terminal_order.id AS "subjectId"
      FROM "TerminalOrder" terminal_order
      WHERE terminal_order."stripeCheckoutSessionId" = ${sessionId}
    ) distinct_subject
    ORDER BY distinct_subject."subjectId"
    LIMIT 2
  `)
}

async function legacyFeatureCandidates(tx: RawPrisma, subscriptionIds: string[]): Promise<RawCandidateRow[]> {
  if (subscriptionIds.length === 0) return []
  return tx.$queryRaw<RawCandidateRow[]>(Prisma.sql`
    SELECT 'LEGACY'::"StripeEventOwnerKind" AS "ownerKind",
           'LEGACY_SUBSCRIPTION_LIFECYCLE'::"StripeEventRouteKey" AS "routeKey",
           'VENUE_FEATURE'::"StripeEventSubjectKind" AS "subjectKind",
           distinct_subject."subjectId",
           'VENUE_FEATURE'::text AS source
    FROM (
      SELECT DISTINCT venue_feature.id AS "subjectId"
      FROM "VenueFeature" venue_feature
      WHERE venue_feature."stripeSubscriptionId" IN (${Prisma.join(subscriptionIds)})
    ) distinct_subject
    ORDER BY distinct_subject."subjectId"
    LIMIT 2
  `)
}

async function tokenInvoiceCandidates(tx: RawPrisma, invoiceIds: string[]): Promise<RawCandidateRow[]> {
  if (invoiceIds.length === 0) return []
  return tx.$queryRaw<RawCandidateRow[]>(Prisma.sql`
    SELECT 'INDEPENDENT'::"StripeEventOwnerKind" AS "ownerKind",
           'TOKEN_INVOICE'::"StripeEventRouteKey" AS "routeKey",
           'TOKEN_PURCHASE'::"StripeEventSubjectKind" AS "subjectKind",
           distinct_subject."subjectId",
           'TOKEN_PURCHASE_INVOICE'::text AS source
    FROM (
      SELECT DISTINCT token_purchase.id AS "subjectId"
      FROM "TokenPurchase" token_purchase
      WHERE token_purchase."stripeInvoiceId" IN (${Prisma.join(invoiceIds)})
    ) distinct_subject
    ORDER BY distinct_subject."subjectId"
    LIMIT 2
  `)
}

async function tokenPaymentIntentCandidates(tx: RawPrisma, paymentIntentIds: string[]): Promise<RawCandidateRow[]> {
  if (paymentIntentIds.length === 0) return []
  return tx.$queryRaw<RawCandidateRow[]>(Prisma.sql`
    SELECT 'INDEPENDENT'::"StripeEventOwnerKind" AS "ownerKind",
           'TOKEN_PAYMENT_INTENT'::"StripeEventRouteKey" AS "routeKey",
           'TOKEN_PURCHASE'::"StripeEventSubjectKind" AS "subjectKind",
           distinct_subject."subjectId",
           'TOKEN_PURCHASE_PAYMENT_INTENT'::text AS source
    FROM (
      SELECT DISTINCT token_purchase.id AS "subjectId"
      FROM "TokenPurchase" token_purchase
      WHERE token_purchase."stripePaymentIntentId" IN (${Prisma.join(paymentIntentIds)})
    ) distinct_subject
    ORDER BY distinct_subject."subjectId"
    LIMIT 2
  `)
}

async function venueCustomerCandidates(tx: RawPrisma, customerIds: string[]): Promise<RawCandidateRow[]> {
  if (customerIds.length === 0) return []
  return tx.$queryRaw<RawCandidateRow[]>(Prisma.sql`
    SELECT 'LEGACY'::"StripeEventOwnerKind" AS "ownerKind",
           'VENUE_BILLING_PROFILE'::"StripeEventRouteKey" AS "routeKey",
           'VENUE'::"StripeEventSubjectKind" AS "subjectKind",
           distinct_subject."subjectId",
           'VENUE_CUSTOMER'::text AS source
    FROM (
      SELECT DISTINCT venue.id AS "subjectId"
      FROM "Venue" venue
      WHERE venue."stripeCustomerId" IN (${Prisma.join(customerIds)})
    ) distinct_subject
    ORDER BY distinct_subject."subjectId"
    LIMIT 2
  `)
}

async function creditPackDrain(tx: RawPrisma, sessionId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ present: boolean }>>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1 FROM "CreditPackPurchase" purchase
      WHERE purchase."stripeCheckoutSessionId" = ${sessionId}
    ) AS present
  `)
  return rows[0]?.present ?? false
}

async function findFallbackAuthorities(
  tx: RawPrisma,
  extracted: Extract<ExtractedSignedPlatformEvent, { kind: 'EXTRACTED' }>,
): Promise<FallbackInspection> {
  let rows: RawCandidateRow[] = []
  let drain = false
  if (extracted.family === 'CHECKOUT') {
    const [commercial, origin, terminal, creditPack] = await Promise.all([
      commercialCandidates(tx, 'stripeCheckoutSessionId', [extracted.references.rootId]),
      legacyOriginCandidates(tx, extracted.references.rootId),
      terminalCandidates(tx, extracted.references.rootId),
      creditPackDrain(tx, extracted.references.rootId),
    ])
    rows = [...commercial, ...origin, ...terminal]
    drain = creditPack
  } else if (extracted.family === 'SUBSCRIPTION') {
    const [commercial, legacy] = await Promise.all([
      commercialCandidates(tx, 'stripeSubscriptionId', [extracted.references.rootId]),
      legacyFeatureCandidates(tx, [extracted.references.rootId]),
    ])
    rows = [...commercial, ...legacy]
  } else if (extracted.family === 'INVOICE') {
    const [token, commercial, legacy] = await Promise.all([
      tokenInvoiceCandidates(tx, [extracted.references.rootId]),
      commercialCandidates(tx, 'stripeSubscriptionId', extracted.references.subscriptionIds),
      legacyFeatureCandidates(tx, extracted.references.subscriptionIds),
    ])
    rows = [...token, ...commercial, ...legacy]
  } else if (extracted.family === 'PAYMENT_INTENT') {
    rows = await tokenPaymentIntentCandidates(tx, [extracted.references.rootId])
  } else if (extracted.family === 'CUSTOMER_DELETED' || extracted.family === 'PAYMENT_METHOD_ATTACHED') {
    rows = await venueCustomerCandidates(tx, extracted.references.customerIds)
  }
  return { candidates: candidateRows(rows), creditPackDrain: drain }
}

async function subjectRow(tx: RawPrisma, binding: StoredStripeObjectBinding): Promise<Record<string, unknown> | null> {
  const { authority } = binding
  if (authority.subjectKind === 'COMMERCIAL_ACCEPTANCE') {
    const rows = await tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT acceptance.id FROM "CommercialQuoteAcceptance" acceptance WHERE acceptance.id = ${authority.subjectId} LIMIT 1
    `)
    return rows[0] ?? null
  }
  if (authority.subjectKind === 'STRIPE_CHECKOUT_ORIGIN') {
    const rows = await tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT origin."stripeCheckoutSessionId" FROM "StripeCheckoutOrigin" origin
      WHERE origin."stripeCheckoutSessionId" = ${authority.subjectId} LIMIT 1
    `)
    return rows[0] ?? null
  }
  if (authority.subjectKind === 'VENUE_FEATURE') {
    const rows = await tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT venue_feature.id, venue_feature."stripeSubscriptionId" FROM "VenueFeature" venue_feature
      WHERE venue_feature.id = ${authority.subjectId} LIMIT 1
    `)
    return rows[0] ?? null
  }
  if (authority.subjectKind === 'TERMINAL_ORDER') {
    const rows = await tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT terminal_order.id, terminal_order."stripeCheckoutSessionId" FROM "TerminalOrder" terminal_order
      WHERE terminal_order.id = ${authority.subjectId} LIMIT 1
    `)
    return rows[0] ?? null
  }
  if (authority.subjectKind === 'TOKEN_PURCHASE') {
    const rows = await tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT token_purchase.id, token_purchase."stripeInvoiceId", token_purchase."stripePaymentIntentId"
      FROM "TokenPurchase" token_purchase WHERE token_purchase.id = ${authority.subjectId} LIMIT 1
    `)
    return rows[0] ?? null
  }
  if (authority.subjectKind === 'VENUE') {
    const rows = await tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT venue.id FROM "Venue" venue WHERE venue.id = ${authority.subjectId} LIMIT 1
    `)
    return rows[0] ?? null
  }
  return null
}

async function inspectBindingRelationship(tx: RawPrisma, binding: StoredStripeObjectBinding): Promise<BindingRelationship> {
  const subject = await subjectRow(tx, binding)
  if (!subject) return 'SUBJECT_MISSING'
  const { authority, objectType, stripeObjectId } = binding

  if (authority.subjectKind === 'COMMERCIAL_ACCEPTANCE') {
    if (objectType === 'CHECKOUT_SESSION') {
      const rows = await tx.$queryRaw<Array<{ present: boolean }>>(Prisma.sql`
        SELECT EXISTS (
          SELECT 1 FROM "CommercialStripeOperation" operation
          WHERE operation."acceptanceId" = ${authority.subjectId}
            AND operation."stripeCheckoutSessionId" = ${stripeObjectId}
        ) AS present
      `)
      return rows[0]?.present ? 'DIRECT_LOCAL_REFERENCE' : 'DIRECT_RELATION_INVALID'
    }
    if (objectType === 'SUBSCRIPTION') {
      const rows = await tx.$queryRaw<Array<{ stripeSubscriptionId: string | null }>>(Prisma.sql`
        SELECT operation."stripeSubscriptionId"
        FROM "CommercialStripeOperation" operation
        WHERE operation."acceptanceId" = ${authority.subjectId}
        ORDER BY operation.id
      `)
      if (rows.some(row => row.stripeSubscriptionId === stripeObjectId)) return 'DIRECT_LOCAL_REFERENCE'
      if (rows.some(row => row.stripeSubscriptionId === null)) return 'PROPAGATED_SIGNED_REFERENCE_REQUIRED'
      return 'DIRECT_RELATION_INVALID'
    }
    return 'PROPAGATED_SIGNED_REFERENCE_REQUIRED'
  }

  if (authority.subjectKind === 'STRIPE_CHECKOUT_ORIGIN') {
    return objectType === 'CHECKOUT_SESSION' && authority.subjectId === stripeObjectId
      ? 'DIRECT_LOCAL_REFERENCE'
      : 'DIRECT_RELATION_INVALID'
  }
  if (authority.subjectKind === 'VENUE_FEATURE') {
    if (objectType === 'SUBSCRIPTION') {
      return subject.stripeSubscriptionId === stripeObjectId ? 'DIRECT_LOCAL_REFERENCE' : 'DIRECT_RELATION_INVALID'
    }
    return 'PROPAGATED_SIGNED_REFERENCE_REQUIRED'
  }
  if (authority.subjectKind === 'TERMINAL_ORDER') {
    return objectType === 'CHECKOUT_SESSION' && subject.stripeCheckoutSessionId === stripeObjectId
      ? 'DIRECT_LOCAL_REFERENCE'
      : 'DIRECT_RELATION_INVALID'
  }
  if (authority.subjectKind === 'TOKEN_PURCHASE') {
    if (objectType === 'INVOICE' && authority.routeKey === 'TOKEN_INVOICE') {
      return subject.stripeInvoiceId === stripeObjectId ? 'DIRECT_LOCAL_REFERENCE' : 'DIRECT_RELATION_INVALID'
    }
    if (objectType === 'PAYMENT_INTENT' && authority.routeKey === 'TOKEN_PAYMENT_INTENT') {
      if (subject.stripePaymentIntentId === stripeObjectId) return 'DIRECT_LOCAL_REFERENCE'
      return subject.stripePaymentIntentId === null ? 'PROPAGATED_SIGNED_REFERENCE_REQUIRED' : 'DIRECT_RELATION_INVALID'
    }
    return 'DIRECT_RELATION_INVALID'
  }
  return 'DIRECT_RELATION_INVALID'
}

function createTransactionPort(tx: RawPrisma): PlatformWebhookClassificationTransaction {
  return {
    async findBindings(references, excludedKeys) {
      const effective = references.filter(reference => !excludedKeys.has(bindingKey(reference)))
      if (effective.length === 0) return []
      const predicates = effective.map(
        reference => Prisma.sql`(
          binding."objectType" = ${reference.objectType}::"StripeObjectType"
          AND binding."stripeObjectId" = ${reference.stripeObjectId}
        )`,
      )
      const rows = await tx.$queryRaw<RawBindingRow[]>(Prisma.sql`
        SELECT binding."objectType", binding."stripeObjectId", binding."ownerKind", binding."routeKey",
               binding."subjectKind", binding."subjectId", binding."sourceWebhookEventId"
        FROM "StripeObjectBinding" binding
        WHERE ${Prisma.join(predicates, ' OR ')}
        ORDER BY binding."objectType", binding."stripeObjectId"
      `)
      return rows.map(storedBinding)
    },

    findFallbackAuthorities(extracted) {
      return findFallbackAuthorities(tx, extracted)
    },

    inspectBindingRelationship(binding) {
      return inspectBindingRelationship(tx, binding)
    },

    async loadDurableSignedEvent(webhookEventId) {
      const rows = await tx.$queryRaw<DurableSignedWebhookEvent[]>(Prisma.sql`
        SELECT event.id, event."stripeEventId", event."eventType", event.payload
        FROM "WebhookEvent" event WHERE event.id = ${webhookEventId} LIMIT 1
      `)
      return rows[0] ?? null
    },

    async createOrCompareBindings(bindings) {
      const ordered = [...bindings].sort((left, right) => bindingKey(left).localeCompare(bindingKey(right)))
      const result: BindingWriteResult[] = []
      for (const binding of ordered) {
        const inserted = await tx.$queryRaw<RawBindingRow[]>(Prisma.sql`
          INSERT INTO "StripeObjectBinding" (
            "objectType", "stripeObjectId", "ownerKind", "routeKey", "subjectKind", "subjectId", "sourceWebhookEventId"
          ) VALUES (
            ${binding.objectType}::"StripeObjectType", ${binding.stripeObjectId},
            ${binding.authority.ownerKind}::"StripeEventOwnerKind", ${binding.authority.routeKey}::"StripeEventRouteKey",
            ${binding.authority.subjectKind}::"StripeEventSubjectKind", ${binding.authority.subjectId},
            ${binding.sourceWebhookEventId}
          )
          ON CONFLICT ("objectType", "stripeObjectId") DO NOTHING
          RETURNING "objectType", "stripeObjectId", "ownerKind", "routeKey", "subjectKind", "subjectId", "sourceWebhookEventId"
        `)
        let winner = inserted[0]
        if (!winner) {
          const observed = await tx.$queryRaw<RawBindingRow[]>(Prisma.sql`
            SELECT existing."objectType", existing."stripeObjectId", existing."ownerKind", existing."routeKey",
                   existing."subjectKind", existing."subjectId", existing."sourceWebhookEventId"
            FROM "StripeObjectBinding" existing
            WHERE existing."objectType" = ${binding.objectType}::"StripeObjectType"
              AND existing."stripeObjectId" = ${binding.stripeObjectId}
            LIMIT 1
          `)
          winner = observed[0]
        }
        if (!winner) throw new BindingSnapshotRetryError(binding.objectType, binding.stripeObjectId)
        const stored = storedBinding(winner)
        result.push({ status: inserted.length > 0 ? 'CREATED' : 'EXISTING', binding: stored })
      }
      return result
    },
  }
}

export function createPrismaPlatformWebhookClassificationRepository(prisma: PrismaClient): PlatformWebhookClassificationRepository {
  return {
    runInTransaction(work) {
      return prisma.$transaction(tx => work(createTransactionPort(tx)), {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      })
    },
  }
}
