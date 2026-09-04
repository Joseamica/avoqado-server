/**
 * 🔴 DINERO. Abrir el turno de caja del NEGOCIO es UN gesto, no dos.
 *
 * Hoy el negocio abre DOS cosas cada mañana: la **Caja** en la tablet (con su fondo) y el **Turno**
 * en la PAX (con otro fondo). Testarudo, 1-sep-2026: la caja abrió a las 07:38 con $2,000 en un
 * Sunmi D3 y el turno a las 08:12 con $0 en la PAX — dos registros y dos fondos distintos para UNA
 * sola caja física. El founder: «la persona va a pensar "abro mi turno desde el POS con saldo
 * inicial en abrir caja" — los confundirá».
 *
 * `abrirTurnoDeCaja` es la respuesta: **liga en vez de duplicar**. Si ya hay caja, el turno se ata a
 * ella; si ya hay turno, la caja se ata a él; si no hay nada, se crean las dos con el MISMO fondo.
 *
 * 🔴 Y el relevo NO es un cierre por reloj (el founder lo vetó): sólo se cierra —sin conteo— un
 * turno que quedó abierto de un DÍA DE NEGOCIO ANTERIOR, con el mismo corte de 04:00 en la zona del
 * venue que ya usa `cashDrawerAutoClose`, y ese corte sólo sirve para decidir «es de otro día».
 * Un turno del MISMO día se reusa tal cual.
 */

jest.mock('@/communication/rabbitmq/publisher', () => ({ publishCommand: jest.fn() }))
jest.mock('@/communication/rabbitmq/commandListener', () => ({ deliverPosCommand: jest.fn() }))

import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { publishCommand } from '@/communication/rabbitmq/publisher'
import { deliverPosCommand } from '@/communication/rabbitmq/commandListener'
import { logAction } from '@/services/dashboard/activity-log.service'
import { abrirTurnoDeCaja } from '@/services/shared/turnoDeCaja'
import { ConflictError, NotFoundError } from '@/errors/AppError'
import { Prisma } from '@prisma/client'

const mockLogAction = logAction as jest.MockedFunction<typeof logAction>
const mockLogger = logger as unknown as { warn: jest.Mock }

const m = prisma as unknown as {
  venue: { findUnique: jest.Mock }
  staffVenue: { findFirst: jest.Mock }
  shift: { findFirst: jest.Mock; findUnique: jest.Mock; create: jest.Mock; updateMany: jest.Mock }
  cashDrawerSession: { findFirst: jest.Mock; findUnique: jest.Mock; create: jest.Mock; updateMany: jest.Mock }
  posCommand: { create: jest.Mock }
  $transaction: jest.Mock
  $queryRaw: jest.Mock
}

const VENUE = 'venue-1'
const STAFF = 'staff-1'
/** Martes 3-sep-2026, 09:00 en CDMX (UTC−6) = 15:00 UTC. Dentro del día de negocio del 3. */
const AHORA = new Date('2026-09-03T15:00:00.000Z')
const ahora = () => AHORA

function sembrarVenue(over: Record<string, unknown> = {}) {
  m.venue.findUnique.mockResolvedValue({
    id: VENUE,
    name: 'Testarudo Cafe',
    timezone: 'America/Mexico_City',
    posType: null,
    posStatus: 'NOT_INTEGRATED',
    ...over,
  })
  m.staffVenue.findFirst.mockResolvedValue({
    staffId: STAFF,
    venueId: VENUE,
    posStaffId: null,
    staff: { id: STAFF, firstName: 'Vir', lastName: 'Gomez' },
  })
}

/** Ni turno ni caja abiertos: el caso «no hay nada». */
function sinNada() {
  m.shift.findFirst.mockResolvedValue(null)
  m.cashDrawerSession.findFirst.mockResolvedValue(null)
  m.cashDrawerSession.findUnique.mockResolvedValue(null)
  m.shift.create.mockImplementation(({ data }: any) => Promise.resolve({ id: 'turno-nuevo', ...data }))
  m.cashDrawerSession.create.mockImplementation(({ data }: any) => Promise.resolve({ id: 'caja-nueva', ...data }))
  m.cashDrawerSession.updateMany.mockResolvedValue({ count: 1 })
  m.shift.updateMany.mockResolvedValue({ count: 1 })
  m.shift.findUnique.mockResolvedValue(null)
}

/**
 * Un P2002 CON su `meta.target`, que es lo que permite saber QUÉ único chocó. Sin discriminar,
 * un choque de `Shift(venueId, externalId)` —que se puebla en los venues integrados— le diría al
 * cajero «ya hay un turno abierto» sobre un negocio que no tiene ninguno.
 */
const p2002 = (target: string | string[] = 'Shift_venueId_open_key') =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'x',
    meta: { target },
  } as any)

/**
 * 🔴 LA FORMA REAL, MEDIDA CONTRA POSTGRES EL 3-SEP-2026 provocando el choque de verdad dentro de
 * una transacción revertida:
 *
 *     code: 'P2002'   meta: { modelName: 'Shift', target: ['venueId'] }   constraint: undefined
 *
 * O sea: `meta.target` trae la lista de COLUMNAS, **no** el nombre del índice, y `meta.constraint`
 * ni siquiera viene. La primera versión de esta discriminación comparaba contra
 * `'Shift_venueId_open_key'` y por tanto **no disparaba nunca** — y estas pruebas no podían cazarlo
 * porque construían la forma que yo había asumido. Es el caso de libro de una prueba que pasa por
 * el motivo equivocado, así que la forma medida entra como fixture propio.
 */
const p2002Real = (columnas: string[], modelName: string) =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'x',
    meta: { modelName, target: columnas },
  } as any)

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

beforeEach(() => {
  sembrarVenue()
  sinNada()
  ;(publishCommand as jest.Mock).mockResolvedValue(undefined)
  ;(deliverPosCommand as jest.Mock).mockResolvedValue('COMPLETED')
  m.posCommand.create.mockResolvedValue({ id: 'cmd-open' })
})

// ============================================================================
// LIGAR, NO DUPLICAR
// ============================================================================

describe('abrirTurnoDeCaja — liga en vez de duplicar', () => {
  it('🔴 el caso de Testarudo: ya hay CAJA abierta y se pide turno ⇒ liga, no crea una segunda caja', async () => {
    m.cashDrawerSession.findFirst.mockResolvedValue({
      id: 'caja-de-la-tablet',
      venueId: VENUE,
      status: 'OPEN',
      startingAmount: new Prisma.Decimal(2000),
      shiftId: null,
      openedAt: new Date('2026-09-03T13:38:00.000Z'),
    })

    const r = await abrirTurnoDeCaja(params({ source: 'TURNO_TPV', startingCash: 0 }))

    expect(m.cashDrawerSession.create).not.toHaveBeenCalled()
    expect(r.cashDrawerSessionId).toBe('caja-de-la-tablet')
    expect(r.cajaCreada).toBe(false)
    expect(r.shiftCreado).toBe(true)
    // La liga queda escrita: es lo que hace que las dos verdades sean una sola.
    expect(m.cashDrawerSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'caja-de-la-tablet', shiftId: null }, data: { shiftId: r.shiftId } }),
    )
  })

  it('🔴 el fondo de la caja que ya estaba NO se pisa (los $2,000 contados siguen siendo $2,000)', async () => {
    m.cashDrawerSession.findFirst.mockResolvedValue({
      id: 'caja-de-la-tablet',
      venueId: VENUE,
      status: 'OPEN',
      startingAmount: new Prisma.Decimal(2000),
      shiftId: null,
      openedAt: new Date('2026-09-03T13:38:00.000Z'),
    })

    await abrirTurnoDeCaja(params({ source: 'TURNO_TPV', startingCash: 0 }))

    // Ni un `update` de `startingAmount`: el único update sobre la caja es la liga.
    for (const llamada of m.cashDrawerSession.updateMany.mock.calls) {
      expect(llamada[0].data).not.toHaveProperty('startingAmount')
    }
  })

  it('ya hay TURNO abierto de HOY y se pide caja ⇒ liga, no crea un segundo turno', async () => {
    m.shift.findFirst.mockResolvedValue({
      id: 'turno-de-hoy',
      venueId: VENUE,
      status: 'OPEN',
      endTime: null,
      startTime: new Date('2026-09-03T14:12:00.000Z'),
      startingCash: new Prisma.Decimal(0),
    })

    const r = await abrirTurnoDeCaja(params())

    expect(m.shift.create).not.toHaveBeenCalled()
    expect(r.shiftId).toBe('turno-de-hoy')
    expect(r.shiftCreado).toBe(false)
    expect(r.cajaCreada).toBe(true)
    expect(r.relevo).toBeUndefined()
    expect(m.cashDrawerSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'caja-nueva', shiftId: null }, data: { shiftId: 'turno-de-hoy' } }),
    )
  })

  it('no hay nada ⇒ crea las DOS con el MISMO fondo y las liga', async () => {
    const r = await abrirTurnoDeCaja(params({ startingCash: 1500 }))

    expect(r.shiftCreado).toBe(true)
    expect(r.cajaCreada).toBe(true)
    expect(Number(m.shift.create.mock.calls[0][0].data.startingCash)).toBe(1500)
    expect(Number(m.cashDrawerSession.create.mock.calls[0][0].data.startingAmount)).toBe(1500)
    expect(m.cashDrawerSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'caja-nueva', shiftId: null }, data: { shiftId: 'turno-nuevo' } }),
    )
  })

  it('la caja nueva nace con su evento OPEN por el MISMO monto (el arqueo se calcula de los eventos)', async () => {
    await abrirTurnoDeCaja(params({ startingCash: 1500 }))

    const evento = m.cashDrawerSession.create.mock.calls[0][0].data.events.create
    expect(evento.type).toBe('OPEN')
    expect(Number(evento.amount)).toBe(1500)
    expect(evento.staffId).toBe(STAFF)
  })

  it('ya hay las DOS ⇒ no crea nada y devuelve las que hay (una apertura encolada sin red no rebota)', async () => {
    m.shift.findFirst.mockResolvedValue({
      id: 'turno-de-hoy',
      venueId: VENUE,
      status: 'OPEN',
      endTime: null,
      startTime: new Date('2026-09-03T14:12:00.000Z'),
      startingCash: new Prisma.Decimal(0),
    })
    m.cashDrawerSession.findFirst.mockResolvedValue({
      id: 'caja-de-hoy',
      venueId: VENUE,
      status: 'OPEN',
      startingAmount: new Prisma.Decimal(2000),
      shiftId: 'turno-de-hoy',
      openedAt: new Date('2026-09-03T13:38:00.000Z'),
    })

    const r = await abrirTurnoDeCaja(params())

    expect(m.shift.create).not.toHaveBeenCalled()
    expect(m.cashDrawerSession.create).not.toHaveBeenCalled()
    expect(r).toMatchObject({ shiftId: 'turno-de-hoy', cashDrawerSessionId: 'caja-de-hoy', shiftCreado: false, cajaCreada: false })
    // Ya estaba ligada a ESTE turno: no se vuelve a escribir.
    expect(m.cashDrawerSession.updateMany).not.toHaveBeenCalled()
  })

  it('una caja ya ligada a OTRO turno NO se le roba la liga (el arqueo se queda con quien lo abrió)', async () => {
    m.cashDrawerSession.findFirst.mockResolvedValue({
      id: 'caja-abierta',
      venueId: VENUE,
      status: 'OPEN',
      startingAmount: new Prisma.Decimal(500),
      shiftId: 'turno-viejo-ya-cerrado',
      openedAt: new Date('2026-09-03T13:00:00.000Z'),
    })

    const r = await abrirTurnoDeCaja(params())

    // La liga es condicional (`shiftId: null`): sobre una caja ya ligada no reescribe nada.
    expect(m.cashDrawerSession.updateMany).not.toHaveBeenCalled()
    expect(r.cashDrawerSessionId).toBe('caja-abierta')
  })

  it('si OTRA caja ya reclama este turno, no se intenta ligar (el `@unique` no puede reventar la apertura)', async () => {
    m.shift.findFirst.mockResolvedValue({
      id: 'turno-de-hoy',
      venueId: VENUE,
      status: 'OPEN',
      endTime: null,
      startTime: new Date('2026-09-03T14:12:00.000Z'),
      startingCash: new Prisma.Decimal(0),
    })
    m.cashDrawerSession.findUnique.mockResolvedValue({ id: 'otra-caja-ya-ligada' })

    const r = await abrirTurnoDeCaja(params())

    expect(m.cashDrawerSession.updateMany).not.toHaveBeenCalled()
    expect(r.shiftId).toBe('turno-de-hoy')
  })
})

// ============================================================================
// RELEVO AL ABRIR (nunca cierre por reloj)
// ============================================================================

describe('abrirTurnoDeCaja — relevo al abrir, NUNCA cierre por reloj', () => {
  /** Turno abierto AYER a las 10:00 CDMX: cae antes del corte de las 04:00 de hoy. */
  const turnoDeAyer = {
    id: 'turno-de-ayer',
    venueId: VENUE,
    status: 'OPEN',
    endTime: null,
    startTime: new Date('2026-09-02T16:00:00.000Z'),
    startingCash: new Prisma.Decimal(500),
    notes: null,
  }

  it('🔴 un turno abierto de AYER se releva: se cierra y se abre uno nuevo', async () => {
    m.shift.findFirst.mockResolvedValue(turnoDeAyer)

    const r = await abrirTurnoDeCaja(params())

    expect(r.relevo).toEqual({ shiftCerradoId: 'turno-de-ayer' })
    expect(r.shiftCreado).toBe(true)
    expect(r.shiftId).toBe('turno-nuevo')
  })

  it('🔴 el relevo NO INVENTA UN CONTEO: ni `endingCash`, ni `cashDeclared`, ni `cashDifference`', async () => {
    m.shift.findFirst.mockResolvedValue(turnoDeAyer)

    await abrirTurnoDeCaja(params())

    const data = m.shift.updateMany.mock.calls[0][0].data
    expect(data.status).toBe('CLOSED')
    expect(data.endTime).toBeInstanceOf(Date)
    for (const campo of ['endingCash', 'cashDeclared', 'cashDifference', 'cardDeclared', 'vouchersDeclared', 'otherDeclared']) {
      expect(data).not.toHaveProperty(campo)
    }
  })

  it('el relevo cierra con un CAS sobre `{ status: OPEN, endTime: null }` (no pisa un cierre en curso)', async () => {
    m.shift.findFirst.mockResolvedValue(turnoDeAyer)

    await abrirTurnoDeCaja(params())

    expect(m.shift.updateMany.mock.calls[0][0].where).toEqual({
      id: 'turno-de-ayer',
      venueId: VENUE,
      status: 'OPEN',
      endTime: null,
    })
  })

  it('🔴 si otro aparato ya cerró el turno de ayer, eso es LO QUE QUERÍAMOS: se sigue, no se lanza', async () => {
    // El CAS pierde porque alguien más ya lo cerró. Lanzar aquí sería reportar una carrera BENIGNA
    // como conflicto permanente — y las apps tratan el 409 como rechazo definitivo, así que una
    // apertura encolada que cayera aquí se descartaría PARA SIEMPRE.
    m.shift.findFirst.mockResolvedValue(turnoDeAyer)
    m.shift.updateMany.mockResolvedValue({ count: 0 })
    m.shift.findUnique.mockResolvedValue({ status: 'CLOSED', endTime: new Date('2026-09-03T09:00:00.000Z') })

    const r = await abrirTurnoDeCaja(params())

    expect(r.shiftCreado).toBe(true)
    expect(r.shiftId).toBe('turno-nuevo')
    // No lo cerramos nosotros, así que no se reporta como relevo de esta llamada.
    expect(r.relevo?.shiftCerradoId).toBeUndefined()
  })

  it('si el turno de ayer quedó en CLOSING mientras se abría, el mensaje dice LA VERDAD (cierre en curso)', async () => {
    m.shift.findFirst.mockResolvedValue(turnoDeAyer)
    m.shift.updateMany.mockResolvedValue({ count: 0 })
    m.shift.findUnique.mockResolvedValue({ status: 'CLOSING', endTime: null })

    await expect(abrirTurnoDeCaja(params())).rejects.toMatchObject({ code: 'SHIFT_CLOSE_IN_PROGRESS' })
    expect(m.shift.create).not.toHaveBeenCalled()
  })

  it('🔴 si falla y el turno sigue abierto, el mensaje NO miente diciendo «ciérralo antes de abrir otro»', async () => {
    m.shift.findFirst.mockResolvedValue(turnoDeAyer)
    m.shift.updateMany.mockResolvedValue({ count: 0 })
    m.shift.findUnique.mockResolvedValue({ status: 'OPEN', endTime: null })

    await expect(abrirTurnoDeCaja(params())).rejects.toMatchObject({ code: 'SHIFT_HANDOVER_RETRY' })
    await expect(abrirTurnoDeCaja(params())).rejects.toThrow(/vuelve a intentar/i)
    expect(m.shift.create).not.toHaveBeenCalled()
  })

  it('🔴 un turno abierto HOY se REUSA: no se releva ni se cierra nada', async () => {
    m.shift.findFirst.mockResolvedValue({
      ...turnoDeAyer,
      id: 'turno-de-hoy',
      // 05:00 CDMX de hoy: después del corte de las 04:00 ⇒ MISMO día de negocio.
      startTime: new Date('2026-09-03T11:00:00.000Z'),
    })

    const r = await abrirTurnoDeCaja(params())

    expect(m.shift.updateMany).not.toHaveBeenCalled()
    expect(m.shift.create).not.toHaveBeenCalled()
    expect(r.relevo).toBeUndefined()
    expect(r.shiftId).toBe('turno-de-hoy')
  })

  it('🔴 la madrugada NO es otro día: a las 02:00 sigue corriendo el día de negocio de ayer', async () => {
    // Se abre a las 02:00 CDMX del 3-sep (08:00 UTC) un turno que empezó ayer a las 22:00.
    m.shift.findFirst.mockResolvedValue({ ...turnoDeAyer, startTime: new Date('2026-09-03T04:00:00.000Z') })

    const r = await abrirTurnoDeCaja(params({ now: () => new Date('2026-09-03T08:00:00.000Z') }))

    expect(m.shift.updateMany).not.toHaveBeenCalled()
    expect(r.relevo).toBeUndefined()
    expect(r.shiftId).toBe('turno-de-ayer')
  })

  it('el corte se calcula en la ZONA DEL VENUE, no en UTC ni en la del servidor', async () => {
    // Tijuana (UTC−7): a las 15:00 UTC son las 08:00 locales, ya pasado el corte de las 04:00.
    // El turno empezó a las 03:00 locales del MISMO día civil — antes del corte ⇒ es de ayer.
    sembrarVenue({ timezone: 'America/Tijuana' })
    m.shift.findFirst.mockResolvedValue({ ...turnoDeAyer, startTime: new Date('2026-09-03T10:00:00.000Z') })

    const r = await abrirTurnoDeCaja(params())

    expect(r.relevo).toEqual({ shiftCerradoId: 'turno-de-ayer' })
  })

  it('el relevo deja rastro legible en `notes` (quien lo lea sabe que nadie contó)', async () => {
    m.shift.findFirst.mockResolvedValue(turnoDeAyer)

    await abrirTurnoDeCaja(params())

    expect(String(m.shift.updateMany.mock.calls[0][0].data.notes)).toMatch(/relevo/i)
  })
})

// ============================================================================
// CONCURRENCIA: DOS APERTURAS A LA VEZ
// ============================================================================

describe('abrirTurnoDeCaja — dos aperturas simultáneas: una gana, la otra recibe ConflictError', () => {
  it('toma el lock DB del venue antes de observar o crear el Shift', async () => {
    await abrirTurnoDeCaja(params())

    expect(m.$queryRaw).toHaveBeenCalledTimes(1)
    expect(m.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(m.shift.findFirst.mock.invocationCallOrder[0])
    expect(m.$queryRaw.mock.calls[0][0].values).toEqual(expect.arrayContaining([expect.stringContaining(VENUE)]))
  })

  it('🔴 el índice único parcial del TURNO (P2002) se traduce a ConflictError, nunca a un 500', async () => {
    m.shift.create.mockRejectedValue(p2002())

    await expect(abrirTurnoDeCaja(params())).rejects.toBeInstanceOf(ConflictError)
  })

  it('🔴 el índice único parcial de la CAJA (P2002) se traduce al MISMO ConflictError', async () => {
    m.cashDrawerSession.create.mockRejectedValue(p2002('CashDrawerSession_venueId_open_key'))

    await expect(abrirTurnoDeCaja(params())).rejects.toBeInstanceOf(ConflictError)
  })

  it('un turno en CLOSING (cierre en curso) no se reusa ni se pisa: ConflictError', async () => {
    m.shift.findFirst.mockResolvedValue({
      id: 'turno-cerrandose',
      venueId: VENUE,
      status: 'CLOSING',
      endTime: null,
      startTime: new Date('2026-09-03T14:00:00.000Z'),
    })

    await expect(abrirTurnoDeCaja(params())).rejects.toBeInstanceOf(ConflictError)
    expect(m.shift.create).not.toHaveBeenCalled()
  })

  it('la consulta del turno mira `endTime: null` (OPEN y CLOSING), no sólo OPEN', async () => {
    await abrirTurnoDeCaja(params())

    const where = m.shift.findFirst.mock.calls.at(-1)![0].where
    expect(where).toMatchObject({ venueId: VENUE, endTime: null })
    // 🔴 Nunca por persona: el turno es del NEGOCIO (decisión del founder, 2-sep-2026).
    expect(where).not.toHaveProperty('staffId')
  })
})

// ============================================================================
// PUERTAS DE ENTRADA
// ============================================================================

describe('abrirTurnoDeCaja — validaciones', () => {
  it('venue inexistente ⇒ NotFoundError, sin escribir nada', async () => {
    m.venue.findUnique.mockResolvedValue(null)

    await expect(abrirTurnoDeCaja(params())).rejects.toBeInstanceOf(NotFoundError)
    expect(m.shift.create).not.toHaveBeenCalled()
    expect(m.cashDrawerSession.create).not.toHaveBeenCalled()
  })

  it('staff que no pertenece al venue ⇒ NotFoundError', async () => {
    m.staffVenue.findFirst.mockResolvedValue(null)

    await expect(abrirTurnoDeCaja(params())).rejects.toBeInstanceOf(NotFoundError)
    expect(m.shift.create).not.toHaveBeenCalled()
  })

  it('un fondo negativo se rechaza antes de tocar la base', async () => {
    await expect(abrirTurnoDeCaja(params({ startingCash: -1 }))).rejects.toThrow()
    expect(m.shift.create).not.toHaveBeenCalled()
  })
})

// ============================================================================
// EL PUENTE A SOFTRESTAURANT (se conserva el de `openShiftForVenue`)
// ============================================================================

describe('abrirTurnoDeCaja — el puente a SoftRestaurant', () => {
  const integrado = { posType: 'SOFTRESTAURANT', posStatus: 'CONNECTED' }

  it('venue integrado y turno NUEVO ⇒ confirma el outbox despues del commit y guarda su `externalId`', async () => {
    sembrarVenue(integrado)

    await abrirTurnoDeCaja(params({ startingCash: 700, stationId: 'CAJA1' }))

    const outbox = m.posCommand.create.mock.calls[0][0].data
    expect(outbox).toMatchObject({ entityType: 'Shift', action: 'OPEN', payload: { startingCash: 700, stationId: 'CAJA1' } })
    expect(m.shift.create.mock.calls[0][0].data.externalId).toBe(outbox.payload.tempShiftId)
    expect(deliverPosCommand).toHaveBeenCalledWith('cmd-open')
    expect(publishCommand).not.toHaveBeenCalled()
  })

  it('venue integrado pero el turno se REUSA ⇒ no se manda ningún comando al POS', async () => {
    sembrarVenue(integrado)
    m.shift.findFirst.mockResolvedValue({
      id: 'turno-de-hoy',
      venueId: VENUE,
      status: 'OPEN',
      endTime: null,
      startTime: new Date('2026-09-03T14:12:00.000Z'),
      startingCash: new Prisma.Decimal(0),
    })

    await abrirTurnoDeCaja(params())

    expect(m.posCommand.create).not.toHaveBeenCalled()
    expect(deliverPosCommand).not.toHaveBeenCalled()
    expect(publishCommand).not.toHaveBeenCalled()
  })

  it('venue NO integrado ⇒ nunca se manda comando y el `externalId` queda nulo', async () => {
    await abrirTurnoDeCaja(params())

    expect(m.posCommand.create).not.toHaveBeenCalled()
    expect(deliverPosCommand).not.toHaveBeenCalled()
    expect(publishCommand).not.toHaveBeenCalled()
    expect(m.shift.create.mock.calls[0][0].data.externalId).toBeNull()
  })

  it('si Rabbit falla despues del commit, el turno queda abierto y el outbox sigue durable', async () => {
    sembrarVenue(integrado)
    ;(deliverPosCommand as jest.Mock).mockRejectedValue(new Error('rabbit caído'))

    await expect(abrirTurnoDeCaja(params())).resolves.toMatchObject({ shiftCreado: true, cajaCreada: true })
    expect(m.shift.create).toHaveBeenCalledTimes(1)
    expect(m.cashDrawerSession.create).toHaveBeenCalledTimes(1)
    expect(m.posCommand.create).toHaveBeenCalledTimes(1)
  })
})

// ============================================================================
// EL RELEVO DE LA CAJA (la asimetría que encontró la revisión)
// ============================================================================

/**
 * 🔴 EL TURNO DE HOY NO PUEDE HEREDAR LA CAJA DE AYER.
 *
 * La primera versión relevaba el TURNO comparando contra el corte del día de negocio, pero buscaba
 * la caja con un `{ venueId, status: 'OPEN' }` pelado, sin comparar contra nada. La asimetría era
 * la señal.
 *
 * El escenario que lo destapa es real y no raro: abren a las 05:30; el turno de ayer se releva
 * bien, pero la caja de ayer sigue abierta porque el auto-cierre (`cashDrawerAutoClose`) la respeta
 * si tuvo movimiento hace menos de 2 h — y una venta de las 03:30 la protege. El turno de hoy
 * adoptaba esa caja con su fondo de ayer y sus eventos de DOS días, y quien cerrara hoy contaría el
 * efectivo contra un esperado que no es el suyo.
 *
 * 🔴 Y aquí NO aplica la gracia de inactividad del job, a propósito: ese barrido corre solo, con un
 * temporizador, y necesita la salvaguarda para no arrancarle la caja a un local que sigue vendiendo
 * a las 04:05. Aquí hay una PERSONA en el mostrador pidiendo abrir, que es la señal más fuerte que
 * existe de que la sesión anterior terminó.
 */
describe('abrirTurnoDeCaja — la caja de un día anterior se releva, no se adopta', () => {
  const cajaDeAyer = {
    id: 'caja-de-ayer',
    venueId: VENUE,
    status: 'OPEN',
    startingAmount: new Prisma.Decimal(500),
    shiftId: null,
    // Abierta ayer a las 10:00 CDMX.
    openedAt: new Date('2026-09-02T16:00:00.000Z'),
  }

  it('🔴 el escenario de las 05:30: se releva el turno de ayer Y la caja de ayer', async () => {
    m.shift.findFirst.mockResolvedValue({
      id: 'turno-de-ayer',
      venueId: VENUE,
      status: 'OPEN',
      endTime: null,
      startTime: new Date('2026-09-02T16:00:00.000Z'),
      notes: null,
    })
    m.cashDrawerSession.findFirst.mockResolvedValue(cajaDeAyer)

    const r = await abrirTurnoDeCaja(params({ now: () => new Date('2026-09-03T11:30:00.000Z'), startingCash: 1000 }))

    expect(r.relevo).toEqual({ shiftCerradoId: 'turno-de-ayer', cajaCerradaId: 'caja-de-ayer' })
    // La caja de hoy es NUEVA, con el fondo de hoy — no la de ayer con sus eventos de dos días.
    expect(r.cajaCreada).toBe(true)
    expect(r.cashDrawerSessionId).toBe('caja-nueva')
    expect(Number(m.cashDrawerSession.create.mock.calls[0][0].data.startingAmount)).toBe(1000)
  })

  it('🔴 el relevo de la caja NO INVENTA UN CONTEO: `actualAmount` y `overShort` no se tocan', async () => {
    m.cashDrawerSession.findFirst.mockResolvedValue(cajaDeAyer)

    await abrirTurnoDeCaja(params())

    const cierre = m.cashDrawerSession.updateMany.mock.calls.find((c: any) => c[0].data.status === 'CLOSED')
    expect(cierre).toBeDefined()
    expect(cierre![0].where).toMatchObject({ id: 'caja-de-ayer', status: 'OPEN' })
    for (const campo of ['actualAmount', 'overShort']) {
      expect(cierre![0].data).not.toHaveProperty(campo)
    }
    // La firma que `isAutoClosedSession` reconoce: sin persona que cerrara.
    expect(cierre![0].data.closedByStaffId).toBeNull()
  })

  it('el relevo de la caja NO crea un evento CLOSE (una fila en cero se leería como un conteo)', async () => {
    m.cashDrawerSession.findFirst.mockResolvedValue(cajaDeAyer)

    await abrirTurnoDeCaja(params())

    for (const llamada of m.cashDrawerSession.create.mock.calls) {
      expect(llamada[0].data.events?.create?.type).not.toBe('CLOSE')
    }
  })

  it('una caja abierta HOY se adopta como siempre: no se releva', async () => {
    m.cashDrawerSession.findFirst.mockResolvedValue({ ...cajaDeAyer, id: 'caja-de-hoy', openedAt: new Date('2026-09-03T13:38:00.000Z') })

    const r = await abrirTurnoDeCaja(params())

    expect(r.cashDrawerSessionId).toBe('caja-de-hoy')
    expect(r.cajaCreada).toBe(false)
    expect(r.relevo?.cajaCerradaId).toBeUndefined()
    expect(m.cashDrawerSession.create).not.toHaveBeenCalled()
  })

  it('🔴 una venta de madrugada NO protege la caja de ayer: aquí no hay gracia de inactividad', async () => {
    // El job la respetaría (movimiento hace < 2 h). El gesto humano no: alguien está pidiendo abrir.
    m.cashDrawerSession.findFirst.mockResolvedValue(cajaDeAyer)

    const r = await abrirTurnoDeCaja(params({ now: () => new Date('2026-09-03T11:30:00.000Z') }))

    expect(r.relevo?.cajaCerradaId).toBe('caja-de-ayer')
  })

  it('si alguien cerró la caja de ayer entre la lectura y el CAS, se crea la de hoy igual', async () => {
    m.cashDrawerSession.findFirst.mockResolvedValue(cajaDeAyer)
    m.cashDrawerSession.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValue({ count: 1 })

    const r = await abrirTurnoDeCaja(params())

    expect(r.cajaCreada).toBe(true)
    // No lo hicimos nosotros, así que no se reporta como relevo de esta llamada.
    expect(r.relevo?.cajaCerradaId).toBeUndefined()
  })
})

// ============================================================================
// EL P2002 TIENE QUE DECIR QUÉ ÚNICO CHOCÓ
// ============================================================================

describe('abrirTurnoDeCaja — no todo P2002 es «ya hay un turno abierto»', () => {
  it('🔴 un P2002 de `Shift(venueId, externalId)` NO se disfraza de turno abierto', async () => {
    // Se puebla en los venues integrados con SoftRestaurant. Traducirlo mandaría al cajero a buscar
    // un turno abierto que no existe.
    m.shift.create.mockRejectedValue(p2002(['venueId', 'externalId']))

    await expect(abrirTurnoDeCaja(params())).rejects.not.toBeInstanceOf(ConflictError)
  })

  it('un P2002 sin `meta.target` tampoco se traduce: no se adivina', async () => {
    m.shift.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'x' } as any),
    )

    await expect(abrirTurnoDeCaja(params())).rejects.not.toBeInstanceOf(ConflictError)
  })

  it('🔴 la forma REAL de Postgres (`target: [venueId]`, sin `constraint`) SÍ se traduce', async () => {
    // Es la que de verdad llega. Sin este caso, la traducción podía no dispararse nunca y las otras
    // pruebas seguirían en verde: `openShiftForVenue` devolvería 500 en la ruta viva de la PAX ante
    // un doble intento legítimo, en vez del 409 amable.
    m.shift.create.mockRejectedValue(p2002Real(['venueId'], 'Shift'))

    await expect(abrirTurnoDeCaja(params())).rejects.toMatchObject({ code: 'CASH_SHIFT_ALREADY_OPEN' })
  })

  it('🔴 la forma REAL del choque de la CAJA (`target: [venueId]`) SÍ se traduce', async () => {
    m.cashDrawerSession.create.mockRejectedValue(p2002Real(['venueId'], 'CashDrawerSession'))

    await expect(abrirTurnoDeCaja(params())).rejects.toMatchObject({ code: 'CASH_SHIFT_ALREADY_OPEN' })
  })

  it('🔴 la forma REAL del OTRO único de la caja (`target: [shiftId]`) NO se traduce', async () => {
    m.cashDrawerSession.create.mockRejectedValue(p2002Real(['shiftId'], 'CashDrawerSession'))

    await expect(abrirTurnoDeCaja(params())).rejects.not.toBeInstanceOf(ConflictError)
  })

  it('el P2002 del índice de abiertos SÍ se traduce, venga como nombre de índice o como lista de campos', async () => {
    m.shift.create.mockRejectedValue(p2002('Shift_venueId_open_key'))
    await expect(abrirTurnoDeCaja(params())).rejects.toMatchObject({ code: 'CASH_SHIFT_ALREADY_OPEN' })

    m.shift.create.mockRejectedValue(p2002(['Shift_venueId_open_key']))
    await expect(abrirTurnoDeCaja(params())).rejects.toMatchObject({ code: 'CASH_SHIFT_ALREADY_OPEN' })
  })

  it('también por `meta.constraint`, que es la tercera forma que Prisma puede dar', async () => {
    m.shift.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'x',
        meta: { modelName: 'Shift', constraint: 'Shift_venueId_open_key' },
      } as any),
    )

    await expect(abrirTurnoDeCaja(params())).rejects.toMatchObject({ code: 'CASH_SHIFT_ALREADY_OPEN' })
  })

  it('🔴 un P2002 de la CAJA por otro único (`shiftId`) no se disfraza de «ya hay caja abierta»', async () => {
    m.cashDrawerSession.create.mockRejectedValue(p2002('CashDrawerSession_shiftId_key'))

    await expect(abrirTurnoDeCaja(params())).rejects.not.toBeInstanceOf(ConflictError)
  })

  it('el P2002 del índice de cajas abiertas SÍ se traduce', async () => {
    m.cashDrawerSession.create.mockRejectedValue(p2002('CashDrawerSession_venueId_open_key'))

    await expect(abrirTurnoDeCaja(params())).rejects.toMatchObject({ code: 'CASH_SHIFT_ALREADY_OPEN' })
  })
})

// ============================================================================
// NO SE AVISA AL POS DE UNA APERTURA QUE VA A RECHAZARSE
// ============================================================================

describe('abrirTurnoDeCaja — el POS externo no recibe turnos que Avoqado nunca creará', () => {
  it('🔴 con un turno en CLOSING, se rechaza ANTES de publicar (como hace `openShiftForVenue`)', async () => {
    sembrarVenue({ posType: 'SOFTRESTAURANT', posStatus: 'CONNECTED' })
    m.shift.findFirst.mockResolvedValue({
      id: 'turno-cerrandose',
      venueId: VENUE,
      status: 'CLOSING',
      endTime: null,
      // 🔴 De AYER a propósito: un CLOSING de hoy ya no publicaba «por suerte» (no haría falta
      // crear turno). El caso que de verdad publica es el de un día anterior, que además parece
      // relevable — y publicar ahí deja al POS con un turno que Avoqado va a rechazar.
      startTime: new Date('2026-09-02T16:00:00.000Z'),
    })

    await expect(abrirTurnoDeCaja(params())).rejects.toMatchObject({ code: 'SHIFT_CLOSE_IN_PROGRESS' })
    expect(publishCommand).not.toHaveBeenCalled()
  })
})

// ============================================================================
// LA BITÁCORA DICE LO QUE DE VERDAD SE ESCRIBIÓ
// ============================================================================

/**
 * 🔴 Estas pruebas nacieron de un hueco medido, no de un antojo: la re-revisión de la Task 4
 * comprobó que **borrar el bloque de auditoría entero dejaba las 45 pruebas en verde**. Las que
 * había filtraban `logAction` por `action` y afirmaban sólo el CONTEO, nunca los VALORES — o sea
 * que la única fila que registra «se mutó el fondo de un turno que abrió otra persona» no tenía
 * guarda ninguna. Es la familia `prueba-que-pasa-por-el-motivo-equivocado`.
 *
 * Lo que aquí se fija es el CONTENIDO: el fondo que se registra es el APLICADO (el que quedó en la
 * fila), nunca el tecleado, y el `de`/`a` de la alineación es lo único que le permite a un dueño
 * auditar por qué su turno cambió de fondo sin que nadie lo tocara.
 */
describe('abrirTurnoDeCaja — la bitácora registra lo ESCRITO, no lo pedido', () => {
  /** La caja que la tablet dejó abierta con $2,000 CONTADOS. */
  const cajaContada = {
    id: 'caja-de-la-tablet',
    venueId: VENUE,
    status: 'OPEN',
    startingAmount: new Prisma.Decimal(2000),
    shiftId: null,
    openedAt: new Date('2026-09-03T13:38:00.000Z'),
  }

  /** El turno de la PAX: abierto HOY, con el $0 que es el default del campo. */
  const turnoEnCero = {
    id: 'turno-de-hoy',
    venueId: VENUE,
    status: 'OPEN',
    endTime: null,
    startTime: new Date('2026-09-03T14:12:00.000Z'),
    startingCash: new Prisma.Decimal(0),
    notes: null,
  }

  const asientos = (action: string) => mockLogAction.mock.calls.filter(c => (c[0] as { action?: string })?.action === action)

  it('🔴 SHIFT_OPENED registra el fondo APLICADO, no el tecleado (Testarudo: $2,000, no $0)', async () => {
    m.cashDrawerSession.findFirst.mockResolvedValue(cajaContada)

    await abrirTurnoDeCaja(params({ source: 'TURNO_TPV', startingCash: 0 }))

    // Registrar el $0 tecleado dejaría al dueño leyendo «abrió con $0» sobre una fila que dice
    // $2,000: una divergencia entre el log y el dato que parece un bug del sistema.
    const [asiento] = asientos('SHIFT_OPENED')
    expect(asiento[0]).toMatchObject({ entity: 'Shift', entityId: 'turno-nuevo', venueId: VENUE, staffId: STAFF })
    expect((asiento[0].data as { startingCash: number }).startingCash).toBe(2000)
    expect((asiento[0].data as { source: string }).source).toBe('TURNO_TPV')
  })

  it('🔴 CASH_DRAWER_OPENED registra el `startingAmount` con el que la gaveta de verdad nació', async () => {
    m.shift.findFirst.mockResolvedValue({ ...turnoEnCero, startingCash: new Prisma.Decimal(2000) })

    await abrirTurnoDeCaja(params({ source: 'CAJA_MOVIL', startingCash: 0 }))

    const [asiento] = asientos('CASH_DRAWER_OPENED')
    expect(asiento[0]).toMatchObject({ entity: 'CashDrawerSession', entityId: 'caja-nueva' })
    expect((asiento[0].data as { startingAmount: number }).startingAmount).toBe(2000)
  })

  it('🔴 SHIFT_STARTING_CASH_ALIGNED dice de CUÁNTO a CUÁNTO se movió el fondo, y de qué gaveta', async () => {
    // Mutar el fondo de un turno YA ABIERTO es tocar dinero. Sin el `de`/`a`, la fila de la
    // bitácora no permite reconstruir qué cambió, que es exactamente para lo que existe.
    m.shift.findFirst.mockResolvedValue(turnoEnCero)

    await abrirTurnoDeCaja(params({ source: 'CAJA_MOVIL', startingCash: 2000 }))

    const [asiento] = asientos('SHIFT_STARTING_CASH_ALIGNED')
    expect(asiento).toBeDefined()
    expect(asiento[0]).toMatchObject({ entity: 'Shift', entityId: 'turno-de-hoy', venueId: VENUE, staffId: STAFF })
    expect(asiento[0].data).toMatchObject({ de: 0, a: 2000, cashDrawerSessionId: 'caja-nueva', source: 'CAJA_MOVIL' })
  })

  it('🔴 y NO se escribe cuando no se movió nada: un asiento de más miente igual que uno de menos', async () => {
    m.shift.findFirst.mockResolvedValue({ ...turnoEnCero, startingCash: new Prisma.Decimal(2000) })

    await abrirTurnoDeCaja(params({ source: 'CAJA_MOVIL', startingCash: 2000 }))

    expect(asientos('SHIFT_STARTING_CASH_ALIGNED')).toHaveLength(0)
  })

  it('🔴 si el CAS de la alineación PIERDE, no se registra la alineación y queda un aviso', async () => {
    // El turno pasó a CLOSING entre la lectura y el UPDATE: la gaveta nace con el fondo bueno y el
    // turno se queda en 0. Es JUSTO la divergencia que ese bloque existe para matar, así que
    // callarla sería peor que no haberlo intentado.
    m.shift.findFirst.mockResolvedValue(turnoEnCero)
    m.shift.updateMany.mockResolvedValue({ count: 0 })

    const r = await abrirTurnoDeCaja(params({ source: 'CAJA_MOVIL', startingCash: 2000 }))

    expect(r.turnoAlineadoDesde).toBeUndefined()
    expect(asientos('SHIFT_STARTING_CASH_ALIGNED')).toHaveLength(0)
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no se pudo alinear el fondo del turno'),
      expect.objectContaining({ venueId: VENUE, shiftId: 'turno-de-hoy', fondoDeLaGaveta: '2000' }),
    )
  })

  it('el relevo deja constancia de que NADIE contó, con el id de lo que cerró', async () => {
    m.shift.findFirst.mockResolvedValue({
      id: 'turno-de-ayer',
      venueId: VENUE,
      status: 'OPEN',
      endTime: null,
      startTime: new Date('2026-09-02T16:00:00.000Z'),
      startingCash: new Prisma.Decimal(500),
      notes: null,
    })

    await abrirTurnoDeCaja(params({ source: 'CAJA_MOVIL' }))

    const [asiento] = asientos('SHIFT_CLOSED_ON_NEXT_OPEN')
    expect(asiento[0]).toMatchObject({ entity: 'Shift', entityId: 'turno-de-ayer' })
    expect(asiento[0].data).toMatchObject({ sinConteo: true, source: 'CAJA_MOVIL' })
  })
})
