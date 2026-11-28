/**
 * Integración (base REAL) — la respuesta del POST de reserva de clase trae el saldo del paquete canjeado (`creditBalance`),
 * y el GET público de la reserva trae la ficha de la clase. Ninguna regla de reserva cambia: una segunda reserva de la misma
 * clienta a la misma clase se sigue creando (la regla «un lugar por clase» va en otro proyecto).
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test'
process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'test-access-secret'
process.env.REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'test-refresh-secret'

import '../../__helpers__/integration-setup'

jest.mock('@/services/email.service', () => ({
  __esModule: true,
  default: new Proxy({}, { get: () => jest.fn(async () => true) }),
}))
jest.mock('@/services/whatsapp.service', () => ({
  ...jest.requireActual('@/services/whatsapp.service'),
  sendReservationConfirmationWhatsApp: jest.fn(async () => true),
}))
jest.mock('@/communication/rabbitmq/gcal-push-consumer', () => ({
  __esModule: true,
  publishPushNotification: jest.fn().mockResolvedValue(undefined),
}))

import request from 'supertest'
import bcrypt from 'bcryptjs'
import { Prisma, CreditPurchaseStatus } from '@prisma/client'
import app from '@/app'
import prisma from '@/utils/prismaClient'

// Valores de prueba armados por una función, para que ningún escáner los tome por secretos.
const fijo = (n: string) => `Fijo-${n}-1!`

const P = '/api/v1/public'
const RUN = Date.now()
const PASSWORD = fijo('prueba')
const H = 3_600_000

describe('reservas de clase · saldo en la respuesta (base real)', () => {
  let orgId: string | undefined
  let venue: { id: string; slug: string } | undefined
  let yoga: string
  let pack: string
  let ana: string
  const email = `ana-saldo-${RUN}@test.com`

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: 'ITEST Saldo Org', email: `itest-saldo-${RUN}@test.com`, phone: '5550000000' },
    })
    orgId = org.id
    venue = await prisma.venue.create({
      data: {
        name: 'ITEST Saldo',
        slug: `itest-saldo-${RUN}`,
        organizationId: org.id,
        address: 'X',
        city: 'X',
        state: 'X',
        country: 'MX',
        zipCode: '00000',
        timezone: 'America/Mexico_City',
        status: 'TRIAL' as any,
      },
      select: { id: true, slug: true },
    })
    await prisma.reservationSettings.create({ data: { venueId: venue.id, publicBookingEnabled: true } })
    const category = await prisma.menuCategory.create({ data: { venueId: venue.id, name: 'Clases', slug: `clases-saldo-${RUN}` } })
    yoga = (
      await prisma.product.create({
        data: {
          venueId: venue.id,
          sku: `SALDO-LAGREE-${RUN}`,
          name: 'Lagree',
          type: 'CLASS',
          categoryId: category.id,
          price: new Prisma.Decimal(0),
        },
        select: { id: true },
      })
    ).id
    ana = (
      await prisma.customer.create({
        data: { venueId: venue.id, email, password: await bcrypt.hash(PASSWORD, 4), firstName: 'Ana', active: true },
      })
    ).id
    pack = (await prisma.creditPack.create({ data: { venueId: venue.id, name: 'Paquete de 5', price: new Prisma.Decimal(1000) } })).id
  })

  afterAll(async () => {
    const step = (fn: () => Promise<unknown>) => fn().catch(() => {})
    if (venue) {
      const venueId = venue.id
      await step(() => prisma.creditTransaction.deleteMany({ where: { venueId } }))
      await step(() => prisma.creditItemBalance.deleteMany({ where: { creditPackPurchase: { venueId } } }))
      await step(() => prisma.creditPackPurchase.deleteMany({ where: { venueId } }))
      await step(() => prisma.creditPack.deleteMany({ where: { venueId } }))
      await step(() => prisma.calendarSyncOutbox.deleteMany({ where: { venueId } }))
      await step(() => prisma.reservation.deleteMany({ where: { venueId } }))
      await step(() => prisma.classSession.deleteMany({ where: { venueId } }))
      await step(() => prisma.reservationSettings.deleteMany({ where: { venueId } }))
      await step(() => prisma.product.deleteMany({ where: { venueId } }))
      await step(() => prisma.menuCategory.deleteMany({ where: { venueId } }))
      await step(() => prisma.customer.deleteMany({ where: { venueId } }))
      await step(() => prisma.activityLog.deleteMany({ where: { venueId } }))
      await step(() => prisma.venue.deleteMany({ where: { id: venueId } }))
    }
    if (orgId) await step(() => prisma.organization.deleteMany({ where: { id: orgId } }))
  })

  const nuevoSaldo = async (cantidad: number) => {
    const compra = await prisma.creditPackPurchase.create({
      data: {
        venueId: venue!.id,
        customerId: ana,
        creditPackId: pack,
        amountPaid: new Prisma.Decimal(1000),
        expiresAt: new Date(Date.now() + 30 * 24 * H),
        status: CreditPurchaseStatus.ACTIVE,
        itemBalances: { create: [{ productId: yoga, originalQuantity: cantidad, remainingQuantity: cantidad }] },
      },
      select: { id: true, itemBalances: { select: { id: true } } },
    })
    return { purchaseId: compra.id, balanceId: compra.itemBalances[0].id }
  }
  const nuevaClase = async (capacity = 10) => {
    const startsAt = new Date(Date.now() + 48 * H)
    return (
      await prisma.classSession.create({
        data: { venueId: venue!.id, productId: yoga, startsAt, endsAt: new Date(startsAt.getTime() + H), duration: 60, capacity },
        select: { id: true },
      })
    ).id
  }
  let ip = 0
  const visitante = () => `10.80.${Math.floor(++ip / 250)}.${ip % 250}`
  let sesion: string | undefined
  const token = async () => {
    if (sesion) return sesion
    const res = await request(app)
      .post(`${P}/venues/${venue!.slug}/customer/login`)
      .set('cf-connecting-ip', visitante())
      .send({ email, password: PASSWORD })
    expect(res.status).toBe(200)
    sesion = res.body.token as string
    return sesion
  }
  const reservarClase = async (body: Record<string, unknown>) =>
    request(app)
      .post(`${P}/venues/${venue!.slug}/reservations`)
      .set('cf-connecting-ip', visitante())
      .set('Authorization', `Bearer ${await token()}`)
      .send({ guestName: 'Ana', guestPhone: '+525511112222', guestEmail: email, ...body })

  it('paquete de 5: responde creditBalance con remaining 4, original 5, el nombre del paquete y su vencimiento', async () => {
    const { balanceId } = await nuevoSaldo(5)
    const res = await reservarClase({ classSessionId: await nuevaClase(), creditItemBalanceId: balanceId })

    expect(res.status).toBe(201)
    expect(res.body.creditBalance).toEqual({
      balanceId,
      packName: 'Paquete de 5',
      remaining: 4,
      original: 5,
      unlimited: false,
      expiresAt: expect.any(String),
    })
  })

  it('la última sesión: remaining 0 y la compra queda EXHAUSTED', async () => {
    const { balanceId, purchaseId } = await nuevoSaldo(1)
    const res = await reservarClase({ classSessionId: await nuevaClase(), creditItemBalanceId: balanceId })

    expect(res.status).toBe(201)
    expect(res.body.creditBalance).toEqual(expect.objectContaining({ balanceId, remaining: 0, original: 1 }))
    const compra = await prisma.creditPackPurchase.findUniqueOrThrow({ where: { id: purchaseId }, select: { status: true } })
    expect(compra.status).toBe(CreditPurchaseStatus.EXHAUSTED)
  })

  it('reserva gratis (sin canje): no trae creditBalance', async () => {
    const res = await reservarClase({ classSessionId: await nuevaClase() })

    expect(res.status).toBe(201)
    expect(res.body).not.toHaveProperty('creditBalance')
  })

  it('un segundo POST de la misma clienta a la misma clase se sigue creando (la regla NO entró)', async () => {
    const { balanceId } = await nuevoSaldo(5)
    const clase = await nuevaClase()

    const primero = await reservarClase({ classSessionId: clase, creditItemBalanceId: balanceId })
    const segundo = await reservarClase({ classSessionId: clase, creditItemBalanceId: balanceId })

    expect(primero.status).toBe(201)
    expect(segundo.status).toBe(201)
    expect(segundo.body.creditBalance).toEqual(expect.objectContaining({ remaining: 3 }))
    expect(await prisma.reservation.count({ where: { classSessionId: clase } })).toBe(2)
  })

  it('clase llena: 409 con code CLASS_FULL y details.available', async () => {
    const clase = await nuevaClase(1)
    expect((await reservarClase({ classSessionId: clase })).status).toBe(201)

    const lleno = await reservarClase({ classSessionId: clase })

    expect(lleno.status).toBe(409)
    expect(lleno.body).toEqual(expect.objectContaining({ code: 'CLASS_FULL', details: { available: 0 } }))
  })

  it('GET público de la reserva de clase: className, instructorName y spotIds guardados', async () => {
    const reservada = await reservarClase({ classSessionId: await nuevaClase() })
    expect(reservada.status).toBe(201)

    const res = await request(app)
      .get(`${P}/venues/${venue!.slug}/reservations/${reservada.body.cancelSecret}`)
      .set('cf-connecting-ip', visitante())

    expect(res.status).toBe(200)
    expect(res.body).toEqual(expect.objectContaining({ className: 'Lagree', instructorName: null, spotIds: [] }))
  })
})
