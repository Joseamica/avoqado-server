/**
 * ¿Esta fila de `VenueFeature` da acceso HOY? UNA sola regla para todos los lectores (D4 + D6, 5-nov-2026).
 *
 * ```
 * apagada o suspendida                         → NO
 * vencimiento futuro (prueba o cortesía)       → SÍ
 * gracia de cobranza vigente                   → SÍ   (aunque la prueba ya haya vencido: D6)
 * vencimiento pasado                           → NO   (prueba, cortesía o los 4 días tras una prueba, vencidos)
 * sin vencimiento                              → SÍ   (pagada; con gracia vencida también: lo corta el 4.º intento)
 * ```
 *
 * 🔴 La gracia sólo AGREGA acceso; nunca lo quita por sí sola (v4, tras tres rondas de Codex): a quien ya pagaba lo sigue
 * cortando la suspensión del 4.º intento de Stripe, como siempre, y nadie pierde acceso contra la regla anterior. El corte
 * exacto de los 4 días tras una prueba viene de `endDate` (el primer fallo lo pone al fin de la gracia). Antes la gracia
 * no contaba y una prueba con tarjeta cuyo primer cobro fallaba perdía el plan desde el día 0 aunque el servidor le
 * hubiera dado días de gracia. Diseño: `docs/audit/2026-11-05-acceso-durante-la-cobranza/promesa.md` («v4»).
 *
 * Módulo PURO y sin imports a propósito: varias suites mockean `basePlan.service` entero y se llevarían la regla con él
 * (la misma lección de `grandfather.ts`).
 */
export interface FilaConVentana {
  active: boolean
  suspendedAt: Date | null
  endDate: Date | null
  /** Obligatorio a propósito: el compilador obliga a cada lectura a traerlo, o decidiría con la regla vieja. */
  gracePeriodEndsAt: Date | null
}

export function daAcceso(f: FilaConVentana, ahora: Date = new Date()): boolean {
  if (!f.active || f.suspendedAt) return false
  if (!f.endDate || f.endDate >= ahora) return true
  return !!f.gracePeriodEndsAt && f.gracePeriodEndsAt >= ahora
}

/** La misma regla como `where` de Prisma (para las consultas por lote). `ventanaDeAcceso.test.ts` prueba que coinciden. */
export const ventanaDeAccesoWhere = (ahora: Date) => ({
  active: true,
  suspendedAt: null,
  OR: [{ endDate: null }, { endDate: { gte: ahora } }, { gracePeriodEndsAt: { gte: ahora } }],
})
