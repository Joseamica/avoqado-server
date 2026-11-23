/**
 * Integración (base REAL) — D679, las reglas del paquete «Ilimitado» (caminos C1–C8 del diseño).
 *
 * El pase es PERSONAL: la reserva va a nombre y contacto de la titular aunque el formulario diga otra cosa, cubre 1 lugar por
 * clase, sólo clases que empiezan antes de que venza (también al cambiar de horario), no se le cambia el nombre ni el contacto
 * a la reserva y, mientras esté vigente, ella no cambia su nombre en «Mi cuenta». Sin máximo por día.
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test'
process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'test-access-secret'
process.env.REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'test-refresh-secret'

import '../../__helpers__/integration-setup'

const mockConfirmado = jest.fn(async (..._a: unknown[]) => true)
jest.mock('@/services/email.service', () => ({
  __esModule: true,
  default: new Proxy({}, { get: (_t, p) => (p === 'sendReservationConfirmedEmail' ? mockConfirmado : jest.fn(async () => true)) }),
}))
jest.mock('@/services/whatsapp.service', () => ({
  ...jest.requireActual('@/services/whatsapp.service'),
  sendReservationConfirmationWhatsApp: jest.fn(async () => true),
  sendReservationRescheduleWhatsApp: jest.fn(async () => true),
}))
jest.mock('@/communication/rabbitmq/gcal-push-consumer', () => ({
  __esModule: true,
  publishPushNotification: jest.fn().mockResolvedValue(undefined),
}))

import request from 'supertest'
import bcrypt from 'bcryptjs'
import { formatInTimeZone } from 'date-fns-tz'
import { es } from 'date-fns/locale'
import { Prisma, CreditPurchaseStatus } from '@prisma/client'
import app from '@/app'
import prisma from '@/utils/prismaClient'
import { redeemCreditsForReservation } from '@/services/reservation/creditRedemption.service'
import { redeemCreditsWithCompensation } from '@/controllers/public/reservation.public.controller'
import { createReservationForConsumer } from '@/services/consumer/reservation.consumer.service'
import {
  cancelReservation,
  markNoShow,
  rescheduleAppointmentReservation,
  rescheduleClassReservation,
  rescheduleReservation,
  updateReservation,
} from '@/services/dashboard/reservation.dashboard.service'
import { mintRescheduleAppointmentHold } from '@/services/reservation/appointmentSlotHold.service'
import { checkInByIdentifier } from '@/services/reservation/kioskCheckIn.service'
import { undoNoShow } from '@/services/reservation/undoNoShow.service'
import { updateProfile } from '@/services/public/customerPortal.public.service'
import { getCustomerPurchases, redeemItemManually, refundPurchase } from '@/services/dashboard/creditPack.dashboard.service'

const P = '/api/v1/public'
const RUN = Date.now()
const PASSWORD = 'Secreto123!'
const H = 3_600_000
const D = 24 * H
const TZ = 'America/Mexico_City'
const allDay = Object.fromEntries(
  ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(day => [
    day,
    { enabled: true, ranges: [{ open: '00:00', close: '23:59' }] },
  ]),
)

describe('D679 · reglas del Ilimitado (integración, base real)', () => {
  let orgId: string | undefined
  let venue: { id: string; slug: string } | undefined
  let consumerId: string | undefined
  let staffId: string | undefined
  let staffVenueId: string
  let lagree: string
  let masaje: string
  let pack: string
  const ana = { id: '', email: `ana-ili-${RUN}@test.com`, phone: `+52${String(RUN).slice(-10)}` }
  const carla = { id: '', email: `carla-ili-${RUN}@test.com` }
  let n = 0

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: 'ITEST Reglas Ilimitado', email: `itest-reglas-ili-${RUN}@test.com`, phone: '5550000000' },
    })
    orgId = org.id
    venue = await prisma.venue.create({
      data: {
        name: 'ITEST Reglas Ilimitado',
        slug: `itest-reglas-ili-${RUN}`,
        organizationId: org.id,
        address: 'X',
        city: 'X',
        state: 'X',
        country: 'MX',
        zipCode: '00000',
        timezone: TZ,
        status: 'TRIAL' as any,
        seatCapExempt: true,
      },
      select: { id: true, slug: true },
    })
    await prisma.reservationSettings.create({
      data: {
        venueId: venue.id,
        publicBookingEnabled: true,
        allowCustomerReschedule: true,
        minNoticeMin: 0,
        maxAdvanceDays: 365,
        capacityMode: 'pacing',
        pacingMaxPerSlot: 10,
        minHoursBeforeCancel: null,
        creditNoShowRefund: true,
        googleCalendarPushEnabled: false,
        operatingHours: allDay as Prisma.InputJsonValue,
      },
    })
    const category = await prisma.menuCategory.create({ data: { venueId: venue.id, name: 'Estudio', slug: `estudio-ili-${RUN}` } })
    lagree = (
      await prisma.product.create({
        data: {
          venueId: venue.id,
          sku: `ILI-lagree-${RUN}`,
          name: 'Lagree',
          type: 'CLASS',
          categoryId: category.id,
          price: new Prisma.Decimal(300),
        },
        select: { id: true },
      })
    ).id
    masaje = (
      await prisma.product.create({
        data: {
          venueId: venue.id,
          sku: `ILI-masaje-${RUN}`,
          name: 'Masaje',
          type: 'APPOINTMENTS_SERVICE',
          duration: 60,
          categoryId: category.id,
          price: new Prisma.Decimal(500),
        },
        select: { id: true },
      })
    ).id
    const password = await bcrypt.hash(PASSWORD, 4)
    ana.id = (
      await prisma.customer.create({
        data: { venueId: venue.id, email: ana.email, password, firstName: 'Ana', lastName: 'Titular', phone: ana.phone, active: true },
      })
    ).id
    carla.id = (
      await prisma.customer.create({ data: { venueId: venue.id, email: carla.email, password, firstName: 'Carla', active: true } })
    ).id
    consumerId = (await prisma.consumer.create({ data: { email: ana.email, firstName: 'Ana', phone: ana.phone } })).id
    pack = (
      await prisma.creditPack.create({
        data: {
          venueId: venue.id,
          name: 'Ilimitado',
          price: new Prisma.Decimal(2500),
          validityDays: 30,
          items: { create: [{ productId: lagree, quantity: 99999, unlimited: true }] },
        },
      })
    ).id
    staffId = (
      await prisma.staff.create({ data: { email: `itest-reglas-ili-${RUN}@example.test`, firstName: 'Recepción', lastName: 'Ili' } })
    ).id
    staffVenueId = (await prisma.staffVenue.create({ data: { venueId: venue.id, staffId, role: 'MANAGER' }, select: { id: true } })).id
  })

  afterAll(async () => {
    const step = (fn: () => Promise<unknown>) => fn().catch(() => {})
    if (venue) {
      const venueId = venue.id
      await step(() => prisma.reservationNoShowCorrection.deleteMany({ where: { venueId } }))
      await step(() => prisma.creditTransaction.deleteMany({ where: { venueId } }))
      await step(() => prisma.creditItemBalance.deleteMany({ where: { creditPackPurchase: { venueId } } }))
      await step(() => prisma.creditPackPurchase.deleteMany({ where: { venueId } }))
      await step(() => prisma.creditPackItem.deleteMany({ where: { creditPack: { venueId } } }))
      await step(() => prisma.creditPack.deleteMany({ where: { venueId } }))
      await step(() => prisma.slotHold.deleteMany({ where: { venueId } }))
      await step(() => prisma.calendarSyncOutbox.deleteMany({ where: { venueId } }))
      await step(() => prisma.reservation.deleteMany({ where: { venueId } }))
      await step(() => prisma.classSession.deleteMany({ where: { venueId } }))
      await step(() => prisma.reservationSettings.deleteMany({ where: { venueId } }))
      await step(() => prisma.product.deleteMany({ where: { venueId } }))
      await step(() => prisma.menuCategory.deleteMany({ where: { venueId } }))
      await step(() => prisma.customer.deleteMany({ where: { venueId } }))
      await step(() => prisma.activityLog.deleteMany({ where: { venueId } }))
      await step(() => prisma.notification.deleteMany({ where: { venueId } }))
      await step(() => prisma.staffVenue.deleteMany({ where: { venueId } }))
      await step(() => prisma.venue.deleteMany({ where: { id: venueId } }))
    }
    if (staffId) await step(() => prisma.staff.deleteMany({ where: { id: staffId } }))
    if (consumerId) await step(() => prisma.consumer.deleteMany({ where: { id: consumerId } }))
    if (orgId) await step(() => prisma.organization.deleteMany({ where: { id: orgId } }))
  })

  // ---------- ayudas ----------

  /** Una compra nueva con un solo saldo. Ilimitado por default (99,999 con la marca), vigencia de 30 días. */
  const comprar = async (
    opts: {
      customerId?: string
      productId?: string
      cantidad?: number
      unlimited?: boolean
      vence?: Date | null
      status?: CreditPurchaseStatus
    } = {},
  ) => {
    const unlimited = opts.unlimited ?? true
    const cantidad = opts.cantidad ?? (unlimited ? 99999 : 5)
    const compra = await prisma.creditPackPurchase.create({
      data: {
        venueId: venue!.id,
        customerId: opts.customerId ?? ana.id,
        creditPackId: pack,
        amountPaid: new Prisma.Decimal(2500),
        expiresAt: opts.vence === undefined ? new Date(Date.now() + 30 * D) : opts.vence,
        status: opts.status ?? CreditPurchaseStatus.ACTIVE,
        itemBalances: {
          create: [
            {
              productId: opts.productId ?? lagree,
              originalQuantity: cantidad,
              remainingQuantity: cantidad,
              ...(unlimited ? { unlimited: true } : {}),
            },
          ],
        },
      },
      select: { id: true, expiresAt: true, itemBalances: { select: { id: true } } },
    })
    return { purchaseId: compra.id, balanceId: compra.itemBalances[0].id, expiresAt: compra.expiresAt }
  }
  const clase = async (horas: number) => {
    const startsAt = new Date(Date.now() + horas * H)
    return (
      await prisma.classSession.create({
        data: { venueId: venue!.id, productId: lagree, startsAt, endsAt: new Date(startsAt.getTime() + H), duration: 60, capacity: 10 },
        select: { id: true },
      })
    ).id
  }
  /** Una cita a `horas` de ahora, de Ana, sin canje todavía. */
  const cita = async (horas: number, extra: Partial<Prisma.ReservationUncheckedCreateInput> = {}) => {
    n += 1
    const startsAt = new Date(Date.now() + horas * H)
    startsAt.setUTCMinutes(0, 0, 0)
    const endsAt = new Date(startsAt.getTime() + H)
    return prisma.reservation.create({
      data: {
        venueId: venue!.id,
        confirmationCode: `ILI-${RUN}-${n}`,
        startsAt,
        endsAt,
        blockedEndsAt: endsAt,
        duration: 60,
        status: 'CONFIRMED',
        customerId: ana.id,
        productId: masaje,
        guestName: 'Ana Titular',
        guestPhone: ana.phone,
        guestEmail: ana.email,
        statusLog: [{ status: 'CONFIRMED', at: new Date().toISOString(), by: null }],
        ...extra,
      },
      select: { id: true, confirmationCode: true, startsAt: true },
    })
  }
  const canjear = (reservationId: string, balanceIds: string[], creditsPerBalance = 1, customerId = ana.id) =>
    prisma.$transaction(tx =>
      redeemCreditsForReservation(tx, {
        venueId: venue!.id,
        reservationId,
        confirmationCode: reservationId,
        balanceIds,
        creditsPerBalance,
        customerId,
      }),
    )

  let ip = 0
  const visitante = () => `10.80.${Math.floor(++ip / 250)}.${ip % 250}`
  const sesiones = new Map<string, string>()
  const token = async (email: string) => {
    if (!sesiones.has(email)) {
      const res = await request(app)
        .post(`${P}/venues/${venue!.slug}/customer/login`)
        .set('cf-connecting-ip', visitante())
        .send({ email, password: PASSWORD })
      expect(res.status).toBe(200)
      sesiones.set(email, res.body.token)
    }
    return sesiones.get(email)!
  }
  const reservar = async (body: Record<string, unknown>, email = ana.email) =>
    request(app)
      .post(`${P}/venues/${venue!.slug}/reservations`)
      .set('cf-connecting-ip', visitante())
      .set('Authorization', `Bearer ${await token(email)}`)
      .send({ guestName: 'Ana López', guestPhone: '+525599998888', guestEmail: `otra-${RUN}@test.com`, ...body })
  const reservarCita = async (horas: number, body: Record<string, unknown>, email = ana.email) => {
    const startsAt = new Date(Date.now() + horas * H)
    startsAt.setUTCMinutes(0, 0, 0)
    return reservar(
      {
        productId: masaje,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + H).toISOString(),
        duration: 60,
        ...body,
      },
      email,
    )
  }
  const reserva = (confirmationCode: string) =>
    prisma.reservation.findFirstOrThrow({
      where: { venueId: venue!.id, confirmationCode },
      select: { id: true, status: true, guestName: true, guestPhone: true, guestEmail: true, customerId: true },
    })
  const saldo = async (balanceId: string) =>
    (await prisma.creditItemBalance.findUniqueOrThrow({ where: { id: balanceId }, select: { remainingQuantity: true } })).remainingQuantity
  const venceTexto = (fecha: Date) =>
    `Tu Ilimitado vence el ${formatInTimeZone(fecha, TZ, "d 'de' MMMM", { locale: es })}; esta clase es después.`

  const TITULAR = { guestName: 'Ana Titular', guestEmail: ana.email }

  // ---------- sin máximo por día ----------

  it('dos clases el mismo día pasan (sin máximo)', async () => {
    const { balanceId } = await comprar()
    const a = await reservar({ classSessionId: await clase(48), creditItemBalanceId: balanceId })
    const b = await reservar({ classSessionId: await clase(50), creditItemBalanceId: balanceId })
    expect([a.status, b.status]).toEqual([201, 201])
    expect(await saldo(balanceId)).toBe(99997)
  })

  // ---------- C1–C3: sólo la titular ----------

  describe('la reserva va a nombre y contacto de la titular', () => {
    it('widget · clase: con otro nombre y teléfono en el formulario, la reserva y su correo de confirmación son de la titular', async () => {
      const { balanceId } = await comprar()
      mockConfirmado.mockClear()
      const res = await reservar({ classSessionId: await clase(60), creditItemBalanceId: balanceId })
      expect(res.status).toBe(201)
      expect(await reserva(res.body.confirmationCode)).toMatchObject({ ...TITULAR, guestPhone: ana.phone, customerId: ana.id })
      expect(mockConfirmado).toHaveBeenCalledWith(ana.email, expect.objectContaining({ customerName: 'Ana Titular' }))
    })

    it('widget · cita: igual, y el correo de confirmación sale a la titular', async () => {
      const { balanceId } = await comprar({ productId: masaje })
      mockConfirmado.mockClear()
      const res = await reservarCita(70, { creditItemBalanceId: balanceId })
      expect(res.status).toBe(201)
      expect(await reserva(res.body.confirmationCode)).toMatchObject({ ...TITULAR, guestPhone: ana.phone })
      expect(mockConfirmado).toHaveBeenCalledWith(ana.email, expect.objectContaining({ customerName: 'Ana Titular' }))
    })

    it('app de clientes · clase: igual', async () => {
      const { balanceId } = await comprar()
      const r = await createReservationForConsumer(consumerId!, venue!.slug, {
        classSessionId: await clase(80),
        creditItemBalanceId: balanceId,
        guestName: 'Ana López',
        guestPhone: '+525599998888',
        guestEmail: `otra-${RUN}@test.com`,
      })
      expect(await reserva(r.confirmationCode)).toMatchObject({ ...TITULAR, guestPhone: ana.phone })
    })

    it('titular sin teléfono en su ficha: la reserva queda sin teléfono y el kiosco no la encuentra con el del formulario', async () => {
      const { balanceId } = await comprar({ customerId: carla.id })
      const res = await reservar(
        { classSessionId: await clase(0.15), creditItemBalanceId: balanceId, guestPhone: '+525512340000' },
        carla.email,
      )
      expect(res.status).toBe(201)
      expect(await reserva(res.body.confirmationCode)).toMatchObject({ guestName: 'Carla', guestPhone: null, guestEmail: carla.email })
      await expect(
        checkInByIdentifier({
          venueId: venue!.id,
          terminalId: null,
          stationKey: `ili-${RUN}`,
          identifier: '+525512340000',
          now: new Date(),
        }),
      ).rejects.toMatchObject({ code: 'CHECK_IN_NOT_FOUND' })
    })

    it('con un paquete normal el formulario manda, como hoy (regresión)', async () => {
      const { balanceId } = await comprar({ unlimited: false })
      const res = await reservar({ classSessionId: await clase(90), creditItemBalanceId: balanceId })
      expect(res.status).toBe(201)
      expect(await reserva(res.body.confirmationCode)).toMatchObject({ guestName: 'Ana López', guestPhone: '+525599998888' })
    })
  })

  // ---------- un lugar ----------

  describe('un lugar por clase', () => {
    it('cita de 2 personas con 1 lugar elegido → ONE_SEAT y la cita queda cancelada por la compensación', async () => {
      const { balanceId } = await comprar({ productId: masaje })
      const res = await reservarCita(100, { creditItemBalanceId: balanceId, partySize: 2, spotIds: ['A1'] })
      expect(res.status).toBe(400)
      expect(res.body).toMatchObject({
        code: 'CREDIT_UNLIMITED_ONE_SEAT',
        message: 'Tu Ilimitado es personal: cubre 1 lugar por clase a tu nombre. Los demás lugares se pagan aparte.',
      })
      const canceladas = await prisma.reservation.findMany({
        where: { venueId: venue!.id, cancellationReason: 'CREDIT_REDEEM_FAILED', partySize: 2 },
        select: { status: true },
        take: 5,
      })
      expect(canceladas.map(r => r.status)).toEqual(['CANCELLED'])
      expect(await saldo(balanceId)).toBe(99999)
    })

    it('2 lugares en una clase → ONE_SEAT, sin «Disponibles: 99999»', async () => {
      const { balanceId } = await comprar()
      const res = await reservar({ classSessionId: await clase(110), creditItemBalanceId: balanceId, partySize: 2 })
      expect(res.status).toBe(400)
      expect(res.body.code).toBe('CREDIT_UNLIMITED_ONE_SEAT')
      expect(JSON.stringify(res.body)).not.toContain('99999')
    })

    it('segundo lugar en la misma clase con su Ilimitado → SAME_CLASS', async () => {
      const { balanceId } = await comprar()
      const c = await clase(120)
      expect((await reservar({ classSessionId: c, creditItemBalanceId: balanceId })).status).toBe(201)
      const res = await reservar({ classSessionId: c, creditItemBalanceId: balanceId })
      expect(res.status).toBe(400)
      expect(res.body).toMatchObject({ code: 'CREDIT_UNLIMITED_SAME_CLASS', message: 'Ya tienes un lugar en esta clase con tu Ilimitado.' })
    })

    it('con dos Ilimitados suyos → SAME_CLASS', async () => {
      const uno = await comprar()
      const otro = await comprar()
      const c = await clase(121)
      expect((await reservar({ classSessionId: c, creditItemBalanceId: uno.balanceId })).status).toBe(201)
      expect((await reservar({ classSessionId: c, creditItemBalanceId: otro.balanceId })).body.code).toBe('CREDIT_UNLIMITED_SAME_CLASS')
    })

    it('con una reserva suya en NO_SHOW pagada con su Ilimitado en esa clase → SAME_CLASS', async () => {
      const { balanceId } = await comprar()
      const c = await clase(122)
      const primera = await reservar({ classSessionId: c, creditItemBalanceId: balanceId })
      await prisma.reservation.update({ where: { id: (await reserva(primera.body.confirmationCode)).id }, data: { status: 'NO_SHOW' } })
      expect((await reservar({ classSessionId: c, creditItemBalanceId: balanceId })).body.code).toBe('CREDIT_UNLIMITED_SAME_CLASS')
    })

    it('con un lugar suyo pagado aparte, el Ilimitado sí pasa', async () => {
      const { balanceId } = await comprar()
      const c = await clase(123)
      await cita(0, {
        classSessionId: c,
        productId: lagree,
        startsAt: new Date(Date.now() + 123 * H),
        endsAt: new Date(Date.now() + 124 * H),
      })
      expect((await reservar({ classSessionId: c, creditItemBalanceId: balanceId })).status).toBe(201)
    })
  })

  // ---------- vigencia ----------

  describe('sólo clases antes de que venza', () => {
    it('clase después del vencimiento → AFTER_EXPIRY con la fecha del negocio', async () => {
      const { balanceId, expiresAt } = await comprar({ vence: new Date(Date.now() + 3 * D) })
      const res = await reservar({ classSessionId: await clase(5 * 24), creditItemBalanceId: balanceId })
      expect(res.status).toBe(400)
      expect(res.body).toMatchObject({ code: 'CREDIT_UNLIMITED_AFTER_EXPIRY', message: venceTexto(expiresAt!) })
    })

    it('paquete normal con la misma clase sí pasa (regresión)', async () => {
      const { balanceId } = await comprar({ unlimited: false, vence: new Date(Date.now() + 3 * D) })
      expect((await reservar({ classSessionId: await clase(5 * 24 + 1), creditItemBalanceId: balanceId })).status).toBe(201)
    })
  })

  // ---------- C4/C5: cambiar de horario ----------

  describe('cambiar de horario', () => {
    const conClase = async (horas: number, vence?: Date) => {
      const { balanceId } = await comprar({ vence })
      const res = await reservar({ classSessionId: await clase(horas), creditItemBalanceId: balanceId })
      expect(res.status).toBe(201)
      return (await reserva(res.body.confirmationCode)).id
    }
    const mover = (reservationId: string, newClassSessionId: string, newSpotIds?: string[]) =>
      rescheduleClassReservation({ venueId: venue!.id, reservationId, newClassSessionId, newSpotIds, rescheduledBy: 'CUSTOMER' })

    it('clase: a después del vencimiento → AFTER_EXPIRY', async () => {
      const id = await conClase(24, new Date(Date.now() + 3 * D))
      await expect(mover(id, await clase(5 * 24))).rejects.toMatchObject({ code: 'CREDIT_UNLIMITED_AFTER_EXPIRY' })
    })

    it('clase: a una clase donde ya tiene lugar → SAME_CLASS', async () => {
      const { balanceId } = await comprar()
      const destino = await clase(130)
      expect((await reservar({ classSessionId: destino, creditItemBalanceId: balanceId })).status).toBe(201)
      const id = await conClase(131)
      await expect(mover(id, destino)).rejects.toMatchObject({ code: 'CREDIT_UNLIMITED_SAME_CLASS' })
    })

    it('clase: con 2 lugares elegidos → ONE_SEAT', async () => {
      const id = await conClase(132)
      await expect(mover(id, await clase(133), ['a', 'b'])).rejects.toMatchObject({ code: 'CREDIT_UNLIMITED_ONE_SEAT' })
    })

    it('clase: a otra clase vigente pasa', async () => {
      const id = await conClase(134)
      const destino = await clase(135)
      await expect(mover(id, destino)).resolves.toMatchObject({ classSessionId: destino })
    })

    it('cita con dos pases movida a un día después del vencimiento de UNO → AFTER_EXPIRY (DASHBOARD y widget con holdId)', async () => {
      const corto = await comprar({ productId: masaje, vence: new Date(Date.now() + 4 * D) })
      const largo = await comprar({ productId: masaje })
      const c = await cita(48)
      await canjear(c.id, [corto.balanceId, largo.balanceId])
      const destino = new Date(c.startsAt.getTime() + 4 * D)

      await expect(
        rescheduleReservation(
          venue!.id,
          c.id,
          { startsAt: destino, endsAt: new Date(destino.getTime() + H) },
          { writeOrigin: 'DASHBOARD' },
          staffId!,
        ),
      ).rejects.toMatchObject({ code: 'CREDIT_UNLIMITED_AFTER_EXPIRY' })

      const hold = await mintRescheduleAppointmentHold({ venueId: venue!.id, reservationId: c.id, requestedStartsAt: destino })
      await expect(
        rescheduleAppointmentReservation({
          venueId: venue!.id,
          reservationId: c.id,
          newStartsAt: destino,
          holdId: hold.id,
          rescheduledBy: 'CUSTOMER',
          writeOrigin: 'PUBLIC',
        }),
      ).rejects.toMatchObject({ code: 'CREDIT_UNLIMITED_AFTER_EXPIRY' })
      expect((await prisma.reservation.findUniqueOrThrow({ where: { id: c.id } })).startsAt).toEqual(c.startsAt)
    })

    it('🔴 mover la cita a después del vencimiento mientras su canje está por entrar: nunca queda una cita fuera de vigencia con canje', async () => {
      const pase = await comprar({ productId: masaje, vence: new Date(Date.now() + 5 * D) })
      const c = await cita(72)
      const destino = new Date(c.startsAt.getTime() + 4 * D)

      const { resultados, esperando } = await enCarrera(c.id, [
        () => canjear(c.id, [pase.balanceId]),
        () =>
          updateReservation(
            venue!.id,
            c.id,
            { startsAt: destino, endsAt: new Date(destino.getTime() + H), duration: 60 },
            { writeOrigin: 'DASHBOARD' },
            staffId!,
          ),
      ])
      expect(esperando).toBe(2)
      const fallidas = resultados.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      expect(fallidas).toHaveLength(1)
      expect(fallidas[0].reason).toMatchObject({ code: 'CREDIT_UNLIMITED_AFTER_EXPIRY' })

      const final = await prisma.reservation.findUniqueOrThrow({ where: { id: c.id }, select: { startsAt: true } })
      const conCanje = (await prisma.creditTransaction.count({ where: { reservationId: c.id, type: 'REDEEM' } })) > 0
      expect(conCanje && final.startsAt >= pase.expiresAt!).toBe(false)
    })
  })

  // ---------- la reserva tiene que estar viva ----------

  describe('canjear sobre una reserva que ya no está viva', () => {
    const canjearConCompensacion = (reservationId: string, confirmationCode: string, balanceId: string) =>
      redeemCreditsWithCompensation({
        venueId: venue!.id,
        reservationId,
        confirmationCode,
        balanceIds: [balanceId],
        creditsPerBalance: 1,
        customerId: ana.id,
      })

    it('Ilimitado sobre una cita cancelada: CREDIT_RESERVATION_NOT_ALIVE, el saldo no baja y no hay MoneyAnomaly', async () => {
      const { balanceId } = await comprar({ productId: masaje })
      const c = await cita(150, { status: 'CANCELLED' })
      await expect(canjearConCompensacion(c.id, c.confirmationCode, balanceId)).rejects.toMatchObject({
        code: 'CREDIT_RESERVATION_NOT_ALIVE',
        message: 'La reserva ya no está activa.',
      })
      expect(await saldo(balanceId)).toBe(99999)
      expect(await prisma.moneyAnomaly.count({ where: { reservationId: c.id } })).toBe(0)
    })

    // Codex código r1 #6: recepción registra la llegada entre el alta de la cita y el canje. El pase sí se cobra.
    it('Ilimitado sobre una cita que ya llegó (CHECKED_IN): se canjea', async () => {
      const { balanceId } = await comprar({ productId: masaje })
      const c = await cita(151, { status: 'CHECKED_IN' })
      await expect(canjearConCompensacion(c.id, c.confirmationCode, balanceId)).resolves.toEqual({ creditsUsed: 1, redeemed: true })
      expect(await saldo(balanceId)).toBe(99998)
    })

    // Decisión: un paquete normal cobra EXACTAMENTE como en develop, también sobre una cita que ya llegó o se canceló.
    it.each(['CHECKED_IN', 'CANCELLED'] as const)('paquete normal sobre una cita %s: cobra como en develop', async status => {
      const { balanceId } = await comprar({ productId: masaje, unlimited: false })
      const c = await cita(152, { status })
      await expect(canjearConCompensacion(c.id, c.confirmationCode, balanceId)).resolves.toEqual({ creditsUsed: 1, redeemed: true })
      expect(await saldo(balanceId)).toBe(4)
    })
  })

  // ---------- Codex código r1: #1, #2, #4, #5, #7 ----------

  describe('Codex código r1', () => {
    it('#1 · con creditItemBalanceIds vacío y el Ilimitado en creditItemBalanceId, la clase queda a nombre de la titular', async () => {
      const { balanceId } = await comprar()
      const res = await reservar({ classSessionId: await clase(300), creditItemBalanceId: balanceId, creditItemBalanceIds: [] })
      expect(res.status).toBe(201)
      expect(await reserva(res.body.confirmationCode)).toMatchObject({ ...TITULAR, guestPhone: ana.phone })
      expect(await saldo(balanceId)).toBe(99998)
    })

    it('#2 · si recepción cambió el contacto de la cita antes del canje, el canje la deja otra vez a nombre de la titular', async () => {
      const { balanceId } = await comprar({ productId: masaje })
      const c = await cita(301, { guestName: 'Ana López', guestPhone: '+525599998888', guestEmail: `otra-${RUN}@test.com` })
      await canjear(c.id, [balanceId])
      expect(await reserva(c.confirmationCode)).toMatchObject({ ...TITULAR, guestPhone: ana.phone })
    })

    it('#4 · con una reserva suya COMPLETADA en esa clase, pagada con su Ilimitado → SAME_CLASS', async () => {
      const { balanceId } = await comprar()
      const c = await clase(302)
      const primera = await reservar({ classSessionId: c, creditItemBalanceId: balanceId })
      await prisma.reservation.update({ where: { id: (await reserva(primera.body.confirmationCode)).id }, data: { status: 'COMPLETED' } })
      expect((await reservar({ classSessionId: c, creditItemBalanceId: balanceId })).body.code).toBe('CREDIT_UNLIMITED_SAME_CLASS')
    })

    it('#5 · cambiar el nombre mientras se le acredita su primer Ilimitado: el cambio espera y lo rechaza', async () => {
      const gina = await prisma.customer.create({ data: { venueId: venue!.id, firstName: 'Gina', email: `gina-${RUN}@test.com` } })
      const { resultados, esperando } = await enCarrera('', [() => updateProfile(venue!.id, gina.id, { firstName: 'Otra' })], {
        candado: tx => tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${gina.id} FOR UPDATE`,
        // La venta se acredita mientras el cambio espera (misma fila de la clienta que toca la entrega).
        antesDeSoltar: tx =>
          tx.creditPackPurchase.create({
            data: {
              venueId: venue!.id,
              customerId: gina.id,
              creditPackId: pack,
              amountPaid: new Prisma.Decimal(2500),
              expiresAt: new Date(Date.now() + 30 * D),
              itemBalances: { create: [{ productId: lagree, originalQuantity: 99999, remainingQuantity: 99999, unlimited: true }] },
            },
          }),
      })
      expect(esperando).toBe(1)
      expect(resultados[0]).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ code: 'CREDIT_UNLIMITED_NAME_LOCKED' }) })
      expect((await prisma.customer.findUniqueOrThrow({ where: { id: gina.id } })).firstName).toBe('Gina')
    })

    it('#7 · cancelar después de reembolsar la compra del pase: no devuelve nada y la vista previa lo dice', async () => {
      await prisma.reservationSettings.update({ where: { venueId: venue!.id }, data: { creditRefundMode: 'NEVER' } })
      try {
        const { balanceId, purchaseId } = await comprar({ productId: masaje })
        const c = await cita(303)
        await canjear(c.id, [balanceId])
        await refundPurchase(venue!.id, purchaseId, staffVenueId, 'reembolso')
        const { cancelSecret } = await prisma.reservation.findUniqueOrThrow({ where: { id: c.id }, select: { cancelSecret: true } })
        const previa = await request(app)
          .get(`${P}/venues/${venue!.slug}/reservations/${cancelSecret}`)
          .set('cf-connecting-ip', visitante())
        expect(previa.body.cancellation).toMatchObject({ creditsUsed: 1, creditsRefundable: 0 })
        const cancelada = await cancelReservation(venue!.id, c.id, 'CUSTOMER')
        expect(cancelada).toMatchObject({ creditsRefunded: 0 })
        expect(await prisma.creditTransaction.count({ where: { reservationId: c.id, type: 'REFUND' } })).toBe(0)
        expect(await saldo(balanceId)).toBe(0)
      } finally {
        await prisma.reservationSettings.update({ where: { venueId: venue!.id }, data: { creditRefundMode: 'TIME_BASED' } })
      }
    })
  })

  // ---------- C6: editar la reserva ----------

  describe('editar una reserva pagada con Ilimitado', () => {
    const conPase = async () => {
      const pase = await comprar({ productId: masaje })
      const c = await cita(160 + n)
      await canjear(c.id, [pase.balanceId])
      return c.id
    }

    it.each([
      ['DASHBOARD', { guestName: 'Ana López' }],
      ['DASHBOARD', { guestPhone: '+525599998888' }],
      ['MCP', { guestEmail: 'otra@test.com' }],
    ] as const)('%s · cambiar %j → TITULAR', async (writeOrigin, data) => {
      const id = await conPase()
      await expect(updateReservation(venue!.id, id, data, { writeOrigin }, staffId!)).rejects.toMatchObject({
        code: 'CREDIT_UNLIMITED_TITULAR',
        message: 'Esta reserva se pagó con un Ilimitado y va a nombre de su titular: no se le puede cambiar el nombre ni el contacto.',
      })
    })

    it('subirle personas → ONE_SEAT', async () => {
      const id = await conPase()
      await expect(updateReservation(venue!.id, id, { partySize: 2 }, { writeOrigin: 'DASHBOARD' }, staffId!)).rejects.toMatchObject({
        code: 'CREDIT_UNLIMITED_ONE_SEAT',
      })
    })

    it('editar las notas pasa, y reenviar el mismo nombre también', async () => {
      const id = await conPase()
      await expect(
        updateReservation(
          venue!.id,
          id,
          { specialRequests: 'Llega tarde', guestName: 'Ana Titular' },
          { writeOrigin: 'DASHBOARD' },
          staffId!,
        ),
      ).resolves.toMatchObject({ specialRequests: 'Llega tarde' })
    })

    it('editar el nombre de una reserva con paquete normal pasa (regresión)', async () => {
      const normal = await comprar({ productId: masaje, unlimited: false })
      const c = await cita(190)
      await canjear(c.id, [normal.balanceId])
      await expect(
        updateReservation(venue!.id, c.id, { guestName: 'Otra' }, { writeOrigin: 'DASHBOARD' }, staffId!),
      ).resolves.toMatchObject({
        guestName: 'Otra',
      })
    })
  })

  // ---------- C7: «Mi cuenta» ----------

  describe('cambiar su nombre en «Mi cuenta»', () => {
    it('con un Ilimitado vigente → NAME_LOCKED; reenviar el mismo nombre sí pasa', async () => {
      await comprar()
      await expect(updateProfile(venue!.id, ana.id, { firstName: 'Anita' })).rejects.toMatchObject({
        code: 'CREDIT_UNLIMITED_NAME_LOCKED',
        message: 'Tu nombre está ligado a tu Ilimitado. Para corregirlo, pídeselo al estudio.',
      })
      await expect(updateProfile(venue!.id, ana.id, { firstName: 'Ana', lastName: 'Titular' })).resolves.toBeTruthy()
    })

    it('cambiar sólo el teléfono sigue la regla de hoy', async () => {
      await expect(updateProfile(venue!.id, ana.id, { phone: '+525500001111' })).rejects.toMatchObject({
        code: 'CUSTOMER_PHONE_CHANGE_NOT_ALLOWED',
      })
    })

    it('con el Ilimitado vencido o reembolsado pasa', async () => {
      const otra = await prisma.customer.create({ data: { venueId: venue!.id, firstName: 'Dora', email: `dora-${RUN}@test.com` } })
      await comprar({ customerId: otra.id, vence: new Date(Date.now() - H) })
      await comprar({ customerId: otra.id, status: CreditPurchaseStatus.REFUNDED })
      await expect(updateProfile(venue!.id, otra.id, { firstName: 'Doris' })).resolves.toMatchObject({ customer: { firstName: 'Doris' } })
    })
  })

  // ---------- correcciones (regresión) ----------

  describe('correcciones de una persona no se rechazan', () => {
    it('canje a mano en un Ilimitado descuenta 1 a nombre de la titular', async () => {
      const { balanceId } = await comprar()
      await redeemItemManually(venue!.id, balanceId, staffVenueId, 'shake')
      expect(await saldo(balanceId)).toBe(99998)
      expect(await prisma.creditTransaction.findFirst({ where: { creditItemBalanceId: balanceId, type: 'REDEEM' } })).toMatchObject({
        customerId: ana.id,
        quantity: -1,
      })
    })

    it('«No asistió» devuelve y «Sí llegó» vuelve a descontar', async () => {
      const { balanceId } = await comprar()
      const c = await cita(-1, { productId: lagree })
      await canjear(c.id, [balanceId])
      expect(await saldo(balanceId)).toBe(99998)
      await markNoShow(venue!.id, c.id, staffId!)
      expect(await saldo(balanceId)).toBe(99999)
      await prisma.$transaction(
        tx =>
          undoNoShow(tx, {
            reservationId: c.id,
            venueId: venue!.id,
            actor: { type: 'HUMAN', staffId: staffId! },
            source: 'DASHBOARD',
            now: new Date(),
          }),
        { timeout: 30_000 },
      )
      expect(await saldo(balanceId)).toBe(99998)
    })
  })

  // ---------- Task 4: cancelar sin castigo, vista previa y faltas ----------

  describe('cancelar no castiga y las faltas sólo se cuentan', () => {
    const politica = (creditRefundMode: 'NEVER' | 'TIME_BASED' | 'ALWAYS', extra: Record<string, unknown> = {}) =>
      prisma.reservationSettings.update({
        where: { venueId: venue!.id },
        data: { creditRefundMode, creditFreeRefundHoursBefore: 24, creditLateRefundPercent: 0, ...extra } as any,
      })
    afterAll(() => politica('TIME_BASED', { creditNoShowRefund: true }))
    const devoluciones = (reservationId: string) =>
      prisma.creditTransaction.findMany({
        where: { reservationId, type: 'REFUND' },
        select: { quantity: true, reason: true, creditItemBalanceId: true },
        take: 10,
      })
    const cancelar = (reservationId: string) => cancelReservation(venue!.id, reservationId, 'CUSTOMER')
    const vistaPrevia = async (reservationId: string) => {
      const { cancelSecret } = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId }, select: { cancelSecret: true } })
      const res = await request(app).get(`${P}/venues/${venue!.slug}/reservations/${cancelSecret}`).set('cf-connecting-ip', visitante())
      expect(res.status).toBe(200)
      return res.body.cancellation
    }
    /** Una compra con dos renglones Ilimitados (Lagree y Masaje), de una clienta aparte para contar sus faltas. */
    const ilimitadoDoble = async (customerId: string) =>
      prisma.creditPackPurchase.create({
        data: {
          venueId: venue!.id,
          customerId,
          creditPackId: pack,
          amountPaid: new Prisma.Decimal(2500),
          expiresAt: new Date(Date.now() + 30 * D),
          itemBalances: {
            create: [
              { productId: lagree, originalQuantity: 99999, remainingQuantity: 99999, unlimited: true },
              { productId: masaje, originalQuantity: 99999, remainingQuantity: 99999, unlimited: true },
            ],
          },
        },
        select: { id: true, itemBalances: { select: { id: true } } },
      })
    const faltasDe = async (customerId: string, purchaseId: string) => {
      const r = await getCustomerPurchases(venue!.id, { customerId })
      return (r.purchases.find(p => p.id === purchaseId) as any)?.faltas
    }

    it('TIME_BASED, cancelar dentro de la ventana con Ilimitado: REFUND +1 con la marca de cancelación tardía', async () => {
      await politica('TIME_BASED')
      const { balanceId } = await comprar({ productId: masaje })
      const c = await cita(3)
      await canjear(c.id, [balanceId])
      await cancelar(c.id)
      expect(await devoluciones(c.id)).toEqual([
        expect.objectContaining({ quantity: 1, reason: expect.stringMatching(/· ilimitado: cancelación tardía$/) }),
      ])
      expect(await saldo(balanceId)).toBe(99999)
    })

    it('NEVER, cancelar con días: REFUND +1 sin la marca', async () => {
      await politica('NEVER')
      const { balanceId } = await comprar({ productId: masaje })
      const c = await cita(200)
      await canjear(c.id, [balanceId])
      await cancelar(c.id)
      const [r] = await devoluciones(c.id)
      expect(r.quantity).toBe(1)
      expect(r.reason).not.toContain('ilimitado')
    })

    it('paquete normal con NEVER: no regresa nada (regresión)', async () => {
      await politica('NEVER')
      const { balanceId } = await comprar({ productId: masaje, unlimited: false })
      const c = await cita(201)
      await canjear(c.id, [balanceId])
      await cancelar(c.id)
      expect(await devoluciones(c.id)).toEqual([])
      expect(await saldo(balanceId)).toBe(4)
    })

    it('cita con un Ilimitado y un crédito normal, NEVER: la vista previa dice 1 de 2 sin unlimited y regresa sólo el Ilimitado', async () => {
      await politica('NEVER')
      const ili = await comprar({ productId: masaje })
      const normal = await comprar({ productId: masaje, unlimited: false })
      const c = await cita(202)
      await canjear(c.id, [ili.balanceId, normal.balanceId])
      const previa = await vistaPrevia(c.id)
      expect(previa).toMatchObject({ creditsUsed: 2, creditsRefundable: 1 })
      expect(previa.unlimited).toBeFalsy()
      await cancelar(c.id)
      expect(await devoluciones(c.id)).toEqual([expect.objectContaining({ creditItemBalanceId: ili.balanceId, quantity: 1 })])
    })

    it('reserva sólo Ilimitada con NEVER: creditsRefundable = creditsUsed y unlimited true', async () => {
      await politica('NEVER')
      const { balanceId } = await comprar({ productId: masaje })
      const c = await cita(203)
      await canjear(c.id, [balanceId])
      expect(await vistaPrevia(c.id)).toMatchObject({ creditsUsed: 1, creditsRefundable: 1, unlimited: true })
    })

    it('cita de dos servicios del mismo Ilimitado cancelada en la ventana: faltas.cancelTarde = 1', async () => {
      await politica('TIME_BASED')
      const eva = await prisma.customer.create({ data: { venueId: venue!.id, firstName: 'Eva' } })
      const compra = await ilimitadoDoble(eva.id)
      const c = await cita(4, { customerId: eva.id })
      await canjear(
        c.id,
        compra.itemBalances.map(b => b.id),
        1,
        eva.id,
      )
      await cancelar(c.id)
      expect(await faltasDe(eva.id, compra.id)).toEqual({ noLlego: 0, cancelTarde: 1 })
    })

    it('«No asistió» sin devolución: faltas.noLlego = 1, y «Sí llegó» lo quita', async () => {
      await politica('TIME_BASED', { creditNoShowRefund: false })
      const fer = await prisma.customer.create({ data: { venueId: venue!.id, firstName: 'Fer' } })
      const compra = await ilimitadoDoble(fer.id)
      const c = await cita(-1, { customerId: fer.id, productId: lagree })
      await canjear(c.id, [compra.itemBalances[0].id], 1, fer.id)
      await markNoShow(venue!.id, c.id, staffId!)
      expect(await faltasDe(fer.id, compra.id)).toEqual({ noLlego: 1, cancelTarde: 0 })
      await prisma.$transaction(
        tx =>
          undoNoShow(tx, {
            reservationId: c.id,
            venueId: venue!.id,
            actor: { type: 'HUMAN', staffId: staffId! },
            source: 'DASHBOARD',
            now: new Date(),
          }),
        { timeout: 30_000 },
      )
      expect(await faltasDe(fer.id, compra.id)).toEqual({ noLlego: 0, cancelTarde: 0 })
    })
  })

  /**
   * Corre `pasos` EN ORDEN mientras otra transacción tiene la fila de la reserva: arranca uno, espera a que ya esté bloqueado,
   * arranca el siguiente; cuando todos esperan, suelta. Misma técnica que tests/integration/reservations/undo-no-show.test.ts.
   */
  async function enCarrera(
    reservationId: string,
    pasos: Array<() => Promise<unknown>>,
    opts: {
      candado?: (tx: Prisma.TransactionClient) => Promise<unknown>
      antesDeSoltar?: (tx: Prisma.TransactionClient) => Promise<unknown>
    } = {},
  ) {
    let enCurso: Promise<PromiseSettledResult<unknown>>[] = []
    let esperando = 0
    await prisma.$transaction(
      async tx => {
        if (opts.candado) await opts.candado(tx)
        else await tx.$queryRaw`SELECT id FROM "Reservation" WHERE id = ${reservationId} FOR UPDATE`
        const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
        const bloqueadas = async () => {
          await tx.$executeRaw`SELECT pg_stat_clear_snapshot()`
          const [{ total }] = await tx.$queryRaw<{ total: number }[]>`
            WITH RECURSIVE bloqueadas(pid) AS (
              SELECT a.pid FROM pg_stat_activity a WHERE ${pid}::int = ANY(pg_blocking_pids(a.pid))
              UNION
              SELECT a.pid FROM pg_stat_activity a JOIN bloqueadas b ON b.pid = ANY(pg_blocking_pids(a.pid))
            )
            SELECT count(*)::int AS total FROM bloqueadas`
          return total
        }
        for (const paso of pasos) {
          enCurso = [...enCurso, Promise.allSettled([paso()]).then(([r]) => r)]
          const limite = Date.now() + 10_000
          while ((esperando = await bloqueadas()) < enCurso.length && Date.now() < limite) await new Promise(r => setTimeout(r, 25))
        }
        if (opts.antesDeSoltar) await opts.antesDeSoltar(tx)
      },
      { timeout: 40_000 },
    )
    return { resultados: await Promise.all(enCurso), esperando }
  }
})
