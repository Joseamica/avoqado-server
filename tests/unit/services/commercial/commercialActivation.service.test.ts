import { createCommercialActivationService } from '@/services/commercial/commercialActivation.service'
import commercialFixture from '@/contracts/commercial/fixtures/catalog-v1.json'
import commercialV2Fixture from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import { COMMERCIAL_V2_DOMAINS } from '@/contracts/commercial/commercialContractV2.constants'
import { hashCanonicalJsonV2 } from '@/services/commercial/commercialCanonicalJsonV2.service'
import { hashCanonicalJsonV1 } from '@/services/master-catalog/catalogHash.service'
import type { CommercialCatalogActivationOutboxRecord, CommercialCatalogPersistedRow } from '@/types/commercialCodec'
import type { CommercialCatalogSnapshotV2 } from '@/types/commercialV2'
import offerFixture from '@/contracts/commercial/fixtures/v3/commercial-offer-v3.json'
import { emitCommercialOfferV3 } from '@/services/commercial/offers/commercialOfferV3.service'
import type { CommercialOfferSnapshotV3, VerifiedStoredCommercialOfferV3 } from '@/types/commercialOfferV3'

const actor = {
  staffId: 'staff_1',
  reason: 'Activar publicación aprobada',
  permissions: ['commercial:publish'],
}

function publicationV1(id: string, publishedAt: Date) {
  const snapshot = { ...commercialFixture, publicationId: id, publishedAt: publishedAt.toISOString() }
  return {
    id,
    checksum: hashCanonicalJsonV1('commercial-catalog-snapshot-v1', snapshot),
    schemaVersion: 1,
    snapshot,
    publishedAt,
  }
}

function publicationV2(id: string, publishedAt: Date): CommercialCatalogPersistedRow {
  const snapshot = JSON.parse(JSON.stringify(commercialV2Fixture)) as CommercialCatalogSnapshotV2
  snapshot.publicationId = id
  snapshot.publishedAt = publishedAt.toISOString()
  return {
    id,
    checksum: hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.CATALOG_SNAPSHOT, snapshot),
    schemaVersion: 2,
    snapshot,
    publishedAt,
  }
}

function incompatibleEligibleOffer(): VerifiedStoredCommercialOfferV3 {
  const source = JSON.parse(JSON.stringify(offerFixture)) as CommercialOfferSnapshotV3
  const benefit = source.benefits.find(candidate => candidate.kind === 'SAAS_PRICE')!
  if (benefit.kind !== 'SAAS_PRICE') throw new Error('Expected SAAS_PRICE benefit')
  const original = benefit.rules[0]
  benefit.rules = [
    JSON.parse(JSON.stringify(original)),
    { ...JSON.parse(JSON.stringify(original)), code: 'POS_PERCENT_05', type: 'PERCENT_OFF', priority: 80, percentBasisPoints: 500 },
    { ...JSON.parse(JSON.stringify(original)), code: 'POS_PERCENT_10', type: 'PERCENT_OFF', priority: 90, percentBasisPoints: 1000 },
  ]
  delete (benefit.rules[1] as { amount?: string }).amount
  delete (benefit.rules[2] as { amount?: string }).amount
  benefit.rules.sort((left, right) => (left.code < right.code ? -1 : 1))
  benefit.stackingGroups = [
    {
      code: 'POS_STRICT_SUBSET',
      steps: [
        { position: 1, ruleCode: 'POS_FIXED_50' },
        { position: 2, ruleCode: 'POS_PERCENT_10' },
      ],
    },
  ]
  return { ...emitCommercialOfferV3(source), verified: true }
}

function activationRecord(
  revision: number,
  publication: CommercialCatalogPersistedRow,
  previousPublication: CommercialCatalogPersistedRow | null,
  eventType: 'PUBLICATION_ACTIVATED' | 'PUBLICATION_ROLLED_BACK' = 'PUBLICATION_ACTIVATED',
): CommercialCatalogActivationOutboxRecord {
  const dedupeKey = `commercial:activation:${revision}:${publication.id}`
  const occurredAt = new Date(`2026-08-${20 + revision}T12:00:00.000Z`)
  return {
    id: `event-${revision}`,
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
      occurredAt: occurredAt.toISOString(),
    },
    dedupeKey,
    createdAt: occurredAt,
    publication,
    previousPublication,
  }
}

function createActivationServiceForTransaction<T extends { getEligibleOffers(now: Date): Promise<readonly VerifiedStoredCommercialOfferV3[]> }>(
  tx: T,
  now?: () => Date,
) {
  return createCommercialActivationService({
    ...(now ? { now } : {}),
    runInTransaction: operation => operation(tx as never),
    runWithEligibleOffers: async (eligibilityNow, operation) =>
      operation(tx as never, await tx.getEligibleOffers(eligibilityNow)),
  })
}

describe('commercial publication activation', () => {
  it('exposes a separately named emergency v1 reactivation operation', () => {
    const service = createCommercialActivationService({
      runInTransaction: jest.fn() as never,
      runWithEligibleOffers: jest.fn() as never,
    })

    expect((service as unknown as Record<string, unknown>).emergencyReactivateCommercialPublicationV1).toEqual(expect.any(Function))
  })

  it('reactivates only a registry-valid v1 member of the proved chain with the emergency audit action', async () => {
    const historicalV1 = publicationV1('catalog-v1', new Date('2026-08-20T12:00:00.000Z'))
    const activeV2 = publicationV2('catalog-v2', new Date('2026-08-21T12:00:00.000Z'))
    const events = [activationRecord(1, historicalV1, null), activationRecord(2, activeV2, historicalV1)]
    const tx = {
      getEligibleOffers: jest.fn().mockResolvedValue([]),
      lockProductionState: jest.fn().mockResolvedValue({
        pointer: {
          environment: 'PRODUCTION',
          publicationId: activeV2.id,
          revision: 2,
          publication: activeV2,
        },
        activationEvents: events,
      }),
      getPublication: jest.fn().mockResolvedValue(historicalV1),
      movePointerIfRevision: jest.fn().mockResolvedValue({
        publicationId: historicalV1.id,
        previousPublicationId: activeV2.id,
        revision: 3,
      }),
      writeAudit: jest.fn(),
      enqueue: jest.fn(),
    }
    const service = createActivationServiceForTransaction(tx, () => new Date('2026-08-27T12:00:00.000Z')) as unknown as {
      emergencyReactivateCommercialPublicationV1(input: unknown, actor: unknown): Promise<unknown>
    }

    await expect(
      service.emergencyReactivateCommercialPublicationV1(
        {
          publicationId: historicalV1.id,
          expectedActivationRevision: 2,
          reason: 'Restaurar compatibilidad v1 durante el incidente',
          confirm: true,
        },
        actor,
      ),
    ).resolves.toEqual({
      publicationId: historicalV1.id,
      previousPublicationId: activeV2.id,
      revision: 3,
      emergency: true,
    })
    expect(tx.writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'COMMERCIAL_PUBLICATION_V1_EMERGENCY_REACTIVATED' }))
    expect(tx.getEligibleOffers).not.toHaveBeenCalled()
    expect(tx.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'PUBLICATION_ROLLED_BACK',
        publication: expect.objectContaining({ id: historicalV1.id, schemaVersion: 1 }),
        activationRevision: 3,
      }),
    )
  })

  it('returns an emergency no-op when the exact verified v1 target is already active', async () => {
    const activeV1 = publicationV1('catalog-v1-active', new Date('2026-08-20T12:00:00.000Z'))
    const tx = {
      getEligibleOffers: jest.fn().mockResolvedValue([]),
      lockProductionState: jest.fn().mockResolvedValue({
        pointer: {
          environment: 'PRODUCTION',
          publicationId: activeV1.id,
          revision: 1,
          publication: activeV1,
        },
        activationEvents: [activationRecord(1, activeV1, null)],
      }),
      getPublication: jest.fn().mockResolvedValue(activeV1),
      movePointerIfRevision: jest.fn(),
      writeAudit: jest.fn(),
      enqueue: jest.fn(),
    }
    const service = createActivationServiceForTransaction(tx)

    await expect(
      service.emergencyReactivateCommercialPublicationV1(
        { publicationId: activeV1.id, expectedActivationRevision: 1, reason: 'Confirmar estado v1 activo', confirm: true },
        actor,
      ),
    ).resolves.toEqual({
      publicationId: activeV1.id,
      previousPublicationId: activeV1.id,
      revision: 1,
      emergency: true,
      noOp: true,
    })
    expect(tx.movePointerIfRevision).not.toHaveBeenCalled()
    expect(tx.getEligibleOffers).not.toHaveBeenCalled()
    expect(tx.writeAudit).not.toHaveBeenCalled()
    expect(tx.enqueue).not.toHaveBeenCalled()
  })

  it('rejects a never-active v1 emergency target with zero effects', async () => {
    const activeV2 = publicationV2('catalog-v2-only', new Date('2026-08-21T12:00:00.000Z'))
    const neverActiveV1 = publicationV1('catalog-v1-never-active', new Date('2026-08-20T12:00:00.000Z'))
    const tx = {
      getEligibleOffers: jest.fn().mockResolvedValue([]),
      lockProductionState: jest.fn().mockResolvedValue({
        pointer: {
          environment: 'PRODUCTION',
          publicationId: activeV2.id,
          revision: 1,
          publication: activeV2,
        },
        activationEvents: [activationRecord(1, activeV2, null)],
      }),
      getPublication: jest.fn().mockResolvedValue(neverActiveV1),
      movePointerIfRevision: jest.fn(),
      writeAudit: jest.fn(),
      enqueue: jest.fn(),
    }
    const service = createActivationServiceForTransaction(tx)

    await expect(
      service.emergencyReactivateCommercialPublicationV1(
        {
          publicationId: neverActiveV1.id,
          expectedActivationRevision: 1,
          reason: 'Intento de emergencia no autorizado por historial',
          confirm: true,
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_CATALOG_V1_EMERGENCY_ROLLBACK_INVALID' })
    expect(tx.movePointerIfRevision).not.toHaveBeenCalled()
    expect(tx.writeAudit).not.toHaveBeenCalled()
    expect(tx.enqueue).not.toHaveBeenCalled()
  })

  it('blocks normal activation when the current dense chain is incomplete', async () => {
    const historical = publicationV2('catalog-history', new Date('2026-08-20T12:00:00.000Z'))
    const active = publicationV2('catalog-active', new Date('2026-08-21T12:00:00.000Z'))
    const target = publicationV2('catalog-next', new Date('2026-08-22T12:00:00.000Z'))
    const tx = {
      getEligibleOffers: jest.fn().mockResolvedValue([]),
      lockProductionState: jest.fn().mockResolvedValue({
        pointer: { environment: 'PRODUCTION', publicationId: active.id, revision: 2, publication: active },
        activationEvents: [activationRecord(2, active, historical)],
      }),
      getPublication: jest.fn().mockResolvedValue(target),
      movePointerIfRevision: jest.fn(),
      writeAudit: jest.fn(),
      enqueue: jest.fn(),
    }
    const service = createActivationServiceForTransaction(tx)

    await expect(
      service.activateCommercialPublication(
        { publicationId: target.id, expectedActivationRevision: 2, reason: actor.reason, confirm: true },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_CATALOG_AUTHORITY_INVALID' })
    expect(tx.getPublication).not.toHaveBeenCalled()
    expect(tx.movePointerIfRevision).not.toHaveBeenCalled()
    expect(tx.writeAudit).not.toHaveBeenCalled()
    expect(tx.enqueue).not.toHaveBeenCalled()
  })

  it('classifies activation from proved membership instead of timestamps and preserves same-head re-invalidation', async () => {
    let current: { publicationId: string; revision: number } | null = null
    const audit: unknown[] = []
    const outbox: CommercialCatalogActivationOutboxRecord[] = []
    const publications = new Map([
      ['catalog-a', publicationV2('catalog-a', new Date('2026-08-25T12:00:00Z'))],
      ['catalog-b', publicationV2('catalog-b', new Date('2026-08-20T12:00:00Z'))],
    ])
    const tx = {
      getEligibleOffers: jest.fn().mockResolvedValue([]),
      lockProductionState: jest.fn(async () => ({
        pointer: current
          ? {
              environment: 'PRODUCTION' as const,
              publicationId: current.publicationId,
              revision: current.revision,
              publication: publications.get(current.publicationId)!,
            }
          : null,
        activationEvents: [...outbox],
      })),
      getPublication: jest.fn(async (id: string) => publications.get(id) ?? null),
      movePointerIfRevision: jest.fn(async (publicationId: string, expectedRevision: number) => {
        const actualRevision = current?.revision ?? 0
        if (actualRevision !== expectedRevision) return null
        const previousPublicationId = current?.publicationId ?? null
        current = { publicationId, revision: actualRevision + 1 }
        return { publicationId, previousPublicationId, revision: actualRevision + 1 }
      }),
      writeAudit: jest.fn(async value => {
        audit.push(value)
      }),
      enqueue: jest.fn(async value => {
        const previousPublication = value.previousPublicationId ? (publications.get(value.previousPublicationId) ?? null) : null
        outbox.push(activationRecord(value.activationRevision, value.publication, previousPublication, value.eventType))
      }),
    }
    const service = createActivationServiceForTransaction(tx, () => new Date(`2026-08-${26 + outbox.length}T12:00:00.000Z`))

    for (const [publicationId, expectedActivationRevision] of [
      ['catalog-a', 0],
      ['catalog-b', 1],
      ['catalog-a', 2],
      ['catalog-b', 3],
      ['catalog-b', 4],
    ] as const) {
      await service.activateCommercialPublication({ publicationId, expectedActivationRevision, reason: actor.reason, confirm: true }, actor)
    }

    expect(current).toEqual({ publicationId: 'catalog-b', revision: 5 })
    expect(tx.lockProductionState).toHaveBeenCalledTimes(5)
    expect(audit).toHaveLength(5)
    expect(outbox.map(item => item.eventType)).toEqual([
      'PUBLICATION_ACTIVATED',
      'PUBLICATION_ACTIVATED',
      'PUBLICATION_ROLLED_BACK',
      'PUBLICATION_ROLLED_BACK',
      'PUBLICATION_ACTIVATED',
    ])
  })

  it('rejects stale activation revisions without audit or outbox', async () => {
    const tx = {
      getEligibleOffers: jest.fn().mockResolvedValue([]),
      lockProductionState: jest.fn().mockResolvedValue({ pointer: null, activationEvents: [] }),
      getPublication: jest.fn().mockResolvedValue(publicationV2('pub_new', new Date('2026-08-21T12:00:00Z'))),
      movePointerIfRevision: jest.fn().mockResolvedValue(null),
      writeAudit: jest.fn(),
      enqueue: jest.fn(),
    }
    const service = createActivationServiceForTransaction(tx)

    await expect(
      service.activateCommercialPublication(
        { publicationId: 'pub_new', expectedActivationRevision: 8, reason: actor.reason, confirm: true },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_ACTIVATION_REVISION_CONFLICT' })
    expect(tx.writeAudit).not.toHaveBeenCalled()
    expect(tx.enqueue).not.toHaveBeenCalled()
  })

  it('rejects activation or rollback to a Catalog incompatible with an eligible Offer before moving the pointer', async () => {
    const target = publicationV2('pub_incompatible', new Date('2026-08-21T12:00:00Z'))
    const tx = {
      getEligibleOffers: jest.fn().mockResolvedValue([]),
      lockProductionState: jest.fn().mockResolvedValue({ pointer: null, activationEvents: [] }),
      getPublication: jest.fn().mockResolvedValue(target),
      movePointerIfRevision: jest.fn(),
      writeAudit: jest.fn(),
      enqueue: jest.fn(),
    }
    const runWithEligibleOffers = jest.fn(async (_now: Date, operation: any) => operation(tx, [incompatibleEligibleOffer()]))
    const service = createCommercialActivationService({
      runInTransaction: operation => operation(tx),
      runWithEligibleOffers,
    })

    await expect(
      service.activateCommercialPublication(
        { publicationId: target.id, expectedActivationRevision: 0, reason: actor.reason, confirm: true },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_CATALOG_OFFER_INCOMPATIBLE' })
    expect(runWithEligibleOffers).toHaveBeenCalledTimes(1)
    expect(tx.getEligibleOffers).not.toHaveBeenCalled()
    expect(tx.movePointerIfRevision).not.toHaveBeenCalled()
    expect(tx.writeAudit).not.toHaveBeenCalled()
    expect(tx.enqueue).not.toHaveBeenCalled()
  })

  it('refuses normal activation of a registry-valid v1 row with the stable v2-required code', async () => {
    const v1 = publicationV1('pub_v1', new Date('2026-08-21T12:00:00Z'))
    const tx = {
      getEligibleOffers: jest.fn().mockResolvedValue([]),
      lockProductionState: jest.fn().mockResolvedValue({ pointer: null, activationEvents: [] }),
      getPublication: jest.fn().mockResolvedValue(v1),
      movePointerIfRevision: jest.fn(),
      writeAudit: jest.fn(),
      enqueue: jest.fn(),
    }
    const service = createActivationServiceForTransaction(tx)

    await expect(
      service.activateCommercialPublication(
        { publicationId: 'pub_v1', expectedActivationRevision: 0, reason: actor.reason, confirm: true },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_CATALOG_ACTIVATION_V2_REQUIRED' })
    expect(tx.movePointerIfRevision).not.toHaveBeenCalled()
    expect(tx.writeAudit).not.toHaveBeenCalled()
    expect(tx.enqueue).not.toHaveBeenCalled()
  })

  it('refuses a tampered v2 target before pointer, audit or outbox effects', async () => {
    const corrupt = publicationV2('pub_corrupt', new Date('2026-08-21T12:00:00Z'))
    const tx = {
      getEligibleOffers: jest.fn().mockResolvedValue([]),
      lockProductionState: jest.fn().mockResolvedValue({ pointer: null, activationEvents: [] }),
      getPublication: jest.fn().mockResolvedValue({
        ...corrupt,
        checksum: 'f'.repeat(64),
      }),
      movePointerIfRevision: jest.fn(),
      writeAudit: jest.fn(),
      enqueue: jest.fn(),
    }
    const service = createActivationServiceForTransaction(tx)

    await expect(
      service.activateCommercialPublication(
        { publicationId: 'pub_corrupt', expectedActivationRevision: 0, reason: actor.reason, confirm: true },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_CATALOG_ACTIVATION_V2_REQUIRED' })
    expect(tx.movePointerIfRevision).not.toHaveBeenCalled()
    expect(tx.writeAudit).not.toHaveBeenCalled()
    expect(tx.enqueue).not.toHaveBeenCalled()
  })
})
