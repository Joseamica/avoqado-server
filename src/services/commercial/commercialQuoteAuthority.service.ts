import { randomUUID } from 'node:crypto'
import AppError from '@/errors/AppError'
import { commercialCampaignVersionSchema, commercialQuoteRequestSchema } from '@/schemas/commercialQuote.schema'
import { hashCanonicalJsonV1 } from '@/services/master-catalog/catalogHash.service'
import type { CommercialCatalogSnapshotV1 } from '@/types/commercial'
import type {
  CommercialAcquisitionContextRecordV1,
  CommercialCampaignVersionV1,
  CommercialQuoteRequestV1,
  CommercialQuoteV1,
} from '@/types/commercialQuote'
import prisma from '@/utils/prismaClient'
import { assertCommercialContractV1 } from './commercialContract.service'
import { commercialAcquisitionContextService } from './commercialAcquisitionContext.service'
import { evaluateCommercialQuote } from './commercialQuoteEngine.service'

type SafeAcquisitionContext = Omit<CommercialAcquisitionContextRecordV1, 'tokenHash'>

export interface CommercialQuoteAuthorityDependencies {
  now(): Date
  randomId(): string
  quoteTtlMs: number
  loadActiveCatalog(): Promise<{ id: string; snapshot: unknown } | null>
  resolveAcquisition(token: string, now: Date): Promise<SafeAcquisitionContext>
  loadCampaignVersion(id: string): Promise<unknown | null>
  isCampaignVersionActive(id: string, campaignCode: string, now: Date): Promise<boolean>
}

function authorityError(code: string, message: string, statusCode = 422): AppError {
  return new AppError(message, statusCode, true, code)
}

function parseRequest(input: unknown): CommercialQuoteRequestV1 & { acquisitionToken?: string } {
  const parsed = commercialQuoteRequestSchema.safeParse(input)
  if (!parsed.success) throw authorityError('COMMERCIAL_QUOTE_REQUEST_INVALID', 'La solicitud de cotización contiene campos inválidos.')
  return parsed.data
}

function parseCatalog(value: unknown): CommercialCatalogSnapshotV1 {
  try {
    assertCommercialContractV1(value)
    return value as CommercialCatalogSnapshotV1
  } catch {
    throw authorityError('COMMERCIAL_CATALOG_UNAVAILABLE', 'El catálogo comercial activo no es compatible.', 503)
  }
}

function parseCampaign(value: unknown): CommercialCampaignVersionV1 {
  const parsed = commercialCampaignVersionSchema.safeParse(value)
  if (!parsed.success) {
    throw authorityError('COMMERCIAL_CAMPAIGN_VERSION_UNAVAILABLE', 'La versión de campaña reclamada no está disponible.', 409)
  }
  return parsed.data
}

export function createCommercialQuoteAuthorityService(dependencies: CommercialQuoteAuthorityDependencies) {
  async function calculate(input: unknown): Promise<{
    quote: CommercialQuoteV1
    checksum: string
    acquisitionContextId: string | null
  }> {
    const request = parseRequest(input)
    const now = dependencies.now()
    const activeCatalog = await dependencies.loadActiveCatalog()
    if (!activeCatalog) throw authorityError('COMMERCIAL_CATALOG_UNAVAILABLE', 'No hay un catálogo comercial activo.', 503)
    const catalog = parseCatalog(activeCatalog.snapshot)
    if (catalog.publicationId !== activeCatalog.id) {
      throw authorityError('COMMERCIAL_CATALOG_UNAVAILABLE', 'El catálogo activo no coincide con su publicación.', 503)
    }
    const acquisition = request.acquisitionToken ? await dependencies.resolveAcquisition(request.acquisitionToken, now) : null
    const campaign = acquisition?.campaignVersionId
      ? parseCampaign(await dependencies.loadCampaignVersion(acquisition.campaignVersionId))
      : undefined
    if (campaign && campaign.campaignVersionId !== acquisition?.campaignVersionId) {
      throw authorityError('COMMERCIAL_CAMPAIGN_VERSION_UNAVAILABLE', 'La campaña no coincide con la atribución emitida.', 409)
    }
    if (campaign && !(await dependencies.isCampaignVersionActive(campaign.campaignVersionId, campaign.campaignCode, now))) {
      throw authorityError('COMMERCIAL_CAMPAIGN_SUPERSEDED', 'La campaña reclamada fue reemplazada; solicita una oferta vigente.', 409)
    }
    const quote = evaluateCommercialQuote({
      quoteId: dependencies.randomId(),
      catalog,
      campaign,
      request: { market: request.market, currency: request.currency, lines: request.lines },
      now,
      expiresAt: new Date(now.getTime() + dependencies.quoteTtlMs),
    })
    return {
      quote,
      checksum: hashCanonicalJsonV1('commercial-quote-v1', quote),
      acquisitionContextId: acquisition?.id ?? null,
    }
  }

  return {
    async previewQuote(input: unknown) {
      return calculate(input)
    },
  }
}

export const prismaCommercialQuoteAuthorityDependencies: CommercialQuoteAuthorityDependencies = {
  now: () => new Date(),
  randomId: () => randomUUID(),
  quoteTtlMs: 15 * 60 * 1000,
  async loadActiveCatalog() {
    const activation = await prisma.commercialPublicationActivation.findUnique({
      where: { environment: 'PRODUCTION' },
      include: { publication: true },
    })
    return activation ? { id: activation.publication.id, snapshot: activation.publication.snapshot } : null
  },
  resolveAcquisition: (token, now) => commercialAcquisitionContextService.resolve(token, now),
  async loadCampaignVersion(id) {
    return (await prisma.commercialCampaignVersion.findUnique({ where: { id }, select: { snapshot: true } }))?.snapshot ?? null
  },
  async isCampaignVersionActive(id, campaignCode) {
    return (
      (await prisma.commercialCampaignActivation.count({
        where: { environment: 'PRODUCTION', campaignCode, campaignVersionId: id },
      })) === 1
    )
  },
}

export const commercialQuoteAuthorityService = createCommercialQuoteAuthorityService(prismaCommercialQuoteAuthorityDependencies)
