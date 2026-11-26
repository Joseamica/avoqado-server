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
import { avisarPlanTerminado, basicoPublicado } from '@/services/billing/avisosDelBasico'
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

describe('basicoPublicado()', () => {
  it('🔴 b2-r9 #8: con una v1 dañada (versionQueCobra lanza) → basicoPublicado() devuelve lo de hoy, sin lanzar', async () => {
    conLaV1Danada()
    await expect(basicoPublicado()).resolves.toEqual(BASICO)
    expect(mockBasico).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('avisosDelBasico'), expect.anything())
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
