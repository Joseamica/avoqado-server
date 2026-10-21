import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { ConflictError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import * as checkIn from '@/services/reservation/checkIn.service'
import {
  confirmPassVisit,
  listPassVisits,
  localDayRange,
  rejectPassVisit,
  summarizePassVisits,
} from '@/services/aggregators/passVisits.service'

const NOW = new Date('2030-01-10T12:00:00Z')
const visit = (over: Record<string, unknown> = {}) => ({
  id: 'vis1',
  provider: 'TOTALPASS',
  status: 'PENDING',
  connectionId: 'c1',
  venueId: 'v1',
  externalUserId: 'U1',
  startedAt: new Date('2030-01-10T11:55:00Z'),
  deadlineAt: new Date('2030-01-10T13:25:00Z'),
  confirmedAt: null,
  confirmedBy: null,
  lastError: null,
  reservationId: null,
  reservation: null,
  validationRef: 'https://admin.totalpass.com/api/v1/webhook_confirmations/SECRETO',
  connection: { confirmMode: 'ON_VENUE_CHECKIN', status: 'ACTIVE' },
  ...over,
})
const checkInSpy = jest.spyOn(checkIn, 'checkInReservation')

/** Texto del SQL de una llamada a `tx.$queryRaw` con plantilla (el primer argumento son los trozos). */
const sqlOf = (call: unknown[]): string => (call[0] as string[]).join('?')

beforeEach(() => {
  checkInSpy.mockReset()
  // Quién la había confirmado antes (dentro de la transacción de confirmar): nadie, salvo que la prueba diga otra cosa.
  prismaMock.aggregatorVisit.findUnique.mockReset()
  prismaMock.aggregatorVisit.findUnique.mockResolvedValue({ confirmedBy: null } as any)
  // Candados del rechazo (FOR UPDATE de la visita y de la reserva): sin reserva no hay estado que leer.
  prismaMock.$queryRaw.mockReset()
  prismaMock.$queryRaw.mockResolvedValue([])
  prismaMock.$transaction.mockImplementation(async (arg: any) => (typeof arg === 'function' ? arg(prismaMock) : arg))
  prismaMock.aggregatorOutbox.findFirst.mockResolvedValue(null)
  prismaMock.customerExternalIdentity.findMany.mockResolvedValue([])
  prismaMock.aggregatorVisit.updateMany.mockResolvedValue({ count: 1 })
})

describe('listPassVisits', () => {
  // nuevo
  it('filtros en la base, paginado acotado y nunca expone la URL de validación', async () => {
    prismaMock.aggregatorVisit.findMany.mockResolvedValueOnce([visit()] as any)
    prismaMock.aggregatorVisit.count.mockResolvedValueOnce(1)
    const r = await listPassVisits('v1', { status: 'PENDING', limit: 500 }, NOW)
    const q = prismaMock.aggregatorVisit.findMany.mock.calls[0][0]
    expect(q.where).toMatchObject({ venueId: 'v1', status: 'PENDING' })
    expect(q.take).toBe(100)
    expect(q.orderBy).toEqual([{ startedAt: 'desc' }, { id: 'desc' }])
    expect(r).toMatchObject({ total: 1, hasMore: false, nextOffset: null })
    expect(r.items[0]).toMatchObject({ id: 'vis1', canConfirm: true, canReject: true })
    expect(JSON.stringify(r)).not.toMatch(/SECRETO|webhook_confirmations/)
  })
  // nuevo
  it('una visita vencida o ya confirmada no se puede confirmar ni rechazar', async () => {
    prismaMock.aggregatorVisit.findMany.mockResolvedValueOnce([
      visit({ status: 'PENDING', deadlineAt: new Date('2030-01-10T11:00:00Z') }),
      visit({ id: 'v2', status: 'CONFIRMED' }),
    ] as any)
    prismaMock.aggregatorVisit.count.mockResolvedValueOnce(2)
    const r = await listPassVisits('v1', {}, NOW)
    expect(r.items.map(i => [i.canConfirm, i.canReject])).toEqual([
      [false, false],
      [false, false],
    ])
  })
  // nuevo — paginado: la segunda página sigue donde se quedó la primera, filtros de fecha y proveedor en la base
  it('página siguiente con offset, filtros de proveedor y fechas, y el total real', async () => {
    prismaMock.aggregatorVisit.findMany.mockResolvedValueOnce([visit(), visit({ id: 'vis2' })] as any)
    prismaMock.aggregatorVisit.count.mockResolvedValueOnce(5)
    const from = new Date('2030-01-01T06:00:00Z')
    const to = new Date('2030-01-11T06:00:00Z')
    const r = await listPassVisits('v1', { provider: 'TOTALPASS', from, to, limit: 2, offset: 2 }, NOW)
    const q = prismaMock.aggregatorVisit.findMany.mock.calls[0][0]
    expect(q).toMatchObject({ skip: 2, take: 2, where: { venueId: 'v1', provider: 'TOTALPASS', startedAt: { gte: from, lt: to } } })
    expect(prismaMock.aggregatorVisit.count.mock.calls[0][0].where).toEqual(q.where)
    expect(r).toMatchObject({ total: 5, hasMore: true, nextOffset: 4 })
  })
  // nuevo — un límite que no es número no rompe la consulta
  it('límite u offset no numéricos ⇒ página por defecto de 50 desde el inicio', async () => {
    prismaMock.aggregatorVisit.findMany.mockResolvedValueOnce([] as any)
    prismaMock.aggregatorVisit.count.mockResolvedValueOnce(0)
    const r = await listPassVisits('v1', { limit: Number.NaN, offset: Number.NaN }, NOW)
    expect(prismaMock.aggregatorVisit.findMany.mock.calls[0][0]).toMatchObject({ skip: 0, take: 50 })
    expect(r).toEqual({ items: [], total: 0, hasMore: false, nextOffset: null })
  })
  // nuevo — nombre del socio: de la reserva o, sin reserva, de su identidad en el proveedor
  it('el nombre del socio sale de la reserva o de su identidad ligada; el error se muestra sin URLs', async () => {
    prismaMock.aggregatorVisit.findMany.mockResolvedValueOnce([
      visit({
        reservationId: 'r1',
        lastError: 'Reintentando con el proveedor: HTTP_503: falló https://admin.totalpass.com/x/TOKEN',
        reservation: {
          id: 'r1',
          classSessionId: 's1',
          startsAt: new Date('2030-01-10T12:00:00Z'),
          guestName: null,
          product: { name: 'Yoga' },
          customer: { firstName: 'Ana', lastName: 'López' },
        },
      }),
      visit({ id: 'vis2', externalUserId: 'U2' }),
    ] as any)
    prismaMock.aggregatorVisit.count.mockResolvedValueOnce(2)
    prismaMock.customerExternalIdentity.findMany.mockResolvedValueOnce([
      { provider: 'TOTALPASS', externalUserId: 'U2', customer: { firstName: 'Beto', lastName: null } },
    ] as any)
    const r = await listPassVisits('v1', {}, NOW)
    expect(r.items[0]).toMatchObject({
      memberName: 'Ana López',
      reservation: { id: 'r1', classSessionId: 's1', startsAt: '2030-01-10T12:00:00.000Z', productName: 'Yoga' },
    })
    expect(r.items[0].lastError).not.toMatch(/TOKEN|https?:/)
    expect(r.items[1]).toMatchObject({ memberName: 'Beto', reservation: null })
    expect(prismaMock.customerExternalIdentity.findMany.mock.calls[0][0].where).toEqual({
      venueId: 'v1',
      OR: [{ provider: 'TOTALPASS', externalUserId: 'U2' }],
    })
  })
  // C6 (P1-6) — cada visita dice el estado REAL de su validación (la última fila VALIDATE_VISIT), en UNA consulta por página
  it('validation sale de la última fila VALIDATE_VISIT de cada visita, con una sola consulta por página', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    prismaMock.aggregatorVisit.findMany.mockResolvedValueOnce(ids.map(id => visit({ id })) as any)
    prismaMock.aggregatorVisit.count.mockResolvedValueOnce(ids.length)
    const key = (id: string) => `VALIDATE_VISIT:c1:${id}`
    prismaMock.$queryRaw.mockResolvedValueOnce([
      { coalesceKey: key('a'), status: 'PENDING' },
      { coalesceKey: key('b'), status: 'IN_PROGRESS' },
      { coalesceKey: key('c'), status: 'FAILED' },
      { coalesceKey: key('d'), status: 'DEAD_LETTER' },
      { coalesceKey: key('e'), status: 'SKIPPED' },
      { coalesceKey: key('f'), status: 'DONE' },
    ])
    const r = await listPassVisits('v1', {}, NOW)
    expect(r.items.map(i => [i.id, i.validation])).toEqual([
      ['a', 'QUEUED'],
      ['b', 'IN_PROGRESS'],
      ['c', 'RETRYING'],
      ['d', 'FAILED'],
      ['e', 'FAILED'],
      ['f', 'DONE'],
      ['g', 'NONE'],
    ])
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1)
    const [strings, ...values] = prismaMock.$queryRaw.mock.calls[0]
    const q = Prisma.sql(strings as TemplateStringsArray, ...values)
    expect(q.sql.replace(/\s+/g, ' ')).toMatch(
      /SELECT DISTINCT ON \("coalesceKey"\) .* FROM "AggregatorOutbox" WHERE "venueId" = \? AND "coalesceKey" IN \(.*\) ORDER BY "coalesceKey", "createdAt" DESC, id DESC/,
    )
    expect(q.values).toEqual(['v1', ...ids.map(key)])
  })
  // C6 — una validación que fracasó (DEAD_LETTER/SKIPPED) con la visita aún en plazo se puede confirmar de nuevo
  it('validación FAILED y la visita sigue PENDING en plazo ⇒ canConfirm (confirmar de nuevo crea otra fila)', async () => {
    prismaMock.aggregatorVisit.findMany.mockResolvedValueOnce([visit()] as any)
    prismaMock.aggregatorVisit.count.mockResolvedValueOnce(1)
    prismaMock.$queryRaw.mockResolvedValueOnce([{ coalesceKey: 'VALIDATE_VISIT:c1:vis1', status: 'DEAD_LETTER' }])
    const r = await listPassVisits('v1', {}, NOW)
    expect(r.items[0]).toMatchObject({ validation: 'FAILED', canConfirm: true, canReject: true })
  })
  // C6 — página vacía: ninguna consulta a la bandeja
  it('sin visitas no consulta la bandeja', async () => {
    prismaMock.aggregatorVisit.findMany.mockResolvedValueOnce([] as any)
    prismaMock.aggregatorVisit.count.mockResolvedValueOnce(0)
    await listPassVisits('v1', {}, NOW)
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
  })
  // ronda 1 — H1: `confirmedBy` sólo dice algo de una visita confirmada
  it('confirmedBy sólo se expone en una visita confirmada (en PENDING, vencida o rechazada sale null)', async () => {
    prismaMock.aggregatorVisit.findMany.mockResolvedValueOnce([
      visit({ status: 'PENDING', confirmedBy: 'VENUE' }),
      visit({ id: 'v2', status: 'CONFIRMED', confirmedBy: 'VENUE', confirmedAt: NOW }),
      visit({ id: 'v3', status: 'ALREADY_CONFIRMED', confirmedBy: 'AUTO', confirmedAt: NOW }),
      visit({ id: 'v4', status: 'EXPIRED', confirmedBy: 'VENUE' }),
      visit({ id: 'v5', status: 'REJECTED', confirmedBy: 'VENUE' }),
    ] as any)
    prismaMock.aggregatorVisit.count.mockResolvedValueOnce(5)
    const r = await listPassVisits('v1', {}, NOW)
    expect(r.items.map(i => i.confirmedBy)).toEqual([null, 'VENUE', 'AUTO', null, null])
  })
})

describe('confirmPassVisit', () => {
  // nuevo
  it('sin reserva ligada ⇒ encola la validación', async () => {
    prismaMock.aggregatorVisit.findFirst.mockResolvedValueOnce(visit() as any).mockResolvedValueOnce(visit() as any)
    await confirmPassVisit('v1', 'vis1', 'staff1', NOW)
    expect(prismaMock.aggregatorOutbox.create.mock.calls[0][0].data).toMatchObject({
      operation: 'VALIDATE_VISIT',
      aggregatorVisitId: 'vis1',
    })
    expect(checkInSpy).not.toHaveBeenCalled()
  })
  // nuevo
  it('con reserva ⇒ hace el check-in de la reserva como el dashboard (actor humano) y encola', async () => {
    prismaMock.aggregatorVisit.findFirst
      .mockResolvedValueOnce(visit({ reservationId: 'r1' }) as any)
      .mockResolvedValueOnce(visit({ reservationId: 'r1' }) as any)
    checkInSpy.mockResolvedValueOnce({ outcome: 'CHECKED_IN' } as any)
    await confirmPassVisit('v1', 'vis1', 'staff1', NOW)
    expect(checkInSpy.mock.calls[0][1]).toEqual({
      reservationId: 'r1',
      venueId: 'v1',
      actor: { type: 'HUMAN', staffId: 'staff1' },
      source: 'DASHBOARD',
      now: NOW,
    })
    expect(prismaMock.aggregatorOutbox.create).toHaveBeenCalledTimes(1)
  })
  // nuevo — Review Focus 2 · C7 (P3-18): y UNA sola bitácora (el reintento no fue una solicitud efectiva)
  it('confirmar dos veces (el dashboard reintenta el POST) deja UNA validación encolada y UNA bitácora', async () => {
    prismaMock.aggregatorVisit.findFirst
      .mockResolvedValueOnce(visit() as any)
      .mockResolvedValueOnce(visit() as any)
      .mockResolvedValueOnce(visit({ confirmedBy: 'VENUE' }) as any)
      .mockResolvedValueOnce(visit({ confirmedBy: 'VENUE' }) as any)
    // Dentro de la transacción: quién la había confirmado antes de este POST.
    prismaMock.aggregatorVisit.findUnique
      .mockResolvedValueOnce({ confirmedBy: null } as any)
      .mockResolvedValueOnce({ confirmedBy: 'VENUE' } as any)
    // 1º: nada esperando ni en curso ⇒ crea; 2º: ya está esperando ⇒ sólo la adelanta.
    prismaMock.aggregatorOutbox.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'o1' } as any)
    await confirmPassVisit('v1', 'vis1', 'staff1', NOW)
    await confirmPassVisit('v1', 'vis1', 'staff1', NOW)
    expect(prismaMock.aggregatorOutbox.create).toHaveBeenCalledTimes(1)
    expect((logAction as jest.Mock).mock.calls.map(c => c[0].action)).toEqual(['PASS_VISIT_CONFIRMED'])
  })
  // C7 (P2-8) — reintento mientras el worker ya está validando con el proveedor: ni otra fila ni otra bitácora
  it('reintentar Confirmar con la validación en curso (IN_PROGRESS, lease vivo) ⇒ ni otra validación ni otra bitácora', async () => {
    prismaMock.aggregatorVisit.findFirst
      .mockResolvedValueOnce(visit({ confirmedBy: 'VENUE' }) as any)
      .mockResolvedValueOnce(visit({ confirmedBy: 'VENUE' }) as any)
    prismaMock.aggregatorVisit.findUnique.mockResolvedValueOnce({ confirmedBy: 'VENUE' } as any)
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'o1' } as any)
    await confirmPassVisit('v1', 'vis1', 'staff1', NOW)
    expect(prismaMock.aggregatorOutbox.create).not.toHaveBeenCalled()
    expect(prismaMock.aggregatorOutbox.update).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })
  // C7 — la validación anterior ya no se reintenta (DEAD_LETTER): confirmar de nuevo SÍ es efectivo
  it('volver a confirmar tras una validación que ya no se reintenta ⇒ crea otra fila y sí deja rastro', async () => {
    prismaMock.aggregatorVisit.findFirst
      .mockResolvedValueOnce(visit({ confirmedBy: 'VENUE' }) as any)
      .mockResolvedValueOnce(visit({ confirmedBy: 'VENUE' }) as any)
    prismaMock.aggregatorVisit.findUnique.mockResolvedValueOnce({ confirmedBy: 'VENUE' } as any)
    await confirmPassVisit('v1', 'vis1', 'staff1', NOW)
    expect(prismaMock.aggregatorOutbox.create).toHaveBeenCalledTimes(1)
    expect((logAction as jest.Mock).mock.calls.map(c => c[0].action)).toEqual(['PASS_VISIT_CONFIRMED'])
  })
  // nuevo
  it('ya no PENDING ⇒ devuelve la visita como está, sin escribir', async () => {
    prismaMock.aggregatorVisit.findFirst.mockResolvedValueOnce(visit({ status: 'CONFIRMED' }) as any)
    const v = await confirmPassVisit('v1', 'vis1', 'staff1', NOW)
    expect(v.status).toBe('CONFIRMED')
    expect(prismaMock.aggregatorOutbox.create).not.toHaveBeenCalled()
  })
  // nuevo
  it('plazo vencido ⇒ 409 que lo dice', async () => {
    prismaMock.aggregatorVisit.findFirst.mockResolvedValueOnce(visit({ deadlineAt: new Date('2030-01-10T11:00:00Z') }) as any)
    await expect(confirmPassVisit('v1', 'vis1', 'staff1', NOW)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/venció/),
    })
  })
  // nuevo
  it('otra visita de otro venue ⇒ 404', async () => {
    prismaMock.aggregatorVisit.findFirst.mockResolvedValueOnce(null)
    await expect(confirmPassVisit('v1', 'vX', 'staff1', NOW)).rejects.toMatchObject({ statusCode: 404 })
  })
  // nuevo
  it('la reserva ya no admite check-in ⇒ igual se valida la visita (el socio sí llegó)', async () => {
    prismaMock.aggregatorVisit.findFirst
      .mockResolvedValueOnce(visit({ reservationId: 'r1' }) as any)
      .mockResolvedValueOnce(visit({ reservationId: 'r1' }) as any)
    checkInSpy.mockRejectedValueOnce(new ConflictError('x', checkIn.RESERVATION_NOT_CHECKINABLE))
    await confirmPassVisit('v1', 'vis1', 'staff1', NOW)
    expect(prismaMock.aggregatorOutbox.create).toHaveBeenCalledTimes(1)
  })
  // nuevo — cualquier otro error del check-in no se traga: no se encola nada
  it('otro error del check-in ⇒ se propaga y no se encola la validación', async () => {
    prismaMock.aggregatorVisit.findFirst.mockResolvedValueOnce(visit({ reservationId: 'r1' }) as any)
    checkInSpy.mockRejectedValueOnce(new Error('base caída'))
    await expect(confirmPassVisit('v1', 'vis1', 'staff1', NOW)).rejects.toThrow('base caída')
    expect(prismaMock.aggregatorOutbox.create).not.toHaveBeenCalled()
  })
  // ronda 1 — H1: la confirmación humana queda como VENUE aunque la conexión sea AUTO
  it('confirmar desde el dashboard marca la visita como confirmada por el estudio, con candado de estado', async () => {
    const auto = visit({ connection: { confirmMode: 'AUTO', status: 'ACTIVE' } })
    prismaMock.aggregatorVisit.findFirst.mockResolvedValueOnce(auto as any).mockResolvedValueOnce(auto as any)
    await confirmPassVisit('v1', 'vis1', 'staff1', NOW)
    expect(prismaMock.aggregatorVisit.updateMany.mock.calls[0][0]).toEqual({
      where: { id: 'vis1', venueId: 'v1', status: 'PENDING' },
      data: { confirmedBy: 'VENUE' },
    })
    expect(prismaMock.aggregatorOutbox.create).toHaveBeenCalledTimes(1)
  })
  // ronda 1 — la visita se resolvió (rechazo, plazo, worker) entre la lectura y la transacción ⇒ no se toca la reserva ni se encola
  it('si la visita dejó de estar PENDING antes de la transacción ⇒ sin check-in, sin encolar y sin bitácora', async () => {
    prismaMock.aggregatorVisit.findFirst
      .mockResolvedValueOnce(visit({ reservationId: 'r1' }) as any)
      .mockResolvedValueOnce(visit({ reservationId: 'r1', status: 'REJECTED' }) as any)
    prismaMock.aggregatorVisit.updateMany.mockResolvedValueOnce({ count: 0 })
    const v = await confirmPassVisit('v1', 'vis1', 'staff1', NOW)
    expect(v.status).toBe('REJECTED')
    expect(checkInSpy).not.toHaveBeenCalled()
    expect(prismaMock.aggregatorOutbox.create).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })
  // ronda 1 — H3: con la conexión pausada o revocada la validación se saltaría en silencio
  it.each(['PAUSED', 'REVOKED'])('conexión %s ⇒ 409 PASS_CONNECTION_NOT_ACTIVE, sin escribir nada', async status => {
    prismaMock.aggregatorVisit.findFirst.mockResolvedValueOnce(
      visit({ reservationId: 'r1', connection: { confirmMode: 'ON_VENUE_CHECKIN', status } }) as any,
    )
    await expect(confirmPassVisit('v1', 'vis1', 'staff1', NOW)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PASS_CONNECTION_NOT_ACTIVE',
      message:
        'La conexión con TotalPass no está activa: no se puede confirmar ahora. Revisa la conexión en Configuración › Integraciones › Pases.',
    })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(checkInSpy).not.toHaveBeenCalled()
    expect(prismaMock.aggregatorVisit.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.aggregatorOutbox.create).not.toHaveBeenCalled()
  })
})

describe('rejectPassVisit', () => {
  // nuevo
  it('una PENDING en plazo pasa a REJECTED y su validación encolada se descarta, en la misma transacción', async () => {
    prismaMock.aggregatorVisit.findFirst
      .mockResolvedValueOnce(visit() as any) // existe (404 si no)
      .mockResolvedValueOnce(visit() as any) // dentro de la transacción
      .mockResolvedValueOnce(visit({ status: 'REJECTED' }) as any) // vista final
    prismaMock.aggregatorVisit.updateMany.mockResolvedValueOnce({ count: 1 })
    const v = await rejectPassVisit('v1', 'vis1', 'staff1', NOW)
    expect(prismaMock.aggregatorOutbox.updateMany.mock.calls[0][0]).toEqual({
      where: { coalesceKey: 'VALIDATE_VISIT:c1:vis1', status: { in: ['PENDING', 'FAILED'] } },
      data: { status: 'SKIPPED', lastError: 'Rechazada por el estudio', processedAt: NOW },
    })
    expect(prismaMock.aggregatorVisit.updateMany.mock.calls[0][0]).toEqual({
      where: { id: 'vis1', venueId: 'v1', status: 'PENDING' },
      data: { status: 'REJECTED', lastError: 'Rechazada por el estudio' },
    })
    expect(v.status).toBe('REJECTED')
    expect((logAction as jest.Mock).mock.calls.map(c => c[0].action)).toEqual(['PASS_VISIT_REJECTED'])
  })
  // ronda 1 — H2: un intento que rechazó y no pudo hacer COMMIT (40001) no deja un rechazo falso en la bitácora
  it('reintento por conflicto de serialización que encuentra la visita ya resuelta ⇒ ningún PASS_VISIT_REJECTED', async () => {
    prismaMock.aggregatorVisit.findFirst
      .mockResolvedValueOnce(visit() as any) // existe
      .mockResolvedValueOnce(visit() as any) // intento 1: PENDING, rechaza…
      .mockResolvedValueOnce(visit({ status: 'CONFIRMED' }) as any) // intento 2: ya la resolvió el worker
      .mockResolvedValueOnce(visit({ status: 'CONFIRMED' }) as any) // vista final
    prismaMock.$transaction
      .mockImplementationOnce(async (fn: any) => {
        await fn(prismaMock)
        throw Object.assign(new Error('could not serialize access'), { code: 'P2034' }) // …y su COMMIT falla
      })
      .mockImplementationOnce(async (fn: any) => fn(prismaMock))
    const v = await rejectPassVisit('v1', 'vis1', 'staff1', NOW)
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2)
    expect(prismaMock.aggregatorVisit.updateMany).toHaveBeenCalledTimes(1) // sólo el intento que se deshizo
    expect(v.status).toBe('CONFIRMED')
    expect(logAction).not.toHaveBeenCalled()
  })
  // nuevo — P1-6: el worker ya está llamando al proveedor con esta visita
  it('con la validación en curso (lease vigente) ⇒ 409 «se está confirmando», sin tocar nada', async () => {
    prismaMock.aggregatorVisit.findFirst.mockResolvedValueOnce(visit() as any).mockResolvedValueOnce(visit() as any)
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce({ id: 'o1' } as any)
    await expect(rejectPassVisit('v1', 'vis1', 'staff1', NOW)).rejects.toMatchObject({ statusCode: 409, code: 'PASS_VISIT_VALIDATING' })
    expect(prismaMock.aggregatorOutbox.findFirst.mock.calls[0][0].where).toEqual({
      coalesceKey: 'VALIDATE_VISIT:c1:vis1',
      status: 'IN_PROGRESS',
      leaseUntil: { gt: NOW },
    })
    expect(prismaMock.aggregatorVisit.updateMany).not.toHaveBeenCalled()
  })
  // nuevo — P1-6: vencida no se rechaza
  it('vencida ⇒ 409, sin tocar nada', async () => {
    const expired = visit({ deadlineAt: new Date('2030-01-10T11:00:00Z') })
    prismaMock.aggregatorVisit.findFirst.mockResolvedValueOnce(expired as any).mockResolvedValueOnce(expired as any)
    await expect(rejectPassVisit('v1', 'vis1', 'staff1', NOW)).rejects.toMatchObject({ statusCode: 409 })
    expect(prismaMock.aggregatorVisit.updateMany).not.toHaveBeenCalled()
  })
  // nuevo
  it('ya resuelta (no PENDING) ⇒ la devuelve como está, sin escribir', async () => {
    prismaMock.aggregatorVisit.findFirst
      .mockResolvedValueOnce(visit({ status: 'CONFIRMED' }) as any)
      .mockResolvedValueOnce(visit({ status: 'CONFIRMED' }) as any)
      .mockResolvedValueOnce(visit({ status: 'CONFIRMED' }) as any)
    const v = await rejectPassVisit('v1', 'vis1', 'staff1', NOW)
    expect(v.status).toBe('CONFIRMED')
    expect(prismaMock.aggregatorOutbox.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.aggregatorVisit.updateMany).not.toHaveBeenCalled()
  })
  // nuevo
  it('otra visita de otro venue ⇒ 404', async () => {
    prismaMock.aggregatorVisit.findFirst.mockResolvedValueOnce(null)
    await expect(rejectPassVisit('v1', 'vX', 'staff1', NOW)).rejects.toMatchObject({ statusCode: 404 })
  })

  // revisión final — F1: la reserva es la fuente de asistencia (pago a coaches); un «no vino» no la deja en CHECKED_IN
  describe('con reserva ligada', () => {
    const checkedIn = {
      id: 'r1',
      venueId: 'v1',
      status: 'CHECKED_IN',
      confirmationCode: 'PASE-1',
      statusLog: [
        { status: 'CONFIRMED', at: '2030-01-10T11:00:00.000Z', by: 'service:pases' },
        { status: 'CHECKED_IN', at: '2030-01-10T11:56:00.000Z', by: 'staff1', source: 'DASHBOARD' },
      ],
    }
    /** El estado que manda es el que se lee BAJO el candado de la reserva, no el de la lectura de la visita. */
    const inTx = (status: string) => {
      prismaMock.$queryRaw.mockResolvedValueOnce([{ id: 'vis1' }]).mockResolvedValueOnce([{ status }])
      return visit({ reservationId: 'r1' })
    }

    // C2 (P1-2) — un check-in normal que se confirmó mientras corría el rechazo: la lectura de la visita aún decía
    // CONFIRMED, pero bajo el candado la reserva ya está CHECKED_IN ⇒ se deshace igual (antes se omitía el undo).
    it('bloquea la visita y luego la reserva (FOR UPDATE) y decide el undo con el estado releído bajo el candado', async () => {
      prismaMock.aggregatorVisit.findFirst
        .mockResolvedValueOnce(visit() as any) // existe
        .mockResolvedValueOnce(visit({ reservationId: 'r1', reservation: { status: 'CONFIRMED' } }) as any) // lectura vieja
        .mockResolvedValueOnce(visit({ status: 'REJECTED' }) as any) // vista final
      prismaMock.$queryRaw.mockResolvedValueOnce([{ id: 'vis1' }]).mockResolvedValueOnce([{ status: 'CHECKED_IN' }])
      prismaMock.reservation.findFirst.mockResolvedValueOnce(checkedIn as any)
      prismaMock.order.findMany.mockResolvedValueOnce([])
      prismaMock.reservation.updateMany.mockResolvedValueOnce({ count: 1 })
      prismaMock.venue.findUniqueOrThrow.mockResolvedValueOnce({ organizationId: 'org1' } as any)
      prismaMock.reservation.findUniqueOrThrow.mockResolvedValueOnce({ id: 'r1' } as any)
      await rejectPassVisit('v1', 'vis1', 'staff1', NOW)
      const [visitLock, reservationLock] = prismaMock.$queryRaw.mock.calls
      expect(sqlOf(visitLock)).toMatch(/FROM "AggregatorVisit" WHERE id = \? AND "venueId" = \? FOR UPDATE/)
      expect(visitLock.slice(1)).toEqual(['vis1', 'v1'])
      expect(sqlOf(reservationLock)).toMatch(/FROM "Reservation" WHERE id = \? FOR UPDATE/)
      expect(reservationLock[1]).toBe('r1')
      expect(prismaMock.reservation.updateMany.mock.calls[0][0]).toMatchObject({
        where: { id: 'r1', venueId: 'v1', status: 'CHECKED_IN' },
        data: { status: 'CONFIRMED', checkedInAt: null },
      })
      expect(prismaMock.aggregatorVisit.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'REJECTED' })
    })

    it('reserva CHECKED_IN ⇒ vuelve a su estado previo en la misma transacción y la visita queda REJECTED', async () => {
      prismaMock.aggregatorVisit.findFirst
        .mockResolvedValueOnce(visit() as any) // existe
        .mockResolvedValueOnce(inTx('CHECKED_IN') as any) // dentro de la transacción
        .mockResolvedValueOnce(visit({ status: 'REJECTED' }) as any) // vista final
      prismaMock.reservation.findFirst.mockResolvedValueOnce(checkedIn as any)
      prismaMock.order.findMany.mockResolvedValueOnce([])
      prismaMock.reservation.updateMany.mockResolvedValueOnce({ count: 1 })
      prismaMock.venue.findUniqueOrThrow.mockResolvedValueOnce({ organizationId: 'org1' } as any)
      prismaMock.reservation.findUniqueOrThrow.mockResolvedValueOnce({ id: 'r1' } as any)
      const v = await rejectPassVisit('v1', 'vis1', 'staff1', NOW)
      expect(prismaMock.reservation.updateMany.mock.calls[0][0]).toMatchObject({
        where: { id: 'r1', venueId: 'v1', status: 'CHECKED_IN' },
        data: { status: 'CONFIRMED', checkedInAt: null },
      })
      expect(prismaMock.activityLog.create.mock.calls[0][0].data).toMatchObject({
        action: 'RESERVATION_CHECK_IN_UNDONE',
        staffId: 'staff1',
        data: { source: 'DASHBOARD', reason: 'Visita de pase rechazada' },
      })
      expect(prismaMock.aggregatorVisit.updateMany.mock.calls[0][0].data).toEqual({
        status: 'REJECTED',
        lastError: 'Rechazada por el estudio',
      })
      expect(v.status).toBe('REJECTED')
    })

    it('reserva CONFIRMED ⇒ no se toca; la visita queda REJECTED', async () => {
      prismaMock.aggregatorVisit.findFirst
        .mockResolvedValueOnce(visit() as any)
        .mockResolvedValueOnce(inTx('CONFIRMED') as any)
        .mockResolvedValueOnce(visit({ status: 'REJECTED' }) as any)
      const v = await rejectPassVisit('v1', 'vis1', 'staff1', NOW)
      expect(prismaMock.reservation.findFirst).not.toHaveBeenCalled()
      expect(prismaMock.reservation.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.aggregatorVisit.updateMany).toHaveBeenCalledTimes(1)
      expect(v.status).toBe('REJECTED')
    })

    it('el check-in no se puede deshacer (ya hay un cobro) ⇒ 409 que dice qué hacer, sin escribir nada', async () => {
      prismaMock.aggregatorVisit.findFirst.mockResolvedValueOnce(visit() as any).mockResolvedValueOnce(inTx('CHECKED_IN') as any)
      prismaMock.reservation.findFirst.mockResolvedValueOnce(checkedIn as any)
      prismaMock.order.findMany.mockResolvedValueOnce([{ id: 'o1', payments: [{ id: 'p1' }] }] as any)
      await expect(rejectPassVisit('v1', 'vis1', 'staff1', NOW)).rejects.toMatchObject({
        statusCode: 409,
        code: 'PASS_VISIT_CHECK_IN_NOT_UNDONE',
        message: expect.stringMatching(/cobro registrado.*reembolsa/),
      })
      expect(prismaMock.reservation.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.aggregatorOutbox.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.aggregatorVisit.updateMany).not.toHaveBeenCalled()
      expect(logAction).not.toHaveBeenCalled()
    })
  })
})

describe('localDayRange', () => {
  // nuevo — P2-14: días LOCALES del venue, `to` inclusivo
  it('convierte AAAA-MM-DD con la zona del venue y hace exclusivo el límite superior', () => {
    const r = localDayRange('2030-01-10', '2030-01-10', 'America/Mexico_City')
    expect(r.from!.toISOString()).toBe('2030-01-10T06:00:00.000Z')
    expect(r.to!.toISOString()).toBe('2030-01-11T06:00:00.000Z')
    expect(localDayRange(undefined, undefined, 'America/Mexico_City')).toEqual({})
  })
  // nuevo — fin de mes y de año
  it('el día siguiente cruza el mes y el año', () => {
    expect(localDayRange(undefined, '2030-12-31', 'America/Mexico_City').to!.toISOString()).toBe('2031-01-01T06:00:00.000Z')
  })
  // nuevo — una fecha imposible es un 400, no un 500
  it('fecha imposible ⇒ 400', () => {
    expect(() => localDayRange('2030-13-01', undefined, 'America/Mexico_City')).toThrow(expect.objectContaining({ statusCode: 400 }))
    expect(() => localDayRange(undefined, '2030-13-01', 'America/Mexico_City')).toThrow(expect.objectContaining({ statusCode: 400 }))
  })
  // ronda 1 — H4: un día que no existe en el calendario no se recorre en silencio al mes siguiente
  it('día inexistente (30 de febrero, 31 de abril) ⇒ 400 en `from` y en `to`', () => {
    for (const day of ['2030-02-30', '2030-04-31']) {
      expect(() => localDayRange(day, undefined, 'America/Mexico_City')).toThrow(expect.objectContaining({ statusCode: 400 }))
      expect(() => localDayRange(undefined, day, 'America/Mexico_City')).toThrow(expect.objectContaining({ statusCode: 400 }))
    }
    expect(localDayRange('2028-02-29', '2028-02-29', 'America/Mexico_City').to!.toISOString()).toBe('2028-03-01T06:00:00.000Z')
  })
})

describe('summarizePassVisits', () => {
  // nuevo
  it('cuenta por proveedor y estado dentro del mes local, más las cancelaciones tardías', async () => {
    prismaMock.aggregatorVisit.groupBy.mockResolvedValueOnce([
      { provider: 'TOTALPASS', status: 'CONFIRMED', _count: { _all: 10 } },
      { provider: 'TOTALPASS', status: 'EXPIRED', _count: { _all: 2 } },
    ] as any)
    prismaMock.activityLog.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0)
    const r = await summarizePassVisits('v1', '2030-01', 'America/Mexico_City')
    expect(r).toEqual([
      { provider: 'TOTALPASS', confirmed: 10, alreadyConfirmed: 0, expired: 2, rejected: 0, pending: 0, lateCancellations: 1 },
      { provider: 'WELLHUB', confirmed: 0, alreadyConfirmed: 0, expired: 0, rejected: 0, pending: 0, lateCancellations: 0 },
    ])
    const where = prismaMock.aggregatorVisit.groupBy.mock.calls[0][0].where
    expect(where.startedAt.gte.toISOString()).toBe('2030-01-01T06:00:00.000Z') // medianoche de CDMX
    expect(where.startedAt.lt.toISOString()).toBe('2030-02-01T06:00:00.000Z')
    // ronda 1 — H5: sólo las tardías, y por proveedor (las cancelaciones por cambio de hora no llevan `late`)
    expect(prismaMock.activityLog.count.mock.calls.map((c: any) => c[0].where.AND)).toEqual([
      [{ data: { path: ['provider'], equals: 'TOTALPASS' } }, { data: { path: ['late'], equals: true } }],
      [{ data: { path: ['provider'], equals: 'WELLHUB' } }, { data: { path: ['late'], equals: true } }],
    ])
  })
  // nuevo — diciembre cierra en enero del año siguiente; las cancelaciones tardías se cuentan por proveedor en el mes
  it('diciembre termina en la medianoche local del 1 de enero siguiente', async () => {
    prismaMock.aggregatorVisit.groupBy.mockResolvedValueOnce([] as any)
    prismaMock.activityLog.count.mockResolvedValue(0)
    await summarizePassVisits('v1', '2030-12', 'America/Mexico_City')
    const where = prismaMock.aggregatorVisit.groupBy.mock.calls[0][0].where
    expect(where).toMatchObject({ venueId: 'v1' })
    expect(where.startedAt.lt.toISOString()).toBe('2031-01-01T06:00:00.000Z')
    expect(prismaMock.activityLog.count.mock.calls[0][0].where).toMatchObject({
      venueId: 'v1',
      action: 'PASS_BOOKING_CANCELLED',
      createdAt: { gte: where.startedAt.gte, lt: where.startedAt.lt },
    })
  })
  // nuevo
  it('mes con formato inválido ⇒ 400', async () => {
    await expect(summarizePassVisits('v1', '2030-13', 'America/Mexico_City')).rejects.toMatchObject({ statusCode: 400 })
  })
})
