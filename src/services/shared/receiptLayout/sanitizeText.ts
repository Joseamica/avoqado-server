/**
 * El texto libre del negocio acaba convertido DIRECTO a bytes ESC/POS en las apps
 * (ESCPOSPrinter.kt:280-284). Un ESC (0x1B) o GS (0x1D) dentro de un texto guardado
 * cortaría papel o cambiaría el formato. Por eso el servidor RECHAZA al guardar y
 * cada intérprete vuelve a sanear antes de emitir (spec § 5.4).
 */
/* eslint-disable no-control-regex -- Este módulo EXISTE para cazar caracteres de control:
   las clases \u0000-\u001F y \u007F-\u009F son su objeto, no un descuido. Se escriben
   SIEMPRE como escapes \uXXXX y nunca como bytes crudos: un carácter invisible aquí es
   indistinguible a la vista y cualquier normalización del archivo lo borraría en silencio,
   desarmando la defensa contra inyección de comandos ESC/POS (P1-8 de la auditoría). */
export type SanitizeResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'control' | 'bidi' | 'zeroWidth' | 'nonLatin1'; offending: string }

const CONTROL = /[\u0000-\u001F\u007F-\u009F]/u
const BIDI = /[\u202A-\u202E\u2066-\u2069]/u
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/u
/** Todo lo que NO sea Latin-1 imprimible: U+0020-007E y U+00A0-00FF. */
const NON_LATIN1 = /[^ -~\u00A0-ÿ]/u

export function sanitizeReceiptText(raw: string): SanitizeResult {
  const text = raw.normalize('NFC')
  const control = CONTROL.exec(text)
  if (control) return { ok: false, reason: 'control', offending: control[0] }
  const bidi = BIDI.exec(text)
  if (bidi) return { ok: false, reason: 'bidi', offending: bidi[0] }
  const zero = ZERO_WIDTH.exec(text)
  if (zero) return { ok: false, reason: 'zeroWidth', offending: zero[0] }
  const foreign = NON_LATIN1.exec(text)
  if (foreign) return { ok: false, reason: 'nonLatin1', offending: foreign[0] }
  return { ok: true, text }
}

/** Nunca lanza: controles, bidi y ancho cero se borran; lo no imprimible se vuelve '?'. */
export function forceReceiptText(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\u200B-\u200D\u2060\uFEFF]/gu, '')
    .replace(/[^ -~\u00A0-ÿ]/gu, '?')
}
