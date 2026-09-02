import { randomInt, randomUUID } from 'node:crypto'

import { Prisma, PrismaClient, StaffRole } from '@prisma/client'

import type { CommercialQuotePreviewSecretsInput } from '@/config/commercialQuotePreviewSecrets'
import { env } from '@/config/env'
import AppError, { ConflictError } from '@/errors/AppError'
import { decodeAndVerifyStoredCommercialCatalogV2 } from '@/services/commercial/commercialArtifactCodecRegistry.service'
import { decodeAndVerifyStoredCommercialOfferV3 } from '@/services/commercial/offers/commercialOfferV3.service'
import {
  assertCommercialOfferAllowsPreviewV3,
  resolveCommercialOfferControlStateV3,
  type CommercialOfferControlLatestEventV3,
} from '@/services/commercial/quotes-v3/commercialOfferControlV3.service'
import { buildCommercialQuoteV3 } from '@/services/commercial/quotes-v3/commercialQuoteV3Builder.service'
import { decodeAndVerifyStoredCommercialQuoteV3 } from '@/services/commercial/quotes-v3/commercialQuoteV3Contract.service'
import {
  evaluateCommercialQuoteV3,
  materializeCommercialQuoteV3Selections,
  type CommercialHardwareSelectionV3,
  type EvaluateCommercialQuoteV3Input,
} from '@/services/commercial/quotes-v3/commercialQuoteV3Engine.service'
import {
  assertLockedCommercialQuoteV3ActorAuthority,
  type LockedCommercialQuoteV3ActorAuthority,
} from '@/services/commercial/quotes-v3/commercialQuoteV3Authority.service'
import {
  fingerprintCommercialQuoteV3Selections,
} from '@/services/commercial/quotes-v3/commercialPublicQuotePreviewV3.service'
import {
  COMMERCIAL_QUOTE_PREVIEW_V3_TTL_MS,
  verifyCommercialQuotePreviewTokenV3,
  type CommercialQuotePreviewTokenPayloadV3,
} from '@/services/commercial/quotes-v3/commercialQuotePreviewTokenV3.service'
import {
  persistBridgedCommercialQuoteV3,
  type CommercialQuoteV3PersistenceTransaction,
  type PersistedCommercialQuoteV3,
} from '@/services/commercial/quotes-v3/commercialQuoteV3Persistence.service'
import type { CommercialQuoteSelectionV2 } from '@/services/commercial/commercialQuoteEngineV2.service'
import type { CommercialRateBlockerV3 } from '@/types/commercialOfferV3'
import type {
  CommercialQuoteV3Authorities,
  CommercialQuoteV3CatalogAuthority,
  CommercialQuoteV3OfferAuthority,
} from '@/types/commercialQuoteV3'

const REQUIRED_PERMISSION = 'billing:subscriptions:manage' as const
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const TOKEN_PATTERN = /^v3\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u
const RETRYABLE_POSTGRES_CODES = new Set(['40001', '40P01'])
export const PREVIEW_QUOTE_V3_UNIQUE_CONSTRAINT = 'CommercialQuotePreviewBridge_previewQuoteId_key'

export interface BridgeCommercialQuotePreviewV3Input {
  organizationId: string
  venueId: string
  actorId: string
  acquisitionContextId: string
  previewToken: string
  normalizedSaasLines: readonly CommercialQuoteSelectionV2[]
  normalizedHardwareSelections: readonly CommercialHardwareSelectionV3[]
  rateBlockers: readonly CommercialRateBlockerV3[]
}

export interface CommercialQuotePreviewBridgeV3ContextRow {
  id: string
  campaignVersionId: string | null
  offerVersionId: string | null
  offerSchemaVersion: number | null
  reservedCatalogPublicationId: string | null
  reservedCatalogSchemaVersion: number | null
  createdAt: Date
  expiresAt: Date
}

export interface CommercialQuotePreviewBridgeV3BindingRow {
  id: string
  acquisitionContextId: string
  staffId: string
  organizationId: string
  purpose: 'NEW_ACCOUNT'
  staffCreatedAt: Date
  organizationCreatedAt: Date
  boundAt: Date
}

export interface CommercialQuotePreviewBridgeV3Record {
  previewQuoteId: string
  previewChecksum: string
  acquisitionContextId: string
  organizationId: string
  venueId: string
  actorId: string
  selectionFingerprint: string
  venueQuoteId: string
  quote: PersistedCommercialQuoteV3
}

export interface CommercialQuotePreviewBridgeV3Insert {
  id: string
  previewQuoteId: string
  previewChecksum: string
  acquisitionContextId: string
  organizationId: string
  venueId: string
  actorId: string
  selectionFingerprint: string
  venueQuoteId: string
}

export interface CommercialQuotePreviewBridgeV3Transaction
  extends Pick<CommercialQuoteV3PersistenceTransaction, 'commercialQuote' | 'activityLog'> {
  setLocalLockTimeout(milliseconds: 1_000): Promise<unknown>
  lockOffer(offerVersionId: string): Promise<CommercialQuoteV3OfferAuthority | null>
  readLatestOfferControl(offerVersionId: string): Promise<CommercialOfferControlLatestEventV3 | null>
  lockReservedCatalog(publicationId: string): Promise<CommercialQuoteV3CatalogAuthority | null>
  lockContext(contextId: string): Promise<CommercialQuotePreviewBridgeV3ContextRow | null>
  lockBinding(contextId: string): Promise<CommercialQuotePreviewBridgeV3BindingRow | null>
  lockOrganization(organizationId: string): Promise<{ id: string; createdAt: Date } | null>
  lockVenue(venueId: string): Promise<{ id: string; organizationId: string; createdAt: Date } | null>
  lockStaff(staffId: string): Promise<{ id: string; active: boolean; commercialCreatedAt: Date | null } | null>
  lockMembership(
    staffId: string,
    venueId: string,
  ): Promise<{ staffId: string; venueId: string; active: boolean; role: StaffRole; permissionSetId: string | null } | null>
  lockPermissionSet(permissionSetId: string | null): Promise<{ id: string; venueId: string; permissions: string[] } | null>
  lockRoleOverride(
    venueId: string,
    role: StaffRole,
  ): Promise<{ permissions: string[]; deniedPermissions: string[] } | null>
  findVerifiedBridgeByPreviewQuoteId(
    previewQuoteId: string,
    authorities: CommercialQuoteV3Authorities,
  ): Promise<CommercialQuotePreviewBridgeV3Record | null>
  readDatabaseClock(): Promise<Date>
  createBridge(record: CommercialQuotePreviewBridgeV3Insert): Promise<void>
}

export interface CommercialQuotePreviewBridgeV3Dependencies {
  secrets: CommercialQuotePreviewSecretsInput
  now(): Date
  verifyPreviewToken(
    token: string,
    secrets: CommercialQuotePreviewSecretsInput,
    now: Date,
  ): CommercialQuotePreviewTokenPayloadV3
  fingerprintSelections(input: Pick<EvaluateCommercialQuoteV3Input, 'saasSelections' | 'hardwareSelections' | 'rateBlockers'>): string
  evaluate(input: EvaluateCommercialQuoteV3Input): ReturnType<typeof evaluateCommercialQuoteV3>
  build(input: Parameters<typeof buildCommercialQuoteV3>[0]): ReturnType<typeof buildCommercialQuoteV3>
  runInTransaction<T>(
    operation: (tx: CommercialQuotePreviewBridgeV3Transaction) => Promise<T>,
    options: {
      maxWait: number
      timeout: number
      isolationLevel: Prisma.TransactionIsolationLevel
    },
  ): Promise<T>
  randomId(): string
  sleep(milliseconds: number): Promise<void>
  retryDelayMilliseconds(): number
}

export const COMMERCIAL_QUOTE_PREVIEW_BRIDGE_V3_TRANSACTION_OPTIONS = Object.freeze({
  maxWait: 5_000,
  timeout: 5_000,
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
})

function bridgeError(message: string, statusCode: number, code: string): never {
  throw new AppError(message, statusCode, true, code)
}

function strictInput(input: BridgeCommercialQuotePreviewV3Input) {
  if (
    typeof input !== 'object' ||
    input === null ||
    Reflect.ownKeys(input).length !== 8 ||
    !ID_PATTERN.test(input.organizationId) ||
    !ID_PATTERN.test(input.venueId) ||
    !ID_PATTERN.test(input.actorId) ||
    !ID_PATTERN.test(input.acquisitionContextId) ||
    typeof input.previewToken !== 'string' ||
    !TOKEN_PATTERN.test(input.previewToken)
  ) {
    bridgeError('La solicitud de vinculación no es válida.', 422, 'COMMERCIAL_PREVIEW_BRIDGE_V3_INPUT_INVALID')
  }
  return materializeCommercialQuoteV3Selections({
    saasSelections: input.normalizedSaasLines,
    hardwareSelections: input.normalizedHardwareSelections,
    rateBlockers: input.rateBlockers,
  })
}

function exactClock(value: Date): Date {
  try {
    const time = Date.prototype.getTime.call(value)
    if (Number.isFinite(time)) return new Date(time)
  } catch {
    // Normalized below.
  }
  return bridgeError('El reloj comercial no es válido.', 503, 'COMMERCIAL_PREVIEW_BRIDGE_V3_CLOCK_INVALID')
}

function inReservationWindow(value: Date | null, reservation: CommercialQuotePreviewBridgeV3ContextRow): boolean {
  if (value === null) return false
  const time = value.getTime()
  return Number.isFinite(time) && time >= reservation.createdAt.getTime() && time <= reservation.expiresAt.getTime()
}

function exactDedicatedContext(
  row: CommercialQuotePreviewBridgeV3ContextRow,
): row is CommercialQuotePreviewBridgeV3ContextRow & {
  offerVersionId: string
  offerSchemaVersion: 3
  reservedCatalogPublicationId: string
  reservedCatalogSchemaVersion: 2
} {
  return (
    row.campaignVersionId === null &&
    typeof row.offerVersionId === 'string' &&
    row.offerSchemaVersion === 3 &&
    typeof row.reservedCatalogPublicationId === 'string' &&
    row.reservedCatalogSchemaVersion === 2
  )
}

function assertSourceTuple(
  expected: CommercialQuotePreviewTokenPayloadV3,
  context: CommercialQuotePreviewBridgeV3ContextRow & {
    offerVersionId: string
    reservedCatalogPublicationId: string
  },
  catalog: CommercialQuoteV3CatalogAuthority,
  offer: CommercialQuoteV3OfferAuthority,
): void {
  if (
    context.offerVersionId !== expected.offerVersionId ||
    context.reservedCatalogPublicationId !== expected.catalogPublicationId ||
    offer.snapshot.campaignVersionId !== expected.offerVersionId ||
    offer.checksum !== expected.offerChecksum ||
    catalog.snapshot.publicationId !== expected.catalogPublicationId ||
    catalog.checksum !== expected.catalogChecksum
  ) {
    bridgeError('La procedencia de la oferta cambió.', 409, 'COMMERCIAL_PREVIEW_V3_SOURCE_MISMATCH')
  }
}

function assertOfferAndReservationWindow(
  offer: CommercialQuoteV3OfferAuthority,
  context: CommercialQuotePreviewBridgeV3ContextRow,
): void {
  const startsAt = Date.parse(offer.snapshot.claimStartsAt)
  const endsAt = Date.parse(offer.snapshot.claimEndsAt)
  const reservedAt = context.createdAt.getTime()
  if (
    offer.snapshot.status !== 'ACTIVE' ||
    !Number.isFinite(startsAt) ||
    !Number.isFinite(endsAt) ||
    reservedAt < startsAt ||
    reservedAt >= endsAt
  ) {
    bridgeError('La oferta reservada no es válida.', 409, 'COMMERCIAL_ACQUISITION_V3_OFFER_INVALID')
  }
}

function lockedActorAuthority(
  input: BridgeCommercialQuotePreviewV3Input,
  organization: { id: string },
  venue: { id: string; organizationId: string },
  staff: { id: string; active: boolean } | null,
  membership: Awaited<ReturnType<CommercialQuotePreviewBridgeV3Transaction['lockMembership']>>,
  permissionSet: Awaited<ReturnType<CommercialQuotePreviewBridgeV3Transaction['lockPermissionSet']>>,
  roleOverride: Awaited<ReturnType<CommercialQuotePreviewBridgeV3Transaction['lockRoleOverride']>>,
): LockedCommercialQuoteV3ActorAuthority {
  const assignedPermissionSet = membership?.permissionSetId
    ? permissionSet?.id === membership.permissionSetId && permissionSet.venueId === input.venueId
      ? { permissions: permissionSet.permissions }
      : { permissions: [] }
    : null
  return {
    organizationId: organization.id,
    venueOrganizationId: venue.organizationId,
    staffActive: staff?.id === input.actorId && staff.active,
    membershipActive: membership?.staffId === input.actorId && membership.venueId === input.venueId && membership.active,
    role: membership?.role ?? StaffRole.VIEWER,
    permissionSet: assignedPermissionSet,
    roleOverride,
  }
}

function assertReplay(
  bridge: CommercialQuotePreviewBridgeV3Record,
  input: BridgeCommercialQuotePreviewV3Input,
  expected: CommercialQuotePreviewTokenPayloadV3,
  selectionFingerprint: string,
): PersistedCommercialQuoteV3 {
  const snapshot = bridge.quote.snapshot
  if (
    bridge.previewQuoteId !== expected.previewQuoteId ||
    bridge.previewChecksum !== expected.previewChecksum ||
    bridge.acquisitionContextId !== input.acquisitionContextId ||
    bridge.organizationId !== input.organizationId ||
    bridge.venueId !== input.venueId ||
    bridge.actorId !== input.actorId ||
    bridge.selectionFingerprint !== selectionFingerprint ||
    bridge.venueQuoteId !== bridge.quote.id ||
    snapshot.schemaVersion !== 3 ||
    snapshot.subject.kind !== 'VENUE' ||
    snapshot.subject.organizationId !== input.organizationId ||
    snapshot.subject.venueId !== input.venueId ||
    snapshot.subject.actorId !== input.actorId ||
    snapshot.acquisitionContextId !== input.acquisitionContextId ||
    snapshot.derivedFromPreview?.previewQuoteId !== expected.previewQuoteId ||
    snapshot.derivedFromPreview.previewChecksum !== expected.previewChecksum ||
    snapshot.derivedFromPreview.selectionFingerprint !== selectionFingerprint
  ) {
    throw new ConflictError('La vista previa ya fue vinculada a otro destino.', 'COMMERCIAL_PREVIEW_BRIDGE_V3_CONFLICT')
  }
  return bridge.quote
}

function ownConstraint(value: unknown, seen = new WeakSet<object>()): string | null {
  if (typeof value !== 'object' || value === null || seen.has(value)) return null
  seen.add(value)
  for (const key of ['constraint', 'constraint_name', 'constraintName'] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor && 'value' in descriptor && typeof descriptor.value === 'string') return descriptor.value
  }
  for (const key of ['cause', 'meta', 'originalError', 'driverAdapterError'] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor)) continue
    const nested = ownConstraint(descriptor.value, seen)
    if (nested) return nested
  }
  return null
}

function exactPrismaPreviewUnique(error: object): boolean {
  const meta = Object.getOwnPropertyDescriptor(error, 'meta')?.value
  if (typeof meta !== 'object' || meta === null) return false
  const modelName = Object.getOwnPropertyDescriptor(meta, 'modelName')?.value
  const target = Object.getOwnPropertyDescriptor(meta, 'target')?.value
  return modelName === 'CommercialQuotePreviewBridge' && Array.isArray(target) && target.length === 1 && target[0] === 'previewQuoteId'
}

export function isPreviewQuoteV3UniqueConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = Object.getOwnPropertyDescriptor(error, 'code')?.value
  if (code !== '23505' && code !== 'P2002') return false
  return ownConstraint(error) === PREVIEW_QUOTE_V3_UNIQUE_CONSTRAINT || (code === 'P2002' && exactPrismaPreviewUnique(error))
}

function postgresCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const candidate = error as { code?: unknown; meta?: unknown; cause?: unknown }
  const meta = typeof candidate.meta === 'object' && candidate.meta !== null ? (candidate.meta as Record<string, unknown>) : null
  const cause = typeof candidate.cause === 'object' && candidate.cause !== null ? (candidate.cause as Record<string, unknown>) : null
  for (const code of [candidate.code, meta?.code, meta?.sqlState, cause?.code]) {
    if (typeof code === 'string' && RETRYABLE_POSTGRES_CODES.has(code)) return code
  }
  return null
}

function unavailable(): never {
  throw new ConflictError('La vinculación está ocupada. Vuelve a intentar.', 'COMMERCIAL_PREVIEW_BRIDGE_V3_UNAVAILABLE', {
    retryable: true,
    attempts: 2,
  })
}

export function createCommercialQuotePreviewBridgeV3Service(dependencies: CommercialQuotePreviewBridgeV3Dependencies) {
  return Object.freeze({
    async bridge(input: BridgeCommercialQuotePreviewV3Input): Promise<{ outcome: 'CREATED' | 'REPLAYED'; quote: PersistedCommercialQuoteV3 }> {
      const normalized = strictInput(input)
      const expected = dependencies.verifyPreviewToken(input.previewToken, dependencies.secrets, dependencies.now())
      if (expected.acquisitionContextId !== input.acquisitionContextId) {
        bridgeError('La vista previa pertenece a otra reservación.', 409, 'COMMERCIAL_PREVIEW_V3_CONTEXT_MISMATCH')
      }
      const selectionFingerprint = dependencies.fingerprintSelections(normalized)
      if (selectionFingerprint !== expected.selectionFingerprint) {
        bridgeError('La selección cambió.', 409, 'COMMERCIAL_PREVIEW_V3_SELECTION_MISMATCH')
      }

      let recoveryOnly = false
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          return await dependencies.runInTransaction(async tx => {
            await tx.setLocalLockTimeout(1_000)
            const offer = await tx.lockOffer(expected.offerVersionId)
            if (offer === null) bridgeError('La oferta reservada no existe.', 409, 'COMMERCIAL_PREVIEW_V3_SOURCE_MISMATCH')
            const control = await tx.readLatestOfferControl(expected.offerVersionId)
            assertCommercialOfferAllowsPreviewV3(resolveCommercialOfferControlStateV3(control))
            const catalog = await tx.lockReservedCatalog(expected.catalogPublicationId)
            if (catalog === null) bridgeError('El catálogo reservado no existe.', 409, 'COMMERCIAL_PREVIEW_V3_SOURCE_MISMATCH')
            const contextRow = await tx.lockContext(input.acquisitionContextId)
            if (contextRow === null || !exactDedicatedContext(contextRow)) {
              bridgeError('La reservación no existe.', 404, 'COMMERCIAL_ACQUISITION_NOT_FOUND')
            }
            assertSourceTuple(expected, contextRow, catalog, offer)
            assertOfferAndReservationWindow(offer, contextRow)
            const binding = await tx.lockBinding(contextRow.id)
            if (binding === null) {
              bridgeError('La reservación aún no está vinculada.', 409, 'COMMERCIAL_ACQUISITION_BINDING_REQUIRED')
            }
            if (
              binding.acquisitionContextId !== contextRow.id ||
              binding.staffId !== input.actorId ||
              binding.organizationId !== input.organizationId ||
              binding.purpose !== 'NEW_ACCOUNT'
            ) {
              bridgeError('La reservación está vinculada a otra cuenta.', 409, 'COMMERCIAL_ACQUISITION_BINDING_CONFLICT')
            }
            const organization = await tx.lockOrganization(input.organizationId)
            const venue = await tx.lockVenue(input.venueId)
            const staff = await tx.lockStaff(input.actorId)
            const membership = await tx.lockMembership(input.actorId, input.venueId)
            const permissionSet = await tx.lockPermissionSet(membership?.permissionSetId ?? null)
            const roleOverride = await tx.lockRoleOverride(input.venueId, membership?.role ?? StaffRole.VIEWER)
            if (organization === null || venue === null) {
              bridgeError('La cuenta vinculada no está disponible.', 409, 'COMMERCIAL_ACQUISITION_NEW_ACCOUNT_INELIGIBLE')
            }
            assertLockedCommercialQuoteV3ActorAuthority(
              lockedActorAuthority(input, organization, venue, staff, membership, permissionSet, roleOverride),
              REQUIRED_PERMISSION,
            )
            if (
              staff === null ||
              staff.commercialCreatedAt === null ||
              binding.staffCreatedAt.getTime() !== staff.commercialCreatedAt.getTime() ||
              binding.organizationCreatedAt.getTime() !== organization.createdAt.getTime() ||
              !inReservationWindow(staff.commercialCreatedAt, contextRow) ||
              !inReservationWindow(organization.createdAt, contextRow) ||
              !inReservationWindow(venue.createdAt, contextRow)
            ) {
              bridgeError('La cuenta ya existía antes de la reservación.', 409, 'COMMERCIAL_ACQUISITION_NEW_ACCOUNT_INELIGIBLE')
            }
            const now = exactClock(await tx.readDatabaseClock())
            dependencies.verifyPreviewToken(input.previewToken, dependencies.secrets, now)
            if (now >= contextRow.expiresAt) {
              bridgeError('La reservación venció.', 410, 'COMMERCIAL_ACQUISITION_EXPIRED')
            }
            const lockedAuthorities: CommercialQuoteV3Authorities = {
              catalog,
              offer,
              acquisitionContext: { id: contextRow.id, createdAt: contextRow.createdAt },
            }
            const existing = await tx.findVerifiedBridgeByPreviewQuoteId(expected.previewQuoteId, lockedAuthorities)
            if (existing !== null) {
              return { outcome: 'REPLAYED' as const, quote: assertReplay(existing, input, expected, selectionFingerprint) }
            }
            if (recoveryOnly) {
              bridgeError('No fue posible recuperar la cotización ganadora.', 409, 'COMMERCIAL_PREVIEW_BRIDGE_V3_RETRY_MISSING')
            }
            const evaluation = dependencies.evaluate({
              authorities: { catalog, offer },
              ...normalized,
              resolvedAt: contextRow.createdAt,
            })
            const reconstructed = dependencies.build({
              quoteId: expected.previewQuoteId,
              subject: { kind: 'ACQUISITION_CONTEXT', acquisitionContextId: contextRow.id },
              acquisitionContextId: contextRow.id,
              derivedFromPreview: null,
              quotedAt: new Date(expected.issuedAt),
              expiresAt: new Date(expected.expiresAt),
              evaluation,
              authorities: lockedAuthorities,
            })
            if (reconstructed.checksum !== expected.previewChecksum) {
              bridgeError('La vista previa no pudo reproducirse.', 409, 'COMMERCIAL_PREVIEW_V3_CHECKSUM_MISMATCH')
            }
            const emitted = dependencies.build({
              quoteId: dependencies.randomId(),
              subject: {
                kind: 'VENUE',
                organizationId: input.organizationId,
                venueId: input.venueId,
                actorId: input.actorId,
              },
              acquisitionContextId: contextRow.id,
              derivedFromPreview: {
                previewQuoteId: expected.previewQuoteId,
                previewChecksum: expected.previewChecksum,
                selectionFingerprint,
              },
              quotedAt: now,
              expiresAt: new Date(now.getTime() + COMMERCIAL_QUOTE_PREVIEW_V3_TTL_MS),
              evaluation,
              authorities: lockedAuthorities,
            })
            const persistenceTx: CommercialQuoteV3PersistenceTransaction = {
              loadAuthorities: async requested =>
                requested.catalogPublicationId === catalog.snapshot.publicationId &&
                requested.offerVersionId === offer.snapshot.campaignVersionId &&
                requested.organizationId === input.organizationId &&
                requested.venueId === input.venueId
                  ? lockedAuthorities
                  : null,
              commercialQuote: tx.commercialQuote,
              activityLog: tx.activityLog,
            }
            const quote = await persistBridgedCommercialQuoteV3(emitted, persistenceTx, {
              actorId: input.actorId,
              acquisitionContext: { id: contextRow.id, createdAt: contextRow.createdAt },
              preview: {
                quoteId: expected.previewQuoteId,
                checksum: expected.previewChecksum,
                selectionFingerprint,
              },
            })
            await tx.createBridge({
              id: dependencies.randomId(),
              previewQuoteId: expected.previewQuoteId,
              previewChecksum: expected.previewChecksum,
              acquisitionContextId: contextRow.id,
              organizationId: input.organizationId,
              venueId: input.venueId,
              actorId: input.actorId,
              selectionFingerprint,
              venueQuoteId: quote.id,
            })
            return { outcome: 'CREATED' as const, quote }
          }, COMMERCIAL_QUOTE_PREVIEW_BRIDGE_V3_TRANSACTION_OPTIONS)
        } catch (error) {
          if (isPreviewQuoteV3UniqueConflict(error)) {
            if (attempt === 2) return unavailable()
            recoveryOnly = true
            continue
          }
          if (postgresCode(error) === null) throw error
          if (attempt === 2) return unavailable()
          await dependencies.sleep(dependencies.retryDelayMilliseconds())
        }
      }
      return unavailable()
    },
  })
}

interface LockedOfferRow {
  id: string
  campaignCode: string
  sourceRevision: number
  schemaVersion: number
  snapshot: unknown
  checksum: string
  publishedAt: Date
}

interface LockedCatalogRow {
  id: string
  schemaVersion: number
  snapshot: unknown
  checksum: string
  publishedAt: Date
}

interface LockedQuoteRow {
  id: string
  schemaVersion: number
  catalogPublicationId: string
  offerVersionId: string | null
  acquisitionContextId: string | null
  organizationId: string | null
  venueId: string | null
  createdById: string | null
  market: string
  currency: string
  snapshot: unknown
  checksum: string
  listSubtotalMinor: bigint
  discountMinor: bigint
  subtotalMinor: bigint
  taxMinor: bigint
  totalMinor: bigint
  renewalSubtotalMinor: bigint
  renewalTaxMinor: bigint
  renewalTotalMinor: bigint
  quotedAt: Date
  expiresAt: Date
}

function verifyOfferRow(row: LockedOfferRow): CommercialQuoteV3OfferAuthority {
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
  return { rowSchemaVersion: row.schemaVersion, rowContext, snapshot: verified.snapshot, checksum: verified.checksum }
}

function verifyCatalogRow(row: LockedCatalogRow): CommercialQuoteV3CatalogAuthority {
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
}

export function createPrismaCommercialQuotePreviewBridgeV3Transaction(
  tx: Prisma.TransactionClient,
): CommercialQuotePreviewBridgeV3Transaction {
  return {
    setLocalLockTimeout: milliseconds => tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${milliseconds}ms'`),
    async lockOffer(offerVersionId) {
      const rows = await tx.$queryRaw<LockedOfferRow[]>(Prisma.sql`
        SELECT "id", "campaignCode", "sourceRevision", "schemaVersion", "snapshot", "checksum", "publishedAt"
        FROM "CommercialCampaignVersion"
        WHERE "id" = ${offerVersionId} AND "schemaVersion" = 3
        FOR SHARE
      `)
      return rows[0] ? verifyOfferRow(rows[0]) : null
    },
    async readLatestOfferControl(offerVersionId) {
      const row = await tx.commercialOfferControlEvent.findFirst({
        where: { offerVersionId },
        orderBy: { revision: 'desc' },
        select: { revision: true, action: true },
      })
      return row as CommercialOfferControlLatestEventV3 | null
    },
    async lockReservedCatalog(publicationId) {
      const rows = await tx.$queryRaw<LockedCatalogRow[]>(Prisma.sql`
        SELECT "id", "schemaVersion", "snapshot", "checksum", "publishedAt"
        FROM "CommercialPublication"
        WHERE "id" = ${publicationId} AND "schemaVersion" = 2
        FOR SHARE
      `)
      return rows[0] ? verifyCatalogRow(rows[0]) : null
    },
    async lockContext(contextId) {
      const rows = await tx.$queryRaw<CommercialQuotePreviewBridgeV3ContextRow[]>(Prisma.sql`
        SELECT "id", "campaignVersionId", "offerVersionId", "offerSchemaVersion",
               "reservedCatalogPublicationId", "reservedCatalogSchemaVersion", "createdAt", "expiresAt"
        FROM "CommercialAcquisitionContext"
        WHERE "id" = ${contextId}
        FOR SHARE
      `)
      return rows[0] ?? null
    },
    async lockBinding(contextId) {
      const rows = await tx.$queryRaw<CommercialQuotePreviewBridgeV3BindingRow[]>(Prisma.sql`
        SELECT "id", "acquisitionContextId", "staffId", "organizationId", "purpose",
               "staffCreatedAt", "organizationCreatedAt", "boundAt"
        FROM "CommercialAcquisitionContextBinding"
        WHERE "acquisitionContextId" = ${contextId}
        FOR SHARE
      `)
      return rows[0] ?? null
    },
    async lockOrganization(organizationId) {
      const rows = await tx.$queryRaw<Array<{ id: string; createdAt: Date }>>(Prisma.sql`
        SELECT "id", "createdAt" FROM "Organization" WHERE "id" = ${organizationId} FOR SHARE
      `)
      return rows[0] ?? null
    },
    async lockVenue(venueId) {
      const rows = await tx.$queryRaw<Array<{ id: string; organizationId: string; createdAt: Date }>>(Prisma.sql`
        SELECT "id", "organizationId", "createdAt" FROM "Venue" WHERE "id" = ${venueId} FOR SHARE
      `)
      return rows[0] ?? null
    },
    async lockStaff(staffId) {
      const rows = await tx.$queryRaw<Array<{ id: string; active: boolean; commercialCreatedAt: Date | null }>>(Prisma.sql`
        SELECT "id", "active", "commercialCreatedAt" FROM "Staff" WHERE "id" = ${staffId} FOR SHARE
      `)
      return rows[0] ?? null
    },
    async lockMembership(staffId, venueId) {
      const rows = await tx.$queryRaw<
        Array<{ staffId: string; venueId: string; active: boolean; role: StaffRole; permissionSetId: string | null }>
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
        SELECT "id", "venueId", "permissions" FROM "PermissionSet" WHERE "id" = ${permissionSetId} FOR SHARE
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
    async findVerifiedBridgeByPreviewQuoteId(previewQuoteId, authorities) {
      const bridgeRows = await tx.$queryRaw<
        Array<{
          previewQuoteId: string
          previewChecksum: string
          acquisitionContextId: string
          organizationId: string
          venueId: string
          actorId: string
          selectionFingerprint: string
          venueQuoteId: string
        }>
      >(Prisma.sql`
        SELECT "previewQuoteId", "previewChecksum", "acquisitionContextId", "organizationId",
               "venueId", "actorId", "selectionFingerprint", "venueQuoteId"
        FROM "CommercialQuotePreviewBridge"
        WHERE "previewQuoteId" = ${previewQuoteId}
        FOR SHARE
      `)
      const bridge = bridgeRows[0]
      if (!bridge) return null
      const quoteRows = await tx.$queryRaw<LockedQuoteRow[]>(Prisma.sql`
        SELECT "id", "schemaVersion", "catalogPublicationId", "offerVersionId", "acquisitionContextId",
               "organizationId", "venueId", "createdById", "market", "currency", "snapshot", "checksum",
               "listSubtotalMinor", "discountMinor", "subtotalMinor", "taxMinor", "totalMinor",
               "renewalSubtotalMinor", "renewalTaxMinor", "renewalTotalMinor", "quotedAt", "expiresAt"
        FROM "CommercialQuote"
        WHERE "id" = ${bridge.venueQuoteId}
        FOR SHARE
      `)
      const row = quoteRows[0]
      if (!row || row.schemaVersion !== 3 || row.offerVersionId === null) {
        bridgeError('La cotización vinculada no es compatible.', 409, 'COMMERCIAL_PREVIEW_BRIDGE_V3_QUOTE_INVALID')
      }
      const verified = decodeAndVerifyStoredCommercialQuoteV3({
        rowSchemaVersion: row.schemaVersion,
        snapshot: row.snapshot,
        checksum: row.checksum,
        rowContext: {
          id: row.id,
          schemaVersion: row.schemaVersion,
          catalogPublicationId: row.catalogPublicationId,
          offerVersionId: row.offerVersionId,
          acquisitionContextId: row.acquisitionContextId,
          organizationId: row.organizationId,
          venueId: row.venueId,
          createdById: row.createdById,
          venueOrganizationId: bridge.organizationId,
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
        },
        authorities,
      })
      return { ...bridge, quote: { id: row.id, snapshot: verified.snapshot, checksum: verified.checksum } }
    },
    async readDatabaseClock() {
      const rows = await tx.$queryRaw<Array<{ now: Date }>>`
        SELECT date_trunc('milliseconds', clock_timestamp()) AS "now"
      `
      return rows[0]?.now ?? new Date(Number.NaN)
    },
    async createBridge(record) {
      await tx.commercialQuotePreviewBridge.create({ data: record })
    },
    commercialQuote: tx.commercialQuote,
    activityLog: tx.activityLog,
  }
}

export function createPrismaCommercialQuotePreviewBridgeV3Service(
  host: PrismaClient,
  secrets: CommercialQuotePreviewSecretsInput = {
    quotePreviewSigningSecret: env.COMMERCIAL_QUOTE_PREVIEW_SIGNING_SECRET,
    publicationPreviewSigningSecret: env.COMMERCIAL_PREVIEW_SIGNING_SECRET,
  },
) {
  return createCommercialQuotePreviewBridgeV3Service({
    secrets,
    now: () => new Date(),
    verifyPreviewToken: verifyCommercialQuotePreviewTokenV3,
    fingerprintSelections: fingerprintCommercialQuoteV3Selections,
    evaluate: evaluateCommercialQuoteV3,
    build: buildCommercialQuoteV3,
    runInTransaction: (operation, options) =>
      host.$transaction(tx => operation(createPrismaCommercialQuotePreviewBridgeV3Transaction(tx)), options),
    randomId: randomUUID,
    sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    retryDelayMilliseconds: () => randomInt(25, 76),
  })
}
