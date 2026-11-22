/**
 * D40 (Flautas Coyoacán, como Fudo): una nota por cada PARTE del paquete. Viaja del POS como `modifierNotes: { modifierId: nota }`
 * y a la cocina DENTRO de la etiqueta de su parte, con la misma forma que arma el POS (`NotaDelExtra.kt`).
 */
import {
  limpiarNotaDelExtra,
  MAX_NOTA_DEL_EXTRA,
  notasDeLasPartes,
  toKdsModifierLabels,
} from '../../../../src/services/kds/kdsModifierLabels'

describe('D40 · la nota de cada parte en la comanda', () => {
  it('P1 la nota sale pegada a SU parte; una parte repetida trae la nota en cada vez', () => {
    expect(
      toKdsModifierLabels([
        { name: 'Consomé', quantity: 1, notes: 'sin cebolla' },
        { name: 'Flautas Cochinita', quantity: 1, notes: 'salsa combinada' },
        { name: 'Flautas Cochinita', quantity: 1, notes: 'salsa combinada' },
        { name: 'Agua', quantity: 1, notes: null },
      ]),
    ).toEqual([
      'Consomé\nNota: sin cebolla',
      'Flautas Cochinita\nNota: salsa combinada',
      'Flautas Cochinita\nNota: salsa combinada',
      'Agua',
    ])
    expect(toKdsModifierLabels([{ name: 'Flautas Cochinita', quantity: 2, notes: 'salsa combinada' }])).toEqual([
      '2x Flautas Cochinita\nNota: salsa combinada',
    ])
  })

  it('P1 sin nota el nombre queda byte a byte (Codex r2 #2); un nombre con «⏎Nota: » es el riesgo cosmético aceptado', () => {
    expect(toKdsModifierLabels([{ name: 'Consomé (Nota: sin cebolla)', quantity: 1 }])).toEqual(['Consomé (Nota: sin cebolla)'])
    // Riesgo aceptado (decisión A): igual a una nota de verdad. Sólo cambia cómo se ve.
    expect(toKdsModifierLabels([{ name: 'Consomé\nNota: sin cebolla', quantity: 1 }])).toEqual(
      toKdsModifierLabels([{ name: 'Consomé', quantity: 1, notes: 'sin cebolla' }]),
    )
  })

  it('P1 la nota se limpia con la MISMA lista de caracteres que el POS (Codex r2 #7)', () => {
    // Vectores compartidos con NotaDelExtraTest.kt (ANDROID/WINDOWS): deben dar lo mismo en los dos lados.
    expect(limpiarNotaDelExtra('sin\u2028cebolla')).toBe('sin cebolla')
    expect(limpiarNotaDelExtra('sin\u0085cebolla')).toBe('sin cebolla')
    expect(limpiarNotaDelExtra('\uFEFF sin\u00A0\u3000cebolla \u200A')).toBe('sin cebolla')
    expect(limpiarNotaDelExtra('sin\u200Bcebolla')).toBe('sin\u200Bcebolla') // el espacio de ancho cero no es espacio en ninguno de los dos
  })

  it('P1 la etiqueta guardada en la comanda se lee tal cual (el lector vuelve a pasar los textos por el normalizador)', () => {
    expect(toKdsModifierLabels(['Consomé\nNota: sin cebolla', 'Agua'])).toEqual(['Consomé\nNota: sin cebolla', 'Agua'])
  })

  it('P1 sin nota la etiqueta es idéntica a la de antes', () => {
    expect(toKdsModifierLabels([{ name: 'Agua', quantity: 1 }, { name: 'Agua', quantity: 1, notes: '   ' }, 'Gelatina'])).toEqual([
      'Agua',
      'Agua',
      'Gelatina',
    ])
  })

  it('P2 la nota se limpia: una línea, sin espacios de sobra y con tope', () => {
    expect(limpiarNotaDelExtra('  sin\n cebolla \t')).toBe('sin cebolla')
    expect(limpiarNotaDelExtra('   ')).toBeNull()
    expect(limpiarNotaDelExtra(42)).toBeNull()
    expect(limpiarNotaDelExtra('sin\u0000cebolla\u0007')).toBe('sin cebolla') // un NUL tumbaba el guardado en Postgres
    expect(limpiarNotaDelExtra('x'.repeat(500))).toHaveLength(MAX_NOTA_DEL_EXTRA)
  })

  it('P1 sólo cuentan las notas de las partes que el renglón trae; la basura se ignora, nunca rechaza', () => {
    const notas = notasDeLasPartes({ consome: ' sin cebolla ', ajeno: 'no', agua: 5, gelatina: '' }, ['consome', 'agua', 'gelatina'])
    expect([...notas]).toEqual([['consome', 'sin cebolla']])
    expect(notasDeLasPartes(null, ['consome']).size).toBe(0)
    expect(notasDeLasPartes('sin cebolla', ['consome']).size).toBe(0)
    expect(notasDeLasPartes(['sin cebolla'], ['consome']).size).toBe(0)
  })
})
