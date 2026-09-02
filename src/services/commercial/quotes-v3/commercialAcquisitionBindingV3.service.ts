import { randomInt, randomUUID } from 'node:crypto'

import { CommercialAcquisitionBindingPurpose, OrgRole, Prisma, PrismaClient } from '@prisma/client'

import AppError, { ConflictError } from '@/errors/AppError'
import {
  assertCommercialOfferAllowsPreviewV3,
  resolveCommercialOfferControlStateV3,
  type CommercialOfferControlLatestEventV3,
} from '@/services/commercial/quotes-v3/commercialOfferControlV3.service'
import { hashCommercialAcquisitionContextTokenV3 } from '@/services/commercial/quotes-v3/commercialAcquisitionContextTokenV3.service'

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const RETRYABLE_POSTGRES_CODES = new Set(['40001', '40P01'])
const BINDING_UNIQUES = new Set([
  'CommercialAcquisitionContextBinding_acquisitionContextId_key',
  'CommercialAcquisitionContextBinding_staffId_purpose_key',
  'CommercialAcquisitionContextBinding_organizationId_purpose_key',
])

export interface BindCommercialAcquisitionContextV3Input {
  acquisitionToken: string
  staffId: string
  organizationId: string
  purpose: 'NEW_ACCOUNT'
}

export interface CommercialAcquisitionBindingV3ContextRow {
  id: string
  tokenHash: string
  campaignVersionId: string | null
  offerVersionId: string | null
  offerSchemaVersion: number | null
  reservedCatalogPublicationId: string | null
  reservedCatalogSchemaVersion: number | null
  createdAt: Date
  expiresAt: Date
}

export interface CommercialAcquisitionBindingV3Record {
  id: string
  acquisitionContextId: string
  staffId: string
  organizationId: string
  purpose: CommercialAcquisitionBindingPurpose
  staffCreatedAt: Date
  organizationCreatedAt: Date
  boundAt: Date
}

export interface CommercialAcquisitionBindingV3Audit {
  staffId: string
  actorType: null
  organizationId: string
  venueId: null
  action: 'COMMERCIAL_ACQUISITION_CONTEXT_BOUND'
  entity: 'CommercialAcquisitionContextBinding'
  entityId: string
  data: {
    acquisitionContextId: string
    organizationId: string
    purpose: 'NEW_ACCOUNT'
    boundAt: string
  }
}

interface CommercialAcquisitionBindingV3Membership {
  staffId: string
  organizationId: string
  role: OrgRole
  isActive: boolean
  isPrimary: boolean
  joinedAt: Date
  leftAt: Date | null
}

export interface CommercialAcquisitionBindingV3Transaction {
  setLocalLockTimeout(milliseconds: 1_000): Promise<unknown>
  findContextByTokenHash(tokenHash: string): Promise<CommercialAcquisitionBindingV3ContextRow | null>
  lockOffer(offerVersionId: string): Promise<{ id: string; schemaVersion: number } | null>
  readLatestOfferControl(offerVersionId: string): Promise<CommercialOfferControlLatestEventV3 | null>
  lockReservedCatalog(publicationId: string): Promise<{ id: string; schemaVersion: number } | null>
  lockContext(contextId: string): Promise<CommercialAcquisitionBindingV3ContextRow | null>
  findBindingByContextId(contextId: string): Promise<CommercialAcquisitionBindingV3Record | null>
  lockStaff(staffId: string): Promise<{ id: string; active: boolean; commercialCreatedAt: Date | null } | null>
  lockOrganization(organizationId: string): Promise<{ id: string; createdAt: Date } | null>
  lockMembership(staffId: string, organizationId: string): Promise<CommercialAcquisitionBindingV3Membership | null>
  findEarliestVenueCreatedAt(organizationId: string): Promise<Date | null>
  readDatabaseClock(): Promise<Date>
  createBinding(record: CommercialAcquisitionBindingV3Record): Promise<void>
  writeAudit(audit: CommercialAcquisitionBindingV3Audit): Promise<void>
}

export interface CommercialAcquisitionBindingV3Dependencies {
  runInTransaction<T>(
    operation: (tx: CommercialAcquisitionBindingV3Transaction) => Promise<T>,
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

export const COMMERCIAL_ACQUISITION_BINDING_V3_TRANSACTION_OPTIONS = Object.freeze({
  maxWait: 5_000,
  timeout: 5_000,
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
})

function bindingError(message: string, statusCode: number, code: string): never {
  throw new AppError(message, statusCode, true, code)
}

function conflict(): never {
  throw new ConflictError('La reservación ya fue vinculada.', 'COMMERCIAL_ACQUISITION_BINDING_CONFLICT')
}

function exactToken(token: string): boolean {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return false
  const bytes = Buffer.from(token, 'base64url')
  return bytes.length === 32 && bytes.toString('base64url') === token
}

function validateInput(input: BindCommercialAcquisitionContextV3Input): void {
  if (
    !exactToken(input.acquisitionToken) ||
    typeof input.staffId !== 'string' ||
    !ID_PATTERN.test(input.staffId) ||
    typeof input.organizationId !== 'string' ||
    !ID_PATTERN.test(input.organizationId) ||
    input.purpose !== 'NEW_ACCOUNT'
  ) {
    bindingError('La vinculación comercial no es válida.', 422, 'COMMERCIAL_ACQUISITION_BINDING_INVALID')
  }
}

function isDedicatedContext(row: CommercialAcquisitionBindingV3ContextRow): row is CommercialAcquisitionBindingV3ContextRow & {
  offerVersionId: string
  offerSchemaVersion: 3
  reservedCatalogPublicationId: string
  reservedCatalogSchemaVersion: 2
} {
  return (
    row.campaignVersionId === null &&
    typeof row.offerVersionId === 'string' &&
    row.offerVersionId.length > 0 &&
    row.offerSchemaVersion === 3 &&
    typeof row.reservedCatalogPublicationId === 'string' &&
    row.reservedCatalogPublicationId.length > 0 &&
    row.reservedCatalogSchemaVersion === 2
  )
}

function sameContext(left: CommercialAcquisitionBindingV3ContextRow, right: CommercialAcquisitionBindingV3ContextRow): boolean {
  return (
    left.id === right.id &&
    left.tokenHash === right.tokenHash &&
    left.offerVersionId === right.offerVersionId &&
    left.offerSchemaVersion === right.offerSchemaVersion &&
    left.reservedCatalogPublicationId === right.reservedCatalogPublicationId &&
    left.reservedCatalogSchemaVersion === right.reservedCatalogSchemaVersion &&
    left.createdAt.getTime() === right.createdAt.getTime() &&
    left.expiresAt.getTime() === right.expiresAt.getTime()
  )
}

function exactReplay(
  binding: CommercialAcquisitionBindingV3Record,
  input: BindCommercialAcquisitionContextV3Input,
  contextId: string,
) {
  if (
    binding.acquisitionContextId !== contextId ||
    binding.staffId !== input.staffId ||
    binding.organizationId !== input.organizationId ||
    binding.purpose !== input.purpose
  ) {
    return conflict()
  }
  return {
    outcome: 'REPLAYED' as const,
    acquisitionContextId: contextId,
    staffId: binding.staffId,
    organizationId: binding.organizationId,
    boundAt: binding.boundAt.toISOString(),
  }
}

function inReservationWindow(value: Date, context: CommercialAcquisitionBindingV3ContextRow): boolean {
  const time = value.getTime()
  return Number.isFinite(time) && time >= context.createdAt.getTime() && time <= context.expiresAt.getTime()
}

function namedUnique(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const candidate = error as { code?: unknown; meta?: unknown }
  if (candidate.code !== 'P2002' || typeof candidate.meta !== 'object' || candidate.meta === null) return null
  const target = (candidate.meta as { target?: unknown }).target
  if (typeof target === 'string') return BINDING_UNIQUES.has(target) ? target : null
  if (Array.isArray(target)) {
    const joined = target.join('_')
    return [...BINDING_UNIQUES].find(item => item.includes(joined)) ?? null
  }
  return null
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

function unavailable(): ConflictError {
  return new ConflictError('La vinculación comercial está ocupada. Vuelve a intentar.', 'COMMERCIAL_ACQUISITION_BINDING_UNAVAILABLE', {
    retryable: true,
    attempts: 2,
  })
}

export function createCommercialAcquisitionBindingV3Service(dependencies: CommercialAcquisitionBindingV3Dependencies) {
  async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        return await operation()
      } catch (error) {
        if (namedUnique(error) !== null) return conflict()
        if (postgresCode(error) === null) throw error
        if (attempt === 2) throw unavailable()
        await dependencies.sleep(dependencies.retryDelayMilliseconds())
      }
    }
    throw unavailable()
  }

  return Object.freeze({
    async bind(input: BindCommercialAcquisitionContextV3Input) {
      validateInput(input)
      return withRetry(() =>
        dependencies.runInTransaction(async tx => {
          await tx.setLocalLockTimeout(1_000)
          const routedContext = await tx.findContextByTokenHash(hashCommercialAcquisitionContextTokenV3(input.acquisitionToken))
          if (routedContext === null || !isDedicatedContext(routedContext)) {
            bindingError('La reservación comercial no existe.', 404, 'COMMERCIAL_ACQUISITION_NOT_FOUND')
          }
          const offer = await tx.lockOffer(routedContext.offerVersionId)
          if (offer === null || offer.id !== routedContext.offerVersionId || offer.schemaVersion !== 3) {
            bindingError('La oferta reservada no está disponible.', 409, 'COMMERCIAL_ACQUISITION_V3_OFFER_INVALID')
          }
          const control = await tx.readLatestOfferControl(routedContext.offerVersionId)
          assertCommercialOfferAllowsPreviewV3(resolveCommercialOfferControlStateV3(control))
          const catalog = await tx.lockReservedCatalog(routedContext.reservedCatalogPublicationId)
          if (catalog === null || catalog.id !== routedContext.reservedCatalogPublicationId || catalog.schemaVersion !== 2) {
            bindingError('El catálogo reservado no está disponible.', 409, 'COMMERCIAL_ACQUISITION_V3_CATALOG_INVALID')
          }
          const context = await tx.lockContext(routedContext.id)
          if (context === null || !isDedicatedContext(context) || !sameContext(routedContext, context)) {
            bindingError('La reservación comercial cambió.', 409, 'COMMERCIAL_ACQUISITION_CONTEXT_CHANGED')
          }
          const existing = await tx.findBindingByContextId(context.id)
          if (existing !== null) return exactReplay(existing, input, context.id)

          const staff = await tx.lockStaff(input.staffId)
          const organization = await tx.lockOrganization(input.organizationId)
          const membership = await tx.lockMembership(input.staffId, input.organizationId)
          const earliestVenue = await tx.findEarliestVenueCreatedAt(input.organizationId)
          const now = await tx.readDatabaseClock()
          if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
            bindingError('El reloj comercial no está disponible.', 503, 'COMMERCIAL_ACQUISITION_BINDING_CLOCK_INVALID')
          }
          if (now >= context.expiresAt) {
            bindingError('La reservación comercial venció.', 410, 'COMMERCIAL_ACQUISITION_EXPIRED')
          }
          if (
            staff === null ||
            staff.id !== input.staffId ||
            !staff.active ||
            staff.commercialCreatedAt === null ||
            organization === null ||
            organization.id !== input.organizationId ||
            membership === null ||
            membership.staffId !== input.staffId ||
            membership.organizationId !== input.organizationId ||
            membership.role !== OrgRole.OWNER ||
            !membership.isActive ||
            !membership.isPrimary ||
            membership.leftAt !== null ||
            !inReservationWindow(staff.commercialCreatedAt, context) ||
            !inReservationWindow(organization.createdAt, context) ||
            !inReservationWindow(membership.joinedAt, context) ||
            (earliestVenue !== null && earliestVenue.getTime() < context.createdAt.getTime())
          ) {
            bindingError('La cuenta no cumple la condición de cliente nuevo.', 409, 'COMMERCIAL_ACQUISITION_NEW_ACCOUNT_INELIGIBLE')
          }
          const record: CommercialAcquisitionBindingV3Record = {
            id: dependencies.randomId(),
            acquisitionContextId: context.id,
            staffId: staff.id,
            organizationId: organization.id,
            purpose: CommercialAcquisitionBindingPurpose.NEW_ACCOUNT,
            staffCreatedAt: new Date(staff.commercialCreatedAt.getTime()),
            organizationCreatedAt: new Date(organization.createdAt.getTime()),
            boundAt: new Date(now.getTime()),
          }
          await tx.createBinding(record)
          await tx.writeAudit({
            staffId: record.staffId,
            actorType: null,
            organizationId: record.organizationId,
            venueId: null,
            action: 'COMMERCIAL_ACQUISITION_CONTEXT_BOUND',
            entity: 'CommercialAcquisitionContextBinding',
            entityId: record.id,
            data: {
              acquisitionContextId: record.acquisitionContextId,
              organizationId: record.organizationId,
              purpose: 'NEW_ACCOUNT',
              boundAt: record.boundAt.toISOString(),
            },
          })
          return {
            outcome: 'CREATED' as const,
            acquisitionContextId: record.acquisitionContextId,
            staffId: record.staffId,
            organizationId: record.organizationId,
            boundAt: record.boundAt.toISOString(),
          }
        }, COMMERCIAL_ACQUISITION_BINDING_V3_TRANSACTION_OPTIONS),
      )
    },
  })
}

export function createPrismaCommercialAcquisitionBindingV3Transaction(
  tx: Prisma.TransactionClient,
): CommercialAcquisitionBindingV3Transaction {
  const contextSelect = Prisma.sql`
    "id", "tokenHash", "campaignVersionId", "offerVersionId", "offerSchemaVersion",
    "reservedCatalogPublicationId", "reservedCatalogSchemaVersion", "createdAt", "expiresAt"
  `
  return {
    setLocalLockTimeout: milliseconds => tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${milliseconds}ms'`),
    findContextByTokenHash: tokenHashValue =>
      tx.commercialAcquisitionContext.findUnique({
        where: { tokenHash: tokenHashValue },
        select: {
          id: true,
          tokenHash: true,
          campaignVersionId: true,
          offerVersionId: true,
          offerSchemaVersion: true,
          reservedCatalogPublicationId: true,
          reservedCatalogSchemaVersion: true,
          createdAt: true,
          expiresAt: true,
        },
      }),
    async lockOffer(offerVersionId) {
      const rows = await tx.$queryRaw<Array<{ id: string; schemaVersion: number }>>(Prisma.sql`
        SELECT "id", "schemaVersion"
        FROM "CommercialCampaignVersion"
        WHERE "id" = ${offerVersionId} AND "schemaVersion" = 3
        FOR SHARE
      `)
      return rows[0] ?? null
    },
    readLatestOfferControl: offerVersionId =>
      tx.commercialOfferControlEvent.findFirst({
        where: { offerVersionId },
        orderBy: { revision: 'desc' },
        select: { revision: true, action: true },
      }),
    async lockReservedCatalog(publicationId) {
      const rows = await tx.$queryRaw<Array<{ id: string; schemaVersion: number }>>(Prisma.sql`
        SELECT "id", "schemaVersion"
        FROM "CommercialPublication"
        WHERE "id" = ${publicationId} AND "schemaVersion" = 2
        FOR SHARE
      `)
      return rows[0] ?? null
    },
    async lockContext(contextId) {
      const rows = await tx.$queryRaw<CommercialAcquisitionBindingV3ContextRow[]>(Prisma.sql`
        SELECT ${contextSelect}
        FROM "CommercialAcquisitionContext"
        WHERE "id" = ${contextId}
        FOR UPDATE
      `)
      return rows[0] ?? null
    },
    findBindingByContextId: contextId =>
      tx.commercialAcquisitionContextBinding.findUnique({ where: { acquisitionContextId: contextId } }),
    async lockStaff(staffId) {
      const rows = await tx.$queryRaw<Array<{ id: string; active: boolean; commercialCreatedAt: Date | null }>>(Prisma.sql`
        SELECT "id", "active", "commercialCreatedAt"
        FROM "Staff"
        WHERE "id" = ${staffId}
        FOR SHARE
      `)
      return rows[0] ?? null
    },
    async lockOrganization(organizationId) {
      const rows = await tx.$queryRaw<Array<{ id: string; createdAt: Date }>>(Prisma.sql`
        SELECT "id", "createdAt"
        FROM "Organization"
        WHERE "id" = ${organizationId}
        FOR SHARE
      `)
      return rows[0] ?? null
    },
    async lockMembership(staffId, organizationId) {
      const rows = await tx.$queryRaw<CommercialAcquisitionBindingV3Membership[]>(Prisma.sql`
        SELECT "staffId", "organizationId", "role", "isActive", "isPrimary", "joinedAt", "leftAt"
        FROM "StaffOrganization"
        WHERE "staffId" = ${staffId} AND "organizationId" = ${organizationId}
        FOR SHARE
      `)
      return rows[0] ?? null
    },
    async findEarliestVenueCreatedAt(organizationId) {
      const row = await tx.venue.findFirst({
        where: { organizationId },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      })
      return row?.createdAt ?? null
    },
    async readDatabaseClock() {
      const rows = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
        SELECT date_trunc('milliseconds', pg_catalog.clock_timestamp()) AS "now"
      `)
      if (!rows[0]) bindingError('El reloj comercial no está disponible.', 503, 'COMMERCIAL_ACQUISITION_BINDING_CLOCK_INVALID')
      return rows[0].now
    },
    async createBinding(record) {
      await tx.commercialAcquisitionContextBinding.create({ data: record })
    },
    async writeAudit(audit) {
      await tx.activityLog.create({
        data: {
          staffId: audit.staffId,
          actorType: audit.actorType,
          organizationId: audit.organizationId,
          venueId: audit.venueId,
          action: audit.action,
          entity: audit.entity,
          entityId: audit.entityId,
          data: audit.data as Prisma.InputJsonValue,
        },
      })
    },
  }
}

export function createPrismaCommercialAcquisitionBindingV3Service(host: PrismaClient) {
  return createCommercialAcquisitionBindingV3Service({
    runInTransaction: (operation, options) =>
      host.$transaction(tx => operation(createPrismaCommercialAcquisitionBindingV3Transaction(tx)), options),
    randomId: randomUUID,
    sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    retryDelayMilliseconds: () => randomInt(25, 76),
  })
}
