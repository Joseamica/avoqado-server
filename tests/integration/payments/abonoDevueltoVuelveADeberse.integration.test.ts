/**
 * D19 · un abono devuelto vuelve a deberse (founder 10-nov «A»; nube 12-nov). El recorrido contra Postgres:
 *
 *   cuenta $100 · abono $50 en efectivo · el panel devuelve ese abono
 *     ⇒ la fila del reembolso guarda `reopenedAmount = 50` y la cuenta guarda pagado $0 / falta $100 (sigue PARTIAL)
 *     ⇒ «Liquidar» del panel cobra $100, no $50
 *     ⇒ el POS cobra $50 en efectivo: queda PARTIAL debiendo $50 (antes PAGADA) y el barrido de «pagada pero abierta» no la elige
 *   y la regla del 18-ago: una venta cerrada que se reembolsa sigue cerrada, sin nada reabierto.
 */
import prisma from '@/utils/prismaClient'
import { Prisma } from '@prisma/client'
import { setupTestData, teardownTestData } from '@tests/helpers/test-data-setup'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { settleOrder } from '@/services/dashboard/order.dashboard.service'
import { payCashOrder } from '@/services/mobile/order.mobile.service'
import { findPaidButOpenOrders } from '@/services/shared/pagadaPeroAbierta'
import { computeOrderBalance, PAGO_PARA_SALDO_SELECT } from '@/services/shared/orderBalance'
import { limpiarVenue, sembrarCobro } from '../dashboard/sembrarCobroParaReembolso'

jest.setTimeout(60000)

const d = (v: number | string) => new Prisma.Decimal(v)

/** Una cuenta VIVA de $100 con un abono de $50 en efectivo: PARTIAL, falta $50. */
async function cuentaConAbono(venueId: string, staffId: string) {
  const order = await prisma.order.create({
    data: {
      venueId,
      orderNumber: `D19-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: 'TAKEOUT',
      source: 'TPV',
      status: 'PENDING',
      subtotal: d(100),
      taxAmount: d(0),
      tipAmount: d(0),
      total: d(100),
      paidAmount: d(50),
      remainingBalance: d(50),
      paymentStatus: 'PARTIAL',
      createdById: staffId,
    },
  })
  const abono = await prisma.payment.create({
    data: {
      venueId,
      orderId: order.id,
      amount: d(50),
      tipAmount: d(0),
      method: 'CASH',
      status: 'COMPLETED',
      type: 'REGULAR',
      splitType: 'EQUALPARTS',
      source: 'TPV',
      processedById: staffId,
      feePercentage: 0,
      feeAmount: d(0),
      netAmount: d(50),
    },
  })
  return { order, abono }
}

async function saldoDe(venueId: string, orderId: string) {
  const o = await prisma.order.findFirstOrThrow({
    where: { id: orderId, venueId },
    select: {
      subtotal: true,
      discountAmount: true,
      serviceChargeAmount: true,
      contratoDePrecio: true,
      taxAmount: true,
      status: true,
      paidAmount: true,
      remainingBalance: true,
      paymentStatus: true,
      payments: { where: { status: 'COMPLETED' }, select: PAGO_PARA_SALDO_SELECT },
    },
  })
  return { guardado: o, calculado: computeOrderBalance(o, o.payments) }
}

describe('D19 · el abono devuelto vuelve a deberse (Postgres)', () => {
  let testData: Awaited<ReturnType<typeof setupTestData>>
  let venueId: string
  let staffId: string

  beforeAll(async () => {
    testData = await setupTestData()
    venueId = testData.venue.id
    staffId = testData.staff[0].id
  })

  afterAll(async () => {
    await limpiarVenue(venueId)
    await teardownTestData().catch(() => undefined)
  })

  it('🔴 el panel devuelve el abono de $50: la cuenta vuelve a deber $100, guardado y calculado', async () => {
    const { order, abono } = await cuentaConAbono(venueId, staffId)

    const r = await issueRefund({ venueId, paymentId: abono.id, amount: 5000, reason: 'OTHER', staffId })

    const fila = await prisma.payment.findUniqueOrThrow({ where: { id: r.refundId } })
    expect(fila.type).toBe('REFUND')
    expect(fila.amount.toString()).toBe('-50')
    expect(fila.reopenedAmount?.toString()).toBe('50')
    expect(fila.reopenedTipAmount?.toString()).toBe('0')

    const { guardado, calculado } = await saldoDe(venueId, order.id)
    expect(guardado.paidAmount.toString()).toBe('0')
    expect(guardado.remainingBalance.toString()).toBe('100')
    // El estado de cobro NO se toca (Codex plan r2 #2): sigue PARTIAL, como hoy.
    expect(guardado.paymentStatus).toBe('PARTIAL')
    expect(calculado.remainingBalance.toString()).toBe('100')
    expect(calculado.isFullyPaid).toBe(false)
  })

  it('🔴 «Liquidar» del panel cobra los $100 que se deben, no $50', async () => {
    const { order, abono } = await cuentaConAbono(venueId, staffId)
    await issueRefund({ venueId, paymentId: abono.id, amount: 5000, reason: 'OTHER', staffId })

    const liquidado = await settleOrder(venueId, order.id, undefined, staffId)

    expect(liquidado.settledAmount).toBe(100)
    const { guardado, calculado } = await saldoDe(venueId, order.id)
    expect(guardado.paymentStatus).toBe('PAID')
    // $50 del abono − $50 devueltos + $100 de la liquidación = $100 netos: la cuenta de $100 quedó cubierta de verdad.
    expect(calculado.paidAmount.toString()).toBe('100')
  })

  it('🔴 el POS cobra $50 en efectivo después: la cuenta queda PARTIAL debiendo $50 (antes se cerraba PAGADA) y el barrido no la elige', async () => {
    const { order, abono } = await cuentaConAbono(venueId, staffId)
    await issueRefund({ venueId, paymentId: abono.id, amount: 5000, reason: 'OTHER', staffId })

    await payCashOrder(venueId, order.id, { amount: 5000, tip: 0, staffId, idempotencyKey: `d19-pos-${order.id}` })

    const { guardado, calculado } = await saldoDe(venueId, order.id)
    expect([guardado.paymentStatus, guardado.remainingBalance.toString()]).toEqual(['PARTIAL', '50'])
    expect(calculado.remainingBalance.toString()).toBe('50')
    const candidatas = await findPaidButOpenOrders(prisma, { graceMs: 0, limit: 100, since: new Date(Date.now() - 60 * 60 * 1000) })
    expect(candidatas.map(c => c.id)).not.toContain(order.id)
  })

  it('REGRESIÓN 18-ago: una venta CERRADA (PAID) que se reembolsa sigue cerrada y no reabre nada', async () => {
    const { pago } = await sembrarCobro({ venueId, staffId, saleCents: 10000 })

    const r = await issueRefund({ venueId, paymentId: pago.id, amount: 4000, reason: 'OTHER', staffId })

    const fila = await prisma.payment.findUniqueOrThrow({ where: { id: r.refundId } })
    expect(fila.reopenedAmount).toBeNull()
    expect(fila.reopenedTipAmount).toBeNull()
    const { guardado, calculado } = await saldoDe(venueId, pago.orderId!)
    expect(guardado.paymentStatus).toBe('PAID')
    expect(guardado.remainingBalance.toString()).toBe('0')
    expect(calculado.isFullyPaid).toBe(true)
  })
})
