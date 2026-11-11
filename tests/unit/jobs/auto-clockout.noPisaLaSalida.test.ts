// El cierre automático no pisa una salida real que llegó entre su lectura y su escritura, y sólo cuenta lo que él cerró.
import { prismaMock } from '@tests/__helpers__/setup'
import { TimeEntryStatus } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import { AutoClockOutJob } from '@/jobs/auto-clockout.job'
import logger from '@/config/logger'

describe('AutoClockOutJob.clockOutEntry: no pisa la salida', () => {
  const job = new AutoClockOutJob()
  const clockInTime = new Date('2024-01-15T18:00:00Z')
  const entry = {
    id: 'entry-1',
    clockInTime,
    breaks: [
      { id: 'b-done', startTime: new Date('2024-01-15T19:00:00Z'), endTime: new Date('2024-01-15T19:30:00Z') },
      { id: 'b-open', startTime: new Date('2024-01-15T22:00:00Z'), endTime: null },
    ],
  }
  const run = () => (job as any).clockOutEntry(entry, 'prueba')

  beforeEach(() => jest.clearAllMocks())

  it('carrera: otra salida ya cerró la entrada (0 filas) -> no toca la entrada ni sus descansos', async () => {
    prismaMock.timeEntry.updateMany.mockResolvedValue({ count: 0 })

    expect(await run()).toBe(false)

    expect(prismaMock.timeEntry.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'entry-1', clockOutTime: null } }))
    expect(prismaMock.timeEntry.update).not.toHaveBeenCalled()
    expect(prismaMock.timeEntryBreak.updateMany).not.toHaveBeenCalled()
  })

  it('sin carrera: escribe los mismos datos de siempre y cierra el descanso con el mismo instante', async () => {
    prismaMock.timeEntry.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.timeEntryBreak.updateMany.mockResolvedValue({ count: 1 })

    expect(await run()).toBe(true)

    const arg = prismaMock.timeEntry.updateMany.mock.calls[0][0] as any
    const now: Date = arg.data.clockOutTime
    expect(now).toBeInstanceOf(Date)
    // 18:00 -> now, menos 30 min de descanso completado
    const expectedHours = new Decimal(Math.max(0, (now.getTime() - clockInTime.getTime()) / 60000 - 30) / 60).toDecimalPlaces(2)
    expect(arg.data).toEqual({
      clockOutTime: now,
      status: TimeEntryStatus.CLOCKED_OUT,
      totalHours: expectedHours,
      breakMinutes: 30,
      autoClockOut: true,
      autoClockOutNote: '[Sistema] Salida automática: prueba',
    })
    expect(prismaMock.timeEntryBreak.updateMany).toHaveBeenCalledTimes(1)
    const breakArg = prismaMock.timeEntryBreak.updateMany.mock.calls[0][0] as any
    // Sólo si sigue abierto: si la persona lo terminó entre la lectura y aquí, conserva su hora real (D2, 10-nov).
    expect(breakArg.where).toEqual({ id: 'b-open', endTime: null })
    expect(breakArg.data.endTime).toBe(now)
  })

  it.each([
    ['fixed time', 'processFixedTimeClockOuts', { autoClockOutEnabled: true, autoClockOutTime: '03:00' }],
    ['max duration', 'processMaxDurationClockOuts', { maxShiftDurationEnabled: true, maxShiftDurationHours: 12 }],
  ])('%s: una entrada que otra salida ya cerró no se cuenta ni se reporta como cerrada', async (_n, metodo, ajustes) => {
    prismaMock.venueSettings.findMany.mockResolvedValue([
      { id: 's1', venueId: 'venue-1', ...ajustes, venue: { id: 'venue-1', name: 'Tienda', timezone: 'America/Mexico_City' } },
    ])
    prismaMock.timeEntry.findMany.mockResolvedValue([
      { ...entry, id: 'ya-cerrada', staff: { firstName: 'Ana', lastName: 'Ruiz' } },
      { ...entry, id: 'abierta', staff: { firstName: 'Luis', lastName: 'Paz' } },
    ])
    prismaMock.timeEntry.updateMany.mockImplementation(async ({ where }: any) => ({ count: where.id === 'abierta' ? 1 : 0 }))
    prismaMock.timeEntryBreak.updateMany.mockResolvedValue({ count: 1 })
    ;(job as any).isWithinClockOutWindow = jest.fn().mockReturnValue(true)

    const r = await (job as any)[metodo]()

    expect(r).toEqual({ count: 1, errors: 0 })
    const cerradas = (logger.info as jest.Mock).mock.calls.filter(([m]) => /^Auto clock-out \((fixed time|max duration)\)/.test(m))
    expect(cerradas.map(([, d]) => d.entryId)).toEqual(['abierta'])
  })
})
