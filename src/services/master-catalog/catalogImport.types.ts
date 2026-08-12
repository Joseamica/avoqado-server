import type { Prisma, PrismaClient, ProductType } from '@prisma/client'
import type { CatalogCommandContext, CatalogWorkbookUpload } from '../../types/master-catalog'
import type { CatalogItemAggregateCommand, CatalogReferenceProposal } from './catalogItem.types'
import type { ParsedMasterCatalogWorkbook } from '../../workers/masterCatalogXlsx.worker'
import type { applyCatalogItemAggregateTx } from './catalogItem.service'
import type { applyCatalogReferenceProposalsTx } from './catalogReference.service'
import type { writeCatalogAudit } from './catalogAudit.service'
import type { acquireCatalogMutationLock } from './catalogMutationLock.service'
import type { CatalogImportConfirmCapacityV1 } from './catalogImportCapacity.service'

// WHY: V1 admits 20k rows per sheet; explicit transaction horizons prevent
// Prisma's 5s default from making a contract-valid atomic import impossible.
export const CATALOG_IMPORT_PREVIEW_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 120_000 } as const
export const CATALOG_IMPORT_CONFIRM_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 900_000 } as const

// WHY: Query-side take guards must run before JSON payload hydration/parsing;
// parser-only caps cannot protect confirm or replay from a corrupted batch.
export const CATALOG_IMPORT_ITEM_LINE_MAX_V1 = 20_000
export const CATALOG_IMPORT_STAGED_LINE_MAX_V1 = 50_000

// WHY: Row findings are stable API data but carry only bounded safe excerpts;
// the raw workbook and full commercial values never enter staging errors.
export interface CatalogImportRowError {
  source_sheet: string
  source_row: number
  column: string
  error_code: string
  rejected_value?: string
  suggestion: string
  message: string
}

export interface CatalogImportDependencySnapshotV1 {
  schemaVersion: 1
  capacity: CatalogImportConfirmCapacityV1
  items: Array<{
    id: string
    revision: number
    invariantVersion: string
    status: string
    businessTypes: string[]
  }>
  priceDependentItemIds: string[]
  organizationValues: Array<{
    id: string
    catalogItemId: string
    kind: string
    scope: 'ORGANIZATION'
    currency: string
    revision: number
    active: boolean
  }>
  references: Array<{ type: 'BRAND' | 'MANUFACTURER' | 'FAMILY'; id: string; revision: number }>
  mappings: Array<{
    id: string
    catalogProductType: string
    productType: ProductType
    mappingVersion: number
    active: true
  }>
  profiles: Array<{
    id: string
    profileVersion: number
    rulesSchemaVersion: number
    businessType: string | null
    operationalRole: string | null
    requiredFields: string[]
    additionalRules: Prisma.JsonValue
  }>
}

export interface CatalogVenueBindingRequestV1 {
  corporateSku: string
  venueId: string
  requestedAction: 'LINK' | 'CREATE' | 'SKIP'
  productId: string | null
  localSku: string | null
  categoryId: string | null
  initialPrice: string | null
  currency: string | null
}

export type CatalogImportStagedReferenceProposalV1 = Extract<CatalogReferenceProposal, { operation: 'CREATE' }> & {
  capacityMarker: string
}

// WHY: A staged item stores the complete Task 5 command plus proposals and
// binding requests; confirmation never rebuilds authority from raw cells.
export interface CatalogImportItemPayloadV1 {
  schemaVersion: 1
  command: CatalogItemAggregateCommand
  referenceProposals: CatalogImportStagedReferenceProposalV1[]
  venueBindingRequests: CatalogVenueBindingRequestV1[]
}

export interface CatalogImportStagedLine {
  sourceSheet: string
  sourceRow: number
  status: 'READY' | 'INVALID'
  payload: Prisma.InputJsonValue
  errors: CatalogImportRowError[]
  catalogItemId?: string | null
}

export interface CatalogImportPreviewResult {
  importBatchId: string
  canConfirm: boolean
  previewToken: string | null
  targetHash: string
  expiresAt: string
  errors: CatalogImportRowError[]
  errorCount: number
  errorsTruncated: boolean
  capacity: CatalogImportConfirmCapacityV1
  blockingReasons: Array<{
    code: 'CATALOG_IMPORT_VALIDATION_FAILED' | 'CATALOG_IMPORT_CONFIRM_LIMIT_EXCEEDED'
    message: string
  }>
}

export interface CatalogImportConfirmInput {
  importBatchId: string
  previewToken: string
  confirm: true
  idempotencyKey: string
}

export interface CatalogImportAppliedResult {
  importBatchId: string
  state: 'APPLIED'
  appliedItemIds: string[]
}

export interface CatalogImportService {
  preview(context: CatalogCommandContext, upload: CatalogWorkbookUpload): Promise<CatalogImportPreviewResult>
  confirm(context: CatalogCommandContext, input: CatalogImportConfirmInput): Promise<CatalogImportAppliedResult>
}

export interface CatalogImportValidationDependencies {
  prisma: Pick<PrismaClient, '$transaction'>
  parseWorkbook(upload: CatalogWorkbookUpload): Promise<ParsedMasterCatalogWorkbook>
  assertLiveAccessTx(tx: CatalogImportTransaction, context: CatalogCommandContext): Promise<void>
  now(): Date
  randomToken(): string
  canonicalizeRows(rows: readonly unknown[], options?: { projectRow?: (row: unknown) => unknown }): Promise<{ hash: string }>
}

export interface CatalogImportConfirmationDependencies {
  prisma: CatalogImportPrisma
  applyCatalogReferenceProposalsTx: typeof applyCatalogReferenceProposalsTx
  applyCatalogItemAggregateTx: typeof applyCatalogItemAggregateTx
  writeCatalogAudit: typeof writeCatalogAudit
  assertLiveAccessTx(tx: CatalogImportTransaction, context: CatalogCommandContext): Promise<void>
  acquireMutationLockTx: typeof acquireCatalogMutationLock
  revalidateDependenciesTx(tx: CatalogImportTransaction, context: CatalogCommandContext, dependencies: unknown): Promise<void>
  canonicalizeRows(rows: readonly unknown[], options?: { projectRow?: (row: unknown) => unknown }): Promise<{ hash: string }>
  now(): Date
  randomAttemptId(): string
}

// WHY: Task 7 composes a transaction client through narrow structural seams;
// runtime production still supplies Prisma while unit tests avoid a database.
export type CatalogImportTransaction = Prisma.TransactionClient
export type CatalogImportPrisma = Pick<PrismaClient, '$transaction' | 'catalogIdempotencyRecord' | 'catalogImportBatch'>
