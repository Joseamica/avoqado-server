import { loadCommercialContractControlledJsonV2 } from '@/services/commercial/commercialContractV2Materialization.service'
import type { CommercialOfferResolutionInputV3, CommercialOfferResolutionV3 } from '@/types/commercialOfferV3'

import {
  COMMERCIAL_OFFER_RESOLUTION_V2_LIMITS,
  CommercialOfferResolutionError,
  resolveCommercialOfferV3,
  validateCommercialOfferResolutionV2,
} from './commercialOfferStacking.service'

export const resolveCommercialOfferV3Revision2 = resolveCommercialOfferV3
export {
  COMMERCIAL_OFFER_RESOLUTION_V2_LIMITS,
  CommercialOfferResolutionError,
  validateCommercialOfferResolutionV2,
}

const revision2Schema = loadCommercialContractControlledJsonV2(
  require.resolve('../../../contracts/commercial/commercial-offer-resolution-v2.schema.json'),
)

export interface CommercialOfferResolutionRegistryEntryV3 {
  resolutionVersion: number
  resolve(input: CommercialOfferResolutionInputV3): CommercialOfferResolutionV3
  schema: unknown
}

export interface CommercialOfferResolutionRegistryV3 {
  entries: Readonly<Record<number, CommercialOfferResolutionRegistryEntryV3>>
  resolve(input: CommercialOfferResolutionDispatchInputV3): CommercialOfferResolutionV3
}

export function createCommercialOfferResolutionRegistry(
  rawEntries: readonly CommercialOfferResolutionRegistryEntryV3[],
): CommercialOfferResolutionRegistryV3 {
  const entries: Record<number, CommercialOfferResolutionRegistryEntryV3> = {}
  for (const rawEntry of rawEntries) {
    if (!Number.isInteger(rawEntry.resolutionVersion) || rawEntry.resolutionVersion < 1 || entries[rawEntry.resolutionVersion]) {
      throw new Error('COMMERCIAL_OFFER_RESOLUTION_REGISTRY_INVALID')
    }
    entries[rawEntry.resolutionVersion] = Object.freeze({ ...rawEntry })
  }
  const frozenEntries = Object.freeze(entries)
  return Object.freeze({
    entries: frozenEntries,
    resolve(rawInput: CommercialOfferResolutionDispatchInputV3): CommercialOfferResolutionV3 {
      if (typeof rawInput !== 'object' || rawInput === null || Array.isArray(rawInput)) unsupported()
      const descriptor = Object.getOwnPropertyDescriptor(rawInput, 'resolutionVersion')
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) unsupported()
      const resolutionVersion = descriptor.value
      if (!Number.isInteger(resolutionVersion) || resolutionVersion < 1 || resolutionVersion > 2_147_483_647) unsupported()
      const entry = frozenEntries[resolutionVersion]
      if (!entry) unsupported()
      const { resolutionVersion: _resolutionVersion, ...input } = rawInput
      return entry.resolve(input)
    },
  })
}

const productionResolutionRegistry = createCommercialOfferResolutionRegistry([
  {
    resolutionVersion: 2,
    resolve: resolveCommercialOfferV3Revision2,
    schema: revision2Schema,
  },
])

export const COMMERCIAL_OFFER_RESOLUTION_REGISTRY = productionResolutionRegistry.entries

export type CommercialOfferResolutionDispatchInputV3 = CommercialOfferResolutionInputV3 & { resolutionVersion: unknown }

export class CommercialOfferResolutionVersionError extends Error {
  readonly code = 'COMMERCIAL_OFFER_RESOLUTION_VERSION_UNSUPPORTED'
  readonly retryable = false
  readonly poisonedRow = true
  readonly alertCode = 'COMMERCIAL_OFFER_RESOLUTION_VERSION_POISONED_ROW'

  constructor() {
    super('COMMERCIAL_OFFER_RESOLUTION_VERSION_UNSUPPORTED')
    this.name = 'CommercialOfferResolutionVersionError'
  }
}

function unsupported(): never {
  throw new CommercialOfferResolutionVersionError()
}

export function resolveCommercialOfferV3WithRegistry(rawInput: CommercialOfferResolutionDispatchInputV3): CommercialOfferResolutionV3 {
  return productionResolutionRegistry.resolve(rawInput)
}
