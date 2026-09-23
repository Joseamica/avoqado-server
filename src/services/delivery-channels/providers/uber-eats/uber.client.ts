/**
 * Cliente de Uber Eats listo para usar — el ÚNICO borde que lee `@/config/env`.
 *
 * Deliberadamente DELGADO: no tiene tests unitarios porque importar `@/config/env`
 * ejecuta validación con `process.exit` y mata workers de Jest (regla del repo).
 * Por eso toda la lógica con riesgo —el par de hosts, el candado de escrituras, la
 * redacción del secret— vive en `uber.http.ts`, que es puro y sí está probado.
 * Aquí solo se resuelve configuración y se compone.
 */
import { DeliveryChannelStatus, DeliveryProvider } from '@prisma/client'

import { env } from '@/config/env'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'

import { DeliveryWriteNotSentError } from '../../core/types'
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

/**
 * SÓLO lo que dice la variable `UBER_WRITABLE_STORE_IDS_<ENV>`, normalizado. 🔴 NO es permiso de
 * escritura: nunca se le pasa a `uberRequest` como `writableStores` (en PRODUCTION saltaría el
 * consentimiento). Lo usan el candado (`getWritableStores`, para la intersección) y la activación,
 * que corre antes de que exista consentimiento (§4.3). En SANDBOX es la lista entera; en PRODUCTION
 * es una restricción (vacía no restringe).
 */
export function tiendasDeLaVariable(environment: UberEnvironment): Set<string> {
  const crudo = environment === 'SANDBOX' ? env.UBER_WRITABLE_STORE_IDS_SANDBOX : env.UBER_WRITABLE_STORE_IDS_PRODUCTION
  return parseWritableStoreIds(crudo)
}

/**
 * EL candado de escrituras (spec §4.3): tiendas a las que se puede escribir AHORA, consultado en cada
 * llamada, SIN caché — una revocación (`store.deprovisioned`) corta la siguiente escritura, no la de
 * dentro de un rato.
 *
 * - SANDBOX: sólo la variable, como siempre (el sandbox de Uber NO aísla producción: default-deny).
 * - PRODUCTION: vínculo `UBER_EATS` con consentimiento del dueño para ESTE ambiente, ESTA tienda
 *   (`ownerAuthorizedStoreId = externalLocationId`) y la app de Uber VIGENTE, en `ACTIVE` o `PAUSED`
 *   (pausar no revoca la autorización: la pausa se escribe antes de avisarle a Uber). La variable,
 *   definida, RESTRINGE por intersección y nunca amplía. Sin `UBER_CLIENT_ID_PRODUCTION` ⇒ nada.
 *
 * `soloTienda` acota la consulta a una tienda por el índice único `(provider, externalLocationId)`:
 * es lo que usa cada escritura. Si la base falla, lanza: la escritura no sale (falla cerrado).
 *
 * ponytail: una consulta indexada por escritura (son pocas por minuto); si algún día pesa, caché con
 * invalidación por `revocationVersion`, nunca por tiempo.
 */
export async function getWritableStores(
  environment: UberEnvironment = getUberEnvironment(),
  soloTienda?: string,
): Promise<Set<string>> {
  const variable = tiendasDeLaVariable(environment)
  if (environment === 'SANDBOX') return variable
  const clientId = env.UBER_CLIENT_ID_PRODUCTION
  if (!clientId) return new Set()

  let filas: Array<{ externalLocationId: string }>
  try {
    filas = await prisma.deliveryChannelLink.findMany({
      where: {
        provider: DeliveryProvider.UBER_EATS,
        ...(soloTienda !== undefined ? { externalLocationId: soloTienda } : {}),
        status: { in: [DeliveryChannelStatus.ACTIVE, DeliveryChannelStatus.PAUSED] },
        ownerAuthorizedEnvironment: 'PRODUCTION',
        ownerAuthorizedClientId: clientId,
        ownerAuthorizedStoreId: { equals: prisma.deliveryChannelLink.fields.externalLocationId },
      },
      select: { externalLocationId: true },
    })
  } catch (err) {
    logger.error('🚨 [Uber] no se pudo consultar el candado de escrituras — la escritura NO sale', {
      storeId: soloTienda,
      error: (err as Error).message,
    })
    throw err
  }
  return new Set(
    filas.map(f => f.externalLocationId.trim().toLowerCase()).filter(id => variable.size === 0 || variable.has(id)),
  )
}

/** Token de aplicación vigente (cacheado 30 días, single-flight). */
export async function getUberToken(): Promise<string> {
  const environment = getUberEnvironment()
  return getUberAppToken({
    fetchToken: createUberTokenFetcher({ environment, credentials: getCredentials(environment) }),
  })
}

/**
 * Petición autenticada a Uber, con el candado de escrituras ya aplicado. El candado se resuelve AQUÍ,
 * en cada escritura y antes del token y de la red; las lecturas no tocan la base. `uberRequest`
 * rechaza la escritura si la tienda no está en el `Set`.
 */
export async function uberApi(opts: UberRequestOptions): Promise<UberResponse> {
  const environment = getUberEnvironment()
  const escritura = opts.method !== 'GET'
  let writableStores = new Set<string>()
  let token: string
  try {
    if (escritura && opts.storeId) writableStores = await getWritableStores(environment, opts.storeId)
    token = await getUberToken()
  } catch (e) {
    // Una escritura que falla aquí NO salió: el caller no debe dejarla «en duda» (las lecturas, igual que siempre).
    if (!escritura) throw e
    throw new DeliveryWriteNotSentError('UNAVAILABLE', `No se envió nada a Uber: ${(e as Error).message}`)
  }
  return uberRequest({ environment, token, writableStores }, opts)
}

/**
 * Trae el pedido COMPLETO. El webhook solo manda un puntero (`resource_href`), no el
 * contenido: sin este GET no hay pedido que ingerir.
 *
 * Devuelve también el texto crudo — es lo que se congela como fixture real, y la
 * única forma honesta de escribir el mapper contra el formato de verdad.
 */
export async function fetchUberOrder(orderId: string, signal?: AbortSignal): Promise<UberResponse> {
  if (!orderId || typeof orderId !== 'string') {
    throw new Error(`fetchUberOrder requiere un orderId no vacío, recibió: ${JSON.stringify(orderId)}`)
  }

  // 🔴 uAPI (`/v1/delivery/*`), no la familia clásica (`/v2/eats/*`): la validación de Uber
  // (caso 59605086, 27-ago) rastrea SÓLO esta familia — las tiendas de prueba se
  // re-integraron a "API version 1.0.0". `expand=carts,payment` no es opcional: sin él el
  // pedido llega SIN artículos ni dinero (verificado: 1.1 KB pelones contra 5.2 KB
  // completos), y el mapper lo rechazaría por no poder determinar la venta.
  const r = await uberApi({ method: 'GET', path: `/v1/delivery/order/${encodeURIComponent(orderId)}?expand=carts,payment`, signal })

  if (r.status >= 400) {
    logger.warn('Uber devolvió error al traer el pedido', {
      orderId,
      status: r.status,
      cuerpo: r.text.slice(0, 300),
    })
  }
  return r
}
