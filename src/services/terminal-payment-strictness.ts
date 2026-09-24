import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { runWithoutCancellation } from '@/utils/requestCancellation'
import type { EstrictoPorVenue } from './terminal-payment.service'

/**
 * Qué venues ya se rigen por la LISTA BLANCA estricta de desenlaces del cobro remoto, y desde cuándo
 * (`Venue.terminalPaymentStrictSince`). Lo consulta el predicado de bloqueo en el camino del dinero —
 * admisión de un cobro, cancelación de una orden, selector de terminales— así que aquí manda una cosa:
 *
 * 🔴 **Leer NUNCA espera y NUNCA lanza.** Un cobro no puede quedarse esperando a que una consulta de
 * configuración conteste; la lista se llena al arrancar y se refresca en segundo plano, igual que el
 * cache de nombres de venue de `observability/venueNames.ts`.
 *
 * 🔴 **Y el lado seguro ante la duda es el PERMISIVO, no el estricto.** Es lo contrario de lo que
 * sugiere el instinto, así que vale escribir el porqué:
 *
 * - Caer al permisivo = comportarse EXACTAMENTE como produccion hoy (`SLOT_HELD`: en vuelo + UNKNOWN).
 *   No abre ningún hueco nuevo: es el mismo predicado que lleva meses protegiendo esos cobros.
 * - Caer al estricto = bloquear las 375 filas históricas de producción, o sea dejar terminales
 *   muertas sin salida, porque la conciliación B que las liberaría todavía no existe.
 *
 * Un fallo de esta consulta no puede ser MÁS destructivo que el estado actual del sistema. Por eso un
 * refresco fallido conserva el último mapa conocido (nunca lo vacía) y grita 🚨 en vez de cambiar de
 * régimen en silencio.
 */

/** Cuánto se confía en la lista antes de refrescarla en segundo plano. */
const TTL_MS = 60 * 1000
/** Tras un fallo de lectura, cuánto se espera antes de volver a intentarlo. Ver el `catch` de `refrescar`. */
const RESPIRO_TRAS_FALLO_MS = 5 * 1000

let cache: Map<string, Date> = new Map()
let cachedAt = 0
/** Una carga en curso, para que N cobros simultáneos causen UNA consulta. */
let enVuelo: Promise<void> | null = null
/** ¿Se llenó alguna vez? Antes del primer prime no se puede distinguir «nadie migró» de «no lo sé». */
let cargadoAlgunaVez = false
let avisoDeNoCargadoEmitido = false

/**
 * Los venues estrictos, ahora mismo. Síncrono: devuelve lo que tiene y dispara el refresco si toca.
 */
export function getVenuesEstrictos(): EstrictoPorVenue {
  if (Date.now() - cachedAt > TTL_MS) void refrescar()
  if (!cargadoAlgunaVez && !avisoDeNoCargadoEmitido) {
    avisoDeNoCargadoEmitido = true
    // No es 🚨: en el arranque normal esto ocurre durante los milisegundos previos al prime, y el
    // régimen permisivo de esa ventana es el de producción. Se registra para que, si alguna vez
    // dura, quede rastro de por qué un venue migrado no estaba aplicando su lista blanca.
    logger.warn('[terminal-payment strictness] Consultada antes del primer prime — rige el predicado heredado')
  }
  return cache
}

/**
 * Carga la lista al arrancar. Devuelve cuántos venues están en modo estricto (0 también es una
 * respuesta válida y es la esperada hasta que empiece la migración). Nunca lanza.
 */
export async function primeVenuesEstrictos(): Promise<number | null> {
  await refrescar()
  // 🔴 `null` cuando la lectura NUNCA logró completarse (P3-4 de Fable): devolver `0` hacía que el arranque
  // imprimiera «✅ 0 venue(s) en modo estricto» encima de un fallo, que es exactamente la forma de un verde
  // falso — «no hay ninguno» y «no pude saberlo» no pueden verse igual en el log del arranque.
  return cargadoAlgunaVez ? cache.size : null
}

/**
 * Fuerza una relectura ya. La usa quien acaba de ENCENDER o APAGAR el flag, para que el cambio se
 * note sin esperar el TTL — apagar es la marcha atrás, y una marcha atrás que tarda un minuto en
 * surtir efecto no sirve cuando hay terminales bloqueadas.
 */
export async function invalidarVenuesEstrictos(): Promise<void> {
  cachedAt = 0
  // 🔴 `forzarLecturaNueva` NO es opcional (P1-3 de la auditoría de Codex, 11-sep): sin ella, una lectura que ya
  // estaba EN VUELO cuando se escribió el `UPDATE` se comparte, y `await` devuelve con el mapa ANTERIOR. O sea que
  // apagar el interruptor —la marcha atrás— podía no surtir efecto y nadie se enteraba. Con la bandera se espera a
  // una lectura que empezó DESPUÉS del cambio.
  await refrescar({ forzarLecturaNueva: true })
}

function refrescar(opciones?: { forzarLecturaNueva?: boolean }): Promise<void> {
  if (enVuelo) {
    // Una lectura en curso puede haber empezado antes del cambio: no vale para confirmarlo. Se espera a que
    // termine y se lanza otra encima.
    if (opciones?.forzarLecturaNueva) return enVuelo.then(() => refrescar({ forzarLecturaNueva: false }))
    return enVuelo
  }
  enVuelo = (async () => {
    try {
      // Trabajo GLOBAL que puede nacer dentro de una petición del MCP (sus herramientas de terminales consultan esta
      // lista): el freno de esa petición no le toca. Cortarlo gritaría un 🚨 falso, y hacerlo esperar el cupo de esa
      // persona retrasaría la marcha atrás de `invalidarVenuesEstrictos` (freno del 23-sep-2026).
      const filas = await runWithoutCancellation(() =>
        prisma.venue.findMany({
          // ENCENDIDO y con corte: la fecha sola no basta, porque apagar la conserva (para no desplazar el corte
          // al reencender). Ver `Venue.terminalPaymentStrictEnabled`.
          where: { terminalPaymentStrictEnabled: true, terminalPaymentStrictSince: { not: null } },
          select: { id: true, terminalPaymentStrictSince: true },
          // Tope explícito (regla `bounded-queries-and-server-load.md`): son los venues MIGRADOS, un puñado durante
          // la migración. Si algún día se pasara de aquí, se vería en el log de arranque antes que en un incidente.
          take: 500,
        }),
      )
      const nuevo = new Map<string, Date>()
      for (const f of filas) if (f.terminalPaymentStrictSince) nuevo.set(f.id, f.terminalPaymentStrictSince)
      cache = nuevo
      cachedAt = Date.now()
      cargadoAlgunaVez = true
    } catch (error) {
      // 🚨 token estable para la regla de Better Stack — NO renombrar.
      logger.error('🚨 [terminal-payment strictness] No se pudo leer qué venues están en modo estricto — se conserva la lista anterior', {
        error: error instanceof Error ? error.message : 'Error desconocido',
        venuesEnMemoria: cache.size,
        cargadoAlgunaVez,
      })
      // La lista NO se vacía: se sigue sirviendo lo último que sí se supo.
      // 🔴 Pero `cachedAt` SÍ se mueve, con un respiro corto (P3-4 de la auditoría de Fable, 11-sep): sin él,
      // con la base caída CADA consulta —o sea, cada cobro— relanzaba la lectura y escribía otro 🚨. Justo
      // cuando la base sufre, la observabilidad no puede ser quien la remate. 5 s es suficiente para que el
      // apagado de urgencia se note y para que el log siga siendo legible.
      cachedAt = Date.now() - TTL_MS + RESPIRO_TRAS_FALLO_MS
    } finally {
      enVuelo = null
    }
  })()
  return enVuelo
}

/** Sólo para pruebas: deja el módulo como recién arrancado. */
export function __resetVenuesEstrictosParaPruebas(): void {
  cache = new Map()
  cachedAt = 0
  enVuelo = null
  cargadoAlgunaVez = false
  avisoDeNoCargadoEmitido = false
}
