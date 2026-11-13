/**
 * D43 (REAL PostgreSQL, 12-nov-2026): el correo nocturno («Origen del pedido») restaba DOS veces la cortesía de una mesa.
 *
 * La misma cuenta —Coca $25 + Agua $20 de cortesía + Café $30, 10 % de descuento de la cuenta, cobrada en $49.50— se guarda de
 * dos formas según quién la escribe (D41):
 *  - mesas de ANDROID (`compOrderItem`): el renglón del Agua queda en $0 y el subtotal ya viene sin ella (55 / 5.50);
 *  - terminal y «Cobrar» (`compItems`): el renglón queda bruto y la cortesía va en una fila COMP del descuento (75 / 25.50).
 * El correo restaba además `OrderItem.discountAmount` de los renglones «netos», que en la forma de mesas YA estaba fuera del
 * subtotal: decía $29.50. La venta neta por canal debe ser la del Resumen de ventas, al centavo, con cualquiera de las dos.
 *
 * Las cuentas se arman con sus escritores REALES (no con filas a mano): así la prueba sigue a lo que de verdad guarda cada uno.
 *
 *   TEST_DATABASE_URL='postgresql://…/<base desechable>' npx jest --selectProjects integration --testPathPattern nightly-sales-cortesias
 */

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger' // mockeado en integration-setup
import { getSalesSummary } from '@/services/dashboard/sales-summary.dashboard.service'
import { getOrderSourcesBreakdown } from '@/jobs/nightly-sales-summary.job'
import { compOrderItem, compWholeOrder } from '@/services/mobile/comp-item.mobile.service'
import { compItems } from '@/services/tpv/order.tpv.service'

const TZ = 'America/Mexico_City'
const FROM = '2025-05-08T06:00:00.000Z'
const TO = '2025-05-09T05:59:59.999Z'
const INSIDE = new Date('2025-05-08T18:00:00.000Z')
const suffix = `d43-${Date.now()}`

let orgId: string
let venueId: string
let staffId: string
let seq = 0

const d = (n: number) => new Prisma.Decimal(n)

/** Cuenta abierta: Coca 25 + Agua 20 + Café 30, con (o sin) 10 % de descuento de cuenta. Devuelve la orden y el Agua. */
async function cuentaAbierta(source: 'AVOQADO_ANDROID' | 'TPV', opts: { conDescuento: boolean; soloCoca?: boolean }) {
  seq += 1
  const renglones = opts.soloCoca
    ? [{ productName: 'Coca', precio: 25 }]
    : [
        { productName: 'Coca', precio: 25 },
        { productName: 'Agua', precio: 20 },
        { productName: 'Café', precio: 30 },
      ]
  const subtotal = renglones.reduce((s, r) => s + r.precio, 0)
  const descuento = opts.conDescuento ? Math.round(subtotal * 0.1 * 100) / 100 : 0
  const order = await prisma.order.create({
    data: {
      venueId,
      orderNumber: `D43-${seq}-${suffix}`,
      source,
      createdAt: INSIDE,
      createdById: staffId,
      contratoDePrecio: 'IVA_INCLUIDO',
      subtotal: d(subtotal),
      discountAmount: d(descuento),
      taxAmount: d(0),
      total: d(subtotal - descuento),
      remainingBalance: d(subtotal - descuento),
      items: {
        create: renglones.map((r, i) => ({
          productName: r.productName,
          quantity: 1,
          unitPrice: d(r.precio),
          taxAmount: d(0),
          total: d(r.precio),
          sequence: i,
        })),
      },
    },
    select: { id: true, items: { select: { id: true, productName: true } } },
  })
  if (opts.conDescuento) {
    await prisma.orderDiscount.create({
      data: { orderId: order.id, type: 'PERCENTAGE', name: 'FULLTEST-10% cuenta', value: d(10), amount: d(descuento) },
    })
  }
  const agua = order.items.find(i => i.productName === 'Agua')
  return { orderId: order.id, aguaId: agua?.id ?? '', cocaId: order.items[0].id }
}

/** Cobrada en efectivo por lo que debía (lo que el reporte cuenta es la cuenta cerrada y pagada). */
async function cobrar(orderId: string) {
  const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { total: true } })
  await prisma.order.update({
    where: { id: orderId },
    data: { status: 'COMPLETED', paymentStatus: 'PAID', paidAmount: o.total, remainingBalance: d(0) },
  })
}

const cabecera = (orderId: string) =>
  prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { subtotal: true, discountAmount: true, total: true } })

let mesas: string
let terminal: string
let mesaTodoCortesia: string

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `D43 Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  venueId = (
    await prisma.venue.create({
      data: { organizationId: orgId, name: `d43-${suffix}`, slug: `d43-${suffix}`, timezone: TZ },
      select: { id: true },
    })
  ).id
  staffId = (
    await prisma.staff.create({
      data: { email: `staff-${suffix}@example.test`, firstName: 'Cortesía', lastName: 'D43' },
      select: { id: true },
    })
  ).id
  await prisma.staffVenue.create({ data: { venueId, staffId, role: 'MANAGER' } })

  // Forma de MESAS (ANDROID con internet): «Dar de cortesía» del Agua.
  const m = await cuentaAbierta('AVOQADO_ANDROID', { conDescuento: true })
  await compOrderItem({ venueId, orderId: m.orderId, itemId: m.aguaId, reason: 'Especial del administrador', staffId })
  await cobrar(m.orderId)
  mesas = m.orderId

  // Forma de la TERMINAL: la cortesía del Agua por `compItems` (renglón bruto + fila COMP).
  const t = await cuentaAbierta('TPV', { conDescuento: true })
  await compItems(venueId, t.orderId, { itemIds: [t.aguaId], reason: 'Especial del administrador', staffId })
  await cobrar(t.orderId)
  terminal = t.orderId

  // Cortesía de TODA la cuenta en mesas: no se cobra nada y no es «data dañada».
  const c = await cuentaAbierta('AVOQADO_ANDROID', { conDescuento: false, soloCoca: true })
  await compWholeOrder({ venueId, orderId: c.orderId, reason: 'Amigos y familia', staffId })
  await cobrar(c.orderId)
  mesaTodoCortesia = c.orderId

  // Importada (SoftRestaurant): sólo cabecera, sin renglones. Su venta es su subtotal.
  await prisma.order.create({
    data: {
      venueId,
      orderNumber: `D43-imp-${suffix}`,
      source: 'POS',
      createdAt: INSIDE,
      subtotal: d(40),
      taxAmount: d(0),
      total: d(40),
      paidAmount: d(40),
      status: 'COMPLETED',
      paymentStatus: 'PAID',
    },
  })
})

afterAll(async () => {
  if (venueId) {
    const orderIds = (await prisma.order.findMany({ where: { venueId }, select: { id: true }, take: 50 })).map(o => o.id)
    await prisma.orderAction.deleteMany({ where: { orderId: { in: orderIds } } })
    await prisma.orderDiscount.deleteMany({ where: { orderId: { in: orderIds } } })
    await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } })
    await prisma.order.deleteMany({ where: { venueId } })
    await prisma.staffVenue.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
  }
  if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
  await prisma.$disconnect()
})

// Lo que pagaron los clientes: 49.50 (mesas) + 49.50 (terminal) + 0 (todo cortesía) + 40 (importada).
const VENTA_NETA = 139

describe('D43 · el correo nocturno no resta dos veces la cortesía', () => {
  it('las dos formas quedaron como se miden en el ensayo (si cambia un escritor, esta prueba lo dice primero)', async () => {
    const m = await cabecera(mesas)
    expect([Number(m.subtotal), Number(m.discountAmount), Number(m.total)]).toEqual([55, 5.5, 49.5])
    const t = await cabecera(terminal)
    expect(Number(t.total)).toBeCloseTo(49.5, 2)
    expect(Number(t.subtotal)).toBeCloseTo(75, 2) // el renglón del Agua sigue bruto
    expect(Number((await cabecera(mesaTodoCortesia)).total)).toBeCloseTo(0, 2)
  })

  it('«Origen del pedido» dice por canal lo que se cobró: $49.50 la mesa (no $29.50) y $49.50 la terminal', async () => {
    const fuentes = await getOrderSourcesBreakdown(venueId, new Date(FROM), new Date(TO))
    // Mesas (49.50 + la de toda la cuenta en 0) en un canal, la terminal (49.50) en otro y la importada (40) en el suyo.
    const porCanal = fuentes.map(f => Math.round(f.netSales * 100) / 100).sort((a, b) => a - b)
    expect(porCanal).toEqual([40, 49.5, 49.5])
    expect(fuentes.reduce((s, f) => s + f.orders, 0)).toBe(4)
  })

  it('la suma por canal es la venta neta del Resumen de ventas, al centavo', async () => {
    const r = await getSalesSummary(venueId, { startDate: FROM, endDate: TO, timezone: TZ })
    const fuentes = await getOrderSourcesBreakdown(venueId, new Date(FROM), new Date(TO))
    expect(r.summary.netSales).toBeCloseTo(VENTA_NETA, 2)
    expect(Math.round(fuentes.reduce((s, f) => s + f.netSales, 0) * 100)).toBe(Math.round((r.summary.netSales ?? 0) * 100))
  })

  it('una cortesía de toda la cuenta en mesas NO se avisa como «data dañada»', async () => {
    ;(logger.warn as jest.Mock).mockClear()
    await getOrderSourcesBreakdown(venueId, new Date(FROM), new Date(TO))
    const avisos = (logger.warn as jest.Mock).mock.calls.filter(([m]) => String(m).includes('net sales negativo'))
    expect(avisos).toEqual([])
  })
})
