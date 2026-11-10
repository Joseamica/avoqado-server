// «Terminar descanso» del POS: primero la checada (si sigue en descanso y sin salida), después el descanso (hz:4c64c58b:D2, 10-nov).
// Al revés se trababa con la salida automática. El cruce real contra Postgres: tests/integration/jobs/salidaAutomaticaYDescanso.
import { prismaMock } from '@tests/__helpers__/setup'
import { endBreak } from '@/services/mobile/time-entry.mobile.service'

describe('endBreak del POS', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.staffVenue.findFirst.mockResolvedValue({ staffId: 'staff-1' } as any)
    prismaMock.timeEntry.findFirst.mockResolvedValue({ id: 'te-1', status: 'ON_BREAK' } as any)
  })

  it('cambia la checada primero, sólo si sigue en descanso y sin salida, y luego cierra el descanso', async () => {
    const orden: string[] = []
    prismaMock.timeEntry.updateMany.mockImplementation((async () => (orden.push('checada'), { count: 1 })) as any)
    prismaMock.timeEntryBreak.updateMany.mockImplementation((async () => (orden.push('descanso'), { count: 1 })) as any)

    expect(await endBreak('venue-1', '1234')).toMatchObject({ id: 'te-1', status: 'CLOCKED_IN' })

    expect(orden).toEqual(['checada', 'descanso'])
    expect(prismaMock.timeEntry.updateMany.mock.calls[0][0]).toEqual({
      where: { id: 'te-1', status: 'ON_BREAK', clockOutTime: null },
      data: { status: 'CLOCKED_IN' },
    })
  })

  it('el descanso termina a la hora del toque, no después de esperar el candado de la checada', async () => {
    const toque = new Date('2026-11-10T18:00:00Z')
    jest.useFakeTimers({ now: toque })
    try {
      prismaMock.timeEntry.updateMany.mockImplementation((async () => (jest.setSystemTime(toque.getTime() + 2000), { count: 1 })) as any)
      prismaMock.timeEntryBreak.updateMany.mockResolvedValue({ count: 1 })

      await endBreak('venue-1', '1234')

      expect((prismaMock.timeEntryBreak.updateMany.mock.calls[0][0] as any).data.endTime).toEqual(toque)
    } finally {
      jest.useRealTimers()
    }
  })

  it('si otra salida la cerró entre la lectura y la escritura → 400 y no toca el descanso', async () => {
    prismaMock.timeEntry.updateMany.mockResolvedValue({ count: 0 })

    await expect(endBreak('venue-1', '1234')).rejects.toThrow(/no estás en descanso/i)
    expect(prismaMock.timeEntryBreak.updateMany).not.toHaveBeenCalled()
  })
})
