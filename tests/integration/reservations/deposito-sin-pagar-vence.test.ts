/**
 * Integration (REAL DB + REAL app por supertest) — D681, la reserva que no se pagó.
 *
 * Caso real (Mindform BSF, 22-nov): una clienta reservó una clase con pago por adelantado, fue a Stripe y regresó sin pagar.
 * La reserva quedó PENDING + depósito PENDING con su sesión de Stripe, pero SIN vencimiento (`depositExpiresAt` NULL):
 * el servidor le daba a Stripe un vencimiento y no lo guardaba. Y al cancelarla ella misma, el depósito seguía PENDING con
 * la liga de Stripe abierta: si pagaba después, el aviso de Stripe la revivía (CANCELLED → CONFIRMED) sin volver a medir el
 * cupo. La ronda 1 de Codex (`docs/audit/2026-11-22-d681-reserva-sin-pagar/codex-r1.md`) agregó los casos #1–#8.
 *
 * Sólo se simula el SDK de Stripe (no hay red en tests). Rutas, controlador, servicios, job y webhook son REALES.
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test'
process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'test-access-secret'
process.env.REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'test-refresh-secret'

import '../../__helpers__/integration-setup'

const mockSessionsCreate = jest.fn()
const mockSessionsExpire = jest.fn()
const mockSessionsRetrieve = jest.fn()
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    checkout: { sessions: { create: mockSessionsCreate, expire: mockSessionsExpire, retrieve: mockSessionsRetrieve } },
    webhooks: { constructEvent: jest.fn() },
    products: { create: jest.fn() },
    prices: { create: jest.fn() },
  })),
)
jest.mock('@/services/email.service', () => ({
  __esModule: true,
  default: new Proxy({}, { get: () => jest.fn(async () => true) }),
}))

import request from 'supertest'
import { CronTime } from 'cron'
import { Prisma } from '@prisma/client'
import app from '@/app'
import prisma from '@/utils/prismaClient'
import { reservationDepositReconciliationJob } from '@/jobs/reservation-deposit-reconciliation.job'
import { processStripeConnectWebhookEvent } from '@/services/payments/reservation-deposit-webhook.service'
import { finalizeDepositCheckoutForConsumer } from '@/services/consumer/reservation.consumer.service'

const P = '/api/v1/public'
const RUN = Date.now()
const CONNECT_ACCOUNT = `acct_itest_d681_${RUN}`

type SesionStripe = { status: 'open' | 'complete' | 'expired'; payment_status: 'paid' | 'unpaid'; payment_intent?: string }

describe('D681 — la reserva sin pagar vence y suelta su lugar (integration, real DB)', () => {
  let orgId: string | undefined
  let venue: { id: string; slug: string } | undefined
  let productId: string
  let consumerId: string | undefined
  let sessionSeq = 0
  /** Lo que «Stripe» contesta como vencimiento de la PRÓXIMA sesión (segundos). null = el que pidió el servidor. */
  let nextExpiresAtSec: number | null = null
  /** Lo que «Stripe» contesta al consultar cada sesión. Sin entrada: abierta y sin pagar. */
  const estadoEnStripe = new Map<string, SesionStripe>()

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: 'ITEST D681 Org', email: `itest-d681-${RUN}@test.com`, phone: '5550000000' },
    })
    orgId = org.id
    venue = await prisma.venue.create({
      data: {
        name: 'ITEST D681 Estudio',
        slug: `itest-d681-${RUN}`,
        organizationId: org.id,
        address: 'X',
        city: 'X',
        state: 'X',
        country: 'MX',
        zipCode: '00000',
        timezone: 'America/Mexico_City',
        // TRIAL ⇒ exento del gate de plan: aquí se prueba el depósito, no los tiers.
        status: 'TRIAL' as any,
      },
      select: { id: true, slug: true },
    })
    // classUpfrontDefault ya es 'required' por default: clase con precio + Stripe ⇒ pago por adelantado.
    await prisma.reservationSettings.create({ data: { venueId: venue.id, publicBookingEnabled: true } })

    const provider = await prisma.paymentProvider.upsert({
      where: { code: 'STRIPE_CONNECT' },
      create: { code: 'STRIPE_CONNECT', name: 'Stripe Connect', type: 'PAYMENT_PROCESSOR' },
      update: { active: true },
    })
    await prisma.ecommerceMerchant.create({
      data: {
        venueId: venue.id,
        businessName: 'ITEST D681',
        contactEmail: `itest-d681-canal-${RUN}@example.test`,
        publicKey: `pk_test_d681_${RUN}`,
        secretKeyHash: `hash-d681-${RUN}`,
        providerId: provider.id,
        providerCredentials: { connectAccountId: CONNECT_ACCOUNT },
        active: true,
        chargesEnabled: true,
      },
    })

    const category = await prisma.menuCategory.create({ data: { venueId: venue.id, name: 'Clases', slug: `clases-d681-${RUN}` } })
    const product = await prisma.product.create({
      data: {
        venueId: venue.id,
        sku: `D681-${RUN}`,
        name: 'Clase Lagree',
        categoryId: category.id,
        price: new Prisma.Decimal(325),
        type: 'CLASS' as any,
      },
    })
    productId = product.id
    const consumer = await prisma.consumer.create({ data: { email: `itest-d681-app-${RUN}@test.com`, firstName: 'App' } })
    consumerId = consumer.id
  })

  beforeEach(() => {
    mockSessionsCreate.mockReset()
    mockSessionsExpire.mockReset()
    mockSessionsRetrieve.mockReset()
    nextExpiresAtSec = null
    mockSessionsCreate.mockImplementation(async (params: { expires_at: number }) => {
      sessionSeq += 1
      return {
        id: `cs_itest_d681_${RUN}_${sessionSeq}`,
        url: `https://checkout.stripe.test/c/pay/cs_itest_d681_${RUN}_${sessionSeq}`,
        expires_at: nextExpiresAtSec ?? params.expires_at,
      }
    })
    mockSessionsExpire.mockResolvedValue({ status: 'expired' })
    mockSessionsRetrieve.mockImplementation(async (id: string) => {
      const e = estadoEnStripe.get(id) ?? { status: 'open', payment_status: 'unpaid' }
      return { id, status: e.status, payment_status: e.payment_status, payment_intent: e.payment_intent ?? null, amount_total: 32500 }
    })
  })

  afterAll(async () => {
    const step = (fn: () => Promise<unknown>) => fn().catch(() => {})
    if (venue) {
      const v = venue.id
      const ids = (await prisma.reservation.findMany({ where: { venueId: v }, select: { id: true }, take: 100 })).map(r => r.id)
      await step(() => prisma.moneyAnomaly.deleteMany({ where: { reservationId: { in: ids } } }))
      await step(() => prisma.processedStripeEvent.deleteMany({ where: { stripeEventId: { contains: `d681_${RUN}` } } }))
      await step(() => prisma.reservation.deleteMany({ where: { venueId: v } }))
      await step(() => prisma.classSession.deleteMany({ where: { venueId: v } }))
      await step(() => prisma.customer.deleteMany({ where: { venueId: v } }))
      await step(() => prisma.product.deleteMany({ where: { venueId: v } }))
      await step(() => prisma.menuCategory.deleteMany({ where: { venueId: v } }))
      await step(() => prisma.ecommerceMerchant.deleteMany({ where: { venueId: v } }))
      await step(() => prisma.reservationSettings.deleteMany({ where: { venueId: v } }))
      await step(() => prisma.activityLog.deleteMany({ where: { venueId: v } }))
      await step(() => prisma.venue.deleteMany({ where: { id: v } }))
    }
    if (consumerId) await step(() => prisma.consumer.deleteMany({ where: { id: consumerId } }))
    if (orgId) await step(() => prisma.organization.deleteMany({ where: { id: orgId } }))
  })

  /** Una clase dentro de 3 días (lejos de la ventana de cancelación y del aviso mínimo). */
  async function nuevaClase(capacity: number) {
    const startsAt = new Date(Date.now() + 3 * 24 * 3_600_000)
    return prisma.classSession.create({
      data: {
        venueId: venue!.id,
        productId,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 50 * 60_000),
        duration: 50,
        capacity,
      },
    })
  }

  let visitante = 0
  function reservar(classSessionId: string, quien: string) {
    // Una IP por reserva: el límite público es de 5 escrituras por minuto por visitante.
    visitante += 1
    return request(app)
      .post(`${P}/venues/${venue!.slug}/reservations`)
      .set('cf-connecting-ip', `10.68.1.${visitante}`)
      .send({ classSessionId, guestName: quien, guestPhone: '5512345678', guestEmail: `${quien.toLowerCase()}-${RUN}@test.com` })
  }

  function cancelar(cancelSecret: string) {
    visitante += 1
    return request(app)
      .post(`${P}/venues/${venue!.slug}/reservations/${cancelSecret}/cancel`)
      .set('cf-connecting-ip', `10.68.1.${visitante}`)
      .send({})
  }

  async function filaPorSecreto(cancelSecret: string) {
    return prisma.reservation.findFirstOrThrow({
      where: { cancelSecret, venueId: venue!.id },
      select: {
        id: true,
        status: true,
        depositStatus: true,
        depositExpiresAt: true,
        checkoutSessionId: true,
        cancelledBy: true,
        createdAt: true,
      },
    })
  }

  /** La reserva que queda cuando Stripe no deja crear la liga: PENDING, depósito PENDING y sin sesión. */
  async function reservaSinLiga(quien: string) {
    const clase = await nuevaClase(10)
    mockSessionsCreate.mockRejectedValueOnce(new Error('Stripe no contesta'))
    const res = await reservar(clase.id, quien)
    expect(res.status).toBeGreaterThanOrEqual(500)
    const fila = await prisma.reservation.findFirstOrThrow({
      where: { venueId: venue!.id, guestName: quien },
      select: { id: true, status: true, depositStatus: true, checkoutSessionId: true, depositExpiresAt: true },
    })
    expect(fila).toMatchObject({ status: 'PENDING', depositStatus: 'PENDING', checkoutSessionId: null })
    return fila
  }

  const hace = (ms: number) => new Date(Date.now() - ms)

  it('🔴 la reserva guarda el MISMO vencimiento que contestó Stripe, y la pantalla «Tu Reservación» lo recibe', async () => {
    const clase = await nuevaClase(10)
    const res = await reservar(clase.id, 'Ana')
    expect(res.status).toBe(201)
    expect(res.body.status).toBe('PENDING')
    expect(res.body.checkoutUrl).toEqual(expect.stringContaining('checkout.stripe.test'))

    const pedido = mockSessionsCreate.mock.calls[0][0] as { expires_at: number }
    const fila = await filaPorSecreto(res.body.cancelSecret)
    expect(fila.depositStatus).toBe('PENDING')
    expect(fila.checkoutSessionId).toEqual(expect.stringContaining('cs_itest_d681_'))
    expect(fila.depositExpiresAt).not.toBeNull()
    expect(fila.depositExpiresAt!.getTime()).toBe(pedido.expires_at * 1000)

    const detalle = await request(app).get(`${P}/venues/${venue!.slug}/reservations/${res.body.cancelSecret}`)
    expect(detalle.status).toBe(200)
    expect(detalle.body.depositStatus).toBe('PENDING')
    expect(new Date(detalle.body.depositExpiresAt).getTime()).toBe(pedido.expires_at * 1000)
    // Lo que ya leían los clientes viejos sigue igual.
    expect(Number(detalle.body.depositAmount)).toBe(325)
  })

  it('🔴 #1 pagó a tiempo y el aviso de Stripe se retrasó: el job pregunta a Stripe y la CONFIRMA (no la vence por reloj)', async () => {
    const clase = await nuevaClase(10)
    nextExpiresAtSec = Math.floor(Date.now() / 1000) - 60 // la hora de la liga ya pasó cuando corre el job
    const res = await reservar(clase.id, 'Ivon')
    expect(res.status).toBe(201)
    const fila = await filaPorSecreto(res.body.cancelSecret)
    estadoEnStripe.set(fila.checkoutSessionId!, { status: 'complete', payment_status: 'paid', payment_intent: `pi_d681_${RUN}_ivon` })

    await reservationDepositReconciliationJob.reconcileNow()

    const despues = await filaPorSecreto(res.body.cancelSecret)
    expect(despues.status).toBe('CONFIRMED')
    expect(despues.depositStatus).toBe('PAID')
  })

  it('🔴 #1 liga vencida sin pagar y sin aviso: el job pregunta a Stripe, la cancela y el lugar se vuelve a reservar', async () => {
    const clase = await nuevaClase(1)
    nextExpiresAtSec = Math.floor(Date.now() / 1000) - 60
    const primera = await reservar(clase.id, 'Bety')
    expect(primera.status).toBe(201)
    const fila = await filaPorSecreto(primera.body.cancelSecret)
    estadoEnStripe.set(fila.checkoutSessionId!, { status: 'expired', payment_status: 'unpaid' })

    // Con el lugar apartado por la reserva sin pagar, la clase está llena.
    nextExpiresAtSec = null
    const llena = await reservar(clase.id, 'Caro')
    expect(llena.status).toBe(409)

    await reservationDepositReconciliationJob.reconcileNow()

    const despues = await filaPorSecreto(primera.body.cancelSecret)
    expect(despues.status).toBe('CANCELLED')
    expect(despues.depositStatus).toBe('EXPIRED')
    expect(despues.cancelledBy).toBe('SYSTEM')

    const otra = await reservar(clase.id, 'Caro')
    expect(otra.status).toBe(201)
  })

  it('el barrido por reloj sí vence una reserva cuya liga de Stripe nunca se creó', async () => {
    const fila = await reservaSinLiga('Hugo')
    expect(fila.depositExpiresAt).not.toBeNull() // nace con fecha
    await prisma.reservation.update({ where: { id: fila.id }, data: { depositExpiresAt: hace(60_000) } }) // pasó la media hora

    await reservationDepositReconciliationJob['expirePastDueReservations']()

    const despues = await prisma.reservation.findUniqueOrThrow({ where: { id: fila.id }, select: { status: true, depositStatus: true } })
    expect(despues).toEqual({ status: 'CANCELLED', depositStatus: 'EXPIRED' })
  })

  it('🔴 #5 una fila vieja sin fecha ni liga (de antes del arreglo) también se vence, por su fecha de alta', async () => {
    const fila = await reservaSinLiga('Lalo')
    await prisma.reservation.update({ where: { id: fila.id }, data: { depositExpiresAt: null, createdAt: hace(25 * 3_600_000) } })

    await reservationDepositReconciliationJob['expirePastDueReservations']()

    const despues = await prisma.reservation.findUniqueOrThrow({ where: { id: fila.id }, select: { status: true, depositStatus: true } })
    expect(despues).toEqual({ status: 'CANCELLED', depositStatus: 'EXPIRED' })
  })

  it('🔴 #4 el barrido nunca cancela a quien ya llegó, aunque su depósito siga pendiente', async () => {
    const fila = await reservaSinLiga('Mara')
    await prisma.reservation.update({
      where: { id: fila.id },
      data: { status: 'CHECKED_IN', checkedInAt: new Date(), depositExpiresAt: hace(60_000) },
    })

    await reservationDepositReconciliationJob['expirePastDueReservations']()

    const despues = await prisma.reservation.findUniqueOrThrow({ where: { id: fila.id }, select: { status: true } })
    expect(despues.status).toBe('CHECKED_IN')
  })

  it('🔴 #4 la liga vencida de una reserva que el negocio ya confirmó sólo cierra el depósito: la reserva sigue confirmada', async () => {
    const clase = await nuevaClase(10)
    const res = await reservar(clase.id, 'Nora')
    expect(res.status).toBe(201)
    const fila = await filaPorSecreto(res.body.cancelSecret)
    await prisma.reservation.update({ where: { id: fila.id }, data: { status: 'CONFIRMED', confirmedAt: new Date() } })

    await processStripeConnectWebhookEvent({
      id: `evt_itest_d681_${RUN}_vencioConfirmada`,
      type: 'checkout.session.expired',
      account: CONNECT_ACCOUNT,
      livemode: false,
      data: { id: fila.checkoutSessionId },
    })

    const despues = await filaPorSecreto(res.body.cancelSecret)
    expect(despues.status).toBe('CONFIRMED')
    expect(despues.depositStatus).toBe('EXPIRED')
  })

  it('🔴 si la clienta la cancela sin pagar: el depósito ya no se cobra, la liga se cierra y un pago tardío NO la revive', async () => {
    const clase = await nuevaClase(10)
    const res = await reservar(clase.id, 'Dani')
    expect(res.status).toBe(201)

    const cancel = await cancelar(res.body.cancelSecret)
    expect(cancel.status).toBe(200)

    const fila = await filaPorSecreto(res.body.cancelSecret)
    expect(fila.status).toBe('CANCELLED')
    expect(fila.depositStatus).toBe('EXPIRED')
    expect(fila.cancelledBy).toBe('CUSTOMER')
    // #8: la respuesta trae el depósito como quedó, igual que un GET posterior.
    expect(cancel.body.depositStatus).toBe('EXPIRED')
    // Se le pide a Stripe cerrar ESA sesión, en la cuenta conectada que la creó.
    expect(mockSessionsExpire).toHaveBeenCalledWith(fila.checkoutSessionId, {}, { stripeAccount: CONNECT_ACCOUNT })

    // Si el aviso de pago llega de todos modos (pagó un segundo antes de que se cerrara), queda como anomalía de dinero.
    await processStripeConnectWebhookEvent({
      id: `evt_itest_d681_${RUN}_pagoTardio`,
      type: 'checkout.session.completed',
      account: CONNECT_ACCOUNT,
      livemode: false,
      data: { id: fila.checkoutSessionId, payment_status: 'paid', payment_intent: `pi_itest_d681_${RUN}` },
    })
    const despues = await filaPorSecreto(res.body.cancelSecret)
    expect(despues.status).toBe('CANCELLED')
    expect(despues.depositStatus).toBe('EXPIRED')
    const anomalia = await prisma.moneyAnomaly.findFirst({ where: { reservationId: fila.id } })
    expect(anomalia?.category).toBe('PAID_AFTER_DIVERGENT_STATE')
  })

  it('🔴 #2 si cerrar la liga en Stripe falla al cancelar, la conciliación la sigue viendo y la cierra sin cambiar quién canceló', async () => {
    const clase = await nuevaClase(10)
    const res = await reservar(clase.id, 'Olga')
    expect(res.status).toBe(201)
    mockSessionsExpire.mockRejectedValueOnce(new Error('Stripe no contesta'))

    const cancel = await cancelar(res.body.cancelSecret)
    expect(cancel.status).toBe(200)
    const fila = await filaPorSecreto(res.body.cancelSecret)
    expect(fila.status).toBe('CANCELLED')
    expect(fila.depositStatus).toBe('PENDING') // a propósito: así la conciliación la sigue consultando

    estadoEnStripe.set(fila.checkoutSessionId!, { status: 'expired', payment_status: 'unpaid' })
    await reservationDepositReconciliationJob.reconcileNow()

    const despues = await filaPorSecreto(res.body.cancelSecret)
    expect(despues.status).toBe('CANCELLED')
    expect(despues.depositStatus).toBe('EXPIRED')
    expect(despues.cancelledBy).toBe('CUSTOMER')
  })

  it('🔴 #2 si la cancelan mientras Stripe crea la liga: la liga se cierra y NO se entrega', async () => {
    const clase = await nuevaClase(10)
    mockSessionsCreate.mockImplementationOnce(async (params: { expires_at: number; metadata: { reservationId: string } }) => {
      // La cancelación entra justo ahora (sin liga guardada todavía, así la deja `cancelReservation`).
      await prisma.reservation.update({
        where: { id: params.metadata.reservationId },
        data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: 'CUSTOMER', depositStatus: 'EXPIRED' },
      })
      sessionSeq += 1
      return { id: `cs_itest_d681_${RUN}_carrera`, url: 'https://checkout.stripe.test/c/pay/carrera', expires_at: params.expires_at }
    })

    const res = await reservar(clase.id, 'Paty')

    expect(res.status).toBe(409)
    expect(res.body.checkoutUrl).toBeUndefined()
    expect(mockSessionsExpire).toHaveBeenCalledWith(`cs_itest_d681_${RUN}_carrera`, {}, { stripeAccount: CONNECT_ACCOUNT })
    const fila = await prisma.reservation.findFirstOrThrow({
      where: { venueId: venue!.id, guestName: 'Paty' },
      select: { status: true, checkoutSessionId: true },
    })
    expect(fila).toEqual({ status: 'CANCELLED', checkoutSessionId: null })
  })

  it('🔴 #3 la app de clientes tampoco revive una reserva cancelada aunque Stripe diga que se pagó', async () => {
    const clase = await nuevaClase(10)
    const res = await reservar(clase.id, 'Rita')
    expect(res.status).toBe(201)
    const fila = await filaPorSecreto(res.body.cancelSecret)
    const customer = await prisma.customer.create({ data: { venueId: venue!.id, email: `rita-${RUN}@test.com`, consumerId } })
    // Pagó en Stripe y, antes de que la app regresara, el negocio la canceló.
    await prisma.reservation.update({
      where: { id: fila.id },
      data: { customerId: customer.id, status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: 'SYSTEM', depositStatus: 'EXPIRED' },
    })
    estadoEnStripe.set(fila.checkoutSessionId!, { status: 'complete', payment_status: 'paid', payment_intent: `pi_d681_${RUN}_rita` })

    await finalizeDepositCheckoutForConsumer(consumerId!, fila.checkoutSessionId!)

    const despues = await filaPorSecreto(res.body.cancelSecret)
    expect(despues.status).toBe('CANCELLED')
    expect(despues.depositStatus).toBe('EXPIRED')
    const anomalia = await prisma.moneyAnomaly.findFirst({ where: { reservationId: fila.id } })
    expect(anomalia?.category).toBe('PAID_AFTER_DIVERGENT_STATE')
  })

  it('🔴 una reserva que quedó CANCELADA con el depósito PENDING (antes del arreglo) tampoco revive si llega el pago', async () => {
    const clase = await nuevaClase(10)
    const res = await reservar(clase.id, 'Eli')
    expect(res.status).toBe(201)
    const fila = await filaPorSecreto(res.body.cancelSecret)
    // Así quedaron RES-48U9MJ y RES-TY5VJV en producción: canceladas por la clienta, depósito PENDING, liga abierta.
    await prisma.reservation.update({
      where: { id: fila.id },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: 'CUSTOMER' },
    })

    await processStripeConnectWebhookEvent({
      id: `evt_itest_d681_${RUN}_legado`,
      type: 'checkout.session.completed',
      account: CONNECT_ACCOUNT,
      livemode: false,
      data: { id: fila.checkoutSessionId, payment_status: 'paid', payment_intent: `pi_itest_d681_${RUN}_legado` },
    })

    const despues = await filaPorSecreto(res.body.cancelSecret)
    expect(despues.status).toBe('CANCELLED')
    expect(despues.cancelledBy).toBe('CUSTOMER')
    const anomalia = await prisma.moneyAnomaly.findFirst({ where: { reservationId: fila.id } })
    expect(anomalia?.category).toBe('PAID_AFTER_DIVERGENT_STATE')
  })

  it('🔴 #6 el job revisa las ligas al menos cada 5 minutos (un lugar abandonado no queda apartado una hora)', () => {
    const [a, b] = new CronTime(reservationDepositReconciliationJob['CRON_PATTERN'], 'America/Mexico_City').sendAt(2)
    expect(b.toMillis() - a.toMillis()).toBeLessThanOrEqual(5 * 60_000)
  })

  // ---- Regresión: lo que ya funcionaba sigue igual ----

  it('una reserva sin pagar y SIN cancelar sí se confirma cuando llega el pago', async () => {
    const clase = await nuevaClase(10)
    const res = await reservar(clase.id, 'Fer')
    expect(res.status).toBe(201)
    const fila = await filaPorSecreto(res.body.cancelSecret)

    await processStripeConnectWebhookEvent({
      id: `evt_itest_d681_${RUN}_pagoNormal`,
      type: 'checkout.session.completed',
      account: CONNECT_ACCOUNT,
      livemode: false,
      data: { id: fila.checkoutSessionId, payment_status: 'paid', payment_intent: `pi_itest_d681_${RUN}_normal` },
    })

    const despues = await filaPorSecreto(res.body.cancelSecret)
    expect(despues.status).toBe('CONFIRMED')
    expect(despues.depositStatus).toBe('PAID')
  })

  it('la liga vencida de una reserva PENDING sí la cancela (aviso de Stripe)', async () => {
    const clase = await nuevaClase(10)
    const res = await reservar(clase.id, 'Susi')
    expect(res.status).toBe(201)
    const fila = await filaPorSecreto(res.body.cancelSecret)

    await processStripeConnectWebhookEvent({
      id: `evt_itest_d681_${RUN}_vencioPendiente`,
      type: 'checkout.session.expired',
      account: CONNECT_ACCOUNT,
      livemode: false,
      data: { id: fila.checkoutSessionId },
    })

    const despues = await filaPorSecreto(res.body.cancelSecret)
    expect(despues).toMatchObject({ status: 'CANCELLED', depositStatus: 'EXPIRED', cancelledBy: 'SYSTEM' })
  })

  it('el job NO toca una reserva cuyo plazo de pago sigue vivo', async () => {
    const clase = await nuevaClase(10)
    const res = await reservar(clase.id, 'Gaby')
    expect(res.status).toBe(201)

    await reservationDepositReconciliationJob.reconcileNow()

    const fila = await filaPorSecreto(res.body.cancelSecret)
    expect(fila.status).toBe('PENDING')
    expect(fila.depositStatus).toBe('PENDING')
  })
})
