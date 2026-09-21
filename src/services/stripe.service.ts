/**
 * Stripe Service
 *
 * Handles all Stripe-related operations:
 * - Customer management
 * - Product/Price synchronization
 * - Subscription management with trials
 * - Payment method updates
 */

import Stripe from 'stripe'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { Feature } from '@prisma/client'
import { retry, shouldRetryStripeError } from '@/utils/retry'
import { addDays } from 'date-fns'
import emailService from './email.service'
import { resolvePlanNotificationTarget } from './access/planNotification.service'
import AppError from '@/errors/AppError'

// Initialize Stripe
// Using default API version from SDK (automatically uses the latest compatible version)
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '')

/**
 * Get or create Stripe customer for an organization
 *
 * @param organizationId - Organization ID
 * @param email - Customer email
 * @param name - Customer name
 * @param venueName - Optional venue name for customer description
 * @param venueSlug - Optional venue slug for identification
 * @returns Stripe customer ID
 */
export async function getOrCreateStripeCustomer(
  venueId: string,
  email: string,
  name: string,
  venueName?: string,
  venueSlug?: string,
): Promise<string> {
  // Check if venue already has a Stripe customer
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { stripeCustomerId: true },
  })

  // Venue must exist
  if (!venue) {
    throw new Error(`Venue ${venueId} not found`)
  }

  if (venue.stripeCustomerId) {
    logger.info(`✅ Venue ${venueId} already has Stripe customer: ${venue.stripeCustomerId}`)

    // Update customer description with venue info if provided
    if (venueName || venueSlug) {
      try {
        await retry(
          () =>
            stripe.customers.update(venue.stripeCustomerId!, {
              description: venueName ? `Venue: ${venueName}${venueSlug ? ` (${venueSlug})` : ''}` : undefined,
              metadata: {
                venueId,
                ...(venueSlug && { venueSlug }),
              },
            }),
          {
            retries: 3,
            shouldRetry: shouldRetryStripeError,
            context: 'stripe.updateCustomer',
          },
        )
        logger.info(`✅ Updated Stripe customer description with venue info: ${venueName}`)
      } catch (error) {
        logger.warn('⚠️ Failed to update Stripe customer description after retries', { error })
      }
    }

    return venue.stripeCustomerId
  }

  // Create new Stripe customer with venue info (with retry)
  // Include venue slug in name for easy identification in Stripe dashboard
  const customerName = venueSlug ? `${name} (${venueSlug})` : name

  const customer = await retry(
    () =>
      stripe.customers.create({
        email,
        name: customerName,
        description: venueName ? `Venue: ${venueName}${venueSlug ? ` (${venueSlug})` : ''}` : undefined,
        metadata: {
          venueId,
          ...(venueSlug && { venueSlug }),
        },
      }),
    {
      retries: 3,
      shouldRetry: shouldRetryStripeError,
      context: 'stripe.createCustomer',
    },
  )

  // Save customer ID to venue database — RACE-SAFE. Concurrent callers (e.g. React
  // StrictMode double-invoking the plan SetupIntent effect, or two onboarding requests)
  // can each reach here having just created a distinct Stripe customer. Only the FIRST to
  // claim the (still-null) column wins; losers discard their duplicate and reuse the winner,
  // so every caller ends up on the SAME customer. Without this, a payment method attached via
  // one customer's SetupIntent won't match the customer createPlanSubscription reads back →
  // "The payment method must be attached to the customer" and the subscription silently fails.
  const claim = await prisma.venue.updateMany({
    where: { id: venueId, stripeCustomerId: null },
    data: { stripeCustomerId: customer.id },
  })

  if (claim.count === 0) {
    const fresh = await prisma.venue.findUnique({ where: { id: venueId }, select: { stripeCustomerId: true } })
    const winner = fresh?.stripeCustomerId
    logger.warn(
      `getOrCreateStripeCustomer: lost create race for venue ${venueId}, reusing existing ${winner} and discarding duplicate ${customer.id}`,
    )
    try {
      await stripe.customers.del(customer.id)
    } catch (delErr) {
      logger.warn(`getOrCreateStripeCustomer: could not delete duplicate customer ${customer.id}`, delErr)
    }
    if (winner) return winner
  }

  logger.info(`✅ Created Stripe customer ${customer.id} for venue ${venueId}`)
  return customer.id
}

/**
 * Sync features to Stripe products and prices
 * Creates or updates Stripe products/prices for each feature
 *
 * @returns Array of synced features with Stripe IDs
 */
export async function syncFeaturesToStripe(): Promise<Feature[]> {
  const features = await prisma.feature.findMany({
    where: { active: true },
  })

  logger.info(`🔄 Syncing ${features.length} features to Stripe...`)

  for (const feature of features) {
    try {
      let productId = feature.stripeProductId
      let priceId = feature.stripePriceId

      // Create or update Stripe product (with retry)
      if (!productId) {
        const product = await retry(
          () =>
            stripe.products.create({
              name: feature.name,
              description: feature.description || undefined,
              metadata: {
                featureId: feature.id,
                featureCode: feature.code,
              },
            }),
          {
            retries: 3,
            shouldRetry: shouldRetryStripeError,
            context: 'stripe.createProduct',
          },
        )
        productId = product.id
        logger.info(`  ✅ Created Stripe product ${productId} for feature ${feature.code}`)
      } else {
        await retry(
          () =>
            stripe.products.update(productId!, {
              name: feature.name,
              description: feature.description || undefined,
            }),
          {
            retries: 3,
            shouldRetry: shouldRetryStripeError,
            context: 'stripe.updateProduct',
          },
        )
        logger.info(`  ✅ Updated Stripe product ${productId} for feature ${feature.code}`)
      }

      // Create or update Stripe price (with retry)
      if (!priceId) {
        const price = await retry(
          () =>
            stripe.prices.create({
              product: productId!,
              unit_amount: Math.round(feature.monthlyPrice.toNumber() * 100), // Convert to cents
              currency: 'mxn',
              recurring: {
                interval: 'month',
              },
              metadata: {
                featureId: feature.id,
                featureCode: feature.code,
              },
            }),
          {
            retries: 3,
            shouldRetry: shouldRetryStripeError,
            context: 'stripe.createPrice',
          },
        )
        priceId = price.id
        logger.info(`  ✅ Created Stripe price ${priceId} for feature ${feature.code}`)
      }

      // Update feature with Stripe IDs
      await prisma.feature.update({
        where: { id: feature.id },
        data: {
          stripeProductId: productId,
          stripePriceId: priceId,
        },
      })
    } catch (error) {
      logger.error(`❌ Error syncing feature ${feature.code} to Stripe:`, error)
    }
  }

  // Return updated features
  return prisma.feature.findMany({
    where: { active: true },
  })
}

/**
 * Create trial subscriptions for selected features
 *
 * @param customerId - Stripe customer ID
 * @param venueId - Venue ID
 * @param featureCodes - Array of feature codes to subscribe to
 * @param trialPeriodDays - Number of trial days (default: 5)
 * @param venueName - Optional venue name for identification
 * @param venueSlug - Optional venue slug for identification
 * @param paymentMethodId - Optional Stripe payment method ID to use for subscription
 * @returns Created subscription IDs
 */
/**
 * ¿Este error de Stripe AFIRMA que el objeto no existe?
 *
 * 🔴 11ª auditoría de Codex (19-sep). Sólo `resource_missing` (404) lo afirma. Un
 * `StripeConnectionError`, un 500 o un timeout dicen «no pude consultarlo», que es una cosa
 * MUY distinta: tratarlos como «no existe» llevaba a crear una suscripción NUEVA teniendo una
 * viva, y a sustituir el vínculo local por el de la nueva — dos suscripciones cobrándole al
 * mismo negocio y la vieja sin que nada local la apuntara.
 */
export function stripeAfirmaQueNoExiste(error: unknown): boolean {
  const e = error as { code?: string; statusCode?: number; type?: string } | null
  if (!e) return false
  return e.code === 'resource_missing' || (e.type === 'StripeInvalidRequestError' && e.statusCode === 404)
}

export async function createTrialSubscriptions(
  customerId: string,
  venueId: string,
  featureCodes: string[],
  trialPeriodDays: number = 5,
  venueName?: string,
  venueSlug?: string,
  paymentMethodId?: string,
): Promise<string[]> {
  logger.info(`🎯 Creating trial subscriptions for venue ${venueId}, features: ${featureCodes.join(', ')}`, {
    paymentMethodId: paymentMethodId || 'default',
  })

  // Get venue info if not provided
  let venueNameToUse = venueName
  let venueSlugToUse = venueSlug
  if (!venueName || !venueSlug) {
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { name: true, slug: true },
    })
    if (venue) {
      venueNameToUse = venueNameToUse || venue.name
      venueSlugToUse = venueSlugToUse || venue.slug
    }
  }

  const features = await prisma.feature.findMany({
    where: {
      code: { in: featureCodes },
      active: true,
      stripePriceId: { not: null },
    },
  })

  if (features.length === 0) {
    throw new Error('No valid features found to subscribe')
  }

  const subscriptionIds: string[] = []
  const errors: { featureCode: string; error: Error }[] = []

  // Create individual subscription for each feature
  for (const feature of features) {
    try {
      // ✅ FIX: Check if VenueFeature already exists with a subscription
      // If it does, reuse the existing subscription instead of creating a new one
      const existingVenueFeature = await prisma.venueFeature.findUnique({
        where: {
          venueId_featureId: {
            venueId,
            featureId: feature.id,
          },
        },
        select: {
          id: true,
          stripeSubscriptionId: true,
        },
      })

      let subscription: Stripe.Subscription

      if (existingVenueFeature?.stripeSubscriptionId) {
        // VenueFeature exists with a subscription - check if it's still valid
        logger.info(`  🔍 Found existing subscription ${existingVenueFeature.stripeSubscriptionId} for feature ${feature.code}`)

        try {
          // Retrieve the existing subscription from Stripe
          const existingSubscription = await stripe.subscriptions.retrieve(existingVenueFeature.stripeSubscriptionId)

          // If subscription is incomplete or past_due, reuse it and attempt payment
          if (existingSubscription.status === 'incomplete' || existingSubscription.status === 'past_due') {
            logger.info(`  ♻️ Reusing existing ${existingSubscription.status} subscription ${existingSubscription.id}`)
            subscription = existingSubscription

            // ✅ FIX: Attempt to charge the latest invoice immediately
            // This triggers webhooks and provides immediate feedback
            try {
              const latestInvoice = existingSubscription.latest_invoice
              if (latestInvoice) {
                const invoiceId = typeof latestInvoice === 'string' ? latestInvoice : latestInvoice.id
                logger.info(`  💳 Attempting to charge invoice ${invoiceId}...`)

                // Attempt payment - this will trigger webhooks (success or failure)
                const paidInvoice = await stripe.invoices.pay(invoiceId)

                if (paidInvoice.status === 'paid') {
                  logger.info(`  ✅ Payment successful! Invoice ${invoiceId} paid`)
                } else {
                  logger.warn(`  ⚠️ Payment incomplete. Invoice ${invoiceId} status: ${paidInvoice.status}`)
                }
              }
            } catch (paymentError: any) {
              // Payment failed - this is expected, webhook will handle it
              logger.warn(`  ❌ Payment failed: ${paymentError.message}`)
              logger.warn(`  📧 User will receive email notification to update payment method`)
              // Don't throw - feature should show as inactive, but record should be created
            }
          } else if (existingSubscription.status === 'canceled') {
            // If canceled, create a new one
            logger.info(`  🆕 Existing subscription canceled, creating new one`)
            subscription = await retry(
              () =>
                stripe.subscriptions.create({
                  customer: customerId,
                  items: [{ price: feature.stripePriceId! }],
                  trial_period_days: trialPeriodDays,
                  description: venueNameToUse ? `${feature.name} - ${venueNameToUse}` : undefined,
                  ...(paymentMethodId && { default_payment_method: paymentMethodId }),
                  metadata: {
                    venueId,
                    featureId: feature.id,
                    featureCode: feature.code,
                    ...(venueNameToUse && { venueName: venueNameToUse }),
                    ...(venueSlugToUse && { venueSlug: venueSlugToUse }),
                  },
                  collection_method: 'charge_automatically',
                  payment_behavior: 'default_incomplete',
                  payment_settings: {
                    save_default_payment_method: 'on_subscription',
                    payment_method_types: ['card'],
                  },
                }),
              {
                retries: 3,
                shouldRetry: shouldRetryStripeError,
                context: 'stripe.createSubscription',
              },
            )
          } else {
            // Active subscription - reuse it
            logger.info(`  ✅ Reusing existing active subscription ${existingSubscription.id}`)
            subscription = existingSubscription
          }
        } catch (error: any) {
          // 🔴 Sólo se crea otra si Stripe AFIRMA que la anterior no existe. Cualquier otro error
          // («no pude consultarla») se propaga: el feature queda sin suscripción y alguien lo
          // reintenta, que es infinitamente mejor que dejar DOS cobrando.
          if (!stripeAfirmaQueNoExiste(error)) {
            logger.error(`  🚨 No se pudo consultar la suscripción ${existingVenueFeature.stripeSubscriptionId}: NO se crea otra`, {
              venueId,
              featureCode: feature.code,
              subscriptionId: existingVenueFeature.stripeSubscriptionId,
              errorType: error?.type,
              errorCode: error?.code,
              statusCode: error?.statusCode,
            })
            throw error
          }
          // Subscription not found in Stripe - create new one
          logger.warn(`  ⚠️ Subscription ${existingVenueFeature.stripeSubscriptionId} not found in Stripe, creating new one`)
          subscription = await retry(
            () =>
              stripe.subscriptions.create({
                customer: customerId,
                items: [{ price: feature.stripePriceId! }],
                trial_period_days: trialPeriodDays,
                description: venueNameToUse ? `${feature.name} - ${venueNameToUse}` : undefined,
                ...(paymentMethodId && { default_payment_method: paymentMethodId }),
                metadata: {
                  venueId,
                  featureId: feature.id,
                  featureCode: feature.code,
                  ...(venueNameToUse && { venueName: venueNameToUse }),
                  ...(venueSlugToUse && { venueSlug: venueSlugToUse }),
                },
                collection_method: 'charge_automatically',
                payment_behavior: 'default_incomplete',
                payment_settings: {
                  save_default_payment_method: 'on_subscription',
                  payment_method_types: ['card'],
                },
              }),
            {
              retries: 3,
              shouldRetry: shouldRetryStripeError,
              context: 'stripe.createSubscription',
            },
          )
        }
      } else {
        // No existing VenueFeature or no subscription - create new subscription
        logger.info(`  🆕 Creating new subscription for feature ${feature.code}`)
        subscription = await retry(
          () =>
            stripe.subscriptions.create({
              customer: customerId,
              items: [
                {
                  price: feature.stripePriceId!,
                },
              ],
              trial_period_days: trialPeriodDays,
              description: venueNameToUse ? `${feature.name} - ${venueNameToUse}` : undefined,
              ...(paymentMethodId && { default_payment_method: paymentMethodId }),
              metadata: {
                venueId,
                featureId: feature.id,
                featureCode: feature.code,
                ...(venueNameToUse && { venueName: venueNameToUse }),
                ...(venueSlugToUse && { venueSlug: venueSlugToUse }),
              },
              // ✅ FIX: Configuración para evitar múltiples invoices en fallos de pago
              // Stripe debe REINTENTAR la misma invoice en lugar de crear nuevas
              collection_method: 'charge_automatically',
              payment_behavior: 'default_incomplete',
              payment_settings: {
                save_default_payment_method: 'on_subscription',
                payment_method_types: ['card'],
              },
            }),
          {
            retries: 3,
            shouldRetry: shouldRetryStripeError,
            context: 'stripe.createSubscription',
          },
        )
      }

      // Create or update VenueFeature record (upsert for renewals)
      // endDate logic:
      // - If trialPeriodDays > 0: set endDate to trial end (trial subscription)
      // - If trialPeriodDays = 0: set endDate to null (paid subscription, no trial)
      const endDate =
        trialPeriodDays > 0
          ? (() => {
              const date = new Date()
              date.setDate(date.getDate() + trialPeriodDays)
              return date
            })()
          : null

      // Active logic:
      // - If trialPeriodDays > 0: active=true (trial, no payment required yet)
      // - If subscription.status is 'active' or 'trialing': active=true (already paid/valid in Stripe)
      // - Otherwise: active=false (wait for payment confirmation via webhook)
      const isActive = trialPeriodDays > 0 || subscription.status === 'active' || subscription.status === 'trialing'

      await prisma.venueFeature.upsert({
        where: {
          venueId_featureId: {
            venueId,
            featureId: feature.id,
          },
        },
        update: {
          // Reactivate existing subscription (renewal after cancellation)
          active: isActive,
          monthlyPrice: feature.monthlyPrice,
          startDate: new Date(),
          endDate,
          stripeSubscriptionId: subscription.id,
          stripePriceId: feature.stripePriceId,
        },
        create: {
          // First-time subscription
          venueId,
          featureId: feature.id,
          active: isActive,
          monthlyPrice: feature.monthlyPrice,
          startDate: new Date(),
          endDate,
          stripeSubscriptionId: subscription.id,
          stripePriceId: feature.stripePriceId,
        },
      })

      subscriptionIds.push(subscription.id)
      if (isActive) {
        const reason = trialPeriodDays > 0 ? 'trial' : subscription.status === 'active' ? 'already paid' : subscription.status
        logger.info(`  ✅ Subscription ${subscription.id} for feature ${feature.code} is ACTIVE (reason: ${reason})`)
      } else {
        logger.info(
          `  ⏳ Created subscription ${subscription.id} for feature ${feature.code} (active=false, waiting for payment confirmation)`,
        )

        // ✅ FIX: For non-trial subscriptions (trialPeriodDays=0), immediately attempt to charge the invoice
        // This prevents the "two-click" issue where users had to subscribe twice to complete payment
        if (trialPeriodDays === 0 && subscription.status === 'incomplete') {
          try {
            const latestInvoice = subscription.latest_invoice
            if (latestInvoice) {
              const invoiceId = typeof latestInvoice === 'string' ? latestInvoice : latestInvoice.id
              logger.info(`  💳 Attempting to charge invoice ${invoiceId} immediately...`)

              // Attempt payment - this triggers webhooks and provides immediate feedback
              const paidInvoice = await stripe.invoices.pay(invoiceId)

              if (paidInvoice.status === 'paid') {
                // ✅ FIX BUG #2: Immediately activate feature instead of waiting for webhook
                // Webhook can have 1-10 second latency, causing "pending" state after successful payment
                await prisma.venueFeature.update({
                  where: {
                    venueId_featureId: {
                      venueId,
                      featureId: feature.id,
                    },
                  },
                  data: {
                    active: true,
                    endDate: null,
                    startDate: new Date(),
                  },
                })
                logger.info(`  ✅ Payment successful! Invoice ${invoiceId} paid, feature IMMEDIATELY activated`)
              } else {
                logger.warn(`  ⚠️ Payment incomplete. Invoice ${invoiceId} status: ${paidInvoice.status}`)
              }
            }
          } catch (paymentError: any) {
            // Payment failed - this is expected for card errors
            // Webhook will handle the failure notification, don't block subscription creation
            logger.warn(`  ❌ Payment failed: ${paymentError.message}`)
            logger.warn(`  📧 User will receive email notification about payment failure`)
            // Don't throw - subscription record should exist even if payment fails
          }
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      logger.error(`  ❌ Error creating subscription for feature ${feature.code}: ${errorMessage}`)
      errors.push({
        featureCode: feature.code,
        error: error instanceof Error ? error : new Error(errorMessage),
      })
    }
  }

  // If any subscriptions failed, throw error with details
  if (errors.length > 0) {
    const errorDetails = errors.map(e => `${e.featureCode}: ${e.error.message}`).join('; ')
    throw new Error(
      `Failed to create ${errors.length} subscription(s): ${errorDetails}. Please ensure you have a valid payment method attached.`,
    )
  }

  return subscriptionIds
}

export interface CreatePlanSubscriptionInput {
  venueId: string
  customerId: string
  paymentMethodId: string
  tierCode: PlanTierCode
  interval: 'monthly' | 'annual'
  trialPeriodDays: number // 0 = pay-now (no trial), 30 = trial
  coupon?: string // e.g. 'INTRO_PRO_3M' (PRO monthly pay-now only)
  venueName?: string
  venueSlug?: string
  /**
   * Llave de idempotencia de Stripe (spec 2026-09-17 § 3.6). Sin ella, el `retry(3)` de abajo
   * puede crear DOS suscripciones cuando el primer intento se pierde en la red — hoy reintentar
   * NO es seguro. Con la llave, el reintento devuelve la misma.
   */
  idempotencyKey?: string
  /**
   * 🔴 `error_if_incomplete` hace que Stripe responda 402 y **no cree** la suscripción cuando el
   * primer cobro falla, en vez de crearla `incomplete`. Sin esto el `upsert` de abajo deja
   * `VenueFeature.active = true` con una tarjeta rechazada: el plan de pago regalado.
   * Sólo tiene sentido con `trialPeriodDays === 0`; con prueba no hay primer cobro.
   */
  paymentBehavior?: 'error_if_incomplete'
  /** Metadatos extra (campaña, intento) para poder RECUPERAR un resultado desconocido. */
  extraMetadata?: Record<string, string>
}

/**
 * Lo que devuelve `createPlanSubscription`.
 *
 * 🔴 `reused` NO es cosmético, y por eso el tipo de retorno dejó de ser un `string`: cuando el
 * venue ya tenía suscripción, esta función devuelve la VIEJA e ignora `coupon`, `interval`,
 * `trialPeriodDays` y la llave de idempotencia. Quien cobra una oferta tiene que poder
 * distinguir «cobré» de «te devolví una suscripción que ya existía»: sin esa distinción,
 * `activate-plan` marcaría la redención APPLIED, consumiría un lugar del cupo y mandaría
 * «recibimos tu pago de $22» con **cero pesos cobrados**.
 */
export interface CreatePlanSubscriptionResult {
  subscriptionId: string
  reused: boolean
}

/**
 * Creates the venue's base-plan subscription (PLAN_PRO or PLAN_PREMIUM). Sibling of
 * createTrialSubscriptions but supports interval (monthly/annual price),
 * pay-now (trialPeriodDays:0), an intro coupon, and Stripe Tax (16% IVA).
 * Idempotent: reuses an existing subscription for the venue+tier if one already exists.
 */
/**
 * Escribe el ACCESO del plan (`VenueFeature`) y lo liga a su suscripción de Stripe.
 *
 * 🔴 Existe separada porque el cobro y el acceso son DOS escrituras, y entre ellas cabe un fallo.
 * `createPlanSubscription` la llama en el camino normal; el camino de RECUPERACIÓN de
 * `activate-plan` la llama también — si Stripe cobró y esta fila no llegó a escribirse, el reintento
 * encuentra la suscripción, se salta la creación, y sin esto el negocio queda **pagando sin acceso**
 * (auditoría de Codex, 18-sep). Los webhooks no lo reparan: buscan la fila y si no está, abandonan.
 *
 * Es idempotente por diseño (`upsert` sobre la llave única venue+feature): llamarla de más no hace
 * daño, y es justo lo que la vuelve segura de invocar en un camino de recuperación.
 */
/**
 * El estado VIGENTE de la suscripción en Stripe.
 *
 * 🔴 Es la única forma honesta de decidir si se activa o se levanta una suspensión. Deducirlo del
 * orden de los webhooks NO funciona, y costó cinco rondas de auditoría descubrir por qué:
 * `VenueFeature.suspendedAt` guarda la hora en que NOSOTROS procesamos el fallo, mientras que
 * `event.created` es la hora de Stripe. Son magnitudes distintas y ninguna precisión lo arregla.
 *
 * ⚠️ Devuelve el estado CRUDO a propósito, sin interpretarlo: quien llama decide qué estado
 * autoriza qué. `active` no significa «no debe nada» (puede haber una factura abierta); significa
 * que la suscripción está corriente. Y `trialing` es acceso legítimo sin pago, que sirve para una
 * primera activación pero no para levantar una suspensión por impago. (6ª auditoría de Codex.)
 *
 * Si Stripe no contesta, LANZA. ⚠️ El reintento NO lo hace Stripe: el controlador del webhook
 * devuelve 200 a propósito (`webhook.controller.ts:92`, «prevent retries»). Quien lo reintenta es
 * el cron `stripe-webhook-reconciliation`, que reprocesa las filas `FAILED` hasta
 * `STRIPE_WEBHOOK_MAX_RETRIES`.
 */
export async function estadoDeLaSuscripcion(subscriptionId: string): Promise<Stripe.Subscription.Status> {
  return (await suscripcionVigente(subscriptionId)).status
}

/**
 * La suscripción VIGENTE, con los datos que hacen falta para escribir el acceso.
 *
 * 🔴 No basta el `status`: el `trial_end` del EVENTO también puede estar vencido. Un aviso atrasado
 * de `trialing` sobre un plan que hoy está pagado volvía a escribir el vencimiento viejo y, si ya
 * había pasado, le quitaba el acceso a quien paga. (8ª auditoría de Codex, 19-sep.)
 */
export async function suscripcionVigente(subscriptionId: string): Promise<{ status: Stripe.Subscription.Status; trialEnd: Date | null }> {
  const suscripcion = await stripe.subscriptions.retrieve(subscriptionId)
  return {
    status: suscripcion.status,
    trialEnd: suscripcion.trial_end ? new Date(suscripcion.trial_end * 1000) : null,
  }
}

export async function asegurarAccesoDelPlan(input: {
  venueId: string
  tierCode: string
  subscriptionId: string
  stripePriceId?: string | null
  trialEnd?: Date | null
}): Promise<void> {
  const feature = await prisma.feature.findFirst({ where: { code: input.tierCode, active: true } })
  if (!feature) throw new Error(`Feature ${input.tierCode} not found or inactive`)

  const trialEnd = input.trialEnd ?? null
  await prisma.venueFeature.upsert({
    where: { venueId_featureId: { venueId: input.venueId, featureId: feature.id } },
    update: {
      active: true,
      stripeSubscriptionId: input.subscriptionId,
      ...(input.stripePriceId ? { stripePriceId: input.stripePriceId } : {}),
      monthlyPrice: feature.monthlyPrice,
      endDate: trialEnd,
      trialEndDate: trialEnd,
      suspendedAt: null,
      paymentFailureCount: 0,
    },
    create: {
      venueId: input.venueId,
      featureId: feature.id,
      active: true,
      monthlyPrice: feature.monthlyPrice,
      stripeSubscriptionId: input.subscriptionId,
      ...(input.stripePriceId ? { stripePriceId: input.stripePriceId } : {}),
      endDate: trialEnd,
      trialEndDate: trialEnd,
    },
  })
}

export async function createPlanSubscription(input: CreatePlanSubscriptionInput): Promise<CreatePlanSubscriptionResult> {
  const feature = await prisma.feature.findFirst({ where: { code: input.tierCode, active: true } })
  if (!feature) throw new Error(`Feature ${input.tierCode} not found or inactive`)

  // Idempotency: reuse existing subscription for this venue+feature.
  const existing = await prisma.venueFeature.findUnique({
    where: { venueId_featureId: { venueId: input.venueId, featureId: feature.id } },
    select: { stripeSubscriptionId: true },
  })
  if (existing?.stripeSubscriptionId) {
    logger.info(`createPlanSubscription: reusing existing sub ${existing.stripeSubscriptionId} for venue ${input.venueId}`)
    // 🔴 Se DICE que se reusó. El llamador decide si eso es legítimo (un reintento idempotente
    // del mismo cobro) o si tiene que negarse a cerrar (una oferta que nunca se cobró).
    return { subscriptionId: existing.stripeSubscriptionId, reused: true }
  }

  const lookupKey = planLookupKey(input.tierCode, input.interval)
  const prices = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 })
  const price = prices.data[0]
  if (!price) throw new Error(`Stripe price not found for lookup_key ${lookupKey} — run scripts/seed-plan-pro.ts`)

  const subscription = await retry(
    () =>
      stripe.subscriptions.create(
        {
          customer: input.customerId,
          items: [{ price: price.id }],
          trial_period_days: input.trialPeriodDays,
          default_payment_method: input.paymentMethodId,
          // No Stripe Tax: IVA is baked into the price (tax_behavior 'inclusive'), so we charge the
          // price as-is and the merchant remits/itemizes the IVA on their own CFDI factura.
          ...(input.coupon ? { discounts: [{ coupon: input.coupon }] } : {}),
          description: input.venueName
            ? `Plan Avoqado ${planLabel(input.tierCode)} - ${input.venueName}`
            : `Plan Avoqado ${planLabel(input.tierCode)}`,
          metadata: {
            venueId: input.venueId,
            featureId: feature.id,
            featureCode: feature.code,
            interval: input.interval,
            ...(input.venueName ? { venueName: input.venueName } : {}),
            ...(input.venueSlug ? { venueSlug: input.venueSlug } : {}),
            ...(input.extraMetadata ?? {}),
          },
          // 🔴 Sólo se manda con trial 0: con prueba gratis no hay primer cobro que pueda fallar.
          ...(input.paymentBehavior && input.trialPeriodDays === 0 ? { payment_behavior: input.paymentBehavior } : {}),
          collection_method: 'charge_automatically',
          payment_settings: { save_default_payment_method: 'on_subscription', payment_method_types: ['card'] },
        },
        // La llave hace que el `retry(3)` de arriba sea seguro: sin ella, un intento perdido en
        // la red y reintentado crea DOS suscripciones y DOS cobros.
        input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : undefined,
      ),
    { retries: 3, shouldRetry: shouldRetryStripeError, context: 'stripe.createPlanSubscription' },
  )

  const trialEnd = input.trialPeriodDays > 0 ? new Date(Date.now() + input.trialPeriodDays * 86400000) : null
  await asegurarAccesoDelPlan({
    venueId: input.venueId,
    tierCode: input.tierCode,
    subscriptionId: subscription.id,
    stripePriceId: price.id,
    trialEnd,
  })

  logger.info(
    `✅ createPlanSubscription: ${subscription.id} (${input.interval}, trial=${input.trialPeriodDays}d) for venue ${input.venueId}`,
  )
  return { subscriptionId: subscription.id, reused: false }
}

/**
 * ¿Este método de pago pertenece al cliente de Stripe de ESTE local? (spec § 3.6, paso 4).
 *
 * 🔴 Sin esta comprobación, un `pm_` de otro cliente se manda como `default_payment_method` y
 * Stripe lo rechaza con un error que no dice nada útil — o peor, si el `pm_` fuera de un cliente
 * que sí controla el atacante, se le cobraría a la tarjeta equivocada.
 */
export async function assertPaymentMethodBelongsToCustomer(
  paymentMethodId: string,
  customerId: string,
): Promise<{ fingerprint: string | null }> {
  const pm = await stripe.paymentMethods.retrieve(paymentMethodId)
  if (pm.customer !== customerId) {
    throw new AppError('Ese método de pago no pertenece a este negocio', 400, true, 'PAYMENT_METHOD_MISMATCH')
  }
  return { fingerprint: pm.card?.fingerprint ?? null }
}

/** Base-plan tier code accepted by the plan checkout/subscription flows. */
export type PlanTierCode = 'PLAN_PRO' | 'PLAN_PREMIUM'

/**
 * Resolve the Stripe price lookup_key for a base-plan tier + interval, e.g.
 * (PLAN_PRO, 'annual') → 'plan_pro_annual', (PLAN_PREMIUM, 'monthly') → 'plan_premium_monthly'.
 * Single source of truth so checkout (and any future flow) stay in lockstep.
 */
export function planLookupKey(tierCode: PlanTierCode, interval: 'monthly' | 'annual'): string {
  const prefix = tierCode === 'PLAN_PREMIUM' ? 'plan_premium' : 'plan_pro'
  const suffix = interval === 'annual' ? 'annual' : 'monthly'
  return `${prefix}_${suffix}`
}

/** Human-friendly plan label for Stripe subscription descriptions. */
function planLabel(tierCode: PlanTierCode): string {
  return tierCode === 'PLAN_PREMIUM' ? 'Premium' : 'Pro'
}

export interface CreatePlanCheckoutSessionInput {
  venueId: string
  customerId: string
  interval: 'monthly' | 'annual'
  successUrl: string
  cancelUrl: string
  /** Base-plan tier to subscribe to. Defaults to PLAN_PRO for back-compat. */
  tierCode?: PlanTierCode
  venueName?: string
  venueSlug?: string
}

/**
 * Creates a Stripe Checkout Session (mode: 'subscription') for the venue's
 * base plan (PLAN_PRO or PLAN_PREMIUM) so the merchant can self-serve subscribe
 * via Stripe's hosted checkout. Resolves the price the same way createPlanSubscription
 * does, via lookup_key (plan_pro_* / plan_premium_*, monthly|annual). IVA is baked into
 * the price (tax_behavior 'inclusive'), so Stripe Tax is intentionally NOT enabled.
 * Returns the hosted-checkout URL the frontend redirects the browser to.
 */
export async function createPlanCheckoutSession(input: CreatePlanCheckoutSessionInput): Promise<string> {
  const tierCode: PlanTierCode = input.tierCode ?? 'PLAN_PRO'

  const feature = await prisma.feature.findFirst({ where: { code: tierCode, active: true } })
  if (!feature) throw new Error(`Feature ${tierCode} not found or inactive`)

  const lookupKey = planLookupKey(tierCode, input.interval)
  const prices = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 })
  const price = prices.data[0]
  if (!price) throw new Error(`Stripe price not found for lookup_key ${lookupKey} — run scripts/seed-plan-pro.ts`)

  const description = input.venueName ? `Plan Avoqado ${planLabel(tierCode)} - ${input.venueName}` : `Plan Avoqado ${planLabel(tierCode)}`

  const session = await retry(
    () =>
      stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: input.customerId,
        line_items: [{ price: price.id, quantity: 1 }],
        allow_promotion_codes: true,
        subscription_data: {
          description,
          metadata: {
            venueId: input.venueId,
            tierCode,
            featureId: feature.id,
            featureCode: feature.code,
            interval: input.interval,
            ...(input.venueName ? { venueName: input.venueName } : {}),
            ...(input.venueSlug ? { venueSlug: input.venueSlug } : {}),
          },
        },
        metadata: {
          venueId: input.venueId,
          tierCode,
          interval: input.interval,
        },
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
      }),
    { retries: 3, shouldRetry: shouldRetryStripeError, context: 'stripe.createPlanCheckoutSession' },
  )

  if (!session.url) throw new Error('Stripe Checkout Session created without a URL')

  logger.info(`✅ createPlanCheckoutSession: ${session.id} (${tierCode}, ${input.interval}) for venue ${input.venueId}`)
  return session.url
}

export interface FulfillPlanCheckoutResult {
  venueId: string
  featureId: string
  featureCode: string
  subscriptionId: string
  endDate: Date | null
}

/**
 * Fulfills a completed base-plan Stripe Checkout Session (mode: 'subscription'),
 * for either tier (PLAN_PRO or PLAN_PREMIUM).
 *
 * The plan checkout (createPlanCheckoutSession) hands Stripe the subscription to create,
 * but nothing creates the local VenueFeature tier row — `handleSubscriptionUpdated`
 * keys off an EXISTING VenueFeature by stripeSubscriptionId and returns early when none
 * exists. This bridges that gap: on `checkout.session.completed` we look up the subscription
 * that Stripe just created and upsert the VenueFeature for the tier carried in the session
 * metadata, mirroring the exact upsert shape of `createPlanSubscription` so both code paths
 * converge on the same row.
 *
 * Idempotent: uses `prisma.venueFeature.upsert` on the (venueId, featureId) unique key, so a
 * re-delivered webhook (Stripe retries) is a no-op update, never a duplicate.
 *
 * Returns the resulting row identifiers so the webhook layer can broadcast `subscription.activated`,
 * or `null` when it can't be fulfilled (e.g. missing subscription id) — caller logs + skips.
 */
export async function fulfillPlanCheckout(session: Stripe.Checkout.Session): Promise<FulfillPlanCheckoutResult | null> {
  const venueId = session.metadata?.venueId
  if (!venueId) {
    logger.warn('⚠️ fulfillPlanCheckout: session has no metadata.venueId — skipping', { sessionId: session.id })
    return null
  }

  // Resolve the tier from the session metadata (set by createPlanCheckoutSession). Default to
  // PLAN_PRO for back-compat with any in-flight session created before tier was threaded through.
  const tierCode: PlanTierCode = session.metadata?.tierCode === 'PLAN_PREMIUM' ? 'PLAN_PREMIUM' : 'PLAN_PRO'

  // On a completed subscription-mode session, `subscription` is the created subscription id (string).
  let subscriptionId = typeof session.subscription === 'string' ? session.subscription : (session.subscription?.id ?? null)
  if (!subscriptionId) {
    // Defensive: re-fetch the session expanding the subscription in case it wasn't inlined.
    const full = await retry(() => stripe.checkout.sessions.retrieve(session.id, { expand: ['subscription'] }), {
      retries: 3,
      shouldRetry: shouldRetryStripeError,
      context: 'stripe.fulfillPlanCheckout.retrieveSession',
    })
    subscriptionId = typeof full.subscription === 'string' ? full.subscription : (full.subscription?.id ?? null)
  }
  if (!subscriptionId) {
    logger.warn('⚠️ fulfillPlanCheckout: completed session has no subscription id — skipping', {
      sessionId: session.id,
      venueId,
    })
    return null
  }

  const feature = await prisma.feature.findFirst({ where: { code: tierCode, active: true } })
  if (!feature) throw new Error(`Feature ${tierCode} not found or inactive`)

  // Pull the real price + trial state from the subscription Stripe created so monthlyPrice/
  // stripePriceId/endDate reflect what the customer actually subscribed to.
  // 🔴 El registro se lee ANTES de consultar Stripe, y NO al revés. Con el orden invertido el CAS
  // vigilaba la ventana equivocada: una cancelación que llegaba entre el `retrieve` y esta lectura
  // ya estaba escrita cuando leíamos, el CAS coincidía y la reactivábamos (medido por Codex,
  // 19-sep). Leyendo primero, cualquier escritura ajena posterior hace fallar el CAS, y el estado
  // que trae Stripe es por construcción más nuevo que lo que comparamos.
  const previo = await prisma.venueFeature.findUnique({
    where: { venueId_featureId: { venueId, featureId: feature.id } },
    select: { id: true, active: true, stripeSubscriptionId: true, updatedAt: true },
  })

  const subscription = await retry(() => stripe.subscriptions.retrieve(subscriptionId as string), {
    retries: 3,
    shouldRetry: shouldRetryStripeError,
    context: 'stripe.fulfillPlanCheckout.retrieveSubscription',
  })
  // 🔴 El estado VIGENTE decide si se concede el acceso, no el hecho de que llegara un
  // `checkout.session.completed` (11ª auditoría de Codex, 19-sep). Stripe no ordena las entregas y
  // este manejador se reprocesa, así que un aviso tardío sobre una suscripción ya muerta devolvía
  // el plan completo. Misma familia que las auditorías 7ª-10ª cerraron en `subscription.updated`.
  //
  // 🔑 Y la ESCRITURA es tan importante como la decisión. Entre consultar Stripe y escribir cabe
  // otro webhook: una cancelación podía desactivar el registro y el `upsert` ciego lo reactivaba.
  // Por eso todas las escrituras de aquí abajo son CAS sobre `updatedAt`, que Prisma mueve en CADA
  // escritura —incluso cuando reescribe el MISMO valor, que es el caso que una comparación por
  // campos NO detecta (Codex, 19-sep)—: si alguien tocó la fila, no escribimos y se reintenta.
  const stripePriceId = subscription.items?.data?.[0]?.price?.id ?? null

  if (subscription.status !== 'active' && subscription.status !== 'trialing') {
    // Terminal (`canceled`, `incomplete_expired`): no hay nada que esperar, y reintentar sólo
    // gastaría los 5 intentos del cron.
    const recuperable =
      subscription.status === 'past_due' ||
      subscription.status === 'unpaid' ||
      subscription.status === 'incomplete' ||
      subscription.status === 'paused' // `paused` se reanuda (pause_collection): NO es terminal
    if (!recuperable) {
      logger.warn('🚨 fulfillPlanCheckout: la suscripción está en un estado terminal — NO se concede acceso', {
        sessionId: session.id,
        venueId,
        subscriptionId: subscription.id,
        status: subscription.status,
        tierCode,
      })
      return null
    }

    // Recuperable: el cobro todavía puede prosperar. NO se concede acceso, pero se guarda el
    // VÍNCULO — sin él, `customer.subscription.updated` e `invoice.payment_succeeded` no
    // encuentran el registro y el cliente que paga tarde se queda sin plan para siempre.
    //
    // 🔴 Y NO se lanza: lanzar consumía los 5 reintentos del cron en ~15-20 min, así que quien
    // pagaba dos horas después ya no tenía rescate (14ª pasada de Codex). El vínculo guardado no
    // caduca; el rescate llega cuando llegue.
    if (previo?.active) {
      logger.warn('🚨 fulfillPlanCheckout: el venue ya tiene el plan ACTIVO — no se toca', {
        venueId,
        tierCode,
        suscripcionViva: previo.stripeSubscriptionId,
        suscripcionDelCheckout: subscription.id,
        status: subscription.status,
      })
      return null
    }
    if (previo?.stripeSubscriptionId && previo.stripeSubscriptionId !== subscription.id) {
      // Reapuntar el vínculo le quitaría el rescate a la OTRA suscripción, que puede estar
      // igualmente a punto de pagar.
      logger.warn('🚨 fulfillPlanCheckout: el registro ya apunta a otra suscripción — no se sustituye', {
        venueId,
        tierCode,
        vinculoActual: previo.stripeSubscriptionId,
        suscripcionDelCheckout: subscription.id,
      })
      return null
    }

    logger.warn('🚨 fulfillPlanCheckout: la suscripción no está vigente todavía — se guarda el vínculo sin conceder acceso', {
      sessionId: session.id,
      venueId,
      subscriptionId: subscription.id,
      status: subscription.status,
      tierCode,
    })

    if (previo) {
      const { count } = await prisma.venueFeature.updateMany({
        where: { id: previo.id, updatedAt: previo.updatedAt },
        data: { stripeSubscriptionId: subscription.id, stripePriceId },
      })
      // 🔴 Un `count: 0` NO se puede tragar aquí: sin vínculo guardado, el barrido
      // `plan-access-reconciliation` no ve esta fila y el cliente que pague después se queda sin
      // plan. Se lanza para que el evento quede FAILED y el cron lo reprocese con lectura fresca
      // (Codex, 19-sep: «termina sin error y el barrido excluye esa fila»).
      if (count === 0) {
        logger.warn('🚨 fulfillPlanCheckout: no se pudo guardar el vínculo (la fila cambió) — se reintentará', {
          sessionId: session.id,
          venueId,
          subscriptionId: subscription.id,
          tierCode,
        })
        throw new Error(`fulfillPlanCheckout: no se pudo guardar el vínculo de ${venueId}/${tierCode}; se reintentará`)
      }
    } else {
      try {
        await prisma.venueFeature.create({
          data: {
            venueId,
            featureId: feature.id,
            active: false,
            monthlyPrice: feature.monthlyPrice,
            stripeSubscriptionId: subscription.id,
            stripePriceId,
          },
        })
      } catch (error: any) {
        if (error?.code !== 'P2002') throw error
        // 🔴 Otro evento creó el registro mientras tanto. NO se puede dar por bueno en silencio:
        // si ese registro quedó SIN el vínculo, el barrido no ve esta fila y el cliente que pague
        // después se queda sin plan (Codex, 19-sep). Se reintenta para releer y decidir de nuevo.
        logger.warn('🚨 fulfillPlanCheckout: otro evento creó el registro a la vez — se reintentará', {
          sessionId: session.id,
          venueId,
          subscriptionId: subscription.id,
          tierCode,
        })
        throw new Error(`fulfillPlanCheckout: el registro de ${venueId}/${tierCode} lo creó otro evento; se reintentará`)
      }
    }
    return null
  }

  // trial_end is unix-seconds while the subscription is trialing; mirrors createPlanSubscription's
  // endDate/trialEndDate semantics (not-null = trial window, null = paid subscription).
  const trialEnd = subscription.status === 'trialing' && subscription.trial_end ? new Date(subscription.trial_end * 1000) : null

  const concesion = {
    active: true,
    stripeSubscriptionId: subscription.id,
    stripePriceId,
    monthlyPrice: feature.monthlyPrice,
    endDate: trialEnd,
    trialEndDate: trialEnd,
    suspendedAt: null,
    paymentFailureCount: 0,
  }

  if (previo) {
    const { count } = await prisma.venueFeature.updateMany({
      where: { id: previo.id, updatedAt: previo.updatedAt },
      data: concesion,
    })
    if (count === 0) {
      // El registro cambió entre la consulta a Stripe y esta escritura (típicamente una
      // cancelación que llegó en medio). No se pisa: el evento queda FAILED y el cron lo
      // reprocesa leyendo el estado fresco.
      logger.warn('🚨 fulfillPlanCheckout: el registro cambió mientras consultábamos Stripe — se reintentará', {
        sessionId: session.id,
        venueId,
        subscriptionId: subscription.id,
        tierCode,
      })
      throw new Error(`fulfillPlanCheckout: el registro de ${venueId}/${tierCode} cambió bajo nosotros; se reintentará`)
    }
  } else {
    try {
      await prisma.venueFeature.create({
        data: { venueId, featureId: feature.id, ...concesion },
      })
    } catch (error: any) {
      if (error?.code !== 'P2002') throw error
      logger.warn('🚨 fulfillPlanCheckout: otro evento creó el registro primero — se reintentará', {
        sessionId: session.id,
        venueId,
        subscriptionId: subscription.id,
        tierCode,
      })
      throw new Error(`fulfillPlanCheckout: el registro de ${venueId}/${tierCode} lo creó otro evento; se reintentará`)
    }
  }

  logger.info(`✅ fulfillPlanCheckout: ${tierCode} activated for venue ${venueId} (sub ${subscription.id}, trial=${!!trialEnd})`)

  return {
    venueId,
    featureId: feature.id,
    featureCode: feature.code,
    subscriptionId: subscription.id,
    endDate: trialEnd,
  }
}

/**
 * Convert trial to paid subscription
 * Called when trial period ends successfully
 *
 * @param venueFeatureId - VenueFeature ID
 */
export async function convertTrialToPaid(venueFeatureId: string): Promise<void> {
  const venueFeature = await prisma.venueFeature.findUnique({
    where: { id: venueFeatureId },
    include: { feature: true },
  })

  if (!venueFeature) {
    throw new Error(`VenueFeature ${venueFeatureId} not found`)
  }

  // Set endDate to null (paid subscription)
  await prisma.venueFeature.update({
    where: { id: venueFeatureId },
    data: {
      endDate: null, // null = paid subscription
      active: true,
    },
  })

  logger.info(`✅ Converted trial to paid subscription for VenueFeature ${venueFeatureId}`)
}

/**
 * Cancel subscription (with retry)
 *
 * @param subscriptionId - Stripe subscription ID
 */
export async function cancelSubscription(subscriptionId: string): Promise<void> {
  await retry(() => stripe.subscriptions.cancel(subscriptionId), {
    retries: 3,
    shouldRetry: shouldRetryStripeError,
    context: 'stripe.cancelSubscription',
  })

  // Deactivate VenueFeature
  await prisma.venueFeature.updateMany({
    where: { stripeSubscriptionId: subscriptionId },
    data: { active: false },
  })

  logger.info(`✅ Canceled subscription ${subscriptionId}`)
}

/**
 * Flip cancel_at_period_end on a subscription WITHOUT canceling immediately.
 * This is the ONLY supported way to cancel/reactivate the PLAN_PRO base plan:
 * `cancel=true` schedules cancellation at period end (venue stays entitled until
 * current_period_end); `cancel=false` undoes a scheduled cancellation.
 * Unlike cancelSubscription(), this does NOT touch the VenueFeature row.
 *
 * @param subscriptionId - Stripe subscription ID
 * @param cancel - true to schedule cancel at period end, false to reactivate
 * @returns the updated Stripe subscription
 */
export async function setSubscriptionCancelAtPeriodEnd(subscriptionId: string, cancel: boolean): Promise<Stripe.Subscription> {
  const updated = await retry(() => stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: cancel }), {
    retries: 3,
    shouldRetry: shouldRetryStripeError,
    context: 'stripe.setSubscriptionCancelAtPeriodEnd',
  })
  logger.info(`✅ Set cancel_at_period_end=${cancel} on subscription ${subscriptionId}`)
  return updated
}

/**
 * Whether a Stripe subscription currently carries an active discount (coupon/promotion
 * code). Used as the anti-abuse gate for the retention offer: a venue that already has a
 * discount on its base-plan subscription cannot stack another retention offer. Reads the
 * single-discount `discount` field AND the newer `discounts` array (Stripe SDK v19 exposes
 * both depending on how the discount was applied), so either representation counts.
 *
 * Tolerant: a Stripe read failure throws (caller decides), but a subscription with no
 * discount returns false.
 *
 * @param subscriptionId - Stripe subscription ID
 */
export async function subscriptionHasActiveDiscount(subscriptionId: string): Promise<boolean> {
  const sub = await retry(() => stripe.subscriptions.retrieve(subscriptionId), {
    retries: 3,
    shouldRetry: shouldRetryStripeError,
    context: 'stripe.subscriptionHasActiveDiscount',
  })
  // SDK v19 may surface a single `discount` object and/or a `discounts` array.
  const single = (sub as any).discount
  const list = (sub as any).discounts as unknown[] | undefined
  return Boolean(single) || (Array.isArray(list) && list.length > 0)
}

/**
 * Apply a coupon to an existing subscription (the retention "stay" offer). Uses the
 * `discounts` API the codebase already uses for createPlanSubscription's intro coupon, so
 * the discount applies on top of the IVA-inclusive price. Does NOT touch the VenueFeature
 * row — the venue keeps the same plan, just at a reduced price for the coupon's duration.
 *
 * Callers MUST gate with {@link subscriptionHasActiveDiscount} first (anti-abuse): Stripe
 * would otherwise silently replace any existing discount.
 *
 * @param subscriptionId - Stripe subscription ID
 * @param coupon - Stripe coupon id (e.g. 'RETENTION_30_3M')
 * @returns the updated Stripe subscription
 */
export async function applySubscriptionCoupon(subscriptionId: string, coupon: string): Promise<Stripe.Subscription> {
  const updated = await retry(() => stripe.subscriptions.update(subscriptionId, { discounts: [{ coupon }] }), {
    retries: 3,
    shouldRetry: shouldRetryStripeError,
    context: 'stripe.applySubscriptionCoupon',
  })
  logger.info(`✅ Applied coupon ${coupon} to subscription ${subscriptionId}`)
  return updated
}

/**
 * Pause collection on a subscription (the retention "pause" offer): Stripe stops generating
 * payable invoices while the subscription stays alive, so the venue keeps its data/config.
 * Uses behavior 'mark_uncollectible' (invoices are still created but immediately marked
 * uncollectible — no charge, no dunning). `resumesAt` is a unix-seconds resume timestamp;
 * Stripe auto-resumes collection then. Does NOT touch the VenueFeature row.
 *
 * @param subscriptionId - Stripe subscription ID
 * @param resumesAt - Date when collection auto-resumes
 * @returns the updated Stripe subscription
 */
export async function pauseSubscriptionCollection(subscriptionId: string, resumesAt: Date): Promise<Stripe.Subscription> {
  const updated = await retry(
    () =>
      stripe.subscriptions.update(subscriptionId, {
        pause_collection: { behavior: 'mark_uncollectible', resumes_at: Math.floor(resumesAt.getTime() / 1000) },
      }),
    {
      retries: 3,
      shouldRetry: shouldRetryStripeError,
      context: 'stripe.pauseSubscriptionCollection',
    },
  )
  logger.info(`✅ Paused collection on subscription ${subscriptionId} until ${resumesAt.toISOString()}`)
  return updated
}

/**
 * Create a single-use Stripe promotion code for a coupon with a redemption deadline. Used by
 * the cancellation confirmation email's win-back CTA: the merchant gets a human-redeemable
 * code (not a raw coupon id) that EXPIRES, creating urgency. `expiresAt` maps to Stripe's
 * `expires_at` (unix seconds). Returns the generated code string (e.g. 'REGRESA-AB12CD') and
 * the promotion-code id.
 *
 * Tolerant by contract for the email flow: callers wrap in try/catch and fall back to a
 * deadline-only message if code creation fails (the coupon itself still works in Checkout's
 * promo field).
 *
 * @param coupon - Stripe coupon id (e.g. 'WINBACK_30_1M')
 * @param expiresAt - Date the promotion code stops being redeemable
 * @param codePrefix - Optional human-readable prefix for the generated code
 */
export async function createWinbackPromotionCode(
  coupon: string,
  expiresAt: Date,
  codePrefix = 'REGRESA',
): Promise<{ code: string; promotionCodeId: string }> {
  // Stripe promotion-code `code` must be unique per account; suffix with a short random token.
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase()
  const code = `${codePrefix}-${suffix}`
  const promo = await retry(
    () =>
      stripe.promotionCodes.create({
        // SDK v19: the coupon is nested under `promotion` (type 'coupon'), not a top-level field.
        promotion: { type: 'coupon', coupon },
        code,
        max_redemptions: 1,
        expires_at: Math.floor(expiresAt.getTime() / 1000),
      }),
    {
      retries: 3,
      shouldRetry: shouldRetryStripeError,
      context: 'stripe.createWinbackPromotionCode',
    },
  )
  logger.info(`✅ Created win-back promotion code ${promo.code} (coupon ${coupon}, expires ${expiresAt.toISOString()})`)
  return { code: promo.code ?? code, promotionCodeId: promo.id }
}

/**
 * Retrieve a subscription and return the typed summary the plan endpoint needs.
 * Stripe SDK v19 omits current_period_end / cancel_at_period_end on the Subscription
 * type even though the API returns them — cast like the rest of the codebase
 * (see stripe.webhook.service.ts:32, plan-renewal-reminder.job.ts:102).
 *
 * @param subscriptionId - Stripe subscription ID
 */
export async function retrievePlanSubscription(subscriptionId: string): Promise<{
  status: string
  cancelAtPeriodEnd: boolean
  currentPeriodEnd: Date | null
  /** Subscription creation timestamp (Stripe `created`, unix seconds → Date) — used for tenure/anti-abuse checks. */
  createdAt: Date | null
  /** Whether the subscription currently carries an active discount (single `discount` or `discounts[]`). */
  hasActiveDiscount: boolean
  interval: 'month' | 'year' | null
  grossAmountCents: number | null
}> {
  const sub = await retry(() => stripe.subscriptions.retrieve(subscriptionId), {
    retries: 3,
    shouldRetry: shouldRetryStripeError,
    context: 'stripe.retrievePlanSubscription',
  })
  const periodEndRaw = (sub as any).current_period_end as number | undefined
  const createdRaw = (sub as any).created as number | undefined
  const rawInterval = sub.items.data[0]?.price.recurring?.interval
  // SDK v19 may surface a single `discount` object and/or a `discounts` array (see subscriptionHasActiveDiscount).
  const singleDiscount = (sub as any).discount
  const discountList = (sub as any).discounts as unknown[] | undefined
  return {
    status: sub.status,
    cancelAtPeriodEnd: Boolean((sub as any).cancel_at_period_end),
    currentPeriodEnd: periodEndRaw ? new Date(periodEndRaw * 1000) : null,
    createdAt: createdRaw ? new Date(createdRaw * 1000) : null,
    hasActiveDiscount: Boolean(singleDiscount) || (Array.isArray(discountList) && discountList.length > 0),
    interval: rawInterval === 'year' ? 'year' : rawInterval === 'month' ? 'month' : null,
    grossAmountCents: sub.items.data[0]?.price.unit_amount ?? null,
  }
}

/**
 * Update payment method for customer (with retry)
 *
 * @param customerId - Stripe customer ID
 * @param paymentMethodId - New payment method ID
 */
export async function updatePaymentMethod(customerId: string, paymentMethodId: string): Promise<void> {
  // Attach payment method to customer
  await retry(() => stripe.paymentMethods.attach(paymentMethodId, { customer: customerId }), {
    retries: 3,
    shouldRetry: shouldRetryStripeError,
    context: 'stripe.attachPaymentMethod',
  })

  // Set as default payment method
  await retry(
    () =>
      stripe.customers.update(customerId, {
        invoice_settings: {
          default_payment_method: paymentMethodId,
        },
      }),
    {
      retries: 3,
      shouldRetry: shouldRetryStripeError,
      context: 'stripe.setDefaultPaymentMethod',
    },
  )

  logger.info(`✅ Updated payment method for customer ${customerId}`)
}

/**
 * Create Stripe Customer Portal session
 * Generates a secure URL to Stripe's hosted billing portal where customers can:
 * - View subscription details
 * - Update payment methods
 * - View invoice history
 * - Cancel subscriptions
 *
 * @param customerId - Stripe customer ID
 * @param returnUrl - URL to redirect user after they're done
 * @returns Session URL for the customer portal
 */
export async function createCustomerPortalSession(customerId: string, returnUrl: string): Promise<string> {
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  })

  logger.info(`✅ Created customer portal session for customer ${customerId}`)
  return session.url
}

/**
 * Create payment intent for trial setup
 * Used to collect payment method upfront before trial
 *
 * @param customerId - Stripe customer ID
 * @param amount - Amount in cents (usually $0 or $1 for verification)
 * @returns Payment intent client secret
 */
export async function createTrialSetupIntent(customerId: string): Promise<string> {
  const setupIntent = await stripe.setupIntents.create({
    customer: customerId,
    payment_method_types: ['card'],
  })

  logger.info(`✅ Created setup intent ${setupIntent.id} for customer ${customerId}`)
  return setupIntent.client_secret!
}

/**
 * Get Stripe invoices for a customer
 * Fetches all invoices (paid, open, draft, etc.) for billing history
 *
 * @param customerId - Stripe customer ID
 * @param limit - Maximum number of invoices to return (default: 100)
 * @returns Array of Stripe invoices
 */
export async function getCustomerInvoices(
  customerId: string,
  options?: {
    limit?: number
    starting_after?: string
  },
): Promise<{ invoices: Stripe.Invoice[]; hasMore: boolean; lastInvoiceId?: string }> {
  const limit = options?.limit || 10 // Default to 10 for better UX
  const invoices = await stripe.invoices.list({
    customer: customerId,
    limit: limit + 1, // Fetch one extra to check if there are more
    ...(options?.starting_after && { starting_after: options.starting_after }),
  })

  // Check if there are more invoices
  const hasMore = invoices.data.length > limit
  const resultInvoices = hasMore ? invoices.data.slice(0, limit) : invoices.data
  const lastInvoiceId = resultInvoices.length > 0 ? resultInvoices[resultInvoices.length - 1].id : undefined

  logger.info(`✅ Retrieved ${resultInvoices.length} invoices for customer ${customerId}`, {
    hasMore,
    requestedLimit: limit,
  })

  return {
    invoices: resultInvoices,
    hasMore,
    lastInvoiceId,
  }
}

/**
 * Get invoice PDF download URL
 * Retrieves the invoice_pdf URL from Stripe for downloading
 *
 * @param invoiceId - Stripe invoice ID
 * @returns Invoice PDF URL
 */
export async function getInvoicePdfUrl(invoiceId: string): Promise<string> {
  const invoice = await stripe.invoices.retrieve(invoiceId)

  if (!invoice.invoice_pdf) {
    throw new Error(`Invoice ${invoiceId} does not have a PDF available`)
  }

  logger.info(`✅ Retrieved PDF URL for invoice ${invoiceId}`)
  return invoice.invoice_pdf
}

/**
 * Preview proration for subscription change
 * Shows how much the customer will be charged/credited when changing subscription
 *
 * @param subscriptionId - Stripe subscription ID
 * @param newPriceId - New Stripe price ID to change to
 * @returns Proration details with amount and description
 */
export async function previewSubscriptionProration(
  subscriptionId: string,
  newPriceId: string,
): Promise<{
  prorationAmount: number
  currency: string
  nextInvoiceAmount: number
  immediateCharge: boolean
  description: string
}> {
  const subscription = await stripe.subscriptions.retrieve(subscriptionId)
  const currentItem = subscription.items.data[0]
  if (!currentItem) throw new Error('Subscription has no items')

  const newPrice = await stripe.prices.retrieve(newPriceId)
  const currency = newPrice.currency

  // 🔴 El importe lo dice STRIPE, no una resta local (auditoría de Codex, 18-sep, hallazgo #10).
  //
  // El cálculo anterior era `(precioNuevo − precioViejo) × fracción de periodo restante`, y por
  // tanto ignoraba el CUPÓN de la campaña, el saldo del cliente, las facturas impagadas, los
  // cambios de intervalo y los impuestos. Medido por el auditor: pasar de PRO con POS22 a un
  // producto de $500 a mitad de mes estimaba ~$329.42 de crédito sobre un mes en que el cliente
  // pagó $22. Y la ejecución real (`updateSubscriptionPrice`, con `always_invoice`) usa además
  // otro instante y la aritmética completa de Stripe: dos números distintos por construcción.
  try {
    const preview = await stripe.invoices.createPreview({
      customer: typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id,
      subscription: subscriptionId,
      subscription_details: {
        items: [{ id: currentItem.id, price: newPriceId }],
        proration_behavior: 'always_invoice',
      },
    } as never)

    // 🔴 `amount_due` NUNCA es negativo: cuando el cambio genera saldo a favor Stripe lo clampa a 0
    // y el crédito viaja en `total` (acaba en el balance del cliente). Leer sólo `amount_due` dejaba
    // la rama del crédito como código muerto y le decía «sin cargo hoy» a quien baja de plan.
    // (Segunda auditoría de Codex, 18-sep.)
    // Lo que se COBRA hoy es `amount_due`, y punto. `total` sólo manda cuando es un CRÉDITO
    // (negativo): ahí Stripe clampa `amount_due` a 0 y el saldo a favor viaja en `total`.
    //
    // 🔴 Los dos errores que ya se cometieron aquí, uno en cada dirección:
    //   · leer SÓLO `amount_due` dejaba la rama del crédito muerta y decía «sin cargo» a quien
    //     baja de plan y tiene saldo a favor (2ª auditoría, 18-sep);
    //   · preferir `total` cuando `amount_due` es 0 anunciaba «Hoy pagas $42.00» a quien NO se le
    //     va a cobrar nada porque su saldo cubre el ajuste (4ª auditoría, 19-sep).
    const p = preview as { amount_due?: number; total?: number }
    const aCobrarHoy = p.amount_due ?? 0
    const total = p.total ?? 0
    const debido = aCobrarHoy > 0 ? aCobrarHoy : total < 0 ? total : 0
    const immediateCharge = debido > 0
    // ⚠️ `amount_due: 0` con `total` positivo NO siempre es saldo a favor: Stripe también difiere
    // al siguiente ciclo un importe que queda debajo de su mínimo facturable. Desde aquí no se
    // distinguen, así que el texto es NEUTRO en vez de afirmar un saldo que puede no existir.
    // (Quinta auditoría de Codex, 19-sep.)
    const sinCobroHoy = aCobrarHoy === 0 && total > 0
    const description = immediateCharge
      ? `Hoy pagas ${(debido / 100).toFixed(2)} ${currency.toUpperCase()} por el cambio`
      : debido < 0
        ? `Se te acredita ${(Math.abs(debido) / 100).toFixed(2)} ${currency.toUpperCase()}`
        : sinCobroHoy
          ? 'Sin cargo hoy: el ajuste se aplica a tu próxima factura'
          : 'Sin cargo hoy: el cambio entra en tu próximo ciclo'

    logger.info('💰 Vista previa de prorrateo pedida a Stripe', { subscriptionId, newPriceId, debido })

    return {
      prorationAmount: debido,
      currency,
      nextInvoiceAmount: newPrice.unit_amount || 0,
      immediateCharge,
      description,
    }
  } catch (error) {
    // 🔴 Si Stripe no puede contestar, se DICE. Un número inventado en la pantalla que decide un
    // cambio de plan es peor que admitir que no se pudo calcular: el cliente aceptaría un cargo
    // que nadie le va a hacer, o rechazaría un cambio por un crédito que no existe.
    logger.warn('No se pudo obtener la vista previa de prorrateo de Stripe', {
      subscriptionId,
      newPriceId,
      error: error instanceof Error ? error.message : String(error),
    })
    // 🔴 Y se dice LANZANDO, no devolviendo ceros. Un objeto con `prorationAmount: 0` e
    // `immediateCharge: false` es una cotización VÁLIDA para quien lee los números —el dashboard,
    // una app, un script—: dice «este cambio no te cuesta nada». Y no es cierto: confirmar ejecuta
    // igual `updateSubscriptionPrice` con `always_invoice`, que sí puede cobrar. El aviso en
    // `description` es texto y no protege a nadie que no lo lea.
    // (Auditoría de riesgo de despliegue de Codex, 19-sep, hallazgo P2.)
    throw new AppError(
      'No pudimos calcular el ajuste ahora. Inténtalo de nuevo en unos minutos.',
      503,
      true,
      'PRORATION_PREVIEW_UNAVAILABLE',
    )
  }
}

/**
 * Update subscription to a new price with proration
 *
 * @param subscriptionId - Stripe subscription ID
 * @param newPriceId - New Stripe price ID
 * @returns Updated subscription
 */
export async function updateSubscriptionPrice(subscriptionId: string, newPriceId: string): Promise<Stripe.Subscription> {
  const subscription = await stripe.subscriptions.retrieve(subscriptionId)

  if (!subscription.items.data[0]) {
    throw new Error('Subscription has no items')
  }

  const currentItem = subscription.items.data[0]

  logger.info(`🔄 Updating subscription ${subscriptionId} to new price ${newPriceId}`)

  const updatedSubscription = await stripe.subscriptions.update(subscriptionId, {
    items: [
      {
        id: currentItem.id,
        price: newPriceId,
      },
    ],
    proration_behavior: 'always_invoice',
    proration_date: Math.floor(Date.now() / 1000),
  })

  logger.info(`✅ Subscription updated successfully`, {
    subscriptionId,
    newPriceId,
    status: updatedSubscription.status,
  })

  return updatedSubscription
}

/**
 * Retry payment for a failed invoice
 * Uses Stripe's invoice.pay() API to manually retry payment with the customer's default payment method
 *
 * @param invoiceId - Stripe invoice ID
 * @returns Paid invoice object
 * @throws Error if invoice is already paid or cannot be paid
 */
export async function retryInvoicePayment(invoiceId: string): Promise<Stripe.Invoice> {
  // First retrieve the invoice to check its status
  const invoice = await stripe.invoices.retrieve(invoiceId)

  // Validate invoice can be paid
  if (invoice.status === 'paid') {
    throw new Error(`Invoice ${invoiceId} is already paid`)
  }

  if (invoice.status !== 'open' && invoice.status !== 'uncollectible') {
    throw new Error(`Invoice ${invoiceId} cannot be paid (status: ${invoice.status})`)
  }

  logger.info(`🔄 Retrying payment for invoice ${invoiceId}`, {
    amount: invoice.amount_due,
    currency: invoice.currency,
    attemptCount: invoice.attempt_count,
  })

  // Attempt to pay the invoice
  const paidInvoice = await stripe.invoices.pay(invoiceId)

  logger.info(`✅ Invoice payment successful`, {
    invoiceId,
    status: paidInvoice.status,
    amountPaid: paidInvoice.amount_paid,
  })

  return paidInvoice
}

/**
 * List all payment methods for a Stripe customer
 * Returns formatted payment method data with default indicator
 *
 * @param customerId - Stripe customer ID
 * @returns Array of payment method objects with isDefault flag
 */
export async function listPaymentMethods(customerId: string): Promise<
  Array<{
    id: string
    card: {
      brand: string
      last4: string
      exp_month: number
      exp_year: number
    }
    isDefault: boolean
  }>
> {
  // Retrieve customer to get default payment method
  const customer = await stripe.customers.retrieve(customerId)

  // Get default payment method ID from customer
  // Stripe.Customer | Stripe.DeletedCustomer - check if customer is not deleted
  const defaultPaymentMethodId =
    !customer.deleted && customer.invoice_settings?.default_payment_method
      ? typeof customer.invoice_settings.default_payment_method === 'string'
        ? customer.invoice_settings.default_payment_method
        : customer.invoice_settings.default_payment_method.id
      : null

  // List all card payment methods
  const paymentMethods = await stripe.paymentMethods.list({
    customer: customerId,
    type: 'card',
  })

  logger.info(`✅ Listed ${paymentMethods.data.length} payment methods for customer ${customerId}`, {
    defaultPaymentMethodId,
  })

  // Format and return payment methods with default indicator
  return paymentMethods.data.map(pm => ({
    id: pm.id,
    card: {
      brand: pm.card?.brand || 'unknown',
      last4: pm.card?.last4 || '0000',
      exp_month: pm.card?.exp_month || 0,
      exp_year: pm.card?.exp_year || 0,
    },
    isDefault: pm.id === defaultPaymentMethodId,
  }))
}

/**
 * Detach (delete) a payment method from a customer
 *
 * @param paymentMethodId - Stripe payment method ID
 */
export async function detachPaymentMethod(paymentMethodId: string) {
  await stripe.paymentMethods.detach(paymentMethodId)
  logger.info(`✅ Payment method ${paymentMethodId} detached`)
}

/**
 * Set a payment method as the default for a customer
 *
 * @param customerId - Stripe customer ID
 * @param paymentMethodId - Stripe payment method ID
 */
export async function setDefaultPaymentMethod(customerId: string, paymentMethodId: string) {
  await stripe.customers.update(customerId, {
    invoice_settings: {
      default_payment_method: paymentMethodId,
    },
  })
  logger.info(`✅ Set default payment method ${paymentMethodId} for customer ${customerId}`)
}

/**
 * Generate billing portal URL for customer to update payment method
 * @param customerId - Stripe customer ID
 * @param returnUrl - Optional return URL after leaving Stripe portal (should include venue slug)
 * @returns Billing portal URL
 */
export async function generateBillingPortalUrl(customerId: string, returnUrl?: string): Promise<string> {
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl || `${process.env.FRONTEND_URL || 'https://dashboardv2.avoqado.io'}/dashboard`,
    })
    return session.url
  } catch (error) {
    logger.error('❌ Failed to generate billing portal URL', {
      customerId,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    // Fallback: Return the provided URL or dashboard
    return returnUrl || `${process.env.FRONTEND_URL || 'https://dashboardv2.avoqado.io'}/dashboard`
  }
}

/**
 * Check if this is the first payment attempt for a subscription
 * Used to determine grace period eligibility (only for returning customers)
 *
 * @param subscriptionId - Stripe subscription ID
 * @returns true if this is the first payment attempt (no previous successful payments)
 */
async function isFirstSubscriptionPayment(subscriptionId: string): Promise<boolean> {
  try {
    // Query Stripe for invoices with successful payments for this subscription
    const invoices = await stripe.invoices.list({
      subscription: subscriptionId,
      status: 'paid',
      limit: 1,
    })

    // If there are no paid invoices, this is the first payment attempt
    const isFirstPayment = invoices.data.length === 0

    logger.info(`🔍 Checked payment history for subscription ${subscriptionId}`, {
      isFirstPayment,
      paidInvoiceCount: invoices.data.length,
    })

    return isFirstPayment
  } catch (error) {
    logger.error('❌ Error checking subscription payment history', {
      subscriptionId,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    // On error, assume it's NOT the first payment (safer to give grace period)
    return false
  }
}

/**
 * Handle payment failure with dunning management
 * Implements grace period logic and progressive warnings
 *
 * Dunning Strategy (Returning Customers):
 * - Day 0 (attempt 1): Email "Payment failed, please update" + 7-day grace period
 * - Day 3 (attempt 2): Email "Reminder: Update payment method"
 * - Day 5 (attempt 3): Email "Final warning before suspension"
 * - Day 7 (attempt 4): SOFT SUSPENSION - Block access, keep data
 * - Day 14 (attempt 5+): HARD CANCEL - Handled by cron job
 *
 * First-Time Customers:
 * - Day 0 (attempt 1): Immediate suspension, no grace period
 * - Must update payment method to activate feature
 *
 * @param subscriptionId - Stripe subscription ID
 * @param attemptCount - Number of payment attempts (from invoice.attempt_count)
 * @param invoiceData - Invoice details for email (invoiceId, amountDue, currency, last4)
 */
/**
 * Escritura CAS del registro del plan en el camino de COBRANZA.
 *
 * 🔴 Mismo motivo que en `subscription.updated`: entre leer el registro, consultar el estado
 * vigente y escribir cabe otro webhook. Escribir sólo por `id` permitía que una suspensión pisara
 * una recuperación que acababa de ocurrir (Codex, 19-sep). `updatedAt` lo mueve Prisma en CADA
 * escritura, así que detecta incluso a quien reescribe el mismo valor.
 */
async function escribirPlanDeCobranzaConCas(
  venueFeature: { id: string; updatedAt: Date; venueId: string },
  data: Record<string, unknown>,
  contexto: { subscriptionId: string },
): Promise<void> {
  const { count } = await prisma.venueFeature.updateMany({
    where: { id: venueFeature.id, updatedAt: venueFeature.updatedAt },
    data,
  })
  if (count === 0) {
    logger.warn('🚨 Cobranza: el registro del plan cambió mientras consultábamos Stripe — se reintentará', {
      venueId: venueFeature.venueId,
      ...contexto,
    })
    throw new Error(`handlePaymentFailure: el registro del plan de ${venueFeature.venueId} cambió bajo nosotros; se reintentará`)
  }
}

export async function handlePaymentFailure(
  subscriptionId: string,
  attemptCount: number,
  invoiceData?: {
    invoiceId: string
    amountDue: number
    currency: string
    last4?: string
  },
): Promise<void> {
  logger.info(`🚨 Handling payment failure for subscription ${subscriptionId}, attempt ${attemptCount}`)

  // Find VenueFeature by subscription ID
  const venueFeature = await prisma.venueFeature.findFirst({
    where: { stripeSubscriptionId: subscriptionId },
    include: {
      venue: {
        select: {
          id: true,
          name: true,
          slug: true,
          stripeCustomerId: true,
          organization: true,
        },
      },
      feature: true,
    },
  })

  if (!venueFeature) {
    logger.warn(`⚠️ VenueFeature not found for subscription ${subscriptionId}`)
    return
  }

  const now = new Date()

  // Update failure tracking
  const updateData: any = {
    lastPaymentAttempt: now,
    paymentFailureCount: attemptCount,
  }

  // Check if this is the first payment attempt for this subscription
  let isFirstPayment = false
  if (attemptCount === 1) {
    isFirstPayment = await isFirstSubscriptionPayment(subscriptionId)
  }

  // Set grace period on first failure (7 days) - ONLY for returning customers
  if (attemptCount === 1) {
    if (isFirstPayment) {
      // First-time customer: Immediate suspension, NO grace period
      updateData.gracePeriodEndsAt = null
      updateData.suspendedAt = now
      updateData.active = false
      logger.warn(`🚫 FIRST PAYMENT FAILED: Immediate suspension for ${venueFeature.feature.name} (Venue: ${venueFeature.venue.name})`, {
        subscriptionId,
        reason: 'First payment attempt failed - no grace period for new customers',
      })
    } else {
      // Returning customer: 7-day grace period
      updateData.gracePeriodEndsAt = addDays(now, 7)
      // active stays TRUE during grace period
      logger.info(`⏰ RETURNING CUSTOMER: Grace period granted for ${venueFeature.feature.name} (Venue: ${venueFeature.venue.name})`, {
        subscriptionId,
        gracePeriodEndsAt: updateData.gracePeriodEndsAt,
      })
    }
  }

  // 🔴 UNA SOLA ESCRITURA. Este flujo escribía dos veces (seguimiento y, en el intento 4, la
  // suspensión) y encadenar sus marcas no bastaba: releer `updatedAt` tras escribir puede devolver
  // la marca de OTRO escritor —un checkout que acaba de vincular una suscripción NUEVA y pagada—,
  // y entonces el segundo CAS pasa y suspende el plan nuevo por la deuda del anterior (Codex,
  // 20-sep). La salida no es gestionar esa relectura: es no necesitarla. La suspensión se decide
  // aquí y viaja en el MISMO `updateData`.
  let suspendePorImpago = false
  if (attemptCount === 4) {
    // Quitar el acceso también se decide con el ESTADO VIGENTE, no con este aviso: un aviso de
    // fallo ATRASADO llega después de que el cliente se puso al corriente. Si Stripe no contesta
    // se PROPAGA: suspender a ciegas le quita el producto a alguien que quizá ya pagó.
    // (6ª auditoría de Codex, 19-sep.)
    const estadoVigente = await estadoDeLaSuscripcion(subscriptionId)
    if (estadoVigente === 'active' || estadoVigente === 'trialing') {
      logger.warn('⚠️ Aviso de fallo ATRASADO: la suscripción está al corriente, NO se suspende', {
        subscriptionId,
        estadoVigente,
        venueId: venueFeature.venueId,
      })
    } else {
      suspendePorImpago = true
      updateData.suspendedAt = now
      updateData.active = false // Block access but keep data
    }
  }

  await escribirPlanDeCobranzaConCas(venueFeature, updateData, { subscriptionId })

  logger.info(`📊 Updated failure tracking for ${venueFeature.feature.name} (Venue: ${venueFeature.venue.name})`, {
    attemptCount,
    isFirstPayment,
    gracePeriodEndsAt: updateData.gracePeriodEndsAt,
    suspended: updateData.suspendedAt !== undefined,
  })

  // Generate billing portal URL for customer to update payment method
  // Build venue-aware return URL
  const FRONTEND_URL = process.env.FRONTEND_URL || 'https://dashboard.avoqado.io'
  const returnUrl = venueFeature.venue.slug
    ? `${FRONTEND_URL}/dashboard/venues/${venueFeature.venue.slug}/billing`
    : `${FRONTEND_URL}/dashboard/venues/${venueFeature.venue.id}/billing`

  const billingPortalUrl = venueFeature.venue.stripeCustomerId
    ? await generateBillingPortalUrl(venueFeature.venue.stripeCustomerId, returnUrl)
    : returnUrl

  // Send appropriate notification based on attempt count
  switch (attemptCount) {
    case 1:
    case 2:
    case 3:
      // Day 0, 3, 5: Payment failed emails
      try {
        if (!invoiceData) {
          logger.warn('⚠️ Invoice data not provided, skipping payment failed email', {
            subscriptionId,
            attemptCount,
          })
          break
        }

        // Resolve recipient (venue.email → owner → org), keeping org email as last-resort fallback.
        const target = await resolvePlanNotificationTarget(venueFeature.venueId)
        const recipient = target.email ?? venueFeature.venue.organization.email

        if (!recipient) {
          logger.warn(`⚠️ No notification recipient for venue ${venueFeature.venueId}; skipping payment failed email`)
          break
        }

        const emailSent = await emailService.sendPaymentFailedEmail(recipient, {
          venueName: venueFeature.venue.name,
          featureName: venueFeature.feature.name,
          attemptCount,
          amountDue: invoiceData.amountDue,
          currency: invoiceData.currency,
          billingPortalUrl,
          last4: invoiceData.last4,
          locale: target.locale,
        })

        if (emailSent) {
          logger.info(`✅ Payment failed email sent (attempt ${attemptCount})`, {
            email: recipient,
            venueId: venueFeature.venueId,
            featureName: venueFeature.feature.name,
          })
        } else {
          logger.warn(`⚠️ Payment failed email failed to send (attempt ${attemptCount})`, {
            email: recipient,
            venueId: venueFeature.venueId,
          })
        }
      } catch (emailError) {
        // Non-blocking: Log error but continue dunning process
        logger.error('❌ Error sending payment failed email', {
          attemptCount,
          subscriptionId,
          error: emailError instanceof Error ? emailError.message : 'Unknown error',
        })
      }
      break

    case 4: {
      // Day 7: Soft suspension. La decisión y la escritura ocurrieron ARRIBA, en la escritura
      // única; aquí sólo queda avisar.
      if (!suspendePorImpago) break

      logger.warn(`⛔ SUSPENDED: Feature ${venueFeature.feature.name} for venue ${venueFeature.venue.name}`)

      try {
        // Resolve recipient (venue.email → owner → org), keeping org email as last-resort fallback.
        const target = await resolvePlanNotificationTarget(venueFeature.venueId)
        const recipient = target.email ?? venueFeature.venue.organization.email

        if (!recipient) {
          logger.warn(`⚠️ No notification recipient for venue ${venueFeature.venueId}; skipping subscription suspended email`)
          break
        }

        const emailSent = await emailService.sendSubscriptionSuspendedEmail(recipient, {
          venueName: venueFeature.venue.name,
          featureName: venueFeature.feature.name,
          suspendedAt: now,
          gracePeriodEndsAt: updateData.gracePeriodEndsAt || addDays(now, 7),
          billingPortalUrl,
          locale: target.locale,
        })

        if (emailSent) {
          logger.info('✅ Subscription suspended email sent', {
            email: recipient,
            venueId: venueFeature.venueId,
            featureName: venueFeature.feature.name,
          })
        } else {
          logger.warn('⚠️ Subscription suspended email failed to send', {
            email: recipient,
            venueId: venueFeature.venueId,
          })
        }
      } catch (emailError) {
        // Non-blocking: Log error but continue dunning process
        logger.error('❌ Error sending subscription suspended email', {
          subscriptionId,
          error: emailError instanceof Error ? emailError.message : 'Unknown error',
        })
      }
      break
    }

    default:
      // Attempt 5+: Grace period expired, awaiting hard cancel by cron job
      logger.warn(`⚠️ Payment failure attempt ${attemptCount} for subscription ${subscriptionId}. Awaiting hard cancellation by cron job.`)
      break
  }

  logger.info(`✅ Payment failure handling complete for subscription ${subscriptionId}`)
}

/**
 * Create SetupIntent for onboarding (without customer)
 *
 * Used during onboarding when the customer/venue doesn't exist yet.
 * The PaymentMethod can be attached to a customer later when the venue is created.
 *
 * @returns SetupIntent client secret
 */
export async function createOnboardingSetupIntent(): Promise<string> {
  const setupIntent = await stripe.setupIntents.create({
    payment_method_types: ['card'],
    usage: 'off_session', // Allow future payments without customer present
  })

  logger.info(`✅ Created onboarding setup intent ${setupIntent.id} (no customer)`)
  return setupIntent.client_secret!
}

/**
 * Customer-scoped SetupIntent for the onboarding plan step. Unlike
 * createOnboardingSetupIntent (no customer), this attaches the resulting
 * payment method to the venue's Stripe customer so the plan subscription can
 * charge it. Returns the client_secret for Stripe Elements.
 */
export async function createPlanSetupIntent(venueId: string): Promise<string> {
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { id: true, email: true, name: true, slug: true, stripeCustomerId: true },
  })
  if (!venue) throw new Error(`Venue ${venueId} not found`)

  const customerId = await getOrCreateStripeCustomer(
    venue.id,
    venue.email || `venue-${venue.slug}@avoqado.io`,
    venue.name,
    venue.name,
    venue.slug,
  )

  const setupIntent = await stripe.setupIntents.create({
    customer: customerId,
    payment_method_types: ['card'],
    usage: 'off_session',
    metadata: { venueId, purpose: 'plan_pro_onboarding' },
  })

  logger.info(`✅ Created plan SetupIntent ${setupIntent.id} for venue ${venueId} (customer ${customerId})`)
  return setupIntent.client_secret!
}

export default {
  getOrCreateStripeCustomer,
  syncFeaturesToStripe,
  createTrialSubscriptions,
  createPlanSubscription,
  convertTrialToPaid,
  cancelSubscription,
  updatePaymentMethod,
  createTrialSetupIntent,
  createOnboardingSetupIntent,
  createPlanSetupIntent,
  getCustomerInvoices,
  getInvoicePdfUrl,
  listPaymentMethods,
  detachPaymentMethod,
  setDefaultPaymentMethod,
  handlePaymentFailure,
  setSubscriptionCancelAtPeriodEnd,
  retrievePlanSubscription,
  subscriptionHasActiveDiscount,
  applySubscriptionCoupon,
  pauseSubscriptionCollection,
  createWinbackPromotionCode,
}
