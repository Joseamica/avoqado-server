/**
 * Integración (base REAL desechable) — D4, Task 0: ningún descuento de clases deja el saldo en negativo, y la devolución
 * de un «No asistió» no escribe si la reserva ya no es NO_SHOW.
 *
 * El canje manual y el ajuste negativo validan el saldo FUERA de su transacción. Para que la carrera sea determinista,
 * una tercera transacción toma el candado de la fila del saldo, deja que las dos llamadas lean (una lectura no espera al
 * candado) y lleguen a su escritura, y sólo entonces suelta. Sin la escritura condicionada las dos escriben: saldo −1.
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { adjustItemBalance, redeemItemManually } from '@/services/dashboard/creditPack.dashboard.service'
import { refundCreditsForReservation } from '@/services/dashboard/creditPack.public.service'

const RUN = Date.now()

describe('Descuentos de clases a la vez y devolución de un «No asistió» (integración, base real)', () => {
  let orgId: string | undefined
  let venueId: string | undefined
  let staffId: string | undefined
  let staffVenueId: string
  let clienta: { id: string }
  let yoga: { id: string }
  let pack: { id: string }
  let n = 0

  const saldoConUnaClase = async (quantity = 1) => {
    n += 1
    const purchase = await prisma.creditPackPurchase.create({
      data: {
        venueId: venueId!,
        customerId: clienta.id,
        creditPackId: pack.id,
        amountPaid: new Prisma.Decimal(200),
        expiresAt: new Date(Date.now() + 30 * 86_400_000),
        itemBalances: { create: [{ productId: yoga.id, originalQuantity: quantity, remainingQuantity: quantity }] },
      },
      select: { itemBalances: { select: { id: true } } },
    })
    return purchase.itemBalances[0].id
  }

  /**
   * Corre `llamadas` mientras otra transacción tiene la fila del saldo, y suelta cuando todas ya esperan para escribir.
   * Se consulta desde la MISMA transacción (así bastan 3 conexiones); `pg_stat_clear_snapshot` porque Postgres congela
   * `pg_stat_activity` dentro de una transacción.
   */
  const aLaVez = async (balanceId: string, llamadas: Array<() => Promise<unknown>>) => {
    let enCurso!: Promise<PromiseSettledResult<unknown>[]>
    await prisma.$transaction(
      async tx => {
        await tx.$queryRaw`SELECT id FROM "CreditItemBalance" WHERE id = ${balanceId} FOR UPDATE`
        enCurso = Promise.allSettled(llamadas.map(f => f()))
        const limite = Date.now() + 10_000
        while (Date.now() < limite) {
          await tx.$executeRaw`SELECT pg_stat_clear_snapshot()`
          const [{ n: esperando }] = await tx.$queryRaw<{ n: number }[]>`
            SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%CreditItemBalance%'`
          if (esperando >= llamadas.length) break
          await new Promise(r => setTimeout(r, 50))
        }
      },
      { timeout: 20_000 },
    )
    return enCurso
  }

  const saldo = async (balanceId: string) =>
    (await prisma.creditItemBalance.findUniqueOrThrow({ where: { id: balanceId }, select: { remainingQuantity: true } })).remainingQuantity

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: 'ITEST Descuentos', email: `itest-descuentos-${RUN}@test.com`, phone: '5550000000' },
    })
    orgId = org.id
    const venue = await prisma.venue.create({
      data: {
        name: 'ITEST Descuentos',
        slug: `itest-descuentos-${RUN}`,
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
    const category = await prisma.menuCategory.create({ data: { venueId, name: 'Clases', slug: `clases-${RUN}` } })
    yoga = await prisma.product.create({
      data: { venueId, sku: `DC-yoga-${RUN}`, name: 'Yoga', type: 'CLASS', categoryId: category.id, price: new Prisma.Decimal(200) },
      select: { id: true },
    })
    pack = await prisma.creditPack.create({
      data: {
        venueId,
        name: '1 clase',
        price: new Prisma.Decimal(200),
        validityDays: 30,
        items: { create: [{ productId: yoga.id, quantity: 1 }] },
      },
      select: { id: true },
    })
    clienta = await prisma.customer.create({ data: { venueId, firstName: 'Ana' }, select: { id: true } })
    const staff = await prisma.staff.create({
      data: { email: `itest-descuentos-${RUN}@example.test`, firstName: 'Recepción', lastName: 'Prueba' },
    })
    staffId = staff.id
    staffVenueId = (await prisma.staffVenue.create({ data: { venueId, staffId, role: 'CASHIER' }, select: { id: true } })).id
  })

  afterAll(async () => {
    if (!venueId) return
    const step = (fn: () => Promise<unknown>) => fn().catch(() => {})
    await step(() => prisma.creditTransaction.deleteMany({ where: { venueId } }))
    await step(() => prisma.creditItemBalance.deleteMany({ where: { creditPackPurchase: { venueId } } }))
    await step(() => prisma.creditPackPurchase.deleteMany({ where: { venueId } }))
    await step(() => prisma.reservation.deleteMany({ where: { venueId } }))
    await step(() => prisma.creditPackItem.deleteMany({ where: { creditPack: { venueId } } }))
    await step(() => prisma.creditPack.deleteMany({ where: { venueId } }))
    await step(() => prisma.product.deleteMany({ where: { venueId } }))
    await step(() => prisma.menuCategory.deleteMany({ where: { venueId } }))
    await step(() => prisma.customer.deleteMany({ where: { venueId } }))
    await step(() => prisma.activityLog.deleteMany({ where: { venueId } }))
    await step(() => prisma.staffVenue.deleteMany({ where: { venueId } }))
    if (staffId) await step(() => prisma.staff.deleteMany({ where: { id: staffId } }))
    await step(() => prisma.venue.deleteMany({ where: { id: venueId } }))
    if (orgId) await step(() => prisma.organization.deleteMany({ where: { id: orgId } }))
    await prisma.$disconnect()
  })

  it('dos canjes manuales a la vez sobre la última clase: uno pasa, el otro recibe el error de saldo y queda en 0', async () => {
    const balanceId = await saldoConUnaClase()

    const r = await aLaVez(balanceId, [
      () => redeemItemManually(venueId!, balanceId, staffVenueId, 'mostrador A'),
      () => redeemItemManually(venueId!, balanceId, staffVenueId, 'mostrador B'),
    ])

    expect(r.filter(x => x.status === 'fulfilled')).toHaveLength(1)
    const rechazos = r.filter((x): x is PromiseRejectedResult => x.status === 'rejected')
    expect(rechazos).toHaveLength(1)
    expect(rechazos[0].reason.message).toBe('No hay creditos disponibles para canjear')
    expect(await saldo(balanceId)).toBe(0)
    expect(await prisma.creditTransaction.count({ where: { creditItemBalanceId: balanceId, type: 'REDEEM' } })).toBe(1)
  })

  it('ajuste −1 y un canje a la vez sobre la última clase: sólo uno descuenta y el saldo queda en 0, nunca −1', async () => {
    const balanceId = await saldoConUnaClase()

    const r = await aLaVez(balanceId, [
      () => adjustItemBalance(venueId!, balanceId, -1, 'Corrección', staffVenueId),
      () => redeemItemManually(venueId!, balanceId, staffVenueId, 'mostrador'),
    ])

    expect(r.filter(x => x.status === 'fulfilled')).toHaveLength(1)
    const rechazos = r.filter((x): x is PromiseRejectedResult => x.status === 'rejected')
    expect(rechazos).toHaveLength(1)
    expect(['No hay creditos disponibles para canjear', 'El ajuste dejaria el balance en -1, no se permite balance negativo']).toContain(
      rechazos[0].reason.message,
    )
    expect(await saldo(balanceId)).toBe(0)
    expect(await prisma.creditTransaction.count({ where: { creditItemBalanceId: balanceId, type: { in: ['REDEEM', 'ADJUST'] } } })).toBe(1)
  })

  it('la devolución de un «No asistió» no escribe si la reserva ya es CHECKED_IN, y sí cuando sigue en NO_SHOW', async () => {
    const balanceId = await saldoConUnaClase()
    const startsAt = new Date(Date.now() - 3_600_000)
    const reserva = await prisma.reservation.create({
      data: {
        venueId: venueId!,
        confirmationCode: `DC-${RUN}-${n}`,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 3_600_000),
        blockedEndsAt: new Date(startsAt.getTime() + 3_600_000),
        duration: 60,
        status: 'CHECKED_IN',
        customerId: clienta.id,
      },
      select: { id: true },
    })
    await redeemItemManually(venueId!, balanceId, staffVenueId)
    await prisma.creditTransaction.updateMany({
      where: { creditItemBalanceId: balanceId, type: 'REDEEM' },
      data: { reservationId: reserva.id },
    })
    const args = {
      venueId: venueId!,
      reservationId: reserva.id,
      startsAt,
      policy: { creditRefundMode: 'ALWAYS' as const, creditFreeRefundHoursBefore: 0, creditLateRefundPercent: 100 },
      reasonPrefix: 'No-show refund',
      onlyIfReservationStatus: 'NO_SHOW' as const,
    }

    const saltada = await refundCreditsForReservation(args)
    expect(saltada).toMatchObject({ creditsRefunded: 0, skipped: 'STATUS_CHANGED' })
    expect(await saldo(balanceId)).toBe(0)
    expect(await prisma.creditTransaction.count({ where: { reservationId: reserva.id, type: 'REFUND' } })).toBe(0)

    await prisma.reservation.update({ where: { id: reserva.id }, data: { status: 'NO_SHOW' } })
    const hecha = await refundCreditsForReservation(args)
    expect(hecha).toMatchObject({ creditsRefunded: 1 })
    expect(await saldo(balanceId)).toBe(1)
  })
})
