/**
 * Integración (base REAL desechable) — qué le regresa a la clienta cuando se cancela su lugar en una clase.
 *
 * D10: quitarla de la lista ES cancelar su reserva. Antes `removeAttendee` escribía CANCELLED por su cuenta: la clase del
 * paquete no regresaba, el depósito se quedaba como estaba y dos DELETE a la vez pasaban los dos.
 * D13: la devolución va en la misma transacción que la cancelación: si falla, nada cambia y se puede reintentar.
 * D14: si el negocio cancela la clase entera, cada quien recupera lo suyo aunque la política diga otra cosa.
 */
jest.mock('@/communication/rabbitmq/gcal-push-consumer', () => ({
  __esModule: true,
  publishPushNotification: jest.fn().mockResolvedValue(undefined),
}))

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import * as creditPackService from '@/services/dashboard/creditPack.public.service'
import { redeemForReservation } from '@/services/dashboard/creditPack.public.service'
import { cancelClassSession, removeAttendee } from '@/services/dashboard/classSession.dashboard.service'
import { cancelReservation } from '@/services/dashboard/reservation.dashboard.service'

const RUN = Date.now()
const H = 3_600_000

describe('D10, D13 y D14 · lo que regresa al cancelar un lugar en una clase (integración, base real)', () => {
  let orgId: string | undefined
  let venueId: string | undefined
  let staffId: string | undefined
  let clienta: { id: string }
  let yoga: { id: string }
  let pack: { id: string }
  let n = 0

  /**
   * Clase dentro de `horas`, con una reserva pagada con 1 de 5 clases (saldo 4). Con `enLaClase`, entra a esa clase en vez
   * de crear otra.
   */
  const inscrita = async (horas: number, extra: Partial<Prisma.ReservationUncheckedCreateInput> = {}, enLaClase?: string) => {
    n += 1
    const purchase = await prisma.creditPackPurchase.create({
      data: {
        venueId: venueId!,
        customerId: clienta.id,
        creditPackId: pack.id,
        amountPaid: new Prisma.Decimal(1000),
        expiresAt: new Date(Date.now() + 30 * 86_400_000),
        itemBalances: { create: [{ productId: yoga.id, originalQuantity: 5, remainingQuantity: 5 }] },
      },
      select: { itemBalances: { select: { id: true } } },
    })
    const balanceId = purchase.itemBalances[0].id
    const startsAt = new Date(Date.now() + horas * H)
    const endsAt = new Date(startsAt.getTime() + H)
    const clase = enLaClase
      ? { id: enLaClase }
      : await prisma.classSession.create({
          data: { venueId: venueId!, productId: yoga.id, startsAt, endsAt, duration: 60, capacity: 10 },
          select: { id: true },
        })
    const reserva = await prisma.reservation.create({
      data: {
        venueId: venueId!,
        classSessionId: clase.id,
        confirmationCode: `QUITAR-${RUN}-${n}`,
        startsAt,
        endsAt,
        blockedEndsAt: endsAt,
        duration: 60,
        status: 'CONFIRMED',
        customerId: clienta.id,
        productId: yoga.id,
        statusLog: [{ status: 'CONFIRMED', at: new Date().toISOString(), by: null }],
        ...extra,
      },
      select: { id: true },
    })
    await redeemForReservation(venueId!, clienta.id, balanceId, reserva.id)
    return { sessionId: clase.id, reservationId: reserva.id, balanceId }
  }

  const saldo = async (balanceId: string) =>
    (await prisma.creditItemBalance.findUniqueOrThrow({ where: { id: balanceId }, select: { remainingQuantity: true } })).remainingQuantity
  const devoluciones = (reservationId: string) => prisma.creditTransaction.count({ where: { reservationId, type: 'REFUND' } })
  const conPolitica = async (creditRefundMode: 'NEVER' | 'TIME_BASED', fn: () => Promise<void>) => {
    await prisma.reservationSettings.update({ where: { venueId: venueId! }, data: { creditRefundMode } })
    try {
      await fn()
    } finally {
      await prisma.reservationSettings.update({ where: { venueId: venueId! }, data: { creditRefundMode: 'TIME_BASED' } })
    }
  }
  const reserva = (id: string) =>
    prisma.reservation.findUniqueOrThrow({
      where: { id },
      select: {
        status: true,
        cancelledBy: true,
        cancelledAt: true,
        cancellationReason: true,
        depositStatus: true,
        refundStatus: true,
        refundFailedReason: true,
      },
    })

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: 'ITEST Quitar asistente', email: `itest-quitar-${RUN}@test.com`, phone: '5550000000' },
    })
    orgId = org.id
    const venue = await prisma.venue.create({
      data: {
        name: 'ITEST Quitar asistente',
        slug: `itest-quitar-${RUN}`,
        organizationId: orgId,
        address: 'X',
        city: 'X',
        state: 'X',
        country: 'MX',
        zipCode: '00000',
        timezone: 'America/Mexico_City',
        status: 'TRIAL' as any,
      },
      select: { id: true },
    })
    venueId = venue.id
    // La política por default: se devuelve completa con 12 horas o más; más tarde, nada. Y retiene el depósito con menos de 2.
    await prisma.reservationSettings.create({
      data: {
        venueId,
        creditRefundMode: 'TIME_BASED',
        creditFreeRefundHoursBefore: 12,
        creditLateRefundPercent: 0,
        forfeitDeposit: true,
        minHoursBeforeCancel: 2,
        googleCalendarPushEnabled: false,
      },
    })
    const category = await prisma.menuCategory.create({ data: { venueId, name: 'Clases', slug: `clases-${RUN}` } })
    yoga = await prisma.product.create({
      data: { venueId, sku: `QUITAR-yoga-${RUN}`, name: 'Yoga', type: 'CLASS', categoryId: category.id, price: new Prisma.Decimal(200) },
      select: { id: true },
    })
    pack = await prisma.creditPack.create({
      data: {
        venueId,
        name: '5 clases',
        price: new Prisma.Decimal(1000),
        validityDays: 30,
        items: { create: [{ productId: yoga.id, quantity: 5 }] },
      },
      select: { id: true },
    })
    clienta = await prisma.customer.create({ data: { venueId, firstName: 'Karla' }, select: { id: true } })
    staffId = (
      await prisma.staff.create({ data: { email: `itest-quitar-${RUN}@example.test`, firstName: 'Recepción', lastName: 'Prueba' } })
    ).id
    await prisma.staffVenue.create({ data: { venueId, staffId, role: 'CASHIER' } })
  })

  afterAll(async () => {
    if (!venueId) return
    const step = (fn: () => Promise<unknown>) => fn().catch(() => {})
    await step(() => prisma.creditTransaction.deleteMany({ where: { venueId } }))
    await step(() => prisma.creditItemBalance.deleteMany({ where: { creditPackPurchase: { venueId } } }))
    await step(() => prisma.creditPackPurchase.deleteMany({ where: { venueId } }))
    await step(() => prisma.reservation.deleteMany({ where: { venueId } }))
    await step(() => prisma.classSession.deleteMany({ where: { venueId } }))
    await step(() => prisma.creditPackItem.deleteMany({ where: { creditPack: { venueId } } }))
    await step(() => prisma.creditPack.deleteMany({ where: { venueId } }))
    await step(() => prisma.product.deleteMany({ where: { venueId } }))
    await step(() => prisma.menuCategory.deleteMany({ where: { venueId } }))
    await step(() => prisma.customer.deleteMany({ where: { venueId } }))
    await step(() => prisma.activityLog.deleteMany({ where: { venueId } }))
    await step(() => prisma.reservationSettings.deleteMany({ where: { venueId } }))
    await step(() => prisma.staffVenue.deleteMany({ where: { venueId } }))
    if (staffId) await step(() => prisma.staff.deleteMany({ where: { id: staffId } }))
    await step(() => prisma.venue.deleteMany({ where: { id: venueId } }))
    if (orgId) await step(() => prisma.organization.deleteMany({ where: { id: orgId } }))
    await prisma.$disconnect()
  })

  it('🔴 con tiempo de sobra: la clase del paquete regresa, una sola vez, y queda a nombre de quien la quitó', async () => {
    const { sessionId, reservationId, balanceId } = await inscrita(48)
    expect(await saldo(balanceId)).toBe(4)

    await removeAttendee(venueId!, sessionId, reservationId, staffId!)

    expect(await saldo(balanceId)).toBe(5)
    expect(await devoluciones(reservationId)).toBe(1)
    const fila = await reserva(reservationId)
    expect(fila).toMatchObject({ status: 'CANCELLED', cancelledBy: staffId, cancellationReason: 'Quitado de la clase por el negocio' })
    expect(fila.cancelledAt).not.toBeNull()
  })

  it('🔴 se queda la política del negocio: ya tarde, la reserva se cancela y la clase no regresa', async () => {
    const { sessionId, reservationId, balanceId } = await inscrita(5)

    await removeAttendee(venueId!, sessionId, reservationId, staffId!)

    expect(await saldo(balanceId)).toBe(4)
    expect(await devoluciones(reservationId)).toBe(0)
    expect((await reserva(reservationId)).status).toBe('CANCELLED')
  })

  it('🔴 quitarla otra vez no devuelve dos veces', async () => {
    const { sessionId, reservationId, balanceId } = await inscrita(48)
    await removeAttendee(venueId!, sessionId, reservationId, staffId!)

    await expect(removeAttendee(venueId!, sessionId, reservationId, staffId!)).rejects.toThrow('Esta reservación ya no puede ser cancelada')

    expect(await saldo(balanceId)).toBe(5)
    expect(await devoluciones(reservationId)).toBe(1)
  })

  it('🔴 dos peticiones a la vez: una sola gana y la clase regresa una vez', async () => {
    const { sessionId, reservationId, balanceId } = await inscrita(48)

    const resultados = await Promise.allSettled([
      removeAttendee(venueId!, sessionId, reservationId, staffId!),
      removeAttendee(venueId!, sessionId, reservationId, staffId!),
    ])

    expect(resultados.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(await saldo(balanceId)).toBe(5)
    expect(await devoluciones(reservationId)).toBe(1)
  })

  it('🔴 el depósito sigue la misma política: ya muy tarde, se retiene', async () => {
    const { sessionId, reservationId } = await inscrita(1, {
      depositAmount: new Prisma.Decimal(100),
      depositStatus: 'PAID',
      depositProcessorRef: `pi_quitar_${RUN}`,
    })

    await removeAttendee(venueId!, sessionId, reservationId, staffId!)

    expect(await reserva(reservationId)).toMatchObject({ status: 'CANCELLED', depositStatus: 'FORFEITED' })
  })

  it('quien ya llegó no se quita: su reserva y su saldo quedan igual', async () => {
    const { sessionId, reservationId, balanceId } = await inscrita(48, { status: 'CHECKED_IN', checkedInAt: new Date() })

    await expect(removeAttendee(venueId!, sessionId, reservationId, staffId!)).rejects.toThrow('Ya llegó a la clase: no se puede quitar.')

    expect((await reserva(reservationId)).status).toBe('CHECKED_IN')
    expect(await saldo(balanceId)).toBe(4)
    expect(await devoluciones(reservationId)).toBe(0)
  })

  it('una reserva de OTRA clase no se toca', async () => {
    const otra = await inscrita(48)
    const { sessionId } = await inscrita(72)

    await expect(removeAttendee(venueId!, sessionId, otra.reservationId, staffId!)).rejects.toThrow(
      'Asistente no encontrado en esta sesión',
    )

    expect((await reserva(otra.reservationId)).status).toBe('CONFIRMED')
    expect(await saldo(otra.balanceId)).toBe(4)
  })

  describe('D13 · cancelar y devolver van juntos', () => {
    afterEach(() => jest.restoreAllMocks())

    it('🔴 si falla la devolución, la reserva sigue viva con su saldo, y reintentar la cancela y devuelve una vez', async () => {
      const { sessionId, reservationId, balanceId } = await inscrita(48)
      jest.spyOn(creditPackService, 'refundCreditsForReservation').mockRejectedValueOnce(new Error('la base se cayó'))

      await expect(removeAttendee(venueId!, sessionId, reservationId, staffId!)).rejects.toThrow('la base se cayó')

      expect(await reserva(reservationId)).toMatchObject({ status: 'CONFIRMED', cancelledAt: null })
      expect(await saldo(balanceId)).toBe(4)
      expect(await devoluciones(reservationId)).toBe(0)

      await removeAttendee(venueId!, sessionId, reservationId, staffId!)

      expect((await reserva(reservationId)).status).toBe('CANCELLED')
      expect(await saldo(balanceId)).toBe(5)
      expect(await devoluciones(reservationId)).toBe(1)
    })

    it('🔴 cancelar desde la reserva sigue contestando cuánto devolvió y a nombre de quién', async () => {
      const { reservationId, balanceId } = await inscrita(48)

      const r = await cancelReservation(venueId!, reservationId, 'CUSTOMER', 'Ya no puedo')

      expect(r).toMatchObject({ status: 'CANCELLED', cancelledBy: 'CUSTOMER', creditsRefunded: 1 })
      expect((r as any).policyApplied).toContain('TIME_BASED:free')
      expect(await saldo(balanceId)).toBe(5)
    })

    it('una reserva sin paquete se cancela igual', async () => {
      n += 1
      const startsAt = new Date(Date.now() + 48 * H)
      const sinPaquete = await prisma.reservation.create({
        data: {
          venueId: venueId!,
          confirmationCode: `QUITAR-${RUN}-${n}`,
          startsAt,
          endsAt: new Date(startsAt.getTime() + H),
          blockedEndsAt: new Date(startsAt.getTime() + H),
          duration: 60,
          status: 'CONFIRMED',
          customerId: clienta.id,
          productId: yoga.id,
          statusLog: [],
        },
        select: { id: true },
      })

      const r = await cancelReservation(venueId!, sinPaquete.id, staffId!)

      expect(r).toMatchObject({ status: 'CANCELLED', creditsRefunded: 0, policyApplied: 'no-credits-used' })
    })
  })

  describe('D14 · el negocio cancela la clase entera', () => {
    afterEach(() => jest.restoreAllMocks())

    it('🔴 cada quien recupera su clase aunque ya sea tarde para la política, y a quien ya llegó no se le toca', async () => {
      const ana = await inscrita(1)
      const eva = await inscrita(1, {}, ana.sessionId)
      const llego = await inscrita(1, { status: 'CHECKED_IN', checkedInAt: new Date() }, ana.sessionId)

      await cancelClassSession(venueId!, ana.sessionId, staffId!)

      expect(await saldo(ana.balanceId)).toBe(5)
      expect(await saldo(eva.balanceId)).toBe(5)
      expect((await reserva(ana.reservationId)).status).toBe('CANCELLED')
      expect(await saldo(llego.balanceId)).toBe(4)
      expect((await reserva(llego.reservationId)).status).toBe('CHECKED_IN')
      const log = await prisma.activityLog.findFirstOrThrow({ where: { action: 'CLASS_SESSION_CANCELLED', entityId: ana.sessionId } })
      expect(log.data).toMatchObject({ creditsRefunded: 2 })
    })

    it('🔴 también si la política del negocio dice «nunca»: canceló el negocio, no la clienta', async () => {
      await conPolitica('NEVER', async () => {
        const { sessionId, reservationId, balanceId } = await inscrita(48)

        await cancelClassSession(venueId!, sessionId, staffId!)

        expect(await saldo(balanceId)).toBe(5)
        expect(await devoluciones(reservationId)).toBe(1)
      })
    })

    it('🔴 cancelarla dos veces no devuelve dos veces', async () => {
      const { sessionId, reservationId, balanceId } = await inscrita(48)
      await cancelClassSession(venueId!, sessionId, staffId!)

      await expect(cancelClassSession(venueId!, sessionId, staffId!)).rejects.toMatchObject({ statusCode: 409 })

      expect(await saldo(balanceId)).toBe(5)
      expect(await devoluciones(reservationId)).toBe(1)
    })

    it('🔴 si falla una devolución, la clase y sus reservas siguen vivas, y reintentar devuelve a todas una vez', async () => {
      const ana = await inscrita(48)
      const eva = await inscrita(48, {}, ana.sessionId)
      const real = creditPackService.refundCreditsForReservation
      jest
        .spyOn(creditPackService, 'refundCreditsForReservation')
        .mockImplementationOnce(real) // la primera devolución sí se escribe…
        .mockRejectedValueOnce(new Error('la base se cayó')) // …y la segunda tira toda la transacción

      await expect(cancelClassSession(venueId!, ana.sessionId, staffId!)).rejects.toThrow('la base se cayó')

      const clase = await prisma.classSession.findUniqueOrThrow({
        where: { id: ana.sessionId },
        select: { status: true, cancelledAt: true },
      })
      expect(clase).toEqual({ status: 'SCHEDULED', cancelledAt: null })
      expect((await reserva(ana.reservationId)).status).toBe('CONFIRMED')
      expect(await saldo(ana.balanceId)).toBe(4)
      expect(await saldo(eva.balanceId)).toBe(4)

      await cancelClassSession(venueId!, ana.sessionId, staffId!)

      expect(await saldo(ana.balanceId)).toBe(5)
      expect(await saldo(eva.balanceId)).toBe(5)
      expect(await devoluciones(ana.reservationId)).toBe(1)
      expect(await devoluciones(eva.reservationId)).toBe(1)
    })

    it('🔴 nunca se queda con el depósito: ya muy tarde, en vez de retenerlo intenta devolverlo', async () => {
      const { sessionId, reservationId } = await inscrita(1, {
        depositAmount: new Prisma.Decimal(100),
        depositStatus: 'PAID',
        depositProcessorRef: `pi_clase_${RUN}`,
      })

      await cancelClassSession(venueId!, sessionId, staffId!)

      // Este negocio de prueba no tiene Stripe: se queda sin retener y con la devolución marcada como fallida, a la vista.
      expect(await reserva(reservationId)).toMatchObject({ status: 'CANCELLED', depositStatus: 'PAID', refundStatus: 'FAILED' })
      expect((await reserva(reservationId)).refundFailedReason).toContain('Stripe Connect')
    })

    it('🔴 cancelar la clase mientras alguien la quita de la lista: la clase regresa una sola vez', async () => {
      const { sessionId, reservationId, balanceId } = await inscrita(48)

      await Promise.allSettled([
        removeAttendee(venueId!, sessionId, reservationId, staffId!),
        cancelClassSession(venueId!, sessionId, staffId!),
      ])

      expect((await reserva(reservationId)).status).toBe('CANCELLED')
      expect(await saldo(balanceId)).toBe(5)
      expect(await devoluciones(reservationId)).toBe(1)
    })

    it('una clase sin reservas se cancela igual', async () => {
      const startsAt = new Date(Date.now() + 48 * H)
      const clase = await prisma.classSession.create({
        data: { venueId: venueId!, productId: yoga.id, startsAt, endsAt: new Date(startsAt.getTime() + H), duration: 60, capacity: 10 },
        select: { id: true },
      })

      const r = await cancelClassSession(venueId!, clase.id, staffId!)

      expect(r.status).toBe('CANCELLED')
    })
  })
})
