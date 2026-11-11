/**
 * Servicio de asistencia de la TPV — toda búsqueda de checada lleva el venue.
 * Auditoría Codex de la fase 2 del checador (2026-08-26), P1-1 y P1-2.
 *
 * `startBreak`/`endBreak` buscaban por `id + staffId`; como la TPV no manda staffId, en la
 * práctica buscaban sólo por id. `getStaffTimeSummary` ni siquiera recibía venue y sumaba
 * las horas de la persona en TODOS sus negocios. Aquí se fija que el `where` lleve `venueId`.
 */

jest.mock('@/utils/prismaClient', () => {
  const db: any = {
    timeEntry: { findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn(), findUniqueOrThrow: jest.fn() },
    timeEntryBreak: { create: jest.fn(), update: jest.fn() },
  }
  db.$transaction = jest.fn(async (ops: unknown) => (typeof ops === 'function' ? ops(db) : Promise.all(ops as Promise<unknown>[])))
  return { __esModule: true, default: db }
})

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import prisma from '@/utils/prismaClient'
import { endBreak, getStaffTimeSummary, startBreak } from '@/services/tpv/time-entry.tpv.service'

const db = prisma as any

beforeEach(() => jest.clearAllMocks())

describe('startBreak / endBreak', () => {
  it('startBreak busca la checada acotada por venueId', async () => {
    db.timeEntry.findFirst.mockResolvedValue({ id: 'te-1', breaks: [] })
    db.timeEntryBreak.create.mockResolvedValue({ id: 'br-1' })
    db.timeEntry.update.mockResolvedValue({ id: 'te-1', status: 'ON_BREAK' })

    await startBreak({ timeEntryId: 'te-1', venueId: 'venue-A' })

    expect(db.timeEntry.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'te-1', venueId: 'venue-A' }) }),
    )
  })

  it('una checada de OTRO venue no se encuentra → error, y no se toca nada', async () => {
    db.timeEntry.findFirst.mockResolvedValue(null)

    await expect(startBreak({ timeEntryId: 'te-de-B', venueId: 'venue-A' })).rejects.toThrow(/no encontrado/i)
    expect(db.timeEntryBreak.create).not.toHaveBeenCalled()
    expect(db.timeEntry.update).not.toHaveBeenCalled()
  })

  it('endBreak también acota por venueId', async () => {
    db.timeEntry.findFirst.mockResolvedValue({ id: 'te-1', breaks: [{ id: 'br-1', endTime: null }] })
    db.timeEntry.updateMany.mockResolvedValue({ count: 1 })
    db.timeEntryBreak.update.mockResolvedValue({ id: 'br-1' })
    db.timeEntry.findUniqueOrThrow.mockResolvedValue({ id: 'te-1', status: 'CLOCKED_IN' })

    expect(await endBreak({ timeEntryId: 'te-1', venueId: 'venue-A' })).toEqual({ id: 'te-1', status: 'CLOCKED_IN' })

    expect(db.timeEntry.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'te-1', venueId: 'venue-A' }) }),
    )
  })

  it('endBreak toma primero la checada (si sigue en descanso y sin salida) y después el descanso (D2, 10-nov)', async () => {
    db.timeEntry.findFirst.mockResolvedValue({ id: 'te-1', breaks: [{ id: 'br-1', endTime: null }] })
    const orden: string[] = []
    db.timeEntry.updateMany.mockImplementation(async () => (orden.push('checada'), { count: 1 }))
    db.timeEntryBreak.update.mockImplementation(async () => (orden.push('descanso'), { id: 'br-1' }))
    db.timeEntry.findUniqueOrThrow.mockResolvedValue({ id: 'te-1', status: 'CLOCKED_IN' })

    await endBreak({ timeEntryId: 'te-1', venueId: 'venue-A' })

    expect(orden).toEqual(['checada', 'descanso'])
    expect(db.timeEntry.updateMany.mock.calls[0][0]).toEqual({
      where: { id: 'te-1', status: 'ON_BREAK', clockOutTime: null },
      data: { status: 'CLOCKED_IN' },
    })
  })

  it('endBreak: el descanso termina a la hora del toque, no después de esperar el candado de la checada', async () => {
    const toque = new Date('2026-11-10T18:00:00Z')
    jest.useFakeTimers({ now: toque })
    try {
      db.timeEntry.findFirst.mockResolvedValue({ id: 'te-1', breaks: [{ id: 'br-1', endTime: null }] })
      db.timeEntry.updateMany.mockImplementation(async () => (jest.setSystemTime(toque.getTime() + 2000), { count: 1 }))
      db.timeEntryBreak.update.mockResolvedValue({ id: 'br-1' })
      db.timeEntry.findUniqueOrThrow.mockResolvedValue({ id: 'te-1', status: 'CLOCKED_IN' })

      await endBreak({ timeEntryId: 'te-1', venueId: 'venue-A' })

      expect(db.timeEntryBreak.update.mock.calls[0][0].data.endTime).toEqual(toque)
    } finally {
      jest.useRealTimers()
    }
  })

  it('endBreak: si otra salida la cerró entre la lectura y la escritura → 400 y no toca el descanso', async () => {
    db.timeEntry.findFirst.mockResolvedValue({ id: 'te-1', breaks: [{ id: 'br-1', endTime: null }] })
    db.timeEntry.updateMany.mockResolvedValue({ count: 0 })

    await expect(endBreak({ timeEntryId: 'te-1', venueId: 'venue-A' })).rejects.toThrow(/no en descanso/i)
    expect(db.timeEntryBreak.update).not.toHaveBeenCalled()
  })

  it('regresión: si el cliente SÍ manda staffId, se sigue respetando', async () => {
    db.timeEntry.findFirst.mockResolvedValue({ id: 'te-1', breaks: [] })
    db.timeEntryBreak.create.mockResolvedValue({ id: 'br-1' })
    db.timeEntry.update.mockResolvedValue({ id: 'te-1', status: 'ON_BREAK' })

    await startBreak({ timeEntryId: 'te-1', venueId: 'venue-A', staffId: 'staff-1' })

    expect(db.timeEntry.findFirst.mock.calls[0][0].where).toEqual(expect.objectContaining({ staffId: 'staff-1', venueId: 'venue-A' }))
  })
})

describe('getStaffTimeSummary', () => {
  it('suma sólo las checadas de ESE venue', async () => {
    db.timeEntry.findMany.mockResolvedValue([])

    await getStaffTimeSummary({ staffId: 'staff-1', venueId: 'venue-A', startDate: '2026-08-01', endDate: '2026-08-26' })

    expect(db.timeEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ staffId: 'staff-1', venueId: 'venue-A' }) }),
    )
  })
})
