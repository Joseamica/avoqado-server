/**
 * IVA por producto, plan 7 (r2 R2-13): el detalle de orden dice el IVA que la orden de verdad SUMA aparte. Con contrato
 * IVA_INCLUIDO y un `taxAmount` escrito (el contraejemplo de la Tarea 1) no hay IVA agregado.
 */
import prisma from '@/utils/prismaClient'
import { getOrder } from '@/services/mobile/order.mobile.service'

const prismaMock = prisma as any
const orden = (o: Record<string, unknown>) => ({
  id: 'o1',
  orderNumber: '42',
  status: 'COMPLETED',
  paymentStatus: 'PAID',
  type: 'TAKEOUT',
  source: 'AVOQADO_ANDROID',
  subtotal: 100,
  discountAmount: 0,
  tipAmount: 0,
  total: 100,
  servedBy: null,
  servedById: null,
  items: [],
  payments: [],
  ...o,
})

it('🔴 contrato IVA_INCLUIDO con taxAmount 16 escrito: addedTaxAmount 0 (el precio ya lo traía)', async () => {
  prismaMock.order.findUnique.mockResolvedValue(orden({ taxAmount: 16, contratoDePrecio: 'IVA_INCLUIDO' }))
  expect((await getOrder('v1', 'o1')).addedTaxAmount).toBe(0)
})

it('IVA aparte (SoftRestaurant, DESCONOCIDO): addedTaxAmount = el IVA de la orden; taxAmount de siempre intacto', async () => {
  prismaMock.order.findUnique.mockResolvedValue(orden({ taxAmount: 16, total: 116, contratoDePrecio: 'DESCONOCIDO' }))
  const o = await getOrder('v1', 'o1')
  expect(o.addedTaxAmount).toBe(16)
  expect(o.taxAmount).toBe(16)
})

it('🔴 orden CANCELADA con taxAmount 16 y contrato DESCONOCIDO: addedTaxAmount 0 (una cancelada no cobró IVA aparte; revisión T4 M2)', async () => {
  prismaMock.order.findUnique.mockResolvedValue(orden({ status: 'CANCELLED', taxAmount: 16, total: 116, contratoDePrecio: 'DESCONOCIDO' }))
  expect((await getOrder('v1', 'o1')).addedTaxAmount).toBe(0)
})
