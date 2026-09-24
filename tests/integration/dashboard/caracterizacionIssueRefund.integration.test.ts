/**
 * 🔴 CARACTERIZACIÓN — lo que `issueRefund` (reembolso del dashboard) escribe HOY, fila por fila.
 *
 * Se escribió contra el código de ANTES de extraer el núcleo `writeRefundInTx` y pasó en verde
 * sobre él. Es la red del refactor: si una sola cifra del camino del dashboard cambia al pasar
 * por el núcleo compartido, cae aquí. No es un deseo: si algún valor parece raro, es lo que el
 * código hacía, y se cambia con su propia decisión, nunca "de paso".
 *
 * Única diferencia admitida: `processorData.provenance` (llave nueva, aditiva, del spec del KDS
 * de Uber §3.1). Por eso las comparaciones de `processorData` la omiten.
 */
import prisma from '@/utils/prismaClient'
import { setupTestData, teardownTestData } from '@tests/helpers/test-data-setup'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { getTenderCommissionsReport } from '@/services/dashboard/tenderType.dashboard.service'
import { abrirTurno, limpiarVenue, sembrarCobro } from './sembrarCobroParaReembolso'

jest.setTimeout(60000)

const sinProcedencia = (pd: unknown) => {
  const { provenance: _ignorada, ...resto } = (pd ?? {}) as Record<string, unknown>
  return resto
}

describe('CARACTERIZACION issueRefund (dashboard) — la fila exacta de hoy', () => {
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

  // Sin turno vivo: el reembolso queda FUERA de turno y deja la conciliación pendiente.
  // Va primero porque el turno vivo de la prueba siguiente es único por venue.
  it('CARACTERIZACION: un reembolso por ARTÍCULO sin turno vivo', async () => {
    const producto = testData.products[0]
    const { pago, items } = await sembrarCobro({
      venueId,
      staffId,
      saleCents: 12000,
      items: [{ productId: producto.id, productName: producto.name, quantity: 2, totalCents: 12000 }],
    })

    const r = await issueRefund({
      venueId,
      paymentId: pago.id,
      items: [{ orderItemId: items[0].id, quantity: 1 }],
      reason: 'RETURNED_GOODS',
      staffId,
    })
    expect(r).toEqual({
      refundId: expect.any(String),
      originalPaymentId: pago.id,
      amount: 60,
      remainingRefundable: 60,
      status: 'COMPLETED',
    })

    const fila = await prisma.payment.findUniqueOrThrow({ where: { id: r.refundId } })
    expect(fila.type).toBe('REFUND')
    expect(fila.status).toBe('COMPLETED')
    expect(fila.amount.toString()).toBe('-60')
    expect(fila.tipAmount.toString()).toBe('0')
    expect(fila.netAmount.toString()).toBe('-60')
    expect(fila.method).toBe('CASH')
    expect(fila.shiftId).toBeNull()
    expect(fila.idempotencyKey).toBeNull()
    expect(fila.processor).toBe('dashboard')
    expect(sinProcedencia(fila.processorData)).toEqual({
      originalPaymentId: pago.id,
      refundReason: 'RETURNED_GOODS',
      note: null,
      amountCents: 6000,
      amount: 60,
      refundedItems: [
        { orderItemId: items[0].id, quantity: 1, amountCents: 6000, amount: 60, productName: producto.name, productId: producto.id },
      ],
      shiftBackfilled: false,
    })

    const conciliacion = await prisma.activityLog.findFirst({ where: { venueId, entityId: r.refundId, action: 'PAYMENT_WITHOUT_SHIFT' } })
    expect(conciliacion?.data).toMatchObject({
      status: 'PENDING',
      reason: 'NO_SHIFT',
      paymentId: r.refundId,
      orderId: pago.orderId,
      channel: 'issueRefund',
      amountPesos: '-60.00',
      totalPesos: '-60.00',
    })
  })

  it('CARACTERIZACION: un reembolso por IMPORTE deja la fila exacta de hoy', async () => {
    const turnoVivo = await abrirTurno(venueId, staffId)
    const { pago, tender } = await sembrarCobro({ venueId, staffId, saleCents: 20000, tipCents: 1000, commissionPercent: 30 })

    const r = await issueRefund({ venueId, paymentId: pago.id, amount: 5000, reason: 'OTHER', staffId })
    expect(r).toEqual({
      refundId: expect.any(String),
      originalPaymentId: pago.id,
      amount: 50,
      remainingRefundable: 160,
      status: 'COMPLETED',
    })

    const fila = await prisma.payment.findUniqueOrThrow({ where: { id: r.refundId } })
    expect(fila.type).toBe('REFUND')
    expect(fila.status).toBe('COMPLETED')
    expect(fila.amount.toString()).toBe('-47.62') // proporcional venta/propina, como hoy
    expect(fila.tipAmount.toString()).toBe('-2.38')
    expect(fila.netAmount.toString()).toBe('-50')
    expect(fila.feeAmount.toString()).toBe('0')
    expect(fila.tenderCommissionAmount).toBeNull() // hoy NO revierte comisión
    expect(fila.tenderCommissionPercent).toBeNull()
    expect(fila.shiftId).toBe(turnoVivo.id) // hoy reclama el turno de HOY
    expect(fila.processedById).toBe(staffId)
    expect(fila.orderId).toBe(pago.orderId)
    expect(fila.method).toBe('OTHER')
    expect(fila.tenderTypeId).toBe(tender!.id)
    expect(fila.tenderRevision).toBe(1)
    expect(fila.tenderLabel).toBe('Uber Eats')
    expect(fila.tenderCountsAsCash).toBe(false)
    expect(fila.tenderCaptureTip).toBe(true)
    expect(fila.tenderSatFormaPago).toBe('99')
    expect(fila.fundsFlow).toBe('EXTERNAL_RECORDED')
    expect(fila.source).toBe('TPV')
    expect(fila.processor).toBe('dashboard')
    expect(fila.idempotencyKey).toBeNull()
    expect(sinProcedencia(fila.processorData)).toEqual({
      originalPaymentId: pago.id,
      refundReason: 'OTHER',
      note: null,
      amountCents: 5000,
      amount: 50,
      shiftBackfilled: true,
    })

    // El turno vivo se DESCUENTA en el mismo CAS que lo reclama.
    const turno = await prisma.shift.findUniqueOrThrow({ where: { id: turnoVivo.id } })
    expect(turno.totalSales.toString()).toBe('-47.62')
    expect(turno.totalTips.toString()).toBe('-2.38')

    // El acumulado vive en el pago ORIGINAL: venta + propina, en pesos y centavos.
    const original = await prisma.payment.findUniqueOrThrow({ where: { id: pago.id } })
    expect(original.processorData).toEqual({
      refundedAmount: 50,
      refundedAmountCents: 5000,
      refunds: [{ refundPaymentId: r.refundId, amount: 50, amountCents: 5000, reason: 'OTHER', at: expect.any(String) }],
    })

    const vtx = await prisma.venueTransaction.findFirstOrThrow({ where: { paymentId: r.refundId } })
    expect({
      type: vtx.type,
      gross: vtx.grossAmount.toString(),
      fee: vtx.feeAmount.toString(),
      net: vtx.netAmount.toString(),
      status: vtx.status,
    }).toEqual({
      type: 'REFUND',
      gross: '-50',
      fee: '0',
      net: '-50',
      status: 'SETTLED',
    })

    expect(await prisma.activityLog.count({ where: { venueId, entityId: r.refundId, action: 'PAYMENT_WITHOUT_SHIFT' } })).toBe(0)
  })

  it('CARACTERIZACION: el reporte de tender NO incluye ese reembolso', async () => {
    const ayer = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    const manana = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
    const reporte = await getTenderCommissionsReport(venueId, { from: ayer, to: manana })
    // Un solo tipo con comisión en este venue: el del cobro de $200 de la prueba anterior.
    expect(reporte.rows).toHaveLength(1)
    expect(reporte.rows[0]).toMatchObject({ count: 1, gross: 200, commission: 60, net: 140 }) // los $200 del cobro, sin restar el reembolso
  })
})
