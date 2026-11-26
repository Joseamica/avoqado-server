/**
 * S8 — cobrar el plan ANTES de terminar el alta (spec 2026-09-17 § 3.6).
 *
 * 🔴 EL ARCHIVO MÁS CARO DE ESTA FEATURE. El orden de los pasos es parte del contrato, no una
 * preferencia: lecturas baratas → cotización del SERVIDOR → verificación contra Stripe → lease
 * → lugar del cupo → Stripe → cierre. Cambiarlo de orden produce dinero mal cobrado.
 *
 * Las seis reglas que sostienen esto, cada una con su prueba y su sabotaje:
 *
 *  1. **El precio lo pone el servidor.** `expectedFirstChargeCents` es EVIDENCIA de lo que la
 *     persona vio; si no coincide con lo que el servidor calcula, se responde 409 y NO se cobra.
 *  2. **El lugar del cupo se aparta con un `UPDATE … WHERE redemptionCount < redemptionCap`.**
 *     Nunca se lee el conteo antes de escribirlo.
 *  3. **Un rechazo del banco LIBERA el lugar** (CAS sobre `status='RESERVED'` con el decremento
 *     del contador en la MISMA transacción). Un resultado DESCONOCIDO lo conserva.
 *  4. **«No pude ver» nunca se lee como «no existe».** Si la búsqueda de un intento anterior en
 *     Stripe falla, se responde 503 y se deja el lease vivo. Concluir «no se creó» estrenaría
 *     llave de idempotencia y crearía un SEGUNDO cobro.
 *  5. **Ya activo con el mismo plan pero SIN redención ⇒ 409, nunca 200.** Responder éxito le
 *     regalaría la oferta a quien tomó la prueba de 30 días, y a los 30 días le cobraría el
 *     precio de lista completo.
 *  6. **Una suscripción REUSADA sin el cupón esperado ⇒ 409, y se libera el lugar.** No hubo
 *     cobro nuevo: marcar APPLIED ahí mandaría «recibimos tu pago de $22» con cero pesos.
 */
import Stripe from 'stripe'
import type { Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { subscriptionPeriod } from '../../utils/stripeSubscriptionPeriod'
import logger from '../../config/logger'
import AppError, { BadRequestError, ConflictError, NotFoundError } from '../../errors/AppError'
import { logAction } from '../dashboard/activity-log.service'
import emailService from '../email.service'
import * as resendService from '../resend.service'
import { resolvePlanNotificationTarget } from '../access/planNotification.service'
import {
  assertPaymentMethodBelongsToCustomer,
  createPlanSubscription,
  entregarSuscripcionDePlan,
  tierQueVendeLaSuscripcion,
  getOrCreateStripeCustomer,
  planLookupKey,
  stripeAfirmaQueNoExiste,
} from '../stripe.service'
import { autorizarObligacionNueva, TIMEOUT_DE_LA_TRANSACCION_MS } from '../access/autorizarObligacionNueva'
import { inventarioDeObligaciones } from '../access/inventarioDeObligaciones'
import { ensureVenueForOnboarding } from './ensureVenue.service'
import { primerCobroCubierto } from './primerCobroPagado'
import { basicPlanValido, fusionarV2SetupData, MENSAJE_BASIC_PLAN_INVALIDO, parseV2Plan } from './onboardingProgress.service'
import { modalidadDePrueba, type TrialModality } from '../billing/modalidadDePrueba'
import { resolverPrecioPorLlave } from '../billing/precioDelPlan'
import {
  codigoDelPlan,
  precioDeLaOferta,
  priceIdVigente,
  versionQueCobra,
  type OfertaVigente,
  type Periodicidad,
  type PlanPagado,
} from '../billing/planOffer'
import { basicoDeLaBienvenida } from '../billing/avisosDelBasico'
import { DIA_MS, ofertaCambio, planFueraDeVenta, revisarComprobante } from '../billing/opcionesDeCompra'
import { verificarCotizacion, type CotizacionFirmada } from '../billing/comprobanteDeCotizacion'
import {
  isLegacyIntroEligible,
  LEGACY_INTRO_OFFER,
  standardPlanQuote,
  STANDARD_PLAN_GROSS_CENTS,
  TRIAL_DAYS,
  type PaidPlanTier,
  type PlanBillingInterval,
} from '../access/planPricing.constants'
import { buildLaunchOfferView, launchOfferAvailability, standardFirstChargeCents } from '../launchCampaigns/launchOfferMath'
import { LAUNCH_CAMPAIGN_SELECT, toOfferRow, type LaunchCampaignRow } from '../launchCampaigns/launchCampaign.service'
import { PLAN_ACTIVATION_STATUS, REDEMPTION_STATUS } from '../launchCampaigns/launchCampaignEnums'
import { idDelCuponDelDescuento } from './cuponDelDescuento'
import { terminarAltaCobradaSinRomper, type ViaDelCierre } from './terminarAltaCobrada'
import { registrarSuscripcionDelIntento } from './registrarSuscripcionDelIntento'
import { cerrarAltaEnGratis, pruebaSinTarjetaTerminada, pruebaTerminadaSinTarjeta } from './cerrarAltaEnGratis'
import { avisoDeLaPruebaSinTarjeta, clienteDeStripeVivo, type TarjetaVisible } from '../billing/tarjetaQueCobraria'
import { billingPageUrl } from '@/utils/dashboardLinks'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '')

/** Cuánto vale un lease antes de que otro intento pueda recuperarlo. */
export const LEASE_MS = 5 * 60_000

/**
 * Tope de suscripciones que se recorren de UN cliente al buscar el intento anterior.
 *
 * 🔴 La búsqueda ya no lleva ventana de fechas (Codex, 21-sep, P1 reproducido): cualquier cota
 * deja fuera un intento más viejo, y la regla que la protegía comparaba la fecha del LEASE, que se
 * renueva en cada reintento — al SEGUNDO reintento una búsqueda vacía pasaba por «no existe» y se
 * cobraba otra vez. Recorriendo TODAS las suscripciones del cliente, «no la encontré» sí prueba
 * ausencia. Un cliente real tiene un puñado; si se llega al tope, NO se pudo cubrir y no se cobra.
 */
const TOPE_SUSCRIPCIONES_POR_CLIENTE = 1_000

/** Estados de Stripe en los que una suscripción recuperada acredita que el cobro quedó hecho. */
const SUSCRIPCION_COBRADA = ['active', 'trialing', 'past_due', 'unpaid'] as const

export type ActivatePlanOffer =
  | { kind: 'LAUNCH'; code: string; offerVersion: number; expectedFirstChargeCents: number }
  | { kind: 'STANDARD'; expectedFirstChargeCents: number }
  /**
   * Planes editables (B2, Task 6, §16, §18): la prueba SIN tarjeta. Sólo llega con una versión del editor (la validación de la
   * ruta no la reconoce sin ella); sin método de pago y sin pagar hoy. Lo guardado conserva el `kind` de hoy (`STANDARD`).
   */
  | { kind: 'STANDARD_SIN_TARJETA'; expectedFirstChargeCents: 0 }

export interface ActivatePlanInput {
  organizationId: string
  staffId: string
  tier: PaidPlanTier
  interval: PlanBillingInterval
  payNow: boolean
  /** La tarjeta del cobro. Falta sólo con `STANDARD_SIN_TARJETA` (B2 Task 6); en los demás tipos, la validación la exige. */
  paymentMethodId?: string
  offer: ActivatePlanOffer
  language?: 'es' | 'en'
  /** Plan Básico: la prueba de Pro que termina sola sin cobrar. Sólo con PRO mensual y `payNow: false`. */
  basicPlan?: boolean
  /**
   * Planes editables (B2): el comprobante firmado de la cotización del alta. 🔴 Viaja APARTE de `offer` (el controlador lo
   * separa) para que ningún camino lo guarde ni lo devuelva. Sólo lo lee el camino con una versión del editor; sin ella, ni su
   * forma se revisa.
   */
  quoteToken?: unknown
}

export interface ActivatePlanResult {
  status: 'ACTIVE'
  alreadyActive: boolean
  tier: PaidPlanTier
  interval: PlanBillingInterval
  firstChargeCents: number
  nextChargeAt: string
  launchOffer?: { code: string; offerVersion: number; months: number; renewalMonthlyCents: number }
  /** Plan Básico: cómo termina la prueba, leído de la suscripción REAL (nunca de lo pedido). Sin prueba, no viaja. */
  trialModality?: TrialModality
  trialEndsAt?: string
  /**
   * Planes editables (B2, Task 6, §18): una prueba SIN tarjeta (la metadata de su suscripción). Con ella viajan, leídos de Stripe
   * en ese momento, la tarjeta que cobraría al terminar (`null` = ninguna; si no se pudo leer, no viaja) y si NO habrá cobro
   * (cancelación programada o cobranza en pausa). Sin prueba sin tarjeta, ninguno viaja.
   */
  sinTarjeta?: true
  tarjetaQueCobrara?: TarjetaVisible | null
  noHabraCobro?: boolean
}

/** El 503 del resultado desconocido. NO es un fallo: es «no sé», y el cliente reintenta igual. */
function pendiente(motivo: string): AppError {
  return new AppError(
    // Stripe recomienda prometer el aviso, no mandar al cliente a volver: «Payment processing.
    // We'll update you when payment is received». Reintentar es SEGURO (la llave de idempotencia
    // lo cubre), pero pedírselo a quien acaba de intentar pagarnos es pasarle a él nuestro trabajo.
    'Estamos confirmando tu pago con el banco. Te avisamos por correo en cuanto quede; no se te cobrará dos veces.',
    503,
    true,
    'PLAN_ACTIVATION_PENDING',
    { motivo },
  )
}

/** El 402 del banco. Lleva el mensaje de Stripe, que es el único que le sirve al cliente. */
function rechazado(message: string, declineCode?: string): AppError {
  return new AppError(message, 402, true, 'PLAN_PAYMENT_DECLINED', { declineCode: declineCode ?? null, message })
}

/**
 * 🔴 D2: el banco pide autorizar el primer cobro (3D Secure). Es un 409, no un 402 ni un 200: un tablero viejo lee
 * cualquier 402 como «tu banco rechazó» y cualquier 200 como «plan activo»; con el 409 muestra este texto, que dice qué
 * hacer. El secreto va SÓLO en `details` (el manejador de errores no los registra): nunca a un log.
 */
function requiereAutenticacion(clientSecret: string): AppError {
  return new AppError(
    'Tu banco pide autorizar este pago. Actualiza la página e inténtalo de nuevo para ver la autorización de tu banco. No se te cobró nada.',
    409,
    true,
    'PLAN_PAYMENT_REQUIRES_ACTION',
    { clientSecret },
  )
}

export function esErrorDeTarjeta(error: unknown): error is Stripe.errors.StripeError {
  const e = error as { type?: string; code?: string }
  return e?.type === 'StripeCardError' || e?.type === 'card_error'
}

/**
 * La ISO de `current_period_end` de una suscripción, que es lo ÚNICO que puede decir cuándo es
 * el siguiente cobro.
 *
 * 🔴 Nunca se deriva de la cotización: sumarle un mes a «hoy» daría una fecha distinta de la que
 * Stripe va a cobrar de verdad, y el cliente la vería en el correo.
 */
function siguienteCobro(sub: Stripe.Subscription): string {
  const end = subscriptionPeriod(sub).end
  if (end) return end.toISOString()
  // Sin la fecha de Stripe no se inventa una: se dice que no se sabe.
  throw pendiente('la suscripción no trae current_period_end')
}

/** Lo que Stripe cobró de verdad en el primer ciclo, leído de la suscripción. */
function primerCobroDe(sub: Stripe.Subscription, respaldo: number): number {
  const latest = sub.latest_invoice
  if (latest && typeof latest !== 'string') {
    const inv = latest as unknown as { amount_paid?: number; amount_due?: number }
    if (typeof inv.amount_paid === 'number' && inv.amount_paid > 0) return inv.amount_paid
    if (typeof inv.amount_due === 'number') return inv.amount_due
  }
  return respaldo
}

/**
 * Planes editables (B2): un intento STANDARD con una versión publicada por el editor. `comprobante` es el que se cobra (su
 * versión, su precio, su fin de prueba); `rechazo`, por qué no se puede cobrar con lo que llegó. Nunca los dos a la vez.
 */
export interface EstandarConVersion {
  version: OfertaVigente
  comprobante: CotizacionFirmada | null
  rechazo: AppError | null
}

interface Cotizacion {
  expected: number
  campaign: LaunchCampaignRow | null
  listPriceCents: number
  /** Sólo STANDARD con una versión del editor (`versionQueCobra()`); sin ella no existe y todo es B0/B1. */
  estandar?: EstandarConVersion
  /**
   * B2 Task 5 (b2-r9 #3): leer la oferta lanzó y quien llama pidió diferirlo (un intento anterior `IN_PROGRESS` que pudo
   * cobrar). Lleva el error tal cual: se lanza sólo si el PASO 6 termina en un intento nuevo.
   */
  lecturaFallida?: { error: unknown }
}

/**
 * Planes editables (B2): ¿el comprobante de esta petición sirve para cobrar un intento NUEVO con la versión vigente? Nunca
 * lanza: devuelve el rechazo para que quien llama lo lance donde le toque. En este orden:
 *  1. el Básico, con una versión del editor, ya no se vende (`PLAN_NOT_ON_SALE`);
 *  2. un plan con `onSale` falso tampoco;
 *  3. el comprobante mismo (`revisarComprobante`, alcance `org:<id>`): falta, no es válido, venció, es de otra versión, o de
 *     otro plan o periodicidad;
 *  4. con tarjeta y el plan de la vigente sin tarjeta → `SIN_TARJETA`; sin tarjeta y el plan con tarjeta → `CON_TARJETA`;
 *  5. otro bruto que el de la vigente, otro primer cobro que el que la persona vio, u otro fin de prueba que el de sus días
 *     (o un fin con 0 días) → `QUOTE_MISMATCH`;
 *  6. `payNow` que no es «el comprobante no tiene prueba» → `PAGO_HOY`.
 */
export function revisarComprobanteDelAlta(args: {
  input: Pick<ActivatePlanInput, 'tier' | 'interval' | 'payNow' | 'basicPlan' | 'paymentMethodId'> & {
    offer: { expectedFirstChargeCents: number }
    quoteToken?: unknown
  }
  organizationId: string
  version: OfertaVigente
  ahora: Date
}): { comprobante: CotizacionFirmada; rechazo: null } | { comprobante: null; rechazo: AppError } {
  const { input, organizationId, version, ahora } = args
  const n = version.number
  const plan = version.definition[input.tier]
  const rechazo = (error: AppError) => ({ comprobante: null, rechazo: error })

  if (input.basicPlan === true) return rechazo(planFueraDeVenta('BASICO', 'Básico'))
  if (!plan.onSale) return rechazo(planFueraDeVenta(input.tier, plan.displayName))

  const revisado = revisarComprobante({
    token: input.quoteToken,
    alcance: `org:${organizationId}`,
    tier: input.tier,
    interval: input.interval,
    versionNumber: n,
    ahora,
  })
  if (revisado.comprobante === null) return revisado
  const { comprobante } = revisado

  // B2 Task 6: sin tarjeta (`STANDARD_SIN_TARJETA`) el plan de la vigente no puede pedirla. Sus días de prueba también se exigen:
  // una versión sin tarjeta siempre tiene prueba (el esquema de la versión), y un comprobante sin prueba no pasa el `PAGO_HOY` de
  // abajo (la prueba sin tarjeta nunca paga hoy).
  const conTarjeta = Boolean(input.paymentMethodId)
  if (conTarjeta && !plan.requiresCard) return rechazo(ofertaCambio('SIN_TARJETA', n))
  if (!conTarjeta && plan.requiresCard) return rechazo(ofertaCambio('CON_TARJETA', n))

  const bruto = precioDeLaOferta(version.definition, input.tier, input.interval).grossCents
  const finEsperado = plan.trialDays > 0 ? comprobante.issuedAt.getTime() + plan.trialDays * DIA_MS : null
  const finFirmado = comprobante.trialEndsAt ? comprobante.trialEndsAt.getTime() : null
  if (
    comprobante.precioCents !== bruto ||
    comprobante.firstChargeCents !== input.offer.expectedFirstChargeCents ||
    finFirmado !== finEsperado
  ) {
    return rechazo(ofertaCambio('QUOTE_MISMATCH', n))
  }
  if (input.payNow !== (comprobante.trialEndsAt === null)) return rechazo(ofertaCambio('PAGO_HOY', n))
  return { comprobante, rechazo: null }
}

/**
 * PASO 3 — la cotización del SERVIDOR, y la comparación contra lo que el cliente dice haber
 * visto. Es la única fuente del precio.
 */
async function cotizar(
  input: ActivatePlanInput,
  progress: { launchCampaignId: string | null },
  now: Date,
  /**
   * B2 Task 5 (b2-r9 #3): con un intento anterior `IN_PROGRESS`, un error al leer la oferta NO sale aquí: vuelve como
   * `lecturaFallida` y lo decide el PASO 6. Sin un intento anterior, sale aquí como hoy.
   */
  opciones: { diferirLectura?: boolean } = {},
): Promise<Cotizacion> {
  if (input.offer.kind === 'STANDARD' || input.offer.kind === 'STANDARD_SIN_TARJETA') {
    // Planes editables (B2): con una versión del editor el precio sale de su comprobante. 🔴 Aquí NO se lanza su rechazo: lo
    // lanza el PASO 4, o lo difiere (Task 5) cuando hay un intento anterior que pudo cobrar. Sin versión, lo de hoy, literal.
    let version: OfertaVigente | null
    try {
      version = await versionQueCobra()
    } catch (error) {
      if (!opciones.diferirLectura) throw error
      logger.warn('activate-plan: no se pudo leer la oferta — se resuelve primero el intento anterior', {
        organizationId: input.organizationId,
        error: error instanceof Error ? error.message : String(error),
      })
      return {
        expected: input.offer.expectedFirstChargeCents,
        campaign: null,
        // Nunca se lee: sin la oferta no hay intento nuevo (se lanza `lecturaFallida`) y el cierre lee la suscripción.
        listPriceCents: STANDARD_PLAN_GROSS_CENTS[input.tier][input.interval],
        lecturaFallida: { error },
      }
    }
    if (version) {
      const { comprobante, rechazo } = revisarComprobanteDelAlta({ input, organizationId: input.organizationId, version, ahora: now })
      return {
        expected: comprobante?.firstChargeCents ?? input.offer.expectedFirstChargeCents,
        campaign: null,
        listPriceCents: comprobante?.precioCents ?? precioDeLaOferta(version.definition, input.tier, input.interval).grossCents,
        estandar: { version, comprobante, rechazo },
      }
    }
    // 🔴 B2 Task 6: la prueba sin tarjeta sólo existe con una versión del editor. Sin ella nunca cae al precio de hoy: no se cobra.
    if (input.offer.kind === 'STANDARD_SIN_TARJETA') throw ofertaCambio('VERSION', 1)
    const expected = standardFirstChargeCents(standardPlanQuote(), input.tier, input.interval, input.payNow)
    if (expected !== input.offer.expectedFirstChargeCents) {
      throw new ConflictError('El precio cambió. Revísalo antes de pagar.', 'OFFER_CHANGED', {
        standardQuote: { firstChargeCents: expected, tier: input.tier, interval: input.interval, payNow: input.payNow },
      })
    }
    return { expected, campaign: null, listPriceCents: STANDARD_PLAN_GROSS_CENTS[input.tier][input.interval] }
  }

  // 🔴 El reclamo manda. El `code` del cuerpo sólo sirve para comprobar que el cliente y el
  // servidor hablan de la MISMA campaña; si no coincide, no se cobra.
  if (!progress.launchCampaignId) {
    throw new ConflictError('Esta cuenta no tiene una oferta reclamada', 'LAUNCH_OFFER_UNAVAILABLE', { reason: 'NOT_PUBLISHED' })
  }
  const campaign = await prisma.launchCampaign.findUnique({ where: { id: progress.launchCampaignId }, select: LAUNCH_CAMPAIGN_SELECT })
  if (!campaign || campaign.code !== input.offer.code) {
    throw new ConflictError('La oferta ya no está disponible', 'LAUNCH_OFFER_UNAVAILABLE', { reason: 'NOT_PUBLISHED' })
  }

  const disponible = launchOfferAvailability(toOfferRow(campaign), now)
  if (!disponible.available) {
    // 🔴 El cupo protege de vender de MÁS, no de dejar terminar a quien YA apartó su lugar.
    //
    // Secuencia real (auditoría de Codex, 18-sep): queda una plaza → este negocio la reserva →
    // Stripe cobra → se pierde la respuesta → el cliente reintenta. Con `redemptionCount` ya en el
    // tope POR SU PROPIA RESERVA, cortar aquí le devuelve «agotado» a alguien que probablemente ya
    // pagó, y la recuperación del intento (PASO 6) nunca llega a ejecutarse.
    //
    // Se mira SU lugar, de ESTA campaña: uno de otra campaña no es salvoconducto. Si resulta ser de
    // otra VERSIÓN de la oferta, `apartarLugar` lo rechaza con `OFFER_CHANGED` en el PASO 7 — que es
    // la respuesta correcta, y muy distinta de «ya no hay lugares».
    const lugarPropio = await prisma.launchCampaignRedemption.findFirst({
      where: { organizationId: input.organizationId, campaignId: campaign.id, status: { not: REDEMPTION_STATUS.RELEASED } },
      select: { id: true },
    })
    if (!lugarPropio) {
      throw new ConflictError('La oferta ya no está disponible', 'LAUNCH_OFFER_UNAVAILABLE', {
        reason: disponible.reason,
        standardQuote: { firstChargeCents: standardFirstChargeCents(standardPlanQuote(), input.tier, input.interval, true) },
      })
    }
  }

  // La oferta de campaña es de un plan concreto, mensual, y SIEMPRE se paga hoy.
  if (input.tier !== campaign.planTier || input.interval !== 'monthly' || !input.payNow) {
    throw new ConflictError('Esa oferta no aplica a este plan', 'LAUNCH_OFFER_NOT_APPLICABLE', {
      offerTier: campaign.planTier,
      requestedTier: input.tier,
      requestedInterval: input.interval,
      payNow: input.payNow,
    })
  }

  if (input.offer.offerVersion !== campaign.offerVersion || campaign.advertisedPriceCents !== input.offer.expectedFirstChargeCents) {
    throw new ConflictError('La oferta cambió. Revísala antes de pagar.', 'OFFER_CHANGED', {
      launchOffer: buildLaunchOfferView(toOfferRow(campaign), now),
    })
  }

  return { expected: campaign.advertisedPriceCents, campaign, listPriceCents: campaign.listPriceCentsSnapshot as number }
}

/** PASO 4 — el precio VIVO de Stripe tiene que coincidir con el que congelamos. */
/**
 * 🔴 El plan tiene que existir en NUESTRO catálogo ANTES de tocar Stripe.
 *
 * `createPlanSubscription` lo comprueba también, pero lanza DENTRO del try del cobro, donde
 * cualquier excepción se clasifica como «resultado desconocido» y el cliente ve «estamos
 * confirmando tu pago». Medido en vivo el 18-sep: con la Feature ausente, el cobro murió antes
 * de la primera llamada a Stripe y aun así la pantalla prometía una confirmación que no existía,
 * dejando además el lugar de la campaña apartado sin motivo.
 *
 * Un fallo aquí es DETERMINISTA — no hay ningún cobro a medias que proteger —, así que se dice
 * lo que es. El 503 ambiguo se reserva para lo que de verdad no se sabe.
 */
async function verificarPlanConfigurado(tier: PaidPlanTier): Promise<void> {
  const tierCode = tier === 'PREMIUM' ? ('PLAN_PREMIUM' as const) : ('PLAN_PRO' as const)
  const feature = await prisma.feature.findFirst({ where: { code: tierCode, active: true }, select: { id: true } })
  if (feature) return
  // 🚨 a propósito: el alta está muerta para TODOS hasta que alguien siembre el plan.
  logger.error('🚨 activate-plan: el plan no existe en el catálogo — NO se cobra', { tierCode })
  throw new AppError(
    'No pudimos activar tu plan por un problema nuestro de configuración. No se te cobró nada. Escríbenos y lo resolvemos.',
    503,
    true,
    'PLAN_NOT_CONFIGURED',
    { tierCode },
  )
}

/**
 * De dónde salió el precio verificado: la relectura antes de cobrar compara contra la MISMA fuente. `LUGAR` (el precio que
 * guardó el lugar apartado de la campaña) y `SUSCRIPCION` (el que de verdad cobró el intento de un lugar de antes de B1) no se
 * releen: Avoqado no archiva precios (diseño §15). Un precio de la `VERSION` que el PASO 7 guardó en el lugar apartado también se
 * relee como `LUGAR` (Codex B1 #2); la `LLAVE`, nunca: se relee como B0.
 */
type OrigenDelPrecio = 'VERSION' | 'LLAVE' | 'LUGAR' | 'SUSCRIPCION'
type PrecioVerificado = { priceId: string; unitAmount: number; origen: OrigenDelPrecio }

/**
 * B0, tal cual: el precio de la LLAVE del plan, con su 409 `PLAN_PRICE_MISMATCH` también cuando la lista viene vacía (nunca
 * el 503 del resolver). Es el camino sin una versión publicada por el editor (tablas vacías o sólo la v1).
 */
async function verificarPrecioPorLlave(
  tier: PaidPlanTier,
  interval: PlanBillingInterval,
  esperado: number,
): Promise<{ priceId: string; unitAmount: number }> {
  const tierCode = tier === 'PREMIUM' ? ('PLAN_PREMIUM' as const) : ('PLAN_PRO' as const)
  const lookupKey = planLookupKey(tierCode, interval)
  const prices = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 })
  const price = prices.data[0]
  const unitAmount = price?.unit_amount
  if (!price || unitAmount !== esperado) {
    // 🚨 a propósito: significa que alguien movió el precio en Stripe debajo de una oferta viva.
    logger.error('🚨 activate-plan: el precio de Stripe no coincide con el snapshot — NO se cobra', {
      lookupKey,
      esperado,
      stripe: unitAmount ?? null,
    })
    throw new ConflictError('El precio del plan cambió. Vuelve a cargar la página.', 'PLAN_PRICE_MISMATCH', {
      esperado,
      stripe: unitAmount ?? null,
    })
  }
  // El MISMO precio que se leyó aquí es el que se cobra: no se vuelve a listar la llave.
  return { priceId: price.id, unitAmount }
}

/**
 * PASO 4 — el precio que se va a cobrar tiene que ser el que el cliente consintió (`esperado`).
 *
 * - Sin una versión publicada por el editor (`version` nulo): `verificarPrecioPorLlave`, idéntico a B0.
 * - Con ella: el `priceId` de su ranura con `prices.retrieve`. Un precio que Stripe ya no tiene (404), inactivo, de otro
 *   monto o una ranura sin precio dan el MISMO 409 `PLAN_PRICE_MISMATCH` de la llave (la pantalla se recarga), nunca el 503
 *   del resolver.
 *
 * `version` es la que leyó el PASO 3 (`cotizar`, B2): una sola lectura decide si el intento va por la llave o por el
 * comprobante, así una versión publicada en medio no hace cobrar con ella a quien no trae su comprobante.
 */
async function verificarPrecioDeStripe(
  version: OfertaVigente | null,
  tier: PaidPlanTier,
  interval: PlanBillingInterval,
  esperado: number,
): Promise<{ priceId: string; unitAmount: number; origen: 'VERSION' | 'LLAVE' }> {
  if (!version) return { ...(await verificarPrecioPorLlave(tier, interval, esperado)), origen: 'LLAVE' }
  return verificarPrecioDeLaVersion(version, tier, interval, esperado)
}

/** El 409 `PLAN_PRICE_MISMATCH` de un precio que no es el consentido, con su 🚨 (alguien movió el precio debajo de una oferta). */
function precioNoCoincide(contexto: Record<string, unknown>, esperado: number, stripeAmount: number | null, motivo: string): AppError {
  logger.error('🚨 activate-plan: el precio que se iba a cobrar no coincide con el snapshot — NO se cobra', {
    ...contexto,
    esperado,
    stripe: stripeAmount,
    motivo,
  })
  return new ConflictError('El precio del plan cambió. Vuelve a cargar la página.', 'PLAN_PRICE_MISMATCH', {
    esperado,
    stripe: stripeAmount,
  })
}

/**
 * Lo que un precio de CAMPAÑA tiene que ser además de su monto: activo, en MXN, mensual, con el IVA incluido (las mismas
 * comprobaciones con las que se activó la campaña) y del PRODUCTO del plan. Devuelve el motivo si no lo es.
 *
 * 🔴 El producto no es ceremonia: el cupón de la campaña se creó con `applies_to: [producto del plan]`; un precio de otro
 * producto con el mismo monto cobraría la lista completa, sin el descuento anunciado.
 */
function formaDeCampanaQueFalta(price: Stripe.Price, productoDelPlan: string | null): string | null {
  if (price.active !== true) return 'INACTIVO'
  if (price.currency !== 'mxn') return 'OTRA_MONEDA'
  if (price.recurring?.interval !== 'month') return 'NO_ES_MENSUAL'
  if (price.tax_behavior !== 'inclusive') return 'SIN_IVA_INCLUIDO'
  const producto = typeof price.product === 'string' ? price.product : (price.product as { id?: string } | null)?.id
  if (!productoDelPlan || producto !== productoDelPlan) return 'OTRO_PRODUCTO'
  return null
}

/** El producto de Stripe del plan: el de su `Feature` activa (`PLAN_PRO` / `PLAN_PREMIUM`). `null` si no lo tiene (falla cerrado). */
async function productoDelPlan(tier: PaidPlanTier): Promise<string | null> {
  const code = tier === 'PREMIUM' ? 'PLAN_PREMIUM' : 'PLAN_PRO'
  const feature = await prisma.feature.findFirst({ where: { code, active: true }, select: { stripeProductId: true } })
  return feature?.stripeProductId ?? null
}

/**
 * El precio de la ranura de una versión del editor. Con `campana` exige además la forma de un precio de campaña (también el
 * producto del plan).
 */
async function verificarPrecioDeLaVersion(
  version: OfertaVigente,
  tier: PaidPlanTier,
  interval: PlanBillingInterval,
  esperado: number,
  campana?: { productoDelPlan: string | null },
): Promise<{ priceId: string; unitAmount: number; origen: 'VERSION' }> {
  const ranura = precioDeLaOferta(version.definition, tier, interval)
  const contexto = {
    origen: 'VERSION',
    versionId: version.versionId,
    number: version.number,
    tier,
    interval,
    priceId: ranura.stripePriceId,
  }
  if (!ranura.stripePriceId) throw precioNoCoincide(contexto, esperado, null, 'SIN_PRECIO')

  let price: Stripe.Price
  try {
    price = await stripe.prices.retrieve(ranura.stripePriceId)
  } catch (error) {
    if (stripeAfirmaQueNoExiste(error)) throw precioNoCoincide(contexto, esperado, null, 'NO_EXISTE')
    throw error
  }
  const unitAmount = price.unit_amount ?? null
  if (!price.active) throw precioNoCoincide(contexto, esperado, unitAmount, 'INACTIVO')
  if (unitAmount !== esperado || ranura.grossCents !== esperado) throw precioNoCoincide(contexto, esperado, unitAmount, 'OTRO_MONTO')
  const falta = campana ? formaDeCampanaQueFalta(price, campana.productoDelPlan) : null
  if (falta) throw precioNoCoincide(contexto, esperado, unitAmount, falta)
  // El MISMO precio que se leyó aquí es el que se cobra; la relectura sólo compara el puntero.
  return { priceId: ranura.stripePriceId, unitAmount: esperado, origen: 'VERSION' }
}

/** Un precio ya leído (del lugar o de la suscripción) que se va a cobrar sin releer: su monto, su forma y su producto, o 409. */
function exigirPrecioDeCampana(
  price: Stripe.Price | null | undefined,
  esperado: number,
  productoDelPlan: string | null,
  contexto: Record<string, unknown>,
): { priceId: string; unitAmount: number } {
  if (!price?.id) throw precioNoCoincide(contexto, esperado, null, 'SIN_PRECIO')
  const unitAmount = price.unit_amount ?? null
  const falta = formaDeCampanaQueFalta(price, productoDelPlan) ?? (unitAmount !== esperado ? 'OTRO_MONTO' : null)
  if (falta) throw precioNoCoincide({ ...contexto, priceId: price.id }, esperado, unitAmount, falta)
  return { priceId: price.id, unitAmount: esperado }
}

/**
 * PASO 4 de un intento de CAMPAÑA (planes editables B1). La campaña consintió `listPriceCentsSnapshot`; ése es el monto que se
 * exige en todos los caminos (409 `PLAN_PRICE_MISMATCH` si no). `LaunchCampaign.stripePriceId` no se usa para cobrar.
 *
 * - **Sin una versión publicada por el editor** (`versionQueCobra()` nulo; B1 con el interruptor apagado): el camino de hoy,
 *   literal, para todo intento: `verificarPrecioPorLlave` (`LLAVE`), con sus códigos de hoy y la relectura de B0.
 * - **Con ella**, en este orden:
 *   1. el lugar `RESERVED` de esta organización, campaña y versión de la oferta **con** su `stripePriceId` → ése (`LUGAR`);
 *   2. un lugar `RESERVED` **sin** precio (apartado antes de B1) con la suscripción de su intento → el precio que de verdad
 *      cobró ese intento (`SUSCRIPCION`). Sólo si la suscripción es de ESE lugar (`metadata.launchRedemptionId`): la de otro
 *      intento (otro lugar, o una prueba estándar) o una que Stripe ya no tiene (404) caen al paso 3, como en B0;
 *   3. un lugar `RESERVED` sin precio ni suscripción suya → la llave (`LLAVE`; la llave nunca se movió después de B1, §15);
 *   4. un intento nuevo → el mensual de la versión (`VERSION`).
 *   En LUGAR, SUSCRIPCION y VERSION el precio también tiene que ser del producto del plan (el `applies_to` del cupón); la LLAVE
 *   sigue literal, como B0.
 */
async function precioDeLaCampana(
  campaign: LaunchCampaignRow,
  organizationId: string,
  progress: { planStripeSubscriptionId: string | null },
): Promise<PrecioVerificado> {
  const tier = campaign.planTier as PaidPlanTier
  const esperado = campaign.listPriceCentsSnapshot as number
  const version = await versionQueCobra()
  if (!version) return { ...(await verificarPrecioPorLlave(tier, 'monthly', esperado)), origen: 'LLAVE' }

  const lugar = await prisma.launchCampaignRedemption.findFirst({
    where: { organizationId, campaignId: campaign.id, offerVersion: campaign.offerVersion, status: REDEMPTION_STATUS.RESERVED },
    select: { id: true, stripePriceId: true },
  })
  const contexto = { organizationId, campaignId: campaign.id, redemptionId: lugar?.id ?? null }

  if (lugar?.stripePriceId) {
    let price: Stripe.Price
    try {
      price = await stripe.prices.retrieve(lugar.stripePriceId)
    } catch (error) {
      if (stripeAfirmaQueNoExiste(error)) throw precioNoCoincide({ ...contexto, origen: 'LUGAR' }, esperado, null, 'NO_EXISTE')
      throw error
    }
    return { ...exigirPrecioDeCampana(price, esperado, await productoDelPlan(tier), { ...contexto, origen: 'LUGAR' }), origen: 'LUGAR' }
  }

  if (lugar && progress.planStripeSubscriptionId) {
    // El precio que de verdad cobró ese intento. Un 404 (Stripe dice que no existe) cae a la llave; cualquier otro error sube
    // tal cual («no pude ver» nunca se lee como «no existe»).
    let sub: Stripe.Subscription | null
    try {
      sub = await stripe.subscriptions.retrieve(progress.planStripeSubscriptionId)
    } catch (error) {
      if (!stripeAfirmaQueNoExiste(error)) throw error
      sub = null
    }
    if (sub && sub.metadata?.launchRedemptionId === lugar.id) {
      const price = sub.items?.data?.[0]?.price as Stripe.Price | undefined
      return {
        ...exigirPrecioDeCampana(price, esperado, await productoDelPlan(tier), {
          ...contexto,
          origen: 'SUSCRIPCION',
          subscriptionId: sub.id,
        }),
        origen: 'SUSCRIPCION',
      }
    }
  }

  if (lugar) return { ...(await verificarPrecioPorLlave(tier, 'monthly', esperado)), origen: 'LLAVE' }

  return verificarPrecioDeLaVersion(version, tier, 'monthly', esperado, { productoDelPlan: await productoDelPlan(tier) })
}

/**
 * PASO 6 — ¿el intento anterior llegó a crear una suscripción?
 *
 * 🔴 Se recorre con `autoPagingEach`, NO con una sola página. Con `limit: 20` bastaba que la
 * suscripción buena quedara en la página 2 para concluir «no se creó», estrenar llave y **cobrar
 * dos veces**. Paginar cuesta una llamada de más; no paginar cuesta un cargo duplicado.
 */
async function buscarSuscripcionDelIntento(
  customerId: string,
  planActivationKey: string,
): Promise<{ encontrada: Stripe.Subscription | null; cubrioTodo: boolean }> {
  let encontrada: Stripe.Subscription | null = null
  let vistas = 0
  let cubrioTodo = true
  await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 }).autoPagingEach(sub => {
    if (sub.metadata?.planActivationKey === planActivationKey) {
      encontrada = sub
      return false // corta el recorrido
    }
    vistas += 1
    if (vistas >= TOPE_SUSCRIPCIONES_POR_CLIENTE) {
      cubrioTodo = false // no se recorrió todo: «no la encontré» ya no prueba nada
      return false
    }
    return true
  })
  return { encontrada, cubrioTodo }
}

/**
 * ¿Queda un cobro de plan del alta SIN cerrar? Lo pregunta `complete` antes de dejar terminar el alta en Gratis.
 *
 * 🔴 Codex R12: exigir sólo `planStripeSubscriptionId` dejaba pasar el caso peor — Stripe cobró pero la respuesta se
 * perdió ANTES de guardar el id. Aquí se busca igual que la recuperación de `activatePlan` (paso 6): por id si lo hay,
 * y si no, por la llave del intento entre TODAS las suscripciones del cliente. «No pude ver» nunca es «no existe».
 */
export async function hayCobroDelAltaSinCerrar(progress: {
  organizationId: string
  planActivationStatus: string | null
  planActivationAttempt: number
  planStripeSubscriptionId: string | null
  /** B2 Task 6: la versión del intento. Sólo con una del editor (≥ 2) se lee la suscripción guardada; sin ella, lo de hoy. */
  planOfferVersionNumber?: number | null
}): Promise<boolean> {
  if (progress.planActivationStatus !== PLAN_ACTIVATION_STATUS.IN_PROGRESS) return false
  // 🔴 B2 Task 6 (b2-r3 #3): una prueba sin tarjeta que Stripe ya canceló sin cobrar no es un cobro abierto. Sólo puede existir con
  // una versión del editor: sin ella, el id guardado basta como hoy, sin leer Stripe. Con ella, si es esa prueba, se sigue mirando
  // lo demás (la búsqueda por la llave y lo vivo del negocio), igual que sin id.
  if (progress.planStripeSubscriptionId && !(await esPruebaTerminadaGuardada(progress))) return true
  // Sin cliente de Stripe no pudo crearse ninguna suscripción: el cliente se crea ANTES de cobrar (paso 4).
  const llave = `plan-activation:${progress.organizationId}:${progress.planActivationAttempt}`
  let afterId: string | undefined
  while (true) {
    // Paginar, no truncar: un cobro en otra página también impide terminar el alta.
    const conCliente = await prisma.venue.findMany({
      where: { organizationId: progress.organizationId, stripeCustomerId: { not: null }, ...(afterId ? { id: { gt: afterId } } : {}) },
      select: { id: true, stripeCustomerId: true },
      orderBy: { id: 'asc' },
      take: 100,
    })
    for (const { id, stripeCustomerId } of conCliente) {
      try {
        const { encontrada, cubrioTodo } = await buscarSuscripcionDelIntento(stripeCustomerId as string, llave)
        if (!cubrioTodo) return true
        const delIntento = encontrada as Stripe.Subscription | null
        // B2 Task 6: la prueba sin tarjeta que terminó sin cobrar tampoco cuenta (sólo lee Stripe si es `canceled` con su metadata).
        if (delIntento && delIntento.status !== 'incomplete_expired' && !(await pruebaSinTarjetaTerminada(delIntento))) return true
        // 🔴 Codex R13: el carril viejo de `complete` cobra con otra llave (`onboarding-complete:<org>`) y sin ese metadata,
        // y su cobro dudoso también deja IN_PROGRESS. Un negocio que aún no termina su alta no tiene por qué tener NINGUNA
        // suscripción de plan viva: cualquiera que esté cobrando (o a medio cobrar) cuenta como abierta.
        // El inventario común distingue una función conocida de un plan, de varios planes y de lo desconocido.
        // No poder determinar UN tier nunca demuestra que no haya cobro; los ítems incompletos también bloquean.
        const inventario = await inventarioDeObligaciones(id)
        if (
          inventario.conCambiosProgramados.length ||
          inventario.vivas.some(sub => sub.proyecciones.some(p => p.tipo === 'PLAN' || p.tipo === 'DESCONOCIDO'))
        )
          return true
      } catch (error) {
        logger.warn('complete: no se pudo consultar Stripe por un cobro del alta sin cerrar — se trata como abierto', {
          organizationId: progress.organizationId,
          error: error instanceof Error ? error.message : String(error),
        })
        return true
      }
    }
    if (conCliente.length < 100) return false
    afterId = conCliente[conCliente.length - 1].id
  }
}

/**
 * B2 Task 6: ¿la suscripción guardada del intento es la prueba sin tarjeta que ya terminó sin cobrar? Sin versión del editor, `false`
 * sin leer nada. «No pude ver» nunca es «terminó»: un error de Stripe es `false` (el cobro cuenta como abierto, como hoy).
 */
async function esPruebaTerminadaGuardada(progress: {
  organizationId: string
  planStripeSubscriptionId: string | null
  planOfferVersionNumber?: number | null
}): Promise<boolean> {
  if ((progress.planOfferVersionNumber ?? 0) < 2 || !progress.planStripeSubscriptionId) return false
  try {
    return await pruebaSinTarjetaTerminada(await stripe.subscriptions.retrieve(progress.planStripeSubscriptionId))
  } catch (error) {
    logger.warn('complete: no se pudo leer la suscripción guardada del alta — se trata como un cobro abierto', {
      organizationId: progress.organizationId,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

/** Cuántos negocios con cliente de Stripe se recorren al buscar la suscripción de un intento por su llave (un alta tiene uno). */
const TOPE_DE_NEGOCIOS_POR_LLAVE = 100

/**
 * B2 Task 5 (b2-r1 #1): la suscripción del intento con esa llave entre los clientes de Stripe de los negocios de la
 * organización (como `hayCobroDelAltaSinCerrar`), para cuando el intento nunca guardó su id. `null` si no está o si no se
 * pudo recorrer todo (más de 100 negocios, o un cliente con más suscripciones que el tope): «no la vi» nunca autoriza nada.
 * Un error de Stripe sube tal cual.
 */
async function suscripcionDelIntentoEnSusNegocios(organizationId: string, planActivationKey: string): Promise<Stripe.Subscription | null> {
  const conCliente = await prisma.venue.findMany({
    where: { organizationId, stripeCustomerId: { not: null } },
    select: { id: true, stripeCustomerId: true },
    orderBy: { id: 'asc' },
    take: TOPE_DE_NEGOCIOS_POR_LLAVE + 1,
  })
  if (conCliente.length > TOPE_DE_NEGOCIOS_POR_LLAVE) return null
  for (const { stripeCustomerId } of conCliente) {
    const { encontrada, cubrioTodo } = await buscarSuscripcionDelIntento(stripeCustomerId as string, planActivationKey)
    if (encontrada) return encontrada
    if (!cubrioTodo) return null
  }
  return null
}

/**
 * PASO 7 — apartar el lugar del cupo. Una sola transacción.
 *
 * 🔴 `findFirst` y no `findUnique`: el candado es el índice único PARCIAL
 * `(organizationId) WHERE status <> 'RELEASED'`, que garantiza a lo más UNA fila viva por
 * organización y conserva las RELEASED como historia.
 */
async function apartarLugar(
  campaign: LaunchCampaignRow,
  organizationId: string,
  venueId: string,
  staffId: string,
  now: Date,
  /** El precio verificado en el PASO 4: el lugar nuevo lo guarda y, retomado después de publicar otra versión, cobra con él. */
  stripePriceId: string,
): Promise<{ id: string; reused: boolean; stripePriceId: string | null }> {
  return prisma.$transaction(async tx => {
    const vivo = await tx.launchCampaignRedemption.findFirst({
      where: { organizationId, status: { not: REDEMPTION_STATUS.RELEASED } },
    })

    if (vivo?.status === REDEMPTION_STATUS.APPLIED) {
      throw new ConflictError('Este negocio ya tiene un plan activo', 'PLAN_ALREADY_ACTIVATED')
    }

    if (vivo?.status === REDEMPTION_STATUS.RESERVED) {
      // 🔴 Reusar el lugar SÓLO si es de ESTA campaña y de ESTA versión de oferta. Con otra
      // versión, Stripe cobraría con el cupón nuevo y el correo diría el precio viejo — el
      // snapshot es lo que el cliente consintió y NUNCA se reescribe.
      if (vivo.campaignId !== campaign.id || vivo.offerVersion !== campaign.offerVersion) {
        throw new ConflictError('La oferta cambió. Revísala antes de pagar.', 'OFFER_CHANGED', {
          launchOffer: buildLaunchOfferView(toOfferRow(campaign), now),
        })
      }
      return { id: vivo.id, reused: true, stripePriceId: vivo.stripePriceId ?? null }
    }

    // 🔴 EL CANDADO DEL CUPO. En Read Committed, `UPDATE … WHERE count < cap` bloquea la fila y
    // vuelve a evaluar el WHERE tras obtener el candado: 20 transacciones sobre un cupo de 5
    // dejan exactamente 5 lugares tomados.
    const seat = await tx.launchCampaign.updateMany({
      where: {
        id: campaign.id,
        status: 'ACTIVE',
        offerVersion: campaign.offerVersion,
        validFrom: { lte: now },
        validUntil: { gt: now },
        redemptionCount: { lt: prisma.launchCampaign.fields.redemptionCap },
      },
      data: { redemptionCount: { increment: 1 } },
    })
    if (seat.count !== 1) {
      const releida = await tx.launchCampaign.findUnique({ where: { id: campaign.id }, select: LAUNCH_CAMPAIGN_SELECT })
      const motivo = releida ? launchOfferAvailability(toOfferRow(releida), now) : { available: false as const, reason: 'ENDED' as const }
      throw new ConflictError('La oferta ya no está disponible', 'LAUNCH_OFFER_UNAVAILABLE', {
        reason: motivo.available ? 'SOLD_OUT' : motivo.reason,
      })
    }

    const creada = await tx.launchCampaignRedemption.create({
      data: {
        campaignId: campaign.id,
        organizationId,
        venueId,
        staffId,
        status: REDEMPTION_STATUS.RESERVED,
        // Snapshot de lo que el cliente consintió. No se relee de la ficha nunca más.
        offerVersion: campaign.offerVersion,
        planTier: campaign.planTier,
        advertisedPriceCents: campaign.advertisedPriceCents,
        discountAmountCents: campaign.discountAmountCents as number,
        discountMonths: campaign.discountMonths,
        listPriceCents: campaign.listPriceCentsSnapshot as number,
        stripeCouponId: campaign.stripeCouponId as string,
        stripePriceId,
      },
      select: { id: true },
    })
    return { id: creada.id, reused: false, stripePriceId }
  })
}

/**
 * Libera un lugar apartado: CAS sobre `status='RESERVED'` y el decremento del contador EN LA
 * MISMA TRANSACCIÓN.
 *
 * 🔴 El CAS no es ceremonia: sin él, dos caminos que liberen el mismo lugar (un rechazo y un
 * reintento) decrementarían el contador DOS veces y la campaña regalaría un lugar de cupo.
 */
export async function liberarLugar(redemptionId: string, campaignId: string, motivo: string): Promise<boolean> {
  return prisma.$transaction(tx => liberarLugarEn(tx, redemptionId, campaignId, motivo))
}

/** El cuerpo de {@link liberarLugar}, para poder liberar DENTRO de la transacción que acredita la propiedad (Codex #14). */
async function liberarLugarEn(tx: Prisma.TransactionClient, redemptionId: string, campaignId: string, motivo: string): Promise<boolean> {
  const r = await tx.launchCampaignRedemption.updateMany({
    where: { id: redemptionId, status: REDEMPTION_STATUS.RESERVED },
    data: { status: REDEMPTION_STATUS.RELEASED, releasedAt: new Date(), lastError: motivo.slice(0, 300) },
  })
  if (r.count === 0) return false
  await tx.launchCampaign.updateMany({
    where: { id: campaignId, redemptionCount: { gt: 0 } },
    data: { redemptionCount: { decrement: 1 } },
  })
  return true
}

/**
 * 🔴 Codex #14: acreditar la propiedad del intento y liberar el lugar van en UNA transacción.
 *
 * Estaban en dos: entre la primera y la segunda, otra petición tomaba un intento nuevo y reusaba la reserva —que
 * seguía `RESERVED`—, y esta liberación se la quitaba por debajo. Comprobar el `count` antes de abrir otra
 * transacción no cierra esa ventana, sólo la hace más corta. Y si no somos los dueños, no se libera nada.
 *
 * `estadoFinal` es el estado al que pasa el intento: el previo cuando no hubo cobro, `DECLINED` cuando el banco
 * rechazó. Devuelve si la fila era nuestra.
 */
async function cerrarIntentoYLiberarLugar(args: {
  organizationId: string
  attempt: number
  lease: Date
  estadoFinal: string
  lugar: { redemptionId: string; campaignId: string; motivo: string } | null
}): Promise<boolean> {
  return prisma.$transaction(async tx => {
    const { count } = await tx.onboardingProgress.updateMany({
      where: {
        organizationId: args.organizationId,
        planActivationStatus: PLAN_ACTIVATION_STATUS.IN_PROGRESS,
        planActivationAttempt: args.attempt,
        planActivationLeaseUntil: args.lease,
      },
      data: { planActivationStatus: args.estadoFinal as never, planActivationLeaseUntil: null },
    })
    if (count === 0) return false
    if (args.lugar) await liberarLugarEn(tx, args.lugar.redemptionId, args.lugar.campaignId, args.lugar.motivo)
    return true
  })
}

/**
 * Deja el lease como estaba, sin subir el intento: sólo se usa cuando NO hubo cobro.
 *
 * 🔴 Exige el vencimiento que ESTA petición escribió (Codex R4): estado e intento no cambian cuando otra petición
 * recupera un lease vencido, así que sin la marca del dueño esta escritura le pisaba el IN_PROGRESS a quien estaba
 * cobrando y lo dejaba sin candado a media compra.
 */
async function soltarLease(organizationId: string, status: string, attempt: number, lease: Date): Promise<void> {
  await prisma.onboardingProgress.updateMany({
    where: {
      organizationId,
      planActivationStatus: PLAN_ACTIVATION_STATUS.IN_PROGRESS,
      planActivationAttempt: attempt,
      planActivationLeaseUntil: lease,
    },
    data: { planActivationStatus: status as never, planActivationLeaseUntil: null },
  })
}

/**
 * 🔴 D2 (Codex r1 #2 y r2 #1, spec §6.4 b): el plan sólo se entrega si la PRIMERA factura quedó pagada por el monto
 * consentido (`primerCobroPagado.ts`). Si no —o si no se pudo verificar—, 503 con el lease VIVO y el lugar RESERVED: lo
 * revisa una persona, igual que «no se pudo determinar qué plan se cobró».
 */
async function exigirPrimerCobroPagado(venueId: string, subscriptionId: string, esperadoCents: number): Promise<void> {
  let motivo: string | undefined
  const cubierto = await primerCobroCubierto(venueId, subscriptionId, esperadoCents).catch((error: unknown) => {
    motivo = error instanceof Error ? error.message : String(error)
    return false
  })
  if (cubierto) return
  logger.error('🚨 activate-plan: el primer cobro no está pagado por el monto consentido — no se entrega', {
    venueId,
    subscriptionId,
    esperadoCents,
    motivo,
  })
  throw pendiente('el primer cobro no está pagado por el monto consentido')
}

const esCobrada = (estado: string) => (SUSCRIPCION_COBRADA as readonly string[]).includes(estado)
const idDe = (valor: string | { id: string } | null | undefined) => (typeof valor === 'string' ? valor : valor?.id)

/** El PaymentIntent de la primera factura, leído de sus pagos (el predeterminado, o el primero de tipo PaymentIntent). */
function piDeLosPagos(pagos: Stripe.ApiList<Stripe.InvoicePayment>): Stripe.PaymentIntent | null {
  const delPi = pagos.data.filter(p => p.payment.type === 'payment_intent')
  const pago = delPi.find(p => p.is_default) ?? delPi[0]
  return typeof pago?.payment.payment_intent === 'object' ? pago.payment.payment_intent : null
}

/**
 * B2 Task 5 (b2-r7 #6, carry 2): la modalidad con la que se CERRÓ el cobro, leída de la suscripción recuperada. Nunca del
 * cuerpo ni del comprobante: `pagada` (su primera factura cobró algo, o ya está `active`), `sinTarjeta` (su metadata),
 * `paymentMethodId` (su método), `offerVersion` (su metadata `planOfferVersion`) y `precioCents` (lo que su precio cobra).
 */
interface ModalidadCobrada {
  pagada: boolean
  sinTarjeta: boolean
  paymentMethodId: string | null
  offerVersion: number | null
  precioCents: number | null
}
function modalidadCobrada(sub: Stripe.Subscription): ModalidadCobrada {
  const factura = typeof sub.latest_invoice === 'object' ? (sub.latest_invoice as { amount_paid?: number } | null) : null
  const version = Number(sub.metadata?.planOfferVersion)
  const unitAmount = (sub.items?.data?.[0]?.price as { unit_amount?: number | null } | undefined)?.unit_amount
  return {
    pagada: (factura?.amount_paid ?? 0) > 0 || sub.status === 'active',
    sinTarjeta: sub.metadata?.sinTarjeta === 'true',
    paymentMethodId: idDe(sub.default_payment_method) ?? null,
    offerVersion: Number.isSafeInteger(version) && version >= 1 ? version : null,
    precioCents: typeof unitAmount === 'number' ? unitAmount : null,
  }
}

/** El lugar del cupo que apartó un intento, tal como lo dejó en la metadata de su suscripción. */
type LugarDelIntento = { redemptionId: string; campaignId: string; offerVersion: string }

/**
 * Codex b2-code #2 (r4 #2): la versión y la periodicidad que firma el comprobante de la petición, aunque ya no sea el de la vigente
 * (el reenvío del navegador tras el reto manda el suyo). `null` sin comprobante, o si no es legible para esta organización (firma,
 * alcance o vencimiento): nunca lanza. Sólo lo lee la recuperación de un reto con versión del editor (o con la oferta ilegible).
 */
function loQueFirmaElComprobante(token: unknown, organizationId: string, ahora: Date): LoQueFirmaElComprobante | null {
  if (token === undefined || token === null) return null
  try {
    const { versionNumber, interval, tier, firstChargeCents } = verificarCotizacion(token, `org:${organizationId}`, ahora)
    return { versionNumber, interval, tier, firstChargeCents }
  } catch {
    return null
  }
}

/** Lo que el reto compara del comprobante de la petición (r4 #2 y r5 B): su versión, su periodicidad, su plan y su primer cobro. */
type LoQueFirmaElComprobante = { versionNumber: number; interval: Periodicidad; tier: PlanPagado; firstChargeCents: number }

/** La periodicidad del precio de una suscripción del plan (`null` si no la trae). */
function periodicidadDeLaSuscripcion(sub: Stripe.Subscription): 'monthly' | 'annual' | null {
  const periodo = sub.items?.data?.[0]?.price?.recurring?.interval
  return periodo === 'year' ? 'annual' : periodo === 'month' ? 'monthly' : null
}

/** Si falta cualquiera de los tres datos, `null`: no se libera nada que no se pueda nombrar completo. */
function lugarDeLaMetadata(sub: Stripe.Subscription): LugarDelIntento | null {
  const { launchRedemptionId, launchCampaignId, launchOfferVersion } = sub.metadata ?? {}
  return launchRedemptionId && launchCampaignId && launchOfferVersion
    ? { redemptionId: launchRedemptionId, campaignId: launchCampaignId, offerVersion: launchOfferVersion }
    : null
}

/**
 * La única línea que deja descartar la suscripción incompleta de un intento anterior (QA 18-oct: no dejaba ninguna). Sólo
 * ids y el motivo: el secreto del cobro nunca va al log.
 */
function registrarDescarte(organizationId: string, subscriptionId: string, motivo: 'PAGO_NO_AUTORIZADO' | 'OTRO_INTENTO' | 'YA_EXPIRADA') {
  logger.info('activate-plan: se descartó la suscripción incompleta del intento anterior (no se cobró)', {
    organizationId,
    subscriptionId,
    motivo,
  })
}

/**
 * 🔴 D2 (spec §6.3 (2)): descartar un intento que no se pagó = ANULAR su factura, nunca `subscriptions.cancel`.
 *
 * Medido en Stripe de prueba (18-oct): anular es CONDICIONAL —sobre una factura ya pagada Stripe responde 400 «Invoices
 * with `paid` payments cannot be voided.»— y, si pasa, deja la suscripción en `incomplete_expired` al instante.
 * `cancel` NO es condicional: si el navegador pagó un instante antes, cancelaría una suscripción PAGADA y el intento nuevo
 * cobraría otra vez.
 *
 * Si anular falla se relee la suscripción: ya cobrada ⇒ se pagó en ese instante y se recupera (sin cobrar otra vez);
 * `incomplete_expired` ⇒ ya estaba descartada; cualquier otra cosa, o Stripe sin contestar ⇒ 'INCIERTO' («no pude ver»
 * nunca es «no existe»).
 */
async function anularIntento(sub: Stripe.Subscription): Promise<'DESCARTADA' | { cobrada: Stripe.Subscription } | 'INCIERTO'> {
  try {
    const facturaId = idDe(sub.latest_invoice)
    if (!facturaId) throw new Error('la suscripción no trae su factura')
    await stripe.invoices.voidInvoice(facturaId)
    return 'DESCARTADA'
  } catch (error) {
    logger.warn('activate-plan: no se pudo anular la factura del intento anterior — se relee la suscripción', {
      subscriptionId: sub.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
  const fresca = await stripe.subscriptions.retrieve(sub.id).catch(() => null)
  if (fresca && esCobrada(fresca.status)) return { cobrada: fresca }
  if (fresca?.status === 'incomplete_expired') return 'DESCARTADA'
  return 'INCIERTO'
}

/**
 * 🔴 D2 (spec §6.3): la suscripción del intento anterior sigue `incomplete` —es la del 2.º create, que espera el reto del
 * banco—. Antes esto era un 503 durante 23 h; ahora se decide con lo que dice Stripe AHORA (la sub con su secreto y el
 * PaymentIntent de su primera factura):
 *
 * | Stripe                                    | ¿Mismo intento? | Qué pasa                                                 |
 * |-------------------------------------------|-----------------|----------------------------------------------------------|
 * | factura `paid` o PI `succeeded/processing` | da igual        | cobrada ⇒ se recupera; si Stripe aún no la activa ⇒ 503 y lease suelto |
 * | PI `requires_action/requires_confirmation` | sí              | 409 con el MISMO secreto (reanudar), lease suelto         |
 * | PI `requires_payment_method`               | sí              | se anula ⇒ DECLINED, lugar liberado, 402 del banco        |
 * | cualquier PI no pagado                     | no              | se anula ⇒ «no existe» ⇒ intento nuevo (`lugarDescartado`) |
 * | la relectura ya dice `incomplete_expired`  | da igual        | descartada sin anular ⇒ intento nuevo                     |
 *
 * «Mismo intento» = la misma tarjeta (cada tarjeta tecleada es un `pm_` nuevo), el mismo plan, la misma campaña y versión de
 * la oferta (o ninguna) y pagar hoy: es el pedido que el propio navegador manda tras el reto. Cualquier lectura que falle
 * ⇒ 503 con el lease VIVO (regla 4). Los 409/402/503 de aquí salen tal cual: el llamador NO lo envuelve en su `try/catch`
 * de lecturas. Cada 503 de «no sé» deja un `logger.warn` con organización, suscripción y estado (nunca el secreto).
 *
 * 🔴 Codex b2-code #2 (r3 y r4, la regla corregida), también la versión de la oferta estándar (`planOfferVersion` de la suscripción)
 * y la periodicidad de la suscripción:
 * - con un comprobante VÁLIDO en la petición (`comprobanteDelPedido`: lo que firma el token, que no necesita leer el puntero):
 *   decide el comprobante, aunque la lectura de la oferta falle: su versión, su periodicidad (r4 #2), su plan y si su primer cobro es
 *   hoy (r5 B), nunca los del cuerpo. La tarjeta sigue siendo la del cuerpo;
 * - sin comprobante válido y con la versión del editor LEÍDA (`delEditor`): la versión vacía y la periodicidad del cuerpo; contra un
 *   reto de una versión del editor no es el mismo intento (se anula y sale el rechazo de la petición, como hoy);
 * - sin comprobante válido y con la lectura de la oferta fallida, o sin versión del editor: lo de B1, sin comparar.
 * Un comprobante NUEVO (otra versión u otro ciclo) no reanuda el reto viejo: se anula y se estrena intento. El reenvío del navegador
 * con SU comprobante (aunque ya no sea el de la vigente) sí lo reanuda.
 */
async function resolverIntentoIncompleto(args: {
  sub: Stripe.Subscription
  input: ActivatePlanInput
  campaign: LaunchCampaignRow | null
  organizationId: string
  attempt: number
  lease: Date
  delEditor: boolean
  comprobanteDelPedido: LoQueFirmaElComprobante | null
}): Promise<{ recuperada: Stripe.Subscription | null; lugarDescartado: LugarDelIntento | null }> {
  const { input, campaign, organizationId, attempt, lease, delEditor, comprobanteDelPedido } = args
  /** La versión y la periodicidad con que se compara el reto (ver arriba); `null` = no se compara (B1). */
  const comparadoCon = comprobanteDelPedido
    ? { version: String(comprobanteDelPedido.versionNumber), interval: comprobanteDelPedido.interval }
    : delEditor
      ? { version: '', interval: input.interval }
      : null
  // 🔴 Codex b2-code r5 B: con un comprobante válido, también el plan y «pagar hoy» salen de él (su primer cobro), no del cuerpo.
  const planPedido = comprobanteDelPedido
    ? codigoDelPlan(comprobanteDelPedido.tier)
    : input.tier === 'PREMIUM'
      ? 'PLAN_PREMIUM'
      : 'PLAN_PRO'
  const pagaHoy = comprobanteDelPedido ? comprobanteDelPedido.firstChargeCents > 0 : input.payNow
  const leer = async <T>(lectura: () => Promise<T>): Promise<T> => {
    try {
      return await lectura()
    } catch (error) {
      logger.warn('activate-plan: no se pudo leer en Stripe el intento incompleto', {
        organizationId,
        subscriptionId: args.sub.id,
        error: error instanceof Error ? error.message : String(error),
      })
      throw pendiente('no se pudo consultar Stripe')
    }
  }

  const sub = await leer(() => stripe.subscriptions.retrieve(args.sub.id, { expand: ['latest_invoice.confirmation_secret'] }))
  // Expiró entre las dos lecturas (las 23 h, o la anuló otra petición): ya está descartada, sin anular nada (Codex r1 #3).
  if (sub.status === 'incomplete_expired') {
    registrarDescarte(organizationId, sub.id, 'YA_EXPIRADA')
    return { recuperada: null, lugarDescartado: lugarDeLaMetadata(sub) }
  }
  if (esCobrada(sub.status)) return { recuperada: sub, lugarDescartado: null }
  if (sub.status !== 'incomplete') {
    logger.warn('activate-plan: la relectura del intento incompleto dio un estado que no se sabe resolver', {
      organizationId,
      subscriptionId: sub.id,
      status: sub.status,
    })
    throw pendiente(`la suscripción anterior quedó en estado ${sub.status}`)
  }

  const factura = typeof sub.latest_invoice === 'object' ? sub.latest_invoice : null
  const pagos = await leer(() => {
    if (!factura?.id) throw new Error('la suscripción no trae su factura')
    return stripe.invoicePayments.list({ invoice: factura.id, expand: ['data.payment.payment_intent'] })
  })
  const pi = piDeLosPagos(pagos)

  if (factura?.status === 'paid' || pi?.status === 'succeeded' || pi?.status === 'processing') {
    const fresca = await leer(() => stripe.subscriptions.retrieve(sub.id))
    if (esCobrada(fresca.status)) return { recuperada: fresca, lugarDescartado: null }
    // Ya se autorizó, sólo falta que Stripe la active (medido: en el mismo instante). El lease se suelta para que el
    // reintento de 10 s del tablero lo cierre sin chocar con «tu pago se está confirmando».
    await soltarLease(organizationId, PLAN_ACTIVATION_STATUS.IN_PROGRESS, attempt, lease)
    throw pendiente('el pago ya se autorizó; Stripe todavía no activa la suscripción')
  }

  const mismoIntento =
    idDe(sub.default_payment_method) === input.paymentMethodId &&
    sub.metadata?.featureCode === planPedido &&
    (sub.metadata?.launchCampaignId ?? '') === (campaign?.id ?? '') &&
    // 🔴 Ruling 8: también la VERSIÓN de la oferta. Si la campaña cambió a media autorización, reanudar cobraría lo de la
    // versión vieja y el PASO 7 respondería OFFER_CHANGED (cobrado y sin acceso); así se anula y se estrena intento, y el
    // avance libera el lugar de la versión vieja con la misma regla.
    (sub.metadata?.launchOfferVersion ?? '') === (campaign ? String(campaign.offerVersion) : '') &&
    // Codex b2-code #2 (r4, la regla corregida): la versión de la oferta estándar y la periodicidad (ver arriba).
    (comparadoCon === null ||
      ((sub.metadata?.planOfferVersion ?? '') === comparadoCon.version && periodicidadDeLaSuscripcion(sub) === comparadoCon.interval)) &&
    pagaHoy

  if (mismoIntento && (pi?.status === 'requires_action' || pi?.status === 'requires_confirmation')) {
    // REANUDAR: volver a confirmar un PI que espera al banco se acepta (medido), así sirve también tras una recarga.
    const secreto = factura?.confirmation_secret?.client_secret
    if (!secreto) {
      logger.warn('activate-plan: el banco espera la autorización pero la factura no trae su secreto', {
        organizationId,
        subscriptionId: sub.id,
        status: pi?.status,
      })
      throw pendiente('la factura del intento no trae su secreto de confirmación')
    }
    await soltarLease(organizationId, PLAN_ACTIVATION_STATUS.IN_PROGRESS, attempt, lease)
    logger.info('activate-plan: el banco sigue esperando que se autorice el primer cobro', { organizationId, subscriptionId: sub.id })
    throw requiereAutenticacion(secreto)
  }
  // Mismo intento con un PI en otro estado (o sin PI): no se sabe qué pasó; no se anula ni se cobra a ciegas.
  if (mismoIntento && pi?.status !== 'requires_payment_method') {
    logger.warn('activate-plan: el pago del mismo intento quedó en un estado que no se sabe resolver', {
      organizationId,
      subscriptionId: sub.id,
      status: pi?.status ?? null,
    })
    throw pendiente(`el pago del intento quedó en ${pi?.status ?? 'sin estado'}`)
  }

  const anulada = await anularIntento(sub)
  if (anulada === 'INCIERTO') throw pendiente('no se pudo descartar el intento anterior')
  if (anulada !== 'DESCARTADA') return { recuperada: anulada.cobrada, lugarDescartado: null }
  registrarDescarte(organizationId, sub.id, mismoIntento ? 'PAGO_NO_AUTORIZADO' : 'OTRO_INTENTO')
  if (!mismoIntento) return { recuperada: null, lugarDescartado: lugarDeLaMetadata(sub) }

  // El reto falló o el banco rechazó después de autenticar: es un rechazo. Estado y lugar se cierran JUNTOS y sólo si el
  // intento sigue siendo nuestro (Codex #14), igual que el PASO 10.
  const { launchRedemptionId, launchCampaignId } = sub.metadata ?? {}
  await cerrarIntentoYLiberarLugar({
    organizationId,
    attempt,
    lease,
    estadoFinal: PLAN_ACTIVATION_STATUS.DECLINED,
    lugar:
      launchRedemptionId && launchCampaignId
        ? { redemptionId: launchRedemptionId, campaignId: launchCampaignId, motivo: 'PLAN_PAYMENT_DECLINED' }
        : null,
  })
  const lpe = pi?.last_payment_error
  throw rechazado(lpe?.message || 'Tu banco no autorizó el pago', lpe?.decline_code ?? lpe?.code)
}

/** `pruebaSinTarjetaTerminada` para el PASO 6: «no pude ver» nunca es «terminó» (`false`: sigue el 503 de hoy). */
async function esPruebaSinTarjetaTerminada(sub: Stripe.Subscription, organizationId: string): Promise<boolean> {
  try {
    return await pruebaSinTarjetaTerminada(sub)
  } catch (error) {
    logger.warn('activate-plan: no se pudo revisar si la prueba sin tarjeta terminó — se responde como hoy', {
      organizationId,
      subscriptionId: sub.id,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

/**
 * B2 Task 6 (b2-r9 #4): el negocio guarda el id de un cliente que Stripe ya borró. Se suelta con un CAS sobre ESE id (si otro lo
 * cambió en medio, no se toca) y `getOrCreateStripeCustomer` crea uno nuevo por el camino de hoy. «Borrado» lo decide
 * `clienteDeStripeVivo` (`deleted: true` o «no existe»); cualquier otro error de Stripe sube y no se cobra.
 */
async function soltarClienteBorrado(venueId: string, organizationId: string, staffId: string): Promise<void> {
  const negocio = await prisma.venue.findUnique({ where: { id: venueId }, select: { stripeCustomerId: true } })
  const guardado = negocio?.stripeCustomerId
  // 🔴 Fix round 2 (C2): esta lectura es la puerta antes de cobrar, así que va con las opciones del cliente de siempre (`{}`, con
  // sus reintentos), no con el tope de 5 s de las lecturas que sólo informan.
  if (!guardado || (await clienteDeStripeVivo(guardado, {})) !== null) return
  const { count } = await prisma.venue.updateMany({ where: { id: venueId, stripeCustomerId: guardado }, data: { stripeCustomerId: null } })
  logger.warn('activate-plan: el cliente de Stripe del negocio ya no existe — se suelta y se crea otro', {
    organizationId,
    venueId,
    customerId: guardado,
    soltado: count === 1,
  })
  if (count === 1) {
    await logAction({
      staffId,
      venueId,
      organizationId,
      action: 'STRIPE_CUSTOMER_RELEASED_DELETED',
      entity: 'Venue',
      entityId: venueId,
      data: { customerId: guardado },
    })
  }
}

export async function activatePlan(
  input: ActivatePlanInput,
  /**
   * 🔴 R2: `soloRecuperar` = el id de la suscripción que el revisor de altas a medio pago viene a cerrar. Con él, esta
   * función sólo puede RECUPERAR esa suscripción ya cobrada: si el alta no apunta a ella, o si Stripe no la da por cobrada,
   * sale sin cobrar, sin anular y sin estrenar intento.
   * `via`: quién terminó el alta, para la bitácora (H0). Sin él, es el cobro del navegador.
   */
  opciones: { soloRecuperar?: string; via?: ViaDelCierre } = {},
): Promise<ActivatePlanResult> {
  const { organizationId, staffId } = input
  // 🔴 Plan Básico: antes de leer o tocar nada. Con otra combinación no hay prueba que termine sola sin cobrar.
  if (!basicPlanValido(input)) throw new BadRequestError(MENSAJE_BASIC_PLAN_INVALIDO, 'BASIC_PLAN_INVALID')
  const now = new Date()
  // 🔴 H0 (28-oct): con el plan confirmado el alta se termina AQUÍ, no cuando el navegador toca «Entrar». Un fallo no cambia
  // la respuesta (el dinero ya se movió): lo retoma el barrido. Promesa: Avoqado/docs/audit/2026-10-28-alta-pagada-se-termina-sola/.
  const terminarElAlta = () => terminarAltaCobradaSinRomper(organizationId, { via: opciones.via ?? 'cobro', staffId })

  // ---- PASO 1: carga ----
  const progress = await prisma.onboardingProgress.findUnique({ where: { organizationId } })
  if (!progress) throw new NotFoundError('No encontramos tu registro', 'ONBOARDING_NOT_FOUND')
  // Un alta terminada con su plan ACTIVO sigue al PASO 2 (contesta «plan activo» con sus tres comprobaciones): el reenvío del
  // navegador tras el reto del banco puede llegar cuando el aviso de Stripe o el barrido ya la terminaron (H0, Codex r1).
  if (progress.completedAt && progress.planActivationStatus !== PLAN_ACTIVATION_STATUS.ACTIVE) {
    throw new ConflictError('Este registro ya terminó', 'ONBOARDING_ALREADY_COMPLETED')
  }

  // 🔴 CONSENTIMIENTO ANTES DEL CARGO (auditoría de Codex, 18-sep).
  //
  // Éste es el camino que COBRA, y no exigía los términos: la única comprobación vivía en
  // `completeV2Onboarding`, o sea DESPUÉS del punto donde el cargo ya pudo ocurrir. El cargo es
  // recurrente y va a una tarjeta: cobrarle un plan mensual a alguien que nunca aceptó los términos
  // ni el aviso de privacidad es justo lo que se discute en un contracargo, y el aviso tiene además
  // su propia exigencia legal en México.
  //
  // Va aquí, en el PASO 1, y no más abajo: comprobarlo después de tocar Stripe sería pedir perdón
  // con el dinero ya movido.
  if (!progress.termsAcceptedAt) {
    throw new ConflictError('Acepta los términos y el aviso de privacidad para continuar', 'TERMS_NOT_ACCEPTED')
  }
  if (
    opciones.soloRecuperar &&
    (progress.planActivationStatus !== PLAN_ACTIVATION_STATUS.IN_PROGRESS || progress.planStripeSubscriptionId !== opciones.soloRecuperar)
  ) {
    throw new ConflictError('El alta ya no espera esa suscripción', 'PLAN_ACTIVATION_IN_PROGRESS')
  }

  const venue = await ensureVenueForOnboarding(organizationId, staffId)
  if (!venue) throw new ConflictError('Falta el nombre de tu negocio para poder cobrar', 'PLAN_VENUE_NOT_READY')

  // ---- PASO 2: idempotencia rápida ----
  if (progress.planActivationStatus === PLAN_ACTIVATION_STATUS.ACTIVE) {
    // 🔴 `parseV2Plan` y no una lectura directa de `v2SetupData.plan`: es la MISMA función que usa
    // la finalización, y además encuentra el plan guardado por el asistente viejo (anidado bajo un
    // `stepN`). Leerlo a mano aquí y con `parseV2Plan` allá es exactamente cómo dos sitios acaban
    // contestando distinto sobre el mismo dinero.
    const activo = parseV2Plan(progress.v2SetupData)
    const mismoPlan = activo?.tier === input.tier && activo?.interval === input.interval
    if (!mismoPlan) {
      throw new ConflictError('Este negocio ya tiene un plan activo', 'PLAN_ALREADY_ACTIVATED', {
        currentTier: activo?.tier ?? null,
        currentInterval: activo?.interval ?? null,
      })
    }

    if (input.offer.kind === 'LAUNCH') {
      // 🔴 LA TERCERA COMPROBACIÓN, y es la que impide regalar la oferta. El camino es real:
      // alguien toca «Ver otros planes», toma la prueba de 30 días (que deja ACTIVE **sin cobro,
      // sin cupón y sin redención**), vuelve y toca «Pagar $22 y entrar». Comparando sólo tier e
      // intervalo esto respondería 200 `alreadyActive`: el cliente creería que pagó, nadie
      // cobraría $22, no se apartaría lugar… y a los 30 días Stripe le cobraría $1,158.84.
      const redimida = await prisma.launchCampaignRedemption.findFirst({
        where: { organizationId, status: REDEMPTION_STATUS.APPLIED },
        select: { id: true, campaignId: true, advertisedPriceCents: true, discountMonths: true, listPriceCents: true, offerVersion: true },
      })
      const campaignDelReclamo = progress.launchCampaignId
      if (!redimida || (campaignDelReclamo && redimida.campaignId !== campaignDelReclamo)) {
        throw new ConflictError(
          'Tu plan ya está activo sin esta oferta, así que no se puede aplicar encima.',
          'PLAN_ACTIVE_WITHOUT_OFFER',
          // `charged`: si ese plan activo se PAGÓ (no es prueba gratis). La pantalla no puede decir «no te cobramos nada»
          // a quien ya pagó en un intento anterior.
          { currentTier: activo?.tier ?? null, currentInterval: activo?.interval ?? null, charged: activo?.payNow === true },
        )
      }
    }

    if (!progress.planStripeSubscriptionId) throw pendiente('no hay suscripción registrada')
    // 🔴 Los dos importes salen de la suscripción REAL, nunca de la cotización.
    const sub = await stripe.subscriptions.retrieve(progress.planStripeSubscriptionId, { expand: ['latest_invoice'] })
    const redencion = await prisma.launchCampaignRedemption.findFirst({
      where: { organizationId, status: REDEMPTION_STATUS.APPLIED },
      include: { campaign: { select: { code: true } } },
    })
    await terminarElAlta()
    // La modalidad de lo que YA existe: un reintento con otra elección no la cambia (nadie toca cancel_at_period_end).
    const modalidadActiva = modalidadDePrueba(sub)
    return {
      status: 'ACTIVE',
      alreadyActive: true,
      tier: input.tier,
      interval: input.interval,
      firstChargeCents: primerCobroDe(sub, redencion?.advertisedPriceCents ?? 0),
      nextChargeAt: siguienteCobro(sub),
      ...modalidadActiva,
      // B2 Task 6 (b2-r8 #9, b2-r9 #7): tras perder el primer 200, la tarjeta que Stripe cobraría y si habrá cobro, de AHORA.
      ...(modalidadActiva.sinTarjeta ? await avisoDeLaPruebaSinTarjeta(sub) : {}),
      ...(redencion
        ? {
            launchOffer: {
              code: redencion.campaign.code,
              offerVersion: redencion.offerVersion,
              months: redencion.discountMonths,
              renewalMonthlyCents: redencion.discountMonths > 1 ? redencion.advertisedPriceCents : redencion.listPriceCents,
            },
          }
        : {}),
    }
  }

  // ---- PASO 3: cotización del servidor ----
  // 🔴 B2 Task 5 (b2-r9 #3): leído ANTES del PASO 3. Un intento anterior IN_PROGRESS pudo cobrar, y recuperarlo no depende de
  // leer la oferta: si esa lectura lanza, el error se difiere (`lecturaFallida`) y lo decide el PASO 6.
  const hayIntentoAnterior = progress.planActivationStatus === PLAN_ACTIVATION_STATUS.IN_PROGRESS
  const { expected, campaign, listPriceCents, estandar, lecturaFallida } = await cotizar(input, progress, now, {
    diferirLectura: hayIntentoAnterior,
  })
  /** Planes editables (B2): el comprobante con el que se cobra este intento (sólo STANDARD con versión del editor). */
  const conComprobante = estandar?.comprobante ?? null
  /** B2 Task 6: la prueba SIN tarjeta (sólo llega con una versión del editor; `cotizar` ya la frenó sin ella). */
  const sinTarjetaPedido = input.offer.kind === 'STANDARD_SIN_TARJETA'

  // ---- PASO 4: verificación contra Stripe (sólo lecturas) ----
  // 🔴 B2 Task 5 (Codex B1 #1, b2-r1 #1): con una versión del editor (o sin poder leer la oferta) y un intento anterior
  // IN_PROGRESS, el comprobante y el precio NO se revisan aquí. Recuperar no depende del comprobante ni del plan pedido: el
  // rechazo se guarda (`rechazoDiferido`), el precio queda pendiente y el PASO 6 decide. Si recupera una suscripción cobrada o
  // en prueba, el alta cierra con ELLA; si termina en un intento nuevo, ahí se lanza el rechazo o se verifica el precio de la
  // vigente. Sin versión del editor, B0/B1 literal. Esto reemplaza la excepción angosta del revisor (Ruling T4-1).
  const recuperacionDiferida = hayIntentoAnterior && (estandar !== undefined || lecturaFallida !== undefined)
  const rechazoDiferido: { error: unknown } | null = !recuperacionDiferida
    ? null
    : lecturaFallida
      ? lecturaFallida
      : estandar?.rechazo
        ? { error: estandar.rechazo }
        : null
  // Planes editables (B2): un comprobante que no sirve para un intento NUEVO se rechaza AQUÍ, antes de Stripe y del lease.
  if (!recuperacionDiferida && estandar?.rechazo) throw estandar.rechazo
  // Una campaña cobra con el precio de su lugar apartado, de su intento, de la llave o de la versión (`precioDeLaCampana`).
  // STANDARD: con un comprobante, su precio (`precioCents`) contra la ranura de SU versión (origen `VERSION`).
  let precioVerificado: PrecioVerificado | null = recuperacionDiferida
    ? null
    : campaign
      ? await precioDeLaCampana(campaign, organizationId, progress)
      : await verificarPrecioDeStripe(estandar?.version ?? null, input.tier, input.interval, listPriceCents)
  /** El precio verificado de un intento NUEVO: nunca falta (PASO 4, o después del PASO 6 si la recuperación se difirió). */
  const precioDelIntentoNuevo = (): PrecioVerificado => {
    if (!precioVerificado) throw new Error('activate-plan: un intento nuevo llegó sin su precio verificado — no se cobra')
    return precioVerificado
  }
  await verificarPlanConfigurado(input.tier)
  const venueRecord = await prisma.venue.findUnique({
    where: { id: venue.id },
    select: { id: true, name: true, slug: true, email: true, timezone: true, organization: { select: { email: true, name: true } } },
  })
  // 🔴 B2 Task 6 (b2-r9 #4): con comprobante, un cliente que Stripe ya borró se suelta ANTES de reusarlo (con un CAS) y el camino de
  // hoy crea otro. Con tarjeta, un método del cliente borrado no es del nuevo: el 400 de hoy de abajo, sin cobrar. Sin versión del
  // editor, ninguna lectura nueva.
  if (conComprobante) await soltarClienteBorrado(venue.id, organizationId, staffId)
  const customerId = await getOrCreateStripeCustomer(
    venue.id,
    venueRecord?.email || venueRecord?.organization?.email || '',
    venueRecord?.organization?.name || venueRecord?.name || 'Avoqado',
    venueRecord?.name,
    venueRecord?.slug,
  )
  // 🔴 R2 (Codex plan r1 #1): el revisor no cobra con esta tarjeta —sólo recupera lo ya pagado—, así que no se le exige.
  // Si el cliente la retiró después de pagar, exigirla dejaba lo cobrado sin acceso en cada pasada.
  // B2 Task 6: la prueba sin tarjeta no trae tarjeta que comprobar (el cliente de Stripe se crea igual: costo aceptado, §16).
  const { fingerprint } =
    opciones.soloRecuperar || sinTarjetaPedido
      ? { fingerprint: null }
      : await assertPaymentMethodBelongsToCustomer(input.paymentMethodId ?? '', customerId)

  // ---- PASO 5: lease con CAS ----
  const prev = {
    status: progress.planActivationStatus as string,
    attempt: progress.planActivationAttempt,
    leaseUntil: progress.planActivationLeaseUntil,
  }
  const leaseVigente = prev.status === PLAN_ACTIVATION_STATUS.IN_PROGRESS && prev.leaseUntil != null && prev.leaseUntil > now
  if (leaseVigente) throw new ConflictError('Tu pago se está confirmando. Espera unos segundos.', 'PLAN_ACTIVATION_IN_PROGRESS')

  // Un intento IN_PROGRESS con el lease VENCIDO se RECUPERA con su mismo número: subirlo
  // estrenaría llave de idempotencia y crearía un segundo cobro del mismo intento.
  let attempt = prev.status === PLAN_ACTIVATION_STATUS.IN_PROGRESS ? prev.attempt : prev.attempt + 1
  // 🔴 El vencimiento LEÍDO entra al CAS y el nuevo es la marca del dueño (Codex C6): al recuperar un lease vencido, estado
  // e intento no cambian, así que sin esto dos peticiones lo tomaban a la vez — una cobraba y la otra, rechazada después,
  // liberaba el lugar de la oferta que la primera estaba usando.
  // 🔴 Y se mide con el reloj de ESTE momento, no con el `now` del principio (Codex R4): entre uno y otro corren
  // cinco llamadas externas a Stripe, así que un lease nacido del reloj viejo podía tomarse ya casi vencido.
  const nuestroLease = new Date(Date.now() + LEASE_MS)
  const tomado = await prisma.onboardingProgress.updateMany({
    where: {
      organizationId,
      completedAt: null,
      planActivationStatus: prev.status as never,
      planActivationAttempt: prev.attempt,
      planActivationLeaseUntil: prev.leaseUntil,
      // R2: el revisor sólo toma el alta si sigue apuntando a la suscripción que vino a cerrar.
      ...(opciones.soloRecuperar ? { planStripeSubscriptionId: opciones.soloRecuperar } : {}),
    },
    data: {
      planActivationStatus: PLAN_ACTIVATION_STATUS.IN_PROGRESS,
      planActivationAttempt: attempt,
      planActivationLeaseUntil: nuestroLease,
      // 🔴 D2 (Codex r1 #1): un intento NUEVO nace sin el id del anterior, en este mismo CAS. Si heredara el de una
      // suscripción ya descartada, la recuperación del PASO 6 la leería por id, la daría por muerta sin buscar por la llave
      // de ESTE intento, y se cobraría encima de la que este intento sí creó. Desde NONE no se toca (el único que deja NONE
      // con id es el carril viejo de `complete`, que usa ese rastro); al recuperar un IN_PROGRESS, el id es el suyo.
      ...(prev.status === PLAN_ACTIVATION_STATUS.DECLINED ? { planStripeSubscriptionId: null } : {}),
      // Planes editables (B2): la INTENCIÓN queda en la base antes de cualquier llamada a Stripe. Sólo un intento nuevo seguro
      // (desde NONE o DECLINED) con su comprobante; al recuperar un IN_PROGRESS no se toca (Task 5).
      ...(conComprobante && (prev.status === PLAN_ACTIVATION_STATUS.NONE || prev.status === PLAN_ACTIVATION_STATUS.DECLINED)
        ? { planOfferVersionNumber: conComprobante.versionNumber }
        : {}),
    },
  })
  if (tomado.count === 0) throw new ConflictError('Tu pago se está confirmando. Espera unos segundos.', 'PLAN_ACTIVATION_IN_PROGRESS')

  // ---- PASO 6: recuperación de un intento desconocido ----
  let suscripcionRecuperada: Stripe.Subscription | null = null
  if (prev.status === PLAN_ACTIVATION_STATUS.IN_PROGRESS) {
    const llaveAnterior = `plan-activation:${organizationId}:${prev.attempt}`
    try {
      // 🔴 Si el intento anterior alcanzó a dejar su id, se recupera EXACTA — sin ventana, sin
      // recorrer páginas. Cualquier cota por fecha deja fuera un intento más viejo y entonces se
      // crea un segundo cobro; con 31 días de por medio lo reprodujo Codex (20-sep). El id se
      // persiste en cuanto la suscripción existe (paso 8), así que este es el camino normal.
      if (progress.planStripeSubscriptionId) {
        suscripcionRecuperada = await stripe.subscriptions.retrieve(progress.planStripeSubscriptionId)
      }
    } catch (error) {
      logger.warn('activate-plan: no se pudo recuperar la suscripción registrada', {
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      })
      throw pendiente('no se pudo consultar Stripe')
    }
    try {
      // RESPALDO, sólo para intentos anteriores a que se persistiera el id: se busca por la llave
      // de idempotencia entre TODAS las suscripciones del cliente, sin ventana de fechas.
      if (!suscripcionRecuperada) {
        const busqueda = await buscarSuscripcionDelIntento(customerId, llaveAnterior)
        suscripcionRecuperada = busqueda.encontrada

        // 🔴 «No la encontré» sólo vale como «no existe» si de verdad se recorrió todo. Si se llegó
        // al tope, el desenlace del intento anterior es incierto — y ante lo incierto NUNCA se
        // autoriza otro cobro (mismo principio que el cobro con terminal).
        if (!suscripcionRecuperada && !busqueda.cubrioTodo) {
          logger.error('🚨 activate-plan: no se pudo recorrer todas las suscripciones del cliente — NO se cobra de nuevo', {
            organizationId,
            intentoAnterior: prev.attempt,
            tope: TOPE_SUSCRIPCIONES_POR_CLIENTE,
          })
          throw pendiente('el intento anterior no se pudo verificar')
        }
      }
    } catch (error) {
      // 🔴 «No pude ver» NUNCA es «no existe». Se deja el lease VIVO y se responde 503.
      logger.warn('activate-plan: no se pudo consultar Stripe para recuperar el intento anterior', {
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      })
      throw pendiente('no se pudo consultar Stripe')
    }
    // 🔴 Encontrarla NO es haberla cobrado. `status: 'all'` es correcto para la BÚSQUEDA (hay que
    // verla aunque esté rara, o se cobra dos veces), pero el desenlace se clasifica aquí:
    //   - viva (`active`/`trialing`/`past_due`/`unpaid`) ⇒ el dinero quedó: se reusa.
    //   - `incomplete_expired` ⇒ el primer cargo nunca se completó y Stripe la dio por muerta: no
    //     hay nada que reusar, se estrena intento.
    //   - `canceled` (u otro) ⇒ AMBIGUO: pudo cobrar y pudo no cobrar. Ni conceder acceso ni
    //     cobrar encima: 503 para que alguien lo mire.
    //   - `incomplete` ⇒ 🔴 D2: en el alta sólo la deja el 2.º create (el que espera el reto del banco), así que se resuelve
    //     con el estado REAL en Stripe (`resolverIntentoIncompleto`), fuera de los try/catch de lectura de arriba para que
    //     su 409, su 402 y sus 503 salgan tal cual.
    // (Segunda auditoría de Codex, 18-sep; `incomplete`: D2, 18-oct.)
    // 🔴 B2 Task 6 (b2-r3 #3): la prueba SIN tarjeta del intento que Stripe ya canceló al terminar sin tarjeta y sin cobrar. Antes de
    // la guarda del revisor y de leer `canceled` como «no sé» (503): el alta se cierra en Gratis y se dice. Sólo lee Stripe si es
    // `canceled` con la metadata `sinTarjeta` (sólo existe con versión del editor); si no se puede leer, sigue el 503 de hoy.
    if (suscripcionRecuperada?.status === 'canceled' && (await esPruebaSinTarjetaTerminada(suscripcionRecuperada, organizationId))) {
      await cerrarAltaEnGratis(organizationId, prev.attempt, suscripcionRecuperada, nuestroLease, {
        via: opciones.via ?? 'navegador',
        staffId,
        venueId: venue.id,
      })
      throw pruebaTerminadaSinTarjeta()
    }
    // 🔴 R2: el revisor sólo cierra lo que Stripe YA cobró. Cualquier otra cosa sale aquí, antes de clasificarla: nunca llega
    // a anular (resolverIntentoIncompleto), a estrenar intento ni a cobrar. Lo que expiró lo atiende R1, sin esta función.
    if (opciones.soloRecuperar && !(suscripcionRecuperada && esCobrada(suscripcionRecuperada.status))) {
      await soltarLease(organizationId, PLAN_ACTIVATION_STATUS.IN_PROGRESS, prev.attempt, nuestroLease)
      throw pendiente('la suscripción todavía no está cobrada')
    }
    /** El lugar del cupo del intento descartado: se libera en el avance de abajo si este pedido no lo reusa. */
    let lugarDescartado: LugarDelIntento | null = null
    if (suscripcionRecuperada) {
      const estado = suscripcionRecuperada.status
      if (estado === 'incomplete_expired') {
        // 🔴 D2 (Codex r1 #3): expiró (las 23 h) o el proceso murió entre anularla y escribir aquí. Sin esto, su lugar quedaba
        // RESERVED para siempre si el cliente volvía y terminaba con otra cosa (la prueba de 30 días).
        lugarDescartado = lugarDeLaMetadata(suscripcionRecuperada)
        registrarDescarte(organizationId, suscripcionRecuperada.id, 'YA_EXPIRADA')
        suscripcionRecuperada = null
      } else if (estado === 'incomplete') {
        ;({ recuperada: suscripcionRecuperada, lugarDescartado } = await resolverIntentoIncompleto({
          sub: suscripcionRecuperada,
          input,
          campaign,
          organizationId,
          attempt,
          lease: nuestroLease,
          // Codex b2-code r3/r4: el comprobante decide, también si leer la oferta falló (`lecturaFallida`): su versión la dice el token,
          // sin el puntero. Sin versión del editor (la lectura no la vio), el comprobante no se lee (B0/B1 literal). `delEditor`: la
          // versión del editor se LEYÓ (sin comprobante válido, entonces sí se compara).
          delEditor: estandar !== undefined,
          comprobanteDelPedido: recuperacionDiferida ? loQueFirmaElComprobante(input.quoteToken, organizationId, now) : null,
        }))
      } else if (!SUSCRIPCION_COBRADA.includes(estado as (typeof SUSCRIPCION_COBRADA)[number])) {
        logger.warn('activate-plan: suscripción recuperada en estado no concluyente', {
          organizationId,
          subscriptionId: suscripcionRecuperada.id,
          estado,
        })
        throw pendiente(`la suscripción anterior quedó en estado ${estado}`)
      }
    }
    if (!suscripcionRecuperada) {
      // No existe de verdad: intento nuevo, llave nueva.
      attempt = prev.attempt + 1
      // 🔴 B2 Task 5: un intento NUEVO sí exige el comprobante y el precio de la vigente. Con un comprobante válido se verifica
      // su precio AQUÍ (lectura de Stripe, antes de la transacción del avance); si no sirve, no hubo cobro: el lease se suelta.
      const porVerificar = recuperacionDiferida && !rechazoDiferido ? estandar : undefined
      if (porVerificar) {
        try {
          precioVerificado = await verificarPrecioDeLaVersion(porVerificar.version, input.tier, input.interval, listPriceCents)
        } catch (error) {
          await soltarLease(organizationId, PLAN_ACTIVATION_STATUS.IN_PROGRESS, prev.attempt, nuestroLease)
          throw error
        }
      }
      const lugar = lugarDescartado
      const avanzado = await prisma.$transaction(async tx => {
        const { count } = await tx.onboardingProgress.updateMany({
          where: {
            organizationId,
            planActivationStatus: PLAN_ACTIVATION_STATUS.IN_PROGRESS,
            planActivationAttempt: prev.attempt,
            planActivationLeaseUntil: nuestroLease,
          },
          // 🔴 D2 (Codex r1 #1): el intento nuevo nace SIN el id del anterior. Si heredara el de la suscripción descartada, el
          // reintento la leería por id, la daría por muerta sin buscar por la llave de ESTE intento, y cobraría encima.
          // 🔴 B2 Task 5: y la INTENCIÓN del intento nuevo (la versión de su comprobante) queda en la base en esta misma
          // transacción, antes de cualquier llamada a Stripe.
          data: {
            planActivationAttempt: attempt,
            planStripeSubscriptionId: null,
            ...(porVerificar && conComprobante ? { planOfferVersionNumber: conComprobante.versionNumber } : {}),
          },
        })
        // 🔴 D2 (Codex r1 #3): el lugar del intento descartado se libera en la MISMA transacción que acredita que el intento es
        // nuestro, salvo que este pedido lo reuse (misma campaña y versión: `apartarLugar` lo toma de nuevo). `liberarLugarEn`
        // es CAS sobre RESERVED: liberar de más es imposible.
        if (
          count === 1 &&
          lugar &&
          (!campaign || campaign.id !== lugar.campaignId || String(campaign.offerVersion) !== lugar.offerVersion)
        ) {
          await liberarLugarEn(tx, lugar.redemptionId, lugar.campaignId, 'PLAN_ATTEMPT_DISCARDED')
        }
        return count
      })
      // Ya no es nuestro (el lease venció y otra petición lo tomó): no se cobra nada.
      if (avanzado === 0) throw new ConflictError('Tu pago se está confirmando. Espera unos segundos.', 'PLAN_ACTIVATION_IN_PROGRESS')
      // 🔴 B2 Task 5: el intento anterior no cobró y lo que llegó no sirve para uno nuevo (un comprobante que no es de la
      // vigente, o la oferta que no se pudo leer). No hubo cobro: queda IN_PROGRESS en el intento nuevo, sin lease ni id.
      if (rechazoDiferido) {
        await soltarLease(organizationId, PLAN_ACTIVATION_STATUS.IN_PROGRESS, attempt, nuestroLease)
        throw rechazoDiferido.error
      }
    }
  }

  // ---- PASO 7: apartar el lugar del cupo ----
  let redemption: { id: string; reused: boolean; stripePriceId: string | null } | null = null
  if (campaign) {
    try {
      redemption = await apartarLugar(campaign, organizationId, venue.id, staffId, now, precioDelIntentoNuevo().priceId)
    } catch (error) {
      // No hubo cobro: el lease vuelve a como estaba.
      await soltarLease(organizationId, prev.status, attempt, nuestroLease)
      throw error
    }
  }
  // ---- PASOS 8-11: Stripe y cierre ----
  const planActivationKey = `plan-activation:${organizationId}:${attempt}`
  // 🔴 Planes editables (B2, §12.2): con una versión del editor nunca va `INTRO_PRO_3M`; el precio es el de la versión.
  const legacyIntro = !campaign && !estandar && isLegacyIntroEligible(input.tier, input.interval, input.payNow)
  const cuponEsperado = campaign ? (campaign.stripeCouponId as string) : legacyIntro ? LEGACY_INTRO_OFFER.couponId : null

  let subscriptionId: string
  let reused = false
  /** El cobro de esta pasada salió del 2.º create de D2 (`default_incomplete`): su primer cobro se exige pagado. */
  let conAutenticacion = false
  if (suscripcionRecuperada) {
    subscriptionId = suscripcionRecuperada.id
    // 🔴 Recuperar el COBRO no basta: hay que reconstruir el ACCESO.
    //
    // Saltarse `createPlanSubscription` aquí es correcto (la suscripción ya existe y volver a
    // crearla cobraría dos veces), pero esa función era también la ÚNICA que escribía
    // `VenueFeature` — la fila que resuelve si el negocio puede usar lo que pagó. Si el fallo que
    // estamos recuperando ocurrió justo entre el cobro de Stripe y esa escritura, sin esto el
    // reintento cierra el onboarding en ACTIVE, marca la redención APPLIED… y deja al cliente
    // pagando sin producto. Los webhooks tampoco lo reparan: buscan la fila y si no está, se van.
    //
    // El acceso lo reconstruye la ENTREGA (más abajo, para los dos caminos): idempotente, y el tier sale del PRECIO de lo
    // que SE COBRÓ, nunca de lo que pide este reintento (reusar la suscripción de Pro y conceder Premium regalaría el tier
    // de arriba). (Auditoría de Codex, 18-sep, hallazgo #4; V5-A paso 6.)
  } else {
    // 🔴 V5-A paso 6: el cobro NUEVO pasa por la regla común — el mismo candado por negocio del dashboard y lo VIVO en
    // Stripe —. Si el negocio ya tiene un plan cobrando (p. ej. lo pagó por el dashboard), no se cobra encima.
    // `intentoCobrar` distingue un rechazo de la regla (nada se cobró) de un fallo del cobro (pudo cobrarse).
    let intentoCobrar = false
    /** 🔴 D2: el secreto del reto del banco. Se atiende DESPUÉS del try/catch (dentro, su catch lo haría un 503). */
    let secretoDelReto: string | undefined
    try {
      // El precio verificado de este intento nuevo (B2 Task 5: si faltara, no se cobra y el catch suelta el lease).
      const verificado = precioDelIntentoNuevo()
      // 🔴 Codex B1 #2: un precio de la VERSIÓN que ya quedó guardado en el lugar apartado (nuevo o reusado, con ESE precio) se
      // relee como `LUGAR`: el lugar ya consintió ese precio y Avoqado no archiva precios (§15). Releer el puntero respondía 409 si
      // en medio se pausó la campaña y se publicó otra versión, y el 409 liberaba un lugar que la campaña pausada ya no deja
      // recuperar. La `LLAVE` (sin versión del editor) se relee como B0, aunque el lugar la guarde: es la paridad con B0.
      const origenDeLaRelectura: OrigenDelPrecio =
        verificado.origen === 'VERSION' && redemption?.stripePriceId === verificado.priceId ? 'LUGAR' : verificado.origen
      // 🔴 D2 (Codex r1 #4): el fin del candado de la regla común, medido JUSTO antes de pedirlo (la transacción arranca
      // después, así que el plazo real es más largo, nunca más corto), con 10 s para confirmar la transacción. El 2.º
      // create no sale si no cabe: «no quedó tiempo» cae abajo como resultado desconocido (503, lugar RESERVED).
      const terminarAntesDe = Date.now() + TIMEOUT_DE_LA_TRANSACCION_MS - 10_000
      const tierCode = input.tier === 'PREMIUM' ? ('PLAN_PREMIUM' as const) : ('PLAN_PRO' as const)
      const r = await autorizarObligacionNueva(
        venue.id,
        customerId,
        { tipo: 'PLAN', tier: input.tier },
        async () => {
          // 🔴 Codex B0 #1/#2: el precio se vuelve a leer JUSTO antes de cobrar (aún sin `intentoCobrar`). Si entre el PASO 4
          // y aquí cambió, cobrar con el verificado dejaba al cliente cobrado sin acceso (la entrega ya no reconoce ese
          // precio por su llave) o, si se archivó, un rechazo de Stripe clasificado como «pudo cobrarse». Se responde 409
          // sin cobrar: el catch de abajo suelta el lease y libera el lugar como cualquier rechazo previo al cobro. Si
          // coincide, se cobra con el priceId del PASO 4 (el que se comparó contra el monto consentido).
          // Planes editables B1: se relee la MISMA fuente que dio el precio verificado. `VERSION` → el puntero (sólo la
          // base, sin Stripe: otra versión publicada en medio es otro priceId); `LLAVE` → la llave, como B0. `LUGAR` y
          // `SUSCRIPCION` no se releen: es el precio que ese lugar ya consintió y Avoqado no archiva precios (§15). Un precio
          // de la versión que el PASO 7 guardó en el lugar ya es `LUGAR` (`origenDeLaRelectura`).
          if (conComprobante) {
            // Planes editables (B2): con comprobante se relee la vigente (sólo la base) y tiene que ser LA MISMA versión del
            // comprobante con el MISMO precio en esta ranura: otra versión publicada en medio (aunque sólo cambien los días) es
            // otra oferta. 409 por el mismo camino de hoy (suelta el lease y el lugar). Lo que se publique DESPUÉS de esta
            // relectura es residuo aceptado: sale con la versión que la persona vio.
            const releida = await versionQueCobra()
            const priceIdReleido = releida ? precioDeLaOferta(releida.definition, input.tier, input.interval).stripePriceId : null
            if (!releida || releida.number !== conComprobante.versionNumber || priceIdReleido !== verificado.priceId) {
              logger.warn('activate-plan: otra versión de la oferta quedó vigente al momento de cobrar — NO se cobra', {
                organizationId,
                origen: 'VERSION',
                comprobante: conComprobante.versionNumber,
                vigenteNumber: releida?.number ?? null,
                verificado: verificado.priceId,
                vigente: priceIdReleido,
              })
              throw ofertaCambio('VERSION', releida?.number ?? 1)
            }
          }
          const vigente = conComprobante
            ? null
            : origenDeLaRelectura === 'VERSION'
              ? { priceId: await priceIdVigente(input.tier, input.interval), unitAmount: null }
              : origenDeLaRelectura === 'LLAVE'
                ? await resolverPrecioPorLlave(tierCode, input.interval)
                : null
          if (vigente && vigente.priceId !== verificado.priceId) {
            // 🚨 a propósito: el precio del plan cambió a media alta.
            logger.error('🚨 activate-plan: la versión vigente cambió al momento de cobrar — NO se cobra', {
              organizationId,
              origen: origenDeLaRelectura,
              ...(origenDeLaRelectura === 'LLAVE' ? { lookupKey: planLookupKey(tierCode, input.interval) } : {}),
              verificado: verificado.priceId,
              vigente: vigente.priceId,
            })
            throw new ConflictError('El precio del plan cambió. Vuelve a cargar la página.', 'PLAN_PRICE_MISMATCH', {
              esperado: verificado.unitAmount,
              stripe: vigente.unitAmount,
            })
          }
          return createPlanSubscription({
            // «Pudo cobrarse» empieza justo antes del POST, no al entrar aquí (Codex C15).
            antesDeCobrar: () => {
              intentoCobrar = true
            },
            venueId: venue.id,
            customerId,
            paymentMethodId: input.paymentMethodId,
            // B2 Task 6: la prueba sin tarjeta, sin método de pago y con el fin de su comprobante (metadata `sinTarjeta: 'true'`).
            ...(sinTarjetaPedido ? { sinTarjeta: true } : {}),
            tierCode,
            interval: input.interval,
            priceId: verificado.priceId,
            // Con campaña SIEMPRE se paga el primer ciclo: la oferta no tiene prueba gratis.
            // 🔴 B2: con comprobante, la prueba termina cuando dice el comprobante (`trial_end`), nunca 30 días desde ahora.
            trialPeriodDays: conComprobante || campaign || input.payNow ? 0 : TRIAL_DAYS,
            ...(conComprobante?.trialEndsAt ? { trialEnd: conComprobante.trialEndsAt } : {}),
            coupon: cuponEsperado ?? undefined,
            // B2 (b2-r9 #1): con comprobante los descuentos van explícitos (aquí ninguno). 🔴 Ojo: según el SDK instalado
            // (stripe 19, `SubscriptionsResource.d.ts`), un `discounts` vacío SÍ hereda el descuento del cliente. La protección
            // real es el cierre del reto del banco (`primerCobroPagado.ts`): sólo acepta un total menor por los descuentos que la
            // propia factura declara (y un descuento sólo baja el precio).
            ...(conComprobante ? { descuentosExplicitos: true as const } : {}),
            idempotencyKey: planActivationKey,
            // Plan Básico: la prueba termina sola sin cobrar. Sólo en ESTE create; un reuso devuelve la suscripción tal cual.
            ...(input.basicPlan ? { cancelAtTrialEnd: true } : {}),
            // 🔴 El rastro del cobro se guarda en el instante siguiente al cargo, no al final: entre
            // crear en Stripe y que esta función devuelva hay escrituras que pueden fallar, y sin el
            // id el reintento tiene que BUSCARLA — que es donde nacía el segundo cobro.
            alCrearEnStripe: async (subId: string) => {
              await prisma.onboardingProgress.updateMany({
                where: { organizationId, completedAt: null },
                data: { planStripeSubscriptionId: subId },
              })
            },
            paymentBehavior: 'error_if_incomplete',
            // 🔴 D2: si el banco pide autenticar el primer cobro, se crea `default_incomplete` y vuelve el secreto del
            // reto. `expected` es el de `cotizar` (lo que el cliente vio y consintió): contra él se exige la factura pagada.
            autenticarEnElNavegador: { primerCobroEsperadoCents: expected, terminarAntesDe },
            extraMetadata: {
              organizationId,
              planActivationKey,
              // B2: la versión del comprobante y la versión cuyo precio se cobra (hoy la misma).
              ...(conComprobante
                ? {
                    planOfferVersion: String(conComprobante.versionNumber),
                    planOfferPrecioDe: String(conComprobante.versionNumber),
                  }
                : {}),
              ...(campaign
                ? {
                    launchCampaignId: campaign.id,
                    launchCampaignCode: campaign.code,
                    launchOfferVersion: String(campaign.offerVersion),
                    launchRedemptionId: redemption?.id ?? '',
                  }
                : {}),
            },
            venueName: venueRecord?.name,
            venueSlug: venueRecord?.slug,
          })
        },
        { desdeElAlta: true },
      )
      subscriptionId = r.subscriptionId
      reused = r.reused
      conAutenticacion = r.conAutenticacion === true
      secretoDelReto = r.requiereAutenticacion?.clientSecret

      // Red de seguridad: el gancho `alCrearEnStripe` ya lo guardó en el instante del cargo.
      // Esto cubre el camino en que la suscripción se REUSÓ (no se creó ahora), donde el gancho
      // no corre.
      await prisma.onboardingProgress
        .updateMany({ where: { organizationId, completedAt: null }, data: { planStripeSubscriptionId: r.subscriptionId } })
        .catch(error => {
          // No puede tumbar un cobro que ya ocurrió: se avisa y queda el respaldo por búsqueda.
          logger.error('🚨 activate-plan: no se pudo registrar el id de la suscripción recién creada', {
            organizationId,
            subscriptionId: r.subscriptionId,
            error: error instanceof Error ? error.message : String(error),
          })
        })
    } catch (error) {
      if (!intentoCobrar) {
        // La regla lo rechazó ANTES de cobrar (un plan vivo, otra compra en curso, Stripe sin verificar): no hubo cargo,
        // así que el lease y el lugar vuelven a como estaban, y su mensaje explica qué pasa.
        // 🔴 Codex #14: el estado y el lugar se cierran JUNTOS, y sólo si el intento sigue siendo nuestro.
        await cerrarIntentoYLiberarLugar({
          organizationId,
          attempt,
          lease: nuestroLease,
          estadoFinal: prev.status,
          lugar:
            redemption && campaign
              ? { redemptionId: redemption.id, campaignId: campaign.id, motivo: 'PLAN_PURCHASE_NOT_AUTHORIZED' }
              : null,
        })
        throw error
      }
      if (esErrorDeTarjeta(error)) {
        // ---- PASO 10: rechazo del banco ----
        // 🔴 Marcar el rechazo y liberar el lugar van JUNTOS (Codex R4): si el intento ya no es de esta petición —otra
        // recuperó el lease y está cobrando con ese mismo lugar—, liberarlo le quitaría el cupo a un cobro vivo.
        await cerrarIntentoYLiberarLugar({
          organizationId,
          attempt,
          lease: nuestroLease,
          estadoFinal: PLAN_ACTIVATION_STATUS.DECLINED,
          lugar: redemption && campaign ? { redemptionId: redemption.id, campaignId: campaign.id, motivo: 'PLAN_PAYMENT_DECLINED' } : null,
        })
        const e = error as unknown as { message?: string; decline_code?: string; code?: string }
        throw rechazado(e.message || 'Tu banco rechazó la tarjeta', e.decline_code ?? e.code)
      }
      // ---- PASO 11: resultado desconocido ----
      // 🔴 NO se toca nada: el lease vence solo y el lugar sigue RESERVED. Liberarlo aquí
      // dejaría un cobro que quizá SÍ ocurrió sin su lugar contado.
      logger.warn('activate-plan: resultado desconocido al cobrar', {
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      })
      throw pendiente('Stripe no contestó')
    }

    if (secretoDelReto) {
      // 🔴 D2: el banco pide autorizar el primer cobro. Nada se cobró todavía: sin entrega ni cierre, y el lugar sigue
      // RESERVED (el cliente sigue comprando). El id ya quedó guardado (gancho + red de seguridad de arriba). Se suelta el
      // lease SIN salir de IN_PROGRESS y con la marca del dueño (R4): el pedido de después del reto entra por el PASO 6.
      await soltarLease(organizationId, PLAN_ACTIVATION_STATUS.IN_PROGRESS, attempt, nuestroLease)
      logger.info('activate-plan: el banco pide autorizar el primer cobro', { organizationId, subscriptionId })
      throw requiereAutenticacion(secretoDelReto)
    }
  }

  // 🔴 Una suscripción que NO creamos nosotros en esta pasada —da igual si vino del reuso o de la
  // RECUPERACIÓN de un intento anterior— tiene que llevar el cupón de la oferta para cerrarse como
  // tal. Comprobarlo sólo con `reused` dejaba fuera el camino de recuperación, donde `reused`
  // queda en `false`: el resultado medido por Codex (20-sep) era una campaña `APPLIED` con **$0
  // pagados y renovación anunciada a $22**, mientras en Stripe esa suscripción no tenía descuento.
  const noLaCreamosConElCupon = reused || suscripcionRecuperada != null
  // 🔴 Qué cupón se le EXIGE a una suscripción que no creamos ahora. El de la CAMPAÑA, siempre: la campaña se reclama
  // en el alta, no en esta petición, así que es la misma del cobro original. El de la promo legacy SÓLO al reusar:
  // en una RECUPERACIÓN sin campaña manda lo que SE COBRÓ, no lo que pide el reintento — al recargar, la pantalla vuelve
  // con Pro y «Pagar hoy» aunque lo cobrado fuera Premium, y exigirle INTRO_PRO_3M cerraba el alta con
  // PLAN_ACTIVE_WITHOUT_OFFER SIN conceder nada: cobrado y sin acceso (lo vivió el founder, 26-sep).
  const cuponExigible = campaign ? cuponEsperado : suscripcionRecuperada ? null : cuponEsperado
  // 🔴 Una suscripción RECUPERADA sin el cupón de la campaña es un cobro de un intento ANTERIOR que nunca se entregó
  // (p. ej. «Ver otros planes» → Premium, falla la entrega, vuelve y toca la oferta). Cerrar el intento y contestar 409
  // lo dejaba cobrado y sin acceso, con «no te cobramos nada» en pantalla. Ahora se entrega LO COBRADO, se libera el
  // lugar de la oferta en el mismo cierre, y sólo entonces se le dice que la oferta no aplicó.
  let ofertaNoAplicada = false
  if (noLaCreamosConElCupon && cuponExigible) {
    const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['discounts'] })
    const descuentos = (sub as unknown as { discounts?: unknown[] }).discounts ?? []
    // 🔴 El cupón vive en `source.coupon` con la API actual; leer `d.coupon` lo daba por ausente SIEMPRE (26-sep).
    const lleva = descuentos.some(d => idDelCuponDelDescuento(d) === cuponExigible)
    if (!lleva && campaign && suscripcionRecuperada && !reused) {
      logger.error('🚨 activate-plan: se recuperó un cobro anterior SIN el cupón de la oferta — se entrega lo cobrado', {
        organizationId,
        subscriptionId,
      })
      ofertaNoAplicada = true
    } else if (!lleva) {
      logger.error('🚨 activate-plan: se reusó una suscripción sin el cupón de la oferta', { organizationId, subscriptionId })
      await cerrarIntentoYLiberarLugar({
        organizationId,
        attempt,
        lease: nuestroLease,
        estadoFinal: prev.status,
        lugar: redemption && campaign ? { redemptionId: redemption.id, campaignId: campaign.id, motivo: 'REUSED_WITHOUT_COUPON' } : null,
      })
      throw new ConflictError(
        'Este negocio ya tiene un plan activo sin esta oferta, así que no se puede aplicar encima.',
        'PLAN_ACTIVE_WITHOUT_OFFER',
      )
    }
  }

  // 🔴 D2 (Codex r1 #2 y r2 #1, spec §6.4 b): el estado no prueba el pago prometido (el #2 puede quedar `active` con una
  // factura de $0). Si el cobro salió del camino de autenticación —el #2 de ESTA pasada, o una recuperada que trae su
  // marca—, la PRIMERA factura tiene que estar pagada por lo consentido ANTES de entregar, y por tanto antes de APPLIED.
  // El cobro clásico (a la primera o recuperado sin la marca) y la prueba de 30 días quedan como estaban (Ruling 1).
  const marcaDelReto = suscripcionRecuperada?.metadata?.primerCobroEsperadoCents
  const esperadoDelPrimerCobro = conAutenticacion ? expected : marcaDelReto != null ? Number(marcaDelReto) : null
  if (esperadoDelPrimerCobro !== null) await exigirPrimerCobroPagado(venue.id, subscriptionId, esperadoDelPrimerCobro)

  // ---- El ACCESO: lo escribe la entrega (V5-A paso 6) ----
  // Ve las dos filas de plan bajo el candado del negocio y deriva el tier del PRECIO. Si falla, el cargo ya ocurrió: el
  // lease queda vivo y el siguiente intento recupera ESTA suscripción por su id y vuelve a entregar.
  let concedido: Awaited<ReturnType<typeof entregarSuscripcionDePlan>>
  try {
    concedido = await entregarSuscripcionDePlan({ venueId: venue.id, subscriptionId, detectedBy: 'onboarding.activatePlan' })
  } catch (error) {
    logger.error('🚨 activate-plan: cobrado, pero la entrega del acceso falló — se reintentará', {
      organizationId,
      subscriptionId,
      error: error instanceof Error ? error.message : String(error),
    })
    throw pendiente('no se pudo registrar el acceso')
  }

  // ---- PASO 9: éxito ----
  const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['latest_invoice'] })
  // 🔴 D2 (spec §6.4 a): sólo se cierra lo que Stripe ya cobra. Una suscripción REUSADA en `incomplete` llegaba hasta aquí y
  // se cerraba ACTIVE, con el lugar APPLIED y el tier puesto, con $0 cobrados. 503: lease vivo y lugar RESERVED.
  if (!SUSCRIPCION_COBRADA.includes(sub.status as (typeof SUSCRIPCION_COBRADA)[number])) {
    throw pendiente(`la suscripción está en ${sub.status}, todavía sin cobrar`)
  }
  const nextChargeAt = siguienteCobro(sub)
  // 🔴 Plan Básico: lo que se guarda, responde y manda por correo describe la modalidad REAL, no la pedida.
  const modalidad = modalidadDePrueba(sub)
  const terminaSinCobro = modalidad.trialModality === 'ENDS_FREE'

  // 🔴 Vigente y SIN conceder = la entrega la dejó en conflicto (otro plan vivo la ocupa). Cerrar el alta como ACTIVE
  // diría «tienes tu plan» sin que lo tenga; el conflicto quedó registrado para revisarse.
  if (!concedido && (sub.status === 'active' || sub.status === 'trialing')) {
    logger.error('🚨 activate-plan: la suscripción cobrada quedó en conflicto y no se concedió — el alta NO se cierra', {
      organizationId,
      subscriptionId,
    })
    throw pendiente('la suscripción cobrada quedó en conflicto con otro plan')
  }
  // El tier del negocio es el CONCEDIDO (sale del precio cobrado), no el que pide este intento.
  // 🔴 Codex R13: y si la entrega no concedió, se deriva de lo que la suscripción VENDE — nunca de `input.tier`. El
  // guard de arriba sólo detiene `active`/`trialing`: una recuperada en `past_due` pasaba y el alta se cerraba
  // anunciando el plan del formulario sobre un cobro de otro. Si no se puede determinar, no se cierra.
  const tierDeLoCobrado = concedido
    ? concedido.featureCode === 'PLAN_PREMIUM'
      ? ('PREMIUM' as const)
      : ('PRO' as const)
    : await tierQueVendeLaSuscripcion(sub)
  if (!tierDeLoCobrado) throw pendiente('no se pudo determinar qué plan se cobró')
  const tierConcedido = tierDeLoCobrado
  // …y el intervalo el de la suscripción COBRADA (Codex C12): recuperar Premium anual cuando el reintento pide Pro mensual
  // guardaba, respondía y mandaba por correo «Pro mensual», y la idempotencia de después comparaba contra ese dato falso.
  const periodo = (sub.items?.data?.[0]?.price as { recurring?: { interval?: string } } | undefined)?.recurring?.interval
  const intervalCobrado: 'monthly' | 'annual' = periodo === 'year' ? 'annual' : periodo === 'month' ? 'monthly' : input.interval
  // 🔴 Codex R13: `payNow` también sale de lo COBRADO cuando las condiciones no son las de este formulario (una
  // suscripción reusada o recuperada). Recuperar un pago YA hecho con `payNow:false` lo guardaba y lo anunciaba como
  // prueba gratis. En el camino normal manda el formulario, que es lo que de verdad se pidió.
  const yaCobrada = ((sub.latest_invoice as { amount_paid?: number } | null)?.amount_paid ?? 0) > 0
  // 🔴 B2 Task 5 (b2-r7 #6, carry 2): la suscripción que recuperó una recuperación diferida (versión del editor, o la oferta
  // ilegible) cierra con SU modalidad: pagó o no, sin tarjeta o con cuál, de qué versión y a qué precio. Nunca la del cuerpo
  // ni la del comprobante: un reenvío que pide otra cosa (u otra versión) no cambia lo que Stripe ya cobró.
  // B2 Task 6: también una suscripción REUSADA al pedir la prueba sin tarjeta: no es la que se pidió, así que cierra con lo suyo.
  // 🔴 Codex b2-code r2 N2: y una recuperada que es de una versión del editor (su metadata `planOfferVersion`, que sólo ponen las
  // compras con comprobante), sea cual sea el tipo del cuerpo: un reenvío de CAMPAÑA que recupera una compra estándar de la v2 cierra
  // con la tarjeta, la versión y el pagar-hoy de esa suscripción. Sin esa metadata (B1), la del cuerpo, como hoy.
  const recuperadaDelEditor = Boolean(suscripcionRecuperada?.metadata?.planOfferVersion)
  const recuperada =
    (recuperacionDiferida && suscripcionRecuperada) || recuperadaDelEditor || (sinTarjetaPedido && reused) ? modalidadCobrada(sub) : null
  /** B2 Task 6: un intento NUEVO de prueba sin tarjeta (la recuperada cierra con su propia modalidad, b2-r7 #6). */
  const sinTarjetaNuevo = recuperada === null && sinTarjetaPedido
  const payNowCobrado = recuperada ? recuperada.pagada : noLaCreamosConElCupon ? yaCobrada : campaign ? true : input.payNow
  // Su tarjeta. Sin tarjeta (su metadata) no hay ninguna; una suscripción con tarjeta que ya no trae su método conserva la del
  // formulario, que el PASO 4 comprobó que es de este cliente (sin ninguna, «Terminar alta» se atoraría).
  const tarjetaGuardada = recuperada
    ? (recuperada.paymentMethodId ?? (recuperada.sinTarjeta ? null : input.paymentMethodId || null))
    : sinTarjetaNuevo
      ? null
      : input.paymentMethodId
  const cobrado = {
    ...input,
    tier: tierConcedido,
    interval: intervalCobrado,
    ...(recuperada ? { payNow: payNowCobrado, paymentMethodId: tarjetaGuardada ?? '' } : {}),
  }

  await prisma.$transaction(async tx => {
    const planGuardado = {
      tier: cobrado.tier,
      paymentMethodId: tarjetaGuardada,
      interval: cobrado.interval,
      payNow: payNowCobrado,
      acceptedAt: now.toISOString(),
      // B2 Task 6 (Ruling T3-1): el plan raíz dice `sinTarjeta`, que leen `parseV2Plan` y «Terminar alta».
      ...(recuperada ? { sinTarjeta: recuperada.sinTarjeta } : sinTarjetaNuevo ? { sinTarjeta: true as const } : {}),
      // Lo guardado describe lo COBRADO: si la oferta no aplicó, no queda como alta con oferta.
      // 🔴 B2: el comprobante NUNCA se guarda (lo devolvería `GET progress`): STANDARD se escribe campo por campo.
      offer:
        ofertaNoAplicada || recuperada
          ? ({ kind: 'STANDARD', expectedFirstChargeCents: primerCobroDe(sub, expected) } as const)
          : input.offer.kind === 'STANDARD' || input.offer.kind === 'STANDARD_SIN_TARJETA'
            ? // B2 Task 6: lo guardado conserva el `kind` de hoy; la prueba sin tarjeta la dice `sinTarjeta`.
              ({ kind: 'STANDARD', expectedFirstChargeCents: input.offer.expectedFirstChargeCents } as const)
            : input.offer,
      // La versión: la de la suscripción recuperada (su metadata) o, en un intento nuevo, la del comprobante con que se cobró.
      ...(recuperada
        ? recuperada.offerVersion !== null
          ? { offerVersion: recuperada.offerVersion }
          : {}
        : conComprobante
          ? { offerVersion: conComprobante.versionNumber }
          : {}),
      ...(terminaSinCobro ? { basicPlan: true as const } : {}),
    }
    const cerrado = await tx.onboardingProgress.updateMany({
      where: {
        organizationId,
        planActivationStatus: PLAN_ACTIVATION_STATUS.IN_PROGRESS,
        planActivationAttempt: attempt,
        planActivationLeaseUntil: nuestroLease,
      },
      data: {
        planActivationStatus: PLAN_ACTIVATION_STATUS.ACTIVE,
        planActivatedAt: now,
        planActivationLeaseUntil: null,
        planStripeSubscriptionId: subscriptionId,
      },
    })

    // 🔴 Cada cierre tiene que TOCAR su fila (Codex C6): si el intento ya no es de esta petición o el lugar de la oferta
    // ya no estaba apartado, no se da por aplicada el alta — el cargo quedó registrado y el siguiente intento lo recupera.
    if (cerrado.count === 0) throw pendiente('el intento ya no era de esta petición al cerrarlo')
    // 🔴 `plan` va en la RAÍZ, que es lo primero que busca `parseV2Plan`. Se agrega SÓLO esa sección, ya con el candado
    // ganado y en la misma transacción: reescribir el formulario leído antes borraba un paso que otra pestaña guardó en
    // medio (y al revés, esa pestaña borraba el plan cobrado; 20-oct).
    await fusionarV2SetupData(tx, organizationId, { plan: planGuardado })
    if (redemption && campaign && ofertaNoAplicada) {
      // El cierre de arriba acreditó que el intento es nuestro: el lugar se libera en la MISMA transacción (Codex #14).
      await liberarLugarEn(tx, redemption.id, campaign.id, 'RECOVERED_WITHOUT_COUPON')
    } else if (redemption && campaign) {
      const aplicada = await tx.launchCampaignRedemption.updateMany({
        where: { id: redemption.id, status: REDEMPTION_STATUS.RESERVED },
        data: { status: REDEMPTION_STATUS.APPLIED, appliedAt: now, stripeSubscriptionId: subscriptionId, cardFingerprint: fingerprint },
      })
      if (aplicada.count === 0) throw pendiente('el lugar de la oferta ya no estaba apartado al cerrar')
    }

    // 🔴 El local queda con su tier, NUNCA en TRIAL: TRIAL se escapa de todo candado de plan y
    // de KYC (`basePlan.service.ts`, `kyc-utils.ts`).
    await tx.venue.update({ where: { id: venue.id }, data: { planTier: tierConcedido } })
  })

  const firstChargeCents = primerCobroDe(sub, expected)
  // Planes editables (B2, §10.5): con una versión del editor los correos dicen el precio de la SUSCRIPCIÓN (lo que Stripe va a
  // cobrar), nunca una constante. Sin versión, las constantes de hoy.
  // 🔴 B2 Task 5 (carry 2): una suscripción recuperada lo decide por SÍ misma: cobrada con una versión (su metadata), su precio;
  // sin versión (un cobro de antes del editor), las constantes de hoy, como B0. Nunca el comprobante de la petición.
  const montoDelPlanCents = recuperada
    ? recuperada.offerVersion !== null
      ? (recuperada.precioCents ?? undefined)
      : undefined
    : estandar
      ? ((sub.items?.data?.[0]?.price as { unit_amount?: number | null } | undefined)?.unit_amount ?? listPriceCents)
      : undefined
  // B2 Task 5 (b2-r7 #6): la confirmación de pago sale si pagó o tiene tarjeta. Una prueba SIN tarjeta que no ha pagado no
  // recibe una confirmación de cobro: recibe su bienvenida sin tarjeta (Task 6), igual si se abrió ahora o se recuperó.
  const pruebaSinTarjeta =
    recuperada !== null ? recuperada.sinTarjeta && !recuperada.pagada && !recuperada.paymentMethodId : sinTarjetaNuevo
  // B2 Task 6 (§18, b2-r8 #9): la tarjeta que Stripe cobraría al terminar y si habrá cobro, leídos AHORA; sólo para decirlo
  // (respuesta, pantalla final y bienvenida): nada lo compara con lo que enseñó la ventana. 🔴 Es informativa: la lectura arranca
  // aquí SIN esperarla, así que ni lenta ni fallida retrasa o frena el cierre del alta (`terminarElAlta`, abajo). Nunca rechaza
  // (`avisoDeLaPruebaSinTarjeta` se degrada a «no se sabe qué tarjeta»); la esperan sólo la bienvenida y la respuesta.
  // 🔴 Fix round 2: el manejador del rechazo se pone AL CREAR la promesa (no al final, tras otras esperas): un rechazo sin manejar
  // apaga el servidor (`unhandledRejection`, server.ts). Rechazada, es «no se sabe qué tarjeta», igual que si fallara la lectura.
  const avisoSinTarjeta = modalidad.sinTarjeta
    ? avisoDeLaPruebaSinTarjeta(sub, customerId).catch(error => {
        logger.warn('activate-plan: no se pudo leer la tarjeta de la prueba sin tarjeta; se omite', {
          organizationId,
          subscriptionId,
          error: error instanceof Error ? error.message : String(error),
        })
        return null
      })
    : null

  if (ofertaNoAplicada) {
    await logAction({
      staffId,
      organizationId,
      action: 'PLAN_ACTIVATED_ONBOARDING',
      entity: 'OnboardingProgress',
      entityId: progress.id,
      data: { tier: cobrado.tier, interval: cobrado.interval, subscriptionId, offerNotApplied: true, reason: 'RECOVERED_WITHOUT_COUPON' },
    })
    // Sin correo de la oferta: prometería un precio que no se cobró. El plan quedó activo; la pantalla lo dice.
    // Pero sí el aviso al equipo (sin oferta) y la bienvenida genérica, sin precios: el alta corta ya no la manda al
    // crear el negocio, y este cliente PAGÓ (Codex r1, 27-oct).
    avisarActivacion({
      venueId: venue.id,
      venueName: venueRecord?.name ?? null,
      organizationId,
      tier: cobrado.tier,
      interval: cobrado.interval,
      payNow: payNowCobrado,
      firstChargeCents,
      nextChargeAt,
      campaign: null,
      terminaSinCobro,
    })
    void resolvePlanNotificationTarget(venue.id)
      .then(target =>
        target.email
          ? resendService.sendOnboardingWelcomeEmail({
              ownerEmail: target.email,
              ownerFirstName: target.ownerName ?? '',
              venueName: venueRecord?.name ?? target.venueName,
              venueSlug: venueRecord?.slug ?? venue.slug,
              hasKycDocuments: false,
            })
          : false,
      )
      .catch(error =>
        logger.warn('activate-plan: no se pudo mandar la bienvenida', {
          organizationId,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
    throw new ConflictError(
      'Ya tienes activo el plan que pagaste en un intento anterior, así que la oferta no se puede aplicar encima. No te cobramos otra vez.',
      'PLAN_ACTIVE_WITHOUT_OFFER',
      { currentTier: cobrado.tier, currentInterval: cobrado.interval, charged: yaCobrada },
    )
  }

  await logAction({
    staffId,
    organizationId,
    action: campaign ? 'LAUNCH_CAMPAIGN_REDEEMED' : 'PLAN_ACTIVATED_ONBOARDING',
    entity: 'OnboardingProgress',
    entityId: progress.id,
    data: {
      tier: cobrado.tier,
      interval: cobrado.interval,
      firstChargeCents,
      subscriptionId,
      ...(modalidad.trialModality ? { trialModality: modalidad.trialModality } : {}),
      ...(pruebaSinTarjeta ? { sinTarjeta: true } : {}),
      ...(campaign ? { code: campaign.code, offerVersion: campaign.offerVersion, redemptionId: redemption?.id ?? null } : {}),
    },
  })

  // El correo no bloquea la respuesta: el dinero ya se movió.
  if (pruebaSinTarjeta) {
    // B2 Task 6 (§18, b2-r8): en vez de la confirmación de pago, la bienvenida a la prueba sin tarjeta. El monto es el precio de
    // la versión (el del comprobante, en un intento nuevo; el de su suscripción, al recuperarla), con la nota del saldo.
    const bienvenida = {
      venueId: venue.id,
      venueSlug: venueRecord?.slug ?? venue.slug,
      subscriptionId,
      tier: cobrado.tier,
      language: input.language,
      timeZone: venueRecord?.timezone,
      trialEnd: typeof sub.trial_end === 'number' ? new Date(sub.trial_end * 1000) : new Date(nextChargeAt),
      montoAlTerminarCents: conComprobante && !recuperada ? conComprobante.precioCents : montoDelPlanCents,
    }
    void Promise.resolve(avisoSinTarjeta)
      // Codex b2-code #6: también si habrá cobro (una cancelación programada: el correo no anuncia ni la tarjeta ni el monto).
      .then(aviso => enviarBienvenidaSinTarjeta({ ...bienvenida, tarjeta: aviso?.tarjetaQueCobrara, noHabraCobro: aviso?.noHabraCobro }))
      .catch(error =>
        logger.warn('activate-plan: no se pudo enviar la bienvenida de la prueba sin tarjeta', {
          organizationId,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
  } else {
    void enviarConfirmacion({
      venueId: venue.id,
      venueSlug: venueRecord?.slug ?? venue.slug,
      campaign,
      input: cobrado,
      expected,
      nextChargeAt,
      timeZone: venueRecord?.timezone,
      terminaSinCobro,
      ...(montoDelPlanCents !== undefined ? { montoDelPlanCents } : {}),
    }).catch(error =>
      logger.warn('activate-plan: no se pudo enviar el correo de confirmación', {
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  }
  // Y al equipo: el aviso de «empezó el alta» sale antes del plan; éste dice quién SÍ terminó.
  avisarActivacion({
    venueId: venue.id,
    venueName: venueRecord?.name ?? null,
    organizationId,
    tier: cobrado.tier,
    interval: cobrado.interval,
    payNow: payNowCobrado,
    firstChargeCents,
    nextChargeAt,
    campaign,
    terminaSinCobro,
    ...(montoDelPlanCents !== undefined ? { montoDelPlanCents } : {}),
    ...(pruebaSinTarjeta ? { sinTarjeta: true } : {}),
  })

  await terminarElAlta()
  return {
    status: 'ACTIVE',
    alreadyActive: false,
    tier: cobrado.tier,
    interval: cobrado.interval,
    firstChargeCents,
    nextChargeAt,
    ...modalidad,
    // La lectura de la tarjeta corrió junto con el cierre; con su tope (5 s) la respuesta sólo la espera lo que le falte.
    ...((avisoSinTarjeta ? await avisoSinTarjeta : null) ?? {}),
    ...(campaign
      ? {
          launchOffer: {
            code: campaign.code,
            offerVersion: campaign.offerVersion,
            months: campaign.discountMonths,
            renewalMonthlyCents: campaign.discountMonths > 1 ? campaign.advertisedPriceCents : (campaign.listPriceCentsSnapshot as number),
          },
        }
      : {}),
  }
}

/**
 * 🔴 R1 y R2 (promesa docs/audit/2026-10-18-campana-3ds-r1r2/promesa.md): el alta que se quedó «esperando al banco» sin nadie
 * en la pantalla (lease suelto o vencido). La llama el barrido `altas-a-medio-pago` y decide con lo que dice Stripe AHORA:
 *
 * - `incomplete_expired` (R1: nadie autorizó y Stripe la dio por muerta a las ~23 h) ⇒ el alta pasa a DECLINED y el lugar
 *   que nombra la metadata de ESA suscripción vuelve a la campaña, en UNA transacción y sólo si el CAS toca la fila. Antes:
 *   el lugar quedaba apartado para siempre y la campaña podía verse agotada.
 * - cobrada y con la marca del reto (R2: autorizó y cerró la pestaña) ⇒ `activatePlan` con `soloRecuperar`: el mismo cierre
 *   que si hubiera vuelto (evidencia del primer cobro, entrega, ACTIVE, APPLIED, correo). Antes: cobrado sin acceso hasta
 *   que volviera, y el mes 2 se cobraba igual.
 * - cualquier otra cosa (esperando al banco, cancelada, cobro clásico sin la marca, suscripción de otro intento) ⇒ nada.
 *
 * 🔴 B2 Task 5 (b2-r1 #1, b2-r2 #1), sólo para un intento de una versión del editor (`planOfferVersionNumber ≥ 2`; sin ella, lo
 * de arriba literal):
 * - sin id guardado (la respuesta del `create` se perdió), se busca su suscripción por la llave del intento entre los clientes
 *   de sus negocios y su id se registra con un CAS (sólo si el alta sigue en ese intento y sin id); no encontrada ⇒ nada;
 * - cobrada o en prueba se cierra también SIN la marca del reto (un Pro de 0 días cobrado en el PRIMER `create`): `payNow` es
 *   la marca o lo que cobró su primera factura, y la tarjeta la suya, o ninguna si su metadata dice `sinTarjeta`.
 *
 * 🔴 Nunca cobra, nunca anula ni crea nada en Stripe. Cada escritura es un CAS: si el cliente vuelve a la vez, gana uno.
 */
export async function cerrarAltaSinNavegador(
  organizationId: string,
  via: ViaDelCierre = 'barrido',
): Promise<'CERRADA' | 'LIBERADA' | 'NADA'> {
  const p = await prisma.onboardingProgress.findUnique({ where: { organizationId } })
  const leaseVivo = p?.planActivationLeaseUntil != null && p.planActivationLeaseUntil > new Date()
  if (!p || p.completedAt || p.planActivationStatus !== PLAN_ACTIVATION_STATUS.IN_PROGRESS || leaseVivo) return 'NADA'
  const conVersion = (p.planOfferVersionNumber ?? 0) >= 2
  const llave = `plan-activation:${organizationId}:${p.planActivationAttempt}`

  let subscriptionId = p.planStripeSubscriptionId
  if (!subscriptionId) {
    if (!conVersion) return 'NADA'
    const encontrada = await suscripcionDelIntentoEnSusNegocios(organizationId, llave)
    if (!encontrada) return 'NADA'
    if (!(await registrarSuscripcionDelIntento(organizationId, p.planActivationAttempt, encontrada.id))) return 'NADA'
    logger.info('altas-a-medio-pago: se encontró por su llave la suscripción del intento y se registró su id', {
      organizationId,
      subscriptionId: encontrada.id,
    })
    subscriptionId = encontrada.id
  }

  // Con versión se lee su primera factura (lo que cobró: el cierre sin la marca la necesita); sin versión, la lectura de hoy.
  const sub = conVersion
    ? await stripe.subscriptions.retrieve(subscriptionId, { expand: ['latest_invoice'] })
    : await stripe.subscriptions.retrieve(subscriptionId)
  // Sólo la suscripción de ESTE intento: la de uno anterior (o la del carril viejo, con otra llave) no es de este revisor.
  if (sub.metadata?.planActivationKey !== llave) return 'NADA'

  if (sub.status === 'incomplete_expired') {
    const lugar = lugarDeLaMetadata(sub)
    const declinada = await prisma.$transaction(async tx => {
      const { count } = await tx.onboardingProgress.updateMany({
        where: {
          organizationId,
          completedAt: null,
          planActivationStatus: PLAN_ACTIVATION_STATUS.IN_PROGRESS,
          planActivationAttempt: p.planActivationAttempt,
          planActivationLeaseUntil: p.planActivationLeaseUntil,
          planStripeSubscriptionId: sub.id,
        },
        data: { planActivationStatus: PLAN_ACTIVATION_STATUS.DECLINED, planActivationLeaseUntil: null },
      })
      if (count === 0) return false
      if (lugar) await liberarLugarEn(tx, lugar.redemptionId, lugar.campaignId, 'PLAN_ATTEMPT_ABANDONED')
      return true
    })
    if (!declinada) return 'NADA'
    logger.info('altas-a-medio-pago: el cobro expiró sin autorizarse — el alta queda DECLINED y su lugar vuelve a la campaña', {
      organizationId,
      subscriptionId: sub.id,
      redemptionId: lugar?.redemptionId ?? null,
    })
    return 'LIBERADA'
  }

  // 🔴 B2 Task 6 (b2-r3 #3): la prueba SIN tarjeta que Stripe canceló al terminar sin tarjeta y sin cobrar: el alta se cierra en
  // Gratis (antes quedaba esperando un cobro que nunca llegaría). Sólo con versión del editor; lee Stripe sólo si es `canceled`
  // con su metadata.
  if (conVersion && sub.status === 'canceled' && (await pruebaSinTarjetaTerminada(sub))) {
    const enGratis = await cerrarAltaEnGratis(organizationId, p.planActivationAttempt, sub, null, { via })
    return enGratis ? 'CERRADA' : 'NADA'
  }

  const marca = sub.metadata?.primerCobroEsperadoCents
  if (!esCobrada(sub.status)) return 'NADA'
  // Sin versión, sólo lo que trae la marca del reto (R2), como hoy. Con versión, también un cobro clásico o una prueba.
  if (marca == null && !conVersion) return 'NADA'

  // 🔴 Codex r1 #1: sin tarjeta en la suscripción no se cierra aquí. El plan se guardaría sin tarjeta y «Terminar alta» lo
  // rechaza (`completeV2Onboarding` la exige); queda el camino de hoy: el cliente vuelve con otra tarjeta y la recuperación
  // del navegador entrega lo ya pagado sin cobrar otra vez. Una persona lo ve por el 🚨. B2: salvo una prueba SIN tarjeta (su
  // metadata), que nunca la tuvo y no la necesita.
  // 🔴 Codex b2-code #4: y, con versión del editor, salvo lo que Stripe YA cobró (`esCobrada`, arriba): una vez cobrado la tarjeta
  // ya no importa, y negarse dejaba el pago sin alta en el aviso, el barrido y «Confirmar mi pago». Cierra con
  // `paymentMethodId: null` en el plan guardado (el cierre lo hace la entrega; sin la marca de la organización, el barrido lo
  // repara). Sin versión del editor, lo de hoy.
  const sinTarjeta = conVersion && sub.metadata?.sinTarjeta === 'true'
  const paymentMethodId = idDe(sub.default_payment_method)
  if (!paymentMethodId && !sinTarjeta && conVersion) {
    logger.warn('altas-a-medio-pago: el cobro está hecho y la suscripción ya no trae tarjeta — se cierra sin tarjeta guardada', {
      organizationId,
      subscriptionId: sub.id,
    })
  }
  if (!paymentMethodId && !sinTarjeta && !conVersion) {
    logger.error('🚨 altas-a-medio-pago: pagado pero la suscripción ya no trae tarjeta — no se cierra sin el navegador', {
      organizationId,
      subscriptionId: sub.id,
    })
    return 'NADA'
  }
  const duena = await prisma.staffOrganization.findFirst({
    where: { organizationId, role: 'OWNER' },
    select: { staffId: true },
    orderBy: { isPrimary: 'desc' },
  })
  if (!duena) throw new Error('la organización no tiene dueña')

  const m = sub.metadata
  // Lo que cobró su primera factura (sólo se lee con versión; 0 en prueba).
  const pagado = typeof sub.latest_invoice === 'object' ? ((sub.latest_invoice as { amount_paid?: number } | null)?.amount_paid ?? 0) : 0
  const cents = marca != null ? Number(marca) : pagado
  await activatePlan(
    {
      organizationId,
      staffId: duena.staffId,
      tier: m.featureCode === 'PLAN_PREMIUM' ? 'PREMIUM' : 'PRO',
      interval: sub.items?.data?.[0]?.price?.recurring?.interval === 'year' ? 'annual' : 'monthly',
      // La marca sólo la pone el 2.º create, que nunca lleva prueba gratis: se pagó hoy. Sin ella (B2), si cobró algo.
      payNow: marca != null || pagado > 0,
      // Sólo queda como dato (con `soloRecuperar` no se cobra ni se comprueba): la tarjeta pudo retirarse después de pagar.
      paymentMethodId: paymentMethodId ?? '',
      offer: m.launchCampaignId
        ? { kind: 'LAUNCH', code: m.launchCampaignCode ?? '', offerVersion: Number(m.launchOfferVersion), expectedFirstChargeCents: cents }
        : { kind: 'STANDARD', expectedFirstChargeCents: cents },
    },
    { soloRecuperar: sub.id, via },
  )
  // Sin versión del editor, el texto de hoy (paridad con el interruptor apagado); con ella, el cierre también cubre el cobro
  // sin la marca del reto, y lo dice.
  logger.info(
    conVersion
      ? 'altas-a-medio-pago: el cobro del alta estaba hecho y nadie lo cerró — el alta se cerró sin el navegador'
      : 'altas-a-medio-pago: el cliente autorizó y cerró la pestaña — el alta se cerró sin el navegador',
    { organizationId, subscriptionId: sub.id },
  )
  return 'CERRADA'
}

export type RetomaDelPago = { estado: 'RETO'; clientSecret: string } | { estado: 'CERRADA' } | { estado: 'NADA' }

/**
 * 🔴 B2 Task 5 (b2-r9 #2): «Confirmar mi pago» retoma el reto del banco del intento a medio pago, aunque la oferta vigente ya
 * no tenga opciones (un comprobante nuevo sería imposible). Decide la suscripción del intento, nunca la oferta ni un comprobante:
 * - la del id guardado o, si falta y el intento es de una versión del editor, la de su llave (como `cerrarAltaSinNavegador`);
 *   sin intento `IN_PROGRESS`, con el lease vivo, sin suscripción o de otra llave ⇒ `NADA`;
 * - `incomplete` con el pago esperando al banco (`requires_action`/`requires_confirmation`, leído como en
 *   `resolverIntentoIncompleto`) ⇒ `RETO` con el secreto de SU factura: el mismo reto, sin pedir otra tarjeta;
 * - cobrada o en prueba ⇒ `cerrarAltaSinNavegador(…, 'navegador')`: `CERRADA` si cerró, si no `NADA`;
 * - cualquier otro estado ⇒ `NADA` (el aviso «sin confirmar» de hoy).
 *
 * 🔴 Nunca cobra, nunca anula y nunca crea nada en Stripe. El secreto sólo va a la dueña (la ruta), nunca a un log.
 */
export async function retomarPagoDelAlta(organizationId: string): Promise<RetomaDelPago> {
  const nada: RetomaDelPago = { estado: 'NADA' }
  const p = await prisma.onboardingProgress.findUnique({ where: { organizationId } })
  const leaseVivo = p?.planActivationLeaseUntil != null && p.planActivationLeaseUntil > new Date()
  if (!p || p.completedAt || p.planActivationStatus !== PLAN_ACTIVATION_STATUS.IN_PROGRESS || leaseVivo) return nada
  const llave = `plan-activation:${organizationId}:${p.planActivationAttempt}`

  // «No pude ver» nunca se lee como «no hay nada»: un fallo de Stripe es el 503 de «estamos confirmando tu pago».
  const leer = async <T>(lectura: () => Promise<T>): Promise<T> => {
    try {
      return await lectura()
    } catch (error) {
      logger.warn('retomar-pago: no se pudo leer en Stripe el intento a medio pago', {
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      })
      throw pendiente('no se pudo consultar Stripe')
    }
  }

  let subscriptionId = p.planStripeSubscriptionId
  if (!subscriptionId) {
    if ((p.planOfferVersionNumber ?? 0) < 2) return nada
    const encontrada = await leer(() => suscripcionDelIntentoEnSusNegocios(organizationId, llave))
    if (!encontrada) return nada
    subscriptionId = encontrada.id
  }
  const id = subscriptionId
  const sub = await leer(() => stripe.subscriptions.retrieve(id, { expand: ['latest_invoice.confirmation_secret'] }))
  if (sub.metadata?.planActivationKey !== llave) return nada

  if (esCobrada(sub.status)) {
    try {
      return (await cerrarAltaSinNavegador(organizationId, 'navegador')) === 'CERRADA' ? { estado: 'CERRADA' } : nada
    } catch (error) {
      logger.warn('retomar-pago: el pago está hecho pero el alta todavía no se pudo cerrar (la cierra el barrido)', {
        organizationId,
        subscriptionId: sub.id,
        error: error instanceof Error ? error.message : String(error),
      })
      return nada
    }
  }
  if (sub.status !== 'incomplete') return nada

  const factura = typeof sub.latest_invoice === 'object' ? sub.latest_invoice : null
  if (!factura?.id) return nada
  const facturaId = factura.id
  const pi = piDeLosPagos(await leer(() => stripe.invoicePayments.list({ invoice: facturaId, expand: ['data.payment.payment_intent'] })))
  if (pi?.status !== 'requires_action' && pi?.status !== 'requires_confirmation') return nada
  const secreto = factura.confirmation_secret?.client_secret
  if (!secreto) return nada
  logger.info('retomar-pago: el banco sigue esperando la autorización; se retoma el mismo reto', { organizationId, subscriptionId: sub.id })
  return { estado: 'RETO', clientSecret: secreto }
}

/**
 * Aviso al equipo de que un alta TERMINÓ con su plan (el de «empezó el alta» sale antes de la tarjeta). Nunca lanza
 * ni se espera: corre después de que el dinero ya se movió y no puede cambiar el cobro ni la respuesta.
 * El monto es lo que se cobra PRIMERO: en una prueba gratis la factura de hoy vale $0, así que se avisa el precio que
 * se cobrará al terminar la prueba (el mismo que dice el correo del cliente).
 */
function avisarActivacion(a: {
  venueId: string
  venueName: string | null
  organizationId: string
  tier: PaidPlanTier
  interval: PlanBillingInterval
  payNow: boolean
  firstChargeCents: number
  nextChargeAt: string
  campaign: LaunchCampaignRow | null
  /** Plan Básico (`ENDS_FREE`): la prueba termina sin cobrar, así que no hay «primer cobro» que calcular ni anunciar. */
  terminaSinCobro?: boolean
  /** Planes editables (B2): con una versión del editor, el precio de la suscripción. Sin él, las constantes de hoy. */
  montoDelPlanCents?: number
  /** B2 Task 6: la prueba empezó sin tarjeta (el aviso lo dice). */
  sinTarjeta?: boolean
}): void {
  const primerCobro = a.terminaSinCobro
    ? 0
    : a.payNow
      ? a.firstChargeCents
      : a.campaign
        ? (a.campaign.listPriceCentsSnapshot as number)
        : (a.montoDelPlanCents ?? STANDARD_PLAN_GROSS_CENTS[a.tier][a.interval])
  void resolvePlanNotificationTarget(a.venueId)
    .then(target =>
      resendService.sendPlanActivatedNotice({
        venueId: a.venueId,
        venueName: a.venueName ?? target.venueName,
        ownerEmail: target.email,
        planName: a.tier === 'PREMIUM' ? 'Premium' : 'Pro',
        payNow: a.payNow,
        firstChargeCents: primerCobro,
        nextChargeAt: a.nextChargeAt,
        campaignCode: a.campaign?.code ?? null,
        ...(a.terminaSinCobro ? { trialEndsFree: true } : {}),
        ...(a.sinTarjeta ? { sinTarjeta: true } : {}),
      }),
    )
    .catch(error =>
      logger.warn('activate-plan: no se pudo avisar al equipo', {
        organizationId: a.organizationId,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
}

/**
 * El correo de confirmación. 🔴 TODOS sus montos salen del snapshot de la campaña, ninguno está
 * escrito en el código: si la ficha dice 6 meses a $33, el correo dice 6 meses a $33.
 */
async function enviarConfirmacion(args: {
  venueId: string
  venueSlug: string
  campaign: LaunchCampaignRow | null
  input: ActivatePlanInput
  expected: number
  /** El siguiente cobro según Stripe (`siguienteCobro(sub)`), el mismo que guarda y responde el alta. */
  nextChargeAt: string
  /** Zona del negocio, para que el correo escriba el día del cobro en SU hora. */
  timeZone?: string
  /** Plan Básico: la suscripción REAL termina sin cobrar. El correo no anuncia el cobro de Pro. */
  terminaSinCobro?: boolean
  /**
   * Planes editables (B2, §10.5): con una versión del editor, el precio de la suscripción leída en el PASO 9. Con él nunca hay
   * introducción legacy (esa compra no lleva `INTRO_PRO_3M`). Sin él, las constantes de hoy.
   */
  montoDelPlanCents?: number
}): Promise<void> {
  const target = await resolvePlanNotificationTarget(args.venueId)
  if (!target.email) return

  const { campaign, input } = args
  const legacyIntro = !campaign && args.montoDelPlanCents === undefined && isLegacyIntroEligible(input.tier, input.interval, input.payNow)

  await emailService.sendPlanConfirmationEmail(target.email, {
    locale: input.language ?? target.locale,
    venueName: target.venueName,
    planName: input.tier === 'PREMIUM' ? 'Premium' : 'Pro',
    payNow: campaign ? true : input.payNow,
    interval: input.interval,
    // 🔴 La fecha de Stripe, no «hoy + 30 días»: un alta del 18-oct decía 17-nov y Stripe cobra el 18-nov (y en el anual
    // decía un mes, no un año; deuda de la campaña 3DS, 20-oct).
    firstChargeDate: new Date(args.nextChargeAt),
    timeZone: args.timeZone,
    firstChargeAmountCents: campaign
      ? (campaign.listPriceCentsSnapshot as number)
      : (args.montoDelPlanCents ?? STANDARD_PLAN_GROSS_CENTS[input.tier][input.interval]),
    ...(campaign
      ? {
          introAmountCents: campaign.advertisedPriceCents,
          introMonths: campaign.discountMonths,
          nextChargeAmountCents: campaign.discountMonths > 1 ? campaign.advertisedPriceCents : (campaign.listPriceCentsSnapshot as number),
        }
      : legacyIntro
        ? { introAmountCents: LEGACY_INTRO_OFFER.introMonthlyCents, nextChargeAmountCents: LEGACY_INTRO_OFFER.introMonthlyCents }
        : {}),
    // B2 Task 9: el Básico pasa por `basicoDeLaBienvenida` (con una versión del editor ya no se ofrece; sin ella, lo de hoy).
    ...(args.terminaSinCobro ? { trialEndsFree: true, ...(await basicoDeLaBienvenida()) } : {}),
    billingPortalUrl: billingPageUrl(args.venueSlug),
  })
}

/**
 * B2 Task 6 (§18, b2-r8): la bienvenida a la prueba SIN tarjeta. Dice cuándo termina, cuánto se cobrará al terminar (el precio de la
 * versión, con la nota del saldo) y en qué tarjeta lo cobraría Stripe o, sin ninguna, que la ponga en «Tu plan» o se queda en
 * Gratis. Una por suscripción (`plan-trial-no-card-start:<subId>`): un reintento o una recuperación no la repiten. Best effort,
 * como los correos de hoy del alta.
 */
async function enviarBienvenidaSinTarjeta(args: {
  venueId: string
  venueSlug: string
  subscriptionId: string
  tier: PaidPlanTier
  language?: 'es' | 'en'
  timeZone?: string
  trialEnd: Date
  montoAlTerminarCents?: number
  /** `undefined` = no se pudo leer en Stripe: el correo no dice ninguna tarjeta. */
  tarjeta?: TarjetaVisible | null
  /** Codex b2-code #6: al terminar Stripe no cobrará (cancelación programada). `undefined` = no se leyó: el correo de hoy. */
  noHabraCobro?: boolean
}): Promise<void> {
  const target = await resolvePlanNotificationTarget(args.venueId)
  if (!target.email) return
  await emailService.sendPlanFreeTrialEndingEmail(target.email, {
    locale: args.language ?? target.locale,
    venueName: target.venueName,
    endDate: args.trialEnd,
    planName: args.tier === 'PREMIUM' ? 'Premium' : 'Pro',
    timeZone: args.timeZone,
    idempotencyKey: `plan-trial-no-card-start:${args.subscriptionId}`,
    billingUrl: billingPageUrl(args.venueSlug),
    empezo: true,
    ...(args.montoAlTerminarCents !== undefined ? { montoAlTerminarCents: args.montoAlTerminarCents } : {}),
    ...(args.tarjeta !== undefined ? { tarjeta: args.tarjeta } : {}),
    ...(args.noHabraCobro !== undefined ? { noHabraCobro: args.noHabraCobro } : {}),
  })
}

export { BadRequestError }
