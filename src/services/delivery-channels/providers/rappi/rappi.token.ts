/**
 * Token de Rappi — caché con single-flight, por superficie.
 *
 * 🔴 TRES SUPERFICIES, TRES TOKENS. Rappi no tiene un solo login: son endpoints distintos y
 * **el token de uno no sirve en otro**. El login es
 * `{hostDeLoginRappi}/restaurants/auth/v1/token/login/<superficie>/` (dominio nuevo, con barra final; ver `rappi.http.ts`):
 *
 *   `token/login/integrations/` → pedidos, menú, disponibilidad, tiendas
 *   `token/login/utils/`        → horarios (pasillo, producto, tienda)
 *   `token/login/finance/`      → pagos, comisiones, compensaciones
 *
 * Cachearlos juntos sería el bug clásico: pedir el horario con el token de pedidos, recibir
 * 401, y no entender por qué si "el token está fresco". La caché es por superficie.
 *
 * ⚠️ El token dura UNA SEMANA. Es muchísimo comparado con Uber (30 días pero con tope de 100
 * al día); aquí el riesgo no es pedir de más sino **quedarse con uno vencido**: una semana es
 * tiempo de sobra para que un despliegue, un reinicio o un reloj desfasado lo dejen viejo. Por
 * eso se renueva con un día de anticipación, no en el último minuto.
 *
 * 🔴 Y el header NO es `Authorization`: es **`x-authorization`**. Un cliente HTTP normal manda
 * el estándar y Rappi responde 401 sin explicar nada. Por eso el header lo arma este módulo y
 * no cada sitio de llamada — un solo lugar donde equivocarse.
 *
 * Módulo PURO: no importa `@/config/env` (eso hace `process.exit` al cargarse y mataría
 * workers de Jest — regla del repo). El caller inyecta cómo se pide el token.
 */

export type SuperficieRappi = 'integrations' | 'utils' | 'finance'

/** RFC6750 §2.1: un token inutilizable no debe anunciar recuperación ni entrar en caché. */
export function tokenRappiValido(token: unknown): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9._~+/-]+=*$/.exec(token)?.[0] === token
}

export interface RappiTokenDeps {
  /** Pide el token a Rappi. Lo implementa quien sí puede leer env y hablar HTTP. */
  fetchToken: (superficie: SuperficieRappi) => Promise<{ access_token: string; expires_in?: number }>
  now?: () => number
}

/** Una semana, que es lo que Rappi documenta, por si no manda `expires_in`. */
const VIGENCIA_POR_DEFECTO_MS = 7 * 24 * 3600 * 1000

/**
 * Se renueva con un DÍA de anticipación. Con una vigencia de una semana el costo de renovar
 * antes es despreciable, y lo que se evita —una llamada con token vencido a media comida— no.
 */
const MARGEN_RENOVACION_MS = 24 * 3600 * 1000
/** Con menos de esto de vida, el token no se guarda: la siguiente llamada vuelve a pedirlo. */
const MARGEN_MINIMO_MS = 60 * 1000

/**
 * 🔴 D6 (26-oct): Rappi entrega el MISMO token hasta que vence (medido en DEV el 25-oct: pedirlo otra vez devolvió el de siempre
 * con 23 h de vida). Con el margen fijo de un día, en su último día nunca quedaba en caché: cada llamada pedía login, y el script
 * de avisos no encontraba el token para sacar el `azp`. Por eso, a un token que llega con menos de dos días, el margen es la
 * MITAD de su vida (con piso de un minuto): se vuelve a pedir pocas veces y siempre antes de que venza.
 */
const margenPara = (vigenciaMs: number): number => Math.min(MARGEN_RENOVACION_MS, Math.max(MARGEN_MINIMO_MS, vigenciaMs / 2))

interface Entrada {
  token: string
  venceEnMs: number
  margenMs: number
}

const cache = new Map<SuperficieRappi, Entrada>()
/**
 * Superficies cuyo login viene fallando (ver `anotarLoginFallido`) y cuándo salió su último 🚨 (ms). En memoria, como la caché:
 * se pierde al reiniciar (a lo más, un 🚨 de más).
 */
const loginsEnRacha = new Map<SuperficieRappi, number>()

/** Mientras una racha siga, el 🚨 se repite cada hora: una caída de login de días no puede callarse tras el primer aviso. */
export const REPETIR_ALARMA_DE_LOGIN_MS = 60 * 60 * 1000
const enVuelo = new Map<SuperficieRappi, Promise<string>>()
let generacion = 0

export function _resetRappiTokenCacheForTests(): void {
  cache.clear()
  enVuelo.clear()
  loginsEnRacha.clear()
  generacion++
}

export async function getRappiToken(superficie: SuperficieRappi, deps: RappiTokenDeps): Promise<string> {
  const ahora = deps.now ?? Date.now

  const guardado = cache.get(superficie)
  if (guardado && guardado.venceEnMs - ahora() > guardado.margenMs) return guardado.token

  // Single-flight POR SUPERFICIE: si tres pedidos entran a la vez sólo se pide un token, pero
  // pedir el de `utils` no debe esperar al de `integrations` — son independientes.
  const yaVaEnCamino = enVuelo.get(superficie)
  if (yaVaEnCamino) return yaVaEnCamino

  const gen = generacion
  const peticion = (async () => {
    const r = await deps.fetchToken(superficie)
    if (!tokenRappiValido(r?.access_token)) throw new Error(`[Rappi] la respuesta de ${superficie} no trae access_token válido`)

    // Nunca cachear si hubo un reset mientras esta petición viajaba: guardaría un token de
    // credenciales que ya nadie está usando.
    if (gen === generacion) {
      const vigencia =
        Number.isFinite(r.expires_in) && (r.expires_in as number) > 0 ? (r.expires_in as number) * 1000 : VIGENCIA_POR_DEFECTO_MS
      cache.set(superficie, { token: r.access_token, venceEnMs: ahora() + vigencia, margenMs: margenPara(vigencia) })
    }
    return r.access_token
  })()

  enVuelo.set(superficie, peticion)
  try {
    return await peticion
  } finally {
    if (enVuelo.get(superficie) === peticion) enVuelo.delete(superficie)
  }
}

/**
 * El header de autorización de Rappi.
 *
 * 🔴 `x-authorization`, NO `Authorization`. Está aquí, en una función, precisamente para que
 * nadie lo escriba a mano en un sitio de llamada y se equivoque: el síntoma sería un 401 sin
 * explicación, con el token correcto.
 */
export function cabeceraRappi(token: string): Record<string, string> {
  return { 'x-authorization': `Bearer ${token}` }
}

/**
 * Invalida el token de una superficie. Se llama cuando Rappi responde 401: puede que lo hayan
 * revocado antes de que venciera, y reintentar con el mismo daría 401 para siempre.
 */
export function invalidarToken(superficie: SuperficieRappi): void {
  cache.delete(superficie)
}

/**
 * Lleva la cuenta de una RACHA de logins rechazados, por superficie, para que el aviso no grite en cada intento (Tarea 20).
 *
 * 🔴 Sin esto, un login rechazado gritaba 🚨 en CADA intento, y con el sondeo de pedidos prendido son ~2 intentos cada 45 s:
 * miles de 🚨 al día por UNA causa. Devuelve `true` si a este fallo le toca el 🚨: el que EMPIEZA la racha, y después uno por
 * hora (`REPETIR_ALARMA_DE_LOGIN_MS`) mientras la racha siga, para que una caída de días (con ventas reales sin poder
 * aceptarse) no pase con un solo aviso del primer día. Los demás devuelven `false` (van como warn). No cambia nada del token:
 * quien llama sigue recibiendo el mismo error.
 */
export function anotarLoginFallido(superficie: SuperficieRappi): boolean {
  const ahora = Date.now()
  const ultimo = loginsEnRacha.get(superficie)
  if (ultimo !== undefined && ahora - ultimo < REPETIR_ALARMA_DE_LOGIN_MS) return false
  loginsEnRacha.set(superficie, ahora)
  return true
}

/** El primer login bueno cierra la racha y REARMA el aviso. `true` si había una racha abierta (para decir que volvió). */
export function anotarLoginExitoso(superficie: SuperficieRappi): boolean {
  return loginsEnRacha.delete(superficie)
}
