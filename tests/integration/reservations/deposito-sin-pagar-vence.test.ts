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
const mockRefundsCreate = jest.fn()
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    checkout: { sessions: { create: mockSessionsCreate, expire: mockSessionsExpire, retrieve: mockSessionsRetrieve } },
    refunds: { create: mockRefundsCreate },
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
import { createDepositCheckoutForConsumer, finalizeDepositCheckoutForConsumer } from '@/services/consumer/reservation.consumer.service'
import { cancelReservation } from '@/services/dashboard/reservation.dashboard.service'
import { registrarLiga } from '@/services/reservation/depositoDeReserva'

const P = '/api/v1/public'
const RUN = Date.now()
const CONNECT_ACCOUNT = `acct_itest_d681_${RUN}`

type SesionStripe = {
  status: 'open' | 'complete' | 'expired'
  payment_status: 'paid' | 'unpaid'
  payment_intent?: string
  url?: string
}

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
      return {
        id,
        status: e.status,
        payment_status: e.payment_status,
        payment_intent: e.payment_intent ?? null,
        amount_total: 32500,
        url: e.status === 'open' ? (e.url ?? `https://checkout.stripe.test/c/pay/${id}`) : null,
      }
    })
    mockRefundsCreate.mockReset()
    mockRefundsCreate.mockResolvedValue({ id: `re_d681_${RUN}`, status: 'succeeded', amount: 32500, failure_reason: null })
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

  it('🔴 r2 #1 si Stripe no deja cerrar la liga, NO se cancela: 503 claro y la reserva sigue igual (falla cerrada)', async () => {
    const clase = await nuevaClase(10)
    const res = await reservar(clase.id, 'Olga')
    expect(res.status).toBe(201)
    mockSessionsExpire.mockRejectedValue(new Error('Stripe no contesta'))
    mockSessionsRetrieve.mockRejectedValueOnce(new Error('Stripe no contesta'))

    const cancel = await cancelar(res.body.cancelSecret)
    expect(cancel.status).toBe(503)
    expect(cancel.body.message ?? cancel.body.error).toContain('No pudimos cerrar el pago en línea; intenta de nuevo en un momento')
    const fila = await filaPorSecreto(res.body.cancelSecret)
    expect(fila).toMatchObject({ status: 'PENDING', depositStatus: 'PENDING' })

    // Stripe vuelve: la misma cancelación ya pasa.
    mockSessionsExpire.mockResolvedValue({ status: 'expired' })
    const otra = await cancelar(res.body.cancelSecret)
    expect(otra.status).toBe(200)
    expect(await filaPorSecreto(res.body.cancelSecret)).toMatchObject({
      status: 'CANCELLED',
      depositStatus: 'EXPIRED',
      cancelledBy: 'CUSTOMER',
    })
  })

  it('🔴 r2 #1 si la liga ya se había pagado al cancelar: se aplica el pago y se cancela como pagada (se devuelve)', async () => {
    const clase = await nuevaClase(10)
    const res = await reservar(clase.id, 'Pili')
    expect(res.status).toBe(201)
    const fila = await filaPorSecreto(res.body.cancelSecret)
    mockSessionsExpire.mockRejectedValueOnce(new Error('This Checkout Session is already complete'))
    estadoEnStripe.set(fila.checkoutSessionId!, { status: 'complete', payment_status: 'paid', payment_intent: `pi_d681_${RUN}_pili` })

    const cancel = await cancelar(res.body.cancelSecret)
    expect(cancel.status).toBe(200)
    const despues = await filaPorSecreto(res.body.cancelSecret)
    expect(despues.status).toBe('CANCELLED')
    expect(despues.depositStatus).toBe('REFUNDED')
    expect(await prisma.moneyAnomaly.count({ where: { reservationId: fila.id } })).toBe(0)
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
    expect(res.body.message ?? res.body.error).toContain('Esta reservación ya se canceló')
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

  // ---- Ronda 2 de Codex ----

  let cuenta = 0
  /** Una reserva con su liga abierta, escrita directo (como la deja el alta): para las pruebas que no necesitan la ruta. */
  async function reservaConLiga(
    o: { status?: any; depositStatus?: any; conLiga?: boolean; customerId?: string; venceEnMin?: number } = {},
  ) {
    cuenta += 1
    const merchant = await prisma.ecommerceMerchant.findFirstOrThrow({ where: { venueId: venue!.id } })
    const startsAt = new Date(Date.now() + 3 * 24 * 3_600_000)
    return prisma.reservation.create({
      data: {
        venueId: venue!.id,
        confirmationCode: `D681-${RUN}-${cuenta}`,
        status: o.status ?? 'PENDING',
        startsAt,
        endsAt: new Date(startsAt.getTime() + 50 * 60_000),
        blockedEndsAt: new Date(startsAt.getTime() + 50 * 60_000),
        duration: 50,
        guestName: `Prueba ${cuenta}`,
        guestPhone: '5512345678',
        customerId: o.customerId,
        depositAmount: new Prisma.Decimal(325),
        depositStatus: o.depositStatus === undefined ? 'PENDING' : o.depositStatus,
        depositExpiresAt: o.conLiga === false && o.depositStatus === null ? null : new Date(Date.now() + (o.venceEnMin ?? 20) * 60_000),
        checkoutSessionId: o.conLiga === false ? null : `cs_d681_${RUN}_r${cuenta}`,
        ecommerceMerchantId: merchant.id,
      },
      select: { id: true, cancelSecret: true, checkoutSessionId: true, confirmationCode: true },
    })
  }
  const leer = (id: string) =>
    prisma.reservation.findUniqueOrThrow({
      where: { id },
      select: { status: true, depositStatus: true, checkoutSessionId: true, cancelledBy: true },
    })
  const avisoPagado = (sesion: string, sufijo: string) =>
    processStripeConnectWebhookEvent({
      id: `evt_itest_d681_${RUN}_${sufijo}`,
      type: 'checkout.session.completed',
      account: CONNECT_ACCOUNT,
      livemode: false,
      data: { id: sesion, payment_status: 'paid', payment_intent: `pi_d681_${RUN}_${sufijo}` },
    })
  const avisoVencido = (sesion: string, sufijo: string) =>
    processStripeConnectWebhookEvent({
      id: `evt_itest_d681_${RUN}_${sufijo}`,
      type: 'checkout.session.expired',
      account: CONNECT_ACCOUNT,
      livemode: false,
      data: { id: sesion },
    })

  it('🔴 r2 #2 un pago tardío no regresa a quien ya llegó (sigue CHECKED_IN, sólo queda pagado)', async () => {
    const r = await reservaConLiga()
    await prisma.reservation.update({ where: { id: r.id }, data: { status: 'CHECKED_IN', checkedInAt: new Date() } })

    await avisoPagado(r.checkoutSessionId!, 'llego')

    expect(await leer(r.id)).toMatchObject({ status: 'CHECKED_IN', depositStatus: 'PAID' })
  })

  it('🔴 r2 #3 la consulta a Stripe recorre TODAS las ligas pendientes, de la más vieja a la más nueva, sin saltarse ninguna', async () => {
    const ids: string[] = []
    for (let i = 0; i < 105; i++) ids.push((await reservaConLiga()).id)
    const filas = await prisma.reservation.findMany({ where: { id: { in: ids } }, select: { checkoutSessionId: true }, take: 200 })
    for (const f of filas) estadoEnStripe.set(f.checkoutSessionId!, { status: 'expired', payment_status: 'unpaid' })

    await reservationDepositReconciliationJob.reconcileNow()

    const quedan = await prisma.reservation.count({ where: { id: { in: ids }, depositStatus: 'PENDING' } })
    expect(quedan).toBe(0)
  }, 120_000)

  it('🔴 r2 #4 «pagar de nuevo» con la liga anterior ya vencida: el apartado vence y contesta «Tu apartado venció» (no abre otra)', async () => {
    const customer = await prisma.customer.create({ data: { venueId: venue!.id, email: `r24-${RUN}@test.com`, consumerId } })
    const r = await reservaConLiga({ customerId: customer.id })
    estadoEnStripe.set(r.checkoutSessionId!, { status: 'expired', payment_status: 'unpaid' })

    await expect(createDepositCheckoutForConsumer(consumerId!, venue!.slug, r.cancelSecret)).rejects.toMatchObject({
      statusCode: 409,
      message: 'Tu apartado venció. Reserva de nuevo.',
    })
    expect(mockSessionsCreate).not.toHaveBeenCalled()
    expect(await leer(r.id)).toMatchObject({ status: 'CANCELLED', depositStatus: 'EXPIRED' })
  })

  it('🔴 r2 #4 «pagar de nuevo» con la liga anterior abierta: reusa ESA liga (nunca dos ligas para el mismo depósito)', async () => {
    const customer = await prisma.customer.create({ data: { venueId: venue!.id, email: `r24b-${RUN}@test.com`, consumerId } })
    const r = await reservaConLiga({ customerId: customer.id })
    estadoEnStripe.set(r.checkoutSessionId!, { status: 'open', payment_status: 'unpaid', url: 'https://checkout.stripe.test/la-misma' })

    const pago = await createDepositCheckoutForConsumer(consumerId!, venue!.slug, r.cancelSecret)

    expect(pago.checkoutUrl).toBe('https://checkout.stripe.test/la-misma')
    expect(mockSessionsCreate).not.toHaveBeenCalled()
    expect((await leer(r.id)).checkoutSessionId).toBe(r.checkoutSessionId)
  })

  it('🔴 r2 #5 una reserva «paga al llegar» (depósito vacío) sí puede abrir su liga desde la app', async () => {
    const customer = await prisma.customer.create({ data: { venueId: venue!.id, email: `r25-${RUN}@test.com`, consumerId } })
    const r = await reservaConLiga({ status: 'CONFIRMED', depositStatus: null, conLiga: false, customerId: customer.id })

    const pago = await createDepositCheckoutForConsumer(consumerId!, venue!.slug, r.cancelSecret)

    expect(pago.checkoutUrl).toEqual(expect.stringContaining('checkout.stripe.test'))
    expect(await leer(r.id)).toMatchObject({
      status: 'CONFIRMED',
      depositStatus: 'PENDING',
      checkoutSessionId: expect.stringContaining('cs_itest_d681_'),
    })
  })

  describe('todos contra todos: dos escritores a la vez sobre la misma reserva', () => {
    /** Ninguna combinación imposible, y todo pago que no pudo aplicarse quedó como anomalía. */
    async function estadoValido(id: string, huboPago: boolean) {
      const f = await leer(id)
      const anomalias = await prisma.moneyAnomaly.count({ where: { reservationId: id } })
      const combinacion = `${f.status}/${f.depositStatus}`
      expect([
        'PENDING/PENDING',
        'CONFIRMED/PAID',
        'CHECKED_IN/PAID',
        'CANCELLED/EXPIRED',
        'CANCELLED/REFUNDED',
        'CANCELLED/FORFEITED',
        'CANCELLED/PAID', // devolución en curso
      ]).toContain(combinacion)
      // Un pago que llegó y no se quedó en la reserva siempre deja rastro.
      if (huboPago && !['PAID', 'REFUNDED', 'FORFEITED'].includes(f.depositStatus ?? '')) expect(anomalias).toBeGreaterThan(0)
      return combinacion
    }
    const aLaVez = (...fns: Array<() => Promise<unknown>>) => Promise.allSettled(fns.map(f => f()))
    const VUELTAS = 4

    it('cancelar contra el aviso de pagado', async () => {
      for (let i = 0; i < VUELTAS; i++) {
        const r = await reservaConLiga()
        await aLaVez(
          () => cancelReservation(venue!.id, r.id, 'CUSTOMER'),
          () => avisoPagado(r.checkoutSessionId!, `cp${i}`),
        )
        const c = await estadoValido(r.id, true)
        expect(c).not.toBe('PENDING/PENDING')
      }
    })

    it('aviso de pagado contra aviso de vencida', async () => {
      for (let i = 0; i < VUELTAS; i++) {
        const r = await reservaConLiga()
        await aLaVez(
          () => avisoPagado(r.checkoutSessionId!, `pv${i}`),
          () => avisoVencido(r.checkoutSessionId!, `vp${i}`),
        )
        expect(['CONFIRMED/PAID', 'CANCELLED/EXPIRED']).toContain(await estadoValido(r.id, true))
      }
    })

    it('aviso de pagado contra el regreso de la app (los dos dicen «pagado»): una sola confirmación, sin anomalía', async () => {
      for (let i = 0; i < VUELTAS; i++) {
        const customer = await prisma.customer.create({ data: { venueId: venue!.id, email: `tt-${RUN}-${i}@test.com`, consumerId } })
        const r = await reservaConLiga({ customerId: customer.id })
        estadoEnStripe.set(r.checkoutSessionId!, { status: 'complete', payment_status: 'paid', payment_intent: `pi_d681_${RUN}_app${i}` })
        await aLaVez(
          () => avisoPagado(r.checkoutSessionId!, `pa${i}`),
          () => finalizeDepositCheckoutForConsumer(consumerId!, r.checkoutSessionId!),
        )
        expect(await estadoValido(r.id, true)).toBe('CONFIRMED/PAID')
        expect(await prisma.moneyAnomaly.count({ where: { reservationId: r.id } })).toBe(0)
      }
    })

    it('aviso de pagado contra la llegada: termina CHECKED_IN y pagado', async () => {
      for (let i = 0; i < VUELTAS; i++) {
        const r = await reservaConLiga()
        await aLaVez(
          () => avisoPagado(r.checkoutSessionId!, `ll${i}`),
          () =>
            prisma.reservation.updateMany({
              where: { id: r.id, status: { in: ['PENDING', 'CONFIRMED'] } },
              data: { status: 'CHECKED_IN', checkedInAt: new Date() },
            }),
        )
        expect(await estadoValido(r.id, true)).toBe('CHECKED_IN/PAID')
      }
    })

    it('cancelar contra el aviso de vencida', async () => {
      for (let i = 0; i < VUELTAS; i++) {
        const r = await reservaConLiga()
        await aLaVez(
          () => cancelReservation(venue!.id, r.id, 'CUSTOMER'),
          () => avisoVencido(r.checkoutSessionId!, `cv${i}`),
        )
        expect(await estadoValido(r.id, false)).toBe('CANCELLED/EXPIRED')
      }
    })

    it('barrido por reloj contra crear la liga (apartado sin liga ya vencido)', async () => {
      for (let i = 0; i < VUELTAS; i++) {
        const r = await reservaConLiga({ conLiga: false, venceEnMin: -1 })
        const merchant = await prisma.ecommerceMerchant.findFirstOrThrow({ where: { venueId: venue!.id }, include: { provider: true } })
        await aLaVez(
          () => reservationDepositReconciliationJob['expirePastDueReservations'](),
          () =>
            registrarLiga({
              reservationId: r.id,
              venueId: venue!.id,
              merchant,
              session: { id: `cs_d681_${RUN}_tarde${i}`, expiresAt: new Date(Date.now() + 31 * 60_000) },
            }),
        )
        expect(await estadoValido(r.id, false)).toBe('CANCELLED/EXPIRED')
      }
    })

    it('cancelar contra «pagar de nuevo» (crear otra liga): nunca queda una liga viva sobre una cancelada', async () => {
      for (let i = 0; i < VUELTAS; i++) {
        const r = await reservaConLiga({ conLiga: false })
        const merchant = await prisma.ecommerceMerchant.findFirstOrThrow({ where: { venueId: venue!.id }, include: { provider: true } })
        await aLaVez(
          () => cancelReservation(venue!.id, r.id, 'CUSTOMER'),
          () =>
            registrarLiga({
              reservationId: r.id,
              venueId: venue!.id,
              merchant,
              session: { id: `cs_d681_${RUN}_otra${i}`, expiresAt: new Date(Date.now() + 19 * 60_000) },
            }),
        )
        const f = await leer(r.id)
        const c = await estadoValido(r.id, false)
        // O se canceló (y si la liga nueva alcanzó a guardarse, se cerró en Stripe), o la liga quedó y la cancelación no pasó.
        if (c === 'CANCELLED/EXPIRED') {
          if (f.checkoutSessionId)
            expect(mockSessionsExpire).toHaveBeenCalledWith(f.checkoutSessionId, {}, { stripeAccount: CONNECT_ACCOUNT })
        } else expect(c).toBe('PENDING/PENDING')
        // La liga nueva que no quedó guardada tampoco sigue viva.
        if (f.checkoutSessionId !== `cs_d681_${RUN}_otra${i}`) {
          expect(mockSessionsExpire).toHaveBeenCalledWith(`cs_d681_${RUN}_otra${i}`, {}, { stripeAccount: CONNECT_ACCOUNT })
        }
      }
    })
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
