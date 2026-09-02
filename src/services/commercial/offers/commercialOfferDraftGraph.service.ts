import { Prisma } from '@prisma/client'

import { ConflictError } from '@/errors/AppError'
import {
  assertValidProjectedDraft,
  projectStoredRule,
  type CampaignDraftRuleRow,
  type CommercialCampaignDraftGraphConsistency,
} from '@/services/commercial/commercialCampaignDraftGraph.service'
import type { CommercialOfferBenefitDraftInputV3, CommercialOfferDraftViewV3 } from '@/types/commercialOfferV3'

import { parseCommercialOfferDraftBenefitsV3 } from './commercialOfferDraft.service'
import { createHardwareSkuSnapshotV3 } from './hardwareSkuSnapshot.service'

type JsonPhysicalKind = 'SQL_NULL' | 'array' | 'null' | 'object' | 'string' | 'number' | 'boolean'

interface CommercialOfferDraftParentRow {
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

interface CommercialOfferBenefitDraftRow {
  benefitCode: string
  kind: 'HARDWARE_PERCENT_OFF' | 'HARDWARE_FIXED_PRICE' | 'PAYMENTS_RATE_SCHEDULE'
  priority: number
  hardwareCatalogKey: string | null
  percentBasisPoints: number | null
  unitAmountMinor: bigint | number | null
  quantityLimit: number | null
  benefitStartsAt: Date | null
  benefitEndsAt: Date | null
  paymentsRateScheduleVersionId: string | null
}

interface CommercialOfferDraftGraphOptions {
  consistency: CommercialCampaignDraftGraphConsistency
}

function storageInvalid(): never {
  throw new ConflictError('El almacenamiento del borrador de oferta v3 no es válido.', 'COMMERCIAL_OFFER_DRAFT_STORAGE_INVALID')
}

function schemaUnsupported(): never {
  throw new ConflictError(
    'El borrador no pertenece al contrato de oferta v3.',
    'COMMERCIAL_OFFER_DRAFT_SCHEMA_UNSUPPORTED',
  )
}

function iso(value: Date | null): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) storageInvalid()
  return value.toISOString()
}

function exactMinor(value: bigint | number | null): string {
  if (typeof value !== 'bigint' || value < 0n || value > 999_999_999_999n) storageInvalid()
  return value.toString()
}

function assertHardwareKey(value: string | null): string {
  if (typeof value !== 'string') storageInvalid()
  try {
    createHardwareSkuSnapshotV3(value)
  } catch {
    storageInvalid()
  }
  return value
}

function projectBenefit(row: CommercialOfferBenefitDraftRow): CommercialOfferBenefitDraftInputV3 {
  const common = { benefitCode: row.benefitCode, priority: row.priority }
  if (row.kind === 'HARDWARE_PERCENT_OFF') {
    if (
      row.unitAmountMinor !== null ||
      row.paymentsRateScheduleVersionId !== null ||
      !Number.isInteger(row.percentBasisPoints) ||
      !Number.isInteger(row.quantityLimit)
    ) {
      storageInvalid()
    }
    return {
      ...common,
      kind: row.kind,
      hardwareCatalogKey: assertHardwareKey(row.hardwareCatalogKey),
      percentBasisPoints: row.percentBasisPoints!,
      quantityLimit: row.quantityLimit!,
      benefitStartsAt: iso(row.benefitStartsAt),
      benefitEndsAt: iso(row.benefitEndsAt),
    }
  }
  if (row.kind === 'HARDWARE_FIXED_PRICE') {
    if (
      row.percentBasisPoints !== null ||
      row.paymentsRateScheduleVersionId !== null ||
      !Number.isInteger(row.quantityLimit)
    ) {
      storageInvalid()
    }
    return {
      ...common,
      kind: row.kind,
      hardwareCatalogKey: assertHardwareKey(row.hardwareCatalogKey),
      unitAmountMinor: exactMinor(row.unitAmountMinor),
      quantityLimit: row.quantityLimit!,
      benefitStartsAt: iso(row.benefitStartsAt),
      benefitEndsAt: iso(row.benefitEndsAt),
    }
  }
  if (row.kind === 'PAYMENTS_RATE_SCHEDULE') {
    if (
      row.hardwareCatalogKey !== null ||
      row.percentBasisPoints !== null ||
      row.unitAmountMinor !== null ||
      row.quantityLimit !== null ||
      row.benefitStartsAt !== null ||
      row.benefitEndsAt !== null ||
      typeof row.paymentsRateScheduleVersionId !== 'string'
    ) {
      storageInvalid()
    }
    return {
      ...common,
      kind: row.kind,
      paymentsRateScheduleVersionId: row.paymentsRateScheduleVersionId,
    }
  }
  storageInvalid()
}

function projectBenefits(rows: CommercialOfferBenefitDraftRow[]): CommercialOfferBenefitDraftInputV3[] {
  try {
    return parseCommercialOfferDraftBenefitsV3(rows.map(projectBenefit))
  } catch (error) {
    if (error instanceof ConflictError && error.code === 'COMMERCIAL_OFFER_DRAFT_STORAGE_INVALID') throw error
    storageInvalid()
  }
}

export async function loadCommercialOfferDraftGraphV3(
  tx: Prisma.TransactionClient,
  id: string,
  options: CommercialOfferDraftGraphOptions,
): Promise<CommercialOfferDraftViewV3 | null> {
  const lockClause = options.consistency === 'FOR_UPDATE' ? Prisma.sql`FOR UPDATE` : Prisma.empty
  const rows = await tx.$queryRaw<CommercialOfferDraftParentRow[]>(Prisma.sql`
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
    throw new Error('COMMERCIAL_OFFER_DRAFT_TRANSACTION_ISOLATION_REQUIRED')
  }
  if (parent.offerSchemaVersion !== 3) schemaUnsupported()
  if (parent.stackingGroupsKind !== 'array' || parent.allowedRuleCodeGroupsKind !== 'SQL_NULL') storageInvalid()

  const storedRules = (await tx.commercialCampaignRuleDraft.findMany({
    where: { campaignDraftId: id },
    orderBy: { code: 'asc' },
  })) as unknown as CampaignDraftRuleRow[]
  const rules = storedRules.map(projectStoredRule)
  const campaign = assertValidProjectedDraft({
    code: parent.code,
    name: parent.name,
    description: parent.description,
    startsAt: iso(parent.startsAt),
    endsAt: iso(parent.endsAt),
    stackingGroups: parent.stackingGroups as never,
    rules,
  })

  const storedBenefits = (await tx.commercialOfferBenefitDraft.findMany({
    where: { campaignDraftId: id },
    orderBy: { benefitCode: 'asc' },
  })) as unknown as CommercialOfferBenefitDraftRow[]

  return {
    id: parent.id,
    ...campaign,
    revision: parent.revision,
    offerSchemaVersion: 3,
    status: parent.status,
    offerBenefits: projectBenefits(storedBenefits),
    createdAt: parent.createdAt,
    updatedAt: parent.updatedAt,
  }
}
