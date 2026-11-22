/**
 * Integration (REAL DB + REAL app por supertest) — D681, la reserva que no se pagó.
 *
 * Caso real (Mindform BSF, 22-nov): una clienta reservó una clase con pago por adelantado, fue a Stripe y regresó sin pagar.
 * La reserva quedó PENDING + depósito PENDING con su sesión de Stripe, pero SIN vencimiento (`depositExpiresAt` NULL):
 * el servidor le daba a Stripe un vencimiento y no lo guardaba. El job que suelta los lugares vencidos busca por esa
 * columna, así que no la veía. Y al cancelarla ella misma, el depósito seguía PENDING con la liga de Stripe abierta:
 * si pagaba después, el aviso de Stripe la revivía (CANCELLED → CONFIRMED) sin volver a medir el cupo.
 *
 * Sólo se simula el SDK de Stripe (no hay red en tests). Rutas, controlador, servicio, job y webhook son REALES.
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test'
process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'test-access-secret'
process.env.REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'test-refresh-secret'

import '../../__helpers__/integration-setup'

const mockSessionsCreate = jest.fn()
const mockSessionsExpire = jest.fn()
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    checkout: { sessions: { create: mockSessionsCreate, expire: mockSessionsExpire, retrieve: jest.fn() } },
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
import { Prisma } from '@prisma/client'
import app from '@/app'
import prisma from '@/utils/prismaClient'
import { reservationDepositReconciliationJob } from '@/jobs/reservation-deposit-reconciliation.job'
import { processStripeConnectWebhookEvent } from '@/services/payments/reservation-deposit-webhook.service'

const P = '/api/v1/public'
const RUN = Date.now()
const CONNECT_ACCOUNT = `acct_itest_d681_${RUN}`

describe('D681 — la reserva sin pagar vence y suelta su lugar (integration, real DB)', () => {
  let orgId: string | undefined
  let venue: { id: string; slug: string } | undefined
  let productId: string
  let sessionSeq = 0
  /** Lo que «Stripe» contesta como vencimiento de la PRÓXIMA sesión (segundos). null = el que pidió el servidor. */
  let nextExpiresAtSec: number | null = null

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
  })

  beforeEach(() => {
    mockSessionsCreate.mockReset()
    mockSessionsExpire.mockReset()
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
  })

  afterAll(async () => {
    const step = (fn: () => Promise<unknown>) => fn().catch(() => {})
    if (venue) {
      const v = venue.id
      await step(() => prisma.moneyAnomaly.deleteMany({ where: { stripeEventId: { startsWith: `evt_itest_d681_${RUN}` } } }))
      await step(() => prisma.processedStripeEvent.deleteMany({ where: { stripeEventId: { startsWith: `evt_itest_d681_${RUN}` } } }))
      await step(() => prisma.reservation.deleteMany({ where: { venueId: v } }))
      await step(() => prisma.classSession.deleteMany({ where: { venueId: v } }))
      await step(() => prisma.product.deleteMany({ where: { venueId: v } }))
      await step(() => prisma.menuCategory.deleteMany({ where: { venueId: v } }))
      await step(() => prisma.ecommerceMerchant.deleteMany({ where: { venueId: v } }))
      await step(() => prisma.reservationSettings.deleteMany({ where: { venueId: v } }))
      await step(() => prisma.activityLog.deleteMany({ where: { venueId: v } }))
      await step(() => prisma.venue.deleteMany({ where: { id: v } }))
    }
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

  async function filaPorSecreto(cancelSecret: string) {
    return prisma.reservation.findFirstOrThrow({
      where: { cancelSecret, venueId: venue!.id },
      select: { id: true, status: true, depositStatus: true, depositExpiresAt: true, checkoutSessionId: true, cancelledBy: true },
    })
  }

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

  it('🔴 vencida la ventana de pago, el job la cancela y el lugar se puede volver a reservar', async () => {
    const clase = await nuevaClase(1)
    // Stripe contesta un vencimiento que ya pasó: así se simula «regresó sin pagar y pasaron los 30 min».
    nextExpiresAtSec = Math.floor(Date.now() / 1000) - 60
    const primera = await reservar(clase.id, 'Bety')
    expect(primera.status).toBe(201)

    // Con el lugar apartado por la reserva sin pagar, la clase está llena.
    nextExpiresAtSec = null
    const llena = await reservar(clase.id, 'Caro')
    expect(llena.status).toBe(409)

    await reservationDepositReconciliationJob['expirePastDueReservations']()

    const fila = await filaPorSecreto(primera.body.cancelSecret)
    expect(fila.status).toBe('CANCELLED')
    expect(fila.depositStatus).toBe('EXPIRED')
    expect(fila.cancelledBy).toBe('SYSTEM')

    const otra = await reservar(clase.id, 'Caro')
    expect(otra.status).toBe(201)
  })

  it('🔴 si la clienta la cancela sin pagar: el depósito ya no se cobra, la liga de Stripe se cierra y un pago tardío NO la revive', async () => {
    const clase = await nuevaClase(10)
    const res = await reservar(clase.id, 'Dani')
    expect(res.status).toBe(201)

    const cancel = await request(app).post(`${P}/venues/${venue!.slug}/reservations/${res.body.cancelSecret}/cancel`).send({})
    expect(cancel.status).toBe(200)

    const fila = await filaPorSecreto(res.body.cancelSecret)
    expect(fila.status).toBe('CANCELLED')
    expect(fila.depositStatus).toBe('EXPIRED')
    expect(fila.cancelledBy).toBe('CUSTOMER')
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

  it('el job NO toca una reserva cuyo plazo de pago sigue vivo', async () => {
    const clase = await nuevaClase(10)
    const res = await reservar(clase.id, 'Gaby')
    expect(res.status).toBe(201)

    await reservationDepositReconciliationJob['expirePastDueReservations']()

    const fila = await filaPorSecreto(res.body.cancelSecret)
    expect(fila.status).toBe('PENDING')
    expect(fila.depositStatus).toBe('PENDING')
  })
})
