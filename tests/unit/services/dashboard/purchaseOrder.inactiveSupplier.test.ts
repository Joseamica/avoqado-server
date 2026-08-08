/**
 * You do not buy from a deactivated supplier.
 *
 * In the PITS matrix this is answered as "naturally compliant". It was not:
 * `createPurchaseOrder` looked the supplier up by `{ id, venueId }` and never looked at
 * `active` or `deletedAt`, so deactivating a supplier did not stop anyone from keeping on
 * buying from them.
 *
 * And there was no second safety net: `deleteSupplier` refuses to delete a supplier that
 * has even ONE order, which means any supplier with history can only be taken out of play
 * with `active: false`. If that flag is not honored when creating the order, deactivating
 * a supplier means absolutely nothing.
 */

import { Decimal } from '@prisma/client/runtime/library'
import { prismaMock } from '../../../__helpers__/setup'
import { createPurchaseOrder } from '@/services/dashboard/purchaseOrder.service'
import { updateSupplier } from '@/services/dashboard/supplier.service'
import AppError from '@/errors/AppError'

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/services/email.service', () => ({ sendEmail: jest.fn() }))

const VENUE = 'venue-1'
const SUPPLIER = 'clsupplier000000000000001'
const RM = 'clrawmaterial00000000001'

const order = {
  supplierId: SUPPLIER,
  orderDate: new Date().toISOString(),
  taxRate: 0.16,
  commissionRate: 0,
  shippingAddressType: 'VENUE' as const,
  items: [{ rawMaterialId: RM, quantityOrdered: 10, unitPrice: 25 }],
}

function supplier(over: Record<string, unknown> = {}) {
  return { id: SUPPLIER, name: 'Distribuidora del Bajío', minimumOrder: null, active: true, deletedAt: null, ...over }
}

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.rawMaterial.findMany.mockResolvedValue([{ id: RM, unit: 'PIECE' }])
  prismaMock.purchaseOrder.findFirst.mockResolvedValue(null)
  prismaMock.purchaseOrder.count.mockResolvedValue(0)
  prismaMock.purchaseOrder.create.mockResolvedValue({ id: 'po-1', orderNumber: 'OC-001', supplierId: SUPPLIER, items: [] })
})

describe('creating a purchase order: the supplier has to be current', () => {
  it('🔴 rejects a deactivated supplier (active: false)', async () => {
    prismaMock.supplier.findFirst.mockResolvedValue(supplier({ active: false }))

    await expect(createPurchaseOrder(VENUE, order as never)).rejects.toThrow(AppError)
    expect(prismaMock.purchaseOrder.create).not.toHaveBeenCalled()
  })

  it('also rejects a deleted one that was left with active: true', async () => {
    // An inconsistent state that really was reachable: `updateSupplier` did not filter by
    // `deletedAt`, so an already-deleted supplier could be reactivated by id.
    prismaMock.supplier.findFirst.mockResolvedValue(supplier({ active: true, deletedAt: new Date() }))

    await expect(createPurchaseOrder(VENUE, order as never)).rejects.toThrow(AppError)
    expect(prismaMock.purchaseOrder.create).not.toHaveBeenCalled()
  })

  it('the message tells "deactivated" apart from "does not exist", and says how to fix it', async () => {
    // Whoever is entering the order has to be able to tell whether they picked the wrong
    // supplier or purchasing decided to stop buying from them. A generic 404 sends them
    // hunting for a bug that does not exist.
    prismaMock.supplier.findFirst.mockResolvedValue(supplier({ active: false }))

    await expect(createPurchaseOrder(VENUE, order as never)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('Distribuidora del Bajío'),
    })
  })

  it('a nonexistent supplier still returns 404, not 400', async () => {
    prismaMock.supplier.findFirst.mockResolvedValue(null)

    await expect(createPurchaseOrder(VENUE, order as never)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('REGRESSION: a current supplier can still be bought from exactly as before', async () => {
    prismaMock.supplier.findFirst.mockResolvedValue(supplier())

    await createPurchaseOrder(VENUE, order as never)

    expect(prismaMock.purchaseOrder.create).toHaveBeenCalledTimes(1)
  })

  it('REGRESSION: the minimum order amount is still evaluated', async () => {
    // The new guard runs BEFORE the minimum check; we have to confirm it did not leave that
    // check unreachable.
    prismaMock.supplier.findFirst.mockResolvedValue(supplier({ minimumOrder: new Decimal(99999) }))

    await expect(createPurchaseOrder(VENUE, order as never)).rejects.toThrow(AppError)
    expect(prismaMock.purchaseOrder.create).not.toHaveBeenCalled()
  })
})

describe('a deleted supplier cannot be resurrected by id', () => {
  it('🔴 editing a deleted supplier returns 404 instead of reactivating it', async () => {
    // Without this, you were left with a supplier that was INVISIBLE (absent from every
    // listing, since they all filter by deletedAt) but still purchasable by id. The exact
    // opposite of deactivating them.
    prismaMock.supplier.findFirst.mockResolvedValue(null) // the deletedAt: null filter no longer finds it

    await expect(updateSupplier(VENUE, SUPPLIER, { active: true } as never)).rejects.toMatchObject({ statusCode: 404 })
    expect(prismaMock.supplier.update).not.toHaveBeenCalled()
  })

  it('the query explicitly asks for deletedAt: null', async () => {
    prismaMock.supplier.findFirst.mockResolvedValue(supplier())
    prismaMock.supplier.update.mockResolvedValue(supplier({ name: 'Nuevo nombre' }))

    await updateSupplier(VENUE, SUPPLIER, { name: 'Nuevo nombre' } as never)

    expect(prismaMock.supplier.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ deletedAt: null }) }),
    )
  })

  it('REGRESSION: a current supplier can still be edited', async () => {
    prismaMock.supplier.findFirst.mockResolvedValue(supplier())
    prismaMock.supplier.update.mockResolvedValue(supplier({ name: 'Nuevo nombre' }))

    const result = await updateSupplier(VENUE, SUPPLIER, { name: 'Nuevo nombre' } as never)

    expect(result.name).toBe('Nuevo nombre')
  })
})
