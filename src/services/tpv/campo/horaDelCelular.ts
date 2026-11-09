export type OrigenHora = 'SERVIDOR' | 'RELOJ_ANCLADO' | 'RELOJ_DEL_CELULAR'

const FUTURO_MAX_MS = 2 * 60 * 1000 // los relojes de las Nexgo van 4-9 min adelantados: ahí ya no se confía
const PASADO_MAX_MS = 7 * 24 * 60 * 60 * 1000 // la cola del celular vive 7 días

/**
 * Decide qué hora usa el servidor para una venta o checada que hizo el celular.
 * Hasta 2 min en el futuro y hasta 7 días atrás se acepta la del celular; fuera de eso, la del servidor.
 * Nunca lanza ni rechaza por la hora.
 */
export function resolverHoraDelCelular(
  entrada: { ocurrioAt?: Date; origen?: 'RELOJ_ANCLADO' | 'RELOJ_DEL_CELULAR' },
  ahora: Date,
): { hora: Date; origen: OrigenHora } {
  const { ocurrioAt, origen } = entrada
  if (!ocurrioAt || Number.isNaN(ocurrioAt.getTime())) return { hora: ahora, origen: 'SERVIDOR' }
  const diff = ocurrioAt.getTime() - ahora.getTime()
  if (diff > FUTURO_MAX_MS || diff < -PASADO_MAX_MS) return { hora: ahora, origen: 'SERVIDOR' }
  return { hora: ocurrioAt, origen: origen ?? 'RELOJ_DEL_CELULAR' }
}
