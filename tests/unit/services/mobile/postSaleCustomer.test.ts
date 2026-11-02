jest.mock('@/services/venueSalesGuard', () => ({ __esModule: true, assertVenueSalesEnabled: jest.fn() }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/shared/loyaltyOnLateCustomer', () => ({
  awardLoyaltyForLateCustomer: jest.fn().mockResolvedValue(null),
  reabrirLealtadSiAplica: jest.fn().mockResolvedValue(false),
}))

import { prismaMock } from '@tests/__helpers__/setup'
import { attachCustomerToPayment } from '@/services/mobile/order.mobile.service'

const venueId = 'venue-1'
const customer = { id: 'customer-1', venueId, firstName: 'Ana', lastName: null, email: null, phone: null }
const order = {
  id: 'order-1',
  venueId,
  orderNumber: 'ORD-1',
  status: 'COMPLETED',
  paymentStatus: 'PAID',
  customerId: null,
  customerName: null,
  orderCustomers: [],
  subtotal: 100,
  discountAmount: 0,
  serviceChargeAmount: 0,
  taxAmount: 0,
}
let payment: any
let primary: any

beforeEach(() => {
  payment = {
    id: 'pay-1',
    venueId,
    orderId: order.id,
    type: 'PAYMENT',
    status: 'COMPLETED',
    processedById: 'cashier',
    createdAt: new Date(),
    order,
  }
  primary = null
  prismaMock.$queryRaw.mockResolvedValue([{ id: order.id }] as never)
  prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
  prismaMock.payment.findFirst.mockImplementation(async () => payment)
  prismaMock.payment.count.mockResolvedValue(0)
  prismaMock.order.findFirst.mockImplementation(async () => ({ ...order, orderCustomers: primary ? [primary] : [] }) as any)
  prismaMock.customer.findUnique.mockResolvedValue(customer as any)
  prismaMock.orderCustomer.findFirst.mockImplementation(async () => primary)
  prismaMock.orderCustomer.findUnique.mockResolvedValue(null)
  prismaMock.orderCustomer.create.mockResolvedValue({ id: 'association-1' } as any)
  prismaMock.order.update.mockResolvedValue({ ...order, customerId: customer.id } as any)
})

describe('asignar cliente postventa — autoridad y anclajes reales', () => {
  it('conserva el recibo inmediato de quien cobró', async () => {
    await expect(attachCustomerToPayment(venueId, payment.id, customer.id, 'cashier')).resolves.toMatchObject({ customerId: customer.id })
  })

  it('un cajero no liga una venta propia antigua por la ruta legacy', async () => {
    payment.createdAt = new Date(Date.now() - 16 * 60_000)
    await expect(attachCustomerToPayment(venueId, payment.id, customer.id, 'cashier')).rejects.toMatchObject({ statusCode: 403 })
    expect(prismaMock.order.update).not.toHaveBeenCalled()
  })

  it('un cajero no se apropia del recibo reciente de otra persona', async () => {
    await expect(attachCustomerToPayment(venueId, payment.id, customer.id, 'other-cashier')).rejects.toMatchObject({ statusCode: 403 })
  })

  it('el anclaje primario de la terminal impide sobrescribir la cabecera vacía', async () => {
    primary = { id: 'association-other', customerId: 'other-customer', isPrimary: true }
    await expect(attachCustomerToPayment(venueId, payment.id, customer.id, 'cashier')).rejects.toMatchObject({ statusCode: 409 })
    expect(prismaMock.order.update).not.toHaveBeenCalled()
  })

  it('un pago fallido no da autoridad de recibo', async () => {
    payment.status = 'FAILED'
    await expect(attachCustomerToPayment(venueId, payment.id, customer.id, 'cashier')).rejects.toMatchObject({ statusCode: 409 })
  })

  it('un reembolso completado no da autoridad de recibo', async () => {
    payment.type = 'REFUND'
    await expect(attachCustomerToPayment(venueId, payment.id, customer.id, 'cashier')).rejects.toMatchObject({ statusCode: 409 })
  })
})
