/**
 * 🔴 Codex pasada final (P1-2, 23-sep): el aviso del banco que llegó FIRMADO pero el servidor NO pudo guardar.
 *
 * Sin guardar no hay evento que el worker recupere ni evidencia que vete: si era la aprobación de un Pago rápido cuya terminal
 * perdió el callback, lo que queda es silencio, y el silencio de un comercio sano se lee como «no se cobró». El controlador
 * contesta 503 para que AngelPay reintente, y deja aquí dos marcas:
 *
 *  · por INTENTO (la llave del aviso): una aprobación —o un estado que no es un rechazo acreditado— que no se guardó es dinero
 *    conocido ⇒ ni la liberación automática ni la declaración del cajero pueden decir «no se cobró» sobre ese intento. No
 *    caduca: si AngelPay reintenta y el aviso aterriza, la evidencia durable ya dice lo mismo; si no reintenta, es lo único que
 *    queda. Sólo con la firma VERIFICADA — un cuerpo sin firma nunca puede crear un veto (sería una forma de congelar terminales).
 *  · por COMERCIO: su canal de avisos acaba de fallar ⇒ su silencio no está comprobado durante `VENTANA_SIN_CANAL_MS`, contada
 *    desde la ÚLTIMA falla. Cubre también el aviso sin llave, que no se puede atar a ningún intento.
 *
 * Vive en memoria A PROPÓSITO: el aviso no se guardó porque la base falló, así que tampoco se puede guardar esto en ella. Vale
 * porque producción corre en UNA sola instancia (`.claude/rules/una-sola-instancia.md`, fila «avisos no guardados»).
 * ⚠️ Residual declarado, gemelo del de la terminal (`evidenciaSinGuardar`): un reinicio del proceso las pierde; si además
 * AngelPay no reintentó, esa aprobación sólo consta en el panel de AngelPay.
 */
import logger from '@/config/logger'

export const VENTANA_SIN_CANAL_MS = 30 * 60_000
/** Cada llave pesa decenas de bytes; el tope sólo existe para que una caída prolongada no crezca sin límite. */
export const TOPE_DE_INTENTOS = 50_000
/** Los comercios reales son decenas; el tope existe porque en la búsqueda caída el id viene de la URL, sin verificar. */
export const TOPE_DE_COMERCIOS = 10_000

// `Set` y `Map` conservan el orden de inserción: el primero es el más viejo.
const intentosConDinero = new Set<string>()
const ultimaFallaPorComercio = new Map<string, number>()

export function registrarAvisoNoGuardado(
  aviso: { merchantAccountId: string; attemptId: string | null; posibleDinero: boolean },
  ahora = Date.now(),
): void {
  const previa = ultimaFallaPorComercio.get(aviso.merchantAccountId)
  if (previa === undefined || ahora > previa) {
    // Borrar y volver a poner deja el orden de inserción = el de la ÚLTIMA falla: el primero es la falla más vieja.
    ultimaFallaPorComercio.delete(aviso.merchantAccountId)
    if (ultimaFallaPorComercio.size >= TOPE_DE_COMERCIOS) {
      const [masViejo, cuando] = ultimaFallaPorComercio.entries().next().value as [string, number]
      ultimaFallaPorComercio.delete(masViejo)
      if (ahora - cuando < VENTANA_SIN_CANAL_MS) {
        logger.error('🚨 [AngelPay webhook] Tope de canales caídos: se olvida la falla MÁS VIEJA aún vigente', {
          merchantAccountId: masViejo,
        })
      }
    }
    ultimaFallaPorComercio.set(aviso.merchantAccountId, ahora)
  }
  if (!aviso.attemptId || !aviso.posibleDinero || intentosConDinero.has(aviso.attemptId)) return
  if (intentosConDinero.size >= TOPE_DE_INTENTOS) {
    const masVieja = intentosConDinero.values().next().value as string
    intentosConDinero.delete(masVieja)
    logger.error('🚨 [AngelPay webhook] Tope de avisos no guardados: se olvida la marca de dinero MÁS VIEJA', { attemptId: masVieja })
  }
  intentosConDinero.add(aviso.attemptId)
}

/** ¿El banco avisó de posible dinero de ESTE intento y el servidor no lo pudo guardar? (llave canónica, ya recortada) */
export function hayDineroNoGuardado(attemptId: string): boolean {
  return intentosConDinero.has(attemptId)
}

/** ¿El canal de avisos de este comercio falló hace menos de la ventana? Mientras sí, su silencio no prueba nada. */
export function canalDelComercioFalloHacePoco(merchantAccountId: string, ahora = Date.now()): boolean {
  const ultima = ultimaFallaPorComercio.get(merchantAccountId)
  return ultima !== undefined && ahora - ultima < VENTANA_SIN_CANAL_MS
}

/**
 * 🔴 El REINGRESO. Si AngelPay no reintentara el 503, la marca de dinero dejaría la terminal apartada SIN SALIDA: la terminal
 * guarda durable el «hay evidencia de cobro» que le contesta el servidor, y nadie registraría ese cobro porque el aviso no existe
 * en la base. Así que el servidor vuelve a procesar él mismo la MISMA entrada, con esperas crecientes (y después cada minuto),
 * hasta que la base la guarde; el reintento de AngelPay, si llega, es un segundo camino (el `eventId` lo vuelve idempotente).
 * `reintentar` contesta si ya quedó guardado; lanzar cuenta como que no.
 * ⚠️ Residual declarado: si el proceso se reinicia con la base todavía caída y AngelPay no reintenta, el reingreso se pierde.
 */
export const ESPERAS_DE_REINGRESO_MS = [5_000, 15_000, 60_000] as const
export const TOPE_DE_REINGRESOS_SIN_VERIFICAR = 1_000
export const TOPE_DE_REINGRESOS_VERIFICADOS = 10_000
/** Un aviso de AngelPay pesa ~1 KB; lo demás no se guarda en memoria para reingresar. */
export const TOPE_DE_CUERPO_PARA_REINGRESO = 16 * 1024

type Reingreso = {
  timer: NodeJS.Timeout | null
  reintentar: () => Promise<boolean>
  intento: number
  /** Firma verificada: un aviso AUTÉNTICO. Los de la búsqueda caída llegan sin verificar hasta que se reintentan. */
  verificado: boolean
  corriendo: boolean
}
// Dos listas, una por clase: el tope se aplica dentro de cada una y el más viejo de su clase es siempre el primero (O(1)).
const autenticos = new Map<string, Reingreso>()
const sinVerificar = new Map<string, Reingreso>()
const buscar = (clave: string): Reingreso | undefined => autenticos.get(clave) ?? sinVerificar.get(clave)
/** La puerta despierta los reingresos a lo más cada tanto: el sondeo de las terminales no puede volverse un martilleo a la base. */
export const DESPERTAR_A_LO_MAS_CADA_MS = 5_000
let ultimoDespertar = 0

export function reingresarMasTarde(clave: string, reintentar: () => Promise<boolean>, verificado: boolean): void {
  const existente = buscar(clave)
  if (existente) {
    // Llegó un aviso AUTÉNTICO (firma verificada, ingreso fallido) con la clave de una entrada sin verificar: desde ahora ningún
    // cuerpo sin verificar lo puede expulsar. 🔴 Codex final-3: y se queda con SU reintento — el cuerpo de la entrada anterior pudo
    // ser falso: al reintentar recibía 401, contaba como «terminado» y se borraba, y el auténtico nunca se reingresaba.
    if (verificado && !existente.verificado) {
      sinVerificar.delete(clave)
      existente.verificado = true
      existente.reintentar = reintentar
      existente.intento = 0
      hacerLugar(true)
      autenticos.set(clave, existente)
    }
    return
  }
  hacerLugar(verificado)
  const r: Reingreso = { timer: null, reintentar, intento: 0, verificado, corriendo: false }
  ;(verificado ? autenticos : sinVerificar).set(clave, r)
  programar(clave, r)
}

/**
 * 🔴 Codex final-2 (P1-2): el tope es POR CLASE. Un cuerpo sin verificar sólo desplaza a otro sin verificar: 1 000 cuerpos con
 * firma falsa durante la caída ya no pueden expulsar el reingreso del aviso auténtico (su veto quedaba vivo y la terminal,
 * retenida sin recuperación aunque la base ya había vuelto). El tope de los auténticos sólo se alcanza en una caída enorme.
 */
function hacerLugar(verificado: boolean): void {
  const lista = verificado ? autenticos : sinVerificar
  if (lista.size < (verificado ? TOPE_DE_REINGRESOS_VERIFICADOS : TOPE_DE_REINGRESOS_SIN_VERIFICAR)) return
  const [masViejo, r] = lista.entries().next().value as [string, Reingreso]
  if (r.timer) clearTimeout(r.timer)
  lista.delete(masViejo)
  if (verificado) logger.error('🚨 [AngelPay webhook] Tope de reingresos AUTÉNTICOS: se abandona el más viejo', { clave: masViejo })
  else logger.warn('[AngelPay webhook] Tope de reingresos sin verificar: se abandona el más viejo', { clave: masViejo })
}

function programar(
  clave: string,
  r: Reingreso,
  espera: number = ESPERAS_DE_REINGRESO_MS[Math.min(r.intento, ESPERAS_DE_REINGRESO_MS.length - 1)],
): void {
  if (r.timer) clearTimeout(r.timer)
  r.timer = setTimeout(() => void correr(clave), espera)
  r.timer.unref()
}

async function correr(clave: string): Promise<void> {
  const r = buscar(clave)
  if (!r || r.corriendo) return
  r.corriendo = true
  r.timer = null
  const loQueCorre = r.reintentar
  let guardado = false
  try {
    guardado = await loQueCorre()
  } catch (err) {
    logger.error('🚨 [AngelPay webhook] El reingreso del aviso volvió a fallar', { err, clave })
  }
  r.corriendo = false
  if (buscar(clave) !== r) return // lo olvidaron mientras corría
  // 🔴 Codex final-3: mientras corría, la entrada se promovió con el cuerpo AUTÉNTICO. Lo que terminó fue el anterior (quizá
  // falso); el auténtico no ha corrido: va YA, nunca se da por guardado.
  if (r.reintentar !== loQueCorre) {
    programar(clave, r, 0)
    return
  }
  if (guardado) {
    ;(r.verificado ? autenticos : sinVerificar).delete(clave)
    logger.info('✅ [AngelPay webhook] Aviso reingresado por el propio servidor', { clave, intento: r.intento + 1 })
    return
  }
  r.intento++
  programar(clave, r)
}

/**
 * 🔴 LA PUERTA (decisión del founder, 23-sep, tras la revisión acotada de Codex): la ÚNICA lectora de la nota en memoria.
 * Cada lugar que puede decir «no se cobró» —la liberación automática, la declaración del cajero, la ventana de 30 s— o
 * PUBLICAR una liberación a la terminal —la consulta S6— pregunta aquí antes de decidir. Contesta si el banco avisó de
 * dinero de ESTE intento que la base no ha guardado, y despierta YA los reingresos auténticos pendientes: primero se guarda la
 * nota, después se decide. Mientras no se pueda guardar, quien pregunta lo trata como dinero (nunca «no se cobró»).
 * `hayDineroNoGuardado` sólo se lee aquí: hay una prueba de arquitectura que falla si otro archivo la consulta directo.
 */
export function puertaDelDinero(attemptId: string): boolean {
  despertarReingresos()
  return hayDineroNoGuardado(attemptId)
}

function despertarReingresos(ahora = Date.now()): void {
  if (autenticos.size === 0 || ahora - ultimoDespertar < DESPERTAR_A_LO_MAS_CADA_MS) return
  ultimoDespertar = ahora
  // Sólo los auténticos: son los únicos que traen dinero. Los sin verificar siguen su propio reloj.
  for (const [clave, r] of autenticos) if (!r.corriendo) programar(clave, r, 0)
}

/** Corre YA los reingresos pendientes (pruebas de integración: la base «vuelve» sin esperar el reloj). */
export async function _reingresarYaParaPruebas(): Promise<void> {
  for (const [clave, r] of [...autenticos, ...sinVerificar]) {
    if (r.timer) clearTimeout(r.timer)
    await correr(clave)
  }
}

export function _olvidarTodoParaPruebas(): void {
  intentosConDinero.clear()
  ultimaFallaPorComercio.clear()
  for (const r of [...autenticos.values(), ...sinVerificar.values()]) if (r.timer) clearTimeout(r.timer)
  autenticos.clear()
  sinVerificar.clear()
  ultimoDespertar = 0
}
