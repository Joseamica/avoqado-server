import {
  createCatalogPublicationOutboxService,
  deliverCatalogPublicationEventV1,
  enqueueCatalogPublicationOutboxTx,
  serializeCatalogPublicationEventsV1,
} from '@/services/master-catalog/catalogPublicationOutbox.service'

const NOW = new Date('2026-08-09T12:00:00.000Z')

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'event-1',
    organizationId: 'org-1',
    batchId: 'batch-1',
    venueId: 'venue-1',
    venueSequence: 4n,
    eventKind: 'CATALOG_PUBLICATION_SERIALIZERS_V1',
    payloadVersion: 1,
    payload: {
      schemaVersion: 1,
      menuItems: [
        {
          itemId: 'product-1',
          itemName: 'Uno',
          sku: 'SKU-1',
          categoryId: 'category-1',
          categoryName: 'Cat',
          price: 12,
          available: true,
          imageUrl: null,
          description: null,
          modifierGroupIds: [],
        },
      ],
      menu: { updateType: 'PARTIAL_UPDATE', productIds: ['product-1'], categoryIds: ['category-1'], reason: 'CATEGORY_UPDATED' },
      priceChanges: [],
    },
    dedupeKey: 'catalog-publication:batch-1:venue-1:refetch:v1',
    status: 'PENDING',
    attempts: 1,
    claimedBy: 'worker-1',
    claimExpiresAt: new Date('2026-08-09T12:00:30.000Z'),
    ...overrides,
  }
}

describe('catalogPublicationOutbox.service', () => {
  it('coalesces one event per venue with monotonic sequence and deterministic dedupe key', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([
        { venueId: 'venue-1', venueSequence: 8n },
        { venueId: 'venue-2', venueSequence: 3n },
      ]),
      product: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'product-1',
            venueId: 'venue-1',
            name: 'Uno',
            sku: 'SKU-1',
            categoryId: 'category-1',
            price: { toString: () => '10.00' },
            active: true,
            imageUrl: null,
            description: 'Desc',
            category: { name: 'Categoría' },
            modifierGroups: [],
          },
          {
            id: 'product-2',
            venueId: 'venue-2',
            name: 'Dos',
            sku: 'SKU-2',
            categoryId: 'category-2',
            price: { toString: () => '20.00' },
            active: true,
            imageUrl: null,
            description: null,
            category: { name: 'Otra' },
            modifierGroups: [],
          },
        ]),
      },
      catalogPublicationOutbox: { createMany: jest.fn().mockResolvedValue({ count: 2 }) },
    }
    const randomId = jest.fn().mockReturnValueOnce('event-1').mockReturnValueOnce('event-2')

    await enqueueCatalogPublicationOutboxTx(tx as never, {
      organizationId: 'org-1',
      publicationBatchId: 'batch-1',
      operation: 'CATALOG_FIELDS_PUBLISH',
      targets: [
        { venueId: 'venue-2', productId: 'product-2' },
        { venueId: 'venue-1', productId: 'product-1' },
        { venueId: 'venue-2', productId: 'product-2' },
      ],
      randomId,
      now: NOW,
    })

    const sequenceSql = tx.$queryRaw.mock.calls[0][0].strings.join('?')
    expect(sequenceSql).toContain('CatalogVenueEventSequence')
    expect(sequenceSql).toContain('ON CONFLICT')
    expect(tx.catalogPublicationOutbox.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          id: 'event-1',
          venueId: 'venue-1',
          venueSequence: 8n,
          dedupeKey: 'catalog-publication:batch-1:venue-1:refetch:v1',
        }),
        expect.objectContaining({ id: 'event-2', venueId: 'venue-2', venueSequence: 3n }),
      ]),
    })
  })

  it('serializes only supported socket contracts and maps a zero old price percent to null', async () => {
    const payload = serializeCatalogPublicationEventsV1(
      [
        {
          productId: 'product-1',
          productName: 'Uno',
          sku: 'SKU-1',
          categoryId: 'category-1',
          categoryName: 'Cat',
          price: 12,
          available: true,
          imageUrl: null,
          description: 'Desc',
          modifierGroupIds: [],
        },
      ],
      [
        {
          productId: 'product-1',
          productName: 'Uno',
          sku: 'SKU-1',
          categoryId: 'category-1',
          categoryName: 'Cat',
          oldPrice: 0,
          newPrice: 12,
        },
      ],
    )
    expect(payload.priceChanges[0]).toMatchObject({ priceChange: 12, priceChangePercent: null })

    const broadcaster = {
      broadcastMenuItemUpdated: jest.fn(),
      broadcastProductPriceChanged: jest.fn(),
      broadcastMenuUpdated: jest.fn(),
    }
    await deliverCatalogPublicationEventV1(
      {
        eventId: 'event-1',
        organizationId: 'org-1',
        publicationBatchId: 'batch-1',
        venueId: 'venue-1',
        venueSequence: '4',
        eventKind: 'CATALOG_PUBLICATION_SERIALIZERS_V1',
        payloadVersion: 1,
        payload,
      },
      broadcaster,
    )
    expect(broadcaster.broadcastMenuItemUpdated).toHaveBeenCalledWith(
      'venue-1',
      expect.objectContaining({ itemId: 'product-1', metadata: expect.objectContaining({ eventId: 'event-1' }) }),
    )
    expect(broadcaster.broadcastProductPriceChanged).toHaveBeenCalledWith('venue-1', expect.objectContaining({ priceChangePercent: null }))
    expect(broadcaster.broadcastMenuUpdated).toHaveBeenCalledWith('venue-1', expect.objectContaining({ productIds: ['product-1'] }))
  })

  it('rejects corrupt nested v1 serializer fields before any broadcast', async () => {
    const broadcaster = {
      broadcastMenuItemUpdated: jest.fn(),
      broadcastProductPriceChanged: jest.fn(),
      broadcastMenuUpdated: jest.fn(),
    }
    const corrupt = {
      schemaVersion: 1,
      menuItems: [
        {
          itemId: 'product-1',
          itemName: 'Uno',
          sku: 99,
          categoryId: 'category-1',
          categoryName: 'Cat',
          price: 12,
          available: 'yes',
          imageUrl: null,
          description: null,
          modifierGroupIds: [42],
        },
      ],
      menu: {
        updateType: 'PARTIAL_UPDATE',
        productIds: [42],
        categoryIds: [17],
        reason: 'CATEGORY_UPDATED',
      },
      priceChanges: [{ bogus: true }],
    }

    await expect(
      deliverCatalogPublicationEventV1(
        {
          eventId: 'event-1',
          organizationId: 'org-1',
          publicationBatchId: 'batch-1',
          venueId: 'venue-1',
          venueSequence: '4',
          eventKind: 'CATALOG_PUBLICATION_SERIALIZERS_V1',
          payloadVersion: 1,
          payload: corrupt,
        },
        broadcaster,
      ),
    ).rejects.toThrow('CATALOG_OUTBOX_PAYLOAD_UNSUPPORTED')
    expect(broadcaster.broadcastMenuItemUpdated).not.toHaveBeenCalled()
    expect(broadcaster.broadcastProductPriceChanged).not.toHaveBeenCalled()
    expect(broadcaster.broadcastMenuUpdated).not.toHaveBeenCalled()
  })

  it('claims only the earliest undelivered venue sequence and acknowledges by exact lease CAS', async () => {
    const claimed = row()
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([claimed]),
      catalogPublicationOutbox: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    }
    const prisma = { $transaction: jest.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) }
    const emit = jest.fn().mockResolvedValue(undefined)
    const service = createCatalogPublicationOutboxService({ prisma: prisma as never, emit, now: () => NOW })

    await expect(service.sweepOnce({ workerId: 'worker-1', limit: 10 })).resolves.toEqual({ claimed: 1, delivered: 1, failed: 0 })

    const claimSql = tx.$queryRaw.mock.calls[0][0].strings.join('?')
    expect(claimSql).toContain('FOR UPDATE SKIP LOCKED')
    expect(claimSql).toContain('NOT EXISTS')
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'event-1', venueId: 'venue-1', venueSequence: '4' }))
    expect(tx.catalogPublicationOutbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'event-1', status: 'PENDING', claimedBy: 'worker-1' }),
        data: expect.objectContaining({ status: 'DELIVERED', deliveredAt: NOW }),
      }),
    )
  })

  it('backs off safely and dead-letters at the bounded maximum attempt', async () => {
    const claimed = row({ attempts: 8 })
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([claimed]),
      catalogPublicationOutbox: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    }
    const prisma = { $transaction: jest.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) }
    const emit = jest.fn().mockRejectedValue(new Error(`secret-${'x'.repeat(900)}`))
    const service = createCatalogPublicationOutboxService({ prisma: prisma as never, emit, now: () => NOW })

    await expect(service.sweepOnce({ workerId: 'worker-1', limit: 10 })).resolves.toEqual({ claimed: 1, delivered: 0, failed: 1 })

    const failure = tx.catalogPublicationOutbox.updateMany.mock.calls[0][0]
    expect(failure.data.status).toBe('DEAD_LETTER')
    expect(failure.data.lastError).toBe('Error')
    expect(failure.data.lastError).not.toContain('secret')
    expect(failure.data.lastError.length).toBeLessThanOrEqual(256)
  })

  it('uses the same eventId on an emit-before-ack retry', async () => {
    const claimed = row()
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([claimed]),
      catalogPublicationOutbox: {
        updateMany: jest.fn().mockRejectedValueOnce(new Error('ack crashed')).mockResolvedValue({ count: 1 }),
      },
    }
    const prisma = { $transaction: jest.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) }
    const emit = jest.fn().mockResolvedValue(undefined)
    const service = createCatalogPublicationOutboxService({ prisma: prisma as never, emit, now: () => NOW })

    await expect(service.sweepOnce({ workerId: 'worker-1', limit: 1 })).rejects.toThrow('ack crashed')
    await expect(service.sweepOnce({ workerId: 'worker-1', limit: 1 })).resolves.toMatchObject({ delivered: 1 })
    expect(emit.mock.calls.map(call => call[0].eventId)).toEqual(['event-1', 'event-1'])
  })

  it.each([
    ['future payload version', row({ payloadVersion: 2 })],
    ['unknown event kind', row({ eventKind: 'UNKNOWN' })],
    ['malformed payload', row({ payload: { schemaVersion: 1 } })],
  ])('fails closed before emit for %s', async (_label, corrupt) => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([corrupt]),
      catalogPublicationOutbox: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    }
    const prisma = { $transaction: jest.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) }
    const emit = jest.fn()
    const service = createCatalogPublicationOutboxService({ prisma: prisma as never, emit, now: () => NOW })

    await expect(service.sweepOnce({ workerId: 'worker-1', limit: 1 })).resolves.toMatchObject({ failed: 1 })
    expect(emit).not.toHaveBeenCalled()
  })
})
