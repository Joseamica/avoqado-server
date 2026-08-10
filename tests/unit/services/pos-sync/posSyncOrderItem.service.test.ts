import { prismaMock } from '../../../__helpers__/setup'
import { processPosOrderItemEvent } from '../../../../src/services/pos-sync/posSyncOrderItem.service'
import {
  assertLegacyCatalogGovernanceForVenue,
  writeLegacyServiceProductCreationAuditForVenue,
} from '../../../../src/services/master-catalog/catalogGovernance.service'
import AppError from '../../../../src/errors/AppError'

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
