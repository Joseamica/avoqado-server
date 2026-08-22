/**
 * Ingreso de webhooks de Rappi.
 *
 * Lo que estos tests protegen: que el evento se tome de la RUTA y no del cuerpo. Varios
 * payloads de Rappi son literalmente indistinguibles entre sí.
 */
import {
  eventoDeLaRuta,
  esPing,
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
