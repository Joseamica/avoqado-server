/**
 * D1 (REAL PostgreSQL · hz:47b359b5:D1, tras D93 «B» como Square): «Ventas por artículo» cuenta lo vendido sin internet a su hora
 * real, igual que el Resumen de ventas. El POS pide los dos del mismo día y antes no cuadraban cerca de medianoche.
 *
 * La venta de las 23:50 del 11 (CDMX) que el POS subió a las 00:10 del 12 guarda `createdAt` = 00:10 (la llegada) y
 * `clientCreatedAt` = 23:50: sale el 11, a las 23; el 12 no. Las barras siguen sumando la tabla.
 *
 *   TEST_DATABASE_URL='postgresql://…/<base desechable>' npx jest --selectProjects integration --testPathPattern sales-by-item-hora-real
 */

import prisma from '@/utils/prismaClient'
import { getSalesByItem } from '@/services/dashboard/sales-by-item.dashboard.service'
import { getSalesSummary } from '@/services/dashboard/sales-summary.dashboard.service'

const TZ = 'America/Mexico_City'
const DIA_11 = { startDate: '2026-11-11T06:00:00.000Z', endDate: '2026-11-12T05:59:59.999Z', timezone: TZ }
const DIA_12 = { startDate: '2026-11-12T06:00:00.000Z', endDate: '2026-11-13T05:59:59.999Z', timezone: TZ }
const suffix = `articulos-horareal-${Date.now()}`

let orgId: string
let venueId: string
let seq = 0

async function venta(p: { producto: string; monto: number; llegada: Date; delAparato?: Date }) {
  seq += 1
  const order = await prisma.order.create({
    data: {
      venueId,
      orderNumber: `AHR-${seq}-${suffix}`,
      createdAt: p.llegada,
      clientCreatedAt: p.delAparato ?? null,
      contratoDePrecio: 'IVA_INCLUIDO',
      subtotal: p.monto,
      taxAmount: 0,
      discountAmount: 0,
      tipAmount: 0,
      total: p.monto,
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      items: { create: [{ productName: p.producto, quantity: 1, unitPrice: p.monto, taxAmount: 0, total: p.monto }] },
    },
    select: { id: true },
  })
  await prisma.payment.create({
    data: {
      venueId,
      orderId: order.id,
      amount: p.monto,
      tipAmount: 0,
      method: 'CASH',
      status: 'COMPLETED',
      type: 'REGULAR',
      feePercentage: 0,
      feeAmount: 0,
      netAmount: p.monto,
      createdAt: p.llegada,
      clientCreatedAt: p.delAparato ?? null,
    },
  })
}

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `ArticulosHoraReal Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  venueId = (
    await prisma.venue.create({
      data: { organizationId: orgId, name: `ahr-${suffix}`, slug: `ahr-${suffix}`, timezone: TZ },
      select: { id: true },
    })
  ).id
  // En línea, el 11 a las 18:00.
  await venta({ producto: 'Café', monto: 100, llegada: new Date('2026-11-12T00:00:00.000Z') })
  // Sin internet: 23:50 del 11, subida a las 00:10 del 12.
  await venta({
    producto: 'Pan',
    monto: 50,
    llegada: new Date('2026-11-12T06:10:00.000Z'),
    delAparato: new Date('2026-11-12T05:50:00.000Z'),
  })
  // En línea, el 12 a las 10:00.
  await venta({ producto: 'Jugo', monto: 30, llegada: new Date('2026-11-12T16:00:00.000Z') })
  // Sin internet: 21:00 del 10, subida 20 h después (el 11 a las 17:00): es del 10, no del 11.
  await venta({
    producto: 'Té',
    monto: 7,
    llegada: new Date('2026-11-11T23:00:00.000Z'),
    delAparato: new Date('2026-11-11T03:00:00.000Z'),
  })
})

afterAll(async () => {
  if (venueId) {
    await prisma.payment.deleteMany({ where: { venueId } })
    await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
    await prisma.order.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
  }
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
  await prisma.$disconnect()
})

const nombres = (r: Awaited<ReturnType<typeof getSalesByItem>>) => r.items.map(i => i.productName).sort()

describe('D1 · Ventas por artículo cuenta lo vendido sin internet a su hora real', () => {
  it('el 11 trae el Pan de las 23:50 que subió el 12; el 12 no; el Té del 10 subido el 11 no va el 11', async () => {
    const r11 = await getSalesByItem(venueId, { ...DIA_11, reportType: 'summary' })
    expect(nombres(r11)).toEqual(['Café', 'Pan'])
    expect(r11.totals.grossSales).toBeCloseTo(150, 2)
    const r12 = await getSalesByItem(venueId, { ...DIA_12, reportType: 'summary' })
    expect(nombres(r12)).toEqual(['Jugo'])
  })

  it('cuadra con el Resumen de ventas del mismo día (lo que el POS enseña junto)', async () => {
    const articulos = await getSalesByItem(venueId, { ...DIA_11, reportType: 'summary' })
    const resumen = await getSalesSummary(venueId, { ...DIA_11 })
    expect(articulos.totals.grossSales).toBeCloseTo(resumen.summary.grossSales ?? 0, 2)
  })

  it('las barras por hora ponen el Pan a las 23 del 11 y suman la tabla', async () => {
    const r = await getSalesByItem(venueId, { ...DIA_11, reportType: 'hourlySum' })
    const porHora = new Map((r.byPeriod ?? []).map(p => [parseInt(String(p.period), 10), p.grossSales]))
    expect(porHora.get(23) ?? 0).toBeCloseTo(50, 2)
    expect(porHora.get(18) ?? 0).toBeCloseTo(100, 2)
    expect(porHora.get(0) ?? 0).toBeCloseTo(0, 2)
    const bruto = (r.byPeriod ?? []).reduce((s, p) => s + p.grossSales, 0)
    expect(bruto).toBeCloseTo(r.totals.grossSales, 2)
  })

  it('el filtro de horas de 23:00 a 23:00 trae sólo el Pan', async () => {
    const r = await getSalesByItem(venueId, { ...DIA_11, reportType: 'summary', startHour: '23:00', endHour: '23:00' })
    expect(nombres(r)).toEqual(['Pan'])
  })
})
