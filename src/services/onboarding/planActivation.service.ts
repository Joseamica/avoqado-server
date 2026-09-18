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
import { assertPaymentMethodBelongsToCustomer, createPlanSubscription, getOrCreateStripeCustomer, planLookupKey } from '../stripe.service'
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
  return new AppError('Tu pago se está confirmando. Vuelve a intentar en unos segundos.', 503, true, 'PLAN_ACTIVATION_PENDING', { motivo })
}

/** El 402 del banco. Lleva el mensaje de Stripe, que es el único que le sirve al cliente. */
function rechazado(message: string, declineCode?: string): AppError {
  return new AppError(message, 402, true, 'PLAN_PAYMENT_DECLINED', { declineCode: declineCode ?? null, message })
}

function esErrorDeTarjeta(error: unknown): error is Stripe.errors.StripeError {
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
    throw new ConflictError('La oferta ya no está disponible', 'LAUNCH_OFFER_UNAVAILABLE', {
      reason: disponible.reason,
      standardQuote: { firstChargeCents: standardFirstChargeCents(standardPlanQuote(), input.tier, input.interval, true) },
    })
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
  desde: Date,
): Promise<Stripe.Subscription | null> {
  let encontrada: Stripe.Subscription | null = null
  await stripe.subscriptions
    .list({
      customer: customerId,
      status: 'all',
      limit: 100,
      created: { gte: Math.floor(desde.getTime() / 1000) - 3600 },
    })
    .autoPagingEach(sub => {
      if (sub.metadata?.planActivationKey === planActivationKey) {
        encontrada = sub
        return false // corta el recorrido
      }
      return true
    })
  return encontrada
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
  return prisma.$transaction(async tx => {
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
  })
}

/** Deja el lease como estaba, sin subir el intento: sólo se usa cuando NO hubo cobro. */
async function soltarLease(organizationId: string, status: string, attempt: number): Promise<void> {
  await prisma.onboardingProgress.updateMany({
    where: { organizationId, planActivationStatus: PLAN_ACTIVATION_STATUS.IN_PROGRESS, planActivationAttempt: attempt },
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
  const tomado = await prisma.onboardingProgress.updateMany({
    where: {
      organizationId,
      completedAt: null,
      planActivationStatus: prev.status as never,
      planActivationAttempt: prev.attempt,
    },
    data: {
      planActivationStatus: PLAN_ACTIVATION_STATUS.IN_PROGRESS,
      planActivationAttempt: attempt,
      planActivationLeaseUntil: new Date(now.getTime() + LEASE_MS),
    },
  })
  if (tomado.count === 0) throw new ConflictError('Tu pago se está confirmando. Espera unos segundos.', 'PLAN_ACTIVATION_IN_PROGRESS')

  // ---- PASO 6: recuperación de un intento desconocido ----
  let suscripcionRecuperada: Stripe.Subscription | null = null
  if (prev.status === PLAN_ACTIVATION_STATUS.IN_PROGRESS) {
    const llaveAnterior = `plan-activation:${organizationId}:${prev.attempt}`
    try {
      suscripcionRecuperada = await buscarSuscripcionDelIntento(customerId, llaveAnterior, prev.leaseUntil ?? now)
    } catch (error) {
      // 🔴 «No pude ver» NUNCA es «no existe». Se deja el lease VIVO y se responde 503.
      logger.warn('activate-plan: no se pudo consultar Stripe para recuperar el intento anterior', {
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      })
      throw pendiente('no se pudo consultar Stripe')
    }
    if (!suscripcionRecuperada) {
      // No existe de verdad: intento nuevo, llave nueva.
      attempt = prev.attempt + 1
      await prisma.onboardingProgress.updateMany({
        where: { organizationId, planActivationStatus: PLAN_ACTIVATION_STATUS.IN_PROGRESS, planActivationAttempt: prev.attempt },
        data: { planActivationAttempt: attempt },
      })
    }
  }

  // ---- PASO 7: apartar el lugar del cupo ----
  let redemption: { id: string; reused: boolean } | null = null
  if (campaign) {
    try {
      redemption = await apartarLugar(campaign, organizationId, venue.id, staffId, now)
    } catch (error) {
      // No hubo cobro: el lease vuelve a como estaba.
      await soltarLease(organizationId, prev.status, attempt)
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
  } else {
    try {
      const r = await createPlanSubscription({
        venueId: venue.id,
        customerId,
        paymentMethodId: input.paymentMethodId,
        tierCode: input.tier === 'PREMIUM' ? 'PLAN_PREMIUM' : 'PLAN_PRO',
        interval: input.interval,
        // Con campaña SIEMPRE se paga el primer ciclo: la oferta no tiene prueba gratis.
        trialPeriodDays: campaign || input.payNow ? 0 : TRIAL_DAYS,
        coupon: cuponEsperado ?? undefined,
        idempotencyKey: planActivationKey,
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
      subscriptionId = r.subscriptionId
      reused = r.reused
    } catch (error) {
      if (esErrorDeTarjeta(error)) {
        // ---- PASO 10: rechazo del banco ----
        await prisma.onboardingProgress.updateMany({
          where: { organizationId, planActivationStatus: PLAN_ACTIVATION_STATUS.IN_PROGRESS, planActivationAttempt: attempt },
          data: { planActivationStatus: PLAN_ACTIVATION_STATUS.DECLINED, planActivationLeaseUntil: null },
        })
        if (redemption && campaign) await liberarLugar(redemption.id, campaign.id, 'PLAN_PAYMENT_DECLINED')
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

  // 🔴 Una suscripción REUSADA sin el cupón esperado NO se puede cerrar como un cobro.
  if (reused && cuponEsperado) {
    const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['discounts'] })
    const descuentos = (sub as unknown as { discounts?: Array<string | { coupon?: { id?: string } }> }).discounts ?? []
    const lleva = descuentos.some(d => typeof d !== 'string' && d?.coupon?.id === cuponEsperado)
    if (!lleva) {
      logger.error('🚨 activate-plan: se reusó una suscripción sin el cupón de la oferta', { organizationId, subscriptionId })
      if (redemption && campaign) await liberarLugar(redemption.id, campaign.id, 'REUSED_WITHOUT_COUPON')
      await soltarLease(organizationId, prev.status, attempt)
      throw new ConflictError(
        'Este negocio ya tiene un plan activo sin esta oferta, así que no se puede aplicar encima.',
        'PLAN_ACTIVE_WITHOUT_OFFER',
      )
    }
  }

  // ---- PASO 9: éxito ----
  const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['latest_invoice'] })
  const nextChargeAt = siguienteCobro(sub)

  await prisma.$transaction(async tx => {
    const planGuardado = {
      tier: input.tier,
      paymentMethodId: input.paymentMethodId,
      interval: input.interval,
      payNow: campaign ? true : input.payNow,
      acceptedAt: now.toISOString(),
      offer: input.offer,
    }
    const v2 = ((progress.v2SetupData as Record<string, unknown> | null) ?? {}) as Record<string, unknown>
    await tx.onboardingProgress.updateMany({
      where: { organizationId, planActivationStatus: PLAN_ACTIVATION_STATUS.IN_PROGRESS, planActivationAttempt: attempt },
      data: {
        planActivationStatus: PLAN_ACTIVATION_STATUS.ACTIVE,
        planActivatedAt: now,
        planActivationLeaseUntil: null,
        planStripeSubscriptionId: subscriptionId,
        // 🔴 `plan` va en la RAÍZ, que es lo primero que busca `parseV2Plan`.
        v2SetupData: { ...v2, plan: planGuardado } as Prisma.InputJsonValue,
      },
    })

    if (redemption && campaign) {
      await tx.launchCampaignRedemption.updateMany({
        where: { id: redemption.id, status: REDEMPTION_STATUS.RESERVED },
        data: { status: REDEMPTION_STATUS.APPLIED, appliedAt: now, stripeSubscriptionId: subscriptionId, cardFingerprint: fingerprint },
      })
    }

    // 🔴 El local queda con su tier, NUNCA en TRIAL: TRIAL se escapa de todo candado de plan y
    // de KYC (`basePlan.service.ts`, `kyc-utils.ts`).
    await tx.venue.update({ where: { id: venue.id }, data: { planTier: input.tier } })
  })

  const firstChargeCents = primerCobroDe(sub, expected)

  await logAction({
    staffId,
    organizationId,
    action: campaign ? 'LAUNCH_CAMPAIGN_REDEEMED' : 'PLAN_ACTIVATED_ONBOARDING',
    entity: 'OnboardingProgress',
    entityId: progress.id,
    data: {
      tier: input.tier,
      interval: input.interval,
      firstChargeCents,
      subscriptionId,
      ...(campaign ? { code: campaign.code, offerVersion: campaign.offerVersion, redemptionId: redemption?.id ?? null } : {}),
    },
  })

  // El correo no bloquea la respuesta: el dinero ya se movió.
  void enviarConfirmacion({ venueId: venue.id, venueSlug: venueRecord?.slug ?? venue.slug, campaign, input, expected, now }).catch(error =>
    logger.warn('activate-plan: no se pudo enviar el correo de confirmación', {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    }),
  )

  return {
    status: 'ACTIVE',
    alreadyActive: false,
    tier: input.tier,
    interval: input.interval,
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
