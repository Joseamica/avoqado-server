import { Prisma } from '@prisma/client'
import { prismaMock } from '../../../__helpers__/setup'
import * as paymentService from '@/services/mercado-pago/payment.service'
import * as connectionService from '@/services/mercado-pago/connection.service'
import { executeMercadoPagoPaymentForPaymentLink } from '@/services/dashboard/paymentLink.service'
import { executeMercadoPagoPaymentForVenue } from '@/services/dashboard/venueCheckout.service'
import { handleIpn } from '@/services/mercado-pago/payment-flow.service'

jest.mock('nanoid', () => ({ nanoid: jest.fn(() => 'test-id') }))
jest.mock('@/services/mercado-pago/payment.service', () => ({
  ...jest.requireActual('@/services/mercado-pago/payment.service'),
  createPayment: jest.fn(),
  getPayment: jest.fn(),
}))
jest.mock('@/services/mercado-pago/connection.service')
// Financial finalization is real; only its external side effects are stubbed.
const mockCreatePosting = jest.fn()
const mockApplyPosting = jest.fn()
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  createSalePostingInTx: (...args: unknown[]) => mockCreatePosting(...args),
  applySalePosting: (...args: unknown[]) => mockApplyPosting(...args),
}))
jest.mock('@/services/referrals/referralQualification.service', () => ({ onOrderPaid: jest.fn() }))

const input = { token: 'card-token', paymentMethodId: 'visa', installments: 1, payer: { email: 'buyer@example.com' } }
const payload = {
  id: 1,
  live_mode: false,
  type: 'payment',
  date_created: new Date().toISOString(),
  user_id: 123,
  api_version: 'v1',
  action: 'payment.updated',
  data: { id: '777' },
}
let session: any
let providerStatus: string
let requestNumber: number
const paths = ['liga', 'venue', 'IPN'] as const
async function execute(path: (typeof paths)[number]) {
  if (path === 'liga') return executeMercadoPagoPaymentForPaymentLink('link1', session.sessionId, input)
  if (path === 'venue') return executeMercadoPagoPaymentForVenue('venue1', session.sessionId, input)
  return handleIpn({ payload, requestId: `request-${++requestNumber}` })
}

beforeEach(() => {
  jest.clearAllMocks()
  providerStatus = 'authorized'
  requestNumber = 0
  session = {
    id: 'cs-db-1',
    sessionId: 'cs-1',
    status: 'PENDING',
    completedAt: null,
    paymentId: null,
    amount: new Prisma.Decimal(275),
    applicationFeeCents: 500,
    description: 'Pago',
    customerEmail: null,
    ecommerceMerchantId: 'em-1',
    ecommerceMerchant: { id: 'em-1', venueId: 'v-1', provider: { code: 'MERCADO_PAGO' } },
    paymentLink: { id: 'pl-1', shortCode: 'link1', venueId: 'v-1', createdById: 'staff-1', purpose: 'ITEM' },
    metadata: { tipAmount: 25, items: [{ productId: 'p-1', productName: 'Producto', quantity: 1, unitPrice: 250, modifiers: [] }] },
  }
  prismaMock.venue.findUnique.mockResolvedValue({ id: 'v-1', name: 'Venue', salesEnabled: true })
  prismaMock.ecommerceMerchant.findFirst.mockResolvedValue({ id: 'em-1', venueId: 'v-1', providerMerchantId: '123' })
  prismaMock.checkoutSession.findUnique.mockImplementation(async () => ({ ...session }))
  prismaMock.checkoutSession.findFirst.mockImplementation(async (args: any) =>
    args.where.ecommerceMerchantId === session.ecommerceMerchantId ? { ...session } : null,
  )
  prismaMock.checkoutSession.update.mockImplementation(async ({ data }: any) => {
    Object.assign(session, data)
    return { ...session }
  })
  prismaMock.$transaction.mockImplementation(async (fn: any) => fn(prismaMock))
  prismaMock.order.create.mockResolvedValue({ id: 'order-1', items: [{ id: 'oi-1', productId: 'p-1', quantity: 1, modifiers: [] }] })
  prismaMock.payment.create.mockResolvedValue({ id: 'payment-1' })
  prismaMock.paymentLink.update.mockResolvedValue({})
  prismaMock.mercadoPagoWebhookEvent.create.mockResolvedValue({ id: 'event-1' })
  prismaMock.mercadoPagoWebhookEvent.updateMany.mockResolvedValue({ count: 1 })
  mockCreatePosting.mockResolvedValue({ id: 'posting-1' })
  mockApplyPosting.mockResolvedValue(undefined)
  jest
    .mocked(connectionService.loadCredentials)
    .mockResolvedValue({ accessToken: 'test-seller', publicKey: 'test-pk', mpUserId: '123' } as any)
  const payment = () => ({ id: 777, status: providerStatus, status_detail: 'test', external_reference: session.sessionId, order: null })
  jest.mocked(paymentService.createPayment).mockImplementation(async () => payment() as any)
  jest.mocked(paymentService.getPayment).mockImplementation(async () => payment() as any)
})

for (const path of paths) {
  describe(`MP ${path} con finalizador real`, () => {
    it.each([
      ['authorized', 'PENDING'],
      ['pending', 'PENDING'],
      ['in_process', 'PENDING'],
      ['in_mediation', 'PENDING'],
      ['rejected', 'CANCELLED'],
      ['cancelled', 'CANCELLED'],
      ['refunded', 'FAILED'],
      ['charged_back', 'FAILED'],
      ['unknown', 'PENDING'],
    ])('%s guarda %s sin entrar al finalizador ni registrar venta/stock', async (status, expected) => {
      providerStatus = status
      await execute(path)
      expect(session.status).toBe(expected)
      expect(session.completedAt).toBeNull()
      expect(session.mpPaymentId).toBe('777')
      // The first operation of the real finalizer is findUnique; no extra read means no entry.
      expect(prismaMock.checkoutSession.findUnique).toHaveBeenCalledTimes(path === 'IPN' ? 0 : 1)
      expect(prismaMock.$transaction).not.toHaveBeenCalled()
      expect(prismaMock.order.create).not.toHaveBeenCalled()
      expect(prismaMock.payment.create).not.toHaveBeenCalled()
      expect(mockCreatePosting).not.toHaveBeenCalled()
      expect(mockApplyPosting).not.toHaveBeenCalled()
    })
    it('authorized seguido de approved registra una sola venta, incluso con IPN repetido', async () => {
      if (path === 'venue') {
        session.paymentLink = null
        session.metadata = { type: 'venue_checkout' }
      }
      await execute(path)
      expect(session.status).toBe('PENDING')
      expect(prismaMock.order.create).not.toHaveBeenCalled()
      providerStatus = 'approved'
      await execute(path)
      expect(session.status).toBe('COMPLETED')
      expect(session.completedAt).toBeInstanceOf(Date)
      expect(session.paymentId).toBe('payment-1')
      const completedAt = session.completedAt
      await execute('IPN')
      await execute('IPN') // new delivery ids, so this exercises finalizer idempotency, not webhook dedupe
      expect(session.completedAt).toBe(completedAt)
      expect(prismaMock.order.create).toHaveBeenCalledTimes(1)
      expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
      expect(mockCreatePosting).toHaveBeenCalledTimes(1)
      expect(mockApplyPosting).toHaveBeenCalledTimes(1)
      expect(prismaMock.payment.create.mock.calls[0][0].data.idempotencyKey).toBe('777')
    })
  })
}

it('liga ajena y venue ajeno no crean pago en MP', async () => {
  await expect(executeMercadoPagoPaymentForPaymentLink('other-link', session.sessionId, input)).rejects.toThrow('La sesión no pertenece')
  session.ecommerceMerchant.venueId = 'other-venue'
  await expect(execute('venue')).rejects.toThrow('La sesión no pertenece')
  expect(paymentService.createPayment).not.toHaveBeenCalled()
})
it('IPN sólo encuentra sesión del merchant propietario', async () => {
  session.ecommerceMerchantId = 'other-merchant'
  expect(await execute('IPN')).toEqual({ status: 'ignored', reason: 'session_not_found' })
  expect(prismaMock.checkoutSession.findFirst).toHaveBeenCalledWith({ where: { sessionId: 'cs-1', ecommerceMerchantId: 'em-1' } })
  expect(prismaMock.checkoutSession.update).not.toHaveBeenCalled()
  expect(prismaMock.order.create).not.toHaveBeenCalled()
})
