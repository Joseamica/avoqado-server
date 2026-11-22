/**
 * D13.3 (REAL PostgreSQL · carril E del Resumen de ventas): el exporte DETALLADO elige los cobros por su hora REAL, como la pantalla,
 * y escribe la «Fecha» en la hora del negocio. Lo mismo el GET (PDF) y el exportador de segundo plano (CSV/Excel), que comparten el
 * `where` y las columnas.
 *
 * La venta en efectivo de las 23:50 del 11 (CDMX) que el POS subió a las 00:10 del 12 guarda `createdAt` = 00:10 y
 * `clientCreatedAt` = 23:50: el archivo del 11 la trae con «2026-11-11 23:50:00»; el del 12, no.
 *
 *   ./scripts/avq-verify.sh avoqado-server npx jest --selectProjects=integration --runTestsByPath tests/integration/dashboard/sales-summary-exporte-hora-real.integration.test.ts --ci
 */

import prisma from '@/utils/prismaClient'
import {
  countSalesSummaryDetailRows,
  fetchSalesSummaryDetailRows,
  getSalesSummary,
} from '@/services/dashboard/sales-summary.dashboard.service'
import { ventasDetalladas, VENTAS_DETALLADAS_COLUMNAS } from '@/services/exports/exportadores/ventasDetalladas.exportador'

const TZ = 'America/Mexico_City'
const DIA_11 = { startDate: '2026-11-11T06:00:00.000Z', endDate: '2026-11-12T05:59:59.999Z' }
const DIA_12 = { startDate: '2026-11-12T06:00:00.000Z', endDate: '2026-11-13T05:59:59.999Z' }
const suffix = `exp-horareal-${Date.now()}`
const fecha = VENTAS_DETALLADAS_COLUMNAS.find(c => c.id === 'createdAt')!.value

let orgId: string | undefined
let venueId: string | undefined
let seq = 0

async function venta(p: { monto: number; llegada: Date; delAparato?: Date }) {
  seq += 1
  const order = await prisma.order.create({
    data: {
      venueId: venueId!,
      orderNumber: `EHR-${seq}-${suffix}`,
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
    },
    select: { id: true },
  })
  await prisma.payment.create({
    data: {
      venueId: venueId!,
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
      data: { name: `ExpHoraReal Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  venueId = (
    await prisma.venue.create({
      data: { organizationId: orgId, name: `ehr-${suffix}`, slug: `ehr-${suffix}`, timezone: TZ },
      select: { id: true },
    })
  ).id
  // En línea, el 11 a las 18:00 (00:00 UTC del 12).
  await venta({ monto: 100, llegada: new Date('2026-11-12T00:00:00.000Z') })
  // Sin internet: 23:50 del 11, subida a las 00:10 del 12.
  await venta({ monto: 50, llegada: new Date('2026-11-12T06:10:00.000Z'), delAparato: new Date('2026-11-12T05:50:00.000Z') })
  // En línea, el 12 a las 10:00.
  await venta({ monto: 30, llegada: new Date('2026-11-12T16:00:00.000Z') })
})

afterAll(async () => {
  if (venueId) {
    await prisma.payment.deleteMany({ where: { venueId } })
    await prisma.order.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
  }
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
  await prisma.$disconnect()
})

describe('D13.3 · el exporte detallado sigue la hora real de la pantalla', () => {
  it('el 11 trae la venta sin red de las 23:50 (con su hora del negocio); el 12 no', async () => {
    expect(await countSalesSummaryDetailRows(venueId!, DIA_11)).toBe(2)
    const filas = await fetchSalesSummaryDetailRows(venueId!, DIA_11, 1000)
    expect(filas.map(f => fecha(f)).sort()).toEqual(['2026-11-11 18:00:00', '2026-11-11 23:50:00'])

    expect(await countSalesSummaryDetailRows(venueId!, DIA_12)).toBe(1)
    const del12 = await fetchSalesSummaryDetailRows(venueId!, DIA_12, 1000)
    expect(del12.map(f => fecha(f))).toEqual(['2026-11-12 10:00:00'])
  })

  it('cuadra con la pantalla: las mismas transacciones y el mismo efectivo que el Resumen de ese día', async () => {
    const pantalla = await getSalesSummary(venueId!, { ...DIA_11, timezone: TZ })
    const filas = await fetchSalesSummaryDetailRows(venueId!, DIA_11, 1000)
    expect(filas).toHaveLength(pantalla.summary.transactionCount)
    expect(filas.reduce((s, f) => s + Number(f.amount), 0)).toBeCloseTo(pantalla.summary.totalCollected, 2)
  })

  it('el exportador de segundo plano (CSV/Excel) cuenta y trae lo mismo, con la misma fecha', async () => {
    const filtros = ventasDetalladas.parsearFiltros(DIA_11)
    const corte = new Date()
    expect(await ventasDetalladas.contar(venueId!, filtros, corte)).toBe(2)
    const pagina = await ventasDetalladas.pagina(venueId!, filtros, corte, null, 500)
    expect(pagina.map(f => fecha(f)).sort()).toEqual(['2026-11-11 18:00:00', '2026-11-11 23:50:00'])
  })
})
