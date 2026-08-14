/**
 * recalculateOrderTotals — las líneas de promoción quedan FUERA de la base de
 * los descuentos % de orden (audit max 2026-08-13).
 *
 * La promo ya trae su precio negociado: re-derivar el 20% de orden sobre un
 * subtotal que incluye el combo de $99 subía el descuento de $20 a $39.80 —
 * doble descuento sobre lo ya descontado. El subtotal de la ORDEN sí incluye
 * las líneas de promo (es dinero que se cobra); solo la base del % las excluye.
 */

import { prismaMock } from '../../../__helpers__/setup'
import { recalculateOrderTotals } from '@/services/mobile/comp-item.mobile.service'

describe('recalculateOrderTotals — base de descuento sin líneas de promoción', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.orderItem.findMany.mockResolvedValue([
      { total: 100, orderPromotionId: null },
      { total: 99, orderPromotionId: 'op-1' }, // combo: precio ya negociado
    ] as any)
    prismaMock.orderServiceCharge.findMany.mockResolvedValue([] as any)
    prismaMock.orderDiscount.update.mockResolvedValue({} as any)
    prismaMock.order.update.mockImplementation(async (args: any) => ({
      subtotal: args.data.subtotal,
      discountAmount: args.data.discountAmount,
      serviceChargeAmount: args.data.serviceChargeAmount,
      total: args.data.total,
      version: 2,
    }))
  })

  it('🔴 el 20% de orden se calcula sobre los $100 normales, no sobre los $199', async () => {
    prismaMock.orderDiscount.findMany.mockResolvedValue([
      { id: 'd1', type: 'PERCENTAGE', value: 20, amount: 39.8, appliedToItemIds: [] },
    ] as any)

    await recalculateOrderTotals('order-1', 0, 0)

    expect(prismaMock.orderDiscount.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'd1' }, data: { amount: 20 } }))
    const orderData = prismaMock.order.update.mock.calls[0][0].data
    // El subtotal SÍ incluye el combo (dinero que se cobra)…
    expect(orderData.subtotal).toBe(199)
    // …pero el total descuenta $20, no $39.80.
    expect(orderData.discountAmount).toBe(20)
    expect(orderData.total).toBe(179)
  })

  it('sin promos en la cuenta, el % sigue sobre el subtotal completo (regresión)', async () => {
    prismaMock.orderItem.findMany.mockResolvedValue([
      { total: 100, orderPromotionId: null },
      { total: 50, orderPromotionId: null },
    ] as any)
    prismaMock.orderDiscount.findMany.mockResolvedValue([
      { id: 'd1', type: 'PERCENTAGE', value: 10, amount: 15, appliedToItemIds: [] },
    ] as any)

    await recalculateOrderTotals('order-1', 0, 0)

    expect(prismaMock.orderDiscount.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'd1' }, data: { amount: 15 } }))
  })
})
