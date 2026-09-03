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

jest.mock('@/services/pos-sync/posSyncStaff.service', () => ({
  posSyncStaffService: { syncPosStaff: jest.fn().mockResolvedValue('staff-1') },
}))

const m = prisma as unknown as {
  shift: { findFirst: jest.Mock; create: jest.Mock; upsert: jest.Mock; findUnique: jest.Mock }
  venue: { findUnique: jest.Mock }
  order: { aggregate: jest.Mock }
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

beforeEach(() => {
  m.venue.findUnique.mockResolvedValue({ organizationId: 'org-1' })
  m.order.aggregate.mockResolvedValue({ _sum: {}, _count: {} })
  m.shift.findUnique.mockResolvedValue(null)
})

describe('getOrCreatePosShift — con el índice de un turno abierto por negocio', () => {
  const payload = { externalId: 'WS-77', startTime: '2026-09-03T15:00:00.000Z' } as never

  it('sin conflicto, se comporta EXACTAMENTE como siempre (crea y devuelve su id)', async () => {
    m.shift.findFirst.mockResolvedValue(null)
    m.shift.create.mockResolvedValue({ id: 'turno-nuevo' })

    expect(await getOrCreatePosShift(payload, VENUE, 'staff-1')).toBe('turno-nuevo')
  })

  it('🔴 si el negocio ya tiene su turno abierto, la orden se ata a ÉSE en vez de quedarse sin turno', async () => {
    m.shift.findFirst
      .mockResolvedValueOnce(null) // no hay uno con ese externalId
      .mockResolvedValueOnce({ id: 'turno-del-negocio' }) // pero sí el abierto del negocio
    m.shift.create.mockRejectedValue(p2002Abiertos())

    expect(await getOrCreatePosShift(payload, VENUE, 'staff-1')).toBe('turno-del-negocio')

    // El rescate busca el abierto del NEGOCIO, sin filtrar por externalId ni por persona.
    const where = m.shift.findFirst.mock.calls[1][0].where
    expect(where).toMatchObject({ venueId: VENUE, status: 'OPEN' })
    expect(where).not.toHaveProperty('externalId')
    expect(where).not.toHaveProperty('staffId')
  })

  it('el rescate también corre si Prisma da el nombre del índice en vez de las columnas', async () => {
    m.shift.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'turno-del-negocio' })
    m.shift.create.mockRejectedValue(p2002PorNombre())

    expect(await getOrCreatePosShift(payload, VENUE, 'staff-1')).toBe('turno-del-negocio')
  })

  it('si el choque es de OTRO único, sube tal cual: no se disfraza ni se inventa un rescate', async () => {
    m.shift.findFirst.mockResolvedValue(null)
    m.shift.create.mockRejectedValue(p2002ExternalId())

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
    m.shift.upsert.mockResolvedValue({ id: 'turno-1', status: 'OPEN' })

    const r = await processPosShiftEvent(payload, 'created')

    expect(r).toMatchObject({ id: 'turno-1' })
  })

  it('🔴 el choque del índice de abiertos sale como ConflictError con su causa, no como 500', async () => {
    m.shift.upsert.mockRejectedValue(p2002Abiertos())

    await expect(processPosShiftEvent(payload, 'created')).rejects.toBeInstanceOf(ConflictError)
    await expect(processPosShiftEvent(payload, 'created')).rejects.toThrow(/turno de caja abierto/i)
  })

  it('otro P2002 de la misma tabla sube tal cual', async () => {
    m.shift.upsert.mockRejectedValue(p2002ExternalId())

    await expect(processPosShiftEvent(payload, 'created')).rejects.not.toBeInstanceOf(ConflictError)
  })
})
