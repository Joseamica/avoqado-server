/**
 * Planes editables (B2, Task 2): las opciones de compra (alta y «Tu plan») calculadas de una versión de la oferta.
 *
 * Todo puro: sin base ni Stripe. Quien llama pasa la versión ya leída y la hora. El precio de cada opción es el de la versión
 * que se nombra (`precioDe`), y el comprobante lo firma junto con el primer cobro y el fin de la prueba.
 */
import AppError, { ConflictError } from '../../errors/AppError'
import logger from '../../config/logger'
import { finDePruebaDiferible, type FilaDePrueba } from './cobroDiferido'
import { firmarCotizacion, verificarCotizacion, type CotizacionFirmada } from './comprobanteDeCotizacion'
import {
  MENSAJE_PLAN_NO_CONFIGURADO,
  codigoDelPlan,
  precioDeLaOferta,
  type OfertaVigente,
  type Periodicidad,
  type PlanPagado,
} from './planOffer'

export const DIA_MS = 86_400_000

export type MotivoDelCambio = 'VERSION' | 'QUOTE_REQUIRED' | 'QUOTE_MISMATCH' | 'PAGO_HOY' | 'SIN_TARJETA' | 'CON_TARJETA' | 'PRUEBA_CERCA'

/**
 * 409 `OFFER_CHANGED`: la oferta cambió y no se cobró nada. `offerVersion` es el número de la versión vigente: quien llama
 * pasa `vigente.number` (1 para el respaldo).
 */
export function ofertaCambio(reason: MotivoDelCambio, offerVersion: number): ConflictError {
  return new ConflictError('La oferta cambió. Revisa el precio antes de pagar. No se te cobró nada.', 'OFFER_CHANGED', {
    reason,
    offerVersion,
  })
}

export function planFueraDeVenta(tier: PlanPagado | 'BASICO', displayName: string): ConflictError {
  return new ConflictError(`El plan ${displayName} ya no está a la venta. Elige otro plan. No se te cobró nada.`, 'PLAN_NOT_ON_SALE', {
    tier,
  })
}

export interface OpcionDeCompra {
  priceId: string
  /** El bruto (con IVA) del precio que se cobrará. */
  precioCents: number
  netCents: number
  firstChargeCents: number
  trialEndsAt: Date | null
  /** El número de la versión cuyo precio se cobra. */
  precioDe: number
}

function sinPrecio(vigente: OfertaVigente, tier: PlanPagado, interval: Periodicidad): AppError {
  // 🚨 a propósito, igual que `resolverPrecioDelPlan`: la versión vigente no trae el precio de Stripe de esta ranura.
  logger.error('🚨 opcionesDeCompra: la versión vigente no trae el precio de Stripe de esta ranura — NO se vende', {
    tierCode: codigoDelPlan(tier),
    interval,
    versionId: vigente.versionId,
    number: vigente.number,
    motivo: 'SIN_PRECIO',
  })
  return new AppError(MENSAJE_PLAN_NO_CONFIGURADO, 503, true, 'PLAN_NOT_CONFIGURED', { tierCode: codigoDelPlan(tier) })
}

/** La compra del alta: `null` si el plan no está en venta; con `trialDays > 0` el primer cobro es $0 y la prueba termina al cumplirse. */
export function opcionDelAlta(vigente: OfertaVigente, tier: PlanPagado, interval: Periodicidad, ahora: Date): OpcionDeCompra | null {
  const plan = vigente.definition[tier]
  if (!plan.onSale) return null
  const precio = precioDeLaOferta(vigente.definition, tier, interval)
  if (!precio.stripePriceId) throw sinPrecio(vigente, tier, interval)
  const conPrueba = plan.trialDays > 0
  return {
    priceId: precio.stripePriceId,
    precioCents: precio.grossCents,
    netCents: precio.netCents,
    firstChargeCents: conPrueba ? 0 : precio.grossCents,
    trialEndsAt: conPrueba ? new Date(ahora.getTime() + plan.trialDays * DIA_MS) : null,
    precioDe: vigente.number,
  }
}

/** Una prueba regalada (sin Stripe) vigente de ese plan. */
export function esPruebaRegaladaVigente(fila: FilaDePrueba | null, tier: PlanPagado, ahoraMs: number): boolean {
  return Boolean(
    fila &&
      fila.active &&
      !fila.suspendedAt &&
      !fila.stripeSubscriptionId &&
      fila.endDate &&
      fila.endDate.getTime() >= ahoraMs &&
      fila.feature.code === codigoDelPlan(tier),
  )
}

/**
 * La compra clásica de «Tu plan» (Gratis → plan, o quedarse con el plan de una prueba regalada). Un plan fuera de venta sólo se
 * puede comprar con una prueba vigente de ese mismo plan (regalada o en Stripe). El precio es el de la vigente; con una prueba
 * regalada a `margenMs` o más de su fin, la prueba sigue hasta su fin y hoy se paga $0 (D3).
 */
export function opcionDeTuPlan(args: {
  vigente: OfertaVigente
  fila: FilaDePrueba | null
  enPruebaDeStripe: PlanPagado | null
  tier: PlanPagado
  interval: Periodicidad
  ahoraMs: number
  margenMs: number
}): OpcionDeCompra | null {
  const { vigente, fila, enPruebaDeStripe, tier, interval, ahoraMs, margenMs } = args
  const regalada = esPruebaRegaladaVigente(fila, tier, ahoraMs)
  if (!vigente.definition[tier].onSale && !regalada && enPruebaDeStripe !== tier) return null
  const precio = precioDeLaOferta(vigente.definition, tier, interval)
  if (!precio.stripePriceId) throw sinPrecio(vigente, tier, interval)
  const fin = finDePruebaDiferible(fila, codigoDelPlan(tier), ahoraMs, margenMs)
  return {
    priceId: precio.stripePriceId,
    precioCents: precio.grossCents,
    netCents: precio.netCents,
    firstChargeCents: fin ? 0 : precio.grossCents,
    trialEndsAt: fin,
    precioDe: vigente.number,
  }
}

export interface OpcionCotizada {
  quoteToken: string
  precioCents: number
  netCents: number
  firstChargeCents: number
  trialEndsAt: string | null
}

/** Firma la opción (con `issuedAt = ahora`) y la devuelve como la ve el cliente. */
export function cotizarOpcion(
  opcion: { precioCents: number; netCents: number; firstChargeCents: number; trialEndsAt: Date | null },
  firma: { versionNumber: number; tier: PlanPagado; interval: Periodicidad; alcance: string },
  ahora: Date,
): OpcionCotizada {
  const quoteToken = firmarCotizacion(
    { ...firma, firstChargeCents: opcion.firstChargeCents, precioCents: opcion.precioCents, trialEndsAt: opcion.trialEndsAt },
    ahora,
  )
  return {
    quoteToken,
    precioCents: opcion.precioCents,
    netCents: opcion.netCents,
    firstChargeCents: opcion.firstChargeCents,
    trialEndsAt: opcion.trialEndsAt ? opcion.trialEndsAt.toISOString() : null,
  }
}

/** Lo mínimo que debe faltar para el fin de prueba firmado al momento de comprar (Codex b2-mac r3 #2). */
const MARGEN_DEL_FIN_DE_PRUEBA_MS = 10 * 60_000

/**
 * Revisa el comprobante de una petición. 🔴 Nunca lanza: devuelve el rechazo para que quien llama lo lance donde le toque.
 * Sin token → `QUOTE_REQUIRED`; un valor que no es texto → `QUOTE_INVALID`; firma, forma, alcance o vencimiento → el error de
 * B1; otro número de versión → `VERSION`; otro plan o periodicidad → `QUOTE_MISMATCH`.
 */
export function revisarComprobante(args: {
  token: unknown
  alcance: string
  tier: PlanPagado
  interval: Periodicidad
  versionNumber: number
  ahora: Date
}): { comprobante: CotizacionFirmada; rechazo: null } | { comprobante: null; rechazo: AppError } {
  const { token, alcance, tier, interval, versionNumber, ahora } = args
  if (token === undefined || token === null) return { comprobante: null, rechazo: ofertaCambio('QUOTE_REQUIRED', versionNumber) }
  let comprobante: CotizacionFirmada
  try {
    comprobante = verificarCotizacion(token, alcance, ahora)
  } catch (error) {
    if (error instanceof AppError) return { comprobante: null, rechazo: error }
    throw error
  }
  if (comprobante.versionNumber !== versionNumber) return { comprobante: null, rechazo: ofertaCambio('VERSION', versionNumber) }
  if (comprobante.tier !== tier || comprobante.interval !== interval) {
    return { comprobante: null, rechazo: ofertaCambio('QUOTE_MISMATCH', versionNumber) }
  }
  // 🔴 Codex b2-mac r3 #2: el fin de prueba firmado de una prueba corta cotizada hace casi 24 h puede estar a segundos; Stripe rechazaría
  // un `trial_end` ya pasado y el alta quedaría «confirmando con el banco». Con menos de 10 min por delante se vuelve a cotizar.
  if (comprobante.trialEndsAt && comprobante.trialEndsAt.getTime() - ahora.getTime() < MARGEN_DEL_FIN_DE_PRUEBA_MS) {
    return { comprobante: null, rechazo: new ConflictError('La cotización ya venció. Vuelve a cotizar.', 'QUOTE_EXPIRED') }
  }
  return { comprobante, rechazo: null }
}
