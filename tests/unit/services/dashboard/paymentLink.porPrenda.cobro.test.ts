/**
 * Liga por prenda (Task 5): la clienta escoge la talla en la página y se le aparta mientras paga.
 * Sólo Stripe Elements con tarjeta; una ficha = un intento (llave `plhold:<ficha>`); cada consulta o cancelación de un
 * intento ya creado va con la cuenta CONGELADA en la ficha; un error al crear el intento NO suelta la ficha.
 * Las fichas (Task 3) y Stripe se simulan; la carrera real de las fichas está en la integración de la Task 3.
 */
jest.mock('@/services/venueSalesGuard', () => ({ __esModule: true, assertVenueSalesEnabled: jest.fn() }))
jest.mock('@/services/superadmin/platformSettings.service', () => ({ getVatRateBps: jest.fn().mockResolvedValue(1600) }))
jest.mock('@/services/access/basePlan.service', () => ({ __esModule: true, venueHasFeatureAccess: jest.fn() }))
jest.mock('@/services/mercado-pago/connection.service', () => ({
  loadCredentials: jest.fn().mockResolvedValue({ accessToken: 'fixture', publicKey: 'pk', mpUserId: 1, expiresAt: new Date('2099-01-01') }),
}))
const piCreate = jest.fn()
const piRetrieve = jest.fn()
const piCancel = jest.fn()
jest.mock('stripe', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ paymentIntents: { create: piCreate, retrieve: piRetrieve, cancel: piCancel } })),
}))
jest.mock('nanoid', () => ({ nanoid: jest.fn(() => 'abc12345') }))
const providerCreateCheckout = jest.fn()
const providerTokenize = jest.fn()
jest.mock('@/services/payments/provider-registry', () => ({
  getProvider: () => ({ createCheckoutSession: providerCreateCheckout, tokenizeCard: providerTokenize }),
}))
jest.mock('@/services/dashboard/paymentLinkStockHold.service', () => ({
  __esModule: true,
  takeOrReuseHold: jest.fn(),
  freezeIntentParams: jest.fn(),
  attachIntent: jest.fn(),
  releaseHold: jest.fn(),
  variantAvailability: jest.fn(),
}))

import {
  completeCharge,
  createCheckoutSession,
  createMercadoPagoPaymentIntentForPaymentLink,
  createStripeCheckoutForPaymentLink,
  createStripePaymentIntentForPaymentLink,
  executeMercadoPagoPaymentForPaymentLink,
  getPaymentLinkByShortCode,
} from '../../../../src/services/dashboard/paymentLink.service'
import {
  attachIntent,
  freezeIntentParams,
  releaseHold,
  takeOrReuseHold,
  variantAvailability,
} from '../../../../src/services/dashboard/paymentLinkStockHold.service'
import { venueHasFeatureAccess } from '../../../../src/services/access/basePlan.service'
import { ConflictError } from '../../../../src/errors/AppError'
import { prismaMock } from '../../../__helpers__/setup'
import { Decimal } from '@prisma/client/runtime/library'

const VENUE = 'cvenue0000000000000000001'
const GROUP = 'cgroup0000000000000000001'
const TALLA_M = 'ctallam000000000000000001'
const TOKEN = 'tok_abcdefghijklmnop'
const EXPIRA = new Date('2026-11-12T18:15:00Z')

const take = takeOrReuseHold as jest.Mock
const freeze = freezeIntentParams as jest.Mock
const attach = attachIntent as jest.Mock
const release = releaseHold as jest.Mock
const disponibilidad = variantAvailability as jest.Mock
const plan = venueHasFeatureAccess as jest.Mock

function liga(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cplink00000000000000000001',
    shortCode: 'abc12345',
    venueId: VENUE,
    purpose: 'ITEM',
    title: 'Blusa',
    description: null,
    imageUrl: null,
    amountType: 'FIXED',
    amount: null,
    currency: 'MXN',
    isReusable: true,
    expiresAt: null,
    status: 'ACTIVE',
    paymentCount: 0,
    customerId: null,
    customFields: null,
    tippingConfig: { enabled: true, presets: [10] },
    discount: null,
    discountId: null,
    redirectUrl: null,
    productGroupId: GROUP,
    items: [],
    venue: {
      id: VENUE,
      name: 'IQ',
      slug: 'iq',
      logo: null,
      primaryColor: null,
      secondaryColor: null,
      paymentLinkBranding: null,
      phone: null,
      timezone: 'America/Mexico_City',
    },
    ecommerceMerchant: {
      id: 'cmerch0000000000000000001',
      provider: { code: 'STRIPE_CONNECT' },
      chargesEnabled: true,
      platformFeeBps: 100,
      providerCredentials: { connectAccountId: 'acct_A' },
    },
    ...overrides,
  }
}

const talla = (o: Record<string, unknown> = {}) => ({
  id: TALLA_M,
  name: 'Blusa · M',
  price: new Decimal(500),
  active: true,
  deletedAt: null,
  productGroup: { deletedAt: null },
  ...o,
})

/** Ficha como la devuelve la Task 3. */
const ficha = (o: Record<string, unknown> = {}) => ({
  id: 'chold00000000000000000001',
  status: 'ACTIVE',
  productId: TALLA_M,
  amountCents: 50000,
  stripeAccountId: null,
  intentParams: null,
  checkoutSnapshot: null,
  stripePaymentIntentId: null,
  expiresAt: EXPIRA,
  ...o,
})

/** El freeze real: congela si no había parámetros y devuelve la ficha como quedó. */
function freezeReal() {
  freeze.mockImplementation(async (holdId: string, args: any) => ficha({ id: holdId, ...args }))
}

const pagar = (input: Record<string, unknown> = {}) =>
  createStripePaymentIntentForPaymentLink('abc12345', { productId: TALLA_M, browserToken: TOKEN, ...input } as any)

beforeEach(() => {
  process.env.STRIPE_PUBLISHABLE_KEY = 'fixture-public-key'
  plan.mockReset().mockResolvedValue(true)
  take.mockReset().mockResolvedValue({ hold: ficha(), reused: false, released: [] })
  freeze.mockReset()
  freezeReal()
  attach.mockReset().mockResolvedValue(undefined)
  release.mockReset().mockResolvedValue(undefined)
  disponibilidad.mockReset()
  piCreate.mockReset().mockResolvedValue({ id: 'pi_nuevo', client_secret: 'secret_nuevo', status: 'requires_payment_method' })
  piRetrieve.mockReset()
  piCancel.mockReset().mockResolvedValue({})
  providerCreateCheckout.mockReset()
  providerTokenize.mockReset()
  prismaMock.paymentLink.findUnique.mockResolvedValue(liga() as any)
  prismaMock.product.findFirst.mockResolvedValue(talla() as any)
  prismaMock.checkoutSession.createMany.mockResolvedValue({ count: 1 } as any)
  prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' } as any)
  ;(prismaMock as any).paymentLinkStockHold = fichas
})

/** El mock global de Prisma no trae la tabla de fichas: sólo hace falta releerla tras un choque de `attachIntent`. */
const fichas = { findUnique: jest.fn() }

const sesionCreada = () => prismaMock.checkoutSession.createMany.mock.calls.at(-1)![0] as any

describe('POST payment-intent de la liga por prenda', () => {
  it('aparta la talla y crea el intento SÓLO con tarjeta, con la llave de la ficha y la metadata de esa talla', async () => {
    const r = await pagar({ tipAmount: 50, customerEmail: 'ana@example.test' })

    expect(plan).toHaveBeenCalledWith(VENUE, 'PRODUCT_VARIANTS')
    expect(prismaMock.product.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: TALLA_M, venueId: VENUE, productGroupId: GROUP } }),
    )
    // 500 de la talla + 50 de propina, en centavos, ANTES de apartar.
    expect(take).toHaveBeenCalledWith({
      paymentLinkId: 'cplink00000000000000000001',
      venueId: VENUE,
      productId: TALLA_M,
      browserToken: TOKEN,
      amountCents: 55000,
    })
    const [params, opciones] = piCreate.mock.calls[0]
    expect(opciones).toEqual({ stripeAccount: 'acct_A', idempotencyKey: 'plhold:chold00000000000000000001' })
    expect(params.payment_method_types).toEqual(['card'])
    expect(params.automatic_payment_methods).toBeUndefined()
    expect(params.amount).toBe(55000)
    expect(JSON.parse(params.metadata.items)).toEqual([
      { productId: TALLA_M, productName: 'Blusa · M', quantity: 1, unitPrice: 500, modifiers: [] },
    ])
    expect(params.metadata).toMatchObject({ purpose: 'ITEM', itemCount: '1', tipAmount: '50' })

    // La sesión local sale de la foto congelada y nunca pisa una existente.
    const { data, skipDuplicates } = sesionCreada()
    expect(skipDuplicates).toBe(true)
    expect(data[0]).toMatchObject({ sessionId: 'pi_nuevo', customerEmail: 'ana@example.test', status: 'PENDING' })
    expect(Number(data[0].amount)).toBe(550)
    expect(data[0].metadata).toMatchObject({
      purpose: 'ITEM',
      tipAmount: 50,
      items: [{ productId: TALLA_M, productName: 'Blusa · M', quantity: 1, unitPrice: 500, modifiers: [] }],
    })
    expect(attach).toHaveBeenCalledWith('chold00000000000000000001', 'pi_nuevo')
    expect(r).toMatchObject({
      paymentIntentId: 'pi_nuevo',
      clientSecret: 'secret_nuevo',
      connectAccountId: 'acct_A',
      amount: 550,
      currency: 'MXN',
      holdExpiresAt: EXPIRA.toISOString(),
    })
  })

  it('sin talla → 400 sin apartar', async () => {
    await expect(pagar({ productId: undefined })).rejects.toMatchObject({ statusCode: 400 })
    expect(take).not.toHaveBeenCalled()
    expect(piCreate).not.toHaveBeenCalled()
  })

  it('sin plan → 403 «no disponible», sin apartar ni crear intento', async () => {
    plan.mockResolvedValue(false)
    await expect(pagar()).rejects.toMatchObject({ statusCode: 403, code: 'PAYMENT_LINK_VARIANT_UNAVAILABLE' })
    expect(take).not.toHaveBeenCalled()
    expect(piCreate).not.toHaveBeenCalled()
  })

  it('talla de otra familia u otro negocio → 400 «no pertenece», sin ficha ni intento', async () => {
    prismaMock.product.findFirst.mockResolvedValue(null)
    await expect(pagar()).rejects.toMatchObject({ statusCode: 400, message: 'Esa talla no pertenece a esta prenda' })
    expect(take).not.toHaveBeenCalled()
    expect(piCreate).not.toHaveBeenCalled()
  })

  it.each([
    ['archivada', { deletedAt: new Date() }],
    ['apagada', { active: false }],
    ['de una familia borrada', { productGroup: { deletedAt: new Date() } }],
  ])('talla %s → 409 PAYMENT_LINK_VARIANT_UNAVAILABLE sin apartar', async (_n, o) => {
    prismaMock.product.findFirst.mockResolvedValue(talla(o) as any)
    await expect(pagar()).rejects.toMatchObject({ statusCode: 409, code: 'PAYMENT_LINK_VARIANT_UNAVAILABLE' })
    expect(take).not.toHaveBeenCalled()
  })

  it('sin existencia → 409 PAYMENT_LINK_VARIANT_SOLD_OUT sin crear intento', async () => {
    take.mockRejectedValue(new ConflictError('Esa talla se agotó', 'PAYMENT_LINK_VARIANT_SOLD_OUT'))
    await expect(pagar()).rejects.toMatchObject({ statusCode: 409, code: 'PAYMENT_LINK_VARIANT_SOLD_OUT' })
    expect(piCreate).not.toHaveBeenCalled()
    expect(prismaMock.checkoutSession.createMany).not.toHaveBeenCalled()
  })

  it('precio de la página distinto → 409 PAYMENT_LINK_PRICE_CHANGED antes de apartar', async () => {
    await expect(pagar({ expectedTotal: 450 })).rejects.toMatchObject({ statusCode: 409, code: 'PAYMENT_LINK_PRICE_CHANGED' })
    expect(take).not.toHaveBeenCalled()
  })

  it('precio cambiado de la talla → aparta con el importe nuevo (la ficha con otro importe no se reusa)', async () => {
    prismaMock.product.findFirst.mockResolvedValue(talla({ price: new Decimal(520) }) as any)
    await pagar()
    expect(take.mock.calls[0][0].amountCents).toBe(52000)
    expect(piCreate.mock.calls[0][0].amount).toBe(52000)
  })

  it('dos POST del mismo token y talla → la misma ficha, la misma llave y los mismos parámetros: un solo intento', async () => {
    const congelada = await (async () => {
      await pagar()
      return freeze.mock.calls[0][1]
    })()
    // El segundo llega con la ficha ya congelada (el CAS no la pisa): freeze devuelve los parámetros del primero.
    freeze.mockImplementation(async () => ficha(congelada))
    await pagar({ customerEmail: 'otra@example.test' })
    expect(piCreate).toHaveBeenCalledTimes(2)
    expect(piCreate.mock.calls[1][1]).toEqual(piCreate.mock.calls[0][1])
    expect(piCreate.mock.calls[1][0]).toEqual(piCreate.mock.calls[0][0])
  })

  describe.each(['requires_payment_method', 'requires_confirmation', 'requires_action'])('recarga con el intento en %s', estado => {
    it('devuelve ESE intento, consultado con la cuenta congelada, sin crear otro', async () => {
      prismaMock.paymentLink.findUnique.mockResolvedValue(
        liga({ ecommerceMerchant: { ...liga().ecommerceMerchant, providerCredentials: { connectAccountId: 'acct_B' } } }) as any,
      )
      take.mockResolvedValue({
        hold: ficha({
          stripePaymentIntentId: 'pi_viejo',
          stripeAccountId: 'acct_A',
          checkoutSnapshot: { amount: '500.00', currency: 'MXN', applicationFeeCents: 580 },
        }),
        reused: true,
        released: [],
      })
      piRetrieve.mockResolvedValue({ id: 'pi_viejo', client_secret: 'secret_viejo', status: estado })
      const r = await pagar()
      expect(piRetrieve).toHaveBeenCalledWith('pi_viejo', undefined, { stripeAccount: 'acct_A' })
      expect(piCreate).not.toHaveBeenCalled()
      expect(prismaMock.checkoutSession.createMany).not.toHaveBeenCalled()
      expect(r).toMatchObject({
        paymentIntentId: 'pi_viejo',
        clientSecret: 'secret_viejo',
        connectAccountId: 'acct_A',
        amount: 500,
        applicationFeeCents: 580,
        holdExpiresAt: EXPIRA.toISOString(),
      })
    })
  })

  it('recarga con el intento en processing → 409 PAYMENT_LINK_PAYMENT_IN_PROGRESS, sin crear otro', async () => {
    take.mockResolvedValue({ hold: ficha({ stripePaymentIntentId: 'pi_viejo', stripeAccountId: 'acct_A' }), reused: true, released: [] })
    piRetrieve.mockResolvedValue({ id: 'pi_viejo', status: 'processing' })
    await expect(pagar()).rejects.toMatchObject({ statusCode: 409, code: 'PAYMENT_LINK_PAYMENT_IN_PROGRESS' })
    expect(piCreate).not.toHaveBeenCalled()
  })

  it('recarga con el intento ya cobrado → alreadyPaid, sin crear otro', async () => {
    take.mockResolvedValue({ hold: ficha({ stripePaymentIntentId: 'pi_viejo', stripeAccountId: 'acct_A' }), reused: true, released: [] })
    piRetrieve.mockResolvedValue({ id: 'pi_viejo', status: 'succeeded' })
    await expect(pagar()).resolves.toEqual({ alreadyPaid: true, paymentIntentId: 'pi_viejo' })
    expect(piCreate).not.toHaveBeenCalled()
  })

  it('intento cancelado → suelta la ficha («intento_cancelado») y aparta otra con intento nuevo', async () => {
    take
      .mockResolvedValueOnce({ hold: ficha({ stripePaymentIntentId: 'pi_viejo', stripeAccountId: 'acct_A' }), reused: true, released: [] })
      .mockResolvedValueOnce({ hold: ficha({ id: 'chold00000000000000000002' }), reused: false, released: [] })
    piRetrieve.mockResolvedValue({ id: 'pi_viejo', status: 'canceled' })
    const r = await pagar()
    expect(release).toHaveBeenCalledWith('chold00000000000000000001', 'intento_cancelado')
    expect(take).toHaveBeenCalledTimes(2)
    expect(piCreate.mock.calls[0][1].idempotencyKey).toBe('plhold:chold00000000000000000002')
    expect(r).toMatchObject({ paymentIntentId: 'pi_nuevo' })
  })

  it('otra talla u otra propina → ficha nueva con intento nuevo y el de la vieja cancelado con SU cuenta', async () => {
    prismaMock.paymentLink.findUnique.mockResolvedValue(
      liga({ ecommerceMerchant: { ...liga().ecommerceMerchant, providerCredentials: { connectAccountId: 'acct_B' } } }) as any,
    )
    take.mockResolvedValue({
      hold: ficha({ id: 'chold00000000000000000002' }),
      reused: false,
      released: [
        { holdId: 'chold00000000000000000001', stripePaymentIntentId: 'pi_viejo', stripeAccountId: 'acct_A' },
        { holdId: 'chold00000000000000000003', stripePaymentIntentId: null, stripeAccountId: null },
      ],
    })
    await pagar()
    expect(piCancel).toHaveBeenCalledTimes(1)
    expect(piCancel).toHaveBeenCalledWith('pi_viejo', undefined, { stripeAccount: 'acct_A' })
    // La ficha NUEVA sí nace con la cuenta de hoy.
    expect(piCreate.mock.calls[0][1]).toEqual({ stripeAccount: 'acct_B', idempotencyKey: 'plhold:chold00000000000000000002' })
  })

  it('cancelar el intento de la ficha soltada falla → se registra y el cobro nuevo sigue', async () => {
    take.mockResolvedValue({
      hold: ficha({ id: 'chold00000000000000000002' }),
      reused: false,
      released: [{ holdId: 'chold00000000000000000001', stripePaymentIntentId: 'pi_viejo', stripeAccountId: 'acct_A' }],
    })
    piCancel.mockRejectedValue(new Error('Stripe caído'))
    await expect(pagar()).resolves.toMatchObject({ paymentIntentId: 'pi_nuevo' })
  })

  it('respuesta perdida al crear: el siguiente POST repite la MISMA llave y parámetros y la sesión sale de la foto congelada', async () => {
    piCreate.mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' }))
    await expect(pagar({ customerEmail: 'ana@example.test' })).rejects.toThrow('socket hang up')
    expect(release).not.toHaveBeenCalled()
    expect(prismaMock.checkoutSession.createMany).not.toHaveBeenCalled()
    const congelada = freeze.mock.calls[0][1]

    // Entretanto cambian el correo de la clienta y la comisión del comercio, y la cuenta conectada pasa a B.
    prismaMock.paymentLink.findUnique.mockResolvedValue(
      liga({
        ecommerceMerchant: { ...liga().ecommerceMerchant, platformFeeBps: 300, providerCredentials: { connectAccountId: 'acct_B' } },
      }) as any,
    )
    take.mockResolvedValue({ hold: ficha(congelada), reused: true, released: [] })
    freeze.mockImplementation(async () => ficha(congelada)) // el CAS no la pisa
    piCreate.mockResolvedValue({ id: 'pi_nuevo', client_secret: 'secret_nuevo' })
    const r = await pagar({ customerEmail: 'otra@example.test' })

    expect(piCreate.mock.calls[1][1]).toEqual(piCreate.mock.calls[0][1])
    expect(piCreate.mock.calls[1][0]).toEqual(piCreate.mock.calls[0][0])
    expect(piCreate.mock.calls[1][1].stripeAccount).toBe('acct_A')
    const { data } = sesionCreada()
    expect(data[0]).toMatchObject({
      sessionId: 'pi_nuevo',
      customerEmail: 'ana@example.test',
      applicationFeeCents: congelada.checkoutSnapshot.applicationFeeCents,
    })
    expect(data[0].metadata.items[0].productId).toBe(TALLA_M)
    expect(r).toMatchObject({ connectAccountId: 'acct_A', applicationFeeCents: congelada.checkoutSnapshot.applicationFeeCents })
  })

  it('conflicto concurrente de idempotencia en Stripe → se responde el error y la ficha se conserva', async () => {
    piCreate.mockRejectedValue(Object.assign(new Error('idempotency_key_in_use'), { type: 'StripeIdempotencyError', statusCode: 409 }))
    await expect(pagar()).rejects.toMatchObject({ statusCode: 409 })
    expect(release).not.toHaveBeenCalled()
    expect(attach).not.toHaveBeenCalled()
  })

  it('rechazo definitivo de Stripe al crear → se responde el error y la ficha sigue ACTIVA hasta vencer', async () => {
    piCreate.mockRejectedValue(Object.assign(new Error('Invalid request'), { type: 'StripeInvalidRequestError', statusCode: 400 }))
    await expect(pagar()).rejects.toMatchObject({ statusCode: 400 })
    expect(release).not.toHaveBeenCalled()
  })

  it('la ficha se soltó mientras se congelaba (otra pestaña cambió de talla) → 409 sin crear intento', async () => {
    freeze.mockImplementation(async (holdId: string, args: any) => ficha({ id: holdId, ...args, status: 'RELEASED' }))
    await expect(pagar()).rejects.toMatchObject({ statusCode: 409, code: 'PAYMENT_LINK_VARIANT_UNAVAILABLE' })
    expect(piCreate).not.toHaveBeenCalled()
  })

  it('perdió la carrera al congelar → crea el intento con los parámetros y la cuenta del GANADOR', async () => {
    freeze.mockImplementation(async (holdId: string, args: any) =>
      ficha({
        id: holdId,
        ...args,
        stripeAccountId: 'acct_A',
        intentParams: { ...args.intentParams, receipt_email: 'ganadora@example.test' },
      }),
    )
    prismaMock.paymentLink.findUnique.mockResolvedValue(
      liga({ ecommerceMerchant: { ...liga().ecommerceMerchant, providerCredentials: { connectAccountId: 'acct_B' } } }) as any,
    )
    await pagar({ customerEmail: 'perdedora@example.test' })
    expect(piCreate.mock.calls[0][0].receipt_email).toBe('ganadora@example.test')
    expect(piCreate.mock.calls[0][1].stripeAccount).toBe('acct_A')
  })

  it('attachIntent dice que la ficha ya no es ese intento → cancela el intento recién creado con la cuenta congelada y no lo devuelve', async () => {
    attach.mockRejectedValue(new ConflictError('x', 'PAYMENT_LINK_HOLD_INTENT_MISMATCH'))
    fichas.findUnique.mockResolvedValue({ status: 'RELEASED', stripePaymentIntentId: null } as any)
    await expect(pagar()).rejects.toMatchObject({ statusCode: 409, code: 'PAYMENT_LINK_VARIANT_UNAVAILABLE' })
    expect(piCancel).toHaveBeenCalledWith('pi_nuevo', undefined, { stripeAccount: 'acct_A' })
  })

  it('attachIntent choca porque la ficha ya se cerró con ese intento → alreadyPaid, sin cancelar', async () => {
    attach.mockRejectedValue(new ConflictError('x', 'PAYMENT_LINK_HOLD_INTENT_MISMATCH'))
    fichas.findUnique.mockResolvedValue({ status: 'CONSUMED', stripePaymentIntentId: 'pi_nuevo' } as any)
    await expect(pagar()).resolves.toEqual({ alreadyPaid: true, paymentIntentId: 'pi_nuevo' })
    expect(piCancel).not.toHaveBeenCalled()
  })
})

describe('los otros caminos rechazan la liga por prenda', () => {
  const MENSAJE = 'Esta liga sólo se paga con tarjeta desde su página de pago'
  const tarjeta = { pan: '4242424242424242', cvv: '123', expMonth: '12', expYear: '2030', holderName: 'Ana' }

  it('Stripe alojado', async () => {
    await expect(createStripeCheckoutForPaymentLink('abc12345', {} as any)).rejects.toMatchObject({ statusCode: 400, message: MENSAJE })
    expect(providerCreateCheckout).not.toHaveBeenCalled()
  })

  it('Blumon: abrir el cobro', async () => {
    prismaMock.paymentLink.findUnique.mockResolvedValue(liga({ ecommerceMerchant: { id: 'm', provider: { code: 'BLUMON' } } }) as any)
    await expect(createCheckoutSession('abc12345', tarjeta)).rejects.toMatchObject({ statusCode: 400, message: MENSAJE })
    expect(providerTokenize).not.toHaveBeenCalled()
    expect(prismaMock.checkoutSession.create).not.toHaveBeenCalled()
  })

  it('Blumon: cobrar una sesión', async () => {
    prismaMock.checkoutSession.findUnique.mockResolvedValue({
      id: 's1',
      status: 'PROCESSING',
      paymentLink: { shortCode: 'abc12345', venueId: VENUE, productGroupId: GROUP },
    } as any)
    await expect(completeCharge('abc12345', 'cs_1')).rejects.toMatchObject({ statusCode: 400, message: MENSAJE })
    expect(prismaMock.checkoutSession.updateMany).not.toHaveBeenCalled()
  })

  it('Mercado Pago: abrir el cobro', async () => {
    prismaMock.paymentLink.findUnique.mockResolvedValue(liga({ ecommerceMerchant: { id: 'm', provider: { code: 'MERCADO_PAGO' } } }) as any)
    await expect(createMercadoPagoPaymentIntentForPaymentLink('abc12345', {} as any)).rejects.toMatchObject({
      statusCode: 400,
      message: MENSAJE,
    })
    expect(prismaMock.checkoutSession.create).not.toHaveBeenCalled()
  })

  it('Mercado Pago: pagar una sesión', async () => {
    prismaMock.checkoutSession.findUnique.mockResolvedValue({
      id: 's1',
      status: 'PENDING',
      ecommerceMerchant: { provider: { code: 'MERCADO_PAGO' } },
      paymentLink: { shortCode: 'abc12345', venueId: VENUE, productGroupId: GROUP },
    } as any)
    await expect(
      executeMercadoPagoPaymentForPaymentLink('abc12345', 'cs_1', { paymentMethodId: 'visa', installments: 1, payer: { email: 'a@b.mx' } }),
    ).rejects.toMatchObject({ statusCode: 400, message: MENSAJE })
  })
})

describe('regresión: las ligas de siempre no cambian', () => {
  it.each([
    ['de importe', { purpose: 'PAYMENT', productGroupId: null, amount: new Decimal(1000) }],
    [
      'de producto fijo',
      {
        productGroupId: null,
        items: [
          {
            id: 'i1',
            quantity: 1,
            product: { id: 'cprod0000000000000000001', name: 'Gorra', price: new Decimal(300) },
            modifiers: [],
          },
        ],
      },
    ],
  ])('liga %s: automatic_payment_methods, llave de siempre y sin apartado', async (_n, o) => {
    prismaMock.paymentLink.findUnique.mockResolvedValue(liga(o) as any)
    prismaMock.checkoutSession.create.mockResolvedValue({} as any)
    piCreate.mockResolvedValue({ id: 'pi_x', client_secret: 's' })
    const r = await createStripePaymentIntentForPaymentLink('abc12345', {})
    const [params, opciones] = piCreate.mock.calls[0]
    expect(params.automatic_payment_methods).toEqual({ enabled: true })
    expect(params.payment_method_types).toBeUndefined()
    expect(opciones.idempotencyKey).toBe('paymentLink:cplink00000000000000000001:pi:abc12345')
    expect(take).not.toHaveBeenCalled()
    expect(plan).not.toHaveBeenCalled()
    expect(prismaMock.checkoutSession.create).toHaveBeenCalledTimes(1)
    expect(r).toMatchObject({ paymentIntentId: 'pi_x', connectAccountId: 'acct_A', holdExpiresAt: null })
  })
})

describe('GET público de la liga por prenda', () => {
  const familia = (o: Record<string, unknown> = {}) => ({
    id: GROUP,
    name: 'Blusa',
    description: 'Lino',
    imageUrl: 'https://img/blusa.jpg',
    deletedAt: null,
    options: [
      { name: 'Talla', values: [{ value: 'M' }, { value: 'L' }] },
      { name: 'Color', values: [{ value: 'Azul' }] },
    ],
    products: [
      {
        id: TALLA_M,
        price: new Decimal(500),
        imageUrl: null,
        variantValues: [
          { option: { name: 'Talla' }, optionValue: { value: 'M' } },
          { option: { name: 'Color' }, optionValue: { value: 'Azul' } },
        ],
      },
      {
        id: 'ctallal000000000000000001',
        price: new Decimal(520),
        imageUrl: 'https://img/l.jpg',
        variantValues: [
          { option: { name: 'Talla' }, optionValue: { value: 'L' } },
          { option: { name: 'Color' }, optionValue: { value: 'Azul' } },
        ],
      },
    ],
    ...o,
  })

  beforeEach(() => {
    prismaMock.productGroup.findFirst.mockResolvedValue(familia() as any)
    disponibilidad.mockResolvedValue([
      { productId: TALLA_M, available: true, heldByYou: false, heldUntil: null },
      { productId: 'ctallal000000000000000001', available: false, heldByYou: false, heldUntil: null },
    ])
  })

  it('trae ejes, valores, precio por talla y available SIN cantidades; baseAmount null e items vacíos', async () => {
    const r: any = await getPaymentLinkByShortCode('abc12345')
    expect(r.baseAmount).toBeNull()
    expect(r.items).toEqual([])
    expect(r.productGroup).toEqual({
      id: GROUP,
      name: 'Blusa',
      description: 'Lino',
      imageUrl: 'https://img/blusa.jpg',
      options: [
        { name: 'Talla', values: ['M', 'L'] },
        { name: 'Color', values: ['Azul'] },
      ],
      variants: [
        {
          productId: TALLA_M,
          values: { Talla: 'M', Color: 'Azul' },
          price: 500,
          imageUrl: null,
          available: true,
          heldByYou: false,
          heldUntil: null,
        },
        {
          productId: 'ctallal000000000000000001',
          values: { Talla: 'L', Color: 'Azul' },
          price: 520,
          imageUrl: 'https://img/l.jpg',
          available: false,
          heldByYou: false,
          heldUntil: null,
        },
      ],
      unavailableReason: null,
    })
    expect(JSON.stringify(r.productGroup)).not.toMatch(/stock|quantity/i)
    expect(disponibilidad).toHaveBeenCalledWith({ paymentLinkId: 'cplink00000000000000000001', productGroupId: GROUP, venueId: VENUE })
  })

  it('con ?t= marca la talla apartada por ese navegador (heldByYou) y su hora', async () => {
    disponibilidad.mockResolvedValue([{ productId: TALLA_M, available: true, heldByYou: true, heldUntil: EXPIRA }])
    const r: any = await getPaymentLinkByShortCode('abc12345', TOKEN)
    expect(disponibilidad).toHaveBeenCalledWith(expect.objectContaining({ browserToken: TOKEN }))
    expect(r.productGroup.variants[0]).toMatchObject({ heldByYou: true, heldUntil: EXPIRA.toISOString() })
  })

  it('sin plan → unavailableReason PLAN y ninguna talla disponible', async () => {
    plan.mockResolvedValue(false)
    const r: any = await getPaymentLinkByShortCode('abc12345')
    expect(r.productGroup.unavailableReason).toBe('PLAN')
    expect(r.productGroup.variants.every((v: any) => v.available === false)).toBe(true)
    expect(disponibilidad).not.toHaveBeenCalled()
  })

  it('familia borrada → la liga no está disponible', async () => {
    prismaMock.productGroup.findFirst.mockResolvedValue(familia({ deletedAt: new Date() }) as any)
    await expect(getPaymentLinkByShortCode('abc12345')).rejects.toMatchObject({ statusCode: 400 })
  })

  it('regresión: una liga de importe no trae productGroup ni consulta familias', async () => {
    prismaMock.paymentLink.findUnique.mockResolvedValue(
      liga({ purpose: 'PAYMENT', productGroupId: null, amount: new Decimal(1000) }) as any,
    )
    const r: any = await getPaymentLinkByShortCode('abc12345')
    expect(r.productGroup).toBeUndefined()
    expect(r.baseAmount).toBe(1000)
    expect(prismaMock.productGroup.findFirst).not.toHaveBeenCalled()
  })
})
