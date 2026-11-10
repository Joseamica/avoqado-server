/**
 * S13 (P2-6): «Mi cuenta» contra Postgres REAL.
 *  - Paga en caja y, al releer «Mi cuenta», ve su sello nuevo y el premio gastado (cadena real: premio → cobro en efectivo → sello).
 *  - R3: los descuentos vigentes por la INTERSECCIÓN de fechas de la asignación y del catálogo, asignados y de su grupo, una vez cada uno.
 *  - Aislamiento: nada de otra clienta ni de otra sucursal; el saldo a favor va aparte y no ocupa lugar en «tarjetas».
 *  - R5': el costo MEDIDO con `EXPLAIN (ANALYZE, BUFFERS)` de la consulta real, con una clienta de 10,000 pedidos en línea y 500
 *    tarjetas en un negocio con otras 100,000 órdenes: primera página y una profunda, ≤ 50 ms y sin recorrer filas de otras clientas.
 */
import cuid from 'cuid'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  socketManager: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn(), broadcastToUser: jest.fn() },
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn(), broadcastToUser: jest.fn() },
}))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn(async () => undefined) }))
jest.mock('@/services/tpv/digitalReceipt.tpv.service', () => ({ generateDigitalReceipt: jest.fn(async () => null) }))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn(),
  reintentarAvisosDeTarjeta: jest.fn().mockResolvedValue({ avisados: 0, fallidos: 0, ocupados: 0 }),
}))
jest.mock('@/services/wallet/firstStampEmail.service', () => ({ sendFirstStampEmailIfDue: jest.fn() }))
jest.mock('@/services/kds/kitchenTicketAuthoring.service', () => ({
  ...jest.requireActual('@/services/kds/kitchenTicketAuthoring.service'),
  armarComandasTrasCommit: jest.fn(),
}))
jest.mock('@/services/online-ordering/notifications.service', () => ({ notifyOrderEvent: jest.fn() }))
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn() }))

import { LoyaltyReconciliationJob } from '@/jobs/loyalty-reconciliation.job'
import { payCashOrder } from '@/services/mobile/order.mobile.service'
import { redeemStampReward } from '@/services/wallet/redeemStampReward.service'
import { fromActiveCursor, toActiveCursor } from '@/services/online-ordering/inbox.service'
import {
  getCustomerPortal,
  listarMisDescuentos,
  listarMisPedidos,
  listarMisTarjetas,
  sqlDeDescuentos,
  sqlDePedidos,
  sqlDeTarjetas,
  sqlDeTotalDeDescuentos,
  sqlDeTotalDePedidos,
  sqlDeTotalDeTarjetas,
} from '@/services/public/customerPortal.public.service'

jest.setTimeout(300000)

const run = cuid()
const D = (v: number) => new Prisma.Decimal(v)
const DIA = 86_400_000
let orgId: string
let venueId: string
let otroVenueId: string
let staffId: string
let n = 0

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: run, email: `${run}@example.test`, phone: '5550000000' } })).id
  venueId = (
    await prisma.venue.create({
      data: { organizationId: orgId, name: run, slug: run, status: 'LIVE_DEMO', timezone: 'America/Mexico_City' },
    })
  ).id
  otroVenueId = (await prisma.venue.create({ data: { organizationId: orgId, name: `${run}-b`, slug: `${run}-b` } })).id
  staffId = (
    await prisma.staff.create({
      data: { email: `${run}-staff@example.test`, firstName: 'Caja', lastName: 'S13', venues: { create: { venueId, role: 'MANAGER' } } },
    })
  ).id
  await prisma.terminal.create({ data: { venueId, name: 'TPV de S13', serialNumber: `AVQD-${cuid()}`, type: 'TPV_ANDROID' } })
  await prisma.loyaltyConfig.create({
    data: { venueId, active: true, pointsPerDollar: 1, stampsEnabled: true, stampsRequired: 3, maxStampsPerDay: 5, redemptionRate: 0.5 },
  })
})

afterAll(async () => {
  for (const v of [venueId, otroVenueId, perf.venueId].filter(Boolean) as string[]) {
    await prisma.walletPassOutbox.deleteMany({ where: { venueId: v } })
    await prisma.paymentEffect.deleteMany({ where: { venueId: v } })
    await prisma.paymentAllocation.deleteMany({ where: { order: { venueId: v } } })
    await prisma.payment.deleteMany({ where: { venueId: v } })
    await prisma.stampEvent.deleteMany({ where: { venueId: v } })
    await prisma.customerOrderMetric.deleteMany({ where: { venueId: v } })
    await prisma.loyaltyTransaction.deleteMany({ where: { customer: { venueId: v } } })
    await prisma.onlineOrder.deleteMany({ where: { venueId: v } })
    await prisma.order.deleteMany({ where: { venueId: v } })
  }
})

async function clienta(nombre: string, extra: Partial<Prisma.CustomerUncheckedCreateInput> = {}, enVenue = venueId) {
  n += 1
  return prisma.customer.create({
    data: { venueId: enVenue, firstName: nombre, phone: `+5255${String(20000000 + n * 7919).slice(0, 8)}`, ...extra },
  })
}

async function folio(customerId: string, o: { pagado?: boolean; enVenue?: string; online?: boolean } = {}) {
  n += 1
  const v = o.enVenue ?? venueId
  const orden = await prisma.order.create({
    data: {
      venueId: v,
      orderNumber: `F${n}-${run.slice(-6)}`,
      source: 'WEB',
      type: 'PICKUP',
      customerId,
      subtotal: D(100),
      taxAmount: D(0),
      total: D(100),
      remainingBalance: D(o.pagado ? 0 : 100),
      paidAmount: D(o.pagado ? 100 : 0),
      paymentStatus: o.pagado ? 'PAID' : 'PENDING',
      status: o.pagado ? 'COMPLETED' : 'PENDING',
      items: { create: [{ productName: 'Café', quantity: 1, unitPrice: D(100), taxAmount: D(0), total: D(100) }] },
    },
  })
  if (o.online !== false) {
    await prisma.onlineOrder.create({
      data: {
        venueId: v,
        orderId: orden.id,
        trackingToken: cuid(),
        paymentMode: 'PAY_AT_PICKUP',
        requiresAcceptance: false,
        status: o.pagado ? 'COMPLETED' : 'PENDING_ACCEPTANCE',
        acceptDeadlineAt: new Date(Date.now() + 30 * 60_000),
      },
    })
  }
  return orden
}

async function tarjetaDe(customerId: string | null, o: { enVenue?: string; saldoAFavor?: boolean; saldo?: number } = {}) {
  n += 1
  const s = await prisma.giftCard.create({
    data: {
      venueId: o.enVenue ?? venueId,
      organizationId: orgId,
      codeHash: `h-${cuid()}`,
      codeEnc: 'x',
      codeLast4: String(1000 + n).slice(-4),
      pageToken: `p-${cuid()}`,
      initialAmount: D(o.saldo ?? 100),
      balance: D(o.saldo ?? 100),
      status: 'ACTIVE',
      activatedAt: new Date(),
      termsVersion: '2026-10-14',
      deliveryChannel: o.saldoAFavor ? 'WHATSAPP' : 'PRINTED',
      customerId,
    },
  })
  await prisma.giftCardActivity.create({
    data: {
      giftCardId: s.id,
      venueId: o.enVenue ?? venueId,
      type: 'ACTIVATE',
      amount: D(o.saldo ?? 100),
      balanceAfter: D(o.saldo ?? 100),
      // El saldo a favor nace de una devolución (EL predicado: ACTIVATE con refundPaymentId).
      ...(o.saldoAFavor ? { refundPaymentId: cuid() } : {}),
    },
  })
  return s
}

function recuperador(orderId: string) {
  const scoped = (a: any) => ({ ...a, where: { AND: [a.where, { id: orderId, venueId }] } })
  return new LoyaltyReconciliationJob({
    prisma: {
      ...prisma,
      order: {
        ...prisma.order,
        findMany: (a: any) => prisma.order.findMany(scoped(a)),
        updateMany: (a: any) => prisma.order.updateMany(scoped(a)),
      },
    } as unknown as typeof prisma,
    cron: { start: jest.fn(), stop: jest.fn() } as any,
    barrerCupones: async () => 0,
  })
}

const sinContacto = { contactos: [], tipo: 'SESION' as const }

describe('«Mi cuenta» se relee después de pagar en caja', () => {
  it('paga en caja y al releer «Mi cuenta» ve su sello nuevo y el premio gastado', async () => {
    const ana = await clienta('Ana Caja')
    const cartilla = await prisma.stampCard.create({
      data: { customerId: ana.id, venueId, cycle: 1, stampsRequired: 3, stampsEarned: 3, completedAt: new Date() },
    })
    const premio = await prisma.stampReward.create({
      data: {
        stampCardId: cartilla.id,
        customerId: ana.id,
        venueId,
        rewardType: 'FIXED_AMOUNT',
        rewardValue: 30,
        rewardLabel: 'Café gratis',
      },
    })
    const antes: any = await getCustomerPortal(venueId, ana.id, sinContacto)
    expect(antes.premioDisponible).toEqual({ id: premio.id, etiqueta: 'Café gratis' })
    expect(antes.stampCard).toMatchObject({ enabled: true, stampsEarned: 0, stampsRequired: 3 })
    expect(antes.puntos).toEqual({ saldo: 0, valor: 0 })

    const orden = await folio(ana.id, { online: false })
    await redeemStampReward(venueId, orden.id, premio.id, { staffId })
    const porCobrar = (await prisma.order.findUniqueOrThrow({ where: { id: orden.id } })).remainingBalance
    expect(porCobrar.toFixed(2)).toBe('70.00')
    await payCashOrder(venueId, orden.id, { amount: 7000, tip: 0, staffId, idempotencyKey: cuid() })
    await recuperador(orden.id).runNow()
    await recuperador(orden.id).runNow()

    const despues: any = await getCustomerPortal(venueId, ana.id, sinContacto)
    expect(despues.premioDisponible).toBeNull()
    expect(despues.stampCard).toMatchObject({ enabled: true, stampsEarned: 1 })
    expect(despues.puntos.saldo).toBeGreaterThan(0)
    expect(despues.puntos.valor).toBe(Math.round(despues.puntos.saldo * 0.5 * 100) / 100)
  })
})

describe('R3 · descuentos con la vigencia de la asignación Y del catálogo', () => {
  it('asignados y de su grupo, vigentes hoy, una vez cada uno, con la fecha que de verdad vence', async () => {
    const grupo = await prisma.customerGroup.create({ data: { venueId, name: `VIP-${run}` } })
    const ana = await clienta('Ana Desc', { customerGroupId: grupo.id })
    const bety = await clienta('Bety Desc')
    const ahora = Date.now()
    const desc = (nombre: string, extra: Partial<Prisma.DiscountUncheckedCreateInput> = {}) =>
      prisma.discount.create({ data: { venueId, name: `${nombre}-${run}`, type: 'PERCENTAGE', value: 10, ...extra } })
    const asignar = (customerId: string, discountId: string, extra: Partial<Prisma.CustomerDiscountUncheckedCreateInput> = {}) =>
      prisma.customerDiscount.create({ data: { customerId, discountId, ...extra } })

    const catalogoVencido = await desc('catalogo-vencido', { validUntil: new Date(ahora - DIA) })
    await asignar(ana.id, catalogoVencido.id) // la asignación sin fechas NO revive un catálogo vencido
    const venceAntes = await desc('vence-antes', { validUntil: new Date(ahora + 30 * DIA) })
    const fechaDeAsignacion = new Date(ahora + 5 * DIA)
    await asignar(ana.id, venceAntes.id, { validUntil: fechaDeAsignacion })
    await desc('de-grupo', { customerGroupId: grupo.id })
    const porLosDos = await desc('por-los-dos', { customerGroupId: grupo.id })
    await asignar(ana.id, porLosDos.id, { validUntil: new Date(ahora + 2 * DIA) })
    const inactiva = await desc('asignacion-inactiva')
    await asignar(ana.id, inactiva.id, { active: false })
    const agotado = await desc('agotado', { maxTotalUses: 1, currentUses: 1 })
    await asignar(ana.id, agotado.id)
    const futura = await desc('asignacion-futura')
    await asignar(ana.id, futura.id, { validFrom: new Date(ahora + DIA) })
    const deOtra = await desc('de-otra')
    await asignar(bety.id, deOtra.id)
    const usado = await desc('usos-por-clienta', { customerGroupId: grupo.id, maxUsesPerCustomer: 1 })
    const yaUsado = await folio(ana.id, { online: false })
    await prisma.orderDiscount.create({
      data: { orderId: yaUsado.id, discountId: usado.id, name: 'usado', type: 'PERCENTAGE', value: 10, amount: 10 },
    })

    // codex-s13-r2 #2: el catálogo permite 1 uso por clienta y ella ya lo usó; su asignación SIN límite propio lo hereda ⇒ agotado.
    const heredaLimite = await desc('hereda-limite', { maxUsesPerCustomer: 1 })
    await asignar(ana.id, heredaLimite.id)
    // …y con límite propio (el override del esquema) manda la asignación: 1 de 5 usos ⇒ sigue vigente.
    const overrideManda = await desc('override-manda', { maxUsesPerCustomer: 1 })
    await asignar(ana.id, overrideManda.id, { maxUses: 5, usageCount: 1 })
    for (const discountId of [heredaLimite.id, overrideManda.id]) {
      const o = await folio(ana.id, { online: false })
      await prisma.orderDiscount.create({ data: { orderId: o.id, discountId, name: 'usado', type: 'PERCENTAGE', value: 10, amount: 10 } })
    }

    const r = await listarMisDescuentos(venueId, ana.id, {})
    const porNombre = new Map(r.items.map(i => [i.nombre.replace(`-${run}`, ''), i.vigenteHasta]))
    expect([...porNombre.keys()].sort()).toEqual(['de-grupo', 'override-manda', 'por-los-dos', 'vence-antes'])
    expect(porNombre.get('vence-antes')).toBe(fechaDeAsignacion.toISOString())
    expect(porNombre.get('de-grupo')).toBeNull()
    expect(porNombre.get('por-los-dos')).toBeNull() // por su grupo no vence: gana la vigencia más larga
    expect(r.total).toBe(4)
    expect(r.items[0]).toMatchObject({ tipo: 'PERCENTAGE', valor: 10 })
    expect((await listarMisDescuentos(venueId, bety.id, {})).items.map(i => i.nombre)).toEqual([`de-otra-${run}`])

    // Paginación: 1 por página recorre las tres sin repetir.
    const vistos: string[] = []
    let cursor: string | undefined
    do {
      const p = await listarMisDescuentos(venueId, ana.id, { limit: 1, cursor })
      vistos.push(...p.items.map(i => i.nombre))
      cursor = p.nextCursor ?? undefined
    } while (cursor)
    expect(vistos.sort()).toEqual(r.items.map(i => i.nombre).sort())
  })
})

describe('Aislamiento y saldo a favor aparte', () => {
  it('sus pedidos y sus tarjetas, nunca los de otra clienta ni los de otra sucursal; el saldo a favor no ocupa lugar', async () => {
    const ana = await clienta('Ana Sola')
    const bety = await clienta('Bety Sola')
    const pagado = await folio(ana.id, { pagado: true })
    const porPagar = await folio(ana.id)
    await folio(ana.id, { online: false }) // una venta de caja no es un pedido en línea
    await folio(bety.id)
    const suya = await tarjetaDe(ana.id)
    await tarjetaDe(bety.id)
    await tarjetaDe(null)
    const saldo = await tarjetaDe(ana.id, { saldoAFavor: true, saldo: 80 })
    // Otra sucursal de la misma organización, con el mismo id de clienta en sus filas: no se cuela.
    const anaB = await clienta('Ana B', {}, otroVenueId)
    await tarjetaDe(ana.id, { enVenue: otroVenueId })
    await folio(anaB.id, { enVenue: otroVenueId })

    const pedidos = await listarMisPedidos(venueId, ana.id, {})
    expect(pedidos.total).toBe(2)
    expect(new Map(pedidos.items.map(p => [p.folio, p.pagado]))).toEqual(
      new Map([
        [pagado.orderNumber, true],
        [porPagar.orderNumber, false],
      ]),
    )
    const tarjetas = await listarMisTarjetas(venueId, ana.id, sinContacto, {})
    expect(tarjetas.items.map(t => t.id)).toEqual([suya.id])
    expect(tarjetas.total).toBe(1)
    const portal: any = await getCustomerPortal(venueId, ana.id, sinContacto)
    expect(portal.saldoAFavor).toMatchObject({ last4: saldo.codeLast4, saldo: 80, codigo: null, estado: 'ACTIVA', disponible: true })
    expect(portal.tarjetas.total).toBe(1)
    expect(portal.pedidos.total).toBe(2)
    expect(portal.otraFicha).toBeNull()
  })
})

// ───────────────────────────── R5': el costo medido ─────────────────────────────

const perf: { venueId?: string; ella?: string } = {}
const PEDIDOS_DE_ELLA = 10_000
const OTRAS_ORDENES = 100_000
const TARJETAS_DE_ELLA = 500
const DESCUENTOS = 100
const TOPE_POR_CLIENTA = 3

type Nodo = { tipo: string; tabla?: string; indice?: string; filas: number; quitadas: number; ordenadas?: number }
function nodos(plan: any, out: Nodo[] = []): Nodo[] {
  const loops = plan['Actual Loops'] ?? 1
  out.push({
    tipo: plan['Node Type'],
    ...(plan['Relation Name'] ? { tabla: plan['Relation Name'] } : {}),
    ...(plan['Index Name'] ? { indice: plan['Index Name'] } : {}),
    filas: (plan['Actual Rows'] ?? 0) * loops,
    quitadas:
      ((plan['Rows Removed by Filter'] ?? 0) + (plan['Rows Removed by Index Recheck'] ?? 0) + (plan['Rows Removed by Join Filter'] ?? 0)) *
      loops,
    // codex-s13-r2 #3: lo ordenado son las filas que ENTRAN al Sort (las de su hijo), no las que salen hacia el LIMIT.
    ...(plan['Node Type'] === 'Sort'
      ? { ordenadas: (plan.Plans ?? []).reduce((n: number, h: any) => n + (h['Actual Rows'] ?? 0) * (h['Actual Loops'] ?? 1), 0) }
      : {}),
  })
  for (const hijo of plan.Plans ?? []) nodos(hijo, out)
  return out
}

/** EXPLAIN (ANALYZE, BUFFERS) de la consulta REAL; se corre dos veces y vale la segunda (caché caliente, como en producción). */
async function medir(nombre: string, sql: Prisma.Sql) {
  const corridas: number[] = []
  let plan: any
  for (let i = 0; i < 2; i++) {
    const [fila] = await prisma.$queryRaw<any[]>(Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`)
    plan = fila['QUERY PLAN'][0]
    corridas.push(plan['Execution Time'])
  }
  const lista = nodos(plan.Plan)
  const porTabla = (t: string) => lista.filter(x => x.tabla === t)
  return {
    nombre,
    ms: corridas[1],
    msEnFrio: corridas[0],
    bufferes: { hit: plan.Plan['Shared Hit Blocks'], read: plan.Plan['Shared Read Blocks'] },
    nodos: lista.filter(x => x.tabla || x.tipo === 'Sort'),
    porTabla,
  }
}

describe("R5' · el costo de las listas, medido", () => {
  it('10,000 pedidos, 500 tarjetas y 100 descuentos con límite de UNA clienta, en un negocio con otras 100,000 órdenes y 100,000 aplicaciones: ≤ 50 ms y sin filas de otras clientas', async () => {
    perf.venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: `${run}-perf`, slug: `${run}-perf` } })).id
    const v = perf.venueId
    const ella = (await prisma.customer.create({ data: { venueId: v, firstName: 'Ella' } })).id
    perf.ella = ella
    const otras: string[] = []
    for (let i = 0; i < 10; i++) otras.push((await prisma.customer.create({ data: { venueId: v, firstName: `Otra ${i}` } })).id)

    // Órdenes intercaladas en el tiempo: cada 11 es de ella (con su pedido en línea); de las otras, la mitad también es en línea.
    const total = PEDIDOS_DE_ELLA + OTRAS_ORDENES
    for (let desde = 1; desde <= total; desde += 10_000) {
      const ns: number[] = []
      for (let k = desde; k < Math.min(desde + 10_000, total + 1); k++) ns.push(k)
      const ids = ns.map(() => cuid())
      const clientes = ns.map(k => (k % 11 === 0 ? ella : otras[k % 10]))
      await prisma.$executeRaw`
        INSERT INTO "Order" (id, "venueId", "orderNumber", subtotal, "taxAmount", total, "customerId", status, "paymentStatus", "createdAt", "updatedAt")
        SELECT x.id, ${v}, 'R5-' || x.n, 100, 0, 100, x.c, 'COMPLETED'::"OrderStatus", 'PAID'::"PaymentStatus",
          (now() AT TIME ZONE 'UTC') - make_interval(mins => x.n), (now() AT TIME ZONE 'UTC') - make_interval(mins => x.n)
        FROM unnest(${ids}::text[], ${clientes}::text[], ${ns}::int[]) AS x(id, c, n)`
      const enLinea = ns.map((k, i) => ({ k, id: ids[i] })).filter(x => x.k % 11 === 0 || x.k % 2 === 0)
      await prisma.$executeRaw`
        INSERT INTO "OnlineOrder" (id, "orderId", "venueId", status, "paymentMode", "trackingToken", "acceptDeadlineAt", "createdAt", "updatedAt")
        SELECT x.oid, o.id, ${v}, 'COMPLETED'::"OnlineOrderStatus", 'PAY_AT_PICKUP'::"OnlineOrderPaymentMode", x.tok, o."createdAt", o."createdAt", o."createdAt"
        FROM unnest(${enLinea.map(() => cuid())}::text[], ${enLinea.map(x => x.id)}::text[], ${enLinea.map(() => cuid())}::text[]) AS x(oid, id, tok)
        JOIN "Order" o ON o.id = x.id`
    }
    // 500 tarjetas de ella y 5,000 de otras, cada una con su ACTIVATE (la libreta que lee EL predicado del saldo a favor).
    const duenas = [...Array(TARJETAS_DE_ELLA).fill(ella), ...Array.from({ length: 5000 }, (_, i) => otras[i % 10])]
    const tarjetas = duenas.map(() => cuid())
    await prisma.$executeRaw`
      INSERT INTO "GiftCard" (id, "venueId", "organizationId", "codeHash", "codeEnc", "codeLast4", "pageToken", "initialAmount", balance, status,
        "termsVersion", "deliveryChannel", "customerId", "activatedAt", "createdAt", "updatedAt")
      SELECT x.id, ${v}, ${orgId}, md5(x.id || ':h'), 'x', '0000', md5(x.id || ':p'), 100, 100, 'ACTIVE'::"GiftCardStatus",
        '2026-10-14', 'PRINTED'::"GiftCardDeliveryChannel", x.c, now() AT TIME ZONE 'UTC',
        (now() AT TIME ZONE 'UTC') - make_interval(mins => x.n::int), now() AT TIME ZONE 'UTC'
      FROM unnest(${tarjetas}::text[], ${duenas}::text[]) WITH ORDINALITY AS x(id, c, n)`
    await prisma.$executeRaw`
      INSERT INTO "GiftCardActivity" (id, "giftCardId", "venueId", type, amount, "balanceAfter", "createdAt")
      SELECT x.aid, x.gid, ${v}, 'ACTIVATE'::"GiftCardActivityType", 100, 100, now() AT TIME ZONE 'UTC'
      FROM unnest(${tarjetas.map(() => cuid())}::text[], ${tarjetas}::text[]) AS x(aid, gid)`
    // codex-s13-r2 #3: 100 descuentos con límite por clienta (50 de su grupo y 50 asignados sin límite propio, que heredan el del
    // catálogo) y 100,000 aplicaciones en las órdenes de OTRAS clientas; ella usó 30 de ellos hasta su tope (90 aplicaciones).
    const grupo = await prisma.customerGroup.create({ data: { venueId: v, name: `R5-${run}` } })
    await prisma.customer.update({ where: { id: ella }, data: { customerGroupId: grupo.id } })
    const base = Date.now() - 365 * DIA
    await prisma.discount.createMany({
      data: Array.from({ length: DESCUENTOS }, (_, i) => ({
        venueId: v,
        name: `R5-${i}`,
        type: 'PERCENTAGE' as const,
        value: 10,
        maxUsesPerCustomer: TOPE_POR_CLIENTA,
        customerGroupId: i < DESCUENTOS / 2 ? grupo.id : null,
        createdAt: new Date(base + i * 60_000),
      })),
    })
    const descuentos = (
      await prisma.discount.findMany({ where: { venueId: v }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: DESCUENTOS })
    ).map(d => d.id)
    await prisma.customerDiscount.createMany({
      data: descuentos.slice(DESCUENTOS / 2).map(discountId => ({ customerId: ella, discountId })),
    })
    // Las asignaciones de OTRAS 200 clientas a los mismos 100 descuentos (20,000): la tabla deja de ser diminuta, como en producción.
    await prisma.customer.createMany({ data: Array.from({ length: 200 }, (_, i) => ({ venueId: v, firstName: `Asignada ${i}` })) })
    const asignadas = (
      await prisma.customer.findMany({ where: { venueId: v, firstName: { startsWith: 'Asignada ' } }, select: { id: true }, take: 200 })
    ).map(c => c.id)
    await prisma.$executeRaw`
      WITH pares AS (
        SELECT c.id AS cliente, d.id AS descuento, row_number() OVER () AS rn
        FROM unnest(${asignadas}::text[]) AS c(id) CROSS JOIN unnest(${descuentos}::text[]) AS d(id)
      ),
      ids AS (SELECT x.id, x.rn FROM unnest(${Array.from({ length: asignadas.length * DESCUENTOS }, () => cuid())}::text[]) WITH ORDINALITY AS x(id, rn))
      INSERT INTO "CustomerDiscount" (id, "customerId", "discountId", "updatedAt")
      SELECT ids.id, pares.cliente, pares.descuento, now() AT TIME ZONE 'UTC' FROM pares JOIN ids ON ids.rn = pares.rn`
    await prisma.$executeRaw`
      WITH otras AS (
        SELECT o.id, row_number() OVER (ORDER BY o.id) AS rn FROM "Order" o WHERE o."venueId" = ${v} AND o."customerId" <> ${ella}
      ),
      ids AS (SELECT x.id, x.rn FROM unnest(${Array.from({ length: OTRAS_ORDENES }, () => cuid())}::text[]) WITH ORDINALITY AS x(id, rn)),
      descs AS (SELECT y.id, y.rn FROM unnest(${descuentos}::text[]) WITH ORDINALITY AS y(id, rn))
      INSERT INTO "OrderDiscount" (id, "orderId", "discountId", type, name, value, amount)
      SELECT ids.id, otras.id, descs.id, 'PERCENTAGE'::"DiscountType", 'R5', 10, 10
      FROM otras JOIN ids ON ids.rn = otras.rn JOIN descs ON descs.rn = (otras.rn % ${DESCUENTOS}) + 1`
    const agotados = descuentos.filter((_, i) => i % 10 < 3)
    const suyasOrdenes = (
      await prisma.order.findMany({
        where: { venueId: v, customerId: ella },
        orderBy: { id: 'asc' },
        take: agotados.length * TOPE_POR_CLIENTA,
        select: { id: true },
      })
    ).map(o => o.id)
    await prisma.orderDiscount.createMany({
      data: suyasOrdenes.map((orderId, i) => ({
        orderId,
        discountId: agotados[i % agotados.length],
        name: 'R5',
        type: 'PERCENTAGE' as const,
        value: 10,
        amount: 10,
      })),
    })
    await prisma.$executeRawUnsafe('ANALYZE "OrderDiscount"')
    await prisma.$executeRawUnsafe('ANALYZE "Discount"')
    await prisma.$executeRawUnsafe('ANALYZE "CustomerDiscount"')
    await prisma.$executeRawUnsafe('ANALYZE "Order"')
    await prisma.$executeRawUnsafe('ANALYZE "OnlineOrder"')
    await prisma.$executeRawUnsafe('ANALYZE "GiftCard"')
    await prisma.$executeRawUnsafe('ANALYZE "GiftCardActivity"')

    // Las respuestas, a esa escala, por la función real.
    const primera = await listarMisPedidos(v, ella, {})
    expect(primera.total).toBe(PEDIDOS_DE_ELLA)
    expect(primera.items).toHaveLength(20)
    const misTarjetas = await listarMisTarjetas(v, ella, sinContacto, {})
    expect(misTarjetas.total).toBe(TARJETAS_DE_ELLA)

    // Los cursores de una página profunda: el pedido 9,000 y la tarjeta 400 (en el orden de la lista).
    const [hondo] = await prisma.$queryRaw<Array<{ id: string; createdAt: Date }>>`
      SELECT oo.id, oo."createdAt" FROM "OnlineOrder" oo JOIN "Order" o ON o.id = oo."orderId"
      WHERE o."customerId" = ${ella} AND o."venueId" = ${v}
      ORDER BY oo."createdAt" DESC, oo.id DESC OFFSET 9000 LIMIT 1`
    const [tarjetaHonda] = await prisma.$queryRaw<Array<{ id: string; createdAt: Date }>>`
      SELECT g.id, g."createdAt" FROM "GiftCard" g WHERE g."venueId" = ${v} AND g."customerId" = ${ella}
      ORDER BY g."createdAt" DESC, g.id DESC OFFSET 400 LIMIT 1`
    const profunda = await listarMisPedidos(v, ella, { cursor: toActiveCursor(hondo) })
    expect(profunda.items).toHaveLength(20)
    // Descuentos a esa escala: 100 con límite, 30 agotados por ella ⇒ 70; la página profunda va después del 50.
    const misDescuentos = await listarMisDescuentos(v, ella, { limit: 50 })
    expect(misDescuentos.total).toBe(DESCUENTOS - agotados.length)
    expect(misDescuentos.items).toHaveLength(50)
    const descuentoHondo = fromActiveCursor(misDescuentos.nextCursor!)

    const ahora = new Date()
    const mediciones = [
      await medir('pedidos · primera página', sqlDePedidos(v, ella, null, 20)),
      await medir('pedidos · página profunda (después del 9,000)', sqlDePedidos(v, ella, hondo, 20)),
      await medir('pedidos · total', sqlDeTotalDePedidos(v, ella)),
      await medir('tarjetas · primera página', sqlDeTarjetas(v, ella, null, 20)),
      await medir('tarjetas · página profunda (después de la 400)', sqlDeTarjetas(v, ella, tarjetaHonda, 20)),
      await medir('tarjetas · total', sqlDeTotalDeTarjetas(v, ella)),
      await medir('descuentos · primera página', sqlDeDescuentos(v, ella, ahora, null, 20)),
      await medir('descuentos · página profunda (después del 50)', sqlDeDescuentos(v, ella, ahora, descuentoHondo, 20)),
      await medir('descuentos · total', sqlDeTotalDeDescuentos(v, ella, ahora)),
    ]
    // La medición va al informe: tiempo, filas recorridas, filtradas y ordenadas por nodo.
    console.log(
      `R5' S13 · mediciones\n${JSON.stringify(
        mediciones.map(m => ({ ...m, porTabla: undefined })),
        null,
        2,
      )}`,
    )

    // Las filas que son SUYAS en cada tabla: leer más (devueltas + descartadas) sería recorrer filas de otras clientas.
    const suyas: Record<string, number> = {
      Order: PEDIDOS_DE_ELLA,
      OnlineOrder: PEDIDOS_DE_ELLA,
      GiftCard: TARJETAS_DE_ELLA,
      GiftCardActivity: TARJETAS_DE_ELLA,
      OrderDiscount: agotados.length * TOPE_POR_CLIENTA,
      CustomerDiscount: DESCUENTOS / 2,
    }
    // Lo que entra a cada Sort tampoco pasa de SU historial en esa lista (pedidos, tarjetas o descuentos candidatos).
    const topeOrdenadas = (nombre: string) =>
      nombre.startsWith('pedidos') ? PEDIDOS_DE_ELLA : nombre.startsWith('tarjetas') ? TARJETAS_DE_ELLA : DESCUENTOS
    for (const m of mediciones) {
      expect({ nombre: m.nombre, ms: m.ms <= 50 }).toEqual({ nombre: m.nombre, ms: true })
      for (const x of m.nodos.filter(n => n.tipo === 'Sort')) {
        expect({ nombre: m.nombre, ordenadas: (x.ordenadas ?? 0) <= topeOrdenadas(m.nombre) }).toEqual({
          nombre: m.nombre,
          ordenadas: true,
        })
      }
      for (const [tabla, tope] of Object.entries(suyas)) {
        const leidas = m.porTabla(tabla)
        for (const x of leidas) expect({ nombre: m.nombre, tabla, tipo: x.tipo }).not.toEqual({ nombre: m.nombre, tabla, tipo: 'Seq Scan' })
        const recorridas = leidas.reduce((suma, x) => suma + x.filas + x.quitadas, 0)
        expect({ nombre: m.nombre, tabla, recorridas: recorridas <= tope }).toEqual({ nombre: m.nombre, tabla, recorridas: true })
      }
    }
  })
})
