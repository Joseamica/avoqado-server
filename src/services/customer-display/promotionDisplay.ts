// src/services/customer-display/promotionDisplay.ts
import { formatInTimeZone } from 'date-fns-tz'
import { DEFAULT_TIMEZONE, isWithinVenueSchedule } from '@/utils/datetime'
import { isValidIANATimezone } from '@/utils/sanitizeTimezone'
import { resolvePromotionLines } from '@/services/promotions/resolvePromotionLines'

/**
 * Lo que la pantalla del cliente ANUNCIA de una promoción (spec §5.7.3). PURO: sin base, sin red; el reloj y la zona
 * llegan por parámetro.
 */

export const MAX_PRICE_COMBINATIONS = 256

export interface OpcionParaAnuncio {
  quantity: number
  chargedQuantity: number
  priceDeltaCents: number
  listPriceCents: number
}
export interface GrupoParaAnuncio {
  minSelect: number
  maxSelect: number
  options: OpcionParaAnuncio[]
}
export interface PromocionParaAnuncio {
  type: 'BUNDLE' | 'COMBO' | 'DISCOUNT'
  pricingMode: 'FIXED_TOTAL' | 'PER_UNIT'
  priceCents: number
  groups: GrupoParaAnuncio[]
  /** true si al leerla se recortaron grupos u opciones: con datos parciales no se anuncia nada. */
  incompleta?: boolean
}

/** Precio de lista en centavos: la MISMA fórmula que el cobro de la promoción (`promotion.service.ts:176`). */
export function centavosDeLista(price: unknown): number {
  return Math.round(Number(price) * 100)
}

function* combinaciones(grupos: GrupoParaAnuncio[], i = 0, actual: OpcionParaAnuncio[] = []): Generator<OpcionParaAnuncio[]> {
  if (i === grupos.length) {
    yield actual
    return
  }
  for (const opcion of grupos[i].options) yield* combinaciones(grupos, i + 1, [...actual, opcion])
}

/**
 * FIXED_TOTAL: el precio base SÓLO si (a) todo grupo tiene al menos una opción y es de una sola; (b) ninguna opción
 * tiene sobreprecio; (c) para CADA selección posible el cobro real es exactamente el precio base (el tope
 * `min(catálogo, base)` de `resolvePromotionLines` nunca lo baja); (d) toda opción entrega lo que cobra. Si no, null.
 */
export function displayPriceCents(p: PromocionParaAnuncio): number | null {
  if (p.incompleta || p.type === 'DISCOUNT' || p.pricingMode !== 'FIXED_TOTAL') return null
  if (p.groups.length === 0) return null
  if (p.groups.some(g => g.options.length === 0 || g.minSelect !== 1 || g.maxSelect !== 1)) return null // (a)
  const opciones = p.groups.flatMap(g => g.options)
  if (opciones.some(o => o.priceDeltaCents !== 0)) return null // (b)
  if (opciones.some(o => o.quantity !== o.chargedQuantity)) return null // (d)
  let total = 1
  for (const g of p.groups) {
    total *= g.options.length
    if (total > MAX_PRICE_COMBINATIONS) return null
  }
  for (const seleccion of combinaciones(p.groups)) {
    const cobro = resolvePromotionLines({
      pricingMode: 'FIXED_TOTAL',
      priceCents: p.priceCents,
      selections: seleccion.map(o => ({ productId: '', ...o })),
    })
    if (cobro.netCents !== p.priceCents) return null // (c)
  }
  return p.priceCents
}

/** PER_UNIT: «{q}x{c}» sólo con UN grupo, la misma pareja en todas sus opciones y rebaja real (q > c ≥ 1). */
export function displayBadge(p: PromocionParaAnuncio): string | null {
  if (p.incompleta || p.type === 'DISCOUNT' || p.pricingMode !== 'PER_UNIT') return null
  if (p.groups.length !== 1 || p.groups[0].options.length === 0) return null
  const [{ quantity: q, chargedQuantity: c }] = p.groups[0].options
  if (!p.groups[0].options.every(o => o.quantity === q && o.chargedQuantity === c)) return null
  if (!Number.isInteger(q) || !Number.isInteger(c) || !(q > c && c >= 1)) return null
  return `${q}x${c}`
}

export interface OrdenDePresentacion {
  id: string
  name: string
  displayOrder: number
}

const COLACION = new Intl.Collator('es-MX', { sensitivity: 'base' })

/** 🔴 EL comparador (hallazgo E5): orden, nombre en español sin acentos ni mayúsculas, id por BYTES. */
export function compararPresentacion(a: OrdenDePresentacion, b: OrdenDePresentacion): number {
  if (a.displayOrder !== b.displayOrder) return a.displayOrder - b.displayOrder
  const porNombre = COLACION.compare(a.name, b.name)
  if (porNombre !== 0) return porNombre
  return Buffer.compare(Buffer.from(a.id, 'utf8'), Buffer.from(b.id, 'utf8'))
}

/** El entero que la tablet usa para ordenar SIN comparar cadenas: 0..n-1 sobre las tarjetas entregadas. */
export function presentationRanks(items: OrdenDePresentacion[]): Map<string, number> {
  return new Map([...items].sort(compararPresentacion).map((item, rango) => [item.id, rango]))
}

export interface HorarioDePromocion {
  validFrom: Date | null
  validUntil: Date | null
  daysOfWeek: number[]
  timeFrom: string | null
  timeUntil: string | null
}

/** La zona con que el SERVIDOR evalúa: la del venue si es válida; si no, la de México (como `isWithinVenueSchedule`). */
export function zonaUtilizable(cruda: string | null | undefined): string {
  return cruda && isValidIANATimezone(cruda) ? cruda : DEFAULT_TIMEZONE
}

/** El MISMO predicado que el catálogo del POS (`promotionCatalog.service.ts`, `isLiveAt`): fechas ∧ horario. */
export function vigenteEn(h: HorarioDePromocion, en: Date, zona: string): boolean {
  const dentroDeFechas = (!h.validFrom || en >= h.validFrom) && (!h.validUntil || en <= h.validUntil)
  return dentroDeFechas && isWithinVenueSchedule(h, en, zona)
}

function sumarDias(fecha: string, dias: number): string {
  const [y, m, d] = fecha.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + dias)).toISOString().slice(0, 10)
}

const MINUTO = 60_000
const HORIZONTE_MAXIMO_MS = 24 * 60 * MINUTO

/**
 * El desfase de la zona (hora local − UTC, en ms) en un instante, leído de Intl. 🔴 NO con `getTimezoneOffset` de date-fns-tz:
 * alrededor del cambio de horario de Tijuana devuelve el desfase según la zona del PROCESO (en `2026-03-08T04:00Z` da −7 h;
 * Intl, −8 h). El token `xxx` de `formatInTimeZone` sí lee el instante real.
 */
function desfase(zona: string, t: number): number {
  const s = formatInTimeZone(new Date(t), zona, 'xxx') // «-08:00»
  const signo = s.startsWith('-') ? -1 : 1
  const [hh, mm] = s.slice(1).split(':').map(Number)
  return signo * (hh * 60 + mm) * MINUTO
}

interface TramoDeLaZona {
  desfases: number[]
  /** El primer instante con el desfase nuevo, si la zona cambia de horario dentro del tramo. */
  salto: number | null
}
let ultimoTramo: { llave: string; valor: TramoDeLaZona } | null = null

/**
 * Los desfases de la zona en `(desde, hasta]` y su salto. Con 24 h de horizonte cabe a lo más UN cambio de horario (están a
 * meses de distancia); cae en minuto exacto, así que se busca por minutos. Se recuerda el último tramo: el carrusel pregunta
 * lo mismo para cada promoción de una construcción (medido: 1,200 promociones de Tijuana en ~120 ms).
 */
function tramoDeLaZona(zona: string, desde: number, hasta: number): TramoDeLaZona {
  const llave = `${zona}|${desde}|${hasta}`
  if (ultimoTramo?.llave === llave) return ultimoTramo.valor
  const antes = desfase(zona, desde)
  const despues = desfase(zona, hasta)
  let valor: TramoDeLaZona = { desfases: [antes], salto: null }
  if (antes !== despues) {
    let lo = Math.floor(desde / MINUTO)
    let hi = Math.ceil(hasta / MINUTO)
    while (hi - lo > 1) {
      const medio = Math.floor((lo + hi) / 2)
      if (desfase(zona, medio * MINUTO) === antes) lo = medio
      else hi = medio
    }
    valor = { desfases: [antes, despues], salto: hi * MINUTO }
  }
  ultimoTramo = { llave, valor }
  return valor
}

/**
 * La próxima apertura dentro del horizonte, o null: el PRIMER instante en que `vigenteEn` dice que sí (Codex r1 #5). Ese
 * instante siempre es uno de estos candidatos, y se toma el menor que esté vigente (uno de más nunca estorba; uno de menos,
 * sí):
 * - `validFrom`;
 * - la hora de apertura de pared —`timeFrom`, o el inicio del día sin ventana completa— de hoy, mañana y pasado, con CADA
 *   desfase del tramo: en otoño la misma hora local ocurre dos veces y las dos cuentan;
 * - el instante del salto: en primavera, una ventana que empezaba en la hora que no existe abre justo ahí.
 * Una ventana que cruza la medianoche no abre a medianoche (el día que cuenta es el que la abrió): no necesita candidato.
 *
 * 🔴 `horizonteMs` es de 24 h como máximo: los candidatos sólo cubren hoy, mañana y pasado, y el tramo supone a lo más UN
 * cambio de horario. Con más, lanza `RangeError` en vez de contestar `null` cuando sí abría (p. ej. el domingo a 7 días).
 */
export function proximaApertura(h: HorarioDePromocion, ahora: Date, zona: string, horizonteMs: number): Date | null {
  if (horizonteMs > HORIZONTE_MAXIMO_MS) {
    throw new RangeError(`proximaApertura: el horizonte máximo es de 24 h (se pidieron ${horizonteMs} ms)`)
  }
  const desde = ahora.getTime()
  const limite = desde + horizonteMs
  const { desfases, salto } = tramoDeLaZona(zona, desde, limite)
  const candidatas: number[] = []
  if (h.validFrom) candidatas.push(h.validFrom.getTime())
  if (salto !== null) candidatas.push(salto)
  const [hh, mm] = (h.timeFrom && h.timeUntil ? h.timeFrom : '00:00').split(':').map(Number)
  const hoy = formatInTimeZone(ahora, zona, 'yyyy-MM-dd')
  for (let dia = 0; dia <= 2; dia++) {
    const [y, m, d] = sumarDias(hoy, dia).split('-').map(Number)
    const pared = Date.UTC(y, m - 1, d, hh, mm)
    for (const o of desfases) candidatas.push(pared - o)
  }
  const enRango = candidatas.filter(c => c > desde && c <= limite).sort((a, b) => a - b)
  for (const c of enRango) if (vigenteEn(h, new Date(c), zona)) return new Date(c)
  return null
}
