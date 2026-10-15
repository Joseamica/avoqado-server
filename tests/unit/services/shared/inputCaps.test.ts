import { createHash } from 'crypto'

import { capItemNote, MAX_ITEM_NOTE_CHARS } from '@/services/shared/inputCaps'

/**
 * D5 v3 (mesas40, 15-oct): la nota es parte de la IDENTIDAD de la línea (`normalizeAddItems` y el match contra filas
 * existentes). Un recorte pelón fusionaba dos notas distintas con el mismo prefijo y el carrito reenviado SUMABA
 * cantidades ($200 → $400, Codex P1). El recorte ahora es inyectivo: prefijo + «…» + 8 hex de sha256(nota completa).
 */
const puntos = (s: string) => Array.from(s).length
const huella = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 8)

describe('capItemNote — recorte inyectivo de la nota de un artículo', () => {
  it('hasta 500 puntos de código queda IDÉNTICA, aunque mida más de 500 en UTF-16', () => {
    const taquitos = '🌮'.repeat(500)
    expect(taquitos).toHaveLength(1_000)
    expect(capItemNote(taquitos)).toBe(taquitos)
    expect(capItemNote('a'.repeat(500))).toBe('a'.repeat(500))
    expect(capItemNote('sin cebolla')).toBe('sin cebolla')
  })

  it('nulo, indefinido y vacío pasan tal cual', () => {
    expect(capItemNote(null)).toBeNull()
    expect(capItemNote(undefined)).toBeUndefined()
    expect(capItemNote('')).toBe('')
  })

  it('🔴 más de 500: exactamente 500 puntos de código = primeros 491 + «…» + 8 hex de sha256(nota completa)', () => {
    const nota = 'a'.repeat(10_038)

    const recortada = capItemNote(nota)

    expect(puntos(recortada)).toBe(MAX_ITEM_NOTE_CHARS)
    expect(recortada).toBe('a'.repeat(491) + '…' + huella(nota))
  })

  it('🔴 dos notas que sólo difieren DESPUÉS del carácter 500 dan resultados distintos', () => {
    const base = 'a'.repeat(500)

    expect(capItemNote(base + 'A')).not.toBe(capItemNote(base + 'B'))
    expect(capItemNote(base + 'A')).toBe('a'.repeat(491) + '…' + huella(base + 'A'))
  })

  it('determinista e idempotente: cap(cap(x)) === cap(x)', () => {
    const nota = 'x'.repeat(300) + '🌮'.repeat(400)
    const una = capItemNote(nota)

    expect(capItemNote(nota)).toBe(una)
    expect(capItemNote(una)).toBe(una)
  })

  it('🔴 el emoji del borde queda ENTERO (nunca medio surrogate)', () => {
    const nota = 'a'.repeat(490) + '🌮' + 'b'.repeat(600)

    const recortada = capItemNote(nota)

    expect(recortada).toBe('a'.repeat(490) + '🌮' + '…' + huella(nota))
    expect(puntos(recortada)).toBe(MAX_ITEM_NOTE_CHARS)
  })
})
