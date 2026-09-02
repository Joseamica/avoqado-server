import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { CommercialArtifactCodecError, decodeAndVerifyStoredCommercialCatalog } from './commercialArtifactCodecRegistry.service'
import type {
  VerifiedStoredCommercialCatalog,
  VerifiedStoredCommercialCatalogV1,
  VerifiedStoredCommercialCatalogV2,
} from './commercialArtifactCodecRegistry.service'
import { CommercialCatalogFallbackError, resolvePublicCommercialCatalog } from './commercialCatalogFallback.service'
import { catalogDecodeInput, verifyFutureCatalogRow } from './commercialCatalogFallbackBoundary.service'
import { proveCatalogActivationChain } from './commercialCatalogFallbackProvenance.service'
import type {
  CommercialCatalogActivationOutboxRecord,
  CommercialCatalogPersistedRow,
  PublicCommercialCatalogFallbackMetadata,
} from '@/types/commercialCodec'

export interface CommercialCatalogAuthorityPointer {
  environment: 'PRODUCTION'
  publicationId: string
  revision: number
  publication: CommercialCatalogPersistedRow
}

export interface CommercialCatalogAuthorityTransaction {
  getProductionPointer(): Promise<CommercialCatalogAuthorityPointer | null>
  getActivationEvents(): Promise<readonly CommercialCatalogActivationOutboxRecord[]>
}

export interface CommercialCatalogAuthorityDependencies {
  runInRepeatableRead<T>(operation: (tx: CommercialCatalogAuthorityTransaction) => Promise<T>): Promise<T>
}

export interface CommercialCatalogAuthorityReadDecision {
  catalog: VerifiedStoredCommercialCatalog
  fallback: PublicCommercialCatalogFallbackMetadata | null
}

export interface CommercialCatalogAuthorityChainDecision {
  pointer: CommercialCatalogAuthorityPointer
  publications: readonly CommercialCatalogPersistedRow[]
}

export type CommercialCatalogAuthorityErrorCode =
  | 'COMMERCIAL_CATALOG_AUTHORITY_INVALID'
  | 'COMMERCIAL_CATALOG_VERSION_UNSUPPORTED'
  | 'COMMERCIAL_CATALOG_ACTIVATION_V2_REQUIRED'
  | 'COMMERCIAL_CATALOG_V1_EMERGENCY_ROLLBACK_INVALID'

export class CommercialCatalogAuthorityError extends Error {
  constructor(public readonly code: CommercialCatalogAuthorityErrorCode) {
    const messageByCode: Record<CommercialCatalogAuthorityErrorCode, string> = {
      COMMERCIAL_CATALOG_AUTHORITY_INVALID: 'No fue posible verificar la autoridad del catálogo comercial activo.',
      COMMERCIAL_CATALOG_VERSION_UNSUPPORTED: 'La versión del catálogo comercial activo todavía no es compatible.',
      COMMERCIAL_CATALOG_ACTIVATION_V2_REQUIRED: 'La activación normal requiere una publicación comercial v2 verificada.',
      COMMERCIAL_CATALOG_V1_EMERGENCY_ROLLBACK_INVALID: 'La reactivación de emergencia v1 no es válida.',
    }
    super(messageByCode[code])
    this.name = 'CommercialCatalogAuthorityError'
  }
}

export function verifyCommercialCatalogActivationChain(input: {
  pointer: CommercialCatalogAuthorityPointer
  activationEvents: readonly CommercialCatalogActivationOutboxRecord[]
}): CommercialCatalogAuthorityChainDecision {
  assertProductionPointerMatchesRow(input.pointer)
  try {
    try {
      decodeAndVerifyStoredCommercialCatalog(catalogDecodeInput(input.pointer.publication))
    } catch (error) {
      if (!(error instanceof CommercialArtifactCodecError) || error.code !== 'COMMERCIAL_CATALOG_CONTRACT_UNSUPPORTED') throw error
      verifyFutureCatalogRow(input.pointer.publication)
    }
    const publications = proveCatalogActivationChain({
      activePublication: input.pointer.publication,
      pointerRevision: input.pointer.revision,
      activationEvents: input.activationEvents,
    })
    return Object.freeze({ pointer: input.pointer, publications })
  } catch (error) {
    if (error instanceof CommercialArtifactCodecError || error instanceof CommercialCatalogFallbackError) {
      throw new CommercialCatalogAuthorityError('COMMERCIAL_CATALOG_AUTHORITY_INVALID')
    }
    throw error
  }
}

export function verifyNormalCommercialCatalogActivationTarget(
  publication: CommercialCatalogPersistedRow,
): VerifiedStoredCommercialCatalogV2 {
  try {
    const decoded = decodeAndVerifyStoredCommercialCatalog(catalogDecodeInput(publication))
    if (decoded.schemaVersion !== 2) {
      throw new CommercialCatalogAuthorityError('COMMERCIAL_CATALOG_ACTIVATION_V2_REQUIRED')
    }
    return decoded
  } catch (error) {
    if (error instanceof CommercialCatalogAuthorityError) throw error
    if (error instanceof CommercialArtifactCodecError) {
      throw new CommercialCatalogAuthorityError('COMMERCIAL_CATALOG_ACTIVATION_V2_REQUIRED')
    }
    throw error
  }
}

export function verifyEmergencyCommercialCatalogV1Target(
  publication: CommercialCatalogPersistedRow,
  chain: CommercialCatalogAuthorityChainDecision,
): VerifiedStoredCommercialCatalogV1 {
  try {
    const decoded = decodeAndVerifyStoredCommercialCatalog(catalogDecodeInput(publication))
    const member = chain.publications.find(
      candidate =>
        candidate.id === publication.id &&
        candidate.schemaVersion === publication.schemaVersion &&
        candidate.checksum === publication.checksum &&
        candidate.publishedAt.toISOString() === publication.publishedAt.toISOString(),
    )
    if (decoded.schemaVersion !== 1 || !member) {
      throw new CommercialCatalogAuthorityError('COMMERCIAL_CATALOG_V1_EMERGENCY_ROLLBACK_INVALID')
    }
    return decoded
  } catch (error) {
    if (error instanceof CommercialCatalogAuthorityError) throw error
    if (error instanceof CommercialArtifactCodecError) {
      throw new CommercialCatalogAuthorityError('COMMERCIAL_CATALOG_V1_EMERGENCY_ROLLBACK_INVALID')
    }
    throw error
  }
}

function translateCatalogVerificationError(error: unknown): never {
  if (error instanceof CommercialCatalogFallbackError) {
    throw new CommercialCatalogAuthorityError('COMMERCIAL_CATALOG_AUTHORITY_INVALID')
  }
  if (!(error instanceof CommercialArtifactCodecError)) throw error
  if (error.code === 'COMMERCIAL_CATALOG_SCHEMA_UNSUPPORTED' || error.code === 'COMMERCIAL_CATALOG_CONTRACT_UNSUPPORTED') {
    throw new CommercialCatalogAuthorityError('COMMERCIAL_CATALOG_VERSION_UNSUPPORTED')
  }
  throw new CommercialCatalogAuthorityError('COMMERCIAL_CATALOG_AUTHORITY_INVALID')
}

function assertProductionPointerMatchesRow(pointer: CommercialCatalogAuthorityPointer): void {
  if (
    pointer.environment !== 'PRODUCTION' ||
    typeof pointer.publicationId !== 'string' ||
    pointer.publicationId.length === 0 ||
    !Number.isSafeInteger(pointer.revision) ||
    pointer.revision <= 0 ||
    pointer.publicationId !== pointer.publication.id
  ) {
    throw new CommercialCatalogAuthorityError('COMMERCIAL_CATALOG_AUTHORITY_INVALID')
  }
}

export const prismaCommercialCatalogAuthorityDependencies: CommercialCatalogAuthorityDependencies = {
  runInRepeatableRead: operation =>
    prisma.$transaction(
      async prismaTx =>
        operation({
          getProductionPointer: () =>
            prismaTx.commercialPublicationActivation.findUnique({
              where: { environment: 'PRODUCTION' },
              include: { publication: true },
            }) as Promise<CommercialCatalogAuthorityPointer | null>,
          getActivationEvents: () =>
            prismaTx.commercialPublicationOutbox.findMany({
              where: { eventType: { in: ['PUBLICATION_ACTIVATED', 'PUBLICATION_ROLLED_BACK'] } },
              include: { publication: true, previousPublication: true },
            }) as Promise<CommercialCatalogActivationOutboxRecord[]>,
        }),
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 5_000,
        timeout: 30_000,
      },
    ),
}

export function createCommercialCatalogAuthorityService(
  dependencies: CommercialCatalogAuthorityDependencies = prismaCommercialCatalogAuthorityDependencies,
) {
  return {
    async readVerifiedActiveCatalog(): Promise<CommercialCatalogAuthorityReadDecision | null> {
      return dependencies.runInRepeatableRead(async tx => {
        const pointer = await tx.getProductionPointer()
        if (!pointer) return null
        assertProductionPointerMatchesRow(pointer)
        try {
          const catalog = decodeAndVerifyStoredCommercialCatalog(catalogDecodeInput(pointer.publication))
          return { catalog, fallback: null }
        } catch (error) {
          if (!(error instanceof CommercialArtifactCodecError) || error.code !== 'COMMERCIAL_CATALOG_CONTRACT_UNSUPPORTED') {
            return translateCatalogVerificationError(error)
          }
          try {
            verifyFutureCatalogRow(pointer.publication)
            const activationEvents = await tx.getActivationEvents()
            return resolvePublicCommercialCatalog({
              activePointer: {
                environment: pointer.environment,
                publicationId: pointer.publicationId,
                revision: pointer.revision,
              },
              activePublication: pointer.publication,
              activationEvents,
            }) as CommercialCatalogAuthorityReadDecision
          } catch (fallbackError) {
            return translateCatalogVerificationError(fallbackError)
          }
        }
      })
    },
  }
}

const commercialCatalogAuthorityService = createCommercialCatalogAuthorityService()

export const readVerifiedActiveCatalog = commercialCatalogAuthorityService.readVerifiedActiveCatalog
