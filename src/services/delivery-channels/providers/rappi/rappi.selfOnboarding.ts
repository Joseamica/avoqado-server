/**
 * Self-onboarding de Rappi — las piezas PURAS del flujo (doc: dev-portal.rappi.com/es/self-onboarding).
 *
 * 🔴 La trampa que la doc de Rappi grita y que cuesta un día entender: el `/oauth/token` devuelve
 * DOS tokens y el que sirve es el `id_token` (JWS, `alg: RS256`, 3 partes). El `access_token` es un
 * JWE opaco (`alg: dir`, 5 partes) y Rappi lo contesta con «401 Invalid merchant token signature».
 * Por eso `elegirIdToken` exige RS256 y NUNCA cae al `access_token`.
 *
 * Sin `@/config/env` ni red: todo se inyecta desde `rappi.client.ts`.
 */
import crypto from 'crypto'

export type AmbienteLogin = 'SANDBOX' | 'PRODUCTION'

export function hostDeLogin(ambiente: AmbienteLogin): string {
  return ambiente === 'PRODUCTION' ? 'https://login.partners.rappi.com' : 'https://login.partners.dev.rappi.com'
}

export function retoPkce(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url')
}

export function urlDeAutorizacion(p: {
  ambiente: AmbienteLogin
  clientId: string
  redirectUri: string
  state: string
  verifier: string
}): string {
  const u = new URL(`${hostDeLogin(p.ambiente)}/authorize`)
  u.searchParams.set('client_id', p.clientId)
  u.searchParams.set('redirect_uri', p.redirectUri)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('scope', 'openid profile email')
  u.searchParams.set('code_challenge', retoPkce(p.verifier))
  u.searchParams.set('code_challenge_method', 'S256')
  u.searchParams.set('state', p.state)
  return u.toString()
}

function algDe(jwt: string): string | null {
  try {
    return (JSON.parse(Buffer.from(jwt.split('.')[0], 'base64url').toString('utf8')) as { alg?: string }).alg ?? null
  } catch {
    return null
  }
}

export function elegirIdToken(respuesta: unknown): string {
  const t = (respuesta as { id_token?: unknown } | null)?.id_token
  if (typeof t !== 'string' || t.split('.').length !== 3 || algDe(t) !== 'RS256') throw new Error('RAPPI_ID_TOKEN_INVALIDO')
  return t
}

type Obj = Record<string, unknown>

/** Un objeto plano, o `null`: `null`, listas y escalares no son cuerpos que podamos leer. */
const objeto = (v: unknown): Obj | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null)

/** Rappi manda ids como texto o como número según el endpoint; siempre los comparamos como texto. */
const idTexto = (v: unknown): string | undefined => {
  if (typeof v === 'string') return v.trim() || undefined
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined
}

export interface TiendaRappi {
  storeId: string
  name: string
  brand?: string
  integrated: boolean
  parentId?: string
  /** Lo que Rappi devuelve al aprovisionar; la re-lectura de `integration-status` lo compara con el que guardamos (R7). */
  integrationId?: string
}

function aTienda(t: Obj | null, parentId?: string): TiendaRappi | null {
  const storeId = idTexto(t?.store_id)
  if (!t || !storeId) return null
  const integrationId = idTexto(t.integration_id)
  return {
    storeId,
    name: typeof t.name === 'string' && t.name.trim() ? t.name.trim() : storeId,
    ...(typeof t.brand === 'string' && t.brand ? { brand: t.brand } : {}),
    integrated: t.integrated === true,
    ...(parentId ? { parentId } : {}),
    ...(integrationId ? { integrationId } : {}),
  }
}

/** El árbol padre/hijas de `integration-status`, plano. Al aprovisionar cada tienda va sola (doc). */
export function aplanarTiendas(respuesta: unknown): TiendaRappi[] {
  const tiendas = objeto(respuesta)?.stores
  if (!Array.isArray(tiendas)) return []
  const out: TiendaRappi[] = []
  for (const p of tiendas.map(objeto)) {
    const padre = aTienda(p)
    if (!padre || !p) continue
    out.push(padre)
    for (const h of Array.isArray(p.children) ? p.children : []) {
      const hija = aTienda(objeto(h), padre.storeId)
      if (hija) out.push(hija)
    }
  }
  return out
}

export function enLotes<T>(xs: readonly T[], n = 20): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

export type RespuestaAprovisionamiento = {
  batchId?: string
  aceptadas: Array<{ storeId: string; integrationId?: string }>
  rechazadas: Array<{ storeId: string; motivo: string }>
  /** No sabemos qué pasó con estas: NO se borran ni se promueven, las resuelve el webhook o la re-lectura. */
  inciertas: string[]
}

/** Rappi RECHAZÓ la petición entera (credencial, permiso, cuerpo): no aprovisionó nada. */
const RECHAZO_DE_PETICION = new Set([400, 401, 403, 422])

/**
 * Clasifica la respuesta de `provision` en tres cubetas — R6, «incierta ≠ rechazada».
 *
 * 🔴 Por qué tres y no dos: rechazar una tienda BORRA su vínculo PENDING. Un 5xx, un 424 o un `202 {}`
 * no dicen que Rappi no aprovisionó — dicen que no sabemos, y Rappi pudo haber empezado. Tratarlos como
 * rechazo borraría un vínculo que la confirmación (webhook o re-lectura) va a querer promover; tratarlos
 * como aceptados dejaría un vínculo esperando algo que quizá nunca llegue. Por eso lo desconocido es su
 * propia cubeta y conserva el vínculo.
 *
 * - `202` con cuerpo legible: cada PEDIDA cae en `accepted[]` (aceptada), `rejected[]` (rechazada) o en
 *   ninguna/en las dos (incierta). Lo que Rappi menciona y no pedimos se ignora.
 * - `400/401/403/422`: todas rechazadas, `HTTP_<status>`.
 * - Cualquier otro status (424, 5xx, 200 raro…), o un `202` vacío/ilegible: todas inciertas.
 */
export function leerRespuestaAprovisionamiento(status: number, raw: string, pedidas: readonly string[]): RespuestaAprovisionamiento {
  const ids = [...new Set(pedidas)]
  const todasInciertas = (): RespuestaAprovisionamiento => ({ aceptadas: [], rechazadas: [], inciertas: ids })

  if (RECHAZO_DE_PETICION.has(status)) {
    return { aceptadas: [], rechazadas: ids.map(storeId => ({ storeId, motivo: `HTTP_${status}` })), inciertas: [] }
  }
  if (status !== 202) return todasInciertas()

  let cuerpo: Obj | null
  try {
    cuerpo = objeto(JSON.parse(raw))
  } catch {
    cuerpo = null
  }
  if (!cuerpo) return todasInciertas()

  const lista = (xs: unknown) =>
    (Array.isArray(xs) ? xs.map(objeto) : []).flatMap(x =>
      x && idTexto(x.store_id) ? [{ storeId: idTexto(x.store_id) as string, x }] : [],
    )
  const aceptadas = new Map(lista(cuerpo.accepted).map(({ storeId, x }) => [storeId, idTexto(x.integration_id)]))
  const rechazadas = new Map(
    lista(cuerpo.rejected).map(({ storeId, x }) => [storeId, typeof x.reason === 'string' && x.reason ? x.reason : 'rejected']),
  )

  const out: RespuestaAprovisionamiento = {
    ...(typeof cuerpo.batch_id === 'string' && cuerpo.batch_id ? { batchId: cuerpo.batch_id } : {}),
    aceptadas: [],
    rechazadas: [],
    inciertas: [],
  }
  // Recorrer las PEDIDAS (no lo que Rappi trae) es lo que descarta ids ajenos y deja como incierta a la que no salió.
  for (const storeId of ids) {
    const aceptada = aceptadas.has(storeId)
    const rechazada = rechazadas.has(storeId)
    if (aceptada && !rechazada) {
      const integrationId = aceptadas.get(storeId)
      out.aceptadas.push({ storeId, ...(integrationId ? { integrationId } : {}) })
    } else if (rechazada && !aceptada) {
      out.rechazadas.push({ storeId, motivo: rechazadas.get(storeId) as string })
    } else {
      out.inciertas.push(storeId) // en ninguna lista, o en las dos: Rappi no nos dijo (o se contradijo)
    }
  }
  return out
}

export type ResultadoRappiTienda = {
  storeId: string
  status: 'ACTIVE' | 'INACTIVE' | 'FAILED'
  errorMessage?: string
  httpCode?: number
  integrationId?: string
}
const ESTADOS = new Set(['ACTIVE', 'INACTIVE', 'FAILED'])

export function leerEstadoAprovisionamiento(payload: unknown): {
  batchId?: string
  operation?: 'PROVISION' | 'DEPROVISION'
  results: ResultadoRappiTienda[]
} {
  const p = objeto(payload) ?? {}
  const results = (Array.isArray(p.results) ? p.results : []).flatMap((r): ResultadoRappiTienda[] => {
    const o = objeto(r)
    const storeId = idTexto(o?.storeId)
    if (!o || !storeId || !ESTADOS.has(String(o.status))) return []
    const integrationId = idTexto(o.integrationId)
    return [
      {
        storeId,
        status: String(o.status) as ResultadoRappiTienda['status'],
        ...(typeof o.errorMessage === 'string' ? { errorMessage: o.errorMessage } : {}),
        ...(typeof o.httpCode === 'number' ? { httpCode: o.httpCode } : {}),
        ...(integrationId ? { integrationId } : {}),
      },
    ]
  })
  return {
    ...(typeof p.batchId === 'string' ? { batchId: p.batchId } : {}),
    ...(p.operation === 'PROVISION' || p.operation === 'DEPROVISION' ? { operation: p.operation } : {}),
    results,
  }
}
