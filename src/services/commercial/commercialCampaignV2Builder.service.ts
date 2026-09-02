import { ConflictError } from '@/errors/AppError'
import { commercialCampaignDraftInputSchema } from '@/schemas/commercialQuote.schema'
import type { CommercialCampaignDraftView } from '@/types/commercialQuote'

import { emitCommercialArtifactV2, type CampaignV2Result } from './commercialArtifactCodecRegistry.service'
import { normalizeCommercialCampaignDraftInputV2 } from './commercialCampaignDraftGraph.service'

export interface CommercialCampaignV2BuildContext {
  campaignVersionId: string
  publishedAt: Date
}

export function buildCommercialCampaignV2(draft: CommercialCampaignDraftView, context: CommercialCampaignV2BuildContext): CampaignV2Result {
  const parsed = commercialCampaignDraftInputSchema.safeParse({
    code: draft.code,
    name: draft.name,
    description: draft.description,
    startsAt: draft.startsAt,
    endsAt: draft.endsAt,
    stackingGroups: draft.stackingGroups,
    rules: draft.rules,
  })
  if (
    !parsed.success ||
    draft.offerSchemaVersion !== 2 ||
    draft.status !== 'ACTIVE' ||
    !Number.isInteger(draft.revision) ||
    draft.revision < 1 ||
    typeof context.campaignVersionId !== 'string' ||
    context.campaignVersionId.trim().length === 0 ||
    context.campaignVersionId.length > 128 ||
    !Number.isFinite(context.publishedAt.getTime())
  ) {
    throw new ConflictError('El borrador de campaña no es publicable.', 'COMMERCIAL_CAMPAIGN_DRAFT_INVALID', {
      issues: parsed.success ? [] : parsed.error.issues,
    })
  }

  const normalized = normalizeCommercialCampaignDraftInputV2(parsed.data)
  const domainValue = {
    schemaVersion: 2,
    contractVersion: '2.0.0',
    campaignVersionId: context.campaignVersionId,
    campaignCode: normalized.code,
    version: draft.revision,
    status: 'ACTIVE',
    publishedAt: context.publishedAt.toISOString(),
    startsAt: normalized.startsAt,
    endsAt: normalized.endsAt,
    stackingGroups: normalized.stackingGroups,
    rules: normalized.rules,
  }

  return emitCommercialArtifactV2({ kind: 'CAMPAIGN', schemaVersion: 2, domainValue })
}
