import { prismaMock } from '@tests/__helpers__/setup'
import { lockClassSession, sumOccupiedSeats, sumPassSeats } from '@/services/reservation/classBooking.service'
import { NotFoundError } from '@/errors/AppError'

const tx = prismaMock as any

describe('classBooking.service', () => {
  beforeEach(() => {
    tx.$queryRaw.mockReset()
  })

  // nuevo
  it('lockClassSession devuelve la fila bloqueada', async () => {
    const row = {
      id: 's1',
      productId: 'p1',
      startsAt: new Date(),
      endsAt: new Date(),
      duration: 50,
      capacity: 12,
      status: 'SCHEDULED',
      assignedStaffId: null,
    }
    tx.$queryRaw.mockResolvedValueOnce([row])
    await expect(lockClassSession(tx, 'v1', 's1')).resolves.toEqual(row)
    const sql = tx.$queryRaw.mock.calls[0][0].join('?')
    expect(sql).toContain('FOR UPDATE')
    expect(sql).toContain('"venueId"')
  })

  // nuevo
  it('lockClassSession lanza 404 si la sesión no es de ese venue', async () => {
    tx.$queryRaw.mockResolvedValueOnce([])
    await expect(lockClassSession(tx, 'v1', 's-otro')).rejects.toBeInstanceOf(NotFoundError)
  })

  // nuevo
  it('lockClassSession usa por default el mensaje del widget y respeta el del llamador', async () => {
    tx.$queryRaw.mockResolvedValueOnce([])
    await expect(lockClassSession(tx, 'v1', 's-otro')).rejects.toThrow('Sesion de clase no encontrada')
    tx.$queryRaw.mockResolvedValueOnce([])
    await expect(lockClassSession(tx, 'v1', 's-otro', 'Sesión no encontrada')).rejects.toThrow('Sesión no encontrada')
  })

  // nuevo
  it('sumOccupiedSeats convierte el bigint y cuenta sólo estados activos', async () => {
    tx.$queryRaw.mockResolvedValueOnce([{ total: BigInt(7) }])
    await expect(sumOccupiedSeats(tx, 's1')).resolves.toBe(7)
    expect(tx.$queryRaw.mock.calls[0][0].join('?')).toContain(`IN ('PENDING', 'CONFIRMED', 'CHECKED_IN')`)
  })

  // nuevo
  it('sumPassSeats sólo cuenta reservas ligadas a un AggregatorBooking', async () => {
    tx.$queryRaw.mockResolvedValueOnce([{ total: BigInt(2) }])
    await expect(sumPassSeats(tx, 's1')).resolves.toBe(2)
    const sql = tx.$queryRaw.mock.calls[0][0].join('?')
    expect(sql).toContain('"AggregatorBooking"')
    expect(sql).toContain(`IN ('PENDING', 'CONFIRMED', 'CHECKED_IN')`)
  })
})
