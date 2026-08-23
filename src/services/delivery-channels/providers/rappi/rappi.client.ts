/**
 * Cliente de Rappi con el env cableado — el único archivo de Rappi que lee `@/config/env`.
 *
 * Deliberadamente DELGADO y sin tests unitarios, igual que `uber.client.ts`: importar
 * `@/config/env` valida y hace `process.exit` al cargarse, así que todo lo probable vive en
 * los módulos puros (`rappi.http`, `rappi.token`, `rappi.rejectReason`…) y aquí sólo se
 * conectan las piezas. Un `if` de negocio en este archivo está en el lugar equivocado.
 *
 * ⚠️ RUTAS CON SUPUESTOS ABIERTOS (sin sandbox no se pueden confirmar):
 *   · El login se documenta como `/{host}/restaurants/auth/v1/token/login/{superficie}`.
 *   · La superficie `integrations` usa `/api/v2/restaurants-integrations-public-api/…` —
 *     ésa sí está publicada endpoint por endpoint.
 *   · Los prefijos de `utils` y `finance` NO están publicados completos: esas superficies
 *     esperan a la primera llamada real. No se inventaron aquí a propósito.
 */
import { env } from '@/config/env'
import logger from '@/config/logger'

import { llamarRappi, type AmbienteRappi, type RappiRespuesta } from './rappi.http'
import { getRappiToken, type SuperficieRappi } from './rappi.token'
import { aMotivoRappi, type ResultadoRechazo } from './rappi.rejectReason'
import type { DenyReason } from '../../core/types'

const API = '/api/v2/restaurants-integrations-public-api'

export function getRappiEnvironment(): AmbienteRappi {
  return env.RAPPI_ENVIRONMENT as AmbienteRappi
}

function credenciales(): { clientId: string; clientSecret: string } {
  const ambiente = getRappiEnvironment()
  const clientId = ambiente === 'SANDBOX' ? env.RAPPI_CLIENT_ID_SANDBOX : env.RAPPI_CLIENT_ID_PRODUCTION
  const clientSecret = ambiente === 'SANDBOX' ? env.RAPPI_CLIENT_SECRET_SANDBOX : env.RAPPI_CLIENT_SECRET_PRODUCTION
  if (!clientId || !clientSecret) {
    const sufijo = ambiente === 'SANDBOX' ? 'SANDBOX' : 'PRODUCTION'
    throw new Error(
      `Faltan credenciales de Rappi para el ambiente ${ambiente}: define RAPPI_CLIENT_ID_${sufijo} y ` +
        `RAPPI_CLIENT_SECRET_${sufijo} en el .env. Las entrega el equipo de integraciones de Rappi al aprobar el alta.`,
    )
  }
  return { clientId, clientSecret }
}

/** Tiendas donde SÍ se puede escribir. Vacía = ninguna — el candado del incidente 2026-08-17. */
export function tiendasEscribiblesRappi(): string[] {
  const crudo = getRappiEnvironment() === 'SANDBOX' ? env.RAPPI_WRITABLE_STORE_IDS_SANDBOX : env.RAPPI_WRITABLE_STORE_IDS_PRODUCTION
  return (crudo ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

/**
 * Pide el token real a Rappi. Las credenciales van en el BODY (no Basic auth) — es como su
 * documentación lo muestra, y es distinto de Uber.
 */
async function fetchTokenReal(superficie: SuperficieRappi): Promise<{ access_token: string; expires_in?: number }> {
  const { clientId, clientSecret } = credenciales()
  const { hostRappi } = await import('./rappi.http')
  const url = `${hostRappi(getRappiEnvironment(), env.RAPPI_COUNTRY)}/restaurants/auth/v1/token/login/${superficie}`

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
  })
  if (!r.ok) {
    const cuerpo = await r.text()
    logger.error('🚨 [Rappi] el login falló', { superficie, status: r.status, cuerpo: cuerpo.slice(0, 300) })
    throw new Error(`[Rappi] login de ${superficie} respondió ${r.status}`)
  }
  return (await r.json()) as { access_token: string; expires_in?: number }
}

/** Petición autenticada, con token cacheado y el candado de escrituras ya armados. */
export async function rappiApi(peticion: {
  superficie?: SuperficieRappi
  metodo: string
  ruta: string
  cuerpo?: unknown
  storeId?: string
}): Promise<RappiRespuesta> {
  return llamarRappi(
    {
      ambiente: getRappiEnvironment(),
      pais: env.RAPPI_COUNTRY,
      fetchImpl: fetch,
      getToken: superficie => getRappiToken(superficie, { fetchToken: fetchTokenReal }),
      tiendasEscribibles: tiendasEscribiblesRappi(),
    },
    { superficie: peticion.superficie ?? 'integrations', ...peticion },
  )
}

// ────────────────────────────────────────────────────────────────────────────────────
//  Las llamadas de salida, contra los endpoints publicados
// ────────────────────────────────────────────────────────────────────────────────────

/**
 * Aceptar un pedido, declarando los minutos de preparación.
 *
 * El `cookingTime` viene en el propio pedido (`tiempoDeCoccion` lo resuelve y recorta al
 * rango permitido); fuera del rango, Rappi rechaza la llamada.
 */
export async function aceptarPedidoRappi(orderId: string, storeId: string, cookingTime: number): Promise<RappiRespuesta> {
  return rappiApi({ metodo: 'PUT', ruta: `${API}/orders/${encodeURIComponent(orderId)}/take/${cookingTime}`, storeId })
}

/**
 * Rechazar un pedido. Devuelve el resultado de la TRADUCCIÓN además del HTTP: si el motivo
 * es "estoy saturado" o "cerrado", Rappi no lo admite y la respuesta correcta es pausar la
 * tienda — el caller tiene que poder distinguirlo de un rechazo que sí salió.
 */
export async function rechazarPedidoRappi(
  orderId: string,
  storeId: string,
  reason: DenyReason | undefined,
  opts: { itemIds?: string[]; itemSkus?: string[]; texto?: string } = {},
): Promise<{ traduccion: ResultadoRechazo; http?: RappiRespuesta }> {
  const traduccion = aMotivoRappi(reason, opts)
  if (!traduccion.rechazable) return { traduccion }

  const http = await rappiApi({
    metodo: 'PUT',
    ruta: `${API}/orders/${encodeURIComponent(orderId)}/reject`,
    cuerpo: traduccion.cuerpo,
    storeId,
  })
  return { traduccion, http }
}

/**
 * "Ya está listo para el repartidor."
 *
 * ⚠️ Rappi documenta que después de TRES llamadas por pedido deja de hacer efecto — no es un
 * botón de reintento infinito.
 */
export async function marcarListoRappi(orderId: string, storeId: string): Promise<RappiRespuesta> {
  return rappiApi({ metodo: 'POST', ruta: `${API}/orders/${encodeURIComponent(orderId)}/ready-for-pickup`, storeId })
}

/**
 * Publicar el menú. 🔴 Un 200 aquí significa "en revisión", NO publicado: lo publicado llega
 * después por el webhook `MENU_APPROVED` (y el rechazo, `MENU_REJECTED`, viene sin motivo).
 */
export async function publicarMenuRappi(payload: { storeId: string; items: unknown[] }): Promise<RappiRespuesta> {
  return rappiApi({ metodo: 'POST', ruta: `${API}/menu`, cuerpo: payload, storeId: payload.storeId })
}

/**
 * Prender/apagar productos por SKU. Tope documentado: 100 items combinados por llamada.
 * ⚠️ Republicar el menú NO reactiva lo apagado — este camino es el ÚNICO que lo hace.
 */
export async function disponibilidadItemsRappi(
  storeIntegrationId: string,
  items: { turn_on?: string[]; turn_off?: string[] },
): Promise<RappiRespuesta> {
  return rappiApi({
    metodo: 'PUT',
    ruta: `${API}/availability/stores/items`,
    cuerpo: [{ store_integration_id: storeIntegrationId, items: { turn_on: items.turn_on ?? [], turn_off: items.turn_off ?? [] } }],
    storeId: storeIntegrationId,
  })
}

/**
 * Prender/apagar la TIENDA — por el endpoint SÍNCRONO a propósito: es el único que contesta
 * por tienda si de verdad quedó (`SUCCESS`) o por qué no (`SUSPENDED`, `STORE_NOT_PUBLISHED`,
 * `FORBIDDEN`…). El asíncrono contestaría 200 y dejaría el botón mintiendo — el bug que ya
 * se arregló una vez en Uber.
 */
export async function habilitarTiendaRappi(
  storeId: string,
  isEnabled: boolean,
): Promise<RappiRespuesta & { resultadoTienda?: string; mensajeTienda?: string }> {
  const r = await rappiApi({
    metodo: 'PUT',
    ruta: `${API}/availability/stores/enable`,
    cuerpo: { stores: [{ store_id: storeId, is_enabled: isEnabled }] },
    storeId,
  })

  // El cuerpo trae el veredicto POR tienda; el 200 del HTTP no basta.
  try {
    const parsed = JSON.parse(r.raw) as { results?: Array<{ operation_result_type?: string; operation_result_message?: string }> }
    const fila = parsed.results?.[0]
    return { ...r, resultadoTienda: fila?.operation_result_type, mensajeTienda: fila?.operation_result_message }
  } catch {
    return r
  }
}

/**
 * El sondeo de pedidos: la RED por si un webhook se perdió (Rappi no documenta reintentos).
 * Devuelve sólo los pedidos pendientes de contestar, y el propio GET los pasa de READY a
 * SENT del lado de Rappi. El ritmo de 45 s lo pone el caller con `crearEspaciadorDeSondeo`.
 */
export async function sondearPedidosRappi(): Promise<RappiRespuesta> {
  return rappiApi({ metodo: 'GET', ruta: `${API}/orders` })
}
