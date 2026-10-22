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

// La reserva simétrica (spec §3.2) se prueba contra Postgres en
// tests/integration/delivery-channels/aceptacionAcreditada.test.ts; aquí se deja pasar.
// `mockTx` deja ver si se selló `readyReportedAt` (el `aplicar` corre con el tx del candado).
const mockTx = { order: { updateMany: jest.fn() } }
jest.mock('../../../../src/services/delivery-channels/core/deliveryOrderLock', () => ({
  tomarReserva: jest.fn(async () => ({ ok: true, token: 'tok' })),
  soltarReserva: jest.fn(async () => true),
  withDeliveryOrderLock: jest.fn(async (_id: string, fn: (tx: unknown) => unknown) => fn(mockTx)),
}))

// Tarea 13: para el caso con el adaptador REAL de Rappi — su red (`rappi.client`) y su contador en la base
// (`rappi.estadoDelPedido`) van simulados; el contador real se prueba en tests/integration/delivery-channels/rappiTopeDeListo.test.ts.
const mockMarcarListoRappi = jest.fn()
jest.mock('../../../../src/services/delivery-channels/providers/rappi/rappi.client', () => ({
  marcarListoRappi: (...a: unknown[]) => mockMarcarListoRappi(...a),
}))
jest.mock('../../../../src/services/delivery-channels/providers/rappi/rappi.estadoDelPedido', () => ({
  ...jest.requireActual('../../../../src/services/delivery-channels/providers/rappi/rappi.estadoDelPedido'),
  reservarLlamadaDeListo: jest.fn(async () => ({ permitido: true })),
  cerrarListo: jest.fn(async () => undefined),
}))

const markOrderReady = jest.fn()

describe('markDeliveryOrderReady', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prisma as any).deliveryLineAction = { count: jest.fn().mockResolvedValue(0) }
    ;(hasAdapter as jest.Mock).mockReturnValue(true)
    ;(adapterFor as jest.Mock).mockReturnValue({ markOrderReady })
    ;(prisma.order.findFirst as jest.Mock).mockResolvedValue({
      id: 'order1',
      externalId: 'UBER_EATS:uuid-uber-1',
      status: 'CONFIRMED',
      orderNumber: 'A-1',
      deliveryChannelLinkId: 'link1',
    })
    ;(prisma.deliveryChannelLink.findFirst as jest.Mock).mockResolvedValue({
      provider: 'UBER_EATS',
      externalLocationId: 'store-uuid',
    })
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

  it('un 2xx sella readyReportedAt (regresión: lo de siempre)', async () => {
    const r = await markDeliveryOrderReady('venue1', 'order1')

    expect(r.outcome).toBe('READY')
    expect(mockTx.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order1', readyReportedAt: null },
      data: { readyReportedAt: expect.any(Date) },
    })
  })

  it('🔴 una respuesta terminal NO sella readyReportedAt: devuelve NO_REINTENTAR (se dejó de intentar, no «listo»)', async () => {
    markOrderReady.mockResolvedValue({ ok: false, status: 0, raw: 'TOPE_DE_LISTO', terminal: true })

    const r = await markDeliveryOrderReady('venue1', 'order1')

    expect(r).toEqual({ outcome: 'NO_REINTENTAR', error: 'TOPE_DE_LISTO' })
    expect(mockTx.order.updateMany).not.toHaveBeenCalled()
  })

  it('🔴 un 400 terminal (transición inválida) tampoco sella: NO_REINTENTAR con el detalle', async () => {
    markOrderReady.mockResolvedValue({ ok: false, status: 400, raw: 'Invalid transition from {TAKEN}', terminal: true })

    const r = await markDeliveryOrderReady('venue1', 'order1')

    expect(r).toEqual({ outcome: 'NO_REINTENTAR', error: 'Invalid transition from {TAKEN}' })
    expect(mockTx.order.updateMany).not.toHaveBeenCalled()
  })

  it('un rechazo NO terminal sigue siendo FAILED (el job lo reintenta con espera)', async () => {
    markOrderReady.mockResolvedValue({ ok: false, status: 424, raw: 'intentelo mas tarde' })

    const r = await markDeliveryOrderReady('venue1', 'order1')

    expect(r.outcome).toBe('FAILED')
    expect(mockTx.order.updateMany).not.toHaveBeenCalled()
  })

  it('🔴 el "listo" de Rappi va por markOrderReady: con el adaptador REAL, el núcleo sí le avisa a Rappi', async () => {
    const { rappiAdapter } = jest.requireActual('../../../../src/services/delivery-channels/providers/rappi/rappi.adapter')
    ;(adapterFor as jest.Mock).mockReturnValue(rappiAdapter)
    ;(prisma.order.findFirst as jest.Mock).mockResolvedValue({
      id: 'order1',
      externalId: 'RAPPI:722609056',
      status: 'CONFIRMED',
      orderNumber: 'R-1',
      deliveryChannelLinkId: 'link1',
    })
    ;(prisma.deliveryChannelLink.findFirst as jest.Mock).mockResolvedValue({ provider: 'RAPPI', externalLocationId: '900175625' })
    mockMarcarListoRappi.mockResolvedValue({ ok: true, status: 200, raw: '{}' })

    const r = await markDeliveryOrderReady('venue1', 'order1')

    // Antes de la Tarea 13 esto era NOT_A_DELIVERY_ORDER: Rappi declaraba `markReady` y el núcleo pregunta por `markOrderReady`.
    expect(r.outcome).toBe('READY')
    expect(mockMarcarListoRappi).toHaveBeenCalledWith('722609056', '900175625', { reintentarEn401: false })
    expect(mockTx.order.updateMany).toHaveBeenCalled()
  })

  it('tenant isolation: la venta se busca con venueId en el where', async () => {
    await markDeliveryOrderReady('venue-otro', 'order1')

    expect((prisma.order.findFirst as jest.Mock).mock.calls[0][0].where).toEqual({ id: 'order1', venueId: 'venue-otro' })
  })
})
