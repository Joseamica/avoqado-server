/**
 * Integration (REAL DB + REAL app por supertest) — Fase 0.B, identidad del cliente atada al venue.
 *
 * Cierra el P2 #3 de las auditorías de Codex ("pruebas sólo mockeadas"): aquí corren las
 * uniones reales ruta → middlewares → controller → servicio → Postgres, y el webhook de
 * Connect contra la constraint única real de ProcessedStripeEvent.
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test'
process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'test-access-secret'
process.env.REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'test-refresh-secret'

import '../../__helpers__/integration-setup'

// Sólo el SDK de Stripe se simula (no hay red en tests): `checkout.sessions.retrieve` devuelve
// lo que cada caso necesite. El fulfillment, la atribución, las constraints y los balances
// son REALES (auditoría 4, bloqueo 4).
const mockStripeRetrieve = jest.fn()
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    checkout: { sessions: { retrieve: mockStripeRetrieve, create: jest.fn() } },
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
import bcrypt from 'bcryptjs'
import { Prisma } from '@prisma/client'
import app from '@/app'
import prisma from '@/utils/prismaClient'
import { processStripeConnectWebhookEvent, STRIPE_EVENT_IN_PROGRESS } from '@/services/payments/reservation-deposit-webhook.service'

const P = '/api/v1/public'
const RUN = Date.now()
const PASSWORD = 'Secreto123!'

describe('Fase 0.B — identidad del cliente (integration, real DB)', () => {
  let orgId: string | undefined
  let venueA: { id: string; slug: string } | undefined
  let venueB: { id: string; slug: string } | undefined
  let productId: string
  let packId: string
  let anaId: string
  let activeEmail: string
  let inactiveEmail: string
  let balanceId: string

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: 'ITEST F0B Org', email: `itest-f0b-${RUN}@test.com`, phone: '5550000000' },
    })
    orgId = org.id
    const mkVenue = async (suffix: string) =>
      prisma.venue.create({
        data: {
          name: `ITEST F0B ${suffix}`,
          slug: `itest-f0b-${suffix}-${RUN}`,
          organizationId: org.id,
          address: 'X',
          city: 'X',
          state: 'X',
          country: 'MX',
          zipCode: '00000',
          timezone: 'America/Mexico_City',
          // TRIAL ⇒ exento del gate de plan (DEMO_VENUE_STATUSES): probamos identidad, no tiers.
          status: 'TRIAL' as any,
        },
        select: { id: true, slug: true },
      })
    const a = await mkVenue('a')
    venueA = a
    const b = await mkVenue('b')
    venueB = b
    // Reservas públicas prendidas en A (el default del modelo es false): así el POST llega a
    // la guarda de identidad en vez de morir en 'reservaciones en línea no habilitadas'.
    await prisma.reservationSettings.create({ data: { venueId: a.id, publicBookingEnabled: true } })

    const category = await prisma.menuCategory.create({
      data: { venueId: a.id, name: 'Clases', slug: `clases-${RUN}` },
    })
    const product = await prisma.product.create({
      data: { venueId: a.id, sku: `F0B-${RUN}`, name: 'Yoga', categoryId: category.id, price: new Prisma.Decimal(200) },
    })
    productId = product.id

    const hashed = await bcrypt.hash(PASSWORD, 4)
    activeEmail = `ana-${RUN}@test.com`
    inactiveEmail = `baja-${RUN}@test.com`
    const ana = await prisma.customer.create({
      data: { venueId: a.id, email: activeEmail, password: hashed, firstName: 'Ana', active: true },
    })
    anaId = ana.id
    await prisma.customer.create({
      data: { venueId: a.id, email: inactiveEmail, password: hashed, firstName: 'Baja', active: false },
    })
    // Un email diferente en venue B con el mismo password, para probar el cruce de venues.
    await prisma.customer.create({
      data: { venueId: b.id, email: activeEmail, password: hashed, firstName: 'AnaB', active: true },
    })

    const pack = await prisma.creditPack.create({
      data: { venueId: a.id, name: 'Pack 5', price: new Prisma.Decimal(1000) },
    })
    packId = pack.id
    const item = await prisma.creditPackItem.create({ data: { creditPackId: pack.id, productId, quantity: 5 } })
    const purchase = await prisma.creditPackPurchase.create({
      data: { venueId: a.id, customerId: ana.id, creditPackId: pack.id, amountPaid: new Prisma.Decimal(1000) },
    })
    const balance = await prisma.creditItemBalance.create({
      data: { creditPackPurchaseId: purchase.id, creditPackItemId: item.id, productId, originalQuantity: 5, remainingQuantity: 5 },
    })
    balanceId = balance.id
  })

  afterAll(async () => {
    // Limpieza ROBUSTA (auditoría 4): corre aunque el setup haya muerto a medias — sólo usa los
    // ids que sí existen y cada paso está protegido para que uno fallido no deje el resto.
    const venueIds = [venueA?.id, venueB?.id].filter((x): x is string => !!x)
    const step = (fn: () => Promise<unknown>) => fn().catch(() => {})
    if (venueIds.length > 0) {
      await step(() => prisma.creditTransaction.deleteMany({ where: { creditPackPurchase: { venueId: { in: venueIds } } } }))
      await step(() => prisma.creditItemBalance.deleteMany({ where: { creditPackPurchase: { venueId: { in: venueIds } } } }))
      await step(() => prisma.creditPackPurchase.deleteMany({ where: { venueId: { in: venueIds } } }))
      await step(() => prisma.creditPackItem.deleteMany({ where: { creditPack: { venueId: { in: venueIds } } } }))
      await step(() => prisma.creditPack.deleteMany({ where: { venueId: { in: venueIds } } }))
      await step(() => prisma.reservation.deleteMany({ where: { venueId: { in: venueIds } } }))
      await step(() => prisma.reservationSettings.deleteMany({ where: { venueId: { in: venueIds } } }))
      await step(() => prisma.product.deleteMany({ where: { venueId: { in: venueIds } } }))
      await step(() => prisma.menuCategory.deleteMany({ where: { venueId: { in: venueIds } } }))
      await step(() => prisma.customer.deleteMany({ where: { venueId: { in: venueIds } } }))
      await step(() => prisma.activityLog.deleteMany({ where: { venueId: { in: venueIds } } }))
      await step(() => prisma.venue.deleteMany({ where: { id: { in: venueIds } } }))
    }
    await step(() => prisma.processedStripeEvent.deleteMany({ where: { stripeEventId: { startsWith: `evt_itest_f0b_${RUN}` } } }))
    await step(() => prisma.moneyAnomaly.deleteMany({ where: { stripeEventId: { startsWith: `cs_itest_f0b_${RUN}` } } }))
    if (orgId) await step(() => prisma.organization.deleteMany({ where: { id: orgId } }))
  })

  const A = () => venueA!
  const B = () => venueB!

  async function loginA(email = activeEmail) {
    return request(app).post(`${P}/venues/${A().slug}/customer/login`).send({ email, password: PASSWORD })
  }

  it('login devuelve token + bookingAccess calculado para el venue', async () => {
    const res = await loginA()
    expect(res.status).toBe(200)
    expect(res.body.token).toEqual(expect.any(String))
    // TRIAL (exento del gate) + publicBooking prendido ⇒ puede reservar; no basta 'any boolean'.
    expect(res.body.bookingAccess).toEqual({ status: 'APPROVED', canCreateReservation: true })
  })

  it('login de cuenta inactiva → 401 CUSTOMER_INACTIVE, sin token', async () => {
    const res = await loginA(inactiveEmail)
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('CUSTOMER_INACTIVE')
    expect(res.body.token).toBeUndefined()
  })

  it('GET balance SIN sesión → 401 CUSTOMER_AUTH_REQUIRED (ya no se consulta por email)', async () => {
    const res = await request(app).get(`${P}/venues/${A().slug}/credit-packs/balance?email=${encodeURIComponent(activeEmail)}`)
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('CUSTOMER_AUTH_REQUIRED')
  })

  it('GET balance CON sesión → 200 con los balances del customer del token', async () => {
    const { body } = await loginA()
    const res = await request(app).get(`${P}/venues/${A().slug}/credit-packs/balance`).set('Authorization', `Bearer ${body.token}`)
    expect(res.status).toBe(200)
    expect(res.body.customer.email).toBe(activeEmail)
    const balances = res.body.purchases.flatMap((p: any) => p.itemBalances)
    expect(balances.map((b: any) => b.id)).toContain(balanceId)
  })

  it('token de venue A contra el slug de venue B → 401 CUSTOMER_TOKEN_VENUE_MISMATCH (el slug manda)', async () => {
    const { body } = await loginA()
    const res = await request(app).get(`${P}/venues/${B().slug}/credit-packs/balance`).set('Authorization', `Bearer ${body.token}`)
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('CUSTOMER_TOKEN_VENUE_MISMATCH')
  })

  it('Authorization presente pero basura → 401 CUSTOMER_TOKEN_INVALID (nunca degrada a invitado)', async () => {
    const res = await request(app).get(`${P}/venues/${A().slug}/credit-packs/balance`).set('Authorization', 'Bearer nope')
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('CUSTOMER_TOKEN_INVALID')
  })

  it('GET portal con sesión → 200 e incluye bookingAccess', async () => {
    const { body } = await loginA()
    const res = await request(app).get(`${P}/venues/${A().slug}/customer/portal`).set('Authorization', `Bearer ${body.token}`)
    expect(res.status).toBe(200)
    expect(res.body.bookingAccess).toEqual(expect.objectContaining({ status: 'APPROVED' }))
  })

  const validReservationBody = () => {
    const startsAt = new Date(Date.now() + 7 * 24 * 3600 * 1000)
    startsAt.setUTCHours(18, 0, 0, 0)
    const endsAt = new Date(startsAt.getTime() + 3600 * 1000)
    return {
      productId,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      duration: 60,
      guestName: 'Invitada',
      guestPhone: '+525511112222',
      guestEmail: `inv-${RUN}@test.com`,
      partySize: 1,
    }
  }

  it('POST reservations con customerId en el body → 400 CUSTOMER_ID_NOT_ALLOWED antes del controller', async () => {
    const res = await request(app)
      .post(`${P}/venues/${A().slug}/reservations`)
      .send({ ...validReservationBody(), customerId: 'cualquiera' })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('CUSTOMER_ID_NOT_ALLOWED')
  })

  it('POST reservations de INVITADO con creditItemBalanceId → 401 CUSTOMER_AUTH_REQUIRED y NO se crea reserva', async () => {
    const before = await prisma.reservation.count({ where: { venueId: A().id } })
    const res = await request(app)
      .post(`${P}/venues/${A().slug}/reservations`)
      .send({ ...validReservationBody(), creditItemBalanceId: balanceId })
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('CUSTOMER_AUTH_REQUIRED')
    const after = await prisma.reservation.count({ where: { venueId: A().id } })
    expect(after).toBe(before)
    const bal = await prisma.creditItemBalance.findUnique({ where: { id: balanceId } })
    expect(bal?.remainingQuantity).toBe(5)
  })

  it('POST reservations AUTENTICADO con creditItemBalanceId → reserva creada ligada a la sesión, saldo 5→4 y CreditTransaction REDEEM (canje REAL)', async () => {
    const { body } = await loginA()
    const res = await request(app)
      .post(`${P}/venues/${A().slug}/reservations`)
      .set('Authorization', `Bearer ${body.token}`)
      .send({ ...validReservationBody(), creditItemBalanceId: balanceId })

    expect(res.status).toBe(201)
    const reservation = await prisma.reservation.findFirst({ where: { venueId: A().id, confirmationCode: res.body.confirmationCode } })
    expect(reservation?.customerId).toBe(anaId) // identidad de la SESIÓN, no del body
    const bal = await prisma.creditItemBalance.findUnique({ where: { id: balanceId } })
    expect(bal?.remainingQuantity).toBe(4)
    const redeem = await prisma.creditTransaction.findFirst({ where: { creditItemBalanceId: balanceId, type: 'REDEEM' } })
    expect(redeem).toBeTruthy()
  })

  describe('webhook Connect — fulfillment REAL (sólo el SDK de Stripe simulado) contra las constraints reales', () => {
    const sessionId = `cs_itest_f0b_${RUN}`
    const stripeSession = (customerId: string) => ({
      id: sessionId,
      payment_status: 'paid',
      payment_intent: `pi_itest_${RUN}`,
      amount_total: 100000,
      customer_email: null,
      metadata: { type: 'credit_pack_purchase', venueId: A().id, packId, customerId, customerEmail: activeEmail, customerPhone: '' },
    })
    const event = (id: string) => ({
      id,
      type: 'checkout.session.completed',
      account: 'acct_itest',
      livemode: false,
      data: { id: sessionId, payment_status: 'paid', metadata: { type: 'credit_pack_purchase' } },
    })

    it('1ª entrega: customer de sesión BORRADO → fail-closed real (MoneyAnomaly, sin compra, claim liberado); ops corrige; 2ª entrega crea la compra para ESE customer; duplicado materializado se ignora; otro evento de la misma sesión no duplica la compra', async () => {
      const id = `evt_itest_f0b_${RUN}`

      // 1) El checkout nació con sesión de un customer que ya no existe en el venue.
      mockStripeRetrieve.mockResolvedValue(stripeSession('cust-que-ya-no-existe'))
      await expect(processStripeConnectWebhookEvent(event(id))).rejects.toMatchObject({ code: 'CREDIT_PACK_OWNER_UNRESOLVED' })
      expect(await prisma.creditPackPurchase.count({ where: { stripeCheckoutSessionId: sessionId } })).toBe(0)
      expect(await prisma.customer.count({ where: { venueId: A().id } })).toBe(2) // NO creó un Customer nuevo por contacto
      expect(await prisma.moneyAnomaly.count({ where: { stripeEventId: sessionId, category: 'CREDIT_PACK_OWNER_UNRESOLVED' } })).toBe(1)
      expect(await prisma.processedStripeEvent.count({ where: { endpoint: 'connect', stripeEventId: id } })).toBe(0) // claim liberado

      // 2) Reintento de Stripe tras la corrección (la sesión ahora resuelve a Ana): compra REAL.
      mockStripeRetrieve.mockResolvedValue(stripeSession(anaId))
      await processStripeConnectWebhookEvent(event(id))
      const purchase = await prisma.creditPackPurchase.findUnique({
        where: { stripeCheckoutSessionId: sessionId },
        include: { itemBalances: true },
      })
      expect(purchase?.customerId).toBe(anaId)
      expect(purchase?.status).toBe('ACTIVE')
      expect(purchase?.itemBalances).toHaveLength(1)
      expect(purchase?.itemBalances[0]).toEqual(expect.objectContaining({ productId, originalQuantity: 5, remainingQuantity: 5 }))
      expect(await prisma.processedStripeEvent.count({ where: { endpoint: 'connect', stripeEventId: id } })).toBe(1)

      // 3) Entrega duplicada del MISMO evento: P2002 en el claim + resultado materializado ⇒ 2xx, sin tocar nada.
      await expect(processStripeConnectWebhookEvent(event(id))).resolves.toBeUndefined()
      expect(await prisma.creditPackPurchase.count({ where: { stripeCheckoutSessionId: sessionId } })).toBe(1)

      // 4) OTRO evento (id distinto) de la MISMA sesión: el fulfillment es idempotente por stripeCheckoutSessionId.
      await processStripeConnectWebhookEvent(event(`${id}_b`))
      expect(await prisma.creditPackPurchase.count({ where: { stripeCheckoutSessionId: sessionId } })).toBe(1)
      expect(await prisma.creditItemBalance.count({ where: { creditPackPurchaseId: purchase!.id } })).toBe(1)
    })

    it('duplicado con claim RECIENTE y resultado NO materializado → no-2xx (STRIPE_EVENT_IN_PROGRESS), sin tocar el claim', async () => {
      const id = `evt_itest_f0b_${RUN}_inflight`
      // Simula "A sigue trabajando": el claim existe y no hay compra para esta otra sesión.
      await prisma.processedStripeEvent.create({
        data: { endpoint: 'connect', stripeEventId: id, eventType: 'checkout.session.completed', account: 'acct_itest', payload: {} },
      })
      const otherSession = { ...event(id), data: { ...event(id).data, id: `cs_itest_f0b_${RUN}_inflight` } }

      await expect(processStripeConnectWebhookEvent(otherSession)).rejects.toMatchObject({ code: STRIPE_EVENT_IN_PROGRESS })
      expect(await prisma.processedStripeEvent.count({ where: { endpoint: 'connect', stripeEventId: id } })).toBe(1)
      expect(mockStripeRetrieve).not.toHaveBeenCalledWith(`cs_itest_f0b_${RUN}_inflight`, expect.anything(), expect.anything())
    })
  })
})
