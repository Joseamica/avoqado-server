import { prismaMock } from '@tests/__helpers__/setup'
import { buildSessionPublication, enqueuePassSessionSync } from '@/services/aggregators/core/sessionSync.service'
import * as classBooking from '@/services/reservation/classBooking.service'

const start = new Date(Date.now() + 48 * 3600e3)

describe('buildSessionPublication', () => {
  // nuevo
  it('arma la publicación con el plan del producto ligado y el cupo calculado', async () => {
    prismaMock.classSession.findFirst.mockResolvedValueOnce({
      id: 's1',
      venueId: 'v1',
      productId: 'p1',
      startsAt: start,
      endsAt: new Date(start.getTime() + 3600e3),
      duration: 60,
      capacity: 12,
      status: 'SCHEDULED',
      product: { name: 'Reformer' },
      assignedStaff: { firstName: 'Lu', lastName: 'Pérez' },
      venue: { timezone: 'America/Mexico_City' },
    } as any)
    prismaMock.aggregatorProductLink.findFirst.mockResolvedValueOnce({ externalPlanId: '305' } as any)
    jest.spyOn(classBooking, 'sumOccupiedSeats').mockResolvedValueOnce(4)
    jest.spyOn(classBooking, 'sumPassSeats').mockResolvedValueOnce(1)
    prismaMock.aggregatorBooking.count.mockResolvedValueOnce(1)
    prismaMock.aggregatorCapacityRule.findMany.mockResolvedValueOnce([
      { scope: 'DEFAULT', weekday: null, startMinute: null, classSessionId: null, maxSpots: 3 },
    ] as any)
    const r = await buildSessionPublication('s1', 'c1')
    expect(r.publication).toMatchObject({
      title: 'Reformer',
      coachName: 'Lu Pérez',
      durationMin: 60,
      externalPlanId: '305',
      timezone: 'America/Mexico_City',
    })
    expect(r.spots).toBe(3) // 1 activo + min(8 libres, 3−1)
  })
  // nuevo
  it('producto no ligado ⇒ NOT_LINKED', async () => {
    prismaMock.classSession.findFirst.mockResolvedValueOnce({
      id: 's1',
      productId: 'p1',
      status: 'SCHEDULED',
      startsAt: start,
      venue: { timezone: 'America/Mexico_City' },
    } as any)
    prismaMock.aggregatorProductLink.findFirst.mockResolvedValueOnce(null)
    await expect(buildSessionPublication('s1', 'c1')).resolves.toMatchObject({ publication: null, reason: 'NOT_LINKED' })
  })
  // nuevo
  it('sesión que ya no existe ⇒ CANCELLED (el worker la da de baja si sigue viva)', async () => {
    prismaMock.classSession.findFirst.mockResolvedValueOnce(null)
    await expect(buildSessionPublication('gone', 'c1')).resolves.toMatchObject({ publication: null, reason: 'CANCELLED' })
    expect(prismaMock.aggregatorProductLink.findFirst).not.toHaveBeenCalled()
  })
  // nuevo
  it('sesión cancelada ⇒ CANCELLED; ya empezada ⇒ PAST', async () => {
    prismaMock.classSession.findFirst.mockResolvedValueOnce({
      id: 's1',
      productId: 'p1',
      status: 'CANCELLED',
      startsAt: start,
      venue: { timezone: 'America/Mexico_City' },
    } as any)
    prismaMock.aggregatorProductLink.findFirst.mockResolvedValueOnce({ externalPlanId: '305' } as any)
    await expect(buildSessionPublication('s1', 'c1')).resolves.toMatchObject({ publication: null, reason: 'CANCELLED' })

    prismaMock.classSession.findFirst.mockResolvedValueOnce({
      id: 's1',
      productId: 'p1',
      status: 'SCHEDULED',
      startsAt: new Date(Date.now() - 60e3),
      venue: { timezone: 'America/Mexico_City' },
    } as any)
    await expect(buildSessionPublication('s1', 'c1')).resolves.toMatchObject({ publication: null, reason: 'PAST' })
  })
  // fix 1/5 — una clase que ya empezó es PAST aunque luego se cancele o se desligue su producto
  it('cancelada DESPUÉS de empezar ⇒ PAST (no CANCELLED), sin revisar el vínculo', async () => {
    prismaMock.classSession.findFirst.mockResolvedValueOnce({
      id: 's1',
      productId: 'p1',
      status: 'CANCELLED',
      startsAt: new Date(Date.now() - 5 * 60e3),
      venue: { timezone: 'America/Mexico_City' },
    } as any)
    await expect(buildSessionPublication('s1', 'c1')).resolves.toMatchObject({ publication: null, reason: 'PAST' })
    expect(prismaMock.aggregatorProductLink.findFirst).not.toHaveBeenCalled()
  })
  // fix 1/5
  it('producto desligado de una clase pasada ⇒ PAST (no NOT_LINKED)', async () => {
    prismaMock.classSession.findFirst.mockResolvedValueOnce({
      id: 's1',
      productId: 'p1',
      status: 'SCHEDULED',
      startsAt: new Date(Date.now() - 5 * 60e3),
      venue: { timezone: 'America/Mexico_City' },
    } as any)
    prismaMock.aggregatorProductLink.findFirst.mockResolvedValueOnce(null)
    await expect(buildSessionPublication('s1', 'c1')).resolves.toMatchObject({ publication: null, reason: 'PAST' })
    expect(prismaMock.aggregatorProductLink.findFirst).not.toHaveBeenCalled()
    prismaMock.aggregatorProductLink.findFirst.mockReset()
  })
  // nuevo — R6
  it('las reglas de cupo se leen acotadas y en orden estable (la más reciente gana)', async () => {
    prismaMock.classSession.findFirst.mockResolvedValueOnce({
      id: 's1',
      venueId: 'v1',
      productId: 'p1',
      startsAt: start,
      duration: 60,
      capacity: 12,
      status: 'SCHEDULED',
      product: { name: 'Reformer' },
      assignedStaff: null,
      venue: { timezone: 'America/Mexico_City' },
    } as any)
    prismaMock.aggregatorProductLink.findFirst.mockResolvedValueOnce({ externalPlanId: '305' } as any)
    jest.spyOn(classBooking, 'sumOccupiedSeats').mockResolvedValueOnce(0)
    jest.spyOn(classBooking, 'sumPassSeats').mockResolvedValueOnce(0)
    prismaMock.aggregatorBooking.count.mockResolvedValueOnce(0)
    prismaMock.aggregatorCapacityRule.findMany.mockResolvedValueOnce([
      { scope: 'DEFAULT', weekday: null, startMinute: null, classSessionId: null, maxSpots: 5 },
      { scope: 'DEFAULT', weekday: null, startMinute: null, classSessionId: null, maxSpots: 9 },
    ] as any)
    const r = await buildSessionPublication('s1', 'c1')
    const q = prismaMock.aggregatorCapacityRule.findMany.mock.calls[0][0]
    expect(q.orderBy).toEqual([{ updatedAt: 'desc' }, { id: 'asc' }])
    expect(q.take).toBeGreaterThan(0)
    expect(r.spots).toBe(5)
    expect(r.publication?.coachName).toBe('Instructor')
  })
  // nuevo
  it('regla semanal en hora local del venue (domingo = 0)', async () => {
    // 2030-01-06 es domingo; 16:00 UTC = 10:00 en Ciudad de México.
    const sunday = new Date('2030-01-06T16:00:00Z')
    prismaMock.classSession.findFirst.mockResolvedValueOnce({
      id: 's1',
      venueId: 'v1',
      productId: 'p1',
      startsAt: sunday,
      duration: 50,
      capacity: 10,
      status: 'SCHEDULED',
      product: { name: 'Spin' },
      assignedStaff: { firstName: 'Ana', lastName: '' },
      venue: { timezone: 'America/Mexico_City' },
    } as any)
    prismaMock.aggregatorProductLink.findFirst.mockResolvedValueOnce({ externalPlanId: '9' } as any)
    jest.spyOn(classBooking, 'sumOccupiedSeats').mockResolvedValueOnce(0)
    jest.spyOn(classBooking, 'sumPassSeats').mockResolvedValueOnce(0)
    prismaMock.aggregatorBooking.count.mockResolvedValueOnce(0)
    prismaMock.aggregatorCapacityRule.findMany.mockResolvedValueOnce([
      { scope: 'DEFAULT', weekday: null, startMinute: null, classSessionId: null, maxSpots: 1 },
      { scope: 'WEEKLY', weekday: 0, startMinute: 600, classSessionId: null, maxSpots: 4 },
    ] as any)
    const r = await buildSessionPublication('s1', 'c1', new Date('2030-01-01T00:00:00Z'))
    expect(r.spots).toBe(4)
    expect(r.publication).toMatchObject({ coachName: 'Ana', bookingClosesAt: new Date(sunday.getTime() - 60e3), cancelUntil: null })
  })
})

describe('enqueuePassSessionSync', () => {
  // nuevo
  it('encola un SYNC_SESSION por cada conexión activa del venue', async () => {
    prismaMock.aggregatorConnection.findMany.mockResolvedValueOnce([{ id: 'c1' }, { id: 'c2' }] as any)
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValue(null)
    await enqueuePassSessionSync(prismaMock as any, 'v1', 's1')
    expect(prismaMock.aggregatorConnection.findMany.mock.calls[0][0]).toMatchObject({ where: { venueId: 'v1', status: 'ACTIVE' } })
    expect(prismaMock.aggregatorOutbox.create.mock.calls.map((c: any[]) => c[0].data.coalesceKey)).toEqual([
      'SYNC_SESSION:c1:s1',
      'SYNC_SESSION:c2:s1',
    ])
  })
})
