import { createHash, randomInt, randomUUID } from 'node:crypto'

import { Prisma, PrismaClient } from '@prisma/client'
import { z } from 'zod'

import type { CommercialQuotePreviewSecretsInput } from '@/config/commercialQuotePreviewSecrets'
import { env } from '@/config/env'
import AppError, { ConflictError } from '@/errors/AppError'
import { decodeAndVerifyStoredCommercialCatalogV2 } from '@/services/commercial/commercialArtifactCodecRegistry.service'
import { canonicalJsonBytesV2 } from '@/services/commercial/commercialCanonicalJsonV2.service'
import { decodeAndVerifyStoredCommercialOfferV3 } from '@/services/commercial/offers/commercialOfferV3.service'
import { hashCommercialAcquisitionContextTokenV3 } from '@/services/commercial/quotes-v3/commercialAcquisitionContextTokenV3.service'
import {
  assertCommercialOfferAllowsPreviewV3,
  resolveCommercialOfferControlStateV3,
} from '@/services/commercial/quotes-v3/commercialOfferControlV3.service'
import { buildCommercialQuoteV3 } from '@/services/commercial/quotes-v3/commercialQuoteV3Builder.service'
import {
  evaluateCommercialQuoteV3,
  materializeCommercialQuoteV3Selections,
  type EvaluateCommercialQuoteV3Input,
} from '@/services/commercial/quotes-v3/commercialQuoteV3Engine.service'
import {
  COMMERCIAL_QUOTE_PREVIEW_V3_TTL_MS,
  issueCommercialQuotePreviewTokenV3,
  type CommercialQuotePreviewTokenPayloadV3,
} from '@/services/commercial/quotes-v3/commercialQuotePreviewTokenV3.service'
import type { CommercialQuoteSnapshotV3, CommercialQuoteV3Authorities, EmittedCommercialQuoteV3 } from '@/types/commercialQuoteV3'

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u
const SELECTION_FINGERPRINT_DOMAIN = Buffer.from('avoqado.commercial.quote-v3-selection@3\0', 'ascii')
const RETRYABLE_POSTGRES_CODES = new Set(['40001', '40P01'])
const requestSchema = z
  .object({
    acquisitionToken: z.string().regex(TOKEN_PATTERN),
    saasSelections: z.unknown(),
    hardwareSelections: z.unknown(),
    rateBlockers: z.unknown(),
  })
  .strict()

type CommercialQuoteV3Selections = Pick<
  EvaluateCommercialQuoteV3Input,
  'saasSelections' | 'hardwareSelections' | 'rateBlockers'
>

export interface CommercialPublicQuotePreviewV3AuthorityContext {
  acquisition: {
    id: string
    createdAt: Date
    expiresAt: Date
  }
  authorities: CommercialQuoteV3Authorities
  quotedAt: Date
}

export interface CommercialPublicQuotePreviewV3Dependencies {
  withPinnedAuthorities<T>(
    acquisitionToken: string,
    operation: (context: CommercialPublicQuotePreviewV3AuthorityContext) => Promise<T> | T,
  ): Promise<T>
  evaluate(input: EvaluateCommercialQuoteV3Input): ReturnType<typeof evaluateCommercialQuoteV3>
  build(input: Parameters<typeof buildCommercialQuoteV3>[0]): EmittedCommercialQuoteV3
  issuePreviewToken(payload: CommercialQuotePreviewTokenPayloadV3, secrets: CommercialQuotePreviewSecretsInput): string
  randomId(): string
  secrets: CommercialQuotePreviewSecretsInput
}

export interface CommercialPublicQuotePreviewV3Result {
  quote: CommercialQuoteSnapshotV3
  checksum: string
  previewToken: string
}

interface PinnedContextRow {
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

interface OfferRow {
  id: string
  campaignCode: string
  sourceRevision: number
  schemaVersion: number
  snapshot: unknown
  checksum: string
  publishedAt: Date
}

interface CatalogRow {
  id: string
  schemaVersion: number
  snapshot: unknown
  checksum: string
  publishedAt: Date
}

function previewError(message: string, statusCode: number, code: string): never {
  throw new AppError(message, statusCode, true, code)
}

function exactToken(token: string): boolean {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return false
  const bytes = Buffer.from(token, 'base64url')
  return bytes.length === 32 && bytes.toString('base64url') === token
}

function exactDate(value: Date, code: string): Date {
  try {
    const time = Date.prototype.getTime.call(value)
    if (!Number.isFinite(time)) return previewError('El reloj de vista previa no es válido.', 503, code)
    return new Date(time)
  } catch {
    return previewError('El reloj de vista previa no es válido.', 503, code)
  }
}

function materializeRequest(input: unknown): { acquisitionToken: string; selections: ReturnType<typeof materializeCommercialQuoteV3Selections> } {
  const parsed = requestSchema.safeParse(input)
  if (!parsed.success || !exactToken(parsed.data.acquisitionToken)) {
    previewError('La solicitud de cotización no es válida.', 422, 'COMMERCIAL_QUOTE_V3_INPUT_INVALID')
  }
  const selections = materializeCommercialQuoteV3Selections({
    saasSelections: parsed.data.saasSelections as EvaluateCommercialQuoteV3Input['saasSelections'],
    hardwareSelections: parsed.data.hardwareSelections as EvaluateCommercialQuoteV3Input['hardwareSelections'],
    rateBlockers: parsed.data.rateBlockers as EvaluateCommercialQuoteV3Input['rateBlockers'],
  })
  return { acquisitionToken: parsed.data.acquisitionToken, selections }
}

export function fingerprintCommercialQuoteV3Selections(input: CommercialQuoteV3Selections): string {
  const selections = materializeCommercialQuoteV3Selections(input)
  return createHash('sha256')
    .update(Buffer.concat([SELECTION_FINGERPRINT_DOMAIN, canonicalJsonBytesV2(selections)]))
    .digest('hex')
}

export function createCommercialPublicQuotePreviewV3Service(dependencies: CommercialPublicQuotePreviewV3Dependencies) {
  return Object.freeze({
    async preview(input: unknown): Promise<CommercialPublicQuotePreviewV3Result> {
      const request = materializeRequest(input)
      const selectionFingerprint = fingerprintCommercialQuoteV3Selections(request.selections)
      return dependencies.withPinnedAuthorities(request.acquisitionToken, async context => {
        if (
          context.authorities.acquisitionContext?.id !== context.acquisition.id ||
          new Date(context.authorities.acquisitionContext.createdAt).getTime() !== context.acquisition.createdAt.getTime()
        ) {
          previewError('La autoridad de adquisición no coincide.', 409, 'COMMERCIAL_ACQUISITION_CONTEXT_CHANGED')
        }
        const quotedAt = exactDate(context.quotedAt, 'COMMERCIAL_PREVIEW_CLOCK_INVALID')
        const expiresAt = new Date(quotedAt.getTime() + COMMERCIAL_QUOTE_PREVIEW_V3_TTL_MS)
        const evaluation = dependencies.evaluate({
          authorities: {
            catalog: context.authorities.catalog,
            offer: context.authorities.offer,
          },
          ...request.selections,
          resolvedAt: new Date(context.acquisition.createdAt.getTime()),
        })
        const emitted = dependencies.build({
          quoteId: dependencies.randomId(),
          subject: { kind: 'ACQUISITION_CONTEXT', acquisitionContextId: context.acquisition.id },
          acquisitionContextId: context.acquisition.id,
          derivedFromPreview: null,
          quotedAt,
          expiresAt,
          evaluation,
          authorities: context.authorities,
        })
        const payload: CommercialQuotePreviewTokenPayloadV3 = {
          version: 3,
          previewQuoteId: emitted.snapshot.quoteId,
          previewChecksum: emitted.checksum,
          acquisitionContextId: context.acquisition.id,
          offerVersionId: emitted.snapshot.offerVersionId,
          offerChecksum: emitted.snapshot.offerChecksum,
          catalogPublicationId: emitted.snapshot.catalogPublicationId,
          catalogChecksum: emitted.snapshot.catalogChecksum,
          selectionFingerprint,
          issuedAt: emitted.snapshot.quotedAt,
          expiresAt: emitted.snapshot.expiresAt,
        }
        return Object.freeze({
          quote: emitted.snapshot,
          checksum: emitted.checksum,
          previewToken: dependencies.issuePreviewToken(payload, dependencies.secrets),
        })
      })
    },
  })
}

function isDedicatedContext(row: PinnedContextRow): row is PinnedContextRow & {
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

function sameContext(left: PinnedContextRow, right: PinnedContextRow): boolean {
  return (
    left.id === right.id &&
    left.tokenHash === right.tokenHash &&
    left.offerVersionId === right.offerVersionId &&
    left.reservedCatalogPublicationId === right.reservedCatalogPublicationId &&
    left.createdAt.getTime() === right.createdAt.getTime() &&
    left.expiresAt.getTime() === right.expiresAt.getTime()
  )
}

function verifyOffer(row: OfferRow) {
  try {
    const verified = decodeAndVerifyStoredCommercialOfferV3({
      rowSchemaVersion: row.schemaVersion,
      snapshot: row.snapshot,
      checksum: row.checksum,
      rowContext: {
        id: row.id,
        campaignCode: row.campaignCode,
        sourceRevision: row.sourceRevision,
        schemaVersion: row.schemaVersion,
        publishedAt: row.publishedAt,
      },
    })
    if (verified.snapshot.status !== 'ACTIVE') {
      previewError('La oferta reservada no está activa.', 409, 'COMMERCIAL_ACQUISITION_V3_OFFER_INVALID')
    }
    return {
      rowSchemaVersion: row.schemaVersion,
      rowContext: {
        id: row.id,
        campaignCode: row.campaignCode,
        sourceRevision: row.sourceRevision,
        schemaVersion: row.schemaVersion,
        publishedAt: row.publishedAt,
      },
      snapshot: verified.snapshot,
      checksum: verified.checksum,
    }
  } catch (error) {
    if (error instanceof AppError) throw error
    return previewError('La oferta reservada no es válida.', 409, 'COMMERCIAL_ACQUISITION_V3_OFFER_INVALID')
  }
}

function verifyCatalog(row: CatalogRow) {
  if (row.schemaVersion !== 2) {
    previewError('El catálogo reservado no es v2.', 409, 'COMMERCIAL_ACQUISITION_V3_CATALOG_INVALID')
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
    return previewError('El catálogo reservado no es válido.', 409, 'COMMERCIAL_ACQUISITION_V3_CATALOG_INVALID')
  }
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
  return new ConflictError('La vista previa comercial está ocupada. Vuelve a intentar.', 'COMMERCIAL_PREVIEW_V3_UNAVAILABLE', {
    retryable: true,
    attempts: 2,
  })
}

function createPrismaPinnedAuthoritiesLoader(host: PrismaClient) {
  return async function withPinnedAuthorities<T>(
    acquisitionToken: string,
    operation: (context: CommercialPublicQuotePreviewV3AuthorityContext) => Promise<T> | T,
  ): Promise<T> {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        return await host.$transaction(
          async tx => {
            await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '1000ms'")
            const routed = await tx.commercialAcquisitionContext.findUnique({
              where: { tokenHash: hashCommercialAcquisitionContextTokenV3(acquisitionToken) },
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
            })
            if (routed === null || !isDedicatedContext(routed)) {
              previewError('El contexto de adquisición no existe.', 404, 'COMMERCIAL_ACQUISITION_NOT_FOUND')
            }
            const offerRows = await tx.$queryRaw<OfferRow[]>(Prisma.sql`
              SELECT "id", "campaignCode", "sourceRevision", "schemaVersion", "snapshot", "checksum", "publishedAt"
              FROM "CommercialCampaignVersion"
              WHERE "id" = ${routed.offerVersionId} AND "schemaVersion" = 3
              FOR SHARE
            `)
            const offerRow = offerRows[0]
            if (!offerRow) previewError('La oferta reservada no existe.', 409, 'COMMERCIAL_ACQUISITION_V3_OFFER_INVALID')
            const latestControl = await tx.commercialOfferControlEvent.findFirst({
              where: { offerVersionId: routed.offerVersionId },
              orderBy: { revision: 'desc' },
              select: { revision: true, action: true },
            })
            assertCommercialOfferAllowsPreviewV3(resolveCommercialOfferControlStateV3(latestControl))
            const catalogRows = await tx.$queryRaw<CatalogRow[]>(Prisma.sql`
              SELECT "id", "schemaVersion", "snapshot", "checksum", "publishedAt"
              FROM "CommercialPublication"
              WHERE "id" = ${routed.reservedCatalogPublicationId} AND "schemaVersion" = 2
              FOR SHARE
            `)
            const catalogRow = catalogRows[0]
            if (!catalogRow) previewError('El catálogo reservado no existe.', 409, 'COMMERCIAL_ACQUISITION_V3_CATALOG_INVALID')
            const contextRows = await tx.$queryRaw<PinnedContextRow[]>(Prisma.sql`
              SELECT "id", "tokenHash", "campaignVersionId", "offerVersionId", "offerSchemaVersion",
                     "reservedCatalogPublicationId", "reservedCatalogSchemaVersion", "createdAt", "expiresAt"
              FROM "CommercialAcquisitionContext"
              WHERE "id" = ${routed.id}
              FOR SHARE
            `)
            const locked = contextRows[0]
            if (!locked || !isDedicatedContext(locked) || !sameContext(routed, locked)) {
              previewError('El contexto de adquisición cambió.', 409, 'COMMERCIAL_ACQUISITION_CONTEXT_CHANGED')
            }
            const clockRows = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
              SELECT date_trunc('milliseconds', pg_catalog.clock_timestamp()) AS "now"
            `)
            const quotedAt = clockRows[0]?.now
            if (!quotedAt || !Number.isFinite(quotedAt.getTime())) {
              previewError('El reloj de vista previa no está disponible.', 503, 'COMMERCIAL_PREVIEW_CLOCK_INVALID')
            }
            if (quotedAt >= locked.expiresAt) {
              previewError('El contexto de adquisición venció.', 410, 'COMMERCIAL_ACQUISITION_EXPIRED')
            }
            const authorities: CommercialQuoteV3Authorities = {
              catalog: verifyCatalog(catalogRow),
              offer: verifyOffer(offerRow),
              acquisitionContext: { id: locked.id, createdAt: locked.createdAt },
            }
            return operation({
              acquisition: { id: locked.id, createdAt: locked.createdAt, expiresAt: locked.expiresAt },
              authorities,
              quotedAt,
            })
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
            maxWait: 5_000,
            timeout: 5_000,
          },
        )
      } catch (error) {
        if (postgresCode(error) === null) throw error
        if (attempt === 2) throw unavailable()
        await new Promise(resolve => setTimeout(resolve, randomInt(25, 76)))
      }
    }
    throw unavailable()
  }
}

export function createPrismaCommercialPublicQuotePreviewV3Service(
  host: PrismaClient,
  secrets: CommercialQuotePreviewSecretsInput = {
    quotePreviewSigningSecret: env.COMMERCIAL_QUOTE_PREVIEW_SIGNING_SECRET,
    publicationPreviewSigningSecret: env.COMMERCIAL_PREVIEW_SIGNING_SECRET,
  },
) {
  return createCommercialPublicQuotePreviewV3Service({
    withPinnedAuthorities: createPrismaPinnedAuthoritiesLoader(host),
    evaluate: evaluateCommercialQuoteV3,
    build: buildCommercialQuoteV3,
    issuePreviewToken: issueCommercialQuotePreviewTokenV3,
    randomId: randomUUID,
    secrets,
  })
}
