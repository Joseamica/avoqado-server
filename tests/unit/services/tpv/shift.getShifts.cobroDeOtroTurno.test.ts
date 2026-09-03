/**
 * 🔴 DINERO. El mismo cobro NO puede contar en DOS turnos.
 *
 * El defecto lo introdujo la task 2b (3-sep-2026) al estampar `Order.shiftId` al ABRIR la orden.
 * `getShifts` une dos caminos al mismo dinero —los cobros alcanzables por `Order.shiftId` y los
 * alcanzables por `Payment.shiftId`— y deduplica con un `Map` que sólo ve las filas de UN turno:
 * deduplica DENTRO de un turno, nunca ENTRE turnos.
 *
 * El escenario real, que antes de la task 2b no podía ocurrir porque la orden nacía sin turno:
 *
 *     13:00  se abre la mesa            → la orden se estampa con el turno A
 *     15:00  cierra el turno A
 *     15:30  pagan la mesa              → el `Payment` se resuelve al turno B
 *
 * A alcanzaba ese cobro por su orden y B por `Payment.shiftId`: la pantalla de Turnos sumaba más
 * de lo que el negocio cobró. El dinero pertenece a donde ENTRÓ, que es B.
 *
 * 🔴 Y la otra mitad, que es la que hace que el arreglo no pueda ser «borrar la rama por orden»:
 * las órdenes históricas de pos-sync tienen turno y su `Payment.shiftId` es NULO. Si se quitara
 * ese camino, su dinero desaparecería de la pantalla. Por eso el filtro deja pasar el cobro sin
 * turno — es de esta orden y no lo reclama ningún otro.
 */

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    shift: { findMany: jest.fn(), count: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    payment: { findMany: jest.fn() },
    order: { count: jest.fn() },
    orderItem: { findMany: jest.fn() },
    rawMaterialMovement: { findMany: jest.fn() },
    venue: { findUnique: jest.fn() },
    staff: { findFirst: jest.fn() },
    activityLog: { create: jest.fn() },
    $transaction: jest.fn(),
  },
}))

jest.mock('@/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/communication/rabbitmq/publisher', () => ({ publishCommand: jest.fn() }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn().mockReturnValue(null) } }))
jest.mock('@/services/access/cashReconciliationAccess.service', () => ({ isCashReconciliationEnabled: jest.fn() }))
jest.mock('@/services/dashboard/shift.dashboard.service', () => ({ resolveShiftCashDrawer: jest.fn().mockResolvedValue(null) }))

import prisma from '@/utils/prismaClient'
import { getShifts } from '@/services/tpv/shift.tpv.service'

const mockPrisma = prisma as unknown as { $transaction: jest.Mock }

describe('getShifts — un cobro de OTRO turno no suma en éste', () => {
  beforeEach(() => jest.clearAllMocks())

  it('🔴 la mesa abierta en A y pagada en B NO deja su dinero en A', async () => {
    // La orden se estampó con A (se abrió en A), pero su cobro se resolvió a B (se pagó en B).
    const cobroDeB = { id: 'pago-1', shiftId: 'turno-B', amount: 100, tipAmount: 15, processedById: 'staff-1', allocations: [] }
    mockPrisma.$transaction.mockResolvedValue([
      [{ id: 'turno-A', venueId: 'venue-1', staff: null, orders: [{ id: 'orden-1', payments: [cobroDeB] }], payments: [] }],
      1,
    ])

    const { data } = await getShifts('venue-1', 20, 1)

    // 0, no 100: A no cobró nada. Sin el filtro, ese dinero salía en A **y** en B.
    expect(data[0].paymentSum).toBe(0)
    expect(data[0].tipsSum).toBe(0)
    expect(data[0].tipsCount).toBe(0)
  })

  it('el mismo cobro SÍ suma en el turno donde entró el dinero', async () => {
    // La otra cara: el filtro no puede dejar a B sin su propio cobro.
    const cobroDeB = { id: 'pago-1', shiftId: 'turno-B', amount: 100, tipAmount: 15, processedById: 'staff-1', allocations: [] }
    mockPrisma.$transaction.mockResolvedValue([[{ id: 'turno-B', venueId: 'venue-1', staff: null, orders: [], payments: [cobroDeB] }], 1])

    const { data } = await getShifts('venue-1', 20, 1)

    expect(data[0].paymentSum).toBe(100)
    expect(data[0].tipsSum).toBe(15)
  })

  it('🔴 el cobro SIN turno de una orden CON turno sigue contando (pos-sync histórico)', async () => {
    // Es lo que impide «arreglar» esto borrando la rama por orden: a estas órdenes se les
    // borraría el dinero de la pantalla.
    const cobroSinTurno = { id: 'pago-1', shiftId: null, amount: 80, tipAmount: 0, processedById: 'staff-1', allocations: [] }
    mockPrisma.$transaction.mockResolvedValue([
      [{ id: 'turno-A', venueId: 'venue-1', staff: null, orders: [{ id: 'orden-pos', payments: [cobroSinTurno] }], payments: [] }],
      1,
    ])

    const { data } = await getShifts('venue-1', 20, 1)

    expect(data[0].paymentSum).toBe(80)
  })

  it('el cobro de ESTE turno alcanzable por los dos caminos sigue contando UNA vez', async () => {
    // Regresión de la deduplicación que ya existía: el filtro no la sustituye.
    const cobro = { id: 'pago-1', shiftId: 'turno-A', amount: 100, tipAmount: 15, processedById: 'staff-1', allocations: [] }
    mockPrisma.$transaction.mockResolvedValue([
      [{ id: 'turno-A', venueId: 'venue-1', staff: null, orders: [{ id: 'orden-1', payments: [cobro] }], payments: [cobro] }],
      1,
    ])

    const { data } = await getShifts('venue-1', 20, 1)

    expect(data[0].paymentSum).toBe(100)
    expect(data[0].tipsCount).toBe(1)
  })
})
