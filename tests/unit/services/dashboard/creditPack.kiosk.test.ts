/**
 * Compra de paquete en el kiosco (D3 del pizarrón, Fase 0.a del modo autoservicio).
 *
 * Antes el endpoint contestaba siempre `url: null` (leía un campo que no existe) y, aunque se
 * corrigiera el nombre, la sesión de Stripe salía SIN contacto: Stripe cobraba y el webhook
 * reventaba en `findOrCreateCustomer` — dinero cobrado, clases nunca entregadas.
 */

// Mock Stripe BEFORE any imports
const mockStripeCheckoutCreate = jest.fn()
const mockStripeCheckoutRetrieve = jest.fn()

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    checkout: { sessions: { create: mockStripeCheckoutCreate, retrieve: mockStripeCheckoutRetrieve } },
  }))
})

import { prismaMock } from '../../../__helpers__/setup'

jest.mock('@/utils/serializableRetry', () => ({
  withSerializableRetry: jest.fn((fn: any) => fn(prismaMock)),
}))

jest.mock('@/services/superadmin/platformSettings.service', () => ({
  getVatRateBps: jest.fn().mockResolvedValue(1600),
}))

jest.mock('@/services/public/customerPhoneLookup', () => ({ findCustomerIdByPhone: jest.fn() }))

jest.mock('@/services/payments/ecommerceCapability', () => ({
  resolveChargeableStripeMerchant: jest.fn(),
}))

import {
  createCheckoutSession,
  createKioskPackCheckout,
  getKioskPackCheckoutStatus,
} from '../../../../src/services/dashboard/creditPack.public.service'
import { BadRequestError, ForbiddenError, NotFoundError } from '../../../../src/errors/AppError'
import { findCustomerIdByPhone as findCustomerIdByPhoneReal } from '@/services/public/customerPhoneLookup'
import { resolveChargeableStripeMerchant as resolveMerchantReal } from '@/services/payments/ecommerceCapability'
import { Decimal } from '@prisma/client/runtime/library'

const findCustomerIdByPhone = findCustomerIdByPhoneReal as jest.Mock
const resolveChargeableStripeMerchant = resolveMerchantReal as jest.Mock

const VENUE_ID = 'venue-123'
const CUSTOMER_ID = 'cust-456'
const PACK_ID = 'pack-123'
const PHONE = '+525512345678'
const MERCHANT = { id: 'm1', platformFeeBps: 100, providerCredentials: { connectAccountId: 'acct_1' } }
const STRIPE_SESSION = { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/cs_test_1', expires_at: 1793200000 }

const createMockPack = () => ({
  id: PACK_ID,
  venueId: VENUE_ID,
  name: '10 clases',
  description: null,
  price: new Decimal(1500),
  currency: 'MXN',
  validityDays: 30,
  maxPerCustomer: null,
  active: true,
})

function mocksDeVenta() {
  resolveChargeableStripeMerchant.mockResolvedValue(MERCHANT)
  prismaMock.venue.findUnique.mockResolvedValue({ slug: 'mindform' } as any)
  prismaMock.creditPack.findFirst.mockResolvedValue(createMockPack() as any)
  mockStripeCheckoutCreate.mockResolvedValue(STRIPE_SESSION)
}

beforeEach(() => {
  // clearAllMocks no borra los mockResolvedValue: sin esto, el switch de aprobación de una prueba
  // se quedaría prendido en las siguientes.
  prismaMock.reservationSettings.findUnique.mockResolvedValue(null)
})

describe('createKioskPackCheckout', () => {
  it('teléfono de una clienta existente → la sesión lleva su customerId y el teléfono', async () => {
    mocksDeVenta()
    findCustomerIdByPhone.mockResolvedValue(CUSTOMER_ID)
    prismaMock.customer.findFirst.mockResolvedValue({ id: CUSTOMER_ID } as any)

    const out = await createKioskPackCheckout({ venueId: VENUE_ID, packId: PACK_ID, phone: PHONE })

    expect(out).toEqual({ url: STRIPE_SESSION.url, sessionId: 'cs_test_1', expiresAt: new Date(1793200000 * 1000).toISOString() })
    expect(prismaMock.customer.findFirst).toHaveBeenCalledWith({ where: { id: CUSTOMER_ID, venueId: VENUE_ID }, select: { id: true } })
    const [params, options] = mockStripeCheckoutCreate.mock.calls[0]
    expect(params.metadata).toMatchObject({
      type: 'credit_pack_purchase',
      venueId: VENUE_ID,
      packId: PACK_ID,
      customerId: CUSTOMER_ID,
      customerPhone: PHONE,
    })
    expect(options).toEqual(expect.objectContaining({ stripeAccount: 'acct_1' }))
    // Las URLs de regreso se mudaron del controlador al servicio, sin cambiar.
    expect(params.success_url).toMatch(/\/mindform\?packs=1&ok=1$/)
    expect(params.cancel_url).toMatch(/\/mindform\?packs=1$/)
  })

  it('🔒 nunca le enseña a quien escanea el correo de la ficha que encontró por teléfono', async () => {
    // El kiosco está en la entrada: cualquiera teclea cualquier número. Si la sesión llevara el
    // correo de esa ficha, la página de Stripe lo pintaría en el teléfono de quien escanea.
    mocksDeVenta()
    findCustomerIdByPhone.mockResolvedValue(CUSTOMER_ID)
    prismaMock.customer.findFirst.mockResolvedValue({ id: CUSTOMER_ID, email: 'ana@x.mx' } as any)

    await createKioskPackCheckout({ venueId: VENUE_ID, packId: PACK_ID, phone: PHONE })

    const [params] = mockStripeCheckoutCreate.mock.calls[0]
    expect(params).not.toHaveProperty('customer_email')
    expect(params.metadata).not.toHaveProperty('customerEmail')
  })

  it('🔴 la sesión sólo acepta TARJETA: un pago diferido (OXXO) se cobraría sin entregar las clases', async () => {
    // Codex r1 (D3): con OXXO prendido en la cuenta Connect, `checkout.session.completed` llega sin pagar,
    // el webhook no entrega y nadie atiende `async_payment_succeeded`.
    mocksDeVenta()
    findCustomerIdByPhone.mockResolvedValue(null)

    await createKioskPackCheckout({ venueId: VENUE_ID, packId: PACK_ID, phone: PHONE })

    expect(mockStripeCheckoutCreate.mock.calls[0][0].payment_method_types).toEqual(['card'])
  })

  it('teléfono que no está en el negocio → sesión de invitada: customerPhone y SIN customerId', async () => {
    mocksDeVenta()
    findCustomerIdByPhone.mockResolvedValue(null)

    await createKioskPackCheckout({ venueId: VENUE_ID, packId: PACK_ID, phone: PHONE })

    const meta = mockStripeCheckoutCreate.mock.calls[0][0].metadata
    expect(meta.customerPhone).toBe(PHONE)
    expect(meta).not.toHaveProperty('customerId')
    expect(prismaMock.customer.findFirst).not.toHaveBeenCalled()
  })

  it('Stripe sin url → BadRequestError; nunca contesta { url: null }', async () => {
    mocksDeVenta()
    findCustomerIdByPhone.mockResolvedValue(null)
    mockStripeCheckoutCreate.mockResolvedValue({ ...STRIPE_SESSION, url: null })

    await expect(createKioskPackCheckout({ venueId: VENUE_ID, packId: PACK_ID, phone: PHONE })).rejects.toBeInstanceOf(BadRequestError)
  })

  it('local inexistente → NotFoundError y no se toca Stripe', async () => {
    prismaMock.venue.findUnique.mockResolvedValue(null)

    await expect(createKioskPackCheckout({ venueId: VENUE_ID, packId: PACK_ID, phone: PHONE })).rejects.toBeInstanceOf(NotFoundError)
    expect(mockStripeCheckoutCreate).not.toHaveBeenCalled()
  })

  it('🔴 negocio que exige cuenta aprobada y teléfono nuevo → 403, NUNCA 401 (un 401 le cierra la sesión al aparato)', async () => {
    mocksDeVenta()
    findCustomerIdByPhone.mockResolvedValue(null)
    prismaMock.reservationSettings.findUnique.mockResolvedValue({ requireCustomerApproval: true } as any)

    const err = await createKioskPackCheckout({ venueId: VENUE_ID, packId: PACK_ID, phone: PHONE }).catch(e => e)

    expect(err).toBeInstanceOf(ForbiddenError)
    expect(err.statusCode).toBe(403)
    expect(mockStripeCheckoutCreate).not.toHaveBeenCalled()
  })
})

describe('createCheckoutSession (regresión: widget y app de clientes siguen leyendo checkoutUrl)', () => {
  it('sigue devolviendo checkoutUrl y ahora también sessionId y expiresAt', async () => {
    mocksDeVenta()
    mockStripeCheckoutCreate.mockResolvedValue({ id: 'cs_w', url: 'https://checkout.stripe.com/c/cs_w' })

    const out = await createCheckoutSession(VENUE_ID, PACK_ID, 'maria@x.mx', PHONE, 'https://ok', 'https://cancel')

    expect(out).toEqual({ checkoutUrl: 'https://checkout.stripe.com/c/cs_w', sessionId: 'cs_w', expiresAt: null })
    // El widget sí manda el correo que escribió quien compra: eso no cambia.
    expect(mockStripeCheckoutCreate.mock.calls[0][0].customer_email).toBe('maria@x.mx')
  })

  it('🔴 el widget también: sólo tarjeta (mismo hueco del pago diferido)', async () => {
    mocksDeVenta()
    mockStripeCheckoutCreate.mockResolvedValue({ id: 'cs_w', url: 'https://checkout.stripe.com/c/cs_w' })

    await createCheckoutSession(VENUE_ID, PACK_ID, 'maria@x.mx', PHONE, 'https://ok', 'https://cancel')

    expect(mockStripeCheckoutCreate.mock.calls[0][0].payment_method_types).toEqual(['card'])
  })
})

describe('getKioskPackCheckoutStatus', () => {
  it('PAID cuando ya existe la compra de esa sesión EN ESTE negocio, sin preguntarle a Stripe', async () => {
    prismaMock.creditPackPurchase.findFirst.mockResolvedValue({ id: 'p1' } as any)

    await expect(getKioskPackCheckoutStatus({ venueId: VENUE_ID, sessionId: 'cs_test_1' })).resolves.toBe('PAID')
    expect(prismaMock.creditPackPurchase.findFirst).toHaveBeenCalledWith({
      where: { stripeCheckoutSessionId: 'cs_test_1', venueId: VENUE_ID },
      select: { id: true },
    })
    expect(mockStripeCheckoutRetrieve).not.toHaveBeenCalled()
  })

  it('EXPIRED cuando Stripe dice expired', async () => {
    prismaMock.creditPackPurchase.findFirst.mockResolvedValue(null)
    resolveChargeableStripeMerchant.mockResolvedValue(MERCHANT)
    mockStripeCheckoutRetrieve.mockResolvedValue({ status: 'expired', metadata: { type: 'credit_pack_purchase', venueId: VENUE_ID } })

    await expect(getKioskPackCheckoutStatus({ venueId: VENUE_ID, sessionId: 'cs_test_1' })).resolves.toBe('EXPIRED')
  })

  it('OPEN cuando Stripe ya cobró pero el webhook todavía no entrega (las clases aún no son suyas)', async () => {
    prismaMock.creditPackPurchase.findFirst.mockResolvedValue(null)
    resolveChargeableStripeMerchant.mockResolvedValue(MERCHANT)
    mockStripeCheckoutRetrieve.mockResolvedValue({
      status: 'complete',
      payment_status: 'paid',
      metadata: { type: 'credit_pack_purchase', venueId: VENUE_ID },
    })

    await expect(getKioskPackCheckoutStatus({ venueId: VENUE_ID, sessionId: 'cs_test_1' })).resolves.toBe('OPEN')
  })

  it('sesión de otro negocio → NotFoundError', async () => {
    prismaMock.creditPackPurchase.findFirst.mockResolvedValue(null)
    resolveChargeableStripeMerchant.mockResolvedValue(MERCHANT)
    mockStripeCheckoutRetrieve.mockResolvedValue({ status: 'expired', metadata: { type: 'credit_pack_purchase', venueId: 'otro' } })

    await expect(getKioskPackCheckoutStatus({ venueId: VENUE_ID, sessionId: 'cs_test_1' })).rejects.toBeInstanceOf(NotFoundError)
  })

  it('sesión que no es de paquete (p. ej. un depósito de reserva) → NotFoundError', async () => {
    prismaMock.creditPackPurchase.findFirst.mockResolvedValue(null)
    resolveChargeableStripeMerchant.mockResolvedValue(MERCHANT)
    mockStripeCheckoutRetrieve.mockResolvedValue({ status: 'open', metadata: { type: 'reservation_deposit', venueId: VENUE_ID } })

    await expect(getKioskPackCheckoutStatus({ venueId: VENUE_ID, sessionId: 'cs_test_1' })).rejects.toBeInstanceOf(NotFoundError)
  })

  it('Stripe no la conoce → NotFoundError', async () => {
    prismaMock.creditPackPurchase.findFirst.mockResolvedValue(null)
    resolveChargeableStripeMerchant.mockResolvedValue(MERCHANT)
    mockStripeCheckoutRetrieve.mockRejectedValue(Object.assign(new Error('No such checkout.session'), { code: 'resource_missing' }))

    await expect(getKioskPackCheckoutStatus({ venueId: VENUE_ID, sessionId: 'cs_test_1' })).rejects.toBeInstanceOf(NotFoundError)
  })

  it('sin cuenta Connect del negocio → OPEN (no inventa un desenlace)', async () => {
    prismaMock.creditPackPurchase.findFirst.mockResolvedValue(null)
    resolveChargeableStripeMerchant.mockResolvedValue(null)

    await expect(getKioskPackCheckoutStatus({ venueId: VENUE_ID, sessionId: 'cs_test_1' })).resolves.toBe('OPEN')
    expect(mockStripeCheckoutRetrieve).not.toHaveBeenCalled()
  })

  it('consulta a Stripe en la cuenta Connect del negocio', async () => {
    prismaMock.creditPackPurchase.findFirst.mockResolvedValue(null)
    resolveChargeableStripeMerchant.mockResolvedValue(MERCHANT)
    mockStripeCheckoutRetrieve.mockResolvedValue({ status: 'open', metadata: { type: 'credit_pack_purchase', venueId: VENUE_ID } })

    await getKioskPackCheckoutStatus({ venueId: VENUE_ID, sessionId: 'cs_test_1' })

    expect(mockStripeCheckoutRetrieve).toHaveBeenCalledWith('cs_test_1', undefined, { stripeAccount: 'acct_1' })
  })
})
