/**
 * Venue Feature Management Service
 *
 * Handles adding and removing features to venues with Stripe subscription management
 */

import Stripe from 'stripe'
import logger from '../../config/logger'
import { BadRequestError, ConflictError, NotFoundError, ServiceUnavailableError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import {
  elPlanConcede,
  getVenueBaseTier,
  sueltasAbsorbidasPorElPlan,
  type BaseTier,
  PAID_PLAN_TIER_CODES,
  PREMIUM_ONLY_CODES,
  FREE_TIER_CODES,
} from '@/services/access/basePlan.service'
import { GRANDFATHER_SELECT, resolveGrandfathered } from '@/services/access/grandfather'
import { cancelSubscription, createTrialSubscriptions, estadoDeLaSuscripcion, stripeAfirmaQueNoExiste } from '../stripe.service'
import { logAction } from './activity-log.service'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '')

/**
 * Add features to a venue with Stripe trial subscriptions
 *
 * @param venueId - Venue ID
 * @param featureCodes - Array of feature codes to add
 * @param trialPeriodDays - Number of trial days (default: 5)
 * @param paymentMethodId - Optional Stripe payment method ID to use for subscription
 * @returns Array of created VenueFeature records
 */
/** Una función suelta que el plan destino dejaría incluida — lo que habría que cancelar. */
export interface SueltaAbsorbida {
  venueFeatureId: string
  code: string
  name: string
  monthlyPrice: number
  /** null cuando la fila no tiene suscripción viva: se reporta igual, para no esconderla. */
  stripeSubscriptionId: string | null
}

/**
 * Qué funciones sueltas de ESTE negocio quedarían incluidas si se mudara a `tier`.
 *
 * 🔴 Decisión del founder (21-sep-2026), «como lo hace Claude»: la suelta absorbida se cancela y
 * se acreditan los días no usados, en vez de cobrar las dos. Esta consulta es la fuente ÚNICA de
 * esa lista: la cotización que el cliente ve y la cancelación que se ejecuta salen de aquí, así
 * que la pantalla no puede prometer una cosa y el cobro hacer otra.
 *
 * Sólo LEE. No cancela, no cobra, no escribe. Devuelve CANDIDATAS: el estado real de cada una se
 * verifica en Stripe antes de actuar.
 *
 * ⚠️ Lo que NO absorbe el plan se conserva intacto con su cobro — y ese caso importa: PRO no
 * incluye inventario, así que cancelárselo a quien lo pagó aparte le quitaría acceso comprado.
 */
export async function sueltasQueAbsorbeElPlan(venueId: string, tier: BaseTier): Promise<SueltaAbsorbida[]> {
  const ahora = new Date()
  const vivas = await prisma.venueFeature.findMany({
    // 🔴 Son CANDIDATAS, no veredictos. Entra toda fila que pueda estar COBRANDO —ligada a una
    // suscripción de Stripe, aunque en local esté suspendida o vencida— más las que dan acceso hoy.
    // «Suspendida en local» NO es «ya no cobra»: Stripe puede seguir en `past_due` reintentando, o
    // haber renovado con el webhook pendiente (Codex, 21-sep). Descartarla dejaba el solape vivo y
    // se cobraban las dos. Quien ejecute la absorción DEBE consultar el estado real en Stripe antes
    // de cancelar o de calcular un crédito — y no acreditar periodos impagados.
    where: {
      venueId,
      OR: [
        { stripeSubscriptionId: { not: null } },
        { active: true, suspendedAt: null, OR: [{ endDate: null }, { endDate: { gte: ahora } }] },
      ],
    },
    // Acotada: un negocio tiene un puñado de funciones; el tope evita una lectura sin fin.
    take: 100,
    orderBy: { id: 'asc' },
    select: {
      id: true,
      monthlyPrice: true,
      stripeSubscriptionId: true,
      feature: { select: { code: true, name: true } },
    },
  })

  const absorbidos = new Set(
    sueltasAbsorbidasPorElPlan(
      tier,
      vivas.map(v => v.feature.code),
    ),
  )

  return vivas
    .filter(v => absorbidos.has(v.feature.code))
    .map(v => ({
      venueFeatureId: v.id,
      code: v.feature.code,
      name: v.feature.name,
      monthlyPrice: Number(v.monthlyPrice),
      stripeSubscriptionId: v.stripeSubscriptionId ?? null,
    }))
}

/**
 * 🔴 No se vende suelto lo que el plan del negocio YA incluye (21-sep): un PRO pagaba $599 por lealtad,
 * que su plan trae. Lo gratis para todos (CHATBOT) tampoco se vende, con o sin plan. El paywall no lo
 * ofrece porque el acceso ya está concedido, pero la API lo cobraba igual. Todo o nada, y antes de
 * tocar Stripe. Lo usan la compra suelta y el cambio suelta→suelta (Codex, ronda 5, P1-3).
 */
export async function assertNoIncluidaEnElPlan(venueId: string, featureCodes: string[]): Promise<void> {
  const tier = await getVenueBaseTier(venueId)
  const yaIncluidas = featureCodes.filter(code =>
    tier ? elPlanConcede(tier, code) : (FREE_TIER_CODES as readonly string[]).includes(code),
  )
  if (yaIncluidas.length > 0) {
    throw new ConflictError(`Tu plan ya incluye ${yaIncluidas.join(', ')}: no hace falta contratarlo aparte.`, 'FEATURE_INCLUDED_IN_PLAN', {
      featureCodes: yaIncluidas,
      tier: tier ?? 'FREE',
    })
  }
}

// La decisión de si la venta suelta está abierta vive en su propio módulo (la consulta también Stripe).
export { ventaSueltaAbierta } from '@/services/access/ventaSuelta'

/** Estados de Stripe en los que una suscripción YA no puede volver a cobrar. */
const SUSCRIPCION_SIN_COBRO: ReadonlySet<string> = new Set(['canceled', 'incomplete_expired'])

/**
 * 🔴 PARCHE INICIAL del hallazgo #1 (21-sep-2026): no se sube a `tier` mientras una función suelta
 * que ese plan INCLUYE siga cobrando en Stripe — el negocio pagaría las dos.
 *
 * La solución decidida por el founder («como lo hace Claude»: cancelar la suelta, acreditar los días
 * no usados y cobrar sólo la diferencia) exige medir en Stripe de prueba cómo sale ese crédito y
 * auditarlo antes de mover dinero. Mientras tanto se bloquea el cambio y se dice cuál es y qué hacer.
 *
 * Estado de cada candidata consultado en Stripe, nunca deducido de la fila: «suspendida en local» no
 * es «ya no cobra». Si Stripe no contesta, 503 y no se sube a ciegas.
 */
export async function assertSinCobroDobleAlSubir(venueId: string, tier: BaseTier): Promise<void> {
  const candidatas = await sueltasQueAbsorbeElPlan(venueId, tier)
  const cobrando: SueltaAbsorbida[] = []
  for (const suelta of candidatas) {
    if (!suelta.stripeSubscriptionId) continue // concedida sin Stripe: no cobra
    let estado: string
    try {
      estado = await estadoDeLaSuscripcion(suelta.stripeSubscriptionId)
    } catch (error) {
      if (stripeAfirmaQueNoExiste(error)) continue
      throw new ServiceUnavailableError(
        'No pudimos confirmar tus funciones contratadas. Inténtalo de nuevo en unos minutos.',
        'PLAN_OVERLAP_UNVERIFIED',
      )
    }
    if (!SUSCRIPCION_SIN_COBRO.has(estado)) cobrando.push(suelta)
  }
  if (cobrando.length === 0) return

  const nombres = cobrando.map(s => s.name).join(', ')
  throw new ConflictError(
    `Ya pagas ${nombres} por separado y el plan lo incluye. Para no cobrarte dos veces, escríbenos a hola@avoqado.io y te hacemos el cambio con el ajuste de lo ya pagado.`,
    'PLAN_ABSORBS_ALA_CARTE',
    { features: cobrando.map(s => ({ code: s.code, name: s.name })) },
  )
}

/**
 * 🔴 Los días de prueba de una compra suelta los decide el SERVIDOR, nunca quien compra.
 * Antes venían en el body (`trialPeriodDays`, 0..365 en el schema), así que cualquiera con
 * permiso de compra podía regalarse un año (auditoría del 21-sep-2026, hallazgo #8). El schema
 * sigue aceptando el campo para no romper clientes viejos, pero su valor se IGNORA.
 */
const TRIAL_ALA_CARTE_DIAS = 5

export async function addFeaturesToVenue(venueId: string, featureCodes: string[], paymentMethodId?: string) {
  // 🔴 Un PLAN no se contrata por la puerta de las funciones sueltas. Los planes son filas de la
  // MISMA tabla `Feature` (`PLAN_PRO`, `PLAN_PREMIUM`), así que sin este corte esta ruta permitía
  // contratar un segundo plan saltándose el guard del checkout —que sí rechaza un plan activo— y
  // dejaba a `cancelPlan()` eligiendo con un `findFirst()` cuál de los dos cancelar (hallazgo #3).
  // Se comprueba ANTES de tocar la base o Stripe: nada de la petición debe ejecutarse a medias.
  const planesPedidos = featureCodes.filter(code => (PAID_PLAN_TIER_CODES as readonly string[]).includes(code))
  if (planesPedidos.length > 0) {
    throw new BadRequestError(`Los planes (${planesPedidos.join(', ')}) se contratan desde el flujo de plan, no como función suelta.`)
  }

  await assertNoIncluidaEnElPlan(venueId, featureCodes)

  const trialPeriodDays = TRIAL_ALA_CARTE_DIAS
  logger.info('Adding features to venue', { venueId, featureCodes, trialPeriodDays, paymentMethodId })

  // Get venue with Stripe customer ID
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: {
      id: true,
      name: true,
      slug: true,
      stripeCustomerId: true,
      stripePaymentMethodId: true,
      features: {
        where: {
          active: true,
        },
        include: {
          feature: true,
        },
      },
    },
  })

  if (!venue) {
    throw new NotFoundError(`Venue with ID ${venueId} not found`)
  }

  // Verify venue has Stripe customer configured
  if (!venue.stripeCustomerId) {
    throw new BadRequestError('Venue does not have Stripe customer configured. Please add a payment method first.')
  }

  // Check if venue already has payment method
  if (!venue.stripePaymentMethodId) {
    logger.warn('Venue has Stripe customer but no payment method', { venueId })
    throw new BadRequestError('Venue does not have a payment method configured. Please add a payment method first.')
  }

  // Check which features are already active
  const activeFeatureCodes = venue.features.map(vf => vf.feature.code)
  const newFeatureCodes = featureCodes.filter(code => !activeFeatureCodes.includes(code))

  if (newFeatureCodes.length === 0) {
    logger.info('All requested features are already active', { venueId, featureCodes })
    return []
  }

  // Check if venue has ever had these features before (even if canceled)
  // If they had a trial before, don't give them another one
  const previousFeatures = await prisma.venueFeature.findMany({
    where: {
      venueId,
      feature: {
        code: {
          in: newFeatureCodes,
        },
      },
    },
    include: {
      feature: true,
    },
  })

  const previousFeatureCodes = previousFeatures.map(vf => vf.feature.code)

  // Only give trial to features they've NEVER had before
  const firstTimeFeatures = newFeatureCodes.filter(code => !previousFeatureCodes.includes(code))
  const returningFeatures = newFeatureCodes.filter(code => previousFeatureCodes.includes(code))

  logger.info('Creating subscriptions for new features', {
    venueId,
    newFeatureCodes,
    alreadyActive: activeFeatureCodes,
    firstTimeFeatures,
    returningFeatures,
  })

  // Create trial subscriptions for new features
  try {
    // First-time features get trial period
    const firstTimeTrialDays = firstTimeFeatures.length > 0 ? trialPeriodDays : 0
    // Returning features get NO trial (immediate payment)
    const returningTrialDays = 0

    const subscriptionIds: string[] = []

    // Create trial subscriptions for first-time features
    if (firstTimeFeatures.length > 0) {
      const firstTimeIds = await createTrialSubscriptions(
        venue.stripeCustomerId,
        venueId,
        firstTimeFeatures,
        firstTimeTrialDays,
        venue.name,
        venue.slug,
        paymentMethodId,
      )
      subscriptionIds.push(...firstTimeIds)
      logger.info('✅ Trial subscriptions created for first-time features', {
        features: firstTimeFeatures,
        trialDays: firstTimeTrialDays,
        paymentMethodId: paymentMethodId || 'default',
      })
    }

    // Create immediate (no trial) subscriptions for returning features
    if (returningFeatures.length > 0) {
      const returningIds = await createTrialSubscriptions(
        venue.stripeCustomerId,
        venueId,
        returningFeatures,
        returningTrialDays,
        venue.name,
        venue.slug,
        paymentMethodId,
      )
      subscriptionIds.push(...returningIds)
      logger.info('✅ Paid subscriptions created for returning features (no trial)', {
        features: returningFeatures,
        paymentMethodId: paymentMethodId || 'default',
      })
    }

    logger.info('✅ Features added successfully', {
      venueId,
      featureCount: newFeatureCodes.length,
      subscriptionIds,
    })

    // Return created VenueFeature records
    const createdFeatures = await prisma.venueFeature.findMany({
      where: {
        venueId,
        stripeSubscriptionId: {
          in: subscriptionIds,
        },
      },
      include: {
        feature: true,
      },
    })

    logAction({
      venueId,
      action: 'FEATURES_ADDED',
      entity: 'VenueFeature',
      entityId: venueId,
      data: { featureCodes: newFeatureCodes },
    })

    return createdFeatures
  } catch (error) {
    logger.error('❌ Error adding features to venue', {
      error,
      venueId,
      featureCodes: newFeatureCodes,
    })
    throw error
  }
}

/**
 * Remove a feature from a venue and cancel Stripe subscription
 *
 * @param venueId - Venue ID
 * @param featureId - Feature ID to remove
 */
export async function removeFeatureFromVenue(venueId: string, featureId: string) {
  logger.info('Removing feature from venue', { venueId, featureId })

  // Get VenueFeature record
  const venueFeature = await prisma.venueFeature.findFirst({
    where: {
      venueId,
      featureId,
      active: true,
    },
    include: {
      feature: true,
    },
  })

  if (!venueFeature) {
    throw new NotFoundError(`Active feature ${featureId} not found for venue ${venueId}`)
  }

  // Guard: the PLAN_PRO base plan must NEVER be canceled via this à-la-carte delete
  // (cancelSubscription cancels Stripe immediately). The base plan can only be canceled
  // through POST /plan/cancel, which schedules cancel_at_period_end. See planState.service.
  if ((PAID_PLAN_TIER_CODES as readonly string[]).includes(venueFeature.feature.code)) {
    throw new BadRequestError('Usa el flujo de plan (cancelar suscripción) para el plan base. Endpoint: /plan/cancel')
  }

  // Cancel Stripe subscription if exists
  if (venueFeature.stripeSubscriptionId) {
    try {
      await cancelSubscription(venueFeature.stripeSubscriptionId)
      logger.info('✅ Stripe subscription canceled', {
        venueId,
        featureId,
        subscriptionId: venueFeature.stripeSubscriptionId,
      })
    } catch (error) {
      logger.error('❌ Error canceling Stripe subscription', {
        error,
        venueId,
        featureId,
        subscriptionId: venueFeature.stripeSubscriptionId,
      })
      // 🔴 Antes se seguía SIEMPRE («admin can manually cancel in Stripe dashboard») y el
      // controlador respondía «canceled successfully»: el cliente perdía el acceso y seguía
      // pagando, sin que nadie se enterara (auditoría 21-sep, #6). Ahora sólo se sigue cuando
      // Stripe AFIRMA que esa suscripción ya no existe —ahí cancelar es un no-op y desactivar
      // es lo correcto—. Cualquier otro fallo (red, Stripe caído, respuesta ambigua) detiene la
      // baja: es preferible que el cliente conserve el acceso que paga a dejarlo pagando sin él.
      if (!stripeAfirmaQueNoExiste(error)) {
        // Un error NO prueba que la cancelación falló: Stripe pudo cancelar y perderse la
        // respuesta, o pudo fallar la escritura local que `cancelSubscription` hace DESPUÉS de
        // cancelar. Rendirse ahí deja una baja imposible —Stripe ya no cobra y la base insiste en
        // que sigue activa— (Codex, 21-sep). Se pregunta el estado real antes de decidir.
        let estado: string | null = null
        try {
          estado = await estadoDeLaSuscripcion(venueFeature.stripeSubscriptionId)
        } catch {
          estado = null // tampoco se pudo consultar: se trata como incierto
        }
        if (estado !== 'canceled' && estado !== 'incomplete_expired') {
          // 503, no 400: el fallo es de Stripe, no de lo que mandó el cliente.
          throw new ServiceUnavailableError(
            'No pudimos confirmar la cancelación con Stripe, así que la función sigue activa. Inténtalo de nuevo en unos minutos.',
            'SUBSCRIPTION_CANCEL_PENDING',
          )
        }
        logger.warn('Stripe respondió con error pero la suscripción SÍ quedó cancelada: se completa la baja local', {
          venueId,
          featureId,
          subscriptionId: venueFeature.stripeSubscriptionId,
          estado,
        })
      }
    }
  }

  // 🔴 R0 (Codex, 21-sep): se apaga SÓLO la fila que sigue ligada a lo que se canceló. Por `id` a secas,
  // una recompra ligada entre la cancelación y esta escritura se quedaba sin el acceso recién pagado.
  const { count } = await prisma.venueFeature.updateMany({
    where: { id: venueFeature.id, stripeSubscriptionId: venueFeature.stripeSubscriptionId },
    data: { active: false },
  })
  if (count === 0) {
    logger.warn('🚨 El vínculo de la función cambió mientras se daba de baja (¿recompra?): no se toca la fila', {
      venueId,
      venueFeatureId: venueFeature.id,
      canceledSubscriptionId: venueFeature.stripeSubscriptionId,
    })
    // Ni auditoría ni «baja hecha» de algo que no ocurrió (Codex, ronda 3): la función sigue contratada.
    throw new ConflictError(
      'Esta función se volvió a contratar mientras se daba de baja. La suscripción anterior sí se canceló; la actual sigue activa.',
      'SUBSCRIPTION_LINK_CHANGED',
    )
  }

  logAction({
    venueId,
    action: 'FEATURE_REMOVED',
    entity: 'VenueFeature',
    entityId: featureId,
    data: { featureCode: venueFeature.feature.code },
  })

  logger.info('✅ Feature removed from venue', {
    venueId,
    featureId,
    featureCode: venueFeature.feature.code,
  })

  return venueFeature
}

/**
 * Get all features available for a venue
 * Shows which features are active and which are available to add
 *
 * @param venueId - Venue ID
 */
export async function getVenueFeatureStatus(venueId: string) {
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: {
      id: true,
      name: true,
      stripeCustomerId: true,
      stripePaymentMethodId: true,
      // Grandfather flags (see schema.prisma): the venue's own, plus its organization's —
      // either one means the venue is exempt from feature paywalls and every available feature
      // must surface as granted (no upsell cards). Resolved via resolveGrandfathered.
      ...GRANDFATHER_SELECT,
      features: {
        where: { active: true },
        include: {
          feature: true,
        },
      },
    },
  })

  if (!venue) {
    throw new NotFoundError(`Venue with ID ${venueId} not found`)
  }

  // Get all available features
  const allFeatures = await prisma.feature.findMany({
    where: { active: true },
  })

  const activeFeatureIds = venue.features.map(vf => vf.featureId)
  const availableFeatures = allFeatures.filter(f => !activeFeatureIds.includes(f.id))

  // Tier-aware base-plan blanket grant (mirror of checkFeatureAccess + getFeatureMetadataForVenue):
  // a premium feature the venue doesn't already own à-la-carte surfaces as UNLOCKED in this paywall
  // payload ONLY when the venue's base tier actually covers it — otherwise a paying venue still sees
  // premium features as locked upsell cards, and (the bug this fixes) a PRO venue was incorrectly
  // shown CFDI / INVENTORY_TRACKING as granted even though the access gate 403s them.
  //   - PREMIUM tier unlocks ALL non-tier features.
  //   - PRO tier unlocks all non-tier features EXCEPT the Premium-only differentiators (PREMIUM_ONLY_CODES).
  //   - no active tier unlocks nothing.
  // This is a pure UNION: features the venue already owns (real VenueFeature rows in `venue.features`)
  // keep their richer state untouched; we only promote the ones that would otherwise be in
  // `availableFeatures`. The plan-tier codes themselves are never blanket-granted.
  const baseTier = await getVenueBaseTier(venueId)
  // Grandfathered venues (own flag OR the organization's) are exempt from feature paywalls —
  // EVERY available non-tier feature must surface as granted (mirror of venueHasFeatureAccess +
  // the checkFeatureAccess middleware short-circuit), so the dashboard shows no upsell cards.
  const isGrandfathered = resolveGrandfathered(venue)
  const isPlanTierCode = (code: string): boolean => (PAID_PLAN_TIER_CODES as readonly string[]).includes(code)
  const isPremiumOnlyCode = (code: string): boolean => (PREMIUM_ONLY_CODES as readonly string[]).includes(code)
  // Tier-aware grant predicate — same rule as the checkFeatureAccess middleware:
  // grantedByPlan = grandfathered || FREE_TIER_CODES || tier === 'PREMIUM' || (tier === 'PRO' && !PREMIUM_ONLY_CODES.includes(code))
  const tierGrants = (code: string): boolean => {
    if (isPlanTierCode(code)) return false // tier codes never self-grant via the blanket
    if (isGrandfathered) return true // grandfathered → every non-tier feature granted, no paywall
    if ((FREE_TIER_CODES as readonly string[]).includes(code)) return true // Free-tier promises: everyone
    if (baseTier === 'PREMIUM') return true
    if (baseTier === 'PRO') return !isPremiumOnlyCode(code)
    return false
  }
  const basePlanGrantedFeatures = availableFeatures.filter(f => tierGrants(f.code))
  const basePlanGrantedIds = new Set(basePlanGrantedFeatures.map(f => f.id))
  // Features that remain genuinely locked (no base plan, or the plan-tier feature itself).
  const lockedAvailableFeatures = availableFeatures.filter(f => !basePlanGrantedIds.has(f.id))

  // Get historical feature usage (including canceled) to determine if features were previously used
  const previousFeatures = await prisma.venueFeature.findMany({
    where: {
      venueId,
      featureId: {
        in: availableFeatures.map(f => f.id),
      },
    },
    select: {
      featureId: true,
    },
  })

  const previousFeatureIds = new Set(previousFeatures.map(vf => vf.featureId))

  // Get payment method details from Stripe if available
  let paymentMethod: {
    brand: string
    last4: string
    expMonth: number
    expYear: number
  } | null = null

  if (venue.stripePaymentMethodId) {
    try {
      const pm = await stripe.paymentMethods.retrieve(venue.stripePaymentMethodId)
      if (pm.card) {
        paymentMethod = {
          brand: pm.card.brand,
          last4: pm.card.last4,
          expMonth: pm.card.exp_month,
          expYear: pm.card.exp_year,
        }
      }
    } catch (error) {
      logger.warn('Failed to retrieve payment method from Stripe', {
        venueId,
        paymentMethodId: venue.stripePaymentMethodId,
        error,
      })
    }
  }

  const result = {
    venueId: venue.id,
    venueName: venue.name,
    hasStripeCustomer: !!venue.stripeCustomerId,
    hasPaymentMethod: !!venue.stripePaymentMethodId,
    paymentMethod,
    activeFeatures: [
      ...venue.features.map(vf => ({
        id: vf.id,
        venueId: vf.venueId,
        featureId: vf.feature.id,
        feature: {
          id: vf.feature.id,
          code: vf.feature.code,
          name: vf.feature.name,
          description: vf.feature.description,
        },
        active: vf.active,
        monthlyPrice: vf.monthlyPrice,
        startDate: vf.startDate,
        endDate: vf.endDate,
        stripeSubscriptionId: vf.stripeSubscriptionId,
        stripePriceId: vf.stripePriceId,
      })),
      // Premium features unlocked solely by the active base plan (no à-la-carte
      // VenueFeature row exists). Synthesized to the active-feature shape so the
      // paywall renders them as owned/unlocked. They carry no Stripe subscription
      // and a synthetic, non-DB id; `grantedByBasePlan` is an additive optional
      // marker the dashboard can use to suppress the per-feature cancel control
      // (you can't cancel a base-plan grant individually).
      ...basePlanGrantedFeatures.map(f => ({
        id: `baseplan:${f.code}`,
        venueId: venue.id,
        featureId: f.id,
        feature: {
          id: f.id,
          code: f.code,
          name: f.name,
          description: f.description,
        },
        active: true,
        monthlyPrice: f.monthlyPrice,
        startDate: null,
        endDate: null,
        stripeSubscriptionId: null,
        stripePriceId: f.stripePriceId,
        grantedByBasePlan: true,
      })),
    ],
    availableFeatures: lockedAvailableFeatures.map(f => ({
      id: f.id,
      code: f.code,
      name: f.name,
      description: f.description,
      monthlyPrice: f.monthlyPrice,
      stripeProductId: f.stripeProductId,
      stripePriceId: f.stripePriceId,
      hadPreviously: previousFeatureIds.has(f.id), // NEW: Indicates if feature was previously used
    })),
  }

  return result
}

export default {
  addFeaturesToVenue,
  removeFeatureFromVenue,
  getVenueFeatureStatus,
}
