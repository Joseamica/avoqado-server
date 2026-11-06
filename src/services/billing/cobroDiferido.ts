/**
 * D3 (5-nov-2026): quedarse con el plan de una prueba REGALADA (SUPERADMIN «Dar días de prueba», sin Stripe) difiere el
 * primer cobro al día exacto en que termina la prueba («como Shopify», decisión del founder). Una sola regla para:
 *   - el checkout, que pasa `trial_end` a Stripe (Stripe exige que esté al menos 48 h en el futuro), y
 *   - lo que Facturación ofrece (`origin.firstChargeAt`), con 72 h: margen para la pestaña abierta, así el DASHBOARD
 *     nunca ofrece «hoy $0» que el checkout ya no daría (si pasa, el checkout contesta 409, nunca cobra hoy).
 * Sólo el MISMO plan: Premium regalado → Pro le quitaría Premium ese día; Pro regalado → Premium regalaría Premium.
 */
export const MARGEN_CHECKOUT_MS = 48 * 3600000
export const MARGEN_OFERTA_MS = 72 * 3600000

export interface FilaDePrueba {
  active: boolean
  suspendedAt: Date | null
  stripeSubscriptionId: string | null
  endDate: Date | null
  feature: { code: string }
}

/** El fin de la prueba regalada del plan `tierCode` si todavía faltan `margenMs`; si no, `null` (se cobra como siempre). */
export function finDePruebaDiferible(
  fila: FilaDePrueba | null | undefined,
  tierCode: string,
  ahoraMs: number,
  margenMs: number,
): Date | null {
  if (!fila || !fila.active || fila.suspendedAt || fila.stripeSubscriptionId || !fila.endDate) return null
  if (fila.feature.code !== tierCode) return null
  return fila.endDate.getTime() - ahoraMs >= margenMs ? fila.endDate : null
}
