/**
 * Ingreso de webhooks de Rappi.
 *
 * Lo que estos tests protegen: que el evento se tome de la RUTA y no del cuerpo. Varios
 * payloads de Rappi son literalmente indistinguibles entre sí.
 */
import crypto from 'crypto'
import prisma from '../../../../src/utils/prismaClient'
import {
  eventoDeLaRuta,
  esPing,
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
