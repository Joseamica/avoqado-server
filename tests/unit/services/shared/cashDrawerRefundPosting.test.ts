/**
 * 🔴 EL CAJÓN SUMABA LA VENTA PERO NO RESTABA EL REEMBOLSO QUE LA APP USA DE VERDAD.
 *
 * Medido en hardware el 2026-08-16: el cajón marcaba $50,380 con $50,230 físicos.
 * El sobrante inventado era EXACTAMENTE lo reembolsado ($150).
 *
 * Hay dos rutas de reembolso y sólo una movía la caja:
 *   · `POST /mobile/venues/:venueId/refunds`  → `refund.mobile.service` → SÍ creaba PAY_OUT,
 *      pero NINGÚN cliente la llama.
 *   · `POST /mobile/venues/:venueId/payments/:paymentId/refund` → `refundDashboardService`
 *      → NO tocaba el cajón. ES LA QUE USA LA APP.
 *
 * Este archivo fija el helper compartido que ahora sabe restar, y que usan las DOS rutas
 * para que exista UN solo lugar con la decisión.
 */

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import { postCashRefundToDrawer, cashRefundDrawerLocalId, DRAWER_REFUND_NOTE_PREFIX } from '@/services/shared/cashDrawerPosting'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'

const reembolsoEnEfectivo = (over: Record<string, unknown> = {}) => ({
  venueId: VENUE,
  refundPaymentId: 'refund-1',
  // Semántica del pago ORIGINAL: es la que dice si el dinero estaba en el cajón.
  method: 'CASH',
  amount: 150,
  staffId: 'staff-1',
  staffName: 'Cajero',
  orderId: 'order-1',
  reason: 'Producto defectuoso',
  ...over,
})

describe('postCashRefundToDrawer — el reembolso en efectivo RESTA del cajón', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prismaMock as any).cashDrawerSession = { updateMany: jest.fn().mockResolvedValue({ count: 1 }), update: jest.fn().mockResolvedValue({}), findFirst: jest.fn().mockResolvedValue({ id: 'session-1' }) }
    ;(prismaMock as any).cashDrawerEvent = { createMany: jest.fn().mockResolvedValue({ count: 1 }) }
  })

  // ── LO NUEVO ────────────────────────────────────────────────────────────────

  it('🔴 un reembolso en efectivo con caja ABIERTA crea un CashDrawerEvent PAY_OUT por lo devuelto', async () => {
    const outcome = await postCashRefundToDrawer(reembolsoEnEfectivo({ amount: 150 }))

    expect(outcome).toBe('POSTED')
    const args = (prismaMock as any).cashDrawerEvent.createMany.mock.calls[0][0]
    expect(args.data[0]).toMatchObject({
      sessionId: 'session-1',
      venueId: VENUE,
      type: 'PAY_OUT',
      staffId: 'staff-1',
      staffName: 'Cajero',
      orderId: 'order-1',
    })
    expect(Number(args.data[0].amount)).toBe(150)
  })

  it('🔴 el monto del PAY_OUT es SIEMPRE positivo, aunque le pasen el Payment negativo del reembolso', async () => {
    // `calculateExpectedAmount` hace `expected -= amount` en un PAY_OUT: un monto
    // negativo SUMARÍA al cajón — el mismo signo invertido que originó este bug.
    await postCashRefundToDrawer(reembolsoEnEfectivo({ amount: -150 }))

    expect(Number((prismaMock as any).cashDrawerEvent.createMany.mock.calls[0][0].data[0].amount)).toBe(150)
  })

  it('🔴 SIN caja abierta el reembolso NO truena: la caja jamás puede impedir devolverle su dinero a un cliente', async () => {
    ;(prismaMock as any).cashDrawerSession.findFirst.mockResolvedValue(null)

    await expect(postCashRefundToDrawer(reembolsoEnEfectivo())).resolves.toBe('NO_OPEN_DRAWER')
    expect((prismaMock as any).cashDrawerEvent.createMany).not.toHaveBeenCalled()
  })

  it('🔴 si la escritura del evento REVIENTA, tampoco truena el reembolso (fail-open duro)', async () => {
    ;(prismaMock as any).cashDrawerEvent.createMany.mockRejectedValue(new Error('DB caída'))

    await expect(postCashRefundToDrawer(reembolsoEnEfectivo())).resolves.toBe('FAILED')
  })

  it('un reembolso de un cobro con TARJETA no toca la caja', async () => {
    await expect(postCashRefundToDrawer(reembolsoEnEfectivo({ method: 'CREDIT_CARD' }))).resolves.toBe('NOT_DRAWER_CASH')
    expect((prismaMock as any).cashDrawerSession.findFirst).not.toHaveBeenCalled()
    expect((prismaMock as any).cashDrawerEvent.createMany).not.toHaveBeenCalled()
  })

  it('🔴 la pregunta "¿salió del cajón?" la contesta tenderSemantics, NO un method===CASH del cuerpo del cliente', async () => {
    // Un vale de despensa viaja como method=OTHER + tenderCountsAsCash=true. El
    // `if (method === 'CASH')` del gemelo viejo lo dejaba fuera del arqueo.
    const outcome = await postCashRefundToDrawer(
      reembolsoEnEfectivo({ method: 'OTHER', tenderTypeId: 'tender-vale', tenderCountsAsCash: true, amount: 80 }),
    )

    expect(outcome).toBe('POSTED')
    expect(Number((prismaMock as any).cashDrawerEvent.createMany.mock.calls[0][0].data[0].amount)).toBe(80)
  })

  it('🔴 `fundsFlow` manda sobre el método: un OTHER estampado CASH_DRAWER sale del cajón', async () => {
    await expect(postCashRefundToDrawer(reembolsoEnEfectivo({ method: 'OTHER', fundsFlow: 'CASH_DRAWER' }))).resolves.toBe('POSTED')
  })

  it('🔴 la nota lleva el prefijo "Reembolso:" — el corte del POS separa reembolsos de retiros por ese prefijo', async () => {
    await postCashRefundToDrawer(reembolsoEnEfectivo({ reason: 'Producto defectuoso' }))

    const note = (prismaMock as any).cashDrawerEvent.createMany.mock.calls[0][0].data[0].note
    expect(DRAWER_REFUND_NOTE_PREFIX).toBe('Reembolso:')
    expect(note.startsWith(DRAWER_REFUND_NOTE_PREFIX)).toBe(true)
    expect(note).toBe('Reembolso: Producto defectuoso')
  })

  it('sin cajero identificado (dashboard/MCP) el movimiento queda a nombre del sistema, no se pierde', async () => {
    ;(prismaMock as any).staff = { findUnique: jest.fn().mockResolvedValue(null) }

    await postCashRefundToDrawer(reembolsoEnEfectivo({ staffId: null, staffName: null }))

    const row = (prismaMock as any).cashDrawerEvent.createMany.mock.calls[0][0].data[0]
    expect(row.staffId).toBe('SYSTEM')
    expect(row.staffName).toBe('Sistema')
  })

  // ── IDEMPOTENCIA ────────────────────────────────────────────────────────────

  it('🔴 la llave se DERIVA del refundPaymentId: un reintento no puede restar dos veces', async () => {
    await postCashRefundToDrawer(reembolsoEnEfectivo({ refundPaymentId: 'refund-42' }))

    const args = (prismaMock as any).cashDrawerEvent.createMany.mock.calls[0][0]
    expect(args.data[0].localId).toBe(cashRefundDrawerLocalId('refund-42'))
    expect(args.data[0].localId).toBe('srv-refund:refund-42')
    expect(args.skipDuplicates).toBe(true)
  })

  it('🔴 la llave del reembolso NO choca con la de la venta del mismo id (prefijos distintos)', async () => {
    const { cashSaleDrawerLocalId } = await import('@/services/shared/cashDrawerPosting')
    expect(cashRefundDrawerLocalId('x')).not.toBe(cashSaleDrawerLocalId('x'))
  })

  it('🔴 un reintento reporta ALREADY_POSTED (Postgres lo saltó), no un segundo movimiento', async () => {
    ;(prismaMock as any).cashDrawerEvent.createMany.mockResolvedValue({ count: 0 })

    await expect(postCashRefundToDrawer(reembolsoEnEfectivo())).resolves.toBe('ALREADY_POSTED')
  })

  // ── REGRESIÓN / BORDES ──────────────────────────────────────────────────────

  it('un reembolso de $0 no ensucia el cajón con un movimiento vacío', async () => {
    await expect(postCashRefundToDrawer(reembolsoEnEfectivo({ amount: 0 }))).resolves.toBe('NOT_DRAWER_CASH')
    expect((prismaMock as any).cashDrawerEvent.createMany).not.toHaveBeenCalled()
  })
})
