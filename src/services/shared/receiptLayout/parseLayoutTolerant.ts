import { blockSchema, type Block } from './schema'
import { CANONICAL_LAYOUT } from './templates'
import { validateLayout } from './validateLayout'

export interface TolerantParse {
  blocks: Block[]
  dropped: number
}

/**
 * Referencia de cómo deben parsear las apps: elemento por elemento, descartando lo que no
 * reconocen. `ignoreUnknownKeys` (kotlinx) o `CodingKeys` (Swift) NO cubren un miembro
 * desconocido de la unión: hay que decodificar la lista y probar cada elemento (spec § 9).
 */
export function parseLayoutTolerant(raw: unknown): TolerantParse {
  if (!Array.isArray(raw)) return { blocks: [], dropped: 0 }
  const blocks: Block[] = []
  let dropped = 0
  for (const item of raw) {
    const r = blockSchema.safeParse(item)
    if (r.success) blocks.push(r.data)
    else dropped += 1
  }
  return { blocks, dropped }
}

export interface EffectiveLayout {
  blocks: Block[]
  source: 'custom' | 'fallback'
  dropped: number
}

/** La regla de las apps: si tras descartar lo desconocido falta un obligatorio, se imprime la canónica embebida. */
export function effectiveLayout(raw: unknown): EffectiveLayout {
  const { blocks, dropped } = parseLayoutTolerant(raw)
  if (blocks.length === 0 || validateLayout(blocks).length > 0) return { blocks: CANONICAL_LAYOUT, source: 'fallback', dropped }
  return { blocks, source: 'custom', dropped }
}
