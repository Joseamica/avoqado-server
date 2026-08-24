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
import { DeliveryOrderEventStatus, DeliveryProvider, Prisma } from '@prisma/client'

import prisma from '../../../../utils/prismaClient'
import { rappiAdapter, RAPPI_EVENTS } from './rappi.adapter'
import { parseRappiSignatureHeader, verifyRappiSignature } from './rappi.signature'

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

// ────────────────────────────────────────────────────────────────────────────────────
//  Persistencia — el 200 sólo sale con el evento ya guardado
// ────────────────────────────────────────────────────────────────────────────────────

export type RappiIngressOutcome = 'PERSISTED' | 'DUPLICATE' | 'INVALID_SIGNATURE' | 'MALFORMED'

export interface RappiIngressInput {
  rawBody: Buffer
  signatureHeader: string | undefined
  /** 🔴 El evento viene de la RUTA, jamás del cuerpo: varios payloads de Rappi son idénticos. */
  evento: string
  /** Los secretos vigentes de ESE evento (`secretosDelEvento`) — cada evento tiene el suyo. */
  secrets: string[]
}

interface CuerpoRappi {
  event?: unknown
  event_time?: unknown
}

/**
 * La llave de deduplicación, compuesta — Rappi NO manda un id de evento propio.
 *
 * Tres familias, porque la identidad natural de cada evento es distinta:
 *
 *  · Con PEDIDO (`NEW_ORDER`, cancelaciones…): `evento:tienda:pedido`. Un reenvío del mismo
 *    aviso deduplica — que es lo que se quiere.
 *  · `ORDER_OTHER_EVENT`: además el SUBTIPO y su `event_time`. El mismo pedido genera varios
 *    ("repartidor asignado", "llegó a la tienda"…) y sin esto el segundo se descartaría como
 *    duplicado del primero.
 *  · Sin identidad natural (`MENU_APPROVED`, `STORE_CONNECTIVITY`…): el TIMESTAMP de la
 *    firma. Un menú se aprueba muchas veces a lo largo de meses con el mismo `store_id` —
 *    sin el timestamp, la segunda aprobación jamás se procesaría.
 */
export function llaveDeDeduplicacion(evento: string, payload: unknown, signatureHeader: string | undefined): string {
  const identidad = rappiAdapter.extractIdentity(payload)
  const base = `RAPPI:${evento}:${identidad.storeId ?? 'sin-tienda'}:${identidad.orderId ?? 'sin-pedido'}`

  if (evento === RAPPI_EVENTS.ORDER_OTHER_EVENT) {
    const c = (payload ?? {}) as CuerpoRappi
    const subtipo = typeof c.event === 'string' ? c.event : 'sin-subtipo'
    const cuando = typeof c.event_time === 'string' ? c.event_time : 'sin-hora'
    return `${base}:${subtipo}:${cuando}`
  }

  const conIdentidadNatural = new Set<string>([
    RAPPI_EVENTS.NEW_ORDER,
    RAPPI_EVENTS.NEW_ORDER_SCHEDULED,
    RAPPI_EVENTS.NEW_ORDER_SCHEDULED_CANCELLED,
    RAPPI_EVENTS.ORDER_EVENT_CANCEL,
  ])
  if (conIdentidadNatural.has(evento)) return base

  const t = parseRappiSignatureHeader(signatureHeader)?.timestamp ?? 'sin-t'
  return `${base}:t${t}`
}

/**
 * Verifica, deduplica y guarda. Espejo del contrato de Uber: ACK persist-first — la firma se
 * comprueba ANTES de mirar el payload, y la carrera del duplicado la resuelve el `@unique`
 * de la base (P2002), no un "¿existe?" previo que dejaría ventana.
 *
 * El link puede no existir (tienda aún sin vincular): el evento se guarda igual con venue
 * nulo — un pedido real jamás se tira por eso.
 */
export async function persistRappiWebhookEvent(input: RappiIngressInput): Promise<{ outcome: RappiIngressOutcome; eventRowId?: string }> {
  const secrets = (input.secrets ?? []).filter(Boolean)
  if (secrets.length === 0) return { outcome: 'INVALID_SIGNATURE' }
  if (!secrets.some(s => verifyRappiSignature(input.rawBody, input.signatureHeader, s))) return { outcome: 'INVALID_SIGNATURE' }

  let payload: unknown
  try {
    payload = JSON.parse(input.rawBody.toString('utf8'))
  } catch {
    return { outcome: 'MALFORMED' }
  }

  const identidad = rappiAdapter.extractIdentity(payload)
  const dedupKey = llaveDeDeduplicacion(input.evento, payload, input.signatureHeader)

  const link = identidad.storeId
    ? await prisma.deliveryChannelLink.findUnique({
        where: { provider_externalLocationId: { provider: DeliveryProvider.RAPPI, externalLocationId: identidad.storeId } },
        select: { id: true, venueId: true },
      })
    : null

  try {
    const row = await prisma.deliveryOrderEvent.create({
      data: {
        provider: DeliveryProvider.RAPPI,
        externalEventId: dedupKey,
        // 🔴 El tipo es el de la RUTA — el payload puede no traer ninguno (PING y
        // MENU_REJECTED son literalmente indistinguibles por contenido).
        eventType: input.evento,
        dedupKey,
        externalOrderId: identidad.orderId,
        channelLinkId: link?.id ?? null,
        venueId: link?.venueId ?? null,
        payload: payload as Prisma.InputJsonValue,
        status: DeliveryOrderEventStatus.RECEIVED,
      },
      select: { id: true },
    })
    return { outcome: 'PERSISTED', eventRowId: row.id }
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return { outcome: 'DUPLICATE' }
    throw e
  }
}
