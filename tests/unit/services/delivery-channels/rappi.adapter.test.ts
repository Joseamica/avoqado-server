/**
 * Adaptador de Rappi — los cinco métodos obligatorios del contrato directo.
 *
 * ⚠️ Escrito contra la documentación, sin sandbox. Prueban la implementación, no que hayamos
 * leído bien la especificación.
 */
import crypto from 'crypto'
import { rappiAdapter, RAPPI_EVENTS, respuestaPing } from '../../../../src/services/delivery-channels/providers/rappi/rappi.adapter'
import { DeliveryWriteNotSentError, type DirectDeliveryAdapter } from '../../../../src/services/delivery-channels/core/types'

// Tarea 13: el «listo» sale por `rappi.client` (que lee el env: aquí, de mentira) y cuenta sus llamadas en la base con
// `rappi.estadoDelPedido` (aquí se simulan la reserva y el cierre; `esTransicionInvalida` es la real). La base de verdad se
// prueba en tests/integration/delivery-channels/rappiTopeDeListo.test.ts.
const mockMarcarListoRappi = jest.fn()
const mockPublicarMenuRappi = jest.fn()
jest.mock('../../../../src/services/delivery-channels/providers/rappi/rappi.client', () => ({
  marcarListoRappi: (...a: unknown[]) => mockMarcarListoRappi(...a),
  publicarMenuRappi: (...a: unknown[]) => mockPublicarMenuRappi(...a),
}))
const mockReservar = jest.fn()
const mockCerrar = jest.fn()
const mockDevolver = jest.fn()
jest.mock('../../../../src/services/delivery-channels/providers/rappi/rappi.estadoDelPedido', () => ({
  ...jest.requireActual('../../../../src/services/delivery-channels/providers/rappi/rappi.estadoDelPedido'),
  reservarLlamadaDeListo: (...a: unknown[]) => mockReservar(...a),
  cerrarListo: (...a: unknown[]) => mockCerrar(...a),
  devolverLlamadaDeListo: (...a: unknown[]) => mockDevolver(...a),
}))

/** El cuerpo REAL del 424 del sandbox DEV (M4, recorrido-real.md, 21-oct): Rappi dice «inténtelo más tarde». */
const CUERPO_424_REAL =
  '{"message":"424 {\\"code\\":\\"error.ready_for_pickup.unsuccessful\\",\\"message\\":\\"No se pudo procesar su solicitud, por favor intentelo mas tarde.\\"}"}'
/** El texto REAL de «transición inválida» de Rappi (M11, 21-oct, al rechazar un pedido TOMADO). */
const TRANSICION_INVALIDA_REAL =
  '[ORDER 722609056] Invalid transition from {TAKEN} to {REJECTED} state, check out https://dev-portal.rappi.com/managing-user-orders/#order-status for further details'

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

describe('rappiAdapter.markOrderReady — el «listo», a lo más 3 llamadas por pedido', () => {
  beforeEach(() => {
    mockReservar.mockReset().mockResolvedValue({ permitido: true })
    mockCerrar.mockReset().mockResolvedValue(undefined)
    mockDevolver.mockReset().mockResolvedValue(undefined)
    mockMarcarListoRappi.mockReset().mockResolvedValue({ ok: true, status: 200, raw: '{}' })
  })

  it('🔴 el "listo" de Rappi va por markOrderReady (el núcleo nunca llamaba a markReady)', () => {
    // El núcleo pregunta `typeof adapter.markOrderReady === 'function'`; con el nombre viejo, Rappi nunca recibía el «listo».
    expect(typeof rappiAdapter.markOrderReady).toBe('function')
    expect('markReady' in rappiAdapter).toBe(false)
  })

  it('🔴 la llamada se reserva (y se cuenta) ANTES de salir a la red, con el pedido y la tienda', async () => {
    await rappiAdapter.markOrderReady('722609056', '900175625')

    expect(mockReservar).toHaveBeenCalledWith('722609056', '900175625')
    expect(mockReservar.mock.invocationCallOrder[0]).toBeLessThan(mockMarcarListoRappi.mock.invocationCallOrder[0])
  })

  it('🔴 un 401 del "listo" no se reintenta por dentro: cada reserva es una sola llamada HTTP', async () => {
    mockMarcarListoRappi.mockResolvedValue({ ok: false, status: 401, raw: 'expired' })

    const r = await rappiAdapter.markOrderReady('722609056', '900175625')

    expect(mockMarcarListoRappi).toHaveBeenCalledTimes(1)
    expect(mockMarcarListoRappi).toHaveBeenCalledWith('722609056', '900175625', { reintentarEn401: false })
    // El 401 se devuelve tal cual: ya contó, no es terminal y no cierra.
    expect(r).toEqual({ ok: false, status: 401, raw: 'expired' })
    expect(mockCerrar).not.toHaveBeenCalled()
  })

  it('🔴 sin permiso (ya hubo 3, o ya cerró): NO sale a la red, cierra con TOPE y devuelve terminal', async () => {
    mockReservar.mockResolvedValue({ permitido: false })

    const r = await rappiAdapter.markOrderReady('722609056', '900175625')

    expect(mockMarcarListoRappi).not.toHaveBeenCalled()
    expect(r).toEqual({ ok: false, status: 0, raw: 'TOPE_DE_LISTO', terminal: true })
    expect(mockCerrar).toHaveBeenCalledWith('722609056', '900175625', 'TOPE')
  })

  it('🔴 sin el aviso del pedido (no hay dónde contar): NO sale a la red, no cierra nada y devuelve terminal (Codex b1 #4)', async () => {
    mockReservar.mockResolvedValue({ permitido: false, sinAviso: true })

    const r = await rappiAdapter.markOrderReady('722609056', '900175625')

    expect(mockMarcarListoRappi).not.toHaveBeenCalled()
    // Terminal: el núcleo devuelve NO_REINTENTAR y el barrido espera su ventana completa, sin gastar llamadas.
    expect(r).toEqual({ ok: false, status: 0, raw: 'LISTO_SIN_AVISO', terminal: true })
    // No hay fila que cerrar: otra búsqueda sólo repetiría la que acaba de fallar.
    expect(mockCerrar).not.toHaveBeenCalled()
  })

  it('2xx ⇒ cierra con HTTP_2XX y devuelve la respuesta tal cual (no terminal)', async () => {
    const r = await rappiAdapter.markOrderReady('722609056', '900175625')

    expect(r).toEqual({ ok: true, status: 200, raw: '{}' })
    expect(mockCerrar).toHaveBeenCalledWith('722609056', '900175625', 'HTTP_2XX')
  })

  it('400 de transición inválida ⇒ terminal y no se repite (cierra con TRANSICION_INVALIDA)', async () => {
    const raw = JSON.stringify({ message: TRANSICION_INVALIDA_REAL })
    mockMarcarListoRappi.mockResolvedValue({ ok: false, status: 400, raw })

    const r = await rappiAdapter.markOrderReady('722609056', '900175625')

    expect(r).toEqual({ ok: false, status: 400, raw, terminal: true })
    expect(mockCerrar).toHaveBeenCalledWith('722609056', '900175625', 'TRANSICION_INVALIDA')
  })

  it('🔴 un 424 de Rappi (cuerpo REAL del sandbox) no cierra el «listo» y sí consume una de las 3', async () => {
    mockMarcarListoRappi.mockResolvedValue({ ok: false, status: 424, raw: CUERPO_424_REAL })

    const r = await rappiAdapter.markOrderReady('722609056', '900175625')

    expect(mockReservar).toHaveBeenCalledTimes(1) // la reserva ya sumó 1 antes de llamar
    expect(r).toEqual({ ok: false, status: 424, raw: CUERPO_424_REAL })
    expect(r.terminal).toBeUndefined()
    expect(mockCerrar).not.toHaveBeenCalled()
  })

  it.each([
    ['un 400 que NO es transición inválida', 400, '{"message":"cookingTime out of range"}'],
    ['un 500', 500, 'boom'],
  ])('%s se devuelve tal cual: cuenta como llamada, no es terminal y no cierra', async (_caso, status, raw) => {
    mockMarcarListoRappi.mockResolvedValue({ ok: false, status, raw })

    const r = await rappiAdapter.markOrderReady('722609056', '900175625')

    expect(r).toEqual({ ok: false, status, raw })
    expect(mockCerrar).not.toHaveBeenCalled()
  })

  it('si la reserva no se puede escribir (la base falla), el «listo» NO sale: sin contar no se llama', async () => {
    mockReservar.mockRejectedValue(new Error('P1001'))

    await expect(rappiAdapter.markOrderReady('722609056', '900175625')).rejects.toThrow('P1001')
    expect(mockMarcarListoRappi).not.toHaveBeenCalled()
  })

  describe('la llamada NO salió (candado de tiendas): no gasta una de las 3', () => {
    const bloqueo = () =>
      new DeliveryWriteNotSentError(
        'STORE_NOT_AUTHORIZED',
        '[Rappi] escritura BLOQUEADA para la tienda 900175625',
        'Rappi todavía no está habilitada',
      )

    it('🔴 devuelve la reserva (con el pedido y la tienda) y relanza el MISMO error; no cierra el «listo»', async () => {
      const error = bloqueo()
      mockMarcarListoRappi.mockRejectedValue(error)

      await expect(rappiAdapter.markOrderReady('722609056', '900175625')).rejects.toBe(error)

      expect(mockReservar).toHaveBeenCalledTimes(1) // sumó 1 antes de llamar…
      expect(mockDevolver).toHaveBeenCalledTimes(1) // …y se devuelve: la llamada nunca salió
      expect(mockDevolver).toHaveBeenCalledWith('722609056', '900175625')
      expect(mockReservar.mock.invocationCallOrder[0]).toBeLessThan(mockDevolver.mock.invocationCallOrder[0])
      expect(mockCerrar).not.toHaveBeenCalled()
    })

    it('🔴 si devolver la reserva falla, el error ORIGINAL se relanza igual (la reserva se queda: el tope sigue protegiendo)', async () => {
      const error = bloqueo()
      mockMarcarListoRappi.mockRejectedValue(error)
      mockDevolver.mockRejectedValue(new Error('P1001'))

      await expect(rappiAdapter.markOrderReady('722609056', '900175625')).rejects.toBe(error)
    })

    it('🔴 un error que NO es «no se envió» (red a medias: la llamada pudo salir) NO devuelve nada: sigue contando', async () => {
      const error = new Error('socket hang up')
      mockMarcarListoRappi.mockRejectedValue(error)

      await expect(rappiAdapter.markOrderReady('722609056', '900175625')).rejects.toBe(error)

      expect(mockDevolver).not.toHaveBeenCalled()
      expect(mockCerrar).not.toHaveBeenCalled()
    })

    it('🔴 un login caído (UNAVAILABLE: el token no se pudo pedir) tampoco gasta una de las 3', async () => {
      // Tarea 15: `rappi.http` lanza la falla del token como «no se envió». Antes era un Error común y la reserva quedaba contada.
      const error = new DeliveryWriteNotSentError('UNAVAILABLE', '[Rappi] no se envió nada: no se pudo obtener el token de integrations')
      mockMarcarListoRappi.mockRejectedValue(error)

      await expect(rappiAdapter.markOrderReady('722609056', '900175625')).rejects.toBe(error)

      expect(mockDevolver).toHaveBeenCalledWith('722609056', '900175625')
      expect(mockCerrar).not.toHaveBeenCalled()
    })

    it('una respuesta de Rappi (aunque sea un 5xx) no devuelve nada: la llamada salió', async () => {
      mockMarcarListoRappi.mockResolvedValue({ ok: false, status: 503, raw: 'boom' })

      await rappiAdapter.markOrderReady('722609056', '900175625')

      expect(mockDevolver).not.toHaveBeenCalled()
    })
  })

  it('si el cierre falla tras un 2xx, el 2xx NO se pierde: se devuelve igual (el núcleo lo acredita)', async () => {
    mockCerrar.mockRejectedValue(new Error('P1001'))

    await expect(rappiAdapter.markOrderReady('722609056', '900175625')).resolves.toEqual({ ok: true, status: 200, raw: '{}' })
  })
})

describe('rappiAdapter.publishMenu — en revisión, con los problemas a la vista', () => {
  const snapshot = (productos: unknown[]) =>
    ({ venueId: 'v1', generatedAt: 'x', categories: [{ name: 'Tacos', products: productos }] }) as never
  const taco = (over: Record<string, unknown> = {}) => ({
    plu: 'TACO-1',
    name: 'Taco',
    description: 'Con piña',
    price: 25,
    imageUrl: null,
    modifierGroups: [],
    ...over,
  })
  /** El ejemplo de 400 de la referencia de Rappi (`fuentes/es__api-reference_menus.md`, «400 La estructura del menú es invalida»), recortado. */
  const CUERPO_400_DOC = JSON.stringify({
    message: 'The submitted menu has errors.',
    errors: [
      {
        reason: 'All items must have a valid name, category or product description.',
        relatedItems: [{ sku: 'product1', type: 'PRODUCT' }],
      },
      { reason: 'Invalid urls were found', relatedItems: [{ sku: 'product2' }, { sku: 'topping1', type: 'TOPPING' }] },
      { reason: 'Sin renglones', relatedItems: [] },
    ],
  })

  beforeEach(() =>
    mockPublicarMenuRappi.mockReset().mockResolvedValue({ ok: true, status: 200, raw: 'Menu updated and ready to be validated' }),
  )

  it('🔴 declara menuConRevision: su 2xx es «en revisión», lo publicado lo dice el veredicto', () => {
    expect(rappiAdapter.menuConRevision).toBe(true)
  })

  it('publishMenu: el 400 trae los motivos de errors[] en problemas', async () => {
    mockPublicarMenuRappi.mockResolvedValue({ ok: false, status: 400, raw: CUERPO_400_DOC })

    const r = await rappiAdapter.publishMenu(snapshot([taco({ price: 25.5 })]), '900175625')

    expect(r).toMatchObject({ ok: false, status: 400, raw: CUERPO_400_DOC })
    expect(r.problemas).toEqual([
      // Lo del mapeo va primero (es lo que Avoqado ya sabía antes de mandar)…
      { sku: 'TACO-1', problema: 'precio 25.5 redondeado a 26: Rappi sólo acepta enteros' },
      // …y luego lo que Rappi dijo, un renglón por producto señalado.
      { sku: 'product1', problema: 'Rappi rechazó: All items must have a valid name, category or product description.' },
      { sku: 'product2', problema: 'Rappi rechazó: Invalid urls were found' },
      { sku: 'topping1', problema: 'Rappi rechazó: Invalid urls were found' },
      { sku: '(menú)', problema: 'Rappi rechazó: Sin renglones' },
    ])
  })

  it('un 400 con un cuerpo que no se puede leer no truena: queda el texto crudo como motivo', async () => {
    mockPublicarMenuRappi.mockResolvedValue({ ok: false, status: 400, raw: '<html>Bad Request</html>' })

    const r = await rappiAdapter.publishMenu(snapshot([taco()]), '900175625')

    expect(r.problemas).toEqual([{ sku: '(menú)', problema: 'Rappi rechazó el menú sin motivos legibles: <html>Bad Request</html>' }])
  })

  it('un 2xx trae los problemas del mapeo (y nada más)', async () => {
    const r = await rappiAdapter.publishMenu(snapshot([taco({ price: 25.5 })]), '900175625')

    expect(r).toMatchObject({ ok: true, status: 200 })
    expect(r.problemas).toEqual([{ sku: 'TACO-1', problema: 'precio 25.5 redondeado a 26: Rappi sólo acepta enteros' }])
  })

  it('🔴 menú vacío tras filtrar: no sale a la red (status 0) y dice por qué', async () => {
    const r = await rappiAdapter.publishMenu(snapshot([taco({ price: 0 })]), '900175625')

    expect(mockPublicarMenuRappi).not.toHaveBeenCalled()
    expect(r).toMatchObject({ ok: false, status: 0 })
    expect(r.problemas).toEqual([{ sku: 'TACO-1', problema: 'Cuesta $0 y no tiene modificadores: Rappi lo rechaza.' }])
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
