/**
 * Ingreso de webhooks de Rappi — qué evento es y con qué secreto se verifica.
 *
 * 🔴 LA URL NO ES DECORACIÓN: ES EL ÚNICO DATO CONFIABLE DE QUÉ EVENTO LLEGÓ.
 *
 * Uber manda el tipo de evento dentro del cuerpo, así que una sola URL basta. Rappi no. Mira
 * los cuerpos que su propia documentación publica:
 *
 *   MENU_REJECTED  →  { "store_id": "900109448" }
 *   PING           →  { "store_id": 999 }
 *
 * **Son indistinguibles.** No hay campo `event`, no hay `type`. Contestarle "OK, aquí sigo" a
 * lo que en realidad era un rechazo de menú —o peor, tratar un PING como rechazo— es
 * literalmente imposible de evitar leyendo el cuerpo. Por eso Rappi exige una URL por evento,
 * y por eso aquí el evento se toma de la RUTA y jamás del payload.
 *
 * 🔴 Y cada evento tiene SU PROPIO SECRETO. No es un secreto por integración: `POST /webhook`
 * devuelve uno por cada evento que registras, y `reset-secret` los rota por separado. Verificar
 * con el secreto de otro evento rechaza todo en silencio.
 *
 * Los secretos son de la INTEGRACIÓN, no del venue: un mismo webhook cubre las tiendas de
 * todos nuestros clientes. Por eso viven en configuración del server y no en
 * `DeliveryChannelLink` — meterlos ahí implicaría copiar el mismo secreto en cada venue y
 * tener que rotarlo N veces.
 */
import { RAPPI_EVENTS } from './rappi.adapter'

/** Los eventos que sabemos manejar, y el pedazo de URL con el que los registramos en Rappi. */
export const RUTA_POR_EVENTO: Readonly<Record<string, string>> = {
  'new-order': RAPPI_EVENTS.NEW_ORDER,
  'new-order-scheduled': RAPPI_EVENTS.NEW_ORDER_SCHEDULED,
  'new-order-scheduled-cancelled': RAPPI_EVENTS.NEW_ORDER_SCHEDULED_CANCELLED,
  'order-cancel': RAPPI_EVENTS.ORDER_EVENT_CANCEL,
  'order-other': RAPPI_EVENTS.ORDER_OTHER_EVENT,
  'menu-approved': RAPPI_EVENTS.MENU_APPROVED,
  'menu-rejected': RAPPI_EVENTS.MENU_REJECTED,
  ping: RAPPI_EVENTS.PING,
  'store-connectivity': RAPPI_EVENTS.STORE_CONNECTIVITY,
  'order-tracking': RAPPI_EVENTS.ORDER_RT_TRACKING,
  'store-provisioning': RAPPI_EVENTS.STORE_PROVISIONING_STATUS,
}

/**
 * De la ruta al nombre del evento de Rappi. `null` si la ruta no es una que registramos —
 * mejor rechazar que adivinar: un evento desconocido con un secreto adivinado sería aceptar
 * cualquier cosa que llegue a una URL parecida.
 */
export function eventoDeLaRuta(segmento: string | undefined): string | null {
  if (!segmento) return null
  return RUTA_POR_EVENTO[segmento.trim().toLowerCase()] ?? null
}

/**
 * Los secretos vigentes para UN evento.
 *
 * Devuelve una lista porque una rotación tiene una ventana en la que los dos sirven: Rappi
 * genera el nuevo con `reset-secret` y lo empieza a usar cuando quiere. Aceptar sólo el nuevo
 * tiraría los eventos que ya venían firmados con el viejo.
 *
 * El mapa viene de configuración como JSON (`{"NEW_ORDER":"abc","PING":"def"}`) porque son
 * once y crecen: once variables de entorno separadas se desincronizan a la primera rotación.
 * Un JSON mal formado NO revienta el arranque — devuelve vacío, y sin secretos nada se acepta,
 * que es la falla segura.
 */
export function secretosDelEvento(mapaJson: string | undefined, evento: string): string[] {
  if (!mapaJson?.trim()) return []

  let mapa: Record<string, unknown>
  try {
    mapa = JSON.parse(mapaJson) as Record<string, unknown>
  } catch {
    // Sin secretos legibles no se acepta NADA. Es lo correcto: aceptar sin verificar sería
    // dejar que cualquiera nos meta pedidos.
    return []
  }
  if (!mapa || typeof mapa !== 'object') return []

  const valor = mapa[evento]
  // Se admite tanto un secreto suelto como una lista (la ventana de rotación).
  const lista = Array.isArray(valor) ? valor : [valor]
  return lista.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map(v => v.trim())
}

/**
 * Qué contestarle a Rappi.
 *
 * 🔴 El PING espera un cuerpo ESPECÍFICO (`{status:"OK", description}`); los demás no esperan
 * nada en particular. Y hay una asimetría que importa: **contestar mal un PING marca la tienda
 * como caída** a los dos intentos, mientras que contestar mal cualquier otro evento no tiene
 * consecuencia inmediata.
 *
 * Rappi **no documenta reintentos**. Eso significa que un 5xx nuestro probablemente pierde el
 * evento para siempre — por eso el sondeo de pedidos (`GET /orders`) no es un lujo, es la red.
 */
export function esPing(evento: string): boolean {
  return evento === RAPPI_EVENTS.PING
}
