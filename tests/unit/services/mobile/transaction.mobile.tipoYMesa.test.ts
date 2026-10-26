/**
 * D4 (mesas40, 15-oct): la reimpresión de Android dice «Mesa 5» / «Para llevar» como el ticket del cobro. Para eso la
 * transacción trae, ADITIVOS y opcionales, el tipo de la orden y el número de su mesa. Sin orden o sin mesa: `null`
 * (Android cae a «En tienda», como hoy).
 */
import prisma from '@/utils/prismaClient'
import * as refundService from '@/services/dashboard/refund.dashboard.service'
import { getTransactionDetail, getTransactions } from '@/services/mobile/transaction.mobile.service'

jest.mock('@/services/dashboard/refund.dashboard.service', () => ({ listRefundsForPayment: jest.fn() }))

const prismaMock = prisma as any
const pago = (order: Record<string, unknown> | null) => ({
  id: 'pay_1',
  amount: 100,
  tipAmount: 0,
  method: 'CASH',
  status: 'COMPLETED',
  cardBrand: null,
  maskedPan: null,
  referenceNumber: null,
  authorizationNumber: null,
  createdAt: new Date('2026-10-15T18:00:00.000Z'),
  processedBy: null,
  orderId: order ? 'order-1' : null,
  order,
})
const pideTipoYMesa = expect.objectContaining({
  select: expect.objectContaining({
    order: expect.objectContaining({
      select: expect.objectContaining({ type: true, table: { select: { number: true } } }),
    }),
  }),
})

beforeEach(() => {
  jest.clearAllMocks()
  ;(refundService.listRefundsForPayment as jest.Mock).mockResolvedValue([])
  prismaMock.digitalReceipt.findFirst.mockResolvedValue(null)
  prismaMock.payment.findUnique.mockResolvedValue(null)
  prismaMock.orderItem.findMany.mockResolvedValue([])
  prismaMock.order.findUnique.mockResolvedValue(null)
  prismaMock.$queryRaw.mockResolvedValue([])
})

describe('getTransactionDetail · tipo de la orden y mesa (D4)', () => {
  it('venta pagada anónima admite cliente, preservando importes y campos de recibo', async () => {
    prismaMock.payment.findFirst.mockResolvedValue(
      pago({
        orderNumber: '42',
        type: 'DINE_IN',
        status: 'COMPLETED',
        paymentStatus: 'PAID',
        customerId: null,
        orderCustomers: [],
        table: null,
        items: [],
      }),
    )
    const detail = await getTransactionDetail('venue_1', 'pay_1')
    expect(detail).toMatchObject({ amount: 100, tipAmount: 0, customerId: null, customerName: null, canAssignCustomer: true })
  })
  it('cliente primario puesto desde la terminal bloquea acción aunque la cabecera esté vacía', async () => {
    prismaMock.payment.findFirst.mockResolvedValue(
      pago({
        orderNumber: '42',
        type: 'TAKEOUT',
        status: 'COMPLETED',
        paymentStatus: 'PAID',
        customerId: null,
        orderCustomers: [{ customerId: 'cust_1', customer: { firstName: 'Ana', lastName: 'López' } }],
        table: null,
        items: [],
      }),
    )
    expect(await getTransactionDetail('venue_1', 'pay_1')).toMatchObject({
      customerId: 'cust_1',
      customerName: 'Ana López',
      canAssignCustomer: false,
    })
  })
  it('cobro de la mesa 5: trae DINE_IN y "5", y la consulta los pide', async () => {
    prismaMock.payment.findFirst.mockResolvedValue(pago({ orderNumber: '42', type: 'DINE_IN', table: { number: '5' }, items: [] }))
    const d = await getTransactionDetail('venue_1', 'pay_1')
    expect([d.orderType, d.tableNumber]).toEqual(['DINE_IN', '5'])
    expect(prismaMock.payment.findFirst).toHaveBeenCalledWith(pideTipoYMesa)
  })
  it('para llevar, sin mesa: TAKEOUT y null', async () => {
    prismaMock.payment.findFirst.mockResolvedValue(pago({ orderNumber: '43', type: 'TAKEOUT', table: null, items: [] }))
    const d = await getTransactionDetail('venue_1', 'pay_1')
    expect([d.orderType, d.tableNumber]).toEqual(['TAKEOUT', null])
  })
  it('un cobro sin orden: los dos null (los campos de siempre, intactos)', async () => {
    prismaMock.payment.findFirst.mockResolvedValue(pago(null))
    const d = await getTransactionDetail('venue_1', 'pay_1')
    expect([d.orderType, d.tableNumber, d.orderNumber, d.amount]).toEqual([null, null, null, 100])
  })
})

describe('getTransactions · tipo de la orden y mesa (D4)', () => {
  it('cada renglón de la lista trae el tipo y la mesa de su orden, y la consulta los pide', async () => {
    prismaMock.$transaction.mockResolvedValue([
      [pago({ orderNumber: '42', type: 'DINE_IN', table: { number: '5' } }), { ...pago(null), id: 'pay_2' }],
      2,
    ])
    const r = await getTransactions('venue_1', 1, 20)
    expect(r.data.map(t => [t.id, t.orderType, t.tableNumber])).toEqual([
      ['pay_1', 'DINE_IN', '5'],
      ['pay_2', null, null],
    ])
    expect(prismaMock.payment.findMany).toHaveBeenCalledWith(pideTipoYMesa)
  })
})
