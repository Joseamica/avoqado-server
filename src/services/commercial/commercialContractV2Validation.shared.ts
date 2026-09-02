import Ajv, { type ErrorObject } from 'ajv'
import { assertCommercialMoneyLimitV2, parseCommercialMoneyV2 } from './commercialMoneyV2.service'
import { getCommercialCapabilityDefinition } from './commercialCapabilityRegistry'
import { loadCommercialContractControlledJsonV2, materializeCommercialContractV2Json } from './commercialContractV2Materialization.service'
import type { CommercialActivationRequirementV2, CommercialEntitlementOriginV2 } from '@/types/commercialV2'

export type CommercialContractArtifactKindV2 = 'CATALOG' | 'CAMPAIGN' | 'QUOTE' | 'ENTITLEMENTS' | 'LIFECYCLE'
type Validator = ((value: unknown) => boolean | PromiseLike<unknown>) & { errors?: ErrorObject[] | null }

const schemaPath = (name: string) => require.resolve(`../../contracts/commercial/${name}`)
const ajv = new Ajv({ allErrors: true, jsonPointers: true })
const validators: Record<CommercialContractArtifactKindV2, Validator> = {
  CATALOG: ajv.compile(loadCommercialContractControlledJsonV2(schemaPath('commercial-catalog-v2.schema.json'))),
  CAMPAIGN: ajv.compile(loadCommercialContractControlledJsonV2(schemaPath('commercial-campaign-v2.schema.json'))),
  QUOTE: ajv.compile(loadCommercialContractControlledJsonV2(schemaPath('commercial-quote-v2.schema.json'))),
  ENTITLEMENTS: ajv.compile(loadCommercialContractControlledJsonV2(schemaPath('commercial-entitlements-v2.schema.json'))),
  LIFECYCLE: ajv.compile(loadCommercialContractControlledJsonV2(schemaPath('commercial-lifecycle-v2.schema.json'))),
}

export class CommercialContractV2ValidationError extends Error {
  constructor(
    readonly code: string,
    readonly rule: string,
    readonly diagnostic?: ReadonlyArray<{ path: string; keyword: string; message: string }>,
  ) {
    super(`${code}:${rule}`)
    this.name = 'CommercialContractV2ValidationError'
  }
}

export function failCommercialContractV2(
  kind: CommercialContractArtifactKindV2,
  rule: string,
  diagnostic?: CommercialContractV2ValidationError['diagnostic'],
): never {
  const suffix = rule === 'SCHEMA_VERSION' ? 'SCHEMA_UNSUPPORTED' : rule === 'CONTRACT_VERSION' ? 'CONTRACT_UNSUPPORTED' : 'SHAPE_INVALID'
  throw new CommercialContractV2ValidationError(`COMMERCIAL_${kind}_${suffix}`, rule, diagnostic)
}

export function withCommercialContractV2Boundary<T>(kind: CommercialContractArtifactKindV2, operation: () => T): T {
  try {
    return operation()
  } catch (error) {
    if (error instanceof CommercialContractV2ValidationError) throw error
    return failCommercialContractV2(kind, 'BOUNDARY')
  }
}

export function assertCommercialContractVersionsV2(kind: CommercialContractArtifactKindV2, value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return failCommercialContractV2(kind, 'SCHEMA')
  const candidate = value as { schemaVersion?: unknown; contractVersion?: unknown }
  if (candidate.schemaVersion !== undefined && candidate.schemaVersion !== 2) failCommercialContractV2(kind, 'SCHEMA_VERSION')
  if (candidate.contractVersion !== undefined && candidate.contractVersion !== '2.0.0') {
    failCommercialContractV2(kind, 'CONTRACT_VERSION')
  }
}

export function assertCommercialContractSchemaV2(kind: CommercialContractArtifactKindV2, value: unknown): void {
  const validator = validators[kind]
  if (validator(value)) return
  const diagnostic = (validator.errors ?? []).map(issue => ({
    path: issue.dataPath || '/',
    keyword: issue.keyword,
    message: issue.message ?? 'Valor inválido',
  }))
  failCommercialContractV2(kind, 'SCHEMA', diagnostic)
}

export function validateCommercialArtifactV2<T>(
  kind: CommercialContractArtifactKindV2,
  value: unknown,
  validateSemantics?: (artifact: T) => void,
): T {
  return withCommercialContractV2Boundary(kind, () => {
    const artifact = materializeCommercialContractV2Json<T>(value)
    assertCommercialContractVersionsV2(kind, artifact)
    assertCommercialContractSchemaV2(kind, artifact)
    validateSemantics?.(artifact)
    return artifact
  })
}

export function compareCommercialAsciiV2(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function assertCommercialUniqueV2(kind: CommercialContractArtifactKindV2, values: string[], rule: string): void {
  if (new Set(values).size !== values.length) failCommercialContractV2(kind, rule)
}

export function assertCommercialUniqueByV2<T>(
  kind: CommercialContractArtifactKindV2,
  values: T[],
  key: (value: T) => string,
  rule: string,
): void {
  assertCommercialUniqueV2(
    kind,
    values.map(value => key(value)),
    rule,
  )
}

export function assertCommercialOrderedV2<T>(
  kind: CommercialContractArtifactKindV2,
  values: T[],
  compare: (left: T, right: T) => number,
  rule: string,
): void {
  for (let index = 1; index < values.length; index += 1) {
    if (compare(values[index - 1], values[index]) > 0) failCommercialContractV2(kind, rule)
  }
}

export function assertCommercialAsciiCodesV2<T>(
  kind: CommercialContractArtifactKindV2,
  values: T[],
  code: (value: T) => string,
  uniqueRule: string,
  orderRule: string,
): void {
  assertCommercialUniqueByV2(kind, values, code, uniqueRule)
  assertCommercialOrderedV2(kind, values, (left, right) => compareCommercialAsciiV2(code(left), code(right)), orderRule)
}

export function commercialActivationMatchesV2(left: CommercialActivationRequirementV2, right: CommercialActivationRequirementV2): boolean {
  if (left.mode !== right.mode) return false
  if (left.mode === 'NOT_REQUIRED' && right.mode === 'NOT_REQUIRED') return true
  return (
    left.mode === 'VENUE_SETTING' &&
    right.mode === 'VENUE_SETTING' &&
    left.settingKey === right.settingKey &&
    left.defaultState === right.defaultState
  )
}

export function assertCommercialCapabilityV2(
  kind: CommercialContractArtifactKindV2,
  value: { capabilityCode: string; capabilityKind: string; activationRequirement: CommercialActivationRequirementV2 },
): void {
  const definition = getCommercialCapabilityDefinition(value.capabilityCode)
  if (!definition) failCommercialContractV2(kind, 'CAPABILITY_UNKNOWN')
  if (definition.capabilityKind !== value.capabilityKind) failCommercialContractV2(kind, 'CAPABILITY_KIND_MISMATCH')
  if (!commercialActivationMatchesV2(definition.activationRequirement, value.activationRequirement)) {
    failCommercialContractV2(kind, 'CAPABILITY_ACTIVATION_MISMATCH')
  }
}

export function parseCommercialContractMoneyV2(
  kind: CommercialContractArtifactKindV2,
  value: string,
  limit?: Parameters<typeof assertCommercialMoneyLimitV2>[0],
): bigint {
  try {
    const parsed = parseCommercialMoneyV2(value)
    return limit ? assertCommercialMoneyLimitV2(limit, parsed) : parsed
  } catch {
    return failCommercialContractV2(kind, 'MONEY')
  }
}

const ORIGIN_RANK: Record<CommercialEntitlementOriginV2['kind'], number> = {
  FREE: 0,
  PRODUCT: 1,
  BUNDLE: 2,
  BUNDLE_COMPONENT: 3,
  CAMPAIGN: 4,
  TRIAL: 5,
  GRANDFATHERED: 6,
  CONTRACT: 7,
  MANUAL: 8,
}

function originTuple(origin: CommercialEntitlementOriginV2): string[] {
  const value = origin as CommercialEntitlementOriginV2 & {
    sourceCode?: string
    sourceId?: string
    parentSourceCode?: string
    lineKey?: string
  }
  return [value.sourceCode ?? '', value.sourceId ?? '', value.parentSourceCode ?? '', value.lineKey ?? '']
}

export function compareCommercialOriginsV2(left: CommercialEntitlementOriginV2, right: CommercialEntitlementOriginV2): number {
  const rank = ORIGIN_RANK[left.kind] - ORIGIN_RANK[right.kind]
  if (rank !== 0) return rank
  const leftTuple = originTuple(left)
  const rightTuple = originTuple(right)
  for (let index = 0; index < leftTuple.length; index += 1) {
    const compared = compareCommercialAsciiV2(leftTuple[index], rightTuple[index])
    if (compared !== 0) return compared
  }
  return 0
}

export function validateCommercialOriginsV2(kind: 'QUOTE' | 'ENTITLEMENTS', origins: CommercialEntitlementOriginV2[]): void {
  const keys = origins.map(origin => `${origin.kind}\u0000${originTuple(origin).join('\u0000')}`)
  assertCommercialUniqueV2(kind, keys, 'ORIGIN_UNIQUE')
  assertCommercialOrderedV2(kind, origins, compareCommercialOriginsV2, 'ORIGIN_ORDER')
  if (origins.every(origin => origin.kind === 'CAMPAIGN')) failCommercialContractV2(kind, 'CAMPAIGN_ONLY_GRANT')
}
