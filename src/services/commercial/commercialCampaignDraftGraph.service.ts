import { Prisma } from '@prisma/client'

import { ConflictError } from '@/errors/AppError'
import { commercialCampaignDraftInputSchema } from '@/schemas/commercialQuote.schema'
import type { CommercialCampaignDraftInput, CommercialCampaignDraftView, CommercialCampaignRuleV2 } from '@/types/commercialQuote'

import { assertCommercialMoneyLimitV2, formatCommercialMoneyV2 } from './commercialMoneyV2.service'
import { canonicalJsonV2 } from './commercialCanonicalJsonV2.service'
import { compareCommercialAsciiV2 } from './commercialContractV2Validation.shared'

export type CommercialCampaignDraftGraphConsistency = 'SNAPSHOT' | 'FOR_UPDATE'

interface CommercialCampaignDraftGraphOptions {
  consistency: CommercialCampaignDraftGraphConsistency
}

type JsonPhysicalKind = 'SQL_NULL' | 'array' | 'null' | 'object' | 'string' | 'number' | 'boolean'

interface CampaignDraftParentRow {
  id: string
  code: string
  name: string
  description: string | null
  revision: number
  offerSchemaVersion: number
  status: 'ACTIVE' | 'ARCHIVED'
  startsAt: Date
  endsAt: Date
  allowedRuleCodeGroups: Prisma.JsonValue | null
  allowedRuleCodeGroupsKind: JsonPhysicalKind
  stackingGroups: Prisma.JsonValue | null
  stackingGroupsKind: JsonPhysicalKind
  transactionIsolation: string
  createdAt: Date
  updatedAt: Date
}

export interface CampaignDraftRuleRow {
  code: string
  type: CommercialCampaignRuleV2['type']
  priority: number
  target: Prisma.JsonValue
  amountMinor: bigint | number | null
  percentBasisPoints: number | null
  cycles: number
}

function storageInvalid(): never {
  throw new ConflictError('El almacenamiento del borrador de campaña no es válido.', 'COMMERCIAL_CAMPAIGN_DRAFT_STORAGE_INVALID')
}

function schemaUnsupported(): never {
  throw new ConflictError(
    'El borrador pertenece a una versión de oferta que Campaign v2 no puede procesar.',
    'COMMERCIAL_CAMPAIGN_DRAFT_SCHEMA_UNSUPPORTED',
  )
}

function amountOutOfRange(): never {
  throw new ConflictError('El monto del borrador de campaña excede el máximo unitario.', 'COMMERCIAL_CAMPAIGN_DRAFT_AMOUNT_OUT_OF_RANGE')
}

function projectStoredAmount(amountMinor: bigint | number | null): string {
  if (typeof amountMinor !== 'bigint') storageInvalid()
  try {
    assertCommercialMoneyLimitV2('UNIT_AMOUNT', amountMinor)
    return formatCommercialMoneyV2(amountMinor)
  } catch (error) {
    if (error instanceof Error && error.message === 'COMMERCIAL_MONEY_V2_LIMIT_EXCEEDED') amountOutOfRange()
    if (error instanceof Error && error.message === 'COMMERCIAL_MONEY_V2_INVALID') storageInvalid()
    throw error
  }
}

export function projectStoredRule(row: CampaignDraftRuleRow): CommercialCampaignRuleV2 {
  const common = {
    code: row.code,
    priority: row.priority,
    target: row.target as CommercialCampaignRuleV2['target'],
    cycles: row.cycles,
  }
  if (row.type === 'PERCENT_OFF') {
    if (
      row.amountMinor !== null ||
      !Number.isInteger(row.percentBasisPoints) ||
      row.percentBasisPoints! < 1 ||
      row.percentBasisPoints! > 10_000
    ) {
      storageInvalid()
    }
    return { ...common, type: row.type, percentBasisPoints: row.percentBasisPoints! }
  }
  if (row.type === 'FREE_PERIOD') {
    if (row.amountMinor !== null || row.percentBasisPoints !== null) storageInvalid()
    return { ...common, type: row.type }
  }
  if (row.percentBasisPoints !== null) storageInvalid()
  return { ...common, type: row.type, amount: projectStoredAmount(row.amountMinor) }
}

export function assertValidProjectedDraft(input: CommercialCampaignDraftInput): CommercialCampaignDraftInput {
  const parsed = commercialCampaignDraftInputSchema.safeParse(input)
  if (!parsed.success) storageInvalid()
  const normalized = normalizeCommercialCampaignDraftInputV2(parsed.data)
  if (canonicalJsonV2(parsed.data) !== canonicalJsonV2(normalized)) storageInvalid()
  return parsed.data
}

export function normalizeCommercialCampaignDraftInputV2(input: CommercialCampaignDraftInput): CommercialCampaignDraftInput {
  const productKindRank = { PLAN: 0, POS: 1, MODULE: 2 } as const
  const rules = input.rules
    .map(rule => ({
      ...rule,
      target: {
        ...(rule.target.productCodes ? { productCodes: [...rule.target.productCodes].sort(compareCommercialAsciiV2) } : {}),
        ...(rule.target.productKinds
          ? { productKinds: [...rule.target.productKinds].sort((left, right) => productKindRank[left] - productKindRank[right]) }
          : {}),
        ...(rule.target.bundleCodes ? { bundleCodes: [...rule.target.bundleCodes].sort(compareCommercialAsciiV2) } : {}),
      },
    }))
    .sort((left, right) => compareCommercialAsciiV2(left.code, right.code))
  const stackingGroups = input.stackingGroups
    .map(group => ({ ...group, steps: [...group.steps].sort((left, right) => left.position - right.position) }))
    .sort((left, right) => compareCommercialAsciiV2(left.code, right.code))

  return { ...input, rules, stackingGroups }
}

export async function loadCommercialCampaignDraftGraph(
  tx: Prisma.TransactionClient,
  id: string,
  options: CommercialCampaignDraftGraphOptions,
): Promise<CommercialCampaignDraftView | null> {
  const lockClause = options.consistency === 'FOR_UPDATE' ? Prisma.sql`FOR UPDATE` : Prisma.empty
  const rows = await tx.$queryRaw<CampaignDraftParentRow[]>(Prisma.sql`
    SELECT
      draft."id",
      draft."code",
      draft."name",
      draft."description",
      draft."revision",
      draft."offerSchemaVersion",
      draft."status",
      draft."startsAt",
      draft."endsAt",
      draft."allowedRuleCodeGroups",
      CASE
        WHEN draft."allowedRuleCodeGroups" IS NULL THEN 'SQL_NULL'
        ELSE jsonb_typeof(draft."allowedRuleCodeGroups")
      END AS "allowedRuleCodeGroupsKind",
      draft."stackingGroups",
      CASE
        WHEN draft."stackingGroups" IS NULL THEN 'SQL_NULL'
        ELSE jsonb_typeof(draft."stackingGroups")
      END AS "stackingGroupsKind",
      current_setting('transaction_isolation') AS "transactionIsolation",
      draft."createdAt",
      draft."updatedAt"
    FROM "CommercialCampaignDraft" AS draft
    WHERE draft."id" = ${id}
    ${lockClause}
  `)
  const parent = rows[0]
  if (!parent) return null

  if (options.consistency === 'SNAPSHOT' && parent.transactionIsolation !== 'repeatable read') {
    throw new Error('COMMERCIAL_CAMPAIGN_DRAFT_TRANSACTION_ISOLATION_REQUIRED')
  }
  if (parent.offerSchemaVersion !== 2) schemaUnsupported()

  const isLegacy = parent.stackingGroupsKind === 'SQL_NULL' && parent.allowedRuleCodeGroupsKind === 'array'
  const isV2 = parent.stackingGroupsKind === 'array' && parent.allowedRuleCodeGroupsKind === 'SQL_NULL'
  if (!isLegacy && !isV2) storageInvalid()

  const storedRules = (await tx.commercialCampaignRuleDraft.findMany({
    where: { campaignDraftId: id },
    orderBy: { code: 'asc' },
  })) as unknown as CampaignDraftRuleRow[]
  const rules = storedRules.map(projectStoredRule)

  if (isLegacy) {
    const legacyAllowedRuleCodeGroups = parent.allowedRuleCodeGroups
    if (!Array.isArray(legacyAllowedRuleCodeGroups)) storageInvalid()
    const legacyProjection = assertValidProjectedDraft({
      code: parent.code,
      name: parent.name,
      description: parent.description,
      startsAt: parent.startsAt.toISOString(),
      endsAt: parent.endsAt.toISOString(),
      stackingGroups: [],
      rules,
    })
    throw new ConflictError(
      'El borrador de campaña debe actualizarse al contrato v2 antes de continuar.',
      'COMMERCIAL_CAMPAIGN_DRAFT_UPGRADE_REQUIRED',
      {
        upgradeSource: {
          sourceFormat: 'LEGACY_ALLOWED_RULE_CODE_GROUPS_V1',
          draftId: parent.id,
          revision: parent.revision,
          code: parent.code,
          name: parent.name,
          description: parent.description,
          status: parent.status,
          startsAt: parent.startsAt.toISOString(),
          endsAt: parent.endsAt.toISOString(),
          legacyAllowedRuleCodeGroups,
          rules: legacyProjection.rules,
        },
      },
    )
  }

  const draft = assertValidProjectedDraft({
    code: parent.code,
    name: parent.name,
    description: parent.description,
    startsAt: parent.startsAt.toISOString(),
    endsAt: parent.endsAt.toISOString(),
    stackingGroups: parent.stackingGroups as unknown as CommercialCampaignDraftInput['stackingGroups'],
    rules,
  })
  return {
    id: parent.id,
    ...draft,
    revision: parent.revision,
    offerSchemaVersion: 2,
    status: parent.status,
    createdAt: parent.createdAt,
    updatedAt: parent.updatedAt,
  }
}
