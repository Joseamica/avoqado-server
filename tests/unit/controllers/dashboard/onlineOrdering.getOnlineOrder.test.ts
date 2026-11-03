/**
 * Pedidos en línea fase 2, clientes (S3, Codex plan r1 #2): la bandeja del panel sólo guarda los cerrados 24 h, y devolver a la
 * tarjeta (o «Devolver por otro medio» tras una reversa) puede hacer falta días después. El detalle de la cuenta del panel lee el
 * pedido en línea por el id de la cuenta con la forma de la bandeja; si la cuenta no es un pedido en línea, 404.
 */
jest.mock('@/services/online-ordering/inbox.service', () => ({ getInboxOrder: jest.fn() }))

import { getInboxOrder } from '@/services/online-ordering/inbox.service'
import { getOnlineOrderHandler } from '@/controllers/dashboard/onlineOrdering.dashboard.controller'

const res = () => {
  const r: any = {}
  r.json = jest.fn().mockReturnValue(r)
  r.status = jest.fn().mockReturnValue(r)
  return r
}

describe('GET /dashboard/venues/:venueId/online-ordering/orders/:orderId', () => {
  beforeEach(() => jest.clearAllMocks())

  it('devuelve el pedido con la forma de la bandeja, buscado por negocio y cuenta', async () => {
    const pedido = { orderId: 'ord1', paymentMode: 'CARD_ONLINE', card: { status: 'CAPTURED' } }
    ;(getInboxOrder as jest.Mock).mockResolvedValue(pedido)
    const r = res()
    const next = jest.fn()
    await getOnlineOrderHandler({ params: { venueId: 'v1', orderId: 'ord1' } } as any, r, next)
    expect(getInboxOrder).toHaveBeenCalledWith({ venueId: 'v1', orderId: 'ord1' })
    expect(r.json).toHaveBeenCalledWith({ success: true, data: pedido })
    expect(next).not.toHaveBeenCalled()
  })

  it('una cuenta que no es pedido en línea (o de otro negocio) ⇒ 404', async () => {
    ;(getInboxOrder as jest.Mock).mockResolvedValue(null)
    const next = jest.fn()
    await getOnlineOrderHandler({ params: { venueId: 'v1', orderId: 'ord-x' } } as any, res(), next)
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }))
  })
})
