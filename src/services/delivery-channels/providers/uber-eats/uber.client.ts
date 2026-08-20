/**
 * Cliente de Uber Eats listo para usar — el ÚNICO borde que lee `@/config/env`.
 *
 * Deliberadamente DELGADO: no tiene tests unitarios porque importar `@/config/env`
 * ejecuta validación con `process.exit` y mata workers de Jest (regla del repo).
 * Por eso toda la lógica con riesgo —el par de hosts, el candado de escrituras, la
 * redacción del secret— vive en `uber.http.ts`, que es puro y sí está probado.
 * Aquí solo se resuelve configuración y se compone.
 */
import { env } from '@/config/env'
import logger from '@/config/logger'

import { createUberTokenFetcher, uberRequest, type UberRequestOptions, type UberResponse } from './uber.http'

export { orderIdFromResourceHref } from './uber.http'
import { parseWritableStoreIds, type UberEnvironment } from './uber.storeAllowlist'
import { getUberAppToken } from './uber.token'

export function getUberEnvironment(): UberEnvironment {
  return env.UBER_ENVIRONMENT as UberEnvironment
}

/**
 * Credenciales del ambiente ACTIVO. Lanza si faltan: es preferible un error legible
 * al primer uso que un 401 opaco de Uber tres capas más abajo.
 */
function getCredentials(environment: UberEnvironment): { clientId: string; clientSecret: string } {
  const clientId = environment === 'SANDBOX' ? env.UBER_CLIENT_ID_SANDBOX : env.UBER_CLIENT_ID_PRODUCTION
  const clientSecret = environment === 'SANDBOX' ? env.UBER_CLIENT_SECRET_SANDBOX : env.UBER_CLIENT_SECRET_PRODUCTION

  if (!clientId || !clientSecret) {
    const sufijo = environment === 'SANDBOX' ? 'SANDBOX' : 'PRODUCTION'
    throw new Error(
      `Faltan credenciales de Uber para el ambiente ${environment}: define UBER_CLIENT_ID_${sufijo} y ` +
        `UBER_CLIENT_SECRET_${sufijo} en el .env. Se obtienen en el dashboard de Uber → la organización ` +
        `de ese ambiente → la app → Credentials.`,
    )
  }
  return { clientId, clientSecret }
}

/** Lista blanca de tiendas escribibles del ambiente ACTIVO. Vacía ⇒ cero escrituras. */
export function getWritableStores(environment: UberEnvironment = getUberEnvironment()): Set<string> {
  const crudo = environment === 'SANDBOX' ? env.UBER_WRITABLE_STORE_IDS_SANDBOX : env.UBER_WRITABLE_STORE_IDS_PRODUCTION
  return parseWritableStoreIds(crudo)
}

/** Token de aplicación vigente (cacheado 30 días, single-flight). */
export async function getUberToken(): Promise<string> {
  const environment = getUberEnvironment()
  return getUberAppToken({
    fetchToken: createUberTokenFetcher({ environment, credentials: getCredentials(environment) }),
  })
}

/** Petición autenticada a Uber, con el candado de escrituras ya aplicado. */
export async function uberApi(opts: UberRequestOptions): Promise<UberResponse> {
  const environment = getUberEnvironment()
  return uberRequest({ environment, token: await getUberToken(), writableStores: getWritableStores(environment) }, opts)
}

/**
 * Trae el pedido COMPLETO. El webhook solo manda un puntero (`resource_href`), no el
 * contenido: sin este GET no hay pedido que ingerir.
 *
 * Devuelve también el texto crudo — es lo que se congela como fixture real, y la
 * única forma honesta de escribir el mapper contra el formato de verdad.
 */
export async function fetchUberOrder(orderId: string): Promise<UberResponse> {
  if (!orderId || typeof orderId !== 'string') {
    throw new Error(`fetchUberOrder requiere un orderId no vacío, recibió: ${JSON.stringify(orderId)}`)
  }

  const r = await uberApi({ method: 'GET', path: `/v2/eats/order/${encodeURIComponent(orderId)}` })

  if (r.status >= 400) {
    logger.warn('Uber devolvió error al traer el pedido', {
      orderId,
      status: r.status,
      cuerpo: r.text.slice(0, 300),
    })
  }
  return r
}
