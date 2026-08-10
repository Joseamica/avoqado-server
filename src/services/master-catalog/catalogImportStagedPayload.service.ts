import { Prisma } from '@prisma/client'
import AppError from '../../errors/AppError'
import type { CatalogItemAggregateCommand, CatalogReferenceProposal, ValidatedCatalogItem } from './catalogItem.types'
import { validateCatalogItemInput, validateCatalogExpectedRevision } from './catalogItemValidation.service'
import { canonicalJsonV1 } from './catalogHash.service'
import { normalizeCatalogReferenceNameV1 } from './catalogReference.service'
import { isCatalogWorkbookTextV1 } from './identifierNormalization.service'
import type { CatalogImportStagedReferenceProposalV1, CatalogVenueBindingRequestV1 } from './catalogImport.types'
import { createCatalogImportCooperativeCheckpoint } from './catalogImportCanonical.service'
import {
  CATALOG_IMPORT_BINDING_REQUEST_MAX_V1,
  parseCatalogImportBindingRequestsCooperativelyV1,
  parseCatalogImportBindingRequestsV1,
  preflightCatalogImportCommandCollectionsCooperativelyV1,
  preflightCatalogImportCommandCollectionsV1,
} from './catalogImportStagedCollections.service'

export interface CatalogImportBatchRowV1 {
  id: string
  organizationId: string
  state: string
  schemaVersion: 1
  requestHash: string
  requestHashVersion: 1
  targetHash: string
  previewTokenHash: string
  previewExpiresAt: Date
  dependencies: Prisma.JsonValue
  staffId: string | null
  result?: Prisma.JsonValue
  failureCode?: string | null
  failureMessage?: string | null
  completedAt?: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface CatalogImportLineRowV1 {
  id: string
  status: string
  sourceSheet: string
  sourceRow: number
  payload: Prisma.JsonValue
  errors?: unknown
  catalogItemId?: string | null
}

export interface CatalogImportStagedPayloadV1 {
  schemaVersion: 1
  command: CatalogItemAggregateCommand
  referenceProposals: CatalogImportStagedReferenceProposalV1[]
  venueBindingRequests: CatalogVenueBindingRequestV1[]
}

type CreateCatalogReferenceProposalV1 = Extract<CatalogReferenceProposal, { operation: 'CREATE' }>

const CREATE_INPUT_KEYS = [
  'brandId',
  'businessTypes',
  'description',
  'familyId',
  'iepsMode',
  'iepsQuota',
  'iepsQuotaUnit',
  'iepsRate',
  'imageUrl',
  'kind',
  'manufacturerId',
  'name',
  'objetoImp',
  'organizationValues',
  'presentationLabel',
  'productType',
  'satProductKey',
  'satUnitKey',
  'sku',
  'taxRate',
  'unit',
] as const
const SHA256_HEX = /^[0-9a-f]{64}$/u
const POSTGRES_INT_MAX = 2_147_483_647
const MAX_PROPOSALS_PER_ITEM = 4
const MAX_ITEM_LINES = 20_000

export function projectCatalogImportValidatedCommandV1(
  operation: 'CREATE' | 'UPDATE',
  validated: ValidatedCatalogItem,
  identity?: { catalogItemId: string; expectedRevision: number },
): CatalogItemAggregateCommand {
  // WHY: Preview stages the exact Task 5 canonical DTO through an explicit
  // whitelist; internal normalizedSku and future validator fields cannot leak.
  const createInput = Object.fromEntries(CREATE_INPUT_KEYS.map(key => [key, validated[key]])) as Record<string, unknown>
  // WHY: Task 5 represents an absent CAS revision as `undefined` internally,
  // but durable canonical JSON has no undefined value; omit only this known
  // optional field instead of applying a permissive generic JSON sanitizer.
  createInput.organizationValues = validated.organizationValues.map(value => ({
    kind: value.kind,
    amount: value.amount,
    currency: value.currency,
    ...(value.expectedRuleRevision === undefined ? {} : { expectedRuleRevision: value.expectedRuleRevision }),
  }))
  if (operation === 'CREATE') return { operation, input: createInput as never }
  if (!identity) return invalidStaging('La proyección UPDATE requiere identidad estable.')
  return {
    operation,
    input: {
      ...createInput,
      ...identity,
      organizationValueDeactivations: validated.organizationValueDeactivations,
    } as never,
  }
}

function invalidStaging(message: string): never {
  throw new AppError(message, 409, true, 'CATALOG_IMPORT_STAGING_INVALID')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...allowed].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function boundedText(value: unknown, maximum = 256): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum
}

function boundedWorkbookText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && isCatalogWorkbookTextV1(value)
}

export function parseCatalogImportBatchV1(value: unknown): CatalogImportBatchRowV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.requestHashVersion !== 1) {
    throw new AppError('La versión durable del preview no es compatible.', 409, true, 'CATALOG_IMPORT_VERSION_UNSUPPORTED')
  }
  if (
    !boundedText(value.id) ||
    !boundedText(value.organizationId) ||
    typeof value.state !== 'string' ||
    !['PREVIEWED', 'APPLYING', 'APPLIED', 'FAILED'].includes(value.state) ||
    typeof value.requestHash !== 'string' ||
    !SHA256_HEX.test(value.requestHash) ||
    typeof value.targetHash !== 'string' ||
    !SHA256_HEX.test(value.targetHash) ||
    typeof value.previewTokenHash !== 'string' ||
    !SHA256_HEX.test(value.previewTokenHash) ||
    !(value.previewExpiresAt instanceof Date) ||
    !Number.isFinite(value.previewExpiresAt.getTime()) ||
    !(value.createdAt instanceof Date) ||
    !Number.isFinite(value.createdAt.getTime()) ||
    !(value.updatedAt instanceof Date) ||
    !Number.isFinite(value.updatedAt.getTime()) ||
    (value.staffId !== null && !boundedText(value.staffId))
  ) {
    return invalidStaging('El batch durable no conserva el shape V1 esperado.')
  }
  if (
    value.state === 'FAILED' &&
    (!boundedText(value.failureCode, 128) ||
      !boundedText(value.failureMessage, 1_024) ||
      !(value.completedAt instanceof Date) ||
      !Number.isFinite(value.completedAt.getTime()))
  ) {
    return invalidStaging('El batch FAILED no conserva su diagnóstico durable.')
  }
  return value as unknown as CatalogImportBatchRowV1
}

function parseCommand(value: unknown, collectionsPreflighted = false): CatalogItemAggregateCommand {
  if (!isRecord(value) || !isRecord(value.input) || typeof value.operation !== 'string') {
    return invalidStaging('El comando staged no es un objeto cerrado.')
  }
  if (value.operation === 'RETIRE') {
    if (!hasExactKeys(value, ['operation', 'input']) || !hasExactKeys(value.input, ['catalogItemId', 'expectedRevision'])) {
      return invalidStaging('El retiro staged contiene campos inesperados.')
    }
    if (!boundedText(value.input.catalogItemId)) return invalidStaging('El retiro staged no conserva un ID válido.')
    try {
      validateCatalogExpectedRevision(value.input.expectedRevision, 'expectedRevision')
    } catch {
      return invalidStaging('El retiro staged no conserva una revisión válida.')
    }
    return value as unknown as CatalogItemAggregateCommand
  }
  if (value.operation !== 'CREATE' && value.operation !== 'UPDATE') {
    return invalidStaging('La operación staged no es compatible con V1.')
  }
  const allowed =
    value.operation === 'CREATE'
      ? CREATE_INPUT_KEYS
      : [...CREATE_INPUT_KEYS, 'catalogItemId', 'expectedRevision', 'organizationValueDeactivations']
  if (!hasExactKeys(value, ['operation', 'input']) || !hasExactKeys(value.input, allowed)) {
    return invalidStaging('El comando staged contiene campos inesperados o faltantes.')
  }
  if (!collectionsPreflighted) {
    // WHY: Nested caps/closed shapes run before Task 5 maps any collection, so
    // corrupted JSON cannot turn its validator into an unbounded traversal.
    preflightCatalogImportCommandCollectionsV1(value.input, value.operation)
  }
  try {
    const validated = validateCatalogItemInput(value.input as never, value.operation)
    const projected = projectCatalogImportValidatedCommandV1(
      value.operation,
      validated,
      value.operation === 'UPDATE'
        ? {
            catalogItemId: value.input.catalogItemId as string,
            expectedRevision: value.input.expectedRevision as number,
          }
        : undefined,
    )
    // WHY: Confirmation may validate but never silently normalize durable
    // content; the reviewed hash must be the exact canonical Task 5 command.
    if (canonicalJsonV1(value) !== canonicalJsonV1(projected)) {
      return invalidStaging('El comando staged no conserva la forma canónica revisada.')
    }
    return projected
  } catch {
    return invalidStaging('El comando staged ya no satisface el contrato Task 5.')
  }
}

function parseReferenceProposals(value: unknown): CatalogImportStagedPayloadV1['referenceProposals'] {
  if (!Array.isArray(value) || value.length > MAX_PROPOSALS_PER_ITEM) {
    return invalidStaging('Las propuestas de referencia staged exceden V1.')
  }
  const proposals: CatalogImportStagedPayloadV1['referenceProposals'] = []
  for (const raw of value) {
    if (
      !isRecord(raw) ||
      raw.operation !== 'CREATE' ||
      typeof raw.referenceType !== 'string' ||
      !['BRAND', 'MANUFACTURER', 'FAMILY'].includes(raw.referenceType)
    ) {
      return invalidStaging('La propuesta de referencia staged no es CREATE V1.')
    }
    const allowed =
      raw.referenceType === 'FAMILY'
        ? ['operation', 'referenceType', 'name', 'parentId', 'capacityMarker']
        : ['operation', 'referenceType', 'name', 'capacityMarker']
    if (!hasExactKeys(raw, allowed) || !boundedWorkbookText(raw.name)) {
      return invalidStaging('La propuesta staged contiene campos inválidos.')
    }
    if (raw.referenceType === 'FAMILY' && raw.parentId !== null && typeof raw.parentId !== 'string') {
      return invalidStaging('El padre FAMILY staged no es válido.')
    }
    try {
      normalizeCatalogReferenceNameV1(raw.name)
    } catch {
      return invalidStaging('El nombre de referencia staged no es válido.')
    }
    const proposal = raw as unknown as CatalogImportStagedPayloadV1['referenceProposals'][number]
    if (typeof raw.capacityMarker !== 'string' || raw.capacityMarker !== catalogImportProposalMarkerV1(proposal)) {
      return invalidStaging('La propuesta staged no conserva su identidad de capacidad.')
    }
    proposals.push(proposal)
  }
  const proposalByMarker = new Map(proposals.map(proposal => [catalogImportProposalMarkerV1(proposal), proposal]))
  for (const proposal of proposals) {
    if (proposal.referenceType !== 'FAMILY') continue
    const parentId = proposal.parentId
    if (parentId === undefined) return invalidStaging('La propuesta FAMILY staged no conserva parentId.')
    if (parentId === null) continue
    if (parentId.startsWith('@proposal:')) {
      const parent = proposalByMarker.get(parentId)
      if (!parent || parent.referenceType !== 'FAMILY' || parent.parentId !== null) {
        return invalidStaging('El padre FAMILY staged no pertenece al mismo payload.')
      }
    } else if (!boundedText(parentId)) {
      return invalidStaging('El padre FAMILY staged no conserva un ID válido.')
    }
  }
  return proposals
}

function parseItemLineEnvelope(line: CatalogImportLineRowV1): Record<string, unknown> {
  // WHY: Durable JSON is untrusted at confirm time; the complete line and all
  // nested arrays fail closed before marker resolution or a Task 5 writer.
  if (
    !boundedText(line.id) ||
    line.status !== 'READY' ||
    line.sourceSheet !== 'Items' ||
    !Number.isSafeInteger(line.sourceRow) ||
    line.sourceRow < 1 ||
    line.sourceRow > POSTGRES_INT_MAX ||
    !(
      line.errors === null ||
      line.errors === undefined ||
      line.errors === Prisma.JsonNull ||
      (Array.isArray(line.errors) && line.errors.length === 0)
    ) ||
    !isRecord(line.payload) ||
    !hasExactKeys(line.payload, ['schemaVersion', 'command', 'referenceProposals', 'venueBindingRequests']) ||
    line.payload.schemaVersion !== 1
  ) {
    return invalidStaging('La fila durable no conserva el shape READY V1.')
  }
  return line.payload
}

function finalizeItemPayload(
  line: CatalogImportLineRowV1,
  command: CatalogItemAggregateCommand,
  referenceProposals: CatalogImportStagedPayloadV1['referenceProposals'],
  venueBindingRequests: CatalogVenueBindingRequestV1[],
): CatalogImportStagedPayloadV1 {
  if (command.operation === 'RETIRE' && (referenceProposals.length !== 0 || venueBindingRequests.length !== 0)) {
    // WHY: RETIRE owns identity/status only; injected proposals or binding
    // intents must never turn a reviewed retirement into additional writes.
    return invalidStaging('El retiro staged contiene mutaciones ancillary.')
  }
  const markerByValue = new Map(referenceProposals.map(proposal => [catalogImportProposalMarkerV1(proposal), proposal]))
  if (command.operation !== 'RETIRE') {
    for (const [field, expectedType] of [
      ['brandId', 'BRAND'],
      ['manufacturerId', 'MANUFACTURER'],
      ['familyId', 'FAMILY'],
    ] as const) {
      const reference = command.input[field]
      if (reference.startsWith('@proposal:')) {
        if (markerByValue.get(reference)?.referenceType !== expectedType) {
          return invalidStaging('El comando staged referencia una propuesta ajena.')
        }
      } else if (!boundedText(reference)) {
        return invalidStaging('El comando staged no conserva un ID de referencia válido.')
      }
    }
  }
  const expectedId = command.operation === 'CREATE' ? null : command.input.catalogItemId
  if ((line.catalogItemId ?? null) !== expectedId) return invalidStaging('La identidad staged no coincide con el comando.')
  return {
    schemaVersion: 1,
    command,
    referenceProposals,
    venueBindingRequests,
  }
}

export function parseCatalogImportStagedPayloadV1(line: CatalogImportLineRowV1): CatalogImportStagedPayloadV1 {
  const payload = parseItemLineEnvelope(line)
  return finalizeItemPayload(
    line,
    parseCommand(payload.command),
    parseReferenceProposals(payload.referenceProposals),
    parseCatalogImportBindingRequestsV1(payload.venueBindingRequests),
  )
}

export function catalogImportProposalMarkerV1(
  proposal: Pick<CreateCatalogReferenceProposalV1, 'referenceType' | 'name' | 'parentId'>,
): string {
  const base = `@proposal:${proposal.referenceType}:${normalizeCatalogReferenceNameV1(proposal.name).normalizedName}`
  if (proposal.referenceType !== 'FAMILY') return base
  return `${base}:PARENT:${proposal.parentId ?? 'ROOT'}`
}

export function stageCatalogImportReferenceProposalsV1(
  proposals: readonly CreateCatalogReferenceProposalV1[],
): CatalogImportStagedPayloadV1['referenceProposals'] {
  // WHY: PostgreSQL review pagination consumes this precomputed Unicode-aware
  // identity; confirm recalculates it so SQL never approximates NFKC semantics.
  return proposals.map(proposal => ({ ...proposal, capacityMarker: catalogImportProposalMarkerV1(proposal) }))
}

export async function parseCatalogImportStagedPayloadsV1(
  lines: readonly CatalogImportLineRowV1[],
  checkpoint = createCatalogImportCooperativeCheckpoint(4),
): Promise<CatalogImportStagedPayloadV1[]> {
  if (lines.length > MAX_ITEM_LINES) return invalidStaging('El batch staged excede Items V1.')
  const payloads: CatalogImportStagedPayloadV1[] = []
  let bindingRequestCount = 0
  // WHY: Aggregate array lengths are rejected before parsing the first nested
  // object, and every legal nested traversal yields inside the batch.
  for (const line of lines) {
    const raw = parseItemLineEnvelope(line)
    if (!Array.isArray(raw.venueBindingRequests)) return invalidStaging('Las solicitudes staged no son un arreglo.')
    bindingRequestCount += raw.venueBindingRequests.length
    if (bindingRequestCount > CATALOG_IMPORT_BINDING_REQUEST_MAX_V1) {
      return invalidStaging('El batch staged excede solicitudes de venue V1.')
    }
    await checkpoint()
  }
  for (const line of lines) {
    const raw = parseItemLineEnvelope(line)
    if (
      !isRecord(raw.command) ||
      !isRecord(raw.command.input) ||
      (raw.command.operation !== 'CREATE' && raw.command.operation !== 'UPDATE' && raw.command.operation !== 'RETIRE')
    ) {
      return invalidStaging('El comando staged no es un objeto cerrado.')
    }
    if (raw.command.operation !== 'RETIRE') {
      await preflightCatalogImportCommandCollectionsCooperativelyV1(raw.command.input, raw.command.operation, checkpoint)
    }
    const payload = finalizeItemPayload(
      line,
      parseCommand(raw.command, raw.command.operation !== 'RETIRE'),
      parseReferenceProposals(raw.referenceProposals),
      await parseCatalogImportBindingRequestsCooperativelyV1(raw.venueBindingRequests, checkpoint),
    )
    payloads.push(payload)
    await checkpoint()
  }
  return payloads
}

export async function collectCatalogImportReferenceProposalsV1(
  payloads: readonly CatalogImportStagedPayloadV1[],
  checkpoint = createCatalogImportCooperativeCheckpoint(4),
): Promise<CreateCatalogReferenceProposalV1[]> {
  const byMarker = new Map<string, CreateCatalogReferenceProposalV1>()
  const familyParentByName = new Map<string, string | null>()
  // WHY: CatalogFamily has organization-wide normalized-name uniqueness even
  // though markers include parent identity. Detect cross-line parent conflicts
  // separately and traverse bounded arrays without allocating a large flat copy.
  for (const payload of payloads) {
    for (const proposal of payload.referenceProposals) {
      const marker = proposal.capacityMarker
      if (proposal.referenceType === 'FAMILY') {
        const normalizedName = normalizeCatalogReferenceNameV1(proposal.name).normalizedName
        const priorParent = familyParentByName.get(normalizedName)
        if (familyParentByName.has(normalizedName) && priorParent !== proposal.parentId) {
          return invalidStaging('Una FAMILY staged aparece bajo padres incompatibles.')
        }
        familyParentByName.set(normalizedName, proposal.parentId ?? null)
      }
      if (!byMarker.has(marker)) {
        // WHY: Capacity-only metadata remains in staging/read authority and is
        // explicitly stripped before the shared Task 5 reference writer seam.
        byMarker.set(
          marker,
          proposal.referenceType === 'FAMILY'
            ? {
                operation: 'CREATE',
                referenceType: 'FAMILY',
                name: proposal.name,
                parentId: proposal.parentId ?? null,
              }
            : { operation: 'CREATE', referenceType: proposal.referenceType, name: proposal.name },
        )
      }
      const pause = checkpoint()
      if (pause) await pause
    }
  }
  return [...byMarker.values()]
}

export function resolveCatalogImportReferenceMarkerV1(value: string, resolved: ReadonlyMap<string, string>): string {
  if (!value.startsWith('@proposal:')) return value
  const id = resolved.get(value)
  return id ?? invalidStaging('Una referencia staged no pudo resolverse.')
}

export function resolveCatalogImportCommandMarkersV1(
  command: CatalogItemAggregateCommand,
  resolved: ReadonlyMap<string, string>,
): CatalogItemAggregateCommand {
  if (command.operation === 'RETIRE') return command
  // WHY: Task 5 receives only real IDs; proposal markers are confined to the
  // hash-bound staged payload and resolved after exact proposal validation.
  return {
    ...command,
    input: {
      ...command.input,
      brandId: resolveCatalogImportReferenceMarkerV1(command.input.brandId, resolved),
      manufacturerId: resolveCatalogImportReferenceMarkerV1(command.input.manufacturerId, resolved),
      familyId: resolveCatalogImportReferenceMarkerV1(command.input.familyId, resolved),
    },
  } as CatalogItemAggregateCommand
}
