/**
 * D46 (REAL PostgreSQL, 14-nov-2026): «Origen del pedido» del correo nocturno no restaba los reembolsos.
 *
 * La cifra principal del correo (Resumen de ventas) es bruto − descuentos − REEMBOLSOS. La tabla por canal sólo sumaba lo de las
 * cuentas: si se devolvían $10 de una venta de $100, arriba decía $90 y en su canal $100. Ahora cada canal resta los reembolsos del
 * periodo de SUS cuentas, con la misma población que el Resumen (por la fecha del reembolso, venta + propina devuelta, sin cuentas
 * canceladas ni de tarjetas de regalo), y la suma por canal es la venta neta del Resumen, al centavo.
 *
 * Los reembolsos se hacen con el escritor REAL del panel (`issueRefund`), no con filas a mano.
 *
 *   TEST_DATABASE_URL='postgresql://…/<base desechable>' npx jest --selectProjects integration --testPathPattern nightly-sales-reembolsos
 */

import prisma from '@/utils/prismaClient'
import { getSalesSummary } from '@/services/dashboard/sales-summary.dashboard.service'
import { getOrderSourcesBreakdown } from '@/jobs/nightly-sales-summary.job'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { limpiarVenue, sembrarCobro } from '../dashboard/sembrarCobroParaReembolso'

jest.setTimeout(60000)

const TZ = 'America/Mexico_City'
const suffix = `d46-${Date.now()}`
const AYER = new Date(Date.now() - 26 * 60 * 60 * 1000)

let orgId: string
let venueId: string
let staffId: string
let desde: Date
let hasta: Date

const canal = (fuentes: Array<{ source: string; orders: number; netSales: number }>, nombre: string) =>
  fuentes.find(f => f.source === nombre)

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `D46 Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  venueId = (
    await prisma.venue.create({
      data: { organizationId: orgId, name: `d46-${suffix}`, slug: `d46-${suffix}`, timezone: TZ },
      select: { id: true },
    })
  ).id
  staffId = (
    await prisma.staff.create({
      data: { email: `staff-${suffix}@example.test`, firstName: 'Reembolso', lastName: 'D46' },
      select: { id: true },
    })
  ).id
  await prisma.staffVenue.create({ data: { venueId, staffId, role: 'MANAGER' } })

  desde = new Date(Date.now() - 2 * 60 * 60 * 1000)

  // Punto de venta: venta de $100, se devuelven $10 el mismo día → $90.
  const tpv = await sembrarCobro({ venueId, staffId, saleCents: 10000 })
  await issueRefund({ venueId, paymentId: tpv.pago.id, amount: 1000, reason: 'OTHER', staffId })

  // QR: venta de $50 devuelta COMPLETA → $0 (la cuenta sigue PAID: el panel no la marca REFUNDED).
  const qr = await sembrarCobro({ venueId, staffId, saleCents: 5000 })
  await prisma.order.update({ where: { id: qr.order.id }, data: { source: 'QR' } })
  await issueRefund({ venueId, paymentId: qr.pago.id, amount: 5000, reason: 'OTHER', staffId })

  // ANDROID: venta de $200 + $10 de propina; se devuelven $50 (47.62 de venta + 2.38 de propina) → $150, como el Resumen.
  const android = await sembrarCobro({ venueId, staffId, saleCents: 20000, tipCents: 1000 })
  await prisma.order.update({ where: { id: android.order.id }, data: { source: 'AVOQADO_ANDROID' } })
  await issueRefund({ venueId, paymentId: android.pago.id, amount: 5000, reason: 'OTHER', staffId })

  // WEB: venta de AYER ($80), $30 devueltos HOY → el canal sale con 0 pedidos y −$30 (el Resumen también los resta hoy).
  const web = await sembrarCobro({ venueId, staffId, saleCents: 8000 })
  await prisma.order.update({ where: { id: web.order.id }, data: { source: 'WEB', createdAt: AYER } })
  await prisma.payment.update({ where: { id: web.pago.id }, data: { createdAt: AYER } })
  await issueRefund({ venueId, paymentId: web.pago.id, amount: 3000, reason: 'OTHER', staffId })

  // KIOSK: venta de $40 con $15 devueltos y luego CANCELADA → no cuenta ni su venta ni su reembolso (igual que el Resumen).
  const kiosco = await sembrarCobro({ venueId, staffId, saleCents: 4000 })
  await issueRefund({ venueId, paymentId: kiosco.pago.id, amount: 1500, reason: 'OTHER', staffId })
  await prisma.order.update({ where: { id: kiosco.order.id }, data: { source: 'KIOSK', status: 'CANCELLED' } })

  hasta = new Date(Date.now() + 2 * 60 * 60 * 1000)
})

afterAll(async () => {
  if (venueId) {
    await prisma.venueTransaction.deleteMany({ where: { venueId } }).catch(() => undefined)
    await limpiarVenue(venueId)
    await prisma.staffVenue.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
  }
  if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
  await prisma.$disconnect()
})

describe('D46 · «Origen del pedido» resta los reembolsos de cada canal', () => {
  it('cada canal dice lo que le quedó después de devolver', async () => {
    const fuentes = await getOrderSourcesBreakdown(venueId, desde, hasta)

    expect(canal(fuentes, 'Punto de venta')).toMatchObject({ orders: 1, netSales: 90, avgOrder: 90 })
    expect(canal(fuentes, 'Avoqado QR')).toMatchObject({ orders: 1, netSales: 0 })
    expect(canal(fuentes, 'AVOQADO_ANDROID')).toMatchObject({ orders: 1, netSales: 150 })
    // Lo devuelto hoy de una venta de ayer: el canal aparece aunque hoy no vendió.
    expect(canal(fuentes, 'WEB')).toMatchObject({ orders: 0, netSales: -30, avgOrder: 0 })
    // La cuenta cancelada no aparece por ningún lado.
    expect(canal(fuentes, 'Kiosco')).toBeUndefined()
    expect(fuentes.reduce((s, f) => s + f.orders, 0)).toBe(3)
  })

  it('la suma por canal es la venta neta del Resumen de ventas, al centavo', async () => {
    const r = await getSalesSummary(venueId, { startDate: desde.toISOString(), endDate: hasta.toISOString(), timezone: TZ })
    const fuentes = await getOrderSourcesBreakdown(venueId, desde, hasta)
    // 350 vendidos (100 + 50 + 200) − 140 devueltos (10 + 50 + 50 + 30).
    expect(r.summary.netSales).toBeCloseTo(210, 2)
    expect(Math.round(fuentes.reduce((s, f) => s + f.netSales, 0) * 100)).toBe(Math.round((r.summary.netSales ?? 0) * 100))
  })

  it('los canales van de la venta neta más alta a la más baja', async () => {
    const fuentes = await getOrderSourcesBreakdown(venueId, desde, hasta)
    const netas = fuentes.map(f => f.netSales)
    expect(netas).toEqual([...netas].sort((a, b) => b - a))
  })
})
