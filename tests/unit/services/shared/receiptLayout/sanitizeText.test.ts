import { forceReceiptText, sanitizeReceiptText } from '@/services/shared/receiptLayout/sanitizeText'

describe('sanitizeReceiptText', () => {
  it('acepta español con acentos, ñ y signos ¿¡', () => {
    expect(sanitizeReceiptText('¡Gracias por tu compra, Ñoño! ¿Volvés?')).toEqual({
      ok: true,
      text: '¡Gracias por tu compra, Ñoño! ¿Volvés?',
    })
  })

  it('normaliza a NFC (la e + tilde combinada se vuelve un solo carácter)', () => {
    const r = sanitizeReceiptText('cafe\u0301')
    expect(r).toEqual({ ok: true, text: 'café' })
  })

  it('🔴 rechaza ESC y GS: son comandos de impresora, no texto', () => {
    expect(sanitizeReceiptText('hola\u001Bm')).toMatchObject({ ok: false, reason: 'control' })
    expect(sanitizeReceiptText('hola\u001DV\u0000')).toMatchObject({ ok: false, reason: 'control' })
    expect(sanitizeReceiptText('a\tb')).toMatchObject({ ok: false, reason: 'control' })
  })

  it('rechaza bidi y ancho cero', () => {
    expect(sanitizeReceiptText('a\u202Eb')).toMatchObject({ ok: false, reason: 'bidi' })
    expect(sanitizeReceiptText('a\u200Bb')).toMatchObject({ ok: false, reason: 'zeroWidth' })
  })

  it('rechaza lo que el papel no imprime (emoji, CJK) diciendo cuál', () => {
    expect(sanitizeReceiptText('Gracias 🙏')).toEqual({ ok: false, reason: 'nonLatin1', offending: '🙏' })
    expect(sanitizeReceiptText('謝謝')).toMatchObject({ ok: false, reason: 'nonLatin1' })
  })
})

describe('forceReceiptText (defensa en profundidad del intérprete)', () => {
  it('borra controles y bidi, y sustituye lo no imprimible por ?', () => {
    expect(forceReceiptText('ho\u001Bla\u202E 🙏 café')).toBe('hola ? café')
  })
})
