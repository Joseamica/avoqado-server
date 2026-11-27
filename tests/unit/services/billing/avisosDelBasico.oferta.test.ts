/**
 * Planes editables (B2, Task 9, b2-r2 #10 y b2-r9 #8): con una versión del editor el Básico ya no está a la venta, así que los
 * avisos dejan de ofrecerlo. `basicoPublicado()` devuelve `null` y los avisos de la prueba `ENDS_FREE` («Tu prueba termina») y
 * de «Tu Pro terminó» salen con su texto de hoy sin el Básico: dicen que termina sin cobro y llevan a «Tu plan». Sin versión del
 * editor (sin versiones o sólo la v1), como hoy. Si leer la oferta falla, también como hoy: leer la oferta nunca tumba un aviso.
 *
 * Las entradas reales: el job `plan-renewal-reminder` (`runNow`) y `avisarPlanTerminado`; el correo es el real (sólo se
 * intercepta la salida, `sendEmail`).
 */
import type Stripe from 'stripe'
import { prismaMock } from '@tests/__helpers__/setup'
import { definicionDePrueba, idsDeLaVersion, punteroA, versionUno } from '@tests/__helpers__/planOfferFixtures'
import logger from '@/config/logger'
import emailService from '@/services/email.service'
import * as planNotification from '@/services/access/planNotification.service'
import { avisarPlanTerminado, basicoDeLaBienvenida, basicoPublicado } from '@/services/billing/avisosDelBasico'
import { PlanRenewalReminderJob } from '@/jobs/plan-renewal-reminder.job'

jest.mock('stripe', () => {
  const retrieve = jest.fn()
  const createPreview = jest.fn()
  const ctor = jest.fn().mockImplementation(() => ({
    subscriptions: { retrieve },
    invoices: { createPreview },
    customers: { retrieve: jest.fn(), retrieveSource: jest.fn() },
    paymentMethods: { retrieve: jest.fn() },
  })) as jest.Mock & { __retrieve: jest.Mock; __createPreview: jest.Mock }
  ctor.__retrieve = retrieve
  ctor.__createPreview = createPreview
  return ctor
})
const stripeMock = require('stripe') as jest.Mock & { __retrieve: jest.Mock; __createPreview: jest.Mock }

jest.mock('@/services/access/planNotification.service', () => ({ __esModule: true, resolvePlanNotificationTarget: jest.fn() }))
jest.mock('@/services/dashboard/planState.service', () => ({ __esModule: true, getPlanState: jest.fn() }))

// El Básico publicado hoy: $499 + IVA.
const BASICO = { priceWithTax: '578.84', priceWithoutTax: '499.00' }
const mockBasico = jest.fn()
jest.mock('@/services/launchCampaigns/hybridCampaign.service', () => ({
  __esModule: true,
  getPublicBasicPlan: (...a: unknown[]) => mockBasico(...a),
}))

const DIA = 86_400_000

const conLaV2 = () =>
  prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv2', 2, definicionDePrueba({ ids: idsDeLaVersion('v2') })) as never)
const conLaV1 = () => prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv1', 1, versionUno()) as never)
const sinVersiones = () => prismaMock.planOfferPointer.findUnique.mockResolvedValue(null as never)
/** Una v1 cuya definición no pasa el esquema: `versionQueCobra()` lanza el 503 de la oferta rota. */
const conLaV1Danada = () =>
  prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv1', 1, { schemaVersion: 1, PRO: 'roto' }) as never)

let enviar: jest.SpyInstance
let pruebaTermina: jest.SpyInstance
let planTermino: jest.SpyInstance

/** El texto plano del correo que salió. */
const textoEnviado = () => String((enviar.mock.calls[0][0] as { text?: string }).text ?? '')

beforeEach(() => {
  stripeMock.__retrieve.mockReset()
  stripeMock.__createPreview.mockReset()
  mockBasico.mockReset().mockResolvedValue(BASICO)
  enviar = jest.spyOn(emailService, 'sendEmail').mockResolvedValue(true)
  pruebaTermina = jest.spyOn(emailService, 'sendPlanTrialEndsFreeEmail')
  planTermino = jest.spyOn(emailService, 'sendPlanEndedEmail')
  ;(planNotification.resolvePlanNotificationTarget as jest.Mock).mockResolvedValue({
    email: 'owner@example.com',
    locale: 'es',
    venueName: 'Negocio de prueba',
    staffId: 'staff-owner',
  })
  prismaMock.notificationPreference.findUnique.mockResolvedValue(null as never)
  prismaMock.venueFeature.updateMany.mockResolvedValue({ count: 1 } as never)
  prismaMock.venueFeature.update.mockResolvedValue({} as never)
})

afterEach(() => {
  enviar.mockRestore()
  pruebaTermina.mockRestore()
  planTermino.mockRestore()
})

describe('«Tu prueba termina» de la prueba ENDS_FREE (el job)', () => {
  const nowS = () => Math.floor(Date.now() / 1000)
  /** La prueba de Pro que termina SIN cobrar en 8 días (la cancelación programada la fija el alta con Básico). */
  const pruebaSinCobro = () => ({
    id: 'sub_1',
    status: 'trialing',
    customer: 'cus_1',
    cancel_at_period_end: true,
    cancel_at: null,
    current_period_start: nowS() - 22 * 86_400,
    current_period_end: nowS() + 8 * 86_400,
    trial_end: nowS() + 8 * 86_400,
    items: { data: [{ price: { recurring: { interval: 'month' } } }] },
    metadata: {},
  })
  const fila = {
    id: 'vf1',
    venueId: 'venue-1',
    stripeSubscriptionId: 'sub_1',
    renewalReminderSentAt: null,
    freeTrialNoticeFor: null,
    feature: { code: 'PLAN_PRO' },
    venue: { slug: 'negocio-de-prueba', timezone: 'America/Mexico_City' },
  }

  beforeEach(() => {
    // Sólo la lectura de `run()` (activas con suscripción) trae la fila; las otras dos pasadas del job, ninguna.
    prismaMock.venueFeature.findMany.mockImplementation((async (args: { where: { active?: boolean; stripeSubscriptionId: unknown } }) =>
      args.where.active === true && args.where.stripeSubscriptionId !== null ? [fila] : []) as never)
    stripeMock.__retrieve.mockResolvedValue(pruebaSinCobro())
  })

  it('🔴 b2-r2 #10: con la v2, la prueba ENDS_FREE llega a su fin → sendPlanTrialEndsFreeEmail sin la oferta del Básico y con la liga a «Tu plan»; sin versión del editor, como hoy', async () => {
    conLaV2()
    await new PlanRenewalReminderJob().runNow()

    expect(pruebaTermina).toHaveBeenCalledTimes(1)
    const [, datos] = pruebaTermina.mock.calls[0] as [string, Record<string, unknown>]
    expect(datos).not.toHaveProperty('basicPlanPriceWithoutTaxCents')
    expect(datos.billingUrl).toEqual(expect.stringContaining('/venues/negocio-de-prueba/'))
    // El texto de hoy sin el Básico: termina sin cobro y lleva a «Tu plan».
    expect(textoEnviado()).toContain('no se te cobrará nada. Si quieres quedarte en Pro, puedes hacerlo desde «Tu plan».')
    expect(textoEnviado()).not.toContain('Básico')
    // Ni siquiera se lee el catálogo del Básico: con la v2 no se ofrece.
    expect(mockBasico).not.toHaveBeenCalled()
    // Nunca anuncia un cobro.
    expect(stripeMock.__createPreview).not.toHaveBeenCalled()

    // Sin versión del editor (sin versiones, o sólo la v1): como hoy, con el Básico a $499 + IVA.
    for (const sinEditor of [sinVersiones, conLaV1]) {
      pruebaTermina.mockClear()
      enviar.mockClear()
      sinEditor()
      await new PlanRenewalReminderJob().runNow()
      expect(pruebaTermina).toHaveBeenCalledTimes(1)
      expect(pruebaTermina.mock.calls[0][1]).toMatchObject({ basicPlanPriceWithoutTaxCents: 49900 })
      expect(textoEnviado()).toContain('Ese día podrás contratar el Básico ($499 + IVA) con un clic')
    }
  })
})

describe('«Tu Pro terminó» / «Tu prueba terminó» (avisarPlanTerminado)', () => {
  const FIN_S = Math.floor((Date.now() - 2 * DIA) / 1000)
  /** Un Pro pagado que terminó al fin de su periodo con la cancelación programada (sin cobro). */
  const proTerminado = {
    id: 'sub_t',
    status: 'canceled',
    ended_at: FIN_S,
    cancel_at_period_end: true,
    cancel_at: FIN_S,
    trial_end: FIN_S - 60 * 86_400,
    current_period_end: FIN_S,
    items: { data: [{ current_period_end: FIN_S }] },
    cancellation_details: { reason: 'cancellation_requested' },
  } as unknown as Stripe.Subscription

  beforeEach(() => {
    prismaMock.venueFeature.findFirst.mockResolvedValue({
      id: 'vf_t',
      venueId: 'venue-1',
      renewalReminderSentAt: null,
      venue: { slug: 'negocio-de-prueba', status: 'ACTIVE' },
    } as never)
    prismaMock.activityLog.findFirst.mockResolvedValue(null as never)
    prismaMock.activityLog.create.mockResolvedValue({} as never)
    prismaMock.venueFeature.count.mockResolvedValue(0 as never)
    prismaMock.hybridContract.count.mockResolvedValue(0 as never)
  })

  it('con la v2: «Tu Pro terminó» sale con su texto de hoy sin el Básico y lleva a «Tu plan»; sin versión del editor, con el Básico', async () => {
    conLaV2()
    await expect(avisarPlanTerminado(proTerminado)).resolves.toBe(true)
    expect(planTermino).toHaveBeenCalledTimes(1)
    const [, datos] = planTermino.mock.calls[0] as [string, Record<string, unknown>]
    expect(datos).toMatchObject({ kind: 'PRO', billingUrl: expect.stringContaining('/venues/negocio-de-prueba/') })
    expect(datos).not.toHaveProperty('basicPlanPriceWithoutTaxCents')
    expect(textoEnviado()).toContain('Puedes volver a Pro cuando quieras.')
    expect(textoEnviado()).not.toContain('Básico')

    planTermino.mockClear()
    enviar.mockClear()
    sinVersiones()
    await expect(avisarPlanTerminado(proTerminado)).resolves.toBe(true)
    expect(planTermino.mock.calls[0][1]).toMatchObject({ basicPlanPriceWithoutTaxCents: 49900 })
  })
})

describe('B4 · el correo de fin de plan lleva el nombre del editor', () => {
  const FIN_S = Math.floor((Date.now() - 2 * DIA) / 1000)
  const proTerminado = {
    id: 'sub_t',
    status: 'canceled',
    ended_at: FIN_S,
    cancel_at_period_end: true,
    cancel_at: FIN_S,
    trial_end: FIN_S - 60 * 86_400,
    current_period_end: FIN_S,
    items: { data: [{ current_period_end: FIN_S }] },
    cancellation_details: { reason: 'cancellation_requested' },
  } as unknown as Stripe.Subscription

  beforeEach(() => {
    prismaMock.venueFeature.findFirst.mockResolvedValue({
      id: 'vf_t',
      venueId: 'venue-1',
      renewalReminderSentAt: null,
      venue: { slug: 'negocio-de-prueba', status: 'ACTIVE' },
    } as never)
    prismaMock.activityLog.findFirst.mockResolvedValue(null as never)
    prismaMock.activityLog.create.mockResolvedValue({} as never)
    prismaMock.venueFeature.count.mockResolvedValue(0 as never)
    prismaMock.hybridContract.count.mockResolvedValue(0 as never)
  })

  it('con la v2 «Plus»: el asunto y el texto dicen Plus, no Pro; sin versión, Pro como hoy', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(
      punteroA('cv2', 2, definicionDePrueba({ ids: idsDeLaVersion('v2'), nombres: { PRO: 'Plus' } })) as never,
    )
    await expect(avisarPlanTerminado(proTerminado)).resolves.toBe(true)
    expect(planTermino.mock.calls[0][1]).toMatchObject({ planName: 'Plus' })
    const salida = enviar.mock.calls[0][0] as { subject: string; text: string }
    expect(salida.subject).toBe('Tu plan Avoqado Plus terminó')
    expect(salida.text).toContain('Puedes volver a Plus cuando quieras.')
    expect(salida.text).not.toContain('Pro')

    planTermino.mockClear()
    enviar.mockClear()
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(null as never)
    await expect(avisarPlanTerminado(proTerminado)).resolves.toBe(true)
    expect((enviar.mock.calls[0][0] as { subject: string }).subject).toBe('Tu plan Avoqado Pro terminó')
  })
})

describe('basicoPublicado()', () => {
  it('🔴 b2-r9 #8: con una v1 dañada (versionQueCobra lanza) → basicoPublicado() devuelve lo de hoy, sin lanzar', async () => {
    conLaV1Danada()
    await expect(basicoPublicado()).resolves.toEqual(BASICO)
    expect(mockBasico).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no se pudo leer la oferta'), expect.anything())
  })

  it('con la v2 → null; sin versiones o con la v1 → el Básico publicado de hoy (y si el catálogo falla, null como hoy)', async () => {
    conLaV2()
    await expect(basicoPublicado()).resolves.toBeNull()
    sinVersiones()
    await expect(basicoPublicado()).resolves.toEqual(BASICO)
    conLaV1()
    await expect(basicoPublicado()).resolves.toEqual(BASICO)
    mockBasico.mockRejectedValueOnce(new Error('catálogo caído'))
    await expect(basicoPublicado()).resolves.toBeNull()
  })
})

/**
 * Fix round 1: la bienvenida de la prueba ENDS_FREE (`sendPlanConfirmationEmail` con `trialEndsFree`, que mandan `activatePlan`
 * y el alta larga). Los dos arman el Básico con `basicoDeLaBienvenida()`; aquí se arma igual y se manda con el correo real.
 */
describe('la bienvenida de la prueba ENDS_FREE', () => {
  const LIGA = 'https://dashboard.example.com/venues/negocio-de-prueba/settings/billing/subscriptions'
  const BASE = {
    locale: 'es' as const,
    venueName: 'Negocio de prueba',
    payNow: false,
    interval: 'monthly' as const,
    firstChargeDate: new Date('2026-12-17T18:00:00Z'),
    firstChargeAmountCents: 115884,
    billingPortalUrl: LIGA,
  }
  const bienvenida = async () => {
    const basico = await basicoDeLaBienvenida()
    await emailService.sendPlanConfirmationEmail('owner@example.com', { ...BASE, trialEndsFree: true, ...basico })
    return basico
  }
  /** El correo que salía antes de B2 (los llamadores mandaban `basicPlanPriceWithoutTaxCents` directo), tal cual. */
  const correoDeHoy = async (basicPlanPriceWithoutTaxCents: number | undefined) => {
    enviar.mockClear()
    await emailService.sendPlanConfirmationEmail('owner@example.com', { ...BASE, trialEndsFree: true, basicPlanPriceWithoutTaxCents })
    return enviar.mock.calls[0][0]
  }
  const HOY =
    '30 días gratis con todo Pro. Termina el 17 de diciembre de 2026 y no se te cobra nada; ese día podrás contratar el Básico por $499 + IVA al mes con un clic.'

  it('🔴 con la v2: sin el precio del Básico, sin la línea del Básico «con un clic», y con la liga a «Tu plan»', async () => {
    conLaV2()
    const basico = await bienvenida()

    expect(basico.basicPlanPriceWithoutTaxCents).toBeUndefined()
    expect(mockBasico).not.toHaveBeenCalled()
    const texto = textoEnviado()
    expect(texto).toContain(
      'Tu prueba de Pro termina el 17 de diciembre de 2026 y no se te cobra nada. Si quieres quedarte en Pro, puedes hacerlo desde «Tu plan».',
    )
    expect(texto).not.toContain('Básico')
    expect(texto).not.toContain('un clic')
    expect(texto).toContain(`Ver mi plan: ${LIGA}`)
    const html = String((enviar.mock.calls[0][0] as { html?: string }).html ?? '')
    expect(html).not.toContain('Básico')
    expect(html).toContain(LIGA)
  })

  it('sin versión del editor (sin versiones o con la v1): el correo de hoy, byte por byte', async () => {
    for (const sinEditor of [sinVersiones, conLaV1]) {
      enviar.mockClear()
      sinEditor()
      await expect(bienvenida()).resolves.toEqual({ basicPlanPriceWithoutTaxCents: 49900 })
      expect(textoEnviado()).toContain(HOY)
      expect(textoEnviado()).toContain('Cámbialo en «Tu plan».')
      const enviado = enviar.mock.calls[0][0]
      expect(enviado).toEqual(await correoDeHoy(49900))
    }
    // Sin precio vigente (el catálogo no contesta): el texto de hoy sin precio, sin cambiar.
    enviar.mockClear()
    sinVersiones()
    mockBasico.mockRejectedValueOnce(new Error('catálogo caído'))
    await expect(bienvenida()).resolves.toEqual({ basicPlanPriceWithoutTaxCents: undefined })
    expect(textoEnviado()).toContain('ese día podrás contratar el Básico con un clic.')
    const sinPrecio = enviar.mock.calls[0][0]
    expect(sinPrecio).toEqual(await correoDeHoy(undefined))
  })

  it('🔴 b2-r9 #8: con versionQueCobra lanzando (una v1 dañada), el correo de hoy, sin lanzar', async () => {
    conLaV1Danada()
    await expect(bienvenida()).resolves.toEqual({ basicPlanPriceWithoutTaxCents: 49900 })
    expect(textoEnviado()).toContain(HOY)
    const enviado = enviar.mock.calls[0][0]
    expect(enviado).toEqual(await correoDeHoy(49900))
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no se pudo leer la oferta'), expect.anything())
  })
})
