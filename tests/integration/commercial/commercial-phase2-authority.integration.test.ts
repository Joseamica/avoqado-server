import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import catalogFixture from '@/contracts/commercial/fixtures/catalog-v1.json'
import prisma from '@/utils/prismaClient'
import { createCommercialDraft } from '@/services/commercial/commercialDraft.service'
import { buildCommercialCatalogV2 } from '@/services/commercial/commercialCatalogV2Builder.service'
import { commercialCampaignDraftService } from '@/services/commercial/commercialCampaignDraft.service'
import { commercialCampaignClaimService } from '@/services/commercial/commercialCampaignClaim.service'
import { commercialCampaignPublicationService } from '@/services/commercial/commercialCampaignPublication.service'
import { commercialAcquisitionContextService } from '@/services/commercial/commercialAcquisitionContext.service'
import { commercialPublicQuotePreviewV2Service } from '@/services/commercial/commercialPublicQuotePreviewV2.service'
import { commercialQuotePreviewBridgeService } from '@/services/commercial/commercialQuotePreviewBridge.service'
import {
  createCommercialQuoteAcceptanceService,
  prismaCommercialQuoteAcceptanceDependencies,
} from '@/services/commercial/commercialQuoteAcceptance.service'
import { prismaCommercialStripeCheckoutRepository } from '@/services/commercial/commercialStripeCheckout.service'
import { commercialSubscriptionLifecycleService } from '@/services/commercial/commercialSubscriptionLifecycle.service'
import { buildInitialCommercialDraftV1 } from '@/services/commercial/commercialInitialCatalog'
import { assertCommercialV2CheckoutActive } from '@/services/commercial/commercialV2CheckoutPolicy.service'
import { formatCommercialMoneyV2 } from '@/services/commercial/commercialMoneyV2.service'
import { commercialReleasePreflightService } from '@/services/commercial/commercialReleasePreflight.service'

const activeCommercialQuoteAcceptanceService = createCommercialQuoteAcceptanceService({
  ...prismaCommercialQuoteAcceptanceDependencies,
  assertCheckoutAllowed: () => assertCommercialV2CheckoutActive('ACTIVE'),
})

describe('Commercial Phase 2 authority flow', () => {
  afterAll(async () => {
    // Remove this suite's isolated active pointer and evidence so the shared,
    // disposable integration database cannot leak a partial chain later.
    await prisma.commercialPublicationActivation.deleteMany()
    await prisma.commercialPublicationOutbox.deleteMany({
      where: { eventType: { in: ['PUBLICATION_ACTIVATED', 'PUBLICATION_ROLLED_BACK'] } },
    })
    await prisma.$disconnect()
  })

  it('pins campaign + quote, accepts once under concurrency and reserves one Stripe operation', async () => {
    await prisma.commercialPublicationOutbox.deleteMany({
      where: { eventType: { in: ['PUBLICATION_ACTIVATED', 'PUBLICATION_ROLLED_BACK'] } },
    })
    await prisma.commercialPublicationActivation.deleteMany()
    const suffix = randomUUID().replace(/-/g, '')
    const code = `POS_INTRO_${suffix.slice(0, 12).toUpperCase()}`
    const staff = await prisma.staff.create({
      data: {
        id: `staff_${suffix}`,
        email: `phase2-${suffix}@example.test`,
        firstName: 'Phase',
        lastName: 'Two',
      },
    })
    const organization = await prisma.organization.create({
      data: { id: `org_${suffix}`, name: 'Phase 2 Test', email: `org-${suffix}@example.test`, phone: '+525500000000' },
    })
    const venue = await prisma.venue.create({
      data: {
        id: `venue_${suffix}`,
        organizationId: organization.id,
        name: 'Phase 2 Venue',
        slug: `phase2-${suffix}`,
      },
    })
    await prisma.staffVenue.create({ data: { staffId: staff.id, venueId: venue.id, role: 'OWNER', active: true } })
    const actor = { staffId: staff.id, reason: 'Prueba integrada Fase 2', permissions: ['commercial:publish'] }
    const draftActor = { staffId: staff.id, reason: actor.reason }

    const initial = buildInitialCommercialDraftV1()
    const catalogDraft = await createCommercialDraft(initial.draft, draftActor)
    const publicationId = `publication_${suffix}`
    const publishedAt = new Date()
    const catalog = buildCommercialCatalogV2({ draft: catalogDraft, publicationId, publishedAt })
    await prisma.commercialPublication.create({
      data: {
        id: publicationId,
        sourceDraftId: catalogDraft.id,
        sourceRevision: catalogDraft.revision,
        schemaVersion: 2,
        snapshot: catalog.snapshot as unknown as Prisma.InputJsonValue,
        checksum: catalog.checksum,
        reason: actor.reason,
        publishedById: staff.id,
        publishedAt,
      },
    })
    await prisma.commercialPublicationActivation.create({
      data: {
        environment: 'PRODUCTION',
        publicationId,
        reason: actor.reason,
        updatedById: staff.id,
      },
    })
    const activationDedupe = `commercial:activation:1:${publicationId}`
    await prisma.commercialPublicationOutbox.create({
      data: {
        eventType: 'PUBLICATION_ACTIVATED',
        publicationId,
        previousPublicationId: null,
        payloadVersion: 1,
        payload: {
          eventId: activationDedupe,
          type: 'PUBLICATION_ACTIVATED',
          publicationId,
          previousPublicationId: null,
          schemaVersion: 2,
          checksum: catalog.checksum,
          occurredAt: publishedAt.toISOString(),
        },
        dedupeKey: activationDedupe,
        nextAttemptAt: publishedAt,
        createdAt: publishedAt,
      },
    })
    const campaignPreflightBaseline = (await commercialReleasePreflightService.run()).campaigns

    const now = Date.now()
    const campaignStartsAt = new Date(now - 60_000).toISOString()
    const campaignEndsAt = new Date(now + 60 * 60_000).toISOString()
    const initialCampaignMinor = 5_000n
    const initialCampaignAmount = formatCommercialMoneyV2(initialCampaignMinor)
    expect(initialCampaignAmount).toBe('50.00')
    const campaignDraft = await commercialCampaignDraftService.createDraft(
      {
        code,
        name: 'POS introducción integrada',
        startsAt: campaignStartsAt,
        endsAt: campaignEndsAt,
        stackingGroups: [],
        rules: [
          {
            code: 'POS_FIFTY',
            type: 'FIXED_PRICE',
            priority: 100,
            target: { productCodes: ['POS'] },
            amount: initialCampaignAmount,
            cycles: 3,
          },
        ],
      },
      draftActor,
    )
    expect(campaignDraft.revision).toBe(1)
    const published = await commercialCampaignPublicationService.publishAndActivate(
      {
        draftId: campaignDraft.id,
        expectedDraftRevision: campaignDraft.revision,
        expectedActivationRevision: null,
        reason: actor.reason,
        confirm: true,
      },
      actor,
    )
    expect(published.version).toMatchObject({ schemaVersion: 2, sourceRevision: campaignDraft.revision })

    const claim = await commercialCampaignClaimService.issue(
      {
        campaignCode: code,
        campaignVersionId: published.version.id,
        channel: 'PAID_META',
        sourceRef: `meta-${suffix}`,
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        confirm: true,
      },
      actor,
      new Date(),
    )
    const acquisition = await commercialAcquisitionContextService.issue({ campaignClaim: claim.claim, utmSource: 'facebook' }, new Date())
    const normalizedLines = [{ targetType: 'PRODUCT' as const, targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }]
    const preview = await commercialPublicQuotePreviewV2Service.preview({
      market: 'MX',
      currency: 'MXN',
      acquisitionToken: acquisition.token,
      lines: normalizedLines,
    })
    const bridged = await commercialQuotePreviewBridgeService.bridge({
      organizationId: organization.id,
      venueId: venue.id,
      actorId: staff.id,
      acquisitionBearer: acquisition.token,
      previewToken: preview.previewToken,
      normalizedLines,
    })
    const created = { quote: bridged.quote.snapshot }

    expect(created.quote.catalogPublicationId).toBe(publicationId)
    expect(created.quote.campaignVersionId).toBe(published.version.id)
    expect(created.quote.totals.total).toBe('58.00')
    expect(created.quote.renewal.total).toBe('288.84')
    const persistedClaim = await prisma.commercialCampaignClaim.findFirstOrThrow({
      where: { campaignVersionId: published.version.id, sourceRef: `meta-${suffix}` },
    })
    const releasePreflight = await commercialReleasePreflightService.run()
    expect(releasePreflight).toMatchObject({
      status: 'PASS',
      catalog: { pointerRevision: 1, chainPublications: 1, historicalV1Verified: 0 },
      offerV3: {
        publishedVersions: expect.any(Number),
        q3a: {
          allowed: {
            offerControlEvents: expect.any(Number),
            directQuotes: expect.any(Number),
            directQuoteAcceptances: expect.any(Number),
          },
          prohibited: {
            campaignActivations: 0,
            campaignClaims: 0,
            acquisitionContexts: 0,
            legacyCampaignLinkedQuotes: 0,
            invalidOfferQuoteShapes: 0,
            previewBridges: 0,
            stripeOperations: 0,
            subscriptionEvents: 0,
          },
        },
      },
      previewCatalogPointers: 0,
    })
    expect(releasePreflight.campaigns).toEqual(campaignPreflightBaseline)
    expect(JSON.stringify(persistedClaim)).not.toContain(claim.claim)
    await expect(
      prisma.$executeRaw`UPDATE "CommercialCampaignClaim" SET "channel" = 'ORGANIC' WHERE "id" = ${persistedClaim.id}`,
    ).rejects.toMatchObject({ meta: expect.objectContaining({ code: '55000' }) })
    await expect(
      prisma.activityLog.count({
        where: { action: 'COMMERCIAL_QUOTE_CREATED', entityId: created.quote.quoteId, actorStaffId: staff.id },
      }),
    ).resolves.toBe(1)
    await expect(
      prisma.$executeRaw`UPDATE "CommercialQuote" SET "totalMinor" = 1 WHERE "id" = ${created.quote.quoteId}`,
    ).rejects.toMatchObject({ meta: expect.objectContaining({ code: '55000' }) })
    const forgedQuoteId = `${created.quote.quoteId}_forged`
    await expect(
      prisma.$executeRaw`
        INSERT INTO "CommercialQuote" (
          "id", "catalogPublicationId", "campaignVersionId", "acquisitionContextId", "organizationId", "venueId", "createdById",
          "schemaVersion", "market", "currency", "snapshot", "checksum", "listSubtotalMinor", "discountMinor", "subtotalMinor",
          "taxMinor", "totalMinor", "renewalSubtotalMinor", "renewalTaxMinor", "renewalTotalMinor", "quotedAt", "expiresAt"
        )
        SELECT
          ${forgedQuoteId}, "catalogPublicationId", "campaignVersionId", "acquisitionContextId", "organizationId", "venueId", "createdById",
          "schemaVersion", "market", "currency",
          jsonb_set(jsonb_set("snapshot", '{quoteId}', to_jsonb(${forgedQuoteId}::text)), '{totals,total}', '"0.01"'::jsonb),
          ${'0'.repeat(64)}, "listSubtotalMinor", "discountMinor", "subtotalMinor", "taxMinor", "totalMinor",
          "renewalSubtotalMinor", "renewalTaxMinor", "renewalTotalMinor", "quotedAt", "expiresAt"
        FROM "CommercialQuote" WHERE "id" = ${created.quote.quoteId}
      `,
    ).rejects.toMatchObject({ meta: expect.objectContaining({ code: '23514' }) })
    const emptySnapshotQuoteId = `${created.quote.quoteId}_empty`
    await expect(
      prisma.$executeRaw`
        INSERT INTO "CommercialQuote" (
          "id", "catalogPublicationId", "campaignVersionId", "acquisitionContextId", "organizationId", "venueId", "createdById",
          "schemaVersion", "market", "currency", "snapshot", "checksum", "listSubtotalMinor", "discountMinor", "subtotalMinor",
          "taxMinor", "totalMinor", "renewalSubtotalMinor", "renewalTaxMinor", "renewalTotalMinor", "quotedAt", "expiresAt"
        )
        SELECT
          ${emptySnapshotQuoteId}, "catalogPublicationId", "campaignVersionId", "acquisitionContextId", "organizationId", "venueId", "createdById",
          "schemaVersion", "market", "currency", '{}'::jsonb, ${'1'.repeat(64)}, "listSubtotalMinor", "discountMinor", "subtotalMinor",
          "taxMinor", "totalMinor", "renewalSubtotalMinor", "renewalTaxMinor", "renewalTotalMinor", "quotedAt", "expiresAt"
        FROM "CommercialQuote" WHERE "id" = ${created.quote.quoteId}
      `,
    ).rejects.toMatchObject({ meta: expect.objectContaining({ code: '23514' }) })

    const acceptInput = {
      quoteId: created.quote.quoteId,
      organizationId: organization.id,
      venueId: venue.id,
      acceptedById: staff.id,
      idempotencyKey: `accept-${suffix}`,
    }
    const [first, second] = await Promise.all([
      activeCommercialQuoteAcceptanceService.accept(acceptInput),
      activeCommercialQuoteAcceptanceService.accept(acceptInput),
    ])
    expect(second.id).toBe(first.id)
    await expect(
      activeCommercialQuoteAcceptanceService.accept({ ...acceptInput, idempotencyKey: `other-${suffix}` }),
    ).rejects.toMatchObject({
      code: 'COMMERCIAL_QUOTE_ALREADY_ACCEPTED',
    })
    await expect(prisma.commercialQuoteAcceptance.count({ where: { quoteId: created.quote.quoteId } })).resolves.toBe(1)

    const reserveInput = {
      id: `stripe_op_${suffix}`,
      acceptanceId: first.id,
      type: 'CHECKOUT_SESSION' as const,
      idempotencyKey: `commercial:${first.id}:checkout-session`,
      requestFingerprint: 'f'.repeat(64),
    }
    const [operationOne, operationTwo] = await Promise.all([
      prismaCommercialStripeCheckoutRepository.reserveOperation(reserveInput),
      prismaCommercialStripeCheckoutRepository.reserveOperation({ ...reserveInput, id: `stripe_op_retry_${suffix}` }),
    ])
    expect(operationTwo.id).toBe(operationOne.id)
    await expect(prisma.commercialStripeOperation.count({ where: { acceptanceId: first.id } })).resolves.toBe(1)
    await expect(prisma.commercialQuoteAcceptance.findUnique({ where: { id: first.id } })).resolves.toMatchObject({
      status: 'STRIPE_PENDING',
      revision: 2,
    })

    const checkoutEffectiveAt = new Date()
    const checkoutEvent = {
      stripeEventId: `evt_checkout_${suffix}`,
      type: 'CHECKOUT_COMPLETED' as const,
      effectiveAt: checkoutEffectiveAt,
      acceptanceId: first.id,
      stripeCheckoutSessionId: `cs_${suffix}`,
      stripeSubscriptionId: `sub_${suffix}`,
    }
    await expect(commercialSubscriptionLifecycleService.reconcile(checkoutEvent)).resolves.toMatchObject({
      matched: true,
      applied: true,
      status: 'ACTIVE',
    })
    await expect(commercialSubscriptionLifecycleService.reconcile(checkoutEvent)).resolves.toMatchObject({
      duplicate: true,
      status: 'ACTIVE',
    })
    await expect(prisma.commercialStripeOperation.findUnique({ where: { id: operationOne.id } })).resolves.toMatchObject({
      stripeCheckoutSessionId: `cs_${suffix}`,
      stripeSubscriptionId: `sub_${suffix}`,
    })
    await expect(
      commercialSubscriptionLifecycleService.reconcile({
        stripeEventId: `evt_stale_${suffix}`,
        type: 'INVOICE_FAILED',
        effectiveAt: new Date(checkoutEffectiveAt.getTime() - 1_000),
        stripeSubscriptionId: `sub_${suffix}`,
      }),
    ).resolves.toMatchObject({ stale: true, status: 'ACTIVE' })
    await expect(prisma.commercialSubscriptionEvent.count({ where: { acceptanceId: first.id } })).resolves.toBe(2)

    const supersededPreview = await commercialPublicQuotePreviewV2Service.preview({
      market: 'MX',
      currency: 'MXN',
      acquisitionToken: acquisition.token,
      lines: normalizedLines,
    })
    const supersededBridge = await commercialQuotePreviewBridgeService.bridge({
      organizationId: organization.id,
      venueId: venue.id,
      actorId: staff.id,
      acquisitionBearer: acquisition.token,
      previewToken: supersededPreview.previewToken,
      normalizedLines,
    })
    const quoteSupersededByRollback = { quote: supersededBridge.quote.snapshot }
    const replacementCampaignMinor = 2_200n
    const replacementCampaignAmount = formatCommercialMoneyV2(replacementCampaignMinor)
    expect(replacementCampaignAmount).toBe('22.00')
    const replacementDraft = await commercialCampaignDraftService.replaceDraft(
      campaignDraft.id,
      {
        code,
        name: 'POS introducción integrada v2',
        startsAt: campaignStartsAt,
        endsAt: campaignEndsAt,
        stackingGroups: [],
        rules: [
          {
            code: 'POS_TWENTY_TWO',
            type: 'FIXED_PRICE',
            priority: 100,
            target: { productCodes: ['POS'] },
            amount: replacementCampaignAmount,
            cycles: 3,
          },
        ],
      },
      campaignDraft.revision,
      draftActor,
    )
    expect(replacementDraft.revision).toBe(2)
    await commercialCampaignPublicationService.publishAndActivate(
      {
        draftId: replacementDraft.id,
        expectedDraftRevision: replacementDraft.revision,
        expectedActivationRevision: published.activation.revision,
        reason: 'Reemplazar la campaña y revocar cotizaciones sin aceptar',
        confirm: true,
      },
      actor,
    )
    await expect(
      commercialPublicQuotePreviewV2Service.preview({
        market: 'MX',
        currency: 'MXN',
        acquisitionToken: acquisition.token,
        lines: normalizedLines,
      }),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_CAMPAIGN_NOT_ACTIVE' })
    await expect(
      activeCommercialQuoteAcceptanceService.accept({
        quoteId: quoteSupersededByRollback.quote.quoteId,
        organizationId: organization.id,
        venueId: venue.id,
        acceptedById: staff.id,
        idempotencyKey: `superseded-${suffix}`,
      }),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_QUOTE_SUPERSEDED' })
    expect(catalogFixture.market.taxRateBasisPoints).toBe(1600)
  })
})
