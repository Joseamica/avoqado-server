import { MAX_SEPARATORS, MAX_TEXT_BLOCKS, type Block, type BlockType } from './schema'
import { sanitizeReceiptText } from './sanitizeText'

/**
 * 🔴 Conjunto CERRADO (spec § 5.2 regla 3): nunca se agrega un obligatorio nuevo. Una app
 * vieja ignora los bloques que no conoce; si un tipo nuevo fuera obligatorio, imprimiría
 * un ticket sin ese dato, en silencio.
 */
export const MANDATORY_BLOCK_TYPES = ['fiscal', 'orderInfo', 'items', 'totals', 'payment', 'areaDelivery', 'signature'] as const
export type MandatoryType = (typeof MANDATORY_BLOCK_TYPES)[number]

/** Tres clases de obligatorio: el diseñador enseña un tooltip distinto para cada una. */
export const MANDATORY_KIND: Record<MandatoryType, 'legal' | 'operativo' | 'plataforma'> = {
  fiscal: 'legal',
  orderInfo: 'legal',
  items: 'legal',
  totals: 'legal',
  payment: 'operativo',
  areaDelivery: 'operativo',
  signature: 'plataforma',
}

/** Máximo de apariciones por tipo. Lo que no está aquí admite 1. */
const BLOCK_MAX: Partial<Record<BlockType, number>> = { text: MAX_TEXT_BLOCKS, separator: MAX_SEPARATORS }

export type LayoutProblemCode =
  | 'RECEIPT_LAYOUT_MISSING_BLOCK'
  | 'RECEIPT_LAYOUT_DUPLICATE_BLOCK'
  | 'RECEIPT_LAYOUT_SIGNATURE_NOT_LAST'
  | 'RECEIPT_LAYOUT_TOO_MANY_BLOCKS'
  | 'RECEIPT_LAYOUT_TEXT_FORBIDDEN_CHARS'
  // De FORMA (validateStrict.ts): el bloque no se pudo leer, antes de mirar la integridad.
  | 'RECEIPT_LAYOUT_UNKNOWN_BLOCK'
  | 'RECEIPT_LAYOUT_INVALID_BLOCK'
  | 'RECEIPT_LAYOUT_INVALID_LAYOUT'

export interface LayoutProblem {
  code: LayoutProblemCode
  message: string
  blockType?: BlockType
  index?: number
}

export function validateLayout(blocks: Block[]): LayoutProblem[] {
  const problems: LayoutProblem[] = []
  const counts = new Map<BlockType, number>()
  blocks.forEach(b => counts.set(b.type, (counts.get(b.type) ?? 0) + 1))

  for (const type of MANDATORY_BLOCK_TYPES) {
    const n = counts.get(type) ?? 0
    if (n === 0) problems.push({ code: 'RECEIPT_LAYOUT_MISSING_BLOCK', blockType: type, message: `Falta el bloque obligatorio «${type}»` })
    if (n > 1)
      problems.push({ code: 'RECEIPT_LAYOUT_DUPLICATE_BLOCK', blockType: type, message: `El bloque «${type}» sólo puede aparecer una vez` })
  }

  for (const [type, n] of counts) {
    if (MANDATORY_BLOCK_TYPES.includes(type as MandatoryType)) continue
    const max = BLOCK_MAX[type] ?? 1
    if (n > max)
      problems.push({ code: 'RECEIPT_LAYOUT_TOO_MANY_BLOCKS', blockType: type, message: `El bloque «${type}» admite hasta ${max}` })
  }

  const last = blocks[blocks.length - 1]
  if ((counts.get('signature') ?? 0) === 1 && last?.type !== 'signature') {
    problems.push({
      code: 'RECEIPT_LAYOUT_SIGNATURE_NOT_LAST',
      blockType: 'signature',
      message: 'La firma «Powered by Avoqado» debe ser el último bloque',
    })
  }

  blocks.forEach((b, index) => {
    const lines = b.type === 'text' ? b.lines : b.type === 'qr' ? [b.caption] : []
    for (const line of lines) {
      const r = sanitizeReceiptText(line)
      if (!r.ok) {
        problems.push({
          code: 'RECEIPT_LAYOUT_TEXT_FORBIDDEN_CHARS',
          blockType: b.type,
          index,
          message: r.reason === 'nonLatin1' ? `El papel no imprime «${r.offending}»` : 'El texto contiene caracteres no permitidos',
        })
        break
      }
    }
  })

  return problems
}
