/**
 * Codex R6-2 (diseño aceptado el 13-sep): EXCLUSIÓN por intento, válida aunque todavía no exista ningún evento del intento.
 *
 * El candado de fila (`FOR UPDATE` sobre `ProviderEventLog`) no cubre una fila que aún no existe: la transacción que
 * publica el vínculo S1 podía consultar los eventos del intento (ninguno), y un evento insertado y decidido por identidad
 * DÉBIL entre esa consulta y el commit del vínculo quedaba sellado sobre OTRO Payment sin que nadie lo reabriera. Un
 * candado consultivo transaccional por `attemptId` —tomado como PRIMERA sentencia por la publicación del vínculo, por la
 * reapertura idempotente (ALREADY_LINKED) y por TODO escritor débil que conozca la llave del intento— serializa esas
 * decisiones: quien llega segundo ve lo que el primero dejó commiteado.
 *
 *  · Dos llaves (`namespace`, `hashtext(attemptId)`): un espacio propio, separado de los advisory de una llave que usa el
 *    resto del repo (`hashtextextended`). 32 bits para el intento bastan: una colisión sólo cuesta una espera; el dueño
 *    sigue decidiéndose por el `attemptId` completo y su índice único.
 *  · Se adquiere en una sentencia y la lectura de S1 va en OTRA (READ COMMITTED: fotografía nueva después de la espera).
 *  · Espera de candado acotada por debajo del presupuesto de la transacción de Prisma: si vence, la transacción entera
 *    revierte — el vínculo no se escribe (la terminal reintenta el anuncio) y el escritor débil no sella (el evento conserva
 *    su estado durable).
 *  · La MISMA normalización de la llave al persistir (`ProviderEventLog.attemptId`), al bloquear y al consultar: sin eso
 *    un escritor podía terminar primero y la publicación no localizar su evento aunque ambos tomaran candados.
 */
import { Prisma } from '@prisma/client'

/** Namespace fijo y reservado del candado por intento (int4). No reutilizar en otro advisory de dos llaves. */
export const NS_CANDADO_INTENTO = 7_310_113
/** Presupuesto de espera del candado, por debajo de los 10 s de la transacción de Prisma (queda margen para ejecutar y terminar). */
export const ESPERA_DE_CANDADO_MS = 8_000
export const LONGITUD_MAXIMA_DE_LLAVE = 64

/** La llave canónica del intento: recortada; vacía, no textual o demasiado larga ⇒ null (no hay intento con el que competir). */
export function llaveDeIntento(cruda: unknown): string | null {
  if (typeof cruda !== 'string') return null
  const llave = cruda.trim()
  return llave && llave.length <= LONGITUD_MAXIMA_DE_LLAVE ? llave : null
}

/** La espera de candado vigente: la del entorno (las pruebas de intercalación la acortan) o la de fábrica. Siempre un entero positivo. */
export function esperaDeCandadoMs(): number {
  const n = Number.parseInt(process.env.TERMINAL_ATTEMPT_LOCK_TIMEOUT_MS ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : ESPERA_DE_CANDADO_MS
}

/**
 * Codex R6-2 (c): el protocolo exige READ COMMITTED EXPLÍCITO — la lectura de S1 en una sentencia posterior al candado sólo
 * es una «fotografía nueva» bajo ese aislamiento; no se deja al valor por defecto de la base. Toda transacción que toma el
 * candado del intento (vínculo, reapertura, escritores débiles, consolidación por referencia) abre con estas opciones.
 */
export const OPCIONES_DE_TRANSACCION_DEL_INTENTO = {
  timeout: 10_000,
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
} as const

/** Primera sentencia de toda transacción que decide sobre un intento: espera acotada + candado consultivo transaccional. */
export async function candadoDeIntento(
  tx: Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRawUnsafe'>,
  llave: string,
): Promise<void> {
  await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${esperaDeCandadoMs()}ms'`)
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(${NS_CANDADO_INTENTO}::int, hashtext(${llave}))::text`
}
