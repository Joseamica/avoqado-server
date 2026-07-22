import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { getStaffSchedule, replaceStaffSchedule } from '@/services/dashboard/staffSchedule.service'
import { getProductStaff, replaceProductStaff } from '@/services/dashboard/productStaff.service'

const fixtureKey = `staff-management-${process.pid}-${Date.now()}`
const organizationIds: string[] = []
const venueIds: string[] = []
const staffIds: string[] = []

let ownVenueId: string
let foreignVenueId: string
let ownActiveStaffVenueId: string
let ownInactiveMembershipId: string
let ownInactiveStaffVenueId: string
let foreignStaffVenueId: string
let ownAppointmentProductId: string
let foreignAppointmentProductId: string
let ownWrongTypeProductId: string

const originalWeekly = {
  monday: { enabled: true, ranges: [{ open: '09:00', close: '17:00' }] },
  tuesday: { enabled: true, ranges: [{ open: '09:00', close: '17:00' }] },
  wednesday: { enabled: true, ranges: [{ open: '09:00', close: '17:00' }] },
  thursday: { enabled: true, ranges: [{ open: '09:00', close: '17:00' }] },
  friday: { enabled: true, ranges: [{ open: '09:00', close: '17:00' }] },
  saturday: { enabled: false, ranges: [] },
  sunday: { enabled: false, ranges: [] },
}

const replacementWeekly = {
  ...originalWeekly,
  monday: { enabled: true, ranges: [{ open: '12:00', close: '20:00' }] },
}

async function createStaffVenue(venueId: string, suffix: string, options?: { staffActive?: boolean; membershipActive?: boolean }) {
  const staff = await prisma.staff.create({
    data: {
      email: `${fixtureKey}-${suffix}@example.test`,
      firstName: suffix,
      lastName: 'Integration',
      active: options?.staffActive ?? true,
    },
  })
  staffIds.push(staff.id)
  return prisma.staffVenue.create({
    data: { staffId: staff.id, venueId, role: 'MANAGER', active: options?.membershipActive ?? true },
  })
}

async function cleanupFixtures() {
  if (venueIds.length > 0) await prisma.venue.deleteMany({ where: { id: { in: venueIds } } })
  if (staffIds.length > 0) await prisma.staff.deleteMany({ where: { id: { in: staffIds } } })
  if (organizationIds.length > 0) await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } })
}

beforeAll(async () => {
  try {
    const ownOrg = await prisma.organization.create({
      data: { name: fixtureKey, slug: `${fixtureKey}-own`, email: `${fixtureKey}-own@example.test`, phone: '5500000000' },
    })
    organizationIds.push(ownOrg.id)
    const foreignOrg = await prisma.organization.create({
      data: {
        name: `${fixtureKey}-foreign`,
        slug: `${fixtureKey}-foreign`,
        email: `${fixtureKey}-foreign@example.test`,
        phone: '5500000001',
      },
    })
    organizationIds.push(foreignOrg.id)

    const ownVenue = await prisma.venue.create({ data: { organizationId: ownOrg.id, name: fixtureKey, slug: `${fixtureKey}-own` } })
    ownVenueId = ownVenue.id
    venueIds.push(ownVenue.id)
    const foreignVenue = await prisma.venue.create({
      data: { organizationId: foreignOrg.id, name: `${fixtureKey}-foreign`, slug: `${fixtureKey}-foreign` },
    })
    foreignVenueId = foreignVenue.id
    venueIds.push(foreignVenue.id)

    ownActiveStaffVenueId = (await createStaffVenue(ownVenueId, 'own-active')).id
    ownInactiveMembershipId = (await createStaffVenue(ownVenueId, 'inactive-membership', { membershipActive: false })).id
    ownInactiveStaffVenueId = (await createStaffVenue(ownVenueId, 'inactive-staff', { staffActive: false })).id
    foreignStaffVenueId = (await createStaffVenue(foreignVenueId, 'foreign')).id

    const ownCategory = await prisma.menuCategory.create({
      data: { venueId: ownVenueId, name: fixtureKey, slug: `${fixtureKey}-own-category` },
    })
    const foreignCategory = await prisma.menuCategory.create({
      data: { venueId: foreignVenueId, name: `${fixtureKey}-foreign`, slug: `${fixtureKey}-foreign-category` },
    })
    ownAppointmentProductId = (
      await prisma.product.create({
        data: {
          venueId: ownVenueId,
          categoryId: ownCategory.id,
          sku: `${fixtureKey}-appointment`,
          name: 'Appointment',
          type: 'APPOINTMENTS_SERVICE',
          price: new Prisma.Decimal(100),
        },
      })
    ).id
    ownWrongTypeProductId = (
      await prisma.product.create({
        data: {
          venueId: ownVenueId,
          categoryId: ownCategory.id,
          sku: `${fixtureKey}-food`,
          name: 'Not an appointment',
          type: 'FOOD_AND_BEV',
          price: new Prisma.Decimal(100),
        },
      })
    ).id
    foreignAppointmentProductId = (
      await prisma.product.create({
        data: {
          venueId: foreignVenueId,
          categoryId: foreignCategory.id,
          sku: `${fixtureKey}-foreign-appointment`,
          name: 'Foreign appointment',
          type: 'APPOINTMENTS_SERVICE',
          price: new Prisma.Decimal(100),
        },
      })
    ).id

    await prisma.productStaff.create({
      data: { venueId: ownVenueId, productId: ownAppointmentProductId, staffVenueId: ownActiveStaffVenueId },
    })
    await prisma.staffSchedule.create({
      data: { venueId: ownVenueId, staffVenueId: ownActiveStaffVenueId, weekly: originalWeekly },
    })
    await prisma.staffScheduleException.create({
      data: {
        venueId: ownVenueId,
        staffVenueId: ownActiveStaffVenueId,
        startDate: '2026-07-25',
        endDate: '2026-07-25',
        kind: 'OFF',
        note: 'original',
      },
    })
  } catch (error) {
    await cleanupFixtures()
    throw error
  }
})

afterAll(async () => {
  await cleanupFixtures()
})

async function expectOriginalMapping() {
  await expect(
    prisma.productStaff.findMany({ where: { productId: ownAppointmentProductId }, select: { staffVenueId: true } }),
  ).resolves.toEqual([{ staffVenueId: ownActiveStaffVenueId }])
}

describe('staff-management tenant and atomicity invariants', () => {
  it('rejects cross-tenant schedule and product reads without leaking foreign configuration', async () => {
    await expect(getStaffSchedule(ownVenueId, foreignStaffVenueId)).rejects.toMatchObject({ statusCode: 400 })
    await expect(getProductStaff(ownVenueId, foreignAppointmentProductId)).rejects.toMatchObject({ statusCode: 400 })
    expect(await prisma.staffSchedule.findUnique({ where: { staffVenueId: foreignStaffVenueId } })).toBeNull()
    await expectOriginalMapping()
  })

  it('rejects a foreign schedule parent without writing into either venue', async () => {
    await expect(
      replaceStaffSchedule(ownVenueId, foreignStaffVenueId, { weekly: replacementWeekly, exceptions: [] }, staffIds[0]),
    ).rejects.toMatchObject({
      statusCode: 400,
    })
    expect(await prisma.staffSchedule.findUnique({ where: { staffVenueId: foreignStaffVenueId } })).toBeNull()
    expect((await prisma.staffSchedule.findUnique({ where: { staffVenueId: ownActiveStaffVenueId } }))?.weekly).toEqual(originalWeekly)
  })

  it.each([
    ['foreign', () => foreignAppointmentProductId],
    ['wrong-type', () => ownWrongTypeProductId],
  ])('rejects a %s product with zero mapping writes', async (_caseName, productId) => {
    await expect(replaceProductStaff(ownVenueId, productId(), [], staffIds[0])).rejects.toMatchObject({ statusCode: 400 })
    await expectOriginalMapping()
  })

  it('prevalidates a mixed own/foreign list before deleting current mappings', async () => {
    await expect(
      replaceProductStaff(ownVenueId, ownAppointmentProductId, [ownActiveStaffVenueId, foreignStaffVenueId], staffIds[0]),
    ).rejects.toMatchObject({ statusCode: 400 })
    await expectOriginalMapping()
  })

  it.each([
    ['inactive membership', () => ownInactiveMembershipId],
    ['inactive Staff', () => ownInactiveStaffVenueId],
  ])('rejects %s before deleting current mappings', async (_caseName, staffVenueId) => {
    await expect(replaceProductStaff(ownVenueId, ownAppointmentProductId, [staffVenueId()], staffIds[0])).rejects.toMatchObject({
      statusCode: 400,
    })
    await expectOriginalMapping()
  })

  it('rolls back weekly and prior-exception deletion when PostgreSQL rejects a replacement exception', async () => {
    await expect(
      replaceStaffSchedule(
        ownVenueId,
        ownActiveStaffVenueId,
        {
          weekly: replacementWeekly,
          exceptions: [{ startDate: '2026-07-26', endDate: '2026-07-26', kind: 'OFF', note: 'invalid\u0000text' }],
        },
        staffIds[0],
      ),
    ).rejects.toBeTruthy()

    expect((await prisma.staffSchedule.findUnique({ where: { staffVenueId: ownActiveStaffVenueId } }))?.weekly).toEqual(originalWeekly)
    await expect(
      prisma.staffScheduleException.findMany({
        where: { staffVenueId: ownActiveStaffVenueId },
        select: { startDate: true, endDate: true, kind: true, note: true },
      }),
    ).resolves.toEqual([{ startDate: '2026-07-25', endDate: '2026-07-25', kind: 'OFF', note: 'original' }])
  })

  it('accepts an explicit empty mapping and exposes an unambiguous bridge response', async () => {
    await expect(replaceProductStaff(ownVenueId, ownAppointmentProductId, [], staffIds[0])).resolves.toEqual({
      productId: ownAppointmentProductId,
      staffVenueIds: [],
      staff: [],
      explicit: false,
    })
    await expect(getProductStaff(ownVenueId, ownAppointmentProductId)).resolves.toEqual({
      productId: ownAppointmentProductId,
      staffVenueIds: [],
      staff: [],
      explicit: false,
    })
    expect(await prisma.productStaff.count({ where: { productId: ownAppointmentProductId } })).toBe(0)
  })
})
