import type {
  CatalogCommandContext,
  CatalogPublicationConfirmInput,
  CatalogPublicationOperation,
  CatalogPublicationPreviewInput,
  CatalogReadContext,
} from '../../types/master-catalog'
import AppError from '../../errors/AppError'
import { createCatalogProductActivationPreviewService } from './catalogPublicationActivation.service'
import { confirmCatalogFieldsPublication } from './catalogPublicationConfirmation.service'
import { previewCatalogFieldsPublication } from './catalogPublicationPreview.service'
import { getCatalogPublicationByIdempotencyKey } from './catalogPublicationRecovery.service'
import { createCatalogPublicationReversionPreviewService } from './catalogPublicationReversion.service'

interface CatalogPublicationFacadeDependencies {
  previewFields: typeof previewCatalogFieldsPublication
  previewActivation: ReturnType<typeof createCatalogProductActivationPreviewService>['preview']
  previewReversion: ReturnType<typeof createCatalogPublicationReversionPreviewService>['preview']
  confirm: typeof confirmCatalogFieldsPublication
  recover: typeof getCatalogPublicationByIdempotencyKey
}

const activationPreview = createCatalogProductActivationPreviewService()
const reversionPreview = createCatalogPublicationReversionPreviewService()

const defaults: CatalogPublicationFacadeDependencies = {
  previewFields: previewCatalogFieldsPublication,
  previewActivation: activationPreview.preview,
  previewReversion: reversionPreview.preview,
  confirm: confirmCatalogFieldsPublication,
  recover: getCatalogPublicationByIdempotencyKey,
}

function previewOperation(input: unknown): CatalogPublicationOperation {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new AppError('La forma de la publicación es inválida.', 422, true, 'CATALOG_PUBLICATION_INPUT_INVALID')
  }
  const operation = (input as Record<string, unknown>).operation
  if (operation !== 'CATALOG_FIELDS_PUBLISH' && operation !== 'CATALOG_PRODUCT_ACTIVATION' && operation !== 'CATALOG_FIELDS_REVERSION') {
    throw new AppError('Operación de publicación no soportada.', 422, true, 'CATALOG_PUBLICATION_OPERATION_UNSUPPORTED')
  }
  return operation
}

export function createCatalogPublicationService(overrides: Partial<CatalogPublicationFacadeDependencies> = {}) {
  const dependencies = { ...defaults, ...overrides }
  return {
    async preview(context: CatalogCommandContext, input: CatalogPublicationPreviewInput) {
      // WHY: Operation dispatch is static before any resource lookup, keeping
      // idempotency namespaces isolated and unknown operations unobservable.
      const operation = previewOperation(input)
      if (operation === 'CATALOG_FIELDS_PUBLISH') return dependencies.previewFields(context, input)
      if (operation === 'CATALOG_PRODUCT_ACTIVATION') return dependencies.previewActivation(context, input)
      return dependencies.previewReversion(context, input)
    },
    confirm(context: CatalogCommandContext, input: CatalogPublicationConfirmInput) {
      return dependencies.confirm(context, input)
    },
    getByIdempotencyKey(context: CatalogReadContext, input: { operation: CatalogPublicationOperation; idempotencyKey: string }) {
      return dependencies.recover(context, input)
    },
  }
}

export const catalogPublicationService = createCatalogPublicationService()
