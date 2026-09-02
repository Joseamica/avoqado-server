import AppError, { ConflictError } from '@/errors/AppError'
import { COMMERCIAL_OFFER_RESOLUTION_REGISTRY } from '@/services/commercial/offers/commercialOfferResolutionRegistry.service'
import {
  CommercialQuoteV3Error,
  decodeAndVerifyStoredCommercialQuoteV3,
} from '@/services/commercial/quotes-v3/commercialQuoteV3Contract.service'
import type {
  CommercialQuoteV3DecodeInput,
  VerifiedStoredCommercialQuoteV3,
} from '@/types/commercialQuoteV3'

const POISONED_RESOLUTION_ALERT = 'COMMERCIAL_OFFER_RESOLUTION_VERSION_POISONED_ROW' as const
const UNSUPPORTED_RESOLUTION = 'COMMERCIAL_OFFER_RESOLUTION_VERSION_UNSUPPORTED' as const

export interface LoadStoredCommercialQuoteV3Input {
  quoteId: string
  organizationId: string
  venueId: string
  correlationId: string
}

export interface CommercialStoredQuoteV3Dependencies {
  loadRowAndAuthorities(input: LoadStoredCommercialQuoteV3Input): Promise<CommercialQuoteV3DecodeInput | null>
  recordPoisonedResolution(input: {
    quoteId: string
    correlationId: string
    code: typeof POISONED_RESOLUTION_ALERT
  }): void
}

export interface CommercialStoredQuoteV3Service {
  loadVerified(input: LoadStoredCommercialQuoteV3Input): Promise<VerifiedStoredCommercialQuoteV3>
}

type OwnDataDescriptor = PropertyDescriptor & { value: unknown }

function ownEnumerableDataDescriptor(value: object, property: PropertyKey): OwnDataDescriptor | null {
  const descriptor = Object.getOwnPropertyDescriptor(value, property)
  if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null
  return descriptor as OwnDataDescriptor
}

function isPlainObject(value: unknown): value is Record<PropertyKey, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function recordPoisonAndThrow(
  dependencies: CommercialStoredQuoteV3Dependencies,
  input: LoadStoredCommercialQuoteV3Input,
): never {
  try {
    dependencies.recordPoisonedResolution({
      quoteId: input.quoteId,
      correlationId: input.correlationId,
      code: POISONED_RESOLUTION_ALERT,
    })
  } catch {
    // Observability cannot turn a deterministic fail-closed response into a data leak.
  }
  throw new ConflictError(UNSUPPORTED_RESOLUTION, UNSUPPORTED_RESOLUTION)
}

function assertSupportedStoredResolution(
  stored: CommercialQuoteV3DecodeInput,
  dependencies: CommercialStoredQuoteV3Dependencies,
  input: LoadStoredCommercialQuoteV3Input,
): void {
  try {
    const snapshotDescriptor = ownEnumerableDataDescriptor(stored, 'snapshot')
    if (!snapshotDescriptor || !isPlainObject(snapshotDescriptor.value)) {
      recordPoisonAndThrow(dependencies, input)
    }
    const resolutionDescriptor = ownEnumerableDataDescriptor(snapshotDescriptor.value, 'resolution')
    if (!resolutionDescriptor || !isPlainObject(resolutionDescriptor.value)) {
      recordPoisonAndThrow(dependencies, input)
    }
    const versionDescriptor = ownEnumerableDataDescriptor(resolutionDescriptor.value, 'resolutionVersion')
    const resolutionVersion = versionDescriptor?.value
    if (
      !versionDescriptor ||
      !Number.isInteger(resolutionVersion) ||
      (resolutionVersion as number) < 1 ||
      (resolutionVersion as number) > 2_147_483_647 ||
      !Object.prototype.hasOwnProperty.call(COMMERCIAL_OFFER_RESOLUTION_REGISTRY, resolutionVersion)
    ) {
      recordPoisonAndThrow(dependencies, input)
    }
  } catch (error) {
    if (error instanceof ConflictError && error.code === UNSUPPORTED_RESOLUTION) throw error
    recordPoisonAndThrow(dependencies, input)
  }
}

function tenantMatches(stored: CommercialQuoteV3DecodeInput, input: LoadStoredCommercialQuoteV3Input): boolean {
  return stored.rowContext.organizationId === input.organizationId &&
    stored.rowContext.venueId === input.venueId &&
    stored.rowContext.venueOrganizationId === input.organizationId
}

export function createCommercialStoredQuoteV3Service(
  dependencies: CommercialStoredQuoteV3Dependencies,
): CommercialStoredQuoteV3Service {
  return Object.freeze({
    async loadVerified(input: LoadStoredCommercialQuoteV3Input): Promise<VerifiedStoredCommercialQuoteV3> {
      const stored = await dependencies.loadRowAndAuthorities(input)
      if (stored === null || !tenantMatches(stored, input)) {
        throw new AppError(
          'COMMERCIAL_QUOTE_V3_NOT_FOUND',
          404,
          true,
          'COMMERCIAL_QUOTE_V3_NOT_FOUND',
        )
      }
      if (stored.rowSchemaVersion !== 3 || stored.rowContext.schemaVersion !== 3) {
        throw new ConflictError('COMMERCIAL_QUOTE_V3_SCHEMA_UNSUPPORTED', 'COMMERCIAL_QUOTE_V3_SCHEMA_UNSUPPORTED')
      }

      assertSupportedStoredResolution(stored, dependencies, input)
      try {
        return decodeAndVerifyStoredCommercialQuoteV3(stored)
      } catch (error) {
        if (error instanceof CommercialQuoteV3Error) {
          throw new ConflictError(error.code, error.code)
        }
        throw error
      }
    },
  })
}
