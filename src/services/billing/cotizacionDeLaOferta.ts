/**
 * Planes editables (B2, Task 3): la cotización que el alta publica en `progress`, con un comprobante firmado por plan y
 * periodicidad. Sólo existe con una versión que publicó el editor (`versionQueCobra()`); sin ella devuelve `null` y la
 * respuesta de hoy no cambia.
 *
 * B2, Task 7: también la de «Tu plan» (`GET /plan` → `cotizacion`), firmada para el negocio (`venue:<id>`), con lo que Stripe dice
 * de una prueba SIN tarjeta (qué tarjeta cobraría y cuánto, §18), y la revisión del checkout que la cita.
 */
import type Stripe from 'stripe'
import type { PlanAcceptance, Prisma, PrismaClient } from '@prisma/client'
import { z } from 'zod'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { BadRequestError } from '../../errors/AppError'
import { stripe, type ResumenDeLaSuscripcionDelPlan } from '../stripe.service'
import type { PlanState } from '../dashboard/planState.service'
import { elegirFilaDelPlan } from '../access/filaDelPlan'
import { MARGEN_CHECKOUT_MS, MARGEN_OFERTA_MS, type FilaDePrueba } from './cobroDiferido'
import {
  cotizarOpcion,
  esPruebaRegaladaVigente,
  ofertaCambio,
  opcionDeTuPlan,
  opcionDelAlta,
  planFueraDeVenta,
  revisarComprobante,
  type OpcionCotizada,
  type OpcionDeCompra,
} from './opcionesDeCompra'
import { codigoDelPlan, numeroDeLaVigente, versionQueCobra, type OfertaVigente, type Periodicidad, type PlanPagado } from './planOffer'
import type { CotizacionFirmada } from './comprobanteDeCotizacion'
import { montoDelSiguienteCobro } from './siguienteCobro'
import { LECTURA_ACOTADA, type TarjetaVisible } from './tarjetaQueCobraria'

export interface PlanCotizado {
  displayName: string
  onSale: boolean
  requiresCard: boolean
  trialDays: number
  monthly: OpcionCotizada | null
  annual: OpcionCotizada | null
}

export interface OfertaDelAlta {
  versionNumber: number
  free: { displayName: string }
  planes: Record<PlanPagado, PlanCotizado>
}

const TIERS: PlanPagado[] = ['PRO', 'PREMIUM']
const PERIODOS: Periodicidad[] = ['monthly', 'annual']

/** Firma las ocho opciones de una versión ya leída (quien llama la lee una sola vez). */
export function cotizarOferta(vigente: OfertaVigente, organizationId: string, ahora: Date = new Date()): OfertaDelAlta {
  const alcance = `org:${organizationId}`
  const planes = {} as Record<PlanPagado, PlanCotizado>
  for (const tier of TIERS) {
    const plan = vigente.definition[tier]
    const cotizado: PlanCotizado = {
      displayName: plan.displayName,
      onSale: plan.onSale,
      requiresCard: plan.requiresCard,
      trialDays: plan.trialDays,
      monthly: null,
      annual: null,
    }
    for (const interval of PERIODOS) {
      const opcion = opcionDelAlta(vigente, tier, interval, ahora)
      if (opcion) cotizado[interval] = cotizarOpcion(opcion, { versionNumber: vigente.number, tier, interval, alcance }, ahora)
    }
    planes[tier] = cotizado
  }
  return { versionNumber: vigente.number, free: { displayName: vigente.definition.FREE.displayName }, planes }
}

export async function cotizacionDelAlta(organizationId: string, ahora: Date = new Date()): Promise<OfertaDelAlta | null> {
  const vigente = await versionQueCobra()
  return vigente ? cotizarOferta(vigente, organizationId, ahora) : null
}

// ---------------------------------------------------------------------------------------------------------------------
// «Tu plan» (B2, Task 7, §17, §18)
// ---------------------------------------------------------------------------------------------------------------------

type Db = Prisma.TransactionClient | PrismaClient

/**
 * La fila de plan que se administra (la regla de `elegirFilaDelPlan`): de ella sale la prueba REGALADA que difiere el primer cobro
 * (D3) o deja comprar un plan fuera de venta (§11 F). «Tu plan» y el checkout la leen igual; dentro del candado, con su `tx`.
 */
export async function leerFilaDelPlan(venueId: string, db: Db = prisma): Promise<FilaDePrueba | null> {
  const codigos = TIERS.map(codigoDelPlan)
  const filas = await db.venueFeature.findMany({
    where: { venueId, feature: { code: { in: codigos } } },
    select: {
      id: true,
      active: true,
      endDate: true,
      suspendedAt: true,
      gracePeriodEndsAt: true,
      stripeSubscriptionId: true,
      updatedAt: true,
      feature: { select: { code: true } },
    },
    take: codigos.length,
  })
  return elegirFilaDelPlan(filas)
}

export interface PlanDeTuPlan {
  displayName: string
  /** Hoy se puede comprar (al menos una periodicidad tiene opción): en venta, o con una prueba regalada vigente de ese plan. */
  vendible: boolean
  monthly: OpcionCotizada | null
  annual: OpcionCotizada | null
}

/**
 * La prueba SIN tarjeta del negocio según Stripe en ESTE momento (b2-r6 #4):
 * - `SIN_TARJETA`: sigue `trialing` y Stripe no tiene con qué cobrarla (la pantalla ofrece «Poner mi tarjeta» sólo con monto);
 * - `CON_TARJETA`: sigue `trialing` y Stripe ya tiene la tarjeta que cobrará (`tarjeta`);
 * - `TERMINADA`: Stripe la canceló (aunque la baja todavía no llegue a la fila): nunca «Listo».
 * `montoAlTerminarCents` es lo que Stripe cobrará (`amount_due` de su vista previa, con saldo y cupones); `null` = no se sabe.
 */
export interface EstadoDeLaPrueba {
  estado: 'SIN_TARJETA' | 'CON_TARJETA' | 'TERMINADA'
  tier: PlanPagado
  interval: Periodicidad
  trialEndsAt: string
  tarjeta: TarjetaVisible | null
  montoAlTerminarCents: number | null
}

/** La compra que el negocio aceptó al convertir su demo (Task 8) y todavía no usó (b2-r8 #7, b2-r9 #5). */
export interface AceptacionPendiente {
  acceptanceId: string
  tier: PlanPagado
  interval: Periodicidad
  expiresAt: string
}

export interface CotizacionDeTuPlan {
  versionNumber: number
  planes: Record<PlanPagado, PlanDeTuPlan>
  estadoDeLaPrueba?: EstadoDeLaPrueba
  aceptacionPendiente?: AceptacionPendiente
}

const periodicidadDe = (interval: 'month' | 'year' | null): Periodicidad | null =>
  interval === 'year' ? 'annual' : interval === 'month' ? 'monthly' : null

/**
 * El estado de la prueba sin tarjeta, de lo que `getPlanState` ya leyó de Stripe (`sub`, con la tarjeta, ruling P6). La única
 * llamada nueva es la vista previa, y sólo con la prueba `trialing` que seguirá cobrándose. `null`: no hay prueba sin tarjeta, ya
 * terminó y se cobró o falló el cobro (`active`, `past_due`, `unpaid`: «Tu plan» de hoy), tiene una cancelación programada
 * (`noHabraCobro`: la pantalla de hoy ya dice cuándo termina) o no se pudo leer su tarjeta.
 */
async function estadoDeLaPruebaSinTarjeta(
  planState: PlanState,
  sub: ResumenDeLaSuscripcionDelPlan | null,
): Promise<EstadoDeLaPrueba | null> {
  const origin = planState.origin
  if (origin?.kind !== 'CLASSIC' || !origin.tier || !sub?.sinTarjeta) return null
  const interval = periodicidadDe(sub.interval)
  if (!interval || !sub.trialEnd) return null
  const base = { tier: origin.tier, interval, trialEndsAt: sub.trialEnd.toISOString() }
  if (sub.status === 'canceled') return { estado: 'TERMINADA', ...base, tarjeta: null, montoAlTerminarCents: null }
  if (sub.status !== 'trialing' || sub.noHabraCobro) return null
  if (!sub.faltaTarjeta && !sub.tarjetaQueCobrara) return null
  const montoAlTerminarCents = planState.stripeSubscriptionId
    ? await montoDelSiguienteCobro(stripe, planState.stripeSubscriptionId, LECTURA_ACOTADA)
    : null
  return sub.faltaTarjeta
    ? { estado: 'SIN_TARJETA', ...base, tarjeta: null, montoAlTerminarCents }
    : { estado: 'CON_TARJETA', ...base, tarjeta: sub.tarjetaQueCobrara ?? null, montoAlTerminarCents }
}

/** La suscripción de Stripe de la fila de ESE plan, en prueba, activa o con el cobro pendiente: el negocio ya lo tiene. */
const SUSCRIPCION_DEL_PLAN_VIVO: ReadonlySet<string> = new Set(['trialing', 'active', 'past_due'])
/** Una suscripción en estos estados nunca se cobró: la aceptación que cita sigue sin usar. */
const SUSCRIPCION_SIN_USO: ReadonlySet<string> = new Set(['incomplete_expired', 'canceled'])

/**
 * La aceptación viva del negocio (`expiresAt > ahora`, la más reciente) sólo si todavía no se usó (b2-r9 #5): el negocio no tiene ya
 * ese plan vivo (la fila de `planState` es de ese plan y su suscripción de Stripe, `sub`, la que leyó `getPlanStateYSuscripcion`,
 * está `trialing`, `active` o `past_due`; fix round 1: el estado de Stripe, no el de la fila) y ninguna suscripción de su cliente de
 * Stripe cita su id (`metadata.planAcceptanceId`, que pone el checkout de la aceptación, Task 8), fuera de `incomplete_expired` y
 * `canceled`. La lista de suscripciones sólo se pide con una aceptación viva. Sin `sub` (sin suscripción o Stripe no contestó) decide
 * la lista.
 * 🔴 Si Stripe no deja verla, LANZA: «no pude ver» no es «sin usar». `GET /plan` entonces no ofrece la acción; el checkout de Task 8
 * la trata como sin usar (su 409) y, si ya se pagó, la regla común responde `PLAN_YA_CONTRATADO`.
 *
 * `opcionesDeStripe`: `LECTURA_ACOTADA` por default (sólo informa); la compra (Task 8) pasa `{}`.
 */
export async function aceptacionSinUsar(
  venueId: string,
  planState: PlanState,
  sub: Pick<ResumenDeLaSuscripcionDelPlan, 'status'> | null,
  customerId: string | null,
  ahora: Date = new Date(),
  opcionesDeStripe: Stripe.RequestOptions = LECTURA_ACOTADA,
): Promise<PlanAcceptance | null> {
  const aceptacion = await prisma.planAcceptance.findFirst({
    where: { venueId, expiresAt: { gt: ahora } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })
  if (!aceptacion) return null
  const yaTieneElPlan =
    planState.planTier === aceptacion.tier &&
    Boolean(planState.stripeSubscriptionId) &&
    sub !== null &&
    SUSCRIPCION_DEL_PLAN_VIVO.has(sub.status)
  if (yaTieneElPlan) return null
  if (!customerId) return aceptacion
  const suscripciones = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 }, opcionesDeStripe)
  const usada = suscripciones.data.some(s => s.metadata?.planAcceptanceId === aceptacion.id && !SUSCRIPCION_SIN_USO.has(s.status))
  if (usada) return null
  if (suscripciones.has_more) {
    throw new Error(`aceptacionSinUsar: el cliente tiene más de 100 suscripciones; no se pudo revisar la aceptación ${aceptacion.id}`)
  }
  return aceptacion
}

const esPlanPagado = (tier: string): tier is PlanPagado => tier === 'PRO' || tier === 'PREMIUM'
const esPeriodicidad = (interval: string): interval is Periodicidad => interval === 'monthly' || interval === 'annual'

/** `aceptacionPendiente` de «Tu plan»: nunca lanza (si no se puede saber si se usó, no se ofrece). */
async function aceptacionPendienteDe(
  venueId: string,
  planState: PlanState,
  sub: ResumenDeLaSuscripcionDelPlan | null,
  ahora: Date,
): Promise<AceptacionPendiente | null> {
  try {
    const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { stripeCustomerId: true } })
    const aceptacion = await aceptacionSinUsar(venueId, planState, sub, venue?.stripeCustomerId ?? null, ahora)
    if (!aceptacion) return null
    if (!esPlanPagado(aceptacion.tier) || !esPeriodicidad(aceptacion.interval)) {
      logger.warn('«Tu plan»: la aceptación guardada no es de un plan y periodicidad conocidos; no se ofrece', {
        venueId,
        acceptanceId: aceptacion.id,
      })
      return null
    }
    return {
      acceptanceId: aceptacion.id,
      tier: aceptacion.tier,
      interval: aceptacion.interval,
      expiresAt: aceptacion.expiresAt.toISOString(),
    }
  } catch (error) {
    logger.warn('«Tu plan»: no se pudo saber si la aceptación ya se usó; no se ofrece', {
      venueId,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * Lo que «Tu plan» cotiza con la versión del editor; `null` sin ella (y entonces `GET /plan` es el de hoy). `sub` es lo que
 * `getPlanState` ya leyó de la suscripción del plan.
 *
 * - Con una prueba sin tarjeta, `estadoDeLaPrueba`; en `SIN_TARJETA` ninguna opción de compra (comprar otro plan encima lo niega la
 *   regla común). En `TERMINADA`, las opciones de compra normales, como Gratis.
 * - Sin prueba sin tarjeta, las opciones de `opcionDeTuPlan` (con `MARGEN_OFERTA_MS`, para que el checkout, con 48 h, nunca reciba
 *   un «$0 hoy» que ya no daría), firmadas para `venue:<id>`, sin llamadas nuevas a Stripe.
 * - `aceptacionPendiente` aunque ningún plan esté en venta en la vigente: el checkout con su `acceptanceId` honra la versión aceptada.
 *
 * Lanza si leer la oferta falla (una versión rota, una ranura sin precio): quien responde `GET /plan` lee la versión UNA vez con
 * `versionDeTuPlanSinRomper` y cotiza con `cotizacionDeTuPlanSinRomper`.
 */
export async function cotizacionDeTuPlan(
  venueId: string,
  planState: PlanState,
  sub: ResumenDeLaSuscripcionDelPlan | null,
  ahora: Date = new Date(),
): Promise<CotizacionDeTuPlan | null> {
  const vigente = await versionQueCobra()
  return vigente ? cotizarTuPlan(vigente, venueId, planState, sub, ahora) : null
}

/** `cotizacionDeTuPlan` con la versión del editor ya leída (fix round 2: `GET /plan` la lee una sola vez). */
export async function cotizarTuPlan(
  vigente: OfertaVigente,
  venueId: string,
  planState: PlanState,
  sub: ResumenDeLaSuscripcionDelPlan | null,
  ahora: Date = new Date(),
): Promise<CotizacionDeTuPlan> {
  const estadoDeLaPrueba = await estadoDeLaPruebaSinTarjeta(planState, sub)
  const sinOpciones = estadoDeLaPrueba?.estado === 'SIN_TARJETA'
  const fila = sinOpciones ? null : await leerFilaDelPlan(venueId)
  const alcance = `venue:${venueId}`
  const planes = {} as Record<PlanPagado, PlanDeTuPlan>
  for (const tier of TIERS) {
    const plan: PlanDeTuPlan = { displayName: vigente.definition[tier].displayName, vendible: false, monthly: null, annual: null }
    if (!sinOpciones) {
      for (const interval of PERIODOS) {
        const opcion = opcionDeTuPlan({
          vigente,
          fila,
          enPruebaDeStripe: null,
          tier,
          interval,
          ahoraMs: ahora.getTime(),
          margenMs: MARGEN_OFERTA_MS,
        })
        if (opcion) plan[interval] = cotizarOpcion(opcion, { versionNumber: vigente.number, tier, interval, alcance }, ahora)
      }
    }
    plan.vendible = plan.monthly !== null || plan.annual !== null
    planes[tier] = plan
  }
  const aceptacionPendiente = await aceptacionPendienteDe(venueId, planState, sub, ahora)
  return {
    versionNumber: vigente.number,
    planes,
    ...(estadoDeLaPrueba ? { estadoDeLaPrueba } : {}),
    ...(aceptacionPendiente ? { aceptacionPendiente } : {}),
  }
}

/**
 * La versión del editor para `GET /plan`, leída UNA vez antes de todo (fix round 2): decide si «Tu plan» lee la tarjeta de la prueba
 * (`conTarjeta`), con qué versión cotiza y si la suscripción se lee con el tope corto (`delEditor`).
 * - `vigente`: la versión del editor, o `null` sin ella o si leerla falla (b2-r9 #8: leer la oferta nunca tumba «Tu plan»; aviso y
 *   la respuesta de hoy, sin cotización).
 * - `delEditor`: hay una versión del editor, aunque su definición no se pueda leer (Codex b2-code r2 #7): si la lectura lanza,
 *   decide el número del puntero (`numeroDeLaVigente`). Sólo con el puntero LEÍDO en una versión 2 o más, `true`: la lectura con
 *   tope, sin cotización. 🔴 r3 R3-2 (la regla única: una lectura hace lo de hoy): en la v1 (dañada), sin número válido o con el
 *   puntero ilegible, `false` y la llamada a Stripe de hoy.
 */
export async function versionDeTuPlanSinRomper(venueId: string): Promise<{ vigente: OfertaVigente | null; delEditor: boolean }> {
  try {
    const vigente = await versionQueCobra()
    return { vigente, delEditor: vigente !== null }
  } catch (error) {
    const numero = await numeroDeLaVigente().catch(() => null)
    logger.warn('«Tu plan»: no se pudo leer la oferta; se responde lo de hoy, sin cotización', {
      venueId,
      numero,
      error: error instanceof Error ? error.message : String(error),
    })
    return { vigente: null, delEditor: numero !== null && numero >= 2 }
  }
}

/**
 * `cotizarTuPlan` para `GET /plan`, con la versión que ya leyó `versionDeTuPlanSinRomper`: si la cotización lanza (una ranura sin
 * precio), `null` con un aviso y la respuesta es la de hoy (b2-r9 #8).
 */
export async function cotizacionDeTuPlanSinRomper(
  vigente: OfertaVigente,
  venueId: string,
  planState: PlanState,
  sub: ResumenDeLaSuscripcionDelPlan | null,
  ahora: Date = new Date(),
): Promise<CotizacionDeTuPlan | null> {
  try {
    return await cotizarTuPlan(vigente, venueId, planState, sub, ahora)
  } catch (error) {
    logger.warn('«Tu plan»: no se pudo leer la oferta; se responde lo de hoy, sin cotización', {
      venueId,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// El checkout de «Tu plan» con una versión del editor (B2, Task 7)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Pasos 1-3 de la compra de «Tu plan»: el comprobante (`venue:<id>`, la vigente; su rechazo se lanza) y `revisarLaOpcion`. Nunca
 * toca Stripe. `trialEnd` es el fin con el que se abre la sesión (`undefined` = se cobra hoy).
 */
export function revisarCompraDeTuPlan(args: {
  vigente: OfertaVigente
  venueId: string
  tier: PlanPagado
  interval: Periodicidad
  quoteToken: unknown
  fila: FilaDePrueba | null
  ahora: Date
}): { opcion: OpcionDeCompra; trialEnd: Date | undefined } {
  const { vigente, venueId, tier, interval, quoteToken, fila, ahora } = args
  const n = vigente.number
  const revisado = revisarComprobante({ token: quoteToken, alcance: `venue:${venueId}`, tier, interval, versionNumber: n, ahora })
  if (revisado.comprobante === null) throw revisado.rechazo
  return revisarLaOpcion({ version: vigente, comprobante: revisado.comprobante, fila, tier, interval, ahora })
}

/**
 * Pasos 2-3: la opción de `version` con el margen del checkout (sin ella, `PLAN_NOT_ON_SALE`) y que el comprobante ya verificado
 * diga lo mismo que la opción: el precio, y el fin de la prueba regalada si la difiere (`PRUEBA_CERCA` si ya no se puede,
 * `QUOTE_MISMATCH` si cambió); sin fin de prueba, se paga hoy el precio. `version` es la vigente («Tu plan») o la que se aceptó al
 * convertir la demo (Task 8: aunque ya no sea la vigente, §11 N2); los rechazos citan SU número (ruling P3). Nunca toca Stripe.
 */
export function revisarLaOpcion(args: {
  version: OfertaVigente
  comprobante: Pick<CotizacionFirmada, 'precioCents' | 'firstChargeCents' | 'trialEndsAt'>
  fila: FilaDePrueba | null
  tier: PlanPagado
  interval: Periodicidad
  ahora: Date
}): { opcion: OpcionDeCompra; trialEnd: Date | undefined } {
  const { version, comprobante, fila, tier, interval, ahora } = args
  const n = version.number
  const opcion = opcionDeTuPlan({
    vigente: version,
    fila,
    enPruebaDeStripe: null,
    tier,
    interval,
    ahoraMs: ahora.getTime(),
    margenMs: MARGEN_CHECKOUT_MS,
  })
  if (!opcion) throw planFueraDeVenta(tier, version.definition[tier].displayName)
  if (comprobante.precioCents !== opcion.precioCents) throw ofertaCambio('QUOTE_MISMATCH', n)
  if (comprobante.trialEndsAt) {
    if (comprobante.firstChargeCents !== 0) throw ofertaCambio('QUOTE_MISMATCH', n)
    if (!opcion.trialEndsAt) throw ofertaCambio('PRUEBA_CERCA', n)
    if (opcion.trialEndsAt.getTime() !== comprobante.trialEndsAt.getTime()) throw ofertaCambio('QUOTE_MISMATCH', n)
    return { opcion, trialEnd: opcion.trialEndsAt }
  }
  if (comprobante.firstChargeCents !== comprobante.precioCents) throw ofertaCambio('QUOTE_MISMATCH', n)
  return { opcion, trialEnd: undefined }
}

/**
 * Paso 5, dentro de la regla común (con su `tx`, sólo la base): la vigente sigue siendo la del comprobante y la prueba regalada da
 * la misma compra. Si no, `ofertaCambio` (o `PLAN_NOT_ON_SALE` si ya no hay opción) y no se abre nada. Lo que se publique DESPUÉS de
 * esta relectura es residuo aceptado: sale con la versión que la persona vio.
 */
export async function exigirLaMismaCompra(
  tx: Prisma.TransactionClient,
  args: { venueId: string; tier: PlanPagado; interval: Periodicidad; versionNumber: number; trialEnd: Date | undefined },
): Promise<void> {
  const { venueId, tier, interval, versionNumber, trialEnd } = args
  const releida = await versionQueCobra(tx)
  if (!releida || releida.number !== versionNumber) throw ofertaCambio('VERSION', releida?.number ?? 1)
  await exigirLaMismaOpcion(tx, { version: releida, venueId, tier, interval, trialEnd })
}

/**
 * La parte de `exigirLaMismaCompra` que no relee la vigente: la fila con su `tx` da la misma opción de `version` (y el mismo fin de
 * la prueba regalada). La compra de una aceptación (Task 8) la usa con la versión ACEPTADA, sin la relectura del número vigente
 * (§11 N2: lo aceptado cierra aunque se publique otra versión).
 */
export async function exigirLaMismaOpcion(
  tx: Prisma.TransactionClient,
  args: { version: OfertaVigente; venueId: string; tier: PlanPagado; interval: Periodicidad; trialEnd: Date | undefined },
): Promise<void> {
  const { version, venueId, tier, interval, trialEnd } = args
  const fila = await leerFilaDelPlan(venueId, tx)
  const opcion = opcionDeTuPlan({
    vigente: version,
    fila,
    enPruebaDeStripe: null,
    tier,
    interval,
    ahoraMs: Date.now(),
    margenMs: MARGEN_CHECKOUT_MS,
  })
  if (!opcion) throw planFueraDeVenta(tier, version.definition[tier].displayName)
  if (trialEnd && opcion.trialEndsAt?.getTime() !== trialEnd.getTime()) {
    throw ofertaCambio(opcion.trialEndsAt ? 'QUOTE_MISMATCH' : 'PRUEBA_CERCA', version.number)
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// La conversión de demo y su aceptación (B2, Task 8, §11 N2)
// ---------------------------------------------------------------------------------------------------------------------

/** Cuánto vive la aceptación de la conversión de demo: lo que dura una sesión de checkout de Stripe (30 min). */
export const PLAN_ACCEPTANCE_TTL_MS = 30 * 60_000

/** El plan que la persona eligió al convertir su demo. Gratis también se dice: una demo nunca pasa a Gratis en silencio (b2-r1 #9). */
export type PlanDeLaConversion = { tier: 'FREE' } | { tier: PlanPagado; interval: Periodicidad; quoteToken: unknown }

const planDeLaConversion = z.union([
  z.object({ tier: z.literal('FREE') }).strict(),
  z
    .object({
      tier: z.enum(['PRO', 'PREMIUM']),
      interval: z.enum(['monthly', 'annual']),
      // Su forma la revisa `revisarComprobante` (sin él, QUOTE_REQUIRED; un valor que no es texto, QUOTE_INVALID).
      quoteToken: z.unknown(),
    })
    .strict(),
])

/**
 * Lee el `plan` del cuerpo de la conversión. Sólo se llama con una versión del editor (sin ella, `plan` no se lee: b2-r3 #8).
 * `null`: no vino (o vino `null`); quien llama responde QUOTE_REQUIRED. Una forma que no es ninguna de las dos → 400 `PLAN_INVALID`.
 */
export function leerPlanDeLaConversion(raw: unknown): PlanDeLaConversion | null {
  if (raw === undefined || raw === null) return null
  const leido = planDeLaConversion.safeParse(raw)
  if (!leido.success) throw new BadRequestError('El plan elegido no es válido. Recarga la página.', 'PLAN_INVALID')
  return leido.data.tier === 'FREE'
    ? { tier: 'FREE' }
    : { tier: leido.data.tier, interval: leido.data.interval, quoteToken: leido.data.quoteToken }
}

// ---------------------------------------------------------------------------------------------------------------------
// Los otros caminos de compra: funciones sueltas a Pro, el Básico (B2, Task 10, §11 F, §11.2)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Una prueba de Stripe vigente de ese plan: la fila del plan ligada a su suscripción, activa, sin suspender y con el fin de la prueba
 * por venir. El aviso de Stripe sólo pone `endDate` mientras la suscripción está `trialing` (pagada, `null`).
 */
function esPruebaDeStripeVigente(fila: FilaDePrueba | null, tier: PlanPagado, ahoraMs: number): boolean {
  return Boolean(
    fila &&
      fila.active &&
      !fila.suspendedAt &&
      fila.stripeSubscriptionId &&
      fila.endDate &&
      fila.endDate.getTime() >= ahoraMs &&
      fila.feature.code === codigoDelPlan(tier),
  )
}

/**
 * La versión del editor que decide una compra nueva, leída sólo de la base (con `db`). Si no se puede leer, decide el número del
 * puntero, como la conversión de demo (Task 8): en la v1 (o sin versiones), `null` con un aviso, el camino de hoy que nunca leyó la
 * oferta; en una versión del editor, sin número válido o si ni el puntero se puede leer, el error (falla cerrado, sin cobrar).
 */
async function versionDelEditorParaComprar(db: Db, venueId: string): Promise<OfertaVigente | null> {
  try {
    return await versionQueCobra(db)
  } catch (error) {
    const numero = await numeroDeLaVigente(db).catch(() => null)
    if (numero !== 1) throw error
    logger.warn('Compra nueva: no se pudo leer la v1 de la oferta; sigue como hoy, sin versión del editor', {
      venueId,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * Lo que una compra NUEVA del Básico o de un plan necesita de la versión del editor (§11 F, §11.2), para los caminos que no cotizan
 * con comprobante (las funciones sueltas a Pro por la compra híbrida, «Terminar mi Pro» del Básico):
 * - sin versión del editor no hace nada (ni lee más que el puntero; sin `tier` ni `basico`, ni eso);
 * - con ella, el Básico → 409 `PLAN_NOT_ON_SALE` (tier `BASICO`): se cierra en el código, no pausando su lista (`codex-r5.md` #10);
 * - un `tier` fuera de venta → 409 `PLAN_NOT_ON_SALE`, salvo con una prueba vigente de ese plan (regalada o en Stripe).
 *
 * Con `db` = la `tx` del candado, todo se lee ahí. Lo ya aceptado, reservado o cobrado no pasa por aquí.
 */
export async function exigirCompraNuevaPermitida(
  db: Prisma.TransactionClient | PrismaClient,
  args: { venueId: string; tier: PlanPagado | null; basico: boolean },
): Promise<void> {
  const { venueId, tier, basico } = args
  if (!tier && !basico) return
  const vigente = await versionDelEditorParaComprar(db, venueId)
  if (!vigente) return
  if (basico) throw planFueraDeVenta('BASICO', 'Básico')
  if (!tier) return
  const plan = vigente.definition[tier]
  if (plan.onSale) return
  const fila = await leerFilaDelPlan(venueId, db)
  const ahoraMs = Date.now()
  if (esPruebaRegaladaVigente(fila, tier, ahoraMs) || esPruebaDeStripeVigente(fila, tier, ahoraMs)) return
  throw planFueraDeVenta(tier, plan.displayName)
}
