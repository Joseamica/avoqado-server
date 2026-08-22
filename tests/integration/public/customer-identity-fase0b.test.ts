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

jest.mock('@/services/dashboard/creditPack.public.service', () => {
  const actual = jest.requireActual('@/services/dashboard/creditPack.public.service')
  return { __esModule: true, ...actual, fulfillPurchase: jest.fn() }
})

import request from 'supertest'
import bcrypt from 'bcryptjs'
import { Prisma } from '@prisma/client'
import app from '@/app'
import prisma from '@/utils/prismaClient'
import { processStripeConnectWebhookEvent } from '@/services/payments/reservation-deposit-webhook.service'
import { fulfillPurchase } from '@/services/dashboard/creditPack.public.service'

const P = '/api/v1/public'
const RUN = Date.now()
const PASSWORD = 'Secreto123!'

describe('Fase 0.B — identidad del cliente (integration, real DB)', () => {
  let orgId: string
  let venueA: { id: string; slug: string }
  let venueB: { id: string; slug: string }
  let productId: string
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
          organizationId: orgId,
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
    venueA = await mkVenue('a')
    venueB = await mkVenue('b')
    // Reservas públicas prendidas en A (el default del modelo es false): así el POST llega a
    // la guarda de identidad en vez de morir en 'reservaciones en línea no habilitadas'.
    await prisma.reservationSettings.create({ data: { venueId: venueA.id, publicBookingEnabled: true } })

    const category = await prisma.menuCategory.create({
      data: { venueId: venueA.id, name: 'Clases', slug: `clases-${RUN}` },
    })
    const product = await prisma.product.create({
      data: { venueId: venueA.id, sku: `F0B-${RUN}`, name: 'Yoga', categoryId: category.id, price: new Prisma.Decimal(200) },
    })
    productId = product.id

    const hashed = await bcrypt.hash(PASSWORD, 4)
    activeEmail = `ana-${RUN}@test.com`
    inactiveEmail = `baja-${RUN}@test.com`
    const ana = await prisma.customer.create({
      data: { venueId: venueA.id, email: activeEmail, password: hashed, firstName: 'Ana', active: true },
    })
    await prisma.customer.create({
      data: { venueId: venueA.id, email: inactiveEmail, password: hashed, firstName: 'Baja', active: false },
    })
    // Un email diferente en venue B con el mismo password, para probar el cruce de venues.
    await prisma.customer.create({
      data: { venueId: venueB.id, email: activeEmail, password: hashed, firstName: 'AnaB', active: true },
    })

    const pack = await prisma.creditPack.create({
      data: { venueId: venueA.id, name: 'Pack 5', price: new Prisma.Decimal(1000) },
    })
    const item = await prisma.creditPackItem.create({ data: { creditPackId: pack.id, productId, quantity: 5 } })
    const purchase = await prisma.creditPackPurchase.create({
      data: { venueId: venueA.id, customerId: ana.id, creditPackId: pack.id, amountPaid: new Prisma.Decimal(1000) },
    })
    const balance = await prisma.creditItemBalance.create({
      data: { creditPackPurchaseId: purchase.id, creditPackItemId: item.id, productId, originalQuantity: 5, remainingQuantity: 5 },
    })
    balanceId = balance.id
  })

  afterAll(async () => {
    const venueIds = [venueA.id, venueB.id]
    await prisma.creditTransaction.deleteMany({ where: { creditPackPurchase: { venueId: { in: venueIds } } } }).catch(() => {})
    await prisma.creditItemBalance.deleteMany({ where: { creditPackPurchase: { venueId: { in: venueIds } } } })
    await prisma.creditPackPurchase.deleteMany({ where: { venueId: { in: venueIds } } })
    await prisma.creditPackItem.deleteMany({ where: { creditPack: { venueId: { in: venueIds } } } })
    await prisma.creditPack.deleteMany({ where: { venueId: { in: venueIds } } })
    await prisma.reservation.deleteMany({ where: { venueId: { in: venueIds } } })
    await prisma.reservationSettings.deleteMany({ where: { venueId: { in: venueIds } } })
    await prisma.product.deleteMany({ where: { venueId: { in: venueIds } } })
    await prisma.menuCategory.deleteMany({ where: { venueId: { in: venueIds } } })
    await prisma.customer.deleteMany({ where: { venueId: { in: venueIds } } })
    await prisma.processedStripeEvent.deleteMany({ where: { stripeEventId: { startsWith: `evt_itest_f0b_${RUN}` } } })
    await prisma.venue.deleteMany({ where: { id: { in: venueIds } } })
    await prisma.organization.deleteMany({ where: { id: orgId } })
  })

  async function loginA(email = activeEmail) {
    return request(app).post(`${P}/venues/${venueA.slug}/customer/login`).send({ email, password: PASSWORD })
  }

  it('login devuelve token + bookingAccess calculado para el venue', async () => {
    const res = await loginA()
    expect(res.status).toBe(200)
    expect(res.body.token).toEqual(expect.any(String))
    expect(res.body.bookingAccess).toEqual(expect.objectContaining({ status: 'APPROVED', canCreateReservation: expect.any(Boolean) }))
  })

  it('login de cuenta inactiva → 401 CUSTOMER_INACTIVE, sin token', async () => {
    const res = await loginA(inactiveEmail)
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('CUSTOMER_INACTIVE')
    expect(res.body.token).toBeUndefined()
  })

  it('GET balance SIN sesión → 401 CUSTOMER_AUTH_REQUIRED (ya no se consulta por email)', async () => {
    const res = await request(app).get(`${P}/venues/${venueA.slug}/credit-packs/balance?email=${encodeURIComponent(activeEmail)}`)
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('CUSTOMER_AUTH_REQUIRED')
  })

  it('GET balance CON sesión → 200 con los balances del customer del token', async () => {
    const { body } = await loginA()
    const res = await request(app).get(`${P}/venues/${venueA.slug}/credit-packs/balance`).set('Authorization', `Bearer ${body.token}`)
    expect(res.status).toBe(200)
    expect(res.body.customer.email).toBe(activeEmail)
    const balances = res.body.purchases.flatMap((p: any) => p.itemBalances)
    expect(balances.map((b: any) => b.id)).toContain(balanceId)
  })

  it('token de venue A contra el slug de venue B → 401 CUSTOMER_TOKEN_VENUE_MISMATCH (el slug manda)', async () => {
    const { body } = await loginA()
    const res = await request(app).get(`${P}/venues/${venueB.slug}/credit-packs/balance`).set('Authorization', `Bearer ${body.token}`)
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('CUSTOMER_TOKEN_VENUE_MISMATCH')
  })

  it('Authorization presente pero basura → 401 CUSTOMER_TOKEN_INVALID (nunca degrada a invitado)', async () => {
    const res = await request(app).get(`${P}/venues/${venueA.slug}/credit-packs/balance`).set('Authorization', 'Bearer nope')
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('CUSTOMER_TOKEN_INVALID')
  })

  it('GET portal con sesión → 200 e incluye bookingAccess', async () => {
    const { body } = await loginA()
    const res = await request(app).get(`${P}/venues/${venueA.slug}/customer/portal`).set('Authorization', `Bearer ${body.token}`)
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
      .post(`${P}/venues/${venueA.slug}/reservations`)
      .send({ ...validReservationBody(), customerId: 'cualquiera' })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('CUSTOMER_ID_NOT_ALLOWED')
  })

  it('POST reservations de INVITADO con creditItemBalanceId → 401 CUSTOMER_AUTH_REQUIRED y NO se crea reserva', async () => {
    const before = await prisma.reservation.count({ where: { venueId: venueA.id } })
    const res = await request(app)
      .post(`${P}/venues/${venueA.slug}/reservations`)
      .send({ ...validReservationBody(), creditItemBalanceId: balanceId })
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('CUSTOMER_AUTH_REQUIRED')
    const after = await prisma.reservation.count({ where: { venueId: venueA.id } })
    expect(after).toBe(before)
    const bal = await prisma.creditItemBalance.findUnique({ where: { id: balanceId } })
    expect(bal?.remainingQuantity).toBe(5)
  })

  describe('webhook Connect — fallo del fulfillment y reintento contra la constraint real', () => {
    const event = (id: string) => ({
      id,
      type: 'checkout.session.completed',
      account: 'acct_itest',
      livemode: false,
      data: { id: `cs_itest_${RUN}`, payment_status: 'paid', metadata: { type: 'credit_pack_purchase' } },
    })

    it('1ª entrega falla → claim liberado; 2ª entrega vuelve a correr el fulfillment; 3ª (ya exitosa) se ignora', async () => {
      const id = `evt_itest_f0b_${RUN}`
      ;(fulfillPurchase as jest.Mock).mockRejectedValueOnce(new Error('owner unresolved')).mockResolvedValue({ id: 'p' })

      await expect(processStripeConnectWebhookEvent(event(id))).rejects.toThrow('owner unresolved')
      expect(await prisma.processedStripeEvent.count({ where: { endpoint: 'connect', stripeEventId: id } })).toBe(0)

      await processStripeConnectWebhookEvent(event(id))
      expect(fulfillPurchase).toHaveBeenCalledTimes(2)
      expect(await prisma.processedStripeEvent.count({ where: { endpoint: 'connect', stripeEventId: id } })).toBe(1)

      await processStripeConnectWebhookEvent(event(id)) // duplicado real (P2002 en el claim)
      expect(fulfillPurchase).toHaveBeenCalledTimes(2)
    })
  })
})
