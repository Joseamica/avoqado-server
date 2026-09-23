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
import logger from '../../config/logger'
import AppError, { BadRequestError, ConflictError, NotFoundError } from '../../errors/AppError'
import { logAction } from '../dashboard/activity-log.service'
import emailService from '../email.service'
import { resolvePlanNotificationTarget } from '../access/planNotification.service'
import {
  assertPaymentMethodBelongsToCustomer,
  createPlanSubscription,
  entregarSuscripcionDePlan,
  tierQueVendeLaSuscripcion,
  getOrCreateStripeCustomer,
  planLookupKey,
} from '../stripe.service'
import { autorizarObligacionNueva } from '../access/autorizarObligacionNueva'
import { ensureVenueForOnboarding } from './ensureVenue.service'
import { parseV2Plan } from './onboardingProgress.service'
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

export interface ActivatePlanInput {
  organizationId: string
  staffId: string
  tier: PaidPlanTier
  interval: PlanBillingInterval
  payNow: boolean
  paymentMethodId: string
  offer: ActivatePlanOffer
  language?: 'es' | 'en'
}

export interface ActivatePlanResult {
  status: 'ACTIVE'
  alreadyActive: boolean
  tier: PaidPlanTier
  interval: PlanBillingInterval
  firstChargeCents: number
  nextChargeAt: string
  launchOffer?: { code: string; offerVersion: number; months: number; renewalMonthlyCents: number }
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
  const sec = (sub as unknown as { current_period_end?: number }).current_period_end
  if (typeof sec === 'number') return new Date(sec * 1000).toISOString()
  const item = sub.items?.data?.[0] as unknown as { current_period_end?: number } | undefined
  if (typeof item?.current_period_end === 'number') return new Date(item.current_period_end * 1000).toISOString()
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

interface Cotizacion {
  expected: number
  campaign: LaunchCampaignRow | null
  listPriceCents: number
}

/**
 * PASO 3 — la cotización del SERVIDOR, y la comparación contra lo que el cliente dice haber
 * visto. Es la única fuente del precio.
 */
async function cotizar(input: ActivatePlanInput, progress: { launchCampaignId: string | null }, now: Date): Promise<Cotizacion> {
  if (input.offer.kind === 'STANDARD') {
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

async function verificarPrecioDeStripe(tier: PaidPlanTier, interval: PlanBillingInterval, esperado: number): Promise<void> {
  const tierCode = tier === 'PREMIUM' ? ('PLAN_PREMIUM' as const) : ('PLAN_PRO' as const)
  const lookupKey = planLookupKey(tierCode, interval)
  const prices = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 })
  const unitAmount = prices.data[0]?.unit_amount
  if (unitAmount !== esperado) {
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
): Promise<{ id: string; reused: boolean }> {
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
      return { id: vivo.id, reused: true }
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
      },
      select: { id: true },
    })
    return { id: creada.id, reused: false }
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

export async function activatePlan(input: ActivatePlanInput): Promise<ActivatePlanResult> {
  const { organizationId, staffId } = input
  const now = new Date()

  // ---- PASO 1: carga ----
  const progress = await prisma.onboardingProgress.findUnique({ where: { organizationId } })
  if (!progress) throw new NotFoundError('No encontramos tu registro', 'ONBOARDING_NOT_FOUND')
  if (progress.completedAt) throw new ConflictError('Este registro ya terminó', 'ONBOARDING_ALREADY_COMPLETED')

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
          { currentTier: activo?.tier ?? null, currentInterval: activo?.interval ?? null },
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
    return {
      status: 'ACTIVE',
      alreadyActive: true,
      tier: input.tier,
      interval: input.interval,
      firstChargeCents: primerCobroDe(sub, redencion?.advertisedPriceCents ?? 0),
      nextChargeAt: siguienteCobro(sub),
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
  const { expected, campaign, listPriceCents } = await cotizar(input, progress, now)

  // ---- PASO 4: verificación contra Stripe (sólo lecturas) ----
  await verificarPrecioDeStripe(input.tier, input.interval, listPriceCents)
  await verificarPlanConfigurado(input.tier)
  const venueRecord = await prisma.venue.findUnique({
    where: { id: venue.id },
    select: { id: true, name: true, slug: true, email: true, organization: { select: { email: true, name: true } } },
  })
  const customerId = await getOrCreateStripeCustomer(
    venue.id,
    venueRecord?.email || venueRecord?.organization?.email || '',
    venueRecord?.organization?.name || venueRecord?.name || 'Avoqado',
    venueRecord?.name,
    venueRecord?.slug,
  )
  const { fingerprint } = await assertPaymentMethodBelongsToCustomer(input.paymentMethodId, customerId)

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
    },
    data: {
      planActivationStatus: PLAN_ACTIVATION_STATUS.IN_PROGRESS,
      planActivationAttempt: attempt,
      planActivationLeaseUntil: nuestroLease,
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
    //   - `canceled`/`incomplete` ⇒ AMBIGUO: pudo cobrar y pudo no cobrar. Ni conceder acceso ni
    //     cobrar encima: 503 para que alguien lo mire.
    // (Segunda auditoría de Codex, 18-sep.)
    if (suscripcionRecuperada) {
      const estado = suscripcionRecuperada.status
      if (estado === 'incomplete_expired') {
        suscripcionRecuperada = null
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
      const avanzado = await prisma.onboardingProgress.updateMany({
        where: {
          organizationId,
          planActivationStatus: PLAN_ACTIVATION_STATUS.IN_PROGRESS,
          planActivationAttempt: prev.attempt,
          planActivationLeaseUntil: nuestroLease,
        },
        data: { planActivationAttempt: attempt },
      })
      // Ya no es nuestro (el lease venció y otra petición lo tomó): no se cobra nada.
      if (avanzado.count === 0) throw new ConflictError('Tu pago se está confirmando. Espera unos segundos.', 'PLAN_ACTIVATION_IN_PROGRESS')
    }
  }

  // ---- PASO 7: apartar el lugar del cupo ----
  let redemption: { id: string; reused: boolean } | null = null
  if (campaign) {
    try {
      redemption = await apartarLugar(campaign, organizationId, venue.id, staffId, now)
    } catch (error) {
      // No hubo cobro: el lease vuelve a como estaba.
      await soltarLease(organizationId, prev.status, attempt, nuestroLease)
      throw error
    }
  }

  // ---- PASOS 8-11: Stripe y cierre ----
  const planActivationKey = `plan-activation:${organizationId}:${attempt}`
  const legacyIntro = !campaign && isLegacyIntroEligible(input.tier, input.interval, input.payNow)
  const cuponEsperado = campaign ? (campaign.stripeCouponId as string) : legacyIntro ? LEGACY_INTRO_OFFER.couponId : null

  let subscriptionId: string
  let reused = false
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
    try {
      const r = await autorizarObligacionNueva(
        venue.id,
        customerId,
        { tipo: 'PLAN', tier: input.tier },
        () => {
          return createPlanSubscription({
            // «Pudo cobrarse» empieza justo antes del POST, no al entrar aquí (Codex C15).
            antesDeCobrar: () => {
              intentoCobrar = true
            },
            venueId: venue.id,
            customerId,
            paymentMethodId: input.paymentMethodId,
            tierCode: input.tier === 'PREMIUM' ? 'PLAN_PREMIUM' : 'PLAN_PRO',
            interval: input.interval,
            // Con campaña SIEMPRE se paga el primer ciclo: la oferta no tiene prueba gratis.
            trialPeriodDays: campaign || input.payNow ? 0 : TRIAL_DAYS,
            coupon: cuponEsperado ?? undefined,
            idempotencyKey: planActivationKey,
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
            extraMetadata: {
              organizationId,
              planActivationKey,
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
  }

  // 🔴 Una suscripción que NO creamos nosotros en esta pasada —da igual si vino del reuso o de la
  // RECUPERACIÓN de un intento anterior— tiene que llevar el cupón de la oferta para cerrarse como
  // tal. Comprobarlo sólo con `reused` dejaba fuera el camino de recuperación, donde `reused`
  // queda en `false`: el resultado medido por Codex (20-sep) era una campaña `APPLIED` con **$0
  // pagados y renovación anunciada a $22**, mientras en Stripe esa suscripción no tenía descuento.
  const noLaCreamosConElCupon = reused || suscripcionRecuperada != null
  if (noLaCreamosConElCupon && cuponEsperado) {
    const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['discounts'] })
    const descuentos = (sub as unknown as { discounts?: Array<string | { coupon?: { id?: string } }> }).discounts ?? []
    const lleva = descuentos.some(d => typeof d !== 'string' && d?.coupon?.id === cuponEsperado)
    if (!lleva) {
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
  const nextChargeAt = siguienteCobro(sub)

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
  const payNowCobrado = noLaCreamosConElCupon ? yaCobrada : campaign ? true : input.payNow
  const cobrado = { ...input, tier: tierConcedido, interval: intervalCobrado }

  await prisma.$transaction(async tx => {
    const planGuardado = {
      tier: cobrado.tier,
      paymentMethodId: input.paymentMethodId,
      interval: cobrado.interval,
      payNow: payNowCobrado,
      acceptedAt: now.toISOString(),
      offer: input.offer,
    }
    const v2 = ((progress.v2SetupData as Record<string, unknown> | null) ?? {}) as Record<string, unknown>
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
        // 🔴 `plan` va en la RAÍZ, que es lo primero que busca `parseV2Plan`.
        v2SetupData: { ...v2, plan: planGuardado } as Prisma.InputJsonValue,
      },
    })

    // 🔴 Cada cierre tiene que TOCAR su fila (Codex C6): si el intento ya no es de esta petición o el lugar de la oferta
    // ya no estaba apartado, no se da por aplicada el alta — el cargo quedó registrado y el siguiente intento lo recupera.
    if (cerrado.count === 0) throw pendiente('el intento ya no era de esta petición al cerrarlo')
    if (redemption && campaign) {
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
      ...(campaign ? { code: campaign.code, offerVersion: campaign.offerVersion, redemptionId: redemption?.id ?? null } : {}),
    },
  })

  // El correo no bloquea la respuesta: el dinero ya se movió.
  void enviarConfirmacion({ venueId: venue.id, venueSlug: venueRecord?.slug ?? venue.slug, campaign, input: cobrado, expected, now }).catch(
    error =>
      logger.warn('activate-plan: no se pudo enviar el correo de confirmación', {
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      }),
  )

  return {
    status: 'ACTIVE',
    alreadyActive: false,
    tier: cobrado.tier,
    interval: cobrado.interval,
    firstChargeCents,
    nextChargeAt,
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
 * El correo de confirmación. 🔴 TODOS sus montos salen del snapshot de la campaña, ninguno está
 * escrito en el código: si la ficha dice 6 meses a $33, el correo dice 6 meses a $33.
 */
async function enviarConfirmacion(args: {
  venueId: string
  venueSlug: string
  campaign: LaunchCampaignRow | null
  input: ActivatePlanInput
  expected: number
  now: Date
}): Promise<void> {
  const target = await resolvePlanNotificationTarget(args.venueId)
  if (!target.email) return

  const FRONTEND_URL = process.env.FRONTEND_URL || 'https://dashboard.avoqado.io'
  const { campaign, input, now } = args
  const unMes = new Date(now.getTime() + 30 * 86400000)
  const legacyIntro = !campaign && isLegacyIntroEligible(input.tier, input.interval, input.payNow)

  await emailService.sendPlanConfirmationEmail(target.email, {
    locale: input.language ?? target.locale,
    venueName: target.venueName,
    planName: input.tier === 'PREMIUM' ? 'Premium' : 'Pro',
    payNow: campaign ? true : input.payNow,
    interval: input.interval,
    firstChargeDate: unMes,
    firstChargeAmountCents: campaign ? (campaign.listPriceCentsSnapshot as number) : STANDARD_PLAN_GROSS_CENTS[input.tier][input.interval],
    ...(campaign
      ? {
          introAmountCents: campaign.advertisedPriceCents,
          introMonths: campaign.discountMonths,
          nextChargeAmountCents: campaign.discountMonths > 1 ? campaign.advertisedPriceCents : (campaign.listPriceCentsSnapshot as number),
        }
      : legacyIntro
        ? { introAmountCents: LEGACY_INTRO_OFFER.introMonthlyCents, nextChargeAmountCents: LEGACY_INTRO_OFFER.introMonthlyCents }
        : {}),
    billingPortalUrl: `${FRONTEND_URL}/dashboard/venues/${args.venueSlug}/billing`,
  })
}

export { BadRequestError }
