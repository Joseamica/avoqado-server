import { CANONICAL_LAYOUT, MAX_BLOCKS } from '@/services/shared/receiptLayout'
import { validateLayoutStrict } from '@/services/shared/receiptLayout/validateStrict'

/**
 * El validador ESTRICTO: el que decide si una receta se puede GUARDAR.
 *
 * 🔴 Existe porque había dos: la ruta HTTP rechazaba un bloque ilegible y el MCP lo DESCARTABA
 * en silencio y guardaba el resto (full-testing del 12-sep, FAIL-3). Una conexión de IA pedía
 * «agrega un texto de 60 caracteres», el texto desaparecía y la respuesta decía ok:true.
 * Ahora los dos caminos llaman a esta función y no hay forma de que diverjan.
 */
const raw = () => JSON.parse(JSON.stringify(CANONICAL_LAYOUT)) as Array<Record<string, unknown>>

describe('validateLayoutStrict', () => {
  it('una receta íntegra pasa y devuelve los bloques con sus defaults', () => {
    const blocks = raw().map(b => (b.type === 'logo' ? { type: 'logo' } : b))
    const i = blocks.findIndex(b => b.type === 'logo')
    const r = validateLayoutStrict(blocks)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.blocks[i]).toEqual({ type: 'logo', size: 'M', align: 'center' })
  })

  it('🔴 un tipo DESCONOCIDO se rechaza (nunca se descarta) con UNKNOWN_BLOCK y su posición', () => {
    const blocks = raw()
    blocks.splice(2, 0, { type: 'hologram' })
    const r = validateLayoutStrict(blocks)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.problem.code).toBe('RECEIPT_LAYOUT_UNKNOWN_BLOCK')
      expect(r.problem.index).toBe(2)
      // La posición va en el mensaje contada desde 1: es lo que lee una persona.
      expect(r.problem.message).toBe('Bloque 3: Tipo de bloque desconocido')
    }
  })

  it('🔴 un tipo CONOCIDO con forma inválida es INVALID_BLOCK, no UNKNOWN: el bloque sí existe', () => {
    const blocks = raw()
    const i = blocks.findIndex(b => b.type === 'text')
    blocks[i] = { type: 'text', lines: ['x'.repeat(60)] }
    const r = validateLayoutStrict(blocks)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.problem.code).toBe('RECEIPT_LAYOUT_INVALID_BLOCK')
      expect(r.problem.index).toBe(i)
      expect(r.problem.blockType).toBe('text')
      expect(r.problem.message).toBe(`Bloque ${i + 1} («text»): Cada renglón admite hasta 48 caracteres`)
    }
  })

  it('un elemento que ni siquiera es un objeto es INVALID_BLOCK con su posición', () => {
    const r = validateLayoutStrict(['hola', ...raw()])
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.problem.code).toBe('RECEIPT_LAYOUT_INVALID_BLOCK')
      expect(r.problem.index).toBe(0)
    }
  })

  it('🔴 pasarse del tope de bloques es TOO_MANY_BLOCKS, sin posición', () => {
    const r = validateLayoutStrict(Array(MAX_BLOCKS + 1).fill({ type: 'separator' }))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.problem.code).toBe('RECEIPT_LAYOUT_TOO_MANY_BLOCKS')
      expect(r.problem.index).toBeUndefined()
    }
  })

  it('una lista vacía o que no es lista es INVALID_LAYOUT', () => {
    for (const malo of [[], 'blocks', null, { type: 'logo' }]) {
      const r = validateLayoutStrict(malo)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.problem.code).toBe('RECEIPT_LAYOUT_INVALID_LAYOUT')
    }
  })

  it('con la forma bien, corre el candado de integridad (la MISMA regla de las apps)', () => {
    const r = validateLayoutStrict(raw().filter(b => b.type !== 'totals'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.problem.code).toBe('RECEIPT_LAYOUT_MISSING_BLOCK')
  })

  it('🔴 un error de forma gana al de integridad: se reporta lo primero que hay que arreglar', () => {
    const blocks = raw().filter(b => b.type !== 'totals')
    blocks.push({ type: 'hologram' })
    const r = validateLayoutStrict(blocks)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.problem.code).toBe('RECEIPT_LAYOUT_UNKNOWN_BLOCK')
  })
})
