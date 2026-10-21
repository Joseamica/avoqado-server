/**
 * Procesador de eventos de Rappi — las decisiones que separan una venta de un bug.
 *
 * ⚠️ Sin sandbox: los payloads son los de la documentación, la red va inyectada.
 */
import logger from '@/config/logger'
import prisma from '../../../../src/utils/prismaClient'
import { processRappiEvent } from '../../../../src/services/delivery-channels/providers/rappi/rappi.eventProcessor'
import { cancelDeliveryOrder } from '../../../../src/services/delivery-channels/core/cancelDeliveryOrder.service'
import { ingestDeliveryOrder } from '../../../../src/services/delivery-channels/core/deliveryOrderIngestion.service'
import { markEventResult } from '../../../../src/services/delivery-channels/core/deliveryWebhookEvent.service'
import { confirmarTienda } from '../../../../src/services/delivery-channels/providers/rappi/rappi.provisioning'
import { suscribirTiendaAEventos } from '../../../../src/services/delivery-channels/providers/rappi/rappi.client'

jest.mock('../../../../src/services/delivery-channels/core/cancelDeliveryOrder.service', () => ({
  cancelDeliveryOrder: jest.fn(),
}))
jest.mock('../../../../src/services/delivery-channels/core/deliveryOrderIngestion.service', () => ({
  ingestDeliveryOrder: jest.fn(),
}))
jest.mock('../../../../src/services/delivery-channels/core/deliveryWebhookEvent.service', () => ({
  markEventResult: jest.fn(),
}))
// El cableado por defecto de `confirmar` importa perezosamente estos dos: `rappi.client` lee `env`
// al cargarse (y eso hace `process.exit` dentro de Jest).
jest.mock('../../../../src/services/delivery-channels/providers/rappi/rappi.provisioning', () => ({
  confirmarTienda: jest.fn(),
}))
jest.mock('../../../../src/services/delivery-channels/providers/rappi/rappi.client', () => ({
  suscribirTiendaAEventos: jest.fn(),
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

  it('🔴 un vínculo viejo en MANUAL: igual acepta en Rappi y la ingesta recibe el vínculo en AUTO', async () => {
    // Rappi cancela solo el pedido que no se acepta en 4–6 min, así que no hay modo manual: un vínculo
    // que haya quedado en MANUAL (de antes de la fase 2) se trata como AUTO — se acepta, y la venta entra
    // confirmada (la ingesta decide PENDING/CONFIRMED y la cocina según el modo del vínculo que recibe).
    ;(prisma.deliveryOrderEvent.findUnique as jest.Mock).mockResolvedValue(
      fila({ channelLink: { ...fila().channelLink, orderAcceptanceMode: 'MANUAL' } }),
    )

    const r = await processRappiEvent('evt1', { aceptar: aceptarOk })

    expect(aceptarOk).toHaveBeenCalledWith('392625', '900105814', 10)
    expect(mockIngest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'link1', orderAcceptanceMode: 'AUTO' }))
    expect(r).toMatchObject({ outcome: 'PROCESSED', accepted: true, orderId: 'ord1' })
  })

  it('si aceptar FALLA no se ingiere: sin el sí de Rappi el pedido no es nuestro', async () => {
    const aceptarMal = jest.fn(async () => ({ ok: false, status: 400, raw: 'invalid transition' }))

    const r = await processRappiEvent('evt1', { aceptar: aceptarMal })

    expect(r.outcome).toBe('FAILED')
    expect(mockIngest).not.toHaveBeenCalled()
    expect(mockMark).toHaveBeenCalledWith('evt1', 'FAILED', undefined, expect.stringContaining('ACCEPT_400'))
  })

  it('si aceptar LANZA, persiste FAILED en vez de dejar el evento en RECEIVED', async () => {
    const aceptarLanza = jest.fn(async () => {
      throw new Error('tienda fuera del allowlist de escritura')
    })

    const r = await processRappiEvent('evt1', { aceptar: aceptarLanza })

    expect(r).toMatchObject({ outcome: 'FAILED', accepted: false, error: expect.stringContaining('allowlist') })
    expect(mockIngest).not.toHaveBeenCalled()
    expect(mockMark).toHaveBeenCalledWith('evt1', 'FAILED', undefined, expect.stringContaining('ACCEPT:'))
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
      fila({ eventType: 'MENU_APPROVED', payload: { store_id: '900105814', message: 'Menu Approved' } }),
    )
    ;(prisma.$queryRaw as jest.Mock).mockResolvedValue([{ config: { rappiPendingMenuHash: 'abc123' } }])

    const r = await processRappiEvent('evt1', { aceptar: aceptarOk })

    expect(r.outcome).toBe('MENU_VERDICT')
    const data = (prisma.deliveryChannelLink.update as jest.Mock).mock.calls[0][0].data
    expect(data.lastMenuHash).toBe('abc123')
    expect(data.config.rappiPendingMenuHash).toBeNull()
  })

  it('MENU_REJECTED limpia la huella pendiente y NO sella nada — el menú NO está arriba', async () => {
    ;(prisma.deliveryOrderEvent.findUnique as jest.Mock).mockResolvedValue(
      fila({ eventType: 'MENU_REJECTED', payload: { store_id: '900105814' } }),
    )
    ;(prisma.$queryRaw as jest.Mock).mockResolvedValue([{ config: { rappiPendingMenuHash: 'abc123' } }])

    await processRappiEvent('evt1', { aceptar: aceptarOk })

    const data = (prisma.deliveryChannelLink.update as jest.Mock).mock.calls[0][0].data
    expect(data.lastMenuHash).toBeUndefined()
    expect(data.config.rappiPendingMenuHash).toBeNull()
  })

  // H2: la copia de `config` que trajo el evento es VIEJA. Escribirla borraba lo que otro escritor guardó
  // mientras tanto — la reclamación del aprovisionamiento con su lote, y la tienda ya no se confirmaba.
  it.each(['MENU_APPROVED', 'MENU_REJECTED'])('%s relee config con la fila BLOQUEADA y no borra rappiProvisioning', async tipo => {
    const reclamacion = { intentId: 'i1', since: 'x', batchId: 'b1' }
    ;(prisma.deliveryOrderEvent.findUnique as jest.Mock).mockResolvedValue(
      fila({
        eventType: tipo,
        payload: { store_id: '900105814' },
        channelLink: { ...fila().channelLink, config: { rappiPendingMenuHash: 'abc123' } },
      }),
    )
    ;(prisma.$queryRaw as jest.Mock).mockResolvedValue([{ config: { rappiPendingMenuHash: 'abc123', rappiProvisioning: reclamacion } }])

    await processRappiEvent('evt1', { aceptar: aceptarOk })

    const [strings, ...valores] = (prisma.$queryRaw as jest.Mock).mock.calls[0]
    expect(strings.join('?')).toMatch(/FOR UPDATE/)
    expect(valores).toEqual(['link1'])
    expect((prisma.deliveryChannelLink.update as jest.Mock).mock.calls[0][0].data.config).toEqual({
      rappiPendingMenuHash: null,
      rappiProvisioning: reclamacion,
    })
  })

  // ── El estado de la tienda ───────────────────────────────────────────────────────
  it('🔴 STORE_CONNECTIVITY enabled:false → el canal ACTIVE queda PAUSED (nada de "La Ribera" otra vez)', async () => {
    ;(prisma.deliveryOrderEvent.findUnique as jest.Mock).mockResolvedValue(
      fila({ eventType: 'STORE_CONNECTIVITY', payload: { external_store_id: '900105814', enabled: false, message: 'not enabled' } }),
    )
    ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 1 })

    await processRappiEvent('evt1', { aceptar: aceptarOk })

    expect(prisma.deliveryChannelLink.updateMany).toHaveBeenCalledWith({
      where: { id: 'link1', status: 'ACTIVE' },
      data: { status: 'PAUSED' },
    })
    expect(prisma.deliveryChannelLink.update).not.toHaveBeenCalled()
  })

  // H6: el filtro va EN el UPDATE (atómico). Un PENDING pausado se saltaba la confirmación del aprovisionamiento,
  // y un DISABLED pausado eludía el guard de pedidos (que sólo rechaza DISABLED).
  it.each(['PENDING', 'DISABLED', 'PAUSED'])(
    'enabled:false sobre un canal %s no lo toca: el filtro ACTIVE va EN el UPDATE',
    async status => {
      ;(prisma.deliveryOrderEvent.findUnique as jest.Mock).mockResolvedValue(
        fila({
          eventType: 'STORE_CONNECTIVITY',
          payload: { external_store_id: '900105814', enabled: false },
          channelLink: { ...fila().channelLink, status },
        }),
      )
      // Como la base: sin filtro de estado se escribe cualquier fila; con él, sólo la que coincide.
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockImplementation(async ({ where }: any) => ({
        count: where.status === undefined || where.status === status ? 1 : 0,
      }))

      const r = await processRappiEvent('evt1', { aceptar: aceptarOk })

      expect(r.outcome).toBe('STORE_STATE')
      expect(prisma.deliveryChannelLink.updateMany).toHaveBeenCalledWith({
        where: { id: 'link1', status: 'ACTIVE' },
        data: { status: 'PAUSED' },
      })
      expect(prisma.deliveryChannelLink.update).not.toHaveBeenCalled()
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no estaba ACTIVE'), expect.objectContaining({ status }))
      expect(logger.error).not.toHaveBeenCalled()
    },
  )

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

  // ── El aprovisionamiento: el webhook confirma cada tienda del lote ──────────────
  const loteAprovisionado = () =>
    fila({
      eventType: 'STORE_PROVISIONING_STATUS',
      channelLink: null, // el cuerpo no trae `store_id` de primer nivel: nunca hay vínculo
      payload: {
        batchId: 'lote-7',
        operation: 'PROVISION',
        results: [
          { storeId: '10', status: 'ACTIVE', integrationId: 'int-10' },
          { storeId: '11', status: 'FAILED', errorMessage: 'no' },
        ],
      },
    })

  it('🔴 STORE_PROVISIONING_STATUS confirma CADA tienda CON el batchId del lote (sin él, R7 las ignoraría todas)', async () => {
    ;(prisma.deliveryOrderEvent.findUnique as jest.Mock).mockResolvedValue(loteAprovisionado())
    // IGNORED o REMOVED no son fallos del EVENTO: ya no hay nada nuestro que confirmar.
    const confirmar = jest.fn().mockResolvedValueOnce('PROMOTED').mockResolvedValueOnce('IGNORED')

    const r = await processRappiEvent('evt1', { aceptar: aceptarOk, confirmar })

    expect(confirmar.mock.calls.map(c => c[0])).toEqual([
      { storeId: '10', status: 'ACTIVE', integrationId: 'int-10', batchId: 'lote-7', operation: 'PROVISION' },
      { storeId: '11', status: 'FAILED', errorMessage: 'no', batchId: 'lote-7', operation: 'PROVISION' },
    ])
    expect(r.outcome).toBe('STORE_STATE')
    expect(mockMark).toHaveBeenCalledWith('evt1', 'PROCESSED')
  })

  // H4: Rappi ya dijo ACTIVE pero una suscripción falló. PROCESSED dejaba el reintento en manos de que el dueño
  // recargara la página; FAILED lo reintenta la reconciliación con su backoff (confirmar es idempotente).
  it('🔴 una tienda SUBSCRIBE_FAILED deja el evento FAILED para reintentar, y las demás se confirman igual', async () => {
    ;(prisma.deliveryOrderEvent.findUnique as jest.Mock).mockResolvedValue(loteAprovisionado())
    const confirmar = jest.fn().mockResolvedValueOnce('SUBSCRIBE_FAILED').mockResolvedValueOnce('REMOVED')

    const r = await processRappiEvent('evt1', { aceptar: aceptarOk, confirmar })

    expect(confirmar).toHaveBeenCalledTimes(2)
    expect(r).toEqual({ outcome: 'FAILED', error: 'PROVISIONING_SUBSCRIBE_FAILED' })
    expect(mockMark).toHaveBeenCalledWith('evt1', 'FAILED', undefined, 'PROVISIONING_SUBSCRIBE_FAILED')
    expect(mockMark).not.toHaveBeenCalledWith('evt1', 'PROCESSED')
  })

  it('si confirmar LANZA, el evento queda FAILED para reprocesarse (confirmarTienda es idempotente)', async () => {
    ;(prisma.deliveryOrderEvent.findUnique as jest.Mock).mockResolvedValue(loteAprovisionado())
    const confirmar = jest.fn().mockRejectedValueOnce(new Error('la base se cayó'))

    const r = await processRappiEvent('evt1', { aceptar: aceptarOk, confirmar })

    expect(r).toMatchObject({ outcome: 'FAILED', error: expect.stringContaining('la base se cayó') })
    expect(mockMark).toHaveBeenCalledWith('evt1', 'FAILED', undefined, expect.stringContaining('PROVISIONING'))
    expect(mockMark).not.toHaveBeenCalledWith('evt1', 'PROCESSED')
  })

  it('🔴 si una tienda sale DEFERRED el evento queda FAILED (Rappi no lo reenvía), pero las demás se confirman igual', async () => {
    ;(prisma.deliveryOrderEvent.findUnique as jest.Mock).mockResolvedValue(loteAprovisionado())
    const confirmar = jest.fn().mockResolvedValueOnce('DEFERRED').mockResolvedValueOnce('REMOVED')

    const r = await processRappiEvent('evt1', { aceptar: aceptarOk, confirmar })

    expect(confirmar).toHaveBeenCalledTimes(2)
    expect(r).toEqual({ outcome: 'FAILED', error: 'PROVISIONING_DEFERRED' })
    expect(mockMark).toHaveBeenCalledWith('evt1', 'FAILED', undefined, 'PROVISIONING_DEFERRED')
    expect(mockMark).not.toHaveBeenCalledWith('evt1', 'PROCESSED')
  })

  it('el cableado por defecto llama a confirmarTienda con el lote y con la suscripción del cliente', async () => {
    ;(prisma.deliveryOrderEvent.findUnique as jest.Mock).mockResolvedValue(loteAprovisionado())
    ;(confirmarTienda as jest.Mock).mockResolvedValue('PROMOTED')

    await processRappiEvent('evt1', { aceptar: aceptarOk })

    expect(confirmarTienda).toHaveBeenCalledTimes(2)
    expect(confirmarTienda).toHaveBeenCalledWith(expect.objectContaining({ storeId: '10', batchId: 'lote-7' }), {
      suscribir: suscribirTiendaAEventos,
    })
  })

  // ── Un canal DESHABILITADO no toma pedidos nuevos (R10) ─────────────────────────
  it('🔴 un pedido nuevo a un canal DISABLED no se acepta ni se registra: FAILED CHANNEL_DISABLED', async () => {
    ;(prisma.deliveryOrderEvent.findUnique as jest.Mock).mockResolvedValue(
      fila({ channelLink: { ...fila().channelLink, status: 'DISABLED' } }),
    )

    const r = await processRappiEvent('evt1', { aceptar: aceptarOk })

    expect(r).toMatchObject({ outcome: 'FAILED', error: 'CHANNEL_DISABLED' })
    expect(aceptarOk).not.toHaveBeenCalled()
    expect(mockIngest).not.toHaveBeenCalled()
    expect(mockMark).toHaveBeenCalledWith('evt1', 'FAILED', undefined, 'CHANNEL_DISABLED')
  })

  it('con el canal DISABLED las cancelaciones SÍ siguen: una venta que ya existía se cancela igual', async () => {
    ;(prisma.deliveryOrderEvent.findUnique as jest.Mock).mockResolvedValue(
      fila({
        eventType: 'ORDER_EVENT_CANCEL',
        payload: { event: 'canceled_with_charge', order_id: '392625', store_id: '900105814' },
        channelLink: { ...fila().channelLink, status: 'DISABLED' },
      }),
    )

    const r = await processRappiEvent('evt1', { aceptar: aceptarOk })

    expect(mockCancel).toHaveBeenCalledWith('392625', 'RAPPI', expect.any(String))
    expect(r.outcome).toBe('CANCELLED')
  })
})
