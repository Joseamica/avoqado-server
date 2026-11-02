// Task 7 — uso del descuento (POS vs ligas) y compatibilidad con ligas en la lista.
import { getDiscountById, getDiscounts } from '../../../../src/services/dashboard/discount.dashboard.service'
import { prismaMock } from '../../../__helpers__/setup'
import { Decimal } from '@prisma/client/runtime/library'

const fila = (over: Record<string, unknown> = {}) => ({
  id: 'cdisc00000000000000000001', venueId: 'v1', name: 'Verano', description: null, type: 'PERCENTAGE', value: new Decimal(10),
  scope: 'ORDER', active: true, isAutomatic: false, requiresApproval: false, type_: null,
  buyQuantity: null, getQuantity: null, getDiscountPercent: null, buyItemIds: [], getItemIds: [],
  maxTotalUses: null, maxUsesPerCustomer: null, customerGroupId: null,
  minPurchaseAmount: null, maxDiscountAmount: null, couponCodes: [], customerDiscounts: [],
  _count: { couponCodes: 0, customerDiscounts: 0, orderDiscounts: 4 },
  ...over,
})

describe('getDiscountById — usage', () => {
  it('total 4, ligasPagadas 1, pos 3 (dos count acotados, sin cargar filas)', async () => {
    ;(prismaMock.discount.findFirst as jest.Mock).mockResolvedValue(fila())
    ;(prismaMock.orderDiscount.count as jest.Mock).mockResolvedValueOnce(4).mockResolvedValueOnce(1)
    const r: any = await getDiscountById('v1', 'cdisc00000000000000000001')
    expect(r.usage).toEqual({ total: 4, pos: 3, ligasPagadas: 1 })
    expect(prismaMock.orderDiscount.count).toHaveBeenCalledWith({ where: { discountId: 'cdisc00000000000000000001', order: { venueId: 'v1' } } })
    expect(prismaMock.orderDiscount.count).toHaveBeenCalledWith({
      where: { discountId: 'cdisc00000000000000000001', order: { venueId: 'v1', source: 'PAYMENT_LINK' } },
    })
    expect(prismaMock.orderDiscount.findMany).not.toHaveBeenCalled()
  })
})

describe('getDiscounts — paymentLinkCompatibility', () => {
  it('ok para uno simple y razón para uno con límite de usos', async () => {
    ;(prismaMock.discount.count as jest.Mock).mockResolvedValue(2)
    ;(prismaMock.discount.findMany as jest.Mock).mockResolvedValue([fila(), fila({ id: 'cdisc00000000000000000002', maxTotalUses: 50 })])
    const r = await getDiscounts('v1')
    expect((r.data[0] as any).paymentLinkCompatibility).toEqual({ ok: true, razon: null })
    expect((r.data[1] as any).paymentLinkCompatibility).toEqual({ ok: false, razon: 'Tiene límite de usos: escríbelo a mano' })
  })
})
