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

/** Mensaje en español para el usuario (los esquemas y errores de este repo hablan español). */
export function mensajeDeSlotsRepetidos(config: SlotsDeConfiguracion): string | null {
  const repetidos = slotsRepetidos(config)
  if (repetidos.length === 0) return null
  return `Una afiliación no puede ocupar dos slots a la vez (${repetidos.map(([a, b]) => `${a} y ${b}`).join('; ')}).`
}
