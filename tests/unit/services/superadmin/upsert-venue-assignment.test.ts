import prisma from '@/utils/prismaClient'
import { upsertVenueAssignment } from '@/services/superadmin/staff.superadmin.service'
import AppError from '@/errors/AppError'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staff: { findUnique: jest.fn() },
    venue: { findUnique: jest.fn() },
    staffOrganization: { findUnique: jest.fn() },
    staffVenue: { findFirst: jest.fn(), update: jest.fn(), upsert: jest.fn() },
  },
}))

const m = prisma as unknown as {
  staff: { findUnique: jest.Mock }
  venue: { findUnique: jest.Mock }
  staffOrganization: { findUnique: jest.Mock }
  staffVenue: { findFirst: jest.Mock; update: jest.Mock; upsert: jest.Mock }
}

const healthy = () => {
  m.staff.findUnique.mockResolvedValue({ id: 'staff-1' })
  m.venue.findUnique.mockResolvedValue({ id: 'venue-1', organizationId: 'org-1', name: 'V' })
  m.staffOrganization.findUnique.mockResolvedValue({ isActive: true })
  m.staffVenue.findFirst.mockResolvedValue(null)
  m.staffVenue.update.mockResolvedValue({})
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

  it('rejects when the PIN is already used by an ACTIVE someone else in the venue', async () => {
    healthy()
    m.staffVenue.findFirst.mockResolvedValue({ id: 'other', staffId: 'other-staff', active: true })
    await expect(upsertVenueAssignment(prisma as any, 'staff-1', 'venue-1', 'WAITER' as any, '3987')).rejects.toThrow('PIN ya está en uso')
    expect(m.staffVenue.upsert).not.toHaveBeenCalled()
  })

  // The DB constraint is @@unique([venueId, pin]) with NO active condition — it counts
  // deactivated rows too. The pre-check must therefore look at ALL rows, not just active
  // ones: filtering by active:true is exactly what turned Isaac's grant into an opaque
  // P2002 → 500 ("No se pudo dar el acceso", PlayTelecom 2026-08-31).
  it('checks the PIN against ALL rows (no active filter) — the query shape matches the DB unique', async () => {
    healthy()
    await upsertVenueAssignment(prisma as any, 'staff-1', 'venue-1', 'WAITER' as any, '3987')
    expect(m.staffVenue.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { venueId: 'venue-1', pin: '3987', staffId: { not: 'staff-1' } },
      }),
    )
    const where = m.staffVenue.findFirst.mock.calls[0][0].where
    expect(where).not.toHaveProperty('active')
  })

  it('frees the PIN held by an INACTIVE row (persona dada de baja) and proceeds with the grant', async () => {
    healthy()
    m.staffVenue.findFirst.mockResolvedValue({ id: 'sv-old', staffId: 'ex-staff', active: false })
    const result = await upsertVenueAssignment(prisma as any, 'staff-1', 'venue-1', 'WAITER' as any, '3987')
    // The stale holder's pin is cleared IN THE SAME client/tx, before the upsert…
    expect(m.staffVenue.update).toHaveBeenCalledWith({ where: { id: 'sv-old' }, data: { pin: null } })
    // …so the upsert no longer violates (venueId, pin) and the grant succeeds.
    expect(m.staffVenue.upsert).toHaveBeenCalled()
    expect(result.freedPin).toEqual({ staffVenueId: 'sv-old', staffId: 'ex-staff' })
  })

  it('does not touch other rows when the PIN is free', async () => {
    healthy()
    const result = await upsertVenueAssignment(prisma as any, 'staff-1', 'venue-1', 'WAITER' as any, '3987')
    expect(m.staffVenue.update).not.toHaveBeenCalled()
    expect(result.freedPin).toBeNull()
  })

  // Regression: these validation failures MUST be AppError instances. The global error
  // handler (app.ts) only honors a custom statusCode + message when `err instanceof AppError`;
  // a plain Error with a monkey-patched .statusCode falls through to a generic HTTP 500,
  // which is exactly the "error genérico sin retroalimentación" the migration wizard hit.
  it('throws a ConflictError (409 AppError) when the PIN collides — not a generic 500', async () => {
    healthy()
    m.staffVenue.findFirst.mockResolvedValue({ id: 'other', staffId: 'other-staff', active: true })
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
