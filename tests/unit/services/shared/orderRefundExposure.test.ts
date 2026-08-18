/**
 * 🔴 EL CARRIL DEL REEMBOLSO SE VE — `refundState` + `refundedAmount` en las
 * respuestas de orden que consumen las apps y el dashboard.
 *
 * Decisión del founder (2026-08-18): tras un reembolso la cuenta queda CERRADA
 * y **MARCADA**. Que el saldo ya no se reabra (arreglado en los 4 canales de
 * cobro) resuelve la mitad; la otra mitad es que el cliente pueda PINTAR la
 * marca — Square muestra la venta en el historial con una flecha y el detalle
 * del reembolso, Toast lleva `refundStatus` = NONE/PARTIAL/FULL en el pago. Sin
 * un campo que lo diga, una venta devuelta se ve exactamente igual que una
 * cobrada.
 *
 * Contrato: **ADITIVO**. `refundedAmount` va en PESOS como el resto de importes
 * de cada respuesta (regla dura de `.claude/rules/critical-warnings.md`), y NADA
 * de lo que ya se devolvía cambia — hay APKs viejos en la calle
 * (`CLAUDE.md`: "NEVER remove API response fields").
 */

const deductInventoryForProductMock = jest.fn()
jest.mock('@/services/dashboard/productInventoryIntegration.service', () => ({
  deductInventoryForProduct: (...a: unknown[]) => deductInventoryForProductMock(...a),
  getProductInventoryMethod: jest.fn(),
  getProductInventoryMethods: jest.fn(),
}))

jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: jest.fn(),
}))

import { Prisma } from '@prisma/client'
import { getOrder, listOrders } from '@/services/mobile/order.mobile.service'
import { getOrderById, getOrders } from '@/services/dashboard/order.dashboard.service'
import { prismaMock } from '../../../__helpers__/setup'

const d = (v: string | number) => new Prisma.Decimal(v)

const VENUE_ID = 'venue-1'
const ORDER_ID = 'order-1'

/** Cobro de $200 + su reembolso total. `type` es lo que los distingue. */
const paidAndFullyRefunded = [
  { id: 'p-1', amount: d('200.00'), tipAmount: d('0.00'), type: 'REGULAR', status: 'COMPLETED', method: 'CASH', createdAt: new Date() },
  { id: 'p-2', amount: d('-200.00'), tipAmount: d('0.00'), type: 'REFUND', status: 'COMPLETED', method: 'CASH', createdAt: new Date() },
]

const paidOnly = [
  { id: 'p-1', amount: d('200.00'), tipAmount: d('0.00'), type: 'REGULAR', status: 'COMPLETED', method: 'CASH', createdAt: new Date() },
]

const orderRow = (payments: any[], over: Record<string, any> = {}) => ({
  id: ORDER_ID,
  orderNumber: 'ORD-1',
  venueId: VENUE_ID,
  status: 'COMPLETED',
  paymentStatus: 'PAID',
  type: 'TAKEOUT',
  source: 'AVOQADO_IOS',
  subtotal: d('200.00'),
  taxAmount: d('0.00'),
  discountAmount: d('0.00'),
  serviceChargeAmount: d('0.00'),
  tipAmount: d('0.00'),
  total: d('200.00'),
  paidAmount: d('200.00'),
  remainingBalance: d('0.00'),
  customerName: null,
  customerId: null,
  specialRequests: null,
  covers: null,
  version: 3,
  createdAt: new Date('2026-08-18T10:00:00Z'),
  servedById: 'staff-1',
  servedBy: { firstName: 'Ana', lastName: 'López' },
  serviceCharges: [],
  orderDiscounts: [],
  items: [],
  payments,
  _count: { items: 0 },
  ...over,
})

beforeEach(() => {
  jest.clearAllMocks()
})

describe('mobile — detalle de orden (`getOrder`) expone el carril del reembolso', () => {
  it('🔴 una venta totalmente devuelta se marca FULL con el monto devuelto', async () => {
    prismaMock.order.findUnique.mockResolvedValue(orderRow(paidAndFullyRefunded) as any)

    const res = await getOrder(VENUE_ID, ORDER_ID)

    expect(res.refundState).toBe('FULL')
    expect(res.refundedAmount).toBe(200)
  })

  it('una devolución PARCIAL se marca PARTIAL', async () => {
    prismaMock.order.findUnique.mockResolvedValue(
      orderRow([
        paidOnly[0],
        {
          id: 'p-2',
          amount: d('-50.00'),
          tipAmount: d('0.00'),
          type: 'REFUND',
          status: 'COMPLETED',
          method: 'CASH',
          createdAt: new Date(),
        },
      ]) as any,
    )

    const res = await getOrder(VENUE_ID, ORDER_ID)

    expect(res.refundState).toBe('PARTIAL')
    expect(res.refundedAmount).toBe(50)
  })

  it('REGRESIÓN: sin reembolsos es NONE / 0, y los campos viejos no cambian', async () => {
    prismaMock.order.findUnique.mockResolvedValue(orderRow(paidOnly) as any)

    const res = await getOrder(VENUE_ID, ORDER_ID)

    expect(res.refundState).toBe('NONE')
    expect(res.refundedAmount).toBe(0)
    // Aditivo: lo que ya devolvía sigue igual.
    expect(res.id).toBe(ORDER_ID)
    expect(res.orderNumber).toBe('ORD-1')
    expect(res.total).toBe(200)
    expect(res.paymentStatus).toBe('PAID')
    expect(res.payments).toHaveLength(1)
  })

  it('🔴 la orden sigue CERRADA: el reembolso NO la devuelve a "por cobrar"', async () => {
    prismaMock.order.findUnique.mockResolvedValue(orderRow(paidAndFullyRefunded) as any)

    const res = await getOrder(VENUE_ID, ORDER_ID)

    expect(res.status).toBe('COMPLETED')
    expect(res.paymentStatus).toBe('PAID')
  })
})

describe('mobile — listado de órdenes (`listOrders`) expone el carril del reembolso', () => {
  it('🔴 cada fila trae refundState y refundedAmount', async () => {
    prismaMock.$transaction.mockResolvedValue([[orderRow(paidAndFullyRefunded)], 1] as any)

    const res = await listOrders(VENUE_ID, { page: 1, pageSize: 20 } as any)

    expect(res.data[0].refundState).toBe('FULL')
    expect(res.data[0].refundedAmount).toBe(200)
  })

  it('REGRESIÓN: sin reembolsos NONE / 0 y el resto de la fila igual', async () => {
    prismaMock.$transaction.mockResolvedValue([[orderRow(paidOnly)], 1] as any)

    const res = await listOrders(VENUE_ID, { page: 1, pageSize: 20 } as any)

    expect(res.data[0].refundState).toBe('NONE')
    expect(res.data[0].refundedAmount).toBe(0)
    expect(res.data[0].orderNumber).toBe('ORD-1')
    expect(res.data[0].total).toBe(200)
    expect(res.meta.total).toBe(1)
  })
})

describe('dashboard — detalle de orden (`getOrderById`) expone el carril del reembolso', () => {
  it('🔴 marca FULL y el monto devuelto, sin tocar lo que ya devolvía', async () => {
    prismaMock.order.findFirst.mockResolvedValue(orderRow(paidAndFullyRefunded.map(p => ({ ...p, processorData: {} }))) as any)

    const res: any = await getOrderById(VENUE_ID, ORDER_ID)

    expect(res.refundState).toBe('FULL')
    expect(res.refundedAmount).toBe(200)
    // `mapOrderPaymentsWithRefunds` sigue corriendo: no se sustituyó nada.
    expect(res.payments).toHaveLength(2)
    expect(res.payments[0]).toHaveProperty('refunds')
    expect(res.orderNumber).toBe('ORD-1')
  })

  it('🔴 un reembolso PENDIENTE no cuenta: sólo los COMPLETED devuelven dinero', async () => {
    prismaMock.order.findFirst.mockResolvedValue(
      orderRow([
        { ...paidOnly[0], processorData: {} },
        {
          id: 'p-2',
          amount: d('-200.00'),
          tipAmount: d('0.00'),
          type: 'REFUND',
          status: 'PENDING',
          method: 'CASH',
          createdAt: new Date(),
          processorData: {},
        },
      ]) as any,
    )

    const res: any = await getOrderById(VENUE_ID, ORDER_ID)

    expect(res.refundState).toBe('NONE')
    expect(res.refundedAmount).toBe(0)
  })

  it('REGRESIÓN: sin reembolsos es NONE / 0', async () => {
    prismaMock.order.findFirst.mockResolvedValue(orderRow(paidOnly.map(p => ({ ...p, processorData: {} }))) as any)

    const res: any = await getOrderById(VENUE_ID, ORDER_ID)

    expect(res.refundState).toBe('NONE')
    expect(res.refundedAmount).toBe(0)
  })
})

describe('dashboard — listado de órdenes (`getOrders`) expone el carril del reembolso', () => {
  it('🔴 cada fila trae refundState y refundedAmount', async () => {
    prismaMock.$transaction.mockResolvedValue([[orderRow(paidAndFullyRefunded)], 1] as any)

    const res: any = await getOrders(VENUE_ID, 1, 20)

    expect(res.data[0].refundState).toBe('FULL')
    expect(res.data[0].refundedAmount).toBe(200)
    // La lista NO engorda con el array de pagos: sólo los dos campos nuevos.
    expect(res.data[0].payments).toBeUndefined()
    expect(res.data[0].orderNumber).toBe('ORD-1')
    expect(res.meta.total).toBe(1)
  })
})
