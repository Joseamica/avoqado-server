// Task 5 — descuento en ligas: un solo cálculo de cobro en los cuatro caminos.
// La clienta paga exactamente base − descuento + propina; si la página mostró otro total → 409 y NO se cobra.
jest.mock('@/services/venueSalesGuard', () => ({ __esModule: true, assertVenueSalesEnabled: jest.fn() }))
jest.mock('@/services/superadmin/platformSettings.service', () => ({ getVatRateBps: jest.fn().mockResolvedValue(1600) }))
jest.mock('@/services/mercado-pago/connection.service', () => ({
  loadCredentials: jest.fn().mockResolvedValue({ accessToken: 'fixture', publicKey: 'pk', mpUserId: 1, expiresAt: new Date('2099-01-01') }),
}))
const createStripePi = jest.fn()
jest.mock('stripe', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ paymentIntents: { create: createStripePi } })),
}))
jest.mock('nanoid', () => ({ nanoid: jest.fn(() => 'abc12345') }))
const providerCreateCheckout = jest.fn()
const providerTokenize = jest.fn()
jest.mock('@/services/payments/provider-registry', () => ({
  getProvider: () => ({ createCheckoutSession: providerCreateCheckout, tokenizeCard: providerTokenize }),
}))

import {
  createStripePaymentIntentForPaymentLink,
  createStripeCheckoutForPaymentLink,
  createCheckoutSession,
  createMercadoPagoPaymentIntentForPaymentLink,
} from '../../../../src/services/dashboard/paymentLink.service'
import { prismaMock } from '../../../__helpers__/setup'
import { Decimal } from '@prisma/client/runtime/library'

type Camino = 'Stripe inline' | 'Stripe hosted' | 'Blumon' | 'MercadoPago'
const CAMINOS: Camino[] = ['Stripe inline', 'Stripe hosted', 'Blumon', 'MercadoPago']
const STRIPE: Camino[] = ['Stripe inline', 'Stripe hosted']

const MANUAL_15 = { v: 1, origen: 'MANUAL', discountId: null, type: 'PERCENTAGE', value: 15, name: 'Buen Fin' }

function liga(camino: Camino, overrides: Record<string, unknown> = {}) {
  const code = camino === 'Blumon' ? 'BLUMON' : camino === 'MercadoPago' ? 'MERCADO_PAGO' : 'STRIPE_CONNECT'
  return {
    id: 'cplink00000000000000000001',
    shortCode: 'abc12345',
    venueId: 'cvenue0000000000000000001',
    purpose: 'PAYMENT',
    title: 'Clase',
    amountType: 'FIXED',
    amount: new Decimal(1000),
    currency: 'MXN',
    isReusable: true,
    expiresAt: null,
    status: 'ACTIVE',
    paymentCount: 0,
    customerId: null,
    customFields: null,
    tippingConfig: { enabled: true, presets: [10, 15] },
    discount: null,
    discountId: null,
    items: [],
    ecommerceMerchant: {
      id: 'cmerch0000000000000000001',
      provider: { code },
      chargesEnabled: true,
      platformFeeBps: 100,
      providerCredentials: { connectAccountId: 'acct_fixture', accessToken: 'fixture' },
    },
    ...overrides,
  }
}

async function pagar(camino: Camino, input: Record<string, unknown>) {
  if (camino === 'Stripe inline') return createStripePaymentIntentForPaymentLink('abc12345', input)
  if (camino === 'Stripe hosted') return createStripeCheckoutForPaymentLink('abc12345', input)
  if (camino === 'MercadoPago') return createMercadoPagoPaymentIntentForPaymentLink('abc12345', input)
  return createCheckoutSession('abc12345', {
    ...input,
    pan: '4242424242424242',
    cvv: '123',
    expMonth: '12',
    expYear: '2030',
    holderName: 'Ana',
  } as any)
}

/** Lo que se le pidió cobrar al proveedor (centavos) o, en Blumon/MP, lo que quedó en la sesión (pesos × 100). */
function centavosCobrados(camino: Camino): number {
  if (camino === 'Stripe inline') return createStripePi.mock.calls[0][0].amount
  if (camino === 'Stripe hosted') return providerCreateCheckout.mock.calls[0][1].amount
  return Math.round(Number(prismaMock.checkoutSession.create.mock.calls[0][0].data.amount) * 100)
}

function metadataDeSesion(): Record<string, unknown> {
  return prismaMock.checkoutSession.create.mock.calls[0][0].data.metadata as Record<string, unknown>
}

function noSeLlamoAlProveedor() {
  expect(createStripePi).not.toHaveBeenCalled()
  expect(providerCreateCheckout).not.toHaveBeenCalled()
  expect(providerTokenize).not.toHaveBeenCalled()
  expect(prismaMock.checkoutSession.create).not.toHaveBeenCalled()
}

beforeEach(() => {
  process.env.STRIPE_PUBLISHABLE_KEY = 'fixture-public-key'
  createStripePi.mockReset().mockResolvedValue({ id: 'pi_fixture', client_secret: 'secret' })
  providerCreateCheckout.mockReset().mockResolvedValue({ id: 'cs_fixture', url: 'https://example.test', expiresAt: new Date() })
  providerTokenize.mockReset().mockResolvedValue({ token: 'tok', maskedPan: '4242', cardBrand: 'VISA' })
  prismaMock.checkoutSession.create.mockResolvedValue({ sessionId: 'session-fixture' } as any)
  prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' } as any)
})

describe.each(CAMINOS)('%s: cobro de liga con descuento', camino => {
  it('liga fija 1000 −15 % + propina 50 → cobra 900 y la sesión guarda la foto del descuento', async () => {
    prismaMock.paymentLink.findUnique.mockResolvedValue(liga(camino, { discount: MANUAL_15 }) as any)
    await pagar(camino, { tipAmount: 50 })
    expect(centavosCobrados(camino)).toBe(90000)
    expect(Number(prismaMock.checkoutSession.create.mock.calls[0][0].data.amount)).toBe(900)
    expect(metadataDeSesion().descuento).toEqual({ foto: MANUAL_15, descuento: 150, base: 1000 })
    expect(metadataDeSesion().tipAmount).toBe(50)
  })

  it('sin expectedTotal cobra el neto 850', async () => {
    prismaMock.paymentLink.findUnique.mockResolvedValue(liga(camino, { discount: MANUAL_15 }) as any)
    await pagar(camino, {})
    expect(centavosCobrados(camino)).toBe(85000)
  })

  it('expectedTotal igual al total (en centavos) deja pasar', async () => {
    prismaMock.paymentLink.findUnique.mockResolvedValue(liga(camino, { discount: MANUAL_15 }) as any)
    await pagar(camino, { tipAmount: 50, expectedTotal: 900.001 })
    expect(centavosCobrados(camino)).toBe(90000)
  })

  it('expectedTotal 1000 con total 850 → 409 PAYMENT_LINK_PRICE_CHANGED con el desglose nuevo, sin cobrar', async () => {
    prismaMock.paymentLink.findUnique.mockResolvedValue(liga(camino, { discount: MANUAL_15 }) as any)
    await expect(pagar(camino, { expectedTotal: 1000 })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PAYMENT_LINK_PRICE_CHANGED',
      details: { desglose: expect.objectContaining({ base: 1000, descuento: 150, neto: 850, aplica: true }) },
    })
    noSeLlamoAlProveedor()
  })

  it('abierta: escribe 100 con −$150 → 400 «El descuento es mayor que el importe», sin cobrar', async () => {
    prismaMock.paymentLink.findUnique.mockResolvedValue(
      liga(camino, {
        amountType: 'OPEN',
        amount: null,
        discount: { ...MANUAL_15, type: 'FIXED_AMOUNT', value: 150 },
      }) as any,
    )
    await expect(pagar(camino, { amount: 100 })).rejects.toMatchObject({ statusCode: 400, message: 'El descuento es mayor que el importe' })
    noSeLlamoAlProveedor()
  })

  it('abierta: 99.99 %, escribe 10 y propina 10 → 400 (neto 0 nunca se cobra)', async () => {
    prismaMock.paymentLink.findUnique.mockResolvedValue(
      liga(camino, { amountType: 'OPEN', amount: null, discount: { ...MANUAL_15, value: 99.99 } }) as any,
    )
    await expect(pagar(camino, { amount: 10, tipAmount: 10 })).rejects.toMatchObject({
      statusCode: 400,
      message: 'El descuento es mayor que el importe',
    })
    noSeLlamoAlProveedor()
  })

  it('descuento del catálogo vencido → cobra la base 1000 sin descuento y sin clave descuento', async () => {
    const foto = { ...MANUAL_15, origen: 'CATALOGO', discountId: 'cdisc0000000000000000001' }
    prismaMock.paymentLink.findUnique.mockResolvedValue(liga(camino, { discount: foto, discountId: foto.discountId }) as any)
    prismaMock.discount.findUnique.mockResolvedValue({
      active: true,
      validFrom: null,
      validUntil: new Date('2020-01-01'),
      daysOfWeek: [],
      timeFrom: null,
      timeUntil: null,
      minPurchaseAmount: null,
      maxDiscountAmount: null,
      scope: 'ORDER',
      type: 'PERCENTAGE',
      requiresApproval: false,
      isAutomatic: false,
      buyQuantity: null,
      getQuantity: null,
      getDiscountPercent: null,
      buyItemIds: [],
      getItemIds: [],
      maxTotalUses: null,
      maxUsesPerCustomer: null,
      customerGroupId: null,
    } as any)
    await pagar(camino, {})
    expect(centavosCobrados(camino)).toBe(100000)
    expect(metadataDeSesion()).not.toHaveProperty('descuento')
  })

  it('liga con productos: la base es el total vivo del paquete', async () => {
    prismaMock.paymentLink.findUnique.mockResolvedValue(
      liga(camino, {
        purpose: 'ITEM',
        discount: MANUAL_15,
        items: [
          { id: 'i1', quantity: 1, product: { id: 'p1', name: 'A', price: new Decimal(600) }, modifiers: [] },
          { id: 'i2', quantity: 1, product: { id: 'p2', name: 'B', price: new Decimal(400) }, modifiers: [] },
        ],
      }) as any,
    )
    await pagar(camino, { tipAmount: 50 })
    expect(centavosCobrados(camino)).toBe(90000)
    expect(metadataDeSesion().descuento).toEqual({ foto: MANUAL_15, descuento: 150, base: 1000 })
  })

  it('liga sin descuento → mismo monto y metadata que hoy (sin clave descuento, sin leer la zona)', async () => {
    prismaMock.paymentLink.findUnique.mockResolvedValue(liga(camino) as any)
    await pagar(camino, { tipAmount: 50 })
    expect(centavosCobrados(camino)).toBe(105000)
    expect(metadataDeSesion()).not.toHaveProperty('descuento')
    expect(prismaMock.venue.findUnique).not.toHaveBeenCalled()
  })
})

describe.each([...STRIPE, 'MercadoPago' as Camino])('%s: mínimo del procesador con descuento', camino => {
  it('neto positivo menor al mínimo, aunque la propina lo complete → 400 sin cobrar', async () => {
    // Stripe: mínimo $10; MP: $5. Neto $4 + propina $10 pasaría el mínimo, pero el neto solo no.
    prismaMock.paymentLink.findUnique.mockResolvedValue(
      liga(camino, { amount: new Decimal(20), discount: { ...MANUAL_15, type: 'FIXED_AMOUNT', value: 16 } }) as any,
    )
    await expect(pagar(camino, { tipAmount: 10 })).rejects.toMatchObject({ statusCode: 400 })
    noSeLlamoAlProveedor()
  })
})

describe.each(STRIPE)('%s: regresión sin descuento', camino => {
  it('abierta SIN descuento, $9 + propina $1 con mínimo $10 → se cobra $10 como hoy', async () => {
    prismaMock.paymentLink.findUnique.mockResolvedValue(liga(camino, { amountType: 'OPEN', amount: null }) as any)
    await pagar(camino, { amount: 9, tipAmount: 1 })
    expect(centavosCobrados(camino)).toBe(1000)
  })
})
