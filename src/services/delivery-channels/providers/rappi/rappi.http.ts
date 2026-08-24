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
 * Módulo PURO: `fetchImpl`, el token y la lista de tiendas se inyectan. No lee `@/config/env`
 * (importarlo hace `process.exit` y mata workers de Jest — regla del repo).
 */
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

export class RappiEscrituraBloqueadaError extends Error {
  constructor(readonly storeId: string) {
    super(
      `[Rappi] escritura BLOQUEADA para la tienda ${storeId}: no está en la lista de tiendas autorizadas. ` +
        'Es el candado que impide tocar el comercio de alguien más — agrégala explícitamente si de verdad es tuya.',
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
    assertTiendaEscribible(peticion.storeId, deps.tiendasEscribibles ?? [])
  }

  const url = `${hostRappi(deps.ambiente, deps.pais)}${peticion.ruta}`

  const intentar = async (): Promise<RappiRespuesta> => {
    const token = await deps.getToken(peticion.superficie)
    const r = await deps.fetchImpl(url, {
      method: peticion.metodo,
      headers: {
        ...cabeceraRappi(token),
        ...(peticion.cuerpo !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(peticion.cuerpo !== undefined ? { body: JSON.stringify(peticion.cuerpo) } : {}),
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
