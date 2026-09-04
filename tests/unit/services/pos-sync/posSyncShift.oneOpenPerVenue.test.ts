/**
 * 🔴 `pos-sync` es la TERCERA puerta que abre turnos, y no comprobaba nada.
 *
 * La Fase 2 añadió el índice único parcial `Shift(venueId) WHERE status='OPEN'`: un turno abierto
 * por negocio, garantizado en la base. `openShiftForVenue` y `abrirTurnoDeCaja` traducen ese choque
 * a un error legible; `posSyncShift` no lo tocaba, así que con el índice puesto sus dos escrituras
 * salían como **500 crudo en el worker** de sincronización.
 *
 * 🔴 Y hay algo peor que el 500, que es lo que obliga a arreglarlo en el mismo cambio que el índice:
 * si pos-sync lograra crear un `OPEN` mientras otro turno está en `CLOSING`, la reversión de
 * `releaseShiftCloseClaim` (CLOSING → OPEN) chocaría contra el índice, y esa función **se traga sus
 * errores**: el turno quedaría atascado en `CLOSING` para siempre y el negocio no podría volver a
 * abrir nunca. El índice impide crear el segundo `OPEN`; lo que faltaba era que el fallo fuera
 * legible en vez de un 500 anónimo.
 *
 * Las dos escrituras se tratan distinto **a propósito**:
 *
 *   · `getOrCreatePosShift` devuelve el id al que se atará una ORDEN. Si el negocio ya tiene su
 *     turno abierto, se devuelve ÉSE: el turno es del negocio (decisión del founder, 2-sep-2026) y
 *     dejar la orden sin turno es exactamente el defecto que este proyecto existe para arreglar.
 *   · `processPosShiftEvent` sincroniza los DATOS de un turno concreto. Devolver otro sería
 *     mis-sincronizar en silencio, así que falla, y el mensaje dice por qué.
 */

import prisma from '@/utils/prismaClient'
import { Prisma } from '@prisma/client'
import { getOrCreatePosShift, processPosShiftEvent } from '@/services/pos-sync/posSyncShift.service'
import { ConflictError } from '@/errors/AppError'
import { posSyncStaffService } from '@/services/pos-sync/posSyncStaff.service'

jest.mock('@/services/pos-sync/posSyncStaff.service', () => ({
  posSyncStaffService: { syncPosStaff: jest.fn().mockResolvedValue('staff-1') },
}))

const m = prisma as unknown as {
  shift: { findFirst: jest.Mock; create: jest.Mock; upsert: jest.Mock; findUnique: jest.Mock; updateMany: jest.Mock }
  venue: { findUnique: jest.Mock }
  order: { aggregate: jest.Mock; count: jest.Mock }
  payment: { findMany: jest.Mock }
  $transaction: jest.Mock
  $queryRaw: jest.Mock
}

const VENUE = 'venue-1'

/**
 * 🔴 EL CHOQUE DEL ÍNDICE DE ABIERTOS, CON LA FORMA REAL — medida contra Postgres el 3-sep-2026
 * provocando el conflicto de verdad: `meta: { modelName: 'Shift', target: ['venueId'] }`, y
 * `meta.constraint` **undefined**. `target` trae las COLUMNAS, no el nombre del índice.
 *
 * Importa aquí más que en ningún otro sitio: si el rescate no corre, el consumidor hace
 * `nack(msg, false, false)` ante cualquier throw y **la orden del POS se dropea**.
 */
const p2002Abiertos = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { modelName: 'Shift', target: ['venueId'] },
  })

/** La forma que yo había ASUMIDO (nombre del índice). Se conserva: Prisma también puede darla. */
const p2002PorNombre = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: 'Shift_venueId_open_key' },
  })

/** Otro único de la MISMA tabla: no significa «ya hay un turno abierto». */
const p2002ExternalId = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: ['venueId', 'externalId'] },
  })

const p2002Ajeno = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: ['anotherUnique'] },
  })

beforeEach(() => {
  m.shift.findFirst.mockReset()
  m.shift.create.mockReset()
  m.shift.upsert.mockReset()
  m.shift.findUnique.mockReset()
  m.shift.updateMany.mockReset()
  m.venue.findUnique.mockReset()
  m.order.aggregate.mockReset()
  m.order.count.mockReset()
  m.payment.findMany.mockReset()
  m.$transaction.mockImplementation(async (callback: (tx: typeof m) => unknown) => callback(m))
  m.$queryRaw.mockResolvedValue([{ pg_advisory_xact_lock: null }])
  m.venue.findUnique.mockResolvedValue({ organizationId: 'org-1' })
  ;(posSyncStaffService.syncPosStaff as jest.Mock).mockResolvedValue('staff-1')
  m.order.aggregate.mockResolvedValue({ _sum: {}, _count: {} })
  m.shift.findUnique.mockResolvedValue(null)
})

describe('getOrCreatePosShift — con el índice de un turno abierto por negocio', () => {
  const payload = { externalId: 'WS-77', startTime: '2026-09-03T15:00:00.000Z' } as never

  it('sin conflicto, se comporta EXACTAMENTE como siempre (crea y devuelve su id)', async () => {
    m.shift.findFirst.mockResolvedValue(null)
    m.shift.create.mockResolvedValue({ id: 'turno-nuevo' })

    expect(await getOrCreatePosShift(payload, VENUE, 'staff-1')).toBe('turno-nuevo')
    expect(m.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(m.shift.findUnique.mock.invocationCallOrder[0])
    expect(m.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(m.shift.findFirst.mock.invocationCallOrder[0])
    expect(m.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(m.shift.create.mock.invocationCallOrder[0])
  })

  it('si el mismo turno está CLOSING devuelve su id provisional y deja que la transacción de la orden falle seguro', async () => {
    m.shift.findFirst.mockResolvedValue(null)
    m.shift.findUnique.mockResolvedValue({ id: 'turno-closing', status: 'CLOSING' })

    expect(await getOrCreatePosShift(payload, VENUE, 'staff-1')).toBe('turno-closing')
    expect(m.shift.create).not.toHaveBeenCalled()
  })

  it('un CLOSING del venue con otro externalId también se devuelve provisional: nunca abre otro encima', async () => {
    m.shift.findFirst.mockResolvedValue({ id: 'turno-closing-del-negocio', status: 'CLOSING' })
    m.shift.findUnique.mockResolvedValue(null)

    expect(await getOrCreatePosShift(payload, VENUE, 'staff-1')).toBe('turno-closing-del-negocio')
    expect(m.shift.create).not.toHaveBeenCalled()
  })

  it('serializa lookup y create: un claim OPEN→CLOSING entre ambos gana y B nunca se abre', async () => {
    let estadoA: 'OPEN' | 'CLOSING' = 'OPEN'
    let lockDelVenue = false
    let turnosBCreados = 0

    m.$transaction.mockImplementation(async (callback: (tx: typeof m) => unknown) => {
      try {
        return await callback(m)
      } catch (error) {
        // El contendiente que esperaba el advisory gana apenas la transacción revierte.
        lockDelVenue = false
        estadoA = 'CLOSING'
        throw error
      } finally {
        lockDelVenue = false
      }
    })
    m.$queryRaw.mockImplementation(async () => {
      lockDelVenue = true
      return [{ pg_advisory_xact_lock: null }]
    })
    m.shift.findUnique.mockResolvedValue(null)
    m.shift.findFirst.mockImplementation(async ({ where }: any) => {
      if (where.externalId) return null
      if (where.status?.in) return estadoA === 'CLOSING' ? { id: 'turno-a', status: 'CLOSING' } : { id: 'turno-a', status: 'OPEN' }
      if (where.status === 'CLOSING') return estadoA === 'CLOSING' ? { id: 'turno-a', status: 'CLOSING' } : null
      if (where.status === 'OPEN') return estadoA === 'OPEN' ? { id: 'turno-a', status: 'OPEN' } : null
      return null
    })
    m.shift.create.mockImplementation(async () => {
      // Sin advisory compartido el claim cabe exactamente aquí: libera el índice parcial y B nace.
      if (!lockDelVenue) estadoA = 'CLOSING'
      if (estadoA === 'OPEN') throw p2002Abiertos()
      turnosBCreados += 1
      return { id: 'turno-b' }
    })

    await expect(getOrCreatePosShift(payload, VENUE, 'staff-1')).resolves.toBe('turno-a')
    expect(turnosBCreados).toBe(0)
  })

  it('🔴 si el negocio ya tiene su turno abierto, la orden se ata a ÉSE en vez de quedarse sin turno', async () => {
    m.shift.findFirst.mockResolvedValue({ id: 'turno-del-negocio', status: 'OPEN' })

    expect(await getOrCreatePosShift(payload, VENUE, 'staff-1')).toBe('turno-del-negocio')

    // La decisión se toma bajo el advisory y busca el activo del NEGOCIO, sin persona/externalId.
    const where = m.shift.findFirst.mock.calls[0][0].where
    expect(where).toMatchObject({ venueId: VENUE, status: { in: ['OPEN', 'CLOSING'] }, endTime: null })
    expect(where).not.toHaveProperty('externalId')
    expect(where).not.toHaveProperty('staffId')
  })

  it('el rescate también corre si Prisma da el nombre del índice en vez de las columnas', async () => {
    m.shift.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'turno-del-negocio', status: 'OPEN' })
    m.shift.create.mockRejectedValue(p2002PorNombre())

    expect(await getOrCreatePosShift(payload, VENUE, 'staff-1')).toBe('turno-del-negocio')
  })

  it.each(['OPEN', 'CLOSING', 'CLOSED'] as const)(
    'si el create pierde el compuesto por un ganador %s, relee ese exacto y devuelve su id provisional',
    async status => {
      m.shift.findFirst.mockResolvedValue(null)
      m.shift.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'turno-exacto-ganador', status })
      m.shift.create.mockRejectedValue(p2002ExternalId())

      await expect(getOrCreatePosShift(payload, VENUE, 'staff-1')).resolves.toBe('turno-exacto-ganador')
    },
  )

  it('si el compuesto choca pero no existe ganador exacto, sube tal cual', async () => {
    m.shift.findFirst.mockResolvedValue(null)
    m.shift.findUnique.mockResolvedValue(null)
    m.shift.create.mockRejectedValue(p2002ExternalId())

    await expect(getOrCreatePosShift(payload, VENUE, 'staff-1')).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
  })

  it('si choca un único ajeno, sube tal cual y no relee un ganador inventado', async () => {
    m.shift.findFirst.mockResolvedValue(null)
    m.shift.create.mockRejectedValue(p2002Ajeno())

    await expect(getOrCreatePosShift(payload, VENUE, 'staff-1')).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
  })

  it('si choca y NO se encuentra el abierto del negocio, se deja subir el error (no se devuelve null en silencio)', async () => {
    m.shift.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null)
    m.shift.create.mockRejectedValue(p2002Abiertos())

    await expect(getOrCreatePosShift(payload, VENUE, 'staff-1')).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
  })
})

describe('processPosShiftEvent — el choque del índice no puede salir como 500 anónimo', () => {
  const payload = {
    venueId: VENUE,
    shiftData: { externalId: 'WS-88', staffId: 'staff-1', posRawData: { apertura: '2026-09-03T15:00:00.000Z' } },
  }

  it('sin conflicto, se comporta como siempre', async () => {
    m.shift.create.mockResolvedValue({ id: 'turno-1', status: 'OPEN' })

    const r = await processPosShiftEvent(payload, 'created')

    expect(r).toMatchObject({ id: 'turno-1' })
  })

  it('A CLOSING + evento created B nunca deja un OPEN B ni vuelve irrecuperable A', async () => {
    m.shift.findUnique.mockResolvedValue(null)
    m.shift.findFirst.mockResolvedValue({ id: 'turno-a', status: 'CLOSING', endTime: null })
    m.shift.create.mockResolvedValue({ id: 'turno-b', status: 'OPEN' })

    await expect(processPosShiftEvent(payload, 'created')).rejects.toMatchObject({
      statusCode: 409,
      code: 'SHIFT_CLOSE_IN_PROGRESS',
    })
    expect(m.shift.create).not.toHaveBeenCalled()
  })

  it('🔴 el choque del índice de abiertos sale como ConflictError con su causa, no como 500', async () => {
    m.shift.create.mockRejectedValue(p2002Abiertos())

    await expect(processPosShiftEvent(payload, 'created')).rejects.toBeInstanceOf(ConflictError)
    await expect(processPosShiftEvent(payload, 'created')).rejects.toThrow(/turno de caja abierto/i)
  })

  it('otro P2002 de la misma tabla sube tal cual', async () => {
    m.shift.create.mockRejectedValue(p2002ExternalId())

    await expect(processPosShiftEvent(payload, 'created')).rejects.not.toBeInstanceOf(ConflictError)
  })

  it('un retry converge después de que el P2002 compuesto reveló un ganador OPEN', async () => {
    const winner = {
      id: 'turno-winner',
      venueId: VENUE,
      externalId: payload.shiftData.externalId,
      status: 'OPEN',
      endTime: null,
      startTime: new Date('2026-09-03T15:00:00.000Z'),
      updatedAt: new Date('2026-09-03T15:00:00.000Z'),
    }
    const saved = { ...winner, updatedAt: new Date('2026-09-03T15:01:00.000Z') }
    m.shift.findFirst.mockResolvedValue(null)
    m.shift.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner)
      .mockResolvedValueOnce(winner)
      .mockResolvedValueOnce(winner)
      .mockResolvedValueOnce(saved)
    m.shift.create.mockRejectedValueOnce(p2002ExternalId())
    m.shift.updateMany.mockResolvedValue({ count: 1 })

    await expect(processPosShiftEvent(payload, 'created')).rejects.toMatchObject({ code: 'SHIFT_CONCURRENT_UPDATE' })
    await expect(processPosShiftEvent(payload, 'created')).resolves.toBe(saved)

    expect(m.shift.create).toHaveBeenCalledTimes(1)
    expect(m.shift.updateMany).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['futuro', '2099-01-01T00:00:00.000Z'],
    ['anterior a apertura', '1970-01-01T00:00:00.000Z'],
    ['inválido', 'no-es-fecha'],
    ['vacío', ''],
    ['nulo', null],
    ['ausente', undefined],
  ])('un CLOSED nuevo con cierre %s usa now capturado, nunca epoch/futuro', async (_case, cierre) => {
    const now = new Date('2026-09-03T21:00:00.000Z')
    jest.useFakeTimers().setSystemTime(now)
    m.shift.create.mockResolvedValue({ id: 'turno-cerrado', status: 'CLOSED', endTime: now })

    try {
      await processPosShiftEvent(
        {
          venueId: VENUE,
          shiftData: {
            externalId: 'WS-CLOSED-NEW',
            staffId: 'staff-1',
            posRawData: { apertura: '2026-09-03T15:00:00.000Z', cierre },
          },
        },
        'closed',
      )
    } finally {
      jest.useRealTimers()
    }

    expect(m.shift.create.mock.calls[0][0].data).toMatchObject({ status: 'CLOSED', endTime: now })
  })
})
