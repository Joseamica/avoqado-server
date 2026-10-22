/**
 * Ingreso de webhooks de Rappi.
 *
 * Lo que estos tests protegen: que el evento se tome de la RUTA y no del cuerpo. Varios
 * payloads de Rappi son literalmente indistinguibles entre sí.
 */
import crypto from 'crypto'
import logger from '../../../../src/config/logger'
import prisma from '../../../../src/utils/prismaClient'
import {
  eventoDeLaRuta,
  esPing,
  firmadoEnMsDeLaLlave,
  guardarPedidoSondeadoRappi,
  llaveDeDeduplicacion,
  persistRappiWebhookEvent,
  RUTA_POR_EVENTO,
  secretosDelEvento,
} from '../../../../src/services/delivery-channels/providers/rappi/rappi.webhookIngress'
import { RAPPI_EVENTS } from '../../../../src/services/delivery-channels/providers/rappi/rappi.adapter'

describe('eventoDeLaRuta', () => {
  // ── Por qué la URL es lo único confiable ──────────────────────────────────────────
  // MENU_REJECTED es `{store_id}` y PING es `{store_id}`. Leyendo el cuerpo son EL MISMO
  // objeto. Sólo la ruta los separa.
  it('🔴 distingue dos eventos cuyos cuerpos son idénticos', () => {
    expect(eventoDeLaRuta('menu-rejected')).toBe(RAPPI_EVENTS.MENU_REJECTED)
    expect(eventoDeLaRuta('ping')).toBe(RAPPI_EVENTS.PING)
  })

  it('cubre los 11 eventos que Rappi documenta', () => {
    expect(Object.keys(RUTA_POR_EVENTO)).toHaveLength(11)
    expect(new Set(Object.values(RUTA_POR_EVENTO)).size).toBe(11)
  })

  it('cada ruta apunta a un evento REAL del adaptador (sin nombres inventados)', () => {
    const reales = new Set(Object.values(RAPPI_EVENTS))
    for (const evento of Object.values(RUTA_POR_EVENTO)) expect(reales.has(evento as never)).toBe(true)
  })

  it('tolera mayúsculas y espacios en la ruta', () => {
    expect(eventoDeLaRuta(' New-Order ')).toBe(RAPPI_EVENTS.NEW_ORDER)
  })

  // 🔴 Adivinar sería aceptar cualquier cosa que llegue a una URL parecida.
  it('una ruta desconocida devuelve null en vez de adivinar', () => {
    expect(eventoDeLaRuta('lo-que-sea')).toBeNull()
    expect(eventoDeLaRuta(undefined)).toBeNull()
    expect(eventoDeLaRuta('')).toBeNull()
  })
})

describe('secretosDelEvento', () => {
  const mapa = JSON.stringify({ NEW_ORDER: 'secreto-pedidos', PING: 'secreto-ping' })

  it('🔴 cada evento trae SU secreto — el de otro rechazaría todo en silencio', () => {
    expect(secretosDelEvento(mapa, 'NEW_ORDER')).toEqual(['secreto-pedidos'])
    expect(secretosDelEvento(mapa, 'PING')).toEqual(['secreto-ping'])
  })

  it('un evento sin secreto configurado devuelve lista vacía', () => {
    expect(secretosDelEvento(mapa, 'MENU_APPROVED')).toEqual([])
  })

  // La rotación tiene una ventana: Rappi genera el nuevo y empieza a usarlo cuando quiere.
  // Aceptar sólo el nuevo tiraría los eventos que ya venían firmados con el viejo.
  it('acepta una LISTA de secretos para la ventana de rotación', () => {
    const conRotacion = JSON.stringify({ NEW_ORDER: ['viejo', 'nuevo'] })
    expect(secretosDelEvento(conRotacion, 'NEW_ORDER')).toEqual(['viejo', 'nuevo'])
  })

  // ── La falla SEGURA ───────────────────────────────────────────────────────────────
  // Sin secretos legibles no se acepta nada. Aceptar sin verificar sería dejar que
  // cualquiera nos meta pedidos.
  it('🔴 un JSON roto NO revienta y NO acepta nada', () => {
    expect(secretosDelEvento('{esto no es json', 'NEW_ORDER')).toEqual([])
  })

  it.each([undefined, '', '   ', 'null', '"texto"', '123'])('la configuración %p no acepta nada', valor => {
    expect(secretosDelEvento(valor as string | undefined, 'NEW_ORDER')).toEqual([])
  })

  it('ignora valores vacíos dentro del mapa', () => {
    expect(secretosDelEvento(JSON.stringify({ NEW_ORDER: ['', '  ', 'bueno'] }), 'NEW_ORDER')).toEqual(['bueno'])
  })
})

describe('esPing', () => {
  // Contestar mal un PING marca la tienda como caída a los dos intentos. Contestar mal
  // cualquier otro evento no tiene consecuencia inmediata — la asimetría importa.
  it('sólo el PING necesita el cuerpo especial', () => {
    expect(esPing(RAPPI_EVENTS.PING)).toBe(true)
    expect(esPing(RAPPI_EVENTS.NEW_ORDER)).toBe(false)
    expect(esPing(RAPPI_EVENTS.MENU_REJECTED)).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────────────────────

function firmar(timestamp: string, body: Buffer, secreto: string): string {
  const firmado = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), body])
  return `t=${timestamp},sign=${crypto.createHmac('sha256', secreto).update(firmado).digest('hex')}`
}

describe('llaveDeDeduplicacion', () => {
  const pedido = { order_detail: { order_id: '392625' }, store: { external_id: '900' } }

  it('🔴 un pedido REENVIADO produce la MISMA llave — el reintento deduplica', () => {
    expect(llaveDeDeduplicacion('NEW_ORDER', pedido, 't=1,sign=a')).toBe(llaveDeDeduplicacion('NEW_ORDER', pedido, 't=2,sign=b'))
  })

  it('🔴 dos eventos del REPARTIDOR del mismo pedido NO colisionan — sin el subtipo, el segundo se tiraría como duplicado', () => {
    const a = llaveDeDeduplicacion(
      'ORDER_OTHER_EVENT',
      { event: 'taken_visible_order', order_id: '1', store_id: '9', event_time: '10:00' },
      undefined,
    )
    const b = llaveDeDeduplicacion('ORDER_OTHER_EVENT', { event: 'arrived', order_id: '1', store_id: '9', event_time: '10:05' }, undefined)
    expect(a).not.toBe(b)
  })

  it('🔴 dos APROBACIONES de menú con meses de distancia NO colisionan — las separa el timestamp de la firma', () => {
    const cuerpo = { store_id: '900109448' }
    const a = llaveDeDeduplicacion('MENU_APPROVED', cuerpo, 't=1000,sign=x')
    const b = llaveDeDeduplicacion('MENU_APPROVED', cuerpo, 't=9999,sign=y')
    expect(a).not.toBe(b)
  })

  it('el MISMO cuerpo por rutas distintas da llaves distintas — la ruta es el tipo', () => {
    // MENU_REJECTED y PING son ambos `{store_id}`: sólo la ruta los separa.
    const cuerpo = { store_id: '900109448' }
    expect(llaveDeDeduplicacion('MENU_REJECTED', cuerpo, 't=1,sign=a')).not.toBe(
      llaveDeDeduplicacion('MENU_APPROVED', cuerpo, 't=1,sign=a'),
    )
  })

  it('🔴 dos lotes de APROVISIONAMIENTO con la misma firma NO colisionan — los separa el batchId', () => {
    // El cuerpo no trae tienda ni pedido: sin el lote, dos resultados firmados en el mismo segundo
    // compartían llave y el segundo se tiraba como duplicado (sus tiendas nunca se confirmaban).
    const lote = (batchId: string) => ({ batchId, operation: 'PROVISION', results: [{ storeId: '10', status: 'ACTIVE' }] })
    const a = llaveDeDeduplicacion('STORE_PROVISIONING_STATUS', lote('b-1'), 't=1000,sign=x')
    const b = llaveDeDeduplicacion('STORE_PROVISIONING_STATUS', lote('b-2'), 't=1000,sign=x')
    expect(a).not.toBe(b)
    // …y el reenvío del MISMO aviso sí deduplica.
    expect(llaveDeDeduplicacion('STORE_PROVISIONING_STATUS', lote('b-1'), 't=1000,sign=y')).toBe(a)
  })

  // Rappi no garantiza un solo aviso completo por lote: si manda dos fragmentos distintos del MISMO lote y
  // operación en el mismo segundo, el segundo no puede tirarse como duplicado (sus tiendas no se confirmarían).
  it('dos cuerpos DISTINTOS del mismo lote, operación y segundo no chocan; el mismo cuerpo sí deduplica', () => {
    const fragmento = (storeId: string) => ({ batchId: 'b-1', operation: 'PROVISION', results: [{ storeId, status: 'ACTIVE' }] })
    const a = llaveDeDeduplicacion('STORE_PROVISIONING_STATUS', fragmento('10'), 't=1000,sign=x')
    expect(llaveDeDeduplicacion('STORE_PROVISIONING_STATUS', fragmento('11'), 't=1000,sign=x')).not.toBe(a)
    expect(llaveDeDeduplicacion('STORE_PROVISIONING_STATUS', fragmento('10'), 't=1000,sign=z')).toBe(a)
  })
})

// Tarea 16 (diseño §4.5.1): el veredicto del menú sólo aplica a la pendiente publicada ANTES de que Rappi firmara el aviso. La
// hora de la firma sale de la llave guardada (el `:t<dígitos>` final). 🔴 Las llaves se arman con `llaveDeDeduplicacion` real:
// si su forma cambia, estas pruebas truenan en vez de que el veredicto deje de aplicarse en silencio.
describe('firmadoEnMsDeLaLlave', () => {
  const cuerpo = { store_id: '900175625' }

  it.each(['MENU_APPROVED', 'MENU_REJECTED'])('🔴 %s: lee el `t` de la firma en segundos y lo da en milisegundos', evento => {
    const llave = llaveDeDeduplicacion(evento, cuerpo, 't=1761130000,sign=abc')
    expect(llave).toBe(`RAPPI:${evento}:900175625:sin-pedido:t1761130000`)
    expect(firmadoEnMsDeLaLlave(llave)).toBe(1_761_130_000_000)
  })

  it('un `t` que ya viene en milisegundos (≥ 1e12) se deja igual', () => {
    expect(firmadoEnMsDeLaLlave(llaveDeDeduplicacion('MENU_APPROVED', cuerpo, 't=1761130000123,sign=abc'))).toBe(1_761_130_000_123)
  })

  it('sin `t` legible no hay hora de firma: null', () => {
    // Sin header de firma la llave termina en `:tsin-t`.
    expect(firmadoEnMsDeLaLlave(llaveDeDeduplicacion('MENU_APPROVED', cuerpo, undefined))).toBeNull()
    expect(firmadoEnMsDeLaLlave(null)).toBeNull()
    expect(firmadoEnMsDeLaLlave('')).toBeNull()
    // Un aviso CON pedido no lleva la firma en la llave.
    expect(firmadoEnMsDeLaLlave(llaveDeDeduplicacion('NEW_ORDER', { order_detail: { order_id: '1' } }, 't=1761130000,sign=a'))).toBeNull()
  })

  // T16b: con una unidad rara (microsegundos pasan el umbral de 1e12 y se leerían como ms del año 57 000) la hora queda en el
  // futuro lejano y TODO veredicto «se firmó después» de cualquier publicación: la regla de la hora se apagaba sin aviso.
  it('🔴 una hora de firma más de un día en el futuro no es una hora: null, con warn', () => {
    const warn = logger.warn as jest.Mock
    warn.mockClear()
    const microsegundos = Date.now() * 1000
    expect(firmadoEnMsDeLaLlave(llaveDeDeduplicacion('MENU_APPROVED', cuerpo, `t=${microsegundos},sign=a`))).toBeNull()
    const enDosDias = Math.floor((Date.now() + 2 * 86_400_000) / 1000)
    expect(firmadoEnMsDeLaLlave(llaveDeDeduplicacion('MENU_APPROVED', cuerpo, `t=${enDosDias},sign=a`))).toBeNull()
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('futuro'), expect.objectContaining({ dedupKey: expect.any(String) }))
  })

  it('un desfase de reloj de menos de un día sí se acepta', () => {
    const enUnaHora = Math.floor((Date.now() + 3_600_000) / 1000)
    expect(firmadoEnMsDeLaLlave(llaveDeDeduplicacion('MENU_APPROVED', cuerpo, `t=${enUnaHora},sign=a`))).toBe(enUnaHora * 1000)
  })

  it('un `t` que no cabe en un entero seguro (nanosegundos) tampoco es una hora: null, con warn', () => {
    const warn = logger.warn as jest.Mock
    warn.mockClear()
    expect(firmadoEnMsDeLaLlave(llaveDeDeduplicacion('MENU_APPROVED', cuerpo, `t=${Date.now()}000000,sign=a`))).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('sólo cuenta el `:t` del FINAL de la llave', () => {
    // El aprovisionamiento pone su `t` en medio (y una huella al final): no es una hora de veredicto.
    const lote = { batchId: 'b-1', operation: 'PROVISION', results: [] }
    expect(firmadoEnMsDeLaLlave(llaveDeDeduplicacion('STORE_PROVISIONING_STATUS', lote, 't=1761130000,sign=a'))).toBeNull()
  })
})

describe('persistRappiWebhookEvent', () => {
  const SECRETO = 's1'
  const body = Buffer.from(JSON.stringify({ order_detail: { order_id: '392625' }, store: { external_id: '900105814' } }), 'utf8')

  beforeEach(() => {
    jest.clearAllMocks()
    ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue({ id: 'link1', venueId: 'v1' })
    ;(prisma.deliveryOrderEvent.create as jest.Mock).mockResolvedValue({ id: 'evt1' })
  })

  it('firma válida → PERSISTED, con el tipo estampado DESDE LA RUTA', async () => {
    const r = await persistRappiWebhookEvent({
      rawBody: body,
      signatureHeader: firmar('100', body, SECRETO),
      evento: 'NEW_ORDER',
      secrets: [SECRETO],
    })

    expect(r).toMatchObject({ outcome: 'PERSISTED', eventRowId: 'evt1' })
    const data = (prisma.deliveryOrderEvent.create as jest.Mock).mock.calls[0][0].data
    expect(data.eventType).toBe('NEW_ORDER')
    expect(data.provider).toBe('RAPPI')
    expect(data.venueId).toBe('v1')
  })

  it('🔴 sin secretos configurados NO se acepta NADA — la falla segura', async () => {
    const r = await persistRappiWebhookEvent({
      rawBody: body,
      signatureHeader: firmar('100', body, SECRETO),
      evento: 'NEW_ORDER',
      secrets: [],
    })
    expect(r.outcome).toBe('INVALID_SIGNATURE')
    expect(prisma.deliveryOrderEvent.create).not.toHaveBeenCalled()
  })

  it('firma con OTRO secreto → INVALID_SIGNATURE, sin mirar el payload', async () => {
    const r = await persistRappiWebhookEvent({
      rawBody: body,
      signatureHeader: firmar('100', body, 'otro'),
      evento: 'NEW_ORDER',
      secrets: [SECRETO],
    })
    expect(r.outcome).toBe('INVALID_SIGNATURE')
  })

  it('JSON ilegible (pero bien firmado) → MALFORMED', async () => {
    const roto = Buffer.from('{esto no es json', 'utf8')
    const r = await persistRappiWebhookEvent({
      rawBody: roto,
      signatureHeader: firmar('100', roto, SECRETO),
      evento: 'NEW_ORDER',
      secrets: [SECRETO],
    })
    expect(r.outcome).toBe('MALFORMED')
  })

  it('🔴 el duplicado lo resuelve LA BASE (P2002), y es éxito, no error', async () => {
    const { Prisma } = jest.requireActual('@prisma/client')
    ;(prisma.deliveryOrderEvent.create as jest.Mock).mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
    )

    const r = await persistRappiWebhookEvent({
      rawBody: body,
      signatureHeader: firmar('100', body, SECRETO),
      evento: 'NEW_ORDER',
      secrets: [SECRETO],
    })
    expect(r.outcome).toBe('DUPLICATE')
  })

  it('tienda sin vincular: el evento se guarda IGUAL, con venue nulo — un pedido real no se tira', async () => {
    ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue(null)

    const r = await persistRappiWebhookEvent({
      rawBody: body,
      signatureHeader: firmar('100', body, SECRETO),
      evento: 'NEW_ORDER',
      secrets: [SECRETO],
    })

    expect(r.outcome).toBe('PERSISTED')
    const data = (prisma.deliveryOrderEvent.create as jest.Mock).mock.calls[0][0].data
    expect(data.venueId).toBeNull()
    expect(data.channelLinkId).toBeNull()
  })
})

// Tarea 20: el sondeo por tienda guarda por la MISMA pieza que el webhook, debajo de la firma (el sondeo no trae firma).
describe('guardarPedidoSondeadoRappi', () => {
  const pedido = { store: { external_id: '900175625', internal_id: '900175625' }, order_detail: { order_id: '570494427' } }

  beforeEach(() => {
    // `mockReset`: un `mockRejectedValueOnce` que una prueba no consumió no debe colarse a la siguiente.
    ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockReset().mockResolvedValue({ id: 'link1', venueId: 'v1' })
    ;(prisma.deliveryOrderEvent.create as jest.Mock).mockReset().mockResolvedValue({ id: 'evt9' })
  })

  it('🔴 guarda con la MISMA llave que el webhook del NEW_ORDER (con firma o sin ella da lo mismo)', async () => {
    const r = await guardarPedidoSondeadoRappi(pedido)

    expect(r).toMatchObject({ outcome: 'PERSISTED', eventRowId: 'evt9', evento: 'NEW_ORDER' })
    const data = (prisma.deliveryOrderEvent.create as jest.Mock).mock.calls[0][0].data
    expect(data.dedupKey).toBe(llaveDeDeduplicacion('NEW_ORDER', pedido, 't=1730000000,sign=abc'))
    expect(data.dedupKey).toBe('RAPPI:NEW_ORDER:900175625:570494427')
    expect(data.externalEventId).toBe(data.dedupKey)
    expect(data).toMatchObject({
      eventType: 'NEW_ORDER',
      provider: 'RAPPI',
      channelLinkId: 'link1',
      venueId: 'v1',
      externalOrderId: '570494427',
    })
  })

  it('el duplicado lo resuelve la base (P2002): DUPLICATE, sin lanzar', async () => {
    const { Prisma } = jest.requireActual('@prisma/client')
    ;(prisma.deliveryOrderEvent.create as jest.Mock).mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
    )
    await expect(guardarPedidoSondeadoRappi(pedido)).resolves.toMatchObject({ outcome: 'DUPLICATE' })
  })

  it('sin id de pedido o sin tienda NO se guarda (MALFORMED): una llave «sin-pedido» chocaría con cualquier otro', async () => {
    await expect(guardarPedidoSondeadoRappi({ store: { external_id: '900175625' }, order_detail: {} })).resolves.toEqual({
      outcome: 'MALFORMED',
    })
    await expect(guardarPedidoSondeadoRappi({ order_detail: { order_id: '1' } })).resolves.toEqual({ outcome: 'MALFORMED' })
    await expect(guardarPedidoSondeadoRappi('no es un objeto')).resolves.toEqual({ outcome: 'MALFORMED' })
    await expect(guardarPedidoSondeadoRappi([pedido])).resolves.toEqual({ outcome: 'MALFORMED' })
    expect(prisma.deliveryOrderEvent.create).not.toHaveBeenCalled()
  })

  // Un programado guardado como NEW_ORDER tomaría la llave del pedido real: cuando Rappi lo libere, su webhook sería DUPLICATE.
  it('🔴 un pedido PROGRAMADO se guarda con SU llave (NEW_ORDER_SCHEDULED), la misma que le pondría su webhook', async () => {
    const programado = { ...pedido, action: 'scheduled' }
    const r = await guardarPedidoSondeadoRappi(programado)

    expect(r).toMatchObject({ outcome: 'PERSISTED', evento: 'NEW_ORDER_SCHEDULED' })
    const data = (prisma.deliveryOrderEvent.create as jest.Mock).mock.calls[0][0].data
    expect(data.eventType).toBe('NEW_ORDER_SCHEDULED')
    expect(data.dedupKey).toBe(llaveDeDeduplicacion('NEW_ORDER_SCHEDULED', programado, undefined))
    expect(data.dedupKey).not.toBe(llaveDeDeduplicacion('NEW_ORDER', pedido, undefined))
  })

  it('regresión: el webhook firmado sigue guardando igual que antes', async () => {
    const body = Buffer.from(JSON.stringify(pedido), 'utf8')
    const r = await persistRappiWebhookEvent({
      rawBody: body,
      signatureHeader: firmar('100', body, 's1'),
      evento: 'NEW_ORDER',
      secrets: ['s1'],
    })

    expect(r).toEqual({ outcome: 'PERSISTED', eventRowId: 'evt9' })
    const data = (prisma.deliveryOrderEvent.create as jest.Mock).mock.calls[0][0].data
    expect(data.dedupKey).toBe('RAPPI:NEW_ORDER:900175625:570494427')
  })
})
