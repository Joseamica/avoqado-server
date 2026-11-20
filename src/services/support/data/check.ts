import { Prisma } from '@prisma/client'
import { fmtCount, fmtDate, fmtMoney, fmtShortDay, fmtTime } from './format'
import { DASHES, hasLinkOrEmail, safeDbText, strictDbText } from './sanitize'

export type FigureKind = 'money' | 'count' | 'time' | 'shortDay' | 'date' | 'last4' | 'text' | 'strictText'
export interface Figure {
  kind: FigureKind
  shown: string
  value: unknown
  fallback?: string
}
export interface Rendered {
  text: string
  figures: Figure[]
}

/** De «4242» o de «411111******1111», sólo los últimos 4 dígitos. */
function fmtLast4(s: string): string {
  const end = /(\d{4})$/.exec(s.normalize('NFKC').trim())
  if (!end) throw new Error('La tarjeta no termina en 4 dígitos')
  return end[1]
}

function dbTextValue(value: unknown): string | null | undefined {
  if (value != null && typeof value !== 'string') throw new Error('Un texto de la base debe ser texto')
  return value
}

/**
 * Cada método formatea, anota su Figure y devuelve lo que se imprime; done() entrega el texto con sus cifras.
 * checkRendered coteja los huecos en el orden en que se llamaron los métodos: llámalos en el orden en que salen en el texto.
 */
export function template(timezone: string) {
  const figures: Figure[] = []
  const note = (figure: Figure): string => {
    figures.push(figure)
    return figure.shown
  }
  return {
    money: (v: number | string | Prisma.Decimal) => note({ kind: 'money', shown: fmtMoney(v), value: v }),
    count: (n: number) => note({ kind: 'count', shown: fmtCount(n), value: n }),
    time: (d: Date) => note({ kind: 'time', shown: fmtTime(d, timezone), value: d }),
    shortDay: (d: Date) => note({ kind: 'shortDay', shown: fmtShortDay(d, timezone), value: d }),
    date: (d: Date | string) => note({ kind: 'date', shown: fmtDate(d, timezone), value: d }),
    last4: (s: string) => note({ kind: 'last4', shown: fmtLast4(s), value: s }),
    /** safeDbText(raw): puede dar '[dato omitido]'. */
    text: (raw: string | null | undefined) => note({ kind: 'text', shown: safeDbText(raw), value: raw }),
    /** strictDbText(raw, fallback): nunca '[dato omitido]' (la caja). */
    strict: (raw: string | null | undefined, fallback: string) =>
      note({ kind: 'strictText', shown: strictDbText(raw, fallback), value: raw, fallback }),
    done: (text: string): Rendered => ({ text, figures: [...figures] }),
  }
}

function reformat(figure: Figure, timezone: string): string {
  const value = figure.value as never
  switch (figure.kind) {
    case 'money':
      return fmtMoney(value)
    case 'count':
      return fmtCount(value)
    case 'time':
      return fmtTime(value, timezone)
    case 'shortDay':
      return fmtShortDay(value, timezone)
    case 'date':
      return fmtDate(value, timezone)
    case 'last4':
      return fmtLast4(value)
    case 'text':
      return safeDbText(dbTextValue(figure.value))
    case 'strictText':
      if (typeof figure.fallback !== 'string') throw new Error('Un hueco estricto necesita su texto fijo')
      return strictDbText(dbTextValue(figure.value), figure.fallback)
    default:
      throw new Error('Hueco desconocido')
  }
}

const MINUS_BEFORE = new RegExp(`[${DASHES}]\\s*$`, 'u')
/**
 * Los huecos que no entran a la búsqueda de ligas y correos (T-B39): su formato lleva puntos, dos puntos y guiones, y sale de una
 * función de format.ts, no de la base. Se cambian por su primer y su último carácter, para que lo pegado a ellos se vea igual que en
 * el texto (T-B39b: un «#» es puntuación, y «cafe.jue 12-nov» ya no se habría visto pegado).
 */
const UNSCANNED: ReadonlySet<FigureKind> = new Set(['money', 'time', 'shortDay', 'date'])
const ends = (shown: string): string => {
  const chars = Array.from(shown)
  return chars.length > 1 ? chars[0] + chars[chars.length - 1] : shown
}

/**
 * true sólo si: cada Figure vuelve a formatearse desde su value y da su shown; quitando una vez cada shown en su orden, el texto no
 * tiene ningún dígito; el texto no tiene 8 o más dígitos seguidos; ningún importe positivo lleva un guion o un menos delante; el
 * texto entero, fuera de los huecos de importe, fecha y hora, no trae una forma de correo, «://», una IPv4 ni un punto pegado que no
 * esté entre dos dígitos (T-B39 y T-B39b; los huecos de texto sí entran: lo que da safeDbText no trae ninguno); y mide ≤ 1,500 caracteres y
 * ≤ 7 renglones. Los dígitos (`\p{Nd}`, `\p{Nl}` y `\p{No}`) se buscan después de NFKC y sin caracteres de
 * formato, para que un superíndice, un dígito encerrado, un «〇» o uno de ancho cero no se cuelen.
 */
export function checkRendered(rendered: Rendered, timezone: string): boolean {
  try {
    const { text, figures } = rendered
    if (typeof text !== 'string' || text.length > 1500 || text.split(/\r\n|[\n\r\u2028\u2029]/).length > 7) return false
    const plain = text.normalize('NFKC').replace(/\p{Cf}/gu, '')
    if (/[\p{Nd}\p{Nl}\p{No}]{8}/u.test(plain)) return false
    let outside = ''
    let scanned = ''
    let at = 0
    for (const figure of figures) {
      if (typeof figure.shown !== 'string' || reformat(figure, timezone) !== figure.shown) return false
      const found = plain.indexOf(figure.shown, at)
      if (found < 0) return false
      // un importe positivo con un guion, una raya, un menos o un parecido (DASHES) pegado se leería negativo: el signo lo pone sólo fmtMoney
      if (figure.kind === 'money' && !figure.shown.startsWith('\u2212') && MINUS_BEFORE.test(plain.slice(0, found))) return false
      outside += plain.slice(at, found)
      scanned += plain.slice(at, found) + (UNSCANNED.has(figure.kind) ? ends(figure.shown) : figure.shown)
      at = found + figure.shown.length
    }
    return !/[\p{Nd}\p{Nl}\p{No}]/u.test(outside + plain.slice(at)) && !hasLinkOrEmail(scanned + plain.slice(at))
  } catch {
    return false
  }
}
