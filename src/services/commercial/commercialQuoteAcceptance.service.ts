import { randomUUID } from 'node:crypto'
import { env } from '@/config/env'
import AppError from '@/errors/AppError'
import prisma from '@/utils/prismaClient'
import {
  CommercialArtifactCodecError,
  decodeAndVerifyStoredCommercialCampaignV2,
} from './commercialArtifactCodecRegistry.service'
import { assertCommercialV2CheckoutActive } from './commercialV2CheckoutPolicy.service'

export interface AcceptCommercialQuoteInput {
  quoteId: string
  organizationId: string
  venueId: string
  acceptedById: string
  idempotencyKey: string
}

interface LockedCommercialQuote {
  id: string
  organizationId: string | null
  venueId: string | null
  schemaVersion: number
  offerVersionId: string | null
  catalogPublicationId: string
  campaignVersionId: string | null
  expiresAt: Date
}

export interface CommercialQuoteCampaignAuthorityRow {
  id: string
  campaignCode: string
  sourceRevision: number
  schemaVersion: number
  snapshot: unknown
  checksum: string
  publishedAt: Date
}

interface CommercialQuoteAcceptanceRecord extends AcceptCommercialQuoteInput {
  id: string
  status: string
  revision: number
  acceptedAt?: Date
}

interface CreateAcceptanceInput extends AcceptCommercialQuoteInput {
  id: string
  acceptedAt: Date
}

export interface CommercialQuoteAcceptanceTransaction {
  lockQuote(id: string): Promise<LockedCommercialQuote | null>
  findAcceptanceByQuoteId(quoteId: string): Promise<CommercialQuoteAcceptanceRecord | null>
  isQuoteAuthorityCurrent(quote: LockedCommercialQuote, now: Date): Promise<boolean>
  createAcceptance(input: CreateAcceptanceInput): Promise<CommercialQuoteAcceptanceRecord>
  writeAudit(input: {
    acceptanceId: string
    quoteId: string
    organizationId: string
    acceptedById: string
    acceptedAt: Date
  }): Promise<void>
}

export interface CommercialQuoteAcceptanceDependencies {
  assertCheckoutAllowed(): void
  now(): Date
  randomId(): string
  runInTransaction<T>(operation: (tx: CommercialQuoteAcceptanceTransaction) => Promise<T>): Promise<T>
}

function acceptanceError(code: string, message: string, statusCode = 409): AppError {
  return new AppError(message, statusCode, true, code)
}

function validateInput(input: AcceptCommercialQuoteInput): void {
  const validId = (value: string) => typeof value === 'string' && value.trim().length > 0 && value.length <= 128
  if (
    !validId(input.quoteId) ||
    !validId(input.organizationId) ||
    !validId(input.venueId) ||
    !validId(input.acceptedById) ||
    !/^[A-Za-z0-9._:-]{16,128}$/.test(input.idempotencyKey)
  ) {
    throw acceptanceError('COMMERCIAL_QUOTE_ACCEPTANCE_INVALID', 'La aceptación de cotización no es válida.', 422)
  }
}

export function isCommercialQuoteCampaignAuthorityCurrent(version: CommercialQuoteCampaignAuthorityRow, now: Date): boolean {
  let nowTime: number
  try {
    nowTime = Date.prototype.getTime.call(now)
  } catch {
    return false
  }
  if (!Number.isFinite(nowTime)) return false

  try {
    const verified = decodeAndVerifyStoredCommercialCampaignV2({
      kind: 'CAMPAIGN',
      rowSchemaVersion: version.schemaVersion,
      snapshot: version.snapshot,
      checksum: version.checksum,
      rowContext: {
        kind: 'CAMPAIGN',
        id: version.id,
        campaignCode: version.campaignCode,
        sourceRevision: version.sourceRevision,
        schemaVersion: version.schemaVersion,
        publishedAt: version.publishedAt,
      },
    })
    const startsAt = Date.parse(verified.snapshot.startsAt)
    const endsAt = Date.parse(verified.snapshot.endsAt)
    return verified.snapshot.status === 'ACTIVE' && nowTime >= startsAt && nowTime < endsAt
  } catch (error) {
    if (error instanceof CommercialArtifactCodecError) return false
    throw error
  }
}

export function createCommercialQuoteAcceptanceService(dependencies: CommercialQuoteAcceptanceDependencies) {
  return {
    async accept(input: AcceptCommercialQuoteInput): Promise<CommercialQuoteAcceptanceRecord> {
      dependencies.assertCheckoutAllowed()
      validateInput(input)
      const now = dependencies.now()
      return dependencies.runInTransaction(async tx => {
        const quote = await tx.lockQuote(input.quoteId)
        if (!quote) throw acceptanceError('COMMERCIAL_QUOTE_NOT_FOUND', 'La cotización no existe.', 404)
        if (quote.schemaVersion !== 2 || quote.offerVersionId !== null) {
          throw acceptanceError(
            'COMMERCIAL_QUOTE_SCHEMA_UNSUPPORTED',
            'Esta versión de la cotización requiere el flujo comercial nuevo.',
          )
        }
        if (quote.organizationId !== input.organizationId || quote.venueId !== input.venueId) {
          throw acceptanceError('COMMERCIAL_QUOTE_SCOPE_MISMATCH', 'La cotización no pertenece a esta organización y sucursal.', 403)
        }
        const existing = await tx.findAcceptanceByQuoteId(input.quoteId)
        if (existing) {
          if (existing.idempotencyKey === input.idempotencyKey) return existing
          throw acceptanceError('COMMERCIAL_QUOTE_ALREADY_ACCEPTED', 'La cotización ya fue aceptada con otra operación.')
        }
        if (quote.expiresAt.getTime() <= now.getTime()) {
          throw acceptanceError('COMMERCIAL_QUOTE_EXPIRED', 'La cotización venció; genera una nueva.', 410)
        }
        if (!(await tx.isQuoteAuthorityCurrent(quote, now))) {
          throw acceptanceError('COMMERCIAL_QUOTE_SUPERSEDED', 'La cotización fue reemplazada; genera una oferta vigente.')
        }
        const acceptance = await tx.createAcceptance({
          ...input,
          id: dependencies.randomId(),
          acceptedAt: now,
        })
        await tx.writeAudit({
          acceptanceId: acceptance.id,
          quoteId: input.quoteId,
          organizationId: input.organizationId,
          acceptedById: input.acceptedById,
          acceptedAt: now,
        })
        return acceptance
      })
    },
  }
}

export const prismaCommercialQuoteAcceptanceDependencies: CommercialQuoteAcceptanceDependencies = {
  assertCheckoutAllowed: () => assertCommercialV2CheckoutActive(env.COMMERCIAL_V2_CHECKOUT_MODE),
  now: () => new Date(),
  randomId: () => randomUUID(),
  runInTransaction: operation =>
    prisma.$transaction(async prismaTx => {
      const tx: CommercialQuoteAcceptanceTransaction = {
        async lockQuote(id) {
          const rows = await prismaTx.$queryRaw<LockedCommercialQuote[]>`
            SELECT "id", "organizationId", "venueId", "schemaVersion", "offerVersionId",
                   "catalogPublicationId", "campaignVersionId", "expiresAt"
            FROM "CommercialQuote"
            WHERE "id" = ${id}
            FOR UPDATE
          `
          return rows[0] ?? null
        },
        findAcceptanceByQuoteId: quoteId => prismaTx.commercialQuoteAcceptance.findUnique({ where: { quoteId } }),
        async isQuoteAuthorityCurrent(quote, now) {
          const catalog = await prismaTx.commercialPublicationActivation.findUnique({
            where: { environment: 'PRODUCTION' },
            select: { publicationId: true },
          })
          if (catalog?.publicationId !== quote.catalogPublicationId) return false
          if (!quote.campaignVersionId) return true
          const version = await prismaTx.commercialCampaignVersion.findUnique({
            where: { id: quote.campaignVersionId },
            select: {
              id: true,
              campaignCode: true,
              sourceRevision: true,
              schemaVersion: true,
              snapshot: true,
              checksum: true,
              publishedAt: true,
            },
          })
          if (!version) return false
          const activation = await prismaTx.commercialCampaignActivation.findUnique({
            where: { environment_campaignCode: { environment: 'PRODUCTION', campaignCode: version.campaignCode } },
            select: { campaignVersionId: true },
          })
          if (activation?.campaignVersionId !== quote.campaignVersionId) return false
          return isCommercialQuoteCampaignAuthorityCurrent(version, now)
        },
        createAcceptance: input =>
          prismaTx.commercialQuoteAcceptance.create({
            data: {
              id: input.id,
              quoteId: input.quoteId,
              idempotencyKey: input.idempotencyKey,
              organizationId: input.organizationId,
              venueId: input.venueId,
              acceptedById: input.acceptedById,
              acceptedAt: input.acceptedAt,
            },
          }),
        async writeAudit(input) {
          await prismaTx.activityLog.create({
            data: {
              staffId: input.acceptedById,
              actorStaffId: input.acceptedById,
              actorType: 'HUMAN',
              organizationId: input.organizationId,
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
      return operation(tx)
    }),
}

export const commercialQuoteAcceptanceService = createCommercialQuoteAcceptanceService(prismaCommercialQuoteAcceptanceDependencies)
