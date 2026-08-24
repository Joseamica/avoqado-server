/**
 * Adaptador de Rappi — los cinco métodos obligatorios del contrato directo.
 *
 * ⚠️ Escrito contra la documentación, sin sandbox. Prueban la implementación, no que hayamos
 * leído bien la especificación.
 */
import crypto from 'crypto'
import { rappiAdapter, RAPPI_EVENTS, respuestaPing } from '../../../../src/services/delivery-channels/providers/rappi/rappi.adapter'
import type { DirectDeliveryAdapter } from '../../../../src/services/delivery-channels/core/types'

describe('rappiAdapter', () => {
  // 🔴 El `satisfies` es el test: si mañana falta un método obligatorio, ESTO no compila.
  // Un contrato que nadie verifica es documentación que miente — pasó una vez con Uber, que
  // no satisfacía su propia interface y el registro tuvo que tipar con `typeof`.
  it('satisface el contrato de un proveedor DIRECTO', () => {
    const _check = rappiAdapter satisfies DirectDeliveryAdapter
    expect(_check.provider).toBe('RAPPI')
  })

  describe('classifyEvent', () => {
    // ── La traducción que evita el bug de dinero ──────────────────────────────────
    it('🔴 el programado NO es NEW_ORDER — sus montos vienen en cero por diseño', () => {
      expect(rappiAdapter.classifyEvent(RAPPI_EVENTS.NEW_ORDER_SCHEDULED)).toBe('SCHEDULED_ORDER')
      expect(rappiAdapter.classifyEvent(RAPPI_EVENTS.NEW_ORDER)).toBe('NEW_ORDER')
    })

    it('🔴 MENU_APPROVED es lo que significa "publicado" — el 200 del POST sólo dice "en revisión"', () => {
      expect(rappiAdapter.classifyEvent(RAPPI_EVENTS.MENU_APPROVED)).toBe('MENU_REFRESH')
      expect(rappiAdapter.classifyEvent(RAPPI_EVENTS.MENU_REJECTED)).toBe('MENU_REFRESH')
    })

    it.each([
      [RAPPI_EVENTS.ORDER_EVENT_CANCEL, 'CANCEL'],
      [RAPPI_EVENTS.NEW_ORDER_SCHEDULED_CANCELLED, 'CANCEL'],
      [RAPPI_EVENTS.ORDER_OTHER_EVENT, 'FULFILLMENT_CHANGED'],
      [RAPPI_EVENTS.STORE_CONNECTIVITY, 'STORE_STATE'],
      [RAPPI_EVENTS.STORE_PROVISIONING_STATUS, 'STORE_STATE'],
      [RAPPI_EVENTS.PING, 'IGNORED'],
      [RAPPI_EVENTS.ORDER_RT_TRACKING, 'IGNORED'],
    ])('%s → %s', (evento, esperado) => {
      expect(rappiAdapter.classifyEvent(evento)).toBe(esperado)
    })

    it('un evento que Rappi agregue mañana se IGNORA, no revienta', () => {
      expect(rappiAdapter.classifyEvent('EVENTO_QUE_NO_EXISTE_TODAVIA')).toBe('IGNORED')
    })
  })

  describe('extractIdentity', () => {
    it('lee el pedido anidado (order_detail + store)', () => {
      const id = rappiAdapter.extractIdentity({
        type: 'NEW_ORDER',
        order_detail: { order_id: '2150558091' },
        store: { internal_id: '900105814', external_id: 'avq-1' },
      })
      expect(id).toMatchObject({ eventType: 'NEW_ORDER', orderId: '2150558091', storeId: 'avq-1' })
    })

    // Los eventos de Rappi NO comparten forma: la cancelación manda los ids PLANOS.
    it('🔴 también lee la forma PLANA de la cancelación', () => {
      const id = rappiAdapter.extractIdentity({ event: 'canceled_with_charge', order_id: '106', store_id: '900109448' })
      expect(id).toMatchObject({ orderId: '106', storeId: '900109448' })
    })

    it('el eventId es estable: el mismo evento reenviado da la misma llave', () => {
      const p = { type: 'NEW_ORDER', order_detail: { order_id: '1' }, store: { external_id: 's1' } }
      expect(rappiAdapter.extractIdentity(p).eventId).toBe(rappiAdapter.extractIdentity(p).eventId)
    })

    it('dos pedidos distintos de la misma tienda NO colisionan', () => {
      const a = rappiAdapter.extractIdentity({ type: 'NEW_ORDER', order_detail: { order_id: '1' }, store: { external_id: 's1' } })
      const b = rappiAdapter.extractIdentity({ type: 'NEW_ORDER', order_detail: { order_id: '2' }, store: { external_id: 's1' } })
      expect(a.eventId).not.toBe(b.eventId)
    })

    it('un payload vacío no revienta: devuelve nulos', () => {
      expect(rappiAdapter.extractIdentity({})).toMatchObject({ orderId: null, storeId: null })
    })
  })

  describe('verifyWebhook', () => {
    const body = Buffer.from('{"order_id":"1"}', 'utf8')
    const firma = (secreto: string) =>
      crypto
        .createHmac('sha256', secreto)
        .update(Buffer.concat([Buffer.from('123.', 'utf8'), body]))
        .digest('hex')

    it('acepta con el header en minúsculas (como los normaliza Node)', () => {
      expect(rappiAdapter.verifyWebhook(body, { 'rappi-signature': `t=123,sign=${firma('s1')}` }, ['s1'])).toBe(true)
    })

    it('acepta cualquiera de los secretos vigentes (rotación sin cortar el servicio)', () => {
      expect(rappiAdapter.verifyWebhook(body, { 'rappi-signature': `t=123,sign=${firma('nuevo')}` }, ['viejo', 'nuevo'])).toBe(true)
    })

    it('sin secretos NUNCA acepta', () => {
      expect(rappiAdapter.verifyWebhook(body, { 'rappi-signature': `t=123,sign=${firma('s1')}` }, [])).toBe(false)
    })

    it('sin header no acepta', () => {
      expect(rappiAdapter.verifyWebhook(body, {}, ['s1'])).toBe(false)
    })
  })

  describe('orderEventTypes', () => {
    it('incluye el programado: también es un pedido que nos mandaron', () => {
      // Dejarlo fuera subestimaría cuántos pedidos recibimos y falsearía la tasa de aceptación.
      expect(rappiAdapter.orderEventTypes()).toEqual([RAPPI_EVENTS.NEW_ORDER, RAPPI_EVENTS.NEW_ORDER_SCHEDULED])
    })
  })
})

describe('respuestaPing', () => {
  // 🔴 Dos pings negativos seguidos y Rappi marca la tienda como caída.
  it('contesta el cuerpo EXACTO que Rappi espera', () => {
    expect(respuestaPing('Taquería El Sol')).toEqual({ status: 'OK', description: 'Taquería El Sol' })
  })

  it('sin nombre de tienda sigue contestando OK — la pregunta es "¿estás ahí?", no "¿cómo te llamas?"', () => {
    expect(respuestaPing(null).status).toBe('OK')
    expect(respuestaPing(undefined).description).toBeTruthy()
  })
})
