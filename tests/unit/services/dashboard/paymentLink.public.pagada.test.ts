// Liga de un solo uso ya cobrada: sigue siendo 400 «ya fue utilizada», ahora con el código y el resumen del pago para que
// el checkout dibuje «Pagada» con su fecha y su recibo.
jest.mock('nanoid', () => ({ nanoid: jest.fn(() => 'abc12345') }))
jest.mock('../../../../src/services/tpv/digitalReceipt.tpv.service', () => ({
  generateDigitalReceipt: jest.fn(async () => ({ accessKey: 'recibo-avq-1', dataSnapshot: { venue: {} } })),
}))
import { getPaymentLinkByShortCode } from '../../../../src/services/dashboard/paymentLink.service'
import { generateDigitalReceipt } from '../../../../src/services/tpv/digitalReceipt.tpv.service'
import { prismaMock } from '../../../__helpers__/setup'
import { Decimal } from '@prisma/client/runtime/library'

function liga(over: Record<string, unknown> = {}) {
  return {
    id: 'cplink00000000000000000001',
    venueId: 'v1',
    shortCode: 'abc12345',
    purpose: 'PAYMENT',
    title: 'Clase muestra',
    description: null,
    imageUrl: null,
    amountType: 'FIXED',
    amount: new Decimal(1000),
    currency: 'MXN',
    status: 'ACTIVE',
    expiresAt: null,
    isReusable: false,
    paymentCount: 1,
    customFields: null,
    tippingConfig: null,
    redirectUrl: null,
    discount: null,
    items: [],
    venue: {
      id: 'v1',
      name: 'Mindform',
      slug: 'mindform',
      logo: 'https://cdn.example.com/logo.png',
      primaryColor: null,
      secondaryColor: null,
      paymentLinkBranding: null,
      phone: '5512345678',
      timezone: 'America/Mexico_City',
    },
    ecommerceMerchant: { provider: { code: 'STRIPE_CONNECT' } },
    ...over,
  }
}

const COBRO_STRIPE = {
  sessionId: 'pi_123',
  paymentId: null,
  amount: new Decimal(1000),
  currency: 'MXN',
  completedAt: new Date('2026-10-27T00:21:18.330Z'),
}

/** El 400 que lanza el servicio (lo que el controlador convierte en la respuesta). */
async function errorDe(over: Record<string, unknown> = {}): Promise<any> {
  ;(prismaMock.paymentLink.findUnique as jest.Mock).mockResolvedValue(liga(over))
  try {
    await getPaymentLinkByShortCode('abc12345')
  } catch (err) {
    return err
  }
  throw new Error('se esperaba un error')
}

describe('getPaymentLinkByShortCode — liga de un solo uso ya cobrada', () => {
  const FRONTEND_URL = process.env.FRONTEND_URL
  beforeEach(() => {
    process.env.FRONTEND_URL = 'https://dashboard.example.com'
    ;(generateDigitalReceipt as jest.Mock).mockClear()
  })
  afterAll(() => {
    process.env.FRONTEND_URL = FRONTEND_URL
  })

  it('Stripe: 400 con el mismo mensaje, el código y el resumen (fecha, monto, tarjeta y recibo de Stripe)', async () => {
    ;(prismaMock.checkoutSession.findFirst as jest.Mock).mockResolvedValue(COBRO_STRIPE)
    ;(prismaMock.payment.findFirst as jest.Mock).mockResolvedValue({
      id: 'pay1',
      receiptUrl: 'https://pay.stripe.com/receipts/abc',
      cardBrand: 'VISA',
      maskedPan: '************4242',
    })

    const err = await errorDe()

    expect(err.statusCode).toBe(400)
    expect(err.message).toBe('Esta liga de pago ya fue utilizada')
    expect(err.code).toBe('PAYMENT_LINK_ALREADY_PAID')
    expect(err.details).toEqual({
      title: 'Clase muestra',
      venue: { name: 'Mindform', slug: 'mindform', logo: 'https://cdn.example.com/logo.png' },
      branding: expect.objectContaining({ buttonColor: expect.any(String), buttonShape: expect.any(String) }),
      timezone: 'America/Mexico_City',
      paidAt: '2026-10-27T00:21:18.330Z',
      amount: 1000,
      currency: 'MXN',
      payment: { cardBrand: 'VISA', last4: '4242', receiptUrl: 'https://pay.stripe.com/receipts/abc' },
    })
    // El recibo de Stripe basta: no se genera el de Avoqado.
    expect(generateDigitalReceipt).not.toHaveBeenCalled()
  })

  it('busca el último cobro COMPLETADO de esa liga y su pago dentro del mismo negocio', async () => {
    ;(prismaMock.checkoutSession.findFirst as jest.Mock).mockResolvedValue(COBRO_STRIPE)
    ;(prismaMock.payment.findFirst as jest.Mock).mockResolvedValue(null)

    await errorDe()

    const sesion = (prismaMock.checkoutSession.findFirst as jest.Mock).mock.calls.map((c: unknown[]) => c[0])[0] as any
    expect(sesion.where).toEqual({ paymentLinkId: 'cplink00000000000000000001', status: 'COMPLETED' })
    expect(sesion.orderBy).toEqual([{ completedAt: 'desc' }, { id: 'desc' }])
    const pago = (prismaMock.payment.findFirst as jest.Mock).mock.calls.map((c: unknown[]) => c[0])[0] as any
    // Stripe guarda la sesión como processorId del pago.
    expect(pago.where).toEqual({ processorId: 'pi_123', venueId: 'v1' })
  })

  it('🔴 Mercado Pago (sin recibo del proveedor): el pago por su id y SIN el recibo de Avoqado (su llave abre la factura)', async () => {
    ;(prismaMock.checkoutSession.findFirst as jest.Mock).mockResolvedValue({ ...COBRO_STRIPE, sessionId: 'cs_mp_1', paymentId: 'pay-mp' })
    ;(prismaMock.payment.findFirst as jest.Mock).mockResolvedValue({ receiptUrl: null, cardBrand: null, maskedPan: null })

    const err = await errorDe({ ecommerceMerchant: { provider: { code: 'MERCADO_PAGO' } } })

    const pago = (prismaMock.payment.findFirst as jest.Mock).mock.calls.map((c: unknown[]) => c[0])[0] as any
    expect(pago.where).toEqual({ id: 'pay-mp', venueId: 'v1' })
    // Ni se genera ni se busca el recibo digital: con sólo el shortCode no se entrega una llave que abre el CFDI.
    expect(generateDigitalReceipt).not.toHaveBeenCalled()
    expect(err.details.payment).toEqual({ cardBrand: null, last4: null, receiptUrl: null })
  })

  it('🔴 un recibo de Avoqado guardado en el pago tampoco sale', async () => {
    ;(prismaMock.checkoutSession.findFirst as jest.Mock).mockResolvedValue(COBRO_STRIPE)
    ;(prismaMock.payment.findFirst as jest.Mock).mockResolvedValue({
      receiptUrl: 'https://dashboard.example.com/receipts/public/llave-con-cfdi',
      cardBrand: 'VISA',
      maskedPan: '************4242',
    })

    const err = await errorDe()

    expect(err.details.payment.receiptUrl).toBeNull()
    expect(JSON.stringify(err.details)).not.toContain('llave-con-cfdi')
  })

  it('no lleva datos de quien pagó ni el teléfono del negocio', async () => {
    ;(prismaMock.checkoutSession.findFirst as jest.Mock).mockResolvedValue(COBRO_STRIPE)
    ;(prismaMock.payment.findFirst as jest.Mock).mockResolvedValue({
      id: 'pay1',
      receiptUrl: null,
      cardBrand: 'VISA',
      maskedPan: '************4242',
    })

    const err = await errorDe()

    const texto = JSON.stringify(err.details)
    expect(texto).not.toContain('5512345678')
    expect(texto).not.toMatch(/email|phone|customer/i)
  })

  it('pagada y después vencida o archivada: sigue diciendo pagada (y no la marca vencida)', async () => {
    ;(prismaMock.checkoutSession.findFirst as jest.Mock).mockResolvedValue(COBRO_STRIPE)
    ;(prismaMock.payment.findFirst as jest.Mock).mockResolvedValue(null)

    const vencida = await errorDe({ expiresAt: new Date('2020-01-01T00:00:00Z') })
    expect(vencida.code).toBe('PAYMENT_LINK_ALREADY_PAID')
    expect(prismaMock.paymentLink.update).not.toHaveBeenCalled()

    const archivada = await errorDe({ status: 'ARCHIVED' })
    expect(archivada.code).toBe('PAYMENT_LINK_ALREADY_PAID')
  })

  it('cobro sin sesión completada (dato viejo): «Pagada» sin fecha ni recibo, sin buscar el pago', async () => {
    ;(prismaMock.checkoutSession.findFirst as jest.Mock).mockResolvedValue(null)

    const err = await errorDe()

    expect(err.code).toBe('PAYMENT_LINK_ALREADY_PAID')
    expect(err.details).toMatchObject({ paidAt: null, amount: null, currency: 'MXN', payment: null })
    expect(prismaMock.payment.findFirst).not.toHaveBeenCalled()
  })

  it('liga de un solo uso SIN cobrar: se resuelve como siempre y no busca cobros', async () => {
    ;(prismaMock.paymentLink.findUnique as jest.Mock).mockResolvedValue(liga({ paymentCount: 0 }))

    const r = (await getPaymentLinkByShortCode('abc12345')) as any

    expect(r.shortCode).toBe('abc12345')
    expect(prismaMock.checkoutSession.findFirst).not.toHaveBeenCalled()
  })

  it('reutilizable con cobros: se resuelve como siempre', async () => {
    ;(prismaMock.paymentLink.findUnique as jest.Mock).mockResolvedValue(liga({ isReusable: true, paymentCount: 3 }))

    const r = (await getPaymentLinkByShortCode('abc12345')) as any

    expect(r.shortCode).toBe('abc12345')
    expect(prismaMock.checkoutSession.findFirst).not.toHaveBeenCalled()
  })
})
