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

import { getOrders } from '@/services/tpv/order.tpv.service'

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
