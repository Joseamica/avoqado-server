/**
 * Integration (REAL DB + REAL app por supertest) — D681, versión chica: «si no paga, no obtiene la clase».
 *
 * Caso real (Mindform BSF, 22-nov): una clienta reservó una clase con pago por adelantado, fue a Stripe y regresó sin pagar.
 * El lugar quedó apartado sin fecha visible hasta que Stripe mandó, a los 30 min, su aviso de liga vencida.
 *
 * (a) Al crear la liga se guarda su vencimiento y «Tu Reservación» lo recibe.
 * (b) Si la clienta vuelve de Stripe SIN pagar (la liga «atrás», `cancel_url`), el widget lo avisa: el SERVIDOR cierra la liga en
 *     Stripe y aplica el MISMO camino del aviso de liga vencida. Si ya se pagó, el del aviso de pago. Si Stripe no contesta, nada
 *     cambia (vence sola). Sólo quien tiene la liga de gestión de ESA reserva puede pedirlo.
 *
 * Sólo se simula el SDK de Stripe (no hay red en tests). Rutas, controlador, servicios y avisos son REALES.
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
import { Prisma } from '@prisma/client'
import app from '@/app'
import prisma from '@/utils/prismaClient'
import { reservationDepositReconciliationJob } from '@/jobs/reservation-deposit-reconciliation.job'

const P = '/api/v1/public'
const RUN = Date.now()
const CONNECT_ACCOUNT = `acct_itest_d681c_${RUN}`

describe('D681 chica — volver de Stripe sin pagar suelta el lugar (integration, real DB)', () => {
  let orgId: string | undefined
  let venue: { id: string; slug: string } | undefined
  let otroVenue: { id: string; slug: string } | undefined
  let productId: string
  let sesion = 0

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: 'ITEST D681c Org', email: `itest-d681c-${RUN}@test.com`, phone: '5550000000' },
    })
    orgId = org.id
    const mkVenue = (sufijo: string) =>
      prisma.venue.create({
        data: {
          name: `ITEST D681c ${sufijo}`,
          slug: `itest-d681c-${sufijo}-${RUN}`,
          organizationId: org.id,
          address: 'X',
          city: 'X',
          state: 'X',
          country: 'MX',
          zipCode: '00000',
          timezone: 'America/Mexico_City',
          status: 'TRIAL' as any, // exento del gate de plan: aquí se prueba el depósito
        },
        select: { id: true, slug: true },
      })
    venue = await mkVenue('a')
    otroVenue = await mkVenue('b')
    await prisma.reservationSettings.create({ data: { venueId: venue.id, publicBookingEnabled: true } })

    const provider = await prisma.paymentProvider.upsert({
      where: { code: 'STRIPE_CONNECT' },
      create: { code: 'STRIPE_CONNECT', name: 'Stripe Connect', type: 'PAYMENT_PROCESSOR' },
      update: { active: true },
    })
    await prisma.ecommerceMerchant.create({
      data: {
        venueId: venue.id,
        businessName: 'ITEST D681c',
        contactEmail: `itest-d681c-canal-${RUN}@example.test`,
        publicKey: `pk_test_d681c_${RUN}`,
        secretKeyHash: `hash-d681c-${RUN}`,
        providerId: provider.id,
        providerCredentials: { connectAccountId: CONNECT_ACCOUNT },
        active: true,
        chargesEnabled: true,
      },
    })
    const category = await prisma.menuCategory.create({ data: { venueId: venue.id, name: 'Clases', slug: `clases-d681c-${RUN}` } })
    const product = await prisma.product.create({
      data: {
        venueId: venue.id,
        sku: `D681C-${RUN}`,
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
    mockSessionsRetrieve.mockReset()
    mockSessionsCreate.mockImplementation(async (params: { expires_at: number }) => {
      sesion += 1
      return {
        id: `cs_itest_d681c_${RUN}_${sesion}`,
        url: `https://checkout.stripe.test/c/pay/${sesion}`,
        expires_at: params.expires_at,
      }
    })
    mockSessionsExpire.mockResolvedValue({ status: 'expired' })
    mockSessionsRetrieve.mockResolvedValue({ status: 'open', payment_status: 'unpaid', payment_intent: null, amount_total: 32500 })
  })

  afterAll(async () => {
    const step = (fn: () => Promise<unknown>) => fn().catch(() => {})
    const ids = [venue?.id, otroVenue?.id].filter((x): x is string => !!x)
    await step(() => prisma.processedStripeEvent.deleteMany({ where: { stripeEventId: { contains: `d681c_${RUN}` } } }))
    await step(() => prisma.reservation.deleteMany({ where: { venueId: { in: ids } } }))
    await step(() => prisma.classSession.deleteMany({ where: { venueId: { in: ids } } }))
    await step(() => prisma.product.deleteMany({ where: { venueId: { in: ids } } }))
    await step(() => prisma.menuCategory.deleteMany({ where: { venueId: { in: ids } } }))
    await step(() => prisma.ecommerceMerchant.deleteMany({ where: { venueId: { in: ids } } }))
    await step(() => prisma.reservationSettings.deleteMany({ where: { venueId: { in: ids } } }))
    await step(() => prisma.activityLog.deleteMany({ where: { venueId: { in: ids } } }))
    await step(() => prisma.venue.deleteMany({ where: { id: { in: ids } } }))
    if (orgId) await step(() => prisma.organization.deleteMany({ where: { id: orgId } }))
  })

  async function nuevaClase(capacity: number) {
    const startsAt = new Date(Date.now() + 3 * 24 * 3_600_000)
    return prisma.classSession.create({
      data: { venueId: venue!.id, productId, startsAt, endsAt: new Date(startsAt.getTime() + 50 * 60_000), duration: 50, capacity },
    })
  }

  let visitante = 0
  const ip = () => `10.68.2.${++visitante}` // el límite público es por visitante
  const reservar = (classSessionId: string, quien: string) =>
    request(app)
      .post(`${P}/venues/${venue!.slug}/reservations`)
      .set('cf-connecting-ip', ip())
      .send({ classSessionId, guestName: quien, guestPhone: '5512345678', guestEmail: `${quien.toLowerCase()}-${RUN}@test.com` })
  const volverSinPagar = (slug: string, cancelSecret: string) =>
    request(app).post(`${P}/venues/${slug}/reservations/${cancelSecret}/abandon-payment`).set('cf-connecting-ip', ip()).send({})
  const fila = (cancelSecret: string) =>
    prisma.reservation.findFirstOrThrow({
      where: { cancelSecret },
      select: { status: true, depositStatus: true, depositExpiresAt: true, checkoutSessionId: true },
    })

  it('🔴 (a) la reserva guarda el vencimiento de su liga y «Tu Reservación» lo recibe', async () => {
    const res = await reservar((await nuevaClase(10)).id, 'Ana')
    expect(res.status).toBe(201)
    const pedido = mockSessionsCreate.mock.calls[0][0] as { expires_at: number }

    expect((await fila(res.body.cancelSecret)).depositExpiresAt?.getTime()).toBe(pedido.expires_at * 1000)
    const detalle = await request(app).get(`${P}/venues/${venue!.slug}/reservations/${res.body.cancelSecret}`)
    expect(detalle.status).toBe(200)
    expect(new Date(detalle.body.depositExpiresAt).getTime()).toBe(pedido.expires_at * 1000)
    expect(detalle.body.depositStatus).toBe('PENDING') // lo que ya leían los clientes viejos sigue igual
  })

  it('🔴 (b) liga abierta: se cierra en Stripe, la reserva se suelta y el lugar se puede volver a reservar', async () => {
    const clase = await nuevaClase(1)
    const res = await reservar(clase.id, 'Bety')
    expect(res.status).toBe(201)
    expect((await reservar(clase.id, 'Caro')).status).toBe(409) // apartado: la clase está llena
    const { checkoutSessionId } = await fila(res.body.cancelSecret)

    const vuelta = await volverSinPagar(venue!.slug, res.body.cancelSecret)

    expect(vuelta.status).toBe(200)
    expect(vuelta.body).toMatchObject({ released: true, status: 'CANCELLED', depositStatus: 'EXPIRED' })
    expect(mockSessionsExpire).toHaveBeenCalledWith(checkoutSessionId, {}, { stripeAccount: CONNECT_ACCOUNT })
    expect(await fila(res.body.cancelSecret)).toMatchObject({ status: 'CANCELLED', depositStatus: 'EXPIRED' })
    expect((await reservar(clase.id, 'Caro')).status).toBe(201)
  })

  it('🔴 (b) si Stripe dice que ya se pagó: se confirma, como con el aviso de pago', async () => {
    const res = await reservar((await nuevaClase(10)).id, 'Dani')
    mockSessionsExpire.mockRejectedValueOnce(new Error('This Checkout Session is already complete'))
    mockSessionsRetrieve.mockResolvedValueOnce({
      status: 'complete',
      payment_status: 'paid',
      payment_intent: `pi_d681c_${RUN}`,
      amount_total: 32500,
    })

    const vuelta = await volverSinPagar(venue!.slug, res.body.cancelSecret)

    expect(vuelta.status).toBe(200)
    expect(vuelta.body).toMatchObject({ released: false, status: 'CONFIRMED', depositStatus: 'PAID' })
    expect(await fila(res.body.cancelSecret)).toMatchObject({ status: 'CONFIRMED', depositStatus: 'PAID' })
  })

  it('🔴 (b) si Stripe no contesta: no se toca nada (la liga vence sola a su hora)', async () => {
    const res = await reservar((await nuevaClase(10)).id, 'Eli')
    mockSessionsExpire.mockRejectedValueOnce(new Error('Stripe no contesta'))
    mockSessionsRetrieve.mockRejectedValueOnce(new Error('Stripe no contesta'))

    const vuelta = await volverSinPagar(venue!.slug, res.body.cancelSecret)

    expect(vuelta.status).toBe(200)
    expect(vuelta.body).toMatchObject({ released: false, status: 'PENDING', depositStatus: 'PENDING' })
    expect(vuelta.body.depositExpiresAt).toEqual(expect.any(String))
    expect(await fila(res.body.cancelSecret)).toMatchObject({ status: 'PENDING', depositStatus: 'PENDING' })
  })

  it('🔴 (b) otra persona no puede soltar el lugar: sin la liga de gestión de ESA reserva, 404 y nada cambia', async () => {
    const res = await reservar((await nuevaClase(10)).id, 'Fer')

    const ajena = await volverSinPagar(venue!.slug, '00000000-0000-4000-8000-000000000000')
    const otroNegocio = await volverSinPagar(otroVenue!.slug, res.body.cancelSecret)

    expect(ajena.status).toBe(404)
    expect(otroNegocio.status).toBe(404)
    expect(mockSessionsExpire).not.toHaveBeenCalled()
    expect(await fila(res.body.cancelSecret)).toMatchObject({ status: 'PENDING', depositStatus: 'PENDING' })
  })

  it('una reserva que ya no espera pago no cambia (repetir la vuelta es seguro)', async () => {
    const res = await reservar((await nuevaClase(10)).id, 'Gaby')
    expect((await volverSinPagar(venue!.slug, res.body.cancelSecret)).body.status).toBe('CANCELLED')
    mockSessionsExpire.mockClear()

    const otra = await volverSinPagar(venue!.slug, res.body.cancelSecret)

    expect(otra.status).toBe(200)
    expect(otra.body).toMatchObject({ released: false, status: 'CANCELLED', depositStatus: 'EXPIRED' })
    expect(mockSessionsExpire).not.toHaveBeenCalled()
  })

  it('al guardar el vencimiento, el barrido por reloj no le quita el lugar a quien tiene liga (eso lo decide Stripe)', async () => {
    const res = await reservar((await nuevaClase(10)).id, 'Hugo')
    await prisma.reservation.updateMany({
      where: { cancelSecret: res.body.cancelSecret },
      data: { depositExpiresAt: new Date(Date.now() - 60_000) },
    })

    await reservationDepositReconciliationJob['expirePastDueReservations']()

    expect(await fila(res.body.cancelSecret)).toMatchObject({ status: 'PENDING', depositStatus: 'PENDING' })
  })
})
