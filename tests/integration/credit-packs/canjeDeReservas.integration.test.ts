/**
 * Integración (base REAL) — el canje de créditos de una reserva, en sus tres caminos (D679, Task 1).
 *
 * Pruebas de CARACTERIZACIÓN: describen lo que hace hoy cada camino (clase del widget, cita del widget y clase de la app de
 * clientes), con sus textos exactos. Se escribieron contra el código de antes de juntar las tres copias en una sola función, y
 * tienen que seguir pasando después: juntarlas no cambia nada de lo que ve la clienta.
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
import { redeemCreditsForReservation } from '@/controllers/public/reservation.public.controller'
import { createReservationForConsumer } from '@/services/consumer/reservation.consumer.service'

const P = '/api/v1/public'
const RUN = Date.now()
const PASSWORD = 'Secreto123!'
const H = 3_600_000

describe('D679 · el canje de una reserva con créditos (caracterización, base real)', () => {
  let orgId: string | undefined
  let venue: { id: string; slug: string } | undefined
  let consumerId: string | undefined
  let yoga: string
  let pilates: string
  let masaje: string
  let pack: string
  let ana: string
  const email = `ana-canje-${RUN}@test.com`
  let n = 0

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: 'ITEST Canje Org', email: `itest-canje-${RUN}@test.com`, phone: '5550000000' },
    })
    orgId = org.id
    venue = await prisma.venue.create({
      data: {
        name: 'ITEST Canje',
        slug: `itest-canje-${RUN}`,
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
    const category = await prisma.menuCategory.create({ data: { venueId: venue.id, name: 'Clases', slug: `clases-canje-${RUN}` } })
    const producto = (name: string, type: 'CLASS' | 'APPOINTMENTS_SERVICE') =>
      prisma.product.create({
        data: { venueId: venue!.id, sku: `CANJE-${name}-${RUN}`, name, type, categoryId: category.id, price: new Prisma.Decimal(200) },
        select: { id: true },
      })
    yoga = (await producto('Yoga', 'CLASS')).id
    pilates = (await producto('Pilates', 'CLASS')).id
    masaje = (await producto('Masaje', 'APPOINTMENTS_SERVICE')).id
    const cliente = await prisma.customer.create({
      data: { venueId: venue.id, email, password: await bcrypt.hash(PASSWORD, 4), firstName: 'Ana', active: true },
    })
    ana = cliente.id
    pack = (await prisma.creditPack.create({ data: { venueId: venue.id, name: 'Pack', price: new Prisma.Decimal(1000) } })).id
    // Con teléfono: el negocio pide teléfono para reservar (default) y la app de clientes lo toma de la cuenta.
    consumerId = (await prisma.consumer.create({ data: { email, firstName: 'Ana', phone: `+52${String(RUN).slice(-10)}` } })).id
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
    if (consumerId) await step(() => prisma.consumer.deleteMany({ where: { id: consumerId } }))
    if (orgId) await step(() => prisma.organization.deleteMany({ where: { id: orgId } }))
  })

  /** Una compra nueva de Ana con un solo saldo. */
  const nuevoSaldo = async (
    cantidad: number,
    opts: { productId?: string; expiresAt?: Date | null; status?: CreditPurchaseStatus } = {},
  ) => {
    const compra = await prisma.creditPackPurchase.create({
      data: {
        venueId: venue!.id,
        customerId: ana,
        creditPackId: pack,
        amountPaid: new Prisma.Decimal(1000),
        expiresAt: opts.expiresAt === undefined ? new Date(Date.now() + 30 * 24 * H) : opts.expiresAt,
        status: opts.status ?? CreditPurchaseStatus.ACTIVE,
        itemBalances: { create: [{ productId: opts.productId ?? yoga, originalQuantity: cantidad, remainingQuantity: cantidad }] },
      },
      select: { id: true, itemBalances: { select: { id: true } } },
    })
    return { purchaseId: compra.id, balanceId: compra.itemBalances[0].id }
  }
  const nuevaClase = async (horas = 48, productId = yoga) => {
    const startsAt = new Date(Date.now() + horas * H)
    return (
      await prisma.classSession.create({
        data: { venueId: venue!.id, productId, startsAt, endsAt: new Date(startsAt.getTime() + H), duration: 60, capacity: 10 },
        select: { id: true },
      })
    ).id
  }
  const nuevaCita = async () => {
    n += 1
    const startsAt = new Date(Date.now() + 72 * H)
    const endsAt = new Date(startsAt.getTime() + H)
    return prisma.reservation.create({
      data: {
        venueId: venue!.id,
        confirmationCode: `CANJE-${RUN}-${n}`,
        startsAt,
        endsAt,
        blockedEndsAt: endsAt,
        duration: 60,
        status: 'CONFIRMED',
        customerId: ana,
        productId: masaje,
        statusLog: [{ status: 'CONFIRMED', at: new Date().toISOString(), by: null }],
      },
      select: { id: true, confirmationCode: true },
    })
  }
  // Cada petición, otro visitante: los topes públicos (5 reservas y 10 entradas por minuto) son por IP real.
  let ip = 0
  const visitante = () => `10.79.${Math.floor(++ip / 250)}.${ip % 250}`
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
  const saldo = async (balanceId: string) =>
    (await prisma.creditItemBalance.findUniqueOrThrow({ where: { id: balanceId }, select: { remainingQuantity: true } })).remainingQuantity
  const canjes = (balanceId: string) =>
    prisma.creditTransaction.findMany({ where: { creditItemBalanceId: balanceId, type: 'REDEEM' }, take: 10 })
  const reservasDe = (classSessionId: string) => prisma.reservation.count({ where: { classSessionId } })
  const citaConCanje = (args: Omit<Parameters<typeof redeemCreditsForReservation>[1], 'venueId'>) =>
    prisma.$transaction(tx => redeemCreditsForReservation(tx, { venueId: venue!.id, ...args }))

  describe('clase del widget', () => {
    it('saldo 5→4 y un REDEEM -1 con reason null', async () => {
      const { balanceId } = await nuevoSaldo(5)
      const res = await reservarClase({ classSessionId: await nuevaClase(), creditItemBalanceId: balanceId })
      expect(res.status).toBe(201)
      expect(res.body).toEqual(expect.objectContaining({ creditRedeemed: true, creditsUsed: 1 }))
      expect(await saldo(balanceId)).toBe(4)
      const r = await canjes(balanceId)
      expect(r).toHaveLength(1)
      expect(r[0]).toEqual(expect.objectContaining({ quantity: -1, reason: null, customerId: ana }))
      expect(r[0].reservationId).toEqual(expect.any(String))
    })

    it('con 2 lugares: REDEEM -2 y reason «Reserva de 2 lugares»', async () => {
      const { balanceId } = await nuevoSaldo(5)
      const res = await reservarClase({ classSessionId: await nuevaClase(), creditItemBalanceId: balanceId, partySize: 2 })
      expect(res.status).toBe(201)
      expect(res.body.creditsUsed).toBe(2)
      expect(await saldo(balanceId)).toBe(3)
      const [r] = await canjes(balanceId)
      expect(r).toEqual(expect.objectContaining({ quantity: -2, reason: 'Reserva de 2 lugares' }))
    })

    it('sin saldo suficiente: 400 con el texto de la clase y la reserva no queda', async () => {
      const { balanceId } = await nuevoSaldo(1)
      const clase = await nuevaClase()
      const res = await reservarClase({ classSessionId: clase, creditItemBalanceId: balanceId, partySize: 2 })
      expect(res.status).toBe(400)
      expect(res.body.message).toBe('No tienes suficientes creditos. Disponibles: 1, necesarios: 2. Compra mas creditos para continuar.')
      expect(await reservasDe(clase)).toBe(0)
      expect(await saldo(balanceId)).toBe(1)
    })

    it('con saldo de otro producto: el texto de la clase', async () => {
      const { balanceId } = await nuevoSaldo(5, { productId: pilates })
      const res = await reservarClase({ classSessionId: await nuevaClase(), creditItemBalanceId: balanceId })
      expect(res.status).toBe(400)
      expect(res.body.message).toBe('El credito no corresponde al producto de esta clase')
    })

    it('compra vencida → «Los creditos han expirado»', async () => {
      const { balanceId } = await nuevoSaldo(5, { expiresAt: new Date(Date.now() - H) })
      const res = await reservarClase({ classSessionId: await nuevaClase(), creditItemBalanceId: balanceId })
      expect(res.status).toBe(400)
      expect(res.body.message).toBe('Los creditos han expirado')
    })

    it('compra no ACTIVE → «Los creditos ya no estan activos»', async () => {
      const { balanceId } = await nuevoSaldo(5, { status: CreditPurchaseStatus.REFUNDED })
      const res = await reservarClase({ classSessionId: await nuevaClase(), creditItemBalanceId: balanceId })
      expect(res.status).toBe(400)
      expect(res.body.message).toBe('Los creditos ya no estan activos')
    })

    it('último crédito: la compra pasa a EXHAUSTED', async () => {
      const { balanceId, purchaseId } = await nuevoSaldo(1)
      const res = await reservarClase({ classSessionId: await nuevaClase(), creditItemBalanceId: balanceId })
      expect(res.status).toBe(201)
      expect(await saldo(balanceId)).toBe(0)
      expect((await prisma.creditPackPurchase.findUniqueOrThrow({ where: { id: purchaseId } })).status).toBe(CreditPurchaseStatus.EXHAUSTED)
    })
  })

  describe('cita (canje en su propia transacción)', () => {
    it('saldo de otro producto, sin saldo y no alcanza: los textos de la cita', async () => {
      const otro = await nuevoSaldo(5, { productId: yoga })
      const cita = await nuevaCita()
      await expect(
        citaConCanje({
          reservationId: cita.id,
          confirmationCode: cita.confirmationCode,
          balanceIds: [otro.balanceId],
          creditsPerBalance: 1,
          customerId: ana,
          expectedProductIds: [masaje],
        }),
      ).rejects.toThrow('El credito no corresponde a los servicios reservados')

      await expect(
        citaConCanje({
          reservationId: cita.id,
          confirmationCode: cita.confirmationCode,
          balanceIds: ['no-existe'],
          creditsPerBalance: 1,
          customerId: ana,
        }),
      ).rejects.toThrow('Balance de credito no encontrado: no-existe')

      const poco = await nuevoSaldo(1, { productId: masaje })
      await expect(
        citaConCanje({
          reservationId: cita.id,
          confirmationCode: cita.confirmationCode,
          balanceIds: [poco.balanceId],
          creditsPerBalance: 2,
          customerId: ana,
          expectedProductIds: [masaje],
        }),
      ).rejects.toThrow(/^No tienes suficientes creditos\. Disponibles: 1, necesarios: 2\.$/)
      expect(await saldo(poco.balanceId)).toBe(1)
    })

    it('2 créditos: saldo 5→3 y reason «Reserva de 2 creditos»', async () => {
      const { balanceId } = await nuevoSaldo(5, { productId: masaje })
      const cita = await nuevaCita()
      const r = await citaConCanje({
        reservationId: cita.id,
        confirmationCode: cita.confirmationCode,
        balanceIds: [balanceId],
        creditsPerBalance: 2,
        customerId: ana,
        expectedProductIds: [masaje],
      })
      expect(r).toEqual({ creditsUsed: 2, redeemed: true })
      expect(await saldo(balanceId)).toBe(3)
      const [t] = await canjes(balanceId)
      expect(t).toEqual(expect.objectContaining({ quantity: -2, reason: 'Reserva de 2 creditos', reservationId: cita.id }))
    })
  })

  describe('clase de la app de clientes', () => {
    it('saldo 5→4', async () => {
      const { balanceId } = await nuevoSaldo(5)
      const r = await createReservationForConsumer(consumerId!, venue!.slug, {
        classSessionId: await nuevaClase(),
        creditItemBalanceId: balanceId,
      })
      expect(r).toEqual(expect.objectContaining({ creditRedeemed: true, creditsUsed: 1 }))
      expect(await saldo(balanceId)).toBe(4)
      const [t] = await canjes(balanceId)
      expect(t).toEqual(expect.objectContaining({ quantity: -1, reason: null, customerId: ana }))
    })

    it('con 2 lugares y saldo 1: el texto de la clase de «no alcanza»', async () => {
      const { balanceId } = await nuevoSaldo(1)
      const clase = await nuevaClase()
      await expect(
        createReservationForConsumer(consumerId!, venue!.slug, { classSessionId: clase, creditItemBalanceId: balanceId, partySize: 2 }),
      ).rejects.toThrow('No tienes suficientes creditos. Disponibles: 1, necesarios: 2. Compra mas creditos para continuar.')
      expect(await reservasDe(clase)).toBe(0)
    })
  })
})
