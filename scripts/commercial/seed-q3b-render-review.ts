import { createHash } from 'node:crypto'

import { Prisma } from '@prisma/client'

import { activateCommercialPublication } from '@/services/commercial/commercialActivation.service'
import { createCommercialDraft } from '@/services/commercial/commercialDraft.service'
import { buildInitialCommercialDraftV1 } from '@/services/commercial/commercialInitialCatalog'
import {
  previewCommercialPublication,
  publishCommercialDraft,
} from '@/services/commercial/commercialPublication.service'
import { commercialOfferPublicationService } from '@/services/commercial/offers/commercialOfferPublication.service'
import {
  createCommercialDirectQuoteV3Service,
  createPrismaCommercialDirectQuoteV3Transaction,
} from '@/services/commercial/quotes-v3/commercialDirectQuoteV3.service'
import {
  createCommercialQuoteV3AcceptanceService,
  createPrismaCommercialQuoteV3AcceptanceTransaction,
} from '@/services/commercial/quotes-v3/commercialQuoteV3Acceptance.service'
import {
  buildCommercialSubscriptionContractSnapshotV1,
  createCommercialSubscriptionContract,
} from '@/services/commercial/billing/subscriptionContract.service'
import { reserveCommercialBillingPaymentAttempt } from '@/services/commercial/billing/paymentAttempt.service'
import {
  approveCommercialManualSpeiCase,
  createCommercialManualSpeiCase,
  registerCommercialManualSpeiEvidence,
  reviewCommercialManualSpeiEvidence,
} from '@/services/commercial/billing/manualSpei.service'
import type { CommercialQuoteSelectionV2 } from '@/services/commercial/commercialQuoteEngineV2.service'
import type { PersistedCommercialQuoteV3 } from '@/services/commercial/quotes-v3/commercialQuoteV3Persistence.service'
import type { CommercialQuoteSnapshotV3 } from '@/types/commercialQuoteV3'
import prisma from '@/utils/prismaClient'

import {
  assertQ3bRenderReviewSeedTarget,
  Q3B_RENDER_REVIEW_CATALOG,
  Q3B_RENDER_REVIEW_MAIN_CONTRACT,
  Q3B_RENDER_REVIEW_MAIN_SELECTIONS,
  Q3B_RENDER_REVIEW_MONEY,
  Q3B_RENDER_REVIEW_OFFER,
  Q3B_RENDER_REVIEW_SCENARIOS,
  Q3B_RENDER_REVIEW_SPEI_SELECTIONS,
} from './q3b-render-review-seed-plan'

assertQ3bRenderReviewSeedTarget(process.env.DATABASE_URL, process.env)

const REVIEW_REASON = 'Datos sintéticos para revisión visual Q3B en Render temporal'
const OFFER_STARTS_AT = new Date('2026-09-01T06:00:00.000Z')
const OFFER_ENDS_AT = new Date('2027-09-01T05:59:59.999Z')
const POLICY_ID = 'q3b-review-manual-spei-policy-v1'
const POLICY_VERSION = 9001
const REVIEWER_ID = 'q3b-review-independent-reviewer'
const APPROVER_ID = 'q3b-review-independent-approver'
const REVIEWER_EMAIL = 'q3b.review.reviewer@avoqado.test'
const APPROVER_EMAIL = 'q3b.review.approver@avoqado.test'

type ReviewIdentity = { id: string; email: string }
type ReviewVenue = { id: string; organizationId: string; slug: string }

function fail(code: string): never {
  throw new Error(code)
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

async function ensureConfiguratorCatalog(publishedById: string): Promise<string> {
  const initial = buildInitialCommercialDraftV1()
  let draft = await prisma.commercialDraft.findUnique({
    where: { sourceKey: Q3B_RENDER_REVIEW_CATALOG.sourceKey },
    select: {
      id: true,
      revision: true,
      status: true,
      featureBindings: {
        select: { capabilityCode: true, product: { select: { code: true } } },
      },
    },
  })
  if (!draft) {
    const created = await createCommercialDraft(
      initial.draft,
      { staffId: publishedById, reason: REVIEW_REASON },
      {
        sourceKey: Q3B_RENDER_REVIEW_CATALOG.sourceKey,
        transactionTimeoutMilliseconds: 30_000,
      },
    )
    draft = await prisma.commercialDraft.findUniqueOrThrow({
      where: { id: created.id },
      select: {
        id: true,
        revision: true,
        status: true,
        featureBindings: {
          select: { capabilityCode: true, product: { select: { code: true } } },
        },
      },
    })
  }
  if (draft.status !== 'ACTIVE') fail('COMMERCIAL_Q3B_RENDER_REVIEW_CATALOG_DRAFT_CONFLICT')
  const bindings = new Set(draft.featureBindings.map(binding => `${binding.product.code}:${binding.capabilityCode}`))
  for (const [productCode, capabilityCodes] of Object.entries(
    Q3B_RENDER_REVIEW_CATALOG.requiredPackageCapabilities,
  )) {
    for (const capabilityCode of capabilityCodes) {
      if (!bindings.has(`${productCode}:${capabilityCode}`)) {
        fail('COMMERCIAL_Q3B_RENDER_REVIEW_CATALOG_DRAFT_CONFLICT')
      }
    }
  }

  const actor = {
    staffId: publishedById,
    permissions: ['commercial:publish'],
    reason: REVIEW_REASON,
    ipAddress: '127.0.0.1',
    userAgent: 'avoqado-q3b-render-review-seed',
  }
  let publication = await prisma.commercialPublication.findFirst({
    where: { sourceDraftId: draft.id, sourceRevision: draft.revision },
    orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
    select: { id: true },
  })
  if (!publication) {
    const preview = await previewCommercialPublication(draft.id, draft.revision, actor)
    publication = await publishCommercialDraft(
      {
        draftId: draft.id,
        expectedRevision: draft.revision,
        previewToken: preview.previewToken,
        checksum: preview.checksum,
        reason: REVIEW_REASON,
        confirm: true,
      },
      actor,
    )
  }

  const active = await prisma.commercialPublicationActivation.findUnique({
    where: { environment: 'PRODUCTION' },
    select: { publicationId: true, revision: true },
  })
  if (active?.publicationId !== publication.id) {
    await activateCommercialPublication(
      {
        publicationId: publication.id,
        expectedActivationRevision: active?.revision ?? 0,
        reason: REVIEW_REASON,
        confirm: true,
      },
      actor,
    )
  }
  return publication.id
}

async function requirePreviewIdentity(email: string): Promise<ReviewIdentity> {
  const staff = await prisma.staff.findUnique({ where: { email }, select: { id: true, email: true } })
  if (!staff) fail('COMMERCIAL_Q3B_RENDER_REVIEW_IDENTITY_MISSING')
  return staff
}

async function requirePreviewVenue(slug: string, organizationId?: string): Promise<ReviewVenue> {
  const venue = await prisma.venue.findUnique({
    where: { slug },
    select: { id: true, organizationId: true, slug: true },
  })
  if (!venue || (organizationId !== undefined && venue.organizationId !== organizationId)) {
    fail('COMMERCIAL_Q3B_RENDER_REVIEW_VENUE_MISSING')
  }
  return venue
}

async function ensurePreviewOwnerVenueAuthority(
  staffId: string,
  organizationId: string,
  venueIds: readonly string[],
): Promise<void> {
  const ownership = await prisma.staffOrganization.findUnique({
    where: { staffId_organizationId: { staffId, organizationId } },
    select: { role: true, isActive: true },
  })
  if (!ownership || ownership.role !== 'OWNER' || !ownership.isActive) {
    fail('COMMERCIAL_Q3B_RENDER_REVIEW_ORGANIZATION_OWNER_REQUIRED')
  }
  await prisma.$transaction(
    venueIds.map(venueId =>
      prisma.staffVenue.upsert({
        where: { staffId_venueId: { staffId, venueId } },
        update: { role: 'SUPERADMIN', active: true, permissionSetId: null },
        create: { staffId, venueId, role: 'SUPERADMIN', active: true },
      }),
    ),
  )
}

async function ensureIndependentStaff(id: string, email: string, firstName: string): Promise<ReviewIdentity> {
  const byEmail = await prisma.staff.findUnique({ where: { email }, select: { id: true, email: true } })
  if (byEmail && byEmail.id !== id) fail('COMMERCIAL_Q3B_RENDER_REVIEW_STAFF_CONFLICT')
  const staff = await prisma.staff.upsert({
    where: { id },
    update: { active: true, emailVerified: true },
    create: {
      id,
      email,
      firstName,
      lastName: 'Revisión Q3B',
      active: true,
      emailVerified: true,
    },
    select: { id: true, email: true },
  })
  if (staff.email !== email) fail('COMMERCIAL_Q3B_RENDER_REVIEW_STAFF_CONFLICT')
  return staff
}

async function ensureOfferDraft(createdById: string): Promise<void> {
  await prisma.$transaction(async tx => {
    const [byId, byCode] = await Promise.all([
      tx.commercialCampaignDraft.findUnique({
        where: { id: Q3B_RENDER_REVIEW_OFFER.draftId },
        include: { rules: true, offerBenefits: true },
      }),
      tx.commercialCampaignDraft.findUnique({
        where: { code: Q3B_RENDER_REVIEW_OFFER.code },
        select: { id: true },
      }),
    ])
    if (byCode && byCode.id !== Q3B_RENDER_REVIEW_OFFER.draftId) {
      fail('COMMERCIAL_Q3B_RENDER_REVIEW_OFFER_CODE_CONFLICT')
    }
    if (!byId) {
      await tx.commercialCampaignDraft.create({
        data: {
          id: Q3B_RENDER_REVIEW_OFFER.draftId,
          code: Q3B_RENDER_REVIEW_OFFER.code,
          name: 'Preview Q3B · POS $50 por 3 meses',
          description: REVIEW_REASON,
          status: 'ACTIVE',
          revision: 1,
          offerSchemaVersion: 3,
          allowedRuleCodeGroups: Prisma.DbNull,
          stackingGroups: [],
          startsAt: OFFER_STARTS_AT,
          endsAt: OFFER_ENDS_AT,
          createdById,
          updatedById: createdById,
          rules: {
            create: {
              code: Q3B_RENDER_REVIEW_OFFER.ruleCode,
              type: 'FIXED_PRICE',
              priority: 100,
              target: { productCodes: ['POS'] },
              amountMinor: Q3B_RENDER_REVIEW_OFFER.amountMinor,
              percentBasisPoints: null,
              cycles: Q3B_RENDER_REVIEW_OFFER.cycles,
            },
          },
        },
      })
      return
    }
    const [rule] = byId.rules
    if (
      byId.code !== Q3B_RENDER_REVIEW_OFFER.code ||
      byId.offerSchemaVersion !== 3 ||
      byId.status !== 'ACTIVE' ||
      byId.revision !== 1 ||
      byId.offerBenefits.length !== 0 ||
      byId.rules.length !== 1 ||
      !rule ||
      rule.code !== Q3B_RENDER_REVIEW_OFFER.ruleCode ||
      rule.type !== 'FIXED_PRICE' ||
      rule.amountMinor !== Q3B_RENDER_REVIEW_OFFER.amountMinor ||
      rule.cycles !== Q3B_RENDER_REVIEW_OFFER.cycles
    ) {
      fail('COMMERCIAL_Q3B_RENDER_REVIEW_OFFER_DRAFT_CONFLICT')
    }
  })
}

async function publishReviewOffer(publishedById: string): Promise<string> {
  await ensureOfferDraft(publishedById)
  const published = await commercialOfferPublicationService.publish(
    {
      draftId: Q3B_RENDER_REVIEW_OFFER.draftId,
      expectedDraftRevision: 1,
      reason: REVIEW_REASON,
      confirm: true,
    },
    {
      staffId: publishedById,
      permissions: ['commercial:publish'],
      reason: REVIEW_REASON,
      ipAddress: '127.0.0.1',
      userAgent: 'avoqado-q3b-render-review-seed',
    },
  )
  return published.snapshot.campaignVersionId
}

function directQuoteService(quoteId: string) {
  return createCommercialDirectQuoteV3Service({
    runInTransaction: (operation, options) =>
      prisma.$transaction(tx => operation(createPrismaCommercialDirectQuoteV3Transaction(tx)), options),
    randomId: () => quoteId,
    sleep: async () => undefined,
    retryDelayMilliseconds: () => 25,
  })
}

function acceptanceService(acceptanceId: string) {
  return createCommercialQuoteV3AcceptanceService({
    runInTransaction: (operation, options) =>
      prisma.$transaction(tx => operation(createPrismaCommercialQuoteV3AcceptanceTransaction(tx)), options),
    randomId: () => acceptanceId,
    sleep: async () => undefined,
    retryDelayMilliseconds: () => 25,
    recordPoisonedResolution: () => fail('COMMERCIAL_Q3B_RENDER_REVIEW_QUOTE_POISONED'),
  })
}

async function ensureQuote(input: {
  quoteId: string
  organizationId: string
  venueId: string
  actorId: string
  offerVersionId: string
  selections: readonly CommercialQuoteSelectionV2[]
  expectedCurrentTotalMinor: string
  expectedRenewalTotalMinor: string
}): Promise<PersistedCommercialQuoteV3> {
  const existing = await prisma.commercialQuote.findUnique({
    where: { id: input.quoteId },
    select: {
      id: true,
      schemaVersion: true,
      organizationId: true,
      venueId: true,
      createdById: true,
      offerVersionId: true,
      snapshot: true,
      checksum: true,
    },
  })
  let quote: PersistedCommercialQuoteV3
  if (existing) {
    if (
      existing.schemaVersion !== 3 ||
      existing.organizationId !== input.organizationId ||
      existing.venueId !== input.venueId ||
      existing.createdById !== input.actorId ||
      existing.offerVersionId !== input.offerVersionId
    ) {
      fail('COMMERCIAL_Q3B_RENDER_REVIEW_QUOTE_CONFLICT')
    }
    quote = {
      id: existing.id,
      snapshot: existing.snapshot as unknown as CommercialQuoteSnapshotV3,
      checksum: existing.checksum,
    }
  } else {
    quote = await directQuoteService(input.quoteId).create({
      organizationId: input.organizationId,
      venueId: input.venueId,
      actorId: input.actorId,
      offerVersionId: input.offerVersionId,
      saasSelections: input.selections,
      hardwareSelections: [],
      rateBlockers: [],
      correlationId: `seed:${input.quoteId}`,
    })
  }
  if (
    quote.snapshot.totals.dueNow.totalMinor !== input.expectedCurrentTotalMinor ||
    quote.snapshot.renewal.totalMinor !== input.expectedRenewalTotalMinor
  ) {
    fail('COMMERCIAL_Q3B_RENDER_REVIEW_MONEY_MISMATCH')
  }
  return quote
}

async function ensureContract(input: {
  quoteId: string
  acceptanceId: string
  acceptanceIdempotencyKey: string
  contractIdempotencyKey: string
  organizationId: string
  venueId: string
  actorId: string
  offerVersionId: string
  selections: readonly CommercialQuoteSelectionV2[]
  expectedCurrentTotalMinor: string
  expectedRenewalTotalMinor: string
}): Promise<{ contractId: string; receivableId: string }> {
  const quote = await ensureQuote(input)
  const acceptance = await acceptanceService(input.acceptanceId).accept({
    quoteId: input.quoteId,
    organizationId: input.organizationId,
    venueId: input.venueId,
    acceptedById: input.actorId,
    idempotencyKey: input.acceptanceIdempotencyKey,
    correlationId: `seed:accept:${input.quoteId}`,
  })
  if (acceptance.id !== input.acceptanceId) fail('COMMERCIAL_Q3B_RENDER_REVIEW_ACCEPTANCE_CONFLICT')
  const snapshot = buildCommercialSubscriptionContractSnapshotV1({
    acceptanceId: acceptance.id,
    quoteChecksum: quote.checksum,
    quote: quote.snapshot,
    timezone: 'America/Mexico_City',
    startsAt: acceptance.acceptedAt,
  })
  const contract = await createCommercialSubscriptionContract(
    { snapshot, idempotencyKey: input.contractIdempotencyKey, graceDays: 5 },
    { host: prisma },
  )
  const [period] = contract.periods
  if (
    contract.periods.length !== 1 ||
    !period ||
    period.amountDueMinor.toString() !== input.expectedCurrentTotalMinor
  ) {
    fail('COMMERCIAL_Q3B_RENDER_REVIEW_CONTRACT_MONEY_MISMATCH')
  }
  return { contractId: contract.contractId, receivableId: period.receivableId }
}

async function ensureManualSpeiPolicy(
  publishedById: string,
  organizationId: string,
  venueId: string,
): Promise<void> {
  const policyChecksum = sha256({
    market: 'MX',
    version: POLICY_VERSION,
    dualApprovalThresholdMinor: Q3B_RENDER_REVIEW_MONEY.policyDualApprovalThresholdMinor.toString(),
    currency: 'MXN',
  })
  await prisma.$transaction(async tx => {
    const active = await tx.commercialManualSpeiPolicyActivation.findUnique({ where: { market: 'MX' } })
    if (active && active.policyVersionId !== POLICY_ID) {
      fail('COMMERCIAL_Q3B_RENDER_REVIEW_SPEI_POLICY_CONFLICT')
    }
    const policy = await tx.commercialManualSpeiPolicyVersion.upsert({
      where: { market_version: { market: 'MX', version: POLICY_VERSION } },
      update: {},
      create: {
        id: POLICY_ID,
        market: 'MX',
        version: POLICY_VERSION,
        dualApprovalThresholdMinor: Q3B_RENDER_REVIEW_MONEY.policyDualApprovalThresholdMinor,
        currency: 'MXN',
        checksum: policyChecksum,
        publishedById,
      },
    })
    if (
      policy.id !== POLICY_ID ||
      policy.dualApprovalThresholdMinor !== Q3B_RENDER_REVIEW_MONEY.policyDualApprovalThresholdMinor ||
      policy.checksum !== policyChecksum
    ) {
      fail('COMMERCIAL_Q3B_RENDER_REVIEW_SPEI_POLICY_CONFLICT')
    }
    if (!active) {
      await tx.commercialManualSpeiPolicyActivation.create({
        data: { market: 'MX', policyVersionId: POLICY_ID, activatedById: publishedById },
      })
      await tx.activityLog.create({
        data: {
          organizationId,
          venueId,
          actorType: 'HUMAN',
          staffId: publishedById,
          actorStaffId: publishedById,
          action: 'COMMERCIAL_MANUAL_SPEI_POLICY_ACTIVATED',
          entity: 'CommercialManualSpeiPolicyVersion',
          entityId: POLICY_ID,
          data: {
            schemaVersion: 1,
            market: 'MX',
            version: POLICY_VERSION,
            dualApprovalThresholdMinor:
              Q3B_RENDER_REVIEW_MONEY.policyDualApprovalThresholdMinor.toString(),
            reason: REVIEW_REASON,
          },
        },
      })
    }
  })
}

async function ensureEvidence(input: {
  caseId: string
  organizationId: string
  venueId: string
  uploadedById: string
  scenarioKey: string
}): Promise<string> {
  const existing = await prisma.commercialManualSpeiEvidence.findUnique({
    where: { caseId_sequence: { caseId: input.caseId, sequence: 1 } },
  })
  const storageObjectKey = `private/commercial-spei/${input.organizationId}/${input.caseId}/demo-${input.scenarioKey.toLowerCase()}.png`
  const contentSha256 = sha256({ caseId: input.caseId, scenario: input.scenarioKey })
  if (existing) {
    if (
      existing.storageObjectKey !== storageObjectKey ||
      existing.contentSha256 !== contentSha256 ||
      existing.uploadedById !== input.uploadedById
    ) {
      fail('COMMERCIAL_Q3B_RENDER_REVIEW_EVIDENCE_CONFLICT')
    }
    return existing.id
  }
  const created = await registerCommercialManualSpeiEvidence(
    {
      caseId: input.caseId,
      organizationId: input.organizationId,
      venueId: input.venueId,
      uploadedById: input.uploadedById,
      storageObjectKey,
      contentSha256,
      mimeType: 'image/png',
      sizeBytes: 184_320,
    },
    { host: prisma },
  )
  return created.evidenceId
}

async function ensureSpeiCase(input: {
  scenario: (typeof Q3B_RENDER_REVIEW_SCENARIOS)[number]
  organizationId: string
  venueId: string
  creatorId: string
  reviewerId: string
  approverId: string
  receivableId: string
  observedAt: Date
}): Promise<string> {
  const key = input.scenario.key.toLowerCase()
  const attemptIdempotencyKey = `q3b.review.spei.${key}.attempt.20260902`
  const requestFingerprint = sha256({ scenario: input.scenario.key, receivableId: input.receivableId })
  const existingAttempt = await prisma.commercialBillingPaymentAttempt.findUnique({
    where: { idempotencyKey: attemptIdempotencyKey },
    select: {
      id: true,
      receivableId: true,
      provider: true,
      amountMinor: true,
      currency: true,
      requestFingerprint: true,
    },
  })
  if (
    existingAttempt &&
    (existingAttempt.receivableId !== input.receivableId ||
      existingAttempt.provider !== 'MANUAL_SPEI' ||
      existingAttempt.currency !== 'MXN' ||
      existingAttempt.requestFingerprint !== requestFingerprint)
  ) {
    fail('COMMERCIAL_Q3B_RENDER_REVIEW_SPEI_ATTEMPT_CONFLICT')
  }
  const attempt = existingAttempt
    ? { paymentAttemptId: existingAttempt.id, amountMinor: existingAttempt.amountMinor }
    : await reserveCommercialBillingPaymentAttempt(
        {
          organizationId: input.organizationId,
          venueId: input.venueId,
          receivableId: input.receivableId,
          provider: 'MANUAL_SPEI',
          idempotencyKey: attemptIdempotencyKey,
          requestFingerprint,
        },
        { host: prisma },
      )
  let speiCase = await prisma.commercialManualSpeiCase.findUnique({
    where: { paymentAttemptId: attempt.paymentAttemptId },
  })
  if (!speiCase) {
    const created = await createCommercialManualSpeiCase(
      {
        organizationId: input.organizationId,
        venueId: input.venueId,
        receivableId: input.receivableId,
        paymentAttemptId: attempt.paymentAttemptId,
        observedAmountMinor: attempt.amountMinor,
        bankReference: input.scenario.bankReference,
        receivingAccountFingerprint: sha256({ account: 'Q3B_RENDER_REVIEW_SPEI' }),
        observedAt: input.observedAt,
        attributedCommercialActorIds: [],
        createdById: input.creatorId,
      },
      { host: prisma },
    )
    speiCase = await prisma.commercialManualSpeiCase.findUniqueOrThrow({ where: { id: created.caseId } })
  }
  if (
    speiCase.organizationId !== input.organizationId ||
    speiCase.venueId !== input.venueId ||
    speiCase.receivableId !== input.receivableId ||
    speiCase.observedAmountMinor !== attempt.amountMinor ||
    speiCase.bankReference !== input.scenario.bankReference
  ) {
    fail('COMMERCIAL_Q3B_RENDER_REVIEW_SPEI_CASE_CONFLICT')
  }

  const evidenceId = await ensureEvidence({
    caseId: speiCase.id,
    organizationId: input.organizationId,
    venueId: input.venueId,
    uploadedById: input.creatorId,
    scenarioKey: input.scenario.key,
  })

  if (input.scenario.key === 'AWAITING_SECOND_APPROVAL') {
    if (speiCase.status === 'PENDING_REVIEW') {
      await reviewCommercialManualSpeiEvidence(
        {
          evidenceId,
          organizationId: input.organizationId,
          venueId: input.venueId,
          actorId: input.reviewerId,
          action: 'ACCEPT',
          reason: null,
        },
        { host: prisma },
      )
    }
    const approvals = await prisma.commercialManualSpeiApproval.count({ where: { caseId: speiCase.id } })
    if (approvals === 0) {
      const result = await approveCommercialManualSpeiCase(
        {
          caseId: speiCase.id,
          organizationId: input.organizationId,
          venueId: input.venueId,
          actorId: input.approverId,
          now: new Date(input.observedAt.getTime() + 120_000),
        },
        { host: prisma },
      )
      if (result.decision !== 'PENDING_SECOND_APPROVAL') {
        fail('COMMERCIAL_Q3B_RENDER_REVIEW_SECOND_APPROVAL_EXPECTED')
      }
    }
  } else if (input.scenario.key === 'REJECTED') {
    if (speiCase.status === 'PENDING_REVIEW') {
      await reviewCommercialManualSpeiEvidence(
        {
          evidenceId,
          organizationId: input.organizationId,
          venueId: input.venueId,
          actorId: input.reviewerId,
          action: 'REJECT',
          reason: 'La referencia de la evidencia sintética no coincide.',
        },
        { host: prisma },
      )
    }
  } else if (input.scenario.key === 'RECONCILED') {
    if (speiCase.status === 'PENDING_REVIEW') {
      await reviewCommercialManualSpeiEvidence(
        {
          evidenceId,
          organizationId: input.organizationId,
          venueId: input.venueId,
          actorId: input.reviewerId,
          action: 'ACCEPT',
          reason: null,
        },
        { host: prisma },
      )
    }
    speiCase = await prisma.commercialManualSpeiCase.findUniqueOrThrow({ where: { id: speiCase.id } })
    if (speiCase.status === 'AWAITING_APPROVAL') {
      const result = await approveCommercialManualSpeiCase(
        {
          caseId: speiCase.id,
          organizationId: input.organizationId,
          venueId: input.venueId,
          actorId: input.approverId,
          now: new Date(input.observedAt.getTime() + 120_000),
        },
        { host: prisma },
      )
      if (result.decision !== 'RECONCILED') fail('COMMERCIAL_Q3B_RENDER_REVIEW_RECONCILIATION_EXPECTED')
    }
  }
  const expectedStatus =
    input.scenario.key === 'AWAITING_SECOND_APPROVAL' ? 'AWAITING_APPROVAL' : input.scenario.key
  const final = await prisma.commercialManualSpeiCase.findUniqueOrThrow({ where: { id: speiCase.id } })
  if (final.status !== expectedStatus) fail('COMMERCIAL_Q3B_RENDER_REVIEW_SPEI_STATUS_MISMATCH')
  return final.id
}

async function seed(): Promise<void> {
  const database = await prisma.$queryRaw<Array<{ database: string }>>`SELECT current_database() AS database`
  if (database[0]?.database !== 'avoqado_q3b_preview') fail('COMMERCIAL_Q3B_RENDER_REVIEW_DATABASE_MISMATCH')

  const dashboardOwner = await requirePreviewIdentity('founder.dashboard.q3b@avoqado.test')
  const superadmin = await requirePreviewIdentity('founder.superadmin.q3b@avoqado.test')
  const fullVenue = await requirePreviewVenue('avoqado-full')
  const wellnessVenue = await requirePreviewVenue('avoqado-wellness', fullVenue.organizationId)
  const reviewer = await ensureIndependentStaff(REVIEWER_ID, REVIEWER_EMAIL, 'Revisor independiente')
  const approver = await ensureIndependentStaff(APPROVER_ID, APPROVER_EMAIL, 'Aprobador independiente')

  await ensurePreviewOwnerVenueAuthority(dashboardOwner.id, fullVenue.organizationId, [
    fullVenue.id,
    wellnessVenue.id,
  ])

  const catalogPublicationId = await ensureConfiguratorCatalog(superadmin.id)
  const offerVersionId = await publishReviewOffer(superadmin.id)
  const main = await ensureContract({
    quoteId: Q3B_RENDER_REVIEW_MAIN_CONTRACT.quoteId,
    acceptanceId: Q3B_RENDER_REVIEW_MAIN_CONTRACT.acceptanceId,
    acceptanceIdempotencyKey: Q3B_RENDER_REVIEW_MAIN_CONTRACT.acceptanceIdempotencyKey,
    contractIdempotencyKey: Q3B_RENDER_REVIEW_MAIN_CONTRACT.contractIdempotencyKey,
    organizationId: fullVenue.organizationId,
    venueId: fullVenue.id,
    actorId: dashboardOwner.id,
    offerVersionId,
    selections: Q3B_RENDER_REVIEW_MAIN_SELECTIONS,
    expectedCurrentTotalMinor: Q3B_RENDER_REVIEW_MONEY.mainCurrentTotalMinor,
    expectedRenewalTotalMinor: Q3B_RENDER_REVIEW_MONEY.mainRenewalTotalMinor,
  })

  await ensureManualSpeiPolicy(superadmin.id, wellnessVenue.organizationId, wellnessVenue.id)
  const caseIds: string[] = []
  for (const [index, scenario] of Q3B_RENDER_REVIEW_SCENARIOS.entries()) {
    const contract = await ensureContract({
      quoteId: scenario.quoteId,
      acceptanceId: scenario.acceptanceId,
      acceptanceIdempotencyKey: `q3b.review.spei.${scenario.key.toLowerCase()}.acceptance.20260902`,
      contractIdempotencyKey: `q3b.review.spei.${scenario.key.toLowerCase()}.contract.20260902`,
      organizationId: wellnessVenue.organizationId,
      venueId: wellnessVenue.id,
      actorId: dashboardOwner.id,
      offerVersionId,
      selections: Q3B_RENDER_REVIEW_SPEI_SELECTIONS,
      expectedCurrentTotalMinor: Q3B_RENDER_REVIEW_MONEY.speiCurrentTotalMinor,
      expectedRenewalTotalMinor: Q3B_RENDER_REVIEW_MONEY.speiRenewalTotalMinor,
    })
    caseIds.push(
      await ensureSpeiCase({
        scenario,
        organizationId: wellnessVenue.organizationId,
        venueId: wellnessVenue.id,
        creatorId: dashboardOwner.id,
        reviewerId: reviewer.id,
        approverId: approver.id,
        receivableId: contract.receivableId,
        observedAt: new Date(`2026-09-02T21:${String(40 + index).padStart(2, '0')}:00.000Z`),
      }),
    )
  }

  const finalCases = await prisma.commercialManualSpeiCase.findMany({
    where: { id: { in: caseIds } },
    select: { id: true, status: true, requiredApprovals: true, exceptionReasons: true },
    orderBy: { observedAt: 'asc' },
  })
  const emptyVenue = await requirePreviewVenue('avoqado-empty', fullVenue.organizationId)
  const emptyContracts = await prisma.commercialSubscriptionContract.count({
    where: { organizationId: emptyVenue.organizationId, venueId: emptyVenue.id },
  })
  if (emptyContracts !== 0) fail('COMMERCIAL_Q3B_RENDER_REVIEW_EMPTY_FALLBACK_CHANGED')

  console.log(
    JSON.stringify({
      status: 'Q3B_RENDER_REVIEW_READY',
      main: {
        venueSlug: fullVenue.slug,
        contractId: main.contractId,
        catalogPublicationId,
        currentTotalMinor: Q3B_RENDER_REVIEW_MONEY.mainCurrentTotalMinor,
        renewalTotalMinor: Q3B_RENDER_REVIEW_MONEY.mainRenewalTotalMinor,
      },
      legacyFallbackVenueSlug: emptyVenue.slug,
      spei: { venueSlug: wellnessVenue.slug, cases: finalCases },
    }),
  )
}

seed()
  .catch(error => {
    console.error(error instanceof Error ? error.message : 'COMMERCIAL_Q3B_RENDER_REVIEW_SEED_FAILED')
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
