/**
 * 🔴 UN REEMBOLSO NO REABRE EL SALDO — camino VALES POR ÁREA (v7).
 *
 * `finalizeAreaTicketPaymentInTransaction`, con `reconcileCapturedPayment`,
 * RECALCULA el saldo de la orden materializada a partir de sus `Payment`
 * COMPLETED. Leía todos sin mirar `type`, así que el `Payment` NEGATIVO
 * `type: REFUND` de un reembolso restaba de lo pagado y la venta ya devuelta
 * volvía a pedir dinero — mismo defecto que los otros tres canales de cobro.
 *
 * Decisión del founder (2026-08-18): la cuenta queda CERRADA y MARCADA, nunca
 * "debiendo $X". Modelo Toast/Square, y en México además lo cierra el SAT (la
 * devolución se ampara con un CFDI de Egreso; el de ingreso no se toca).
 *
 * Se prueba con un `tx` falso que recorre la finalización completa con el intento
 * PENDIENTE: la venta sin renglones ni reservas no consume nada, así que lo que se
 * mide es la escritura de la conciliación. (Hasta la ronda 10 el intento llegaba
 * SUCCEEDED para cortar justo después de esa escritura; R11-5 hizo esa salida de
 * sólo lectura, antes de escribir nada.)
 */

import { Prisma } from '@prisma/client'
import { finalizeAreaTicketPaymentInTransaction } from '@/services/mobile/areaTicketV7.mobile.service'

const d = (v: string | number) => new Prisma.Decimal(v)

const VENUE_ID = 'cvenue0000000000000000001'
const ORDER_ID = 'corder0000000000000000001'
const PAYMENT_ID = 'cpay000000000000000000001'
const SESSION_ID = 'csess000000000000000000001'
const ATTEMPT_ID = 'cattempt00000000000000001'

type FakePayment = { amount: Prisma.Decimal; tipAmount: Prisma.Decimal; type: string }

function makeTx(order: Record<string, any>, payments: FakePayment[]) {
  const paymentSelects: any[] = []
  const orderUpdates: any[] = []
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    areaTicket: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    order: {
      findFirst: jest.fn().mockResolvedValue(order),
      update: jest.fn().mockImplementation(async (args: any) => {
        orderUpdates.push(args.data)
        return {}
      }),
    },
    payment: {
      findMany: jest.fn().mockImplementation(async (args: any) => {
        paymentSelects.push(args?.select)
        return payments.map(p => ({
          amount: p.amount,
          tipAmount: p.tipAmount,
          ...(args?.select?.type ? { type: p.type } : {}),
        }))
      }),
    },
    // El intento sigue pendiente: la finalización llega hasta el final (sin renglones ni reservas, no consume nada).
    areaTicketPaymentAttempt: {
      findFirst: jest.fn().mockResolvedValue({ id: ATTEMPT_ID, status: 'PENDING', paymentId: null }),
      update: jest.fn().mockResolvedValue({}),
      // R12-4: al cerrar PAID, los intentos UNKNOWN hermanos con su cobro COMPLETED quedan SUCCEEDED (aquí: ninguno).
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    areaTicketCheckoutSession: {
      update: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue({ status: 'PAYMENT_PENDING', activePaymentAttemptId: ATTEMPT_ID }),
    },
    areaTicketInventoryReservation: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    orderItem: { findMany: jest.fn().mockResolvedValue([]) },
    // R10-1/R10-3: con la venta ya cerrada, la finalización mira si alguien tiene su vale de inventario (aquí: nadie); al consumir
    // deja su constancia (SKIPPED).
    inventoryPosting: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'posting-v7' }) },
  }
  return { tx, paymentSelects, orderUpdates }
}

const baseOrder = (over: Record<string, any> = {}) => ({
  paymentStatus: 'PARTIAL',
  status: 'COMPLETED',
  subtotal: d('200.00'),
  discountAmount: d('0.00'),
  serviceChargeAmount: d('0.00'),
  servedById: 'staff-1',
  createdById: 'staff-1',
  areaTicketCode: 'A-1',
  ...over,
})

const run = (tx: any) =>
  finalizeAreaTicketPaymentInTransaction(tx, {
    venueId: VENUE_ID,
    orderId: ORDER_ID,
    paymentId: PAYMENT_ID,
    fullyPaid: false,
    reconcileCapturedPayment: true,
    locked: { sessionId: SESSION_ID, attemptId: ATTEMPT_ID } as any,
  })

describe('vales por área v7 — un reembolso previo no reabre saldo', () => {
  it('🔴 la consulta de pagos PIDE `type` (sin él el refund resta)', async () => {
    const { tx, paymentSelects } = makeTx(baseOrder(), [{ amount: d('200.00'), tipAmount: d('0.00'), type: 'REGULAR' }])

    await run(tx)

    expect(paymentSelects[0]).toMatchObject({ amount: true, tipAmount: true, type: true })
  })

  it('🔴 una cuenta cobrada y devuelta NO vuelve a quedar PARTIAL debiendo $200', async () => {
    // +200 REGULAR, −200 REFUND. Antes: 200 − 200 = 0 pagados sobre un total de
    // 200 ⇒ `paymentStatus: PENDING`, `remainingBalance: 200`. La venta devuelta
    // reaparecía por cobrar en un vale ya entregado.
    const { tx, orderUpdates } = makeTx(baseOrder(), [
      { amount: d('200.00'), tipAmount: d('0.00'), type: 'REGULAR' },
      { amount: d('-200.00'), tipAmount: d('0.00'), type: 'REFUND' },
    ])

    const result = await run(tx)

    expect(orderUpdates).toHaveLength(1)
    expect(orderUpdates[0].paymentStatus).toBe('PAID')
    expect(Number(orderUpdates[0].paidAmount)).toBe(200)
    expect(Number(orderUpdates[0].remainingBalance)).toBe(0)
    expect(result.fullyPaid).toBe(true)
  })

  it('la propina devuelta tampoco borra la propina cobrada del total', async () => {
    const { tx, orderUpdates } = makeTx(baseOrder(), [
      { amount: d('200.00'), tipAmount: d('10.00'), type: 'REGULAR' },
      { amount: d('-200.00'), tipAmount: d('-10.00'), type: 'REFUND' },
    ])

    await run(tx)

    expect(Number(orderUpdates[0].tipAmount)).toBe(10)
    expect(Number(orderUpdates[0].total)).toBe(210)
    expect(orderUpdates[0].paymentStatus).toBe('PAID')
  })

  // ── REGRESIÓN: sin reembolsos, importes idénticos ─────────────────────────────

  it('REGRESIÓN: un cobro completo sigue quedando PAID con saldo 0', async () => {
    const { tx, orderUpdates } = makeTx(baseOrder(), [{ amount: d('200.00'), tipAmount: d('0.00'), type: 'REGULAR' }])

    const result = await run(tx)

    expect(orderUpdates[0].paymentStatus).toBe('PAID')
    expect(Number(orderUpdates[0].paidAmount)).toBe(200)
    expect(Number(orderUpdates[0].remainingBalance)).toBe(0)
    expect(Number(orderUpdates[0].total)).toBe(200)
    expect(result.fullyPaid).toBe(true)
  })

  it('REGRESIÓN: un abono parcial sigue quedando PARTIAL con el restante real', async () => {
    const { tx, orderUpdates } = makeTx(baseOrder(), [{ amount: d('50.00'), tipAmount: d('0.00'), type: 'REGULAR' }])

    const result = await run(tx)

    expect(orderUpdates[0].paymentStatus).toBe('PARTIAL')
    expect(Number(orderUpdates[0].paidAmount)).toBe(50)
    expect(Number(orderUpdates[0].remainingBalance)).toBe(150)
    expect(result.fullyPaid).toBe(false)
  })

  it('REGRESIÓN: sin pagos la cuenta queda PENDING, no PARTIAL', async () => {
    const { tx, orderUpdates } = makeTx(baseOrder(), [])

    await run(tx)

    expect(orderUpdates[0].paymentStatus).toBe('PENDING')
    expect(Number(orderUpdates[0].paidAmount)).toBe(0)
    expect(Number(orderUpdates[0].remainingBalance)).toBe(200)
  })

  it('REGRESIÓN: descuento y cargo por servicio siguen entrando al total', async () => {
    const { tx, orderUpdates } = makeTx(baseOrder({ discountAmount: d('50.00'), serviceChargeAmount: d('20.00') }), [
      { amount: d('100.00'), tipAmount: d('0.00'), type: 'REGULAR' },
    ])

    await run(tx)

    // 200 − 50 + 20 = 170; pagados 100 ⇒ faltan 70.
    expect(Number(orderUpdates[0].total)).toBe(170)
    expect(Number(orderUpdates[0].remainingBalance)).toBe(70)
    expect(orderUpdates[0].paymentStatus).toBe('PARTIAL')
  })
})
