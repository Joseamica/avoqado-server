import { randomInt, randomUUID } from 'node:crypto'

import { CommercialQuoteAcceptanceStatus, Prisma, PrismaClient, StaffRole } from '@prisma/client'

import logger from '@/config/logger'
import AppError, { ConflictError } from '@/errors/AppError'
import { decodeAndVerifyStoredCommercialCatalogV2 } from '@/services/commercial/commercialArtifactCodecRegistry.service'
import { decodeAndVerifyStoredCommercialOfferV3 } from '@/services/commercial/offers/commercialOfferV3.service'
import {
  assertCommercialOfferAllowsAcceptanceV3,
  resolveCommercialOfferControlStateV3,
  type CommercialOfferControlLatestEventV3,
} from '@/services/commercial/quotes-v3/commercialOfferControlV3.service'
import {
  assertLockedCommercialQuoteV3ActorAuthority,
  type LockedCommercialQuoteV3ActorAuthority,
} from '@/services/commercial/quotes-v3/commercialQuoteV3Authority.service'
import { createCommercialStoredQuoteV3Service } from '@/services/commercial/quotes-v3/commercialStoredQuoteV3.service'
import type {
  CommercialQuoteV3CatalogAuthority,
  CommercialQuoteV3DecodeInput,
  CommercialQuoteV3OfferAuthority,
  CommercialQuoteSnapshotV3,
} from '@/types/commercialQuoteV3'

const REQUIRED_PERMISSION = 'billing:subscriptions:manage' as const
const QUOTE_UNIQUE_CONSTRAINT = 'CommercialQuoteAcceptance_quoteId_key' as const
const IDEMPOTENCY_UNIQUE_CONSTRAINT = 'CommercialQuoteAcceptance_idempotencyKey_key' as const
const REDEMPTION_CONTEXT_UNIQUE_CONSTRAINT = 'CommercialAcquisitionRedemption_acquisitionContextId_key' as const
const REDEMPTION_QUOTE_UNIQUE_CONSTRAINT = 'CommercialAcquisitionRedemption_quoteId_key' as const
const REDEMPTION_ACCEPTANCE_UNIQUE_CONSTRAINT = 'CommercialAcquisitionRedemption_acceptanceId_key' as const
const REDEMPTION_UNIQUE_CONSTRAINTS = new Set<string>([
  REDEMPTION_CONTEXT_UNIQUE_CONSTRAINT,
  REDEMPTION_QUOTE_UNIQUE_CONSTRAINT,
  REDEMPTION_ACCEPTANCE_UNIQUE_CONSTRAINT,
])

export interface AcceptCommercialQuoteV3Input {
  quoteId: string
  organizationId: string
  venueId: string
  acceptedById: string
  idempotencyKey: string
  correlationId: string
}

export interface CommercialQuoteV3AcceptanceRecord {
  id: string
  quoteId: string
  idempotencyKey: string
  organizationId: string
  venueId: string
  acceptedById: string
  status: CommercialQuoteAcceptanceStatus
  revision: number
  acceptedAt: Date
}

export interface DiscoveredCommercialQuoteV3Row {
  id: string
  schemaVersion: number
  catalogPublicationId: string
  offerVersionId: string | null
  offerSchemaVersion: number | null
  acquisitionContextId: string | null
}

export interface LockedCommercialQuoteV3AcceptanceRow extends DiscoveredCommercialQuoteV3Row {
  acquisitionContextId: string | null
  organizationId: string | null
  venueId: string | null
  createdById: string | null
  market: string
  currency: string
  snapshot: unknown
  checksum: string
  listSubtotalMinor: bigint | number
  discountMinor: bigint | number
  subtotalMinor: bigint | number
  taxMinor: bigint | number
  totalMinor: bigint | number
  renewalSubtotalMinor: bigint | number
  renewalTaxMinor: bigint | number
  renewalTotalMinor: bigint | number
  quotedAt: Date
  expiresAt: Date
}

export interface LockedCommercialQuoteV3AcceptanceOfferRow {
  id: string
  campaignCode: string
  sourceRevision: number
  schemaVersion: number
  snapshot: unknown
  checksum: string
  publishedAt: Date
}

export interface LockedCommercialQuoteV3AcceptanceCatalogRow {
  id: string
  schemaVersion: number
  snapshot: unknown
  checksum: string
  publishedAt: Date
}

export interface LockedCommercialQuoteV3AcceptanceContextRow {
  id: string
  offerVersionId: string | null
  offerSchemaVersion: number | null
  reservedCatalogPublicationId: string | null
  reservedCatalogSchemaVersion: number | null
  createdAt: Date
}

export interface LockedCommercialQuoteV3AcceptanceBindingRow {
  acquisitionContextId: string
  staffId: string
  organizationId: string
  purpose: 'NEW_ACCOUNT'
}

export interface LockedCommercialQuoteV3AcceptanceBridgeRow {
  previewQuoteId: string
  previewChecksum: string
  acquisitionContextId: string
  organizationId: string
  venueId: string
  actorId: string
  selectionFingerprint: string
  venueQuoteId: string
}

export interface CommercialAcquisitionRedemptionRecord {
  id: string
  acquisitionContextId: string
  quoteId: string
  acceptanceId: string
  organizationId: string
  venueId: string
  staffId: string
  redeemedAt: Date
}

export interface CreateCommercialAcquisitionRedemptionInput extends CommercialAcquisitionRedemptionRecord {}

export interface CreateCommercialQuoteV3AcceptanceRecordInput {
  id: string
  quoteId: string
  organizationId: string
  venueId: string
  acceptedById: string
  idempotencyKey: string
  status: 'ACCEPTED'
  revision: 1
  acceptedAt: Date
}

export interface CommercialQuoteV3AcceptanceTransaction {
  setLocalLockTimeout(milliseconds: 1_000): Promise<void>
  discoverQuote(
    quoteId: string,
    organizationId: string,
    venueId: string,
  ): Promise<DiscoveredCommercialQuoteV3Row | null>
  lockOffer(offerVersionId: string): Promise<LockedCommercialQuoteV3AcceptanceOfferRow | null>
  readLatestOfferControl(offerVersionId: string): Promise<CommercialOfferControlLatestEventV3 | null>
  lockCatalog(publicationId: string): Promise<LockedCommercialQuoteV3AcceptanceCatalogRow | null>
  lockAcquisitionContext(contextId: string): Promise<LockedCommercialQuoteV3AcceptanceContextRow | null>
  lockAcquisitionBinding(contextId: string): Promise<LockedCommercialQuoteV3AcceptanceBindingRow | null>
  lockOrganization(organizationId: string): Promise<{ id: string } | null>
  lockVenue(venueId: string): Promise<{ id: string; organizationId: string } | null>
  lockStaff(staffId: string): Promise<{ id: string; active: boolean } | null>
  lockMembership(
    staffId: string,
    venueId: string,
  ): Promise<{
    staffId: string
    venueId: string
    active: boolean
    role: StaffRole
    permissionSetId: string | null
  } | null>
  lockPermissionSet(permissionSetId: string | null): Promise<{
    id: string
    venueId: string
    permissions: string[]
  } | null>
  lockRoleOverride(
    venueId: string,
    role: StaffRole,
  ): Promise<{
    permissions: string[]
    deniedPermissions: string[]
  } | null>
  lockQuote(quoteId: string): Promise<LockedCommercialQuoteV3AcceptanceRow | null>
  lockPreviewBridgeByQuoteId(quoteId: string): Promise<LockedCommercialQuoteV3AcceptanceBridgeRow | null>
  readDatabaseClock(): Promise<Date>
  findAcceptanceByQuoteId(quoteId: string): Promise<CommercialQuoteV3AcceptanceRecord | null>
  findRedemptionByContextId(contextId: string): Promise<CommercialAcquisitionRedemptionRecord | null>
  createAcceptance(input: CreateCommercialQuoteV3AcceptanceRecordInput): Promise<CommercialQuoteV3AcceptanceRecord>
  createRedemption(input: CreateCommercialAcquisitionRedemptionInput): Promise<CommercialAcquisitionRedemptionRecord>
  writeAudit(input: {
    acceptanceId: string
    quoteId: string
    organizationId: string
    venueId: string
    acceptedById: string
    acceptedAt: Date
  }): Promise<void>
}

export interface CommercialQuoteV3AcceptanceDependencies {
  runInTransaction<T>(
    operation: (tx: CommercialQuoteV3AcceptanceTransaction) => Promise<T>,
    options: {
      maxWait: number
      timeout: number
      isolationLevel: Prisma.TransactionIsolationLevel
    },
  ): Promise<T>
  randomId(): string
  sleep(milliseconds: number): Promise<void>
  retryDelayMilliseconds(): number
  recordPoisonedResolution(input: {
    quoteId: string
    correlationId: string
    code: 'COMMERCIAL_OFFER_RESOLUTION_VERSION_POISONED_ROW'
  }): void
}

export const COMMERCIAL_QUOTE_V3_ACCEPTANCE_TRANSACTION_OPTIONS = Object.freeze({
  maxWait: 5_000,
  timeout: 5_000,
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
})

function acceptanceError(code: string, message: string, statusCode = 409, details?: unknown): AppError {
  return new AppError(message, statusCode, true, code, details)
}

function notFound(): never {
  throw acceptanceError('COMMERCIAL_QUOTE_V3_NOT_FOUND', 'La cotización no existe.', 404)
}

function validateInput(input: AcceptCommercialQuoteV3Input): void {
  const validId = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length > 0 && value.length <= 128
  if (
    !validId(input.quoteId) ||
    !validId(input.organizationId) ||
    !validId(input.venueId) ||
    !validId(input.acceptedById) ||
    typeof input.correlationId !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(input.correlationId) ||
    !/^[A-Za-z0-9._:-]{16,128}$/.test(input.idempotencyKey)
  ) {
    throw acceptanceError(
      'COMMERCIAL_QUOTE_V3_ACCEPTANCE_INVALID',
      'La aceptación de la cotización no es válida.',
      422,
    )
  }
}

function assertV3Discovery(
  discovery: DiscoveredCommercialQuoteV3Row,
): asserts discovery is DiscoveredCommercialQuoteV3Row & { offerVersionId: string; offerSchemaVersion: 3 } {
  if (discovery.schemaVersion !== 3 || discovery.offerVersionId === null || discovery.offerSchemaVersion !== 3) {
    throw new ConflictError('COMMERCIAL_QUOTE_V3_SCHEMA_UNSUPPORTED', 'COMMERCIAL_QUOTE_V3_SCHEMA_UNSUPPORTED')
  }
}

function exactDatabaseClock(value: Date): Date {
  try {
    const time = Date.prototype.getTime.call(value)
    if (Number.isFinite(time)) return new Date(time)
  } catch {
    // Normalized below.
  }
  throw acceptanceError('COMMERCIAL_QUOTE_V3_ACCEPTANCE_CLOCK_INVALID', 'El reloj comercial no es válido.', 503)
}

function verifyCatalog(row: LockedCommercialQuoteV3AcceptanceCatalogRow): CommercialQuoteV3CatalogAuthority {
  if (row.schemaVersion !== 2) {
    throw new ConflictError('COMMERCIAL_QUOTE_V3_CATALOG_INVALID', 'COMMERCIAL_QUOTE_V3_CATALOG_INVALID')
  }
  try {
    return decodeAndVerifyStoredCommercialCatalogV2({
      kind: 'CATALOG',
      rowSchemaVersion: row.schemaVersion,
      snapshot: row.snapshot,
      checksum: row.checksum,
      rowContext: {
        kind: 'CATALOG',
        id: row.id,
        schemaVersion: row.schemaVersion,
        publishedAt: row.publishedAt,
      },
    })
  } catch {
    throw new ConflictError('COMMERCIAL_QUOTE_V3_CATALOG_INVALID', 'COMMERCIAL_QUOTE_V3_CATALOG_INVALID')
  }
}

function verifyOffer(row: LockedCommercialQuoteV3AcceptanceOfferRow): CommercialQuoteV3OfferAuthority {
  try {
    const rowContext = {
      id: row.id,
      campaignCode: row.campaignCode,
      sourceRevision: row.sourceRevision,
      schemaVersion: row.schemaVersion,
      publishedAt: row.publishedAt,
    }
    const verified = decodeAndVerifyStoredCommercialOfferV3({
      rowSchemaVersion: row.schemaVersion,
      snapshot: row.snapshot,
      checksum: row.checksum,
      rowContext,
    })
    return {
      rowSchemaVersion: row.schemaVersion,
      snapshot: verified.snapshot,
      checksum: verified.checksum,
      rowContext,
    }
  } catch {
    throw new ConflictError('COMMERCIAL_QUOTE_V3_OFFER_INVALID', 'COMMERCIAL_QUOTE_V3_OFFER_INVALID')
  }
}

function lockedActorAuthority(
  input: AcceptCommercialQuoteV3Input,
  organization: { id: string },
  venue: { id: string; organizationId: string },
  staff: { id: string; active: boolean } | null,
  membership: Awaited<ReturnType<CommercialQuoteV3AcceptanceTransaction['lockMembership']>>,
  permissionSet: Awaited<ReturnType<CommercialQuoteV3AcceptanceTransaction['lockPermissionSet']>>,
  roleOverride: Awaited<ReturnType<CommercialQuoteV3AcceptanceTransaction['lockRoleOverride']>>,
): LockedCommercialQuoteV3ActorAuthority {
  const assignedPermissionSet = membership?.permissionSetId
    ? permissionSet?.id === membership.permissionSetId && permissionSet.venueId === input.venueId
      ? { permissions: permissionSet.permissions }
      : { permissions: [] }
    : null
  return {
    organizationId: organization.id,
    venueOrganizationId: venue.organizationId,
    staffActive: staff?.id === input.acceptedById && staff.active === true,
    membershipActive:
      membership?.staffId === input.acceptedById && membership.venueId === input.venueId && membership.active === true,
    role: membership?.role ?? StaffRole.VIEWER,
    permissionSet: assignedPermissionSet,
    roleOverride,
  }
}

function assertLockedQuoteIdentity(
  quote: LockedCommercialQuoteV3AcceptanceRow,
  discovery: DiscoveredCommercialQuoteV3Row & { offerVersionId: string; offerSchemaVersion: 3 },
  input: AcceptCommercialQuoteV3Input,
): asserts quote is LockedCommercialQuoteV3AcceptanceRow & { offerVersionId: string; offerSchemaVersion: 3 } {
  if (quote.organizationId !== input.organizationId || quote.venueId !== input.venueId) notFound()
  if (quote.schemaVersion !== 3 || quote.offerSchemaVersion !== 3 || quote.offerVersionId === null) {
    throw new ConflictError('COMMERCIAL_QUOTE_V3_SCHEMA_UNSUPPORTED', 'COMMERCIAL_QUOTE_V3_SCHEMA_UNSUPPORTED')
  }
  if (
    quote.id !== discovery.id ||
    quote.catalogPublicationId !== discovery.catalogPublicationId ||
    quote.offerVersionId !== discovery.offerVersionId ||
    quote.acquisitionContextId !== discovery.acquisitionContextId
  ) {
    throw new ConflictError('COMMERCIAL_QUOTE_V3_SOURCE_CHANGED', 'COMMERCIAL_QUOTE_V3_SOURCE_CHANGED')
  }
}

function decodeInput(
  quote: LockedCommercialQuoteV3AcceptanceRow & { offerVersionId: string },
  venueOrganizationId: string,
  catalog: CommercialQuoteV3CatalogAuthority,
  offer: CommercialQuoteV3OfferAuthority,
  acquisitionContext: { id: string; createdAt: Date } | null,
): CommercialQuoteV3DecodeInput {
  return {
    rowSchemaVersion: quote.schemaVersion,
    snapshot: quote.snapshot,
    checksum: quote.checksum,
    rowContext: {
      id: quote.id,
      schemaVersion: quote.schemaVersion,
      catalogPublicationId: quote.catalogPublicationId,
      offerVersionId: quote.offerVersionId,
      acquisitionContextId: quote.acquisitionContextId,
      organizationId: quote.organizationId,
      venueId: quote.venueId,
      createdById: quote.createdById,
      venueOrganizationId,
      market: quote.market,
      currency: quote.currency,
      quotedAt: quote.quotedAt,
      expiresAt: quote.expiresAt,
      listSubtotalMinor: quote.listSubtotalMinor,
      discountMinor: quote.discountMinor,
      subtotalMinor: quote.subtotalMinor,
      taxMinor: quote.taxMinor,
      totalMinor: quote.totalMinor,
      renewalSubtotalMinor: quote.renewalSubtotalMinor,
      renewalTaxMinor: quote.renewalTaxMinor,
      renewalTotalMinor: quote.renewalTotalMinor,
    },
    authorities: { catalog, offer, acquisitionContext },
  }
}

function acquisitionConflict(code: string, message: string): ConflictError {
  return new ConflictError(message, code, { retryable: false })
}

function assertAcquisitionSource(
  context: LockedCommercialQuoteV3AcceptanceContextRow | null,
  binding: LockedCommercialQuoteV3AcceptanceBindingRow | null,
  discovery: DiscoveredCommercialQuoteV3Row & { offerVersionId: string; offerSchemaVersion: 3 },
  input: AcceptCommercialQuoteV3Input,
): asserts context is LockedCommercialQuoteV3AcceptanceContextRow {
  if (
    context === null ||
    context.id !== discovery.acquisitionContextId ||
    context.offerVersionId !== discovery.offerVersionId ||
    context.offerSchemaVersion !== 3 ||
    context.reservedCatalogPublicationId !== discovery.catalogPublicationId ||
    context.reservedCatalogSchemaVersion !== 2
  ) {
    throw acquisitionConflict('COMMERCIAL_ACQUISITION_SOURCE_MISMATCH', 'La fuente de adquisición no coincide.')
  }
  if (
    binding === null ||
    binding.acquisitionContextId !== context.id ||
    binding.staffId !== input.acceptedById ||
    binding.organizationId !== input.organizationId ||
    binding.purpose !== 'NEW_ACCOUNT'
  ) {
    throw acquisitionConflict('COMMERCIAL_ACQUISITION_BINDING_MISMATCH', 'La reservación pertenece a otra cuenta.')
  }
}

function assertAcquisitionBridge(
  bridge: LockedCommercialQuoteV3AcceptanceBridgeRow | null,
  quote: LockedCommercialQuoteV3AcceptanceRow,
  input: AcceptCommercialQuoteV3Input,
  acquisitionContextId: string,
  snapshot: CommercialQuoteSnapshotV3,
): void {
  const preview = snapshot.derivedFromPreview
  if (
    bridge === null ||
    preview === null ||
    bridge.venueQuoteId !== quote.id ||
    bridge.acquisitionContextId !== acquisitionContextId ||
    bridge.organizationId !== input.organizationId ||
    bridge.venueId !== input.venueId ||
    bridge.actorId !== input.acceptedById ||
    bridge.previewQuoteId !== preview.previewQuoteId ||
    bridge.previewChecksum !== preview.previewChecksum ||
    bridge.selectionFingerprint !== preview.selectionFingerprint
  ) {
    throw acquisitionConflict('COMMERCIAL_ACQUISITION_BRIDGE_MISMATCH', 'La cotización no coincide con su vista previa.')
  }
}

function replayAcquisition(
  existing: CommercialQuoteV3AcceptanceRecord,
  redemption: CommercialAcquisitionRedemptionRecord | null,
  input: AcceptCommercialQuoteV3Input,
  acquisitionContextId: string,
): CommercialQuoteV3AcceptanceRecord {
  const replay = replayExisting(existing, input)
  if (
    redemption === null ||
    redemption.acquisitionContextId !== acquisitionContextId ||
    redemption.quoteId !== input.quoteId ||
    redemption.acceptanceId !== replay.id ||
    redemption.organizationId !== input.organizationId ||
    redemption.venueId !== input.venueId ||
    redemption.staffId !== input.acceptedById
  ) {
    throw acquisitionConflict(
      'COMMERCIAL_ACQUISITION_REDEMPTION_INCONSISTENT',
      'La redención de la oferta no coincide con la aceptación.',
    )
  }
  return replay
}

function assertExistingScope(
  existing: CommercialQuoteV3AcceptanceRecord,
  input: AcceptCommercialQuoteV3Input,
): void {
  if (
    existing.quoteId !== input.quoteId ||
    existing.organizationId !== input.organizationId ||
    existing.venueId !== input.venueId
  ) {
    throw new ConflictError('COMMERCIAL_QUOTE_V3_ACCEPTANCE_INCONSISTENT', 'COMMERCIAL_QUOTE_V3_ACCEPTANCE_INCONSISTENT')
  }
}

function replayExisting(
  existing: CommercialQuoteV3AcceptanceRecord,
  input: AcceptCommercialQuoteV3Input,
): CommercialQuoteV3AcceptanceRecord {
  assertExistingScope(existing, input)
  if (existing.acceptedById !== input.acceptedById || existing.idempotencyKey !== input.idempotencyKey) {
    throw new ConflictError('La cotización ya fue aceptada con otra operación.', 'COMMERCIAL_QUOTE_ALREADY_ACCEPTED')
  }
  return existing
}

type OwnDataDescriptor = PropertyDescriptor & { value: unknown }

function ownDataDescriptor(value: object, property: PropertyKey): OwnDataDescriptor | null {
  const descriptor = Object.getOwnPropertyDescriptor(value, property)
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? (descriptor as OwnDataDescriptor) : null
}

function ownConstraint(value: unknown, seen = new WeakSet<object>()): string | null {
  if (typeof value !== 'object' || value === null || seen.has(value)) return null
  seen.add(value)
  for (const key of ['constraint', 'constraint_name', 'constraintName'] as const) {
    const candidate = ownDataDescriptor(value, key)?.value
    if (typeof candidate === 'string') return candidate
  }
  for (const key of ['cause', 'meta', 'originalError', 'driverAdapterError'] as const) {
    const nested = ownDataDescriptor(value, key)?.value
    const candidate = ownConstraint(nested, seen)
    if (candidate) return candidate
  }
  return null
}

type KnownUniqueConstraint =
  | typeof QUOTE_UNIQUE_CONSTRAINT
  | typeof IDEMPOTENCY_UNIQUE_CONSTRAINT
  | typeof REDEMPTION_CONTEXT_UNIQUE_CONSTRAINT
  | typeof REDEMPTION_QUOTE_UNIQUE_CONSTRAINT
  | typeof REDEMPTION_ACCEPTANCE_UNIQUE_CONSTRAINT

function exactPrismaTarget(error: object): KnownUniqueConstraint | null {
  const meta = ownDataDescriptor(error, 'meta')?.value
  if (typeof meta !== 'object' || meta === null) return null
  const modelName = ownDataDescriptor(meta, 'modelName')?.value
  const target = ownDataDescriptor(meta, 'target')?.value
  const field =
    typeof target === 'string'
      ? target
      : Array.isArray(target) && target.length === 1
        ? ownDataDescriptor(target, '0')?.value
        : null
  if (modelName === 'CommercialQuoteAcceptance') {
    if (field === 'quoteId' || field === QUOTE_UNIQUE_CONSTRAINT) return QUOTE_UNIQUE_CONSTRAINT
    if (field === 'idempotencyKey' || field === IDEMPOTENCY_UNIQUE_CONSTRAINT) return IDEMPOTENCY_UNIQUE_CONSTRAINT
  }
  if (modelName === 'CommercialAcquisitionRedemption') {
    if (field === 'acquisitionContextId' || field === REDEMPTION_CONTEXT_UNIQUE_CONSTRAINT) {
      return REDEMPTION_CONTEXT_UNIQUE_CONSTRAINT
    }
    if (field === 'quoteId' || field === REDEMPTION_QUOTE_UNIQUE_CONSTRAINT) return REDEMPTION_QUOTE_UNIQUE_CONSTRAINT
    if (field === 'acceptanceId' || field === REDEMPTION_ACCEPTANCE_UNIQUE_CONSTRAINT) {
      return REDEMPTION_ACCEPTANCE_UNIQUE_CONSTRAINT
    }
  }
  return null
}

function uniqueConstraint(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const code = ownDataDescriptor(error, 'code')?.value
  if (code !== '23505' && code !== 'P2002') return null
  return ownConstraint(error) ?? (code === 'P2002' ? exactPrismaTarget(error) : null)
}

type DatabaseFailure = 'RETRYABLE_CONCURRENCY' | 'LOCK_TIMEOUT' | 'TRANSACTION_TIMEOUT' | 'UNCLASSIFIED_UNIQUE' | null

function databaseFailure(error: unknown): DatabaseFailure {
  if (typeof error !== 'object' || error === null) return null
  const code = ownDataDescriptor(error, 'code')?.value
  if (code === '23505' || code === 'P2002') return 'UNCLASSIFIED_UNIQUE'
  if (code === 'P2028') return 'TRANSACTION_TIMEOUT'
  if (code === 'P2034') return 'RETRYABLE_CONCURRENCY'
  const meta = ownDataDescriptor(error, 'meta')?.value
  const cause = ownDataDescriptor(error, 'cause')?.value
  const nestedCodes = [
    code,
    typeof meta === 'object' && meta !== null ? ownDataDescriptor(meta, 'code')?.value : null,
    typeof meta === 'object' && meta !== null ? ownDataDescriptor(meta, 'sqlState')?.value : null,
    typeof cause === 'object' && cause !== null ? ownDataDescriptor(cause, 'code')?.value : null,
  ]
  if (nestedCodes.includes('55P03')) return 'LOCK_TIMEOUT'
  if (nestedCodes.includes('57014')) return 'TRANSACTION_TIMEOUT'
  if (nestedCodes.includes('40001') || nestedCodes.includes('40P01')) return 'RETRYABLE_CONCURRENCY'
  return null
}

function unavailable(attempts: number): AppError {
  return acceptanceError(
    'COMMERCIAL_QUOTE_V3_ACCEPTANCE_UNAVAILABLE',
    'La cotización está ocupada. Vuelve a intentar.',
    409,
    { retryable: true, attempts },
  )
}

function transactionTimeout(attempts: number): AppError {
  return acceptanceError(
    'COMMERCIAL_QUOTE_V3_ACCEPTANCE_TIMEOUT',
    'La aceptación tardó más de lo permitido. Vuelve a intentar.',
    503,
    { retryable: true, attempts },
  )
}

export function createCommercialQuoteV3AcceptanceService(dependencies: CommercialQuoteV3AcceptanceDependencies) {
  const execute = (input: AcceptCommercialQuoteV3Input) =>
    dependencies.runInTransaction(async tx => {
      await tx.setLocalLockTimeout(1_000)
      const discovery = await tx.discoverQuote(input.quoteId, input.organizationId, input.venueId)
      if (discovery === null) notFound()
      assertV3Discovery(discovery)

      const offerRow = await tx.lockOffer(discovery.offerVersionId)
      if (offerRow === null || offerRow.id !== discovery.offerVersionId || offerRow.schemaVersion !== 3) {
        throw new ConflictError('COMMERCIAL_QUOTE_V3_OFFER_INVALID', 'COMMERCIAL_QUOTE_V3_OFFER_INVALID')
      }
      const latestControl = await tx.readLatestOfferControl(discovery.offerVersionId)
      const offerControlState = resolveCommercialOfferControlStateV3(latestControl)

      const catalogRow = await tx.lockCatalog(discovery.catalogPublicationId)
      if (catalogRow === null || catalogRow.id !== discovery.catalogPublicationId) {
        throw new ConflictError('COMMERCIAL_QUOTE_V3_CATALOG_INVALID', 'COMMERCIAL_QUOTE_V3_CATALOG_INVALID')
      }
      const acquisitionContext =
        discovery.acquisitionContextId === null
          ? null
          : await tx.lockAcquisitionContext(discovery.acquisitionContextId)
      const acquisitionBinding =
        discovery.acquisitionContextId === null
          ? null
          : await tx.lockAcquisitionBinding(discovery.acquisitionContextId)
      const organization = await tx.lockOrganization(input.organizationId)
      const venue = await tx.lockVenue(input.venueId)
      if (organization === null || venue === null || venue.organizationId !== input.organizationId) notFound()

      const staff = await tx.lockStaff(input.acceptedById)
      const membership = await tx.lockMembership(input.acceptedById, input.venueId)
      const permissionSet = await tx.lockPermissionSet(membership?.permissionSetId ?? null)
      const role = membership?.role ?? StaffRole.VIEWER
      const roleOverride = await tx.lockRoleOverride(input.venueId, role)
      const quote = await tx.lockQuote(input.quoteId)
      if (quote === null) notFound()
      assertLockedQuoteIdentity(quote, discovery, input)

      if (discovery.acquisitionContextId !== null) {
        assertAcquisitionSource(acquisitionContext, acquisitionBinding, discovery, input)
        assertLockedCommercialQuoteV3ActorAuthority(
          lockedActorAuthority(input, organization, venue, staff, membership, permissionSet, roleOverride),
          REQUIRED_PERMISSION,
        )
        const bridge = await tx.lockPreviewBridgeByQuoteId(input.quoteId)
        const catalog = verifyCatalog(catalogRow)
        const offer = verifyOffer(offerRow)
        const stored = createCommercialStoredQuoteV3Service({
          loadRowAndAuthorities: async () =>
            decodeInput(quote, venue.organizationId, catalog, offer, {
              id: acquisitionContext.id,
              createdAt: acquisitionContext.createdAt,
            }),
          recordPoisonedResolution: dependencies.recordPoisonedResolution,
        })
        const verified = await stored.loadVerified({
          quoteId: input.quoteId,
          organizationId: input.organizationId,
          venueId: input.venueId,
          correlationId: input.correlationId,
        })
        assertAcquisitionBridge(bridge, quote, input, discovery.acquisitionContextId, verified.snapshot)

        const existing = await tx.findAcceptanceByQuoteId(input.quoteId)
        const redemption = await tx.findRedemptionByContextId(discovery.acquisitionContextId)
        if (existing) return replayAcquisition(existing, redemption, input, discovery.acquisitionContextId)
        if (redemption !== null) {
          throw acquisitionConflict('COMMERCIAL_ACQUISITION_ALREADY_REDEEMED', 'La oferta ya fue utilizada.')
        }

        assertCommercialOfferAllowsAcceptanceV3(offerControlState)
        const acceptedAt = exactDatabaseClock(await tx.readDatabaseClock())
        if (Date.parse(verified.snapshot.expiresAt) <= acceptedAt.getTime()) {
          throw acceptanceError('COMMERCIAL_QUOTE_V3_EXPIRED', 'La cotización venció; genera una nueva.', 410)
        }
        const created = await tx.createAcceptance({
          id: dependencies.randomId(),
          quoteId: input.quoteId,
          organizationId: input.organizationId,
          venueId: input.venueId,
          acceptedById: input.acceptedById,
          idempotencyKey: input.idempotencyKey,
          status: 'ACCEPTED',
          revision: 1,
          acceptedAt,
        })
        assertExistingScope(created, input)
        await tx.createRedemption({
          id: dependencies.randomId(),
          acquisitionContextId: discovery.acquisitionContextId,
          quoteId: input.quoteId,
          acceptanceId: created.id,
          organizationId: input.organizationId,
          venueId: input.venueId,
          staffId: input.acceptedById,
          redeemedAt: acceptedAt,
        })
        await tx.writeAudit({
          acceptanceId: created.id,
          quoteId: input.quoteId,
          organizationId: input.organizationId,
          venueId: input.venueId,
          acceptedById: input.acceptedById,
          acceptedAt,
        })
        return created
      }

      const existing = await tx.findAcceptanceByQuoteId(input.quoteId)
      if (existing) return replayExisting(existing, input)

      assertCommercialOfferAllowsAcceptanceV3(offerControlState)
      assertLockedCommercialQuoteV3ActorAuthority(
        lockedActorAuthority(input, organization, venue, staff, membership, permissionSet, roleOverride),
        REQUIRED_PERMISSION,
      )
      const acceptedAt = exactDatabaseClock(await tx.readDatabaseClock())
      const catalog = verifyCatalog(catalogRow)
      const offer = verifyOffer(offerRow)
      const stored = createCommercialStoredQuoteV3Service({
        loadRowAndAuthorities: async () => decodeInput(quote, venue.organizationId, catalog, offer, null),
        recordPoisonedResolution: dependencies.recordPoisonedResolution,
      })
      const verified = await stored.loadVerified({
        quoteId: input.quoteId,
        organizationId: input.organizationId,
        venueId: input.venueId,
        correlationId: input.correlationId,
      })
      if (Date.parse(verified.snapshot.expiresAt) <= acceptedAt.getTime()) {
        throw acceptanceError('COMMERCIAL_QUOTE_V3_EXPIRED', 'La cotización venció; genera una nueva.', 410)
      }

      const created = await tx.createAcceptance({
        id: dependencies.randomId(),
        quoteId: input.quoteId,
        organizationId: input.organizationId,
        venueId: input.venueId,
        acceptedById: input.acceptedById,
        idempotencyKey: input.idempotencyKey,
        status: 'ACCEPTED',
        revision: 1,
        acceptedAt,
      })
      assertExistingScope(created, input)
      await tx.writeAudit({
        acceptanceId: created.id,
        quoteId: input.quoteId,
        organizationId: input.organizationId,
        venueId: input.venueId,
        acceptedById: input.acceptedById,
        acceptedAt,
      })
      return created
    }, COMMERCIAL_QUOTE_V3_ACCEPTANCE_TRANSACTION_OPTIONS)

  const recoverQuoteCollision = (input: AcceptCommercialQuoteV3Input) => execute(input)

  const recoverQuoteCollisionWithRetry = async (input: AcceptCommercialQuoteV3Input) => {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        return await recoverQuoteCollision(input)
      } catch (error) {
        const failure = databaseFailure(error)
        if (failure === 'UNCLASSIFIED_UNIQUE' || failure === 'LOCK_TIMEOUT') throw unavailable(attempt)
        if (failure === 'TRANSACTION_TIMEOUT') throw transactionTimeout(attempt)
        if (failure !== 'RETRYABLE_CONCURRENCY') throw error
        if (attempt < 2) {
          await dependencies.sleep(dependencies.retryDelayMilliseconds())
          continue
        }
        throw unavailable(attempt)
      }
    }
    throw unavailable(2)
  }

  return Object.freeze({
    async accept(input: AcceptCommercialQuoteV3Input): Promise<CommercialQuoteV3AcceptanceRecord> {
      validateInput(input)
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          return await execute(input)
        } catch (error) {
          const constraint = uniqueConstraint(error)
          if (constraint !== null && REDEMPTION_UNIQUE_CONSTRAINTS.has(constraint)) {
            throw acquisitionConflict('COMMERCIAL_ACQUISITION_ALREADY_REDEEMED', 'La oferta ya fue utilizada.')
          }
          if (constraint === QUOTE_UNIQUE_CONSTRAINT) return recoverQuoteCollisionWithRetry(input)
          if (constraint === IDEMPOTENCY_UNIQUE_CONSTRAINT) {
            throw new ConflictError(
              'La clave de idempotencia ya pertenece a otra aceptación.',
              'COMMERCIAL_QUOTE_ACCEPTANCE_IDEMPOTENCY_KEY_CONFLICT',
            )
          }

          const failure = databaseFailure(error)
          if (failure === 'UNCLASSIFIED_UNIQUE') throw unavailable(attempt)
          if (failure === 'TRANSACTION_TIMEOUT') throw transactionTimeout(attempt)
          if (failure === 'LOCK_TIMEOUT') throw unavailable(attempt)
          if (failure !== 'RETRYABLE_CONCURRENCY') throw error
          if (attempt < 2) {
            await dependencies.sleep(dependencies.retryDelayMilliseconds())
            continue
          }
          throw unavailable(attempt)
        }
      }
      throw unavailable(2)
    },
  })
}

export function createPrismaCommercialQuoteV3AcceptanceTransaction(
  tx: Prisma.TransactionClient,
): CommercialQuoteV3AcceptanceTransaction {
  return {
    async setLocalLockTimeout(milliseconds) {
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${milliseconds}ms'`)
    },
    async discoverQuote(quoteId, organizationId, venueId) {
      const rows = await tx.$queryRaw<DiscoveredCommercialQuoteV3Row[]>(Prisma.sql`
        SELECT "id", "schemaVersion", "catalogPublicationId", "offerVersionId", "offerSchemaVersion",
               "acquisitionContextId"
        FROM "CommercialQuote"
        WHERE "id" = ${quoteId}
          AND "organizationId" = ${organizationId}
          AND "venueId" = ${venueId}
      `)
      return rows[0] ?? null
    },
    async lockOffer(offerVersionId) {
      const rows = await tx.$queryRaw<LockedCommercialQuoteV3AcceptanceOfferRow[]>(Prisma.sql`
        SELECT "id", "campaignCode", "sourceRevision", "schemaVersion", "snapshot", "checksum", "publishedAt"
        FROM "CommercialCampaignVersion"
        WHERE "id" = ${offerVersionId}
        FOR SHARE
      `)
      return rows[0] ?? null
    },
    async readLatestOfferControl(offerVersionId) {
      const row = await tx.commercialOfferControlEvent.findFirst({
        where: { offerVersionId },
        orderBy: { revision: 'desc' },
        select: { revision: true, action: true },
      })
      return row as CommercialOfferControlLatestEventV3 | null
    },
    async lockCatalog(publicationId) {
      const rows = await tx.$queryRaw<LockedCommercialQuoteV3AcceptanceCatalogRow[]>(Prisma.sql`
        SELECT "id", "schemaVersion", "snapshot", "checksum", "publishedAt"
        FROM "CommercialPublication"
        WHERE "id" = ${publicationId}
        FOR SHARE
      `)
      return rows[0] ?? null
    },
    async lockAcquisitionContext(contextId) {
      const rows = await tx.$queryRaw<LockedCommercialQuoteV3AcceptanceContextRow[]>(Prisma.sql`
        SELECT "id", "offerVersionId", "offerSchemaVersion", "reservedCatalogPublicationId",
               "reservedCatalogSchemaVersion", "createdAt"
        FROM "CommercialAcquisitionContext"
        WHERE "id" = ${contextId}
        FOR SHARE
      `)
      return rows[0] ?? null
    },
    async lockAcquisitionBinding(contextId) {
      const rows = await tx.$queryRaw<LockedCommercialQuoteV3AcceptanceBindingRow[]>(Prisma.sql`
        SELECT "acquisitionContextId", "staffId", "organizationId", "purpose"
        FROM "CommercialAcquisitionContextBinding"
        WHERE "acquisitionContextId" = ${contextId}
        FOR SHARE
      `)
      return rows[0] ?? null
    },
    async lockOrganization(organizationId) {
      const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "Organization" WHERE "id" = ${organizationId} FOR SHARE
      `)
      return rows[0] ?? null
    },
    async lockVenue(venueId) {
      const rows = await tx.$queryRaw<Array<{ id: string; organizationId: string }>>(Prisma.sql`
        SELECT "id", "organizationId" FROM "Venue" WHERE "id" = ${venueId} FOR SHARE
      `)
      return rows[0] ?? null
    },
    async lockStaff(staffId) {
      const rows = await tx.$queryRaw<Array<{ id: string; active: boolean }>>(Prisma.sql`
        SELECT "id", "active" FROM "Staff" WHERE "id" = ${staffId} FOR SHARE
      `)
      return rows[0] ?? null
    },
    async lockMembership(staffId, venueId) {
      const rows = await tx.$queryRaw<
        Array<{
          staffId: string
          venueId: string
          active: boolean
          role: StaffRole
          permissionSetId: string | null
        }>
      >(Prisma.sql`
        SELECT "staffId", "venueId", "active", "role", "permissionSetId"
        FROM "StaffVenue"
        WHERE "staffId" = ${staffId} AND "venueId" = ${venueId}
        FOR SHARE
      `)
      return rows[0] ?? null
    },
    async lockPermissionSet(permissionSetId) {
      if (permissionSetId === null) return null
      const rows = await tx.$queryRaw<Array<{ id: string; venueId: string; permissions: string[] }>>(Prisma.sql`
        SELECT "id", "venueId", "permissions"
        FROM "PermissionSet"
        WHERE "id" = ${permissionSetId}
        FOR SHARE
      `)
      return rows[0] ?? null
    },
    async lockRoleOverride(venueId, role) {
      const rows = await tx.$queryRaw<Array<{ permissions: string[]; deniedPermissions: string[] }>>(Prisma.sql`
        SELECT "permissions", "deniedPermissions"
        FROM "VenueRolePermission"
        WHERE "venueId" = ${venueId} AND "role" = CAST(${role} AS "StaffRole")
        FOR SHARE
      `)
      return rows[0] ?? null
    },
    async lockQuote(quoteId) {
      const rows = await tx.$queryRaw<LockedCommercialQuoteV3AcceptanceRow[]>(Prisma.sql`
        SELECT "id", "schemaVersion", "catalogPublicationId", "offerVersionId", "offerSchemaVersion",
               "acquisitionContextId", "organizationId", "venueId", "createdById", "market", "currency",
               "snapshot", "checksum", "listSubtotalMinor", "discountMinor", "subtotalMinor", "taxMinor",
               "totalMinor", "renewalSubtotalMinor", "renewalTaxMinor", "renewalTotalMinor", "quotedAt", "expiresAt"
        FROM "CommercialQuote"
        WHERE "id" = ${quoteId}
        FOR UPDATE
      `)
      return rows[0] ?? null
    },
    async lockPreviewBridgeByQuoteId(quoteId) {
      const rows = await tx.$queryRaw<LockedCommercialQuoteV3AcceptanceBridgeRow[]>(Prisma.sql`
        SELECT "previewQuoteId", "previewChecksum", "acquisitionContextId", "organizationId", "venueId",
               "actorId", "selectionFingerprint", "venueQuoteId"
        FROM "CommercialQuotePreviewBridge"
        WHERE "venueQuoteId" = ${quoteId}
        FOR SHARE
      `)
      return rows[0] ?? null
    },
    async readDatabaseClock() {
      const rows = await tx.$queryRaw<Array<{ now: Date }>>`
        SELECT date_trunc('milliseconds', clock_timestamp()) AS "now"
      `
      return rows[0]?.now ?? new Date(Number.NaN)
    },
    findAcceptanceByQuoteId: quoteId =>
      tx.commercialQuoteAcceptance.findUnique({
        where: { quoteId },
        select: {
          id: true,
          quoteId: true,
          idempotencyKey: true,
          organizationId: true,
          venueId: true,
          acceptedById: true,
          status: true,
          revision: true,
          acceptedAt: true,
        },
      }),
    findRedemptionByContextId: acquisitionContextId =>
      tx.commercialAcquisitionRedemption.findUnique({
        where: { acquisitionContextId },
        select: {
          id: true,
          acquisitionContextId: true,
          quoteId: true,
          acceptanceId: true,
          organizationId: true,
          venueId: true,
          staffId: true,
          redeemedAt: true,
        },
      }),
    createAcceptance: input =>
      tx.commercialQuoteAcceptance.create({
        data: {
          id: input.id,
          quoteId: input.quoteId,
          idempotencyKey: input.idempotencyKey,
          organizationId: input.organizationId,
          venueId: input.venueId,
          acceptedById: input.acceptedById,
          status: input.status,
          revision: input.revision,
          acceptedAt: input.acceptedAt,
        },
        select: {
          id: true,
          quoteId: true,
          idempotencyKey: true,
          organizationId: true,
          venueId: true,
          acceptedById: true,
          status: true,
          revision: true,
          acceptedAt: true,
        },
      }),
    createRedemption: input =>
      tx.commercialAcquisitionRedemption.create({
        data: {
          id: input.id,
          acquisitionContextId: input.acquisitionContextId,
          quoteId: input.quoteId,
          acceptanceId: input.acceptanceId,
          organizationId: input.organizationId,
          venueId: input.venueId,
          staffId: input.staffId,
          redeemedAt: input.redeemedAt,
        },
        select: {
          id: true,
          acquisitionContextId: true,
          quoteId: true,
          acceptanceId: true,
          organizationId: true,
          venueId: true,
          staffId: true,
          redeemedAt: true,
        },
      }),
    async writeAudit(input) {
      await tx.activityLog.create({
        data: {
          staffId: input.acceptedById,
          actorStaffId: input.acceptedById,
          actorType: 'HUMAN',
          organizationId: input.organizationId,
          venueId: input.venueId,
          action: 'COMMERCIAL_QUOTE_ACCEPTED',
          entity: 'CommercialQuoteAcceptance',
          entityId: input.acceptanceId,
          data: {
            quoteId: input.quoteId,
            acceptedAt: input.acceptedAt.toISOString(),
          },
        },
      })
    },
  }
}

export function createPrismaCommercialQuoteV3AcceptanceService(host: PrismaClient) {
  return createCommercialQuoteV3AcceptanceService({
    runInTransaction: (operation, options) =>
      host.$transaction(tx => operation(createPrismaCommercialQuoteV3AcceptanceTransaction(tx)), options),
    randomId: randomUUID,
    sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    retryDelayMilliseconds: () => randomInt(25, 76),
    recordPoisonedResolution: input => {
      logger.error('Stored Commercial Quote v3 has an unsupported resolution version', input)
    },
  })
}
