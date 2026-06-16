import prisma from '@/utils/prismaClient'
import { upsertVenueAssignment } from '@/services/superadmin/staff.superadmin.service'
import AppError from '@/errors/AppError'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staff: { findUnique: jest.fn() },
    venue: { findUnique: jest.fn() },
    staffOrganization: { findUnique: jest.fn() },
    staffVenue: { findFirst: jest.fn(), upsert: jest.fn() },
  },
}))

const m = prisma as unknown as {
  staff: { findUnique: jest.Mock }
  venue: { findUnique: jest.Mock }
  staffOrganization: { findUnique: jest.Mock }
  staffVenue: { findFirst: jest.Mock; upsert: jest.Mock }
}

const healthy = () => {
  m.staff.findUnique.mockResolvedValue({ id: 'staff-1' })
  m.venue.findUnique.mockResolvedValue({ id: 'venue-1', organizationId: 'org-1', name: 'V' })
  m.staffOrganization.findUnique.mockResolvedValue({ isActive: true })
  m.staffVenue.findFirst.mockResolvedValue(null)
  m.staffVenue.upsert.mockResolvedValue({})
}

describe('upsertVenueAssignment', () => {
  beforeEach(() => jest.clearAllMocks())

  it('upserts the StaffVenue when staff ∈ org and PIN is free', async () => {
    healthy()
    await upsertVenueAssignment(prisma as any, 'staff-1', 'venue-1', 'MANAGER' as any, '3987')
    expect(m.staffVenue.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { staffId_venueId: { staffId: 'staff-1', venueId: 'venue-1' } },
        update: expect.objectContaining({ role: 'MANAGER', pin: '3987', active: true, endDate: null }),
        create: expect.objectContaining({ staffId: 'staff-1', venueId: 'venue-1', role: 'MANAGER', pin: '3987', active: true }),
      }),
    )
  })

  it('rejects when staff does not belong to the venue org', async () => {
    healthy()
    m.staffOrganization.findUnique.mockResolvedValue(null)
    await expect(upsertVenueAssignment(prisma as any, 'staff-1', 'venue-1', 'MANAGER' as any)).rejects.toThrow(
      'no pertenece a la organización',
    )
    expect(m.staffVenue.upsert).not.toHaveBeenCalled()
  })

  it('rejects when the PIN is already used by someone else in the venue', async () => {
    healthy()
    m.staffVenue.findFirst.mockResolvedValue({ id: 'other' })
    await expect(upsertVenueAssignment(prisma as any, 'staff-1', 'venue-1', 'WAITER' as any, '3987')).rejects.toThrow('PIN ya está en uso')
    expect(m.staffVenue.upsert).not.toHaveBeenCalled()
  })

  // Regression: these validation failures MUST be AppError instances. The global error
  // handler (app.ts) only honors a custom statusCode + message when `err instanceof AppError`;
  // a plain Error with a monkey-patched .statusCode falls through to a generic HTTP 500,
  // which is exactly the "error genérico sin retroalimentación" the migration wizard hit.
  it('throws a ConflictError (409 AppError) when the PIN collides — not a generic 500', async () => {
    healthy()
    m.staffVenue.findFirst.mockResolvedValue({ id: 'other' })
    const err = await upsertVenueAssignment(prisma as any, 'staff-1', 'venue-1', 'WAITER' as any, '3987').catch(e => e)
    expect(err).toBeInstanceOf(AppError)
    expect(err.statusCode).toBe(409)
    expect(err.isOperational).toBe(true)
    expect(err.message).toMatch('PIN ya está en uso')
  })

  it('throws a 400 AppError when the staff does not belong to the venue org', async () => {
    healthy()
    m.staffOrganization.findUnique.mockResolvedValue(null)
    const err = await upsertVenueAssignment(prisma as any, 'staff-1', 'venue-1', 'MANAGER' as any).catch(e => e)
    expect(err).toBeInstanceOf(AppError)
    expect(err.statusCode).toBe(400)
  })

  it('throws a 404 AppError when the venue does not exist', async () => {
    healthy()
    m.venue.findUnique.mockResolvedValue(null)
    const err = await upsertVenueAssignment(prisma as any, 'staff-1', 'venue-1', 'MANAGER' as any).catch(e => e)
    expect(err).toBeInstanceOf(AppError)
    expect(err.statusCode).toBe(404)
  })
})
