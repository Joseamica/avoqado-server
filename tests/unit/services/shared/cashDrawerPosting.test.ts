/**
 * 🔴 EL CAJÓN RESTABA LOS REEMBOLSOS PERO NO SUMABA LAS VENTAS.
 *
 * `refund.mobile.service.ts` crea un `CashDrawerEvent` PAY_OUT en cuanto se devuelve
 * efectivo, pero NINGÚN servidor creaba el evento simétrico al COBRAR en efectivo: el
 * tipo `CASH_SALE` sólo podía llegar por el push del cliente a `/cash-drawer/sync`,
 * fire-and-forget y sin cola de reintento. Medido en producción el 2026-08-16:
 * PAY_OUT = 5 eventos / $1,496.00 · CASH_SALE = 1 evento / $13.50.
 *
 * Consecuencia: `calculateExpectedAmount` = inicial + PAY_IN − PAY_OUT, y el cierre
 * de caja acusaba un FALTANTE del tamaño de todas las ventas del día. O sea: le
 * echaba la culpa al cajero por dinero que sí estaba en el cajón.
 *
 * Este archivo fija la simetría del enganche del servidor.
 */

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import { postCashSaleToDrawer, cashSaleDrawerLocalId } from '@/services/shared/cashDrawerPosting'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'

const pagoEnEfectivo = (over: Record<string, unknown> = {}) => ({
  venueId: VENUE,
  paymentId: 'payment-1',
  method: 'CASH',
  status: 'COMPLETED',
  type: 'REGULAR',
  amount: 100,
  tipAmount: 0,
  staffId: 'staff-1',
  staffName: 'Cajero',
  orderId: 'order-1',
  ...over,
})

describe('postCashSaleToDrawer — la venta en efectivo SUMA al cajón', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prismaMock as any).cashDrawerSession = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue({ id: 'session-1' }),
    }
    ;(prismaMock as any).cashDrawerEvent = { createMany: jest.fn().mockResolvedValue({ count: 1 }) }
  })

  // ── LO NUEVO ────────────────────────────────────────────────────────────────

  it('🔴 una venta en efectivo con caja ABIERTA crea un CashDrawerEvent CASH_SALE por el monto cobrado', async () => {
    const outcome = await postCashSaleToDrawer(pagoEnEfectivo({ amount: 250.5 }))

    expect(outcome).toBe('POSTED')
    const args = (prismaMock as any).cashDrawerEvent.createMany.mock.calls[0][0]
    expect(args.data[0]).toMatchObject({
      sessionId: 'session-1',
      venueId: VENUE,
      type: 'CASH_SALE',
      staffId: 'staff-1',
      staffName: 'Cajero',
      orderId: 'order-1',
    })
    expect(Number(args.data[0].amount)).toBe(250.5)
  })

  it('🔴 la propina cobrada en efectivo ENTRA al cajón (está físicamente ahí hasta que se reparta)', async () => {
    await postCashSaleToDrawer(pagoEnEfectivo({ amount: 100, tipAmount: 20 }))

    const args = (prismaMock as any).cashDrawerEvent.createMany.mock.calls[0][0]
    expect(Number(args.data[0].amount)).toBe(120)
  })

  it('🔴 SIN caja abierta el cobro NO truena: la caja jamás puede impedir una venta', async () => {
    ;(prismaMock as any).cashDrawerSession.findFirst.mockResolvedValue(null)

    await expect(postCashSaleToDrawer(pagoEnEfectivo())).resolves.toBe('NO_OPEN_DRAWER')
    expect((prismaMock as any).cashDrawerEvent.createMany).not.toHaveBeenCalled()
  })

  it('🔴 si la escritura del evento REVIENTA, tampoco truena el cobro (fail-open duro)', async () => {
    ;(prismaMock as any).cashDrawerEvent.createMany.mockRejectedValue(new Error('DB caída'))

    await expect(postCashSaleToDrawer(pagoEnEfectivo())).resolves.toBe('FAILED')
  })

  it('una venta con TARJETA no toca la caja', async () => {
    await expect(postCashSaleToDrawer(pagoEnEfectivo({ method: 'CREDIT_CARD' }))).resolves.toBe('NOT_DRAWER_CASH')
    expect((prismaMock as any).cashDrawerSession.findFirst).not.toHaveBeenCalled()
    expect((prismaMock as any).cashDrawerEvent.createMany).not.toHaveBeenCalled()
  })

  it('un cobro declarado a mano (transferencia registrada) tampoco toca la caja', async () => {
    await expect(postCashSaleToDrawer(pagoEnEfectivo({ method: 'BANK_TRANSFER' }))).resolves.toBe('NOT_DRAWER_CASH')
  })

  it('🔴 la pregunta "¿está en el cajón?" la contesta tenderSemantics, no un method===CASH local', async () => {
    // Un tender personalizado que cuenta como efectivo físico (vale de despensa)
    // viaja como method=OTHER + tenderCountsAsCash=true. Con un check local de
    // `method === 'CASH'` este dinero se quedaba fuera del arqueo.
    const outcome = await postCashSaleToDrawer(
      pagoEnEfectivo({ method: 'OTHER', tenderTypeId: 'tender-vale', tenderCountsAsCash: true, amount: 80 }),
    )

    expect(outcome).toBe('POSTED')
    expect(Number((prismaMock as any).cashDrawerEvent.createMany.mock.calls[0][0].data[0].amount)).toBe(80)
  })

  it('🔴 `fundsFlow` manda sobre el método: un OTHER estampado CASH_DRAWER entra', async () => {
    await expect(postCashSaleToDrawer(pagoEnEfectivo({ method: 'OTHER', fundsFlow: 'CASH_DRAWER' }))).resolves.toBe('POSTED')
  })

  it('un pago que aún no está COMPLETED no mueve el cajón', async () => {
    await expect(postCashSaleToDrawer(pagoEnEfectivo({ status: 'PENDING' }))).resolves.toBe('NOT_COMPLETED')
    expect((prismaMock as any).cashDrawerEvent.createMany).not.toHaveBeenCalled()
  })

  // ── IDEMPOTENCIA ────────────────────────────────────────────────────────────

  it('🔴 la llave del evento se DERIVA del paymentId: reproducir el mismo pago del outbox no duplica el movimiento', async () => {
    await postCashSaleToDrawer(pagoEnEfectivo({ paymentId: 'payment-42' }))

    const args = (prismaMock as any).cashDrawerEvent.createMany.mock.calls[0][0]
    expect(args.data[0].localId).toBe(cashSaleDrawerLocalId('payment-42'))
    // El índice @@unique([venueId, localId]) es el candado; skipDuplicates hace que
    // el reintento sea un no-op en vez de un P2002 que tumbe la respuesta del cobro.
    expect(args.skipDuplicates).toBe(true)
  })

  it('🔴 un reintento reporta ALREADY_POSTED (Postgres lo saltó), no un segundo movimiento', async () => {
    ;(prismaMock as any).cashDrawerEvent.createMany.mockResolvedValue({ count: 0 })

    await expect(postCashSaleToDrawer(pagoEnEfectivo())).resolves.toBe('ALREADY_POSTED')
  })

  // ── REGRESIÓN: no romper lo que ya existía ──────────────────────────────────

  it('🔴 un REEMBOLSO no entra por aquí — su PAY_OUT ya resta, y sumarlo lo restaría dos veces', async () => {
    // El refund crea su propio PAY_OUT (`refund.mobile.service.ts:178`) y guarda el
    // Payment con monto NEGATIVO + status COMPLETED. Si el enganche de ventas lo
    // tomara, el cajón movería el reembolso dos veces.
    await expect(postCashSaleToDrawer(pagoEnEfectivo({ type: 'REFUND', amount: -50 }))).resolves.toBe('NOT_DRAWER_CASH')
    expect((prismaMock as any).cashDrawerEvent.createMany).not.toHaveBeenCalled()
  })

  it('un cobro en $0 (cuenta cortesiada al 100%) no ensucia el cajón con un movimiento vacío', async () => {
    await expect(postCashSaleToDrawer(pagoEnEfectivo({ amount: 0, tipAmount: 0 }))).resolves.toBe('NOT_DRAWER_CASH')
  })

  it('un pago de prueba (type TEST, demo en vivo) no mueve dinero real', async () => {
    await expect(postCashSaleToDrawer(pagoEnEfectivo({ type: 'TEST' }))).resolves.toBe('NOT_DRAWER_CASH')
  })
})
