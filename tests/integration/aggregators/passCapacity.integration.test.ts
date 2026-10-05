/**
 * Integration (REAL DB) — reglas de lugares para pases. Lo que los mocks no pueden probar: que SERIALIZABLE contra
 * Postgres de verdad deje UNA sola regla cuando dos guardados llegan a la vez (no hay índice único que lo impida).
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test'
import '../../__helpers__/integration-setup'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { setDefaultPassCap, upsertWeeklyPassCap } from '@/services/aggregators/passCapacity.service'
import { ingestBookingRequested } from '@/services/aggregators/core/bookingIngestion.service'
import { getClassSession, getClassSessions } from '@/services/dashboard/classSession.dashboard.service'

const RUN = Date.now()
describe('reglas de lugares para pases (integration, real DB)', () => {
  let orgId: string | undefined
  let venueId: string | undefined
  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: 'ITEST Pases Cap', email: `itest-pcap-${RUN}@test.com`, phone: '5550000000' },
    })
    orgId = org.id
    const venue = await prisma.venue.create({
      data: {
        name: 'ITEST Pases Cap',
        slug: `itest-pcap-${RUN}`,
        organizationId: org.id,
        address: 'X',
        city: 'X',
        state: 'X',
        country: 'MX',
        zipCode: '00000',
        timezone: 'America/Mexico_City',
      },
    })
    venueId = venue.id
  })
  afterAll(async () => {
    const step = (fn: () => Promise<unknown>) => fn().catch(() => {})
    if (venueId) {
      await step(() => prisma.aggregatorCapacityRule.deleteMany({ where: { venueId } }))
      await step(() => prisma.activityLog.deleteMany({ where: { venueId } }))
      await step(() => prisma.aggregatorOutbox.deleteMany({ where: { venueId } }))
      await step(() => prisma.aggregatorBooking.deleteMany({ where: { venueId } }))
      await step(() => prisma.aggregatorSessionLink.deleteMany({ where: { venueId } }))
      await step(() => prisma.aggregatorProductLink.deleteMany({ where: { venueId } }))
      await step(() => prisma.reservation.deleteMany({ where: { venueId } }))
      await step(() => prisma.customerExternalIdentity.deleteMany({ where: { venueId } }))
      await step(() => prisma.customer.deleteMany({ where: { venueId } }))
      await step(() => prisma.aggregatorConnection.deleteMany({ where: { venueId } }))
      await step(() => prisma.classSession.deleteMany({ where: { venueId } }))
      await step(() => prisma.product.deleteMany({ where: { venueId } }))
      await step(() => prisma.menuCategory.deleteMany({ where: { venueId } }))
      await step(() => prisma.venue.deleteMany({ where: { id: venueId } }))
    }
    if (orgId) await step(() => prisma.organization.deleteMany({ where: { id: orgId } }))
  })

  // nuevo — Review Focus 5
  it('dos guardados simultáneos de la regla general dejan UNA sola regla', async () => {
    await Promise.all([setDefaultPassCap(venueId!, 2, null), setDefaultPassCap(venueId!, 3, null)])
    const rules = await prisma.aggregatorCapacityRule.findMany({ where: { venueId, scope: 'DEFAULT' }, take: 10 })
    expect(rules).toHaveLength(1)
    expect([2, 3]).toContain(rules[0].maxSpots)
  })
  // nuevo
  it('dos guardados simultáneos del mismo día+hora dejan UNA sola excepción', async () => {
    await Promise.all([
      upsertWeeklyPassCap(venueId!, { weekday: 6, startMinute: 540, maxSpots: 1 }, null),
      upsertWeeklyPassCap(venueId!, { weekday: 6, startMinute: 540, maxSpots: 2 }, null),
    ])
    const rules = await prisma.aggregatorCapacityRule.findMany({
      where: { venueId, scope: 'WEEKLY', weekday: 6, startMinute: 540 },
      take: 10,
    })
    expect(rules).toHaveLength(1)
  })

  // C10 (P2-11) — completar las reservas de pase no borra el historial: «Pases 2 de N» seguía en «0 de N»
  it('una sesión con 2 reservas de pase COMPLETED dice taken 2 en la lista y en el detalle', async () => {
    const category = await prisma.menuCategory.create({ data: { venueId: venueId!, name: 'Clases', slug: `clases-pcap-${RUN}` } })
    const product = await prisma.product.create({
      data: {
        venueId: venueId!,
        sku: `PCAP-${RUN}`,
        name: 'Pilates',
        type: 'CLASS',
        categoryId: category.id,
        price: new Prisma.Decimal(200),
      },
    })
    const startsAt = new Date(Date.now() + 24 * 3600_000)
    const session = await prisma.classSession.create({
      data: {
        venueId: venueId!,
        productId: product.id,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 3600_000),
        duration: 60,
        capacity: 8,
      },
    })
    const c = await prisma.aggregatorConnection.create({
      data: {
        venueId: venueId!,
        provider: 'TOTALPASS',
        externalPlaceId: `place-pcap-${RUN}`,
        webhookToken: `tok-pcap-${RUN}`,
        status: 'ACTIVE',
      },
    })
    await prisma.aggregatorProductLink.create({
      data: { connectionId: c.id, venueId: venueId!, productId: product.id, externalPlanId: '1' },
    })
    await prisma.aggregatorSessionLink.create({
      data: { connectionId: c.id, venueId: venueId!, classSessionId: session.id, externalOccurrenceId: `occ-pcap-${RUN}` },
    })
    for (const n of [1, 2]) {
      const b = await ingestBookingRequested(
        { id: c.id, venueId: venueId!, provider: 'TOTALPASS' },
        {
          kind: 'BOOKING_REQUESTED',
          externalBookingId: `pcap-${RUN}-${n}`,
          externalOccurrenceId: `occ-pcap-${RUN}`,
          externalUserId: `UPCAP${RUN}-${n}`,
          externalPlanCode: null,
          placeId: null,
          user: { name: `Socio ${n}`, email: null, phone: null },
          seatRef: null,
        },
        new Date(),
      )
      expect(b.decision).toBe('ACCEPTED')
    }
    // La clase ya pasó: sus dos socios asistieron.
    await prisma.reservation.updateMany({ where: { classSessionId: session.id }, data: { status: 'COMPLETED' } })
    await prisma.classSession.update({ where: { id: session.id }, data: { status: 'COMPLETED' } })

    const detail = await getClassSession(venueId!, session.id)
    expect(detail.passes).toMatchObject({ taken: 2 })
    expect(detail.available).toBe(8) // los inscritos/disponibles siguen contando sólo las vivas
    const day = 24 * 3600_000
    const list = await getClassSessions(
      venueId!,
      { dateFrom: new Date(startsAt.getTime() - day), dateTo: new Date(startsAt.getTime() + day) } as any,
      'America/Mexico_City',
    )
    expect(list.find(x => x.id === session.id)?.passes).toMatchObject({ taken: 2 })
  })
})
