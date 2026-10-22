/**
 * `cancelDeliveryOrder` — el proveedor (Uber, Rappi) canceló un pedido: deja de ser venta y sale de la cocina.
 *
 * Núcleo compartido: Uber y Rappi lo llaman igual. Lo que se prueba aquí es la relectura del estado BAJO el candado de la
 * orden (Tarea 11 de Rappi fase 2, pendiente 6 de la revisión de la Tarea 10): dos cancelaciones a la vez leían las dos
 * «CONFIRMED» antes del candado y las dos escribían, así que quedaban DOS `DELIVERY_ORDER_CANCELLED` en la bitácora. El
 * stock ya estaba a salvo por un UNIQUE; la carrera real contra Postgres: tests/integration/delivery-channels/comandaBajoCandado.test.ts.
 */
import { Prisma } from '@prisma/client'

import prisma from '@/utils/prismaClient'
import { cancelDeliveryOrder } from '@/services/delivery-channels/core/cancelDeliveryOrder.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { reverseSalePosting } from '@/services/inventory/reverseSalePosting.service'
import { findLiveTerminalCharge } from '@/services/shared/orderCancelGuard'

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/services/inventory/reverseSalePosting.service', () => ({ reverseSalePosting: jest.fn() }))
jest.mock('@/services/shared/orderCancelGuard', () => ({ findLiveTerminalCharge: jest.fn() }))

const mockLog = logAction as jest.Mock
const mockReverse = reverseSalePosting as jest.Mock
const mockCobroVivo = findLiveTerminalCharge as jest.Mock

/** La orden tal como la lee la cancelación ANTES del candado. */
const ordenLeida = (status = 'CONFIRMED') => ({
  id: 'ord1',
  venueId: 'v1',
  orderNumber: 'A1',
  status,
  total: new Prisma.Decimal('90.00'),
})

const esCandadoDeFila = (c: any[]) => Array.isArray(c[0]) && /FROM\s+"Order"[\s\S]*FOR UPDATE/.test(c[0].join('?'))

describe('cancelDeliveryOrder', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prisma.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prisma))
    ;(prisma.$queryRaw as jest.Mock).mockResolvedValue([{ id: 'ord1' }])
    ;(prisma.order.findFirst as jest.Mock).mockResolvedValue(ordenLeida())
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue({ status: 'CONFIRMED' })
    ;(prisma.order.update as jest.Mock).mockResolvedValue({ id: 'ord1' })
    ;(prisma.kdsOrderItem.deleteMany as jest.Mock).mockResolvedValue({ count: 0 })
    ;(prisma.kdsOrder.deleteMany as jest.Mock).mockResolvedValue({ count: 1 })
    mockCobroVivo.mockResolvedValue(null)
    mockReverse.mockResolvedValue({ outcome: 'REVERSED', movements: 1 })
  })

  it('🔴 dos cancelaciones a la vez: la segunda relee CANCELLED bajo el candado y NO escribe otra vez', async () => {
    // Las dos leyeron CONFIRMED antes del candado; cuando a esta le toca el candado, la otra ya la dejó CANCELLED.
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue({ status: 'CANCELLED' })

    const r = await cancelDeliveryOrder('392625', 'RAPPI' as never, 'cancelado por Rappi: canceled_with_charge')

    expect(r).toEqual({ outcome: 'ALREADY_CANCELLED', orderId: 'ord1' })
    // Bajo el candado de fila de la orden (el mismo de la ingesta y del cobro), y releída con él en la mano.
    expect((prisma.$queryRaw as jest.Mock).mock.calls.some(esCandadoDeFila)).toBe(true)
    expect(prisma.order.findUnique).toHaveBeenCalledWith({ where: { id: 'ord1' }, select: { status: true } })
    // Nada se escribe dos veces: ni el estado, ni la cocina, ni la bitácora, ni el stock.
    expect(prisma.order.update).not.toHaveBeenCalled()
    expect(prisma.kdsOrder.deleteMany).not.toHaveBeenCalled()
    expect(mockLog).not.toHaveBeenCalled()
    expect(mockReverse).not.toHaveBeenCalled()
  })

  it('la primera cancelación: candado → relectura → CANCELLED → cocina vacía, stock devuelto y UNA línea de bitácora', async () => {
    const r = await cancelDeliveryOrder('392625', 'RAPPI' as never, 'cancelado por Rappi: canceled_with_charge')

    expect(r).toEqual({ outcome: 'CANCELLED', orderId: 'ord1' })
    const candado = (prisma.$queryRaw as jest.Mock).mock.calls.findIndex(esCandadoDeFila)
    const t = {
      candado: (prisma.$queryRaw as jest.Mock).mock.invocationCallOrder[candado],
      relectura: (prisma.order.findUnique as jest.Mock).mock.invocationCallOrder[0],
      escritura: (prisma.order.update as jest.Mock).mock.invocationCallOrder[0],
    }
    expect(t.candado).toBeLessThan(t.relectura)
    expect(t.relectura).toBeLessThan(t.escritura)
    expect(prisma.order.update).toHaveBeenCalledWith({ where: { id: 'ord1' }, data: { status: 'CANCELLED' } })
    expect(prisma.kdsOrder.deleteMany).toHaveBeenCalledWith({ where: { orderId: 'ord1' } })
    expect(mockReverse).toHaveBeenCalledTimes(1)
    const cancelaciones = mockLog.mock.calls.filter(([a]) => a.action === 'DELIVERY_ORDER_CANCELLED')
    expect(cancelaciones).toHaveLength(1)
    expect(cancelaciones[0][0]).toMatchObject({
      entityId: 'ord1',
      venueId: 'v1',
      data: { externalId: 'RAPPI:392625', provider: 'RAPPI', motivo: 'cancelado por Rappi: canceled_with_charge', total: '90' },
    })
  })

  it('ya CANCELLED antes del candado: ALREADY_CANCELLED sin abrir la transacción (como siempre)', async () => {
    ;(prisma.order.findFirst as jest.Mock).mockResolvedValue(ordenLeida('CANCELLED'))

    const r = await cancelDeliveryOrder('77645', 'UBER_EATS' as never, 'cancelado por Uber')

    expect(r).toEqual({ outcome: 'ALREADY_CANCELLED', orderId: 'ord1' })
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(mockLog).not.toHaveBeenCalled()
  })

  it('sin la orden: ORDER_NOT_FOUND, sin escribir nada (la cancelación que se adelanta al pedido)', async () => {
    ;(prisma.order.findFirst as jest.Mock).mockResolvedValue(null)

    const r = await cancelDeliveryOrder('77645', 'UBER_EATS' as never, 'cancelado por Uber')

    expect(r).toEqual({ outcome: 'ORDER_NOT_FOUND' })
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(mockLog).not.toHaveBeenCalled()
  })

  it('con un cobro de terminal vivo cancela igual (es verdad externa) y deja el 🚨 en la bitácora', async () => {
    mockCobroVivo.mockResolvedValue({ requestId: 'req-1' })

    const r = await cancelDeliveryOrder('77645', 'UBER_EATS' as never, 'cancelado por Uber')

    expect(r).toEqual({ outcome: 'CANCELLED', orderId: 'ord1' })
    expect(mockLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'ORDER_CANCELLED_WITH_LIVE_TERMINAL_CHARGE' }))
    expect(mockLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'DELIVERY_ORDER_CANCELLED' }))
  })
})
