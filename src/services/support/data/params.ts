import { Prisma } from '@prisma/client'
import { fromZonedTime } from 'date-fns-tz'
import { venueDayKey } from '@/utils/venueDateKeys'
import type { DataScope } from './catalog'

/** Monto, hora y día que propone la IA: el código sólo los acepta si están en el mensaje de la persona. Puras. */

export interface TimeWindow {
  from: Date
  to: Date
}
type Clock = Pick<DataScope, 'timezone' | 'now'>

const MAX_AMOUNT = new Prisma.Decimal('9999999.99')
const HALF_HOUR = 30 * 60 * 1000

/**
 * Minúsculas, sin acentos, dígitos de ancho completo a normales (NFKD) y un solo espacio. Las marcas de la hora se escriben de una sola
 * forma («2pm», «2 p. m.» → «2 pm»; «14:30hrs», «14:30 hr.» → «14:30 hrs»; tras «la/las N» o «H:MM», «en la/por la tarde» y «de esta
 * tarde» → «de la tarde»); los dígitos no cambian. «en la tarde» sólo cambia tras una hora: «cobré 85 en la tarde» sigue siendo un monto.
 */
const plain = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(\d) ?([ap])\.? ?m\b\.?/g, '$1 $2m')
    .replace(/(\d) ?hrs?\b\.?/g, '$1 hrs')
    .replace(
      /(\blas? \d{1,2}(?:[:.]\d{2})?|\d:\d{2}) (?:(?:en|por) la (manana|madrugada|tarde|noche)|de esta (manana|tarde|noche))\b/g,
      '$1 de la $2$3',
    )

/** «a las 2», «la 1», «las 2.30», «14:30», «2 pm», «9 de la noche», «12 del día»: números de una hora, que no son montos. «la 1,250» sí es monto. */
const HOURS_IN_TEXT =
  /\blas? \d{1,2}(?:[:.]\d{2})?(?!\d|[.,]\d)|(?<!\d)\d{1,2}:\d{2}(?!\d)|(?<![\d.,])\d{1,2} ?(?:[ap]m\b|hrs\b|de la (?:manana|madrugada|tarde|noche)|del dia)/g
/** Dígitos con o sin comas de miles y hasta 2 decimales, que no sean parte de un número más largo («850.505», «12,3456»). */
const AMOUNT_IN_TEXT = /(?<![\d.,:])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?![\d:]|[.,]\d)/g

/**
 * El número de algo, no un monto (C7 r1): el número SUELTO justo después de «mesa», «ticket», «orden», «pedido», «folio», «caja»,
 * «terminal», «#» o «no.» («la venta de la mesa 5» no es un cobro de $5.00). Sobre el texto de `plain`, así que sin importar mayúsculas
 * ni acentos («Órden»). T-B49: nunca uno con marca de dinero: con «$» justo antes ya no va pegado a la palabra, y con «peso», «pesos» o
 * «mxn» justo después se queda («entraron a caja 850 pesos»). El número se toma entero (sin un dígito, un punto o una coma con dígito
 * después), para que la marca no se salte quitando sólo una parte («caja 1,250 pesos» no deja «250»). Costo aceptado: «caja 850» a secas
 * es la caja.
 */
const REFERENCE_NUMBER =
  /(?:\b(?:mesa|ticket|orden|pedido|folio|caja|terminal)\b|\bno\.|#) ?\d+(?:[.,]\d+)*(?!\d|[.,]\d| ?(?:pesos?|mxn)\b)/g

/** Cada monto que la persona escribió, como 'pesos.cc'. No cuenta los números de una hora («a las 2», «14:30», «2 pm») ni los de algo («la mesa 5»). */
export function amountsIn(message: string): string[] {
  const text = plain(message).replace(HOURS_IN_TEXT, ' ').replace(REFERENCE_NUMBER, ' ')
  return [...text.matchAll(AMOUNT_IN_TEXT)].map(([, int, cents]) =>
    new Prisma.Decimal(`${int.replace(/,/g, '')}.${cents ?? '0'}`).toFixed(2),
  )
}

/** El monto que dio la IA sólo vale si está en el mensaje. Exacto al centavo; null si no está, si no es un monto (o es cero) o si pasa de 9,999,999.99. */
export function matchAmount(message: string, claimed: string | null): Prisma.Decimal | null {
  const normalized = claimed?.replace(/[$,\s]/g, '')
  if (!normalized || !/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null
  const amount = new Prisma.Decimal(normalized)
  return amount.gt(0) && amount.lte(MAX_AMOUNT) && amountsIn(message).includes(amount.toFixed(2)) ? amount : null
}

/** 'yyyy-mm-dd' de hoy o de ayer en la sucursal: días de calendario, no de 24 h. */
function dayKey(day: 'today' | 'yesterday', { timezone, now }: Clock): string {
  const today = venueDayKey(now, timezone)
  return day === 'today' ? today : new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
}

/**
 * De las 00:00:00.000 a las 23:59:59.999 del día calendario de la sucursal (hoy o ayer), escritas como texto: la zona es la de la
 * sucursal y nunca la del proceso (D19), también el día que cambia la hora (Tijuana, 1-nov-2026: 25 h). Sólo lee `scope.now`.
 */
export function wholeDayBounds(day: 'today' | 'yesterday', scope: Clock): TimeWindow {
  const key = dayKey(day, scope)
  return { from: fromZonedTime(`${key}T00:00:00.000`, scope.timezone), to: fromZonedTime(`${key}T23:59:59.999`, scope.timezone) }
}

/**
 * Las 00:00 del primero de los últimos `days` días calendario de la sucursal, hoy incluido: con 7, seis días atrás (el «Últimos 7 días»
 * del panel, `getLast7Days`). Escrito como texto en la zona de la sucursal, como `wholeDayBounds`: no son `days` × 24 h, y la noche que
 * cambia la hora no lo mueve. Sólo lee `scope.now`.
 */
export function lastDaysStart(days: number, scope: Clock): Date {
  const first = new Date(Date.parse(`${venueDayKey(scope.now, scope.timezone)}T00:00:00Z`) - (days - 1) * 86_400_000)
  return fromZonedTime(`${first.toISOString().slice(0, 10)}T00:00:00.000`, scope.timezone)
}

/** hoy: del inicio del día de la sucursal a `now`; ayer: el día completo. */
export function dayBounds(day: 'today' | 'yesterday', scope: Clock): TimeWindow {
  const whole = wholeDayBounds(day, scope)
  return day === 'today' ? { from: whole.from, to: scope.now } : whole
}

/**
 * Una hora sólo es hora si lo dice: «la/las», «:» en los minutos, «am/pm», «hrs», «de la mañana/madrugada/tarde/noche» o «del día».
 * Los minutos con punto («2.30») cuentan sólo junto con otra marca: «14.30» a secas puede ser un monto.
 */
const TIME = /^(?:[a-z]+ )*?(las? )?(\d{1,2})(?:([:.])(\d{2}))?(?: ?(hrs|[ap]m|de la (?:manana|madrugada|tarde|noche)|del dia))?$/

/** Las horas del día (0-23) que puede querer decir y si dice mañana o tarde (`marked`); null si no es una hora. */
function readings(time: string): { hours: number[]; minutes: number; marked: boolean } | null {
  const m = TIME.exec(time)
  const qualifier = m?.[5] ?? ''
  if (!m || !(m[1] || m[3] === ':' || qualifier)) return null
  const hour = Number(m[2])
  const minutes = Number(m[4] ?? 0)
  if (minutes > 59) return null
  if (!qualifier || qualifier === 'hrs') {
    return hour > 23 ? null : { hours: hour >= 1 && hour <= 12 ? [hour % 12, (hour % 12) + 12] : [hour], minutes, marked: false }
  }
  if (hour < 1 || hour > 12) return null
  // «12 de la noche» y «12 de la mañana» se usan para las dos medianoches o para el mediodía; «del día» sólo es el mediodía
  if (hour === 12 && (qualifier === 'de la noche' || qualifier === 'de la manana')) return null
  if (qualifier === 'del dia') return hour === 12 ? { hours: [12], minutes, marked: true } : null
  // de 1 a 5, «de la noche» es de madrugada
  if (qualifier === 'de la noche') return { hours: [hour <= 5 ? hour : hour + 12], minutes, marked: true }
  const am = qualifier === 'am' || qualifier === 'de la manana' || qualifier === 'de la madrugada'
  return { hours: [am ? hour % 12 : (hour % 12) + 12], minutes, marked: true }
}

/**
 * T-B32: lo que sigue justo a la hora y dice que la persona escribió más que la IA: un dígito (pegado o tras `,` `.` `:` `-` `/` `h`
 * o espacios: «2 30», «2,30», «14h30», «2-3», «2 1/2»), «y» pegada a un dígito («2y30»), «menos» con lo que venga, «y» o «con»
 * seguidas de algo que no esté en su lista («a las 2 y no lo veo» y «a las 2 con tarjeta» pasan; «y media», «con 30» no), u otra
 * hora del rango («2 o 3»). Lo que esté más lejos lo revisa `LEFTOVER_*` (T-B36).
 */
const AFTER_Y = 'no|aun|todavia|ya|nada|tampoco|nunca|sigue|me|se|lo|le|quiero|necesito|cuanto|que'
const AFTER_CON = 'tarjeta|efectivo|visa|mastercard|master|amex|american|terminal|transferencia|qr|debito|credito|vale|vales|la|el|mi|su'
const CUT_SHORT = new RegExp(
  `^(?:[\\s,.:\\-/h]*\\d| ?y\\d|[\\s,]+menos\\b|[\\s,]+y\\b(?! (?:${AFTER_Y})\\b)|[\\s,]+con\\b(?! (?:${AFTER_CON})\\b)|[\\s,]+(?:a|hasta|o) (?:las? )?\\d)`,
)
// «del día de hoy/ayer» es una fecha, no el mediodía (T-B36c). `HOURS_IN_TEXT` sigue leyendo «12 del día de hoy» como hora: así los montos no cambian
const MARK = '(?:[ap]m|de la (?:manana|madrugada|tarde|noche)|del dia(?! (?:de )?(?:hoy|ayer)\\b))'
/** La marca de mañana o tarde que la IA no copió: «a las 2» en «a las 2 pm» descartaría la lectura que la persona sí dijo. */
const DROPPED_MARKER = new RegExp(`^[\\s,]*${MARK}\\b`)
/** Cualquier marca, también «en/por la tarde» y «de esta tarde» lejos de una hora: con la hora marcada, otra marca la corrige (O1). */
const ANY_MARKER = new RegExp(`\\b(?:${MARK}|(?:en|por) la (?:manana|madrugada|tarde|noche)|de esta (?:manana|tarde|noche))\\b`, 'g')
/** «entre las 2…», «después de las 2», «desde 2 pm»: la hora es un borde de un rango, no un punto (R4). */
const RANGE = '(?:entre|desde|hasta|antes de|despues de|a partir de|pasadas|pasaditas)'
const RANGE_WORD = new RegExp(`\\b${RANGE}\\b`)
const RANGE_BEFORE = new RegExp(`\\b${RANGE}(?: las?)?[\\s,]*$`)
/**
 * T-B36: una hora sólo cambia con un número, una palabra de número u hora, una marca o un borde de rango; fuera de las apariciones de la
 * hora de la IA no puede quedar ninguno. Números: cada corrida de dígitos con `.` `,` `:` entre ellos; la de 1 o 2 dígitos sin `$`
 * antes ni «pesos/mxn» después niega si vale hasta 59 después de la primera aparición (minutos u otra hora: «a las 2, no, 3») o hasta
 * 24 antes (el comienzo de un rango o la hora corregida: «de 2 a 3 pm»). Con decimales, comas o 3 dígitos o más es un monto y no cuenta,
 * salvo «H.MM» o «H,MM» después de la hora, con H hasta 24 y MM hasta 59 («a las 2, no, 2.30»; T-B36b). Antes, «cobré 12.50 a las 2»
 * es un monto. Si la hora de la IA lleva una de estas palabras («cuarto para las 3»), tampoco se entiende.
 * Un monto chico sin marca de dinero también niega («cobré 20 a las 2», «a las 2 de 45»): costo aceptado (T-B48). No se excusa con el
 * monto que validó `matchAmount`: la IA puede tomar por monto la hora corregida («cobré 850 a las 2, no, 3»; Codex bloque 3 r1 y r2).
 * Riesgos que quedan, aceptados: un error de dedo en la palabra («a las 2 trenta») da la ventana de las 2:00; tampoco se reconocen un
 * rango que se abre después de la hora («de las 2 en adelante», «a las 2 o después», «luego de las 2»), palabras de número pegadas
 * («treintaycinco»), dígitos pegados («245», «1445») ni dígitos de otras escrituras.
 */
const LEFTOVER_NUMBER = /\d+(?:[.,:]\d+)*/g
const LEFTOVER_WORD =
  /\b(?:la una|una hora|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieci\w+|veinte|veinti\w+|treinta|cuarenta|cincuenta|media|cuarto|mediodia|medio dia|medianoche)\b/g

/**
 * Sin hora: [dayBounds]. Con hora: ±30 min; de 1 a 12 sin «de la mañana/tarde/noche» ni «am/pm», sus dos lecturas. Cada ventana
 * se recorta al día y a `now`; la que empieza en el futuro se descarta; salen ordenadas de la más temprana a la más tardía. null = la hora no está en el mensaje, no es una hora, o
 * no quedó ninguna ventana.
 */
export function timeWindows(time: string | null, message: string, day: 'today' | 'yesterday', scope: Clock): TimeWindow[] | null {
  const bounds = dayBounds(day, scope)
  const wanted = plain(time ?? '')
  if (!wanted) return [bounds]
  const read = readings(wanted)
  if (!read || RANGE_WORD.test(wanted) || wanted.match(LEFTOVER_WORD)) return null
  // Tal cual en el mensaje, y completa cada vez que aparece: «a las 1» no está en «a las 10», ni «2 pm» en «12 pm», ni «a las 2» en «a las 2.30»,
  // y no empieza pegada a una letra, un dígito o `:` `.` `,`: «a la 1» no está en «hasta la 1», ni «3 pm» en «2,3 pm»
  const text = plain(message)
  const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const found = [...text.matchAll(new RegExp(`(?<![\\d:.,a-z])${escaped}`, 'g'))].map(m => m.index ?? 0)
  if (!found.length) return null
  const cutShort = (at: number) => {
    const after = text.slice(at + wanted.length)
    return RANGE_BEFORE.test(text.slice(0, at)) || CUT_SHORT.test(after) || (!read.marked && DROPPED_MARKER.test(after))
  }
  const outside = ({ 0: hit, index = 0 }: RegExpMatchArray) => !found.some(at => index < at + wanted.length && at < index + hit.length)
  const loose = ({ 0: n, index = 0 }: RegExpMatchArray) => {
    const before = index < found[0]
    const [, h, mm] = /^(\d{1,2})(?:[.,](\d{2}))?$/.exec(n) ?? []
    const hour = mm ? !before && Number(h) <= 24 && Number(mm) <= 59 : h !== undefined && Number(h) <= (before ? 24 : 59)
    return hour && !/\$ ?$/.test(text.slice(0, index)) && !/^ ?(?:pesos|mxn)\b/.test(text.slice(index + n.length))
  }
  // Otra hora en cualquier parte del mensaje («a las 2 y no, a las 3», «de las 2 a las 3»): no se sabe cuál quiso
  const otherHour = [...text.matchAll(HOURS_IN_TEXT)].some(outside)
  const leftover =
    [...text.matchAll(LEFTOVER_WORD)].some(outside) ||
    [...text.matchAll(LEFTOVER_NUMBER)].some(m => outside(m) && loose(m)) ||
    (read.marked && [...text.matchAll(ANY_MARKER)].some(outside))
  if (otherHour || leftover || found.some(cutShort)) return null
  const key = dayKey(day, scope)
  const pad = (n: number) => String(n).padStart(2, '0')
  const windows = read.hours
    .map(hour => {
      // La noche que se atrasa el reloj, la hora repetida sólo cubre su primera vez
      const at = fromZonedTime(`${key}T${pad(hour)}:${pad(read.minutes)}:00.000`, scope.timezone).getTime()
      return {
        from: new Date(Math.max(at - HALF_HOUR, bounds.from.getTime())),
        to: new Date(Math.min(at + HALF_HOUR, bounds.to.getTime())),
      }
    })
    .filter(w => w.from < w.to) // la que empieza después de `now` queda vacía
  return windows.length ? windows : null
}
