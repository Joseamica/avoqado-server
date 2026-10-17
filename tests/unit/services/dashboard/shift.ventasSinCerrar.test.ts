/**
 * Cierre r1 (capacidad): la lista y el resumen de turnos del panel leen las ventas de los turnos SIN cerrar (el acumulado guardado
 * cuenta las cargas de tarjetas de regalo) con UNA consulta agrupada por turno, nunca una por fila.
 */
import { Prisma } from '@prisma/client'
import { getShifts, getShiftsSummary } from '@/services/dashboard/shift.dashboard.service'
import { prismaMock } from '../../../__helpers__/setup'

const D = (v: number) => new Prisma.Decimal(v)
const turno = (id: string, status: string, totalSales: number) => ({
  id,
  venueId: 'v1',
  staffId: 's1',
  status,
  startTime: new Date('2026-10-17T15:00:00.000Z'),
  endTime: status === 'CLOSED' ? new Date('2026-10-17T23:00:00.000Z') : null,
  startingCash: D(0),
  totalSales: D(totalSales),
  totalTips: D(0),
  totalOrders: 0,
  staff: { id: 's1', firstName: 'Ana', lastName: 'Caja', email: 'a@x.test' },
  venue: { id: 'v1', name: 'Negocio' },
})

beforeEach(() => {
  prismaMock.shift.findMany.mockResolvedValue([
    turno('t-abierto-1', 'OPEN', 1200),
    turno('t-abierto-2', 'CLOSING', 900),
    turno('t-cerrado', 'CLOSED', 500),
  ])
  prismaMock.shift.count.mockResolvedValue(3)
  prismaMock.$transaction.mockImplementation(async (ops: any) => (Array.isArray(ops) ? Promise.all(ops) : ops(prismaMock)))
  prismaMock.review.count.mockResolvedValue(0)
  prismaMock.payment.groupBy.mockResolvedValue([
    { shiftId: 't-abierto-1', _sum: { amount: D(200) } },
    { shiftId: 't-abierto-2', _sum: { amount: D(100) } },
  ] as never)
})

it('🔴 resumen: UNA consulta agrupada para los turnos sin cerrar; el cerrado conserva su total firmado', async () => {
  const r = await getShiftsSummary('v1', {})
  expect(prismaMock.payment.groupBy).toHaveBeenCalledTimes(1)
  expect((prismaMock.payment.groupBy as jest.Mock).mock.calls[0][0]).toMatchObject({
    by: ['shiftId'],
    where: { venueId: 'v1', shiftId: { in: ['t-abierto-1', 't-abierto-2'] }, status: 'COMPLETED' },
  })
  expect(prismaMock.payment.aggregate).not.toHaveBeenCalled()
  expect(r.summary.totalSales).toBe(800) // 200 + 100 sin tarjetas + 500 firmado
})

it('lista: la misma consulta agrupada; un turno sin cobros vale 0, no su acumulado', async () => {
  prismaMock.payment.groupBy.mockResolvedValue([{ shiftId: 't-abierto-1', _sum: { amount: D(200) } }] as never)
  const r = await getShifts('v1', 1, 10, {})
  expect(prismaMock.payment.groupBy).toHaveBeenCalledTimes(1)
  expect(r.data.map((t: { id: string; totalSales: number }) => [t.id, t.totalSales])).toEqual([
    ['t-abierto-1', 200],
    ['t-abierto-2', 0],
    ['t-cerrado', 500],
  ])
})

it('sin turnos abiertos no se consulta nada', async () => {
  prismaMock.shift.findMany.mockResolvedValue([turno('t-cerrado', 'CLOSED', 500)])
  await getShiftsSummary('v1', {})
  expect(prismaMock.payment.groupBy).not.toHaveBeenCalled()
})
