import type { ZodIssue } from 'zod'
import { blockSchema, layoutBlocksSchema, type Block, type BlockType } from './schema'
import { validateLayout, type LayoutProblem } from './validateLayout'

export type StrictLayoutResult = { ok: true; blocks: Block[] } | { ok: false; problem: LayoutProblem }

const TIPOS_CONOCIDOS = new Set<string>(blockSchema.options.map(o => o.shape.type.value))

/**
 * ¿Se puede GUARDAR esta receta? La respuesta única para el dashboard (HTTP) y para el MCP.
 *
 * 🔴 Es ESTRICTO a propósito, y es lo contrario de `parseLayoutTolerant`: aquél es la regla de
 * las APPS al LEER (una app vieja ignora el bloque que no conoce y sigue imprimiendo); éste es
 * la regla al ESCRIBIR, donde descartar un bloque sin decirlo es guardar algo que nadie pidió.
 * El MCP usaba el tolerante y guardaba sin el bloque inválido con ok:true (FAIL-3, 12-sep).
 *
 * El problema dice QUÉ bloque (posición desde 0 en `index`, desde 1 en el mensaje) y separa
 * «no existe ese tipo» (UNKNOWN) de «existe pero trae algo mal» (INVALID): son dos arreglos
 * distintos, y mezclarlos manda a buscar el error donde no está.
 */
export function validateLayoutStrict(raw: unknown): StrictLayoutResult {
  const forma = layoutBlocksSchema.safeParse(raw)
  if (!forma.success) return { ok: false, problem: problemaDeForma(forma.error.issues[0], raw) }

  const integridad = validateLayout(forma.data)
  if (integridad.length > 0) return { ok: false, problem: integridad[0] }
  return { ok: true, blocks: forma.data }
}

function problemaDeForma(issue: ZodIssue, raw: unknown): LayoutProblem {
  const [primero] = issue.path
  if (typeof primero !== 'number') {
    // Error de la LISTA, no de un bloque: vacía, no es lista, o se pasa del tope.
    const code = issue.code === 'too_big' ? 'RECEIPT_LAYOUT_TOO_MANY_BLOCKS' : 'RECEIPT_LAYOUT_INVALID_LAYOUT'
    return { code, message: issue.message }
  }

  const item = (raw as unknown[])[primero]
  const tipo = tipoDe(item)
  if (!tipo) {
    // Sin un tipo reconocible: un objeto con un `type` que no existe es DESCONOCIDO; algo que ni
    // siquiera es un objeto (un texto suelto, un número) es un bloque INVÁLIDO.
    const esObjeto = typeof item === 'object' && item !== null
    return {
      code: esObjeto ? 'RECEIPT_LAYOUT_UNKNOWN_BLOCK' : 'RECEIPT_LAYOUT_INVALID_BLOCK',
      message: `Bloque ${primero + 1}: ${issue.message}`,
      index: primero,
    }
  }
  return {
    code: 'RECEIPT_LAYOUT_INVALID_BLOCK',
    message: `Bloque ${primero + 1} («${tipo}»): ${issue.message}`,
    index: primero,
    blockType: tipo,
  }
}

function tipoDe(item: unknown): BlockType | null {
  const type = (item as { type?: unknown } | null)?.type
  return typeof type === 'string' && TIPOS_CONOCIDOS.has(type) ? (type as BlockType) : null
}
