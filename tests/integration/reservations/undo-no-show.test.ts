/**
 * Integración (base REAL desechable) — D4, Task 1: «Sí llegó» revierte exactamente lo que hizo el «No asistió».
 *
 * Paquete de 5 clases, una reserva pagada con una (saldo 4) y depósito pagado. `markNoShow` real con «devolver la clase»
 * y «retener el depósito» encendidos ⇒ saldo 5 y depósito FORFEITED. `undoNoShow` lo deja como si hubiera llegado.
 *
 * Las carreras son deterministas: una tercera transacción toma el candado de la fila de la reserva, cada llamada se
 * suelta en orden y no se arranca la siguiente hasta que la anterior ya ESPERA ese candado (medido en Postgres con
 * `pg_blocking_pids`, siguiendo la cadena desde la transacción que lo tiene: no cuenta esperas de otras suites). Sólo
 * entonces se suelta. Cada prueba afirma que sí hubo carrera (`esperando`), no sólo el estado final.
 */
// Task 3: el aviso de la corrección del kiosco sale sin esperar; aquí sólo se comprueba que se pidió (lo prueba Task 4).
// El resumen por clase sí es el real: su marca en ActivityLog tiene que pasar el check de identidad (Codex r3 #3).
jest.mock('@/services/reservation/noShowNotices.service', () => ({
  __esModule: true,
  ...jest.requireActual('@/services/reservation/noShowNotices.service'),
  afterNoShowCorrection: jest.fn(async () => {}),
  notifyNoShowNeedsReview: jest.fn(async () => {}),
}))

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { markNoShow } from '@/services/dashboard/reservation.dashboard.service'
import { redeemForReservation } from '@/services/dashboard/creditPack.public.service'
import { undoNoShow, type UndoNoShowCommand } from '@/services/reservation/undoNoShow.service'
import { undoCheckIn, CHECK_IN_UNDO_NOT_APPLICABLE } from '@/services/reservation/checkIn.service'
import { kioskCheckInReservation } from '@/services/reservation/kioskCheckIn.service'
import { getReservationSettings } from '@/services/dashboard/reservationSettings.service'
import { afterNoShowCorrection, sendClassNoShowSummaries } from '@/services/reservation/noShowNotices.service'

const RUN = Date.now()

type Asentado = { status: 'fulfilled'; value: any } | { status: 'rejected'; reason: any }
const asentar = (p: Promise<unknown>): Promise<Asentado> =>
  p.then(
    value => ({ status: 'fulfilled' as const, value }),
    reason => ({ status: 'rejected' as const, reason }),
  )

describe('D4 · «Sí llegó» deshace un «No asistió» (integración, base real)', () => {
  let orgId: string | undefined
  let venueId: string | undefined
  let staffId: string | undefined
  let duenaId: string | undefined
  let staffVenueId: string
  let clienta: { id: string }
  let yoga: { id: string }
  let pack: { id: string }
  let n = 0

  /** Reserva CONFIRMED de hace una hora, pagada con 1 de 5 clases (saldo 4) y con depósito PAID. */
  const reservaPagada = async () => {
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
    const startsAt = new Date(Date.now() - 3_600_000)
    const reserva = await prisma.reservation.create({
      data: {
        venueId: venueId!,
        confirmationCode: `UNS-${RUN}-${n}`,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 3_600_000),
        blockedEndsAt: new Date(startsAt.getTime() + 3_600_000),
        duration: 60,
        status: 'CONFIRMED',
        customerId: clienta.id,
        productId: yoga.id,
        depositAmount: new Prisma.Decimal(100),
        depositStatus: 'PAID',
        statusLog: [{ status: 'CONFIRMED', at: new Date().toISOString(), by: null }],
      },
      select: { id: true },
    })
    await redeemForReservation(venueId!, clienta.id, balanceId, reserva.id)
    return { reservationId: reserva.id, balanceId }
  }

  const cmd = (reservationId: string): UndoNoShowCommand => ({
    reservationId,
    venueId: venueId!,
    actor: { type: 'HUMAN', staffId: staffId! },
    source: 'DASHBOARD',
    now: new Date(),
  })
  const deshacer = (reservationId: string) => prisma.$transaction(tx => undoNoShow(tx, cmd(reservationId)), { timeout: 30_000 })

  const saldo = async (balanceId: string) =>
    (await prisma.creditItemBalance.findUniqueOrThrow({ where: { id: balanceId }, select: { remainingQuantity: true } })).remainingQuantity
  const reserva = (id: string) =>
    prisma.reservation.findUniqueOrThrow({
      where: { id },
      select: { status: true, depositStatus: true, noShowAt: true, checkedInAt: true, noShowFeeAmount: true },
    })
  const devoluciones = (reservationId: string) =>
    prisma.creditTransaction.count({ where: { reservationId, type: 'REFUND', reason: { startsWith: 'No-show refund' } } })
  const reDescuentos = (reservationId: string) =>
    prisma.creditTransaction.count({ where: { reservationId, type: 'REDEEM', reason: 'No-show undo' } })

  /**
   * Corre `pasos` EN ORDEN mientras otra transacción tiene la fila de la reserva: arranca uno, espera a que ya esté
   * bloqueado, arranca el siguiente; cuando todos esperan, suelta. Devuelve cuántos llegaron a esperar a la vez.
   */
  const enCarrera = async (reservationId: string, pasos: Array<() => Promise<unknown>>) => {
    let enCurso: Promise<Asentado>[] = []
    let esperando = 0
    await prisma.$transaction(
      async tx => {
        await tx.$queryRaw`SELECT id FROM "Reservation" WHERE id = ${reservationId} FOR UPDATE`
        const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
        const bloqueadas = async () => {
          // `pg_stat_activity` se congela dentro de una transacción: hay que soltar la foto en cada vuelta.
          await tx.$executeRaw`SELECT pg_stat_clear_snapshot()`
          const [{ n: total }] = await tx.$queryRaw<{ n: number }[]>`
            WITH RECURSIVE bloqueadas(pid) AS (
              SELECT a.pid FROM pg_stat_activity a WHERE ${pid}::int = ANY(pg_blocking_pids(a.pid))
              UNION
              SELECT a.pid FROM pg_stat_activity a JOIN bloqueadas b ON b.pid = ANY(pg_blocking_pids(a.pid))
            )
            SELECT count(*)::int AS n FROM bloqueadas`
          return total
        }
        for (const paso of pasos) {
          enCurso = [...enCurso, asentar(paso())]
          const limite = Date.now() + 10_000
          while ((esperando = await bloqueadas()) < enCurso.length && Date.now() < limite) await new Promise(r => setTimeout(r, 25))
        }
      },
      { timeout: 40_000 },
    )
    return { resultados: await Promise.all(enCurso), esperando }
  }

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: 'ITEST Sí llegó', email: `itest-sillego-${RUN}@test.com`, phone: '5550000000' },
    })
    orgId = org.id
    const venue = await prisma.venue.create({
      data: {
        name: 'ITEST Sí llegó',
        slug: `itest-sillego-${RUN}`,
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
    await prisma.reservationSettings.create({
      data: { venueId, forfeitDeposit: true, creditNoShowRefund: true, googleCalendarPushEnabled: false },
    })
    const category = await prisma.menuCategory.create({ data: { venueId, name: 'Clases', slug: `clases-${RUN}` } })
    yoga = await prisma.product.create({
      data: { venueId, sku: `UNS-yoga-${RUN}`, name: 'Yoga', type: 'CLASS', categoryId: category.id, price: new Prisma.Decimal(200) },
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
    const staff = await prisma.staff.create({
      data: { email: `itest-sillego-${RUN}@example.test`, firstName: 'Recepción', lastName: 'Prueba' },
    })
    staffId = staff.id
    staffVenueId = (await prisma.staffVenue.create({ data: { venueId, staffId, role: 'CASHIER' }, select: { id: true } })).id
  })

  afterAll(async () => {
    if (!venueId) return
    const step = (fn: () => Promise<unknown>) => fn().catch(() => {})
    await step(() => prisma.reservationNoShowCorrection.deleteMany({ where: { venueId } }))
    await step(() => prisma.creditTransaction.deleteMany({ where: { venueId } }))
    await step(() => prisma.creditItemBalance.deleteMany({ where: { creditPackPurchase: { venueId } } }))
    await step(() => prisma.creditPackPurchase.deleteMany({ where: { venueId } }))
    await step(() => prisma.order.deleteMany({ where: { venueId } }))
    await step(() => prisma.reservation.deleteMany({ where: { venueId } }))
    await step(() => prisma.classSession.deleteMany({ where: { venueId } }))
    await step(() => prisma.creditPackItem.deleteMany({ where: { creditPack: { venueId } } }))
    await step(() => prisma.creditPack.deleteMany({ where: { venueId } }))
    await step(() => prisma.product.deleteMany({ where: { venueId } }))
    await step(() => prisma.menuCategory.deleteMany({ where: { venueId } }))
    await step(() => prisma.customer.deleteMany({ where: { venueId } }))
    await step(() => prisma.activityLog.deleteMany({ where: { venueId } }))
    await step(() => prisma.notification.deleteMany({ where: { venueId } }))
    await step(() => prisma.reservationSettings.deleteMany({ where: { venueId } }))
    await step(() => prisma.staffVenue.deleteMany({ where: { venueId } }))
    if (staffId) await step(() => prisma.staff.deleteMany({ where: { id: staffId } }))
    if (duenaId) await step(() => prisma.staff.deleteMany({ where: { id: duenaId } }))
    await step(() => prisma.venue.deleteMany({ where: { id: venueId } }))
    if (orgId) await step(() => prisma.organization.deleteMany({ where: { id: orgId } }))
    await prisma.$disconnect()
  })

  it('🔴 markNoShow (devuelve la clase, retiene el depósito, multa anotada) ⇒ «Sí llegó» deja saldo 4, PAID, CHECKED_IN y una corrección; repetirlo no cambia nada', async () => {
    const { reservationId, balanceId } = await reservaPagada()
    expect(await saldo(balanceId)).toBe(4)

    await markNoShow(venueId!, reservationId, staffId!)
    await prisma.reservation.update({ where: { id: reservationId }, data: { noShowFeeAmount: new Prisma.Decimal(50) } }) // lo que anota el trabajo
    expect(await saldo(balanceId)).toBe(5)
    expect(await reserva(reservationId)).toMatchObject({ status: 'NO_SHOW', depositStatus: 'FORFEITED' })
    expect(await devoluciones(reservationId)).toBe(1)

    const primera = await deshacer(reservationId)

    expect(primera.outcome).toBe('UNDONE')
    // Con montos y paquete reales de la base: es lo que la ventana de confirmación dice («la multa de $50», «tus $100», «1 de “5 clases”»).
    expect(primera.plan).toEqual({
      creditToReconsume: 1,
      clearFee: true,
      restoreDeposit: true,
      feeAmount: 50,
      depositAmount: 100,
      packName: '5 clases',
      pending: [],
    })
    expect(await saldo(balanceId)).toBe(4)
    const fila = await reserva(reservationId)
    expect(fila).toMatchObject({ status: 'CHECKED_IN', depositStatus: 'PAID', noShowAt: null, noShowFeeAmount: null })
    expect(fila.checkedInAt).toBeTruthy()
    const undo = await prisma.creditTransaction.findFirstOrThrow({ where: { reservationId, reason: 'No-show undo' } })
    expect(undo).toMatchObject({ type: 'REDEEM', quantity: -1, creditItemBalanceId: balanceId, createdById: staffVenueId })
    const correcciones = await prisma.reservationNoShowCorrection.findMany({ where: { reservationId }, take: 5 })
    expect(correcciones).toHaveLength(1)
    expect(correcciones[0]).toMatchObject({ venueId, source: 'DASHBOARD', actorStaffId: staffId, pending: [], resolvedAt: null })
    expect(correcciones[0].plan).toMatchObject({ feeAmount: 50, depositAmount: 100, packName: '5 clases' }) // la corrección guarda lo mismo
    const logs = await prisma.activityLog.findMany({ where: { entityId: reservationId, action: 'RESERVATION_NO_SHOW_UNDONE' }, take: 5 })
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ actorType: 'HUMAN', staffId, actorStaffId: staffId, organizationId: orgId })

    const segunda = await deshacer(reservationId)

    expect(segunda.outcome).toBe('ALREADY_UNDONE')
    expect(segunda.correction.id).toBe(correcciones[0].id)
    expect(await saldo(balanceId)).toBe(4)
    expect(await reDescuentos(reservationId)).toBe(1)
  })

  it('🔴 kiosco: un toque guardado sin red sobre un «No asistió» se corrige solo con actor SERVICE (pasa el check de ActivityLog) y la repetición devuelve la misma corrección', async () => {
    const { reservationId, balanceId } = await reservaPagada()
    await markNoShow(venueId!, reservationId, staffId!)
    expect(await saldo(balanceId)).toBe(5)
    const { startsAt } = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId }, select: { startsAt: true } })
    const grace = (await getReservationSettings(venueId!)).scheduling.noShowGraceMin
    // El cierre que la lista le dio al kiosco (el del SERVIDOR) y un toque 5 min antes: dentro de la ventana.
    const tapped = { closesAt: new Date(startsAt.getTime() + grace * 60_000), msBeforeClose: 5 * 60_000 }
    const tappedAt = new Date(tapped.closesAt.getTime() - tapped.msBeforeClose)
    const llegada = () => kioskCheckInReservation({ venueId: venueId!, reservationId, now: new Date(), tapped })

    const primera = await llegada()

    expect(primera).toMatchObject({ reservationId, orderId: null, correction: { id: expect.any(String), pending: [] } })
    expect(await reserva(reservationId)).toMatchObject({
      status: 'CHECKED_IN',
      depositStatus: 'PAID',
      noShowAt: null,
      checkedInAt: tappedAt,
    })
    expect(await saldo(balanceId)).toBe(4)
    const correccion = await prisma.reservationNoShowCorrection.findUniqueOrThrow({ where: { reservationId } })
    expect(correccion).toMatchObject({ id: primera.correction!.id, venueId, source: 'KIOSK', actorStaffId: null, resolvedAt: null })
    const logs = await prisma.activityLog.findMany({ where: { entityId: reservationId, action: 'RESERVATION_NO_SHOW_UNDONE' }, take: 5 })
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      actorType: 'SERVICE',
      servicePrincipalId: 'kiosk',
      staffId: null,
      actorStaffId: null,
      organizationId: orgId,
    })
    expect(afterNoShowCorrection).toHaveBeenCalledTimes(1)
    expect(afterNoShowCorrection).toHaveBeenCalledWith(correccion.id)
    expect(await prisma.order.count({ where: { reservationId } })).toBe(0) // una corrección nunca abre cuenta

    // Se perdió la respuesta: el aparato repite la MISMA llegada.
    const repetida = await llegada()

    expect(repetida).toEqual(primera)
    expect(await reDescuentos(reservationId)).toBe(1)
    expect(await prisma.reservationNoShowCorrection.count({ where: { reservationId } })).toBe(1)
    expect(afterNoShowCorrection).toHaveBeenCalledTimes(1)
    expect(await prisma.activityLog.count({ where: { entityId: reservationId, action: 'RESERVATION_KIOSK_CHECK_IN_AFTER_NO_SHOW' } })).toBe(
      0,
    )
  })

  it('🔴 una llegada corregida no se puede «deshacer check-in»: 409 y la clase no se toca (si no, se devolvería dos veces)', async () => {
    const { reservationId, balanceId } = await reservaPagada()
    await markNoShow(venueId!, reservationId, staffId!)
    await deshacer(reservationId)
    expect(await saldo(balanceId)).toBe(4)

    const intento = prisma.$transaction(tx =>
      undoCheckIn(tx, {
        reservationId,
        venueId: venueId!,
        actor: { type: 'HUMAN', staffId: staffId! },
        source: 'DASHBOARD',
        now: new Date(),
        reason: 'se tocó el nombre equivocado',
      }),
    )

    await expect(intento).rejects.toMatchObject({ statusCode: 409, code: CHECK_IN_UNDO_NOT_APPLICABLE })
    expect(await reserva(reservationId)).toMatchObject({ status: 'CHECKED_IN', depositStatus: 'PAID' })
    expect(await saldo(balanceId)).toBe(4)
    expect(await devoluciones(reservationId)).toBe(1)
    expect(await reDescuentos(reservationId)).toBe(1)
    expect(await prisma.activityLog.count({ where: { entityId: reservationId, action: 'RESERVATION_CHECK_IN_UNDONE' } })).toBe(0)
  })

  it('🔴 dos «Sí llegó» a la vez (dos aparatos) ⇒ una sola corrección y un solo REDEEM «No-show undo»', async () => {
    const { reservationId, balanceId } = await reservaPagada()
    await markNoShow(venueId!, reservationId, staffId!)
    expect(await saldo(balanceId)).toBe(5)

    const { resultados, esperando } = await enCarrera(reservationId, [() => deshacer(reservationId), () => deshacer(reservationId)])

    expect(esperando).toBe(2) // las dos estuvieron esperando el candado a la vez: sí hubo carrera
    expect(resultados.map(r => r.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(resultados.map(r => (r.status === 'fulfilled' ? r.value.outcome : null)).sort()).toEqual(['ALREADY_UNDONE', 'UNDONE'])
    expect(await reDescuentos(reservationId)).toBe(1)
    expect(await prisma.reservationNoShowCorrection.count({ where: { reservationId } })).toBe(1)
    expect(await saldo(balanceId)).toBe(4)
    expect(await reserva(reservationId)).toMatchObject({ status: 'CHECKED_IN', depositStatus: 'PAID' })
  })

  it('🔴 «No asistió» y «Sí llegó» a la vez, el «No asistió» primero: su devolución y su retención llegan tarde y NO escriben', async () => {
    const { reservationId, balanceId } = await reservaPagada()

    const { resultados, esperando } = await enCarrera(reservationId, [
      () => markNoShow(venueId!, reservationId, staffId!),
      () => deshacer(reservationId),
    ])

    expect(esperando).toBe(2)
    expect(resultados[0].status).toBe('fulfilled')
    expect(resultados[1]).toMatchObject({ status: 'fulfilled', value: { outcome: 'UNDONE' } })
    // Nunca CHECKED_IN con una devolución sin su re-descuento, ni con el depósito retenido.
    expect(await reserva(reservationId)).toMatchObject({ status: 'CHECKED_IN', depositStatus: 'PAID' })
    expect(await devoluciones(reservationId)).toBe(await reDescuentos(reservationId))
    expect(await saldo(balanceId)).toBe(4)
    expect(await prisma.reservationNoShowCorrection.count({ where: { reservationId } })).toBe(1)
  })

  it('🔴 clase cobrada en caja («Inscribir y cobrar»: venta PAID ligada a la reserva) ⇒ sin «clase no pagada»; una venta cancelada no cuenta', async () => {
    const startsAt = new Date(Date.now() - 3_600_000)
    const endsAt = new Date(startsAt.getTime() + 3_600_000)
    const sesion = await prisma.classSession.create({
      data: { venueId: venueId!, productId: yoga.id, startsAt, endsAt, duration: 60, capacity: 10 },
      select: { id: true },
    })
    /** Clase de $200 sin paquete ni depósito, con su venta PAID ligada; el automático la marca «No asistió». */
    const claseConVenta = async (status: 'COMPLETED' | 'CANCELLED') => {
      n += 1
      const { id } = await prisma.reservation.create({
        data: {
          venueId: venueId!,
          confirmationCode: `UNS-${RUN}-${n}`,
          classSessionId: sesion.id,
          productId: yoga.id,
          startsAt,
          endsAt,
          blockedEndsAt: endsAt,
          duration: 60,
          status: 'CONFIRMED',
          customerId: clienta.id,
          statusLog: [{ status: 'CONFIRMED', at: new Date().toISOString(), by: null }],
        },
        select: { id: true },
      })
      await prisma.order.create({
        data: {
          venueId: venueId!,
          reservationId: id,
          orderNumber: `UNS-${RUN}-${n}`,
          status,
          paymentStatus: 'PAID',
          subtotal: new Prisma.Decimal(200),
          taxAmount: new Prisma.Decimal(0),
          total: new Prisma.Decimal(200),
        },
      })
      await markNoShow(venueId!, id, staffId!)
      return id
    }

    const pagada = await deshacer(await claseConVenta('COMPLETED'))
    const cancelada = await deshacer(await claseConVenta('CANCELLED'))

    expect(pagada).toMatchObject({ outcome: 'UNDONE', plan: { pending: [] }, correction: { pending: [] } })
    expect(cancelada).toMatchObject({ outcome: 'UNDONE', plan: { pending: ['CLASS_UNPAID'] }, correction: { pending: ['CLASS_UNPAID'] } })
  })

  it('«Sí llegó» antes que el «No asistió»: no hay nada que corregir (409) y el «No asistió» queda completo', async () => {
    const { reservationId, balanceId } = await reservaPagada()

    const { resultados, esperando } = await enCarrera(reservationId, [
      () => deshacer(reservationId),
      () => markNoShow(venueId!, reservationId, staffId!),
    ])

    expect(esperando).toBe(2)
    expect(resultados[0]).toMatchObject({ status: 'rejected', reason: { code: 'NO_SHOW_UNDO_NOT_APPLICABLE' } })
    expect(resultados[1].status).toBe('fulfilled')
    expect(await reserva(reservationId)).toMatchObject({ status: 'NO_SHOW', depositStatus: 'FORFEITED' })
    expect(await devoluciones(reservationId)).toBe(1)
    expect(await saldo(balanceId)).toBe(5)
    expect(await prisma.reservationNoShowCorrection.count({ where: { reservationId } })).toBe(0)

    // Y ya con el «No asistió» completo, la corrección lo revierte entero.
    await deshacer(reservationId)
    expect(await reserva(reservationId)).toMatchObject({ status: 'CHECKED_IN', depositStatus: 'PAID' })
    expect(await saldo(balanceId)).toBe(4)
  })

  it('🔴 resumen por clase: la marca «ya se mandó» va en ActivityLog con actor SERVICE (pasa el check) y borrar la campanita no lo reenvía', async () => {
    // Una ventana propia en el pasado: el resumen lee las clases de TODA la base, así no toca las de otras suites.
    const startsAt = new Date('2001-03-04T16:00:00Z')
    const now = new Date(startsAt.getTime() + 2 * 3_600_000)
    const duena = await prisma.staff.create({
      data: { email: `itest-sillego-duena-${RUN}@example.test`, firstName: 'Dueña', lastName: 'Prueba' },
      select: { id: true },
    })
    duenaId = duena.id
    await prisma.staffVenue.create({ data: { venueId: venueId!, staffId: duena.id, role: 'OWNER' } })
    const cs = await prisma.classSession.create({
      data: {
        venueId: venueId!,
        productId: yoga.id,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 3_600_000),
        duration: 60,
        capacity: 10,
      },
      select: { id: true },
    })
    await prisma.reservation.create({
      data: {
        venueId: venueId!,
        confirmationCode: `UNS-${RUN}-resumen`,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 3_600_000),
        blockedEndsAt: new Date(startsAt.getTime() + 3_600_000),
        duration: 60,
        status: 'NO_SHOW',
        noShowAt: new Date(startsAt.getTime() + 20 * 60_000),
        customerId: clienta.id,
        productId: yoga.id,
        classSessionId: cs.id,
        statusLog: [],
      },
    })
    const campanitas = () => prisma.notification.count({ where: { entityType: 'ClassSession', entityId: cs.id } })

    expect(await sendClassNoShowSummaries(now)).toBe(1)

    expect(await campanitas()).toBe(1)
    const sellos = await prisma.activityLog.findMany({
      where: { entity: 'ClassSession', entityId: cs.id, action: 'RESERVATION_NO_SHOW_SUMMARY_SENT' },
      take: 5,
    })
    expect(sellos).toHaveLength(1)
    expect(sellos[0]).toMatchObject({
      venueId,
      actorType: 'SERVICE',
      servicePrincipalId: 'reservation-auto-no-show',
      staffId: null,
      actorStaffId: null,
      organizationId: orgId,
    })

    // La dueña vacía su buzón: el siguiente tick no le vuelve a mandar el resumen.
    await prisma.notification.deleteMany({ where: { entityType: 'ClassSession', entityId: cs.id } })
    expect(await sendClassNoShowSummaries(now)).toBe(0)
    expect(await campanitas()).toBe(0)
  })
})
