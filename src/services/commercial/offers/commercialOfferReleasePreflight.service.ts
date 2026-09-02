import { Prisma } from '@prisma/client'

import prisma from '@/utils/prismaClient'

export interface CommercialOfferV3AllowedQ3AReferences {
  offerControlEvents: number
  directQuotes: number
  directQuoteAcceptances: number
}

export interface CommercialOfferV3ProhibitedReferences {
  campaignActivations: number
  campaignClaims: number
  acquisitionContexts: number
  legacyCampaignLinkedQuotes: number
  invalidOfferQuoteShapes: number
  previewBridges: number
  stripeOperations: number
  subscriptionEvents: number
}

export interface CommercialOfferV3AllowedQ3BReferences {
  offerControlEvents: number
  dedicatedClaims: number
  pinnedAcquisitionContexts: number
  acquisitionBindings: number
  directQuotes: number
  bridgedQuotes: number
  previewBridges: number
  quoteAcceptances: number
  acquisitionRedemptions: number
}

export interface CommercialOfferV3ProhibitedQ3BReferences {
  campaignActivations: number
  legacyCampaignClaims: number
  legacyAcquisitionContexts: number
  legacyCampaignLinkedQuotes: number
  invalidOfferQuoteShapes: number
  stripeOperations: number
  subscriptionEvents: number
  entitlementEffects: number
  hardwareOrderEffects: number
}

export interface CommercialOfferReleasePreflightTransaction {
  readSchemaPhase(): Promise<'Q3A' | 'Q3B'>
  countPublishedV3Versions(): Promise<number>
  countAllowedQ3AReferences(): Promise<CommercialOfferV3AllowedQ3AReferences>
  countProhibitedQ3AReferences(): Promise<CommercialOfferV3ProhibitedReferences>
  countAllowedQ3BReferences(): Promise<CommercialOfferV3AllowedQ3BReferences>
  countProhibitedQ3BReferences(): Promise<CommercialOfferV3ProhibitedQ3BReferences>
}

export interface CommercialOfferReleasePreflightDependencies {
  now(): Date
  runInRepeatableRead<T>(operation: (tx: CommercialOfferReleasePreflightTransaction) => Promise<T>): Promise<T>
}

export class CommercialOfferReleasePreflightError extends Error {
  readonly code: 'COMMERCIAL_OFFER_V3_PROHIBITED_Q3A_REFERENCE' | 'COMMERCIAL_OFFER_V3_PROHIBITED_Q3B_REFERENCE'

  constructor(
    public readonly references: CommercialOfferV3ProhibitedReferences | CommercialOfferV3ProhibitedQ3BReferences,
    phase: 'Q3A' | 'Q3B' = 'Q3A',
  ) {
    super(`Una oferta v3 está conectada a una superficie todavía prohibida para ${phase === 'Q3A' ? 'Q3-A' : 'Q3-B'}.`)
    this.code = phase === 'Q3A' ? 'COMMERCIAL_OFFER_V3_PROHIBITED_Q3A_REFERENCE' : 'COMMERCIAL_OFFER_V3_PROHIBITED_Q3B_REFERENCE'
    this.name = 'CommercialOfferReleasePreflightError'
  }
}

function freezeCounts<T extends object>(counts: T): Readonly<T> {
  if (Object.values(counts).some(count => !Number.isInteger(count) || count < 0)) {
    throw new Error('COMMERCIAL_OFFER_V3_PREFLIGHT_COUNT_INVALID')
  }
  return Object.freeze({ ...counts })
}

export function assertNoProhibitedCommercialOfferV3Q3AReferences(
  references: CommercialOfferV3ProhibitedReferences,
): Readonly<CommercialOfferV3ProhibitedReferences> {
  const frozen: Readonly<CommercialOfferV3ProhibitedReferences> = freezeCounts(references)
  if (Object.values(frozen).some(count => count !== 0)) throw new CommercialOfferReleasePreflightError(frozen)
  return frozen
}

export function assertNoProhibitedCommercialOfferV3Q3BReferences(
  references: CommercialOfferV3ProhibitedQ3BReferences,
): Readonly<CommercialOfferV3ProhibitedQ3BReferences> {
  const frozen: Readonly<CommercialOfferV3ProhibitedQ3BReferences> = freezeCounts(references)
  if (Object.values(frozen).some(count => count !== 0)) throw new CommercialOfferReleasePreflightError(frozen, 'Q3B')
  return frozen
}

export function createCommercialOfferReleasePreflightService(dependencies: CommercialOfferReleasePreflightDependencies) {
  return {
    run() {
      return dependencies.runInRepeatableRead(async tx => {
        const checkedAt = dependencies.now()
        const schemaPhase = await tx.readSchemaPhase()
        const [publishedVersions, allowedCounts, prohibitedCounts] = await Promise.all([
          tx.countPublishedV3Versions(),
          tx.countAllowedQ3AReferences(),
          tx.countProhibitedQ3AReferences(),
        ])
        const allowed = freezeCounts(allowedCounts)
        const prohibited = freezeCounts(prohibitedCounts)
        const q3aReceipt = Object.freeze({
          status: 'PASS' as const,
          schemaVersion: 3 as const,
          publishedVersions,
          q3a: Object.freeze({ allowed, prohibited }),
          checkedAt: checkedAt.toISOString(),
        })
        if (schemaPhase === 'Q3A') return q3aReceipt

        const [allowedQ3BCounts, prohibitedQ3BCounts] = await Promise.all([
          tx.countAllowedQ3BReferences(),
          tx.countProhibitedQ3BReferences(),
        ])
        const allowedQ3B = freezeCounts(allowedQ3BCounts)
        const prohibitedQ3B = assertNoProhibitedCommercialOfferV3Q3BReferences(prohibitedQ3BCounts)
        return Object.freeze({
          ...q3aReceipt,
          q3b: Object.freeze({ allowed: allowedQ3B, prohibited: prohibitedQ3B }),
        })
      })
    },
  }
}

const q3aDirectQuoteWhere = {
  schemaVersion: 3,
  offerVersionId: { not: null },
  offerSchemaVersion: 3,
  campaignVersionId: null,
  acquisitionContextId: null,
  organizationId: { not: null },
  venueId: { not: null },
  createdById: { not: null },
  commercialQuotePreviewBridge: { is: null },
} satisfies Prisma.CommercialQuoteWhereInput

const q3bBridgedQuoteWhere = {
  schemaVersion: 3,
  offerVersionId: { not: null },
  offerSchemaVersion: 3,
  campaignVersionId: null,
  acquisitionContextId: { not: null },
  organizationId: { not: null },
  venueId: { not: null },
  createdById: { not: null },
  commercialQuotePreviewBridge: { isNot: null },
} satisfies Prisma.CommercialQuoteWhereInput

const q3bQuoteWhere = {
  OR: [q3aDirectQuoteWhere, q3bBridgedQuoteWhere],
} satisfies Prisma.CommercialQuoteWhereInput

const dedicatedClaimWhere = {
  campaignVersionId: null,
  campaignCode: null,
  offerVersionId: { not: null },
  offerSchemaVersion: 3,
  offerVersion: { schemaVersion: 3 },
} satisfies Prisma.CommercialCampaignClaimWhereInput

const pinnedContextWhere = {
  campaignVersionId: null,
  offerVersionId: { not: null },
  offerSchemaVersion: 3,
  reservedCatalogPublicationId: { not: null },
  reservedCatalogSchemaVersion: 2,
  offerVersion: { schemaVersion: 3 },
  reservedCatalogPublication: { schemaVersion: 2 },
} satisfies Prisma.CommercialAcquisitionContextWhereInput

export async function countAllowedCommercialOfferV3Q3AReferences(
  tx: Prisma.TransactionClient,
): Promise<CommercialOfferV3AllowedQ3AReferences> {
  const [offerControlEvents, directQuotes, directQuoteAcceptances] = await Promise.all([
    tx.commercialOfferControlEvent.count({ where: { offerVersion: { schemaVersion: 3 } } }),
    tx.commercialQuote.count({ where: q3aDirectQuoteWhere }),
    tx.commercialQuoteAcceptance.count({ where: { quote: q3aDirectQuoteWhere } }),
  ])
  return { offerControlEvents, directQuotes, directQuoteAcceptances }
}

export async function countAllowedCommercialOfferV3Q3BReferences(
  tx: Prisma.TransactionClient,
): Promise<CommercialOfferV3AllowedQ3BReferences> {
  const [
    offerControlEvents,
    dedicatedClaims,
    pinnedAcquisitionContexts,
    acquisitionBindings,
    directQuotes,
    bridgedQuotes,
    previewBridges,
    quoteAcceptances,
    acquisitionRedemptions,
  ] = await Promise.all([
    tx.commercialOfferControlEvent.count({ where: { offerVersion: { schemaVersion: 3 } } }),
    tx.commercialCampaignClaim.count({ where: dedicatedClaimWhere }),
    tx.commercialAcquisitionContext.count({ where: pinnedContextWhere }),
    tx.commercialAcquisitionContextBinding.count({ where: { acquisitionContext: pinnedContextWhere } }),
    tx.commercialQuote.count({ where: q3aDirectQuoteWhere }),
    tx.commercialQuote.count({ where: q3bBridgedQuoteWhere }),
    tx.commercialQuotePreviewBridge.count({ where: { venueQuote: q3bBridgedQuoteWhere } }),
    tx.commercialQuoteAcceptance.count({ where: { quote: q3bQuoteWhere } }),
    tx.commercialAcquisitionRedemption.count({
      where: { acquisitionContext: pinnedContextWhere, quote: q3bBridgedQuoteWhere },
    }),
  ])
  return {
    offerControlEvents,
    dedicatedClaims,
    pinnedAcquisitionContexts,
    acquisitionBindings,
    directQuotes,
    bridgedQuotes,
    previewBridges,
    quoteAcceptances,
    acquisitionRedemptions,
  }
}

export async function countProhibitedCommercialOfferV3Q3AReferences(
  tx: Prisma.TransactionClient,
): Promise<CommercialOfferV3ProhibitedReferences> {
  const [
    campaignActivations,
    campaignClaims,
    acquisitionContexts,
    legacyCampaignLinkedQuotes,
    invalidOfferQuoteShapes,
    previewBridges,
    stripeOperations,
    subscriptionEvents,
  ] = await Promise.all([
    tx.commercialCampaignActivation.count({ where: { campaignVersion: { schemaVersion: 3 } } }),
    tx.commercialCampaignClaim.count({ where: { campaignVersion: { schemaVersion: 3 } } }),
    tx.commercialAcquisitionContext.count({ where: { campaignVersion: { schemaVersion: 3 } } }),
    tx.commercialQuote.count({ where: { campaignVersion: { schemaVersion: 3 } } }),
    tx.commercialQuote.count({
      where: {
        offerVersionId: { not: null },
        commercialQuotePreviewBridge: { is: null },
        OR: [
          { schemaVersion: { not: 3 } },
          { offerSchemaVersion: { not: 3 } },
          { offerSchemaVersion: null },
          { campaignVersionId: { not: null } },
          { acquisitionContextId: { not: null } },
          { organizationId: null },
          { venueId: null },
          { createdById: null },
        ],
      },
    }),
    tx.commercialQuotePreviewBridge.count({
      where: { venueQuote: { offerVersionId: { not: null } } },
    }),
    tx.commercialStripeOperation.count({ where: { acceptance: { quote: q3aDirectQuoteWhere } } }),
    tx.commercialSubscriptionEvent.count({ where: { acceptance: { quote: q3aDirectQuoteWhere } } }),
  ])
  return {
    campaignActivations,
    campaignClaims,
    acquisitionContexts,
    legacyCampaignLinkedQuotes,
    invalidOfferQuoteShapes,
    previewBridges,
    stripeOperations,
    subscriptionEvents,
  }
}

export async function countProhibitedCommercialOfferV3Q3BReferences(
  tx: Prisma.TransactionClient,
): Promise<CommercialOfferV3ProhibitedQ3BReferences> {
  const [
    campaignActivations,
    legacyCampaignClaims,
    legacyAcquisitionContexts,
    legacyCampaignLinkedQuotes,
    invalidOfferQuoteShapes,
    stripeOperations,
    subscriptionEvents,
    entitlementEffects,
    hardwareOrderEffects,
  ] = await Promise.all([
    tx.commercialCampaignActivation.count({ where: { campaignVersion: { schemaVersion: 3 } } }),
    tx.commercialCampaignClaim.count({ where: { campaignVersion: { schemaVersion: 3 } } }),
    tx.commercialAcquisitionContext.count({ where: { campaignVersion: { schemaVersion: 3 } } }),
    tx.commercialQuote.count({ where: { campaignVersion: { schemaVersion: 3 } } }),
    tx.commercialQuote.count({
      where: {
        offerVersionId: { not: null },
        NOT: q3bQuoteWhere,
      },
    }),
    tx.commercialStripeOperation.count({ where: { acceptance: { quote: q3bQuoteWhere } } }),
    tx.commercialSubscriptionEvent.count({ where: { acceptance: { quote: q3bQuoteWhere } } }),
    tx.organizationEntitlement.count({
      where: { organization: { commercialQuoteAcceptances: { some: { quote: q3bQuoteWhere } } } },
    }),
    tx.terminalOrder.count({
      where: { venue: { commercialQuoteAcceptances: { some: { quote: q3bQuoteWhere } } } },
    }),
  ])
  return {
    campaignActivations,
    legacyCampaignClaims,
    legacyAcquisitionContexts,
    legacyCampaignLinkedQuotes,
    invalidOfferQuoteShapes,
    stripeOperations,
    subscriptionEvents,
    entitlementEffects,
    hardwareOrderEffects,
  }
}

export function createPrismaCommercialOfferReleasePreflightDependencies(
  database: typeof prisma,
): CommercialOfferReleasePreflightDependencies {
  return {
    now: () => new Date(),
    runInRepeatableRead: operation =>
      database.$transaction(
        tx =>
          operation({
            readSchemaPhase: async () => {
              const rows = await tx.$queryRaw<Array<{ q3bReady: boolean }>>(Prisma.sql`
                SELECT EXISTS (
                  SELECT 1
                  FROM pg_catalog.pg_constraint constraint_row
                  WHERE constraint_row.conrelid = '"CommercialQuote"'::regclass
                    AND constraint_row.conname = 'CommercialQuote_v3_totals_check'
                    AND constraint_row.convalidated
                    AND pg_catalog.pg_get_constraintdef(constraint_row.oid)
                      LIKE '%commercial_quote_snapshot_matches_v3_row_q3b%'
                ) AS "q3bReady"
              `)
              return rows[0]?.q3bReady === true ? 'Q3B' : 'Q3A'
            },
            countPublishedV3Versions: () => tx.commercialCampaignVersion.count({ where: { schemaVersion: 3 } }),
            countAllowedQ3AReferences: () => countAllowedCommercialOfferV3Q3AReferences(tx),
            countProhibitedQ3AReferences: () => countProhibitedCommercialOfferV3Q3AReferences(tx),
            countAllowedQ3BReferences: () => countAllowedCommercialOfferV3Q3BReferences(tx),
            countProhibitedQ3BReferences: () => countProhibitedCommercialOfferV3Q3BReferences(tx),
          }),
        {
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
          maxWait: 5_000,
          timeout: 30_000,
        },
      ),
  }
}

export const prismaCommercialOfferReleasePreflightDependencies = createPrismaCommercialOfferReleasePreflightDependencies(prisma)

export const commercialOfferReleasePreflightService = createCommercialOfferReleasePreflightService(
  prismaCommercialOfferReleasePreflightDependencies,
)
