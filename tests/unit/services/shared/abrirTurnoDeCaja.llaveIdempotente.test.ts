/**
 * 🔴 DINERO. `POST /cash-drawer/open` acepta una LLAVE IDEMPOTENTE (`localId`), como ya lo hacen
 * `pay-in` y `pay-out`: el mismo `localId` devuelve la MISMA caja, nunca crea una segunda.
 *
 * Por qué (Task 8b, 5-sep-2026): la apertura sin red vive en una cola durable y se reproduce al
 * volver la red. Si la respuesta del `POST /open` se pierde —WiFi del local, 502 del proxy, la app
 * que muere a media petición— el aparato reintenta, y sin llave el servidor no tiene forma de
 * decir «ésa ya la tengo». Hoy lo salva el índice de «una caja abierta por negocio» (la segunda
 * LIGA), pero la respuesta dice `cajaCreada:false` sobre la PROPIA caja del cajero, así que la
 * app le avisa «se adoptó la caja abierta por …» sobre su propia apertura — y con dos tablets del
 * mismo modelo, la misma cuenta y el mismo fondo, ni siquiera puede distinguir la suya de la ajena
 * (residuo N1 declarado en las dos apps).
 *
 * La llave vive en el evento `OPEN` (`CashDrawerEvent.localId`, `@@unique([venueId, localId])`):
 * es la MISMA columna y el MISMO índice con los que ya se deduplican los ingresos y retiros, así
 * que no hay migración ni una segunda forma de escribir en esa tabla. Es el patrón de
 * `recordManualDrawerEvent`, aplicado a la apertura.
 *
 * ADITIVO: sin `localId` no se consulta nada y el evento OPEN nace exactamente como hoy.
 */

jest.mock('@/communication/rabbitmq/publisher', () => ({ publishCommand: jest.fn() }))
jest.mock('@/communication/rabbitmq/commandListener', () => ({ deliverPosCommand: jest.fn() }))

import prisma from '@/utils/prismaClient'
import { deliverPosCommand } from '@/communication/rabbitmq/commandListener'
import { logAction } from '@/services/dashboard/activity-log.service'
import { abrirTurnoDeCaja } from '@/services/shared/turnoDeCaja'
import { BadRequestError, ConflictError } from '@/errors/AppError'
import { Prisma } from '@prisma/client'

const mockLogAction = logAction as jest.MockedFunction<typeof logAction>

const m = prisma as unknown as {
  venue: { findUnique: jest.Mock }
  staffVenue: { findFirst: jest.Mock }
  shift: { findFirst: jest.Mock; findMany: jest.Mock; findUnique: jest.Mock; create: jest.Mock; updateMany: jest.Mock }
  cashDrawerSession: { findFirst: jest.Mock; findUnique: jest.Mock; create: jest.Mock; updateMany: jest.Mock }
  cashDrawerEvent: { findFirst: jest.Mock }
  posCommand: { create: jest.Mock }
}

const VENUE = 'venue-1'
const STAFF = 'staff-1'
const AHORA = new Date('2026-09-05T16:31:00.000Z')
const ahora = () => AHORA
/** La llave que manda la app: el id del evento OPEN local (Android) o el de la sesión (iOS). */
const LLAVE = '5c3d1d2e-0b6a-4a1e-9f0e-6a1f6d3d9a11'

function sembrar() {
  m.venue.findUnique.mockResolvedValue({
    id: VENUE,
    name: 'Testarudo Cafe',
    timezone: 'America/Mexico_City',
    posType: null,
    posStatus: 'NOT_INTEGRATED',
  })
  m.staffVenue.findFirst.mockResolvedValue({
    staffId: STAFF,
    venueId: VENUE,
    posStaffId: null,
    staff: { id: STAFF, firstName: 'Vir', lastName: 'Gomez' },
  })
  m.shift.findFirst.mockResolvedValue(null)
  m.shift.findMany.mockResolvedValue([])
  m.shift.findUnique.mockResolvedValue(null)
  m.cashDrawerSession.findFirst.mockResolvedValue(null)
  m.cashDrawerSession.findUnique.mockResolvedValue(null)
  m.cashDrawerEvent.findFirst.mockResolvedValue(null)
  m.shift.create.mockImplementation(({ data }: any) => Promise.resolve({ id: 'turno-nuevo', ...data }))
  m.cashDrawerSession.create.mockImplementation(({ data }: any) => Promise.resolve({ id: 'caja-nueva', ...data }))
  m.cashDrawerSession.updateMany.mockResolvedValue({ count: 1 })
  m.shift.updateMany.mockResolvedValue({ count: 1 })
  m.posCommand.create.mockResolvedValue({ id: 'cmd-open' })
  ;(deliverPosCommand as jest.Mock).mockResolvedValue('COMPLETED')
}

const params = (over: Record<string, unknown> = {}) => ({
  venueId: VENUE,
  staffId: STAFF,
  staffName: 'Vir Gomez',
  startingCash: 500,
  deviceName: 'samsung SM-X133',
  source: 'CAJA_MOVIL' as const,
  now: ahora,
  ...over,
})

/** La apertura que YA aterrizó con esa llave: lo que el servidor encuentra en el reintento. */
const aperturaYaRegistrada = (over: Record<string, unknown> = {}) => ({
  id: 'ev-open-x',
  sessionId: 'caja-x',
  localId: LLAVE,
  session: {
    id: 'caja-x',
    shiftId: 'turno-x',
    status: 'OPEN',
    startingAmount: new Prisma.Decimal(500),
    openedByName: 'Vir Gomez',
    ...over,
  },
})

const p2002 = (columnas: string[], modelName: string) =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'x',
    meta: { modelName, target: columnas },
  } as any)

beforeEach(() => {
  jest.clearAllMocks()
  sembrar()
})

describe('abrirTurnoDeCaja — la llave idempotente de la apertura', () => {
  it('con localId, el evento OPEN nace con esa llave y el resultado la devuelve', async () => {
    const r = await abrirTurnoDeCaja(params({ localId: LLAVE }))

    expect(m.cashDrawerEvent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ venueId: VENUE, localId: LLAVE, type: 'OPEN' }) }),
    )
    expect(m.cashDrawerSession.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ events: { create: expect.objectContaining({ type: 'OPEN', localId: LLAVE }) } }),
      }),
    )
    expect(r.localId).toBe(LLAVE)
    expect(r.reintento).toBe(false)
    expect(r.cajaCreada).toBe(true)
  })

  it('REGRESIÓN — sin localId no se consulta la llave y el evento OPEN nace sin ella, como hoy', async () => {
    const r = await abrirTurnoDeCaja(params())

    expect(m.cashDrawerEvent.findFirst).not.toHaveBeenCalled()
    const { data } = m.cashDrawerSession.create.mock.calls[0][0]
    expect(data.events.create).not.toHaveProperty('localId')
    expect(r.localId).toBeNull()
    expect(r.reintento).toBe(false)
  })

  it('🔴 REINTENTO: la misma llave devuelve la MISMA caja y el MISMO turno, sin crear nada ni relevar nada', async () => {
    m.cashDrawerEvent.findFirst.mockResolvedValue(aperturaYaRegistrada())
    // Hay además un turno de AYER abierto: en una apertura normal se relevaría. En el reintento
    // NO se toca — la apertura ya ocurrió, y ocurrió con lo que había entonces.
    m.shift.findFirst.mockResolvedValue({
      id: 'turno-de-ayer',
      venueId: VENUE,
      status: 'OPEN',
      endTime: null,
      startTime: new Date('2026-09-04T22:00:00.000Z'),
      startingCash: new Prisma.Decimal(0),
      notes: null,
    })

    const r = await abrirTurnoDeCaja(params({ localId: LLAVE, startingCash: 999 }))

    expect(r).toEqual(
      expect.objectContaining({
        cashDrawerSessionId: 'caja-x',
        shiftId: 'turno-x',
        cajaCreada: true,
        shiftCreado: false,
        reintento: true,
        localId: LLAVE,
        // El fondo APLICADO es el de la caja que ya existe, no los $999 que llegaron en el reintento.
        fondoAplicado: '500',
      }),
    )
    expect(m.cashDrawerSession.create).not.toHaveBeenCalled()
    expect(m.shift.create).not.toHaveBeenCalled()
    expect(m.shift.updateMany).not.toHaveBeenCalled()
    expect(m.cashDrawerSession.updateMany).not.toHaveBeenCalled()
    // Ni un renglón nuevo en la bitácora: el asiento de esta apertura ya se escribió la primera vez.
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it('reintento sobre una caja sin liga ⇒ el turno sale del turno vivo del negocio', async () => {
    m.cashDrawerEvent.findFirst.mockResolvedValue(aperturaYaRegistrada({ shiftId: null }))
    m.shift.findFirst.mockResolvedValue({ id: 'turno-vivo', venueId: VENUE, status: 'OPEN', endTime: null })

    const r = await abrirTurnoDeCaja(params({ localId: LLAVE }))

    expect(r.reintento).toBe(true)
    expect(r.shiftId).toBe('turno-vivo')
    expect(m.cashDrawerSession.create).not.toHaveBeenCalled()
  })

  it('reintento sin turno resoluble ⇒ 409 SHIFT_HANDOVER_RETRY — nunca una segunda caja para la misma apertura', async () => {
    m.cashDrawerEvent.findFirst.mockResolvedValue(aperturaYaRegistrada({ shiftId: null }))
    m.shift.findFirst.mockResolvedValue(null)

    await expect(abrirTurnoDeCaja(params({ localId: LLAVE }))).rejects.toMatchObject({
      constructor: ConflictError,
      code: 'SHIFT_HANDOVER_RETRY',
    })
    expect(m.cashDrawerSession.create).not.toHaveBeenCalled()
    expect(m.shift.create).not.toHaveBeenCalled()
  })

  it('🔴 una llave ya usada por OTRO movimiento (no un OPEN) ⇒ 400 legible, nunca un 500 del índice', async () => {
    // El OPEN con esa llave no existe, pero un PAY_IN sí la tiene: la creación choca contra
    // `@@unique([venueId, localId])`. Es un defecto del cliente y se le dice; un 500 lo dejaría
    // reintentando para siempre.
    m.cashDrawerSession.create.mockRejectedValue(p2002(['venueId', 'localId'], 'CashDrawerEvent'))

    await expect(abrirTurnoDeCaja(params({ localId: LLAVE }))).rejects.toMatchObject({
      constructor: BadRequestError,
      code: 'CASH_DRAWER_OPEN_LOCAL_ID_REUSED',
    })
  })

  it('REGRESIÓN — el choque del índice de «una caja abierta por negocio» sigue siendo el 409 de siempre', async () => {
    m.cashDrawerSession.create.mockRejectedValue(p2002(['venueId'], 'CashDrawerSession'))

    await expect(abrirTurnoDeCaja(params({ localId: LLAVE }))).rejects.toMatchObject({
      constructor: ConflictError,
      code: 'CASH_SHIFT_ALREADY_OPEN',
    })
  })
})
