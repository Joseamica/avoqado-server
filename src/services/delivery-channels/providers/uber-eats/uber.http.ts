/**
 * Adaptador HTTP de Uber Eats — spec paso 2 (el adaptador real que `uber.token.ts` no hace).
 *
 * 🔴 POR QUÉ EL PAR login↔api ES INSEPARABLE: el 2026-08-17 un token de sandbox
 * escribió el menú EN VIVO de un restaurante real. La lección no fue "usa sandbox",
 * fue que el ambiente debe elegirse UNA vez y arrastrar sus DOS hosts juntos. Aquí
 * no existe forma de pedir el login de sandbox contra la API de producción: se
 * resuelven del mismo `environment` o no se resuelven.
 *
 * 🔴 TODA escritura pasa por el candado de tiendas, en el punto MÁS BAJO — este.
 * Un caller nuevo no puede olvidarlo: si el método no es GET y no trae `storeId`
 * autorizado, la petición no sale a la red.
 *
 * Módulo PURO: `fetchImpl` y credenciales se inyectan, nunca lee `@/config/env`
 * (importarlo hace `process.exit` y mata workers de Jest — regla del repo).
 */
import { assertStoreWritable, UberStoreWriteBlockedError, type UberEnvironment } from './uber.storeAllowlist'

export interface UberHosts {
  /** Dominio de OAuth. NUNCA se combina con el `api` de otro ambiente. */
  login: string
  /** Dominio de la API de negocio. */
  api: string
}

const HOSTS: Record<UberEnvironment, UberHosts> = {
  SANDBOX: { login: 'https://sandbox-login.uber.com', api: 'https://test-api.uber.com' },
  PRODUCTION: { login: 'https://auth.uber.com', api: 'https://api.uber.com' },
}

/**
 * Resuelve el par de hosts del ambiente. Un valor desconocido LANZA en vez de caer
 * a producción: un default silencioso aquí apunta a comercios reales.
 */
export function uberHostsFor(environment: UberEnvironment): UberHosts {
  const hosts = HOSTS[environment]
  if (!hosts) {
    throw new Error(`Ambiente de Uber desconocido: "${String(environment)}". Válidos: SANDBOX | PRODUCTION. No hay default.`)
  }
  return hosts
}

/** Techo de espera de CUALQUIER llamada a Uber. Ver la nota en `uberRequest`. */
const TIMEOUT_MS = 25_000

export interface UberCredentials {
  clientId: string
  clientSecret: string
}

/**
 * Scopes de Eats Marketplace. VERIFICADOS uno por uno contra la app real de sandbox
 * el 2026-08-20 — no copiados de la documentación.
 *
 * 🔴 Uber rechaza la petición ENTERA con `invalid_scope` si UNO solo no está
 * concedido: no ignora el sobrante ni devuelve un token parcial. Por eso esta lista
 * es exactamente lo concedido, y por eso pedir scopes "de más por si acaso" rompe
 * todo.
 *
 * `eats.pos_provisioning` NO va aquí, y no es un olvido: sólo existe en el flujo de
 * `authorization_code` (ver `buildUberAuthorizeUrl`), donde SÍ funciona. Meterlo en
 * esta lista tumba la obtención del token de aplicación por completo.
 * `eats.deliveries` tampoco está concedido a esta app.
 */
const DEFAULT_SCOPE = 'eats.store eats.order eats.store.status.write eats.store.orders.read eats.report'

export interface UberTokenFetcherDeps {
  environment: UberEnvironment
  credentials: UberCredentials
  scope?: string
  fetchImpl?: typeof fetch
}

/**
 * Construye el `fetchToken` que `getUberAppToken` inyecta. Devuelve la respuesta
 * CRUDA del proveedor: validar `access_token`/`expires_in` es responsabilidad de
 * la caché, que ya lo hace y no debe duplicarse.
 */
export function createUberTokenFetcher(deps: UberTokenFetcherDeps): () => Promise<{ access_token: string; expires_in: number }> {
  const { login } = uberHostsFor(deps.environment)
  const doFetch = deps.fetchImpl ?? fetch

  return async () => {
    const cuerpo = new URLSearchParams({
      client_id: deps.credentials.clientId,
      client_secret: deps.credentials.clientSecret,
      grant_type: 'client_credentials',
      scope: deps.scope ?? DEFAULT_SCOPE,
    })

    const r = await doFetch(`${login}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: cuerpo.toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    const texto = await r.text()
    if (r.status >= 400) {
      // El cuerpo de Uber puede repetir lo que le mandamos: se recorta y NUNCA se
      // interpola el secret, para que el mensaje sea pegable en un ticket.
      throw new Error(
        `Uber rechazó la petición de token: HTTP ${r.status} — ${redactar(texto, deps.credentials.clientSecret).slice(0, 300)}`,
      )
    }

    try {
      return JSON.parse(texto)
    } catch {
      throw new Error(`Uber devolvió un token ilegible (HTTP ${r.status}): ${texto.slice(0, 200)}`)
    }
  }
}

/** Quita el secret de cualquier texto antes de que llegue a un log o a una excepción. */
function redactar(texto: string, secret: string): string {
  if (!secret) return texto
  return texto.split(secret).join('«secret»')
}

/**
 * URL a la que se manda al COMERCIANTE para que autorice a Avoqado sobre sus tiendas.
 *
 * `eats.pos_provisioning` sólo existe en este flujo (authorization_code): el token de
 * aplicación lo rechaza con `invalid_scope` — verificado el 2026-08-20. Tiene sentido:
 * es un permiso que una PERSONA concede, no algo que una máquina pida sola.
 */
export function buildUberAuthorizeUrl(opts: {
  environment: UberEnvironment
  clientId: string
  redirectUri: string
  state: string
  scope?: string
}): string {
  const { login } = uberHostsFor(opts.environment)
  const q = new URLSearchParams({
    client_id: opts.clientId,
    response_type: 'code',
    redirect_uri: opts.redirectUri,
    scope: opts.scope ?? 'eats.pos_provisioning',
    state: opts.state,
  })
  return `${login}/oauth/v2/authorize?${q.toString()}`
}

export interface UberUserToken {
  access_token: string
  expires_in: number
  refresh_token?: string
  scope?: string
}

/**
 * Canjea el `code` de un solo uso por un token DEL COMERCIANTE.
 *
 * `redirect_uri` debe ser idéntico al usado al pedir la autorización: OAuth lo exige
 * como prueba de que quien canjea es quien pidió.
 */
export async function exchangeUberAuthCode(opts: {
  environment: UberEnvironment
  credentials: UberCredentials
  code: string
  redirectUri: string
  fetchImpl?: typeof fetch
}): Promise<UberUserToken> {
  const { login } = uberHostsFor(opts.environment)
  const doFetch = opts.fetchImpl ?? fetch

  const cuerpo = new URLSearchParams({
    client_id: opts.credentials.clientId,
    client_secret: opts.credentials.clientSecret,
    grant_type: 'authorization_code',
    redirect_uri: opts.redirectUri,
    code: opts.code,
  })

  const r = await doFetch(`${login}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: cuerpo.toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })

  const texto = await r.text()
  if (r.status >= 400) {
    throw new Error(`Uber rechazó el canje del código: HTTP ${r.status} — ${redactar(texto, opts.credentials.clientSecret).slice(0, 300)}`)
  }

  const json = JSON.parse(texto)
  if (typeof json?.access_token !== 'string' || json.access_token.length === 0) {
    throw new Error('Uber devolvió un canje sin access_token')
  }
  return json
}

/**
 * Extrae el id del pedido de un `resource_href` de webhook.
 *
 * 🔴 Se deriva el ID y se DESCARTA el host, en vez de pedirle a esa URL directamente.
 * El payload viene de fuera: aunque su firma sea válida, el host debe salir SIEMPRE
 * del ambiente configurado. Pegarle a la URL recibida convertiría el webhook en un
 * SSRF con firma — y en un camino por el que un token de producción podría acabar
 * viajando a un host que no es de Uber.
 */
export function orderIdFromResourceHref(href: unknown): string | null {
  if (typeof href !== 'string' || href.length === 0) return null
  // Las DOS familias: la clásica (`/eats/order/{id}`) y el uAPI (`/delivery/order/{id}`).
  // Las tiendas re-integradas a v1.0.0 pueden apuntar el webhook a cualquiera de las dos;
  // aceptar sólo una perdería pedidos completos en silencio — el webhook se ACKea con 200
  // y el puntero muere aquí.
  const m = href.match(/\/(?:eats|delivery)\/order\/([^/?#]+)/)
  if (!m) return null
  const id = decodeURIComponent(m[1]).trim()
  return id.length > 0 ? id : null
}

export interface UberRequestDeps {
  environment: UberEnvironment
  token: string
  /** Lista blanca de tiendas escribibles. Vacía ⇒ ninguna escritura sale. */
  writableStores: Set<string>
  fetchImpl?: typeof fetch
}

export interface UberRequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Ruta con la barra inicial, sin host: `/v1/delivery/order/{id}`. */
  path: string
  /** OBLIGATORIO en cualquier método distinto de GET: es lo que el candado autoriza. */
  storeId?: string
  body?: unknown
}

export interface UberResponse {
  status: number
  /** Cuerpo parseado, o `null` si no era JSON. Nunca lanza por un cuerpo raro. */
  json: unknown
  /** Cuerpo crudo — es lo que se congela como fixture real. */
  text: string
}

/**
 * Petición autenticada a la API de Uber. Aplica el candado a TODA escritura.
 * Devuelve la respuesta aunque sea 4xx/5xx: interpretar el status es del caller
 * (un 409 en accept significa "ya estaba aceptado", que es éxito).
 */
export async function uberRequest(deps: UberRequestDeps, opts: UberRequestOptions): Promise<UberResponse> {
  const esEscritura = opts.method !== 'GET'
  if (esEscritura) {
    // Sin storeId no hay nada que autorizar: se trata como bloqueo, no como excepción
    // genérica, para que el mensaje diga qué env var falta.
    if (!opts.storeId) throw new UberStoreWriteBlockedError('', deps.environment)
    assertStoreWritable(opts.storeId, deps.writableStores, deps.environment)

    // 🔴 El candado autoriza el storeId QUE DECLARA EL CALLER. Sin esto se puede declarar
    // una tienda permitida y mandar la escritura a OTRA: autorizar A y escribirle a B.
    // Hallado por auditoría externa el 2026-08-20.
    //
    // Sólo aplica a rutas DE TIENDA (`/stores/{id}/…`). Las rutas de PEDIDO
    // (`/v1/delivery/order/{orderId}/accept`) no llevan la tienda en la ruta y eso
    // es correcto — exigirla ahí rompería aceptar y rechazar pedidos.
    const enRuta = opts.path.match(/\/stores?\/([^/?#]+)/i)
    if (enRuta && decodeURIComponent(enRuta[1]).toLowerCase() !== opts.storeId.toLowerCase()) {
      throw new UberStoreWriteBlockedError(
        `${opts.storeId} (autorizado) no coincide con "${decodeURIComponent(enRuta[1])}" (destino real en la ruta ${opts.path})`,
        deps.environment,
      )
    }
  }

  // 🔴 `path` es ruta, no URL: sin esto, un `path` como "//evil.example/x" o ".evil.example/x"
  // produce un host distinto y le manda el bearer token. Debe empezar con UNA barra y no
  // llevar autoridad ni esquema.
  if (!opts.path.startsWith('/') || opts.path.startsWith('//') || /^[a-z]+:/i.test(opts.path)) {
    throw new Error(`Ruta de Uber inválida: "${opts.path}". Debe empezar con "/" y no llevar host ni esquema.`)
  }

  const { api } = uberHostsFor(deps.environment)
  const doFetch = deps.fetchImpl ?? fetch

  const headers: Record<string, string> = { Authorization: `Bearer ${deps.token}` }
  let cuerpo: string | undefined
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    cuerpo = JSON.stringify(opts.body)
  }

  // 🔴 TIMEOUT, o una llamada colgada congela lo que la esperaba (hallazgo de Codex, 4ª
  // pasada). El caso concreto: el job de reconciliación tiene un candado de "una pasada a la
  // vez"; si una llamada a Uber nunca responde, ese candado no se suelta NUNCA y el job deja
  // de rescatar pedidos para siempre, sin un solo error en el log. `fetch` de Node no trae
  // límite propio: espera indefinidamente.
  //
  // 25s: por debajo del plazo de ~11.5 min que Uber da para aceptar (así un reintento aún
  // llega a tiempo) y muy por encima de lo que tardan estas llamadas en la práctica.
  const r = await doFetch(`${api}${opts.path}`, {
    method: opts.method,
    headers,
    body: cuerpo,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const texto = await r.text()

  let json: unknown = null
  if (texto) {
    try {
      json = JSON.parse(texto)
    } catch {
      json = null
    }
  }

  return { status: r.status, json, text: texto }
}
