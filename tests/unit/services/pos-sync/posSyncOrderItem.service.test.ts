import { prismaMock } from '../../../__helpers__/setup'
import { processPosOrderItemEvent } from '../../../../src/services/pos-sync/posSyncOrderItem.service'
import {
  assertLegacyCatalogGovernanceForVenue,
  writeLegacyServiceProductCreationAuditForVenue,
} from '../../../../src/services/master-catalog/catalogGovernance.service'
import AppError, { NotFoundError } from '../../../../src/errors/AppError'

jest.mock('../../../../src/services/master-catalog/catalogGovernance.service', () => ({
  assertLegacyCatalogGovernanceForVenue: jest.fn().mockResolvedValue(undefined),
  writeLegacyServiceProductCreationAuditForVenue: jest.fn().mockResolvedValue(undefined),
}))

const payload = {
  venueId: 'venue-1',
  parentOrderExternalId: 'order-ext-1',
  itemData: {
    externalId: 'item-ext-1',
    deleted: false,
    productExternalId: 'product-ext-1',
    productName: 'Producto POS',
    quantity: 1,
    unitPrice: 25,
    total: 25,
  },
}

describe('posSyncOrderItem.service — governed Product placeholder', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.order.findUnique.mockResolvedValue({ id: 'order-1' } as never)
    // Real lock contract: the parent is still this venue's order, and it keeps the payload's key under the lock.
    prismaMock.$queryRaw.mockResolvedValue([{ id: 'order-1' }])
    prismaMock.order.findFirst.mockResolvedValue({ id: 'order-1' } as never)
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock))
    prismaMock.orderItem.upsert.mockResolvedValue({ id: 'item-1', externalId: 'item-ext-1' } as never)
  })

  it('reuses a Product created while waiting for the Venue fence without a duplicate CREATE audit', async () => {
    prismaMock.product.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'product-concurrent' } as never)

    await processPosOrderItemEvent(payload)

    expect(assertLegacyCatalogGovernanceForVenue).toHaveBeenCalledTimes(1)
    expect(prismaMock.product.upsert).not.toHaveBeenCalled()
    expect(writeLegacyServiceProductCreationAuditForVenue).not.toHaveBeenCalled()
    expect(prismaMock.orderItem.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ product: { connect: { id: 'product-concurrent' } } }),
      }),
    )
  })

  it('writes exactly one SERVICE audit after the Product create and before OrderItem persistence', async () => {
    prismaMock.product.findUnique.mockResolvedValue(null)
    prismaMock.product.upsert.mockResolvedValue({ id: 'product-new' } as never)

    await processPosOrderItemEvent(payload)

    expect(prismaMock.product.upsert.mock.calls[0][0].create).not.toHaveProperty('createdById')
    expect(writeLegacyServiceProductCreationAuditForVenue).toHaveBeenCalledWith(prismaMock, {
      venueId: 'venue-1',
      productId: 'product-new',
      actor: { type: 'SERVICE', servicePrincipalId: 'POS_SYNC' },
    })
    expect((prismaMock.product.upsert as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (writeLegacyServiceProductCreationAuditForVenue as jest.Mock).mock.invocationCallOrder[0],
    )
    expect((writeLegacyServiceProductCreationAuditForVenue as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (prismaMock.orderItem.upsert as jest.Mock).mock.invocationCallOrder[0],
    )
  })

  it('does not persist the OrderItem when SERVICE provenance fails in the transaction', async () => {
    prismaMock.product.findUnique.mockResolvedValue(null)
    prismaMock.product.upsert.mockResolvedValue({ id: 'product-new' } as never)
    ;(writeLegacyServiceProductCreationAuditForVenue as jest.Mock).mockRejectedValueOnce(new Error('audit unavailable'))

    await expect(processPosOrderItemEvent(payload)).rejects.toThrow('audit unavailable')
    expect(prismaMock.orderItem.upsert).not.toHaveBeenCalled()
  })

  it('blocks an effective-ENFORCED placeholder before Product and OrderItem writes', async () => {
    prismaMock.product.findUnique.mockResolvedValue(null)
    ;(assertLegacyCatalogGovernanceForVenue as jest.Mock).mockRejectedValueOnce(
      new AppError('governed', 422, true, 'CATALOG_GOVERNANCE_REQUIRED'),
    )

    await expect(processPosOrderItemEvent(payload)).rejects.toMatchObject({
      statusCode: 422,
      code: 'CATALOG_GOVERNANCE_REQUIRED',
    })

    // WHY: POS Product creation and its OrderItem are one atomic operation;
    // an enforced fence rejection must precede both durable effects.
    expect(prismaMock.product.upsert).not.toHaveBeenCalled()
    expect(writeLegacyServiceProductCreationAuditForVenue).not.toHaveBeenCalled()
    expect(prismaMock.orderItem.upsert).not.toHaveBeenCalled()
  })
})

describe('posSyncOrderItem.service — line events serialized on the parent Order (Plan 3b T6)', () => {
  const PARENT = { id: 'order-1' }
  const PARENT_NOT_FOUND = 'La orden padre order-ext-1 no fue encontrada. No se puede procesar el item.'
  type ItemEvent = Parameters<typeof processPosOrderItemEvent>[0]
  const event = (itemData: Partial<ItemEvent['itemData']> = {}): ItemEvent => ({
    ...payload,
    itemData: { ...payload.itemData, ...itemData },
  })
  const at = (fn: unknown) => (fn as jest.Mock).mock.invocationCallOrder[0]

  /** A transaction double that shares no function with the global client. */
  function lineTx() {
    return {
      $queryRaw: jest.fn().mockResolvedValue([PARENT]),
      order: {
        findUnique: jest.fn().mockResolvedValue(PARENT),
        findFirst: jest.fn().mockResolvedValue(PARENT),
        update: jest.fn(),
        updateMany: jest.fn(),
        upsert: jest.fn(),
      },
      product: {
        findUnique: jest.fn().mockResolvedValue({ id: 'product-existing' }),
        upsert: jest.fn().mockResolvedValue({ id: 'product-new' }),
      },
      orderItem: {
        upsert: jest.fn().mockResolvedValue({ id: 'item-1', externalId: 'item-ext-1' }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    }
  }
  type LineTx = ReturnType<typeof lineTx>
  /** Each attempt gets its own transaction, in order; an unexpected extra attempt falls to the rejecting global client. */
  function runIn(...txs: LineTx[]) {
    for (const tx of txs) prismaMock.$transaction.mockImplementationOnce(async (callback: (client: LineTx) => unknown) => callback(tx))
  }

  beforeEach(() => {
    // Every read and write must go through the line transaction: the global client rejects if touched.
    const globalUse = () => Promise.reject(new Error('global client used outside the line transaction'))
    for (const fn of [
      prismaMock.$queryRaw,
      prismaMock.order.findUnique,
      prismaMock.order.findFirst,
      prismaMock.product.findUnique,
      prismaMock.product.upsert,
      prismaMock.orderItem.upsert,
      prismaMock.orderItem.delete,
      prismaMock.orderItem.deleteMany,
    ])
      fn.mockImplementation(globalUse)
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock))
  })

  it('resolves, locks and rereads the parent inside the transaction before writing the line, and never touches the header money', async () => {
    const tx = lineTx()
    runIn(tx)

    await expect(processPosOrderItemEvent(event())).resolves.toMatchObject({ id: 'item-1' })

    expect(tx.order.findUnique).toHaveBeenCalledWith({
      where: { venueId_externalId: { venueId: 'venue-1', externalId: 'order-ext-1' } },
      select: { id: true },
    })
    // lockExistingOrderForPayment: SELECT id FROM "Order" WHERE id = ? AND "venueId" = ? FOR UPDATE
    expect(tx.$queryRaw.mock.calls[0].slice(1)).toEqual(['order-1', 'venue-1'])
    expect(tx.order.findFirst).toHaveBeenCalledWith({
      where: { id: 'order-1', venueId: 'venue-1', externalId: 'order-ext-1' },
      select: { id: true },
    })
    expect(at(tx.order.findUnique)).toBeLessThan(at(tx.$queryRaw))
    expect(at(tx.$queryRaw)).toBeLessThan(at(tx.order.findFirst))
    expect(at(tx.order.findFirst)).toBeLessThan(at(tx.orderItem.upsert))
    // Existing Product: the fast path never takes the Venue fence.
    expect(assertLegacyCatalogGovernanceForVenue).not.toHaveBeenCalled()
    // The imported POS header is the monetary authority: a line event never rewrites the Order's money. It only touches
    // `updatedAt`, after the line and in the same transaction, so the POS floor plan version (tablesVersion) moves.
    expect(tx.order.update).toHaveBeenCalledTimes(1)
    expect(tx.order.update).toHaveBeenCalledWith({ where: { id: 'order-1' }, data: { updatedAt: expect.any(Date) } })
    expect(at(tx.orderItem.upsert)).toBeLessThan(at(tx.order.update))
    expect(tx.order.updateMany).not.toHaveBeenCalled()
    expect(tx.order.upsert).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
  })

  it('keeps the upsert field semantics: defaults only on create, omitted fields stay undefined on update, productId never updated', async () => {
    const tx = lineTx()
    runIn(tx)

    await processPosOrderItemEvent(
      event({
        quantity: undefined,
        unitPrice: undefined,
        discountAmount: undefined,
        taxAmount: undefined,
        total: undefined,
        notes: null,
        sequence: 3,
      }),
    )

    const args = tx.orderItem.upsert.mock.calls[0][0]
    expect(args.where).toEqual({ orderId_externalId: { orderId: 'order-1', externalId: 'item-ext-1' } })
    expect(args.update).toStrictEqual({
      quantity: undefined,
      unitPrice: undefined,
      discountAmount: undefined,
      taxAmount: undefined,
      total: undefined,
      notes: null,
      posRawData: undefined,
      syncStatus: 'SYNCED',
      lastSyncAt: expect.any(Date),
      sequence: 3,
    })
    expect(args.create).toStrictEqual({
      order: { connect: { id: 'order-1' } },
      product: { connect: { id: 'product-existing' } },
      externalId: 'item-ext-1',
      quantity: 1,
      unitPrice: 0,
      discountAmount: 0,
      taxAmount: 0,
      total: 0,
      notes: null,
      posRawData: undefined,
      originSystem: 'POS_SOFTRESTAURANT',
      syncStatus: 'SYNCED',
      sequence: 3,
      lastSyncAt: expect.any(Date),
    })
  })

  it('an unknown parent is not found before any fence or lock, as before', async () => {
    const tx = lineTx()
    tx.order.findUnique.mockResolvedValue(null)
    tx.product.findUnique.mockResolvedValue(null)
    runIn(tx)

    await expect(processPosOrderItemEvent(event())).rejects.toThrow(PARENT_NOT_FOUND)
    expect(assertLegacyCatalogGovernanceForVenue).not.toHaveBeenCalled()
    expect(tx.$queryRaw).not.toHaveBeenCalled()
  })

  it('a parent that left the venue or vanished before the lock is not found and nothing is written', async () => {
    const tx = lineTx()
    tx.$queryRaw.mockResolvedValue([])
    runIn(tx)

    await expect(processPosOrderItemEvent(event())).rejects.toThrow(PARENT_NOT_FOUND)
    expect(tx.order.findFirst).not.toHaveBeenCalled()
    expect(tx.orderItem.upsert).not.toHaveBeenCalled()
    expect(tx.product.upsert).not.toHaveBeenCalled()
  })

  it('a parent whose natural key no longer names it under the lock is not found either', async () => {
    const tx = lineTx()
    tx.order.findFirst.mockResolvedValue(null)
    runIn(tx)

    await expect(processPosOrderItemEvent(event())).rejects.toBeInstanceOf(NotFoundError)
    expect(tx.orderItem.upsert).not.toHaveBeenCalled()
  })

  it('a delete runs after the lock in the same transaction, and an absent line still answers deleted', async () => {
    const tx = lineTx()
    tx.orderItem.deleteMany.mockResolvedValue({ count: 0 })
    runIn(tx)

    await expect(processPosOrderItemEvent(event({ deleted: true }))).resolves.toEqual({ id: 'item-ext-1', deleted: true })
    expect(tx.orderItem.deleteMany).toHaveBeenCalledWith({ where: { orderId: 'order-1', externalId: 'item-ext-1' } })
    expect(at(tx.order.findFirst)).toBeLessThan(at(tx.orderItem.deleteMany))
    // Nothing was deleted: nothing changed for /tables, so the parent is not touched.
    expect(tx.order.update).not.toHaveBeenCalled()
    expect(tx.product.findUnique).not.toHaveBeenCalled()
    expect(assertLegacyCatalogGovernanceForVenue).not.toHaveBeenCalled()
  })

  it('a missing product takes the Venue fence BEFORE the Order lock, then writes placeholder, audit and line after it', async () => {
    const tx = lineTx()
    tx.product.findUnique.mockResolvedValue(null)
    runIn(tx)

    await expect(processPosOrderItemEvent(event())).resolves.toMatchObject({ id: 'item-1' })

    expect(assertLegacyCatalogGovernanceForVenue).toHaveBeenCalledWith(tx, {
      venueId: 'venue-1',
      operation: 'CREATE',
      willBeVendable: true,
      actor: { type: 'SERVICE', servicePrincipalId: 'POS_SYNC' },
    })
    expect(at(assertLegacyCatalogGovernanceForVenue)).toBeLessThan(at(tx.$queryRaw))
    expect(at(tx.$queryRaw)).toBeLessThan(at(tx.product.upsert))
    expect(at(tx.product.upsert)).toBeLessThan(at(writeLegacyServiceProductCreationAuditForVenue))
    expect(at(writeLegacyServiceProductCreationAuditForVenue)).toBeLessThan(at(tx.orderItem.upsert))
    expect(writeLegacyServiceProductCreationAuditForVenue).toHaveBeenCalledWith(tx, {
      venueId: 'venue-1',
      productId: 'product-new',
      actor: { type: 'SERVICE', servicePrincipalId: 'POS_SYNC' },
    })
    expect(tx.orderItem.upsert.mock.calls[0][0].create.product).toEqual({ connect: { id: 'product-new' } })
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
  })

  it('a product that vanished while the fast path waited rolls back and retries ONCE with the Venue fence first', async () => {
    const fast = lineTx()
    fast.product.findUnique.mockResolvedValueOnce({ id: 'product-existing' }).mockResolvedValue(null)
    const fenced = lineTx()
    fenced.product.findUnique.mockResolvedValue(null)
    runIn(fast, fenced)

    await expect(processPosOrderItemEvent(event())).resolves.toMatchObject({ id: 'item-1' })

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2)
    // First attempt: fast path without fence; once the Product is gone it writes nothing and gives up its transaction.
    expect(fast.product.upsert).not.toHaveBeenCalled()
    expect(fast.orderItem.upsert).not.toHaveBeenCalled()
    // Retry: fence, then Order lock, then placeholder + audit + line, all on the retry's own transaction.
    expect(assertLegacyCatalogGovernanceForVenue).toHaveBeenCalledTimes(1)
    expect(assertLegacyCatalogGovernanceForVenue).toHaveBeenCalledWith(fenced, expect.objectContaining({ venueId: 'venue-1' }))
    expect(at(assertLegacyCatalogGovernanceForVenue)).toBeLessThan(at(fenced.$queryRaw))
    expect(at(fenced.$queryRaw)).toBeLessThan(at(fenced.product.upsert))
    expect(writeLegacyServiceProductCreationAuditForVenue).toHaveBeenCalledWith(
      fenced,
      expect.objectContaining({ productId: 'product-new' }),
    )
    expect(fenced.orderItem.upsert.mock.calls[0][0].create.product).toEqual({ connect: { id: 'product-new' } })
  })

  it('a governance denial on a first fenced attempt is not retried', async () => {
    const denial = new AppError('governed', 422, true, 'CATALOG_GOVERNANCE_REQUIRED')
    const tx = lineTx()
    tx.product.findUnique.mockResolvedValue(null)
    runIn(tx)
    ;(assertLegacyCatalogGovernanceForVenue as jest.Mock).mockRejectedValueOnce(denial)

    await expect(processPosOrderItemEvent(event())).rejects.toBe(denial)
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(tx.$queryRaw).not.toHaveBeenCalled()
    expect(tx.product.upsert).not.toHaveBeenCalled()
    expect(tx.orderItem.upsert).not.toHaveBeenCalled()
  })

  it('a governance denial on the fenced retry is not retried again', async () => {
    const denial = new AppError('governed', 422, true, 'CATALOG_GOVERNANCE_REQUIRED')
    const fast = lineTx()
    fast.product.findUnique.mockResolvedValueOnce({ id: 'product-existing' }).mockResolvedValue(null)
    const fenced = lineTx()
    fenced.product.findUnique.mockResolvedValue(null)
    runIn(fast, fenced)
    ;(assertLegacyCatalogGovernanceForVenue as jest.Mock).mockRejectedValueOnce(denial)

    await expect(processPosOrderItemEvent(event())).rejects.toBe(denial)
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2)
    expect(fenced.$queryRaw).not.toHaveBeenCalled()
    expect(fast.orderItem.upsert).not.toHaveBeenCalled()
    expect(fenced.orderItem.upsert).not.toHaveBeenCalled()
  })
})
