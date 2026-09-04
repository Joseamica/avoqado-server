/**
 * Task 5g — la apertura SoftRestaurant es un outbox, no una llamada de red previa.
 *
 * Estas pruebas fijan el incidente real: Testarudo ya tenia $2,000 en la gaveta y
 * la PAX pidio $0. El POS debe recibir el fondo ganador y la misma identidad que
 * queda en Shift, aun si Rabbit falla despues del commit.
 */

jest.mock('@/communication/rabbitmq/publisher', () => ({ publishCommand: jest.fn() }))
jest.mock('@/communication/rabbitmq/commandListener', () => ({ deliverPosCommand: jest.fn() }))

import { Prisma } from '@prisma/client'

import { deliverPosCommand } from '@/communication/rabbitmq/commandListener'
import { publishCommand } from '@/communication/rabbitmq/publisher'
import { ConflictError } from '@/errors/AppError'
import { abrirTurnoDeCaja } from '@/services/shared/turnoDeCaja'
import prisma from '@/utils/prismaClient'

const m = prisma as any
const VENUE = 'venue-softrestaurant'
const STAFF = 'staff-1'
const AHORA = new Date('2026-09-03T15:00:00.000Z')

const params = (over: Record<string, unknown> = {}) => ({
  venueId: VENUE,
  staffId: STAFF,
  staffName: 'Vir Gomez',
  startingCash: 0,
  source: 'TURNO_TPV' as const,
  stationId: 'CAJA1',
  now: () => AHORA,
  ...over,
})

const p2002TurnoAbierto = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'x',
    meta: { modelName: 'Shift', target: ['venueId'] },
  } as any)

function cajaAbierta(fondo = 2000) {
  m.cashDrawerSession.findFirst.mockResolvedValue({
    id: 'caja-existente',
    venueId: VENUE,
    status: 'OPEN',
    startingAmount: new Prisma.Decimal(fondo),
    shiftId: null,
    openedAt: new Date('2026-09-03T13:38:00.000Z'),
  })
}

beforeEach(() => {
  m.venue.findUnique.mockResolvedValue({
    id: VENUE,
    name: 'Testarudo Cafe',
    timezone: 'America/Mexico_City',
    posType: 'SOFTRESTAURANT',
    posStatus: 'CONNECTED',
  })
  m.staffVenue.findFirst.mockResolvedValue({
    staffId: STAFF,
    venueId: VENUE,
    posStaffId: 'SR-STAFF-7',
    staff: { id: STAFF, firstName: 'Vir', lastName: 'Gomez' },
  })
  m.shift.findFirst.mockResolvedValue(null)
  m.shift.findUnique.mockResolvedValue(null)
  m.shift.updateMany.mockResolvedValue({ count: 1 })
  m.shift.create.mockImplementation(({ data }: any) => Promise.resolve({ id: 'turno-ganador', ...data }))
  m.cashDrawerSession.findFirst.mockResolvedValue(null)
  m.cashDrawerSession.findUnique.mockResolvedValue(null)
  m.cashDrawerSession.create.mockImplementation(({ data }: any) => Promise.resolve({ id: 'caja-nueva', ...data }))
  m.cashDrawerSession.updateMany.mockResolvedValue({ count: 1 })
  m.posCommand.create.mockResolvedValue({ id: 'cmd-open-1' })
  ;(deliverPosCommand as jest.Mock).mockResolvedValue('COMPLETED')
  ;(publishCommand as jest.Mock).mockResolvedValue(undefined)
})

describe('abrirTurnoDeCaja — outbox durable SoftRestaurant', () => {
  it('gaveta en 2000 + solicitud en 0: Shift y outbox conservan fondo ganador e identidad estable', async () => {
    cajaAbierta(2000)

    const result = await abrirTurnoDeCaja(params())

    expect(result).toMatchObject({ shiftId: 'turno-ganador', fondoAplicado: '2000', shiftCreado: true })
    const shiftData = m.shift.create.mock.calls[0][0].data
    const outboxData = m.posCommand.create.mock.calls[0][0].data
    expect(Number(shiftData.startingCash)).toBe(2000)
    expect(outboxData).toMatchObject({
      venueId: VENUE,
      entityType: 'Shift',
      entityId: 'turno-ganador',
      commandType: 'CREATE',
      action: 'OPEN',
      dedupeKey: 'shift-open:turno-ganador',
      payload: {
        tempShiftId: shiftData.externalId,
        posStaffId: 'SR-STAFF-7',
        startingCash: 2000,
        stationId: 'CAJA1',
      },
    })
    expect(outboxData.payload.tempShiftId).toEqual(expect.stringMatching(/^SHIFT_/))
    expect(m.shift.create.mock.invocationCallOrder[0]).toBeLessThan(m.posCommand.create.mock.invocationCallOrder[0])
    expect(deliverPosCommand).toHaveBeenCalledWith('cmd-open-1')
    expect(publishCommand).not.toHaveBeenCalled()
  })

  it('el contendiente que pierde el unico de turno no deja outbox ni publica', async () => {
    cajaAbierta(2000)
    m.shift.create.mockRejectedValueOnce(p2002TurnoAbierto())

    await expect(abrirTurnoDeCaja(params())).rejects.toBeInstanceOf(ConflictError)

    expect(m.posCommand.create).not.toHaveBeenCalled()
    expect(deliverPosCommand).not.toHaveBeenCalled()
    expect(publishCommand).not.toHaveBeenCalled()
  })

  it('Rabbit caido despues del commit no deshace la apertura y deja la misma fila durable', async () => {
    cajaAbierta(2000)
    ;(deliverPosCommand as jest.Mock).mockRejectedValueOnce(new Error('rabbit caido'))

    await expect(abrirTurnoDeCaja(params())).resolves.toMatchObject({ shiftId: 'turno-ganador', fondoAplicado: '2000' })

    expect(m.shift.create).toHaveBeenCalledTimes(1)
    expect(m.posCommand.create).toHaveBeenCalledTimes(1)
    expect(deliverPosCommand).toHaveBeenCalledWith('cmd-open-1')
  })

  it('un turno del dia actual se reusa sin crear OPEN externo', async () => {
    m.shift.findFirst.mockResolvedValue({
      id: 'turno-de-hoy',
      status: 'OPEN',
      endTime: null,
      startTime: new Date('2026-09-03T14:00:00.000Z'),
      startingCash: new Prisma.Decimal(2000),
      notes: null,
    })
    cajaAbierta(2000)

    await expect(abrirTurnoDeCaja(params())).resolves.toMatchObject({ shiftId: 'turno-de-hoy', shiftCreado: false })

    expect(m.posCommand.create).not.toHaveBeenCalled()
    expect(deliverPosCommand).not.toHaveBeenCalled()
    expect(publishCommand).not.toHaveBeenCalled()
  })

  it('un venue no integrado abre localmente sin crear OPEN externo', async () => {
    m.venue.findUnique.mockResolvedValue({
      id: VENUE,
      name: 'Cafe local',
      timezone: 'America/Mexico_City',
      posType: null,
      posStatus: 'NOT_INTEGRATED',
    })

    await expect(abrirTurnoDeCaja(params({ startingCash: 500 }))).resolves.toMatchObject({ shiftCreado: true })

    expect(m.posCommand.create).not.toHaveBeenCalled()
    expect(deliverPosCommand).not.toHaveBeenCalled()
    expect(publishCommand).not.toHaveBeenCalled()
  })
})
