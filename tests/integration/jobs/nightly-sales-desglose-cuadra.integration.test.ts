/**
 * D21 (REAL PostgreSQL, 16-nov-2026): el «Desglose de ventas» por categoría del correo nocturno suma las ventas netas.
 *
 * Medido en av-db-25: la consulta de categorías parte de los RENGLONES, así que un cobro rápido de la TPV (FAST-…, importe
 * libre, sin renglones) no salía en ninguna categoría (160 cuentas, $28,757.69). Además contaba cuentas que la cifra de
 * ventas netas no cuenta (PENDING, DELETED: 27 cuentas, $5,455.50 de más) y no restaba los reembolsos. Aquí se arma un día
 * con todo eso y el desglose que recibe el correo tiene que sumar, al centavo, las ventas netas del Resumen de ventas.
 *
 *   TEST_DATABASE_URL='postgresql://…/<base desechable>' npx jest --selectProjects integration --testPathPattern nightly-sales-desglose-cuadra
 */

import prisma from '@/utils/prismaClient'
import { getSalesSummary } from '@/services/dashboard/sales-summary.dashboard.service'
import { getCategoryBreakdown, reconcileCategoryBreakdown } from '@/jobs/nightly-sales-summary.job'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { limpiarVenue, sembrarCobro } from '../dashboard/sembrarCobroParaReembolso'

jest.setTimeout(60000)

const TZ = 'America/Mexico_City'
const suffix = `d21-${Date.now()}`
const cents = (n: number) => Math.round(n * 100)

let orgId: string
let venueId: string
let staffId: string
let desde: Date
let hasta: Date

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `D21 Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  venueId = (
    await prisma.venue.create({
      data: { organizationId: orgId, name: `d21-${suffix}`, slug: `d21-${suffix}`, timezone: TZ },
      select: { id: true },
    })
  ).id
  staffId = (
    await prisma.staff.create({
      data: { email: `staff-${suffix}@example.test`, firstName: 'Desglose', lastName: 'D21' },
      select: { id: true },
    })
  ).id
  await prisma.staffVenue.create({ data: { venueId, staffId, role: 'MANAGER' } })
  const bebidas = await prisma.menuCategory.create({ data: { venueId, name: 'Bebidas', slug: `bebidas-${suffix}` } as any })
  const cafe = await prisma.product.create({
    data: { venueId, categoryId: bebidas.id, sku: `CAFE-${suffix}`, name: 'Café', price: 100 } as any,
  })

  desde = new Date(Date.now() - 2 * 60 * 60 * 1000)

  // Café de $100 (Bebidas), con $10 devueltos el mismo día.
  const conCafe = await sembrarCobro({
    venueId,
    staffId,
    saleCents: 10000,
    items: [{ productId: cafe.id, productName: 'Café', quantity: 1, totalCents: 10000 }],
  })
  await issueRefund({ venueId, paymentId: conCafe.pago.id, amount: 1000, reason: 'OTHER', staffId })

  // Venta de $50 de un renglón sin producto del catálogo (ya salía en «Sin categorizar»).
  const libre = await sembrarCobro({ venueId, staffId, saleCents: 5000 })
  await prisma.orderItem.create({
    data: { orderId: libre.order.id, productName: 'Varios', quantity: 1, unitPrice: 50, taxAmount: 0, total: 50 },
  })

  // Cobro rápido de la TPV: $26.99 SIN renglones (el caso medido el 27-oct).
  await sembrarCobro({ venueId, staffId, saleCents: 2699 })

  // Cuentas con café que las ventas netas NO cuentan: una PENDING y una DELETED.
  for (const status of ['PENDING', 'DELETED'] as const) {
    const fuera = await sembrarCobro({
      venueId,
      staffId,
      saleCents: 3000,
      items: [{ productId: cafe.id, productName: 'Café', quantity: 1, totalCents: 3000 }],
    })
    await prisma.order.update({ where: { id: fuera.order.id }, data: { status } })
  }

  // Codex r1 #1: promoción de Rappi asumida por el negocio — la ingesta la guarda SÓLO en Order.discountAmount (sin
  // reparto por renglón): $174 de producto, $28 de promoción, neto $146. Antes las categorías decían $174.
  const rappi = await sembrarCobro({
    venueId,
    staffId,
    saleCents: 14600,
    items: [{ productId: cafe.id, productName: 'Café', quantity: 1, totalCents: 17400 }],
  })
  await prisma.order.update({ where: { id: rappi.order.id }, data: { subtotal: 174, discountAmount: 28, total: 146 } })

  // Codex r1 #2: dos pesadas de 0.333 kg a $199.99/kg — el cobro redondea CADA renglón (66.60 × 2 = 133.20) y el renglón
  // sin redondear vale 66.59667: antes salía un «importe libre» de $0.01 que no existe.
  const pesada = await sembrarCobro({ venueId, staffId, saleCents: 13320 })
  for (let i = 0; i < 2; i++) {
    await prisma.orderItem.create({
      data: {
        orderId: pesada.order.id,
        productId: cafe.id,
        productName: 'Café',
        quantity: 1,
        unitPrice: 199.99,
        weightQuantity: 0.333,
        taxAmount: 0,
        total: 66.6,
      } as any,
    })
  }

  // Codex r2 #1: pieza de combo de lista $200 vendida en $99 y luego regalada desde Mesas (isCortesia, total 0,
  // discountAmount 99: la fórmula por renglón la lee como $101) junto a un café de $100. La cuenta cobró $100: todo es café.
  const postres = await prisma.menuCategory.create({ data: { venueId, name: 'Postres', slug: `postres-${suffix}` } as any })
  const pastel = await prisma.product.create({
    data: { venueId, categoryId: postres.id, sku: `PASTEL-${suffix}`, name: 'Pastel', price: 200 } as any,
  })
  const regalo = await sembrarCobro({
    venueId,
    staffId,
    saleCents: 10000,
    items: [{ productId: cafe.id, productName: 'Café', quantity: 1, totalCents: 10000 }],
  })
  await prisma.orderItem.create({
    data: {
      orderId: regalo.order.id,
      productId: pastel.id,
      productName: 'Pastel',
      quantity: 1,
      unitPrice: 200,
      discountAmount: 99,
      total: 0,
      taxAmount: 0,
      isCortesia: true,
      cortesiaReason: 'cumpleaños',
    } as any,
  })

  // Codex r2 #2: dos pesadas de 0.5 kg a $100.01/kg ($50.01 cada una, subtotal $100.02) con un descuento de cuenta de $100.01
  // repartido 50.01 / 50.00: los renglones valen −0.005 y +0.005 (suman 0) y la cuenta cobró $0.01, que es café.
  const casiGratis = await sembrarCobro({ venueId, staffId, saleCents: 1 })
  for (const descuento of [50.01, 50]) {
    await prisma.orderItem.create({
      data: {
        orderId: casiGratis.order.id,
        productId: cafe.id,
        productName: 'Café',
        quantity: 1,
        unitPrice: 100.01,
        weightQuantity: 0.5,
        discountAmount: descuento,
        taxAmount: 0,
        total: 50.01 - descuento,
      } as any,
    })
  }
  await prisma.order.update({ where: { id: casiGratis.order.id }, data: { subtotal: 100.02, discountAmount: 100.01, total: 0.01 } })

  hasta = new Date(Date.now() + 2 * 60 * 60 * 1000)
})

afterAll(async () => {
  if (venueId) {
    await prisma.venueTransaction.deleteMany({ where: { venueId } }).catch(() => undefined)
    await limpiarVenue(venueId)
    await prisma.product.deleteMany({ where: { venueId } })
    await prisma.menuCategory.deleteMany({ where: { venueId } })
    await prisma.staffVenue.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
  }
  if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
  await prisma.$disconnect()
})

describe('D21 · el desglose por categoría del correo nocturno suma las ventas netas', () => {
  it('las categorías cuentan las mismas cuentas que las ventas netas (sin PENDING ni DELETED)', async () => {
    const categorias = await getCategoryBreakdown(venueId, desde, hasta)
    // Café: 100 + 146 (la promoción de la cuenta repartida a su renglón) + 133.20 (lo que se cobró por las pesadas) + 100 (la
    // cuenta con el pastel regalado) + 0.01 (las pesadas casi gratis). El pastel regalado no cobró nada.
    expect(categorias).toEqual([
      { name: 'Bebidas', itemsSold: 7, netSales: 479.21 },
      { name: 'Sin categorizar', itemsSold: 1, netSales: 50 },
      { name: 'Postres', itemsSold: 1, netSales: 0 },
    ])
  })

  it('🔴 el desglose del correo suma las ventas netas del Resumen, al centavo, con su renglón de importe libre', async () => {
    const r = await getSalesSummary(venueId, { startDate: desde.toISOString(), endDate: hasta.toISOString(), timezone: TZ })
    // 100 + 50 + 26.99 + 146 + 133.20 + 100 + 0.01 vendidos − 10 devueltos.
    expect(r.summary.netSales).toBeCloseTo(546.2, 2)

    const filas = reconcileCategoryBreakdown(await getCategoryBreakdown(venueId, desde, hasta), r.summary.netSales ?? 0, r.summary.refunds)
    expect(filas).toEqual([
      { name: 'Bebidas', itemsSold: 7, netSales: 479.21 },
      { name: 'Sin categorizar', itemsSold: 1, netSales: 50 },
      { name: 'Postres', itemsSold: 1, netSales: 0 },
      { name: 'Devoluciones', itemsSold: null, netSales: -10 },
      { name: 'Ventas sin producto (importe libre)', itemsSold: null, netSales: 26.99 },
    ])
    expect(filas.reduce((s, f) => s + cents(f.netSales), 0)).toBe(cents(r.summary.netSales ?? 0))
  })
})
