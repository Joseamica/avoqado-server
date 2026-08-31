/**
 * "La comida ya está lista" → avisarle a Uber.
 *
 * La validación de producción de Uber (caso 59605086) exige ver funcionando "Mark Order as
 * Ready". El gesto humano ya existe: la cocina marca listo en el KDS — esto sólo conecta ese
 * gesto con el aviso al marketplace, sin botón nuevo.
 */
import prisma from '../../../../src/utils/prismaClient'
import { adapterFor, hasAdapter } from '../../../../src/services/delivery-channels/core/adapterRegistry'
import { markDeliveryOrderReady } from '../../../../src/services/delivery-channels/core/respondToDeliveryOrder.service'

jest.mock('../../../../src/services/delivery-channels/core/adapterRegistry', () => ({
  hasAdapter: jest.fn(() => true),
  adapterFor: jest.fn(),
}))

const markOrderReady = jest.fn()

describe('markDeliveryOrderReady', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(hasAdapter as jest.Mock).mockReturnValue(true)
    ;(adapterFor as jest.Mock).mockReturnValue({ markOrderReady })
    ;(prisma.order.findFirst as jest.Mock).mockResolvedValue({
      id: 'order1',
      externalId: 'UBER_EATS:uuid-uber-1',
      status: 'CONFIRMED',
      orderNumber: 'A-1',
    })
    ;(prisma.deliveryChannelLink.findFirst as jest.Mock).mockResolvedValue({ externalLocationId: 'store-uuid' })
    markOrderReady.mockResolvedValue({ ok: true, status: 200, raw: '' })
  })

  it('avisa a Uber con el id que UBER conoce (sin el prefijo) y la tienda del canal', async () => {
    const r = await markDeliveryOrderReady('venue1', 'order1')

    expect(r.outcome).toBe('READY')
    expect(markOrderReady).toHaveBeenCalledWith('uuid-uber-1', 'store-uuid')
  })

  it('🔴 una venta que NO es de delivery es un NO-OP silencioso — el KDS lo llama en CADA bump', async () => {
    // El enganche vive en el flujo del KDS, que también maneja comandas de mesa y mostrador.
    // Si esto lanzara para las no-delivery, marcar lista una hamburguesa de mesa fallaría.
    ;(prisma.order.findFirst as jest.Mock).mockResolvedValue({ id: 'order1', externalId: null })

    const r = await markDeliveryOrderReady('venue1', 'order1')

    expect(r.outcome).toBe('NOT_A_DELIVERY_ORDER')
    expect(markOrderReady).not.toHaveBeenCalled()
  })

  it('si Uber rechaza, devuelve FAILED con el detalle — el caller decide si le importa', async () => {
    markOrderReady.mockResolvedValue({ ok: false, status: 400, raw: 'no longer active' })

    const r = await markDeliveryOrderReady('venue1', 'order1')

    expect(r.outcome).toBe('FAILED')
  })

  it('tenant isolation: la venta se busca con venueId en el where', async () => {
    await markDeliveryOrderReady('venue-otro', 'order1')

    expect((prisma.order.findFirst as jest.Mock).mock.calls[0][0].where).toEqual({ id: 'order1', venueId: 'venue-otro' })
  })
})
