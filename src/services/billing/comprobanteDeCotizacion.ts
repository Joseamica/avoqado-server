import crypto from 'crypto'
import { ACCESS_TOKEN_SECRET } from '../../config/env'
import { BadRequestError, ConflictError } from '../../errors/AppError'
import type { Periodicidad, PlanPagado } from './planOffer'

/**
 * Planes editables (B1): el comprobante firmado de una cotización (lo usa B2).
 *
 * Una firma SIN estado (patrón de `platformUnsubscribeToken.ts`): la llave se DERIVA de `ACCESS_TOKEN_SECRET` con la etiqueta
 * `avoqado-plan-quote-v1`, así que ningún otro token vale aquí ni al revés y no hace falta otra variable de entorno.
 * Atado al alcance (`org:<id>` o `venue:<id>`); vale 24 h desde su emisión.
 */
export interface CotizacionFirmable {
  versionNumber: number
  tier: PlanPagado
  interval: Periodicidad
  firstChargeCents: number
  trialEndsAt: Date | null
  alcance: string
}

export interface CotizacionFirmada extends CotizacionFirmable {
  issuedAt: Date
}

export const VIGENCIA_DE_LA_COTIZACION_MS = 86_400_000
/** Cuánto en el futuro puede venir la emisión (desfase de relojes entre procesos). */
const TOLERANCIA_DE_RELOJ_MS = 5 * 60_000
const MAX_LARGO = 2048
const KEY_LABEL = 'avoqado-plan-quote-v1'

interface Cuerpo {
  f: 1
  p: 'plan-quote'
  n: number
  t: PlanPagado
  i: Periodicidad
  c: number
  e: number | null
  s: number
  a: string
}

const sign = (b64Body: string): string => {
  const key = crypto.createHmac('sha256', ACCESS_TOKEN_SECRET).update(KEY_LABEL).digest()
  return crypto.createHmac('sha256', key).update(b64Body).digest('base64url')
}

const invalido = () => new BadRequestError('El comprobante de la cotización no es válido. Vuelve a cotizar.', 'QUOTE_INVALID')

export function firmarCotizacion(c: CotizacionFirmable, now: Date = new Date()): string {
  const cuerpo: Cuerpo = {
    f: 1,
    p: 'plan-quote',
    n: c.versionNumber,
    t: c.tier,
    i: c.interval,
    c: c.firstChargeCents,
    e: c.trialEndsAt ? c.trialEndsAt.getTime() : null,
    s: now.getTime(),
    a: c.alcance,
  }
  // Errores de programación (no del usuario): nunca se firma algo que `verificarCotizacion` no podría leer.
  const dinero = (v: number, min: number) => Number.isSafeInteger(v) && v >= min
  if (Number.isNaN(now.getTime())) throw new Error('firmarCotizacion: la hora de emisión no es válida')
  if (c.trialEndsAt && Number.isNaN(c.trialEndsAt.getTime())) throw new Error('firmarCotizacion: el fin de la prueba no es una fecha válida')
  if (!dinero(c.versionNumber, 1) || !dinero(c.firstChargeCents, 0)) {
    throw new Error('firmarCotizacion: la versión y el primer cobro deben ser enteros válidos')
  }
  if (!c.alcance) throw new Error('firmarCotizacion: falta el alcance')
  const b64 = Buffer.from(JSON.stringify(cuerpo)).toString('base64url')
  const token = `${b64}.${sign(b64)}`
  if (token.length > MAX_LARGO) throw new Error('firmarCotizacion: el comprobante excede el largo permitido')
  return token
}

export function verificarCotizacion(token: unknown, alcance: string, now: Date = new Date()): CotizacionFirmada {
  if (typeof token !== 'string' || token.length > MAX_LARGO) throw invalido()
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) throw invalido()
  const b64 = token.slice(0, dot)
  const dada = Buffer.from(token.slice(dot + 1))
  const esperada = Buffer.from(sign(b64))
  if (dada.length !== esperada.length || !crypto.timingSafeEqual(dada, esperada)) throw invalido()

  let p: Partial<Cuerpo> | null
  try {
    p = JSON.parse(Buffer.from(b64, 'base64url').toString('utf-8'))
  } catch {
    throw invalido()
  }
  const entero = (v: unknown, min: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min
  if (
    !p ||
    typeof p !== 'object' ||
    p.f !== 1 ||
    p.p !== 'plan-quote' ||
    !entero(p.n, 1) ||
    (p.t !== 'PRO' && p.t !== 'PREMIUM') ||
    (p.i !== 'monthly' && p.i !== 'annual') ||
    !entero(p.c, 0) ||
    !(p.e === null || entero(p.e, 0)) ||
    !entero(p.s, 0) ||
    typeof p.a !== 'string' ||
    !p.a
  ) {
    throw invalido()
  }
  if (p.a !== alcance) throw invalido()
  const edad = now.getTime() - p.s
  if (edad < -TOLERANCIA_DE_RELOJ_MS) throw invalido()
  if (edad >= VIGENCIA_DE_LA_COTIZACION_MS) {
    throw new ConflictError('La cotización ya venció. Vuelve a cotizar.', 'QUOTE_EXPIRED')
  }
  return {
    versionNumber: p.n,
    tier: p.t,
    interval: p.i,
    firstChargeCents: p.c,
    trialEndsAt: p.e === null ? null : new Date(p.e),
    alcance: p.a,
    issuedAt: new Date(p.s),
  }
}
