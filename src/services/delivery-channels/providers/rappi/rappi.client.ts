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

import {
  llamarRappi,
  RappiEscrituraBloqueadaError,
  TIMEOUT_RAPPI_MS,
  type AmbienteRappi,
  type RappiPeticion,
  type RappiRespuesta,
} from './rappi.http'
import { getRappiToken, type SuperficieRappi } from './rappi.token'
import { aMotivoRappi, type ResultadoRechazo } from './rappi.rejectReason'
import {
  aplanarTiendas,
  cuerpoAprovisionamiento,
  elegirIdToken,
  hostDeLogin,
  leerRespuestaAprovisionamiento,
  type RespuestaAprovisionamiento,
  type TiendaRappi,
} from './rappi.selfOnboarding'
import { RAPPI_EVENTS } from './rappi.adapter'
import { RUTA_POR_EVENTO, secretosDelEvento } from './rappi.webhookIngress'
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
    signal: AbortSignal.timeout(TIMEOUT_RAPPI_MS),
  })
  if (!r.ok) {
    const cuerpo = await r.text()
    logger.error('🚨 [Rappi] el login falló', { superficie, status: r.status, cuerpo: cuerpo.slice(0, 300) })
    throw new Error(`[Rappi] login de ${superficie} respondió ${r.status}`)
  }
  return (await r.json()) as { access_token: string; expires_in?: number }
}

/** Petición autenticada, con token cacheado y el candado de escrituras ya armados. */
export async function rappiApi(peticion: Omit<RappiPeticion, 'superficie'> & { superficie?: SuperficieRappi }): Promise<RappiRespuesta> {
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

// ────────────────────────────────────────────────────────────────────────────────────
//  Self-onboarding (spec 2026-09-29) — doc: dev-portal.rappi.com/es/self-onboarding
// ────────────────────────────────────────────────────────────────────────────────────

/**
 * Una base configurable, validada AQUÍ y no en el arranque: estas variables son de una función opcional, y
 * un valor mal escrito en el env tumbaría TODA la API (`process.exit` del parseo). Lo que se niega es el flujo.
 * La barra final se quita: `//api/...` ya no coincide con la `redirect_uri` registrada en Rappi, y un webhook
 * con `//` no recibe nada sin avisar.
 */
function baseHttpValida(nombre: string, valor: string): string {
  const base = valor.trim().replace(/\/+$/, '')
  let url: URL | undefined
  try {
    url = new URL(base)
  } catch {
    // cae abajo: el mensaje es el mismo para «no es una URL» y «no es http(s)»
  }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new Error(`${nombre} no es una URL http(s) válida (se configuró ${JSON.stringify(valor)}); ej. https://api.avoqado.io`)
  }
  return base
}

export function apiBaseSelfOnboarding(): string {
  if (env.RAPPI_SELF_ONBOARDING_API_BASE) return baseHttpValida('RAPPI_SELF_ONBOARDING_API_BASE', env.RAPPI_SELF_ONBOARDING_API_BASE)
  if (getRappiEnvironment() === 'SANDBOX') return 'https://api.dev.rappi.com'
  throw new Error('Falta RAPPI_SELF_ONBOARDING_API_BASE: Rappi no publica el host de México para el self-onboarding (preguntar al TAM).')
}

const RUTA_CALLBACK = '/api/v1/delivery/rappi/oauth/callback'

export function redirectUriRappi(): string {
  if (!env.RAPPI_OAUTH_REDIRECT_BASE) throw new Error('Falta RAPPI_OAUTH_REDIRECT_BASE (debe ser idéntica a la registrada con el TAM).')
  return `${baseHttpValida('RAPPI_OAUTH_REDIRECT_BASE', env.RAPPI_OAUTH_REDIRECT_BASE)}${RUTA_CALLBACK}`
}

/** La base pública a la que Rappi manda los pedidos de cada tienda. */
function baseDeWebhooksRappi(): string {
  if (!env.RAPPI_WEBHOOK_BASE_URL) throw new Error('Falta RAPPI_WEBHOOK_BASE_URL')
  return baseHttpValida('RAPPI_WEBHOOK_BASE_URL', env.RAPPI_WEBHOOK_BASE_URL)
}

/** Eventos cuya URL es POR TIENDA. `STORE_PROVISIONING_STATUS` es por integración: no va aquí. */
const EVENTOS_POR_TIENDA = Object.entries(RUTA_POR_EVENTO).filter(([, ev]) => ev !== RAPPI_EVENTS.STORE_PROVISIONING_STATUS)

/**
 * 🔴 Todo lo que el self-onboarding va a necesitar, validado ANTES de crear el intent. Sin esto, una base de
 * webhooks faltante se descubría hasta suscribir: Rappi ya había aprovisionado la tienda y ésta se quedaba sin
 * recibir pedidos. Devuelve la base del enlace de inicio — la MISMA de la `redirect_uri` registrada en Rappi.
 * Incluye el secreto de CADA webhook que la tienda va a recibir (la misma lista que `suscribirTiendaAEventos`,
 * más el aviso de aprovisionamiento): Rappi acepta la suscripción aunque nos falte, y luego nuestro endpoint le
 * contesta 401 a cada pedido.
 */
export function preflightSelfOnboardingRappi(): string {
  const callback = redirectUriRappi()
  apiBaseSelfOnboarding()
  baseDeWebhooksRappi()
  const eventos = [RAPPI_EVENTS.STORE_PROVISIONING_STATUS, ...EVENTOS_POR_TIENDA.map(([, ev]) => ev)]
  const sinSecreto = eventos.filter(ev => secretosDelEvento(env.RAPPI_WEBHOOK_SECRETS, ev).length === 0)
  if (sinSecreto.length) {
    throw new Error(`Falta en RAPPI_WEBHOOK_SECRETS el secreto de ${sinSecreto.join(', ')} (Rappi lo entrega al registrar cada webhook).`)
  }
  return callback.slice(0, -RUTA_CALLBACK.length)
}

export function clientIdRappi(): string {
  const { clientId } = credenciales()
  return clientId
}

/** Cliente PÚBLICO con PKCE: sin `client_secret` (doc). Devuelve el id_token, nunca el access_token. */
export async function canjearCodigoRappi(code: string, verifier: string): Promise<string> {
  const r = await fetch(`${hostDeLogin(getRappiEnvironment())}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientIdRappi(),
      code_verifier: verifier,
      redirect_uri: redirectUriRappi(),
    }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_RAPPI_MS),
  })
  if (!r.ok) {
    logger.error('🚨 [Rappi] el canje del código falló', { status: r.status })
    throw new Error(`RAPPI_CANJE_${r.status}`)
  }
  return elegirIdToken(await r.json())
}

const deComercio = (idToken: string) => ({ 'Authorization-Partners': `Bearer ${idToken}` })

export async function tiendasDelComercio(idToken: string): Promise<TiendaRappi[]> {
  const r = await rappiApi({
    metodo: 'GET',
    ruta: `${API}/stores/integration-status`,
    host: apiBaseSelfOnboarding(),
    cabecerasExtra: deComercio(idToken),
  })
  if (!r.ok) throw new Error(`RAPPI_INTEGRATION_STATUS_${r.status}`)
  return aplanarTiendas(JSON.parse(r.raw))
}

export async function aprovisionarTiendasRappi(
  idToken: string,
  tiendas: Array<{ storeId: string; name: string }>,
): Promise<RespuestaAprovisionamiento> {
  const pedidas = tiendas.map(t => t.storeId)
  const r = await rappiApi({
    metodo: 'POST',
    ruta: `${API}/stores/provisioning`,
    host: apiBaseSelfOnboarding(),
    cabecerasExtra: deComercio(idToken),
    storeIds: pedidas,
    cuerpo: cuerpoAprovisionamiento(tiendas),
  })
  return leerRespuestaAprovisionamiento(r.status, r.raw, pedidas)
}

/**
 * 🔴 El paso que se olvida: una tienda aprovisionada pero sin suscribir a cada webhook queda
 * "conectada" y no recibe NADA. Se reporta qué eventos fallaron para no promoverla a ACTIVE.
 *
 * Siempre devuelve `{ ok, fallidos }`: un fallo de red en UN evento (la llamada lanza) cuenta como fallido y se
 * sigue con los demás. La única excepción es el candado: un rechazo de `RappiEscrituraBloqueadaError` no es un
 * fallo por evento sino una tienda que NO se puede escribir, así que se relanza.
 */
export async function suscribirTiendaAEventos(storeId: string): Promise<{ ok: boolean; fallidos: string[] }> {
  const base = baseDeWebhooksRappi()
  const fallidos: string[] = []
  for (const [segmento, evento] of EVENTOS_POR_TIENDA) {
    try {
      const r = await rappiApi({
        metodo: 'PUT',
        ruta: `${API}/webhook/${evento}/add-stores`,
        storeId,
        cuerpo: [{ url: `${base}/api/v1/webhooks/delivery/rappi/${segmento}`, stores: [storeId] }],
      })
      if (!r.ok) fallidos.push(evento)
    } catch (error) {
      if (error instanceof RappiEscrituraBloqueadaError) throw error
      logger.error('🚨 [Rappi] la suscripción de un evento lanzó', {
        storeId,
        evento,
        error: error instanceof Error ? error.message : String(error),
      })
      fallidos.push(evento)
    }
  }
  return { ok: fallidos.length === 0, fallidos }
}
