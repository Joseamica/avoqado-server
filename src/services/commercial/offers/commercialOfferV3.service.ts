import { createHash } from 'node:crypto'
import Ajv, { type ErrorObject } from 'ajv'

import { canonicalJsonBytesV2 } from '@/services/commercial/commercialCanonicalJsonV2.service'
import {
  loadCommercialContractControlledJsonV2,
  materializeCommercialContractV2Json,
} from '@/services/commercial/commercialContractV2Materialization.service'
import { CommercialContractV2ValidationError, validateCommercialCampaignV2 } from '@/services/commercial/commercialContractV2.service'
import type {
  CommercialBenefitV3,
  CommercialHardwareBenefitV3,
  CommercialOfferSnapshotV3,
  CommercialOfferV3DecodeInput,
  EmittedCommercialOfferV3,
  VerifiedStoredCommercialOfferV3,
} from '@/types/commercialOfferV3'

const COMMERCIAL_OFFER_V3_HASH_DOMAIN = 'avoqado.commercial.offer-snapshot@3\0'
const schema = loadCommercialContractControlledJsonV2(require.resolve('../../../contracts/commercial/commercial-offer-v3.schema.json'))
const validator = new Ajv({ allErrors: true, jsonPointers: true }).compile(schema as object)

export class CommercialOfferV3Error extends Error {
  constructor(
    readonly code: 'COMMERCIAL_OFFER_V3_INVALID' | 'COMMERCIAL_OFFER_V3_CHECKSUM_MISMATCH' | 'COMMERCIAL_OFFER_V3_IDENTITY_MISMATCH',
    readonly rule: string,
    readonly diagnostic?: ReadonlyArray<{ path: string; keyword: string; message: string }>,
  ) {
    super(`${code}:${rule}`)
    this.name = 'CommercialOfferV3Error'
  }
}

function invalid(rule: string, diagnostic?: ReadonlyArray<{ path: string; keyword: string; message: string }>): never {
  throw new CommercialOfferV3Error('COMMERCIAL_OFFER_V3_INVALID', rule, diagnostic)
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function assertValidTimestampWindow(startsAt: string, endsAt: string, rule: string): void {
  const start = Date.parse(startsAt)
  const end = Date.parse(endsAt)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) invalid(rule)
}

function hardwareBenefits(value: CommercialOfferSnapshotV3): CommercialHardwareBenefitV3[] {
  return value.benefits.filter(
    (benefit): benefit is CommercialHardwareBenefitV3 => benefit.kind === 'HARDWARE_PERCENT_OFF' || benefit.kind === 'HARDWARE_FIXED_PRICE',
  )
}

function validateSaasBenefit(value: CommercialOfferSnapshotV3, benefit: Extract<CommercialBenefitV3, { kind: 'SAAS_PRICE' }>): void {
  try {
    validateCommercialCampaignV2({
      schemaVersion: 2,
      contractVersion: '2.0.0',
      campaignVersionId: value.campaignVersionId,
      campaignCode: value.campaignCode,
      version: value.version,
      status: value.status,
      publishedAt: value.publishedAt,
      startsAt: value.claimStartsAt,
      endsAt: value.claimEndsAt,
      stackingGroups: benefit.stackingGroups,
      rules: benefit.rules,
    })
  } catch (error) {
    if (error instanceof CommercialContractV2ValidationError) {
      invalid(`SAAS_PRICE_${error.rule}`, error.diagnostic)
    }
    invalid('SAAS_PRICE_RULES')
  }
}

function validateSemantics(value: CommercialOfferSnapshotV3): void {
  assertValidTimestampWindow(value.claimStartsAt, value.claimEndsAt, 'CLAIM_WINDOW')

  const codes = value.benefits.map(benefit => benefit.benefitCode)
  if (new Set(codes).size !== codes.length) invalid('BENEFIT_CODE_UNIQUE')
  for (let index = 1; index < codes.length; index += 1) {
    if (compareAscii(codes[index - 1], codes[index]) > 0) invalid('BENEFIT_ORDER')
  }

  const saasRuleCodes = new Set<string>()
  const saasStackingGroupCodes = new Set<string>()
  for (const benefit of value.benefits) {
    if (benefit.kind === 'SAAS_PRICE') {
      validateSaasBenefit(value, benefit)
      for (const rule of benefit.rules) {
        if (saasRuleCodes.has(rule.code)) invalid('SAAS_RULE_CODE_UNIQUE')
        saasRuleCodes.add(rule.code)
      }
      for (const group of benefit.stackingGroups) {
        if (saasStackingGroupCodes.has(group.code)) invalid('SAAS_STACKING_GROUP_CODE_UNIQUE')
        saasStackingGroupCodes.add(group.code)
      }
    }
    if (benefit.kind === 'HARDWARE_PERCENT_OFF' || benefit.kind === 'HARDWARE_FIXED_PRICE') {
      assertValidTimestampWindow(benefit.benefitStartsAt, benefit.benefitEndsAt, 'HARDWARE_BENEFIT_WINDOW')
    }
    if (benefit.kind === 'HARDWARE_FIXED_PRICE' && BigInt(benefit.unitAmountMinor) > BigInt(benefit.skuSnapshot.listUnitAmountMinor)) {
      invalid('HARDWARE_FIXED_PRICE_ABOVE_LIST')
    }
    if (
      benefit.kind === 'PAYMENTS_RATE_SCHEDULE' &&
      !/^payments-rate-schedule-version-[A-Za-z0-9][A-Za-z0-9._:-]{0,95}-v[1-9][0-9]{0,8}$/.test(benefit.paymentsRateScheduleVersionId)
    ) {
      invalid('RATE_SCHEDULE_VERSION_REFERENCE')
    }
  }

  const bySku = new Map<string, CommercialHardwareBenefitV3[]>()
  const skuSnapshotBytes = new Map<string, Buffer>()
  for (const benefit of hardwareBenefits(value)) {
    const catalogKey = benefit.skuSnapshot.catalogKey
    const snapshotBytes = canonicalJsonBytesV2(benefit.skuSnapshot)
    const expectedSnapshotBytes = skuSnapshotBytes.get(catalogKey)
    if (expectedSnapshotBytes && Buffer.compare(expectedSnapshotBytes, snapshotBytes) !== 0) {
      invalid('HARDWARE_SKU_SNAPSHOT_MISMATCH')
    }
    skuSnapshotBytes.set(catalogKey, snapshotBytes)

    const values = bySku.get(catalogKey) ?? []
    values.push(benefit)
    bySku.set(catalogKey, values)
  }
  for (const benefits of bySku.values()) {
    const ordered = [...benefits].sort(
      (left, right) =>
        Date.parse(left.benefitStartsAt) - Date.parse(right.benefitStartsAt) || compareAscii(left.benefitCode, right.benefitCode),
    )
    for (let index = 1; index < ordered.length; index += 1) {
      if (Date.parse(ordered[index].benefitStartsAt) < Date.parse(ordered[index - 1].benefitEndsAt)) {
        invalid('HARDWARE_WINDOW_OVERLAP')
      }
    }
  }
}

export function validateCommercialOfferV3(input: unknown): CommercialOfferSnapshotV3 {
  let value: CommercialOfferSnapshotV3
  try {
    value = materializeCommercialContractV2Json<CommercialOfferSnapshotV3>(input)
  } catch {
    return invalid('MATERIALIZATION')
  }
  if (!validator(value)) {
    const diagnostic = (validator.errors ?? []).map((issue: ErrorObject) => ({
      path: issue.dataPath || '/',
      keyword: issue.keyword,
      message: issue.message ?? 'Valor inválido',
    }))
    const rateReferenceIssue = diagnostic.some(
      issue => issue.path.endsWith('/paymentsRateScheduleVersionId') || issue.path.endsWith('.paymentsRateScheduleVersionId'),
    )
    return invalid(rateReferenceIssue ? 'RATE_SCHEDULE_VERSION_REFERENCE' : 'SCHEMA', diagnostic)
  }
  validateSemantics(value)
  return value
}

function checksumCommercialOfferV3(snapshot: CommercialOfferSnapshotV3): string {
  return createHash('sha256')
    .update(Buffer.concat([Buffer.from(COMMERCIAL_OFFER_V3_HASH_DOMAIN, 'ascii'), canonicalJsonBytesV2(snapshot)]))
    .digest('hex')
}

export function emitCommercialOfferV3(input: unknown): EmittedCommercialOfferV3 {
  const snapshot = validateCommercialOfferV3(input)
  return Object.freeze({
    kind: 'COMMERCIAL_OFFER' as const,
    schemaVersion: 3 as const,
    mode: 'READ_WRITE' as const,
    snapshot,
    checksum: checksumCommercialOfferV3(snapshot),
  })
}

function publishedAtIso(value: Date): string | null {
  try {
    const time = Date.prototype.getTime.call(value)
    return Number.isFinite(time) ? Date.prototype.toISOString.call(value) : null
  } catch {
    return null
  }
}

export function decodeAndVerifyStoredCommercialOfferV3(input: CommercialOfferV3DecodeInput): VerifiedStoredCommercialOfferV3 {
  if (input.rowSchemaVersion !== 3 || input.rowContext.schemaVersion !== 3) {
    invalid('SCHEMA_VERSION')
  }
  const snapshot = validateCommercialOfferV3(input.snapshot)
  const checksum = checksumCommercialOfferV3(snapshot)
  if (typeof input.checksum !== 'string' || input.checksum !== checksum) {
    throw new CommercialOfferV3Error('COMMERCIAL_OFFER_V3_CHECKSUM_MISMATCH', 'CHECKSUM')
  }
  if (
    input.rowContext.id !== snapshot.campaignVersionId ||
    input.rowContext.campaignCode !== snapshot.campaignCode ||
    input.rowContext.sourceRevision !== snapshot.version ||
    publishedAtIso(input.rowContext.publishedAt) !== snapshot.publishedAt
  ) {
    throw new CommercialOfferV3Error('COMMERCIAL_OFFER_V3_IDENTITY_MISMATCH', 'ROW_CONTEXT')
  }
  return Object.freeze({
    kind: 'COMMERCIAL_OFFER' as const,
    schemaVersion: 3 as const,
    mode: 'READ_WRITE' as const,
    snapshot,
    checksum,
    verified: true as const,
  })
}
