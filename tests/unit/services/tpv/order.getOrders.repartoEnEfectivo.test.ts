/**
 * Rappi 2b (Codex plan de apps r1 #5): la lista «Órdenes» de la TPV (legacy, sin mantenimiento) no tiene el reparto
 * terceros → propina → venta. Un pedido de plataforma con efectivo por cobrar (`thirdPartyCashDue` no nulo) ya no sale ahí:
 * se cobra en «Pedidos en línea» del POS. Lo que ya entró por la TPV no se rechaza (no se toca su registrador).
 */
import { prismaMock } from '../../../__helpers__/setup'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn().mockReturnValue(null), broadcastToVenue: jest.fn() },
}))

import { getOrder, getOrders } from '@/services/tpv/order.tpv.service'

const filtro = () => (prismaMock.order.findMany as jest.Mock).mock.calls[0]?.[0]?.where

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.order.findMany.mockResolvedValue([])
})

describe('getOrders de la TPV: pedidos de plataforma en efectivo', () => {
  it.each([
    ['por omisión', undefined],
    ['con los de «pagar después»', { includePayLater: true }],
    ['sólo «pagar después»', { onlyPayLater: true }],
    ['con los del kiosco', { includeKiosk: true }],
  ])('%s, no lista los que tienen efectivo de reparto por cobrar', async (_caso, opciones) => {
    await getOrders('venue-1', undefined, opciones)
    expect(filtro()).toMatchObject({ venueId: 'venue-1', thirdPartyCashDue: null })
  })
})

// Pedidos en línea fase 2 (T8, Codex r2 #1): la terminal no debe poder EMPEZAR un cobro local de un pedido pagado con tarjeta en
// línea. La lista no lo trae (sí los de pagar al recoger) y la lectura de uno solo responde 409. Cubre también a las TPV viejas.
describe('TPV: pedidos en línea con tarjeta', () => {
  it.each([
    ['por omisión', undefined],
    ['con los de «pagar después»', { includePayLater: true }],
    ['sólo «pagar después»', { onlyPayLater: true }],
    ['con los del kiosco', { includeKiosk: true }],
  ])('%s, el listado no trae pedidos de tarjeta y sí los de pagar al recoger', async (_caso, opciones) => {
    await getOrders('venue-1', undefined, opciones)
    expect(filtro().AND).toEqual(expect.arrayContaining([{ onlineOrder: { isNot: { paymentMode: 'CARD_ONLINE' } } }]))
  })

  it('pedir un pedido de tarjeta para cobrarlo → 409 ONLINE_ORDER_PAID_BY_CARD', async () => {
    prismaMock.order.findUnique.mockResolvedValue({ id: 'o-web', venueId: 'venue-1', items: [], payments: [], table: null } as any)
    prismaMock.onlineOrder.findFirst.mockResolvedValue({
      paymentMode: 'CARD_ONLINE',
      charge: { id: 'ch1', status: 'AUTHORIZED', paymentIntentId: 'pi_1' },
    } as any)
    await expect(getOrder('venue-1', 'o-web')).rejects.toMatchObject({ statusCode: 409, code: 'ONLINE_ORDER_PAID_BY_CARD' })
  })
})
