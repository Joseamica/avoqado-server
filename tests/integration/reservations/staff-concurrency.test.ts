import { Prisma, PrismaClient } from '@prisma/client'

jest.mock('@/communication/rabbitmq/gcal-push-consumer', () => ({
  __esModule: true,
  publishPushNotification: jest.fn().mockResolvedValue(undefined),
}))

import prisma from '@/utils/prismaClient'
import { ConflictError } from '@/errors/AppError'
import { withSerializableRetry } from '@/utils/serializableRetry'
import { assertOrganizationStaffAvailability } from '@/services/dashboard/appointmentStaffAssignment.service'
import { createReservation } from '@/services/dashboard/reservation.dashboard.service'
import { createClassSession, createClassSessionsBulk, updateClassSession } from '@/services/dashboard/classSession.dashboard.service'
import { hardDeleteTeamMember } from '@/services/dashboard/team.dashboard.service'

const fixtureKey = `staff-concurrency-${process.pid}-${Date.now()}`
const inspector = new PrismaClient()
const lockHolder = new PrismaClient()

const organizationIds: string[] = []
const venueIds: string[] = []
let staffId: string
let secondStaffId: string
let sameOrgVenueA: string
let sameOrgVenueB: string
let otherOrgVenue: string
let classProductA: string
let classProductB: string
let classProductOther: string
let appointmentProductA: string
let appointmentProductB: string
let appointmentProductOther: string
let sequence = 0

interface Window {
  startsAt: Date
  endsAt: Date
}

interface Gate {
  ready: Promise<void>
  signalReady: () => void
  permit: Promise<void>
  release: () => void
}

function createGate(): Gate {
  let signalReady!: () => void
  let release!: () => void
  return {
    ready: new Promise<void>(resolve => {
      signalReady = resolve
    }),
    signalReady: () => signalReady(),
    permit: new Promise<void>(resolve => {
      release = resolve
    }),
    release: () => release(),
  }
}

function testWindow(dayOffset: number, startHour = 10, durationMin = 60): Window {
  const startsAt = new Date(Date.UTC(2032, 0, 1 + dayOffset, startHour, 0, 0))
  return { startsAt, endsAt: new Date(startsAt.getTime() + durationMin * 60_000) }
}

function nextConfirmationCode(prefix: string): string {
  sequence += 1
  return `${prefix}-${process.pid}-${sequence}`
}

async function waitForSignalOrFailure(signal: Promise<void>, operation: Promise<unknown>, label: string): Promise<void> {
  let timeout: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      signal,
      operation.then(
        () => {
          throw new Error(`${label} completed before reaching its barrier`)
        },
        error => {
          throw new Error(`${label} failed before reaching its barrier: ${error instanceof Error ? error.message : String(error)}`)
        },
      ),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 10_000)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function waitUntilBlockedBy(holderPid: number, expected: number, label: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const [row] = await inspector.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      WITH RECURSIVE blocked(pid) AS (
        SELECT activity.pid
        FROM pg_stat_activity activity
        WHERE ${holderPid} = ANY(pg_blocking_pids(activity.pid))
        UNION
        SELECT activity.pid
        FROM pg_stat_activity activity
        JOIN blocked parent ON parent.pid = ANY(pg_blocking_pids(activity.pid))
      )
      SELECT COUNT(*)::bigint AS count FROM blocked
    `)
    if (Number(row.count) >= expected) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${expected} blocked transactions: ${label}`)
}

function appointmentWindow(dayOffset: number): Window {
  const today = new Date()
  const startsAt = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + dayOffset, 12, 0, 0))
  return { startsAt, endsAt: new Date(startsAt.getTime() + 60 * 60_000) }
}

function startAppointmentVenueLockHolder(venueId: string) {
  const gate = createGate()
  let holderPid = 0
  const promise = lockHolder.$transaction(
    async tx => {
      const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
      holderPid = backend.pid
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'apt-hold:' + venueId}))`
      gate.signalReady()
      await gate.permit
    },
    { timeout: 20_000 },
  )
  return { gate, promise, getPid: () => holderPid }
}

function createProductionAppointment(args: {
  venueId: string
  productId: string
  window: Window
  writeOrigin: 'PUBLIC' | 'DASHBOARD'
  requestedStaffId?: string
}) {
  return createReservation(
    args.venueId,
    {
      ...args.window,
      duration: 60,
      productId: args.productId,
      productIds: [args.productId],
      assignedStaffId: args.requestedStaffId,
    },
    { writeOrigin: args.writeOrigin, windowSemantics: 'base' },
  )
}

async function createVenueFixture(organizationId: string, suffix: string) {
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
    data: { venueId: venue.id, name: `${suffix} classes`, slug: `${fixtureKey}-${suffix}-classes`, availableDays: [] },
  })
  const product = await prisma.product.create({
    data: {
      venueId: venue.id,
      categoryId: category.id,
      sku: `${fixtureKey}-${suffix}-class`,
      name: `${suffix} class`,
      type: 'CLASS',
      price: new Prisma.Decimal(100),
      duration: 60,
      maxParticipants: 10,
      tags: [],
      allergens: [],
    },
  })
  await prisma.reservationSettings.create({ data: { venueId: venue.id, googleCalendarPushEnabled: false } })
  return { venueId: venue.id, productId: product.id }
}

async function ensureMembership(venueId: string): Promise<void> {
  await prisma.staffVenue.upsert({
    where: { staffId_venueId: { staffId, venueId } },
    create: { staffId, venueId, role: 'MANAGER', active: true },
    update: { active: true, endDate: null },
  })
}

async function createAppointmentProduct(venueId: string, suffix: string): Promise<string> {
  const category = await prisma.menuCategory.findFirstOrThrow({ where: { venueId }, select: { id: true } })
  const product = await prisma.product.create({
    data: {
      venueId,
      categoryId: category.id,
      sku: `${fixtureKey}-${suffix}-appointment`,
      name: `${suffix} appointment`,
      type: 'APPOINTMENTS_SERVICE',
      price: new Prisma.Decimal(100),
      duration: 60,
      tags: [],
      allergens: [],
    },
  })
  return product.id
}

async function configureAppointmentStaff(venueId: string, productId: string, candidateStaffIds: string[]): Promise<void> {
  const allDay = Object.fromEntries(
    ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(day => [
      day,
      { enabled: true, ranges: [{ open: '00:00', close: '23:59' }] },
    ]),
  )
  for (const candidateStaffId of candidateStaffIds) {
    const membership = await prisma.staffVenue.upsert({
      where: { staffId_venueId: { staffId: candidateStaffId, venueId } },
      create: { staffId: candidateStaffId, venueId, role: 'MANAGER', active: true },
      update: { active: true, endDate: null },
    })
    await prisma.productStaff.upsert({
      where: { productId_staffVenueId: { productId, staffVenueId: membership.id } },
      create: { venueId, productId, staffVenueId: membership.id },
      update: { venueId },
    })
    await prisma.staffSchedule.upsert({
      where: { staffVenueId: membership.id },
      create: { venueId, staffVenueId: membership.id, weekly: allDay },
      update: { venueId, weekly: allDay },
    })
  }
}

async function cleanupCommitments(): Promise<void> {
  const venueFilter = { in: venueIds }
  await prisma.slotHold.deleteMany({ where: { venueId: venueFilter } })
  await prisma.reservation.deleteMany({ where: { venueId: venueFilter } })
  await prisma.classSession.deleteMany({ where: { venueId: venueFilter } })
  await Promise.all(venueIds.map(ensureMembership))
}

async function cleanupFixtures(): Promise<void> {
  if (venueIds.length > 0) await prisma.venue.deleteMany({ where: { id: { in: venueIds } } })
  if (staffId || secondStaffId) await prisma.staff.deleteMany({ where: { id: { in: [staffId, secondStaffId].filter(Boolean) } } })
  if (organizationIds.length > 0) await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } })
}

type CommitmentKind = 'reservation' | 'hold' | 'class'

// Reservation and SlotHold production writers are wired in the next booking
// task. These deliberately small competitors exercise the production
// membership/personal-conflict predicate now; the later task repeats the same
// races against the full HTTP/core writers.
function startMinimalCommitmentWriter(args: { kind: CommitmentKind; venueId: string; productId?: string; window: Window; gate?: Gate }) {
  let attempts = 0
  const promise = withSerializableRetry(
    async tx => {
      attempts += 1
      const membership = await tx.staffVenue.findFirst({
        where: { venueId: args.venueId, staffId, active: true, staff: { active: true } },
        select: { venue: { select: { organizationId: true } } },
      })
      if (!membership) throw new ConflictError('El profesionista ya no está disponible')

      const checkedAt = new Date()
      await assertOrganizationStaffAvailability(tx, {
        organizationId: membership.venue.organizationId,
        staffId,
        startsAt: args.window.startsAt,
        endsAt: args.window.endsAt,
        checkedAt,
      })

      if (attempts === 1 && args.gate) {
        args.gate.signalReady()
        await args.gate.permit
      }

      if (args.kind === 'reservation') {
        return tx.reservation.create({
          data: {
            venueId: args.venueId,
            confirmationCode: nextConfirmationCode('RACE'),
            status: 'CONFIRMED',
            channel: 'DASHBOARD',
            startsAt: args.window.startsAt,
            endsAt: args.window.endsAt,
            duration: Math.round((args.window.endsAt.getTime() - args.window.startsAt.getTime()) / 60_000),
            assignedStaffId: staffId,
            partySize: 1,
          },
        })
      }
      if (args.kind === 'hold') {
        return tx.slotHold.create({
          data: {
            venueId: args.venueId,
            startsAt: args.window.startsAt,
            endsAt: args.window.endsAt,
            productIds: [],
            staffId,
            partySize: 1,
            expiresAt: new Date(args.window.endsAt.getTime() + 10 * 60_000),
          },
        })
      }
      if (!args.productId) throw new Error('Class writer requires productId')
      return tx.classSession.create({
        data: {
          venueId: args.venueId,
          productId: args.productId,
          startsAt: args.window.startsAt,
          endsAt: args.window.endsAt,
          duration: Math.round((args.window.endsAt.getTime() - args.window.startsAt.getTime()) / 60_000),
          capacity: 10,
          assignedStaffId: staffId,
          createdById: staffId,
        },
      })
    },
    { maxRetries: 4, baseDelayMs: 1 },
  )

  return { promise, getAttempts: () => attempts }
}

async function createProductionClass(venueId: string, productId: string, window: Window) {
  return createClassSession(
    venueId,
    {
      productId,
      startsAt: window.startsAt.toISOString(),
      endsAt: window.endsAt.toISOString(),
      capacity: 10,
      assignedStaffId: staffId,
      internalNotes: null,
    },
    staffId,
  )
}

beforeAll(async () => {
  try {
    const sameOrg = await prisma.organization.create({
      data: {
        name: `${fixtureKey}-same-org`,
        slug: `${fixtureKey}-same-org`,
        email: `${fixtureKey}-same@example.test`,
        phone: '5500000000',
      },
    })
    const otherOrg = await prisma.organization.create({
      data: {
        name: `${fixtureKey}-other-org`,
        slug: `${fixtureKey}-other-org`,
        email: `${fixtureKey}-other@example.test`,
        phone: '5500000001',
      },
    })
    organizationIds.push(sameOrg.id, otherOrg.id)

    const venueA = await createVenueFixture(sameOrg.id, 'a')
    const venueB = await createVenueFixture(sameOrg.id, 'b')
    const venueOther = await createVenueFixture(otherOrg.id, 'other')
    sameOrgVenueA = venueA.venueId
    classProductA = venueA.productId
    sameOrgVenueB = venueB.venueId
    classProductB = venueB.productId
    otherOrgVenue = venueOther.venueId
    classProductOther = venueOther.productId

    const staff = await prisma.staff.create({
      data: {
        email: `${fixtureKey}@example.test`,
        firstName: 'Concurrency',
        lastName: 'Staff',
        active: true,
      },
    })
    staffId = staff.id
    const secondStaff = await prisma.staff.create({
      data: {
        email: `${fixtureKey}-second@example.test`,
        firstName: 'Second',
        lastName: 'Professional',
        active: true,
      },
    })
    secondStaffId = secondStaff.id
    await Promise.all(venueIds.map(ensureMembership))
    ;[appointmentProductA, appointmentProductB, appointmentProductOther] = await Promise.all([
      createAppointmentProduct(sameOrgVenueA, 'a'),
      createAppointmentProduct(sameOrgVenueB, 'b'),
      createAppointmentProduct(otherOrgVenue, 'other'),
    ])
    await Promise.all([
      configureAppointmentStaff(sameOrgVenueA, appointmentProductA, [staffId, secondStaffId]),
      configureAppointmentStaff(sameOrgVenueB, appointmentProductB, [staffId]),
      configureAppointmentStaff(otherOrgVenue, appointmentProductOther, [staffId]),
    ])
  } catch (error) {
    await cleanupFixtures()
    throw error
  }
})

beforeEach(async () => {
  sequence = 0
  await cleanupCommitments()
})

afterAll(async () => {
  try {
    await cleanupFixtures()
  } finally {
    await Promise.allSettled([inspector.$disconnect(), lockHolder.$disconnect()])
  }
})

describe('production appointment create serialization on PostgreSQL', () => {
  it('commits exactly one simultaneous self-service create at pacing one', async () => {
    await prisma.reservationSettings.update({
      where: { venueId: sameOrgVenueA },
      data: { capacityMode: 'per_staff', showStaffPicker: false, pacingMaxPerSlot: 1, minNoticeMin: 0 },
    })
    const window = appointmentWindow(10)
    const holder = startAppointmentVenueLockHolder(sameOrgVenueA)
    await waitForSignalOrFailure(holder.gate.ready, holder.promise, 'pacing-one venue lock holder')
    const creates = [
      createProductionAppointment({ venueId: sameOrgVenueA, productId: appointmentProductA, window, writeOrigin: 'PUBLIC' }),
      createProductionAppointment({ venueId: sameOrgVenueA, productId: appointmentProductA, window, writeOrigin: 'PUBLIC' }),
    ]
    let observationError: unknown
    try {
      await waitUntilBlockedBy(holder.getPid(), 2, 'pacing-one appointment creates')
    } catch (error) {
      observationError = error
    } finally {
      holder.gate.release()
      await holder.promise
    }
    const outcomes = await Promise.allSettled(creates)
    if (observationError) throw observationError

    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
    const rejected = outcomes.filter(outcome => outcome.status === 'rejected') as PromiseRejectedResult[]
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toMatchObject({ statusCode: 409, code: undefined })
    expect(await prisma.reservation.count({ where: { venueId: sameOrgVenueA, startsAt: window.startsAt } })).toBe(1)
  })

  it('commits two simultaneous creates with distinct Staff.id assignments at pacing two', async () => {
    await prisma.reservationSettings.update({
      where: { venueId: sameOrgVenueA },
      data: { capacityMode: 'per_staff', showStaffPicker: false, pacingMaxPerSlot: 2, minNoticeMin: 0 },
    })
    const window = appointmentWindow(11)
    const holder = startAppointmentVenueLockHolder(sameOrgVenueA)
    await waitForSignalOrFailure(holder.gate.ready, holder.promise, 'pacing-two venue lock holder')
    const creates = [
      createProductionAppointment({ venueId: sameOrgVenueA, productId: appointmentProductA, window, writeOrigin: 'PUBLIC' }),
      createProductionAppointment({ venueId: sameOrgVenueA, productId: appointmentProductA, window, writeOrigin: 'PUBLIC' }),
    ]
    let observationError: unknown
    try {
      await waitUntilBlockedBy(holder.getPid(), 2, 'pacing-two appointment creates')
    } catch (error) {
      observationError = error
    } finally {
      holder.gate.release()
      await holder.promise
    }
    const created = await Promise.all(creates)
    if (observationError) throw observationError

    expect(new Set(created.map(row => row.assignedStaffId))).toEqual(new Set([staffId, secondStaffId]))
    expect(await prisma.reservation.count({ where: { venueId: sameOrgVenueA, startsAt: window.startsAt } })).toBe(2)
  })

  it('serializes a requested professional against a same-organization cross-venue writer', async () => {
    await prisma.reservationSettings.update({
      where: { venueId: sameOrgVenueB },
      data: { capacityMode: 'per_staff', showStaffPicker: true, pacingMaxPerSlot: null, minNoticeMin: 0 },
    })
    const window = appointmentWindow(12)
    const gate = createGate()
    const competitor = startMinimalCommitmentWriter({ kind: 'reservation', venueId: sameOrgVenueA, window, gate })
    await waitForSignalOrFailure(gate.ready, competitor.promise, 'cross-venue Reservation writer')

    let created: Awaited<ReturnType<typeof createProductionAppointment>> | undefined
    try {
      created = await createProductionAppointment({
        venueId: sameOrgVenueB,
        productId: appointmentProductB,
        window,
        writeOrigin: 'DASHBOARD',
        requestedStaffId: staffId,
      })
    } finally {
      gate.release()
    }
    const competitorError = await competitor.promise.catch(error => error)

    expect(created?.assignedStaffId).toBe(staffId)
    expect(competitorError).toMatchObject({ statusCode: 409 })
    expect(await prisma.reservation.count({ where: { assignedStaffId: staffId, startsAt: window.startsAt } })).toBe(1)
  })

  it('isolates the same apparent Staff.id across organizations', async () => {
    await prisma.reservationSettings.update({
      where: { venueId: otherOrgVenue },
      data: { capacityMode: 'per_staff', showStaffPicker: true, pacingMaxPerSlot: null, minNoticeMin: 0 },
    })
    const window = appointmentWindow(13)
    const gate = createGate()
    const competitor = startMinimalCommitmentWriter({ kind: 'reservation', venueId: sameOrgVenueA, window, gate })
    await waitForSignalOrFailure(gate.ready, competitor.promise, 'other-organization Reservation writer')

    let created: Awaited<ReturnType<typeof createProductionAppointment>> | undefined
    try {
      created = await createProductionAppointment({
        venueId: otherOrgVenue,
        productId: appointmentProductOther,
        window,
        writeOrigin: 'DASHBOARD',
        requestedStaffId: staffId,
      })
    } finally {
      gate.release()
    }
    await expect(competitor.promise).resolves.toMatchObject({ assignedStaffId: staffId })

    expect(created?.assignedStaffId).toBe(staffId)
    expect(await prisma.reservation.count({ where: { assignedStaffId: staffId, startsAt: window.startsAt } })).toBe(2)
  })

  it('exhausts the real venue lock retries as one bounded domain 409 without leaking a database error', async () => {
    await prisma.reservationSettings.update({
      where: { venueId: sameOrgVenueA },
      data: { capacityMode: 'per_staff', showStaffPicker: false, pacingMaxPerSlot: 1, minNoticeMin: 0 },
    })
    const window = appointmentWindow(14)
    const holder = startAppointmentVenueLockHolder(sameOrgVenueA)
    const startedAt = Date.now()
    let failure: unknown
    try {
      await waitForSignalOrFailure(holder.gate.ready, holder.promise, 'exhausted-retry venue lock holder')
      try {
        await createProductionAppointment({
          venueId: sameOrgVenueA,
          productId: appointmentProductA,
          window,
          writeOrigin: 'PUBLIC',
        })
      } catch (error) {
        failure = error
      }
    } finally {
      holder.gate.release()
      await holder.promise
    }

    const elapsedMs = Date.now() - startedAt
    expect(elapsedMs).toBeLessThan(20_000)
    expect(failure).toBeInstanceOf(ConflictError)
    expect(failure).toMatchObject({
      statusCode: 409,
      code: undefined,
      message: 'Conflicto de concurrencia persistente, por favor intente de nuevo',
    })
    expect(`${(failure as any)?.code ?? ''} ${(failure as Error)?.message ?? ''}`).not.toMatch(/P2028|P2010|55P03|40001/)
    expect(await prisma.reservation.count({ where: { venueId: sameOrgVenueA, startsAt: window.startsAt } })).toBe(0)
  })
})

describe('staff commitment serialization on PostgreSQL', () => {
  it.each([
    ['same venue', () => sameOrgVenueA, () => sameOrgVenueA, () => classProductA],
    ['cross venue in one organization', () => sameOrgVenueA, () => sameOrgVenueB, () => classProductB],
  ])('serializes a production class against a paused Reservation writer: %s', async (_label, writerVenue, classVenue, productId) => {
    const window = testWindow(_label === 'same venue' ? 1 : 2)
    const gate = createGate()
    const competitor = startMinimalCommitmentWriter({ kind: 'reservation', venueId: writerVenue(), window, gate })

    await waitForSignalOrFailure(gate.ready, competitor.promise, `${_label} reservation writer`)
    let createdClass: Awaited<ReturnType<typeof createProductionClass>> | undefined
    let classFailure: unknown
    try {
      createdClass = await createProductionClass(classVenue(), productId(), window)
    } catch (error) {
      classFailure = error
    } finally {
      gate.release()
    }
    const competitorError = await competitor.promise.catch(error => error)
    if (classFailure) throw classFailure

    expect(createdClass?.assignedStaffId).toBe(staffId)
    expect(competitorError).toBeInstanceOf(ConflictError)
    expect(competitorError).toMatchObject({ statusCode: 409 })
    expect(competitor.getAttempts()).toBeGreaterThanOrEqual(2)
    expect(await prisma.classSession.count({ where: { assignedStaffId: staffId, startsAt: window.startsAt, endsAt: window.endsAt } })).toBe(
      1,
    )
    expect(await prisma.reservation.count({ where: { assignedStaffId: staffId, startsAt: window.startsAt, endsAt: window.endsAt } })).toBe(
      0,
    )
  })

  it('keeps the same Staff isolated across different organizations', async () => {
    const window = testWindow(3)
    const gate = createGate()
    const competitor = startMinimalCommitmentWriter({ kind: 'reservation', venueId: sameOrgVenueA, window, gate })

    await waitForSignalOrFailure(gate.ready, competitor.promise, 'other-organization reservation writer')
    let classFailure: unknown
    try {
      await createProductionClass(otherOrgVenue, classProductOther, window)
    } catch (error) {
      classFailure = error
    } finally {
      gate.release()
    }
    await expect(competitor.promise).resolves.toMatchObject({ assignedStaffId: staffId })
    if (classFailure) throw classFailure

    expect(await prisma.classSession.count({ where: { venueId: otherOrgVenue, assignedStaffId: staffId } })).toBe(1)
    expect(await prisma.reservation.count({ where: { venueId: sameOrgVenueA, assignedStaffId: staffId } })).toBe(1)
  })

  it('serializes a production class against a live SlotHold writer', async () => {
    const window = testWindow(4)
    const gate = createGate()
    const competitor = startMinimalCommitmentWriter({ kind: 'hold', venueId: sameOrgVenueA, window, gate })

    await waitForSignalOrFailure(gate.ready, competitor.promise, 'live-hold writer')
    let classFailure: unknown
    try {
      await createProductionClass(sameOrgVenueA, classProductA, window)
    } catch (error) {
      classFailure = error
    } finally {
      gate.release()
    }
    const competitorError = await competitor.promise.catch(error => error)
    if (classFailure) throw classFailure

    expect(competitorError).toBeInstanceOf(ConflictError)
    expect(competitor.getAttempts()).toBeGreaterThanOrEqual(2)
    expect(await prisma.classSession.count({ where: { venueId: sameOrgVenueA, assignedStaffId: staffId } })).toBe(1)
    expect(await prisma.slotHold.count({ where: { venueId: sameOrgVenueA, staffId } })).toBe(0)
  })

  it('rolls back an entire recurring batch when a later occurrence conflicts', async () => {
    const first = testWindow(14)
    const second = {
      startsAt: new Date(first.startsAt.getTime() + 7 * 86_400_000),
      endsAt: new Date(first.endsAt.getTime() + 7 * 86_400_000),
    }
    await prisma.reservation.create({
      data: {
        venueId: sameOrgVenueA,
        confirmationCode: nextConfirmationCode('BULK'),
        status: 'CONFIRMED',
        channel: 'DASHBOARD',
        startsAt: second.startsAt,
        endsAt: second.endsAt,
        duration: 60,
        assignedStaffId: staffId,
        partySize: 1,
      },
    })
    await prisma.reservationSettings.update({
      where: { venueId: sameOrgVenueA },
      data: { googleCalendarPushEnabled: true },
    })
    const connection = await prisma.googleCalendarConnection.create({
      data: {
        scope: 'VENUE',
        venueId: sameOrgVenueA,
        googleAccountEmail: `${fixtureKey}-calendar@example.test`,
        googleAccountSub: `${fixtureKey}-calendar`,
        selectedCalendarId: `${fixtureKey}-calendar`,
        selectedCalendarSummary: 'Concurrency fixture',
        selectedCalendarTimeZone: 'UTC',
        refreshTokenCiphertext: Buffer.from('fixture-token'),
      },
    })

    try {
      await expect(
        createClassSessionsBulk(
          sameOrgVenueA,
          {
            productId: classProductA,
            startDate: first.startsAt.toISOString().slice(0, 10),
            startTime: '10:00',
            endTime: '11:00',
            weekdays: [first.startsAt.getUTCDay()],
            occurrences: 2,
            capacity: 10,
            assignedStaffId: staffId,
            internalNotes: null,
          },
          staffId,
          'UTC',
        ),
      ).rejects.toMatchObject({ statusCode: 409 })

      expect(connection.status).toBe('CONNECTED')
      expect(await prisma.classSession.count({ where: { venueId: sameOrgVenueA, productId: classProductA } })).toBe(0)
      expect(await prisma.calendarSyncOutbox.count({ where: { venueId: sameOrgVenueA, targetConnectionId: connection.id } })).toBe(0)
    } finally {
      await prisma.googleCalendarConnection.delete({ where: { id: connection.id } })
      await prisma.reservationSettings.update({
        where: { venueId: sameOrgVenueA },
        data: { googleCalendarPushEnabled: false },
      })
    }
  })
})

describe('ClassSession updates on PostgreSQL', () => {
  it('serializes two partial updates from the freshly locked row', async () => {
    const window = testWindow(30, 10, 180)
    const session = await prisma.classSession.create({
      data: {
        venueId: sameOrgVenueA,
        productId: classProductA,
        startsAt: window.startsAt,
        endsAt: window.endsAt,
        duration: 180,
        capacity: 10,
        assignedStaffId: staffId,
        createdById: staffId,
      },
    })
    const holderGate = createGate()
    let holderPid = 0
    const holder = lockHolder.$transaction(
      async tx => {
        const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
        holderPid = backend.pid
        await tx.$queryRaw`SELECT id FROM "ClassSession" WHERE id = ${session.id} FOR UPDATE`
        holderGate.signalReady()
        await holderGate.permit
      },
      { timeout: 15_000 },
    )
    await waitForSignalOrFailure(holderGate.ready, holder, 'ClassSession row-lock holder')

    const startUpdate = updateClassSession(sameOrgVenueA, session.id, { startsAt: testWindow(30, 12).startsAt.toISOString() })
    const endUpdate = updateClassSession(sameOrgVenueA, session.id, { endsAt: testWindow(30, 11).startsAt.toISOString() })
    let observationError: unknown
    try {
      await waitUntilBlockedBy(holderPid, 2, 'partial ClassSession updates')
    } catch (error) {
      observationError = error
    } finally {
      holderGate.release()
      await holder
    }
    const outcomes = await Promise.allSettled([startUpdate, endUpdate])
    if (observationError) throw observationError
    const fulfilled = outcomes.filter(outcome => outcome.status === 'fulfilled')
    const rejected = outcomes.filter(outcome => outcome.status === 'rejected')
    const stored = await prisma.classSession.findUniqueOrThrow({ where: { id: session.id } })

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ statusCode: 400 })
    expect(stored.endsAt.getTime()).toBeGreaterThan(stored.startsAt.getTime())
    expect(stored.duration).toBe(Math.round((stored.endsAt.getTime() - stored.startsAt.getTime()) / 60_000))
  })

  it('allows metadata-only edits on a deliberately pre-existing personal conflict', async () => {
    const window = testWindow(31)
    const session = await prisma.classSession.create({
      data: {
        venueId: sameOrgVenueA,
        productId: classProductA,
        startsAt: window.startsAt,
        endsAt: window.endsAt,
        duration: 60,
        capacity: 10,
        assignedStaffId: staffId,
        createdById: staffId,
      },
    })
    await prisma.reservation.create({
      data: {
        venueId: sameOrgVenueA,
        confirmationCode: nextConfirmationCode('META'),
        status: 'CONFIRMED',
        channel: 'DASHBOARD',
        startsAt: window.startsAt,
        endsAt: window.endsAt,
        duration: 60,
        assignedStaffId: staffId,
        partySize: 1,
      },
    })

    const updated = await updateClassSession(sameOrgVenueA, session.id, { internalNotes: 'metadata only' })

    expect(updated.internalNotes).toBe('metadata only')
    expect(await prisma.classSession.count({ where: { id: session.id } })).toBe(1)
  })
})

describe('hardDeleteTeamMember serialization on PostgreSQL', () => {
  it.each(['reservation', 'class', 'hold'] as const)('retains membership when a committed future %s exists', async kind => {
    const window = testWindow(kind === 'reservation' ? 40 : kind === 'class' ? 41 : 42)
    if (kind === 'reservation') {
      await prisma.reservation.create({
        data: {
          venueId: sameOrgVenueA,
          confirmationCode: nextConfirmationCode('DELETE'),
          status: 'CONFIRMED',
          channel: 'DASHBOARD',
          startsAt: window.startsAt,
          endsAt: window.endsAt,
          duration: 60,
          assignedStaffId: staffId,
          partySize: 1,
        },
      })
    } else if (kind === 'class') {
      await prisma.classSession.create({
        data: {
          venueId: sameOrgVenueA,
          productId: classProductA,
          startsAt: window.startsAt,
          endsAt: window.endsAt,
          duration: 60,
          capacity: 10,
          assignedStaffId: staffId,
          createdById: staffId,
        },
      })
    } else {
      await prisma.slotHold.create({
        data: {
          venueId: sameOrgVenueA,
          startsAt: window.startsAt,
          endsAt: window.endsAt,
          productIds: [],
          staffId,
          expiresAt: new Date(window.endsAt.getTime() + 10 * 60_000),
        },
      })
    }
    const membership = await prisma.staffVenue.findUniqueOrThrow({ where: { staffId_venueId: { staffId, venueId: sameOrgVenueA } } })

    await expect(hardDeleteTeamMember(sameOrgVenueA, membership.id, true)).rejects.toMatchObject({ statusCode: 409 })

    expect(await prisma.staffVenue.count({ where: { id: membership.id } })).toBe(1)
  })

  it('ignores cancelled-parent, expired, and past holds', async () => {
    const window = testWindow(43)
    const cancelledParent = await prisma.reservation.create({
      data: {
        venueId: sameOrgVenueA,
        confirmationCode: nextConfirmationCode('CANCELLED'),
        status: 'CANCELLED',
        channel: 'DASHBOARD',
        startsAt: window.startsAt,
        endsAt: window.endsAt,
        duration: 60,
        assignedStaffId: staffId,
        partySize: 1,
      },
    })
    await prisma.slotHold.createMany({
      data: [
        {
          venueId: sameOrgVenueA,
          startsAt: window.startsAt,
          endsAt: window.endsAt,
          productIds: [],
          staffId,
          heldForReservationId: cancelledParent.id,
          expiresAt: new Date(window.endsAt.getTime() + 10 * 60_000),
        },
        {
          venueId: sameOrgVenueA,
          startsAt: window.startsAt,
          endsAt: window.endsAt,
          productIds: [],
          staffId,
          expiresAt: new Date('2020-01-01T00:00:00.000Z'),
        },
        {
          venueId: sameOrgVenueA,
          startsAt: new Date('2020-01-01T00:00:00.000Z'),
          endsAt: new Date('2020-01-01T01:00:00.000Z'),
          productIds: [],
          staffId,
          expiresAt: new Date(window.endsAt.getTime() + 10 * 60_000),
        },
      ],
    })
    const membership = await prisma.staffVenue.findUniqueOrThrow({ where: { staffId_venueId: { staffId, venueId: sameOrgVenueA } } })

    await expect(hardDeleteTeamMember(sameOrgVenueA, membership.id, true)).resolves.toMatchObject({
      deletedRecords: { staffVenue: 1 },
    })
    expect(await prisma.staffVenue.count({ where: { id: membership.id } })).toBe(0)
  })

  it.each(['reservation', 'class', 'hold'] as const)(
    'serializes hard-delete against a paused %s writer without leaving an orphan',
    async kind => {
      const window = testWindow(kind === 'reservation' ? 44 : kind === 'class' ? 45 : 46)
      const gate = createGate()
      const competitor = startMinimalCommitmentWriter({
        kind,
        venueId: sameOrgVenueA,
        productId: kind === 'class' ? classProductA : undefined,
        window,
        gate,
      })
      await waitForSignalOrFailure(gate.ready, competitor.promise, `${kind} writer before hard-delete`)
      const membership = await prisma.staffVenue.findUniqueOrThrow({ where: { staffId_venueId: { staffId, venueId: sameOrgVenueA } } })

      let deleted: Awaited<ReturnType<typeof hardDeleteTeamMember>> | undefined
      let deleteFailure: unknown
      try {
        deleted = await hardDeleteTeamMember(sameOrgVenueA, membership.id, true)
      } catch (error) {
        deleteFailure = error
      } finally {
        gate.release()
      }
      const competitorError = await competitor.promise.catch(error => error)
      if (deleteFailure) throw deleteFailure

      expect(deleted?.deletedRecords.staffVenue).toBe(1)
      expect(competitorError).toBeInstanceOf(ConflictError)
      expect(competitor.getAttempts()).toBeGreaterThanOrEqual(2)
      expect(await prisma.staffVenue.count({ where: { id: membership.id } })).toBe(0)
      const remainingCommitments = await Promise.all([
        prisma.reservation.count({ where: { venueId: sameOrgVenueA, assignedStaffId: staffId } }),
        prisma.classSession.count({ where: { venueId: sameOrgVenueA, assignedStaffId: staffId } }),
        prisma.slotHold.count({ where: { venueId: sameOrgVenueA, staffId } }),
      ])
      expect(remainingCommitments).toEqual([0, 0, 0])
    },
  )
})
