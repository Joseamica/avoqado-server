/**
 * Procesador de eventos de Rappi — las decisiones que separan una venta de un bug.
 *
 * ⚠️ Sin sandbox: los payloads son los de la documentación, la red va inyectada.
 */
import prisma from '../../../../src/utils/prismaClient'
import { processRappiEvent } from '../../../../src/services/delivery-channels/providers/rappi/rappi.eventProcessor'
import { cancelDeliveryOrder } from '../../../../src/services/delivery-channels/core/cancelDeliveryOrder.service'
import { ingestDeliveryOrder } from '../../../../src/services/delivery-channels/core/deliveryOrderIngestion.service'
import { markEventResult } from '../../../../src/services/delivery-channels/core/deliveryWebhookEvent.service'

jest.mock('../../../../src/services/delivery-channels/core/cancelDeliveryOrder.service', () => ({
  cancelDeliveryOrder: jest.fn(),
}))
jest.mock('../../../../src/services/delivery-channels/core/deliveryOrderIngestion.service', () => ({
  ingestDeliveryOrder: jest.fn(),
}))
jest.mock('../../../../src/services/delivery-channels/core/deliveryWebhookEvent.service', () => ({
  markEventResult: jest.fn(),
}))

const mockCancel = cancelDeliveryOrder as jest.Mock
const mockIngest = ingestDeliveryOrder as jest.Mock
const mockMark = markEventResult as jest.Mock

/** Un pedido completo, con los montos que el ejemplo del portal deja en cero ya rellenos. */
function payloadPedido(over: Record<string, unknown> = {}) {
  return {
    order_detail: {
      order_id: '392625',
      created_at: '2026-04-10T11:12:57.000Z',
      cooking_time: 10,
      min_cooking_time: 5,
      max_cooking_time: 20,
      totals: { total_products_with_discount: 100, other_totals: { tip: 0 } },
      items: [{ id: '1', sku: 'TACO', name: 'Taco', price: 25, quantity: 4 }],
      ...over,
    },
    store: { internal_id: '900105814', external_id: '900105814' },
  }
}

function fila(over: Record<string, unknown> = {}) {
  return {
    id: 'evt1',
    status: 'RECEIVED',
    eventType: 'NEW_ORDER',
    orderId: null,
    venueId: 'v1',
    payload: payloadPedido(),
    channelLink: {
      id: 'link1',
      venueId: 'v1',
      externalLocationId: '900105814',
      orderAcceptanceMode: 'AUTO',
      config: null,
    },
    ...over,
  }
}

describe('processRappiEvent', () => {
  const aceptarOk = jest.fn(async () => ({ ok: true, status: 200, raw: '{}' }))

  beforeEach(() => {
    jest.clearAllMocks()
    ;(prisma.deliveryOrderEvent.findUnique as jest.Mock).mockResolvedValue(fila())
    mockIngest.mockResolvedValue({ order: { id: 'ord1' }, created: true, kitchenTicketCreated: true })
    mockCancel.mockResolvedValue({ outcome: 'CANCELLED', orderId: 'ord1' })
  })

  // ── El reloj de 4–6 minutos: aceptar PRIMERO ─────────────────────────────────────
  it('🔴 en AUTO acepta ANTES de ingerir, con el cookingTime que el propio pedido sugiere', async () => {
    const orden: string[] = []
    aceptarOk.mockImplementationOnce(async () => {
      orden.push('accept')
      return { ok: true, status: 200, raw: '{}' }
    })
    mockIngest.mockImplementationOnce(async () => {
      orden.push('ingest')
      return { order: { id: 'ord1' }, created: true, kitchenTicketCreated: true }
    })

    const r = await processRappiEvent('evt1', { aceptar: aceptarOk })

    expect(r).toMatchObject({ outcome: 'PROCESSED', accepted: true, orderId: 'ord1' })
    expect(orden).toEqual(['accept', 'ingest'])
    // El tiempo declarado es el que RAPPI mandó en el pedido (10), no un invento nuestro.
    expect(aceptarOk).toHaveBeenCalledWith('392625', '900105814', 10)
  })

  it('en MANUAL NO acepta: la cocina decide desde el POS y la venta entra igual', async () => {
    ;(prisma.deliveryOrderEvent.findUnique as jest.Mock).mockResolvedValue(
      fila({ channelLink: { ...fila().channelLink, orderAcceptanceMode: 'MANUAL' } }),
    )

    const r = await processRappiEvent('evt1', { aceptar: aceptarOk })

    expect(aceptarOk).not.toHaveBeenCalled()
    expect(mockIngest).toHaveBeenCalled()
    expect(r).toMatchObject({ outcome: 'PROCESSED', accepted: false })
  })

  it('si aceptar FALLA no se ingiere: sin el sí de Rappi el pedido no es nuestro', async () => {
    const aceptarMal = jest.fn(async () => ({ ok: false, status: 400, raw: 'invalid transition' }))

    const r = await processRappiEvent('evt1', { aceptar: aceptarMal })

    expect(r.outcome).toBe('FAILED')
    expect(mockIngest).not.toHaveBeenCalled()
    expect(mockMark).toHaveBeenCalledWith('evt1', 'FAILED', undefined, expect.stringContaining('ACCEPT_400'))
  })

  // ── La red de dinero manda sobre el reloj ────────────────────────────────────────
  it('🔴 si el dinero NO CUADRA no se acepta NADA — un pedido que no podemos registrar no se toma', async () => {
    const descuadrado = payloadPedido({ totals: { total_products_with_discount: 99999, other_totals: { tip: 0 } } })
    ;(prisma.deliveryOrderEvent.findUnique as jest.Mock).mockResolvedValue(fila({ payload: descuadrado }))

    const r = await processRappiEvent('evt1', { aceptar: aceptarOk })

    expect(r.outcome).toBe('FAILED')
    expect(aceptarOk).not.toHaveBeenCalled()
    expect(mockIngest).not.toHaveBeenCalled()
  })

  it('🔴 aceptado pero la ingesta truena → FAILED VISIBLE, jamás silencio (hay dinero comprometido)', async () => {
    mockIngest.mockRejectedValueOnce(new Error('la base se cayó'))

    const r = await processRappiEvent('evt1', { aceptar: aceptarOk })

    expect(r).toMatchObject({ outcome: 'FAILED', accepted: true })
    expect(mockMark).toHaveBeenCalledWith('evt1', 'FAILED', undefined, expect.stringContaining('INGEST'))
  })

  // ── El programado NO es una venta ────────────────────────────────────────────────
  it('🔴 un PROGRAMADO se anota y NO se ingiere: sus montos vienen en cero por diseño', async () => {
    ;(prisma.deliveryOrderEvent.findUnique as jest.Mock).mockResolvedValue(fila({ eventType: 'NEW_ORDER_SCHEDULED' }))

    const r = await processRappiEvent('evt1', { aceptar: aceptarOk })

    expect(r.outcome).toBe('SCHEDULED_NOTED')
    expect(mockIngest).not.toHaveBeenCalled()
    expect(aceptarOk).not.toHaveBeenCalled()
  })

  it('cancelar un programado que nunca fue venta NO es error (ORDER_NOT_FOUND es lo normal)', async () => {
    ;(prisma.deliveryOrderEvent.findUnique as jest.Mock).mockResolvedValue(
      fila({ eventType: 'NEW_ORDER_SCHEDULED_CANCELLED', payload: { order_id: '392625', store_id: '900105814' } }),
    )
    mockCancel.mockResolvedValueOnce({ outcome: 'ORDER_NOT_FOUND' })

    const r = await processRappiEvent('evt1', { aceptar: aceptarOk })

    expect(r.outcome).toBe('CANCELLED')
    expect(mockMark).toHaveBeenCalledWith('evt1', 'PROCESSED', undefined)
  })

  it('ORDER_EVENT_CANCEL cancela la venta y saca el pedido de cocina', async () => {
    ;(prisma.deliveryOrderEvent.findUnique as jest.Mock).mockResolvedValue(
      fila({ eventType: 'ORDER_EVENT_CANCEL', payload: { event: 'canceled_with_charge', order_id: '392625', store_id: '900105814' } }),
    )

    const r = await processRappiEvent('evt1', { aceptar: aceptarOk })

    expect(mockCancel).toHaveBeenCalledWith('392625', 'RAPPI', expect.any(String))
    expect(r).toMatchObject({ outcome: 'CANCELLED', orderId: 'ord1' })
  })

  // ── El veredicto del menú ────────────────────────────────────────────────────────
  it('🔴 MENU_APPROVED sella la huella pendiente — AHÍ es cuando el menú está publicado', async () => {
    ;(prisma.deliveryOrderEvent.findUnique as jest.Mock).mockResolvedValue(
      fila({
        eventType: 'MENU_APPROVED',
        payload: { store_id: '900105814', message: 'Menu Approved' },
        channelLink: { ...fila().channelLink, config: { rappiPendingMenuHash: 'abc123' } },
      }),
    )

    const r = await processRappiEvent('evt1', { aceptar: aceptarOk })

    expect(r.outcome).toBe('MENU_VERDICT')
    const data = (prisma.deliveryChannelLink.update as jest.Mock).mock.calls[0][0].data
    expect(data.lastMenuHash).toBe('abc123')
    expect(data.config.rappiPendingMenuHash).toBeNull()
  })

  it('MENU_REJECTED limpia la huella pendiente y NO sella nada — el menú NO está arriba', async () => {
    ;(prisma.deliveryOrderEvent.findUnique as jest.Mock).mockResolvedValue(
      fila({
        eventType: 'MENU_REJECTED',
        payload: { store_id: '900105814' },
        channelLink: { ...fila().channelLink, config: { rappiPendingMenuHash: 'abc123' } },
      }),
    )

    await processRappiEvent('evt1', { aceptar: aceptarOk })

    const data = (prisma.deliveryChannelLink.update as jest.Mock).mock.calls[0][0].data
    expect(data.lastMenuHash).toBeUndefined()
    expect(data.config.rappiPendingMenuHash).toBeNull()
  })

  // ── El estado de la tienda ───────────────────────────────────────────────────────
  it('🔴 STORE_CONNECTIVITY enabled:false → el canal queda PAUSED (nada de "La Ribera" otra vez)', async () => {
    ;(prisma.deliveryOrderEvent.findUnique as jest.Mock).mockResolvedValue(
      fila({ eventType: 'STORE_CONNECTIVITY', payload: { external_store_id: '900105814', enabled: false, message: 'not enabled' } }),
    )

    await processRappiEvent('evt1', { aceptar: aceptarOk })

    expect(prisma.deliveryChannelLink.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'PAUSED' } }))
  })

  it('enabled:true NO reactiva solo — podría reabrir la tienda que el dueño pausó a propósito', async () => {
    ;(prisma.deliveryOrderEvent.findUnique as jest.Mock).mockResolvedValue(
      fila({ eventType: 'STORE_CONNECTIVITY', payload: { external_store_id: '900105814', enabled: true } }),
    )

    await processRappiEvent('evt1', { aceptar: aceptarOk })

    expect(prisma.deliveryChannelLink.update).not.toHaveBeenCalled()
  })

  // ── Los bordes ───────────────────────────────────────────────────────────────────
  it('un pedido de una tienda SIN vincular queda FAILED y VISIBLE — hay comida de alguien ahí', async () => {
    ;(prisma.deliveryOrderEvent.findUnique as jest.Mock).mockResolvedValue(fila({ channelLink: null }))

    const r = await processRappiEvent('evt1', { aceptar: aceptarOk })

    expect(r.outcome).toBe('ORPHANED')
    expect(mockMark).toHaveBeenCalledWith('evt1', 'FAILED', undefined, 'TIENDA_SIN_VINCULO')
  })

  it('un evento ya procesado NO se reprocesa (el despacho es at-least-once)', async () => {
    ;(prisma.deliveryOrderEvent.findUnique as jest.Mock).mockResolvedValue(fila({ status: 'PROCESSED', orderId: 'ord1' }))

    const r = await processRappiEvent('evt1', { aceptar: aceptarOk })

    expect(r).toMatchObject({ outcome: 'ALREADY_DONE', orderId: 'ord1' })
    expect(mockIngest).not.toHaveBeenCalled()
  })

  it('los eventos del REPARTIDOR (ORDER_OTHER_EVENT) son informativos: cero mutación', async () => {
    ;(prisma.deliveryOrderEvent.findUnique as jest.Mock).mockResolvedValue(
      fila({ eventType: 'ORDER_OTHER_EVENT', payload: { event: 'taken_visible_order', order_id: '392625', store_id: '900105814' } }),
    )

    const r = await processRappiEvent('evt1', { aceptar: aceptarOk })

    expect(r.outcome).toBe('NOT_AN_ORDER')
    expect(mockIngest).not.toHaveBeenCalled()
    expect(mockCancel).not.toHaveBeenCalled()
  })
})
