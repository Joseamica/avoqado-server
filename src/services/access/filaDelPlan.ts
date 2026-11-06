/**
 * ¿Cuál de las filas de plan de un negocio es la que se ADMINISTRA (se muestra, se cancela, se reintenta)? ¿Y se puede
 * conceder un plan encima de lo que ya hay?
 *
 * 🔴 Codex C8 (22-sep): tras un cambio de plan hay DOS filas (la vieja retirada, la nueva vigente). Tomar «la primera» sin
 * orden mostraba el plan viejo como cancelado y rechazaba cancelar el vigente. La regla es explícita:
 *   1. la que da acceso (activa, sin suspensión y VIGENTE);
 *   2. la que sigue ligada a una suscripción que puede cobrar (se puede cancelar o reintentar);
 *   3. la activa;
 *   y ante empate, la más recientemente escrita.
 *
 * 🔴 Codex R10 (ronda 2) añadió las dos cosas que faltaban para que el puntaje no premiara a la obligación equivocada:
 * la VIGENCIA (`endDate`) —una prueba vencida ganaba como si diera acceso— y el ESTADO ECONÓMICO del vínculo: un webhook
 * tardío de una suscripción cancelada le subía el `updatedAt` a su fila y volvía a elegirla mientras la nueva cobraba.
 */
export interface FilaDePlanLeida {
  active: boolean
  suspendedAt: Date | null
  stripeSubscriptionId: string | null
  /** Fin de la concesión (prueba, cortesía con vencimiento). Pasado ⇒ ya no da acceso. */
  endDate?: Date | null
  updatedAt?: Date
  /** ¿Su suscripción sigue pudiendo cobrar? `false` = CONSTA terminada; `null`/ausente = no se consultó y no degrada. */
  cobroVivo?: boolean | null
}

const vigente = (f: FilaDePlanLeida, ahora: Date) => !f.endDate || f.endDate.getTime() > ahora.getTime()
/** Un vínculo sólo cuenta si no CONSTA terminado: la ignorancia no degrada, la evidencia sí. */
const vinculoUtil = (f: FilaDePlanLeida) => !!f.stripeSubscriptionId && f.cobroVivo !== false
/** Su suscripción TERMINÓ y nos consta: el `active` que conserve es un residuo local que la conciliación va a quitar. */
const constaMuerto = (f: FilaDePlanLeida) => !!f.stripeSubscriptionId && f.cobroVivo === false

/**
 * 🔴 Lo que CONSTA que cobra pesa más que lo que la fila local dice de sí misma: esa es la lección de R10. Un webhook
 * tardío de la cancelada la dejaba `active` y con el `updatedAt` más nuevo, y así ganaba a la que de verdad cobraba.
 */
const puntaje = (f: FilaDePlanLeida, ahora: Date) =>
  (f.cobroVivo === true ? 16 : 0) +
  (f.active && !f.suspendedAt && vigente(f, ahora) && !constaMuerto(f) ? 8 : 0) +
  (vinculoUtil(f) ? 4 : 0) +
  (f.active && vigente(f, ahora) && !constaMuerto(f) ? 2 : 0) +
  (f.active ? 1 : 0)

export function elegirFilaDelPlan<T extends FilaDePlanLeida>(filas: T[], ahora: Date = new Date()): T | null {
  if (filas.length === 0) return null
  return [...filas].sort(
    (a, b) => puntaje(b, ahora) - puntaje(a, ahora) || (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0),
  )[0]
}

/**
 * ¿Hay más de una fila ADMINISTRABLE empatada arriba? Entonces no hay una respuesta: elegir por `updatedAt` sería
 * adivinar cuál cobra. Quien administra la expone o rechaza la ambigüedad, nunca la resuelve por antigüedad.
 */
export function hayAmbiguedadDePlan(filas: FilaDePlanLeida[], ahora: Date = new Date()): boolean {
  if (filas.length < 2) return false
  const puntajes = filas.map(f => puntaje(f, ahora)).sort((a, b) => b - a)
  return puntajes[0] > 0 && puntajes[0] === puntajes[1]
}
