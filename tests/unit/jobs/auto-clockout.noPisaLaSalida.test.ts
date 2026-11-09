// El cierre automático no pisa una salida real que llegó entre su lectura y su escritura.
import { prismaMock } from '@tests/__helpers__/setup'
import { TimeEntryStatus } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import { AutoClockOutJob } from '@/jobs/auto-clockout.job'

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

    await run()

    expect(prismaMock.timeEntry.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'entry-1', clockOutTime: null } }))
    expect(prismaMock.timeEntry.update).not.toHaveBeenCalled()
    expect(prismaMock.timeEntryBreak.update).not.toHaveBeenCalled()
  })

  it('sin carrera: escribe los mismos datos de siempre y cierra el descanso con el mismo instante', async () => {
    prismaMock.timeEntry.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.timeEntryBreak.update.mockResolvedValue({} as any)

    await run()

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
    expect(prismaMock.timeEntryBreak.update).toHaveBeenCalledTimes(1)
    const breakArg = prismaMock.timeEntryBreak.update.mock.calls[0][0] as any
    expect(breakArg.where).toEqual({ id: 'b-open' })
    expect(breakArg.data.endTime).toBe(now)
  })
})
