import { randomBytes, randomUUID } from 'node:crypto'
import AppError from '../../errors/AppError'
import type { CatalogCommandContext, CatalogWorkbookUpload } from '../../types/master-catalog'
import prisma from '../../utils/prismaClient'
import { writeCatalogAudit } from './catalogAudit.service'
export {
  canonicalizeAndHashCatalogImportRows,
  EVENT_LOOP_BUDGET_MS,
  type CanonicalCatalogImportRowsResult,
} from './catalogImportCanonical.service'
import { canonicalizeAndHashCatalogImportRows } from './catalogImportCanonical.service'
import { createCatalogImportConfirmationService } from './catalogImportConfirmation.service'
import { revalidateCatalogImportDependenciesTx } from './catalogImportDependencies.service'
import { applyCatalogItemAggregateTx } from './catalogItem.service'
import type {
  CatalogImportConfirmationDependencies,
  CatalogImportConfirmInput,
  CatalogImportPrisma,
  CatalogImportService,
  CatalogImportTransaction,
} from './catalogImport.types'
import { createCatalogImportValidationService } from './catalogImportValidation.service'
import { applyCatalogReferenceProposalsTx } from './catalogReference.service'
import { createCatalogWorkbookService } from './catalogWorkbook.service'
import { acquireCatalogMutationLock } from './catalogMutationLock.service'
import { resolveMasterCatalogAccess } from './masterCatalogAccess.service'

// WHY: Task 10 mounts one catalog-import facade; paginated review seams remain
// live-authorized services rather than controllers reaching into staged JSON.
export { getCatalogImportPreviewItemDetail, listCatalogImportPreviewPage } from './catalogImportRead.service'
export type {
  CatalogImportPreviewItemDetailInput,
  CatalogImportPreviewItemDetailResultV1,
  CatalogImportPreviewPageInput,
  CatalogImportPreviewPageV1,
  CatalogImportPreviewSection,
} from './catalogImportRead.service'

function mapCatalogImportTransactionError(error: unknown): never {
  // WHY: Prisma guarantees rollback on an interactive-transaction timeout;
  // callers receive one stable retryable code instead of leaking P2028 text.
  if ((error as { code?: string }).code === 'P2028') {
    throw new AppError('La transacción de importación excedió el tiempo permitido.', 503, true, 'CATALOG_IMPORT_TRANSACTION_TIMEOUT')
  }
  throw error
}

async function assertCatalogImportLiveAccessTx(tx: CatalogImportTransaction, context: CatalogCommandContext): Promise<void> {
  // WHY: Both preview and confirm re-read live membership, entitlement, module,
  // and CORE gate inside their own transaction; token claims are never enough.
  const access = await resolveMasterCatalogAccess({
    organizationId: context.organizationId,
    principal: context.actor,
    capability: 'MUTATE_CONTENT',
    requiredGate: 'CORE',
    prisma: tx,
  })
  if (access.reasonCode === 'DEPENDENCY_UNAVAILABLE') {
    throw new AppError('El acceso al catálogo no está disponible.', 503, true, 'CATALOG_ACCESS_UNAVAILABLE')
  }
  if (!access.canMutateContent) {
    throw new AppError('No tienes acceso vigente para importar el catálogo.', 403, true, 'CATALOG_ACCESS_DENIED')
  }
}

interface CatalogImportFactoryDependencies {
  prisma: CatalogImportPrisma
  parseWorkbook(upload: CatalogWorkbookUpload): Promise<import('../../workers/masterCatalogXlsx.worker').ParsedMasterCatalogWorkbook>
  applyCatalogReferenceProposalsTx: CatalogImportConfirmationDependencies['applyCatalogReferenceProposalsTx']
  applyCatalogItemAggregateTx: CatalogImportConfirmationDependencies['applyCatalogItemAggregateTx']
  writeCatalogAudit: CatalogImportConfirmationDependencies['writeCatalogAudit']
  assertLiveAccessTx(tx: CatalogImportTransaction, context: CatalogCommandContext): Promise<void>
  acquireMutationLockTx?: CatalogImportConfirmationDependencies['acquireMutationLockTx']
  revalidateDependenciesTx?: CatalogImportConfirmationDependencies['revalidateDependenciesTx']
  now(): Date
  randomToken(): string
  randomAttemptId(): string
}

export function createCatalogImportService(dependencies: CatalogImportFactoryDependencies): CatalogImportService {
  const validation = createCatalogImportValidationService({
    prisma: dependencies.prisma,
    parseWorkbook: dependencies.parseWorkbook,
    assertLiveAccessTx: dependencies.assertLiveAccessTx,
    now: dependencies.now,
    randomToken: dependencies.randomToken,
    canonicalizeRows: canonicalizeAndHashCatalogImportRows,
  })
  const confirmation = createCatalogImportConfirmationService({
    prisma: dependencies.prisma,
    applyCatalogReferenceProposalsTx: dependencies.applyCatalogReferenceProposalsTx,
    applyCatalogItemAggregateTx: dependencies.applyCatalogItemAggregateTx,
    writeCatalogAudit: dependencies.writeCatalogAudit,
    assertLiveAccessTx: dependencies.assertLiveAccessTx,
    acquireMutationLockTx: dependencies.acquireMutationLockTx ?? acquireCatalogMutationLock,
    revalidateDependenciesTx: dependencies.revalidateDependenciesTx ?? revalidateCatalogImportDependenciesTx,
    canonicalizeRows: canonicalizeAndHashCatalogImportRows,
    now: dependencies.now,
    randomAttemptId: dependencies.randomAttemptId,
  })
  // WHY: The facade exposes one approved boundary while validation and atomic
  // confirmation remain independently reviewable state machines.
  return {
    preview: async (context, upload) => {
      try {
        return await validation.preview(context, upload)
      } catch (error) {
        return mapCatalogImportTransactionError(error)
      }
    },
    confirm: async (context, input) => {
      try {
        return await confirmation.confirm(context, input)
      } catch (error) {
        return mapCatalogImportTransactionError(error)
      }
    },
  }
}

const workbookService = createCatalogWorkbookService()
const defaultCatalogImportService = createCatalogImportService({
  prisma,
  parseWorkbook: upload => workbookService.parse(upload),
  applyCatalogReferenceProposalsTx,
  applyCatalogItemAggregateTx,
  writeCatalogAudit,
  assertLiveAccessTx: assertCatalogImportLiveAccessTx,
  revalidateDependenciesTx: revalidateCatalogImportDependenciesTx,
  now: () => new Date(),
  // WHY: A 256-bit opaque bearer is returned once; only its SHA-256 digest is
  // persisted by preview and no recovery path can reconstruct it.
  randomToken: () => randomBytes(32).toString('base64url'),
  // WHY: Each APPLYING lease carries an unguessable fence so final CAS writes
  // cannot be confused with a watchdog or a concurrent confirmation attempt.
  randomAttemptId: () => randomUUID(),
})

export const previewCatalogImport = (context: CatalogCommandContext, upload: CatalogWorkbookUpload) =>
  defaultCatalogImportService.preview(context, upload)

export const confirmCatalogImport = (context: CatalogCommandContext, input: CatalogImportConfirmInput) =>
  defaultCatalogImportService.confirm(context, input)
