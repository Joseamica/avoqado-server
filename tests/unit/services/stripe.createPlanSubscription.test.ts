const mockSubCreate = jest.fn()
const mockSubRetrieve = jest.fn()
const mockPriceList = jest.fn()
jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    subscriptions: { create: mockSubCreate, retrieve: mockSubRetrieve },
    prices: { list: mockPriceList },
  }))
})
jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venueFeature: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn().mockResolvedValue({}) },
    feature: {
      findFirst: jest.fn().mockResolvedValue({ id: 'feat-pro', code: 'PLAN_PRO', stripePriceId: 'price_monthly', monthlyPrice: 999 }),
    },
  },
}))

import {
  CODIGOS_PIDE_AUTENTICACION,
  createPlanSubscription,
  pideAutenticacion,
  type CreatePlanSubscriptionInput,
} from '../../../src/services/stripe.service'

beforeEach(() => {
  jest.clearAllMocks()
  process.env.STRIPE_SECRET_KEY = 'sk_test_x'
  mockPriceList.mockResolvedValue({ data: [{ id: 'price_monthly' }] })
  // `clearAllMocks` no tira las respuestas `…Once` sin usar: una prueba que falla a medias se las heredaba a la siguiente.
  mockSubCreate.mockReset().mockResolvedValue({ id: 'sub_1', status: 'trialing' })
})

describe('createPlanSubscription', () => {
  it('trial path: 30-day trial, no coupon, no Stripe Tax (IVA baked into the price)', async () => {
    await createPlanSubscription({
      venueId: 'v1',
      customerId: 'cus_1',
      paymentMethodId: 'pm_1',
      priceId: 'price_cotizado',
      tierCode: 'PLAN_PRO',
      interval: 'monthly',
      trialPeriodDays: 30,
    })
    const arg = mockSubCreate.mock.calls[0][0]
    expect(arg.trial_period_days).toBe(30)
    expect(arg.discounts).toBeUndefined()
    // Stripe Tax is intentionally NOT used: the IVA is baked into the price (tax_behavior
    // 'inclusive'), so automatic_tax must be absent — enabling it would 400 in prod where
    // Stripe Tax isn't configured.
    expect(arg.automatic_tax).toBeUndefined()
  })

  it('pay-now monthly: no trial + INTRO_PRO_3M coupon', async () => {
    await createPlanSubscription({
      venueId: 'v1',
      customerId: 'cus_1',
      paymentMethodId: 'pm_1',
      priceId: 'price_cotizado',
      tierCode: 'PLAN_PRO',
      interval: 'monthly',
      trialPeriodDays: 0,
      coupon: 'INTRO_PRO_3M',
    })
    const arg = mockSubCreate.mock.calls[0][0]
    expect(arg.trial_period_days).toBe(0)
    expect(arg.discounts).toEqual([{ coupon: 'INTRO_PRO_3M' }])
  })

  it('annual: no coupon, cobra con el priceId recibido', async () => {
    await createPlanSubscription({
      venueId: 'v1',
      customerId: 'cus_1',
      paymentMethodId: 'pm_1',
      priceId: 'price_cotizado',
      tierCode: 'PLAN_PRO',
      interval: 'annual',
      trialPeriodDays: 0,
    })
    const arg = mockSubCreate.mock.calls[0][0]
    expect(arg.items[0].price).toBe('price_cotizado')
  })

  it('usa el priceId recibido y no lista por llave', async () => {
    await createPlanSubscription({
      venueId: 'v1',
      customerId: 'cus_1',
      paymentMethodId: 'pm_1',
      priceId: 'price_cotizado',
      tierCode: 'PLAN_PRO',
      interval: 'monthly',
      trialPeriodDays: 0,
    })
    expect(mockSubCreate.mock.calls[0][0].items).toEqual([{ price: 'price_cotizado' }])
    expect(mockPriceList).not.toHaveBeenCalled()
  })
})

/**
 * 🔴 V5-A paso 6 (v5 punto 6): `createPlanSubscription` sólo COBRA. El acceso lo escribe la entrega
 * (`entregarSuscripcionDePlan`), que ve las dos filas de plan bajo el candado del negocio; el `upsert` ciego que
 * había aquí concedía aunque otra obligación viva ocupara el plan, y sin mirar el estado de la suscripción.
 */
describe('cobra, pero NO escribe el acceso', () => {
  it('🔴 no toca VenueFeature: la fila la decide la entrega', async () => {
    const prismaMod = (await import('@/utils/prismaClient')).default as unknown as { venueFeature: { upsert: jest.Mock } }

    await createPlanSubscription({
      venueId: 'v1',
      customerId: 'cus_1',
      paymentMethodId: 'pm_1',
      priceId: 'price_cotizado',
      tierCode: 'PLAN_PRO',
      interval: 'monthly',
      trialPeriodDays: 30,
    })

    expect(mockSubCreate).toHaveBeenCalled()
    expect(prismaMod.venueFeature.upsert).not.toHaveBeenCalled()
  })
})

describe('reusar sólo lo que todavía puede cobrar', () => {
  const conFilaLigada = async () => {
    const prismaMod = (await import('@/utils/prismaClient')).default as unknown as { venueFeature: { findUnique: jest.Mock } }
    prismaMod.venueFeature.findUnique.mockResolvedValueOnce({ stripeSubscriptionId: 'sub_viejo' })
  }
  const pedir = () =>
    createPlanSubscription({
      venueId: 'v1',
      customerId: 'cus_1',
      paymentMethodId: 'pm_1',
      priceId: 'price_cotizado',
      tierCode: 'PLAN_PRO',
      interval: 'monthly',
      trialPeriodDays: 0,
    })

  it('una suscripción ligada que sigue viva se REUSA (un reintento del mismo cobro no cobra otra vez)', async () => {
    await conFilaLigada()
    mockSubRetrieve.mockResolvedValue({ id: 'sub_viejo', status: 'active' })

    await expect(pedir()).resolves.toEqual({ subscriptionId: 'sub_viejo', reused: true })
    expect(mockSubCreate).not.toHaveBeenCalled()
  })

  it('🔴 una ligada que Stripe ya dio por TERMINADA no se reusa: se cobra de nuevo (antes se cerraba el alta con una suscripción muerta)', async () => {
    await conFilaLigada()
    mockSubRetrieve.mockResolvedValue({ id: 'sub_viejo', status: 'canceled' })

    await expect(pedir()).resolves.toEqual({ subscriptionId: 'sub_1', reused: false })
  })

  it('🔴 si no se puede saber si sigue viva, no se decide a ciegas: se lanza (el llamador lo trata como desconocido)', async () => {
    await conFilaLigada()
    mockSubRetrieve.mockRejectedValue(new Error('socket hang up'))

    await expect(pedir()).rejects.toMatchObject({ code: 'SUBSCRIPTION_STATE_UNVERIFIED' })
    expect(mockSubCreate).not.toHaveBeenCalled()
  })
})

/**
 * 🔴 EL GANCHO DEL CARGO (Codex, 21-sep).
 *
 * Entre crear la suscripción en Stripe —el momento en que el dinero se mueve— y que esta función
 * devuelva su id, todavía corre `asegurarAccesoDelPlan`. Si ESA escritura falla, el llamador nunca
 * ve el id y pierde el rastro del cobro que ya ocurrió; su reintento tiene entonces que BUSCAR la
 * suscripción, y ahí es donde nacía el segundo cargo. Por eso el gancho corre ANTES.
 */
describe('alCrearEnStripe: el rastro del cargo, antes que cualquier otra escritura', () => {
  it('🔴 se invoca con el id en cuanto la suscripción existe (el rastro del cargo, antes de devolver)', async () => {
    const orden: string[] = []

    await createPlanSubscription({
      venueId: 'v1',
      customerId: 'cus_1',
      paymentMethodId: 'pm_1',
      priceId: 'price_cotizado',
      tierCode: 'PLAN_PRO',
      interval: 'monthly',
      trialPeriodDays: 30,
      alCrearEnStripe: async (id: string) => {
        orden.push(`gancho:${id}`)
      },
    })

    expect(orden).toEqual(['gancho:sub_1'])
  })

  it('🔴 si el gancho falla, NO se tumba el cobro que ya ocurrió', async () => {
    const r = await createPlanSubscription({
      venueId: 'v1',
      customerId: 'cus_1',
      paymentMethodId: 'pm_1',
      priceId: 'price_cotizado',
      tierCode: 'PLAN_PRO',
      interval: 'monthly',
      trialPeriodDays: 30,
      alCrearEnStripe: async () => {
        throw new Error('la base se cayó')
      },
    })

    expect(r.subscriptionId).toBeTruthy()
  })
})

describe('antesDeCobrar: la frontera entre «preparar» y «pudo cobrarse» (Codex C15)', () => {
  it('se invoca justo antes del POST de Stripe', async () => {
    const orden: string[] = []
    mockSubCreate.mockImplementation(async () => {
      orden.push('post')
      return { id: 'sub_1', status: 'active' }
    })

    await createPlanSubscription({
      venueId: 'v1',
      customerId: 'cus_1',
      paymentMethodId: 'pm_1',
      priceId: 'price_cotizado',
      tierCode: 'PLAN_PRO',
      interval: 'monthly',
      trialPeriodDays: 0,
      antesDeCobrar: () => orden.push('antes'),
    })

    expect(orden).toEqual(['antes', 'post'])
  })

  it('NO se invoca si falla la preparación (no hay plan en el catálogo): nada pudo cobrarse', async () => {
    const prisma = (await import('@/utils/prismaClient')).default as unknown as { feature: { findFirst: jest.Mock } }
    prisma.feature.findFirst.mockResolvedValueOnce(null)
    const antesDeCobrar = jest.fn()

    await expect(
      createPlanSubscription({
        venueId: 'v1',
        customerId: 'cus_1',
        paymentMethodId: 'pm_1',
        priceId: 'price_cotizado',
        tierCode: 'PLAN_PRO',
        interval: 'monthly',
        trialPeriodDays: 0,
        antesDeCobrar,
      }),
    ).rejects.toThrow()
    expect(antesDeCobrar).not.toHaveBeenCalled()
  })
})

describe('🔴 Codex C3: cobra bajo el candado de la regla', () => {
  it('cada llamada a Stripe sin reintentos del SDK (los decide `retry`, con la llave)', async () => {
    await createPlanSubscription({
      venueId: 'v1',
      customerId: 'cus_1',
      paymentMethodId: 'pm_1',
      priceId: 'price_cotizado',
      tierCode: 'PLAN_PRO',
      interval: 'monthly',
      trialPeriodDays: 0,
      idempotencyKey: 'k1',
    })

    expect(mockSubCreate.mock.calls[0][1]).toMatchObject({ idempotencyKey: 'k1', maxNetworkRetries: 0, timeout: expect.any(Number) })
  })
})

/**
 * 🔴 D2 (18-oct): con una tarjeta que pide 3D Secure, el primer cobro on-session con `error_if_incomplete` responde 402
 * `subscription_payment_intent_requires_action` y NO deja nada vivo (medido en Stripe de prueba). Antes eso terminaba en
 * «tu banco rechazó». Con la opción `autenticarEnElNavegador` se crea OTRA VEZ con `default_incomplete` y se devuelve el
 * secreto para que el navegador muestre el reto del banco. El monto lo juzga `activatePlan` (S2), no esta función.
 */
describe('🔴 D2: el banco pide autenticar el primer cobro', () => {
  const alCrearEnStripe = jest.fn().mockResolvedValue(undefined)
  const errorDeAutenticacion = (code = 'subscription_payment_intent_requires_action') =>
    Object.assign(new Error('Payment for this subscription requires additional user action…'), {
      type: 'StripeCardError',
      code,
      statusCode: 402,
    })
  const errorDeConexion = () => Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' })
  const porAutenticar = {
    id: 'sub_3ds',
    status: 'incomplete',
    latest_invoice: { id: 'in_1', status: 'open', confirmation_secret: { type: 'payment_intent', client_secret: 'pi_1_secret_x' } },
  }
  const conSecreto = {
    subscriptionId: 'sub_3ds',
    reused: false,
    conAutenticacion: true,
    requiereAutenticacion: { clientSecret: 'pi_1_secret_x' },
  }
  const pedir = (extra: Partial<CreatePlanSubscriptionInput> = {}) =>
    createPlanSubscription({
      venueId: 'v1',
      customerId: 'cus_1',
      paymentMethodId: 'pm_1',
      priceId: 'price_cotizado',
      tierCode: 'PLAN_PRO',
      interval: 'monthly',
      trialPeriodDays: 0,
      coupon: 'LC_X',
      idempotencyKey: 'plan-activation:org-1:1',
      paymentBehavior: 'error_if_incomplete',
      extraMetadata: { planActivationKey: 'plan-activation:org-1:1', launchRedemptionId: 'red-1' },
      alCrearEnStripe,
      autenticarEnElNavegador: { primerCobroEsperadoCents: 1000, terminarAntesDe: Date.now() + 140_000 },
      ...extra,
    })

  it('con autenticarEnElNavegador, el 402 de autenticación crea la suscripción default_incomplete y devuelve el secreto', async () => {
    mockSubCreate.mockRejectedValueOnce(errorDeAutenticacion()).mockResolvedValueOnce(porAutenticar)

    const r = await pedir()

    expect(mockSubCreate).toHaveBeenCalledTimes(2)
    const [primero] = mockSubCreate.mock.calls[0]
    const [segundo, opciones] = mockSubCreate.mock.calls[1]
    expect(segundo).toMatchObject({
      payment_behavior: 'default_incomplete',
      expand: ['latest_invoice.confirmation_secret'],
      trial_period_days: 0,
      default_payment_method: 'pm_1',
      discounts: [{ coupon: 'LC_X' }],
    })
    expect(segundo.metadata).toEqual({ ...primero.metadata, primerCobroEsperadoCents: '1000' })
    // Lo demás (cliente, precio, descripción, cobro y ajustes de pago) viaja IGUAL que en el #1.
    expect(segundo).toEqual({
      ...primero,
      payment_behavior: 'default_incomplete',
      expand: ['latest_invoice.confirmation_secret'],
      metadata: segundo.metadata,
    })
    expect(opciones).toEqual({ idempotencyKey: 'plan-activation:org-1:1:autenticar', timeout: 15_000, maxNetworkRetries: 0 })
    expect(r).toEqual(conSecreto)
    expect(alCrearEnStripe).toHaveBeenCalledTimes(1)
    expect(alCrearEnStripe).toHaveBeenCalledWith('sub_3ds')
  })

  it('también con el código documentado invoice_payment_intent_requires_action', async () => {
    mockSubCreate.mockRejectedValueOnce(errorDeAutenticacion('invoice_payment_intent_requires_action')).mockResolvedValueOnce(porAutenticar)

    await expect(pedir()).resolves.toEqual(conSecreto)
    expect(mockSubCreate).toHaveBeenCalledTimes(2)
  })

  it('🔴 sin la opción (asistente largo) el 402 de autenticación se propaga intacto y hay UN solo create', async () => {
    const error = errorDeAutenticacion()
    mockSubCreate.mockRejectedValueOnce(error)

    await expect(pedir({ autenticarEnElNavegador: undefined })).rejects.toBe(error)
    expect(mockSubCreate).toHaveBeenCalledTimes(1)
    expect(alCrearEnStripe).not.toHaveBeenCalled()
  })

  it('🔴 un rechazo normal (card_declined) con la opción se propaga y hay UN solo create', async () => {
    const error = Object.assign(new Error('Your card was declined.'), {
      type: 'StripeCardError',
      code: 'card_declined',
      decline_code: 'generic_decline',
      statusCode: 402,
    })
    mockSubCreate.mockRejectedValueOnce(error)

    await expect(pedir()).rejects.toBe(error)
    expect(mockSubCreate).toHaveBeenCalledTimes(1)
    expect(alCrearEnStripe).not.toHaveBeenCalled()
  })

  it('🔴 sin idempotencyKey el 402 de autenticación se propaga intacto: nunca un 2.º create sin llave (que el retry podría duplicar)', async () => {
    const error = errorDeAutenticacion()
    mockSubCreate.mockRejectedValueOnce(error).mockResolvedValueOnce(porAutenticar)

    await expect(pedir({ idempotencyKey: undefined })).rejects.toBe(error)
    expect(mockSubCreate).toHaveBeenCalledTimes(1)
    expect(alCrearEnStripe).not.toHaveBeenCalled()
  })

  it('🔴 un terminarAntesDe que no es número (NaN) falla cerrado: el #2 no sale y lanza «no quedó tiempo»', async () => {
    mockSubCreate.mockRejectedValueOnce(errorDeAutenticacion()).mockResolvedValueOnce(porAutenticar)

    await expect(pedir({ autenticarEnElNavegador: { primerCobroEsperadoCents: 1000, terminarAntesDe: NaN } })).rejects.toThrow(
      'no quedó tiempo en el candado para el segundo intento',
    )
    expect(mockSubCreate).toHaveBeenCalledTimes(1)
    expect(alCrearEnStripe).not.toHaveBeenCalled()
  })

  it('el #2 queda active (factura de $0): devuelve conAutenticacion sin requiereAutenticacion (el monto lo juzga activatePlan, S2.10)', async () => {
    mockSubCreate.mockRejectedValueOnce(errorDeAutenticacion()).mockResolvedValueOnce({
      id: 'sub_3ds',
      status: 'active',
      latest_invoice: { id: 'in_1', status: 'paid', confirmation_secret: null },
    })

    await expect(pedir()).resolves.toEqual({ subscriptionId: 'sub_3ds', reused: false, conAutenticacion: true })
    expect(alCrearEnStripe).toHaveBeenCalledWith('sub_3ds')
  })

  it('el #2 incomplete SIN secreto: lanza, pero el rastro (alCrearEnStripe) ya quedó', async () => {
    mockSubCreate.mockRejectedValueOnce(errorDeAutenticacion()).mockResolvedValueOnce({
      id: 'sub_3ds',
      status: 'incomplete',
      latest_invoice: { id: 'in_1', status: 'open', confirmation_secret: null },
    })

    await expect(pedir()).rejects.toThrow('la suscripción quedó incompleta sin secreto de confirmación')
    expect(alCrearEnStripe).toHaveBeenCalledTimes(1)
    expect(alCrearEnStripe).toHaveBeenCalledWith('sub_3ds')
  })

  /**
   * 🔴 Codex r1 #4 y r2 #2: el #2 corre dentro del candado de la regla común, después de la consulta de reuso
   * y el #1. Cada POST del #2 —el primero y su único reintento— sale sólo si JUSTO antes de mandarlo
   * quedan ≥ 15 s (el `timeout` de una llamada) antes de `terminarAntesDe`. El reloj falso cubre también la espera del
   * `retry`: medir en `shouldRetry` (antes de la espera) no basta, y la 7d es la que lo distingue.
   */
  describe('tiempo: cada POST del #2 se mide contra terminarAntesDe', () => {
    const NO_QUEDO_TIEMPO = 'no quedó tiempo en el candado para el segundo intento'
    const adelantar = (ms: number) => jest.setSystemTime(Date.now() + ms)
    const primeroTardaYPideAutenticar = (ms: number) =>
      mockSubCreate.mockImplementationOnce(async () => {
        adelantar(ms)
        throw errorDeAutenticacion()
      })
    /** Arranca el cobro con el reloj ya en marcha; el veredicto no deja rechazos sin atender mientras corre el reloj. */
    const cobrarConReloj = () =>
      pedir({ autenticarEnElNavegador: { primerCobroEsperadoCents: 1000, terminarAntesDe: Date.now() + 140_000 } }).then(
        valor => ({ valor }),
        error => ({ error }),
      )
    let venueFeature: { findUnique: jest.Mock }

    beforeEach(async () => {
      jest.useFakeTimers({ now: 1_000_000 })
      venueFeature = ((await import('@/utils/prismaClient')).default as unknown as { venueFeature: { findUnique: jest.Mock } }).venueFeature
      // La consulta de reuso: hay una ligada, Stripe tarda 15 s en decir que ya terminó (no se reusa).
      venueFeature.findUnique.mockResolvedValue({ stripeSubscriptionId: 'sub_vieja' })
      mockSubRetrieve.mockImplementation(async () => {
        adelantar(15_000)
        return { id: 'sub_vieja', status: 'canceled' }
      })
    })

    afterEach(() => {
      jest.useRealTimers()
      venueFeature.findUnique.mockResolvedValue(null)
      mockSubRetrieve.mockReset()
    })

    it('🔴 si tras la consulta de reuso y el #1 quedan < 15 s, el #2 NO se manda y lanza «no quedó tiempo»', async () => {
      primeroTardaYPideAutenticar(115_000) // 15 + 115 = 130 s ⇒ quedan 10 s

      const veredicto = cobrarConReloj()
      await jest.runAllTimersAsync()

      expect(await veredicto).toEqual({ error: expect.objectContaining({ message: NO_QUEDO_TIEMPO }) })
      expect(mockSubCreate).toHaveBeenCalledTimes(1)
      expect(alCrearEnStripe).not.toHaveBeenCalled()
    })

    it('el reintento del #2 no sale si al ir a mandarlo quedan < 15 s', async () => {
      primeroTardaYPideAutenticar(95_000) // quedan 30 s
      mockSubCreate.mockImplementationOnce(async () => {
        adelantar(16_000) // el 1.er POST del #2 tarda 16 s y se cae la red ⇒ quedan 14 s
        throw errorDeConexion()
      })

      const veredicto = cobrarConReloj()
      await jest.runAllTimersAsync()

      expect(await veredicto).toEqual({ error: expect.objectContaining({ message: NO_QUEDO_TIEMPO }) })
      expect(mockSubCreate).toHaveBeenCalledTimes(2)
      expect(alCrearEnStripe).not.toHaveBeenCalled()
    })

    it('con tiempo, el #2 reintenta UNA vez y no más', async () => {
      // Dos caídas de red seguidas: #1 + dos POST del #2, y se rinde con el error de red.
      primeroTardaYPideAutenticar(1_000)
      const segundaCaida = errorDeConexion()
      mockSubCreate.mockRejectedValueOnce(errorDeConexion()).mockRejectedValueOnce(segundaCaida)

      const fallido = cobrarConReloj()
      await jest.runAllTimersAsync()

      expect(await fallido).toEqual({ error: segundaCaida })
      expect(mockSubCreate).toHaveBeenCalledTimes(3)

      // Una caída y luego éxito: el reintento devuelve el secreto.
      mockSubCreate.mockClear()
      primeroTardaYPideAutenticar(1_000)
      mockSubCreate.mockRejectedValueOnce(errorDeConexion()).mockResolvedValueOnce(porAutenticar)

      const exitoso = cobrarConReloj()
      await jest.runAllTimersAsync()

      expect(await exitoso).toEqual({ valor: conSecreto })
      expect(mockSubCreate).toHaveBeenCalledTimes(3)
    })

    it('🔴 reintento autorizado con ≥ 16 s, pero el reloj avanza DURANTE la espera: NO sale el 2.º POST si al despertar quedan < 15 s', async () => {
      primeroTardaYPideAutenticar(105_000) // quedan 20 s
      mockSubCreate.mockRejectedValueOnce(errorDeConexion()) // 1.er POST del #2 sale (20 ≥ 15) y se cae sin mover el reloj

      const veredicto = cobrarConReloj()
      await jest.advanceTimersByTimeAsync(0) // llega a la espera del `retry` (que ya decidió reintentar con 20 s)
      expect(mockSubCreate).toHaveBeenCalledTimes(2)

      adelantar(6_000) // mientras espera ⇒ quedan 14 s
      await jest.advanceTimersByTimeAsync(1_250) // la espera máxima del helper: 1000 ms × 1.25 de variación

      expect(await veredicto).toEqual({ error: expect.objectContaining({ message: NO_QUEDO_TIEMPO }) })
      expect(mockSubCreate).toHaveBeenCalledTimes(2)
      expect(alCrearEnStripe).not.toHaveBeenCalled()
    })
  })

  it('pideAutenticacion: sí con los dos códigos de autenticación; no con card_declined, ni con un error que no es de tarjeta', () => {
    expect(CODIGOS_PIDE_AUTENTICACION).toEqual(['subscription_payment_intent_requires_action', 'invoice_payment_intent_requires_action'])
    for (const code of CODIGOS_PIDE_AUTENTICACION) {
      expect(pideAutenticacion({ type: 'StripeCardError', code })).toBe(true)
      expect(pideAutenticacion({ type: 'card_error', code })).toBe(true)
    }
    expect(pideAutenticacion({ type: 'StripeCardError', code: 'card_declined', decline_code: 'generic_decline' })).toBe(false)
    expect(pideAutenticacion({ type: 'StripeInvalidRequestError', code: 'subscription_payment_intent_requires_action' })).toBe(false)
    expect(pideAutenticacion(errorDeConexion())).toBe(false)
    expect(pideAutenticacion(new Error('subscription_payment_intent_requires_action'))).toBe(false)
    expect(pideAutenticacion(null)).toBe(false)
    expect(pideAutenticacion(undefined)).toBe(false)
  })
})

/**
 * Planes editables B2 (Task 4): una compra con comprobante cobra con el fin de prueba que el comprobante firmó (`trial_end`,
 * nunca días contados desde ahora) y con `discounts` explícitos (b2-r9 #1). Sin esas opciones, el cuerpo de siempre.
 */
describe('B2: el fin de prueba del comprobante y los descuentos explícitos', () => {
  const FIN = new Date('2026-12-25T12:34:56.789Z')
  const errorDeAutenticacion = () =>
    Object.assign(new Error('Payment for this subscription requires additional user action…'), {
      type: 'StripeCardError',
      code: 'subscription_payment_intent_requires_action',
      statusCode: 402,
    })
  const porAutenticar = {
    id: 'sub_3ds',
    status: 'incomplete',
    latest_invoice: { id: 'in_1', status: 'open', confirmation_secret: { type: 'payment_intent', client_secret: 'pi_1_secret_x' } },
  }
  const base = (extra: Partial<CreatePlanSubscriptionInput> = {}): CreatePlanSubscriptionInput => ({
    venueId: 'v1',
    customerId: 'cus_1',
    paymentMethodId: 'pm_1',
    priceId: 'price_v2_pro_m',
    tierCode: 'PLAN_PRO',
    interval: 'monthly',
    trialPeriodDays: 0,
    idempotencyKey: 'plan-activation:org-1:1',
    paymentBehavior: 'error_if_incomplete',
    autenticarEnElNavegador: { primerCobroEsperadoCents: 92684, terminarAntesDe: Date.now() + 140_000 },
    ...extra,
  })

  it('con trialEnd manda trial_end en segundos y no trial_period_days; sin trialEnd, el cuerpo de siempre', async () => {
    await createPlanSubscription(base({ trialEnd: FIN }))
    const conFin = mockSubCreate.mock.calls[0][0]
    expect(conFin.trial_end).toBe(Math.floor(FIN.getTime() / 1000))
    expect('trial_period_days' in conFin).toBe(false)

    mockSubCreate.mockClear()
    await createPlanSubscription(base({ trialPeriodDays: 30, paymentBehavior: undefined, autenticarEnElNavegador: undefined }))
    const deHoy = mockSubCreate.mock.calls[0][0]
    expect(deHoy.trial_period_days).toBe(30)
    expect('trial_end' in deHoy).toBe(false)
    expect(Object.keys(deHoy)).toEqual([
      'customer',
      'items',
      'trial_period_days',
      'default_payment_method',
      'description',
      'metadata',
      'collection_method',
      'payment_settings',
    ])
  })

  it('con trialEnd no manda payment_behavior ni intenta el 2.º create de autenticación', async () => {
    await createPlanSubscription(base({ trialEnd: FIN }))
    expect(mockSubCreate.mock.calls[0][0].payment_behavior).toBeUndefined()

    // Con prueba no hay primer cobro: un 402 de autenticación (no debería ocurrir) sale intacto, con UN solo create.
    mockSubCreate.mockReset().mockRejectedValueOnce(errorDeAutenticacion()).mockResolvedValueOnce(porAutenticar)
    await expect(createPlanSubscription(base({ trialEnd: FIN }))).rejects.toMatchObject({
      code: 'subscription_payment_intent_requires_action',
    })
    expect(mockSubCreate).toHaveBeenCalledTimes(1)
  })

  it('🔴 b2-r9 #1: con descuentosExplicitos y sin cupón, los dos create llevan discounts ""; con cupón, [{ coupon }]; sin descuentosExplicitos y sin cupón, el cuerpo no trae la llave discounts (como hoy)', async () => {
    mockSubCreate.mockReset().mockRejectedValueOnce(errorDeAutenticacion()).mockResolvedValueOnce(porAutenticar)
    await createPlanSubscription(base({ descuentosExplicitos: true }))
    expect(mockSubCreate).toHaveBeenCalledTimes(2)
    expect(mockSubCreate.mock.calls[0][0].discounts).toBe('')
    expect(mockSubCreate.mock.calls[1][0].discounts).toBe('')

    mockSubCreate.mockReset().mockRejectedValueOnce(errorDeAutenticacion()).mockResolvedValueOnce(porAutenticar)
    await createPlanSubscription(base({ descuentosExplicitos: true, coupon: 'LC_X' }))
    expect(mockSubCreate.mock.calls[0][0].discounts).toEqual([{ coupon: 'LC_X' }])
    expect(mockSubCreate.mock.calls[1][0].discounts).toEqual([{ coupon: 'LC_X' }])

    mockSubCreate.mockReset().mockResolvedValue({ id: 'sub_1', status: 'active' })
    await createPlanSubscription(base())
    expect('discounts' in mockSubCreate.mock.calls[0][0]).toBe(false)
  })
})

/**
 * Planes editables B2, Task 6 (§16, §18): la prueba SIN tarjeta se abre en Stripe sin método de pago y, si al terminar sigue sin
 * tarjeta, Stripe la cancela (`missing_payment_method: 'cancel'`). La metadata `sinTarjeta: 'true'` es la que la reconoce.
 */
describe('B2 Task 6: la prueba sin tarjeta', () => {
  const FIN = new Date('2026-12-09T16:00:00.000Z')
  const base = (extra: Partial<CreatePlanSubscriptionInput> = {}): CreatePlanSubscriptionInput => ({
    venueId: 'v1',
    customerId: 'cus_1',
    paymentMethodId: 'pm_1',
    priceId: 'price_v2_pro_m',
    tierCode: 'PLAN_PRO',
    interval: 'monthly',
    trialPeriodDays: 0,
    idempotencyKey: 'plan-activation:org-1:1',
    ...extra,
  })

  it('con sinTarjeta: sin default_payment_method, con trial_settings.end_behavior.missing_payment_method "cancel" y el mismo payment_settings; sin trialEnd → Error', async () => {
    await createPlanSubscription(base({ paymentMethodId: undefined, sinTarjeta: true, trialEnd: FIN }))
    const [cuerpo] = mockSubCreate.mock.calls[0] as [Record<string, any>]
    expect('default_payment_method' in cuerpo).toBe(false)
    expect(cuerpo.trial_settings).toEqual({ end_behavior: { missing_payment_method: 'cancel' } })
    expect(cuerpo.trial_end).toBe(Math.floor(FIN.getTime() / 1000))
    expect('trial_period_days' in cuerpo).toBe(false)
    expect(cuerpo.payment_settings).toEqual({ save_default_payment_method: 'on_subscription', payment_method_types: ['card'] })
    expect(cuerpo.collection_method).toBe('charge_automatically')
    expect(cuerpo.metadata).toMatchObject({ sinTarjeta: 'true' })

    // Sin el fin de la prueba no hay prueba sin tarjeta: error de programación, antes de «pudo cobrarse».
    mockSubCreate.mockClear()
    const antesDeCobrar = jest.fn()
    await expect(createPlanSubscription(base({ paymentMethodId: undefined, sinTarjeta: true, antesDeCobrar }))).rejects.toThrow(Error)
    expect(antesDeCobrar).not.toHaveBeenCalled()
    expect(mockSubCreate).not.toHaveBeenCalled()
  })

  it('sin sinTarjeta y sin paymentMethodId → Error; con paymentMethodId, el cuerpo de hoy', async () => {
    const antesDeCobrar = jest.fn()
    await expect(createPlanSubscription(base({ paymentMethodId: undefined, trialEnd: FIN, antesDeCobrar }))).rejects.toThrow(Error)
    expect(antesDeCobrar).not.toHaveBeenCalled()
    expect(mockSubCreate).not.toHaveBeenCalled()

    await createPlanSubscription(base({ trialEnd: FIN }))
    const [cuerpo] = mockSubCreate.mock.calls[0] as [Record<string, any>]
    expect(cuerpo.default_payment_method).toBe('pm_1')
    expect('trial_settings' in cuerpo).toBe(false)
    expect(cuerpo.metadata).not.toHaveProperty('sinTarjeta')
    expect(Object.keys(cuerpo)).toEqual([
      'customer',
      'items',
      'trial_end',
      'default_payment_method',
      'description',
      'metadata',
      'collection_method',
      'payment_settings',
    ])
  })
})
