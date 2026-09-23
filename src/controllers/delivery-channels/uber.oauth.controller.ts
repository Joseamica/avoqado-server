/**
 * Activación de Uber Eats por OAuth — el comerciante autoriza a Avoqado sobre sus tiendas.
 *
 * POR QUÉ EXISTE: una tienda sólo queda alcanzable por nuestro token de aplicación
 * DESPUÉS de que su dueño autorice la app y se llame `POST /pos_data`
 * [doc: developer.uber.com/docs/eats/guides/integration-activation-flows]. Sin este
 * flujo, cada alta dependería de un ticket a soporte de Uber.
 *
 * 🔴 El flujo cuelga de una INTENCIÓN de conexión (`DeliveryConnectIntent`, spec §4.1), que
 * emite una petición AUTENTICADA (`connect-url`) y que se revalida en cada paso. Antes el
 * `venueId` viajaba suelto por `/start?venueId=…`: cualquiera podía armar el enlace de un
 * negocio ajeno y conectarle tiendas — o sea, desviarle pedidos reales.
 *
 * El token del COMERCIANTE vive cifrado en la intención sólo mientras la activación lo
 * necesita, y se borra al terminar: tras la activación el acceso es perpetuo vía
 * `client_credentials`.
 *
 * ⚠️ Rutas PÚBLICAS (Uber redirige el navegador aquí, sin sesión de Avoqado). La prueba de
 * origen es la firma HMAC de la intención, con un propósito por paso.
 */
import { DeliveryConnectIntent } from '@prisma/client'
import { Request, Response } from 'express'

import { env } from '@/config/env'
import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'
import * as claims from '@/services/delivery-channels/core/deliveryStoreClaim.service'
import * as intents from '@/services/delivery-channels/core/deliveryConnectIntent.service'
import prisma from '@/utils/prismaClient'

import {
  buildUberAuthorizeUrl,
  exchangeUberAuthCode,
  uberRequest,
  type UberCredentials,
} from '@/services/delivery-channels/providers/uber-eats/uber.http'
import { getWritableStores } from '@/services/delivery-channels/providers/uber-eats/uber.client'
import { type UberEnvironment } from '@/services/delivery-channels/providers/uber-eats/uber.storeAllowlist'

const ACTIVATE_PATH = '/api/v1/delivery/uber/oauth/activate'

function credentials(e: UberEnvironment): UberCredentials {
  const clientId = e === 'SANDBOX' ? env.UBER_CLIENT_ID_SANDBOX : env.UBER_CLIENT_ID_PRODUCTION
  const clientSecret = e === 'SANDBOX' ? env.UBER_CLIENT_SECRET_SANDBOX : env.UBER_CLIENT_SECRET_PRODUCTION
  if (!clientId || !clientSecret) {
    throw new Error(`Faltan UBER_CLIENT_ID_${e} / UBER_CLIENT_SECRET_${e} en el .env`)
  }
  return { clientId, clientSecret }
}

/** La URL de retorno DEBE ser idéntica al pedir y al canjear: OAuth lo exige. */
function redirectUri(req: Request): string {
  const base = env.UBER_OAUTH_REDIRECT_BASE || `${req.protocol}://${req.get('host')}`
  return `${base}/api/v1/delivery/uber/oauth/callback`
}

/**
 * 🔴 Escapa TODO lo que venga de fuera antes de meterlo en HTML. Estas rutas son públicas y
 * sin sesión: interpolar `error_description` de la query o el nombre de una tienda que
 * devuelve Uber es XSS reflejado bajo el origen de la API. Hallado por auditoría externa.
 */
function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function page(titulo: string, cuerpo: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${esc(titulo)}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:720px;margin:56px auto;padding:0 20px;color:#1a1a1a}
code{background:#f2f2f0;padding:2px 6px;border-radius:4px;font-size:14px}
.ok{color:#1d7a4d}.bad{color:#b32020}li{margin:6px 0}</style>
<h1>${esc(titulo)}</h1>${cuerpo}`
}

const PIDE_OTRO = 'Pide un enlace nuevo desde el dashboard de Avoqado (Delivery → Conectar Uber Eats).'
const YA_USADO = page('Este enlace ya se usó o venció', `<p class="bad">Este enlace ya se usó o venció. ${PIDE_OTRO}</p>`)

const MOTIVOS: Record<string, string> = {
  EXPIRED: `El enlace venció (dura 10 minutos). ${PIDE_OTRO}`,
  ENVIRONMENT_CHANGED: `La configuración de Uber en Avoqado cambió mientras conectabas. ${PIDE_OTRO}`,
  CLIENT_ID_CHANGED: `La configuración de Uber en Avoqado cambió mientras conectabas. ${PIDE_OTRO}`,
  STAFF_NOT_AUTHORIZED:
    'Quien generó este enlace ya no tiene permiso para conectar canales en este negocio. Pide a un administrador que genere uno nuevo.',
  PLAN_REQUIRED: 'El envío a domicilio requiere el plan PREMIUM. Actívalo en el dashboard (Configuración → Plan) y genera un enlace nuevo.',
  TOKEN_UNREADABLE: `No pudimos leer la autorización de Uber que guardamos. ${PIDE_OTRO}`,
}
const paginaFallo = (motivo: string) =>
  page('No se pudo conectar', `<p class="bad">${esc(MOTIVOS[motivo] ?? `${motivo}. ${PIDE_OTRO}`)}</p>`)

const TEXTO_RESULTADO: Record<string, string> = {
  ACTIVATED: '<span class="ok">conectada</span>',
  EXCLUDED_BY_ENV: '<span class="bad">excluida por Avoqado</span> — no está en la lista de tiendas habilitadas para conectar.',
  OTHER_VENUE: '<span class="bad">ya está conectada a otro negocio</span>; contacta a Avoqado.',
  POS_DATA_FAILED: '<span class="bad">Uber rechazó la activación</span>',
  CLAIMED_BY_OTHER: '<span class="bad">otra conexión la está activando en este momento</span>; espera unos minutos y vuelve a intentar.',
  REVOKED_MEANWHILE:
    '<span class="bad">Uber retiró el permiso de esta tienda mientras se conectaba</span>; para conectarla hay que autorizarla de nuevo con un enlace nuevo.',
  [intents.RESULTADO_REINTENTABLE]: '<span class="bad">no se pudo guardar</span>; usa «Reintentar».',
}

/** El texto de UNA tienda en la página de resultado. Exportado para las pruebas. */
export function textoResultado(x: intents.ResultadoTienda): string {
  // Reconectar una tienda PAUSADA: se autorizó, pero sigue sin recibir pedidos hasta que la reanuden.
  if (x.outcome === 'ACTIVATED' && x.sigueEnPausa)
    return '<span class="ok">conectada</span>; sigue en pausa — reanúdala desde el panel de Avoqado.'
  // Sin respuesta de Uber (red, timeout) no sabemos si la rechazó: no se dice que sí.
  if (x.outcome === 'POS_DATA_FAILED' && x.sinRespuesta) {
    return '<span class="bad">no pudimos confirmar con Uber</span>; reintenta en unos minutos con un enlace nuevo desde el dashboard.'
  }
  return TEXTO_RESULTADO[x.outcome] ?? esc(x.outcome)
}

/** El negocio de Avoqado al que van las tiendas: la ÚNICA pista que tiene el dueño de la cuenta de Uber de que el enlace es el correcto. */
async function nombreDelNegocio(venueId: string): Promise<string> {
  return (await prisma.venue.findUnique({ where: { id: venueId }, select: { name: true } }))?.name ?? '(negocio sin nombre)'
}

/** Error público: texto fijo + el código de la petición para soporte. El mensaje interno sólo va al log. */
function paginaError(res: Response, titulo: string): string {
  const codigo = res.getHeader('X-Correlation-ID')
  return page(
    titulo,
    '<p class="bad">Algo falló de nuestro lado. Inténtalo de nuevo en unos minutos.</p>' +
      (codigo ? `<p>Si escribes a soporte, comparte este código: <code>${esc(codigo)}</code></p>` : ''),
  )
}

/**
 * La confirmación ANTES de conectar, también con UNA sola tienda.
 *
 * ⚠️ Desviación deliberada del spec §4.1 (que activaba sola la tienda única): el enlace es al
 * portador y el dashboard lo manda por correo, así que alguien con permiso en OTRO negocio podría
 * mandárselo al dueño de una tienda real haciéndose pasar por Avoqado. Con una tienda, un clic en
 * la pantalla legítima de Uber bastaba para desviarle los pedidos. Ahora siempre se ve A QUÉ
 * negocio van y hay que confirmarlo; los dos caminos publican al mismo `POST /oauth/activate`.
 */
function paginaSeleccion(id: string, tiendas: intents.TiendaUber[], negocio: string): string {
  const cabecera =
    `<p>Vas a conectar estas tiendas a <strong>${esc(negocio)}</strong> en Avoqado. Al conectarlas, Uber empezará a mandar ` +
    'sus pedidos a ese negocio. Si ése no es tu negocio, cierra esta página y no conectes nada.</p>'
  const state2 = `<input type="hidden" name="state2" value="${esc(intents.firmarIntent(id, 'activate'))}">`
  if (tiendas.length === 1) {
    const t = tiendas[0]
    return page(
      'Confirma la conexión',
      `${cabecera}<form method="post" action="${ACTIVATE_PATH}">${state2}<input type="hidden" name="stores" value="${esc(t.id)}">
<p><strong>${esc(t.name ?? '(sin nombre)')}</strong> <code>${esc(t.id)}</code></p>
<button type="submit">Conectar ${esc(t.name ?? t.id)} a ${esc(negocio)}</button></form>`,
    )
  }
  // La palomita del dueño ES el permiso por tienda (decisión del founder). Nada viene marcado.
  const opciones = tiendas
    .map(
      t =>
        `<li><label><input type="checkbox" name="stores" value="${esc(t.id)}"> <strong>${esc(t.name ?? '(sin nombre)')}</strong> <code>${esc(t.id)}</code></label></li>`,
    )
    .join('')
  return page(
    'Elige qué tiendas conectar',
    `${cabecera}<form method="post" action="${ACTIVATE_PATH}">${state2}
<ul>${opciones}</ul><button type="submit">Conectar las tiendas marcadas a ${esc(negocio)}</button></form>`,
  )
}

function formularioReintentar(id: string): string {
  return `<form method="post" action="${ACTIVATE_PATH}"><input type="hidden" name="state2" value="${esc(intents.firmarIntent(id, 'activate'))}">
<button type="submit">Reintentar</button></form>`
}

async function responderActivacion(res: Response, id: string, r: intents.ResultadoActivacion): Promise<void> {
  if (r.estado === 'NO_DISPONIBLE') {
    res.status(400).send(YA_USADO)
    return
  }
  if (r.estado === 'FAILED') {
    res.status(403).send(paginaFallo(r.motivo))
    return
  }
  if (r.estado === 'EN_CURSO') {
    res
      .status(409)
      .send(page('Activación en curso', '<p>Ya se están conectando estas tiendas en otra pestaña. Espera unos segundos y recarga.</p>'))
    return
  }
  const fila = await prisma.deliveryConnectIntent.findUnique({ where: { id }, select: { storesJson: true, venueId: true } })
  const tiendas = new Map(((fila?.storesJson as intents.TiendaUber[] | null) ?? []).map(t => [t.id, t]))
  const negocio = esc(fila ? await nombreDelNegocio(fila.venueId) : '')
  // Sólo tiendas con resultado: la versión consentida se anota antes para todas las elegidas.
  const filas = Object.entries(r.resultados)
    .filter(([, x]) => x.outcome)
    .map(
      ([storeId, x]) =>
        `<li><strong>${esc(tiendas.get(storeId)?.name ?? '(sin nombre)')}</strong><br><code>${esc(storeId)}</code><br>` +
        `${textoResultado(x)}${x.status ? ` (HTTP ${esc(x.status)})` : ''}</li>`,
    )
  if (r.estado === 'CONSUMED') {
    const todas = Object.values(r.resultados).every(x => x.outcome === 'ACTIVATED')
    const encabezado = todas
      ? `Conectadas a <strong>${negocio}</strong> en Avoqado:`
      : `Resultado para <strong>${negocio}</strong> en Avoqado:`
    res
      .status(todas ? 200 : 207)
      .send(page(todas ? 'Avoqado quedó conectado' : 'Conexión con avisos', `<p>${encabezado}</p><ul>${filas.join('')}</ul>`))
    return
  }
  // INCOMPLETO (un fallo local dejó tiendas sin finalizar) o INTERRUMPIDO (esta ejecución perdió el lease).
  res
    .status(r.estado === 'INCOMPLETO' ? 207 : 409)
    .send(
      page(
        'La conexión quedó a medias',
        `<p>Resultado para <strong>${negocio}</strong> en Avoqado:</p><ul>${filas.join('')}</ul><p>Faltan tiendas por terminar.</p>${formularioReintentar(id)}`,
      ),
    )
}

/**
 * El trabajo por tienda (spec §4.3): reclamar la tienda ANTES del HTTP, `pos_data`, finalizar
 * por CAS. Exportado para las pruebas: la reclamación y la finalización viven en
 * `deliveryStoreClaim.service`, donde cada efecto exige el lease vivo de esta ejecución.
 */
export const activarTiendaUber: intents.ActivarTienda = async ({ intent, owner, token, storeId, store }) => {
  const e = intent.environment as UberEnvironment
  // La variable RESTRINGE por intersección, nunca amplía (§4.3, [N-5]): en SANDBOX sólo lo que
  // lista (default-deny, el sandbox de Uber NO aísla producción); en PRODUCTION vacía no restringe
  // — ahí la palomita del dueño, reclamada abajo, ES el permiso de esta tienda.
  const lista = getWritableStores(e)
  if ((e === 'SANDBOX' || lista.size > 0) && !lista.has(storeId.toLowerCase())) return { outcome: 'EXCLUDED_BY_ENV' }

  const reclamo = await claims.reclamarTienda(intent, owner, storeId, store?.name ?? null)
  // Ejecución muerta: nada de HTTP; `activar` descarta el resultado y la recuperación re-reclama.
  if (reclamo.tipo === 'MUERTA') return { outcome: intents.RESULTADO_REINTENTABLE }
  if (reclamo.tipo === 'FINAL') return { outcome: reclamo.outcome }

  // Recuperación con la MISMA versión consentida y `pos_data` ya aceptado: no se repite (M3).
  if (!reclamo.posDataOk) {
    const fallo = await posData(intent, token, storeId, e)
    if (fallo) {
      // Final: la tienda queda libre para un enlace nuevo (un lease perdido lo repite la recuperación).
      await claims.liberarReclamo(intent, owner, storeId, fallo)
      return fallo
    }
    if (!(await claims.anotarPosDataOk(intent.id, owner, storeId))) return { outcome: intents.RESULTADO_REINTENTABLE }
  }

  let fin: Awaited<ReturnType<typeof claims.finalizarTienda>>
  try {
    fin = await claims.finalizarTienda(intent, owner, storeId, reclamo.version)
  } catch (err) {
    // Entre 2 y 3: Uber ya dijo que sí y la escritura local no. «Reintentar» finaliza sin repetir `pos_data`.
    logger.error('🚨 [UberOAuth] pos_data OK pero no se pudo guardar la conexión', {
      intentId: intent.id,
      storeId,
      error: (err as Error).message,
    })
    return { outcome: intents.RESULTADO_REINTENTABLE }
  }
  if (fin === null) return { outcome: intents.RESULTADO_REINTENTABLE }
  if (fin.outcome === 'ACTIVATED') {
    void logAction({
      staffId: intent.staffId,
      venueId: intent.venueId,
      action: 'DELIVERY_CHANNEL_CONNECTED',
      entity: 'DeliveryChannelLink',
      entityId: reclamo.linkId,
      data: { provider: 'UBER_EATS', externalLocationId: storeId, intentId: intent.id, environment: e, sigueEnPausa: !!fin.sigueEnPausa },
    })
  }
  return fin
}

/** Paso 2: `POST /pos_data` (2xx exigido). `null` = aceptado; si no, el resultado final de la tienda. */
async function posData(
  intent: DeliveryConnectIntent,
  token: string,
  storeId: string,
  e: UberEnvironment,
): Promise<claims.ResultadoFinal | null> {
  let status = 0
  try {
    const activacion = await uberRequest(
      // El candado de escritura de ESTA llamada es la intersección de arriba + la reclamación.
      { environment: e, token, writableStores: new Set([storeId.toLowerCase()]) },
      {
        method: 'POST',
        path: `/v1/eats/stores/${encodeURIComponent(storeId)}/pos_data`,
        storeId,
        body: {
          integrator_store_id: intent.venueId,
          integrator_brand_id: 'avoqado',
          // 🔴 `is_order_manager` ES EL INTERRUPTOR. Sin él, la tienda queda con
          // `integration_enabled: true` y todo PARECE bien —el webhook llega, el pedido
          // se trae, se ingiere con su comanda de cocina— pero `accept_pos_order`
          // responde `403 user_not_allowed` y Uber cancela a los ~11.5 min. El cliente se
          // queda sin comida y el log sólo dice "user not allowed".
          //
          // Medido con un pedido REAL el 2026-08-20 (`00012fba-…`, "Avoqado Sandbox 1").
          // Ningún test lo podía atrapar: todos mockean la red.
          //
          // ⚠️ NO es `pos_integration_enabled`: ése está DEPRECADO y Uber lo IGNORA en
          // silencio — se probó mandándolo, el POST devolvió 200 y el flag siguió en
          // `false`. Lo dice nuestra propia investigación (ANEXO §Flujo
          // integrator-initiated, paso 4) y se confirmó contra la API real.
          is_order_manager: true,
          // AUTO: que Uber no exija que un humano confirme en su app. Nuestro
          // `orderAcceptanceMode` por canal es quien decide si aceptamos solos.
          require_manual_acceptance: false,
        },
      },
    )
    status = activacion.status
    if (status < 200 || status >= 300) {
      logger.warn('🛵 [UberOAuth] Uber rechazó pos_data', { intentId: intent.id, storeId, status, cuerpo: activacion.text.slice(0, 200) })
    }
  } catch (err) {
    logger.warn('🛵 [UberOAuth] pos_data no respondió', { intentId: intent.id, storeId, error: (err as Error).message })
    return { outcome: 'POS_DATA_FAILED', sinRespuesta: true }
  }
  return status >= 200 && status < 300 ? null : { outcome: 'POS_DATA_FAILED', status }
}

/** Paso 1: `GET /oauth/start?intent=<id>.<hmac>` — manda al comerciante a autorizar. Ya NO acepta `venueId`. */
export async function startUberOAuth(req: Request, res: Response): Promise<void> {
  try {
    const id = intents.leerFirma(req.query.intent, 'start')
    if (!id) {
      res.status(400).send(page('Enlace inválido', `<p class="bad">Este enlace no es válido. ${PIDE_OTRO}</p>`))
      return
    }
    const intent = await prisma.deliveryConnectIntent.findUnique({ where: { id } })
    if (!intent || intent.state !== 'CREATED') {
      res.status(400).send(YA_USADO)
      return
    }
    const motivo = await intents.revalidar(intent)
    if (motivo) {
      res.status(403).send(paginaFallo(motivo))
      return
    }
    res.redirect(
      buildUberAuthorizeUrl({
        environment: intent.environment as UberEnvironment,
        clientId: intent.clientId,
        redirectUri: redirectUri(req),
        state: intents.firmarIntent(id, 'callback'),
      }),
    )
  } catch (e) {
    logger.error('No se pudo iniciar el OAuth de Uber', { error: (e as Error).message })
    res.status(500).send(paginaError(res, 'No se pudo iniciar'))
  }
}

/** Paso 2: recibe el código, canjea, lista tiendas y pide confirmar A QUÉ negocio van (una o varias). */
export async function uberOAuthCallback(req: Request, res: Response): Promise<void> {
  const { code, state, error, error_description: desc } = req.query as Record<string, string>
  try {
    // 🔴 El `state` se valida ANTES de tocar nada más: sin eso, `error`/`error_description`
    // de un GET arbitrario llegaban a la respuesta sin haber probado que el flujo nació aquí.
    const id = intents.leerFirma(state, 'callback')
    if (!id) {
      res.status(400).send(page('Estado inválido', `<p class="bad">El <code>state</code> no se pudo verificar. ${PIDE_OTRO}</p>`))
      return
    }
    const intent = await prisma.deliveryConnectIntent.findUnique({ where: { id } })
    // Un replay del callback muere aquí: el código NUNCA se canjea dos veces.
    if (!intent || intent.state !== 'CREATED') {
      res.status(400).send(YA_USADO)
      return
    }
    if (error || !code) {
      await intents.fallar(id, error ? 'UBER_DENIED' : 'NO_CODE')
      res
        .status(400)
        .send(page('Uber no autorizó la conexión', `<p class="bad"><code>${esc(error ?? 'sin código')}</code> ${esc(desc)}</p>`))
      return
    }
    const motivo = await intents.revalidar(intent)
    if (motivo) {
      res.status(403).send(paginaFallo(motivo))
      return
    }
    // CAS ANTES de canjear: si dos callbacks llegan juntos, sólo uno pasa de aquí.
    if (!(await intents.casEstado(id, 'CREATED', 'EXCHANGED'))) {
      res.status(400).send(YA_USADO)
      return
    }

    const e = intent.environment as UberEnvironment
    let tiendas: intents.TiendaUber[]
    let token: string
    try {
      token = (await exchangeUberAuthCode({ environment: e, credentials: credentials(e), code, redirectUri: redirectUri(req) }))
        .access_token
      // Con el token del COMERCIANTE: sus tiendas, no las nuestras. uAPI (`/v1/delivery/stores`)
      // es el "Get Stores to User" que la validación de Uber rastrea (caso 59605086).
      const lista = await uberRequest({ environment: e, token, writableStores: new Set() }, { method: 'GET', path: '/v1/delivery/stores' })
      // 🔴 Un 401/500 de Uber NO es "no hay tiendas".
      if (lista.status >= 400) throw new Error(`Uber respondió HTTP ${lista.status} al listar las tiendas`)
      // uAPI trae `id`; la familia clásica traía `store_id`. Se aceptan ambos.
      tiendas = ((lista.json as { stores?: Array<{ id?: string; store_id?: string; name?: string }> })?.stores ?? [])
        .map(t => ({ id: t.id ?? t.store_id ?? '', name: t.name ?? null }))
        .filter(t => t.id)
    } catch (err) {
      await intents.fallar(id, 'EXCHANGE_FAILED')
      logger.error('Uber OAuth: falló el canje o el listado de tiendas', { intentId: id, error: (err as Error).message })
      res.status(502).send(page('Uber no devolvió tus tiendas', `<p class="bad">No se conectó nada. ${PIDE_OTRO}</p>`))
      return
    }
    if (tiendas.length === 0) {
      await intents.fallar(id, 'NO_STORES')
      res.status(200).send(page('Autorizado, pero sin tiendas', '<p>Uber no devolvió ninguna tienda para esta cuenta.</p>'))
      return
    }

    const guardado = await intents.casEstado(id, 'EXCHANGED', 'EXCHANGED', {
      storesJson: tiendas as never,
      merchantTokenEnvelope: intents.cifrarTokenComerciante(intent, token),
    })
    if (!guardado) {
      res.status(400).send(YA_USADO)
      return
    }
    // Con una tienda o con varias, nada se activa sin que el dueño vea A QUÉ negocio van y lo confirme.
    res.status(200).send(paginaSeleccion(id, tiendas, await nombreDelNegocio(intent.venueId)))
  } catch (err) {
    logger.error('Falló el callback de OAuth de Uber', { error: (err as Error).message })
    res.status(500).send(paginaError(res, 'Falló la conexión'))
  }
}

function mismaSeleccion(cuerpo: unknown, guardada: unknown): boolean {
  const a = new Set(([] as unknown[]).concat(cuerpo ?? []))
  const b = new Set(Array.isArray(guardada) ? guardada : [])
  return a.size === b.size && [...a].every(x => b.has(x))
}

const OTRA_SELECCION = page(
  'Ya se había enviado otra selección',
  '<p class="bad">Para este enlace ya se había enviado otra selección de tiendas (quizá desde otra pestaña). Revisa esa pestaña para ver el resultado.</p>',
)

/** Paso 3: `POST /oauth/activate` (`state2` firmado + `stores[]`) — la selección, y el «Reintentar». */
export async function activarUberOAuth(req: Request, res: Response): Promise<void> {
  try {
    const id = intents.leerFirma(req.body?.state2, 'activate')
    const intent = id ? await prisma.deliveryConnectIntent.findUnique({ where: { id } }) : null
    if (!id || !intent) {
      res.status(400).send(YA_USADO)
      return
    }
    if (intent.state === 'EXCHANGED') {
      const disponibles = new Set(((intent.storesJson as intents.TiendaUber[] | null) ?? []).map(t => t.id))
      const pedidas = [...new Set(([] as unknown[]).concat(req.body?.stores ?? []))]
      if (pedidas.length === 0 || pedidas.some(s => typeof s !== 'string' || !disponibles.has(s))) {
        res.status(400).send(page('Selección inválida', '<p class="bad">Marca al menos una de las tiendas que Uber mostró.</p>'))
        return
      }
      // count 0 ⇒ otra pestaña mandó SU selección antes: no se activa la de otro en nombre de ésta.
      // Congela la versión de revocación de cada tienda EN el consentimiento (M7).
      if (!(await claims.seleccionarTiendas(id, pedidas as string[]))) {
        res.status(409).send(OTRA_SELECCION)
        return
      }
    }
    // ACTIVATING = «Reintentar»: se usa la selección guardada, nunca la del cuerpo. El formulario de
    // «Reintentar» no manda `stores`; si llegan y NO son la selección guardada, es otra pestaña con SU
    // selección tarde — no se activa la de otro en nombre de ésta. La misma selección (doble clic)
    // sigue de largo y el lease contesta «en curso».
    else if (req.body?.stores !== undefined && !mismaSeleccion(req.body.stores, intent.selectionJson)) {
      res.status(409).send(OTRA_SELECCION)
      return
    }
    return responderActivacion(res, id, await intents.activar(id, activarTiendaUber))
  } catch (err) {
    logger.error('Falló la activación de Uber', { error: (err as Error).message })
    res.status(500).send(paginaError(res, 'Falló la conexión'))
  }
}
