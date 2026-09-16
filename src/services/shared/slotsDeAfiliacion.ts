/**
 * Codex R12-2: una afiliación ocupa UN solo slot de la configuración de pagos (PRIMARY / SECONDARY / TERTIARY). Con la misma
 * afiliación en dos slots, dos tarifas distintas describen el mismo cargo y nadie puede decir cuál corresponde: la captura al
 * cobrar lo declara «captura fallida por configuración ambigua» (pendiente, visible) y los ESCRITORES de configuración lo
 * rechazan aquí — en el venue y en la organización, en el alta y en la edición parcial (sobre la configuración RESULTANTE).
 * El respaldo contra dos ediciones concurrentes es el CHECK de la base (migración `20260914150000_payment_config_slots_distintos`).
 * Módulo PURO: sin Prisma, sin Express.
 */
export type SlotsDeConfiguracion = {
  primaryAccountId?: string | null
  secondaryAccountId?: string | null
  tertiaryAccountId?: string | null
}

/** Los pares de slots que comparten afiliación en la configuración dada, en orden fijo; vacío = configuración válida. */
export function slotsRepetidos(config: SlotsDeConfiguracion): Array<[string, string]> {
  const repetidos: Array<[string, string]> = []
  const p = config.primaryAccountId ?? null
  const s = config.secondaryAccountId ?? null
  const t = config.tertiaryAccountId ?? null
  if (p && s && p === s) repetidos.push(['PRIMARY', 'SECONDARY'])
  if (p && t && p === t) repetidos.push(['PRIMARY', 'TERTIARY'])
  if (s && t && s === t) repetidos.push(['SECONDARY', 'TERTIARY'])
  return repetidos
}

export const AFILIACION_EN_VARIOS_SLOTS = 'AFFILIATION_IN_SEVERAL_SLOTS'
export const MENSAJE_AFILIACION_EN_VARIOS_SLOTS = 'Una afiliación no puede ocupar dos slots a la vez.'

/** Mensaje en español para el usuario (los esquemas y errores de este repo hablan español). */
export function mensajeDeSlotsRepetidos(config: SlotsDeConfiguracion): string | null {
  const repetidos = slotsRepetidos(config)
  if (repetidos.length === 0) return null
  return `Una afiliación no puede ocupar dos slots a la vez (${repetidos.map(([a, b]) => `${a} y ${b}`).join('; ')}).`
}

/**
 * Los CHECK de la migración `20260914150000_payment_config_slots_distintos`, uno por tabla de configuración, tal como Postgres
 * los nombra al rechazar la fila (las comillas llegan escapadas dentro del `PostgresError` que Prisma embebe en el mensaje).
 */
const VIOLACION_DE_SLOTS_DISTINTOS = /violates check constraint \\?"(VenuePaymentConfig|OrganizationPaymentConfig)_slots_distintos\\?"/

/**
 * ¿Es este error la violación de uno de esos CHECK (Postgres 23514)? Prisma no la expone con un código propio: llega como
 * `PrismaClientUnknownRequestError` con el `PostgresError` embebido en el mensaje (`… violates check constraint "<nombre>"`),
 * y el nombre del CHECK es nuestro. El handler global la traduce al mismo 400 + código que devuelven los escritores que
 * validan antes de escribir, para que un escritor que no validó —o dos ediciones concurrentes— no acaben en un 500 anónimo.
 */
export function esViolacionDeSlotsDistintos(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return VIOLACION_DE_SLOTS_DISTINTOS.test(message)
}
