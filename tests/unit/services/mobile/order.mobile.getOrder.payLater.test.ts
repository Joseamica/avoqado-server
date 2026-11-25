/**
 * D39 (Codex r1 #1): el detalle de la cuenta del POS dice si se mandó a «Pagar después» a propósito (`Order.payLater`). Sin mesa no
 * basta: una importada o de plataforma tampoco tiene mesa, y el canje la rechaza. El POS ofrece «Recompensas» en Pedidos sólo con `true`.
 */
import prisma from '@/utils/prismaClient'
import { getOrder, listOrders } from '@/services/mobile/order.mobile.service'

const prismaMock = prisma as any
const orden = (o: Record<string, unknown>) => ({
  id: 'o1',
  orderNumber: '42',
  status: 'CONFIRMED',
  paymentStatus: 'PENDING',
  type: 'TAKEOUT',
  source: 'AVOQADO_ANDROID',
  subtotal: 100,
  discountAmount: 0,
  tipAmount: 0,
  total: 100,
  servedBy: null,
  servedById: null,
  tableId: null,
  items: [],
  payments: [],
  ...o,
})

describe('getOrder del POS — D39: payLater', () => {
  it('una cuenta de «Pagar después»: payLater true', async () => {
    prismaMock.order.findUnique.mockResolvedValue(orden({ payLater: true }))
    expect((await getOrder('v1', 'o1')).payLater).toBe(true)
  })

  it('una venta que se creó para cobrarse: false; una fila vieja o importada sin el dato: null', async () => {
    prismaMock.order.findUnique.mockResolvedValue(orden({ payLater: false }))
    expect((await getOrder('v1', 'o1')).payLater).toBe(false)
    prismaMock.order.findUnique.mockResolvedValue(orden({ payLater: null }))
    expect((await getOrder('v1', 'o1')).payLater).toBeNull()
    prismaMock.order.findUnique.mockResolvedValue(orden({}))
    expect((await getOrder('v1', 'o1')).payLater).toBeNull()
  })
})

describe('listOrders del POS — D39: payLater en cada fila (la copia sin red de Pedidos)', () => {
  it('lo manda igual que el detalle', async () => {
    prismaMock.order.findMany.mockResolvedValue([
      orden({ id: 'o1', payLater: true, _count: { items: 1 } }),
      orden({ id: 'o2', payLater: null, _count: { items: 1 } }),
    ])
    prismaMock.order.count.mockResolvedValue(2)
    prismaMock.$transaction.mockImplementation(async (ops: any) => (Array.isArray(ops) ? Promise.all(ops) : ops(prismaMock)))
    const filas = (await listOrders('v1', { page: 1, pageSize: 20 })).data
    expect(filas.map(f => f.payLater)).toEqual([true, null])
  })
})
