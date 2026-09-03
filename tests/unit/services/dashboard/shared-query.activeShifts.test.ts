// El helper va PRIMERO: registra el mock de '@/utils/prismaClient' antes de que
// se importe el servicio (mismo patrón que tests/unit/services/dashboard/lineRevenue.test.ts).
import { prismaMock } from '@tests/__helpers__/setup'
import { SharedQueryService } from '@/services/dashboard/shared-query.service'

/**
 * Fase 1 del «turno de caja del negocio»: el turno YA no es de la persona que lo
 * abrió. El selector «Vendedor» de Cobrar cambia el `createdById` de cada orden,
 * así que contar por `createdById = shift.staffId` borraba del conteo todo lo que
 * cobró cualquier otro cajero del mismo turno (Testarudo, 1-sep: 78 de 92 órdenes).
 *
 * El conteo lo hace ahora Postgres agrupando por `Order.shiftId` —lo que la Task 7
 * escribe en cada orden/cobro—: una fila por turno, no una por orden. Contrato de
 * `ActiveShiftInfo` sin cambios.
 */
describe('getActiveShifts — el turno es del negocio', () => {
  it('cuenta las órdenes del TURNO (shiftId), aunque las haya creado otra persona', async () => {
    prismaMock.shift.findMany.mockResolvedValue([
      {
        id: 'shift-1',
        staffId: 'daniel',
        startTime: new Date('2026-09-01T14:12:00Z'),
        totalCashPayments: null,
        totalCardPayments: null,
        totalTips: null,
        staff: { firstName: 'Daniel', lastName: 'A', venues: [{ role: 'OWNER' }] },
      },
    ] as never)
    // Las dos órdenes son de OTRAS personas (viridiana, hector): Postgres las cuenta
    // por `shiftId` y devuelve UNA fila por turno.
    prismaMock.order.groupBy.mockResolvedValue([{ shiftId: 'shift-1', _count: 2 }] as never)
    // Trampa deliberada: si alguien vuelve a traer UNA FILA POR ORDEN a Node, la prueba lo
    // dice con un mensaje legible (0 ≠ 2, más el `not.toHaveBeenCalled` de abajo) en vez de
    // reventar con un TypeError por un mock sin cebar.
    prismaMock.order.findMany.mockResolvedValue([] as never)

    const r = await SharedQueryService.getActiveShifts('v1')

    expect(r[0].ordersCount).toBe(2)
    const arg = prismaMock.order.groupBy.mock.calls[0][0]
    expect(arg.by).toEqual(['shiftId'])
    // EXACTO, no objectContaining: un `createdAt: { gte }` colado aquí volvería a dejar
    // fuera la cuenta abierta ANTES del startTime y pagada dentro del turno; y un
    // `createdById` volvería a contar por persona. Cualquiera de los dos rompe este toEqual.
    expect(arg.where).toEqual({ venueId: 'v1', shiftId: { in: ['shift-1'] } })
    expect(arg._count).toEqual(true)
    // El conteo lo hace Postgres: no se trae una fila por orden.
    expect(prismaMock.order.findMany).not.toHaveBeenCalled()
  })

  it('no mezcla las órdenes de un turno con las del otro', async () => {
    prismaMock.shift.findMany.mockResolvedValue([
      {
        id: 'shift-1',
        staffId: 'daniel',
        startTime: new Date('2026-09-01T14:12:00Z'),
        totalCashPayments: null,
        totalCardPayments: null,
        totalTips: null,
        staff: { firstName: 'Daniel', lastName: 'A', venues: [{ role: 'OWNER' }] },
      },
      {
        id: 'shift-2',
        staffId: 'viridiana',
        startTime: new Date('2026-09-01T16:00:00Z'),
        totalCashPayments: null,
        totalCardPayments: null,
        totalTips: null,
        staff: { firstName: 'Viridiana', lastName: 'B', venues: [{ role: 'CASHIER' }] },
      },
    ] as never)
    prismaMock.order.groupBy.mockResolvedValue([
      { shiftId: 'shift-1', _count: 1 },
      { shiftId: 'shift-2', _count: 2 },
    ] as never)

    const r = await SharedQueryService.getActiveShifts('v1')

    const porTurno = new Map(r.map(s => [s.shiftId, s.ordersCount]))
    expect(porTurno.get('shift-1')).toBe(1)
    expect(porTurno.get('shift-2')).toBe(2)
    const arg = prismaMock.order.groupBy.mock.calls[0][0]
    expect(arg.by).toEqual(['shiftId'])
    expect(arg.where).toEqual({ venueId: 'v1', shiftId: { in: ['shift-1', 'shift-2'] } })
  })

  // Regresión: sin turnos abiertos no se consulta ni una orden (comportamiento previo).
  it('sin turnos abiertos devuelve [] sin consultar órdenes', async () => {
    prismaMock.shift.findMany.mockResolvedValue([] as never)

    const r = await SharedQueryService.getActiveShifts('v1')

    expect(r).toEqual([])
    expect(prismaMock.order.groupBy).not.toHaveBeenCalled()
    expect(prismaMock.order.findMany).not.toHaveBeenCalled()
  })
})
