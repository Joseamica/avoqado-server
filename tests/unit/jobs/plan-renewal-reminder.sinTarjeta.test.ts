/**
 * Planes editables (B2, Task 9, §18): el recordatorio diario de una prueba SIN tarjeta (metadata `sinTarjeta: 'true'`, Ruling P6).
 *
 * Hoy el recordatorio de una prueba dice «cobraremos $X a tu tarjeta». La prueba sin tarjeta dice, con lo que Stripe tiene en este
 * momento, qué tarjeta cobrará (`tarjetaQueCobraria`) o que no hay ninguna y el negocio sigue en Gratis, y cuánto (la vista
 * previa). Es el correo de Task 6. El sello (`renewalReminderSentAt`, una vez por periodo) y el manejo de errores, los de hoy.
 * 🔴 Si la tarjeta no se pudo leer, nunca dice «sin tarjeta»: no sale, no se sella y la corrida siguiente lo vuelve a intentar.
 * Sin `sinTarjeta`, todo como hoy.
 *
 * La entrada real: `new PlanRenewalReminderJob().runNow()`. El correo es el real (sólo se intercepta `sendEmail`).
 */
import { prismaMock } from '@tests/__helpers__/setup'
import logger from '@/config/logger'
import emailService from '@/services/email.service'
import * as planNotification from '@/services/access/planNotification.service'
import { PlanRenewalReminderJob } from '@/jobs/plan-renewal-reminder.job'

// Un solo Stripe en memoria para el job y para `tarjetaQueCobraria` (los dos hacen `new Stripe(...)`).
jest.mock('stripe', () => {
  const fns = {
    subscriptionsRetrieve: jest.fn(),
    createPreview: jest.fn(),
    customersRetrieve: jest.fn(),
    retrieveSource: jest.fn(),
    paymentMethodsRetrieve: jest.fn(),
  }
  const ctor = jest.fn().mockImplementation(() => ({
    subscriptions: { retrieve: fns.subscriptionsRetrieve },
    invoices: { createPreview: fns.createPreview },
    customers: { retrieve: fns.customersRetrieve, retrieveSource: fns.retrieveSource },
    paymentMethods: { retrieve: fns.paymentMethodsRetrieve },
  })) as jest.Mock & { __fns: typeof fns }
  ctor.__fns = fns
  return ctor
})
const stripe = (require('stripe') as jest.Mock & { __fns: Record<string, jest.Mock> }).__fns

jest.mock('@/services/access/planNotification.service', () => ({ __esModule: true, resolvePlanNotificationTarget: jest.fn() }))
jest.mock('@/services/dashboard/planState.service', () => ({ __esModule: true, getPlanState: jest.fn() }))
jest.mock('@/services/launchCampaigns/hybridCampaign.service', () => ({
  __esModule: true,
  getPublicBasicPlan: jest.fn().mockResolvedValue(null),
}))

const DIA_S = 86_400
const LECTURA_ACOTADA = { timeout: 5_000, maxNetworkRetries: 0 }
const nowS = Math.floor(Date.now() / 1000)
const FIN_S = nowS + 8 * DIA_S

/** La prueba sin tarjeta de Pro mensual de la v2 ($926.84 con IVA), que termina en 8 días. */
const prueba = (over: Record<string, unknown> = {}) => ({
  id: 'sub_1',
  status: 'trialing',
  customer: 'cus_1',
  default_payment_method: null,
  default_source: null,
  trial_end: FIN_S,
  cancel_at_period_end: false,
  cancel_at: null,
  current_period_start: nowS - 22 * DIA_S,
  current_period_end: FIN_S,
  items: { data: [{ price: { recurring: { interval: 'month' } } }] },
  metadata: { featureCode: 'PLAN_PRO', sinTarjeta: 'true', planOfferVersion: '2' },
  ...over,
})
const cliente = (over: Record<string, unknown> = {}) => ({
  id: 'cus_1',
  object: 'customer',
  invoice_settings: { default_payment_method: null },
  default_source: null,
  ...over,
})

/** La fila del plan, con su sello real: lo que escribe el `update` del job es lo que lee la corrida siguiente. */
let sello: Date | null
const fila = () => ({
  id: 'vf1',
  venueId: 'venue-1',
  stripeSubscriptionId: 'sub_1',
  renewalReminderSentAt: sello,
  freeTrialNoticeFor: null,
  feature: { code: 'PLAN_PRO' },
  venue: { slug: 'negocio-de-prueba', timezone: 'America/Mexico_City' },
})

let enviar: jest.SpyInstance
let correoSinTarjeta: jest.SpyInstance
let correoDeHoy: jest.SpyInstance
const textoEnviado = () => String((enviar.mock.calls[0][0] as { text?: string }).text ?? '')
const run = () => new PlanRenewalReminderJob().runNow()

beforeEach(() => {
  sello = null
  for (const fn of Object.values(stripe)) fn.mockReset()
  stripe.createPreview.mockResolvedValue({ amount_due: 92684, total: 92684 })
  stripe.customersRetrieve.mockResolvedValue(cliente())
  stripe.subscriptionsRetrieve.mockResolvedValue(prueba())
  enviar = jest.spyOn(emailService, 'sendEmail').mockResolvedValue(true)
  correoSinTarjeta = jest.spyOn(emailService, 'sendPlanFreeTrialEndingEmail')
  correoDeHoy = jest.spyOn(emailService, 'sendPlanRenewalReminderEmail')
  ;(planNotification.resolvePlanNotificationTarget as jest.Mock).mockResolvedValue({
    email: 'owner@example.com',
    locale: 'es',
    venueName: 'Negocio de prueba',
    staffId: 'staff-owner',
  })
  // Sólo la lectura de `run()` (activas con suscripción) trae la fila; las otras dos pasadas del job, ninguna.
  prismaMock.venueFeature.findMany.mockImplementation((async (args: { where: { active?: boolean; stripeSubscriptionId: unknown } }) =>
    args.where.active === true && args.where.stripeSubscriptionId !== null ? [fila()] : []) as never)
  prismaMock.venueFeature.update.mockImplementation((async (args: { data: { renewalReminderSentAt: Date } }) => {
    sello = args.data.renewalReminderSentAt
    return {}
  }) as never)
})

afterEach(() => {
  enviar.mockRestore()
  correoSinTarjeta.mockRestore()
  correoDeHoy.mockRestore()
})

describe('recordatorio de la prueba sin tarjeta', () => {
  it('🔴 la prueba sin tarjeta a 8 días: el recordatorio dice «pon tu tarjeta» con el monto de la vista previa y sella como hoy; la segunda corrida no lo repite', async () => {
    await run()

    expect(correoSinTarjeta).toHaveBeenCalledTimes(1)
    expect(correoSinTarjeta).toHaveBeenCalledWith(
      'owner@example.com',
      expect.objectContaining({
        locale: 'es',
        venueName: 'Negocio de prueba',
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
    expect(correoDeHoy).not.toHaveBeenCalled()
    // La tarjeta, del cliente vivo, con el tope de las lecturas que sólo informan; la vista previa, igual.
    expect(stripe.customersRetrieve).toHaveBeenCalledWith(
      'cus_1',
      { expand: ['invoice_settings.default_payment_method', 'default_source'] },
      LECTURA_ACOTADA,
    )
    expect(stripe.createPreview).toHaveBeenCalledWith({ subscription: 'sub_1' }, LECTURA_ACOTADA)
    // El sello de hoy, una vez por periodo.
    expect(prismaMock.venueFeature.update).toHaveBeenCalledTimes(1)
    expect(prismaMock.venueFeature.update).toHaveBeenCalledWith({ where: { id: 'vf1' }, data: { renewalReminderSentAt: expect.any(Date) } })

    // La corrida de mañana: ya sellado este periodo → nada (ni lee Stripe de más).
    await run()
    expect(correoSinTarjeta).toHaveBeenCalledTimes(1)
    expect(stripe.customersRetrieve).toHaveBeenCalledTimes(1)
    expect(prismaMock.venueFeature.update).toHaveBeenCalledTimes(1)
  })

  it('🔴 con la tarjeta ya puesta en el portal: el recordatorio dice esa tarjeta ••••last4 y el monto', async () => {
    // El portal deja la tarjeta como la predeterminada del cliente (Stripe la devuelve expandida).
    stripe.customersRetrieve.mockResolvedValue(
      cliente({
        invoice_settings: {
          default_payment_method: { id: 'pm_portal', object: 'payment_method', type: 'card', card: { brand: 'mastercard', last4: '5555' } },
        },
      }),
    )

    await run()

    expect(correoSinTarjeta).toHaveBeenCalledWith(
      'owner@example.com',
      expect.objectContaining({ montoAlTerminarCents: 92684, tarjeta: { brand: 'mastercard', last4: '5555' } }),
    )
    expect(textoEnviado()).toContain('se cobrarán $926.84 en tu tarjeta Mastercard ••••5555')
    expect(prismaMock.venueFeature.update).toHaveBeenCalledTimes(1)
  })

  it('el método de la suscripción manda sobre el del cliente (la jerarquía de Stripe)', async () => {
    stripe.subscriptionsRetrieve.mockResolvedValue(prueba({ default_payment_method: 'pm_sub' }))
    stripe.paymentMethodsRetrieve.mockResolvedValue({ id: 'pm_sub', type: 'card', card: { brand: 'visa', last4: '4242' } })
    stripe.customersRetrieve.mockResolvedValue(
      cliente({ invoice_settings: { default_payment_method: { id: 'pm_otro', type: 'card', card: { brand: 'amex', last4: '0005' } } } }),
    )

    await run()

    expect(stripe.paymentMethodsRetrieve).toHaveBeenCalledWith('pm_sub', {}, LECTURA_ACOTADA)
    expect(textoEnviado()).toContain('en tu tarjeta Visa ••••4242')
  })

  it('🔴 la tarjeta no se pudo leer (tiempo agotado): no sale nada, no se sella, nunca «sin tarjeta»; la corrida siguiente lo vuelve a intentar', async () => {
    stripe.customersRetrieve.mockRejectedValueOnce(Object.assign(new Error('Request timed out'), { type: 'StripeConnectionError' }))

    await expect(run()).resolves.toBeUndefined()

    expect(correoSinTarjeta).not.toHaveBeenCalled()
    expect(correoDeHoy).not.toHaveBeenCalled()
    expect(enviar).not.toHaveBeenCalled()
    expect(prismaMock.venueFeature.update).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no se pudo leer'), expect.objectContaining({ venueFeatureId: 'vf1' }))

    // Mañana, con Stripe sano: sale y se sella.
    await run()
    expect(correoSinTarjeta).toHaveBeenCalledTimes(1)
    expect(correoSinTarjeta.mock.calls[0][1]).toMatchObject({ tarjeta: null, montoAlTerminarCents: 92684 })
    expect(prismaMock.venueFeature.update).toHaveBeenCalledTimes(1)
  })

  it('sin vista previa: el recordatorio sale igual, sin la frase del monto, y se sella (no promete un cobro)', async () => {
    stripe.createPreview.mockRejectedValue(new Error('Stripe 503'))

    await run()

    expect(correoSinTarjeta).toHaveBeenCalledTimes(1)
    expect(correoSinTarjeta.mock.calls[0][1]).not.toHaveProperty('montoAlTerminarCents')
    expect(textoEnviado()).toContain('pon tu tarjeta en «Tu plan»; si no, sigues en Gratis.')
    expect(textoEnviado()).not.toMatch(/\$/)
    expect(prismaMock.venueFeature.update).toHaveBeenCalledTimes(1)
  })

  it('con la cancelación programada: ninguno (como hoy)', async () => {
    // Premium: la de Pro con `cancel_at_period_end` es la prueba ENDS_FREE, que tiene su propio aviso.
    prismaMock.venueFeature.findMany.mockImplementation((async (args: { where: { active?: boolean; stripeSubscriptionId: unknown } }) =>
      args.where.active === true && args.where.stripeSubscriptionId !== null
        ? [{ ...fila(), feature: { code: 'PLAN_PREMIUM' } }]
        : []) as never)
    stripe.subscriptionsRetrieve.mockResolvedValue(prueba({ cancel_at: FIN_S }))

    await run()

    expect(correoSinTarjeta).not.toHaveBeenCalled()
    expect(correoDeHoy).not.toHaveBeenCalled()
    expect(stripe.customersRetrieve).not.toHaveBeenCalled()
  })
})

describe('sin sinTarjeta, el recordatorio de hoy', () => {
  it('una prueba con tarjeta de hoy: el correo de hoy, con las mismas llamadas a Stripe', async () => {
    stripe.subscriptionsRetrieve.mockResolvedValue(prueba({ default_payment_method: 'pm_1', metadata: { featureCode: 'PLAN_PRO' } }))

    await run()

    expect(stripe.subscriptionsRetrieve).toHaveBeenCalledTimes(1)
    expect(stripe.subscriptionsRetrieve).toHaveBeenCalledWith('sub_1')
    expect(stripe.createPreview).toHaveBeenCalledTimes(1)
    expect(stripe.createPreview).toHaveBeenCalledWith({ subscription: 'sub_1' })
    expect(stripe.customersRetrieve).not.toHaveBeenCalled()
    expect(stripe.paymentMethodsRetrieve).not.toHaveBeenCalled()
    expect(correoSinTarjeta).not.toHaveBeenCalled()
    expect(correoDeHoy).toHaveBeenCalledTimes(1)
    expect(correoDeHoy.mock.calls[0][1]).toMatchObject({ amountCents: 92684, isTrialEnd: true, planName: 'Pro' })
    expect(prismaMock.venueFeature.update).toHaveBeenCalledTimes(1)

    // Y sin monto, como hoy: sin correo y sin sello.
    correoDeHoy.mockClear()
    prismaMock.venueFeature.update.mockClear()
    sello = null
    stripe.createPreview.mockResolvedValue({})
    await run()
    expect(correoDeHoy).not.toHaveBeenCalled()
    expect(prismaMock.venueFeature.update).not.toHaveBeenCalled()
  })

  it('una prueba sin tarjeta que ya se cobró (activa): el recordatorio de renovación de hoy, sin leer la tarjeta', async () => {
    stripe.subscriptionsRetrieve.mockResolvedValue(prueba({ status: 'active', default_payment_method: 'pm_1' }))

    await run()

    expect(correoSinTarjeta).not.toHaveBeenCalled()
    expect(stripe.customersRetrieve).not.toHaveBeenCalled()
    expect(stripe.createPreview).toHaveBeenCalledWith({ subscription: 'sub_1' })
    expect(correoDeHoy).toHaveBeenCalledTimes(1)
    expect(correoDeHoy.mock.calls[0][1]).toMatchObject({ amountCents: 92684, isTrialEnd: false })
  })
})
