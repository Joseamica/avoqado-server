import { interpret } from '@/services/shared/receiptLayout/interpret'
import { CANONICAL_LAYOUT } from '@/services/shared/receiptLayout/templates'
import { PAPER_WIDTHS } from '@/services/shared/receiptLayout/types'
import { input } from './helpers'

describe('interpret — la canónica de punta a punta', () => {
  it.each(PAPER_WIDTHS)('a %i columnas ningún renglón se pasa del papel', width => {
    for (const l of interpret(CANONICAL_LAYOUT, input(), width)) {
      if (l.kind === 'text') expect(l.double ? l.text.length * 2 : l.text.length).toBeLessThanOrEqual(width)
    }
  })
  it('empieza con el logo y termina con la firma y el corte', () => {
    const lines = interpret(CANONICAL_LAYOUT, input(), 48)
    expect(lines[0]).toEqual({ kind: 'image', ref: 'logo', widthPct: 60, align: 'center' })
    expect(lines[lines.length - 1]).toEqual({ kind: 'cut' })
    expect(lines[lines.length - 2]).toMatchObject({ kind: 'text', text: 'Powered by Avoqado' })
  })
  it('🔴 respeta el orden de la receta: mover el bloque fiscal después de los artículos lo imprime después', () => {
    const movido = [...CANONICAL_LAYOUT]
    const [fiscal] = movido.splice(2, 1)
    movido.splice(
      movido.findIndex(b => b.type === 'totals'),
      0,
      fiscal,
    )
    const texts = interpret(movido, input(), 48).map(l => (l.kind === 'text' ? l.text : ''))
    expect(texts.indexOf('RFC: TCA2501231A6')).toBeGreaterThan(texts.findIndex(t => t.startsWith('Cant')))
  })
})
