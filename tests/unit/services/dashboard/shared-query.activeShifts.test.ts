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
 * El conteo se hace ahora por `Order.shiftId`, que es lo que la Task 7 escribe en
 * cada orden/cobro. Contrato de `ActiveShiftInfo` sin cambios.
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
    prismaMock.order.findMany.mockResolvedValue([
      { shiftId: 'shift-1', createdById: 'viridiana', createdAt: new Date('2026-09-01T15:00:00Z') },
      { shiftId: 'shift-1', createdById: 'hector', createdAt: new Date('2026-09-01T18:00:00Z') },
    ] as never)

    const r = await SharedQueryService.getActiveShifts('v1')

    expect(r[0].ordersCount).toBe(2)
    const where = prismaMock.order.findMany.mock.calls[0][0].where
    expect(where).toEqual(expect.objectContaining({ venueId: 'v1', shiftId: { in: ['shift-1'] } }))
    expect(where).not.toHaveProperty('createdById')
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
    prismaMock.order.findMany.mockResolvedValue([
      { shiftId: 'shift-1', createdById: 'viridiana', createdAt: new Date('2026-09-01T15:00:00Z') },
      { shiftId: 'shift-2', createdById: 'daniel', createdAt: new Date('2026-09-01T17:00:00Z') },
      { shiftId: 'shift-2', createdById: 'hector', createdAt: new Date('2026-09-01T18:00:00Z') },
    ] as never)

    const r = await SharedQueryService.getActiveShifts('v1')

    const porTurno = new Map(r.map(s => [s.shiftId, s.ordersCount]))
    expect(porTurno.get('shift-1')).toBe(1)
    expect(porTurno.get('shift-2')).toBe(2)
    const where = prismaMock.order.findMany.mock.calls[0][0].where
    expect(where).toEqual(expect.objectContaining({ shiftId: { in: ['shift-1', 'shift-2'] } }))
  })

  // Regresión: sin turnos abiertos no se consulta ni una orden (comportamiento previo).
  it('sin turnos abiertos devuelve [] sin consultar órdenes', async () => {
    prismaMock.shift.findMany.mockResolvedValue([] as never)

    const r = await SharedQueryService.getActiveShifts('v1')

    expect(r).toEqual([])
    expect(prismaMock.order.findMany).not.toHaveBeenCalled()
  })
})
