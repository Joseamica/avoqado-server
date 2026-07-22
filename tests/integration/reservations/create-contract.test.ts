import { Prisma, PrismaClient } from '@prisma/client'

jest.mock('@/communication/rabbitmq/gcal-push-consumer', () => ({
  __esModule: true,
  publishPushNotification: jest.fn().mockResolvedValue(undefined),
}))

import prisma from '@/utils/prismaClient'
import { BadRequestError } from '@/errors/AppError'
import { createReservation } from '@/services/dashboard/reservation.dashboard.service'

const fixtureKey = `reservation-create-contract-${process.pid}-${Date.now()}`
const inspector = new PrismaClient()
const venueIds: string[] = []
let organizationId: string
let venueId: string
let foreignVenueId: string
let productA: string
let productB: string
let foreignProduct: string
let modifierId: string
let sequence = 0

function nextWindow(durationMin: number) {
  sequence += 1
  const startsAt = new Date(Date.now() + (48 * 60 + sequence * 180) * 60_000)
  startsAt.setUTCSeconds(0, 0)
  return { startsAt, endsAt: new Date(startsAt.getTime() + durationMin * 60_000) }
}

async function createVenue(suffix: string) {
  const venue = await prisma.venue.create({
    data: {
      organizationId,
      name: `${fixtureKey}-${suffix}`,
      slug: `${fixtureKey}-${suffix}`,
      timezone: 'UTC',
    },
  })
  venueIds.push(venue.id)
  const category = await prisma.menuCategory.create({
    data: {
      venueId: venue.id,
      name: `${fixtureKey}-${suffix}-services`,
      slug: `${fixtureKey}-${suffix}-services`,
      availableDays: [],
    },
  })
  await prisma.reservationSettings.create({
    data: {
      venueId: venue.id,
      minNoticeMin: 0,
      maxAdvanceDays: 365,
      capacityMode: 'pacing',
      googleCalendarPushEnabled: false,
    },
  })
  return { venue, category }
}

async function createAppointment(args: { venueId: string; categoryId: string; suffix: string; duration: number; price: number }) {
  return prisma.product.create({
    data: {
      venueId: args.venueId,
      categoryId: args.categoryId,
      sku: `${fixtureKey}-${args.suffix}`,
      name: `${fixtureKey}-${args.suffix}`,
      type: 'APPOINTMENTS_SERVICE',
      duration: args.duration,
      price: new Prisma.Decimal(args.price),
      tags: [],
      allergens: [],
    },
  })
}

async function cleanupFixtures() {
  if (venueIds.length > 0) await prisma.venue.deleteMany({ where: { id: { in: venueIds } } })
  if (organizationId) await prisma.organization.deleteMany({ where: { id: organizationId } })
}

beforeAll(async () => {
  try {
    const organization = await prisma.organization.create({
      data: {
        name: fixtureKey,
        slug: fixtureKey,
        email: `${fixtureKey}@example.test`,
        phone: '5500000000',
      },
    })
    organizationId = organization.id

    const local = await createVenue('local')
    const foreign = await createVenue('foreign')
    venueId = local.venue.id
    foreignVenueId = foreign.venue.id

    const [first, second, foreignRow] = await Promise.all([
      createAppointment({ venueId, categoryId: local.category.id, suffix: 'a', duration: 60, price: 500 }),
      createAppointment({ venueId, categoryId: local.category.id, suffix: 'b', duration: 30, price: 300 }),
      createAppointment({ venueId: foreignVenueId, categoryId: foreign.category.id, suffix: 'foreign', duration: 30, price: 200 }),
    ])
    productA = first.id
    productB = second.id
    foreignProduct = foreignRow.id

    const group = await prisma.modifierGroup.create({
      data: { venueId, name: `${fixtureKey}-extras`, required: false, allowMultiple: true },
    })
    const modifier = await prisma.modifier.create({
      data: { groupId: group.id, name: 'Tiempo extra', price: new Prisma.Decimal(25), durationMin: 15 },
    })
    modifierId = modifier.id
    await prisma.productModifierGroup.create({ data: { productId: productA, groupId: group.id } })
  } catch (error) {
    await cleanupFixtures()
    throw error
  }
})

beforeEach(async () => {
  sequence = 0
  await prisma.reservation.deleteMany({ where: { venueId } })
  await prisma.reservationSettings.update({ where: { venueId }, data: { capacityMode: 'pacing', showStaffPicker: false } })
})

afterAll(async () => {
  try {
    await cleanupFixtures()
  } finally {
    await inspector.$disconnect()
  }
})

describe('createReservation PostgreSQL contract', () => {
  it('stores scalar legacy identity as [] and an explicit list atomically in request order', async () => {
    const scalarWindow = nextWindow(60)
    const scalar = await createReservation(venueId, { ...scalarWindow, duration: 60, productId: productA }, { writeOrigin: 'DASHBOARD' })

    const listWindow = nextWindow(90)
    const explicit = await createReservation(
      venueId,
      {
        ...listWindow,
        duration: 5,
        productId: productA,
        productIds: [productA, productB],
      },
      { writeOrigin: 'DASHBOARD', windowSemantics: 'base' },
    )

    const rows = await inspector.reservation.findMany({
      where: { id: { in: [scalar.id, explicit.id] } },
      select: { id: true, productId: true, productIds: true, duration: true },
    })
    const byId = new Map(rows.map(row => [row.id, row]))
    expect(byId.get(scalar.id)).toMatchObject({ productId: productA, productIds: [], duration: 60 })
    expect(byId.get(explicit.id)).toMatchObject({ productId: productA, productIds: [productA, productB], duration: 90 })
  })

  it('persists one canonical modifier result and the final interval in the same transaction', async () => {
    const window = nextWindow(60)
    const created = await createReservation(
      venueId,
      {
        ...window,
        duration: 5,
        productId: productA,
        productIds: [productA],
        modifierSelections: [{ productId: productA, modifierId, quantity: 1 }],
      },
      { writeOrigin: 'DASHBOARD', windowSemantics: 'base' },
    )

    const stored = await inspector.reservation.findUniqueOrThrow({
      where: { id: created.id },
      include: { modifiers: true },
    })
    expect(stored.productIds).toEqual([productA])
    expect(stored.duration).toBe(75)
    expect(stored.endsAt).toEqual(new Date(window.startsAt.getTime() + 75 * 60_000))
    expect(stored.modifiers).toHaveLength(1)
    expect(stored.modifiers[0]).toMatchObject({ productId: productA, modifierId, name: 'Tiempo extra', quantity: 1 })
    expect(stored.modifiers[0].price.toString()).toBe('25')
  })

  it('rolls back a foreign second product before Reservation, modifier, or outbox writes', async () => {
    const window = nextWindow(90)

    await expect(
      createReservation(
        venueId,
        {
          ...window,
          duration: 90,
          productId: productA,
          productIds: [productA, foreignProduct],
          modifierSelections: [{ productId: productA, modifierId }],
        },
        { writeOrigin: 'DASHBOARD', windowSemantics: 'base' },
      ),
    ).rejects.toBeInstanceOf(BadRequestError)

    expect(await inspector.reservation.count({ where: { venueId } })).toBe(0)
    expect(await inspector.reservationModifier.count({ where: { reservation: { venueId } } })).toBe(0)
    expect(await inspector.calendarSyncOutbox.count({ where: { venueId } })).toBe(0)
  })

  it('returns the legacy staff-aware duration floor conflict with zero writes', async () => {
    await prisma.reservationSettings.update({ where: { venueId }, data: { capacityMode: 'per_staff' } })
    const window = nextWindow(5)

    await expect(
      createReservation(venueId, { ...window, duration: 60, productId: productA }, { writeOrigin: 'DASHBOARD' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'APPOINTMENT_WINDOW_CHANGED' })

    expect(await inspector.reservation.count({ where: { venueId } })).toBe(0)
    expect(await inspector.reservationModifier.count({ where: { reservation: { venueId } } })).toBe(0)
    expect(await inspector.calendarSyncOutbox.count({ where: { venueId } })).toBe(0)
  })

  it('retries a real SQLSTATE 40001 and leaves exactly one reservation plus one modifier', async () => {
    const sqlName = `reservation_retry_${process.pid}_${Date.now()}`
    const sequenceName = `${sqlName}_seq`
    const functionName = `${sqlName}_fn`
    const triggerName = `${sqlName}_trigger`
    const escapedVenueId = venueId.replace(/'/g, "''")

    try {
      await inspector.$executeRawUnsafe(`CREATE SEQUENCE "${sequenceName}" START 1`)
      await inspector.$executeRawUnsafe(`
        CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
        BEGIN
          IF NEW."venueId" = '${escapedVenueId}' AND nextval('"${sequenceName}"') = 1 THEN
            RAISE EXCEPTION 'fixture serialization retry' USING ERRCODE = '40001';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `)
      await inspector.$executeRawUnsafe(
        `CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "Reservation" FOR EACH ROW EXECUTE FUNCTION "${functionName}"()`,
      )

      const window = nextWindow(60)
      const created = await createReservation(
        venueId,
        {
          ...window,
          duration: 60,
          productId: productA,
          productIds: [productA],
          modifierSelections: [{ productId: productA, modifierId }],
        },
        { writeOrigin: 'DASHBOARD', windowSemantics: 'base' },
      )

      const [rows, modifierRows, sequenceState] = await Promise.all([
        inspector.reservation.findMany({ where: { venueId }, select: { id: true, productId: true, productIds: true, duration: true } }),
        inspector.reservationModifier.findMany({ where: { reservation: { venueId } } }),
        inspector.$queryRawUnsafe<Array<{ last_value: bigint }>>(`SELECT last_value FROM "${sequenceName}"`),
      ])
      expect(rows).toEqual([{ id: created.id, productId: productA, productIds: [productA], duration: 75 }])
      expect(modifierRows).toHaveLength(1)
      expect(Number(sequenceState[0].last_value)).toBe(2)
    } finally {
      await inspector.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "Reservation"`)
      await inspector.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`)
      await inspector.$executeRawUnsafe(`DROP SEQUENCE IF EXISTS "${sequenceName}"`)
    }
  })
})
