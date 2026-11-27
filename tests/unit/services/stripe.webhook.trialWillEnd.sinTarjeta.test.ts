/**
 * Planes editables (B2, Task 9, §18): `trial_will_end` de una prueba SIN tarjeta (metadata `sinTarjeta: 'true'`, Ruling P6).
 *
 * Hoy el aviso dice «cobraremos $X a tu tarjeta» a toda prueba. La prueba sin tarjeta, en cambio, dice lo que Stripe tiene en este
 * momento: qué tarjeta cobrará (`tarjetaQueCobraria`, con el cliente leído por `clienteDeStripeVivo`) o que no hay ninguna y el
 * negocio sigue en Gratis, y cuánto (`amount_due` de la vista previa). Lo dicen el correo de Task 6 y el aviso en la app, con el
 * mismo texto. 🔴 Si la tarjeta no se pudo leer, no se dice «sin tarjeta»: no sale nada y el evento queda FAILED para que la
 * conciliación lo repita, como un `retrieve` fallido. Sin `sinTarjeta`, todo como hoy.
 *
 * La entrada real: `handleStripeWebhookEvent` con el evento como lo manda Stripe. El correo es el real (sólo se intercepta la
 * salida, `sendEmail`); `noHabraCobro`, `montoDelSiguienteCobro` y `tarjetaQueCobraria` van reales contra Stripe en memoria.
 */
import Stripe from 'stripe'

// El SDK de Stripe que construye `tarjetaQueCobraria` (el cliente, sus métodos y sus fuentes).
jest.mock('stripe', () => {
  const customersRetrieve = jest.fn()
  const retrieveSource = jest.fn()
  const paymentMethodsRetrieve = jest.fn()
  const ctor = jest.fn().mockImplementation(() => ({
    customers: { retrieve: customersRetrieve, retrieveSource },
    paymentMethods: { retrieve: paymentMethodsRetrieve },
    subscriptions: { list: jest.fn().mockResolvedValue({ data: [] }) },
  })) as jest.Mock & Record<string, jest.Mock>
  ctor.__customersRetrieve = customersRetrieve
  ctor.__retrieveSource = retrieveSource
  ctor.__paymentMethodsRetrieve = paymentMethodsRetrieve
  return ctor
})
const sdk = require('stripe') as jest.Mock & Record<string, jest.Mock>

// El cliente de Stripe del webhook: la suscripción vigente y la vista previa de la próxima factura.
const mockSubRetrieve = jest.fn()
const mockPreview = jest.fn()
jest.mock('@/services/stripe.service', () => ({
  __esModule: true,
  default: jest.fn(),
  stripe: {
    subscriptions: { retrieve: (...a: unknown[]) => mockSubRetrieve(...a) },
    invoices: { createPreview: (...a: unknown[]) => mockPreview(...a) },
  },
  // La misma regla que `stripe.service.ts`: «no existe» sólo con `resource_missing` o un 404.
  stripeAfirmaQueNoExiste: (error: unknown) => {
    const e = error as { code?: string; statusCode?: number; type?: string } | null
    return !!e && (e.code === 'resource_missing' || (e.type === 'StripeInvalidRequestError' && e.statusCode === 404))
  },
  estadoDeLaSuscripcion: jest.fn(),
  suscripcionVendeElPlan: jest.fn().mockResolvedValue(true),
  entregarSuscripcionDePlan: jest.fn().mockResolvedValue(null),
  suscripcionVigente: jest.fn(),
  handlePaymentFailure: jest.fn(),
  generateBillingPortalUrl: jest.fn(),
  fulfillPlanCheckout: jest.fn(),
}))
jest.mock('@/services/dashboard/seatReconciliation.service', () => ({
  __esModule: true,
  executeSeatReconciliation: jest.fn().mockResolvedValue(0),
  reactivateSeatCapDeactivated: jest.fn().mockResolvedValue(0),
}))
jest.mock('@/services/dashboard/creditPack.public.service', () => ({ __esModule: true, fulfillPurchase: jest.fn() }))
jest.mock('@/services/access/planNotification.service', () => ({ __esModule: true, resolvePlanNotificationTarget: jest.fn() }))
jest.mock('@/services/dashboard/notification.dashboard.service', () => ({ createNotification: jest.fn() }))
jest.mock('@/services/dashboard/token-budget.service', () => ({ tokenBudgetService: {} }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getServer: () => null, broadcastToVenue: jest.fn() } }))
jest.mock('@/services/launchCampaigns/hybridLifecycle.service', () => ({ handleHybridStripeEvent: jest.fn().mockResolvedValue(false) }))
jest.mock('@/services/launchCampaigns/hybridCampaign.service', () => ({
  __esModule: true,
  getPublicBasicPlan: jest.fn().mockResolvedValue(null),
}))

import { prismaMock } from '@tests/__helpers__/setup'
import { definicionDePrueba, idsDeLaVersion, punteroA } from '@tests/__helpers__/planOfferFixtures'
import logger from '@/config/logger'
import emailService from '@/services/email.service'
import * as planNotification from '@/services/access/planNotification.service'
import { createNotification } from '@/services/dashboard/notification.dashboard.service'
import { handleStripeWebhookEvent } from '@/services/stripe.webhook.service'

const DIA = 86_400_000
const LECTURA_ACOTADA = { timeout: 5_000, maxNetworkRetries: 0 }
const FIN_S = Math.floor((Date.now() + 3 * DIA) / 1000)
const FECHA = new Date(FIN_S * 1000).toLocaleDateString('es-MX', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'America/Mexico_City',
})

/** La prueba sin tarjeta que Stripe tiene hoy: Pro mensual de la v2 ($799 + IVA = $926.84), sin método de pago. */
const prueba = (over: Record<string, unknown> = {}) => ({
  id: 'sub_prueba',
  object: 'subscription',
  status: 'trialing',
  customer: 'cus_1',
  default_payment_method: null,
  default_source: null,
  trial_end: FIN_S,
  cancel_at_period_end: false,
  cancel_at: null,
  pause_collection: null,
  items: { data: [{ price: { recurring: { interval: 'month' } } }] },
  metadata: { venueId: 'venue-1', featureCode: 'PLAN_PRO', sinTarjeta: 'true', planOfferVersion: '2' },
  ...over,
})

/** El cliente de Stripe, como lo devuelve `customers.retrieve` con la tarjeta predeterminada y la fuente expandidas. */
const cliente = (over: Record<string, unknown> = {}) => ({
  id: 'cus_1',
  object: 'customer',
  invoice_settings: { default_payment_method: null },
  default_source: null,
  ...over,
})

const evento = (sub: ReturnType<typeof prueba>, id = 'evt_trial_will_end') =>
  ({ id, object: 'event', type: 'customer.subscription.trial_will_end', data: { object: sub } }) as unknown as Stripe.Event

let enviar: jest.SpyInstance
let correoSinTarjeta: jest.SpyInstance
let correoDeHoy: jest.SpyInstance

/** Lo que salió por correo (texto plano). */
const textoEnviado = () => String((enviar.mock.calls[0][0] as { text?: string }).text ?? '')
const avisosEnLaApp = () => (createNotification as jest.Mock).mock.calls.map((c: unknown[]) => (c[0] as { message: string }).message)
const ultimoEstadoDelEvento = () => {
  const llamadas = prismaMock.webhookEvent.update.mock.calls.map((c: unknown[]) => (c[0] as { data: { status?: string } }).data.status)
  return llamadas.filter(Boolean).pop()
}

/** Lo que dice la app con y sin tarjeta, con el mismo texto que el correo. */
const SIN_TARJETA = (monto: string) =>
  `Tu prueba de Avoqado Pro termina el ${FECHA}. Para seguir con Avoqado Pro, pon tu tarjeta en «Tu plan»: ese día se cobrarán ${monto}. Si no la pones, tu negocio sigue en Gratis.`
const CON_TARJETA = (monto: string, tarjeta: string) =>
  `Tu prueba de Avoqado Pro termina el ${FECHA}. Ese día se cobrarán ${monto} en tu tarjeta ${tarjeta}; puedes cambiarla o cancelar en «Tu plan».`

beforeEach(() => {
  mockSubRetrieve.mockReset()
  mockPreview.mockReset().mockResolvedValue({ amount_due: 92684, total: 92684 })
  sdk.__customersRetrieve.mockReset().mockResolvedValue(cliente())
  sdk.__retrieveSource.mockReset()
  sdk.__paymentMethodsRetrieve.mockReset()
  enviar = jest.spyOn(emailService, 'sendEmail').mockResolvedValue(true)
  correoSinTarjeta = jest.spyOn(emailService, 'sendPlanFreeTrialEndingEmail')
  correoDeHoy = jest.spyOn(emailService, 'sendPlanRenewalReminderEmail')
  ;(planNotification.resolvePlanNotificationTarget as jest.Mock).mockResolvedValue({
    email: 'negocio@example.com',
    locale: 'es',
    venueName: 'Negocio de prueba',
    staffId: 'staff-owner',
  })
  ;(createNotification as jest.Mock).mockResolvedValue({})
  prismaMock.webhookEvent.create.mockResolvedValue({ id: 'we_1' } as never)
  prismaMock.webhookEvent.update.mockResolvedValue({} as never)
  prismaMock.webhookEvent.findUnique.mockResolvedValue({ retryCount: 1 } as never)
  prismaMock.venue.findUnique.mockResolvedValue({ id: 'venue-1' } as never)
  prismaMock.planOfferPointer.findUnique.mockResolvedValue(null as never)
  prismaMock.venueFeature.findFirst.mockResolvedValue({
    id: 'vf_1',
    venueId: 'venue-1',
    feature: { code: 'PLAN_PRO', name: 'Avoqado Pro' },
    venue: { name: 'Negocio de prueba', status: 'ACTIVE', slug: 'negocio-de-prueba', timezone: 'America/Mexico_City' },
  } as never)
  prismaMock.staffVenue.findMany.mockResolvedValue([
    { staff: { id: 'staff-owner', email: 'owner@example.com' } },
    { staff: { id: 'staff-admin', email: 'admin@example.com' } },
  ] as never)
})

afterEach(() => {
  enviar.mockRestore()
  correoSinTarjeta.mockRestore()
  correoDeHoy.mockRestore()
})

describe('trial_will_end de la prueba sin tarjeta', () => {
  it('B4 (M6, M7): con la v2 «Plus» el aviso en la app, su metadata y el correo dicen Plus; la versión se lee UNA vez por aviso, no por persona', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(
      punteroA('cv2', 2, definicionDePrueba({ ids: idsDeLaVersion('v2'), nombres: { PRO: 'Plus' } })) as never,
    )
    mockSubRetrieve.mockResolvedValue(prueba())
    await handleStripeWebhookEvent(evento(prueba()))

    expect(correoSinTarjeta).toHaveBeenCalledWith('negocio@example.com', expect.objectContaining({ planName: 'Plus' }))
    expect(avisosEnLaApp()).toEqual([
      SIN_TARJETA('$926.84').replace(/Avoqado Pro/g, 'Avoqado Plus'),
      SIN_TARJETA('$926.84').replace(/Avoqado Pro/g, 'Avoqado Plus'),
    ])
    const metadatas = (createNotification as jest.Mock).mock.calls.map(
      (c: unknown[]) => (c[0] as { metadata: { featureName: string } }).metadata,
    )
    expect(metadatas.map(m => m.featureName)).toEqual(['Plan Avoqado Plus', 'Plan Avoqado Plus'])

    // Con 5 personas en el equipo se lee la versión las mismas veces que con 2.
    const lecturasCon2 = prismaMock.planOfferPointer.findUnique.mock.calls.length
    prismaMock.planOfferPointer.findUnique.mockClear()
    ;(createNotification as jest.Mock).mockClear()
    prismaMock.staffVenue.findMany.mockResolvedValue(
      [1, 2, 3, 4, 5].map(n => ({ staff: { id: `staff-${n}`, email: `s${n}@example.com` } })) as never,
    )
    mockSubRetrieve.mockResolvedValue(prueba())
    await handleStripeWebhookEvent(evento(prueba(), 'evt_trial_will_end_5'))
    expect((createNotification as jest.Mock).mock.calls).toHaveLength(5)
    expect(prismaMock.planOfferPointer.findUnique.mock.calls.length).toBe(lecturasCon2)
  })

  it('🔴 §18: trial_will_end de una prueba sin tarjeta y sin tarjeta guardada → «pon tu tarjeta… se cobrarán $926.84… si no, sigues en Gratis» con el amount_due de la vista previa, en el correo y en la app', async () => {
    mockSubRetrieve.mockResolvedValue(prueba())

    await handleStripeWebhookEvent(evento(prueba()))

    // El correo de Task 6, con el monto de la vista previa y «sin tarjeta».
    expect(correoSinTarjeta).toHaveBeenCalledTimes(1)
    expect(correoSinTarjeta).toHaveBeenCalledWith(
      'negocio@example.com',
      expect.objectContaining({
        locale: 'es',
        endDate: new Date(FIN_S * 1000),
        planName: 'Pro',
        montoAlTerminarCents: 92684,
        tarjeta: null,
        timeZone: 'America/Mexico_City',
        billingUrl: expect.stringContaining('/venues/negocio-de-prueba/'),
      }),
    )
    expect(textoEnviado()).toContain('pon tu tarjeta en «Tu plan»; si no, sigues en Gratis.')
    expect(textoEnviado()).toContain('se cobrarán $926.84')
    // Nunca el «cobraremos a tu tarjeta» de hoy.
    expect(correoDeHoy).not.toHaveBeenCalled()
    // La app, con el mismo texto, a cada OWNER/ADMIN, sólo IN_APP.
    expect(avisosEnLaApp()).toEqual([SIN_TARJETA('$926.84'), SIN_TARJETA('$926.84')])
    expect((createNotification as jest.Mock).mock.calls[0][0].channels).toEqual(['IN_APP'])
    // La tarjeta se lee del cliente vivo, con el tope de las lecturas que sólo informan.
    expect(sdk.__customersRetrieve).toHaveBeenCalledWith(
      'cus_1',
      { expand: ['invoice_settings.default_payment_method', 'default_source'] },
      LECTURA_ACOTADA,
    )
    expect(mockPreview).toHaveBeenCalledWith({ subscription: 'sub_prueba' }, LECTURA_ACOTADA)
    expect(ultimoEstadoDelEvento()).toBe('SUCCESS')
  })

  it('🔴 §18: con una tarjeta guardada en el cliente (o por default_source) → «se cobrarán $926.84 en tu tarjeta Visa ••••4242»', async () => {
    const conPredeterminada = cliente({
      invoice_settings: {
        default_payment_method: { id: 'pm_1', object: 'payment_method', type: 'card', card: { brand: 'visa', last4: '4242' } },
      },
    })
    const conFuente = cliente({ default_source: { id: 'card_1', object: 'card', brand: 'Visa', last4: '4242' } })

    for (const [guardada, tarjeta] of [
      [conPredeterminada, { brand: 'visa', last4: '4242' }],
      [conFuente, { brand: 'Visa', last4: '4242' }],
    ] as const) {
      correoSinTarjeta.mockClear()
      enviar.mockClear()
      ;(createNotification as jest.Mock).mockClear()
      sdk.__customersRetrieve.mockResolvedValue(guardada)
      mockSubRetrieve.mockResolvedValue(prueba())

      await handleStripeWebhookEvent(evento(prueba()))

      expect(correoSinTarjeta).toHaveBeenCalledWith(
        'negocio@example.com',
        expect.objectContaining({ montoAlTerminarCents: 92684, tarjeta }),
      )
      expect(textoEnviado()).toContain('se cobrarán $926.84 en tu tarjeta Visa ••••4242')
      // La app dice la marca como la lee una persona («Visa»), nunca la clave de Stripe (`visa`).
      expect(avisosEnLaApp()).toEqual([CON_TARJETA('$926.84', 'Visa ••••4242'), CON_TARJETA('$926.84', 'Visa ••••4242')])
      expect(avisosEnLaApp()[0]).not.toContain('visa')
    }
  })

  it('con saldo a favor, el monto es el amount_due de la vista previa; sin vista previa, el aviso sin monto; con cancelación programada, ninguno', async () => {
    // Saldo a favor: la vista previa ya lo aplica (amount_due < total).
    mockPreview.mockResolvedValue({ amount_due: 42684, total: 92684 })
    mockSubRetrieve.mockResolvedValue(prueba())
    await handleStripeWebhookEvent(evento(prueba()))
    expect(correoSinTarjeta.mock.calls[0][1]).toMatchObject({ montoAlTerminarCents: 42684, tarjeta: null })
    expect(avisosEnLaApp()[0]).toBe(SIN_TARJETA('$426.84'))

    // Sin vista previa: el correo y la app salen igual, sin la frase del monto (la prueba sin tarjeta no promete un cobro).
    correoSinTarjeta.mockClear()
    enviar.mockClear()
    ;(createNotification as jest.Mock).mockClear()
    mockPreview.mockRejectedValue(new Error('Stripe 503'))
    await handleStripeWebhookEvent(evento(prueba(), 'evt_2'))
    expect(correoSinTarjeta).toHaveBeenCalledTimes(1)
    expect(correoSinTarjeta.mock.calls[0][1]).not.toHaveProperty('montoAlTerminarCents')
    expect(correoSinTarjeta.mock.calls[0][1]).toMatchObject({ tarjeta: null })
    expect(textoEnviado()).not.toMatch(/\$/)
    expect(avisosEnLaApp()[0]).toBe(
      `Tu prueba de Avoqado Pro termina el ${FECHA}. Para seguir con Avoqado Pro, pon tu tarjeta en «Tu plan». Si no la pones, tu negocio sigue en Gratis.`,
    )

    // Sin vista previa y con tarjeta: la frase de la tarjeta sin monto.
    correoSinTarjeta.mockClear()
    ;(createNotification as jest.Mock).mockClear()
    sdk.__customersRetrieve.mockResolvedValue(
      cliente({ invoice_settings: { default_payment_method: { id: 'pm_1', type: 'card', card: { brand: 'amex', last4: '0005' } } } }),
    )
    await handleStripeWebhookEvent(evento(prueba(), 'evt_3'))
    expect(avisosEnLaApp()[0]).toBe(
      `Tu prueba de Avoqado Pro termina el ${FECHA}. Ese día se cobrará tu plan en tu tarjeta American Express ••••0005; puedes cambiarla o cancelar en «Tu plan».`,
    )

    // Con la cancelación programada (al fin del periodo o con `cancel_at` antes del fin): nada promete que la prueba sigue.
    for (const cancelada of [prueba({ cancel_at_period_end: true }), prueba({ cancel_at: FIN_S })]) {
      correoSinTarjeta.mockClear()
      ;(createNotification as jest.Mock).mockClear()
      sdk.__customersRetrieve.mockClear()
      mockSubRetrieve.mockResolvedValue(cancelada)
      await handleStripeWebhookEvent(evento(cancelada, 'evt_cancelada'))
      expect(correoSinTarjeta).not.toHaveBeenCalled()
      expect(correoDeHoy).not.toHaveBeenCalled()
      expect(createNotification).not.toHaveBeenCalled()
      expect(sdk.__customersRetrieve).not.toHaveBeenCalled()
    }
  })

  it('un cliente borrado en Stripe dice «sin tarjeta»', async () => {
    sdk.__customersRetrieve.mockResolvedValue({ id: 'cus_1', object: 'customer', deleted: true })
    mockSubRetrieve.mockResolvedValue(prueba())

    await handleStripeWebhookEvent(evento(prueba()))

    expect(correoSinTarjeta.mock.calls[0][1]).toMatchObject({ tarjeta: null, montoAlTerminarCents: 92684 })
    expect(avisosEnLaApp()[0]).toBe(SIN_TARJETA('$926.84'))
  })

  it('🔴 la tarjeta no se pudo leer (tiempo agotado): no sale nada, nunca «sin tarjeta», el evento queda FAILED y la repetición avisa', async () => {
    sdk.__customersRetrieve.mockRejectedValueOnce(Object.assign(new Error('Request timed out'), { type: 'StripeConnectionError' }))
    mockSubRetrieve.mockResolvedValue(prueba())

    // Como un `retrieve` fallido: el procesamiento falla (el controlador igual contesta 200 a Stripe).
    await expect(handleStripeWebhookEvent(evento(prueba()))).rejects.toThrow('No se pudo leer qué tarjeta cobrará Stripe')

    expect(correoSinTarjeta).not.toHaveBeenCalled()
    expect(correoDeHoy).not.toHaveBeenCalled()
    expect(enviar).not.toHaveBeenCalled()
    expect(createNotification).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no se pudo leer'),
      expect.objectContaining({ subscriptionId: 'sub_prueba' }),
    )
    // FAILED: la conciliación de webhooks lo repite (nada salió, así que la repetición no duplica).
    expect(ultimoEstadoDelEvento()).toBe('FAILED')

    // La repetición (la conciliación ya tiene el evento) con Stripe sano: sale el aviso, una vez.
    prismaMock.webhookEvent.update.mockClear()
    await handleStripeWebhookEvent(evento(prueba()), { claimedEventId: 'we_1' })
    expect(correoSinTarjeta).toHaveBeenCalledTimes(1)
    expect(avisosEnLaApp()).toEqual([SIN_TARJETA('$926.84'), SIN_TARJETA('$926.84')])
    expect(ultimoEstadoDelEvento()).toBe('SUCCESS')
  })

  it('una prueba con tarjeta de hoy (sin sinTarjeta): el aviso de hoy, con las mismas llamadas', async () => {
    const deHoy = prueba({ default_payment_method: 'pm_1', metadata: { venueId: 'venue-1', featureCode: 'PLAN_PRO' } })
    mockSubRetrieve.mockResolvedValue(deHoy)

    await handleStripeWebhookEvent(evento(deHoy))

    // Las mismas llamadas a Stripe: la suscripción vigente y la vista previa, con sus argumentos de hoy; nada del cliente.
    expect(mockSubRetrieve).toHaveBeenCalledTimes(1)
    expect(mockSubRetrieve).toHaveBeenCalledWith('sub_prueba')
    expect(mockPreview).toHaveBeenCalledTimes(1)
    expect(mockPreview).toHaveBeenCalledWith({ subscription: 'sub_prueba' })
    expect(sdk.__customersRetrieve).not.toHaveBeenCalled()
    expect(sdk.__paymentMethodsRetrieve).not.toHaveBeenCalled()
    // El correo y el aviso de hoy.
    expect(correoSinTarjeta).not.toHaveBeenCalled()
    expect(correoDeHoy).toHaveBeenCalledTimes(1)
    expect(correoDeHoy).toHaveBeenCalledWith(
      'negocio@example.com',
      expect.objectContaining({ amountCents: 92684, isTrialEnd: true, planName: 'Pro' }),
    )
    expect(avisosEnLaApp()[0]).toBe(
      `Tu prueba de Avoqado Pro termina el ${FECHA}. Ese día cobraremos $926.84 a tu tarjeta; cancela antes desde Facturación si no quieres continuar.`,
    )

    // Y sin monto, como hoy: sin correo y el aviso de la app sin monto.
    correoDeHoy.mockClear()
    ;(createNotification as jest.Mock).mockClear()
    mockPreview.mockResolvedValue({})
    await handleStripeWebhookEvent(evento(deHoy, 'evt_sin_monto'))
    expect(correoDeHoy).not.toHaveBeenCalled()
    expect(correoSinTarjeta).not.toHaveBeenCalled()
    expect(avisosEnLaApp()[0]).toBe(
      `Tu prueba de Avoqado Pro termina el ${FECHA}. Ese día se cobrará a tu tarjeta; cancela antes desde Facturación si no quieres continuar.`,
    )
  })
})
