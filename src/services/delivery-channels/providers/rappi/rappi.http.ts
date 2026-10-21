/**
 * Cliente HTTP de Rappi — hosts, token, candado de escritura y el ritmo del sondeo.
 *
 * 🔴 EL CANDADO DE TIENDAS EXISTE POR UN INCIDENTE REAL, Y APLICA IGUAL AQUÍ. El 2026-08-17 un
 * token de sandbox de Uber escribió el menú EN VIVO de un restaurante real. La lección no fue
 * "usa sandbox": fue que **ninguna escritura debe poder salir a la red sin que su tienda esté
 * en una lista explícita**. Rappi tiene la misma exposición y peor: las tiendas se provisionan
 * por lote, así que basta un id de más en un arreglo para tocar un comercio que no era.
 *
 * Por eso el candado vive en el punto MÁS BAJO —aquí— y no en cada sitio de llamada: un caller
 * nuevo no puede olvidarlo. Si el método no es de lectura y la tienda no está autorizada, la
 * petición no sale.
 *
 * 🔴 UN SOLO HOST POR AMBIENTE, y el de México se escribe raro a propósito de nadie:
 * `services.mxgrability.rappi.com`. No hay forma de pedir el token de pruebas contra el host de
 * producción: se resuelven del mismo `ambiente` o no se resuelven.
 *
 * 🔴 DOS DOMINIOS (medido el 20-oct-2026): la API (`/api/v2/restaurants-integrations-public-api`,
 * `/api/rest-ops-utils`) sigue en el host clásico de `hostRappi`; el LOGIN se mudó al dominio nuevo de
 * `hostDeLoginRappi` y su ruta lleva barra final (sin ella, 307).
 *
 * Módulo PURO: `fetchImpl`, el token y la lista de tiendas se inyectan. No lee `@/config/env`
 * (importarlo hace `process.exit` y mata workers de Jest — regla del repo).
 */
import { DeliveryWriteNotSentError } from '../../core/types'
import { cabeceraRappi, invalidarToken, type SuperficieRappi } from './rappi.token'

export type AmbienteRappi = 'SANDBOX' | 'PRODUCTION'

/** País → host de producción. Sólo México por ahora; agregar uno es una línea. */
export const HOSTS_PRODUCCION: Readonly<Record<string, string>> = {
  MX: 'https://services.mxgrability.rappi.com',
  CO: 'https://services.rappi.com',
  AR: 'https://services.rappi.com.ar',
  BR: 'https://services.rappi.com.br',
  CL: 'https://services.rappi.cl',
  CR: 'https://services.rappi.co.cr',
  EC: 'https://services.rappi.com.ec',
  PE: 'https://services.rappi.pe',
  UY: 'https://services.rappi.com.uy',
}

const HOST_SANDBOX = 'https://microservices.dev.rappi.com'

/**
 * El host del ambiente. Un país desconocido en producción LANZA en vez de caer a México: un
 * default silencioso mandaría los pedidos de un país al host de otro, y el síntoma sería
 * "no encuentra la tienda" sin ninguna pista de por qué.
 */
export function hostRappi(ambiente: AmbienteRappi, pais = 'MX'): string {
  if (ambiente === 'SANDBOX') return HOST_SANDBOX
  const host = HOSTS_PRODUCCION[pais.trim().toUpperCase()]
  if (!host)
    throw new Error(`[Rappi] no hay host de producción para el país "${pais}". Países válidos: ${Object.keys(HOSTS_PRODUCCION).join(', ')}`)
  return host
}

const HOST_LOGIN_SANDBOX = 'https://api.dev.rappi.com'
const HOST_LOGIN_PRODUCCION_MX = 'https://api.rappi.com.mx'

/**
 * El dominio NUEVO de Rappi: el del login (`/restaurants/auth/v1/token/login/{superficie}/`) y el del self-onboarding.
 * La API de pedidos, menú y Utils NO va aquí: sigue en `hostRappi`. Sólo México está publicado en producción; otro país
 * LANZA en vez de caer al de México, por la misma razón que `hostRappi`. Sandbox lo ignora.
 */
export function hostDeLoginRappi(ambiente: AmbienteRappi, pais = 'MX'): string {
  if (ambiente === 'SANDBOX') return HOST_LOGIN_SANDBOX
  if (pais.trim().toUpperCase() !== 'MX') {
    throw new Error(
      `[Rappi] el dominio nuevo (login y self-onboarding) sólo está publicado para México en producción; país "${pais}" no soportado`,
    )
  }
  return HOST_LOGIN_PRODUCCION_MX
}

/**
 * 🔴 Es un «no se envió»: el candado salta ANTES de la red, así que se SABE que Rappi no recibió nada. Por eso extiende
 * `DeliveryWriteNotSentError` (`STORE_NOT_AUTHORIZED`, igual que `UberStoreWriteBlockedError`): la cocina lo recibe como un
 * 409 en vez de un 500 sin explicación. `instanceof RappiEscrituraBloqueadaError` sigue valiendo.
 *
 * 🔴 `paraLaCocina`: NO es «desconectada». El candado es la lista de tiendas del entorno (`RAPPI_WRITABLE_STORE_IDS_*`); reconectar desde el
 * panel no la abre (el aprovisionamiento contesta `NOT_ENABLED_FOR_PILOT`), así que a la cocina no se le manda a «reconectar».
 */
export class RappiEscrituraBloqueadaError extends DeliveryWriteNotSentError {
  constructor(readonly storeId: string) {
    super(
      'STORE_NOT_AUTHORIZED',
      `[Rappi] escritura BLOQUEADA para la tienda ${storeId}: no está en la lista de tiendas autorizadas. ` +
        'Es el candado que impide tocar el comercio de alguien más — agrégala explícitamente si de verdad es tuya.',
      'Rappi todavía no está habilitada para esta tienda; avisa a soporte de Avoqado.',
    )
    this.name = 'RappiEscrituraBloqueadaError'
  }
}

const LECTURAS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * ¿Se puede escribir en esta tienda?
 *
 * Lista VACÍA = nada se puede escribir. Es la falla segura y es deliberada: durante todo el
 * desarrollo la lista está vacía, así que ninguna prueba puede tocar un comercio real por
 * accidente. Abrirla es un acto explícito, el día del piloto.
 */
export function assertTiendaEscribible(storeId: string | undefined, autorizadas: readonly string[]): void {
  const id = storeId?.trim()
  if (!id || !autorizadas.some(a => a.trim() === id)) throw new RappiEscrituraBloqueadaError(id || '(sin id)')
}

export interface RappiHttpDeps {
  ambiente: AmbienteRappi
  pais?: string
  fetchImpl: typeof fetch
  /** Devuelve el token vigente de esa superficie (lo cachea `rappi.token.ts`). */
  getToken: (superficie: SuperficieRappi) => Promise<string>
  /** Tiendas en las que SÍ se puede escribir. Vacía = ninguna. */
  tiendasEscribibles?: readonly string[]
}

/**
 * Techo de espera de CUALQUIER llamada a Rappi (API, login y canje OAuth). Sin él, una llamada colgada
 * sostenía la pasada de la reconciliación y detrás de ella esperaban los pedidos. Uno vencido LANZA, igual
 * que un fallo de red: quien llama lo trata como tal (un aprovisionamiento queda incierto, no rechazado).
 */
export const TIMEOUT_RAPPI_MS = 10_000

export interface RappiRespuesta {
  ok: boolean
  status: number
  raw: string
}

export interface RappiPeticion {
  superficie: SuperficieRappi
  metodo: string
  ruta: string
  cuerpo?: unknown
  /** Obligatorio en escrituras: es lo que el candado revisa. */
  storeId?: string
  /** Host alterno: los endpoints del self-onboarding viven en otro dominio que el resto de la API. */
  host?: string
  /** El self-onboarding manda DOS tokens: el del integrador (`x-authorization`) y el del comercio. */
  cabecerasExtra?: Record<string, string>
  /** Escrituras de varias tiendas (aprovisionar): el candado revisa CADA una. */
  storeIds?: readonly string[]
}

/**
 * Hace la llamada.
 *
 * 🔴 Ante un 401 invalida el token y reintenta UNA vez. Rappi puede revocar un token antes de
 * que venza, y sin esto reintentaríamos con el mismo para siempre. Una sola vez, no en bucle:
 * si el segundo también da 401 el problema son las credenciales, y machacar sólo empeora la
 * tasa de éxito del 98% que Rappi exige.
 */
export async function llamarRappi(deps: RappiHttpDeps, peticion: RappiPeticion): Promise<RappiRespuesta> {
  if (!LECTURAS.has(peticion.metodo.toUpperCase())) {
    const autorizadas = deps.tiendasEscribibles ?? []
    const tiendas = peticion.storeIds ?? [peticion.storeId]
    // Un lote vacío no es un pase libre: sin ninguna tienda que revisar, el candado se niega igual.
    if (tiendas.length === 0) assertTiendaEscribible(undefined, autorizadas)
    for (const t of tiendas) assertTiendaEscribible(t, autorizadas)
  }

  const url = `${peticion.host ?? hostRappi(deps.ambiente, deps.pais)}${peticion.ruta}`

  const intentar = async (): Promise<RappiRespuesta> => {
    const token = await deps.getToken(peticion.superficie)
    const r = await deps.fetchImpl(url, {
      method: peticion.metodo,
      headers: {
        ...cabeceraRappi(token),
        ...(peticion.cabecerasExtra ?? {}),
        ...(peticion.cuerpo !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(peticion.cuerpo !== undefined ? { body: JSON.stringify(peticion.cuerpo) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_RAPPI_MS),
    })
    return { ok: r.ok, status: r.status, raw: await r.text() }
  }

  const primera = await intentar()
  if (primera.status !== 401) return primera

  invalidarToken(peticion.superficie)
  return intentar()
}

/**
 * El ritmo del sondeo de pedidos.
 *
 * 🔴 Rappi lo pide textual en sus estándares: *"realiza solicitudes a la API de Rappi para
 * descargar órdenes dejando un intervalo de 45 segundos"*. Es SÓLO para descargar pedidos — no
 * aplica al menú ni a la disponibilidad, y confundirlo volvería lentísima la sincronización sin
 * necesidad.
 *
 * Es un espaciador, no un limitador: no rechaza, espera. Rechazar dejaría un ciclo de sondeo
 * sin correr, y perder una vuelta de sondeo es perder pedidos cuando el webhook falló — que es
 * exactamente para lo que el sondeo existe, porque Rappi **no documenta reintentos** de webhook.
 */
export const INTERVALO_SONDEO_MS = 45_000

export function crearEspaciadorDeSondeo(opts: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  // Por VENUE: dos negocios distintos no tienen por qué hacerse fila entre ellos — el límite
  // es sobre cuánto sondeamos una tienda, no sobre cuántas tiendas atendemos.
  const ultima = new Map<string, number>()

  return {
    async esperarTurno(venueId: string): Promise<void> {
      const previa = ultima.get(venueId)
      if (previa !== undefined) {
        const falta = INTERVALO_SONDEO_MS - (now() - previa)
        if (falta > 0) await sleep(falta)
      }
      ultima.set(venueId, now())
    },
    _reset(): void {
      ultima.clear()
    },
  }
}
