import { scrubSupportText } from '@/services/support/privacy'
import { sanitizeTemplateVar, stripWhatsappControls } from '@/utils/whatsappSanitize'
import { SUPPORT_DATA_OMITTED } from './texts'

/**
 * Las reglas de salida para todo texto que viene de la base (nombres de servicio, cliente, personal, mesa o sucursal) antes de
 * entrar al hueco de una plantilla de la B. Son más estrictas que el filtro de entrada (`support/privacy.ts`), que no cambia.
 */

/** Un dígito: también los encerrados y de adorno (❶, ➀, ⓵) y las letras-número («〇»), que NFKC no convierte. */
const ID_DIGIT = '[\\p{Nd}\\p{Nl}\\p{No}]'
/**
 * Los seis dígitos de un RFC o una CURP son una fecha posible (aa, mes 01-12, día 01-31): así «$8,500.00 VIP» (850000) no es un
 * RFC. Si el mes o el día traen un dígito que no es 0-9 (de otra escritura o de adorno), la fecha no se puede leer como número y
 * se toma por posible.
 */
const UNREADABLE_DIGIT = '(?:[^\\P{Nd}0-9]|[\\p{Nl}\\p{No}])'
const datePart = (ascii: string) => `(?:${ascii}|${UNREADABLE_DIGIT}${ID_DIGIT}|${ID_DIGIT}${UNREADABLE_DIGIT})`
const BIRTH_DATE = `${ID_DIGIT}{2}${datePart('0[1-9]|1[0-2]')}${datePart('0[1-9]|[12][0-9]|3[01]')}`
const RFC = new RegExp(`[A-ZÑ&]{3,4}${BIRTH_DATE}(?:[A-Z]|${ID_DIGIT}){3}`, 'u')
const CURP = new RegExp(`[A-Z]{4}${BIRTH_DATE}[HM][A-Z]{5}(?:[A-Z]|${ID_DIGIT})${ID_DIGIT}`, 'u')
const EMAIL = /[\p{L}\p{Nd}._%+-]+@[\p{L}\p{Nd}.-]+\.\p{L}{2,}/u
const MONEY_WORD = /(?<!\p{L})(?:mxn|pesos?)(?!\p{L})/iu
const DIGIT = new RegExp(ID_DIGIT, 'gu')
/**
 * Lo que se lee como menos: guion, raya o menos, y sus parecidos ➖ ˗ ─ ━ ⁃. La lista se cierra aquí: otro parecido que falte es
 * riesgo residual aceptado. `check.ts` usa la misma para la regla del menos.
 */
export const DASHES = '\\p{Pd}\\u2212\\u2796\\u02d7\\u2500\\u2501\\u2043'
/** Un guion al final: pegado al importe que sigue, lo volvería negativo en la respuesta. */
const TRAILING_DASH = new RegExp(`[\\s${DASHES}]+$`, 'u')

/**
 * Paso 1: sin controles de WhatsApp y NFKC; renglones, controles y los invisibles que se ven como espacio (los rellenos de hangul y
 * el braille en blanco) como espacio; luego sin caracteres de formato ni ignorables por omisión (ancho cero, unión de grafemas,
 * selectores de variante, vocales inherentes jemer, selectores mongoles), que ya no incluyen a los rellenos; «。» como «.».
 */
function normalizeDbText(raw: string): string {
  return (
    stripWhatsappControls(raw)
      .normalize('NFKC')
      .replace(/[\p{Cc}\p{Zl}\p{Zp}\u115f\u1160\u3164\u2800]/gu, ' ')
      .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '')
      .replace(/\u3002/gu, '.')
      .replace(/\s+/gu, ' ')
      .trim()
      // quitar un carácter de formato puede dejar juntos una letra y su acento: se componen, y aplicarla dos veces no cambia nada
      .normalize('NFKC')
  )
}

const LINK = '[enlace]'
// T-B35: una liga sin esquema necesita un punto pegado entre dos etiquetas, en cualquier escritura, puerto o terminación. No se
// adivina qué es un dominio: se despega el punto. Costo aceptado: «cafe. com» todavía se LEE como dominio, pero ya no se puede tocar.
/** Paso A: cualquier esquema en cualquier combinación de mayúsculas, o un «://» suelto, hasta el siguiente espacio. */
const SCHEME_LINK = /(?:[a-z][a-z0-9+.-]*)?:\/\/\S*/giu
/** Paso B: una IPv4 (cuatro grupos de 1 a 3 dígitos), con su puerto y su ruta. Una fecha o unos miles con puntos no lo son. */
const DOTTED_DIGITS = /\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/\S*)?/gu
/**
 * Paso C (T-B39b): un punto pegado, tras algo que no es espacio y ANTES de algo que no es espacio ni puntuación. Una etiqueta de
 * dominio sólo sigue con una letra, un dígito, una marca o un símbolo: tras «,» «:» «)» «»» o de otro punto no hay liga posible.
 */
const GLUED_DOT = /(?<=(\S))\.(?=([^\s\p{P}]))/gu
const ONE_DIGIT = new RegExp(`^${ID_DIGIT}$`, 'u')
/** T-B39c, sólo en safeDbText: el principio del valor es la orilla de un hueco, y cuenta como un «antes» que no es dígito. */
const LEADING_DOT = /^\.(?=[^\s\p{P}])/u

/** Paso A, y luego el detector de la fase 1 (el de `sanitizeTemplateVar`, sin tope de largo: sólo repite el paso A). */
const withoutSchemes = (text: string): string => sanitizeTemplateVar(text.replace(SCHEME_LINK, LINK), Number.POSITIVE_INFINITY)

/**
 * Pasos B y C: la IP sale «[enlace]», y cada punto pegado lleva un espacio después, salvo entre dos dígitos («2.5 L»); también uno
 * al principio («.Ana» → «. Ana»).
 */
const withoutGluedDots = (text: string): string =>
  text
    .replace(DOTTED_DIGITS, LINK)
    .replace(GLUED_DOT, (dot, before: string, after: string) => (ONE_DIGIT.test(before) && ONE_DIGIT.test(after) ? dot : '. '))
    .replace(LEADING_DOT, '. ')

/**
 * T-B39: la regla de salida sobre un texto ENTERO (la respuesta que arma una plantilla), con los mismos detectores: forma de correo,
 * «://», una IPv4 o un punto pegado (el del paso C, T-B39b) que no esté entre dos dígitos. Lo que da safeDbText ya no
 * trae ninguno. El correo se busca tal cual (no pegado): pegar todo el mensaje juntaría palabras de oraciones distintas.
 */
export function hasLinkOrEmail(text: string): boolean {
  const plain = normalizeDbText(text)
  return (
    EMAIL.test(plain) ||
    plain.search(SCHEME_LINK) >= 0 ||
    plain.search(DOTTED_DIGITS) >= 0 ||
    [...plain.matchAll(GLUED_DOT)].some(([, before, after]) => !(ONE_DIGIT.test(before) && ONE_DIGIT.test(after)))
  )
}

/** Forma de correo, tal cual o pegado (sólo letras, dígitos, «@» y «.»). */
function looksLikeEmail(upper: string): boolean {
  return [upper, upper.replace(/[^\p{L}\p{Nd}@.]/gu, '')].some(s => EMAIL.test(s))
}

/**
 * Pasos 2 a 4: 8 o más dígitos en total, lo que marca el filtro de entrada, o forma de correo, RFC o CURP, tal cual o pegado.
 * Pegado para el correo: sólo letras, dígitos, «@» y «.»; para RFC y CURP: sólo letras, dígitos y «&» (un punto no los separa).
 */
function hidesDbData(text: string): boolean {
  if ((text.match(DIGIT)?.length ?? 0) >= 8) return true
  const scrub = scrubSupportText(text)
  if (scrub.sensitive || scrub.tooLong) return true
  const upper = text.toUpperCase()
  return looksLikeEmail(upper) || [upper, upper.replace(/[^\p{L}\p{Nd}\p{Nl}\p{No}&]/gu, '')].some(s => RFC.test(s) || CURP.test(s))
}

/** Normalizado y sin un guion, una raya o un menos al final. */
const tidyDbText = (text: string): string => normalizeDbText(text).replace(TRAILING_DASH, '')

/**
 * Paso 5, después de los espacios del paso C: 40 puntos de código (nunca medio emoji). Si el corte cae dentro de un «[enlace]»,
 * corta antes de él. Lo cortado no termina en espacio ni en guion («cafe. » → «cafe.»), así que otra pasada no lo cambia. Vacío
 * sólo si no queda nada que no sea liga.
 */
function cutDbText(text: string): string {
  const chars = Array.from(text)
  if (chars.length <= 40) return text
  let head = chars.slice(0, 40).join('')
  const rest = chars.slice(40).join('')
  for (let k = 1; k < LINK.length; k++) {
    if (head.endsWith(LINK.slice(0, k)) && rest.startsWith(LINK.slice(k))) head = head.slice(0, -k)
  }
  return tidyDbText(head)
}

/**
 * La regla de estructura de la Parte 2, en su orden. Idempotente. null, undefined o vacío → ''. Un nombre que sólo es guiones →
 * '[dato omitido]'.
 */
export function safeDbText(raw: string | null | undefined): string {
  if (!normalizeDbText(raw ?? '')) return ''
  const normalized = tidyDbText(raw ?? '')
  if (!normalized) return SUPPORT_DATA_OMITTED
  // el correo va antes que los enlaces: «ana @ cafe.com» se omite entero, no queda «ana @ [enlace]»
  if (looksLikeEmail(normalized.toUpperCase())) return SUPPORT_DATA_OMITTED
  // los esquemas, antes de contar dígitos: los dígitos de una ruta no omiten el nombre entero
  const text = withoutSchemes(normalized)
  if (hidesDbData(text)) return SUPPORT_DATA_OMITTED
  // la IP y los puntos pegados, después del RFC y la CURP (un RFC con puntos se ve entero) y antes del corte
  // el corte puede dejar una forma nueva (un correo o un PIN que acaba justo ahí): se revisa otra vez
  const cut = cutDbText(withoutGluedDots(text))
  return !cut || hidesDbData(cut) ? SUPPORT_DATA_OMITTED : cut
}

/** Signo o palabra de moneda, un dígito con punto o coma y otro dígito, o tres dígitos seguidos sin una letra entre ellos. */
const looksLikeAmount = (text: string): boolean =>
  /\p{Sc}/u.test(text) ||
  MONEY_WORD.test(text) ||
  /[\p{Nd}\p{Nl}\p{No}][.,][\p{Nd}\p{Nl}\p{No}]/u.test(text) ||
  /[\p{Nd}\p{Nl}\p{No}]{3}/u.test(text.replace(/[^\p{L}\p{Nd}\p{Nl}\p{No}]/gu, ''))

/**
 * El filtro estricto de la caja (su última barrera). Nunca da '[dato omitido]': da `fallback`. El `fallback` lo escribe el código y
 * no puede traer cifras ni signos de moneda: si los trae, lanza (así la plantilla falla al armarse y checkRendered da false).
 */
export function strictDbText(raw: string | null | undefined, fallback: string): string {
  if (/[\p{Nd}\p{Nl}\p{No}\p{Sc}]/u.test(fallback.normalize('NFKC'))) {
    throw new Error('El texto fijo de un hueco estricto no puede traer cifras ni signos de moneda')
  }
  const safe = safeDbText(raw)
  if (!safe || safe === SUPPORT_DATA_OMITTED) return fallback
  return [normalizeDbText(raw ?? ''), safe].some(looksLikeAmount) ? fallback : safe
}
