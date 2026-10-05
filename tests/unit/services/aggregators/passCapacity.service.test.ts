import { prismaMock } from '@tests/__helpers__/setup'
import * as suggestions from '@/services/aggregators/core/capacitySuggestions'
import * as sync from '@/services/aggregators/passSessionSync'
import { logAction } from '@/services/dashboard/activity-log.service'
import {
  deletePassCapRule,
  getPassCapacity,
  MAX_WEEKLY_PASS_RULES,
  passesForSessions,
  setDefaultPassCap,
  setSessionPassCap,
  upsertWeeklyPassCap,
} from '@/services/aggregators/passCapacity.service'

const NOW = new Date('2030-01-10T12:00:00Z')

beforeEach(() => {
  prismaMock.$transaction.mockImplementation(async (arg: any) => (typeof arg === 'function' ? arg(prismaMock) : arg))
  jest.spyOn(sync, 'enqueueHorizonSessionsSync').mockResolvedValue(0)
  prismaMock.aggregatorProductLink.findMany.mockResolvedValue([{ productId: 'p1' }] as any)
  prismaMock.reservation.groupBy.mockReset()
  prismaMock.reservation.groupBy.mockResolvedValue([])
})

describe('getPassCapacity', () => {
  // nuevo
  it('regla general, excepciones por día y sugerencias marcadas como aplicadas', async () => {
    prismaMock.aggregatorCapacityRule.findMany.mockResolvedValueOnce([
      { id: 'r0', scope: 'DEFAULT', weekday: null, startMinute: null, classSessionId: null, maxSpots: 4 },
      { id: 'r1', scope: 'WEEKLY', weekday: 6, startMinute: 540, classSessionId: null, maxSpots: 1 },
    ] as any)
    jest.spyOn(suggestions, 'loadPassSuggestions').mockResolvedValueOnce([
      { localWeekday: 6, localStartMinute: 540, suggestedMaxSpots: 1, weeksOfData: 8, p75Occupancy: 11, capacity: 13 },
      { localWeekday: 1, localStartMinute: 420, suggestedMaxSpots: 3, weeksOfData: 4, p75Occupancy: 8, capacity: 12 },
    ])
    const v = await getPassCapacity('v1', NOW)
    expect(v.defaultMaxSpots).toBe(4)
    expect(v.weekly).toEqual([{ id: 'r1', weekday: 6, startMinute: 540, maxSpots: 1 }])
    expect(v.suggestions.map(s => s.applied)).toEqual([true, false])
    expect(prismaMock.aggregatorCapacityRule.findMany.mock.calls[0][0]).toMatchObject({
      where: { venueId: 'v1', scope: { in: ['DEFAULT', 'WEEKLY'] } },
    })
  })
})

describe('setDefaultPassCap', () => {
  // nuevo
  it('crea la regla general si no hay y encola las sesiones futuras de las clases ligadas', async () => {
    prismaMock.aggregatorCapacityRule.findFirst.mockResolvedValueOnce(null)
    prismaMock.aggregatorCapacityRule.findMany.mockResolvedValue([])
    jest.spyOn(suggestions, 'loadPassSuggestions').mockResolvedValue([])
    await setDefaultPassCap('v1', 3, 's1', NOW)
    expect(prismaMock.aggregatorCapacityRule.create.mock.calls[0][0].data).toEqual({ venueId: 'v1', scope: 'DEFAULT', maxSpots: 3 })
    expect(sync.enqueueHorizonSessionsSync).toHaveBeenCalledWith(expect.anything(), 'v1', ['p1'], NOW) // Review Focus 3
  })
  // nuevo
  it('null borra la regla general (vuelven a ofrecerse todos los libres)', async () => {
    prismaMock.aggregatorCapacityRule.findFirst.mockResolvedValueOnce({ id: 'r0' } as any)
    prismaMock.aggregatorCapacityRule.findMany.mockResolvedValue([])
    jest.spyOn(suggestions, 'loadPassSuggestions').mockResolvedValue([])
    await setDefaultPassCap('v1', null, 's1', NOW)
    expect(prismaMock.aggregatorCapacityRule.delete.mock.calls[0][0]).toEqual({ where: { id: 'r0' } })
  })
  // nuevo
  it('null sin regla general es un no-op: no escribe, no encola y no deja rastro', async () => {
    prismaMock.aggregatorCapacityRule.findFirst.mockResolvedValueOnce(null)
    await setDefaultPassCap('v1', null, 's1', NOW)
    expect(prismaMock.aggregatorCapacityRule.delete).not.toHaveBeenCalled()
    expect(sync.enqueueHorizonSessionsSync).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })
  // nuevo
  it('un cambio real deja rastro en ActivityLog con quién lo hizo', async () => {
    prismaMock.aggregatorCapacityRule.findFirst.mockResolvedValueOnce({ id: 'r0' } as any)
    await setDefaultPassCap('v1', 2, 's1', NOW)
    expect(prismaMock.aggregatorCapacityRule.update.mock.calls[0][0]).toEqual({ where: { id: 'r0' }, data: { maxSpots: 2 } })
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ staffId: 's1', venueId: 'v1', action: 'PASS_CAPACITY_DEFAULT_SET', data: { maxSpots: 2 } }),
    )
  })
  // nuevo
  it('fuera de rango ⇒ 400', async () => {
    await expect(setDefaultPassCap('v1', -1, 's1', NOW)).rejects.toMatchObject({ statusCode: 400 })
    await expect(setDefaultPassCap('v1', 501, 's1', NOW)).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('upsertWeeklyPassCap', () => {
  // nuevo
  it('la misma combinación día+hora actualiza la existente en vez de duplicarla', async () => {
    prismaMock.aggregatorCapacityRule.findFirst.mockResolvedValueOnce({ id: 'r1' } as any)
    prismaMock.aggregatorCapacityRule.update.mockResolvedValueOnce({ id: 'r1', weekday: 6, startMinute: 540, maxSpots: 2 } as any)
    const r = await upsertWeeklyPassCap('v1', { weekday: 6, startMinute: 540, maxSpots: 2 }, 's1', NOW)
    expect(prismaMock.aggregatorCapacityRule.findFirst.mock.calls[0][0].where).toEqual({
      venueId: 'v1',
      scope: 'WEEKLY',
      weekday: 6,
      startMinute: 540,
    })
    expect(r).toEqual({ id: 'r1', weekday: 6, startMinute: 540, maxSpots: 2 })
    expect(prismaMock.aggregatorCapacityRule.create).not.toHaveBeenCalled()
  })
  // nuevo — H1 (R45): el total de reglas cabe en el take más chico (200) de worker y aceptación
  it(`con ${150} excepciones, crear una nueva ⇒ 400 y no escribe`, async () => {
    expect(MAX_WEEKLY_PASS_RULES).toBe(150)
    prismaMock.aggregatorCapacityRule.findFirst.mockResolvedValueOnce(null)
    prismaMock.aggregatorCapacityRule.count.mockResolvedValueOnce(150)
    await expect(upsertWeeklyPassCap('v1', { weekday: 2, startMinute: 600, maxSpots: 1 }, 's1', NOW)).rejects.toMatchObject({
      statusCode: 400,
      code: 'PASS_CAPACITY_TOO_MANY_RULES',
      message: 'Ya tienes 150 excepciones de lugares. Borra alguna antes de agregar otra.',
    })
    expect(prismaMock.aggregatorCapacityRule.count.mock.calls[0][0]).toEqual({ where: { venueId: 'v1', scope: 'WEEKLY' } })
    expect(prismaMock.aggregatorCapacityRule.create).not.toHaveBeenCalled()
    expect(sync.enqueueHorizonSessionsSync).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })
  // nuevo — H1
  it('con 149 excepciones todavía se puede crear la 150', async () => {
    prismaMock.aggregatorCapacityRule.findFirst.mockResolvedValueOnce(null)
    prismaMock.aggregatorCapacityRule.count.mockResolvedValueOnce(149)
    prismaMock.aggregatorCapacityRule.create.mockResolvedValueOnce({ id: 'rN', weekday: 2, startMinute: 600, maxSpots: 1 } as any)
    await expect(upsertWeeklyPassCap('v1', { weekday: 2, startMinute: 600, maxSpots: 1 }, 's1', NOW)).resolves.toEqual({
      id: 'rN',
      weekday: 2,
      startMinute: 600,
      maxSpots: 1,
    })
  })
  // nuevo — H1
  it('actualizar una existente con 150 excepciones pasa (no cuenta)', async () => {
    prismaMock.aggregatorCapacityRule.findFirst.mockResolvedValueOnce({ id: 'r1' } as any)
    prismaMock.aggregatorCapacityRule.count.mockResolvedValueOnce(150)
    prismaMock.aggregatorCapacityRule.update.mockResolvedValueOnce({ id: 'r1', weekday: 6, startMinute: 540, maxSpots: 3 } as any)
    await expect(upsertWeeklyPassCap('v1', { weekday: 6, startMinute: 540, maxSpots: 3 }, 's1', NOW)).resolves.toEqual({
      id: 'r1',
      weekday: 6,
      startMinute: 540,
      maxSpots: 3,
    })
    expect(prismaMock.aggregatorCapacityRule.count).not.toHaveBeenCalled()
    prismaMock.aggregatorCapacityRule.count.mockReset()
  })
  // nuevo
  it('día u hora inválidos ⇒ 400', async () => {
    await expect(upsertWeeklyPassCap('v1', { weekday: 7, startMinute: null, maxSpots: 1 }, 's1', NOW)).rejects.toMatchObject({
      statusCode: 400,
    })
    await expect(upsertWeeklyPassCap('v1', { weekday: 1, startMinute: 1440, maxSpots: 1 }, 's1', NOW)).rejects.toMatchObject({
      statusCode: 400,
    })
  })
})

describe('deletePassCapRule', () => {
  // nuevo
  it('sólo borra reglas DEFAULT/WEEKLY del propio venue; otra ⇒ 404', async () => {
    prismaMock.aggregatorCapacityRule.findFirst.mockResolvedValueOnce(null)
    await expect(deletePassCapRule('v1', 'rX', 's1', NOW)).rejects.toMatchObject({ statusCode: 404 })
    expect(prismaMock.aggregatorCapacityRule.findFirst.mock.calls[0][0].where).toEqual({
      id: 'rX',
      venueId: 'v1',
      scope: { in: ['DEFAULT', 'WEEKLY'] },
    })
    expect(prismaMock.aggregatorCapacityRule.delete).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })
  // nuevo — H4
  it('la bitácora del borrado dice qué regla era', async () => {
    prismaMock.aggregatorCapacityRule.findFirst.mockResolvedValueOnce({
      id: 'r1',
      scope: 'WEEKLY',
      weekday: 6,
      startMinute: 540,
      maxSpots: 2,
    } as any)
    await deletePassCapRule('v1', 'r1', 's1', NOW)
    expect(prismaMock.aggregatorCapacityRule.delete.mock.calls[0][0]).toEqual({ where: { id: 'r1' } })
    expect(sync.enqueueHorizonSessionsSync).toHaveBeenCalledWith(expect.anything(), 'v1', ['p1'], NOW)
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: 's1',
        venueId: 'v1',
        action: 'PASS_CAPACITY_RULE_DELETED',
        data: { ruleId: 'r1', scope: 'WEEKLY', weekday: 6, startMinute: 540, maxSpots: 2 },
      }),
    )
  })
})

describe('setSessionPassCap', () => {
  // nuevo
  it('valida que la sesión sea del venue, guarda la regla SESSION y encola esa sesión', async () => {
    prismaMock.classSession.findFirst.mockResolvedValueOnce({ id: 's9' } as any)
    prismaMock.aggregatorCapacityRule.findFirst.mockResolvedValueOnce(null)
    prismaMock.aggregatorConnection.findMany.mockResolvedValueOnce([{ id: 'c1' }] as any)
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(null)
    await setSessionPassCap('v1', 's9', 0, 's1')
    expect(prismaMock.classSession.findFirst.mock.calls[0][0].where).toEqual({ id: 's9', venueId: 'v1' }) // H2
    expect(prismaMock.aggregatorCapacityRule.create.mock.calls[0][0].data).toEqual({
      venueId: 'v1',
      scope: 'SESSION',
      classSessionId: 's9',
      maxSpots: 0,
    })
    expect(prismaMock.aggregatorOutbox.create.mock.calls[0][0].data).toMatchObject({ operation: 'SYNC_SESSION', classSessionId: 's9' })
  })
  // nuevo
  it('null sin regla de la sesión es un no-op: no encola ni deja rastro', async () => {
    prismaMock.classSession.findFirst.mockResolvedValueOnce({ id: 's9' } as any)
    prismaMock.aggregatorCapacityRule.findFirst.mockResolvedValueOnce(null)
    await setSessionPassCap('v1', 's9', null, 's1')
    expect(prismaMock.aggregatorCapacityRule.delete).not.toHaveBeenCalled()
    expect(prismaMock.aggregatorOutbox.create).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })
  // nuevo
  it('sesión de otro venue ⇒ 404', async () => {
    prismaMock.classSession.findFirst.mockResolvedValueOnce(null)
    await expect(setSessionPassCap('v1', 'sX', 1, 's1')).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('passesForSessions', () => {
  const s = (id: string, startsAt: string, pass: number, own: number, over: { productId?: string | null; status?: string } = {}) => ({
    id,
    productId: 'p1' as string | null,
    status: 'SCHEDULED',
    ...over,
    capacity: 10,
    startsAt: new Date(startsAt),
    reservations: [
      ...Array.from({ length: pass }, () => ({ partySize: 1, aggregatorBooking: { id: 'b' } })),
      ...Array.from({ length: own }, () => ({ partySize: 1, aggregatorBooking: null })),
    ],
  })
  // nuevo
  it('sin conexión ACTIVE ⇒ null (el calendario no muestra pases)', async () => {
    prismaMock.aggregatorConnection.count.mockResolvedValueOnce(0)
    expect(await passesForSessions('v1', [s('a', '2030-01-11T15:00:00Z', 1, 2)], 'America/Mexico_City')).toBeNull()
  })
  // nuevo
  it('cuenta los lugares de pase y aplica la regla más específica, en UNA consulta de reglas', async () => {
    prismaMock.aggregatorConnection.count.mockResolvedValueOnce(1)
    prismaMock.aggregatorCapacityRule.findMany.mockResolvedValueOnce([
      { scope: 'DEFAULT', weekday: null, startMinute: null, classSessionId: null, maxSpots: 3 },
      { scope: 'SESSION', weekday: null, startMinute: null, classSessionId: 'b', maxSpots: 0 },
    ] as any)
    // H3: una reserva de pase de 2 personas cuenta 2 (la suma de lugares viene de la base; las propias no cuentan).
    prismaMock.reservation.groupBy.mockResolvedValueOnce([{ classSessionId: 'a', _sum: { partySize: 2 } }] as any)
    const m = await passesForSessions(
      'v1',
      [s('a', '2030-01-11T15:00:00Z', 0, 0), s('b', '2030-01-12T15:00:00Z', 0, 0)],
      'America/Mexico_City',
    )
    expect(m!.get('a')).toEqual({ taken: 2, cap: 3, sessionCap: null })
    expect(m!.get('b')).toEqual({ taken: 0, cap: 0, sessionCap: 0 })
    expect(prismaMock.aggregatorCapacityRule.findMany).toHaveBeenCalledTimes(1)
    const q = prismaMock.aggregatorCapacityRule.findMany.mock.calls[0][0]
    expect(q.where).toEqual({ venueId: 'v1', OR: [{ scope: { in: ['DEFAULT', 'WEEKLY'] } }, { classSessionId: { in: ['a', 'b'] } }] })
    expect(q.orderBy).toEqual([{ updatedAt: 'desc' }, { id: 'asc' }]) // R6
    // C10: UNA consulta agregada para todas, con las reservas de pase ya completadas incluidas.
    expect(prismaMock.reservation.groupBy).toHaveBeenCalledTimes(1)
    expect(prismaMock.reservation.groupBy.mock.calls[0][0]).toEqual({
      by: ['classSessionId'],
      where: {
        venueId: 'v1',
        classSessionId: { in: ['a', 'b'] },
        status: { in: ['PENDING', 'CONFIRMED', 'CHECKED_IN', 'COMPLETED'] },
        aggregatorBooking: { isNot: null },
      },
      _sum: { partySize: true },
    })
  })
  // C10 (P2-11) — completar las reservas de pase no borra el historial: «Pases 2 de N» no pasa a «0 de N». El llamador sólo
  // trae las reservas vivas (inscritos y disponibles), así que el conteo de pases no puede salir de ellas.
  it('una sesión con 2 reservas de pase COMPLETED ⇒ taken 2 aunque el llamador no las traiga', async () => {
    prismaMock.aggregatorConnection.count.mockResolvedValueOnce(1)
    prismaMock.aggregatorCapacityRule.findMany.mockResolvedValueOnce([
      { scope: 'DEFAULT', weekday: null, startMinute: null, classSessionId: null, maxSpots: 3 },
    ] as any)
    prismaMock.reservation.groupBy.mockResolvedValueOnce([{ classSessionId: 'pasada', _sum: { partySize: 2 } }] as any)
    const m = await passesForSessions('v1', [s('pasada', '2030-01-09T15:00:00Z', 0, 0, { status: 'COMPLETED' })], 'America/Mexico_City')
    expect(m!.get('pasada')).toEqual({ taken: 2, cap: 3, sessionCap: null })
  })
  // nuevo
  it('las excepciones por día y hora se leen en la hora LOCAL del venue (domingo = 0)', async () => {
    prismaMock.aggregatorConnection.count.mockResolvedValueOnce(1)
    prismaMock.aggregatorCapacityRule.findMany.mockResolvedValueOnce([
      { scope: 'WEEKLY', weekday: 6, startMinute: 540, classSessionId: null, maxSpots: 2 },
      { scope: 'WEEKLY', weekday: 0, startMinute: null, classSessionId: null, maxSpots: 5 },
      { scope: 'DEFAULT', weekday: null, startMinute: null, classSessionId: null, maxSpots: 1 },
    ] as any)
    // 15:00Z = 09:00 en Ciudad de México. 12-ene-2030 es sábado; 13-ene, domingo; 14-ene, lunes.
    const m = await passesForSessions(
      'v1',
      [s('sab', '2030-01-12T15:00:00Z', 0, 0), s('dom', '2030-01-13T15:00:00Z', 0, 0), s('lun', '2030-01-14T15:00:00Z', 0, 0)],
      'America/Mexico_City',
    )
    expect(m!.get('sab')!.cap).toBe(2)
    expect(m!.get('dom')!.cap).toBe(5)
    expect(m!.get('lun')!.cap).toBe(1)
  })
  // nuevo — H5
  it('sólo da pases a clases que el proveedor ve: producto ligado y no cancelada', async () => {
    prismaMock.aggregatorConnection.count.mockResolvedValueOnce(1)
    prismaMock.aggregatorCapacityRule.findMany.mockResolvedValueOnce([
      { scope: 'DEFAULT', weekday: null, startMinute: null, classSessionId: null, maxSpots: 3 },
    ] as any)
    const m = await passesForSessions(
      'v1',
      [
        s('ligada', '2030-01-11T15:00:00Z', 1, 0),
        s('otra', '2030-01-11T16:00:00Z', 0, 0, { productId: 'p2' }),
        s('cancelada', '2030-01-11T17:00:00Z', 0, 0, { status: 'CANCELLED' }),
        s('sinProducto', '2030-01-11T18:00:00Z', 0, 0, { productId: null }),
        s('pasada', '2030-01-11T19:00:00Z', 0, 0, { status: 'COMPLETED' }),
      ],
      'America/Mexico_City',
    )
    expect([...m!.keys()]).toEqual(['ligada', 'pasada'])
    expect(m!.get('ligada')).toEqual({ taken: 0, cap: 3, sessionCap: null })
    // El conteo de pases también se pide sólo para las que entran al mapa.
    expect(prismaMock.reservation.groupBy.mock.calls[0][0].where.classSessionId).toEqual({ in: ['ligada', 'pasada'] })
    const links = prismaMock.aggregatorProductLink.findMany.mock.calls[0][0]
    expect(links.where).toEqual({ active: true, productId: { in: ['p1', 'p2'] }, connection: { venueId: 'v1', status: 'ACTIVE' } })
    expect(links.take).toBeGreaterThan(0)
    // Las reglas de sesión sólo se piden para las que entran al mapa.
    expect(prismaMock.aggregatorCapacityRule.findMany.mock.calls[0][0].where.OR[1]).toEqual({
      classSessionId: { in: ['ligada', 'pasada'] },
    })
  })
  // nuevo — H5
  it('con conexión ACTIVE pero ninguna clase ligada ⇒ mapa vacío (no null) y sin consultar reglas', async () => {
    prismaMock.aggregatorConnection.count.mockResolvedValueOnce(1)
    prismaMock.aggregatorProductLink.findMany.mockResolvedValueOnce([])
    const m = await passesForSessions('v1', [s('a', '2030-01-11T15:00:00Z', 0, 0)], 'America/Mexico_City')
    expect(m).toEqual(new Map())
    expect(prismaMock.aggregatorCapacityRule.findMany).not.toHaveBeenCalled()
    expect(prismaMock.reservation.groupBy).not.toHaveBeenCalled()
  })
})
