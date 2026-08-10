import AppError from '../../errors/AppError'
import { createCatalogImportCooperativeCheckpoint, type CatalogImportCooperativeCheckpoint } from './catalogImportCanonical.service'
import type { CatalogImportStagedPayloadV1 } from './catalogImportStagedPayload.service'

// WHY: The version makes future bulk primitives additive; a recalibrated cost
// model cannot silently reinterpret an already-staged V1 preview.
export const CATALOG_IMPORT_CONFIRM_COST_MODEL_VERSION = 1 as const
export const CATALOG_IMPORT_CONFIRM_WORK_UNIT_LIMIT = 12_000 as const
export const CATALOG_IMPORT_CONFIRM_OVERFLOW_SENTINEL = 12_001 as const

// WHY: LOWER_BOUND records an intentional early stop at limit+1. It is valid
// only for FAILED previews and never pretends an attacker-sized scan was exact.
export interface CatalogImportConfirmCapacityV1 {
  schemaVersion: 1
  costModelVersion: 1
  measurement: 'EXACT' | 'LOWER_BOUND'
  workUnits: number
  limit: 12_000
  withinLimit: boolean
  breakdown: {
    base: 32
    referenceProposals: number
    createItems: number
    updateItems: number
    retireItems: number
    organizationValues: number
    deactivations: number
  }
}

export type CatalogImportCapacityMeasurementV1 = CatalogImportConfirmCapacityV1['measurement']

type ReferenceProposal = CatalogImportStagedPayloadV1['referenceProposals'][number]
type MainBreakdownKey = 'referenceProposals' | 'createItems' | 'updateItems' | 'retireItems'

interface MutableCapacity {
  workUnits: number
  breakdown: CatalogImportConfirmCapacityV1['breakdown']
  proposalMarkers: Set<string>
}

function createAccumulator(): MutableCapacity {
  return {
    workUnits: 32,
    breakdown: { base: 32, referenceProposals: 0, createItems: 0, updateItems: 0, retireItems: 0, organizationValues: 0, deactivations: 0 },
    proposalMarkers: new Set(),
  }
}

function addBounded(accumulator: MutableCapacity, key: MainBreakdownKey, requested: number): number {
  const applied = Math.min(requested, CATALOG_IMPORT_CONFIRM_OVERFLOW_SENTINEL - accumulator.workUnits)
  accumulator.breakdown[key] += applied
  accumulator.workUnits += applied
  return applied
}

function proposalCostV1(proposal: ReferenceProposal): number {
  // WHY: Child FAMILY creation has one additional dependency/lock compared
  // with root/reference-table inserts; all other proposal kinds cost three.
  return proposal.referenceType === 'FAMILY' && proposal.parentId !== null && proposal.parentId !== undefined ? 4 : 3
}

function addProposal(accumulator: MutableCapacity, proposal: ReferenceProposal): void {
  // WHY: JS computed and confirmation-reverified capacityMarker is the Unicode
  // identity authority. PostgreSQL and this scan never approximate NFKC rules.
  const marker = proposal.capacityMarker
  if (typeof marker !== 'string' || marker.length === 0) {
    throw new AppError('La propuesta staged no conserva su identidad de capacidad.', 409, true, 'CATALOG_IMPORT_STAGING_INVALID')
  }
  if (accumulator.proposalMarkers.has(marker)) return
  accumulator.proposalMarkers.add(marker)
  addBounded(accumulator, 'referenceProposals', proposalCostV1(proposal))
}

function addPayload(accumulator: MutableCapacity, payload: CatalogImportStagedPayloadV1): void {
  if (payload.command.operation === 'CREATE') {
    addBounded(accumulator, 'createItems', 10)
    return
  }
  if (payload.command.operation === 'RETIRE') {
    addBounded(accumulator, 'retireItems', 6)
    return
  }
  addBounded(accumulator, 'updateItems', 12)
  const valueUnits = addBounded(accumulator, 'updateItems', payload.command.input.organizationValues.length)
  accumulator.breakdown.organizationValues += valueUnits
  const deactivationUnits = addBounded(accumulator, 'updateItems', payload.command.input.organizationValueDeactivations.length)
  accumulator.breakdown.deactivations += deactivationUnits
}

function finishCapacity(accumulator: MutableCapacity): CatalogImportConfirmCapacityV1 {
  const overflowed = accumulator.workUnits >= CATALOG_IMPORT_CONFIRM_OVERFLOW_SENTINEL
  return {
    schemaVersion: 1,
    costModelVersion: CATALOG_IMPORT_CONFIRM_COST_MODEL_VERSION,
    measurement: overflowed ? 'LOWER_BOUND' : 'EXACT',
    workUnits: accumulator.workUnits,
    limit: CATALOG_IMPORT_CONFIRM_WORK_UNIT_LIMIT,
    withinLimit: !overflowed,
    breakdown: accumulator.breakdown,
  }
}

function invalidCapacity(): never {
  throw new AppError('La capacidad durable del import no es válida.', 409, true, 'CATALOG_IMPORT_CAPACITY_INVALID')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function capacityInteger(value: unknown, sqlScalar = false): number {
  const normalized = sqlScalar && typeof value === 'string' && /^(0|[1-9][0-9]{0,8})$/u.test(value) ? Number(value) : value
  if (
    !Number.isSafeInteger(normalized) ||
    (normalized as number) < 0 ||
    (normalized as number) > CATALOG_IMPORT_CONFIRM_OVERFLOW_SENTINEL
  ) {
    return invalidCapacity()
  }
  return normalized as number
}

function parseCapacity(
  value: unknown,
  allowedMeasurements: readonly CatalogImportCapacityMeasurementV1[],
  sqlScalars: boolean,
): CatalogImportConfirmCapacityV1 {
  const capacityKeys = ['schemaVersion', 'costModelVersion', 'measurement', 'workUnits', 'limit', 'withinLimit', 'breakdown']
  const breakdownKeys = ['base', 'referenceProposals', 'createItems', 'updateItems', 'retireItems', 'organizationValues', 'deactivations']
  if (
    !isRecord(value) ||
    !hasExactKeys(value, capacityKeys) ||
    !isRecord(value.breakdown) ||
    !hasExactKeys(value.breakdown, breakdownKeys)
  ) {
    return invalidCapacity()
  }
  const withinLimit =
    sqlScalars && value.withinLimit === 'true' ? true : sqlScalars && value.withinLimit === 'false' ? false : value.withinLimit
  const parsed = {
    schemaVersion: capacityInteger(value.schemaVersion, sqlScalars),
    costModelVersion: capacityInteger(value.costModelVersion, sqlScalars),
    measurement: value.measurement,
    workUnits: capacityInteger(value.workUnits, sqlScalars),
    limit: capacityInteger(value.limit, sqlScalars),
    withinLimit,
    breakdown: {
      base: capacityInteger(value.breakdown.base, sqlScalars),
      referenceProposals: capacityInteger(value.breakdown.referenceProposals, sqlScalars),
      createItems: capacityInteger(value.breakdown.createItems, sqlScalars),
      updateItems: capacityInteger(value.breakdown.updateItems, sqlScalars),
      retireItems: capacityInteger(value.breakdown.retireItems, sqlScalars),
      organizationValues: capacityInteger(value.breakdown.organizationValues, sqlScalars),
      deactivations: capacityInteger(value.breakdown.deactivations, sqlScalars),
    },
  }
  const expectedWork =
    parsed.breakdown.base +
    parsed.breakdown.referenceProposals +
    parsed.breakdown.createItems +
    parsed.breakdown.updateItems +
    parsed.breakdown.retireItems
  const measurement = parsed.measurement as CatalogImportCapacityMeasurementV1
  if (
    parsed.schemaVersion !== 1 ||
    parsed.costModelVersion !== CATALOG_IMPORT_CONFIRM_COST_MODEL_VERSION ||
    (measurement !== 'EXACT' && measurement !== 'LOWER_BOUND') ||
    !allowedMeasurements.includes(measurement) ||
    parsed.limit !== CATALOG_IMPORT_CONFIRM_WORK_UNIT_LIMIT ||
    typeof parsed.withinLimit !== 'boolean' ||
    parsed.breakdown.base !== 32 ||
    parsed.workUnits !== expectedWork ||
    (measurement === 'EXACT' && parsed.withinLimit !== parsed.workUnits <= CATALOG_IMPORT_CONFIRM_WORK_UNIT_LIMIT) ||
    (measurement === 'LOWER_BOUND' && (parsed.workUnits !== CATALOG_IMPORT_CONFIRM_OVERFLOW_SENTINEL || parsed.withinLimit !== false)) ||
    parsed.breakdown.organizationValues + parsed.breakdown.deactivations > parsed.breakdown.updateItems
  ) {
    return invalidCapacity()
  }
  return parsed as CatalogImportConfirmCapacityV1
}

export function parseCatalogImportConfirmCapacityV1(
  value: unknown,
  allowedMeasurements: readonly CatalogImportCapacityMeasurementV1[] = ['EXACT', 'LOWER_BOUND'],
): CatalogImportConfirmCapacityV1 {
  // WHY: Dependencies are canonical JSON authority. Numbers and booleans must
  // retain their JSON types through preview, hash, replay, and confirmation.
  return parseCapacity(value, allowedMeasurements, false)
}

export function parseCatalogImportConfirmCapacitySqlRowV1(
  value: unknown,
  allowedMeasurements: readonly CatalogImportCapacityMeasurementV1[] = ['EXACT', 'LOWER_BOUND'],
): CatalogImportConfirmCapacityV1 {
  // WHY: PostgreSQL bigint/text scalar projections are the one intentional
  // coercion seam; keeping it named prevents reuse by durable mutation paths.
  return parseCapacity(value, allowedMeasurements, true)
}

export function markCatalogImportConfirmDeactivationOverflowV1(bestEffort: CatalogImportConfirmCapacityV1): CatalogImportConfirmCapacityV1 {
  const exact = parseCatalogImportConfirmCapacityV1(bestEffort, ['EXACT'])
  const overflowUnits = Math.max(0, CATALOG_IMPORT_CONFIRM_OVERFLOW_SENTINEL - exact.workUnits)
  // WHY: Active-price hydration reports only that omitted rules exceeded its
  // safe bound. Attribute the unknown remainder to UPDATE tombstones without
  // fabricating an exact count, while preserving the V1 arithmetic invariant.
  return {
    ...exact,
    measurement: 'LOWER_BOUND',
    workUnits: CATALOG_IMPORT_CONFIRM_OVERFLOW_SENTINEL,
    withinLimit: false,
    breakdown: {
      ...exact.breakdown,
      updateItems: exact.breakdown.updateItems + overflowUnits,
      deactivations: exact.breakdown.deactivations + overflowUnits,
    },
  }
}

function scanPayload(accumulator: MutableCapacity, payload: CatalogImportStagedPayloadV1): boolean {
  for (const proposal of payload.referenceProposals) {
    addProposal(accumulator, proposal)
    if (accumulator.workUnits >= CATALOG_IMPORT_CONFIRM_OVERFLOW_SENTINEL) return false
  }
  addPayload(accumulator, payload)
  return accumulator.workUnits < CATALOG_IMPORT_CONFIRM_OVERFLOW_SENTINEL
}

export function calculateCatalogImportConfirmCapacityV1(payloads: readonly CatalogImportStagedPayloadV1[]): CatalogImportConfirmCapacityV1 {
  const accumulator = createAccumulator()
  // WHY: Work stops at the first proven-over-limit unit; both memory and CPU
  // remain bounded even if a corrupt caller supplies oversized collections.
  for (const payload of payloads) if (!scanPayload(accumulator, payload)) break
  return finishCapacity(accumulator)
}

export async function calculateCatalogImportConfirmCapacityCooperativelyV1(
  payloads: readonly CatalogImportStagedPayloadV1[],
  checkpoint: CatalogImportCooperativeCheckpoint = createCatalogImportCooperativeCheckpoint(4),
): Promise<CatalogImportConfirmCapacityV1> {
  const accumulator = createAccumulator()
  for (const payload of payloads) {
    for (const proposal of payload.referenceProposals) {
      addProposal(accumulator, proposal)
      const pause = checkpoint()
      if (pause) await pause
      if (accumulator.workUnits >= CATALOG_IMPORT_CONFIRM_OVERFLOW_SENTINEL) return finishCapacity(accumulator)
    }
    addPayload(accumulator, payload)
    const pause = checkpoint()
    if (pause) await pause
    if (accumulator.workUnits >= CATALOG_IMPORT_CONFIRM_OVERFLOW_SENTINEL) return finishCapacity(accumulator)
  }
  return finishCapacity(accumulator)
}

function requireWithinLimit(capacity: CatalogImportConfirmCapacityV1): CatalogImportConfirmCapacityV1 {
  if (capacity.withinLimit) return capacity
  // WHY: 413 is stable for initial confirmation and replay. It instructs the
  // human to split/re-preview and never implies that a partial apply ran.
  throw new AppError(
    `La importación requiere al menos ${capacity.workUnits} unidades de trabajo; el límite V1 es ${capacity.limit}. Divide el archivo y genera previews separados.`,
    413,
    true,
    'CATALOG_IMPORT_CONFIRM_LIMIT_EXCEEDED',
    { capacity },
  )
}

export function requireCatalogImportConfirmCapacityV1(payloads: readonly CatalogImportStagedPayloadV1[]): CatalogImportConfirmCapacityV1 {
  return requireWithinLimit(calculateCatalogImportConfirmCapacityV1(payloads))
}

export async function requireCatalogImportConfirmCapacityCooperativelyV1(
  payloads: readonly CatalogImportStagedPayloadV1[],
  checkpoint: CatalogImportCooperativeCheckpoint = createCatalogImportCooperativeCheckpoint(4),
): Promise<CatalogImportConfirmCapacityV1> {
  return requireWithinLimit(await calculateCatalogImportConfirmCapacityCooperativelyV1(payloads, checkpoint))
}
