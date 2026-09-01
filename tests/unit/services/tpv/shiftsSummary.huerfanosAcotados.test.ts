/**
 * El resumen de turnos de la TPV acota los pagos huérfanos cuando no hay fechas.
 *
 * Hallazgo del barrido post-incidente (2026-09-01): `getShiftsSummary` sin
 * startTime/endTime consultaba los pagos con `shiftId: null` SIN ninguna ventana.
 * Testarudo tiene 32,646 pagos huérfanos (importados de otro POS, sin turno):
 * una sola llamada sin fechas materializaba todos en el hilo único — la misma
 * clase de bomba que tumbó producción esa mañana con el detalle del venue.
 *
 * La regla que fijan estas pruebas: sin fechas, la rama de huérfanos se acota a
 * las últimas 24 horas (la pantalla de turnos de la PAX habla del día en curso).
 * Con fechas del cliente, se respetan tal cual — el comportamiento con fechas
 * no cambia ni un byte.
 */
import prisma from '@/utils/prismaClient'
import { getShiftsSummary } from '@/services/tpv/shift.tpv.service'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    shift: { findMany: jest.fn() },
    payment: { findMany: jest.fn() },
    order: { count: jest.fn() },
  },
}))

const m = prisma as unknown as {
  shift: { findMany: jest.Mock }
  payment: { findMany: jest.Mock }
  order: { count: jest.Mock }
}

beforeEach(() => {
  jest.clearAllMocks()
  m.shift.findMany.mockResolvedValue([])
  m.payment.findMany.mockResolvedValue([])
  m.order.count.mockResolvedValue(0)
})

const ventanaDeHuerfanos = () => {
  expect(m.payment.findMany).toHaveBeenCalledTimes(1)
  return m.payment.findMany.mock.calls[0][0].where
}

describe('getShiftsSummary — pagos huérfanos acotados', () => {
  it('sin fechas, los huérfanos se acotan a las últimas 24 horas', async () => {
    const antes = Date.now()
    await getShiftsSummary('venue-1', {})
    const despues = Date.now()

    const where = ventanaDeHuerfanos()
    expect(where.shiftId).toBeNull()
    expect(where.createdAt?.gte).toBeInstanceOf(Date)
    const gte = (where.createdAt.gte as Date).getTime()
    // gte ≈ ahora − 24 h (tolerancia por el reloj del test)
    expect(gte).toBeGreaterThanOrEqual(antes - 24 * 60 * 60 * 1000 - 5000)
    expect(gte).toBeLessThanOrEqual(despues - 24 * 60 * 60 * 1000 + 5000)
  })

  it('con fechas del cliente, la ventana del cliente manda (sin cambios)', async () => {
    await getShiftsSummary('venue-1', { startTime: '2026-08-30T00:00:00.000Z', endTime: '2026-08-30T23:59:59.000Z' })

    const where = ventanaDeHuerfanos()
    expect(where.createdAt.gte).toEqual(new Date('2026-08-30T00:00:00.000Z'))
    expect(where.createdAt.lte).toEqual(new Date('2026-08-30T23:59:59.000Z'))
  })

  it('con sólo startTime, se respeta el startTime del cliente sin inventar lte', async () => {
    await getShiftsSummary('venue-1', { startTime: '2026-08-30T00:00:00.000Z' })

    const where = ventanaDeHuerfanos()
    expect(where.createdAt.gte).toEqual(new Date('2026-08-30T00:00:00.000Z'))
    expect(where.createdAt.lte).toBeUndefined()
  })

  it('la rama de turnos abiertos no cambia: sin fechas sigue pidiendo endTime null', async () => {
    await getShiftsSummary('venue-1', {})

    const whereShifts = m.shift.findMany.mock.calls[0][0].where
    expect(whereShifts.OR).toEqual(expect.arrayContaining([{ endTime: null }]))
  })
})
