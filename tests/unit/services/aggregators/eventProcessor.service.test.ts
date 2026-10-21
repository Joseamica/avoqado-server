import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import logger from '@/config/logger'
import { MAX_EVENT_ATTEMPTS, processInboundEvent } from '@/services/aggregators/core/eventProcessor.service'
import * as registry from '@/services/aggregators/core/adapterRegistry'
import * as booking from '@/services/aggregators/core/bookingIngestion.service'
import * as visit from '@/services/aggregators/core/visit.service'
import { fakeAdapter } from './fakeAdapter'

const NOW = new Date('2030-01-01T00:00:00Z')

const evRow = (kind: string, over: Record<string, unknown> = {}, connOver: Record<string, unknown> = {}) => ({
  id: 'e1',
  provider: 'TOTALPASS',
  kind,
  payload: {},
  status: 'RECEIVED',
  attemptCount: 0,
  nextAttemptAt: null,
  ...over,
  connection: {
    id: 'c1',
    venueId: 'v1',
    provider: 'TOTALPASS',
    externalPlaceId: 'place-1',
    confirmMode: 'AUTO',
    status: 'ACTIVE',
    ...connOver,
  },
})

const cancelled = (placeId: string | null = 'place-1') => ({
  kind: 'BOOKING_CANCELLED' as const,
  externalBookingId: 'x',
  late: false,
  placeId,
})

const adapterSpy = jest.spyOn(registry, 'adapterFor')
const requestedSpy = jest.spyOn(booking, 'ingestBookingRequested')
const cancelledSpy = jest.spyOn(booking, 'ingestBookingCancelled')
const checkinSpy = jest.spyOn(visit, 'ingestCheckin')

function useParsed(parsed: unknown) {
  adapterSpy.mockReturnValue(fakeAdapter({ parseWebhook: jest.fn().mockReturnValue(parsed) }))
}
function lastUpdateData(): any {
  const calls = prismaMock.aggregatorInboundEvent.update.mock.calls
  expect(calls).toHaveLength(1)
  return calls[0][0].data
}

// Los «Once» que un camino no consume se quedarían para la prueba siguiente: se limpian todos.
beforeEach(() => {
  for (const fn of [
    adapterSpy,
    requestedSpy,
    cancelledSpy,
    checkinSpy,
    prismaMock.aggregatorInboundEvent.findUnique,
    prismaMock.aggregatorInboundEvent.update,
  ])
    fn.mockReset()
  requestedSpy.mockResolvedValue({ decision: 'ACCEPTED', reservationId: 'r1' })
  cancelledSpy.mockResolvedValue(undefined as any)
  checkinSpy.mockResolvedValue({ visitId: 'vis1', duplicate: false, queuedValidation: true })
  prismaMock.aggregatorInboundEvent.update.mockResolvedValue({} as any)
})
afterAll(() => {
  for (const s of [adapterSpy, requestedSpy, cancelledSpy, checkinSpy]) s.mockRestore()
})

describe('processInboundEvent', () => {
  // nuevo — Review Focus 5
  it('evento que el adaptador no entiende ⇒ IGNORED con el motivo', async () => {
    prismaMock.aggregatorInboundEvent.findUnique.mockResolvedValueOnce(evRow('BOOKING') as any)
    adapterSpy.mockReturnValue(fakeAdapter({ parseWebhook: jest.fn().mockReturnValue({ kind: 'IGNORED', reason: 'slot.status=weird' }) }))
    await processInboundEvent('e1')
    expect(prismaMock.aggregatorInboundEvent.update.mock.calls[0][0].data).toMatchObject({ status: 'IGNORED', error: 'slot.status=weird' })
  })

  // nuevo — seguridad: el payload trae otra sucursal
  it('place distinto al de la conexión ⇒ FAILED sin crear nada y sin reintento', async () => {
    prismaMock.aggregatorInboundEvent.findUnique.mockResolvedValueOnce(evRow('BOOKING') as any)
    useParsed(cancelled('OTRA'))
    await processInboundEvent('e1', NOW)
    expect(cancelledSpy).not.toHaveBeenCalled()
    const data = lastUpdateData()
    expect(data.status).toBe('FAILED')
    expect(data.nextAttemptAt).toBeNull()
    expect(data.error).toContain('OTRA')
  })

  // nuevo
  it('error al procesar ⇒ FAILED con reintento programado', async () => {
    prismaMock.aggregatorInboundEvent.findUnique.mockResolvedValueOnce(evRow('BOOKING') as any)
    useParsed(cancelled())
    cancelledSpy.mockRejectedValueOnce(new Error('db caída'))
    await processInboundEvent('e1', NOW)
    const data = lastUpdateData()
    expect(data).toMatchObject({ status: 'FAILED', attemptCount: 1, error: 'db caída' })
    expect(data.nextAttemptAt.toISOString()).toBe('2030-01-01T00:02:00.000Z')
  })

  // nuevo — 2^n minutos con tope de 60
  it('la espera crece 2^n minutos y se topa en 60', async () => {
    prismaMock.aggregatorInboundEvent.findUnique.mockResolvedValueOnce(
      evRow('BOOKING', { status: 'FAILED', attemptCount: 6, nextAttemptAt: NOW }) as any,
    )
    useParsed(cancelled())
    cancelledSpy.mockRejectedValueOnce(new Error('db caída'))
    await processInboundEvent('e1', NOW)
    const data = lastUpdateData()
    expect(data.attemptCount).toBe(7)
    expect(data.nextAttemptAt.toISOString()).toBe('2030-01-01T01:00:00.000Z') // 2^7 = 128 → 60
  })

  // nuevo — el adaptador de hoy es un stub que truena: no debe tumbar nada, sólo reintentar
  it('el adaptador truena al leer el payload ⇒ FAILED con reintento, la promesa no se rechaza', async () => {
    prismaMock.aggregatorInboundEvent.findUnique.mockResolvedValueOnce(evRow('CHECKIN') as any)
    adapterSpy.mockReturnValue(
      fakeAdapter({
        parseWebhook: jest.fn(() => {
          throw new Error('pendiente')
        }),
      }),
    )
    await expect(processInboundEvent('e1', NOW)).resolves.toBeUndefined()
    expect(lastUpdateData()).toMatchObject({ status: 'FAILED', attemptCount: 1, nextAttemptAt: new Date('2030-01-01T00:02:00.000Z') })
  })

  // nuevo — un P2002 que escapa de withSerializableRetry es un fallo más
  it('P2002 que escapa ⇒ FAILED con reintento y sin volcar los argumentos de Prisma', async () => {
    prismaMock.aggregatorInboundEvent.findUnique.mockResolvedValueOnce(evRow('BOOKING') as any)
    useParsed({
      kind: 'BOOKING_REQUESTED',
      externalBookingId: 'b1',
      externalOccurrenceId: 'o1',
      externalUserId: 'U1',
      externalPlanCode: null,
      placeId: 'place-1',
      user: { name: 'Ana', email: 'ana@correo.mx', phone: null },
      seatRef: null,
    })
    requestedSpy.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed on ana@correo.mx', {
        code: 'P2002',
        clientVersion: 'x',
        meta: { target: ['email'] },
      }),
    )
    await processInboundEvent('e1', NOW)
    const data = lastUpdateData()
    expect(data).toMatchObject({ status: 'FAILED', attemptCount: 1 })
    expect(data.error).toContain('P2002')
    expect(data.error).not.toContain('ana@correo.mx')
  })

  // nuevo — se trunca a 2000
  it('el error se guarda truncado a 2000 caracteres', async () => {
    prismaMock.aggregatorInboundEvent.findUnique.mockResolvedValueOnce(evRow('BOOKING') as any)
    useParsed(cancelled())
    cancelledSpy.mockRejectedValueOnce(new Error('x'.repeat(5000)))
    await processInboundEvent('e1', NOW)
    expect(lastUpdateData().error).toHaveLength(2000)
  })

  // nuevo — al agotar los intentos se queda FAILED sin próxima vuelta y se avisa una vez como error
  it(`al llegar a ${MAX_EVENT_ATTEMPTS} intentos queda FAILED sin reintento y se registra como error`, async () => {
    prismaMock.aggregatorInboundEvent.findUnique.mockResolvedValueOnce(
      evRow('BOOKING', { status: 'FAILED', attemptCount: MAX_EVENT_ATTEMPTS - 1, nextAttemptAt: NOW }) as any,
    )
    useParsed(cancelled())
    cancelledSpy.mockRejectedValueOnce(new Error('db caída'))
    ;(logger.error as jest.Mock).mockClear()
    await processInboundEvent('e1', NOW)
    const data = lastUpdateData()
    expect(data).toMatchObject({ status: 'FAILED', attemptCount: MAX_EVENT_ATTEMPTS, nextAttemptAt: null })
    expect(logger.error).toHaveBeenCalledTimes(1)
  })

  // nuevo
  it('evento que ya agotó sus intentos no se vuelve a procesar', async () => {
    prismaMock.aggregatorInboundEvent.findUnique.mockResolvedValueOnce(
      evRow('BOOKING', { status: 'FAILED', attemptCount: MAX_EVENT_ATTEMPTS, nextAttemptAt: NOW }) as any,
    )
    await processInboundEvent('e1', NOW)
    expect(adapterSpy).not.toHaveBeenCalled()
    expect(prismaMock.aggregatorInboundEvent.update).not.toHaveBeenCalled()
  })

  // nuevo — R10: FAILED sin próxima vuelta (sucursal ajena) es terminal aunque le queden intentos
  it('FAILED sin nextAttemptAt no se vuelve a procesar', async () => {
    prismaMock.aggregatorInboundEvent.findUnique.mockResolvedValueOnce(
      evRow('BOOKING', { status: 'FAILED', attemptCount: 0, nextAttemptAt: null }) as any,
    )
    useParsed(cancelled())
    await processInboundEvent('e1', NOW)
    expect(adapterSpy).not.toHaveBeenCalled()
    expect(cancelledSpy).not.toHaveBeenCalled()
    expect(prismaMock.aggregatorInboundEvent.update).not.toHaveBeenCalled()
  })

  // nuevo — un FAILED con próxima vuelta sí se reintenta
  it('FAILED con nextAttemptAt se reintenta y queda PROCESSED', async () => {
    prismaMock.aggregatorInboundEvent.findUnique.mockResolvedValueOnce(
      evRow('BOOKING', { status: 'FAILED', attemptCount: 2, nextAttemptAt: NOW }) as any,
    )
    useParsed(cancelled())
    await processInboundEvent('e1', NOW)
    expect(cancelledSpy).toHaveBeenCalledTimes(1)
    expect(lastUpdateData().status).toBe('PROCESSED')
  })

  // nuevo — R11: reserva que llega entre suscribir webhooks y activar la conexión no se pierde
  it('conexión PENDING ⇒ FAILED, +1 intento, otro intento en 1 minuto, sin ingerir', async () => {
    prismaMock.aggregatorInboundEvent.findUnique.mockResolvedValueOnce(
      evRow('BOOKING', { attemptCount: 3, status: 'FAILED', nextAttemptAt: NOW }, { status: 'PENDING' }) as any,
    )
    useParsed(cancelled())
    await processInboundEvent('e1', NOW)
    expect(cancelledSpy).not.toHaveBeenCalled()
    expect(requestedSpy).not.toHaveBeenCalled()
    expect(checkinSpy).not.toHaveBeenCalled()
    expect(lastUpdateData()).toEqual({
      status: 'FAILED',
      attemptCount: 4,
      error: 'conexión PENDING: se reintenta',
      nextAttemptAt: new Date(NOW.getTime() + 60e3),
    })
  })

  it('conexión PENDING cuenta para el tope de intentos', async () => {
    prismaMock.aggregatorInboundEvent.findUnique.mockResolvedValueOnce(
      evRow('BOOKING', { status: 'FAILED', attemptCount: MAX_EVENT_ATTEMPTS - 1, nextAttemptAt: NOW }, { status: 'PENDING' }) as any,
    )
    await processInboundEvent('e1', NOW)
    expect(lastUpdateData()).toMatchObject({ status: 'FAILED', attemptCount: MAX_EVENT_ATTEMPTS, nextAttemptAt: null })
  })

  // nuevo — un estudio en pausa no recibe reservas
  it.each(['PAUSED', 'REVOKED'])('conexión %s ⇒ IGNORED sin ingerir', async status => {
    prismaMock.aggregatorInboundEvent.findUnique.mockResolvedValueOnce(evRow('BOOKING', {}, { status }) as any)
    useParsed(cancelled())
    await processInboundEvent('e1', NOW)
    expect(cancelledSpy).not.toHaveBeenCalled()
    expect(lastUpdateData()).toMatchObject({ status: 'IGNORED', error: `conexión ${status}` })
  })

  // nuevo — enrutamiento
  it('reserva nueva ⇒ ingestBookingRequested y PROCESSED', async () => {
    prismaMock.aggregatorInboundEvent.findUnique.mockResolvedValueOnce(evRow('BOOKING') as any)
    const parsed = {
      kind: 'BOOKING_REQUESTED',
      externalBookingId: 'b1',
      externalOccurrenceId: 'o1',
      externalUserId: 'U1',
      externalPlanCode: null,
      placeId: null,
      user: { name: 'Ana', email: null, phone: null },
      seatRef: null,
    }
    useParsed(parsed)
    await processInboundEvent('e1', NOW)
    expect(requestedSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1', venueId: 'v1', provider: 'TOTALPASS' }), parsed, NOW)
    expect(lastUpdateData()).toEqual({ status: 'PROCESSED', processedAt: NOW, error: null, nextAttemptAt: null })
  })

  it('check-in ⇒ ingestCheckin con el modo de confirmación de la conexión', async () => {
    prismaMock.aggregatorInboundEvent.findUnique.mockResolvedValueOnce(evRow('CHECKIN', {}, { confirmMode: 'ON_VENUE_CHECKIN' }) as any)
    const parsed = {
      kind: 'CHECKIN_CREATED',
      externalCheckinId: 'h1',
      validationRef: 'ref',
      externalUserId: 'U1',
      placeId: 'place-1',
      startedAt: NOW,
      deadlineAt: NOW,
      user: { name: 'Ana', email: null, phone: null },
    }
    useParsed(parsed)
    await processInboundEvent('e1', NOW)
    expect(checkinSpy).toHaveBeenCalledWith(expect.objectContaining({ confirmMode: 'ON_VENUE_CHECKIN' }), parsed, NOW)
    expect(lastUpdateData().status).toBe('PROCESSED')
  })

  it('cancelación ⇒ ingestBookingCancelled y PROCESSED', async () => {
    prismaMock.aggregatorInboundEvent.findUnique.mockResolvedValueOnce(evRow('BOOKING') as any)
    useParsed(cancelled())
    await processInboundEvent('e1', NOW)
    expect(cancelledSpy).toHaveBeenCalledTimes(1)
    expect(lastUpdateData().status).toBe('PROCESSED')
  })

  // nuevo — Codex F4: la cancelación llegó antes que su reserva (que espera reintento); si se daba por procesada, la
  // reserva entraba después CONFIRMED y dejaba un lugar fantasma.
  it('cancelación de una reserva que aún no tenemos ⇒ FAILED con el reintento normal, no PROCESSED', async () => {
    prismaMock.aggregatorInboundEvent.findUnique.mockResolvedValueOnce(evRow('BOOKING') as any)
    useParsed(cancelled())
    cancelledSpy.mockResolvedValueOnce('NOT_FOUND')
    await processInboundEvent('e1', NOW)
    const data = lastUpdateData()
    expect(data).toMatchObject({ status: 'FAILED', attemptCount: 1 })
    expect(data.error).toMatch(/aún no tenemos/)
    expect(data.nextAttemptAt.toISOString()).toBe('2030-01-01T00:02:00.000Z')
  })
  // nuevo — Codex F4: al agotar los intentos queda FAILED terminal con aviso [PASES]
  it('cancelación sin reserva que agota sus intentos ⇒ FAILED sin próxima vuelta y un error en el log', async () => {
    prismaMock.aggregatorInboundEvent.findUnique.mockResolvedValueOnce(
      evRow('BOOKING', { status: 'FAILED', attemptCount: MAX_EVENT_ATTEMPTS - 1, nextAttemptAt: NOW }) as any,
    )
    useParsed(cancelled())
    cancelledSpy.mockResolvedValueOnce('NOT_FOUND')
    ;(logger.error as jest.Mock).mockClear()
    await processInboundEvent('e1', NOW)
    expect(lastUpdateData()).toMatchObject({ status: 'FAILED', attemptCount: MAX_EVENT_ATTEMPTS, nextAttemptAt: null })
    expect((logger.error as jest.Mock).mock.calls[0][0]).toMatch(/^\[PASES\]/)
  })
  // regresión — una cancelación que sí encontró su reserva (o que ya no se puede cancelar) se da por procesada
  it.each(['CANCELLED', 'ALREADY'] as const)('cancelación %s ⇒ PROCESSED', async result => {
    prismaMock.aggregatorInboundEvent.findUnique.mockResolvedValueOnce(evRow('BOOKING') as any)
    useParsed(cancelled())
    cancelledSpy.mockResolvedValueOnce(result)
    await processInboundEvent('e1', NOW)
    expect(lastUpdateData().status).toBe('PROCESSED')
  })

  it.each(['PROCESSED', 'IGNORED'])('evento ya %s ⇒ no hace nada', async status => {
    prismaMock.aggregatorInboundEvent.findUnique.mockResolvedValueOnce(evRow('BOOKING', { status }) as any)
    await processInboundEvent('e1', NOW)
    expect(adapterSpy).not.toHaveBeenCalled()
    expect(prismaMock.aggregatorInboundEvent.update).not.toHaveBeenCalled()
  })

  it('evento inexistente ⇒ no hace nada', async () => {
    prismaMock.aggregatorInboundEvent.findUnique.mockResolvedValueOnce(null)
    await expect(processInboundEvent('nope', NOW)).resolves.toBeUndefined()
    expect(prismaMock.aggregatorInboundEvent.update).not.toHaveBeenCalled()
  })

  // nuevo — la base caída al leer o al marcar el fallo no rechaza la promesa (se llama sin await)
  it('si la base falla al leer el evento, la promesa no se rechaza', async () => {
    prismaMock.aggregatorInboundEvent.findUnique.mockRejectedValueOnce(new Error('db caída'))
    await expect(processInboundEvent('e1', NOW)).resolves.toBeUndefined()
  })

  it('si la base falla al marcar el fallo, la promesa no se rechaza', async () => {
    prismaMock.aggregatorInboundEvent.findUnique.mockResolvedValueOnce(evRow('BOOKING') as any)
    useParsed(cancelled())
    cancelledSpy.mockRejectedValueOnce(new Error('db caída'))
    prismaMock.aggregatorInboundEvent.update.mockRejectedValueOnce(new Error('db caída otra vez'))
    await expect(processInboundEvent('e1', NOW)).resolves.toBeUndefined()
  })
})
