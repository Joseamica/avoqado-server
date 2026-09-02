import { AsyncLocalStorage } from 'node:async_hooks'
import AppError, { ConflictError, ServiceUnavailableError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'
import type { CommercialCatalogAuthorityPointer } from './commercialCatalogAuthority.service'
import {
  CommercialArtifactCodecError,
  decodeAndVerifyStoredCommercialCatalog,
  type VerifiedStoredCommercialCatalogV2,
} from './commercialArtifactCodecRegistry.service'
import { catalogDecodeInput } from './commercialCatalogFallbackBoundary.service'

const commercialQuoteV2AuthorityContextBrand: unique symbol = Symbol('CommercialQuoteV2AuthorityContext')
const activeContexts = new WeakSet<object>()
const activeAuthorityScope = new AsyncLocalStorage<CommercialQuoteV2AuthorityContext>()

export interface CommercialQuoteV2AuthorityContext {
  readonly catalog: VerifiedStoredCommercialCatalogV2
  readonly [commercialQuoteV2AuthorityContextBrand]: true
}

export interface CommercialQuoteV2AuthorityDependencies {
  loadProductionCatalogPointer(): Promise<CommercialCatalogAuthorityPointer | null>
}

function catalogUnavailable(): never {
  throw new ServiceUnavailableError('El catálogo comercial activo no está disponible temporalmente.', 'COMMERCIAL_CATALOG_UNAVAILABLE')
}

function authorityContextRequired(): never {
  throw new AppError(
    'La operación comercial requiere el contexto verificado de cotización.',
    500,
    false,
    'COMMERCIAL_QUOTE_AUTHORITY_CONTEXT_REQUIRED',
  )
}

function assertProductionPointer(pointer: CommercialCatalogAuthorityPointer): void {
  if (
    pointer.environment !== 'PRODUCTION' ||
    typeof pointer.publicationId !== 'string' ||
    pointer.publicationId.length === 0 ||
    !Number.isSafeInteger(pointer.revision) ||
    pointer.revision <= 0 ||
    typeof pointer.publication !== 'object' ||
    pointer.publication === null ||
    pointer.publicationId !== pointer.publication.id
  ) {
    catalogUnavailable()
  }
}

export function assertCommercialQuoteV2AuthorityContext(value: unknown): asserts value is CommercialQuoteV2AuthorityContext {
  if (typeof value !== 'object' || value === null || !activeContexts.has(value) || activeAuthorityScope.getStore() !== value) {
    authorityContextRequired()
  }
}

export const prismaCommercialQuoteV2AuthorityDependencies: CommercialQuoteV2AuthorityDependencies = {
  async loadProductionCatalogPointer() {
    return (await prisma.commercialPublicationActivation.findUnique({
      where: { environment: 'PRODUCTION' },
      include: { publication: true },
    })) as unknown as CommercialCatalogAuthorityPointer | null
  },
}

export function createCommercialQuoteV2AuthorityService(
  dependencies: CommercialQuoteV2AuthorityDependencies = prismaCommercialQuoteV2AuthorityDependencies,
) {
  return {
    async withVerifiedActiveCatalogV2<T>(operation: (context: CommercialQuoteV2AuthorityContext) => Promise<T> | T): Promise<T> {
      const pointer = await dependencies.loadProductionCatalogPointer()
      if (!pointer) return catalogUnavailable()
      assertProductionPointer(pointer)

      let catalog
      try {
        catalog = decodeAndVerifyStoredCommercialCatalog(catalogDecodeInput(pointer.publication))
      } catch (error) {
        if (error instanceof CommercialArtifactCodecError) return catalogUnavailable()
        throw error
      }
      if (catalog.schemaVersion !== 2) {
        throw new ConflictError(
          'La cotización v2 requiere que el catálogo comercial activo ya sea v2.',
          'COMMERCIAL_QUOTE_CATALOG_V2_REQUIRED',
        )
      }

      const context: CommercialQuoteV2AuthorityContext = Object.freeze({
        catalog,
        [commercialQuoteV2AuthorityContextBrand]: true as const,
      })
      activeContexts.add(context)
      try {
        return await activeAuthorityScope.run(context, () => operation(context))
      } finally {
        activeContexts.delete(context)
      }
    },
  }
}

const commercialQuoteV2AuthorityService = createCommercialQuoteV2AuthorityService()

export const withVerifiedActiveCatalogV2 = commercialQuoteV2AuthorityService.withVerifiedActiveCatalogV2
