/**
 * Integration (REAL DB) — hz:fefa11b6:D20, bloque 0a: registrar la llegada de una reserva YA pagada con créditos de paquete
 * (normal o Ilimitado) no abre una cuenta a precio de lista que se pueda cobrar otra vez.
 *
 * Antes: la cuenta nacía PENDIENTE al precio del catálogo, salía en «Sin cobrar» y la caja podía cobrar la clase dos veces.
 * Ahora: los lugares pagados con crédito van en $0 («Pagada con paquete»); la cuenta sigue abierta (se le pueden agregar extras).
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test'

import '../../__helpers__/integration-setup'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { checkInReservationAndOpenOrder, type CheckInActor } from '@/services/reservation/checkIn.service'
import { sqlLateralDeLaCuenta } from '@/services/dashboard/salesSummaryPoblacion'

const RUN = Date.now()

describe('D20 0a — check-in de una reserva ya pagada (integration, real DB)', () => {
  let orgId: string | undefined
  let venueId: string | undefined
  let staffId: string | undefined
  let actor: CheckInActor
  let yogaId: string
  let customerId: string
  let packId: string

  const mkReservation = async (extra: Partial<Prisma.ReservationUncheckedCreateInput> = {}) =>
    prisma.reservation.create({
      data: {
        venueId: venueId!,
        confirmationCode: `ITEST-PAG-${RUN}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
        startsAt: new Date(Date.now() + 3600_000),
        endsAt: new Date(Date.now() + 7200_000),
        blockedEndsAt: new Date(Date.now() + 7200_000),
        duration: 60,
        status: 'CONFIRMED',
        productId: yogaId,
        customerId,
        guestName: 'Ana',
        statusLog: [{ status: 'CONFIRMED', at: new Date().toISOString(), by: null }],
        ...extra,
      },
    })

  /** Una compra de paquete con un saldo de yoga (normal o Ilimitado) y su canje para la reserva. */
  const pagarConPaquete = async (
    reservationId: string,
    opts: { unlimited?: boolean; creditos?: number; compraReembolsada?: boolean } = {},
  ) => {
    const purchase = await prisma.creditPackPurchase.create({
      data: {
        venueId: venueId!,
        customerId,
        creditPackId: packId,
        amountPaid: new Prisma.Decimal(1000),
        status: opts.compraReembolsada ? 'REFUNDED' : 'ACTIVE',
      },
    })
    const balance = await prisma.creditItemBalance.create({
      data: {
        creditPackPurchaseId: purchase.id,
        productId: yogaId,
        originalQuantity: opts.unlimited ? 99999 : 5,
        remainingQuantity: opts.unlimited ? 99998 : 4,
        unlimited: opts.unlimited === true,
      },
    })
    await prisma.creditTransaction.create({
      data: {
        venueId: venueId!,
        customerId,
        creditPackPurchaseId: purchase.id,
        creditItemBalanceId: balance.id,
        type: 'REDEEM',
        quantity: -(opts.creditos ?? 1),
        reservationId,
      },
    })
    return { purchase, balance }
  }

  const llegada = (reservationId: string) =>
    checkInReservationAndOpenOrder({ reservationId, venueId: venueId!, actor, source: 'DASHBOARD', now: new Date() })

  const cuentaDe = async (orderId: string) => {
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { items: { orderBy: { sequence: 'asc' }, include: { modifiers: true } } },
    })
    // «Sin cobrar» cuenta las cuentas abiertas que todavía deben algo (`sales-summary.dashboard.service.ts`, conteo `cuentas`).
    const [fila] = await prisma.$queryRawUnsafe<Array<{ sin_cobrar: boolean; falta: Prisma.Decimal }>>(
      `SELECT (cuenta.abierta AND NOT cuenta.es_venta AND cuenta.falta > 0.005) AS sin_cobrar, cuenta.falta FROM "Order" o ${sqlLateralDeLaCuenta('o')} WHERE o.id = $1`,
      orderId,
    )
    return { order, sinCobrar: fila.sin_cobrar, falta: Number(fila.falta) }
  }

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: 'ITEST PAG Org', email: `itest-pag-${RUN}@test.com`, phone: '5550000000' },
    })
    orgId = org.id
    const venue = await prisma.venue.create({
      data: {
        name: 'ITEST PAG Venue',
        slug: `itest-pag-${RUN}`,
        organizationId: org.id,
        address: 'X',
        city: 'X',
        state: 'X',
        country: 'MX',
        zipCode: '00000',
        timezone: 'America/Mexico_City',
      },
    })
    venueId = venue.id
    const staff = await prisma.staff.create({ data: { email: `recep-pag-${RUN}@test.com`, firstName: 'Recepción', lastName: 'ITEST' } })
    staffId = staff.id
    actor = { type: 'HUMAN', staffId: staff.id }
    const category = await prisma.menuCategory.create({ data: { venueId: venue.id, name: 'Clases', slug: `clases-pag-${RUN}` } })
    const yoga = await prisma.product.create({
      data: { venueId: venue.id, sku: `PAG-${RUN}`, name: 'Yoga', categoryId: category.id, price: new Prisma.Decimal(200) },
    })
    yogaId = yoga.id
    customerId = (await prisma.customer.create({ data: { venueId: venue.id, firstName: 'Ana' }, select: { id: true } })).id
    packId = (
      await prisma.creditPack.create({
        data: {
          venueId: venue.id,
          name: '5 clases',
          price: new Prisma.Decimal(1000),
          validityDays: 30,
          items: { create: [{ productId: yoga.id, quantity: 5 }] },
        },
        select: { id: true },
      })
    ).id
  })

  afterAll(async () => {
    const step = (fn: () => Promise<unknown>) => fn().catch(() => {})
    if (venueId) {
      await step(() => prisma.creditTransaction.deleteMany({ where: { venueId } }))
      await step(() => prisma.creditItemBalance.deleteMany({ where: { creditPackPurchase: { venueId } } }))
      await step(() => prisma.creditPackPurchase.deleteMany({ where: { venueId } }))
      await step(() => prisma.orderItemModifier.deleteMany({ where: { orderItem: { order: { venueId } } } }))
      await step(() => prisma.orderItem.deleteMany({ where: { order: { venueId } } }))
      await step(() => prisma.order.deleteMany({ where: { venueId } }))
      await step(() => prisma.activityLog.deleteMany({ where: { venueId } }))
      await step(() => prisma.reservationModifier.deleteMany({ where: { reservation: { venueId } } }))
      await step(() => prisma.reservation.deleteMany({ where: { venueId } }))
      await step(() => prisma.creditPackItem.deleteMany({ where: { creditPack: { venueId } } }))
      await step(() => prisma.creditPack.deleteMany({ where: { venueId } }))
      await step(() => prisma.customer.deleteMany({ where: { venueId } }))
      await step(() => prisma.product.deleteMany({ where: { venueId } }))
      await step(() => prisma.menuCategory.deleteMany({ where: { venueId } }))
      await step(() => prisma.venue.deleteMany({ where: { id: venueId } }))
    }
    if (staffId) await step(() => prisma.staff.deleteMany({ where: { id: staffId } }))
    if (orgId) await step(() => prisma.organization.deleteMany({ where: { id: orgId } }))
  })

  it('🔴 clase pagada con 1 crédito: la cuenta nace con saldo $0, con su nota, y NO sale en «Sin cobrar»', async () => {
    const r = await mkReservation()
    await pagarConPaquete(r.id)

    const res = await llegada(r.id)
    expect(res.orderId).toBeTruthy()
    const { order, sinCobrar, falta } = await cuentaDe(res.orderId!)

    expect(Number(order.total)).toBe(0)
    expect(Number(order.remainingBalance)).toBe(0)
    // Sigue abierta (Codex 0-r1 #4-#6, #9): se le puede agregar un extra; deshacer la llegada no deja una venta.
    expect(order.paymentStatus).toBe('PENDING')
    expect(order.status).toBe('PENDING')
    expect(order.items).toHaveLength(1)
    expect(order.items[0]).toEqual(expect.objectContaining({ quantity: 1, notes: 'Pagada con paquete' }))
    expect(Number(order.items[0].unitPrice)).toBe(0)
    expect(Number(order.items[0].total)).toBe(0)
    expect(sinCobrar).toBe(false)
    expect(falta).toBe(0)
    const rastro = await prisma.activityLog.findFirst({
      where: { venueId, entityId: order.id, action: 'RESERVATION_ORDER_PREPAID_APPLIED' },
    })
    expect(rastro?.data).toEqual(expect.objectContaining({ reservationId: r.id, creditsApplied: 1, total: '0.00' }))

    // Idempotente: otra llegada devuelve la MISMA cuenta.
    const otra = await llegada(r.id)
    expect(otra.orderId).toBe(res.orderId)
  })

  it('🔴 Ilimitado: el mismo REDEEM −1 cubre la clase (sin leer sus 99,999)', async () => {
    const r = await mkReservation()
    await pagarConPaquete(r.id, { unlimited: true })

    const { order, sinCobrar } = await cuentaDe((await llegada(r.id)).orderId!)
    expect(Number(order.total)).toBe(0)
    expect(order.items[0].notes).toBe('Pagada con paquete')
    expect(sinCobrar).toBe(false)
  })

  it('canje + devolución (canceló a tiempo y aun así llega): NO está pagada, la cuenta es a precio de lista', async () => {
    const r = await mkReservation()
    const { purchase, balance } = await pagarConPaquete(r.id)
    await prisma.creditTransaction.create({
      data: {
        venueId: venueId!,
        customerId,
        creditPackPurchaseId: purchase.id,
        creditItemBalanceId: balance.id,
        type: 'REFUND',
        quantity: 1,
        reservationId: r.id,
        reason: 'Cancellation refund — policy: ALWAYS',
      },
    })

    const { order, sinCobrar, falta } = await cuentaDe((await llegada(r.id)).orderId!)
    expect(Number(order.total)).toBe(200)
    expect(order.paymentStatus).toBe('PENDING')
    expect(order.items[0].notes).toBeNull()
    expect(sinCobrar).toBe(true)
    expect(falta).toBe(200)
  })

  it('Ilimitado con su marca de cancelación tardía (REFUND 0): sigue cubierta', async () => {
    const r = await mkReservation()
    const { purchase, balance } = await pagarConPaquete(r.id, { unlimited: true })
    await prisma.creditTransaction.create({
      data: {
        venueId: venueId!,
        customerId,
        creditPackPurchaseId: purchase.id,
        creditItemBalanceId: balance.id,
        type: 'REFUND',
        quantity: 0,
        reservationId: r.id,
        reason: 'Cancellation refund — policy: TIME_BASED:late (0%) · ilimitado: cancelación tardía',
      },
    })
    const { order } = await cuentaDe((await llegada(r.id)).orderId!)
    expect(Number(order.total)).toBe(0)
  })

  it('2 lugares y 1 crédito: 1 lugar en $0 y 1 a precio lleno ($200 por cobrar)', async () => {
    const r = await mkReservation({ partySize: 2 })
    await pagarConPaquete(r.id)

    const { order, sinCobrar, falta } = await cuentaDe((await llegada(r.id)).orderId!)
    expect(Number(order.total)).toBe(200)
    expect(order.paymentStatus).toBe('PENDING')
    expect(order.items.map(i => [i.quantity, Number(i.unitPrice), i.notes])).toEqual([
      [1, 0, 'Pagada con paquete'],
      [1, 200, null],
    ])
    expect(sinCobrar).toBe(true)
    expect(falta).toBe(200)
  })

  it('con un extra de $50: sólo queda el extra por cobrar', async () => {
    const r = await mkReservation()
    await prisma.reservationModifier.create({ data: { reservationId: r.id, productId: yogaId, name: 'Tapete', quantity: 1, price: 50 } })
    await pagarConPaquete(r.id)

    const { order, falta } = await cuentaDe((await llegada(r.id)).orderId!)
    expect(Number(order.total)).toBe(50)
    expect(order.paymentStatus).toBe('PENDING')
    expect(order.items).toHaveLength(1)
    expect(order.items[0].modifiers.map(m => Number(m.price))).toEqual([50])
    // El renglón de $0 lleva sus extras en el total: la factura no lo omite aunque la caja cobre $50 (Codex 0-r1 #8).
    expect(Number(order.items[0].total)).toBe(50)
    expect(falta).toBe(50)
  })

  it('2 lugares, 1 crédito y un extra de $50 por lugar: el extra va en el lugar que se cobra', async () => {
    const r = await mkReservation({ partySize: 2 })
    await prisma.reservationModifier.create({ data: { reservationId: r.id, productId: yogaId, name: 'Tapete', quantity: 1, price: 50 } })
    await pagarConPaquete(r.id)

    const { order, falta } = await cuentaDe((await llegada(r.id)).orderId!)
    expect(Number(order.total)).toBe(300) // un lugar de $200 + 2 tapetes de $50
    expect(order.items.map(i => [i.quantity, Number(i.unitPrice), i.modifiers.length])).toEqual([
      [1, 0, 0],
      [1, 200, 1],
    ])
    expect(falta).toBe(300)
  })

  it('3 lugares, 3 canjes y 1 devolución: cubren 2', async () => {
    const r = await mkReservation({ partySize: 3 })
    const { purchase, balance } = await pagarConPaquete(r.id, { creditos: 3 })
    await prisma.creditTransaction.create({
      data: {
        venueId: venueId!,
        customerId,
        creditPackPurchaseId: purchase.id,
        creditItemBalanceId: balance.id,
        type: 'REFUND',
        quantity: 1,
        reservationId: r.id,
      },
    })
    const { order } = await cuentaDe((await llegada(r.id)).orderId!)
    expect(order.items.map(i => [i.quantity, Number(i.unitPrice)])).toEqual([
      [2, 0],
      [1, 200],
    ])
    expect(Number(order.total)).toBe(200)
  })

  it('un canje ya hecho cubre aunque después marquen la compra «reembolsada» (la marca sólo anula lo que quedaba)', async () => {
    const r = await mkReservation()
    await pagarConPaquete(r.id, { compraReembolsada: true })
    const { order } = await cuentaDe((await llegada(r.id)).orderId!)
    expect(Number(order.total)).toBe(0)
  })

  it('regresión: el depósito en línea NO se aplica en este bloque (la cuenta queda como hoy)', async () => {
    const r = await mkReservation({ depositAmount: new Prisma.Decimal(80), depositStatus: 'PAID', depositPaidAt: new Date() })
    const { order } = await cuentaDe((await llegada(r.id)).orderId!)
    expect(Number(order.total)).toBe(200)
    expect(order.items[0].notes).toBeNull()
  })

  it('regresión: reserva sin nada pagado sigue igual (PENDIENTE a precio de lista, sin rastro de prepago)', async () => {
    const r = await mkReservation()
    const res = await llegada(r.id)
    const { order, sinCobrar } = await cuentaDe(res.orderId!)
    expect(Number(order.total)).toBe(200)
    expect(order.paymentStatus).toBe('PENDING')
    expect(order.status).toBe('PENDING')
    expect(sinCobrar).toBe(true)
    expect(await prisma.activityLog.count({ where: { venueId, entityId: order.id, action: 'RESERVATION_ORDER_PREPAID_APPLIED' } })).toBe(0)
  })
})
