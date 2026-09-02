import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { Prisma, StaffRole } from '@prisma/client'
import AppError from '@/errors/AppError'
import { evaluatePermissionList, hasPermission } from '@/lib/permissions'
import logger from '@/config/logger'
import type { CommercialAcquisitionContextRecordV1 } from '@/types/commercialQuote'
import type { CommercialQuoteSnapshotV2 } from '@/types/commercialV2'
import prisma from '@/utils/prismaClient'
import { env } from '@/config/env'
import type { CommercialQuotePreviewSecretsInput } from '@/config/commercialQuotePreviewSecrets'
import { canonicalJsonBytesV2 } from './commercialCanonicalJsonV2.service'
import { catalogDecodeInput } from './commercialCatalogFallbackBoundary.service'
import { commercialAcquisitionContextService } from './commercialAcquisitionContext.service'
import { commercialCampaignQuoteAuthorityLoader } from './commercialCampaignClaim.service'
import {
  CommercialArtifactCodecError,
  decodeAndVerifyStoredCommercialCampaignV2,
  decodeAndVerifyStoredCommercialCatalogV2,
  decodeAndVerifyStoredCommercialQuoteV2,
  type CatalogV2Result,
  type CampaignV2Result,
  type QuoteV2Result,
  type VerifiedStoredCommercialCampaignV2,
  type VerifiedStoredCommercialCatalogV2,
  type VerifiedStoredCommercialQuoteV2,
} from './commercialArtifactCodecRegistry.service'
import { fingerprintCommercialSelectionV2 } from './commercialFingerprintV2.service'
import { evaluateCommercialQuoteV2, type CommercialQuoteSelectionV2 } from './commercialQuoteEngineV2.service'
import type { CommercialQuotePersistenceTransaction, PersistedCommercialQuoteV2 } from './commercialQuotePersistence.service'
import { persistCommercialQuoteV2 } from './commercialQuotePersistence.service'
import {
  reconstructCommercialQuotePreviewV2,
  type CommercialQuotePreviewReconstructionInputV2,
  type CommercialQuotePreviewReconstructionResultV2,
} from './commercialQuotePreviewReconstruction.service'
import { verifyCommercialQuotePreviewTokenV2, type CommercialQuotePreviewTokenPayloadV2 } from './commercialQuotePreviewToken.service'
import { withVerifiedActiveCatalogV2, type CommercialQuoteV2AuthorityContext } from './commercialQuoteV2Authority.service'
import { buildCommercialQuoteV2 } from './commercialQuoteV2Builder.service'

export const PREVIEW_QUOTE_UNIQUE_CONSTRAINT = 'CommercialQuotePreviewBridge_previewQuoteId_key'
const REQUIRED_PERMISSION = 'billing:subscriptions:manage'
const SHA256_HEX = /^[0-9a-f]{64}$/

type SafeAcquisitionContext = Omit<CommercialAcquisitionContextRecordV1, 'tokenHash'>
type CatalogAuthority = CatalogV2Result | VerifiedStoredCommercialCatalogV2
type CampaignAuthority = CampaignV2Result | VerifiedStoredCommercialCampaignV2
type ReplayQuote = Pick<VerifiedStoredCommercialQuoteV2, 'snapshot' | 'checksum'> | PersistedCommercialQuoteV2

export interface CommercialPreviewQuoteBindingV2 {
  previewQuoteId: string
  previewChecksum: string
  acquisitionContextId: string
  organizationId: string
  venueId: string
  actorId: string
  selectionFingerprint: string
  venueQuoteId: string
  quote: ReplayQuote
}

export interface LockedCommercialPreviewBridgeAuthorityV2 {
  now: Date
  catalog: CatalogAuthority
  campaign: CampaignAuthority | null
  acquisition: SafeAcquisitionContext
  binding: CommercialPreviewQuoteBindingV2 | null
}

export interface CommercialQuotePreviewBridgeInput {
  organizationId: string
  venueId: string
  actorId: string
  acquisitionBearer: string
  previewToken: string
  normalizedLines: CommercialQuoteSelectionV2[]
}

interface LoadLockedBridgeInput extends CommercialQuotePreviewBridgeInput {
  expectedCatalogPublicationId: string
  expectedCatalogChecksum: string
  expectedCampaignChecksum: string | null
  expected: CommercialQuotePreviewTokenPayloadV2
  selectionFingerprint: string
}

export type BridgeCommercialQuotePreviewResultV2 =
  | { outcome: 'CREATED'; quote: PersistedCommercialQuoteV2 }
  | { outcome: 'REPLAYED'; quote: ReplayQuote }

export interface CommercialPreviewBridgeTelemetryEvent {
  eventName: string
  schemaVersion: 2
  artifactKind: 'QUOTE'
  code: string
}

export function recordCommercialPreviewBridgeEvent(event: CommercialPreviewBridgeTelemetryEvent): void {
  logger.info('Commercial preview bridge outcome', {
    event: event.eventName,
    schemaVersion: event.schemaVersion,
    artifactKind: event.artifactKind,
    code: event.code,
  })
}

export interface CommercialQuotePreviewBridgeDependencies {
  secrets: CommercialQuotePreviewSecretsInput
  now(): Date
  randomId(): string
  withVerifiedActiveCatalogV2<T>(operation: (context: CommercialQuoteV2AuthorityContext) => Promise<T>): Promise<T>
  preflightAuthority(input: Pick<CommercialQuotePreviewBridgeInput, 'organizationId' | 'venueId' | 'actorId'>): Promise<boolean>
  verifyToken(token: string, secrets: CommercialQuotePreviewSecretsInput, now: Date): CommercialQuotePreviewTokenPayloadV2
  fingerprintSelection(input: { lines: readonly CommercialQuoteSelectionV2[] }): string
  resolveAcquisition(context: CommercialQuoteV2AuthorityContext, bearer: string, now: Date): Promise<SafeAcquisitionContext>
  loadCampaign(
    context: CommercialQuoteV2AuthorityContext,
    campaignVersionId: string,
    issuedAt: Date,
  ): Promise<VerifiedStoredCommercialCampaignV2>
  reconstruct(input: CommercialQuotePreviewReconstructionInputV2): CommercialQuotePreviewReconstructionResultV2
  runInReadCommitted<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>
  loadLockedAuthorityAndBinding(
    tx: Prisma.TransactionClient,
    input: LoadLockedBridgeInput,
  ): Promise<LockedCommercialPreviewBridgeAuthorityV2>
  persistQuote(result: QuoteV2Result, tx: Prisma.TransactionClient): Promise<PersistedCommercialQuoteV2>
  insertBinding(tx: Prisma.TransactionClient, input: Omit<CommercialPreviewQuoteBindingV2, 'quote'>): Promise<void>
  recordEvent(event: CommercialPreviewBridgeTelemetryEvent): void
}

function bridgeError(code: string, message: string, statusCode: number): AppError {
  return new AppError(message, statusCode, true, code)
}

function authorityRequired(): never {
  throw bridgeError('COMMERCIAL_PREVIEW_BRIDGE_AUTHORITY_REQUIRED', 'No tienes autorización vigente para cotizar en esta sucursal.', 403)
}

function superseded(): never {
  throw bridgeError('COMMERCIAL_PREVIEW_SUPERSEDED', 'La oferta cambió. Genera una nueva cotización.', 409)
}

function conflict(): never {
  throw bridgeError('COMMERCIAL_PREVIEW_BRIDGE_CONFLICT', 'Este comprobante ya se usó para otra cotización.', 409)
}

function retryMissing(): never {
  throw bridgeError('COMMERCIAL_PREVIEW_BRIDGE_RETRY_MISSING', 'No fue posible recuperar la cotización ganadora.', 409)
}

function quoteInvalid(): never {
  throw bridgeError('COMMERCIAL_PREVIEW_BRIDGE_QUOTE_INVALID', 'La cotización almacenada no pudo verificarse.', 409)
}

function sameHash(left: string, right: string): boolean {
  return SHA256_HEX.test(left) && SHA256_HEX.test(right) && timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

function ownConstraint(value: unknown, seen = new WeakSet<object>()): string | null {
  if (typeof value !== 'object' || value === null || seen.has(value)) return null
  seen.add(value)
  for (const key of ['constraint', 'constraint_name', 'constraintName'] as const) {
    const candidate = Object.getOwnPropertyDescriptor(value, key)?.value
    if (typeof candidate === 'string') return candidate
  }
  for (const key of ['cause', 'meta', 'originalError', 'driverAdapterError'] as const) {
    const nested = Object.getOwnPropertyDescriptor(value, key)?.value
    const candidate = ownConstraint(nested, seen)
    if (candidate) return candidate
  }
  return null
}

function isExactPrismaPreviewTarget(error: object): boolean {
  const meta = Object.getOwnPropertyDescriptor(error, 'meta')?.value
  if (typeof meta !== 'object' || meta === null) return false
  const modelName = Object.getOwnPropertyDescriptor(meta, 'modelName')?.value
  const target = Object.getOwnPropertyDescriptor(meta, 'target')?.value
  return (
    modelName === 'CommercialQuotePreviewBridge' &&
    Array.isArray(target) &&
    target.length === 1 &&
    Object.getOwnPropertyDescriptor(target, '0')?.value === 'previewQuoteId'
  )
}

export function isPreviewQuoteBindingUniqueConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = Object.getOwnPropertyDescriptor(error, 'code')?.value
  if (code !== '23505' && code !== 'P2002') return false
  return ownConstraint(error) === PREVIEW_QUOTE_UNIQUE_CONSTRAINT || (code === 'P2002' && isExactPrismaPreviewTarget(error))
}

function economicProjection(snapshot: CommercialQuoteSnapshotV2) {
  return {
    catalogPublicationId: snapshot.catalogPublicationId,
    campaignVersionId: snapshot.campaignVersionId,
    campaignCode: snapshot.campaignCode,
    market: snapshot.market,
    currency: snapshot.currency,
    lines: snapshot.lines,
    entitlementGrants: snapshot.entitlementGrants,
    totals: snapshot.totals,
    renewal: snapshot.renewal,
  }
}

function assertEquivalentEconomics(preview: CommercialQuoteSnapshotV2, venue: CommercialQuoteSnapshotV2): void {
  if (!canonicalJsonBytesV2(economicProjection(preview)).equals(canonicalJsonBytesV2(economicProjection(venue)))) superseded()
}

function assertCampaignCurrent(campaign: CampaignAuthority | null, now: Date): void {
  if (!campaign) return
  const startsAt = Date.parse(campaign.snapshot.startsAt)
  const endsAt = Date.parse(campaign.snapshot.endsAt)
  const nowTime = now.getTime()
  if (
    campaign.snapshot.status !== 'ACTIVE' ||
    !Number.isFinite(startsAt) ||
    !Number.isFinite(endsAt) ||
    !Number.isFinite(nowTime) ||
    startsAt >= endsAt ||
    nowTime < startsAt ||
    nowTime >= endsAt
  ) {
    superseded()
  }
}

function assertReplayTuple(
  binding: CommercialPreviewQuoteBindingV2,
  input: CommercialQuotePreviewBridgeInput,
  expected: CommercialQuotePreviewTokenPayloadV2,
  selectionFingerprint: string,
): void {
  if (
    binding.previewQuoteId !== expected.previewQuoteId ||
    !sameHash(binding.previewChecksum, expected.previewChecksum) ||
    binding.acquisitionContextId !== expected.acquisitionContextId ||
    binding.organizationId !== input.organizationId ||
    binding.venueId !== input.venueId ||
    binding.actorId !== input.actorId ||
    !sameHash(binding.selectionFingerprint, selectionFingerprint)
  ) {
    conflict()
  }
  const snapshot = binding.quote.snapshot
  if (
    snapshot.schemaVersion !== 2 ||
    binding.venueQuoteId !== snapshot.quoteId ||
    snapshot.subject.kind !== 'VENUE' ||
    snapshot.subject.organizationId !== input.organizationId ||
    snapshot.subject.venueId !== input.venueId ||
    snapshot.subject.actorId !== input.actorId ||
    snapshot.acquisitionContextId !== expected.acquisitionContextId ||
    snapshot.derivedFromPreview?.previewQuoteId !== expected.previewQuoteId ||
    !sameHash(snapshot.derivedFromPreview.previewChecksum, expected.previewChecksum) ||
    !sameHash(snapshot.derivedFromPreview.selectionFingerprint, selectionFingerprint)
  ) {
    quoteInvalid()
  }
}

function campaignDecodeInput(row: {
  id: string
  campaignCode: string
  sourceRevision: number
  schemaVersion: number
  snapshot: unknown
  checksum: string
  publishedAt: Date
}) {
  return {
    kind: 'CAMPAIGN' as const,
    rowSchemaVersion: row.schemaVersion,
    snapshot: row.snapshot,
    checksum: row.checksum,
    rowContext: {
      kind: 'CAMPAIGN' as const,
      id: row.id,
      campaignCode: row.campaignCode,
      sourceRevision: row.sourceRevision,
      schemaVersion: row.schemaVersion,
      publishedAt: row.publishedAt,
    },
  }
}

async function preflightExactTargetAuthority(input: { organizationId: string; venueId: string; actorId: string }): Promise<boolean> {
  const membership = await prisma.staffVenue.findUnique({
    where: { staffId_venueId: { staffId: input.actorId, venueId: input.venueId } },
    include: {
      staff: { select: { active: true } },
      venue: { select: { organizationId: true } },
      permissionSet: { select: { permissions: true } },
    },
  })
  if (!membership?.active || !membership.staff.active || membership.venue.organizationId !== input.organizationId) return false
  if (membership.permissionSet) return evaluatePermissionList(membership.permissionSet.permissions, REQUIRED_PERMISSION)
  const roleOverride = await prisma.venueRolePermission.findUnique({
    where: { venueId_role: { venueId: input.venueId, role: membership.role } },
    select: { permissions: true, deniedPermissions: true },
  })
  return hasPermission(membership.role, roleOverride?.permissions, REQUIRED_PERMISSION, roleOverride?.deniedPermissions)
}

async function loadVerifiedReplay(tx: Prisma.TransactionClient, previewQuoteId: string): Promise<CommercialPreviewQuoteBindingV2 | null> {
  const binding = await tx.commercialQuotePreviewBridge.findUnique({
    where: { previewQuoteId },
    include: {
      venueQuote: {
        include: {
          catalogPublication: true,
          campaignVersion: true,
          venue: { select: { organizationId: true } },
        },
      },
    },
  })
  if (!binding) return null
  try {
    const row = binding.venueQuote
    const quote = decodeAndVerifyStoredCommercialQuoteV2({
      kind: 'QUOTE',
      rowSchemaVersion: row.schemaVersion,
      snapshot: row.snapshot,
      checksum: row.checksum,
      rowContext: {
        kind: 'QUOTE',
        id: row.id,
        catalogPublicationId: row.catalogPublicationId,
        campaignVersionId: row.campaignVersionId,
        acquisitionContextId: row.acquisitionContextId,
        organizationId: row.organizationId,
        venueId: row.venueId,
        createdById: row.createdById,
        schemaVersion: row.schemaVersion,
        market: row.market,
        currency: row.currency,
        quotedAt: row.quotedAt,
        expiresAt: row.expiresAt,
        listSubtotalMinor: row.listSubtotalMinor,
        discountMinor: row.discountMinor,
        subtotalMinor: row.subtotalMinor,
        taxMinor: row.taxMinor,
        totalMinor: row.totalMinor,
        renewalSubtotalMinor: row.renewalSubtotalMinor,
        renewalTaxMinor: row.renewalTaxMinor,
        renewalTotalMinor: row.renewalTotalMinor,
        venueOrganizationId: row.venue?.organizationId ?? null,
      },
      authorities: {
        catalog: catalogDecodeInput(row.catalogPublication),
        campaign: row.campaignVersion ? campaignDecodeInput(row.campaignVersion) : null,
      },
    })
    return { ...binding, quote }
  } catch (error) {
    if (error instanceof CommercialArtifactCodecError) return quoteInvalid()
    throw error
  }
}

async function loadLockedAuthorityAndBinding(
  tx: Prisma.TransactionClient,
  input: LoadLockedBridgeInput,
): Promise<LockedCommercialPreviewBridgeAuthorityV2> {
  const catalogRows = await tx.$queryRaw<
    Array<{
      id: string
      sourceRevision: number
      schemaVersion: number
      snapshot: unknown
      checksum: string
      publishedAt: Date
    }>
  >(Prisma.sql`
    SELECT publication."id", publication."sourceRevision", publication."schemaVersion",
           publication."snapshot", publication."checksum", publication."publishedAt"
    FROM "CommercialPublicationActivation" AS activation
    INNER JOIN "CommercialPublication" AS publication ON publication."id" = activation."publicationId"
    WHERE activation."environment" = 'PRODUCTION'
    FOR SHARE OF activation, publication
  `)
  const catalogRow = catalogRows[0]
  if (!catalogRow || catalogRow.id !== input.expectedCatalogPublicationId || catalogRow.checksum !== input.expectedCatalogChecksum)
    superseded()
  let catalog: VerifiedStoredCommercialCatalogV2
  try {
    catalog = decodeAndVerifyStoredCommercialCatalogV2(catalogDecodeInput(catalogRow as never))
  } catch (error) {
    if (error instanceof CommercialArtifactCodecError) return superseded()
    throw error
  }

  let campaign: VerifiedStoredCommercialCampaignV2 | null = null
  if (input.expected.campaignVersionId) {
    const campaignRows = await tx.$queryRaw<
      Array<{
        id: string
        campaignCode: string
        sourceRevision: number
        schemaVersion: number
        snapshot: unknown
        checksum: string
        publishedAt: Date
      }>
    >(Prisma.sql`
      SELECT version."id", version."campaignCode", version."sourceRevision", version."schemaVersion",
             version."snapshot", version."checksum", version."publishedAt"
      FROM "CommercialCampaignActivation" AS activation
      INNER JOIN "CommercialCampaignVersion" AS version ON version."id" = activation."campaignVersionId"
      WHERE activation."environment" = 'PRODUCTION'
        AND activation."campaignVersionId" = ${input.expected.campaignVersionId}
      FOR SHARE OF activation, version
    `)
    try {
      if (!campaignRows[0] || campaignRows[0].checksum !== input.expectedCampaignChecksum) return superseded()
      campaign = decodeAndVerifyStoredCommercialCampaignV2(campaignDecodeInput(campaignRows[0]))
    } catch (error) {
      if (error instanceof CommercialArtifactCodecError) return superseded()
      throw error
    }
  }

  const acquisitionRows = await tx.$queryRaw<
    Array<CommercialAcquisitionContextRecordV1 & { attribution: CommercialAcquisitionContextRecordV1['attribution'] }>
  >(Prisma.sql`
    SELECT "id", "tokenHash", "campaignVersionId", "channel", "attribution", "createdAt", "expiresAt"
    FROM "CommercialAcquisitionContext"
    WHERE "id" = ${input.expected.acquisitionContextId}
    FOR SHARE
  `)
  const clockRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`
  const now = clockRows[0]?.now ?? new Date(Number.NaN)
  const acquisitionRow = acquisitionRows[0]
  const bearerHash = createHash('sha256').update(input.acquisitionBearer).digest('hex')
  if (
    !acquisitionRow ||
    !sameHash(acquisitionRow.tokenHash, bearerHash) ||
    acquisitionRow.campaignVersionId !== input.expected.campaignVersionId ||
    acquisitionRow.expiresAt.getTime() <= now.getTime()
  ) {
    superseded()
  }

  const venueRows = await tx.$queryRaw<Array<{ organizationId: string }>>(Prisma.sql`
    SELECT "organizationId" FROM "Venue" WHERE "id" = ${input.venueId} FOR SHARE
  `)
  const staffRows = await tx.$queryRaw<Array<{ active: boolean }>>(Prisma.sql`
    SELECT "active" FROM "Staff" WHERE "id" = ${input.actorId} FOR SHARE
  `)
  const membershipRows = await tx.$queryRaw<
    Array<{ id: string; role: StaffRole; permissionSetId: string | null; active: boolean }>
  >(Prisma.sql`
    SELECT "id", "role", "permissionSetId", "active"
    FROM "StaffVenue"
    WHERE "staffId" = ${input.actorId} AND "venueId" = ${input.venueId}
    FOR SHARE
  `)
  const membership = membershipRows[0]
  if (venueRows[0]?.organizationId !== input.organizationId || staffRows[0]?.active !== true || membership?.active !== true) {
    authorityRequired()
  }

  let authorized = false
  if (membership.permissionSetId) {
    const permissionSets = await tx.$queryRaw<Array<{ permissions: string[] }>>(Prisma.sql`
      SELECT "permissions" FROM "PermissionSet"
      WHERE "id" = ${membership.permissionSetId} AND "venueId" = ${input.venueId}
      FOR SHARE
    `)
    authorized = !!permissionSets[0] && evaluatePermissionList(permissionSets[0].permissions, REQUIRED_PERMISSION)
  } else {
    const rolePermissions = await tx.$queryRaw<Array<{ permissions: string[]; deniedPermissions: string[] }>>(Prisma.sql`
      SELECT "permissions", "deniedPermissions" FROM "VenueRolePermission"
      WHERE "venueId" = ${input.venueId} AND "role" = CAST(${membership.role} AS "StaffRole")
      FOR SHARE
    `)
    authorized = hasPermission(membership.role, rolePermissions[0]?.permissions, REQUIRED_PERMISSION, rolePermissions[0]?.deniedPermissions)
  }
  if (!authorized) authorityRequired()

  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "CommercialQuotePreviewBridge"
    WHERE "previewQuoteId" = ${input.expected.previewQuoteId}
    FOR UPDATE
  `)
  const binding = await loadVerifiedReplay(tx, input.expected.previewQuoteId)
  const { tokenHash: _tokenHash, ...acquisition } = acquisitionRow
  return { now, catalog, campaign, acquisition, binding }
}

export const prismaCommercialQuotePreviewBridgeDependencies: CommercialQuotePreviewBridgeDependencies = {
  secrets: {
    quotePreviewSigningSecret: env.COMMERCIAL_QUOTE_PREVIEW_SIGNING_SECRET,
    publicationPreviewSigningSecret: env.COMMERCIAL_PREVIEW_SIGNING_SECRET,
  },
  now: () => new Date(),
  randomId: randomUUID,
  withVerifiedActiveCatalogV2,
  preflightAuthority: preflightExactTargetAuthority,
  verifyToken: verifyCommercialQuotePreviewTokenV2,
  fingerprintSelection: fingerprintCommercialSelectionV2,
  resolveAcquisition: (context, bearer, now) => commercialAcquisitionContextService.resolveForQuote(context, bearer, now),
  loadCampaign: (context, campaignVersionId, issuedAt) => commercialCampaignQuoteAuthorityLoader.load(context, campaignVersionId, issuedAt),
  reconstruct: reconstructCommercialQuotePreviewV2,
  runInReadCommitted: operation =>
    prisma.$transaction(operation, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 5_000,
      timeout: 30_000,
    }),
  loadLockedAuthorityAndBinding,
  persistQuote: (result, tx) => persistCommercialQuoteV2(result, tx as unknown as CommercialQuotePersistenceTransaction),
  async insertBinding(tx, input) {
    await tx.commercialQuotePreviewBridge.create({ data: input })
  },
  recordEvent: recordCommercialPreviewBridgeEvent,
}

export function createCommercialQuotePreviewBridgeService(
  dependencies: CommercialQuotePreviewBridgeDependencies = prismaCommercialQuotePreviewBridgeDependencies,
) {
  function recordEvent(eventName: string, code: string): void {
    try {
      dependencies.recordEvent({ eventName, schemaVersion: 2, artifactKind: 'QUOTE', code })
    } catch {
      // Telemetry is intentionally best-effort and cannot affect quote authority.
    }
  }

  async function executeTransaction(input: {
    request: CommercialQuotePreviewBridgeInput
    authorityContext: CommercialQuoteV2AuthorityContext
    expected: CommercialQuotePreviewTokenPayloadV2
    expectedCampaignChecksum: string | null
    selectionFingerprint: string
    reconstructed: CommercialQuotePreviewReconstructionResultV2
    retry: boolean
  }): Promise<BridgeCommercialQuotePreviewResultV2> {
    return dependencies.runInReadCommitted(async tx => {
      const locked = await dependencies.loadLockedAuthorityAndBinding(tx, {
        ...input.request,
        expectedCatalogPublicationId: input.authorityContext.catalog.snapshot.publicationId,
        expectedCatalogChecksum: input.authorityContext.catalog.checksum,
        expectedCampaignChecksum: input.expectedCampaignChecksum,
        expected: input.expected,
        selectionFingerprint: input.selectionFingerprint,
      })
      if (Date.parse(input.expected.expiresAt) <= locked.now.getTime()) superseded()
      assertCampaignCurrent(locked.campaign, locked.now)
      if (locked.binding) {
        assertReplayTuple(locked.binding, input.request, input.expected, input.selectionFingerprint)
        return { outcome: 'REPLAYED', quote: locked.binding.quote }
      }
      if (input.retry) return retryMissing()

      const evaluation = evaluateCommercialQuoteV2({
        catalog: locked.catalog.snapshot,
        campaign: locked.campaign?.snapshot ?? null,
        lines: input.request.normalizedLines,
        now: locked.now,
      })
      const expiresAt = new Date(Date.prototype.getTime.call(locked.now) + 15 * 60 * 1000)
      const emitted = buildCommercialQuoteV2({
        quoteId: dependencies.randomId(),
        subject: {
          kind: 'VENUE',
          organizationId: input.request.organizationId,
          venueId: input.request.venueId,
          actorId: input.request.actorId,
        },
        acquisitionContextId: input.expected.acquisitionContextId,
        derivedFromPreview: {
          previewQuoteId: input.expected.previewQuoteId,
          previewChecksum: input.expected.previewChecksum,
          selectionFingerprint: input.selectionFingerprint,
        },
        quotedAt: locked.now,
        expiresAt,
        evaluation,
        authorities: { catalog: locked.catalog, campaign: locked.campaign },
      })
      assertEquivalentEconomics(input.reconstructed.quote.snapshot, emitted.snapshot)
      const quote = await dependencies.persistQuote(emitted, tx)
      await dependencies.insertBinding(tx, {
        previewQuoteId: input.expected.previewQuoteId,
        previewChecksum: input.expected.previewChecksum,
        acquisitionContextId: input.expected.acquisitionContextId,
        organizationId: input.request.organizationId,
        venueId: input.request.venueId,
        actorId: input.request.actorId,
        selectionFingerprint: input.selectionFingerprint,
        venueQuoteId: quote.id,
      })
      return { outcome: 'CREATED', quote }
    })
  }

  return {
    async bridge(request: CommercialQuotePreviewBridgeInput): Promise<BridgeCommercialQuotePreviewResultV2> {
      try {
        return await dependencies.withVerifiedActiveCatalogV2(async authorityContext => {
          if (!(await dependencies.preflightAuthority(request))) authorityRequired()
          const now = dependencies.now()
          const expected = dependencies.verifyToken(request.previewToken, dependencies.secrets, now)
          const selectionFingerprint = dependencies.fingerprintSelection({ lines: request.normalizedLines })
          if (!sameHash(selectionFingerprint, expected.selectionFingerprint)) superseded()
          const acquisition = await dependencies.resolveAcquisition(authorityContext, request.acquisitionBearer, now)
          const issuedAt = new Date(expected.issuedAt)
          const expiresAt = new Date(expected.expiresAt)
          const campaign = expected.campaignVersionId
            ? await dependencies.loadCampaign(authorityContext, expected.campaignVersionId, issuedAt)
            : null
          const reconstructed = dependencies.reconstruct({
            authorityContext,
            acquisition,
            campaign,
            lines: request.normalizedLines,
            previewQuoteId: expected.previewQuoteId,
            issuedAt,
            expiresAt,
            expected,
          })

          let result: BridgeCommercialQuotePreviewResultV2
          try {
            result = await executeTransaction({
              request,
              authorityContext,
              expected,
              expectedCampaignChecksum: campaign?.checksum ?? null,
              selectionFingerprint,
              reconstructed,
              retry: false,
            })
          } catch (error) {
            if (!isPreviewQuoteBindingUniqueConflict(error)) throw error
            result = await executeTransaction({
              request,
              authorityContext,
              expected,
              expectedCampaignChecksum: campaign?.checksum ?? null,
              selectionFingerprint,
              reconstructed,
              retry: true,
            })
          }
          recordEvent(
            result.outcome === 'CREATED' ? 'COMMERCIAL_PREVIEW_BRIDGE_CREATED' : 'COMMERCIAL_PREVIEW_BRIDGE_REPLAYED',
            result.outcome,
          )
          return result
        })
      } catch (error) {
        const code = error instanceof AppError && error.code ? error.code : 'COMMERCIAL_PREVIEW_BRIDGE_UNEXPECTED'
        recordEvent('COMMERCIAL_PREVIEW_BRIDGE_REJECTED', code)
        throw error
      }
    },
  }
}

export const commercialQuotePreviewBridgeService = createCommercialQuotePreviewBridgeService()
