/**
 * Self-onboarding de Rappi por OAuth (spec 2026-09-29) — el comerciante entra a Rappi, ve SUS
 * tiendas, confirma a qué negocio de Avoqado van y elige cuáles conectar.
 *
 * ⚠️ Rutas PÚBLICAS: Rappi redirige aquí el navegador del comerciante, sin sesión de Avoqado. La
 * prueba de origen es la firma HMAC de la intención, con un propósito por paso (start, callback,
 * activate, result). Estas páginas deciden a qué negocio llegan los pedidos REALES de un
 * restaurante: por eso la selección enseña el negocio destino y exige confirmarlo (R11) — el
 * enlace es al portador, y alguien con permiso en OTRO negocio podría mandárselo al dueño.
 *
 * 🔴 El `code` se canjea DESPUÉS de ganar el CAS `CREATED → EXCHANGED` (R12): un replay o dos
 * callbacks a la vez nunca lo canjean dos veces. El `id_token` vive cifrado en la intención
 * mientras Rappi confirma (es asíncrono): la página de resultado lo usa para re-leer
 * `integration-status`, porque Rappi no documenta reintentos de su webhook.
 *
 * 🔴 Nunca se loguean `code`, tokens, verifier ni sobres: sólo ids. Todo lo que viene de fuera
 * (nombres de tienda, `error_description`, motivos de Rappi, el nombre del negocio) pasa por `esc()`.
 */
import { DeliveryConnectIntent } from '@prisma/client'
import { Request, Response } from 'express'

import logger from '@/config/logger'
import { casEstado, fallar } from '@/services/delivery-channels/core/deliveryConnectIntent.service'
import {
  cifrarIdToken,
  depsDesdeEnv,
  descifrarIdToken,
  firmar,
  leerFirma,
  revalidarRappi,
  verifierDe,
  type ConnectDeps,
  type PropositoRappi,
} from '@/services/delivery-channels/providers/rappi/rappi.connect'
import {
  activarSeleccion,
  cerrarSiTodoFinal,
  confirmarTienda,
  type ResultadoRappi,
} from '@/services/delivery-channels/providers/rappi/rappi.provisioning'
import { urlDeAutorizacion, type TiendaRappi } from '@/services/delivery-channels/providers/rappi/rappi.selfOnboarding'
import prisma from '@/utils/prismaClient'

const ACTIVATE_PATH = '/api/v1/delivery/rappi/oauth/activate'
const RESULT_PATH = '/api/v1/delivery/rappi/oauth/result'
/** Perezoso: `rappi.client` importa `@/config/env`, que hace `process.exit` si se carga en Jest. */
const cliente = () => import('@/services/delivery-channels/providers/rappi/rappi.client')

// ─── HTML (copia de `uber.oauth.controller.ts`, que no los exporta) ─────────────────────

/** 🔴 Escapa TODO lo externo: estas rutas son públicas, interpolar sin esto es XSS reflejado bajo el origen de la API. */
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

const PIDE_OTRO = 'Pide un enlace nuevo desde el dashboard de Avoqado (Delivery → Conectar Rappi).'
const INVALIDO = page('Enlace inválido', `<p class="bad">Este enlace no es válido. ${PIDE_OTRO}</p>`)
const YA_USADO = page('Este enlace ya se usó o venció', `<p class="bad">Este enlace ya se usó o venció. ${PIDE_OTRO}</p>`)

const MOTIVOS: Record<string, string> = {
  EXPIRED: `El enlace venció. ${PIDE_OTRO}`,
  ENVIRONMENT_CHANGED: `La configuración de Rappi en Avoqado cambió mientras conectabas. ${PIDE_OTRO}`,
  CLIENT_ID_CHANGED: `La configuración de Rappi en Avoqado cambió mientras conectabas. ${PIDE_OTRO}`,
  STAFF_NOT_AUTHORIZED:
    'Quien generó este enlace ya no tiene permiso para conectar canales en este negocio. Pide a un administrador que genere uno nuevo.',
  PLAN_REQUIRED: 'El envío a domicilio requiere el plan PREMIUM. Actívalo en el dashboard (Configuración → Plan) y genera un enlace nuevo.',
  RAPPI_TOKEN_ILEGIBLE: `No pudimos leer la autorización de Rappi que guardamos. ${PIDE_OTRO}`,
}
const textoMotivo = (m: string) => MOTIVOS[m] ?? `No se pudo conectar (${m}). ${PIDE_OTRO}`
const paginaFallo = (motivo: string) => page('No se pudo conectar', `<p class="bad">${esc(textoMotivo(motivo))}</p>`)

/** Error público: texto fijo + el código de la petición para soporte. El mensaje interno sólo va al log. */
function paginaError(res: Response, titulo: string): string {
  const codigo = res.getHeader('X-Correlation-ID')
  return page(
    titulo,
    '<p class="bad">Algo falló de nuestro lado. Inténtalo de nuevo en unos minutos.</p>' +
      (codigo ? `<p>Si escribes a soporte, comparte este código: <code>${esc(codigo)}</code></p>` : ''),
  )
}

/** El negocio de Avoqado al que van las tiendas: la ÚNICA pista del dueño de que el enlace es el correcto. */
async function nombreDelNegocio(venueId: string): Promise<string> {
  return (await prisma.venue.findUnique({ where: { id: venueId }, select: { name: true } }))?.name ?? '(negocio sin nombre)'
}

// ─── Lo común a los cuatro pasos ────────────────────────────────────────────────────────

type Ctx = { intentId?: string }

/** Cada paso en su `try/catch`: una excepción es una página amable, nunca un stack. Al log, sólo el id y el mensaje. */
function publica(titulo: string, paso: (req: Request, res: Response, ctx: Ctx) => Promise<void>) {
  return async (req: Request, res: Response): Promise<void> => {
    const ctx: Ctx = {}
    try {
      await paso(req, res, ctx)
    } catch (e) {
      logger.error(`🚨 [RappiOAuth] ${titulo}`, { intentId: ctx.intentId, error: (e as Error).message })
      res.status(500).send(paginaError(res, titulo))
    }
  }
}

/** La firma con SU propósito y el intent de Rappi que nombra. `null` ⇒ ya se respondió. */
async function abrir(res: Response, deps: ConnectDeps, firmado: unknown, p: PropositoRappi, ctx: Ctx) {
  const id = leerFirma(deps, firmado, p)
  if (!id) {
    res.status(400).send(INVALIDO)
    return null
  }
  ctx.intentId = id
  const intent = await prisma.deliveryConnectIntent.findUnique({ where: { id } })
  if (!intent || intent.provider !== 'RAPPI') {
    res.status(400).send(YA_USADO)
    return null
  }
  return intent
}

/** Lo que autorizó la emisión sigue siendo cierto (vigencia, app, permiso, plan). Si no, FAILED y la página lo dice. */
async function vigente(res: Response, deps: ConnectDeps, intent: DeliveryConnectIntent): Promise<boolean> {
  const motivo = await revalidarRappi(deps, intent)
  if (motivo) res.status(403).send(paginaFallo(motivo))
  return !motivo
}

const objeto = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [])
/** Lo que todavía espera a Rappi; lo demás ya es final y no se vuelve a tocar. */
const ESPERANDO = new Set(['PROVISIONING', 'UNCERTAIN', 'SUBSCRIBE_FAILED'])

// ─── Paso 1: start ──────────────────────────────────────────────────────────────────────

/** `GET /oauth/start?intent=<id>.<hmac>` — manda al comerciante al login de Rappi, con PKCE. */
export const startRappiOAuth = publica('No se pudo iniciar', async (req, res, ctx) => {
  const deps = await depsDesdeEnv()
  const intent = await abrir(res, deps, req.query.intent, 'start', ctx)
  if (!intent) return
  if (intent.state !== 'CREATED') {
    res.status(400).send(YA_USADO)
    return
  }
  if (!(await vigente(res, deps, intent))) return
  const { redirectUriRappi } = await cliente()
  res.redirect(
    302,
    urlDeAutorizacion({
      ambiente: deps.ambiente,
      clientId: deps.clientId,
      redirectUri: redirectUriRappi(),
      state: firmar(deps, intent.id, 'callback'),
      verifier: verifierDe(deps, intent.id),
    }),
  )
})

// ─── Paso 2: callback ───────────────────────────────────────────────────────────────────

/** Sólo motivos controlados en `failureReason`; cualquier otra cosa (red, JSON) es `RAPPI_ERROR`. */
function motivoDeCanje(e: unknown): string {
  const m = (e as Error)?.message ?? ''
  return /^RAPPI_(ID_TOKEN_INVALIDO|CANJE_\d+|INTEGRATION_STATUS_\d+)$/.test(m) ? m : 'RAPPI_ERROR'
}

/** La selección: A QUÉ negocio van (R11), una palomita obligatoria que lo confirma, y nada marcado de antemano. */
function paginaSeleccion(deps: ConnectDeps, id: string, tiendas: TiendaRappi[], negocio: string): string {
  const opciones = tiendas
    .map(t =>
      t.integrated
        ? `<li><label><input type="checkbox" disabled> <strong>${esc(t.name)}</strong> <code>${esc(t.storeId)}</code> — ya integrada</label></li>`
        : `<li><label><input type="checkbox" name="tiendas" value="${esc(t.storeId)}"> <strong>${esc(t.name)}</strong> <code>${esc(t.storeId)}</code></label></li>`,
    )
    .join('')
  return page(
    'Elige qué tiendas conectar',
    `<p>Estas tiendas se conectarán a <strong>${esc(negocio)}</strong> en Avoqado. Al conectarlas, Rappi empezará a mandar ` +
      'sus pedidos a ese negocio. Si ése no es tu negocio, cierra esta página y no conectes nada.</p>' +
      `<form method="post" action="${ACTIVATE_PATH}"><input type="hidden" name="state2" value="${esc(firmar(deps, id, 'activate'))}">
<ul>${opciones}</ul>
<p><label><input type="checkbox" name="confirmo_negocio" value="si" required> Confirmo que estas tiendas son de <strong>${esc(negocio)}</strong>.</label></p>
<button type="submit">Conectar las tiendas marcadas a ${esc(negocio)}</button></form>`,
  )
}

/** `GET /oauth/callback?code=&state=` — R12, en este orden: firma → CREATED → `error` → revalidar → CAS → canje → guardar. */
export const rappiOAuthCallback = publica('Falló la conexión', async (req, res, ctx) => {
  const { code, error, error_description: desc } = req.query as Record<string, unknown>
  const deps = await depsDesdeEnv()
  const intent = await abrir(res, deps, req.query.state, 'callback', ctx)
  if (!intent) return
  // Un replay del callback muere aquí: el código NUNCA se canjea dos veces.
  if (intent.state !== 'CREATED') {
    res.status(400).send(YA_USADO)
    return
  }
  if (error || typeof code !== 'string' || !code) {
    await fallar(intent.id, error ? 'RAPPI_DENIED' : 'RAPPI_SIN_CODIGO')
    res
      .status(400)
      .send(
        page(
          'Rappi no autorizó la conexión',
          `<p class="bad">${esc(desc || error || 'Rappi no devolvió el código.')}</p><p>${PIDE_OTRO}</p>`,
        ),
      )
    return
  }
  if (!(await vigente(res, deps, intent))) return
  // CAS ANTES de canjear, sin token todavía: de dos callbacks simultáneos sólo uno pasa de aquí.
  if (!(await casEstado(intent.id, 'CREATED', 'EXCHANGED'))) {
    res.status(400).send(YA_USADO)
    return
  }

  let idToken: string
  let tiendas: TiendaRappi[]
  try {
    const { canjearCodigoRappi, tiendasDelComercio } = await cliente()
    idToken = await canjearCodigoRappi(code, verifierDe(deps, intent.id))
    if (!idToken) throw new Error('RAPPI_ID_TOKEN_INVALIDO')
    tiendas = await tiendasDelComercio(idToken)
  } catch (e) {
    const motivo = motivoDeCanje(e)
    await fallar(intent.id, motivo)
    logger.error('🚨 [RappiOAuth] falló el canje o el listado de tiendas', { intentId: intent.id, error: (e as Error).message })
    res.status(502).send(page('Rappi no devolvió tus tiendas', `<p class="bad">No se conectó nada. ${PIDE_OTRO}</p>`))
    return
  }
  if (!tiendas.length) {
    await fallar(intent.id, 'RAPPI_SIN_TIENDAS')
    res.status(200).send(page('Autorizado, pero sin tiendas', '<p>Rappi no devolvió ninguna tienda para esta cuenta.</p>'))
    return
  }
  // La selección sólo se enseña si ESTE callback guardó token y tiendas (count 1).
  const guardado = await casEstado(intent.id, 'EXCHANGED', 'EXCHANGED', {
    merchantTokenEnvelope: cifrarIdToken(deps, intent, idToken),
    storesJson: tiendas as never,
  })
  if (!guardado) {
    res.status(400).send(YA_USADO)
    return
  }
  res.status(200).send(paginaSeleccion(deps, intent.id, tiendas, await nombreDelNegocio(intent.venueId)))
})

// ─── Paso 3: activate ───────────────────────────────────────────────────────────────────

/** `POST /oauth/activate` (`state2` + `tiendas[]` + `confirmo_negocio`) → 303 al resultado. */
export const activarRappiOAuth = publica('Falló la conexión', async (req, res, ctx) => {
  const deps = await depsDesdeEnv()
  const intent = await abrir(res, deps, req.body?.state2, 'activate', ctx)
  if (!intent) return
  const aResultado = () => res.redirect(303, `${RESULT_PATH}?intent=${encodeURIComponent(firmar(deps, intent.id, 'result'))}`)
  // Doble clic, «atrás» u otra pestaña: la selección ya salió (o el intent terminó). Se enseña el resultado; no se reenvía nada.
  if (intent.state !== 'EXCHANGED') {
    aResultado()
    return
  }
  if (!(await vigente(res, deps, intent))) return
  if (req.body?.confirmo_negocio !== 'si') {
    res
      .status(400)
      .send(
        page('Falta confirmar el negocio', '<p class="bad">Marca la casilla que confirma a qué negocio de Avoqado van estas tiendas.</p>'),
      )
    return
  }
  // Nunca se confía en el formulario: sólo tiendas que Rappi listó (y no integradas ya), sin repetir.
  const listadas = new Map(((intent.storesJson as TiendaRappi[] | null) ?? []).filter(t => !t.integrated).map(t => [t.storeId, t]))
  const pedidas = new Set(([] as unknown[]).concat(req.body?.tiendas ?? []))
  const elegidas = [...pedidas].flatMap(s => (typeof s === 'string' ? (listadas.get(s) ?? []) : []))
  if (!elegidas.length) {
    res.status(400).send(page('Selección inválida', '<p class="bad">Marca al menos una de las tiendas que Rappi mostró.</p>'))
    return
  }
  // Review Focus 2: el segundo envío pierde este CAS y sólo ve el resultado.
  if (!(await casEstado(intent.id, 'EXCHANGED', 'ACTIVATING', { selectionJson: elegidas.map(t => t.storeId) }))) {
    aResultado()
    return
  }
  // R13: se aprovisiona con la fila FRESCA (ACTIVATING y con su selección), no con la leída antes del CAS.
  const fresco = await prisma.deliveryConnectIntent.findUnique({ where: { id: intent.id } })
  if (fresco?.state !== 'ACTIVATING') {
    aResultado()
    return
  }
  const idToken = descifrarIdToken(deps, fresco)
  if (!idToken) {
    await fallar(intent.id, 'RAPPI_TOKEN_ILEGIBLE') // sin token no sale nada a Rappi
    res.status(403).send(paginaFallo('RAPPI_TOKEN_ILEGIBLE'))
    return
  }
  const c = await cliente()
  await activarSeleccion(fresco, idToken, elegidas, {
    aprovisionar: c.aprovisionarTiendasRappi,
    suscribir: c.suscribirTiendaAEventos,
    tiendasEscribibles: c.tiendasEscribiblesRappi(),
  })
  aResultado()
})

// ─── Paso 4: result ─────────────────────────────────────────────────────────────────────

/**
 * Review Focus 3: el webhook `STORE_PROVISIONING_STATUS` puede no llegar nunca. Cada carga re-lee
 * `integration-status` y confirma lo que Rappi ya integró, con la MISMA `confirmarTienda` del webhook,
 * que sólo promueve si el `integrationId` es el que guardamos (R7). Recargar mil veces es seguro:
 * lo final no se toca y una confirmación repetida se ignora.
 */
async function reChequear(deps: ConnectDeps, intent: DeliveryConnectIntent): Promise<void> {
  if (await revalidarRappi(deps, intent)) return // FAILED: la página lo dice
  const idToken = descifrarIdToken(deps, intent)
  if (!idToken) {
    await fallar(intent.id, 'RAPPI_TOKEN_ILEGIBLE')
    return
  }
  const c = await cliente()
  let tiendas: TiendaRappi[]
  try {
    tiendas = await c.tiendasDelComercio(idToken)
  } catch (e) {
    logger.warn('🛵 [RappiOAuth] no se pudo re-leer integration-status', { intentId: intent.id, error: (e as Error).message })
    return
  }
  const seleccion = new Set(ids(intent.selectionJson))
  const resultados = objeto(intent.resultsJson)
  for (const t of tiendas) {
    const outcome = objeto(resultados[t.storeId]).outcome as string
    if (!seleccion.has(t.storeId) || !t.integrated || !t.integrationId || !ESPERANDO.has(outcome)) continue
    await confirmarTienda(
      { storeId: t.storeId, status: 'ACTIVE', integrationId: t.integrationId },
      { suscribir: c.suscribirTiendaAEventos },
      { intentId: intent.id },
    )
  }
  await cerrarSiTodoFinal(intent.id)
}

const CONFIRMANDO = 'Rappi la está confirmando — recarga esta página en un minuto.'
const TEXTO: Record<string, string> = {
  PROVISIONING: CONFIRMANDO,
  UNCERTAIN: CONFIRMANDO,
  SUBSCRIBE_FAILED: CONFIRMANDO,
  ACTIVATED: '<span class="ok">Conectada.</span>',
  ALREADY_CONNECTED: '<span class="ok">Ya estaba conectada a este negocio.</span>',
  NOT_ENABLED_FOR_PILOT: '<span class="bad">Esta tienda todavía no está habilitada para el piloto; escríbenos.</span>',
  OTHER_VENUE: '<span class="bad">Esta tienda ya está conectada a otro negocio de Avoqado.</span>',
  CLAIMED_BY_OTHER: '<span class="bad">Otra conexión está en curso para esta tienda; intenta en unos minutos.</span>',
  FAILED: '<span class="bad">No se pudo conectar; intenta de nuevo.</span>',
}

function textoResultado(r: ResultadoRappi | undefined, activando: boolean): string {
  if (r?.outcome === 'REJECTED') return `<span class="bad">Rappi la rechazó${r.detalle ? `: ${esc(r.detalle)}` : ''}.</span>`
  // Fuera de ACTIVATING ya nadie re-lee: «recarga» mentiría (el webhook todavía puede confirmarla).
  if (!r || ESPERANDO.has(r.outcome))
    return activando ? CONFIRMANDO : '<span class="bad">Rappi todavía no la confirma; revisa su estado en el dashboard de Avoqado.</span>'
  return TEXTO[r.outcome] ?? esc(r.outcome)
}

function paginaResultado(i: DeliveryConnectIntent, negocio: string): string {
  const seleccion = ids(i.selectionJson)
  if (!seleccion.length) return paginaFallo(i.failureReason ?? 'EXPIRED')
  const nombres = new Map(((i.storesJson as TiendaRappi[] | null) ?? []).map(t => [t.storeId, t.name]))
  const resultados = objeto(i.resultsJson)
  const activando = i.state === 'ACTIVATING'
  const filas = seleccion
    .map(
      s =>
        `<li><strong>${esc(nombres.get(s) ?? s)}</strong> <code>${esc(s)}</code><br>` +
        `${textoResultado(resultados[s] as ResultadoRappi | undefined, activando)}</li>`,
    )
    .join('')
  const pie = i.state === 'FAILED' && i.failureReason ? `<p class="bad">${esc(textoMotivo(i.failureReason))}</p>` : ''
  return page(
    activando ? 'Conectando con Rappi' : 'Resultado de la conexión',
    `<p>Tiendas de Rappi para <strong>${esc(negocio)}</strong> en Avoqado:</p><ul>${filas}</ul>${pie}`,
  )
}

/** `GET /oauth/result?intent=` — lo que pasó con cada tienda; mientras Rappi confirma, re-lee su estado. */
export const resultadoRappiOAuth = publica('No se pudo mostrar el resultado', async (req, res, ctx) => {
  const deps = await depsDesdeEnv()
  const intent = await abrir(res, deps, req.query.intent, 'result', ctx)
  if (!intent) return
  if (intent.state === 'ACTIVATING') await reChequear(deps, intent)
  // Se relee: el re-chequeo (o un webhook) pudo haber avanzado los resultados.
  const actual = (await prisma.deliveryConnectIntent.findUnique({ where: { id: intent.id } })) ?? intent
  res.status(200).send(paginaResultado(actual, await nombreDelNegocio(intent.venueId)))
})
