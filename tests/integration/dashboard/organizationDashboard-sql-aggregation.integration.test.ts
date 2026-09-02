/**
 * Integration tests: organization dashboard aggregations in SQL (REAL PostgreSQL).
 *
 * 2026-09-01 (fase 3 de la reescritura Node→SQL): diez agregaciones del dashboard de
 * organización (PlayTelecom / white-label) materializaban TODAS las órdenes, pagos o
 * checadas de la org en Node para sumarlas. Ahora agrega Postgres. Los datos de este
 * dashboard (SIMs, promotores, custodia) no existen en la base de desarrollo, así que
 * este archivo siembra una org sintética con la forma de PlayTelecom — dos tiendas,
 * promotores, gerente, ventas de $0, checadas con GPS y nocturnas — y fija los números.
 *
 * Qué fija, además de los totales:
 *  · El BIND de fecha: una venta a las 22:30 locales viaja como 04:30Z del día
 *    siguiente. Con el bind correcto cae en el día 11; con el bind directo que tenía
 *    getStorePerformance (corrido 6 h) desaparece — de ahí las dos pruebas que FALLABAN
 *    contra el código anterior y ahora pasan.
 *  · El bucket por zona del venue en los dos heatmaps (la misma checada nocturna).
 *  · La ventana [clockIn, clockOut] inclusiva del efectivo por checada.
 *  · Que CANCELLED/PENDING siguen fuera de todas las agregaciones de órdenes.
 *  · Que el id de un empleado de OTRA org se rechaza (404) en tendencia, mezcla y
 *    calendario, y que esas consultas se acotan a los venues de la org aunque el
 *    empleado sí sea miembro (IDOR cross-tenant, 2026-09-01).
 *
 * Run with:
 *   TEST_DATABASE_URL='postgresql://…/av-db-25-test' \
 *     npx jest --selectProjects integration --testPathPattern organizationDashboard-sql-aggregation
 */

import { NotFoundError } from '@/errors/AppError'
import { organizationDashboardService as svc } from '@/services/organization-dashboard/organizationDashboard.service'
import { venueStartOfDay } from '@/utils/datetime'
import prisma from '@/utils/prismaClient'

const TZ = 'America/Mexico_City'
// Martes 11-mar-2025 en la zona del venue (UTC-6 en marzo):
const MORNING = new Date('2025-03-11T15:00:00.000Z') // 09:00 local
const NOON = new Date('2025-03-11T18:00:00.000Z') // 12:00 local
const AFTERNOON = new Date('2025-03-11T21:00:00.000Z') // 15:00 local
const E2_IN = new Date('2025-03-11T22:00:00.000Z') // 16:00 local
const E2_OUT = new Date('2025-03-11T23:00:00.000Z') // 17:00 local
const EVENING = new Date('2025-03-11T23:30:00.000Z') // 17:30 local — fuera de toda checada de Ana
const BETO_IN = new Date('2025-03-12T04:00:00.000Z') // 22:00 local del 11 ← la trampa
const NOCTURNA = new Date('2025-03-12T04:30:00.000Z') // 22:30 local del 11 ← la trampa
const ABONO_NOCTURNO = new Date('2025-03-12T05:00:00.000Z') // 23:00 local del 11, dentro de la checada abierta de Carla
const MADRUGADA12 = new Date('2025-03-12T06:30:00.000Z') // 00:30 local del 12 (fuera del día 11)
const DIA = '2025-03-11'

const suffix = `od-sql-${Date.now()}`
const round2 = (n: number): number => Math.round(n * 100) / 100
const dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb']

let orgId: string
let v1: string
let v2: string
let ana: string
let beto: string
let carla: string
let mario: string
let hoy: Date
let ayerNoche: Date
// Otra organización, para el candado cross-tenant.
let orgB: string
let vB: string
let vC: string
let dana: string
let zoe: string
let ximena: string
let yago: string
let zonaA: string
let zonaB: string
let haceTresDias: Date

let orderSeq = 0
async function order(data: {
  venueId: string
  createdById?: string
  createdAt: Date
  total: number
  status?: 'COMPLETED' | 'CANCELLED' | 'PENDING'
  items: Array<{
    productName: string
    categoryName?: string | null
    productSku?: string
    productId?: string
    quantity: number
    total: number
  }>
  payments?: Array<{ amount: number; method: 'CASH' | 'CREDIT_CARD'; processedById: string; createdAt?: Date }>
}) {
  orderSeq += 1
  return prisma.order.create({
    data: {
      venueId: data.venueId,
      orderNumber: `OD-${orderSeq}-${suffix}`,
      createdAt: data.createdAt,
      createdById: data.createdById,
      type: 'DINE_IN',
      subtotal: data.total,
      discountAmount: 0,
      taxAmount: 0,
      total: data.total,
      status: data.status ?? 'COMPLETED',
      paymentStatus: 'PAID',
      items: {
        create: data.items.map(i => ({
          productId: i.productId,
          productName: i.productName,
          productSku: i.productSku,
          categoryName: i.categoryName ?? null,
          quantity: i.quantity,
          unitPrice: i.total,
          discountAmount: 0,
          taxAmount: 0,
          total: i.total,
        })),
      },
      payments: data.payments
        ? {
            create: data.payments.map(p => ({
              venueId: data.venueId,
              amount: p.amount,
              tipAmount: 0,
              method: p.method,
              status: 'COMPLETED' as const,
              processedById: p.processedById,
              createdAt: p.createdAt ?? data.createdAt,
              feePercentage: 0,
              feeAmount: 0,
              netAmount: p.amount,
            })),
          }
        : undefined,
    },
    select: { id: true },
  })
}

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `OrgDashboard SQL ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
    select: { id: true },
  })
  orgId = org.id

  // Dos tiendas con coordenadas (para la anomalía de GPS) y zona México.
  const venue1 = await prisma.venue.create({
    data: {
      organizationId: orgId,
      name: `BAE Norte ${suffix}`,
      slug: `bae-norte-${suffix}`,
      timezone: TZ,
      status: 'ACTIVE',
      latitude: 20.5888,
      longitude: -100.3899,
      city: 'Querétaro',
      state: 'QRO',
    },
    select: { id: true },
  })
  const venue2 = await prisma.venue.create({
    data: {
      organizationId: orgId,
      name: `BAE Sur ${suffix}`,
      slug: `bae-sur-${suffix}`,
      timezone: TZ,
      status: 'ACTIVE',
      latitude: 22.1565,
      longitude: -100.9855,
      city: 'San Luis Potosí',
      state: 'SLP',
    },
    select: { id: true },
  })
  v1 = venue1.id
  v2 = venue2.id

  const mkStaff = (first: string, last: string) =>
    prisma.staff.create({
      data: { email: `${first.toLowerCase()}-${suffix}@example.test`, firstName: first, lastName: last },
      select: { id: true },
    })
  ana = (await mkStaff('Ana', 'Promotora')).id
  beto = (await mkStaff('Beto', 'Nocturno')).id
  carla = (await mkStaff('Carla', 'Sur')).id
  mario = (await mkStaff('Mario', 'Gerente')).id
  await prisma.staffOrganization.create({ data: { staffId: mario, organizationId: orgId, role: 'ADMIN' } })
  await prisma.staffVenue.createMany({
    data: [
      { staffId: ana, venueId: v1, role: 'CASHIER' },
      { staffId: beto, venueId: v1, role: 'WAITER' },
      { staffId: carla, venueId: v2, role: 'CASHIER' },
      { staffId: mario, venueId: v1, role: 'MANAGER' },
      { staffId: mario, venueId: v2, role: 'MANAGER' },
    ],
  })

  // Un producto con categoría de catálogo (para la mezcla por categoría).
  const cat = await prisma.menuCategory.create({
    data: { venueId: v1, name: 'Accesorios', slug: `accesorios-${suffix}` },
    select: { id: true },
  })
  const cargador = await prisma.product.create({
    data: { venueId: v1, sku: `CARG-${suffix}`, name: `Cargador ${suffix}`, categoryId: cat.id, price: 30, type: 'OTHER' },
    select: { id: true },
  })

  // ── Día 11 (2025) ──────────────────────────────────────────────────────────
  // Ana en Norte: SIM de $100 (mediodía), SIM de $0 (portabilidad, 15:00 — justo al
  // clockOut de su primera checada, inclusivo), SIM de $150 (17:30, fuera de toda checada).
  await order({
    venueId: v1,
    createdById: ana,
    createdAt: NOON,
    total: 100,
    items: [{ productName: 'SIM Bait 100', productSku: '8952-0001', quantity: 1, total: 100 }],
    payments: [{ amount: 100, method: 'CASH', processedById: ana }],
  })
  await order({
    venueId: v1,
    createdById: ana,
    createdAt: AFTERNOON,
    total: 0,
    items: [{ productName: 'SIM Portabilidad', productSku: '8952-0002', quantity: 1, total: 0 }],
    payments: [{ amount: 0, method: 'CASH', processedById: ana }],
  })
  await order({
    venueId: v1,
    createdById: ana,
    createdAt: EVENING,
    total: 150,
    items: [{ productName: 'SIM Bait 100', productSku: '8952-0003', quantity: 1, total: 150 }],
    payments: [{ amount: 150, method: 'CASH', processedById: ana }],
  })
  // Beto en Norte, nocturna (22:30 local del 11 = 04:30Z del 12): 2 cargadores con tarjeta.
  await order({
    venueId: v1,
    createdById: beto,
    createdAt: NOCTURNA,
    total: 80,
    items: [{ productName: 'Cargador', categoryName: 'Accesorios', productSku: 'CARG', productId: cargador.id, quantity: 2, total: 80 }],
    payments: [{ amount: 80, method: 'CREDIT_CARD', processedById: beto }],
  })
  // Carla en Sur: SIM de $120 a las 09:00 — exactamente su clockIn (inclusivo) — y un
  // abono de $45 a las 23:00 locales, DENTRO de su checada nocturna abierta (sin salida).
  await order({
    venueId: v2,
    createdById: carla,
    createdAt: MORNING,
    total: 120,
    items: [{ productName: 'SIM Bait 100', productSku: '8952-0005', quantity: 1, total: 120 }],
    payments: [
      { amount: 120, method: 'CASH', processedById: carla },
      { amount: 45, method: 'CASH', processedById: carla, createdAt: ABONO_NOCTURNO },
    ],
  })
  // Carla, 00:30 local del 12: fuera del día 11 (control de la frontera).
  await order({
    venueId: v2,
    createdById: carla,
    createdAt: MADRUGADA12,
    total: 999,
    items: [{ productName: 'SIM Bait 100', productSku: '8952-0006', quantity: 1, total: 999 }],
    payments: [{ amount: 999, method: 'CASH', processedById: carla }],
  })
  // Ana, con categoría de catálogo (mezcla): un cargador de $60 (día distinto, no importa).
  await order({
    venueId: v1,
    createdById: ana,
    createdAt: new Date('2025-02-01T18:00:00.000Z'),
    total: 60,
    items: [{ productName: 'Cargador', categoryName: 'Accesorios', productId: cargador.id, quantity: 1, total: 60 }],
  })
  // CANCELLED y PENDING: fuera de toda agregación.
  await order({
    venueId: v1,
    createdById: ana,
    createdAt: NOON,
    total: 5000,
    status: 'CANCELLED',
    items: [{ productName: 'Trampa', categoryName: 'Trampa', quantity: 9, total: 5000 }],
  })
  await order({
    venueId: v1,
    createdById: ana,
    createdAt: NOON,
    total: 700,
    status: 'PENDING',
    items: [{ productName: 'Trampa', categoryName: 'Trampa', quantity: 9, total: 700 }],
  })

  // Checadas del día 11.
  await prisma.timeEntry.createMany({
    data: [
      { staffId: ana, venueId: v1, clockInTime: MORNING, clockOutTime: AFTERNOON, status: 'CLOCKED_OUT' },
      { staffId: ana, venueId: v1, clockInTime: E2_IN, clockOutTime: E2_OUT, status: 'CLOCKED_OUT' },
      { staffId: beto, venueId: v1, clockInTime: BETO_IN, clockOutTime: null, status: 'CLOCKED_IN' },
      { staffId: carla, venueId: v2, clockInTime: MORNING, clockOutTime: AFTERNOON, status: 'CLOCKED_OUT' },
      { staffId: carla, venueId: v2, clockInTime: NOCTURNA, clockOutTime: null, status: 'CLOCKED_IN' },
      { staffId: carla, venueId: v2, clockInTime: MADRUGADA12, clockOutTime: null, status: 'CLOCKED_IN' },
    ],
  })
  // Depósito aprobado del día (y uno pendiente que no cuenta).
  await prisma.cashDeposit.createMany({
    data: [
      { staffId: ana, venueId: v1, amount: 250, method: 'BANK_TRANSFER', status: 'APPROVED', timestamp: AFTERNOON },
      { staffId: ana, venueId: v1, amount: 999, method: 'BANK_TRANSFER', status: 'PENDING', timestamp: AFTERNOON },
    ],
  })

  // ── HOY (para las funciones relativas al reloj) ────────────────────────────
  // Una hora después de la medianoche del venue: siempre es "hoy" en su zona.
  hoy = new Date(venueStartOfDay(TZ).getTime() + 60 * 60 * 1000)
  const min = (n: number) => new Date(hoy.getTime() + n * 60 * 1000)
  // Ayer a las 20:00 locales (= medianoche de hoy − 4 h): NO es hoy. Un bind directo
  // (corrido 6 h) lo mete en "hoy". Lo vende el gerente para no alterar el podio.
  ayerNoche = new Date(venueStartOfDay(TZ).getTime() - 4 * 60 * 60 * 1000)
  await order({
    venueId: v1,
    createdById: mario,
    createdAt: ayerNoche,
    total: 5,
    items: [{ productName: 'SIM Bait 100', quantity: 7, total: 5 }],
  })

  await order({
    venueId: v1,
    createdById: ana,
    createdAt: min(1),
    total: 40,
    items: [{ productName: 'SIM Bait 100', quantity: 1, total: 40 }],
  })
  await order({
    venueId: v1,
    createdById: ana,
    createdAt: min(2),
    total: 25,
    items: [{ productName: 'SIM Bait 100', quantity: 1, total: 25 }],
  })
  // Carla vende 3 en Sur ANTES que Beto sus 3 en Norte: empate en conteo, gana quien empezó primero.
  await order({
    venueId: v2,
    createdById: carla,
    createdAt: min(3),
    total: 10,
    items: [{ productName: 'SIM Bait 100', quantity: 1, total: 10 }],
  })
  await order({
    venueId: v2,
    createdById: carla,
    createdAt: min(4),
    total: 20,
    items: [{ productName: 'SIM Bait 100', quantity: 1, total: 20 }],
  })
  await order({
    venueId: v2,
    createdById: carla,
    createdAt: min(5),
    total: 30,
    items: [{ productName: 'SIM Bait 100', quantity: 1, total: 30 }],
  })
  await order({
    venueId: v1,
    createdById: beto,
    createdAt: min(6),
    total: 10,
    items: [{ productName: 'Cargador', categoryName: 'Accesorios', quantity: 1, total: 10 }],
  })
  await order({
    venueId: v1,
    createdById: beto,
    createdAt: min(7),
    total: 10,
    items: [{ productName: 'Cargador', categoryName: 'Accesorios', quantity: 1, total: 10 }],
  })
  await order({
    venueId: v1,
    createdById: beto,
    createdAt: min(8),
    total: 10,
    items: [{ productName: 'Cargador', categoryName: 'Accesorios', quantity: 1, total: 10 }],
  })

  // Checadas de hoy: Ana (con GPS en CDMX, a ~190 km de Norte) y Carla, sin salida.
  await prisma.timeEntry.createMany({
    data: [
      { staffId: ana, venueId: v1, clockInTime: hoy, status: 'CLOCKED_IN', clockInLatitude: 19.4326, clockInLongitude: -99.1332 },
      { staffId: carla, venueId: v2, clockInTime: hoy, status: 'CLOCKED_IN' },
    ],
  })

  // ── Otra organización (candado cross-tenant) ──────────────────────────────
  // Dana es miembro de ESTA org sólo por StaffOrganization (sin StaffVenue aquí, para no
  // alterar los conteos de promotores) y además trabaja en una tienda de OTRA org: sus
  // ventas y checadas de allá no deben verse desde ésta. Zoe sólo existe en la otra org.
  // Ximena fue de esta org, pero su StaffVenue está inactivo.
  const otraOrg = await prisma.organization.create({
    data: { name: `Otra Org ${suffix}`, email: `otra-${suffix}@example.test`, phone: '0000000001' },
    select: { id: true },
  })
  orgB = otraOrg.id
  const venueAjeno = await prisma.venue.create({
    data: { organizationId: orgB, name: `Ajena ${suffix}`, slug: `ajena-${suffix}`, timezone: TZ, status: 'ACTIVE' },
    select: { id: true },
  })
  vB = venueAjeno.id
  // Una tienda CERRADA de esta org: su historial sigue siendo de la org (no se filtra por status).
  const venueCerrado = await prisma.venue.create({
    data: { organizationId: orgId, name: `Cerrada ${suffix}`, slug: `cerrada-${suffix}`, timezone: TZ, status: 'CLOSED' },
    select: { id: true },
  })
  vC = venueCerrado.id
  dana = (await mkStaff('Dana', 'Doble')).id
  zoe = (await mkStaff('Zoe', 'Ajena')).id
  ximena = (await mkStaff('Ximena', 'Exempleada')).id
  // Yago fue miembro de ESTA org (StaffOrganization dado de baja) y hoy trabaja en la otra.
  yago = (await mkStaff('Yago', 'Exmiembro')).id
  await prisma.staffOrganization.create({ data: { staffId: dana, organizationId: orgId, role: 'MEMBER' } })
  await prisma.staffOrganization.create({
    data: { staffId: yago, organizationId: orgId, role: 'MEMBER', isActive: false, leftAt: new Date('2025-01-15T00:00:00.000Z') },
  })
  await prisma.staffVenue.createMany({
    data: [
      { staffId: dana, venueId: vB, role: 'CASHIER' },
      { staffId: zoe, venueId: vB, role: 'CASHIER' },
      { staffId: ximena, venueId: v1, role: 'HOST', active: false },
      { staffId: yago, venueId: vB, role: 'CASHIER' },
    ],
  })
  const catFuga = await prisma.menuCategory.create({
    data: { venueId: vB, name: 'Fuga', slug: `fuga-${suffix}` },
    select: { id: true },
  })
  const fuga = await prisma.product.create({
    data: { venueId: vB, sku: `FUGA-${suffix}`, name: `Fuga ${suffix}`, categoryId: catFuga.id, price: 500, type: 'OTHER' },
    select: { id: true },
  })
  // Hace tres días (dentro de la tendencia de 7 días; fuera de "hoy"): $30 en Sur (esta org,
  // sin producto → «Sin categoría») y $500 con categoría «Fuga» en la tienda ajena. Son $30 y
  // no $40 a propósito: con $40, Sur empataría con Norte en ventas de la SEMANA (100 y 100) y el
  // ranking de getStorePerformance no desempata — la prueba de rangos quedaría al azar.
  haceTresDias = min(-3 * 24 * 60)
  await order({
    venueId: v2,
    createdById: dana,
    createdAt: haceTresDias,
    total: 30,
    items: [{ productName: 'SIM Bait 100', quantity: 1, total: 30 }],
  })
  // Fuera de toda ventana de "hoy"/"semana" (feb-2025): $7 en Sur cuyo renglón apunta a un
  // PRODUCTO de la otra org (la FK es global) — su categoría «Fuga» no debe asomarse; y $3 en
  // la tienda CERRADA de esta org, que sí cuenta.
  await order({
    venueId: v2,
    createdById: dana,
    createdAt: new Date('2025-02-01T18:00:00.000Z'),
    total: 7,
    items: [{ productName: 'Fuga', productId: fuga.id, quantity: 1, total: 7 }],
  })
  await order({
    venueId: vC,
    createdById: dana,
    createdAt: new Date('2025-02-01T19:00:00.000Z'),
    total: 3,
    items: [{ productName: 'SIM Bait 100', quantity: 1, total: 3 }],
  })
  // Y un producto de ESTA org cuya categoría es de la otra (la FK de categoría también es global):
  // venta de $0 para no mover sumas — basta con que «Fuga» no aparezca como renglón.
  const mixto = await prisma.product.create({
    data: { venueId: v2, sku: `MIXTO-${suffix}`, name: `Mixto ${suffix}`, categoryId: catFuga.id, price: 0, type: 'OTHER' },
    select: { id: true },
  })
  await order({
    venueId: v2,
    createdById: dana,
    createdAt: new Date('2025-02-01T20:00:00.000Z'),
    total: 0,
    items: [{ productName: 'Mixto', productId: mixto.id, quantity: 1, total: 0 }],
  })
  await order({
    venueId: vB,
    createdById: dana,
    createdAt: haceTresDias,
    total: 500,
    items: [{ productName: 'Fuga', productId: fuga.id, quantity: 1, total: 500 }],
  })
  // Su única checada de hoy es en la tienda ajena.
  await prisma.timeEntry.create({ data: { staffId: dana, venueId: vB, clockInTime: hoy, status: 'CLOCKED_IN' } })
  // Mario, gerente de ESTA org, también gestiona la tienda ajena; y una zona por org.
  await prisma.staffVenue.create({ data: { staffId: mario, venueId: vB, role: 'MANAGER' } })
  zonaA = (
    await prisma.zone.create({ data: { organizationId: orgId, name: `Zona A ${suffix}`, slug: `zona-a-${suffix}` }, select: { id: true } })
  ).id
  zonaB = (
    await prisma.zone.create({ data: { organizationId: orgB, name: `Zona B ${suffix}`, slug: `zona-b-${suffix}` }, select: { id: true } })
  ).id
})

afterAll(async () => {
  const venueIds = [v1, v2, vB, vC].filter(Boolean)
  await prisma.payment.deleteMany({ where: { venueId: { in: venueIds } } })
  await prisma.order.deleteMany({ where: { venueId: { in: venueIds } } })
  await prisma.timeEntry.deleteMany({ where: { venueId: { in: venueIds } } })
  await prisma.cashDeposit.deleteMany({ where: { venueId: { in: venueIds } } })
  await prisma.staffVenue.deleteMany({ where: { venueId: { in: venueIds } } })
  await prisma.product.deleteMany({ where: { venueId: { in: venueIds } } })
  await prisma.menuCategory.deleteMany({ where: { venueId: { in: venueIds } } })
  await prisma.venue.deleteMany({ where: { id: { in: venueIds } } })
  await prisma.staffOrganization.deleteMany({ where: { organizationId: orgId } })
  await prisma.zone.deleteMany({ where: { organizationId: { in: [orgId, orgB].filter(Boolean) } } })
  await prisma.staff.deleteMany({ where: { id: { in: [ana, beto, carla, mario, dana, zoe, ximena, yago].filter(Boolean) } } })
  await prisma.organization.deleteMany({ where: { id: { in: [orgId, orgB].filter(Boolean) } } })
})

describe('getVisionGlobalSummary — ventas, unidades y categorías agregadas en Postgres', () => {
  it('suma el día civil del venue: la nocturna de las 22:30 entra, la de las 00:30 del día siguiente no', async () => {
    const s = await svc.getVisionGlobalSummary(orgId, TZ, DIA, DIA)

    expect(round2(s.todaySales)).toBe(450) // 100 + 0 + 150 + 80 (nocturna) + 120
    expect(s.unitsSold).toBe(6) // 1 + 1 + 1 + 2 + 1
    expect(round2(s.avgTicket)).toBe(90) // 450 / 5 órdenes
    expect(round2(s.todayCashSales)).toBe(415) // el cargador fue con tarjeta; la de 999 es del 12
    expect(s.activePromoters).toBe(3) // Ana, Beto y Carla checaron en el día
    expect(s.totalPromoters).toBe(3) // CASHIER/WAITER activos
    expect(s.activeStores).toBe(2)
    expect(s.totalStores).toBe(2)
    expect(round2(s.approvedDeposits)).toBe(250) // el PENDING no cuenta
    expect(s.categoryBreakdown).toEqual([
      { id: 'SIM Bait 100', name: 'SIM Bait 100', units: 3, sales: 370, percentage: 50 },
      { id: 'Accesorios', name: 'Accesorios', units: 2, sales: 80, percentage: 33 },
      { id: 'SIM Portabilidad', name: 'SIM Portabilidad', units: 1, sales: 0, percentage: 17 },
    ])
  })

  it('con filtro de tienda sólo cuenta esa tienda y totalStores sigue siendo el de la org', async () => {
    const s = await svc.getVisionGlobalSummary(orgId, TZ, DIA, DIA, v2)
    expect(round2(s.todaySales)).toBe(120)
    expect(s.unitsSold).toBe(1)
    expect(s.activePromoters).toBe(1)
    expect(s.activeStores).toBe(1)
    expect(s.totalStores).toBe(2)
  })

  it('hoy: agrega las ventas de las dos tiendas y cuenta a quien checó hoy', async () => {
    const s = await svc.getVisionGlobalSummary(orgId, TZ)
    expect(round2(s.todaySales)).toBe(155) // Norte 40+25+10+10+10 · Sur 10+20+30; la de anoche NO
    expect(s.unitsSold).toBe(8)
    expect(round2(s.avgTicket)).toBe(19.38) // 155 / 8
    expect(s.activePromoters).toBe(2)
    expect(s.categoryBreakdown.map(c => [c.name, c.units, c.percentage])).toEqual([
      ['SIM Bait 100', 5, 63],
      ['Accesorios', 3, 38],
    ])
  })
})

describe('getStorePerformance — unidades y promotores activos por tienda', () => {
  it('con rango explícito, las unidades usan la MISMA ventana que las ventas (la nocturna cuenta)', async () => {
    const stores = await svc.getStorePerformance(orgId, 50, TZ, DIA, DIA)
    const norte = stores.find(s => s.id === v1)!
    const sur = stores.find(s => s.id === v2)!

    expect(round2(norte.todaySales)).toBe(330) // 100 + 0 + 150 + 80
    // 🔴 Fallaba con el bind directo: la ventana de unidades corría 6 h y perdía los 2 cargadores.
    expect(norte.unitsSold).toBe(5)
    expect(norte.activePromoters).toBe(2) // Ana y Beto
    expect(norte.promoterCount).toBe(2)
    expect(round2(sur.todaySales)).toBe(120)
    expect(sur.unitsSold).toBe(1)
    expect(sur.activePromoters).toBe(1)
  })

  it('hoy: la venta de anoche a las 20:00 locales no entra a las unidades de hoy', async () => {
    const stores = await svc.getStorePerformance(orgId, 50, TZ)
    const norte = stores.find(s => s.id === v1)!
    const sur = stores.find(s => s.id === v2)!

    expect(round2(norte.todaySales)).toBe(95)
    // 🔴 Fallaba con el bind directo: metía las 7 unidades de anoche (12 en vez de 5).
    expect(norte.unitsSold).toBe(5)
    expect(round2(norte.weekSales)).toBe(100) // la de anoche SÍ es de esta semana
    expect(norte.activePromoters).toBe(1) // sólo Ana checó hoy en Norte
    expect(norte.rank).toBe(1)
    expect(sur.unitsSold).toBe(3)
    expect(sur.activePromoters).toBe(1)
    expect(sur.rank).toBe(2)
  })
})

describe('getManagerDashboard — promotores activos por tienda del gerente', () => {
  it('cuenta distinto por tienda y agrega', async () => {
    const d = (await svc.getManagerDashboard(orgId, mario, TZ))!
    expect(d.manager.name).toBe('Mario Gerente')
    const norte = d.stores.find(s => s.id === v1)!
    const sur = d.stores.find(s => s.id === v2)!
    expect(round2(norte.todaySales)).toBe(95)
    expect(round2(norte.weekSales)).toBe(100)
    expect(norte.promoterCount).toBe(2)
    expect(norte.activePromoters).toBe(1)
    expect(sur.promoterCount).toBe(1)
    expect(sur.activePromoters).toBe(1)
    expect(d.aggregateMetrics.promotersActive).toBe(2)
    expect(d.aggregateMetrics.promotersTotal).toBe(3)
    expect(round2(d.aggregateMetrics.totalSales)).toBe(155)
  })
})

describe('getTopPromoter — conteo por vendedor en Postgres', () => {
  it('gana quien más vendió hoy; en empate, quien empezó a vender primero, con su tienda', async () => {
    const top = (await svc.getTopPromoter(orgId))!
    expect(top.staffId).toBe(carla)
    expect(top.staffName).toBe('Carla Sur')
    expect(top.venueId).toBe(v2)
    expect(top.salesCount).toBe(3)
  })
})

describe('getStaffAttendance — efectivo por checada agregado en Postgres', () => {
  it('cada checada suma sólo los cobros en efectivo dentro de su ventana [entrada, salida] inclusiva', async () => {
    const { staff } = await svc.getStaffAttendance(orgId, DIA)
    const rows = staff as Array<any>
    expect(rows.map(r => r.id).sort()).toEqual([ana, beto, carla].sort()) // Mario no aparece: sin checada ni ventas

    const a = rows.find(r => r.id === ana)!
    expect(a.status).toBe('INACTIVE')
    expect(round2(a.sales)).toBe(250)
    expect(round2(a.cashSales)).toBe(250)
    expect(a.breakMinutes).toBe(60)
    expect(a.allTimeEntries).toHaveLength(2)
    // Más reciente primero: la de las 16:00 no tuvo cobros; la de la mañana suma la SIM de
    // $100 y la de $0 cobrada exactamente al minuto de salida (inclusivo). La de $150 fue
    // a las 17:30, después de salir: cuenta en el día, no en ninguna checada.
    expect(a.allTimeEntries.map((e: any) => e.cashSales)).toEqual([0, 100])
    expect(a.allTimeEntries.map((e: any) => e.isLate)).toEqual([true, false])
    expect(a.isLate).toBe(false)

    const b = rows.find(r => r.id === beto)!
    expect(b.status).toBe('ACTIVE')
    expect(round2(b.sales)).toBe(80)
    expect(round2(b.cashSales)).toBe(0)
    expect(b.isLate).toBe(true)

    const c = rows.find(r => r.id === carla)!
    expect(c.status).toBe('ACTIVE')
    expect(round2(c.sales)).toBe(165) // 120 + 45; la de 999 es del 12
    expect(round2(c.cashSales)).toBe(165)
    // El cobro exactamente al clockIn cuenta (inclusivo). La checada nocturna ABIERTA
    // recoge el abono de las 23:00 (su ventana llega hasta el fin del rango) pero no la
    // venta de las 00:30 del 12, porque el rango del día la excluye.
    expect(c.allTimeEntries.map((e: any) => e.cashSales)).toEqual([45, 120])
    expect(c.breakMinutes).toBe(450)
  })

  it('el filtro de estado deja sólo a quien sigue dentro', async () => {
    const { staff } = await svc.getStaffAttendance(orgId, DIA, undefined, 'ACTIVE')
    expect((staff as Array<any>).map(r => r.id).sort()).toEqual([beto, carla].sort())
  })
})

describe('getStaffSalesTrend / getStaffSalesMix — por vendedor en Postgres', () => {
  it('la tendencia agrupa los últimos 7 días por nombre de día', async () => {
    const { salesData } = await svc.getStaffSalesTrend(orgId, ana)
    expect(salesData).toHaveLength(7)
    const hoyNombre = dayNames[hoy.getDay()]
    for (const d of salesData) {
      const esperado = d.day === hoyNombre ? 65 : 0
      expect([d.day, round2(d.sales)]).toEqual([d.day, esperado])
    }
  })

  it('la mezcla agrupa por categoría de catálogo y manda lo sin producto a «Sin categoría»', async () => {
    const { salesMix } = await svc.getStaffSalesMix(orgId, ana)
    // Ana: SIMs sin producto (100 + 0 + 150 + 40 + 25 = 315) y un cargador con categoría (60).
    expect(salesMix).toEqual([
      { category: 'Sin categoría', amount: 315, percentage: 84 },
      { category: 'Accesorios', amount: 60, percentage: 16 },
    ])
  })
})

describe('Acotado a la org — el id de un empleado de otra org no lee nada (IDOR cross-tenant)', () => {
  // checkOrgAccess sólo valida que el usuario pertenezca a la org de la URL; el staffId se
  // tomaba tal cual. Un OWNER de la org A leía ventas, mezcla y checadas de la org B.
  it('la tendencia rechaza a quien no es de la org (404)', async () => {
    await expect(svc.getStaffSalesTrend(orgId, zoe)).rejects.toBeInstanceOf(NotFoundError)
  })

  it('la mezcla rechaza a quien no es de la org (404)', async () => {
    await expect(svc.getStaffSalesMix(orgId, zoe)).rejects.toBeInstanceOf(NotFoundError)
  })

  it('el calendario rechaza a quien no es de la org (404)', async () => {
    await expect(svc.getStaffAttendanceCalendar(orgId, zoe)).rejects.toBeInstanceOf(NotFoundError)
  })

  it('un StaffVenue inactivo en la org no basta', async () => {
    await expect(svc.getStaffSalesTrend(orgId, ximena)).rejects.toBeInstanceOf(NotFoundError)
    await expect(svc.getStaffSalesMix(orgId, ximena)).rejects.toBeInstanceOf(NotFoundError)
    await expect(svc.getStaffAttendanceCalendar(orgId, ximena)).rejects.toBeInstanceOf(NotFoundError)
  })

  it('una membresía de org dada de baja (isActive=false) tampoco basta', async () => {
    await expect(svc.getStaffSalesTrend(orgId, yago)).rejects.toBeInstanceOf(NotFoundError)
    await expect(svc.getStaffSalesMix(orgId, yago)).rejects.toBeInstanceOf(NotFoundError)
    await expect(svc.getStaffAttendanceCalendar(orgId, yago)).rejects.toBeInstanceOf(NotFoundError)
  })

  it('la tendencia de un miembro sólo suma sus ventas en tiendas de ESTA org', async () => {
    const { salesData } = await svc.getStaffSalesTrend(orgId, dana)
    const nombre = dayNames[haceTresDias.getDay()]
    expect(round2(salesData.find(d => d.day === nombre)!.sales)).toBe(30) // los $500 de la tienda ajena no entran
    expect(salesData.filter(d => d.day !== nombre).map(d => round2(d.sales))).toEqual([0, 0, 0, 0, 0, 0])
  })

  it('la mezcla no trae la categoría de la otra org: ni por sus ventas allá ni por un producto ajeno ligado aquí', async () => {
    const { salesMix } = await svc.getStaffSalesMix(orgId, dana)
    // Los $500 de la tienda ajena quedan fuera por la orden; los $7 de aquí con producto de la
    // otra org cuentan, pero sin su categoría (el nombre «Fuga» es dato de la org B).
    expect(salesMix.map(c => c.category)).not.toContain('Fuga')
    expect(round2(salesMix.reduce((sum, c) => sum + c.amount, 0))).toBe(40) // 30 + 7 + 3
  })

  it('la mezcla incluye la venta en una tienda CERRADA de la org', async () => {
    const { salesMix } = await svc.getStaffSalesMix(orgId, dana)
    expect(salesMix).toEqual([{ category: 'Sin categoría', amount: 40, percentage: 100 }]) // sin los $3 de la cerrada serían 37
  })

  it('el calendario no marca presente por una checada en la otra org', async () => {
    const { calendar, stats } = await svc.getStaffAttendanceCalendar(orgId, dana)
    expect(calendar.find(d => d.isToday)!.isPresent).toBe(false)
    expect(stats.present).toBe(0)
  })
})

describe('Zonas, panel del gerente y reset de contraseña — acotados a la org (mismo patrón IDOR)', () => {
  // Las rutas van sólo con checkOrgAccess y el id de la URL se usaba tal cual: cualquier miembro
  // de una org podía renombrar o borrar una zona de OTRA org, y el panel del gerente listaba las
  // tiendas que gestiona en otras orgs.
  it('renombrar una zona de otra org se rechaza (404) y la zona queda intacta', async () => {
    await expect(svc.updateZone(orgId, zonaB, { name: 'Pirata' })).rejects.toBeInstanceOf(NotFoundError)
    const zona = await prisma.zone.findUnique({ where: { id: zonaB }, select: { name: true } })
    expect(zona?.name).toBe(`Zona B ${suffix}`)
  })

  it('borrar una zona de otra org se rechaza (404) y la zona sigue existiendo', async () => {
    await expect(svc.deleteZone(orgId, zonaB)).rejects.toBeInstanceOf(NotFoundError)
    expect(await prisma.zone.count({ where: { id: zonaB } })).toBe(1)
  })

  it('renombrar una zona propia sigue funcionando', async () => {
    const zona = await svc.updateZone(orgId, zonaA, { name: `Zona A2 ${suffix}` })
    expect(zona.name).toBe(`Zona A2 ${suffix}`)
  })

  it('el panel del gerente sólo lista sus tiendas de ESTA org', async () => {
    const d = (await svc.getManagerDashboard(orgId, mario, TZ))!
    expect(d.stores.map(s => s.id).sort()).toEqual([v1, v2].sort()) // la tienda ajena que también gestiona no aparece
  })

  it('el panel del gerente no reconoce a un ex-miembro de la org', async () => {
    expect(await svc.getManagerDashboard(orgId, yago, TZ)).toBeNull()
  })

  it('restablecer la contraseña de un ex-miembro se rechaza (404) y su contraseña no cambia', async () => {
    // Yago hoy trabaja en la otra org: resetear su contraseña desde aquí sería apropiarse de su cuenta.
    const antes = (await prisma.staff.findUnique({ where: { id: yago }, select: { password: true } }))!.password
    await expect(svc.resetUserPassword(orgId, yago, mario)).rejects.toBeInstanceOf(NotFoundError)
    const despues = (await prisma.staff.findUnique({ where: { id: yago }, select: { password: true } }))!.password
    expect(despues).toBe(antes)
  })

  it('borrar una zona propia sigue funcionando', async () => {
    await svc.deleteZone(orgId, zonaA)
    expect(await prisma.zone.count({ where: { id: zonaA } })).toBe(0)
  })
})

describe('Heatmaps — bucket por día del venue en Postgres', () => {
  // Las etiquetas de día salen de eachDayOfInterval(new Date('YYYY-MM-DD')): en un host
  // en UTC son 10..13, en un host en México 09..12 (trampa preexistente, no se toca aquí).
  // Se pide un rango que contenga 10, 11 y 12 en los dos casos y se busca POR FECHA.
  const porFecha = <T extends { date: string }>(days: T[], date: string): T => days.find(d => d.date === date)!

  it('asistencia: la checada de las 22:00 locales es del día 11 y por día se queda la más temprana', async () => {
    const { staff, summary } = await svc.getAttendanceHeatmap(orgId, '2025-03-10', '2025-03-13', 'OWNER', mario)
    const fila = (staffId: string, venueId: string) => staff.find(s => s.staffId === staffId && s.venueId === venueId)!

    const a = fila(ana, v1)
    expect(['2025-03-10', '2025-03-11', '2025-03-12'].map(d => porFecha(a.days, d).status)).toEqual(['absent', 'present', 'absent'])
    expect(porFecha(a.days, '2025-03-11').clockInTime).toBe(MORNING.toISOString()) // la primera de sus dos checadas
    expect(porFecha(a.days, '2025-03-11').clockOutTime).toBe(AFTERNOON.toISOString())

    const b = fila(beto, v1)
    expect(['2025-03-10', '2025-03-11', '2025-03-12'].map(d => porFecha(b.days, d).status)).toEqual(['absent', 'late', 'absent']) // 22:00 local del 11

    const c = fila(carla, v2)
    expect(['2025-03-10', '2025-03-11', '2025-03-12'].map(d => porFecha(c.days, d).status)).toEqual(['absent', 'present', 'present'])
    expect(porFecha(c.days, '2025-03-11').clockInTime).toBe(MORNING.toISOString()) // no la nocturna de las 22:30
    expect(porFecha(c.days, '2025-03-12').clockInTime).toBe(MADRUGADA12.toISOString())

    expect(porFecha(summary.byDay, '2025-03-10')).toEqual({ date: '2025-03-10', present: 0, late: 0, absent: 5 })
    expect(porFecha(summary.byDay, '2025-03-11')).toEqual({ date: '2025-03-11', present: 2, late: 1, absent: 2 })
    expect(porFecha(summary.byDay, '2025-03-12')).toEqual({ date: '2025-03-12', present: 1, late: 0, absent: 4 })
  })

  it('ventas: conteo y monto por vendedor × día local, con totales por día y por tienda', async () => {
    const { staff, summary } = await svc.getSalesHeatmap(orgId, '2025-03-10', '2025-03-13', 'OWNER', mario)
    const fila = (staffId: string, venueId: string) => staff.find(s => s.staffId === staffId && s.venueId === venueId)!
    const tres = (days: Array<{ date: string; salesCount: number; salesAmount: number }>) =>
      ['2025-03-10', '2025-03-11', '2025-03-12'].map(d => [porFecha(days, d).salesCount, round2(porFecha(days, d).salesAmount)])

    const a = fila(ana, v1)
    expect(tres(a.days)).toEqual([
      [0, 0],
      [3, 250],
      [0, 0],
    ])
    expect(round2(a.totalSales)).toBe(250)
    expect(round2(a.avgDailySales)).toBe(250)

    const b = fila(beto, v1)
    expect(tres(b.days)).toEqual([
      [0, 0],
      [1, 80],
      [0, 0],
    ]) // 22:30 local = día 11

    const c = fila(carla, v2)
    expect(tres(c.days)).toEqual([
      [0, 0],
      [2, 165], // el abono de las 23:00 es del 11
      [1, 999],
    ])
    expect(round2(c.avgDailySales)).toBe(582) // (165 + 999) / 2

    expect(porFecha(summary.byDay, '2025-03-10')).toMatchObject({ totalCount: 0, totalAmount: 0 })
    expect(porFecha(summary.byDay, '2025-03-11')).toMatchObject({ totalCount: 6, totalAmount: 495 })
    expect(porFecha(summary.byDay, '2025-03-12')).toMatchObject({ totalCount: 1, totalAmount: 999 })
    const porTienda = new Map(summary.byVenue.map(v => [v.venueId, round2(v.total)]))
    expect(porTienda.get(v1)).toBe(330)
    expect(porTienda.get(v2)).toBe(1164)
  })
})

describe('Los que conservan su findMany con select quirúrgico', () => {
  it('getCrossStoreAnomalies sigue detectando el check-in fuera de la geocerca con el nombre de la persona', async () => {
    const anomalies = await svc.getCrossStoreAnomalies(orgId, TZ)
    const gps = anomalies.filter(a => a.type === 'GPS_VIOLATION')
    expect(gps).toHaveLength(1)
    expect(gps[0].storeId).toBe(v1)
    expect(gps[0].severity).toBe('CRITICAL')
    expect(gps[0].description).toContain('Ana Promotora')
  })

  it('getOnlineStaff lista a quien está dentro con su rol y su tienda', async () => {
    const online = await svc.getOnlineStaff(orgId)
    expect(online.onlineCount).toBe(2)
    expect(online.totalCount).toBe(3)
    expect(online.percentageOnline).toBe(67)
    expect(online.onlineStaff.map(s => [s.staffName, s.venueId, s.role]).sort()).toEqual(
      [
        ['Ana Promotora', v1, 'Staff'],
        ['Carla Sur', v2, 'Staff'],
      ].sort(),
    )
    expect(online.byVenue.find(v => v.venueId === v1)).toEqual({
      venueId: v1,
      venueName: `BAE Norte ${suffix}`,
      onlineCount: 1,
      totalCount: 2,
    })
  })

  it('getClosingReportData arma el reporte del día con el pago cobrado y el promotor', async () => {
    const report = await svc.getClosingReportData(orgId, DIA)
    expect(report.rows).toHaveLength(5) // la de las 00:30 del 12 queda fuera
    expect(round2(report.totalAmount)).toBe(495) // suma lo COBRADO (120 + 45 en la SIM de Carla)
    expect(report.rows[0]).toMatchObject({
      row: 1,
      store: `BAE Sur ${suffix}`,
      iccid: '8952-0005',
      saleType: 'SIM Bait 100',
      promoter: 'Carla Sur',
      amount: 165,
      isPortabilidad: false,
      saleStatus: 'Sin verificación',
    })
    expect(report.rows[4]).toMatchObject({ row: 5, store: `BAE Norte ${suffix}`, promoter: 'Beto Nocturno', amount: 80 })
  })

  it('getStaffAttendanceCalendar marca presente el día de hoy', async () => {
    const { calendar, stats } = await svc.getStaffAttendanceCalendar(orgId, ana)
    const today = calendar.find(d => d.isToday)!
    expect(today.isPresent).toBe(true)
    expect(today.timeEntries).toHaveLength(1)
    expect(stats.present).toBe(1)
  })
})
