/**
 * 🔴 DINERO — P1.2 de la auditoría del 4-sep-2026: un turno CERRADO con `endTime` nulo se REUSABA
 * como si fuera el turno abierto del negocio.
 *
 * `abrirTurnoDeCaja` buscaba `{ venueId, endTime: null }` y sólo se defendía de `CLOSING`. La razón
 * de buscar por `endTime` y no por `status` es buena y se conserva (un cierre en curso puede
 * REVERTIRSE a OPEN, y abrir otro encima dejaría dos abiertos), pero dejaba la rama `CLOSED` sin
 * ninguna guarda:
 *
 *     UPDATE "Shift" SET "endTime" = NULL WHERE id = '<uno cerrado de hoy>'
 *
 * ⇒ la siguiente apertura devolvía ese turno CERRADO con `shiftCreado: false`, la app creía que
 * había turno abierto, y `turnoAbiertoDelNegocio` seguía devolviendo `null` ⇒ **cada cobro del día
 * nacía sin turno**, sin un solo error. Y si el turno reusado ya tenía `cashDeclared`, la siguiente
 * alineación de fondo y el siguiente cierre firmaban sobre un corte YA firmado.
 *
 * El productor conocido de ese estado era el P1.1 (`PUT {"endTime": null}`), ya cerrado — pero
 * también lo produce cualquier corrección a mano en Postgres, que es justamente la salida obligada
 * del P1.1 y del preflight de la migración del índice único.
 *
 * Dos mitades:
 *   1. la búsqueda del turno vivo exige `endTime: null` **Y** `status IN (OPEN, CLOSING)`;
 *   2. un CLOSED con `endTime` nulo es una ANOMALÍA DE DATOS: no se reusa, se SANA (`endTime`) y
 *      queda su rastro en `ActivityLog` — un estado imposible que se arregla en silencio vuelve a
 *      aparecer sin que nadie sepa cuántas veces pasó.
 */

jest.mock('@/communication/rabbitmq/publisher', () => ({ publishCommand: jest.fn() }))
jest.mock('@/communication/rabbitmq/commandListener', () => ({ deliverPosCommand: jest.fn() }))

import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { publishCommand } from '@/communication/rabbitmq/publisher'
import { deliverPosCommand } from '@/communication/rabbitmq/commandListener'
import { logAction } from '@/services/dashboard/activity-log.service'
import { abrirTurnoDeCaja, turnoAbiertoDelNegocio, turnoVivoWhere } from '@/services/shared/turnoDeCaja'
import { Prisma } from '@prisma/client'

const mockLogAction = logAction as jest.MockedFunction<typeof logAction>
const mockLogger = logger as unknown as { error: jest.Mock; warn: jest.Mock; info: jest.Mock }

const m = prisma as unknown as {
  venue: { findUnique: jest.Mock }
  staffVenue: { findFirst: jest.Mock }
  shift: { findFirst: jest.Mock; findMany: jest.Mock; findUnique: jest.Mock; create: jest.Mock; updateMany: jest.Mock }
  cashDrawerSession: { findFirst: jest.Mock; findUnique: jest.Mock; create: jest.Mock; updateMany: jest.Mock }
  posCommand: { create: jest.Mock }
}

const VENUE = 'venue-1'
const STAFF = 'staff-1'
const AHORA = new Date('2026-09-03T15:00:00.000Z')
const ahora = () => AHORA

const params = (over: Record<string, unknown> = {}) => ({
  venueId: VENUE,
  staffId: STAFF,
  staffName: 'Vir Gomez',
  startingCash: 2000,
  deviceName: 'sunmi SM-D3',
  source: 'CAJA_MOVIL' as const,
  now: ahora,
  ...over,
})

/** El turno CERRADO de hoy al que alguien le borró el `endTime`. */
const ZOMBI = {
  id: 'turno-zombi',
  venueId: VENUE,
  status: 'CLOSED',
  endTime: null,
  startTime: new Date('2026-09-03T14:00:00.000Z'),
  notes: null,
  startingCash: new Prisma.Decimal(2000),
  cashDeclared: new Prisma.Decimal(1300),
}

beforeEach(() => {
  jest.clearAllMocks()
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
  // Sin turno VIVO: es lo que devuelve la consulta con el filtro por estado puesto.
  m.shift.findFirst.mockResolvedValue(null)
  m.shift.findMany.mockResolvedValue([])
  m.shift.findUnique.mockResolvedValue(null)
  m.shift.create.mockImplementation(({ data }: any) => Promise.resolve({ id: 'turno-nuevo', ...data }))
  m.shift.updateMany.mockResolvedValue({ count: 1 })
  m.cashDrawerSession.findFirst.mockResolvedValue(null)
  m.cashDrawerSession.findUnique.mockResolvedValue(null)
  m.cashDrawerSession.create.mockImplementation(({ data }: any) => Promise.resolve({ id: 'caja-nueva', ...data }))
  m.cashDrawerSession.updateMany.mockResolvedValue({ count: 1 })
  ;(publishCommand as jest.Mock).mockResolvedValue(undefined)
  ;(deliverPosCommand as jest.Mock).mockResolvedValue('COMPLETED')
  m.posCommand.create.mockResolvedValue({ id: 'cmd-open' })
})

describe('turnoVivoWhere — «vivo» se define UNA sola vez', () => {
  it('exige `endTime: null` Y un estado vivo (OPEN o CLOSING), nunca CLOSED', () => {
    expect(turnoVivoWhere(VENUE)).toEqual({ venueId: VENUE, endTime: null, status: { in: ['OPEN', 'CLOSING'] } })
  })

  it('🔴 nunca por persona: el turno es del NEGOCIO', () => {
    expect(turnoVivoWhere(VENUE)).not.toHaveProperty('staffId')
  })

  it('el claim (`turnoAbiertoDelNegocio`) parte del MISMO where y lo estrecha a OPEN', async () => {
    const db = { shift: { findFirst: jest.fn().mockResolvedValue(null) } } as any

    await turnoAbiertoDelNegocio(db, VENUE)

    // Mismo `venueId` y mismo `endTime: null` que la apertura; sólo el estado se estrecha, porque
    // un CLOSING no puede recibir dinero.
    expect(db.shift.findFirst.mock.calls[0][0].where).toEqual({ venueId: VENUE, endTime: null, status: 'OPEN' })
  })
})

describe('abrirTurnoDeCaja — la búsqueda del turno vivo filtra por estado', () => {
  it('🔴 el `where` lleva `status IN (OPEN, CLOSING)`: un CLOSED nunca llega a la rama de reuso', async () => {
    await abrirTurnoDeCaja(params())

    const where = m.shift.findFirst.mock.calls.at(-1)![0].where
    expect(where).toEqual({ venueId: VENUE, endTime: null, status: { in: ['OPEN', 'CLOSING'] } })
  })
})

describe('abrirTurnoDeCaja — un CLOSED con `endTime` nulo se SANA, no se reusa', () => {
  /** El estado imposible: la consulta de anomalías lo encuentra, la del turno vivo no. */
  function conZombi() {
    m.shift.findMany.mockResolvedValue([{ id: ZOMBI.id }])
    m.shift.updateMany.mockResolvedValue({ count: 1 })
  }

  it('🔴 se CREA un turno nuevo en vez de reusar el zombi', async () => {
    conZombi()

    const r = await abrirTurnoDeCaja(params())

    expect(r.shiftCreado).toBe(true)
    expect(r.shiftId).toBe('turno-nuevo')
    expect(r.shiftId).not.toBe(ZOMBI.id)
  })

  it('🔴 al zombi se le pone `endTime`, con un CAS que sólo casa si sigue siendo la anomalía', async () => {
    conZombi()

    await abrirTurnoDeCaja(params())

    const sanacion = m.shift.updateMany.mock.calls.find((c: any[]) => c[0]?.data?.endTime === AHORA)
    expect(sanacion).toBeDefined()
    expect(sanacion![0].where).toMatchObject({ venueId: VENUE, status: 'CLOSED', endTime: null })
    expect(sanacion![0].where.id).toEqual({ in: [ZOMBI.id] })
  })

  it('la consulta de anomalías va acotada por venue, por estado y con tope', async () => {
    conZombi()

    await abrirTurnoDeCaja(params())

    const args = m.shift.findMany.mock.calls[0][0]
    expect(args.where).toEqual({ venueId: VENUE, status: 'CLOSED', endTime: null })
    expect(typeof args.take).toBe('number')
    expect(args.take).toBeGreaterThan(0)
  })

  it('🔴 queda rastro: `ActivityLog` con el id y un `logger.error` (es un estado que la app no produce)', async () => {
    conZombi()

    await abrirTurnoDeCaja(params())

    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId: VENUE,
        action: 'SHIFT_ANOMALY_HEALED',
        entity: 'Shift',
        entityId: ZOMBI.id,
      }),
    )
    expect(mockLogger.error).toHaveBeenCalled()
  })

  it('sin anomalías NO se escribe nada ni se audita: el caso normal no paga el arreglo', async () => {
    await abrirTurnoDeCaja(params())

    expect(m.shift.updateMany.mock.calls.filter((c: any[]) => c[0]?.data?.endTime === AHORA)).toHaveLength(0)
    expect(mockLogAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'SHIFT_ANOMALY_HEALED' }))
    expect(mockLogger.error).not.toHaveBeenCalled()
  })

  it('perder el CAS (otro aparato sanó primero) NO audita ese id: no lo hicimos nosotros', async () => {
    conZombi()
    m.shift.updateMany.mockImplementation(async (args: any) => ({ count: args?.data?.endTime === AHORA ? 0 : 1 }))

    await abrirTurnoDeCaja(params())

    expect(mockLogAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'SHIFT_ANOMALY_HEALED' }))
  })

  it('🔴 se sana ANTES de leer el turno vivo: la lectura no puede ver un mundo a medias', async () => {
    // No es cosmético. Si la sanación corriera después, la lectura del turno vivo y el relevo ya
    // habrían decidido sobre un venue con una fila que nadie sabe leer.
    //
    // ⚠️ Aquí NO se prueba «la apertura sobrevive a una bitácora caída»: `logAction` YA se traga
    // todo y nunca rechaza (`activity-log.service.ts`), así que forzarla a rechazar fabricaría un
    // estado que la producción no puede producir — y el `void` de la llamada haría estallar al
    // worker de Jest, no a `abrirTurnoDeCaja`. Sería una prueba que acusa en falso.
    conZombi()

    await abrirTurnoDeCaja(params())

    expect(m.shift.findMany.mock.invocationCallOrder[0]).toBeLessThan(m.shift.findFirst.mock.invocationCallOrder[0])
  })
})
