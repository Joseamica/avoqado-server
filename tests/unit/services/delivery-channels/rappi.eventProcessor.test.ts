/**
 * Procesador de eventos de Rappi — las decisiones que separan una venta de un bug.
 *
 * ⚠️ Sin sandbox: los payloads son los de la documentación, la red va inyectada.
 */
import * as fs from 'fs'
import * as path from 'path'

import logger from '@/config/logger'
import prisma from '../../../../src/utils/prismaClient'
import { processRappiEvent, RECLAMO_RAPPI_MS } from '../../../../src/services/delivery-channels/providers/rappi/rappi.eventProcessor'
import { cancelDeliveryOrder } from '../../../../src/services/delivery-channels/core/cancelDeliveryOrder.service'
import { ingestDeliveryOrder } from '../../../../src/services/delivery-channels/core/deliveryOrderIngestion.service'
import {
  cerrarEventoReclamado,
  markEventResult,
  reclamarEvento,
  renovarReclamo,
} from '../../../../src/services/delivery-channels/core/deliveryWebhookEvent.service'
import { confirmarTienda } from '../../../../src/services/delivery-channels/providers/rappi/rappi.provisioning'
import { historialDelPedidoRappi, suscribirTiendaAEventos } from '../../../../src/services/delivery-channels/providers/rappi/rappi.client'
import { anotarAceptacion } from '../../../../src/services/delivery-channels/providers/rappi/rappi.estadoDelPedido'

jest.mock('../../../../src/services/delivery-channels/core/cancelDeliveryOrder.service', () => ({
  cancelDeliveryOrder: jest.fn(),
}))
jest.mock('../../../../src/services/delivery-channels/core/deliveryOrderIngestion.service', () => ({
  ingestDeliveryOrder: jest.fn(),
}))
jest.mock('../../../../src/services/delivery-channels/core/deliveryWebhookEvent.service', () => ({
  markEventResult: jest.fn(),
  reclamarEvento: jest.fn(),
  renovarReclamo: jest.fn(),
  cerrarEventoReclamado: jest.fn(),
}))
// El cableado por defecto de `confirmar` importa perezosamente estos dos: `rappi.client` lee `env`
// al cargarse (y eso hace `process.exit` dentro de Jest).
jest.mock('../../../../src/services/delivery-channels/providers/rappi/rappi.provisioning', () => ({
  confirmarTienda: jest.fn(),
}))
jest.mock('../../../../src/services/delivery-channels/providers/rappi/rappi.client', () => ({
  suscribirTiendaAEventos: jest.fn(),
  historialDelPedidoRappi: jest.fn(),
}))
// La marca de aceptación es un UPDATE condicionado al token (se prueba en `rappi.estadoDelPedido.test.ts` y contra Postgres);
// aquí se observa cuándo se escribe. `leerEstado` y `leerHistorial` son los reales.
jest.mock('../../../../src/services/delivery-channels/providers/rappi/rappi.estadoDelPedido', () => ({
  ...jest.requireActual('../../../../src/services/delivery-channels/providers/rappi/rappi.estadoDelPedido'),
  anotarAceptacion: jest.fn(),
}))

const mockCancel = cancelDeliveryOrder as jest.Mock
const mockIngest = ingestDeliveryOrder as jest.Mock
const mockMark = markEventResult as jest.Mock
const mockReclamar = reclamarEvento as jest.Mock
const mockRenovar = renovarReclamo as jest.Mock
const mockCerrar = cerrarEventoReclamado as jest.Mock
const mockAnotar = anotarAceptacion as jest.Mock
const mockHistorialHttp = historialDelPedidoRappi as jest.Mock

/** Los historiales REALES del sandbox DEV de Rappi (21-oct-2026, recorrido-real.md). */
const SANDBOX = path.join(__dirname, 'fixtures/rappi/sandbox')
const crudoDelSandbox = (archivo: string) => fs.readFileSync(path.join(SANDBOX, archivo), 'utf8')
const HISTORIAL_ACEPTADO = JSON.parse(crudoDelSandbox('eventos-aceptado.json')) // [taken_visible_order]
const HISTORIAL_VACIO = JSON.parse(crudoDelSandbox('eventos-vacio.json')) // []
/** La marca que deja un intento que ya vio el sí de Rappi. */
const MARCA = { aceptacion: { en: '2026-10-21T22:26:20.000Z', evidencia: 'HTTP_2XX' } }

/** El token del reclamo que este proceso obtiene en cada prueba (salvo las que simulan a otro dueño). */
const TOKEN = 'tok-1'

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
    mockReclamar.mockResolvedValue(TOKEN)
    mockRenovar.mockResolvedValue(true)
    mockCerrar.mockResolvedValue(true)
    mockAnotar.mockResolvedValue(true)
    // El cableado por defecto del historial: un pedido sin eventos del lado de Rappi.
    mockHistorialHttp.mockResolvedValue({ ok: true, status: 200, raw: '[]' })
  })

  // 🔴 Desde la Tarea 8 TODO cierre va por `cerrarEventoReclamado` con su token: `markEventResult` escribe sin
  // mirar el reclamo y podría pisar el resultado de otro dueño. Vale para cada prueba de este archivo.
  afterEach(() => {
    expect(mockMark).not.toHaveBeenCalled()
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

  it('si aceptar FALLA (un no-2xx que no es 400) no se ingiere: queda FAILED reintentable, sin leer el historial', async () => {
    const aceptarMal = jest.fn(async () => ({ ok: false, status: 500, raw: 'upstream error' }))
    const historial = jest.fn()

    const r = await processRappiEvent('evt1', { aceptar: aceptarMal, historial })

    expect(r).toMatchObject({ outcome: 'FAILED', error: 'ACCEPT_500' })
    expect(mockIngest).not.toHaveBeenCalled()
    expect(historial).not.toHaveBeenCalled()
    expect(mockAnotar).not.toHaveBeenCalled()
    expect(mockCerrar).toHaveBeenCalledWith('evt1', TOKEN, 'FAILED', undefined, expect.stringContaining('ACCEPT_500'))
  })

  it('si aceptar LANZA, persiste FAILED en vez de dejar el evento en RECEIVED', async () => {
    const aceptarLanza = jest.fn(async () => {
      throw new Error('tienda fuera del allowlist de escritura')
    })

    const r = await processRappiEvent('evt1', { aceptar: aceptarLanza })

    expect(r).toMatchObject({ outcome: 'FAILED', accepted: false, error: expect.stringContaining('allowlist') })
    expect(mockIngest).not.toHaveBeenCalled()
    expect(mockCerrar).toHaveBeenCalledWith('evt1', TOKEN, 'FAILED', undefined, expect.stringContaining('ACCEPT:'))
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
    expect(mockCerrar).toHaveBeenCalledWith('evt1', TOKEN, 'FAILED', undefined, expect.stringContaining('INGEST'))
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
    expect(mockCerrar).toHaveBeenCalledWith('evt1', TOKEN, 'PROCESSED', undefined)
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
    expect(mockCerrar).toHaveBeenCalledWith('evt1', TOKEN, 'FAILED', undefined, 'TIENDA_SIN_VINCULO')
  })

  it('un evento ya procesado NO se reprocesa (el despacho es at-least-once)', async () => {
    ;(prisma.deliveryOrderEvent.findUnique as jest.Mock).mockResolvedValue(fila({ status: 'PROCESSED', orderId: 'ord1' }))

    const r = await processRappiEvent('evt1', { aceptar: aceptarOk })

    expect(r).toMatchObject({ outcome: 'ALREADY_DONE', orderId: 'ord1' })
    expect(mockIngest).not.toHaveBeenCalled()
    // El corte de PROCESSED va ANTES del reclamo: lo terminado ni se reclama ni se vuelve a cerrar.
    expect(mockReclamar).not.toHaveBeenCalled()
    expect(mockCerrar).not.toHaveBeenCalled()
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
    expect(mockCerrar).toHaveBeenCalledWith('evt1', TOKEN, 'PROCESSED')
  })

  // H4: Rappi ya dijo ACTIVE pero una suscripción falló. PROCESSED dejaba el reintento en manos de que el dueño
  // recargara la página; FAILED lo reintenta la reconciliación con su backoff (confirmar es idempotente).
  it('🔴 una tienda SUBSCRIBE_FAILED deja el evento FAILED para reintentar, y las demás se confirman igual', async () => {
    ;(prisma.deliveryOrderEvent.findUnique as jest.Mock).mockResolvedValue(loteAprovisionado())
    const confirmar = jest.fn().mockResolvedValueOnce('SUBSCRIBE_FAILED').mockResolvedValueOnce('REMOVED')

    const r = await processRappiEvent('evt1', { aceptar: aceptarOk, confirmar })

    expect(confirmar).toHaveBeenCalledTimes(2)
    expect(r).toEqual({ outcome: 'FAILED', error: 'PROVISIONING_SUBSCRIBE_FAILED' })
    expect(mockCerrar).toHaveBeenCalledWith('evt1', TOKEN, 'FAILED', undefined, 'PROVISIONING_SUBSCRIBE_FAILED')
    expect(mockCerrar).not.toHaveBeenCalledWith('evt1', TOKEN, 'PROCESSED')
  })

  it('si confirmar LANZA, el evento queda FAILED para reprocesarse (confirmarTienda es idempotente)', async () => {
    ;(prisma.deliveryOrderEvent.findUnique as jest.Mock).mockResolvedValue(loteAprovisionado())
    const confirmar = jest.fn().mockRejectedValueOnce(new Error('la base se cayó'))

    const r = await processRappiEvent('evt1', { aceptar: aceptarOk, confirmar })

    expect(r).toMatchObject({ outcome: 'FAILED', error: expect.stringContaining('la base se cayó') })
    expect(mockCerrar).toHaveBeenCalledWith('evt1', TOKEN, 'FAILED', undefined, expect.stringContaining('PROVISIONING'))
    expect(mockCerrar).not.toHaveBeenCalledWith('evt1', TOKEN, 'PROCESSED')
  })

  it('🔴 si una tienda sale DEFERRED el evento queda FAILED (Rappi no lo reenvía), pero las demás se confirman igual', async () => {
    ;(prisma.deliveryOrderEvent.findUnique as jest.Mock).mockResolvedValue(loteAprovisionado())
    const confirmar = jest.fn().mockResolvedValueOnce('DEFERRED').mockResolvedValueOnce('REMOVED')

    const r = await processRappiEvent('evt1', { aceptar: aceptarOk, confirmar })

    expect(confirmar).toHaveBeenCalledTimes(2)
    expect(r).toEqual({ outcome: 'FAILED', error: 'PROVISIONING_DEFERRED' })
    expect(mockCerrar).toHaveBeenCalledWith('evt1', TOKEN, 'FAILED', undefined, 'PROVISIONING_DEFERRED')
    expect(mockCerrar).not.toHaveBeenCalledWith('evt1', TOKEN, 'PROCESSED')
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
    expect(mockCerrar).toHaveBeenCalledWith('evt1', TOKEN, 'FAILED', undefined, 'CHANNEL_DISABLED')
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

  // ── El reclamo: dos procesos nunca aceptan ni registran el MISMO pedido a la vez (Tarea 8) ──
  describe('el reclamo del evento', () => {
    it('reclama por 45 s justo después del corte de PROCESSED, y cierra con SU token', async () => {
      const r = await processRappiEvent('evt1', { aceptar: aceptarOk })

      expect(RECLAMO_RAPPI_MS).toBe(45_000)
      expect(mockReclamar).toHaveBeenCalledWith('evt1', 45_000)
      expect(r).toMatchObject({ outcome: 'PROCESSED', orderId: 'ord1' })
      expect(mockCerrar).toHaveBeenCalledTimes(1)
      expect(mockCerrar).toHaveBeenCalledWith('evt1', TOKEN, 'PROCESSED', 'ord1')
    })

    it('🔴 con el evento reclamado por otro (la petición viva), no acepta ni ingiere y devuelve IN_FLIGHT', async () => {
      mockReclamar.mockResolvedValueOnce(null)

      const r = await processRappiEvent('evt1', { aceptar: aceptarOk })

      expect(r).toEqual({ outcome: 'IN_FLIGHT' })
      expect(aceptarOk).not.toHaveBeenCalled()
      expect(mockIngest).not.toHaveBeenCalled()
      // Sin reclamo no hay nada que cerrar: el resultado lo escribe el dueño.
      expect(mockCerrar).not.toHaveBeenCalled()
      expect(mockRenovar).not.toHaveBeenCalled()
    })

    it('IN_FLIGHT vale para cualquier tipo de evento: una cancelación reclamada por otro no se cancela dos veces', async () => {
      ;(prisma.deliveryOrderEvent.findUnique as jest.Mock).mockResolvedValue(
        fila({ eventType: 'ORDER_EVENT_CANCEL', payload: { event: 'canceled_with_charge', order_id: '392625', store_id: '900105814' } }),
      )
      mockReclamar.mockResolvedValueOnce(null)

      const r = await processRappiEvent('evt1', { aceptar: aceptarOk })

      expect(r.outcome).toBe('IN_FLIGHT')
      expect(mockCancel).not.toHaveBeenCalled()
      expect(mockCerrar).not.toHaveBeenCalled()
    })

    it('renueva con su token antes de aceptar y antes de ingerir', async () => {
      const orden: string[] = []
      mockRenovar.mockImplementation(async (...args: unknown[]) => {
        orden.push(`renovar:${JSON.stringify(args)}`)
        return true
      })
      aceptarOk.mockImplementationOnce(async () => {
        orden.push('accept')
        return { ok: true, status: 200, raw: '{}' }
      })
      mockIngest.mockImplementationOnce(async () => {
        orden.push('ingest')
        return { order: { id: 'ord1' }, created: true, kitchenTicketCreated: true }
      })

      await processRappiEvent('evt1', { aceptar: aceptarOk })

      const renovar = `renovar:${JSON.stringify(['evt1', TOKEN, 45_000])}`
      expect(orden).toEqual([renovar, 'accept', renovar, 'ingest'])
    })

    it('🔴 si al renovar antes de ACEPTAR ve que perdió el reclamo, se detiene sin aceptar ni ingerir', async () => {
      mockRenovar.mockResolvedValue(false)

      const r = await processRappiEvent('evt1', { aceptar: aceptarOk })

      expect(r.outcome).toBe('IN_FLIGHT')
      expect(aceptarOk).not.toHaveBeenCalled()
      expect(mockIngest).not.toHaveBeenCalled()
      // Ya no es suyo: no escribe nada encima del dueño nuevo.
      expect(mockCerrar).not.toHaveBeenCalled()
    })

    it('🔴 si al renovar antes de INGERIR (ya aceptado) ve que perdió el reclamo, no ingiere ni cierra', async () => {
      // Pierde el reclamo DESPUÉS de aceptar: la renovación sólo falla cuando `aceptar` ya corrió.
      mockRenovar.mockImplementation(async () => aceptarOk.mock.calls.length === 0)

      const r = await processRappiEvent('evt1', { aceptar: aceptarOk })

      expect(aceptarOk).toHaveBeenCalledTimes(1)
      expect(mockIngest).not.toHaveBeenCalled()
      expect(mockCerrar).not.toHaveBeenCalled()
      expect(r).toMatchObject({ outcome: 'IN_FLIGHT', accepted: true })
    })

    it('un aceptar rechazado (400) renueva con su token ANTES de leer el historial (Tarea 9)', async () => {
      const orden: string[] = []
      mockRenovar.mockImplementation(async () => {
        orden.push('renovar')
        return true
      })
      const aceptarMal = jest.fn(async () => {
        orden.push('accept')
        return { ok: false, status: 400, raw: 'Invalid transition' }
      })
      const historial = jest.fn(async () => {
        orden.push('historial')
        return HISTORIAL_ACEPTADO
      })
      mockAnotar.mockImplementationOnce(async () => {
        orden.push('marca')
        return true
      })
      mockIngest.mockImplementationOnce(async () => {
        orden.push('ingest')
        return { order: { id: 'ord1' }, created: true, kitchenTicketCreated: true }
      })

      await processRappiEvent('evt1', { aceptar: aceptarMal, historial })

      expect(orden).toEqual(['renovar', 'accept', 'renovar', 'historial', 'marca', 'renovar', 'ingest'])
    })

    it('🔴 si al renovar antes de leer el historial ve que perdió el reclamo, se detiene: ni lee, ni anota, ni ingiere, ni cierra', async () => {
      // Pierde el reclamo DESPUÉS del 400: la renovación sólo falla cuando `aceptar` ya corrió.
      const aceptarMal = jest.fn(async () => ({ ok: false, status: 400, raw: 'Invalid transition' }))
      mockRenovar.mockImplementation(async () => aceptarMal.mock.calls.length === 0)
      const historial = jest.fn(async () => HISTORIAL_ACEPTADO)

      const r = await processRappiEvent('evt1', { aceptar: aceptarMal, historial })

      expect(r.outcome).toBe('IN_FLIGHT')
      expect(historial).not.toHaveBeenCalled()
      expect(mockAnotar).not.toHaveBeenCalled()
      expect(mockIngest).not.toHaveBeenCalled()
      expect(mockCerrar).not.toHaveBeenCalled()
    })

    it('si el cierre encuentra el reclamo de otro (false), no hay reintento ni escritura de respaldo', async () => {
      mockCerrar.mockResolvedValueOnce(false)

      const r = await processRappiEvent('evt1', { aceptar: aceptarOk })

      // Lo que ESTE proceso hizo sigue siendo verdad (aceptó e ingirió); el 🚨 lo da el cierre.
      expect(r).toMatchObject({ outcome: 'PROCESSED', orderId: 'ord1' })
      expect(mockCerrar).toHaveBeenCalledTimes(1)
    })
  })

  // ── Aceptado pero no guardado: la marca y la recuperación por el historial (Tarea 9) ──
  // 🔴 Nunca registrar a ciegas ni dos veces: con la marca no se vuelve a aceptar (Rappi contestaría 400); sin ella, un 400
  // sólo se registra si el historial de Rappi dice que el pedido SÍ quedó aceptado.
  describe('aceptado pero no guardado (Tarea 9)', () => {
    const filaConMarca = (over: Record<string, unknown> = {}) => fila({ resourcePayload: MARCA, ...over })
    const rechazo400 = () => jest.fn(async () => ({ ok: false, status: 400, raw: 'Invalid transition from {TAKEN} to {TAKEN}' }))

    it('🔴 tras el 2xx de aceptar, la marca queda ANTES de ingerir', async () => {
      const orden: string[] = []
      aceptarOk.mockImplementationOnce(async () => {
        orden.push('accept')
        return { ok: true, status: 200, raw: '{}' }
      })
      mockAnotar.mockImplementationOnce(async () => {
        orden.push('marca')
        return true
      })
      mockIngest.mockImplementationOnce(async () => {
        orden.push('ingest')
        return { order: { id: 'ord1' }, created: true, kitchenTicketCreated: true }
      })

      const r = await processRappiEvent('evt1', { aceptar: aceptarOk })

      expect(orden).toEqual(['accept', 'marca', 'ingest'])
      // Con SU token: si el reclamo ya no es suyo, la marca no se escribe.
      expect(mockAnotar).toHaveBeenCalledWith('evt1', TOKEN, 'HTTP_2XX')
      expect(r).toMatchObject({ outcome: 'PROCESSED', accepted: true, orderId: 'ord1' })
    })

    it('🔴 reintento con marca: NO vuelve a aceptar e ingiere', async () => {
      ;(prisma.deliveryOrderEvent.findUnique as jest.Mock).mockResolvedValue(
        filaConMarca({ status: 'FAILED', error: 'INGEST: la base se cayó' }),
      )
      const historial = jest.fn()

      const r = await processRappiEvent('evt1', { aceptar: aceptarOk, historial })

      expect(aceptarOk).not.toHaveBeenCalled()
      expect(historial).not.toHaveBeenCalled()
      expect(mockAnotar).not.toHaveBeenCalled()
      expect(mockIngest).toHaveBeenCalledTimes(1)
      expect(r).toMatchObject({ outcome: 'PROCESSED', accepted: true, orderId: 'ord1' })
      expect(mockCerrar).toHaveBeenCalledWith('evt1', TOKEN, 'PROCESSED', 'ord1')
    })

    it('🔴 la fila se relee DESPUÉS del reclamo: la marca que acaba de dejar el dueño anterior se ve y no se vuelve a aceptar', async () => {
      // La primera lectura (antes de reclamar) es vieja: no trae la marca. El dueño anterior aceptó, escribió la marca y se le
      // venció el reclamo antes de ingerir; este proceso lo reclamó después. Decidir con la lectura vieja volvería a aceptar.
      const findUnique = prisma.deliveryOrderEvent.findUnique as jest.Mock
      findUnique.mockReset().mockResolvedValueOnce(fila()).mockResolvedValueOnce(filaConMarca())

      const r = await processRappiEvent('evt1', { aceptar: aceptarOk })

      expect(findUnique).toHaveBeenCalledTimes(2)
      // La lectura con la que se decide va DESPUÉS del reclamo.
      expect(findUnique.mock.invocationCallOrder[1]).toBeGreaterThan(mockReclamar.mock.invocationCallOrder[0])
      expect(aceptarOk).not.toHaveBeenCalled()
      expect(mockAnotar).not.toHaveBeenCalled()
      expect(mockIngest).toHaveBeenCalledTimes(1)
      expect(r).toMatchObject({ outcome: 'PROCESSED', orderId: 'ord1' })
    })

    it('🔴 muere entre el 2xx y la marca: el reintento recibe 400 y el historial con taken_visible_order lo registra una vez', async () => {
      // 1.er intento: Rappi dice que sí y el proceso muere antes de escribir la marca (aquí, la escritura revienta).
      mockAnotar.mockRejectedValueOnce(new Error('el proceso murió'))
      const primero = await processRappiEvent('evt1', { aceptar: aceptarOk })
      expect(primero).toMatchObject({ outcome: 'FAILED', accepted: true })
      expect(mockIngest).not.toHaveBeenCalled()

      // El reintento: la fila sigue SIN marca. Rappi ya lo tiene TAKEN y contesta 400; su historial dice que sí se aceptó.
      const aceptarDeNuevo = rechazo400()
      const historial = jest.fn(async () => HISTORIAL_ACEPTADO)
      const segundo = await processRappiEvent('evt1', { aceptar: aceptarDeNuevo, historial })

      expect(historial).toHaveBeenCalledWith('392625')
      expect(mockAnotar).toHaveBeenLastCalledWith('evt1', TOKEN, 'HISTORIAL_TAKEN')
      expect(mockIngest).toHaveBeenCalledTimes(1) // UNA venta, no dos
      expect(segundo).toMatchObject({ outcome: 'PROCESSED', accepted: true, orderId: 'ord1' })
    })

    it('400 y el historial con cancelación ⇒ PEDIDO_YA_NO_ACTIVO, sin ingerir', async () => {
      const historial = jest.fn(async () => [{ event: 'canceled_with_charge' }, { event: 'taken_visible_order' }])

      const r = await processRappiEvent('evt1', { aceptar: rechazo400(), historial })

      expect(r).toMatchObject({ outcome: 'FAILED', error: 'PEDIDO_YA_NO_ACTIVO' })
      expect(mockAnotar).not.toHaveBeenCalled()
      expect(mockIngest).not.toHaveBeenCalled()
      // El código EXACTO en `error`: es lo que la reconciliación reconoce como terminal.
      expect(mockCerrar).toHaveBeenCalledWith('evt1', TOKEN, 'FAILED', undefined, 'PEDIDO_YA_NO_ACTIVO')
    })

    it.each([
      ['vacío (Rappi no tiene eventos del pedido)', async () => HISTORIAL_VACIO],
      ['caído (no se pudo leer: null)', async () => null],
      ['que lanza (red)', async () => Promise.reject(new Error('ETIMEDOUT'))],
      ['sin aceptación ni cierre', async () => [{ event: 'courier_assigned' }]],
    ])('400 y el historial %s ⇒ ACEPTACION_INCIERTA con 🚨, sin ingerir', async (_caso, leer) => {
      const r = await processRappiEvent('evt1', { aceptar: rechazo400(), historial: jest.fn(leer) })

      expect(r).toMatchObject({ outcome: 'FAILED', error: 'ACEPTACION_INCIERTA' })
      expect(mockAnotar).not.toHaveBeenCalled()
      expect(mockIngest).not.toHaveBeenCalled()
      expect(mockCerrar).toHaveBeenCalledWith('evt1', TOKEN, 'FAILED', undefined, 'ACEPTACION_INCIERTA')
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('🚨'), expect.objectContaining({ eventRowId: 'evt1' }))
    })

    it('🔴 si la marca no se puede escribir porque el reclamo ya no es suyo, se detiene sin ingerir ni cerrar', async () => {
      mockAnotar.mockResolvedValueOnce(false)

      const r = await processRappiEvent('evt1', { aceptar: aceptarOk })

      expect(r).toMatchObject({ outcome: 'IN_FLIGHT', accepted: true })
      expect(mockIngest).not.toHaveBeenCalled()
      expect(mockCerrar).not.toHaveBeenCalled()
    })

    it('lo mismo tras el historial: si la marca HISTORIAL_TAKEN no aplica, IN_FLIGHT sin ingerir', async () => {
      mockAnotar.mockResolvedValueOnce(false)

      const r = await processRappiEvent('evt1', { aceptar: rechazo400(), historial: jest.fn(async () => HISTORIAL_ACEPTADO) })

      expect(r).toMatchObject({ outcome: 'IN_FLIGHT', accepted: true })
      expect(mockIngest).not.toHaveBeenCalled()
      expect(mockCerrar).not.toHaveBeenCalled()
    })

    it('el cableado por defecto lee el historial con historialDelPedidoRappi (una lectura, el id del pedido) y lo entiende', async () => {
      mockHistorialHttp.mockResolvedValue({ ok: true, status: 200, raw: crudoDelSandbox('eventos-aceptado.json') })

      const r = await processRappiEvent('evt1', { aceptar: rechazo400() })

      expect(mockHistorialHttp).toHaveBeenCalledTimes(1)
      expect(mockHistorialHttp).toHaveBeenCalledWith('392625')
      expect(mockAnotar).toHaveBeenCalledWith('evt1', TOKEN, 'HISTORIAL_TAKEN')
      expect(r).toMatchObject({ outcome: 'PROCESSED', orderId: 'ord1' })
    })

    it('el cableado por defecto: un status distinto de 2xx del historial es «no se pudo leer» ⇒ ACEPTACION_INCIERTA', async () => {
      mockHistorialHttp.mockResolvedValue({ ok: false, status: 503, raw: '' })

      const r = await processRappiEvent('evt1', { aceptar: rechazo400() })

      expect(r).toMatchObject({ outcome: 'FAILED', error: 'ACEPTACION_INCIERTA' })
      expect(mockIngest).not.toHaveBeenCalled()
    })

    // ── El canal DESHABILITADO ─────────────────────────────────────────────────────────
    const deshabilitado = (over: Record<string, unknown> = {}) =>
      fila({ channelLink: { ...fila().channelLink, status: 'DISABLED' }, ...over })

    it('🔴 canal deshabilitado con la marca puesta: se registra igual (Rappi ya lo aceptó) y grita', async () => {
      ;(prisma.deliveryOrderEvent.findUnique as jest.Mock).mockResolvedValue(deshabilitado({ resourcePayload: MARCA }))
      const historial = jest.fn()

      const r = await processRappiEvent('evt1', { aceptar: aceptarOk, historial })

      expect(aceptarOk).not.toHaveBeenCalled()
      expect(historial).not.toHaveBeenCalled()
      expect(mockIngest).toHaveBeenCalledTimes(1)
      expect(r).toMatchObject({ outcome: 'PROCESSED', orderId: 'ord1', accepted: true })
      expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/🚨.*DESHABILITADO/), expect.objectContaining({ eventRowId: 'evt1' }))
    })

    it('🔴 canal deshabilitado sin marca pero con taken en el historial: se anota, se registra (sin aceptar otra vez) y grita', async () => {
      ;(prisma.deliveryOrderEvent.findUnique as jest.Mock).mockResolvedValue(deshabilitado())
      const historial = jest.fn(async () => HISTORIAL_ACEPTADO)

      const r = await processRappiEvent('evt1', { aceptar: aceptarOk, historial })

      expect(historial).toHaveBeenCalledTimes(1) // UNA lectura
      expect(aceptarOk).not.toHaveBeenCalled()
      expect(mockAnotar).toHaveBeenCalledWith('evt1', TOKEN, 'HISTORIAL_TAKEN')
      expect(mockIngest).toHaveBeenCalledTimes(1)
      expect(r).toMatchObject({ outcome: 'PROCESSED', orderId: 'ord1', accepted: true })
      expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/🚨.*DESHABILITADO/), expect.anything())
    })

    it.each([
      ['vacío', async () => HISTORIAL_VACIO],
      ['caído', async () => null],
      ['con cancelación', async () => [{ event: 'canceled_by_timeout' }, { event: 'taken_visible_order' }]],
    ])('canal deshabilitado sin marca y sin taken vigente en el historial (%s) ⇒ CHANNEL_DISABLED', async (_caso, leer) => {
      ;(prisma.deliveryOrderEvent.findUnique as jest.Mock).mockResolvedValue(deshabilitado())
      const historial = jest.fn(leer)

      const r = await processRappiEvent('evt1', { aceptar: aceptarOk, historial })

      expect(historial).toHaveBeenCalledTimes(1)
      expect(r).toMatchObject({ outcome: 'FAILED', error: 'CHANNEL_DISABLED' })
      expect(aceptarOk).not.toHaveBeenCalled()
      expect(mockAnotar).not.toHaveBeenCalled()
      expect(mockIngest).not.toHaveBeenCalled()
      expect(mockCerrar).toHaveBeenCalledWith('evt1', TOKEN, 'FAILED', undefined, 'CHANNEL_DISABLED')
    })

    it('canal deshabilitado: renueva el reclamo antes de leer el historial, y si lo perdió no lee ni cierra', async () => {
      ;(prisma.deliveryOrderEvent.findUnique as jest.Mock).mockResolvedValue(deshabilitado())
      mockRenovar.mockResolvedValue(false)
      const historial = jest.fn(async () => HISTORIAL_ACEPTADO)

      const r = await processRappiEvent('evt1', { aceptar: aceptarOk, historial })

      expect(mockRenovar).toHaveBeenCalledWith('evt1', TOKEN, 45_000)
      expect(historial).not.toHaveBeenCalled()
      expect(r.outcome).toBe('IN_FLIGHT')
      expect(mockCerrar).not.toHaveBeenCalled()
    })
  })
})
