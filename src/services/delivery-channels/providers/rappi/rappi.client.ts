/**
 * Cliente de Rappi con el env cableado — el único archivo de Rappi que lee `@/config/env`.
 *
 * Deliberadamente DELGADO y sin tests unitarios, igual que `uber.client.ts`: importar
 * `@/config/env` valida y hace `process.exit` al cargarse, así que todo lo probable vive en
 * los módulos puros (`rappi.http`, `rappi.token`, `rappi.rejectReason`…) y aquí sólo se
 * conectan las piezas. Un `if` de negocio en este archivo está en el lugar equivocado.
 *
 * ⚠️ RUTAS CON SUPUESTOS ABIERTOS (sin sandbox no se pueden confirmar):
 *   · El login es `{hostDeLoginRappi}/restaurants/auth/v1/token/login/{superficie}/` (dominio nuevo, CON barra final:
 *     medido en DEV el 20-oct). La API sigue en el host clásico (`hostRappi`).
 *   · La superficie `integrations` usa `/api/v2/restaurants-integrations-public-api/…` —
 *     ésa sí está publicada endpoint por endpoint.
 *   · `utils` va a `/api/rest-ops-utils/…` en el host clásico (M6 y M14, 22-oct: login 200 y `GET /store/schedule/{id}` 200).
 *     El prefijo de `finance` NO está publicado completo: espera a la primera llamada real. No se inventó aquí a propósito.
 */
import { env } from '@/config/env'
import logger from '@/config/logger'

import {
  hostDeLoginRappi,
  llamarRappi,
  RappiEscrituraBloqueadaError,
  TIMEOUT_RAPPI_MS,
  type AmbienteRappi,
  type RappiPeticion,
  type RappiRespuesta,
} from './rappi.http'
import { anotarLoginExitoso, anotarLoginFallido, getRappiToken, type SuperficieRappi } from './rappi.token'
import { aplanarHorarioDeTienda, type FranjaActualRappi, type FranjaTiendaRappi } from './rappi.hours'
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

/**
 * ¿Hay llaves de la integración para el ambiente en uso? La pregunta del PING (`rappi.webhook.controller`): sin ellas no
 * podemos contestarle a Rappi nada de lo que nos pida, así que la tienda no está "ahí para recibir".
 * Envuelve `credenciales()` y NUNCA lanza ni imprime nada: el PING no puede revolver un Error (llega cada 3 minutos por
 * tienda) y mucho menos soltar el texto de una llave. Devuelve sólo el booleano.
 */
export function credencialesPresentes(): boolean {
  try {
    credenciales()
    return true
  } catch {
    return false
  }
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
  // 🔴 Dominio nuevo y barra FINAL: sin ella Rappi contesta 307 (medido el 20-oct).
  const url = `${hostDeLoginRappi(getRappiEnvironment(), env.RAPPI_COUNTRY)}/restaurants/auth/v1/token/login/${superficie}/`

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
    signal: AbortSignal.timeout(TIMEOUT_RAPPI_MS),
  })
  if (!r.ok) {
    const cuerpo = await r.text()
    const datos = { superficie, status: r.status, cuerpo: cuerpo.slice(0, 300) }
    // 🔴 El 🚨 sale al EMPEZAR la racha de fallos de esa superficie y, mientras siga, una vez por hora; el resto, warn (Tarea 20).
    if (anotarLoginFallido(superficie)) logger.error('🚨 [Rappi] el login falló', datos)
    else logger.warn('[Rappi] el login sigue fallando (ya se avisó; el aviso se repite cada hora mientras siga la racha)', datos)
    throw new Error(`[Rappi] login de ${superficie} respondió ${r.status}`)
  }
  const cuerpo = (await r.json()) as { access_token: string; expires_in?: number }
  // 🔴 La racha de fallos se cierra SÓLO si la respuesta trae un `access_token` de texto no vacío: cualquier 2xx con un cuerpo que
  // no sirve (lo rechaza `getRappiToken`) cerraba la racha y dejaba un «el login volvió» falso, y el siguiente rechazo gritaba
  // 🚨 como si fuera una caída nueva.
  const tokenSirve = typeof cuerpo?.access_token === 'string' && cuerpo.access_token.trim() !== ''
  if (tokenSirve && anotarLoginExitoso(superficie)) logger.info('[Rappi] el login volvió a funcionar', { superficie })
  return cuerpo
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
 * ⚠️ Rappi documenta que después de TRES solicitudes por pedido deja de ejecutar acciones y considera mal uso lo que siga.
 * El tope lo lleva `rappiAdapter.markOrderReady` (contado en la base); aquí sólo sale la llamada. `reintentarEn401: false`
 * hace que sea UNA petición HTTP aunque el token haya vencido (ver `RappiPeticion`).
 */
export async function marcarListoRappi(
  orderId: string,
  storeId: string,
  opciones: Pick<RappiPeticion, 'reintentarEn401'> = {},
): Promise<RappiRespuesta> {
  return rappiApi({
    metodo: 'POST',
    ruta: `${API}/orders/${encodeURIComponent(orderId)}/ready-for-pickup`,
    storeId,
    reintentarEn401: opciones.reintentarEn401,
  })
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
 * «Integrada sí/no» (Tarea 18): `PUT stores-pa/{storeId}/status?integrated=<bool>`. NO prende ni apaga la tienda: dice si sus pedidos
 * llegan por la integración o se atienden a mano en el portal de aliados (por eso es aparte de `habilitarTiendaRappi`).
 *
 * 🔴 Host CLÁSICO (el de siempre, sin `host` alterno): la medición M9 (21-oct) contestó HTTP 500 «contact support» en los DOS
 * hosts, así que el sandbox no decidió cuál es el bueno; hasta que Rappi lo aclare se queda en el de toda la API. Es una
 * ESCRITURA: lleva `storeId`, así que el candado de tiendas aplica (fuera de la lista lanza `RappiEscrituraBloqueadaError` y no
 * sale nada). Un 500 se DEVUELVE tal cual, no se lanza: quien llama (best-effort) lo registra.
 */
export async function marcarTiendaIntegradaRappi(storeId: string, integrada: boolean): Promise<RappiRespuesta> {
  return rappiApi({
    metodo: 'PUT',
    ruta: `${API}/stores-pa/${encodeURIComponent(storeId)}/status?integrated=${integrada}`,
    storeId,
  })
}

// ────────────────────────────────────────────────────────────────────────────────────
//  Horario regular de la tienda — API de Utils (Tarea 19), doc: `fuentes/es__utils.md` «Horarios de tiendas»
// ────────────────────────────────────────────────────────────────────────────────────

const UTILS = '/api/rest-ops-utils'
const rutaDeHorario = (storeId: string, storeScheduleId?: number | string) =>
  `${UTILS}/store/schedule/${encodeURIComponent(storeId)}${storeScheduleId === undefined ? '' : `/${encodeURIComponent(String(storeScheduleId))}`}`

/**
 * Lo que Rappi tiene hoy como horario regular, YA APLANADO a `{ id, day, starts_time, ends_time }` (horas en `HH:MM:SS`). Es una
 * LECTURA: va sin `storeId`. Medido en DEV (M14): 200 `{"storeScheduleDays":[]}` para una tienda sin horario.
 * 🔴 Un 2xx con un cuerpo que no se entiende LANZA (`aplanarHorarioDeTienda`): nunca se devuelve como «no hay franjas». Un
 * no-2xx se devuelve tal cual, sin `franjas`.
 */
export async function listarHorarioTiendaRappi(storeId: string): Promise<RappiRespuesta & { franjas?: FranjaActualRappi[] }> {
  const r = await rappiApi({ superficie: 'utils', metodo: 'GET', ruta: rutaDeHorario(storeId) })
  if (!r.ok) return r
  return { ...r, franjas: aplanarHorarioDeTienda(r.raw) }
}

/** Crea UNA franja (`POST`, cuerpo en snake_case). Escritura: lleva `storeId`, el candado de tiendas aplica. */
export async function crearFranjaTiendaRappi(storeId: string, franja: FranjaTiendaRappi): Promise<RappiRespuesta> {
  return rappiApi({
    superficie: 'utils',
    metodo: 'POST',
    ruta: rutaDeHorario(storeId),
    cuerpo: { day: franja.day, starts_time: franja.starts_time, ends_time: franja.ends_time },
    storeId,
  })
}

/** Cambia las horas de UNA franja existente (`PUT`, cuerpo en camelCase, a diferencia del POST). Escritura con candado. */
export async function actualizarFranjaTiendaRappi(
  storeId: string,
  storeScheduleId: number | string,
  franja: FranjaTiendaRappi,
): Promise<RappiRespuesta> {
  return rappiApi({
    superficie: 'utils',
    metodo: 'PUT',
    ruta: rutaDeHorario(storeId, storeScheduleId),
    cuerpo: { startsTime: franja.starts_time, endsTime: franja.ends_time },
    storeId,
  })
}

/** Borra UNA franja (`DELETE`; Rappi contesta 200 sin cuerpo). Escritura con candado. */
export async function borrarFranjaTiendaRappi(storeId: string, storeScheduleId: number | string): Promise<RappiRespuesta> {
  return rappiApi({ superficie: 'utils', metodo: 'DELETE', ruta: rutaDeHorario(storeId, storeScheduleId), storeId })
}

/**
 * El historial de eventos de UN pedido del lado de Rappi (Tarea 9): lo único que dice si un pedido que contestó 400 al
 * aceptar sí quedó aceptado (`taken_visible_order`). Medido el 21-oct en DEV: 200 con una lista; `[]` si nunca se aceptó.
 * Es una LECTURA: va sin `storeId`, como las demás. 🔴 No confundir con el GET de pedidos por tienda (`sondearPedidosRappi`),
 * que NO es una lectura: pasa los pedidos de READY a SENT. El cuerpo lo interpreta `leerRespuestaDelHistorial` (`rappi.estadoDelPedido`).
 */
export async function historialDelPedidoRappi(orderId: string): Promise<RappiRespuesta> {
  return rappiApi({ metodo: 'GET', ruta: `${API}/orders/${encodeURIComponent(orderId)}/events` })
}

/**
 * El sondeo de pedidos de UNA tienda: la RED por si su aviso NEW_ORDER se perdió (Tarea 20; Rappi no documenta reintentos).
 *
 * 🔴 NO es una lectura: el propio GET pasa los pedidos de READY a SENT del lado de Rappi, y quien lee primero se los lleva
 * (medido el 22-oct, M13: el segundo GET, 26 s después, vino vacío). Por eso:
 *   · es POR TIENDA y en el host NUEVO (`hostDeLoginRappi`; M13: 200 con la lista). El `GET {API}/orders` clásico es GLOBAL:
 *     pasaría a SENT los pedidos de tiendas que no son nuestras o no están en la lista, y ya no se usa;
 *   · lleva el candado de tiendas como una escritura (`cambiaEstado`): una tienda fuera de `RAPPI_WRITABLE_STORE_IDS_*` lanza
 *     `RappiEscrituraBloqueadaError` y no sale nada;
 *   · su único llamador es `rappi-order-poll.job.ts`, que guarda cada pedido ANTES de cualquier otra llamada de red. Nunca se
 *     llama fuera del sondeo.
 * Cada elemento de la lista tiene la forma del cuerpo del aviso NEW_ORDER (`{ store, customer, order_detail }`). El cuerpo lo
 * interpreta el job; aquí sólo sale la llamada.
 */
export async function sondearPedidosRappi(storeId: string): Promise<RappiRespuesta> {
  return rappiApi({
    metodo: 'GET',
    ruta: `/restaurants/orders/v1/stores/${encodeURIComponent(storeId)}/orders`,
    host: hostDeLoginRappi(getRappiEnvironment(), env.RAPPI_COUNTRY),
    storeId,
    cambiaEstado: true,
  })
}

/**
 * Los pedidos en SENT (entregados a la integración y todavía sin contestar) de TODAS las tiendas de la integración: la
 * recuperación del sondeo (Tarea 20). Si el proceso muere entre el GET por tienda y el guardado, el pedido ya no vuelve por ese
 * GET; vuelve por aquí (~10 min). Es una LECTURA (M13: 200 con la lista, mismo formato), host CLÁSICO y sin `storeId`: la
 * variante por tienda del host nuevo da 404. Quien llama descarta los pedidos de tiendas que no son suyas.
 */
export async function pedidosEnviadosRappi(): Promise<RappiRespuesta> {
  return rappiApi({ metodo: 'GET', ruta: `${API}/orders/status/sent` })
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
  // Ya publicado (docs de Rappi, «dominios nuevos»): DEV `api.dev.rappi.com`, México `api.rappi.com.mx`. La variable sólo lo sustituye.
  return hostDeLoginRappi(getRappiEnvironment(), env.RAPPI_COUNTRY)
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
 * También las dos llaves de Rappi (la integración M2M y el Client ID del login del dueño): sin ellas el dueño ya
 * habría autorizado en Rappi cuando el canje o el aprovisionamiento fallaran, con el intent creado.
 */
export function preflightSelfOnboardingRappi(): string {
  credenciales()
  clientIdRappi()
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

/**
 * Client ID del login del DUEÑO (self-onboarding). 🔴 No es el de la integración: al activar Self Onboarding en el
 * Integrations Manager, Rappi crea otra aplicación con su propio Client ID (verificado el 14-oct en DEV). Nunca cae
 * al de la integración: el login de Rappi lo rechazaría y el dueño vería un error de Rappi, no el nuestro.
 */
export function clientIdRappi(): string {
  const sufijo = getRappiEnvironment() === 'SANDBOX' ? 'SANDBOX' : 'PRODUCTION'
  const clientId = (
    sufijo === 'SANDBOX' ? env.RAPPI_SELF_ONBOARDING_CLIENT_ID_SANDBOX : env.RAPPI_SELF_ONBOARDING_CLIENT_ID_PRODUCTION
  )?.trim()
  if (!clientId) {
    throw new Error(
      `Falta RAPPI_SELF_ONBOARDING_CLIENT_ID_${sufijo}: es el Client ID de la página Self Onboarding del Integrations Manager ` +
        '(distinto al de la integración).',
    )
  }
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
