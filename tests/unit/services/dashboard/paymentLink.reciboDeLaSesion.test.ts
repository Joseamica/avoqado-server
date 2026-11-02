/**
 * D7 (26-oct): la página de éxito de una liga pagada con Mercado Pago decía «Recibo aún no disponible» y no dejaba
 * mandarlo. El estado y los envíos buscaban el pago por `processorId = sessionId`, que sólo coincide con Stripe
 * (`pi_…`); con Mercado Pago la sesión es `cs_mp_…` y el pago guarda el id de MP. Y Mercado Pago no da recibo propio.
 */
jest.mock('@/services/tpv/digitalReceipt.tpv.service', () => ({
  generateDigitalReceipt: jest.fn(),
}))
jest.mock('@/services/whatsapp.service', () => ({
  sendReceiptWhatsApp: jest.fn().mockResolvedValue(undefined),
  sendPaymentLinkShareWhatsApp: jest.fn(),
}))
jest.mock('@/services/email.service', () => ({
  __esModule: true,
  default: { sendReceiptEmail: jest.fn().mockResolvedValue(true) },
}))

import { Decimal } from '@prisma/client/runtime/library'
import {
  getSessionStatus,
  sendPaymentLinkReceiptEmail,
  sendPaymentLinkReceiptWhatsapp,
} from '../../../../src/services/dashboard/paymentLink.service'
import { generateDigitalReceipt } from '@/services/tpv/digitalReceipt.tpv.service'
import { sendReceiptWhatsApp } from '@/services/whatsapp.service'
import emailService from '@/services/email.service'
import { prismaMock } from '../../../__helpers__/setup'

const mockGenerar = generateDigitalReceipt as jest.Mock
const FRONTEND = 'https://dashboard.test'

const sesionMP = {
  sessionId: 'cs_mp_abc',
  paymentId: 'pay-mp-1',
  status: 'COMPLETED',
  amount: new Decimal(9),
  currency: 'MXN',
  completedAt: new Date(),
  errorMessage: null,
  paymentLink: { shortCode: 'abc12345', redirectUrl: null },
}

const pagoMP = {
  id: 'pay-mp-1',
  venueId: 'venue-1',
  amount: new Decimal(9),
  tipAmount: new Decimal(0),
  receiptUrl: null,
  cardBrand: null,
  maskedPan: null,
  method: 'CREDIT_CARD',
  createdAt: new Date(),
  venue: { name: 'Avoqado Full', logo: null, address: null, city: null, state: null, phone: null, email: null, currency: 'MXN' },
  order: { orderNumber: 'PL-1', subtotal: new Decimal(10), discountAmount: new Decimal(1), total: new Decimal(9), items: [] },
}

describe('ligas de pago — recibo de la sesión (D7)', () => {
  const frontendAntes = process.env.FRONTEND_URL
  beforeEach(() => {
    process.env.FRONTEND_URL = FRONTEND
    mockGenerar.mockReset()
  })
  afterAll(() => {
    process.env.FRONTEND_URL = frontendAntes
  })

  it('Mercado Pago: encuentra el pago por la sesión y da el recibo de Avoqado', async () => {
    prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(sesionMP as any)
    prismaMock.payment.findFirst.mockResolvedValueOnce(pagoMP as any)
    mockGenerar.mockResolvedValueOnce({ accessKey: 'ak-1' })

    const r = await getSessionStatus('abc12345', 'cs_mp_abc')

    expect(prismaMock.payment.findFirst.mock.calls[0][0]?.where).toEqual({ id: 'pay-mp-1' })
    expect(mockGenerar).toHaveBeenCalledWith('pay-mp-1')
    expect(r.payment?.receiptUrl).toBe(`${FRONTEND}/receipts/public/ak-1`)
  })

  it('Stripe: sin paymentId en la sesión busca por processorId y conserva el recibo de Stripe', async () => {
    prismaMock.checkoutSession.findUnique.mockResolvedValueOnce({ ...sesionMP, sessionId: 'pi_123', paymentId: null } as any)
    prismaMock.payment.findFirst.mockResolvedValueOnce({
      ...pagoMP,
      receiptUrl: 'https://pay.stripe.com/receipts/x',
      cardBrand: 'visa',
      maskedPan: '************4242',
    } as any)

    const r = await getSessionStatus('abc12345', 'pi_123')

    expect(prismaMock.payment.findFirst.mock.calls[0][0]?.where).toEqual({ processorId: 'pi_123' })
    expect(mockGenerar).not.toHaveBeenCalled()
    expect(r.payment).toEqual({ receiptUrl: 'https://pay.stripe.com/receipts/x', cardBrand: 'visa', last4: '4242' })
  })

  it('si el recibo no se puede generar, el estado no falla: el recibo queda «no disponible»', async () => {
    prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(sesionMP as any)
    prismaMock.payment.findFirst.mockResolvedValueOnce(pagoMP as any)
    mockGenerar.mockRejectedValueOnce(new Error('snapshot roto'))

    const r = await getSessionStatus('abc12345', 'cs_mp_abc')

    expect(r.status).toBe('COMPLETED')
    expect(r.payment?.receiptUrl).toBeNull()
  })

  it('antes de COMPLETED no busca el pago ni crea recibo', async () => {
    prismaMock.checkoutSession.findUnique.mockResolvedValueOnce({ ...sesionMP, status: 'PENDING' } as any)

    const r = await getSessionStatus('abc12345', 'cs_mp_abc')

    expect(prismaMock.payment.findFirst).not.toHaveBeenCalled()
    expect(mockGenerar).not.toHaveBeenCalled()
    expect(r.payment).toBeNull()
  })

  it('WhatsApp con Mercado Pago manda el recibo de Avoqado', async () => {
    prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(sesionMP as any)
    prismaMock.payment.findFirst.mockResolvedValueOnce(pagoMP as any)
    mockGenerar.mockResolvedValueOnce({ accessKey: 'ak-2' })

    await expect(sendPaymentLinkReceiptWhatsapp('abc12345', 'cs_mp_abc', '+525511112222')).resolves.toEqual({ sent: true })

    expect(prismaMock.payment.findFirst.mock.calls[0][0]?.where).toEqual({ id: 'pay-mp-1' })
    expect(sendReceiptWhatsApp).toHaveBeenCalledWith(
      '+525511112222',
      expect.objectContaining({ receiptUrl: `${FRONTEND}/receipts/public/ak-2`, totalAmount: '$9.00 MXN' }),
    )
  })

  it('correo con Mercado Pago manda el recibo de Avoqado', async () => {
    prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(sesionMP as any)
    prismaMock.payment.findFirst.mockResolvedValueOnce(pagoMP as any)
    mockGenerar.mockResolvedValueOnce({ accessKey: 'ak-3' })

    await sendPaymentLinkReceiptEmail('abc12345', 'cs_mp_abc', 'cliente@example.com')

    expect(prismaMock.payment.findFirst.mock.calls[0][0]?.where).toEqual({ id: 'pay-mp-1' })
    const llamada = (emailService.sendReceiptEmail as jest.Mock).mock.calls[0]
    expect(JSON.stringify(llamada)).toContain(`${FRONTEND}/receipts/public/ak-3`)
  })

  it('Stripe sin su receipt_url (falló la consulta a Stripe): da el recibo de Avoqado en vez de «no disponible»', async () => {
    prismaMock.checkoutSession.findUnique.mockResolvedValueOnce({ ...sesionMP, sessionId: 'pi_456', paymentId: null } as any)
    prismaMock.payment.findFirst.mockResolvedValueOnce({ ...pagoMP, id: 'pay-st-1' } as any)
    mockGenerar.mockResolvedValueOnce({ accessKey: 'ak-4' })

    const r = await getSessionStatus('abc12345', 'pi_456')

    expect(mockGenerar).toHaveBeenCalledWith('pay-st-1')
    expect(r.payment?.receiptUrl).toBe(`${FRONTEND}/receipts/public/ak-4`)
  })

  it('si el recibo ya existía con datos del cliente (generado desde el panel), la página de la liga no lo da', async () => {
    prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(sesionMP as any)
    prismaMock.payment.findFirst.mockResolvedValueOnce(pagoMP as any)
    mockGenerar.mockResolvedValueOnce({ accessKey: 'ak-5', dataSnapshot: { customer: { name: 'Otra Persona', email: 'otra@example.com' } } })

    const r = await getSessionStatus('abc12345', 'cs_mp_abc')

    expect(r.payment?.receiptUrl).toBeNull()
  })
})
