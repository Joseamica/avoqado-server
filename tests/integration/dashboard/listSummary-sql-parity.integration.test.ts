/**
 * Integration (REAL PostgreSQL): el resumen SQL de /payments y /orders dice EXACTAMENTE
 * lo mismo que el `where` de Prisma del listado.
 *
 * 2026-09-01 (incidente del query-guard): el dashboard bajaba 10,000 filas para contar
 * pestañas y sumar tarjetas. Ahora el servidor agrega con `GROUP BY`, y su `WHERE` es un
 * ESPEJO escrito a mano de `buildPaymentsWhereClause` / `buildOrdersWhereClause` — Prisma
 * no puede expresar `amount + tipAmount` entre dos valores, así que el resumen no puede
 * reusar el objeto `where` tal cual. Este archivo es lo que vuelve seguro ese espejo:
 *
 *  1. PARIDAD: para una matriz de filtros, `prisma.count({ where })` === `summary.total`.
 *     Un predicado que diverja (ILIKE contra contains, un IN contra un igual, el bind de
 *     fecha, la búsqueda por nombre del mesero…) sale aquí.
 *  2. BORDES: hay un pago exactamente en `from` y otro exactamente en `to` (±1 ms fuera),
 *     que es lo único que fija el `>=`/`<=` y el corrimiento de 6 h de un bind pelón.
 *  3. DOMINIO: los grupos y las sumas se comprueban contra números sembrados a mano
 *     (un golden viejo-contra-nuevo no ve un defecto presente en los dos).
 *  4. CLIENTE: los filtros que antes aplicaba el navegador (subtotal/propina/total,
 *     internacional, marca) se comprueban contra una réplica en Node de esa lógica.
 *
 * Run with:
 *   export TEST_DATABASE_URL='postgresql://…/av-db-25-test'
 *   npx jest --selectProjects integration --testPathPattern listSummary-sql-parity
 */
import prisma from '@/utils/prismaClient'
import { buildPaymentsWhereClause, PaymentFilters } from '@/services/dashboard/payment.dashboard.service'
import { buildOrdersWhereClause, getOrders, OrderFilters } from '@/services/dashboard/order.dashboard.service'
import {
  getPaymentsSummary,
  getPaymentFilterOptions,
  PaymentClientFilters,
  paymentRowPassesClientFilters,
  paymentsSqlScope,
} from '@/services/dashboard/paymentSummary.dashboard.service'
import {
  getOrdersSummary,
  getOrderFilterOptions,
  OrderClientFilters,
  ordersSqlScope,
} from '@/services/dashboard/orderSummary.dashboard.service'
import { passesAmountFilter } from '@/services/dashboard/listSummary.shared'

const suffix = `ls-${Date.now()}`
const round2 = (n: number): number => Math.round(n * 100) / 100

const FROM = new Date('2025-05-10T06:00:00.000Z')
const TO = new Date('2025-05-12T05:59:59.999Z')
const INSIDE = new Date('2025-05-11T18:00:00.000Z')
const FROM_MINUS_1MS = new Date(FROM.getTime() - 1)
const TO_PLUS_1MS = new Date(TO.getTime() + 1)

let orgId: string
let venueId: string
let otherVenueId: string
let ana: string
let bruno: string
let merchantA: string
let merchantB: string
let mesa: string
let providerId: string

const paymentIds: string[] = []
const orderIds: string[] = []

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `ListSummary Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
    select: { id: true },
  })
  orgId = org.id
  const venue = await prisma.venue.create({
    data: { organizationId: orgId, name: `ls-${suffix}`, slug: `ls-${suffix}`, timezone: 'America/Mexico_City' },
    select: { id: true },
  })
  venueId = venue.id
  const other = await prisma.venue.create({
    data: { organizationId: orgId, name: `ls-other-${suffix}`, slug: `ls-other-${suffix}`, timezone: 'America/Mexico_City' },
    select: { id: true },
  })
  otherVenueId = other.id

  ana = (
    await prisma.staff.create({ data: { email: `ana-${suffix}@example.test`, firstName: 'Ana', lastName: 'López' }, select: { id: true } })
  ).id
  bruno = (
    await prisma.staff.create({
      data: { email: `bruno-${suffix}@example.test`, firstName: 'Bruno', lastName: 'Martínez' },
      select: { id: true },
    })
  ).id

  const provider = await prisma.paymentProvider.create({
    data: { code: `LS_${suffix}`, name: 'Proveedor LS', type: 'PAYMENT_PROCESSOR' },
    select: { id: true },
  })
  providerId = provider.id
  merchantA = (
    await prisma.merchantAccount.create({
      data: { providerId, externalMerchantId: `ma-a-${suffix}`, displayName: 'Cuenta A', credentialsEncrypted: {} },
      select: { id: true },
    })
  ).id
  merchantB = (
    await prisma.merchantAccount.create({
      data: { providerId, externalMerchantId: `ma-b-${suffix}`, displayName: null, credentialsEncrypted: {} },
      select: { id: true },
    })
  ).id
  mesa = (await prisma.table.create({ data: { venueId, number: '7', capacity: 4, qrCode: `qr7-${suffix}` }, select: { id: true } })).id

  const cliente = await prisma.customer.create({
    data: { venueId, firstName: 'Carla', lastName: 'Ortiz', phone: `55-${suffix.slice(-6)}` },
    select: { id: true },
  })

  // ── Órdenes (cada una con su pago) ────────────────────────────────────────
  type Seed = {
    key: string
    at: Date
    order: {
      status: string
      type?: string
      total: number
      tip: number
      number: string
      table?: boolean
      servedBy?: string
      withCustomer?: boolean
    }
    payment?: {
      status: string
      type?: string
      method: string
      source?: string
      amount: number
      tip: number
      merchant?: string
      staff?: string
      brand?: string | null
      processorData?: unknown
      maskedPan?: string
      ref?: string
      auth?: string
    }
    venue?: string
  }
  const seeds: Seed[] = [
    // borde exacto: entra (>= from)
    {
      key: 'from',
      at: FROM,
      order: { status: 'COMPLETED', total: 1, tip: 0, number: `B-FROM-${suffix}` },
      payment: { status: 'COMPLETED', method: 'CASH', amount: 1, tip: 0, staff: ana },
    },
    // borde exacto: entra (<= to)
    {
      key: 'to',
      at: TO,
      order: { status: 'COMPLETED', total: 2, tip: 0, number: `B-TO-${suffix}` },
      payment: { status: 'COMPLETED', method: 'CASH', amount: 2, tip: 0, staff: ana },
    },
    // 1 ms fuera por cada lado: NO entran
    {
      key: 'from-1',
      at: FROM_MINUS_1MS,
      order: { status: 'COMPLETED', total: 4, tip: 0, number: `B-OUT1-${suffix}` },
      payment: { status: 'COMPLETED', method: 'CASH', amount: 4, tip: 0, staff: ana },
    },
    {
      key: 'to+1',
      at: TO_PLUS_1MS,
      order: { status: 'COMPLETED', total: 8, tip: 0, number: `B-OUT2-${suffix}` },
      payment: { status: 'COMPLETED', method: 'CASH', amount: 8, tip: 0, staff: ana },
    },
    // completados con tarjeta, marcas y banderas de internacional en las 3 formas
    {
      key: 'visa-intl-bool',
      at: INSIDE,
      order: {
        status: 'COMPLETED',
        type: 'DINE_IN',
        total: 150,
        tip: 15,
        number: `ORD-150-${suffix}`,
        table: true,
        servedBy: ana,
        withCustomer: true,
      },
      payment: {
        status: 'COMPLETED',
        method: 'CREDIT_CARD',
        source: 'TPV',
        amount: 150,
        tip: 15,
        merchant: merchantA,
        staff: ana,
        brand: 'VISA',
        processorData: { isInternational: true },
        maskedPan: `411111******4242`,
        ref: 'REF-777',
        auth: 'AUTH-1',
      },
    },
    {
      key: 'mc-intl-string',
      at: INSIDE,
      order: { status: 'COMPLETED', type: 'TAKEOUT', total: 300, tip: 30, number: `ORD-300-${suffix}`, servedBy: bruno },
      payment: {
        status: 'COMPLETED',
        method: 'DEBIT_CARD',
        source: 'TPV',
        amount: 300,
        tip: 30,
        merchant: merchantB,
        staff: bruno,
        brand: 'MASTERCARD',
        processorData: { isInternational: 'true' },
        maskedPan: `555555******5555`,
      },
    },
    {
      key: 'amex-fallback-brand',
      at: INSIDE,
      order: { status: 'COMPLETED', type: 'DINE_IN', total: 99.99, tip: 0, number: `ORD-99-${suffix}`, servedBy: ana },
      // sin cardBrand en la columna: el cliente cae a processorData.cardBrand (y lo pone en mayúsculas)
      payment: {
        status: 'COMPLETED',
        method: 'CREDIT_CARD',
        source: 'QR',
        amount: 99.99,
        tip: 0,
        merchant: merchantA,
        staff: ana,
        brand: null,
        processorData: { cardBrand: 'american_express', isInternational: false },
      },
    },
    // efectivo sin marca, sin processorData
    {
      key: 'cash',
      at: INSIDE,
      order: { status: 'COMPLETED', type: 'DINE_IN', total: 100.5, tip: 10.25, number: `ORD-100-${suffix}`, table: true, servedBy: ana },
      payment: { status: 'COMPLETED', method: 'CASH', source: 'POS', amount: 100.5, tip: 10.25, staff: ana },
    },
    // reembolso moderno: COMPLETED + type REFUND, monto negativo
    {
      key: 'refund-modern',
      at: INSIDE,
      order: { status: 'COMPLETED', total: 50, tip: 0, number: `ORD-R1-${suffix}` },
      payment: { status: 'COMPLETED', type: 'REFUND', method: 'CASH', source: 'POS', amount: -50, tip: 0, staff: bruno },
    },
    // reembolso legacy: status REFUNDED
    {
      key: 'refund-legacy',
      at: INSIDE,
      order: { status: 'COMPLETED', total: 70, tip: 0, number: `ORD-R2-${suffix}` },
      payment: {
        status: 'REFUNDED',
        method: 'CREDIT_CARD',
        source: 'TPV',
        amount: 70,
        tip: 0,
        merchant: merchantA,
        staff: ana,
        brand: 'VISA',
      },
    },
    // PROCESSING (cuenta en «pendientes»), FAILED (cuenta en «todos», en ninguna pestaña), PENDING (el listado lo excluye)
    {
      key: 'processing',
      at: INSIDE,
      order: { status: 'CONFIRMED', total: 20, tip: 0, number: `ORD-P-${suffix}` },
      payment: { status: 'PROCESSING', method: 'CREDIT_CARD', amount: 20, tip: 0, staff: bruno },
    },
    {
      key: 'failed',
      at: INSIDE,
      order: { status: 'CONFIRMED', total: 30, tip: 0, number: `ORD-F-${suffix}` },
      payment: { status: 'FAILED', method: 'CREDIT_CARD', amount: 30, tip: 0, staff: bruno },
    },
    {
      key: 'pending',
      at: INSIDE,
      order: { status: 'PENDING', total: 40, tip: 0, number: `ORD-PEND-${suffix}` },
      payment: { status: 'PENDING', method: 'CREDIT_CARD', amount: 40, tip: 0 },
    },
    // órdenes en estados que el listado excluye por default, y una FAST
    { key: 'cancelled', at: INSIDE, order: { status: 'CANCELLED', total: 60, tip: 0, number: `ORD-C-${suffix}` } },
    { key: 'deleted', at: INSIDE, order: { status: 'DELETED', total: 61, tip: 0, number: `ORD-D-${suffix}` } },
    { key: 'fast', at: INSIDE, order: { status: 'COMPLETED', total: 25, tip: 2, number: `FAST-${suffix}` } },
    {
      key: 'ready',
      at: INSIDE,
      order: { status: 'READY', type: 'DELIVERY', total: 80, tip: 8, number: `ORD-RD-${suffix}`, servedBy: bruno },
    },
    // otro venue: NUNCA cuenta
    {
      key: 'other-venue',
      at: INSIDE,
      venue: 'other',
      order: { status: 'COMPLETED', total: 999, tip: 99, number: `ORD-OTHER-${suffix}` },
      payment: { status: 'COMPLETED', method: 'CASH', amount: 999, tip: 99, staff: ana },
    },
  ]

  for (const s of seeds) {
    const vid = s.venue === 'other' ? otherVenueId : venueId
    const order = await prisma.order.create({
      data: {
        venueId: vid,
        orderNumber: s.order.number,
        type: (s.order.type ?? 'DINE_IN') as any,
        status: s.order.status as any,
        createdAt: s.at,
        subtotal: s.order.total,
        taxAmount: 0,
        tipAmount: s.order.tip,
        total: s.order.total,
        tableId: s.order.table ? mesa : undefined,
        servedById: s.order.servedBy,
        ...(s.order.withCustomer ? { orderCustomers: { create: [{ customerId: cliente.id }] } } : {}),
      },
      select: { id: true },
    })
    orderIds.push(order.id)
    if (s.payment) {
      const p = s.payment
      const pay = await prisma.payment.create({
        data: {
          venueId: vid,
          orderId: order.id,
          createdAt: s.at,
          status: p.status as any,
          type: (p.type ?? 'REGULAR') as any,
          method: p.method as any,
          source: (p.source ?? 'OTHER') as any,
          amount: p.amount,
          tipAmount: p.tip,
          feePercentage: 0,
          feeAmount: 0,
          netAmount: p.amount,
          merchantAccountId: p.merchant,
          processedById: p.staff,
          cardBrand: (p.brand ?? undefined) as any,
          processorData: p.processorData as any,
          maskedPan: p.maskedPan,
          referenceNumber: p.ref,
          authorizationNumber: p.auth,
        },
        select: { id: true },
      })
      paymentIds.push(pay.id)
    }
  }
})

afterAll(async () => {
  await prisma.payment.deleteMany({ where: { id: { in: paymentIds } } })
  await prisma.orderCustomer.deleteMany({ where: { orderId: { in: orderIds } } })
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } })
  await prisma.customer.deleteMany({ where: { venueId: { in: [venueId, otherVenueId] } } })
  await prisma.table.deleteMany({ where: { venueId: { in: [venueId, otherVenueId] } } })
  await prisma.merchantAccount.deleteMany({ where: { id: { in: [merchantA, merchantB] } } })
  await prisma.paymentProvider.deleteMany({ where: { id: providerId } })
  await prisma.staff.deleteMany({ where: { id: { in: [ana, bruno] } } })
  await prisma.venue.deleteMany({ where: { id: { in: [venueId, otherVenueId] } } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
  await prisma.$disconnect()
})

const RANGE = { startDate: FROM.toISOString(), endDate: TO.toISOString() }

// ─── 1. Paridad: el espejo SQL cuenta lo mismo que el where de Prisma ─────────
describe('paridad pagos: summary.total === prisma.payment.count({ where: buildPaymentsWhereClause })', () => {
  const matriz: Array<[string, PaymentFilters]> = [
    ['sin filtros', {}],
    ['rango', RANGE],
    ['rango + efectivo', { ...RANGE, methods: ['CASH'] as any }],
    ['rango + tarjetas', { ...RANGE, methods: ['CREDIT_CARD', 'DEBIT_CARD'] as any }],
    ['método de UN valor (legacy)', { ...RANGE, method: 'CREDIT_CARD' as any }],
    ['sources TPV+POS', { ...RANGE, sources: ['TPV', 'POS'] }],
    ['source de UN valor', { ...RANGE, source: 'QR' }],
    ['merchant A', { ...RANGE, merchantAccountIds: [] as string[] }], // se completa abajo
    ['staff Ana', { ...RANGE, staffIds: [] as string[] }],
    ['staff de UN valor', { ...RANGE, staffId: '' }],
    ['búsqueda por nombre (ana)', { ...RANGE, search: 'ana' }],
    ['búsqueda por apellido con acento (lópez)', { ...RANGE, search: 'LÓPEZ' }],
    ['búsqueda numérica 150', { ...RANGE, search: '150' }],
    ['búsqueda numérica 15 (casa propina 15)', { ...RANGE, search: '15' }],
    ['búsqueda numérica con centavos 99.9 (amount en [99.9, 100.9))', { ...RANGE, search: '99.9' }],
    ['búsqueda numérica exacta 99.99', { ...RANGE, search: '99.99' }],
    ['búsqueda numérica 0.5 (no casa 0.25 ni 1)', { ...RANGE, search: '0.5' }],
    ['búsqueda numérica 100.5', { ...RANGE, search: '100.5' }],
    ['búsqueda por últimos 4 (4242)', { ...RANGE, search: '4242' }],
    ['búsqueda por referencia', { ...RANGE, search: 'ref-7' }],
    ['búsqueda por autorización', { ...RANGE, search: 'auth' }],
    ['búsqueda con espacios', { ...RANGE, search: '  bruno  ' }],
    ['búsqueda con comodín de SQL (%)', { ...RANGE, search: '%' }],
    ['búsqueda con guión bajo (_)', { ...RANGE, search: 'REF_7' }],
    ['búsqueda sin resultados', { ...RANGE, search: 'zzz-nadie' }],
    ['todo junto', { ...RANGE, methods: ['CREDIT_CARD'] as any, sources: ['TPV'], search: 'a' }],
    ['sólo startDate', { startDate: FROM.toISOString() }],
    ['sólo endDate', { endDate: TO.toISOString() }],
  ]

  it.each(matriz)('%s', async (_nombre, base) => {
    const filters: PaymentFilters = { ...base }
    if ('merchantAccountIds' in filters) filters.merchantAccountIds = [merchantA]
    if ('staffIds' in filters) filters.staffIds = [ana]
    if ('staffId' in filters) filters.staffId = bruno

    const esperado = await prisma.payment.count({ where: buildPaymentsWhereClause(venueId, filters) })
    const summary = await getPaymentsSummary(venueId, filters)
    expect(summary.total).toBe(esperado)
    // No sólo el CONTEO: el MISMO conjunto de filas. Un espejo que casa la fila A donde Prisma
    // casa la B daría el mismo total y seguiría mintiendo.
    const idsPrisma = (
      await prisma.payment.findMany({ where: buildPaymentsWhereClause(venueId, filters), select: { id: true }, take: 1000 })
    )
      .map(r => r.id)
      .sort()
    const idsSql = (
      await prisma.$queryRaw<Array<{ id: string }>>`SELECT p."id" FROM "Payment" p WHERE ${paymentsSqlScope(venueId, filters)}`
    )
      .map(r => r.id)
      .sort()
    expect(idsSql).toEqual(idsPrisma)
    // Sin filtros del cliente, los dos juegos de grupos son el mismo.
    expect(summary.filteredGroups).toEqual(summary.groups)
    expect(summary.filteredTotal).toBe(esperado)
  })

  it('merchant de UN valor (legacy) — paridad', async () => {
    const filters: PaymentFilters = { ...RANGE, merchantAccountId: merchantB }
    const esperado = await prisma.payment.count({ where: buildPaymentsWhereClause(venueId, filters) })
    expect((await getPaymentsSummary(venueId, filters)).total).toBe(esperado)
    expect(esperado).toBe(1)
  })
})

describe('paridad órdenes: summary.total === prisma.order.count({ where: buildOrdersWhereClause })', () => {
  const matriz: Array<[string, OrderFilters]> = [
    ['sin filtros (excluye PENDING/CANCELLED/DELETED)', {}],
    ['rango', RANGE],
    ['statuses CANCELLED (anula la exclusión)', { ...RANGE, statuses: ['CANCELLED'] }],
    ['statuses PENDING+DELETED', { ...RANGE, statuses: ['PENDING', 'DELETED'] }],
    ['types DINE_IN', { ...RANGE, types: ['DINE_IN'] }],
    ['types DELIVERY+TAKEOUT', { ...RANGE, types: ['DELIVERY', 'TAKEOUT'] }],
    ['types FAST («Venta sin productos»: prefijo del número, no un OrderType)', { ...RANGE, types: ['FAST'] }],
    ['types FAST + DINE_IN', { ...RANGE, types: ['FAST', 'DINE_IN'] }],
    ['types FAST + búsqueda (el OR de la búsqueda no se pisa)', { ...RANGE, types: ['FAST'], search: 'fast' }],
    ['types FAST + búsqueda sin resultados', { ...RANGE, types: ['FAST'], search: 'zzz-nadie' }],
    ['tableIds', { ...RANGE, tableIds: [] as string[] }],
    ['staffIds (servedBy)', { ...RANGE, staffIds: [] as string[] }],
    ['búsqueda FAST', { ...RANGE, search: 'fast' }],
    ['búsqueda por número de orden', { ...RANGE, search: 'ORD-300' }],
    ['búsqueda numérica 100 (total en [100,101))', { ...RANGE, search: '100' }],
    ['búsqueda numérica con centavos 99.9', { ...RANGE, search: '99.9' }],
    ['búsqueda numérica exacta 100.5', { ...RANGE, search: '100.5' }],
    ['búsqueda por cliente (carla)', { ...RANGE, search: 'carla' }],
    ['búsqueda por teléfono del cliente', { ...RANGE, search: suffix.slice(-6) }],
    ['búsqueda sin resultados', { ...RANGE, search: 'zzz-nadie' }],
    ['búsqueda con comodín (%)', { ...RANGE, search: '%' }],
    ['todo junto', { ...RANGE, types: ['DINE_IN'], staffIds: [] as string[], search: 'ord' }],
  ]

  it.each(matriz)('%s', async (_nombre, base) => {
    const filters: OrderFilters = { ...base }
    if ('tableIds' in filters) filters.tableIds = [mesa]
    if ('staffIds' in filters) filters.staffIds = [ana]

    const esperado = await prisma.order.count({ where: buildOrdersWhereClause(venueId, filters) })
    const summary = await getOrdersSummary(venueId, filters)
    expect(summary.total).toBe(esperado)
    const idsPrisma = (await prisma.order.findMany({ where: buildOrdersWhereClause(venueId, filters), select: { id: true }, take: 1000 }))
      .map(r => r.id)
      .sort()
    const idsSql = (await prisma.$queryRaw<Array<{ id: string }>>`SELECT o."id" FROM "Order" o WHERE ${ordersSqlScope(venueId, filters)}`)
      .map(r => r.id)
      .sort()
    expect(idsSql).toEqual(idsPrisma)
    expect(summary.filteredGroups).toEqual(summary.groups)
  })
})

// ─── 2. Bordes exactos del rango ───────────────────────────────────────────────
describe('bordes del rango (fija >= / <= y el bind utcTs)', () => {
  it('el pago de exactamente `from` y el de exactamente `to` entran; ±1 ms quedan fuera', async () => {
    const s = await getPaymentsSummary(venueId, { ...RANGE, methods: ['CASH'] as any, staffIds: [ana] })
    // from(1) + to(2) + cash(100.5) — los de ±1 ms (4 y 8) no.
    const cash = s.groups.find(g => g.status === 'COMPLETED' && g.type === 'REGULAR')!
    expect(cash.count).toBe(3)
    expect(round2(cash.amount)).toBe(103.5)
  })

  it('órdenes: mismo borde', async () => {
    const s = await getOrdersSummary(venueId, { ...RANGE, search: 'B-' })
    expect(s.total).toBe(2)
    expect(round2(s.groups[0].total)).toBe(3)
  })
})

// ─── 3. Dominio: grupos y sumas contra lo sembrado ────────────────────────────
describe('grupos de pagos (dominio)', () => {
  it('estado×tipo con conteos y sumas exactas; los reembolsos van con su signo', async () => {
    const s = await getPaymentsSummary(venueId, RANGE)
    const g = (status: string, type: string) => s.groups.find(x => x.status === status && x.type === type)
    // from 1 + to 2 + visa 150 + mc 300 + amex 99.99 + cash 100.5 = 653.49; propinas 15+30+10.25 = 55.25
    expect(g('COMPLETED', 'REGULAR')).toMatchObject({ count: 6 })
    expect(round2(g('COMPLETED', 'REGULAR')!.amount)).toBe(653.49)
    expect(round2(g('COMPLETED', 'REGULAR')!.tipAmount)).toBe(55.25)
    expect(g('COMPLETED', 'REFUND')).toMatchObject({ count: 1, amount: -50, tipAmount: 0 })
    expect(g('REFUNDED', 'REGULAR')).toMatchObject({ count: 1, amount: 70 })
    expect(g('PROCESSING', 'REGULAR')).toMatchObject({ count: 1, amount: 20 })
    expect(g('FAILED', 'REGULAR')).toMatchObject({ count: 1, amount: 30 })
    // PENDING excluido, otro venue excluido
    expect(s.groups.find(x => x.status === 'PENDING')).toBeUndefined()
    expect(s.total).toBe(10)
  })

  it('un venue sin pagos devuelve grupos vacíos y total 0', async () => {
    const s = await getPaymentsSummary(otherVenueId, { ...RANGE, methods: ['CRYPTOCURRENCY'] as any })
    expect(s).toEqual({ groups: [], filteredGroups: [], total: 0, filteredTotal: 0 })
  })
})

describe('el filtro «Venta sin productos» (types=FAST) — cerrado el 2026-09-01', () => {
  it('el listado ya NO revienta y devuelve sólo las órdenes FAST-…', async () => {
    const r = await getOrders(venueId, 1, 10, { ...RANGE, types: ['FAST'] })
    expect(r.meta.total).toBe(1)
    expect(r.data[0].orderNumber).toBe(`FAST-${suffix}`)
  })

  it('FAST junto a un tipo real es un OR: las FAST más las de ese tipo', async () => {
    const r = await getOrdersSummary(venueId, { ...RANGE, types: ['FAST', 'DELIVERY'] })
    expect(r.total).toBe(2) // FAST-… + la READY de tipo DELIVERY
    const soloDelivery = await getOrdersSummary(venueId, { ...RANGE, types: ['DELIVERY'] })
    expect(soloDelivery.total).toBe(1)
  })
})

describe('grupos de órdenes (dominio)', () => {
  it('por estado, sin PENDING/CANCELLED/DELETED, sin el otro venue', async () => {
    const s = await getOrdersSummary(venueId, RANGE)
    const g = (status: string) => s.groups.find(x => x.status === status)
    // COMPLETED: from 1, to 2, 150, 300, 99.99, 100.5, R1 50, R2 70, fast 25 = 798.49; tips 15+30+10.25+2 = 57.25
    expect(g('COMPLETED')).toMatchObject({ count: 9 })
    expect(round2(g('COMPLETED')!.total)).toBe(798.49)
    expect(round2(g('COMPLETED')!.tipAmount)).toBe(57.25)
    expect(g('CONFIRMED')).toMatchObject({ count: 2, total: 50 })
    expect(g('READY')).toMatchObject({ count: 1, total: 80, tipAmount: 8 })
    expect(g('PENDING')).toBeUndefined()
    expect(g('CANCELLED')).toBeUndefined()
    expect(s.total).toBe(12)
  })
})

// ─── 4. Los filtros que antes aplicaba el navegador ──────────────────────────
describe('filtros del cliente en SQL == réplica en Node sobre las filas', () => {
  const casos: Array<[string, PaymentClientFilters]> = [
    ['subtotal > 100', { subtotal: { operator: 'gt', value: 100 } }],
    ['subtotal < 100', { subtotal: { operator: 'lt', value: 100 } }],
    ['subtotal = 99.99 (decimal exacto, no float)', { subtotal: { operator: 'eq', value: 99.99 } }],
    ['subtotal > 99.99 (borde con centavos: 99.99 NO pasa)', { subtotal: { operator: 'gt', value: 99.99 } }],
    ['subtotal < 100.5 (borde: 100.5 NO pasa)', { subtotal: { operator: 'lt', value: 100.5 } }],
    ['propina = 10.25', { tip: { operator: 'eq', value: 10.25 } }],
    ['subtotal between 1..2 (inclusivo)', { subtotal: { operator: 'between', value: 1, value2: 2 } }],
    ['gt sin valor (cuenta como 0: deja fuera al reembolso negativo)', { subtotal: { operator: 'gt' } }],
    ['propina between 10..15', { tip: { operator: 'between', value: 10, value2: 15 } }],
    ['propina = 0', { tip: { operator: 'eq', value: 0 } }],
    ['total (monto+propina) < 120', { total: { operator: 'lt', value: 120 } }],
    ['total between 110.75..165 (casa 110.75 y 165 exactos)', { total: { operator: 'between', value: 110.75, value2: 165 } }],
    ['internacional sí (boolean y cadena "true")', { international: ['yes'] }],
    ['internacional no (false, null y sin processorData)', { international: ['no'] }],
    ['internacional sí+no = sin filtro', { international: ['yes', 'no'] }],
    ['marca VISA (columna)', { cardBrands: ['VISA'] }],
    ['marca AMEX sólo en processorData, en minúsculas', { cardBrands: ['AMERICAN_EXPRESS'] }],
    ['marcas VISA+MASTERCARD', { cardBrands: ['VISA', 'MASTERCARD'] }],
    ['marca en minúsculas desde el cliente', { cardBrands: ['visa'] }],
    [
      'combinado',
      {
        subtotal: { operator: 'gt', value: 50 },
        total: { operator: 'lt', value: 500 },
        international: ['no'],
        cardBrands: ['MASTERCARD', 'VISA'],
      },
    ],
  ]

  it.each(casos)('%s', async (_nombre, client) => {
    const rows = await prisma.payment.findMany({
      where: buildPaymentsWhereClause(venueId, RANGE),
      select: { amount: true, tipAmount: true, cardBrand: true, processorData: true, status: true, type: true },
      take: 1000,
    })
    expect(rows.length).toBeLessThan(1000) // el oráculo tiene que ver TODAS las filas
    const esperadas = rows.filter(r => paymentRowPassesClientFilters(r, client))
    const summary = await getPaymentsSummary(venueId, RANGE, client)
    expect(summary.filteredTotal).toBe(esperadas.length)
    // Y las sumas también, no sólo el conteo.
    const sumaEsperada = round2(esperadas.reduce((s, r) => s + Number(r.amount), 0))
    expect(round2(summary.filteredGroups.reduce((s, g) => s + g.amount, 0))).toBe(sumaEsperada)
    // Los grupos SIN filtros del cliente no se tocan.
    expect(summary.total).toBe(rows.length)
  })

  it('un grupo que el filtro del cliente vacía desaparece de filteredGroups (como un GROUP BY del subconjunto)', async () => {
    const s = await getPaymentsSummary(venueId, RANGE, { subtotal: { operator: 'gt', value: 100 } })
    expect(s.groups.some(g => g.status === 'PROCESSING')).toBe(true)
    expect(s.filteredGroups.some(g => g.status === 'PROCESSING')).toBe(false) // el de $20 no pasa
    expect(s.filteredGroups.every(g => g.count > 0)).toBe(true)
  })

  it('la réplica en Node de passesAmountFilter es la de Payments.tsx', () => {
    expect(passesAmountFilter(5, { operator: 'gt', value: 5 })).toBe(false)
    expect(passesAmountFilter(5, { operator: 'between', value: 5, value2: 5 })).toBe(true)
    expect(passesAmountFilter(-50, { operator: 'gt' })).toBe(false)
    expect(passesAmountFilter(0, { operator: 'lt', value: 1 })).toBe(true)
    expect(passesAmountFilter(7, undefined)).toBe(true)
  })

  it('órdenes: total y propina', async () => {
    const casosO: OrderClientFilters[] = [
      { total: { operator: 'gt', value: 100 } },
      { total: { operator: 'between', value: 50, value2: 100 } },
      { total: { operator: 'eq', value: 99.99 } },
      { tip: { operator: 'gt', value: 0 } },
      { tip: { operator: 'lt', value: 5 } },
      { total: { operator: 'gt', value: 100 }, tip: { operator: 'gt', value: 0 } },
    ]
    const rows = await prisma.order.findMany({
      where: buildOrdersWhereClause(venueId, RANGE),
      select: { total: true, tipAmount: true },
      take: 1000,
    })
    for (const client of casosO) {
      const esperadas = rows.filter(
        r => passesAmountFilter(Number(r.total) || 0, client.total) && passesAmountFilter(Number(r.tipAmount) || 0, client.tip),
      )
      const s = await getOrdersSummary(venueId, RANGE, client)
      expect(s.filteredTotal).toBe(esperadas.length)
      expect(round2(s.filteredGroups.reduce((a, g) => a + g.total, 0))).toBe(round2(esperadas.reduce((a, r) => a + Number(r.total), 0)))
    }
  })
})

// ─── Opciones de los filtros ───────────────────────────────────────────────────
describe('filter-options: valores distintos del venue, mismo alcance base que el listado', () => {
  it('pagos: cuentas, métodos, orígenes, meseros y marcas (con el fallback de processorData)', async () => {
    const o = await getPaymentFilterOptions(venueId)
    expect(o.merchantAccounts.map(m => m.id).sort()).toEqual([merchantA, merchantB].sort())
    expect(o.methods).toEqual(['CASH', 'CREDIT_CARD', 'DEBIT_CARD'])
    expect(o.sources.sort()).toEqual(['OTHER', 'POS', 'QR', 'TPV'])
    expect(o.waiters.map(w => w.id).sort()).toEqual([ana, bruno].sort())
    expect(o.cardBrands).toEqual(['AMERICAN_EXPRESS', 'MASTERCARD', 'VISA'])
  })

  it('órdenes: estados (sin PENDING/CANCELLED/DELETED), tipos, FAST, mesas y meseros', async () => {
    const o = await getOrderFilterOptions(venueId)
    expect(o.statuses).toEqual(['COMPLETED', 'CONFIRMED', 'READY'])
    expect(o.types).toEqual(['DELIVERY', 'DINE_IN', 'TAKEOUT'])
    expect(o.hasFastSales).toBe(true)
    expect(o.tables.map(t => t.id)).toEqual([mesa])
    expect(o.waiters.map(w => w.id).sort()).toEqual([ana, bruno].sort())
  })

  it('un venue sin órdenes: todo vacío y sin FAST', async () => {
    const o = await getOrderFilterOptions(otherVenueId)
    expect(o).toEqual({ statuses: ['COMPLETED'], types: ['DINE_IN'], hasFastSales: false, tables: [], waiters: [] })
  })
})
