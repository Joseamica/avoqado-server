/**
 * D15 (pizarrón hz:e82938e1:D15, 18-nov): el detalle de la cuenta del POS (Mesas de ANDROID/WINDOWS) dice qué descuento quedó FIJO
 * al cobrar los vales. Lo demás de cada descuento va igual (id, nombre, monto) y el `reparto` no viaja.
 */
import prisma from '@/utils/prismaClient'
import { getOrder } from '@/services/mobile/order.mobile.service'

const prismaMock = prisma as any
const orden = (o: Record<string, unknown>) => ({
  id: 'o1',
  orderNumber: '42',
  status: 'CONFIRMED',
  paymentStatus: 'PENDING',
  type: 'TAKEOUT',
  source: 'AVOQADO_ANDROID',
  subtotal: 100,
  discountAmount: 15,
  tipAmount: 0,
  total: 85,
  servedBy: null,
  servedById: null,
  items: [],
  payments: [],
  ...o,
})

describe('getOrder del POS — D15: la rebaja fija del cobro de vales', () => {
  it('🔴 pide el reparto de cada descuento y manda congeladoPorVales sólo en la fila marcada', async () => {
    prismaMock.order.findUnique.mockResolvedValue(
      orden({
        orderDiscounts: [
          { id: 'od-vale', name: '10 % producto', amount: 10, reparto: { v: 1, alcance: 'DIRIGIDO', espejo: true, deValeV7: true } },
          { id: 'od-cuenta', name: 'Cliente frecuente', amount: 5, reparto: { v: 1, alcance: 'CUENTA', espejo: false } },
        ],
      }),
    )

    const o = await getOrder('v1', 'o1')

    expect(prismaMock.order.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({ orderDiscounts: { select: { id: true, name: true, amount: true, reparto: true } } }),
      }),
    )
    expect(o.discounts).toEqual([
      { id: 'od-vale', name: '10 % producto', amount: 10, congeladoPorVales: true },
      { id: 'od-cuenta', name: 'Cliente frecuente', amount: 5, congeladoPorVales: false },
    ])
  })
})
