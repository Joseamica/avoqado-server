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

import prisma from '@/utils/prismaClient'
import { publishCommand } from '@/communication/rabbitmq/publisher'
import { abrirTurnoDeCaja } from '@/services/shared/turnoDeCaja'
import { ConflictError, NotFoundError } from '@/errors/AppError'
import { Prisma } from '@prisma/client'

const m = prisma as unknown as {
  venue: { findUnique: jest.Mock }
  staffVenue: { findFirst: jest.Mock }
  shift: { findFirst: jest.Mock; create: jest.Mock; updateMany: jest.Mock }
  cashDrawerSession: { findFirst: jest.Mock; findUnique: jest.Mock; create: jest.Mock; updateMany: jest.Mock }
  $transaction: jest.Mock
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
}

const p2002 = () => new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'x' } as any)

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

  it('si el CAS del relevo no gana (alguien lo cerró primero), es ConflictError y NO se crea turno', async () => {
    m.shift.findFirst.mockResolvedValue(turnoDeAyer)
    m.shift.updateMany.mockResolvedValue({ count: 0 })

    await expect(abrirTurnoDeCaja(params())).rejects.toBeInstanceOf(ConflictError)
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
  it('🔴 el índice único parcial del TURNO (P2002) se traduce a ConflictError, nunca a un 500', async () => {
    m.shift.create.mockRejectedValue(p2002())

    await expect(abrirTurnoDeCaja(params())).rejects.toBeInstanceOf(ConflictError)
  })

  it('🔴 el índice único parcial de la CAJA (P2002) se traduce al MISMO ConflictError', async () => {
    m.cashDrawerSession.create.mockRejectedValue(p2002())

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

  it('venue integrado y turno NUEVO ⇒ manda el comando al POS y guarda su `externalId`', async () => {
    sembrarVenue(integrado)

    await abrirTurnoDeCaja(params({ startingCash: 700, stationId: 'CAJA1' }))

    expect(publishCommand).toHaveBeenCalledWith(
      `command.softrestaurant.${VENUE}`,
      expect.objectContaining({ entity: 'Shift', action: 'OPEN' }),
    )
    const enviado = (publishCommand as jest.Mock).mock.calls[0][1]
    expect(m.shift.create.mock.calls[0][0].data.externalId).toBe(enviado.payload.tempShiftId)
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

    expect(publishCommand).not.toHaveBeenCalled()
  })

  it('venue NO integrado ⇒ nunca se manda comando y el `externalId` queda nulo', async () => {
    await abrirTurnoDeCaja(params())

    expect(publishCommand).not.toHaveBeenCalled()
    expect(m.shift.create.mock.calls[0][0].data.externalId).toBeNull()
  })

  it('si el POS no acepta el comando, NO se crea el turno (mismo corte que `openShiftForVenue`)', async () => {
    sembrarVenue(integrado)
    ;(publishCommand as jest.Mock).mockRejectedValue(new Error('rabbit caído'))

    await expect(abrirTurnoDeCaja(params())).rejects.toThrow()
    expect(m.shift.create).not.toHaveBeenCalled()
    expect(m.cashDrawerSession.create).not.toHaveBeenCalled()
  })
})
