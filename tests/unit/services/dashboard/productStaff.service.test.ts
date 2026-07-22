const prismaMock = {
  product: { findFirst: jest.fn() },
  staffVenue: { findMany: jest.fn() },
  productStaff: { findMany: jest.fn() },
  $transaction: jest.fn(),
}

const logAction = jest.fn().mockResolvedValue(undefined)

jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: prismaMock }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction }))

import { getProductStaff, replaceProductStaff } from '@/services/dashboard/productStaff.service'
import { BadRequestError } from '@/errors/AppError'

describe('productStaff service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.product.findFirst.mockResolvedValue({ id: 'product-1' })
    prismaMock.productStaff.findMany.mockResolvedValue([])
    prismaMock.staffVenue.findMany.mockResolvedValue([])
  })

  it('tenant- and type-scopes the product lookup', async () => {
    await getProductStaff('venue-1', 'product-1')
    expect(prismaMock.product.findFirst).toHaveBeenCalledWith({
      where: { id: 'product-1', venueId: 'venue-1', type: 'APPOINTMENTS_SERVICE' },
      select: { id: true },
    })
  })

  it('rejects foreign or wrong-type products before reads or writes', async () => {
    prismaMock.product.findFirst.mockResolvedValue(null)
    await expect(replaceProductStaff('venue-1', 'product-1', ['sv-1'], 'actor')).rejects.toBeInstanceOf(BadRequestError)
    expect(prismaMock.staffVenue.findMany).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('returns the deterministic StaffVenue-to-Staff bridge without private Staff fields', async () => {
    prismaMock.productStaff.findMany.mockResolvedValue([
      { staffVenueId: 'sv-1', staffVenue: { staffId: 'staff-1' } },
      { staffVenueId: 'sv-2', staffVenue: { staffId: 'staff-2' } },
    ])
    await expect(getProductStaff('venue-1', 'product-1')).resolves.toEqual({
      productId: 'product-1',
      staffVenueIds: ['sv-1', 'sv-2'],
      staff: [
        { staffVenueId: 'sv-1', staffId: 'staff-1' },
        { staffVenueId: 'sv-2', staffId: 'staff-2' },
      ],
      explicit: true,
    })
  })

  it('stable-dedupes IDs and validates active local membership plus active Staff before deleting', async () => {
    prismaMock.staffVenue.findMany.mockResolvedValue([
      { id: 'sv-2', staffId: 'staff-2' },
      { id: 'sv-1', staffId: 'staff-1' },
    ])
    const tx = { productStaff: { deleteMany: jest.fn(), createMany: jest.fn() } }
    prismaMock.$transaction.mockImplementation((callback: any) => callback(tx))

    await expect(replaceProductStaff('venue-1', 'product-1', ['sv-1', 'sv-2', 'sv-1'], 'actor')).resolves.toEqual({
      productId: 'product-1',
      staffVenueIds: ['sv-1', 'sv-2'],
      staff: [
        { staffVenueId: 'sv-1', staffId: 'staff-1' },
        { staffVenueId: 'sv-2', staffId: 'staff-2' },
      ],
      explicit: true,
    })
    expect(prismaMock.staffVenue.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['sv-1', 'sv-2'] }, venueId: 'venue-1', active: true, staff: { active: true } },
      select: { id: true, staffId: true },
    })
    expect(tx.productStaff.createMany).toHaveBeenCalledWith({
      data: [
        { productId: 'product-1', staffVenueId: 'sv-1', venueId: 'venue-1' },
        { productId: 'product-1', staffVenueId: 'sv-2', venueId: 'venue-1' },
      ],
    })
  })

  it('performs zero writes for a mixed valid/invalid/foreign/inactive list', async () => {
    prismaMock.staffVenue.findMany.mockResolvedValue([{ id: 'sv-valid', staffId: 'staff-1' }])
    await expect(replaceProductStaff('venue-1', 'product-1', ['sv-valid', 'sv-invalid'], 'actor')).rejects.toBeInstanceOf(BadRequestError)
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('allows an empty list to intentionally delete all mappings', async () => {
    const tx = { productStaff: { deleteMany: jest.fn(), createMany: jest.fn() } }
    prismaMock.$transaction.mockImplementation((callback: any) => callback(tx))
    await expect(replaceProductStaff('venue-1', 'product-1', [], 'actor')).resolves.toEqual({
      productId: 'product-1',
      staffVenueIds: [],
      staff: [],
      explicit: false,
    })
    expect(prismaMock.staffVenue.findMany).not.toHaveBeenCalled()
    expect(tx.productStaff.deleteMany).toHaveBeenCalledWith({ where: { productId: 'product-1', venueId: 'venue-1' } })
    expect(tx.productStaff.createMany).not.toHaveBeenCalled()
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ staffId: 'actor', venueId: 'venue-1', action: 'SERVICE_STAFF_UPDATED' }),
    )
  })

  it('logs only after the transaction settles successfully', async () => {
    prismaMock.$transaction.mockRejectedValue(new Error('write failed'))
    await expect(replaceProductStaff('venue-1', 'product-1', [], 'actor')).rejects.toThrow('write failed')
    expect(logAction).not.toHaveBeenCalled()
  })
})
