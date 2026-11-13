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
  restoreReleasedHold: jest.fn(),
  variantAvailability: jest.fn(),
  consumeHoldInTx: jest.fn(),
}))
// Task 6: el cierre (`finalizePaymentLinkCheckout`). El vale y la comisión se observan, no se prueban aquí.
const crearVale = jest.fn()
const aplicarVale = jest.fn()
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  __esModule: true,
  createSalePostingInTx: (...a: unknown[]) => crearVale(...a),
  applySalePosting: (...a: unknown[]) => aplicarVale(...a),
}))
jest.mock('@/services/tpv/paymentEffects.service', () => ({
  ...jest.requireActual('@/services/tpv/paymentEffects.service'),
  enqueuePaymentCommissionInTx: jest.fn(),
}))

import {
  completeCharge,
  createCheckoutSession,
  createMercadoPagoPaymentIntentForPaymentLink,
  createStripeCheckoutForPaymentLink,
  createStripePaymentIntentForPaymentLink,
  executeMercadoPagoPaymentForPaymentLink,
  finalizePaymentLinkCheckout,
  getPaymentLinkByShortCode,
} from '../../../../src/services/dashboard/paymentLink.service'
import {
  attachIntent,
  consumeHoldInTx,
  freezeIntentParams,
  releaseHold,
  restoreReleasedHold,
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
const EXPIRA = new Date('2099-11-12T18:15:00Z') // vigente: la revisión de previas compara contra la hora real

const take = takeOrReuseHold as jest.Mock
const freeze = freezeIntentParams as jest.Mock
const attach = attachIntent as jest.Mock
const release = releaseHold as jest.Mock
const restaurar = restoreReleasedHold as jest.Mock
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
  take.mockReset().mockResolvedValue({ hold: ficha(), reused: false, released: [], pendientes: [] })
  freeze.mockReset()
  freezeReal()
  attach.mockReset().mockResolvedValue(undefined)
  release.mockReset().mockResolvedValue(undefined)
  restaurar.mockReset().mockResolvedValue(true)
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
  fichas.findUnique.mockReset()
  fichas.findFirst.mockReset().mockResolvedValue(null)
  fichas.findMany.mockReset().mockResolvedValue([])
  fichas.updateMany.mockReset().mockResolvedValue({ count: 1 })
  ;(prismaMock as any).paymentLinkStockHold = fichas
})

/**
 * El mock global de Prisma no trae la tabla de fichas. `findMany` = las fichas previas del navegador con intento (se revisan
 * en Stripe antes de apartar otra); `updateMany` = marcarlas; `findUnique` = releer tras un choque de `attachIntent`.
 */
const fichas = { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), updateMany: jest.fn() }

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
    await pagar()
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
        pendientes: [],
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
    take.mockResolvedValue({
      hold: ficha({ stripePaymentIntentId: 'pi_viejo', stripeAccountId: 'acct_A' }),
      reused: true,
      released: [],
      pendientes: [],
    })
    piRetrieve.mockResolvedValue({ id: 'pi_viejo', status: 'processing' })
    await expect(pagar()).rejects.toMatchObject({ statusCode: 409, code: 'PAYMENT_LINK_PAYMENT_IN_PROGRESS' })
    expect(piCreate).not.toHaveBeenCalled()
  })

  it('recarga con el intento ya cobrado → alreadyPaid, sin crear otro', async () => {
    take.mockResolvedValue({
      hold: ficha({ stripePaymentIntentId: 'pi_viejo', stripeAccountId: 'acct_A' }),
      reused: true,
      released: [],
      pendientes: [],
    })
    piRetrieve.mockResolvedValue({ id: 'pi_viejo', status: 'succeeded' })
    await expect(pagar()).resolves.toEqual({ alreadyPaid: true, paymentIntentId: 'pi_viejo' })
    expect(piCreate).not.toHaveBeenCalled()
  })

  it('intento cancelado → suelta la ficha («intento_cancelado») y aparta otra con intento nuevo', async () => {
    take
      .mockResolvedValueOnce({
        hold: ficha({ stripePaymentIntentId: 'pi_viejo', stripeAccountId: 'acct_A' }),
        reused: true,
        released: [],
        pendientes: [],
      })
      .mockResolvedValueOnce({ hold: ficha({ id: 'chold00000000000000000002' }), reused: false, released: [], pendientes: [] })
    piRetrieve.mockResolvedValue({ id: 'pi_viejo', status: 'canceled' })
    const r = await pagar()
    expect(release).toHaveBeenCalledWith('chold00000000000000000001', 'intento_cancelado')
    expect(take).toHaveBeenCalledTimes(2)
    expect(piCreate.mock.calls[0][1].idempotencyKey).toBe('plhold:chold00000000000000000002')
    expect(r).toMatchObject({ paymentIntentId: 'pi_nuevo' })
  })

  /**
   * 🔴 Codex código r1 #2: dos POST del mismo token eligen M y L. L revisa sus previas cuando M todavía no liga su intento;
   * después M liga su intento y empieza a pagar; L suelta la ficha de M en `takeOrReuseHold`. Antes L cancelaba «a mejor
   * esfuerzo» y, aunque Stripe lo rechazara por estar en curso, devolvía un intento nuevo: dos cobros posibles antes de vencer.
   * Ahora cada ficha soltada con intento pasa por el mismo camino estricto que las previas; si no se confirma cancelada, se
   * suelta la ficha NUEVA y no se crea ni devuelve intento.
   */
  describe('carrera M/L del mismo token: la ficha soltada por takeOrReuseHold se cierra en estricto', () => {
    const NUEVA = 'chold00000000000000000002'
    beforeEach(() => {
      prismaMock.paymentLink.findUnique.mockResolvedValue(
        liga({ ecommerceMerchant: { ...liga().ecommerceMerchant, providerCredentials: { connectAccountId: 'acct_B' } } }) as any,
      )
      take.mockResolvedValue({
        hold: ficha({ id: NUEVA }),
        reused: false,
        released: [
          { holdId: 'chold00000000000000000001', stripePaymentIntentId: 'pi_de_m', stripeAccountId: 'acct_A' },
          { holdId: 'chold00000000000000000003', stripePaymentIntentId: null, stripeAccountId: null },
        ],
        pendientes: [],
      })
    })

    it('cancelable → se consulta y cancela con SU cuenta, se confirma «canceled» y sigue con la ficha nueva', async () => {
      piRetrieve.mockResolvedValue({ id: 'pi_de_m', status: 'requires_payment_method' })
      piCancel.mockResolvedValue({ id: 'pi_de_m', status: 'canceled' })
      const r = await pagar()
      expect(piRetrieve).toHaveBeenCalledWith('pi_de_m', undefined, { stripeAccount: 'acct_A' })
      expect(piCancel).toHaveBeenCalledTimes(1)
      expect(piCancel).toHaveBeenCalledWith('pi_de_m', undefined, { stripeAccount: 'acct_A' })
      // La ficha NUEVA sí nace con la cuenta de hoy.
      expect(piCreate.mock.calls[0][1]).toEqual({ stripeAccount: 'acct_B', idempotencyKey: `plhold:${NUEVA}` })
      expect(r).toMatchObject({ paymentIntentId: 'pi_nuevo' })
    })

    const M = 'chold00000000000000000001'
    /** Codex código r2: la ficha de M NO se queda soltada mientras su pago sigue: se restaura (CAS) y nadie más la aparta. */
    const mSeRestauraYNoSeMarcaCobrada = () => {
      expect(restaurar).toHaveBeenCalledWith(M)
      expect(restaurar).not.toHaveBeenCalledWith('chold00000000000000000003')
      expect(fichas.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ releasedReason: 'intento_cobrado' }) }),
      )
      expect(fichas.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ releasedReason: 'intento_cancelado' }) }),
      )
    }

    it('M ya está en processing → 409 IN_PROGRESS, M vuelve a ACTIVE, se suelta la ficha nueva y no se crea intento', async () => {
      piRetrieve.mockResolvedValue({ id: 'pi_de_m', status: 'processing' })
      await expect(pagar()).rejects.toMatchObject({ statusCode: 409, code: 'PAYMENT_LINK_PAYMENT_IN_PROGRESS' })
      expect(piCancel).not.toHaveBeenCalled()
      expect(piCreate).not.toHaveBeenCalled()
      expect(release).toHaveBeenCalledWith(NUEVA, expect.any(String), { soloSinIntento: true })
      mSeRestauraYNoSeMarcaCobrada()
    })

    it('Stripe rechaza la cancelación porque M ya empezó a cobrar → 409 IN_PROGRESS, M vuelve a ACTIVE, ficha nueva suelta', async () => {
      piRetrieve.mockResolvedValue({ id: 'pi_de_m', status: 'requires_action' })
      piCancel.mockRejectedValue(Object.assign(new Error('unexpected state'), { code: 'payment_intent_unexpected_state' }))
      await expect(pagar()).rejects.toMatchObject({ code: 'PAYMENT_LINK_PAYMENT_IN_PROGRESS' })
      expect(piCreate).not.toHaveBeenCalled()
      expect(release).toHaveBeenCalledWith(NUEVA, expect.any(String), { soloSinIntento: true })
      mSeRestauraYNoSeMarcaCobrada()
    })

    it('Stripe rechaza la cancelación porque OTRA solicitud ya canceló M (al volver a consultar «canceled») → sigue con la ficha nueva, M no se restaura', async () => {
      piRetrieve
        .mockResolvedValueOnce({ id: 'pi_de_m', status: 'requires_payment_method' })
        .mockResolvedValueOnce({ id: 'pi_de_m', status: 'canceled' })
      piCancel.mockRejectedValue(Object.assign(new Error('unexpected state'), { code: 'payment_intent_unexpected_state' }))
      const r = await pagar()
      expect(r).toMatchObject({ paymentIntentId: 'pi_nuevo' })
      expect(restaurar).not.toHaveBeenCalled()
      expect(release).not.toHaveBeenCalled()
    })

    it('cancelar responde sin «canceled» → 409, M vuelve a ACTIVE', async () => {
      piRetrieve.mockResolvedValue({ id: 'pi_de_m', status: 'requires_payment_method' })
      piCancel.mockResolvedValue({ id: 'pi_de_m', status: 'processing' })
      await expect(pagar()).rejects.toMatchObject({ code: 'PAYMENT_LINK_PAYMENT_IN_PROGRESS' })
      mSeRestauraYNoSeMarcaCobrada()
    })

    it('M ya cobró (sin cierre todavía) → alreadyPaid con SU intento, M vuelve a ACTIVE antes de cualquier marca, ficha nueva suelta', async () => {
      piRetrieve.mockResolvedValue({ id: 'pi_de_m', status: 'succeeded' })
      await expect(pagar()).resolves.toEqual({ alreadyPaid: true, paymentIntentId: 'pi_de_m' })
      expect(piCreate).not.toHaveBeenCalled()
      expect(release).toHaveBeenCalledWith(NUEVA, expect.any(String), { soloSinIntento: true })
      mSeRestauraYNoSeMarcaCobrada()
    })

    it('Stripe caído al revisar la de M → sube el error, M vuelve a ACTIVE, ficha nueva suelta, sin intento', async () => {
      piRetrieve.mockRejectedValue(new Error('Stripe caído'))
      await expect(pagar()).rejects.toThrow('Stripe caído')
      expect(piCreate).not.toHaveBeenCalled()
      expect(release).toHaveBeenCalledWith(NUEVA, expect.any(String), { soloSinIntento: true })
      mSeRestauraYNoSeMarcaCobrada()
    })

    it('M confirmada cancelada → NO se restaura (la pieza se libera de verdad)', async () => {
      piRetrieve.mockResolvedValue({ id: 'pi_de_m', status: 'requires_payment_method' })
      piCancel.mockResolvedValue({ id: 'pi_de_m', status: 'canceled' })
      await pagar()
      expect(restaurar).not.toHaveBeenCalled()
    })

    it('L reusada con su intento ya entregado a la pestaña: con M en processing → 409, M vuelve a ACTIVE y L se queda como estaba', async () => {
      take.mockResolvedValue({
        hold: ficha({ id: NUEVA, stripePaymentIntentId: 'pi_de_l', stripeAccountId: 'acct_A' }),
        reused: true,
        released: [{ holdId: M, stripePaymentIntentId: 'pi_de_m', stripeAccountId: 'acct_A' }],
        pendientes: [],
      })
      piRetrieve.mockResolvedValue({ id: 'pi_de_m', status: 'processing' })
      await expect(pagar()).rejects.toMatchObject({ code: 'PAYMENT_LINK_PAYMENT_IN_PROGRESS' })
      expect(release).not.toHaveBeenCalled()
      expect(restaurar).toHaveBeenCalledWith(M)
    })

    it('L reusada SIN intento todavía: sí se suelta', async () => {
      take.mockResolvedValue({
        hold: ficha({ id: NUEVA }),
        reused: true,
        released: [{ holdId: M, stripePaymentIntentId: 'pi_de_m', stripeAccountId: 'acct_A' }],
        pendientes: [],
      })
      piRetrieve.mockResolvedValue({ id: 'pi_de_m', status: 'processing' })
      await expect(pagar()).rejects.toMatchObject({ code: 'PAYMENT_LINK_PAYMENT_IN_PROGRESS' })
      expect(release).toHaveBeenCalledWith(NUEVA, expect.any(String), { soloSinIntento: true })
    })
  })

  describe('encargo b578cd: también se cierran las fichas YA soltadas con intento sin cierre cierto (pendientes)', () => {
    const L = 'chold0000000000000000000l'
    const P = 'chold0000000000000000000q'
    const conPendiente = (releasedReason: string, o: Record<string, unknown> = {}) =>
      take.mockResolvedValue({
        hold: ficha({ id: L }),
        reused: true,
        released: [],
        pendientes: [{ holdId: P, stripePaymentIntentId: 'pi_pend', stripeAccountId: 'acct_A', releasedReason, ...o }],
      })

    it('cambio_de_compra en processing → 409, la pendiente vuelve a ACTIVE, la de esta solicitud se suelta (sólo sin intento) y no se crea', async () => {
      conPendiente('cambio_de_compra')
      piRetrieve.mockResolvedValue({ id: 'pi_pend', status: 'processing' })
      await expect(pagar()).rejects.toMatchObject({ code: 'PAYMENT_LINK_PAYMENT_IN_PROGRESS' })
      expect(piRetrieve).toHaveBeenCalledWith('pi_pend', undefined, { stripeAccount: 'acct_A' })
      expect(restaurar).toHaveBeenCalledWith(P)
      expect(release).toHaveBeenCalledWith(L, 'intento_previo_sin_cerrar', { soloSinIntento: true })
      expect(piCreate).not.toHaveBeenCalled()
    })

    it('cancelable → se cancela con SU cuenta, se marca «intento_cancelado» y recién entonces se crea el de esta ficha', async () => {
      conPendiente('cambio_de_compra')
      piRetrieve.mockResolvedValue({ id: 'pi_pend', status: 'requires_payment_method' })
      piCancel.mockResolvedValue({ id: 'pi_pend', status: 'canceled' })
      await expect(pagar()).resolves.toMatchObject({ paymentIntentId: 'pi_nuevo' })
      expect(piCancel.mock.invocationCallOrder[0]).toBeLessThan(piCreate.mock.invocationCallOrder[0])
      expect(fichas.updateMany).toHaveBeenCalledWith({
        where: { id: P, status: { in: ['ACTIVE', 'RELEASED'] } },
        data: { status: 'RELEASED', releasedReason: 'intento_cancelado' },
      })
      expect(restaurar).not.toHaveBeenCalled()
    })

    it('vencida (del barrido) ya cobrada → alreadyPaid, se marca «intento_cobrado» y NO se restaura', async () => {
      conPendiente('vencida')
      piRetrieve.mockResolvedValue({ id: 'pi_pend', status: 'succeeded' })
      await expect(pagar()).resolves.toEqual({ alreadyPaid: true, paymentIntentId: 'pi_pend' })
      expect(restaurar).not.toHaveBeenCalled()
      expect(fichas.updateMany).toHaveBeenCalledWith({ where: { id: P, status: 'RELEASED' }, data: { releasedReason: 'intento_cobrado' } })
      expect(piCreate).not.toHaveBeenCalled()
    })

    it('la reusada con su intento ya entregado y una pendiente en processing → 409 sin devolver su intento ni soltarla', async () => {
      take.mockResolvedValue({
        hold: ficha({ id: L, stripePaymentIntentId: 'pi_de_l', stripeAccountId: 'acct_A' }),
        reused: true,
        released: [],
        pendientes: [{ holdId: P, stripePaymentIntentId: 'pi_pend', stripeAccountId: 'acct_A', releasedReason: 'cambio_de_compra' }],
      })
      piRetrieve.mockResolvedValue({ id: 'pi_pend', status: 'processing' })
      await expect(pagar()).rejects.toMatchObject({ code: 'PAYMENT_LINK_PAYMENT_IN_PROGRESS' })
      expect(piRetrieve).not.toHaveBeenCalledWith('pi_de_l', expect.anything(), expect.anything())
      expect(release).not.toHaveBeenCalled()
    })
  })

  describe('nunca un intento nuevo mientras el anterior del mismo navegador esté en curso o cobrado', () => {
    /** Ficha previa del navegador con intento, como la devuelve la consulta de previas. */
    const previa = (o: Record<string, unknown> = {}) =>
      ficha({
        id: 'chold0000000000000000000p',
        productId: 'ctallal000000000000000001',
        stripePaymentIntentId: 'pi_previo',
        stripeAccountId: 'acct_A',
        ...o,
      })

    beforeEach(() => {
      prismaMock.paymentLink.findUnique.mockResolvedValue(
        liga({ ecommerceMerchant: { ...liga().ecommerceMerchant, providerCredentials: { connectAccountId: 'acct_B' } } }) as any,
      )
    })

    it('la consulta de previas es de ESTE navegador y liga, con intento, sin las ya cerradas', async () => {
      await pagar()
      const where = fichas.findMany.mock.calls[0][0].where
      expect(where).toMatchObject({
        paymentLinkId: 'cplink00000000000000000001',
        browserToken: TOKEN,
        stripePaymentIntentId: { not: null },
      })
      expect(fichas.findMany.mock.calls[0][0].take).toBeGreaterThan(0)
    })

    it.each([
      ['de otra talla', {}],
      ['vencida (aún ACTIVE)', { productId: TALLA_M, expiresAt: new Date('2020-01-01') }],
      ['soltada por el barrido («vencida»)', { productId: TALLA_M, status: 'RELEASED', releasedReason: 'vencida' }],
      ['de otro importe', { productId: TALLA_M, amountCents: 50000 + 1000 }],
    ])('previa %s en processing → 409 IN_PROGRESS, sin apartar ni crear', async (_n, o) => {
      fichas.findMany.mockResolvedValue([previa(o)])
      piRetrieve.mockResolvedValue({ id: 'pi_previo', status: 'processing' })
      await expect(pagar()).rejects.toMatchObject({ statusCode: 409, code: 'PAYMENT_LINK_PAYMENT_IN_PROGRESS' })
      expect(piRetrieve).toHaveBeenCalledWith('pi_previo', undefined, { stripeAccount: 'acct_A' })
      expect(piCancel).not.toHaveBeenCalled()
      expect(take).not.toHaveBeenCalled()
      expect(piCreate).not.toHaveBeenCalled()
    })

    it('Codex codigo-r4b: previa soltada por cambio de compra y aún cobrando → 409 y vuelve a ACTIVE (la pieza sigue apartada)', async () => {
      fichas.findMany.mockResolvedValue([previa({ status: 'RELEASED', releasedReason: 'cambio_de_compra' })])
      piRetrieve.mockResolvedValue({ id: 'pi_previo', status: 'processing' })
      await expect(pagar()).rejects.toMatchObject({ code: 'PAYMENT_LINK_PAYMENT_IN_PROGRESS' })
      expect(restaurar).toHaveBeenCalledWith('chold0000000000000000000p')
      expect(take).not.toHaveBeenCalled()
    })

    it('previa soltada por cambio de compra ya cobrada: vuelve a ACTIVE para el cierre; si ya no se puede (vencida), se marca «intento_cobrado»', async () => {
      fichas.findMany.mockResolvedValue([previa({ status: 'RELEASED', releasedReason: 'cambio_de_compra' })])
      piRetrieve.mockResolvedValue({ id: 'pi_previo', status: 'succeeded' })
      await expect(pagar()).resolves.toEqual({ alreadyPaid: true, paymentIntentId: 'pi_previo' })
      expect(restaurar).toHaveBeenCalledWith('chold0000000000000000000p')
      expect(fichas.updateMany).not.toHaveBeenCalled()
      restaurar.mockResolvedValue(false)
      await expect(pagar()).resolves.toEqual({ alreadyPaid: true, paymentIntentId: 'pi_previo' })
      expect(fichas.updateMany).toHaveBeenCalledWith({
        where: { id: 'chold0000000000000000000p', status: 'RELEASED' },
        data: { releasedReason: 'intento_cobrado' },
      })
    })

    it('previa ya cobrada → alreadyPaid con SU intento, sin apartar ni crear; soltada se marca «intento_cobrado»', async () => {
      fichas.findMany.mockResolvedValue([previa({ status: 'RELEASED', releasedReason: 'vencida' })])
      piRetrieve.mockResolvedValue({ id: 'pi_previo', status: 'succeeded' })
      await expect(pagar()).resolves.toEqual({ alreadyPaid: true, paymentIntentId: 'pi_previo' })
      expect(take).not.toHaveBeenCalled()
      expect(piCreate).not.toHaveBeenCalled()
      expect(fichas.updateMany).toHaveBeenCalledWith({
        where: { id: 'chold0000000000000000000p', status: 'RELEASED' },
        data: { releasedReason: 'intento_cobrado' },
      })
    })

    it('previa cancelable → se cancela con SU cuenta, se confirma «canceled», se marca y se aparta otra', async () => {
      fichas.findMany.mockResolvedValue([previa()])
      piRetrieve.mockResolvedValue({ id: 'pi_previo', status: 'requires_payment_method' })
      piCancel.mockResolvedValue({ id: 'pi_previo', status: 'canceled' })
      const r = await pagar()
      expect(piCancel).toHaveBeenCalledWith('pi_previo', undefined, { stripeAccount: 'acct_A' })
      expect(fichas.updateMany).toHaveBeenCalledWith({
        where: { id: 'chold0000000000000000000p', status: { in: ['ACTIVE', 'RELEASED'] } },
        data: { status: 'RELEASED', releasedReason: 'intento_cancelado' },
      })
      expect(take).toHaveBeenCalledTimes(1)
      expect(piCreate.mock.calls[0][1]).toEqual({ stripeAccount: 'acct_B', idempotencyKey: 'plhold:chold00000000000000000001' })
      expect(r).toMatchObject({ paymentIntentId: 'pi_nuevo' })
    })

    it('previa que cambia de estado entre consultar y cancelar (payment_intent_unexpected_state) → 409 IN_PROGRESS, sin el error crudo', async () => {
      fichas.findMany.mockResolvedValue([previa()])
      piRetrieve.mockResolvedValue({ id: 'pi_previo', status: 'requires_action' })
      piCancel.mockRejectedValue(
        Object.assign(new Error('This PaymentIntent could not be canceled'), {
          type: 'StripeInvalidRequestError',
          code: 'payment_intent_unexpected_state',
          statusCode: 400,
        }),
      )
      const err = await pagar().catch(e => e)
      expect(err).toBeInstanceOf(ConflictError)
      expect(err).toMatchObject({
        statusCode: 409,
        code: 'PAYMENT_LINK_PAYMENT_IN_PROGRESS',
        message: 'Tu pago se está procesando. Espera unos segundos.',
      })
      expect(fichas.updateMany).not.toHaveBeenCalled()
      expect(take).not.toHaveBeenCalled()
      expect(piCreate).not.toHaveBeenCalled()
    })

    it('regresión: otro rechazo de Stripe al cancelar (sin ese código) sube tal cual, no se aparta ni se crea', async () => {
      fichas.findMany.mockResolvedValue([previa()])
      piRetrieve.mockResolvedValue({ id: 'pi_previo', status: 'requires_action' })
      piCancel.mockRejectedValue(Object.assign(new Error('otro rechazo'), { type: 'StripeInvalidRequestError', statusCode: 400 }))
      await expect(pagar()).rejects.toThrow('otro rechazo')
      expect(take).not.toHaveBeenCalled()
      expect(piCreate).not.toHaveBeenCalled()
    })

    it('cancelar responde sin «canceled» → 409 IN_PROGRESS, no se aparta', async () => {
      fichas.findMany.mockResolvedValue([previa()])
      piRetrieve.mockResolvedValue({ id: 'pi_previo', status: 'requires_payment_method' })
      piCancel.mockResolvedValue({ id: 'pi_previo', status: 'processing' })
      await expect(pagar()).rejects.toMatchObject({ statusCode: 409, code: 'PAYMENT_LINK_PAYMENT_IN_PROGRESS' })
      expect(take).not.toHaveBeenCalled()
    })

    it('previa ya cancelada en Stripe → sólo se marca y se aparta otra (sin volver a cancelar)', async () => {
      fichas.findMany.mockResolvedValue([previa()])
      piRetrieve.mockResolvedValue({ id: 'pi_previo', status: 'canceled' })
      await pagar()
      expect(piCancel).not.toHaveBeenCalled()
      expect(fichas.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'RELEASED', releasedReason: 'intento_cancelado' } }),
      )
      expect(piCreate).toHaveBeenCalledTimes(1)
    })

    // Task 6 (regla 4): un error PERMANENTE de Stripe para ESE intento no puede trabar al navegador para siempre en la liga.
    it.each([
      ['el intento ya no existe (resource_missing)', { type: 'StripeInvalidRequestError', code: 'resource_missing', statusCode: 404 }],
      ['la cuenta congelada ya no da acceso (permiso)', { type: 'StripePermissionError', statusCode: 403 }],
      ['la cuenta congelada es inválida (account_invalid)', { type: 'StripePermissionError', code: 'account_invalid', statusCode: 403 }],
    ])('previa con error permanente: %s → se marca «intento_cancelado» y se aparta otra', async (_n, e) => {
      fichas.findMany.mockResolvedValue([previa()])
      piRetrieve.mockRejectedValueOnce(Object.assign(new Error('stripe dice que no'), e))
      const r = await pagar()
      expect(fichas.updateMany).toHaveBeenCalledWith({
        where: { id: 'chold0000000000000000000p', status: { in: ['ACTIVE', 'RELEASED'] } },
        data: { status: 'RELEASED', releasedReason: 'intento_cancelado' },
      })
      expect(take).toHaveBeenCalledTimes(1)
      expect(r).toMatchObject({ paymentIntentId: 'pi_nuevo' })
    })

    it.each([
      ['Stripe caído (conexión)', { type: 'StripeConnectionError' }],
      ['error de Stripe (api_error)', { type: 'StripeAPIError', statusCode: 500 }],
      ['límite de peticiones', { type: 'StripeRateLimitError', statusCode: 429 }],
      ['nuestra llave de plataforma falla (401: no es de la cuenta)', { type: 'StripeAuthenticationError', statusCode: 401 }],
    ])('previa con error PASAJERO (%s) → el error sube, no se marca ni se aparta', async (_n, e) => {
      fichas.findMany.mockResolvedValue([previa()])
      piRetrieve.mockRejectedValueOnce(Object.assign(new Error('pasajero'), e))
      await expect(pagar()).rejects.toThrow('pasajero')
      expect(fichas.updateMany).not.toHaveBeenCalled()
      expect(take).not.toHaveBeenCalled()
      expect(piCreate).not.toHaveBeenCalled()
    })

    it('regresión: la previa que se reusa (misma talla, importe y datos, vigente) no se cancela: se devuelve su intento', async () => {
      const misma = ficha({
        stripePaymentIntentId: 'pi_viejo',
        stripeAccountId: 'acct_A',
        intentParams: { receipt_email: 'ana@example.test' },
        checkoutSnapshot: { amount: '500.00', currency: 'MXN', applicationFeeCents: 580, metadata: {} },
      })
      fichas.findMany.mockResolvedValue([misma])
      take.mockResolvedValue({ hold: misma, reused: true, released: [], pendientes: [] })
      piRetrieve.mockResolvedValue({ id: 'pi_viejo', client_secret: 'secret_viejo', status: 'requires_payment_method' })
      const r = await pagar({ customerEmail: 'ana@example.test' })
      expect(piCancel).not.toHaveBeenCalled()
      expect(fichas.updateMany).not.toHaveBeenCalled()
      expect(piCreate).not.toHaveBeenCalled()
      expect(r).toMatchObject({ paymentIntentId: 'pi_viejo', connectAccountId: 'acct_A' })
    })

    // Encargo 51ecc0 (13-nov): Stripe contesta `payment_intent_unexpected_state` también cuando el intento YA quedó cancelado
    // (otra solicitud del mismo navegador lo canceló un instante antes). Eso no es «en curso»: se vuelve a consultar y manda
    // su estado real.
    const yaCancelado = () =>
      Object.assign(new Error('You cannot cancel this PaymentIntent because it has a status of canceled.'), {
        type: 'StripeInvalidRequestError',
        code: 'payment_intent_unexpected_state',
        statusCode: 400,
      })

    it('previa que OTRA solicitud ya canceló (unexpected_state y al volver a consultar «canceled») → se marca y se aparta otra', async () => {
      fichas.findMany.mockResolvedValue([previa()])
      piRetrieve
        .mockResolvedValueOnce({ id: 'pi_previo', status: 'requires_payment_method' })
        .mockResolvedValueOnce({ id: 'pi_previo', status: 'canceled' })
      piCancel.mockRejectedValue(yaCancelado())
      const r = await pagar()
      expect(piRetrieve).toHaveBeenNthCalledWith(2, 'pi_previo', undefined, { stripeAccount: 'acct_A' })
      expect(fichas.updateMany).toHaveBeenCalledWith({
        where: { id: 'chold0000000000000000000p', status: { in: ['ACTIVE', 'RELEASED'] } },
        data: { status: 'RELEASED', releasedReason: 'intento_cancelado' },
      })
      expect(take).toHaveBeenCalledTimes(1)
      expect(r).toMatchObject({ paymentIntentId: 'pi_nuevo' })
    })

    it('unexpected_state y al volver a consultar ya cobró → alreadyPaid con SU intento, sin apartar ni crear', async () => {
      fichas.findMany.mockResolvedValue([previa({ status: 'RELEASED', releasedReason: 'vencida' })])
      piRetrieve
        .mockResolvedValueOnce({ id: 'pi_previo', status: 'requires_action' })
        .mockResolvedValueOnce({ id: 'pi_previo', status: 'succeeded' })
      piCancel.mockRejectedValue(yaCancelado())
      await expect(pagar()).resolves.toEqual({ alreadyPaid: true, paymentIntentId: 'pi_previo' })
      expect(take).not.toHaveBeenCalled()
      expect(piCreate).not.toHaveBeenCalled()
    })

    it('unexpected_state y al volver a consultar Stripe no contesta → sube ese error, no se marca ni se aparta', async () => {
      fichas.findMany.mockResolvedValue([previa()])
      piRetrieve
        .mockResolvedValueOnce({ id: 'pi_previo', status: 'requires_payment_method' })
        .mockRejectedValueOnce(Object.assign(new Error('Stripe caído'), { type: 'StripeConnectionError' }))
      piCancel.mockRejectedValue(yaCancelado())
      await expect(pagar()).rejects.toThrow('Stripe caído')
      expect(fichas.updateMany).not.toHaveBeenCalled()
      expect(take).not.toHaveBeenCalled()
    })

    it('reproduce el aviso falso: dos POST a la vez tras cambiar de talla (StrictMode o dos pestañas) → los dos reciben el intento nuevo', async () => {
      // Stripe simulado con estado: cancelar un intento ya cancelado contesta unexpected_state, como el de verdad.
      const estado: Record<string, string> = { pi_previo: 'requires_payment_method' }
      piRetrieve.mockImplementation(async (id: string) => ({ id, status: estado[id] }))
      piCancel.mockImplementation(async (id: string) => {
        await new Promise(r => setImmediate(r))
        if (estado[id] === 'canceled') throw yaCancelado()
        estado[id] = 'canceled'
        return { id, status: 'canceled' }
      })
      // Las dos ven todavía la ficha de la talla vieja con su intento.
      fichas.findMany.mockResolvedValue([previa()])
      const L = ficha({ id: 'chold0000000000000000000l' })
      take
        .mockResolvedValueOnce({ hold: L, reused: false, released: [], pendientes: [] })
        .mockResolvedValueOnce({ hold: L, reused: true, released: [], pendientes: [] })
      piCreate.mockResolvedValue({ id: 'pi_de_l', client_secret: 'secret_l', status: 'requires_payment_method' })
      const [a, b] = await Promise.allSettled([pagar(), pagar()])
      expect(a).toMatchObject({ status: 'fulfilled', value: { paymentIntentId: 'pi_de_l' } })
      expect(b).toMatchObject({ status: 'fulfilled', value: { paymentIntentId: 'pi_de_l' } })
      // Una sola cancelación real; la otra sólo confirmó el estado.
      expect(estado.pi_previo).toBe('canceled')
      expect(piCreate.mock.calls.every(c => c[1].idempotencyKey === 'plhold:chold0000000000000000000l')).toBe(true)
    })
  })

  describe('la clienta corrige su correo o un campo y vuelve a «Pagar» con la misma talla e importe', () => {
    const congelada = (o: Record<string, unknown> = {}) =>
      ficha({
        stripeAccountId: 'acct_A',
        intentParams: { receipt_email: 'vieja@example.test', metadata: {} },
        checkoutSnapshot: {
          amount: '500.00',
          currency: 'MXN',
          applicationFeeCents: 580,
          metadata: { customFieldResponses: { talla: 'x' } },
        },
        ...o,
      })

    it('correo distinto con intento → se cancela (confirmado) y se aparta otra con el correo nuevo', async () => {
      const vieja = congelada({
        stripePaymentIntentId: 'pi_viejo',
        checkoutSnapshot: { amount: '500.00', currency: 'MXN', applicationFeeCents: 580, metadata: {} },
      })
      take
        .mockResolvedValueOnce({ hold: vieja, reused: true, released: [], pendientes: [] })
        .mockResolvedValueOnce({ hold: ficha({ id: 'chold00000000000000000002' }), reused: false, released: [], pendientes: [] })
      piRetrieve.mockResolvedValue({ id: 'pi_viejo', status: 'requires_payment_method' })
      piCancel.mockResolvedValue({ id: 'pi_viejo', status: 'canceled' })
      await pagar({ customerEmail: 'nueva@example.test' })
      expect(piCancel).toHaveBeenCalledWith('pi_viejo', undefined, { stripeAccount: 'acct_A' })
      expect(fichas.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'chold00000000000000000001' }),
          data: { status: 'RELEASED', releasedReason: 'intento_cancelado' },
        }),
      )
      expect(take).toHaveBeenCalledTimes(2)
      expect(piCreate).toHaveBeenCalledTimes(1)
      expect(piCreate.mock.calls[0][0].receipt_email).toBe('nueva@example.test')
      expect(piCreate.mock.calls[0][1].idempotencyKey).toBe('plhold:chold00000000000000000002')
    })

    it('correo distinto y el intento viejo ya está en processing → 409 IN_PROGRESS, sin crear otro', async () => {
      take.mockResolvedValue({ hold: congelada({ stripePaymentIntentId: 'pi_viejo' }), reused: true, released: [], pendientes: [] })
      piRetrieve.mockResolvedValue({ id: 'pi_viejo', status: 'processing' })
      await expect(pagar({ customerEmail: 'nueva@example.test', customFieldResponses: { talla: 'x' } })).rejects.toMatchObject({
        code: 'PAYMENT_LINK_PAYMENT_IN_PROGRESS',
      })
      expect(piCreate).not.toHaveBeenCalled()
    })

    it('campo personalizado distinto, ficha congelada sin intento → se suelta y se aparta otra con los datos nuevos', async () => {
      prismaMock.paymentLink.findUnique.mockResolvedValue(
        liga({ customFields: [{ id: 'talla', label: 'Nota', type: 'TEXT', required: false }] }) as any,
      )
      take
        .mockResolvedValueOnce({ hold: congelada({ intentParams: { metadata: {} } }), reused: true, released: [], pendientes: [] })
        .mockResolvedValueOnce({ hold: ficha({ id: 'chold00000000000000000002' }), reused: false, released: [], pendientes: [] })
      await pagar({ customFieldResponses: { talla: 'y' } })
      expect(release).toHaveBeenCalledWith('chold00000000000000000001', 'cambio_de_compra', { soloSinIntento: true })
      expect(piCancel).not.toHaveBeenCalled()
      expect(sesionCreada().data[0].metadata.customFieldResponses).toEqual({ talla: 'y' })
      expect(piCreate.mock.calls[0][1].idempotencyKey).toBe('plhold:chold00000000000000000002')
    })

    it('regresión: mismos datos (mismo correo y campos) → reusa la ficha congelada con la misma llave', async () => {
      prismaMock.paymentLink.findUnique.mockResolvedValue(
        liga({ customFields: [{ id: 'talla', label: 'Nota', type: 'TEXT', required: false }] }) as any,
      )
      const misma = congelada({ intentParams: { receipt_email: 'vieja@example.test', metadata: {} } })
      take.mockResolvedValue({ hold: misma, reused: true, released: [], pendientes: [] })
      freeze.mockImplementation(async () => misma)
      await pagar({ customerEmail: 'vieja@example.test', customFieldResponses: { talla: 'x' } })
      expect(release).not.toHaveBeenCalled()
      expect(take).toHaveBeenCalledTimes(1)
      expect(piCreate.mock.calls[0][1].idempotencyKey).toBe('plhold:chold00000000000000000001')
    })
  })

  it('respuesta perdida al crear: el siguiente POST repite la MISMA llave y parámetros y la sesión sale de la foto congelada', async () => {
    piCreate.mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' }))
    await expect(pagar({ customerEmail: 'ana@example.test' })).rejects.toThrow('socket hang up')
    expect(release).not.toHaveBeenCalled()
    expect(prismaMock.checkoutSession.createMany).not.toHaveBeenCalled()
    const congelada = freeze.mock.calls[0][1]

    // Entretanto cambian la comisión del comercio y su cuenta conectada pasa a B (la clienta no cambió sus datos).
    prismaMock.paymentLink.findUnique.mockResolvedValue(
      liga({
        ecommerceMerchant: { ...liga().ecommerceMerchant, platformFeeBps: 300, providerCredentials: { connectAccountId: 'acct_B' } },
      }) as any,
    )
    take.mockResolvedValue({ hold: ficha(congelada), reused: true, released: [], pendientes: [] })
    freeze.mockImplementation(async () => ficha(congelada)) // el CAS no la pisa
    piCreate.mockResolvedValue({ id: 'pi_nuevo', client_secret: 'secret_nuevo' })
    const r = await pagar({ customerEmail: 'ana@example.test' })

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

  describe('conflicto concurrente de idempotencia en Stripe (otra solicitud crea el mismo intento)', () => {
    const enUso = () =>
      Object.assign(new Error('There is currently another in-progress request using this Idempotent Key'), {
        type: 'StripeIdempotencyError',
        code: 'idempotency_key_in_use',
        statusCode: 409,
      })
    beforeEach(() => jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] }))
    afterEach(() => jest.useRealTimers())

    it('encargo 51ecc0 · Codex r3b #2: espera y repite con la MISMA llave y parámetros → recibe el intento que creó la otra', async () => {
      piCreate
        .mockRejectedValueOnce(enUso())
        .mockResolvedValueOnce({ id: 'pi_nuevo', client_secret: 'secret_nuevo', status: 'requires_payment_method' })
      const p = pagar().catch(e => e)
      await jest.advanceTimersByTimeAsync(1500)
      expect(await p).toMatchObject({ paymentIntentId: 'pi_nuevo' })
      expect(piCreate).toHaveBeenCalledTimes(2)
      expect(piCreate.mock.calls[1]).toEqual(piCreate.mock.calls[0])
      expect(attach).toHaveBeenCalledWith('chold00000000000000000001', 'pi_nuevo')
    })

    it('sigue en uso después de repetir → se responde el error y la ficha se conserva', async () => {
      piCreate.mockRejectedValue(enUso())
      const p = pagar().catch(e => e)
      await jest.advanceTimersByTimeAsync(1500)
      expect(await p).toMatchObject({ statusCode: 409 })
      expect(piCreate).toHaveBeenCalledTimes(2)
      expect(release).not.toHaveBeenCalled()
      expect(attach).not.toHaveBeenCalled()
    })

    it('regresión: misma llave con OTROS parámetros (400 de idempotencia) no se repite', async () => {
      piCreate.mockRejectedValue(
        Object.assign(new Error('Keys for idempotent requests can only be used with the same parameters'), {
          type: 'StripeIdempotencyError',
          statusCode: 400,
        }),
      )
      await expect(pagar()).rejects.toMatchObject({ statusCode: 400 })
      expect(piCreate).toHaveBeenCalledTimes(1)
      expect(release).not.toHaveBeenCalled()
    })
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

/**
 * Encargo b578cd · Codex r3b #1 (13-nov): intercalaciones de 2-3 POST del mismo navegador. Las fichas y Stripe se simulan CON
 * ESTADO y con la semántica de `paymentLinkStockHold.service` (candado por navegador en `takeOrReuseHold`, CAS de congelar,
 * ligar, soltar y restaurar) y de Stripe (misma llave = mismo intento; cancelar algo que ya no es cancelable →
 * `payment_intent_unexpected_state`; la respuesta de una consulta puede llegar vieja). La invariante:
 *   ninguna solicitud ENTREGA un intento mientras OTRA ficha del navegador tenga un intento ligado que no esté cancelado con
 *   certeza, y al final queda a lo más UN intento vivo (no cancelado) entre los ligados o entregados, con su ficha apartada.
 */
describe('intercalaciones del mismo navegador: nunca dos cobros posibles (encargo b578cd)', () => {
  const LINK = 'cplink00000000000000000001'
  const T_M = 'ctallam000000000000000001'
  const T_L = 'ctallal000000000000000001'
  const FINALES = ['intento_cancelado', 'intento_cobrado']
  const REUSABLE = new Set(['requires_payment_method', 'requires_confirmation', 'requires_action'])
  type Fila = {
    id: string
    paymentLinkId: string
    browserToken: string
    productId: string
    status: string
    releasedReason: string | null
    stripePaymentIntentId: string | null
    stripeAccountId: string | null
    amountCents: number | null
    intentParams: unknown
    checkoutSnapshot: unknown
    expiresAt: Date
    creada: number
  }
  let filas: Map<string, Fila>
  let intentos: Map<string, { status: string; holdKey: string }>
  let porLlave: Map<string, string>
  let candado: Promise<unknown>
  let n: number
  /** Pausas por operación (para fijar una intercalación) o el azar con semilla (para recorrer muchas). */
  let pausa: (op: string, id?: string) => Promise<void>
  /** Cada intento entregado a una pestaña, con lo que había vivo en ese momento. */
  let entregas: Array<{ pi: string; otrosVivos: string[] }>

  const copia = (f: Fila) => ({ ...f })
  const vivo = (pi: string | null) => !!pi && intentos.has(pi) && intentos.get(pi)!.status !== 'canceled'
  const ref = (f: Fila) => ({
    holdId: f.id,
    stripePaymentIntentId: f.stripePaymentIntentId,
    stripeAccountId: f.stripeAccountId,
    releasedReason: f.releasedReason,
  })

  function sembrar(o: Partial<Fila> & { productId: string }): Fila {
    const f: Fila = {
      id: `chold${String(++n).padStart(20, '0')}`,
      paymentLinkId: LINK,
      browserToken: TOKEN,
      status: 'ACTIVE',
      releasedReason: null,
      stripePaymentIntentId: null,
      stripeAccountId: null,
      amountCents: 50000,
      intentParams: null,
      checkoutSnapshot: null,
      expiresAt: EXPIRA,
      creada: n,
      ...o,
    }
    filas.set(f.id, f)
    return f
  }

  /** `where` de Prisma con lo que usa el servicio: igualdad, in, notIn, not (nulo) y OR. */
  function cumple(f: Record<string, any>, where: Record<string, any>): boolean {
    return Object.entries(where).every(([k, c]) => {
      if (k === 'OR') return (c as Record<string, any>[]).some(w => cumple(f, w))
      const v = f[k]
      if (c && typeof c === 'object' && !(c instanceof Date)) {
        if ('in' in c) return c.in.includes(v)
        if ('notIn' in c) return !c.notIn.includes(v)
        if ('not' in c) return v !== c.not
      }
      return v === c
    })
  }

  beforeEach(() => {
    filas = new Map()
    intentos = new Map()
    porLlave = new Map()
    candado = Promise.resolve()
    n = 0
    entregas = []
    pausa = async () => {}
    prismaMock.product.findFirst.mockImplementation((async (args: any) => talla({ id: args.where.id })) as any)

    fichas.findMany.mockImplementation(async (args: any) => {
      await pausa('previas')
      // `stripePaymentIntentId: { not: null }` lo resuelve `cumple` (not); el resto es igualdad y OR.
      return [...filas.values()]
        .filter(f => cumple(f, args.where))
        .sort((a, b) => b.creada - a.creada)
        .slice(0, args.take)
        .map(copia)
    })
    fichas.updateMany.mockImplementation(async (args: any) => {
      await pausa('marcar')
      let count = 0
      for (const f of filas.values()) {
        if (!cumple(f, args.where)) continue
        Object.assign(f, args.data)
        count++
      }
      return { count }
    })
    fichas.findUnique.mockImplementation(async (args: any) => (filas.has(args.where.id) ? copia(filas.get(args.where.id)!) : null))

    take.mockImplementation(async (args: any) => {
      await pausa('take')
      const turno = candado.then(() => {
        const ahora = new Date()
        const propias = [...filas.values()].filter(f => f.paymentLinkId === args.paymentLinkId && f.browserToken === args.browserToken)
        const activas = propias.filter(f => f.status === 'ACTIVE').sort((a, b) => b.creada - a.creada)
        const reusable = activas.find(
          f => f.productId === args.productId && f.expiresAt > ahora && (f.amountCents === null || f.amountCents === args.amountCents),
        )
        const pendientes = propias
          .filter(f => f.status === 'RELEASED' && f.stripePaymentIntentId !== null && !FINALES.includes(f.releasedReason as string))
          .map(ref)
        const released = activas
          .filter(f => f !== reusable)
          .map(f => {
            f.status = 'RELEASED'
            f.releasedReason = 'cambio_de_compra'
            return ref(f)
          })
        if (reusable) return { hold: copia(reusable), reused: true, released, pendientes }
        return { hold: copia(sembrar({ productId: args.productId, amountCents: args.amountCents })), reused: false, released, pendientes }
      })
      candado = turno.catch(() => undefined)
      const r = await turno
      await pausa('take-respuesta')
      return r
    })
    freeze.mockImplementation(async (holdId: string, args: any) => {
      await pausa('congelar')
      const f = filas.get(holdId)!
      if (f.status === 'ACTIVE' && f.intentParams === null) Object.assign(f, args)
      return copia(f)
    })
    attach.mockImplementation(async (holdId: string, pi: string) => {
      await pausa('ligar')
      const f = filas.get(holdId)!
      if (f.status !== 'ACTIVE' || (f.stripePaymentIntentId !== null && f.stripePaymentIntentId !== pi)) {
        throw new ConflictError('La ficha de apartado ya no está activa', 'PAYMENT_LINK_HOLD_INTENT_MISMATCH')
      }
      f.stripePaymentIntentId = pi
    })
    release.mockImplementation(async (holdId: string, motivo: string, opciones?: { soloSinIntento?: boolean }) => {
      await pausa('soltar')
      const f = filas.get(holdId)!
      if (f.status === 'ACTIVE' && (!opciones?.soloSinIntento || f.stripePaymentIntentId === null)) {
        f.status = 'RELEASED'
        f.releasedReason = motivo
      }
    })
    restaurar.mockImplementation(async (holdId: string) => {
      await pausa('restaurar')
      const f = filas.get(holdId)!
      if (f.status !== 'RELEASED' || f.releasedReason !== 'cambio_de_compra' || f.expiresAt <= new Date()) return false
      f.status = 'ACTIVE'
      f.releasedReason = null
      return true
    })

    piCreate.mockImplementation(async (_params: unknown, opciones: { idempotencyKey: string }) => {
      await pausa('crear')
      let id = porLlave.get(opciones.idempotencyKey)
      if (!id) {
        id = `pi_${opciones.idempotencyKey.slice(-6)}_${++n}`
        porLlave.set(opciones.idempotencyKey, id)
        intentos.set(id, { status: 'requires_payment_method', holdKey: opciones.idempotencyKey })
      }
      const r = { id, client_secret: `secret_${id}`, status: intentos.get(id)!.status }
      await pausa('crear-respuesta')
      return r
    })
    piRetrieve.mockImplementation(async (id: string) => {
      await pausa('consultar', id)
      // La foto se toma AHORA; la respuesta puede llegar cuando Stripe ya cambió (vieja).
      const r = { id, client_secret: `secret_${id}`, status: intentos.get(id)!.status }
      await pausa('consultar-respuesta', id)
      return r
    })
    piCancel.mockImplementation(async (id: string) => {
      await pausa('cancelar', id)
      const i = intentos.get(id)!
      if (!REUSABLE.has(i.status)) {
        throw Object.assign(new Error('unexpected state'), { code: 'payment_intent_unexpected_state' })
      }
      i.status = 'canceled'
      await pausa('cancelar-respuesta', id)
      return { id, status: 'canceled' }
    })
  })

  /** Intentos ligados a una ficha que siguen vivos. */
  const ligadosVivos = (salvo?: string) =>
    [...filas.values()].filter(f => f.id !== salvo && vivo(f.stripePaymentIntentId)).map(f => f.stripePaymentIntentId as string)

  /** Un POST de la pestaña; si entrega un intento, anota qué otros intentos ligados seguían vivos en ese instante. */
  const pagarTalla = (productId: string, customerEmail?: string) =>
    createStripePaymentIntentForPaymentLink('abc12345', { productId, browserToken: TOKEN, customerEmail } as any).then(
      (r: any) => {
        if (r?.paymentIntentId && !r.alreadyPaid) {
          const suya = [...filas.values()].find(f => f.stripePaymentIntentId === r.paymentIntentId)
          entregas.push({ pi: r.paymentIntentId, otrosVivos: vivo(r.paymentIntentId) ? ligadosVivos(suya?.id) : [] })
        }
        return { ok: true as const, r }
      },
      (e: any) => ({ ok: false as const, code: e?.code as string | undefined, e }),
    )

  /** El POST viejo de la talla M que ya apartó y liga su intento (como lo deja `attachIntent`). */
  function ligarM(m: Fila, status: string) {
    const pi = 'pi_M'
    intentos.set(pi, { status, holdKey: `plhold:${m.id}` })
    porLlave.set(`plhold:${m.id}`, pi)
    Object.assign(m, { stripePaymentIntentId: pi, stripeAccountId: 'acct_A', intentParams: { amount: 50000 } })
  }

  /** La invariante al terminar: ninguna entrega con otro vivo, a lo más un intento vivo y con su ficha apartada. */
  function nuncaDosCobros() {
    for (const e of entregas) expect(e).toEqual({ pi: e.pi, otrosVivos: [] })
    const candidatos = new Set([...entregas.map(e => e.pi), ...[...filas.values()].map(f => f.stripePaymentIntentId)].filter(vivo))
    expect([...candidatos].length).toBeLessThanOrEqual(1)
    for (const pi of candidatos) {
      const suya = [...filas.values()].find(f => f.stripePaymentIntentId === pi)
      expect({ pi, ficha: suya?.status }).toEqual({ pi, ficha: 'ACTIVE' })
    }
  }

  function puerta() {
    let abrir!: () => void
    const p = new Promise<void>(r => (abrir = r))
    return { p, abrir }
  }
  async function hasta(cond: () => boolean) {
    for (let i = 0; i < 500 && !cond(); i++) await new Promise(r => setImmediate(r))
    if (!cond()) throw new Error('la intercalación no llegó al punto esperado')
  }

  /** Fija la secuencia de Codex r3b #1 hasta que L₂ termina; devuelve las promesas para que cada caso decida el final. */
  async function secuenciaR3b(estadoDeM: string, antesDeL2: () => void = () => undefined) {
    const m = sembrar({ productId: T_M })
    const tomas = [puerta(), puerta()]
    let llegadas = 0
    const consultaDeL1 = puerta()
    let consultasM = 0
    pausa = async (op, id) => {
      if (op === 'take') await tomas[llegadas++].p
      if (op === 'consultar-respuesta' && id === 'pi_M' && consultasM++ === 0) await consultaDeL1.p
    }
    // L₁ y L₂ revisan previas cuando M todavía no tiene intento, y se detienen antes de apartar.
    const l1 = pagarTalla(T_L)
    const l2 = pagarTalla(T_L)
    await hasta(() => llegadas === 2)
    // El POST viejo liga pi_M (la clienta ya lo empieza a confirmar).
    ligarM(m, estadoDeM)
    // L₁ aparta (suelta M con pi_M, crea L) y consulta pi_M: la respuesta de Stripe se queda en el camino.
    tomas[0].abrir()
    await hasta(() => consultasM === 1)
    // L₂ aparta (REUSA L) y termina.
    antesDeL2()
    tomas[1].abrir()
    const r2 = await l2
    return { m, l1, r2, soltarConsultaDeL1: consultaDeL1.abrir }
  }

  it('r3b #1: pi_M cobrando → L₂ no crea ni entrega pi_L; L₁ tampoco; M vuelve a apartarse y L se suelta', async () => {
    const { m, l1, r2, soltarConsultaDeL1 } = await secuenciaR3b('processing')
    expect(r2).toMatchObject({ ok: false, code: 'PAYMENT_LINK_PAYMENT_IN_PROGRESS' })
    soltarConsultaDeL1()
    expect(await l1).toMatchObject({ ok: false, code: 'PAYMENT_LINK_PAYMENT_IN_PROGRESS' })
    expect(piCreate).not.toHaveBeenCalled()
    expect(filas.get(m.id)).toMatchObject({ status: 'ACTIVE', releasedReason: null, stripePaymentIntentId: 'pi_M' })
    expect([...filas.values()].filter(f => f.productId === T_L).map(f => f.status)).toEqual(['RELEASED'])
    nuncaDosCobros()
  })

  it('r3b #1, pi_M todavía cancelable → L₂ lo cancela con certeza ANTES de crear pi_L; L₁ recibe el mismo pi_L', async () => {
    const { m, l1, r2, soltarConsultaDeL1 } = await secuenciaR3b('requires_payment_method')
    expect(r2).toMatchObject({ ok: true })
    expect(intentos.get('pi_M')!.status).toBe('canceled')
    soltarConsultaDeL1()
    const r1 = await l1
    expect(r1).toMatchObject({ ok: true, r: { paymentIntentId: (r2 as any).r.paymentIntentId } })
    expect(filas.get(m.id)).toMatchObject({ status: 'RELEASED', releasedReason: 'intento_cancelado' })
    nuncaDosCobros()
  })

  it('r3b #1 con la consulta de L₁ vieja («processing») y pi_M ya rechazado: L₂ lo cancela y entrega pi_L → L₁ NO suelta L', async () => {
    // A la clienta le rechazan la tarjeta de M (vuelve a requires_payment_method) mientras la respuesta de L₁ sigue en el camino.
    const { m, l1, r2, soltarConsultaDeL1 } = await secuenciaR3b('processing', () => {
      intentos.get('pi_M')!.status = 'requires_payment_method'
    })
    expect(r2).toMatchObject({ ok: true })
    expect(intentos.get('pi_M')!.status).toBe('canceled')
    soltarConsultaDeL1()
    expect(await l1).toMatchObject({ ok: false, code: 'PAYMENT_LINK_PAYMENT_IN_PROGRESS' })
    // La ficha de L ya tiene el intento que L₂ entregó con certeza: soltarla dejaría ese pago sin pieza apartada.
    const fichaL = [...filas.values()].find(f => f.stripePaymentIntentId === (r2 as any).r.paymentIntentId)!
    expect(fichaL.status).toBe('ACTIVE')
    expect(filas.get(m.id)).toMatchObject({ status: 'RELEASED', releasedReason: 'intento_cancelado' })
    nuncaDosCobros()
  })

  it('después de que L₁ restauró M: otra L y la propia M reciben 409 «en curso», sin crear intento', async () => {
    const { l1, soltarConsultaDeL1 } = await secuenciaR3b('processing')
    soltarConsultaDeL1()
    await l1
    pausa = async () => {}
    expect(await pagarTalla(T_L)).toMatchObject({ ok: false, code: 'PAYMENT_LINK_PAYMENT_IN_PROGRESS' })
    expect(await pagarTalla(T_M)).toMatchObject({ ok: false, code: 'PAYMENT_LINK_PAYMENT_IN_PROGRESS' })
    expect(piCreate).not.toHaveBeenCalled()
    nuncaDosCobros()
  })

  it('Codex codigo-r4b: B corrige el correo con una copia vieja de la ficha (sin intento) cuando A ya ligó y la clienta confirma → B no la suelta; 409', async () => {
    const creando = puerta()
    const soltando = puerta()
    let enCrear = false
    let enSoltar = false
    pausa = async op => {
      if (op === 'crear-respuesta' && !enCrear) {
        enCrear = true
        await creando.p
      }
      if (op === 'soltar' && !enSoltar) {
        enSoltar = true
        await soltando.p
      }
    }
    // A congela con el correo viejo y espera la respuesta de Stripe al crear.
    const a = pagarTalla(T_L, 'viejo@example.test')
    await hasta(() => enCrear)
    // B, con el correo corregido, reusa la ficha (su copia: sin intento) y se detiene justo antes de soltarla.
    const b = pagarTalla(T_L, 'nuevo@example.test')
    await hasta(() => enSoltar)
    // A liga y entrega su intento; la clienta lo confirma.
    creando.abrir()
    const ra = await a
    expect(ra).toMatchObject({ ok: true })
    intentos.get((ra as any).r.paymentIntentId)!.status = 'processing'
    soltando.abrir()
    expect(await b).toMatchObject({ ok: false, code: 'PAYMENT_LINK_PAYMENT_IN_PROGRESS' })
    const ficha = [...filas.values()].find(f => f.stripePaymentIntentId === (ra as any).r.paymentIntentId)!
    expect(ficha.status).toBe('ACTIVE')
    nuncaDosCobros()
  })

  /** PRNG con semilla (mulberry32): la misma semilla repite la misma intercalación. */
  function azar(semilla: number) {
    let a = semilla >>> 0
    return () => {
      a = (a + 0x6d2b79f5) >>> 0
      let t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  /**
   * Cada operación de fichas y de Stripe cede el turno 0-3 vueltas al azar: con muchas semillas se recorren las intercalaciones
   * de los POST (y de la clienta que confirma su intento o a quien se le rechaza la tarjeta).
   */
  type Post = string | readonly [string, string]
  async function correr(semilla: number, inicio: () => void, tallas: Post[], clienta: 'confirma' | 'rechazo' | 'nada') {
    const r = azar(semilla)
    pausa = async () => {
      const k = Math.floor(r() * 4)
      for (let i = 0; i < k; i++) await new Promise(res => setImmediate(res))
    }
    inicio()
    const posts = tallas.map(t => (typeof t === 'string' ? pagarTalla(t) : pagarTalla(t[0], t[1])))
    const pestaña = (async () => {
      for (let i = 0; i < 30; i++) {
        await pausa('clienta')
        const ligados = [...filas.values()].filter(f => vivo(f.stripePaymentIntentId))
        const objetivo = ligados[Math.floor(r() * Math.max(ligados.length, 1))]
        if (!objetivo || r() < 0.7) continue
        const i2 = intentos.get(objetivo.stripePaymentIntentId as string)!
        if (clienta === 'confirma' && i2.status === 'requires_payment_method') i2.status = 'processing'
        else if (clienta === 'rechazo' && i2.status === 'processing') i2.status = 'requires_payment_method'
      }
    })()
    await Promise.all([...posts, pestaña])
    nuncaDosCobros()
  }

  const SEMILLAS = Array.from({ length: 150 }, (_, i) => i + 1)

  it.each([
    ['misma talla ×3, sin intento ligado', () => undefined, [T_L, T_L, T_L], 'nada'],
    ['misma talla ×3, la clienta confirma lo que se le entrega', () => undefined, [T_L, T_L, T_L], 'confirma'],
    ['tallas distintas (L, M, L) desde cero', () => undefined, [T_L, T_M, T_L], 'confirma'],
    ['M en vuelo sin intento + L, L (r3b #1)', 'm-sin-intento', [T_M, T_L, T_L], 'confirma'],
    ['M con intento cobrando + L, L, M', 'm-processing', [T_L, T_L, T_M], 'rechazo'],
    ['M con intento cancelable + L, M, L', 'm-cancelable', [T_L, T_M, T_L], 'confirma'],
    // Codex codigo-r4b: la clienta corrige su correo a media carrera (otra compra con la misma talla).
    ['misma talla ×3 con el correo corregido a media carrera', () => undefined, [T_L, [T_L, 'nuevo@example.test'], T_L], 'confirma'],
    ['tallas y correos mezclados', 'm-cancelable', [[T_M, 'nuevo@example.test'], T_L, [T_L, 'nuevo@example.test']], 'confirma'],
  ] as const)('%s: en 150 intercalaciones nunca hay dos cobros posibles', async (_n, inicio, tallas, clienta) => {
    for (const semilla of SEMILLAS) {
      filas.clear()
      intentos.clear()
      porLlave.clear()
      entregas = []
      candado = Promise.resolve()
      const sembrarInicio = () => {
        if (typeof inicio === 'function') return
        const m = sembrar({ productId: T_M })
        if (inicio === 'm-processing') ligarM(m, 'processing')
        if (inicio === 'm-cancelable') ligarM(m, 'requires_payment_method')
      }
      try {
        await correr(semilla, sembrarInicio, [...tallas], clienta)
      } catch (err) {
        throw new Error(`semilla ${semilla}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
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

describe('cierre del cobro de la liga por prenda (Task 6)', () => {
  const consumir = consumeHoldInTx as jest.Mock
  const sesion = (merchant: Record<string, unknown> = {}) => ({
    id: 'csess0000000000000000001',
    sessionId: 'pi_talla',
    ecommerceMerchantId: 'cmerch0000000000000000001',
    paymentLinkId: 'cplink00000000000000000001',
    attributedCustomerId: null,
    amount: new Decimal(550),
    currency: 'MXN',
    description: 'Blusa',
    customerEmail: null,
    customerPhone: null,
    customerName: null,
    applicationFeeCents: 580,
    status: 'PENDING',
    metadata: {
      tipAmount: 50,
      items: [{ productId: TALLA_M, productName: 'Blusa · M', quantity: 1, unitPrice: 500, modifiers: [] }],
    },
    paymentLink: {
      id: 'cplink00000000000000000001',
      venueId: VENUE,
      purpose: 'ITEM',
      shortCode: 'abc12345',
      createdById: 'cstaff0000000000000000001',
      attributions: [],
    },
    ecommerceMerchant: {
      id: 'cmerch0000000000000000001',
      providerCredentials: { connectAccountId: 'acct_HOY' },
      provider: { code: 'STRIPE_CONNECT' },
      ...merchant,
    },
  })
  let txClient: any

  beforeEach(() => {
    consumir.mockReset().mockResolvedValue(1)
    crearVale.mockReset().mockResolvedValue({ id: 'cposting00000000000000001' })
    aplicarVale.mockReset().mockResolvedValue({ applied: true })
    prismaMock.checkoutSession.findUnique.mockResolvedValue(sesion() as any)
    prismaMock.checkoutSession.update.mockResolvedValue({} as any)
    prismaMock.paymentLink.update.mockResolvedValue({} as any)
    prismaMock.order.create.mockResolvedValue({ id: 'corder000000000000000001', items: [{ id: 'oi', productId: TALLA_M }] } as any)
    prismaMock.payment.create.mockResolvedValue({ id: 'cpay00000000000000000001' } as any)
    piRetrieve.mockResolvedValue({ id: 'pi_talla', latest_charge: null })
    txClient = { ...prismaMock, __tx: true }
    prismaMock.$transaction.mockImplementation((cb: any) => cb(txClient))
  })
  afterEach(() => prismaMock.$transaction.mockImplementation((cb: any) => cb(prismaMock)))

  const cerrar = () =>
    finalizePaymentLinkCheckout({
      stripeSessionId: 'pi_talla',
      paymentIntentId: 'pi_talla',
      amountPaidCents: 55000,
      stripePaymentMethodType: 'card',
    })

  it('consume la ficha del intento DENTRO de la transacción del cobro', async () => {
    await cerrar()
    expect(consumir).toHaveBeenCalledTimes(1)
    expect(consumir).toHaveBeenCalledWith(txClient, 'pi_talla')
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
  })

  it('ficha ya vencida o soltada (consume 0) → la venta se registra igual: orden, cobro y vale', async () => {
    consumir.mockResolvedValue(0)
    await cerrar()
    expect(prismaMock.order.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
    expect(crearVale).toHaveBeenCalledTimes(1)
    expect(aplicarVale).toHaveBeenCalledWith('cposting00000000000000001', expect.anything())
  })

  it('el cargo se consulta con la cuenta CONGELADA en la ficha, no con la de hoy del negocio', async () => {
    fichas.findFirst.mockResolvedValue({ stripeAccountId: 'acct_CONGELADA' })
    await cerrar()
    expect(fichas.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { stripePaymentIntentId: 'pi_talla' } }))
    expect(piRetrieve).toHaveBeenCalledWith('pi_talla', { expand: ['latest_charge'] }, { stripeAccount: 'acct_CONGELADA' })
  })

  it('con ficha congelada aunque el negocio ya no tenga cuenta conectada → igual consulta el cargo con la congelada', async () => {
    prismaMock.checkoutSession.findUnique.mockResolvedValue(sesion({ providerCredentials: {} }) as any)
    fichas.findFirst.mockResolvedValue({ stripeAccountId: 'acct_CONGELADA' })
    await cerrar()
    expect(piRetrieve).toHaveBeenCalledWith('pi_talla', { expand: ['latest_charge'] }, { stripeAccount: 'acct_CONGELADA' })
  })

  it('regresión: sin ficha (liga de siempre) → la cuenta de hoy del negocio', async () => {
    await cerrar()
    expect(piRetrieve).toHaveBeenCalledWith('pi_talla', { expand: ['latest_charge'] }, { stripeAccount: 'acct_HOY' })
  })

  it('regresión: sesión ya COMPLETED (aviso repetido) → no consume ni crea nada', async () => {
    prismaMock.checkoutSession.findUnique.mockResolvedValue({ ...sesion(), status: 'COMPLETED' } as any)
    await cerrar()
    expect(consumir).not.toHaveBeenCalled()
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })
})
