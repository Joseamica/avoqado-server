/**
 * Carril F · D16.2 del Resumen de ventas (REAL PostgreSQL, 23-nov-2026). Con un filtro de método o de comercio (la vista de
 * movimientos), «Neto cobrado» no se podía reconstruir en pantalla: faltaba el renglón de lo cobrado con ese método. Campo nuevo y
 * opcional `summary.chargedAmount`: los cobros de la vista (sin devoluciones), con propina, como «Cobraste» del estado del periodo.
 * La cuenta que la pantalla enseña cierra al centavo: chargedAmount − refunds − platformFees − tenderCommissions = totalCollected.
 * Sin filtro no se manda (la vista de ventas ya se explica con sus renglones).
 *
 *   npx jest --selectProjects integration --testPathPattern sales-summary-vista-de-movimientos   (por avq-verify: corre en la nube)
 */

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { getSalesSummary } from '@/services/dashboard/sales-summary.dashboard.service'

jest.setTimeout(60000)

const TZ = 'America/Mexico_City'
const FROM = '2025-06-10T06:00:00.000Z'
const TO = '2025-06-11T05:59:59.999Z'
const INSIDE = new Date('2025-06-10T18:00:00.000Z')
const AYER = new Date('2025-06-09T18:00:00.000Z')
const suffix = `movimientos-${Date.now()}`
const cents = (n: number | null | undefined) => (n == null ? n : Math.round(n * 100))

let orgId: string
let venueId: string
let seq = 0

type Pago = {
  amount: number
  tip?: number
  method?: 'CASH' | 'OTHER'
  type?: 'REGULAR' | 'REFUND' | null
  status?: 'COMPLETED' | 'FAILED'
  tenderCommission?: number
  at?: Date
}

async function cuenta(subtotal: number, pagos: Pago[], at = INSIDE) {
  seq += 1
  const order = await prisma.order.create({
    data: {
      venueId,
      orderNumber: `MOV-${seq}-${suffix}`,
      createdAt: at,
      contratoDePrecio: 'IVA_INCLUIDO',
      subtotal,
      taxAmount: 0,
      discountAmount: 0,
      tipAmount: 0,
      total: subtotal,
      status: 'COMPLETED',
      paymentStatus: 'PAID',
    },
    select: { id: true },
  })
  for (const p of pagos) {
    await prisma.payment.create({
      data: {
        venueId,
        orderId: order.id,
        amount: p.amount,
        tipAmount: p.tip ?? 0,
        method: p.method ?? 'CASH',
        status: p.status ?? 'COMPLETED',
        type: p.type === undefined ? 'REGULAR' : p.type,
        tenderCommissionAmount: p.tenderCommission === undefined ? undefined : new Prisma.Decimal(p.tenderCommission),
        feePercentage: 0,
        feeAmount: 0,
        netAmount: p.amount,
        createdAt: p.at ?? at,
      },
    })
  }
}

const resumen = (extra: Record<string, unknown> = {}) => getSalesSummary(venueId, { startDate: FROM, endDate: TO, timezone: TZ, ...extra })

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `Movimientos Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  venueId = (
    await prisma.venue.create({
      data: { organizationId: orgId, name: `mov-${suffix}`, slug: `mov-${suffix}`, timezone: TZ },
      select: { id: true },
    })
  ).id
  // Hoy, en efectivo: $100 + $10 de propina, $50 (cobro viejo con tipo NULL) y la devolución de $30 + $3 de propina de una venta de ayer.
  await cuenta(100, [{ amount: 100, tip: 10 }])
  await cuenta(50, [{ amount: 50, type: null }])
  await cuenta(
    30,
    [
      { amount: 30, tip: 3, at: AYER },
      { amount: -30, tip: -3, type: 'REFUND', at: INSIDE },
    ],
    AYER,
  )
  // Hoy, en efectivo: una devolución de $20 que FALLÓ (un reembolso anulado conserva su importe y queda FAILED): no salió dinero.
  await cuenta(
    20,
    [
      { amount: 20, at: AYER },
      { amount: -20, type: 'REFUND', status: 'FAILED', at: INSIDE },
    ],
    AYER,
  )
  // Hoy, «Otros»: un pedido de Uber de $90 con $27 de comisión de la plataforma.
  await cuenta(90, [{ amount: 90, method: 'OTHER', tenderCommission: 27 }])
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

describe('D16.2 · lo cobrado con el método elegido (vista de movimientos)', () => {
  it('🔴 efectivo: $160 cobrados (con propina), sin la devolución; la cuenta cierra con «Neto cobrado»', async () => {
    const r = await resumen({ paymentMethod: 'CASH' })
    expect(r.filtered).toBe(true)
    expect(cents(r.summary.chargedAmount)).toBe(16000)
    // Codex r5 #1: la devolución que falló no se cuenta como dinero devuelto en esta vista (el neto tampoco la resta).
    expect(cents(r.summary.refunds)).toBe(3300)
    expect(r.summary.refundCount).toBe(1)
    expect(cents(r.summary.totalCollected)).toBe(12700)
    const s = r.summary
    expect(cents((s.chargedAmount ?? 0) - s.refunds - s.platformFees - (s.tenderCommissions ?? 0))).toBe(cents(s.totalCollected))
  })

  it('🔴 «Otros»: $90 cobrados, menos la comisión de la plataforma, dan «Neto cobrado»', async () => {
    const r = await resumen({ paymentMethod: 'OTHER' })
    expect(cents(r.summary.chargedAmount)).toBe(9000)
    expect(cents(r.summary.totalCollected)).toBe(6300)
  })

  // Regresión: la vista de ventas no cambia y no lo manda.
  it('control · sin filtro no se manda y las cifras de siempre siguen', async () => {
    const r = await resumen()
    expect(r.filtered).toBe(false)
    expect(r.summary.chargedAmount).toBeUndefined()
    // La vista de ventas no cambia aquí: resta la devolución de ayer con su propina y (deuda anotada) también la que falló.
    expect(cents(r.summary.netSales)).toBe(24000 - 3300 - 2000)
  })
})
