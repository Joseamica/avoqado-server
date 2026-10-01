/**
 * Caja externa (spec 2026-09-30 D5): lo que impide imprimir un vale que la OTRA caja pueda
 * cobrar completo. Pura — sin base ni red. `issueAreaTicket` la llama sólo si el área cobra
 * en caja externa; la ruta AVOQADO nunca pasa por aquí.
 *
 * Ojo: todo producto de Avoqado tiene SKU (la columna es obligatoria y, si nadie lo captura,
 * se inventa). Aquí sólo se detecta el SKU vacío; un SKU inventado que el otro POS no conoce
 * lo ataja la carga del catálogo, no este código.
 */
export interface ExternalCodeLine {
  productNameSnapshot: string
  skuSnapshot: string | null
  weightKg: string | null
  discountAmount: string
  modifiersSnapshot: Array<{ name: string; price: string; sku?: string | null }>
}

export interface ExternalRouteBlockers {
  /** «Latte» o «Shot de espresso (extra)»: sin código, la otra caja no lo puede cobrar. */
  missingCodes: string[]
  /** Un código fijo cobraría 1 pieza; los códigos con peso son de la fase de la cremería. */
  weighted: string[]
  /** La otra caja cobra su precio: un descuento del vale no le llega y el cliente pagaría de más. */
  discounted: string[]
}

const hasCode = (value: string | null | undefined): boolean => Boolean(value?.trim())

export function externalRouteBlockers(lines: ExternalCodeLine[]): ExternalRouteBlockers {
  const missingCodes = new Set<string>()
  const weighted = new Set<string>()
  const discounted = new Set<string>()
  for (const line of lines) {
    if (!hasCode(line.skuSnapshot)) missingCodes.add(line.productNameSnapshot)
    if (line.weightKg != null) weighted.add(line.productNameSnapshot)
    if (Number(line.discountAmount) > 0) discounted.add(line.productNameSnapshot)
    for (const modifier of line.modifiersSnapshot) {
      if (Number(modifier.price) > 0 && !hasCode(modifier.sku)) missingCodes.add(`${modifier.name} (extra)`)
    }
  }
  return { missingCodes: [...missingCodes], weighted: [...weighted], discounted: [...discounted] }
}
