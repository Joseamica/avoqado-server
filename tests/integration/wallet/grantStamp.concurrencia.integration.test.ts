/**
 * grantStamp bajo concurrencia REAL contra Postgres (auditoría A del plan de sellos tardíos, hallazgo 3, 14-oct-2026).
 *
 * Defecto previo del motor: el tope diario y la elección de cartilla se leían FUERA de la transacción. Dos ventas DISTINTAS
 * del mismo cliente al mismo tiempo podían (a) pasar las dos el tope de «1 sello al día» y (b) caer en la misma cartilla a un
 * sello de completarse: la segunda chocaba con el premio y su sello se perdía como «ya sellado».
 *
 * Las espías FUERZAN el cruce en el código viejo: cada lectura (tope o cartilla) espera a la otra antes de seguir, o sigue sola
 * a los 1.5 s. Con el candado por (negocio, cliente) la segunda venta ni siquiera llega a leer hasta que la primera terminó.
 *
 * Y al final, la guarda B1 de `awardLoyaltyForPaidOrder` (revisión de S3): la corrida del cobro que leyó la venta «sin
 * cliente» no puede cerrar la lealtad si, antes de su cierre, la liga tardía ya hizo commit del cliente (y reabrió la venta).
 */
import '../../__helpers__/integration-setup'
import prisma from '@/utils/prismaClient'

// El aviso al pase y el correo del primer sello son fire-and-forget hacia afuera: aquí no aportan y dejarían trabajo vivo.
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({ notifyCustomerPassUpdated: jest.fn() }))
jest.mock('@/services/wallet/firstStampEmail.service', () => ({ sendFirstStampEmailIfDue: jest.fn() }))

import { grantStamp, reverseStampForOrder } from '@/services/wallet/stampLedger.service'
import { awardLoyaltyForPaidOrder } from '@/services/shared/loyaltyOnPaidOrder'
import { reabrirLealtadSiAplica } from '@/services/shared/loyaltyOnLateCustomer'
import { aTiempo, aparcarLaSiguienteTransaccion, esperarBloqueado } from '@tests/__helpers__/candadosDePostgres'

const sello = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`
let orgId: string | undefined
let venueId: string | undefined
let n = 0

/** Junta las dos llamadas en el mismo punto, o suelta a la que llegó sola a los `ms`. */
function barreraDeDos(ms = 1500): () => Promise<void> {
  let llegadas = 0
  let soltar: () => void = () => undefined
  const juntas = new Promise<void>(resolve => {
    soltar = resolve
  })
  return async () => {
    llegadas += 1
    if (llegadas >= 2) soltar()
    await Promise.race([juntas, new Promise<void>(resolve => setTimeout(resolve, ms).unref())])
  }
}

async function cliente(): Promise<string> {
  return (await prisma.customer.create({ data: { venueId: venueId!, firstName: `Sello ${++n}` } })).id
}

async function venta(extra: { loyaltyEligibleAt?: Date } = {}): Promise<string> {
  const o = await prisma.order.create({
    data: {
      venueId: venueId!,
      orderNumber: `ORD-SELLO-${sello}-${++n}`,
      subtotal: 50,
      taxAmount: 0,
      total: 50,
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      ...extra,
    },
  })
  return o.id
}

async function programa(maxStampsPerDay: number, stampsRequired: number) {
  await prisma.loyaltyConfig.upsert({
    where: { venueId: venueId! },
    create: { venueId: venueId!, active: true, stampsEnabled: true, stampsRequired, maxStampsPerDay, stampRewardLabel: 'Un café gratis' },
    update: { active: true, stampsEnabled: true, stampsRequired, maxStampsPerDay },
  })
}

const earnsDe = (customerId: string) => prisma.stampEvent.count({ where: { venueId, type: 'EARN', stampCard: { customerId } } })

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `ITEST Sellos ${sello}`, email: `itest-sellos-${sello}@test.com`, phone: '5550000000' },
    })
  ).id
  venueId = (
    await prisma.venue.create({
      data: { name: `itest-sellos-${sello}`, slug: `itest-sellos-${sello}`, organizationId: orgId, timezone: 'America/Mexico_City' },
    })
  ).id
})

afterAll(async () => {
  // 🔴 Sin fixture no se limpia NADA: un filtro con venueId undefined borraría tablas enteras.
  if (!venueId || !orgId) return
  await prisma.stampReward.deleteMany({ where: { venueId } })
  await prisma.stampEvent.deleteMany({ where: { venueId } })
  await prisma.stampCard.deleteMany({ where: { venueId } })
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.customer.deleteMany({ where: { venueId } })
  await prisma.loyaltyConfig.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
  await prisma.$disconnect()
})

describe('grantStamp con dos ventas del MISMO cliente al mismo tiempo (Postgres real)', () => {
  it('🔴 tope de 1 al día: UN solo sello; la otra venta dice DAILY_LIMIT_REACHED', async () => {
    await programa(1, 7)
    const c = await cliente()
    await prisma.stampCard.create({ data: { venueId: venueId!, customerId: c, cycle: 1, stampsRequired: 7, stampsEarned: 0 } })
    const o1 = await venta()
    const o2 = await venta()
    const original = prisma.stampEvent.count.bind(prisma.stampEvent)
    const juntarse = barreraDeDos()
    // Código viejo: las dos lecturas del tope (fuera de la transacción) ven 0 antes de que nadie escriba.
    const espia = jest.spyOn(prisma.stampEvent, 'count').mockImplementation((async (args: any) => {
      const r = await original(args)
      await juntarse()
      return r
    }) as never)
    const r = await Promise.all([grantStamp(venueId!, c, o1), grantStamp(venueId!, c, o2)]).finally(() => espia.mockRestore())
    expect(r.filter(x => x.granted)).toHaveLength(1)
    expect(r.filter(x => x.reason === 'DAILY_LIMIT_REACHED')).toHaveLength(1)
    expect(await earnsDe(c)).toBe(1)
  })

  it('🔴 cartilla a UN sello de completarse: un premio, y el segundo sello cae en la cartilla NUEVA (no se pierde)', async () => {
    await programa(0, 2) // sin tope; cartillas de 2
    const c = await cliente()
    await prisma.stampCard.create({ data: { venueId: venueId!, customerId: c, cycle: 1, stampsRequired: 2, stampsEarned: 1 } })
    const o1 = await venta()
    const o2 = await venta()
    const original = prisma.stampCard.findFirst.bind(prisma.stampCard)
    const juntarse = barreraDeDos()
    // Código viejo: las dos eligen la cartilla 1 (fuera de la transacción) antes de que nadie la llene.
    const espia = jest.spyOn(prisma.stampCard, 'findFirst').mockImplementation((async (args: any) => {
      const r = await original(args)
      await juntarse()
      return r
    }) as never)
    const r = await Promise.all([grantStamp(venueId!, c, o1), grantStamp(venueId!, c, o2)]).finally(() => espia.mockRestore())
    expect(r.map(x => x.granted)).toEqual([true, true])
    expect(await prisma.stampReward.count({ where: { venueId, customerId: c } })).toBe(1)
    const cartillas = await prisma.stampCard.findMany({
      where: { venueId, customerId: c },
      orderBy: { cycle: 'asc' },
      select: { cycle: true, stampsEarned: true, completedAt: true },
      take: 5,
    })
    expect(cartillas).toEqual([
      { cycle: 1, stampsEarned: 2, completedAt: expect.any(Date) },
      { cycle: 2, stampsEarned: 1, completedAt: null },
    ])
    expect(await earnsDe(c)).toBe(2)
  })
})

// ── B1 (revisión de S3, 14-oct): el cierre de la corrida que leyó «sin cliente» lleva `orderCustomers: { none: {} }` ──────
//
// Aquí se prueba el orden SIMPLE: la liga hace commit ENTRE la lectura de clientes de la corrida y su cierre. El cruce exacto
// (el cierre esperando el candado de fila que tiene la transacción de la liga) NO lo cubre esta guarda: medido el 14-oct en una
// base desechable, el cierre (un solo `UPDATE … AND NOT EXISTS(SELECT … FROM "OrderCustomer" …)`) espera el candado y, al
// soltarse, CIERRA la venta igual —con o sin `Order.customerId` escrito por la liga—, porque la subconsulta no ve la fila que
// llegó después de su foto. Lo cubre la condición de fila que agrega la tarea siguiente (S4).
describe('B1: la corrida del cobro que leyó «sin cliente» no cierra una venta que ya tiene cliente (Postgres real)', () => {
  it('🔴 la liga hace commit entre la lectura y el cierre: loyaltyProcessedAt sigue en null (el reconciliador la ve)', async () => {
    const c = await cliente()
    const orderId = await venta({ loyaltyEligibleAt: new Date(Date.now() - 60_000) })
    const original = prisma.orderCustomer.findMany.bind(prisma.orderCustomer)
    let reabrio: boolean | undefined
    const espia = jest.spyOn(prisma.orderCustomer, 'findMany').mockImplementation((async (args: any) => {
      // La corrida del cobro lee los clientes de la venta: ninguno todavía.
      const leidos = await original(args)
      if (reabrio === undefined) {
        // …y antes de que cierre, el barista liga al cliente: la liga y su reapertura hacen commit en UNA transacción.
        reabrio = await prisma.$transaction(async tx => {
          await tx.orderCustomer.create({ data: { orderId, customerId: c, isPrimary: true } })
          return reabrirLealtadSiAplica(tx, { venueId: venueId!, orderId, customerId: c })
        })
      }
      return leidos
    }) as never)

    const r = await awardLoyaltyForPaidOrder({ venueId: venueId!, orderId, orderTotal: 50 }).finally(() => espia.mockRestore())

    expect(r).toEqual({ complete: true, errors: [] })
    expect(reabrio).toBe(true)
    const fila = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { loyaltyProcessedAt: true, loyaltyEligibleAt: true },
    })
    // Si el cierre viejo pasara, la venta quedaría «procesada» sin sello y el reconciliador nunca volvería a verla.
    expect(fila.loyaltyProcessedAt).toBeNull()
    expect(fila.loyaltyEligibleAt).not.toBeNull()
  })

  it('regresión: la venta que SIGUE sin cliente sí se cierra (la guarda no deja colgada una venta de mostrador)', async () => {
    const orderId = await venta({ loyaltyEligibleAt: new Date(Date.now() - 60_000) })

    const r = await awardLoyaltyForPaidOrder({ venueId: venueId!, orderId, orderTotal: 50 })

    expect(r).toEqual({ complete: true, errors: [] })
    const fila = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { loyaltyProcessedAt: true } })
    expect(fila.loyaltyProcessedAt).toBeInstanceOf(Date)
  })
})

// ── Ola final del servidor (rulings del código, 15-oct-2026) ────────────────────────────────────────────────────────────────
//
// Estos cruces NO dependen de tiempos: la primera transacción se APARCA con sus candados tomados (antes del commit) y la prueba
// OBSERVA en `pg_stat_activity` / `pg_blocking_pids` a la segunda esperándola, antes de soltarla.

describe('F2: la MISMA venta dos veces a la vez — la segunda dice ALREADY_STAMPED, no un DAILY_LIMIT engañoso (Postgres real)', () => {
  it('🔴 la segunda espera el candado del cliente y, al entrar, ve el sello de SU orden antes que el tope del día', async () => {
    await programa(1, 7) // tope 1 al día: sin la relectura, la segunda leería «ya tuvo su sello de hoy»
    const c = await cliente()
    const o = await venta()
    const aparcada = aparcarLaSiguienteTransaccion(prisma)
    let primera: Promise<Awaited<ReturnType<typeof grantStamp>>> | undefined
    let segunda: Promise<Awaited<ReturnType<typeof grantStamp>>> | undefined
    try {
      primera = grantStamp(venueId!, c, o)
      const pidPrimera = await aTiempo(aparcada.pid, 8_000, 'la primera no llegó al commit')
      // La segunda pasa el atajo de afuera (la primera aún no hace commit) y se forma en el candado (negocio, cliente).
      segunda = grantStamp(venueId!, c, o)
      const espera = await esperarBloqueado(prisma, { bloqueadoPor: [pidPrimera], consulta: /pg_advisory_xact_lock/ })
      expect(espera).toMatchObject({ waitEvent: 'advisory' })
    } finally {
      aparcada.soltar()
      aparcada.restaurar()
    }
    const [r1, r2] = await Promise.all([primera!, segunda!])
    expect(r1.granted).toBe(true)
    expect(r2).toMatchObject({ granted: false, reason: 'ALREADY_STAMPED' })
    expect(await earnsDe(c)).toBe(1)
  })
})

describe('H3: la reversión toma el MISMO candado (negocio, cliente) que el otorgamiento (Postgres real)', () => {
  it('🔴 otra venta completa la cartilla mientras se revierte un sello: la reversión espera, ve la cartilla completa y deja todo cuadrado', async () => {
    await programa(0, 3) // sin tope; cartillas de 3
    const c = await cliente()
    await prisma.stampCard.create({ data: { venueId: venueId!, customerId: c, cycle: 1, stampsRequired: 3, stampsEarned: 0 } })
    const [o1, o2, o3] = [await venta(), await venta(), await venta()]
    expect((await grantStamp(venueId!, c, o1)).granted).toBe(true)
    expect((await grantStamp(venueId!, c, o2)).granted).toBe(true) // 2 de 3

    // La tercera venta COMPLETA la cartilla (premio + cartilla nueva) y se queda con sus candados, sin commit.
    const aparcada = aparcarLaSiguienteTransaccion(prisma)
    let otorgar: Promise<Awaited<ReturnType<typeof grantStamp>>> | undefined
    let revertir: Promise<Awaited<ReturnType<typeof reverseStampForOrder>>> | undefined
    let espera: Awaited<ReturnType<typeof esperarBloqueado>> = null
    try {
      otorgar = grantStamp(venueId!, c, o3)
      const pidOtorgar = await aTiempo(aparcada.pid, 8_000, 'el otorgamiento no llegó al commit')
      // Se reembolsa o1 justo entonces. Sin el candado, la reversión leía la cartilla en 2/3 (abierta), restaba sobre la
      // cartilla que la otra venta ya había completado y dejaba «2 de 3 y un premio pendiente».
      revertir = reverseStampForOrder(venueId!, o1)
      espera = await esperarBloqueado(prisma, { bloqueadoPor: [pidOtorgar], consulta: /./ })
    } finally {
      aparcada.soltar()
      aparcada.restaurar()
    }
    const [otorgado, revertido] = await Promise.all([otorgar!, revertir!])
    // La reversión esperó el candado de ASESORÍA del cliente (no una fila a media escritura).
    expect(espera).toMatchObject({ waitEvent: 'advisory' })
    expect(otorgado).toMatchObject({ granted: true, completed: true })
    expect(revertido.reversed).toBe(true)

    const cartillas = await prisma.stampCard.findMany({
      where: { venueId, customerId: c },
      orderBy: { cycle: 'asc' },
      select: { cycle: true, stampsEarned: true, completedAt: true },
      take: 5,
    })
    // El premio de una cartilla que ya no está completa se cancela, la cartilla vuelve a 2 de 3 y la nueva (vacía) se va.
    expect(cartillas).toEqual([{ cycle: 1, stampsEarned: 2, completedAt: null }])
    expect(await prisma.stampReward.count({ where: { venueId, customerId: c, status: 'PENDING' } })).toBe(0)
    expect(await prisma.stampReward.count({ where: { venueId, customerId: c, status: 'CANCELLED' } })).toBe(1)
  })
})
