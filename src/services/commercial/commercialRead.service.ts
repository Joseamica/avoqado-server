import type { CommercialCatalogSnapshotV1 } from '@/types/commercial'
import type { CommercialCatalogSnapshotV2 } from '@/types/commercialV2'
import { readVerifiedActiveCatalog } from './commercialCatalogAuthority.service'

const CACHE_TTL_MS = 60_000

export interface CommercialPublicationCandidate {
  id: string
  checksum: string
  schemaVersion: number
  snapshot: unknown
}

export interface CommercialReadDependencies {
  resolveVerifiedActiveCatalog(): Promise<{
    catalog: {
      snapshot: CommercialCatalogSnapshotV1 | CommercialCatalogSnapshotV2
      checksum: string
    }
    fallback: {
      activePublicationId: string
      fallbackPublicationId: string
    } | null
  } | null>
}

export interface ActiveCommercialCatalog {
  snapshot: CommercialCatalogSnapshotV1 | CommercialCatalogSnapshotV2
  etag: string
  fallback: {
    activePublicationId: string
    servedPublicationId: string
    reason: 'ACTIVE_SCHEMA_INCOMPATIBLE'
  } | null
}

interface CommercialCatalogCacheEntry extends ActiveCommercialCatalog {
  expiresAtMs: number
}

export const prismaCommercialReadDependencies = {
  resolveVerifiedActiveCatalog: readVerifiedActiveCatalog,
}

export function createCommercialReadService(dependencies: CommercialReadDependencies) {
  let cache: CommercialCatalogCacheEntry | null = null

  return {
    invalidateCache(): void {
      cache = null
    },

    async getActiveCommercialCatalog(now: Date = new Date()): Promise<ActiveCommercialCatalog | null> {
      if (cache && cache.expiresAtMs > now.getTime()) {
        const { expiresAtMs: _expiresAtMs, ...cached } = cache
        return cached
      }

      const verified = await dependencies.resolveVerifiedActiveCatalog()
      if (!verified) return null
      const result: ActiveCommercialCatalog = {
        snapshot: verified.catalog.snapshot,
        etag: `"${verified.catalog.checksum}"`,
        fallback: verified.fallback
          ? {
              activePublicationId: verified.fallback.activePublicationId,
              servedPublicationId: verified.fallback.fallbackPublicationId,
              reason: 'ACTIVE_SCHEMA_INCOMPATIBLE',
            }
          : null,
      }

      cache = { ...result, expiresAtMs: now.getTime() + CACHE_TTL_MS }
      return result
    },
  }
}

const commercialReadService = createCommercialReadService(prismaCommercialReadDependencies)

export function invalidateCommercialCatalogCache(): void {
  commercialReadService.invalidateCache()
}

export const getActiveCommercialCatalog = commercialReadService.getActiveCommercialCatalog
