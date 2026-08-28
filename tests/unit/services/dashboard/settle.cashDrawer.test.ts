/**
 * Fase 2 de la unificación de caja: liquidar un saldo desde el dashboard MUEVE el cajón.
 *
 * `settleOrder` y `settleCustomerBalance` crean un Payment CASH hardcodeado y NO publicaban
 * al cajón (auditoría 27-ago §2.2): el reporte de ventas subía y el arqueo no ⇒ FALTANTE
 * falso al cerrar. Decisión del founder (27-ago): ese efectivo SÍ entró a la caja.
 *
 * Dos invariantes que ya siguen los otros caminos:
 *   · el posting va DESPUÉS del commit (el Payment ya existe aunque el cajón falle);
 *   · fail-open: si el cajón truena, la liquidación igual se completa.
 * Y el Payment nace con `fundsFlow = CASH_DRAWER` explícito, para no depender del fallback.
 */
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  createSalePostingInTx: jest.fn().mockResolvedValue(null),
  applySalePosting: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/referrals/referralQualification.service', () => ({ onOrderPaid: jest.fn() }))
jest.mock('@/services/shared/cashDrawerPosting', () => ({
  postCashSaleToDrawer: jest.fn().mockResolvedValue('POSTED'),
  cashSaleDrawerLocalId: (id: string) => `pay:${id}`,
}))

import { postCashSaleToDrawer } from '@/services/shared/cashDrawerPosting'
import { settleOrder } from '@/services/dashboard/order.dashboard.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'

function armarOrden() {
  const order = {
    id: 'order-1',
    venueId: VENUE,
    orderNumber: 'A-1',
    total: 500,
    paidAmount: 0,
    remainingBalance: 500,
    paymentStatus: 'PENDING',
    version: 1,
  }
  const created: any[] = []
  ;(prismaMock as any).order = {
    findFirst: jest.fn().mockResolvedValue(order),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  }
  ;(prismaMock as any).payment = {
    // settleOrder recalcula lo YA pagado antes de liquidar: nada pagado ⇒ liquida los $500
    aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0, tipAmount: 0 } }),
    create: jest.fn().mockImplementation(async (args: any) => {
      const row = { id: 'pay-1', ...args.data }
      created.push(row)
      return row
    }),
  }
  ;(prismaMock as any).orderItem = { findMany: jest.fn().mockResolvedValue([]) }
  ;(prismaMock as any).$transaction = jest.fn().mockImplementation(async (fn: any) => fn(prismaMock))
  return { order, created }
}

beforeEach(() => jest.clearAllMocks())

describe('settleOrder — liquidar desde el dashboard', () => {
  it('🔴 el Payment nace con fundsFlow=CASH_DRAWER, no depende del fallback por método', async () => {
    const { created } = armarOrden()
    await settleOrder(VENUE, 'order-1')
    expect(created[0].method).toBe('CASH')
    expect(created[0].fundsFlow).toBe('CASH_DRAWER')
  })

  it('🔴 publica la venta al cajón DESPUÉS del commit, con el monto liquidado', async () => {
    armarOrden()
    await settleOrder(VENUE, 'order-1')
    expect(postCashSaleToDrawer).toHaveBeenCalledTimes(1)
    expect(postCashSaleToDrawer).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId: VENUE,
        paymentId: 'pay-1',
        orderId: 'order-1',
        status: 'COMPLETED',
        amount: 500,
        fundsFlow: 'CASH_DRAWER',
      }),
    )
  })

  it('🔴 fail-open: si el cajón truena, la liquidación igual se completa', async () => {
    armarOrden()
    ;(postCashSaleToDrawer as jest.Mock).mockRejectedValueOnce(new Error('cajón caído'))
    const res = await settleOrder(VENUE, 'order-1')
    expect(res.settledAmount).toBe(500)
  })

  it('sin saldo pendiente no crea pago ni toca el cajón', async () => {
    armarOrden()
    ;(prismaMock as any).order.updateMany = jest.fn().mockResolvedValue({ count: 0 })
    const res = await settleOrder(VENUE, 'order-1')
    expect(res.settledAmount).toBe(0)
    expect(postCashSaleToDrawer).not.toHaveBeenCalled()
  })
})
