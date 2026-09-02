import catalogV1Fixture from '@/contracts/commercial/fixtures/catalog-v1.json'
import catalogV2Fixture from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import { COMMERCIAL_V2_DOMAINS } from '@/contracts/commercial/commercialContractV2.constants'
import { hashCanonicalJsonV2 } from '@/services/commercial/commercialCanonicalJsonV2.service'
import { hashCanonicalJsonV1 } from '@/services/master-catalog/catalogHash.service'
import * as catalogAuthorityModule from '@/services/commercial/commercialCatalogAuthority.service'
import type { CommercialCatalogActivationOutboxRecord, CommercialCatalogPersistedRow } from '@/types/commercialCodec'
import type { CommercialCatalogSnapshotV1 } from '@/types/commercial'
import type { CommercialCatalogSnapshotV2 } from '@/types/commercialV2'

function activeV2Row(): CommercialCatalogPersistedRow {
  const snapshot = JSON.parse(JSON.stringify(catalogV2Fixture)) as CommercialCatalogSnapshotV2
  snapshot.publicationId = 'catalog-active-v2'
  snapshot.publishedAt = '2026-08-27T12:00:00.000Z'
  return {
    id: snapshot.publicationId,
    schemaVersion: 2,
    snapshot,
    checksum: hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.CATALOG_SNAPSHOT, snapshot),
    publishedAt: new Date(snapshot.publishedAt),
  }
}

function futureV2Row(): CommercialCatalogPersistedRow {
  const row = activeV2Row()
  const snapshot = JSON.parse(JSON.stringify(row.snapshot)) as CommercialCatalogSnapshotV2
  snapshot.publicationId = 'catalog-active-future'
  snapshot.publishedAt = '2026-08-28T12:00:00.000Z'
  snapshot.contractVersion = '3.0.0' as '2.0.0'
  return {
    id: snapshot.publicationId,
    schemaVersion: 2,
    snapshot,
    checksum: hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.CATALOG_SNAPSHOT, snapshot),
    publishedAt: new Date(snapshot.publishedAt),
  }
}

function activationEvent(
  revision: number,
  publication: CommercialCatalogPersistedRow,
  previousPublication: CommercialCatalogPersistedRow | null,
): CommercialCatalogActivationOutboxRecord {
  const eventType = 'PUBLICATION_ACTIVATED' as const
  const dedupeKey = `commercial:activation:${revision}:${publication.id}`
  return {
    id: `catalog-activation-${revision}`,
    eventType,
    publicationId: publication.id,
    previousPublicationId: previousPublication?.id ?? null,
    payloadVersion: 1,
    payload: {
      eventId: dedupeKey,
      type: eventType,
      publicationId: publication.id,
      previousPublicationId: previousPublication?.id ?? null,
      schemaVersion: publication.schemaVersion,
      checksum: publication.checksum,
      occurredAt: `2026-08-${25 + revision}T15:00:00.000Z`,
    },
    dedupeKey,
    createdAt: new Date(`2026-08-${25 + revision}T15:00:00.000Z`),
    publication,
    previousPublication,
  }
}

function activeV1Row(): CommercialCatalogPersistedRow {
  const snapshot = JSON.parse(JSON.stringify(catalogV1Fixture)) as CommercialCatalogSnapshotV1
  snapshot.publicationId = 'catalog-active-v1'
  snapshot.publishedAt = '2026-08-26T12:00:00.000Z'
  return {
    id: snapshot.publicationId,
    schemaVersion: 1,
    snapshot,
    checksum: hashCanonicalJsonV1('commercial-catalog-snapshot-v1', snapshot),
    publishedAt: new Date(snapshot.publishedAt),
  }
}

function serviceForPointer(pointer: unknown) {
  const getActivationEvents = jest.fn()
  const getProductionPointer = jest.fn().mockResolvedValue(pointer)
  const runInRepeatableRead = jest.fn(async operation => operation({ getProductionPointer, getActivationEvents }))
  return {
    service: catalogAuthorityModule.createCommercialCatalogAuthorityService({ runInRepeatableRead }),
    getActivationEvents,
    getProductionPointer,
    runInRepeatableRead,
  }
}

describe('commercial catalog authority', () => {
  it('provides an injectable authority factory for one-snapshot verification', () => {
    expect((catalogAuthorityModule as Record<string, unknown>).createCommercialCatalogAuthorityService).toEqual(expect.any(Function))
  })

  it('registry-verifies an active v2 row without loading unused activation history', async () => {
    const publication = activeV2Row()
    const { service, getActivationEvents, getProductionPointer, runInRepeatableRead } = serviceForPointer({
      environment: 'PRODUCTION',
      publicationId: publication.id,
      revision: 7,
      publication,
    })

    const result = await service.readVerifiedActiveCatalog()

    expect(result).toMatchObject({
      catalog: { kind: 'CATALOG', schemaVersion: 2, mode: 'READ_WRITE', checksum: publication.checksum },
      fallback: null,
    })
    expect(runInRepeatableRead).toHaveBeenCalledTimes(1)
    expect(getProductionPointer).toHaveBeenCalledTimes(1)
    expect(getActivationEvents).not.toHaveBeenCalled()
  })

  it('serves an independently valid active v1 row without consulting broken or unused history', async () => {
    const publication = activeV1Row()
    const { service, getActivationEvents } = serviceForPointer({
      environment: 'PRODUCTION',
      publicationId: publication.id,
      revision: 4,
      publication,
    })

    await expect(service.readVerifiedActiveCatalog()).resolves.toMatchObject({
      catalog: { kind: 'CATALOG', schemaVersion: 1, mode: 'READ_ONLY', checksum: publication.checksum },
      fallback: null,
    })
    expect(getActivationEvents).not.toHaveBeenCalled()
  })

  it('returns null when the production pointer does not exist', async () => {
    const { service, getActivationEvents } = serviceForPointer(null)

    await expect(service.readVerifiedActiveCatalog()).resolves.toBeNull()
    expect(getActivationEvents).not.toHaveBeenCalled()
  })

  it('rejects a joined row that does not match the production pointer identity', async () => {
    const publication = activeV2Row()
    const { service, getActivationEvents } = serviceForPointer({
      environment: 'PRODUCTION',
      publicationId: 'catalog-pointed-somewhere-else',
      revision: 1,
      publication,
    })

    await expect(service.readVerifiedActiveCatalog()).rejects.toMatchObject({
      code: 'COMMERCIAL_CATALOG_AUTHORITY_INVALID',
    })
    expect(getActivationEvents).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'unknown schema',
      mutate: (row: CommercialCatalogPersistedRow) => ({ ...row, schemaVersion: 99 }),
      code: 'COMMERCIAL_CATALOG_VERSION_UNSUPPORTED',
    },
    {
      name: 'malformed snapshot',
      mutate: (row: CommercialCatalogPersistedRow) => ({ ...row, snapshot: { schemaVersion: 2 } }),
      code: 'COMMERCIAL_CATALOG_AUTHORITY_INVALID',
    },
    {
      name: 'checksum mismatch',
      mutate: (row: CommercialCatalogPersistedRow) => ({ ...row, checksum: 'f'.repeat(64) }),
      code: 'COMMERCIAL_CATALOG_AUTHORITY_INVALID',
    },
    {
      name: 'row and snapshot identity mismatch',
      mutate: (row: CommercialCatalogPersistedRow) => ({ ...row, id: 'different-row-id' }),
      code: 'COMMERCIAL_CATALOG_AUTHORITY_INVALID',
    },
  ])('fails closed with a stable classification for $name', async ({ mutate, code }) => {
    const publication = mutate(activeV2Row())
    const { service, getActivationEvents } = serviceForPointer({
      environment: 'PRODUCTION',
      publicationId: publication.id,
      revision: 1,
      publication,
    })

    await expect(service.readVerifiedActiveCatalog()).rejects.toMatchObject({ code })
    expect(getActivationEvents).not.toHaveBeenCalled()
  })

  it('serves a compatible v2 predecessor only from the complete proved chain of a future contract', async () => {
    const compatible = activeV2Row()
    const active = futureV2Row()
    const { service, getActivationEvents } = serviceForPointer({
      environment: 'PRODUCTION',
      publicationId: active.id,
      revision: 2,
      publication: active,
    })
    getActivationEvents.mockResolvedValue([activationEvent(2, active, compatible), activationEvent(1, compatible, null)])

    await expect(service.readVerifiedActiveCatalog()).resolves.toMatchObject({
      catalog: { kind: 'CATALOG', schemaVersion: 2, checksum: compatible.checksum },
      fallback: {
        fallbackUsed: true,
        activePublicationId: active.id,
        fallbackPublicationId: compatible.id,
        incidentCode: 'COMMERCIAL_CATALOG_CONTRACT_UNSUPPORTED',
      },
    })
    expect(getActivationEvents).toHaveBeenCalledTimes(1)
  })

  it('classifies broken future-contract provenance as authority invalid', async () => {
    const active = futureV2Row()
    const { service, getActivationEvents } = serviceForPointer({
      environment: 'PRODUCTION',
      publicationId: active.id,
      revision: 2,
      publication: active,
    })
    getActivationEvents.mockResolvedValue([activationEvent(2, active, null)])

    await expect(service.readVerifiedActiveCatalog()).rejects.toMatchObject({
      code: 'COMMERCIAL_CATALOG_AUTHORITY_INVALID',
    })
    expect(getActivationEvents).toHaveBeenCalledTimes(1)
  })

  it('classifies a proved future contract with no compatible predecessor as version unsupported', async () => {
    const active = futureV2Row()
    const { service, getActivationEvents } = serviceForPointer({
      environment: 'PRODUCTION',
      publicationId: active.id,
      revision: 1,
      publication: active,
    })
    getActivationEvents.mockResolvedValue([activationEvent(1, active, null)])

    await expect(service.readVerifiedActiveCatalog()).rejects.toMatchObject({
      code: 'COMMERCIAL_CATALOG_VERSION_UNSUPPORTED',
    })
    expect(getActivationEvents).toHaveBeenCalledTimes(1)
  })
})
