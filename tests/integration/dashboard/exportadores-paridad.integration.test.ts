/**
 * Integración (Postgres REAL): los exportadores nuevos devuelven EXACTAMENTE las filas y los valores de los GET viejos,
 * recorriendo por keyset con 4 cobros en el MISMO instante y páginas de 2, y el corte deja fuera lo posterior.
 * Lo que una prueba unitaria no ve: la precisión de `createdAt` en Postgres contra el `Date` de JS en la frontera de página.
 *
 *   ./scripts/avq-verify.sh avoqado-server npx jest --selectProjects=integration --runTestsByPath tests/integration/dashboard/exportadores-paridad.integration.test.ts --ci
 */
import prisma from '@/utils/prismaClient'
import type { ExportColumnDef } from '@/services/dashboard/export.helpers'
import cuid from 'cuid'
import { fetchOrdersForExport } from '@/services/dashboard/order.dashboard.service'
import { fetchPaymentsForExport } from '@/services/dashboard/payment.dashboard.service'
import { fetchSalesSummaryDetailRows } from '@/services/dashboard/sales-summary.dashboard.service'
import { cobros, COBROS_COLUMNAS } from '@/services/exports/exportadores/cobros.exportador'
import { ordenes, ORDENES_COLUMNAS } from '@/services/exports/exportadores/ordenes.exportador'
import { ventasDetalladas, VENTAS_DETALLADAS_COLUMNAS } from '@/services/exports/exportadores/ventasDetalladas.exportador'
import type { Cursor, Exportador } from '@/services/exports/exportadores/types'

interface Semillas {
  orgId?: string
  venueId?: string
  staffId?: string
  providerId?: string
  merchantId?: string
  orderIds: string[]
  paymentIds: string[]
}

/** Borra SÓLO lo que sí se creó (regla del workspace: nunca un deleteMany con un id undefined). */
export async function limpiarSemillas(
  db: Pick<typeof prisma, 'payment' | 'order' | 'merchantAccount' | 'paymentProvider' | 'staff' | 'venue' | 'organization'>,
  x: Semillas,
) {
  if (x.paymentIds.length) await db.payment.deleteMany({ where: { id: { in: x.paymentIds } } })
  if (x.orderIds.length) await db.order.deleteMany({ where: { id: { in: x.orderIds } } })
  if (x.merchantId) await db.merchantAccount.deleteMany({ where: { id: x.merchantId } })
  if (x.providerId) await db.paymentProvider.deleteMany({ where: { id: x.providerId } })
  if (x.staffId) await db.staff.deleteMany({ where: { id: x.staffId } })
  if (x.venueId) await db.venue.deleteMany({ where: { id: x.venueId } })
  if (x.orgId) await db.organization.deleteMany({ where: { id: x.orgId } })
}

const sufijo = `exp-${Date.now()}`
const T = new Date('2025-10-15T18:00:00.000Z')
const RANGO = { startDate: '2025-10-01T06:00:00.000Z', endDate: '2025-11-01T05:59:59.999Z' }
// Órdenes: rango propio (noviembre) para no mezclarse con las semillas de cobros. 4 empates en TO, una FAST-, una que la búsqueda excluye y una posterior al corte.
const TO = new Date('2025-11-10T18:00:00.000Z')
const RANGO_ORD = { startDate: '2025-11-01T06:00:00.000Z', endDate: '2025-12-01T05:59:59.999Z' }
const CORTE_ORD = new Date('2025-11-10T19:00:00.000Z')
const s: Semillas = { orderIds: [], paymentIds: [] }

beforeAll(async () => {
  s.orgId = (
    await prisma.organization.create({
      data: { name: `Exp Org ${sufijo}`, email: `${sufijo}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  s.venueId = (
    await prisma.venue.create({
      data: { organizationId: s.orgId, name: `exp-${sufijo}`, slug: `exp-${sufijo}`, timezone: 'America/Mexico_City' },
      select: { id: true },
    })
  ).id
  s.staffId = (
    await prisma.staff.create({ data: { email: `ana-${sufijo}@example.test`, firstName: 'Ana', lastName: 'López' }, select: { id: true } })
  ).id
  s.providerId = (
    await prisma.paymentProvider.create({
      data: { code: `EXP_${sufijo}`, name: 'Proveedor EXP', type: 'PAYMENT_PROCESSOR' },
      select: { id: true },
    })
  ).id
  s.merchantId = (
    await prisma.merchantAccount.create({
      data: { providerId: s.providerId, externalMerchantId: `ma-${sufijo}`, displayName: 'Cuenta A', credentialsEncrypted: {} },
      select: { id: true },
    })
  ).id

  const semillas: Array<{ at: Date; status: string; method: string; amount: number; tip: number; pan?: string; intl?: unknown }> = [
    { at: T, status: 'COMPLETED', method: 'CREDIT_CARD', amount: 100, tip: 10, pan: '411111******1234', intl: true },
    { at: T, status: 'COMPLETED', method: 'CASH', amount: 50, tip: 0 },
    { at: T, status: 'COMPLETED', method: 'DEBIT_CARD', amount: 75.5, tip: 7.5, pan: '522222******9876', intl: 'true' },
    { at: T, status: 'REFUNDED', method: 'CASH', amount: 20, tip: 0 }, // cobros sí; ventas detalladas no (sólo COMPLETED)
    { at: new Date(+T - 1000), status: 'COMPLETED', method: 'CASH', amount: 30, tip: 3 },
    { at: new Date(+T + 1000), status: 'COMPLETED', method: 'CASH', amount: 40, tip: 4 },
    { at: new Date(+T - 2000), status: 'PENDING', method: 'CASH', amount: 99, tip: 0 }, // fuera de los dos
  ]
  for (const [i, x] of semillas.entries()) {
    const order = await prisma.order.create({
      data: {
        venueId: s.venueId,
        orderNumber: `EXP-${i}-${sufijo}`,
        type: 'DINE_IN' as any,
        status: 'COMPLETED' as any,
        createdAt: x.at,
        subtotal: x.amount,
        taxAmount: 0,
        tipAmount: x.tip,
        total: x.amount,
      },
      select: { id: true },
    })
    s.orderIds.push(order.id)
    const pay = await prisma.payment.create({
      data: {
        venueId: s.venueId,
        orderId: order.id,
        createdAt: x.at,
        status: x.status as any,
        type: 'REGULAR' as any,
        method: x.method as any,
        source: 'TPV' as any,
        amount: x.amount,
        tipAmount: x.tip,
        feePercentage: 0,
        feeAmount: 0,
        netAmount: x.amount,
        merchantAccountId: x.pan ? s.merchantId : undefined,
        processedById: s.staffId,
        maskedPan: x.pan,
        processorData: x.intl === undefined ? undefined : ({ isInternational: x.intl } as any),
      },
      select: { id: true },
    })
    s.paymentIds.push(pay.id)
  }

  const ordSemillas: Array<{ n: string; at: Date }> = [
    ...[1, 2, 3, 4].map(i => ({ n: `ORD-${sufijo}-${i}`, at: TO })),
    { n: `FAST-ORD-${sufijo}`, at: new Date(+TO - 1000) },
    { n: `OTRO-${sufijo}`, at: new Date(+TO - 2000) }, // la búsqueda `ORD-<sufijo>` la excluye
    { n: `ORD-${sufijo}-TARDE`, at: new Date(+CORTE_ORD + 60_000) }, // creada después del corte
  ]
  for (const o of ordSemillas) {
    const id = cuid() // cuid v1, como `@default(cuid())`
    await prisma.order.create({
      data: {
        id,
        venueId: s.venueId,
        orderNumber: o.n,
        type: 'DINE_IN' as any,
        status: 'COMPLETED' as any,
        createdAt: o.at,
        subtotal: 10,
        taxAmount: 0,
        tipAmount: 1,
        total: 10,
        createdById: s.staffId,
      },
      select: { id: true },
    })
    s.orderIds.push(id)
  }
})

afterAll(async () => {
  await limpiarSemillas(prisma, s)
  await prisma.$disconnect()
})

async function recorrer<F, R>(exp: Exportador<F, R>, filtros: F, corte: Date, limite = 2): Promise<R[]> {
  const out: R[] = []
  let cursor: Cursor | null = null
  for (;;) {
    const p = await exp.pagina(s.venueId!, filtros, corte, cursor, limite)
    out.push(...p)
    if (p.length < limite) return out
    cursor = exp.cursorDe(p[p.length - 1])
  }
}
const porId = <R>(cols: ExportColumnDef<R>[], filas: R[]) =>
  Object.fromEntries(filas.map(f => [(f as unknown as { id: string }).id, cols.map(c => c.value(f) ?? '')]))

describe('paridad de los exportadores contra los GET viejos (Postgres real)', () => {
  it('cobros: mismas 6 filas y valores que el GET viejo; sin duplicados con 4 empates y páginas de 2; orden createdAt desc, id desc', async () => {
    const filtros = cobros.parsearFiltros(RANGO)
    const nuevo = await recorrer(cobros, filtros, new Date())
    const viejo = await fetchPaymentsForExport(s.venueId!, RANGO, 10_000)
    expect(nuevo).toHaveLength(6)
    expect(new Set(nuevo.map(f => f.id)).size).toBe(6)
    expect(porId(COBROS_COLUMNAS, nuevo)).toEqual(porId(COBROS_COLUMNAS, viejo as never))
    expect(await cobros.contar(s.venueId!, filtros, new Date())).toBe(6)
    for (let i = 1; i < nuevo.length; i++) {
      const [a, b] = [nuevo[i - 1], nuevo[i]]
      expect(+a.createdAt > +b.createdAt || (+a.createdAt === +b.createdAt && a.id > b.id)).toBe(true)
    }
  })
  it('ventas detalladas: mismas 5 filas COMPLETED y valores que el GET viejo', async () => {
    const filtros = ventasDetalladas.parsearFiltros(RANGO)
    const nuevo = await recorrer(ventasDetalladas, filtros, new Date())
    const viejo = await fetchSalesSummaryDetailRows(s.venueId!, filtros, 10_000)
    expect(nuevo).toHaveLength(5)
    expect(porId(VENTAS_DETALLADAS_COLUMNAS, nuevo)).toEqual(porId(VENTAS_DETALLADAS_COLUMNAS, viejo))
    expect(await ventasDetalladas.contar(s.venueId!, filtros, new Date())).toBe(5)
  })
  it('órdenes: mismas filas y valores que el GET viejo; sin duplicados con 4 empates y páginas de 2; FAST y búsqueda filtran igual; el corte deja fuera la posterior', async () => {
    const comparar = async (raw: Record<string, unknown>, esperadas: number) => {
      const filtros = ordenes.parsearFiltros({ ...RANGO_ORD, ...raw })
      const nuevo = await recorrer(ordenes, filtros, CORTE_ORD)
      const viejo = (await fetchOrdersForExport(s.venueId!, filtros, 10_000)).filter(o => +o.createdAt <= +CORTE_ORD)
      expect(nuevo).toHaveLength(esperadas)
      expect(new Set(nuevo.map(f => f.id)).size).toBe(esperadas)
      expect(porId(ORDENES_COLUMNAS, nuevo)).toEqual(porId(ORDENES_COLUMNAS, viejo))
      expect(await ordenes.contar(s.venueId!, filtros, CORTE_ORD)).toBe(esperadas)
      for (let i = 1; i < nuevo.length; i++) {
        const [a, b] = [nuevo[i - 1], nuevo[i]]
        expect(+a.createdAt > +b.createdAt || (+a.createdAt === +b.createdAt && a.id > b.id)).toBe(true)
      }
      return nuevo
    }
    await comparar({}, 6) // 4 empates + FAST + OTRO; la TARDE queda fuera por el corte
    const fast = await comparar({ types: 'FAST' }, 1)
    expect(fast[0].orderNumber).toBe(`FAST-ORD-${sufijo}`)
    await comparar({ search: `ORD-${sufijo}` }, 1 + 4) // 4 empates + la FAST (su folio también lo contiene); OTRO queda fuera
    // sin corte, la posterior sí sale
    expect(await ordenes.contar(s.venueId!, ordenes.parsearFiltros(RANGO_ORD), new Date())).toBe(7)
  })
  it('el corte deja fuera lo que entró después de pedir el exporte', async () => {
    const corte = new Date(+T - 500)
    const filtros = cobros.parsearFiltros(RANGO)
    const nuevo = await recorrer(cobros, filtros, corte)
    expect(nuevo.map(f => +f.createdAt)).toEqual([+T - 1000])
    expect(await cobros.contar(s.venueId!, filtros, corte)).toBe(1)
  })
  it('🔴 montaje fallido a medias: la limpieza sólo borra lo que sí se creó, nunca con un id undefined', async () => {
    const llamadas: Array<[string, unknown]> = []
    const espia = new Proxy(
      {},
      {
        get: (_t, modelo: string) => ({
          deleteMany: async (a: { where: unknown }) => {
            llamadas.push([modelo, a.where])
          },
        }),
      },
    ) as any
    await limpiarSemillas(espia, { orgId: 'corg000000000000000000001', orderIds: [], paymentIds: [] }) // murió tras crear la organización
    expect(llamadas).toEqual([['organization', { id: 'corg000000000000000000001' }]])
  })
})
