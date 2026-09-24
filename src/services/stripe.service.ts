/**
 * Stripe Service
 *
 * Handles all Stripe-related operations:
 * - Customer management
 * - Product/Price synchronization
 * - Subscription management with trials
 * - Payment method updates
 */

import { randomUUID } from 'crypto'
import Stripe from 'stripe'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { Feature, Prisma } from '@prisma/client'
import { retry, shouldRetryStripeError } from '@/utils/retry'
import { addDays } from 'date-fns'
import emailService from './email.service'
import { resolvePlanNotificationTarget } from './access/planNotification.service'
import AppError, { ConflictError } from '@/errors/AppError'
import { ventaSueltaAbierta } from './access/ventaSuelta'
import {
  avisarConflictoCreado,
  cerrarConflictoEntregado,
  cerrarConflictoTerminado,
  registrarConflictoDeObligacion,
} from './access/conflictosDeObligacion.service'
import {
  clasificarEstado,
  clasificarSuscripcion,
  decidirEntregaDePlan,
  type CatalogoDeCobro,
  type Cobrable,
  type ItemDeSuscripcion,
  type OperacionDeFila,
  type Tier,
} from './access/obligacionesDeCobro'

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
    // Sin ganador: el negocio se borró mientras se creaba el cliente (el borrado bloquea la fila). Quien
    // llamó NO debe seguir: crearía un SetupIntent o una suscripción para un negocio que ya no existe.
    throw new AppError(`El negocio ${venueId} ya no existe.`, 404, true, 'VENUE_NOT_FOUND')
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

/**
 * Opciones de cada llamada a Stripe hecha CON el candado de compra tomado: tiempo máximo propio y sin
 * los reintentos internos del SDK (80 s × 2 por defecto), para que el peor caso quepa en la
 * transacción. Los reintentos los decide `retry`, con la llave de idempotencia de la invocación.
 */
export const STRIPE_DENTRO_DEL_CANDADO = { timeout: 15_000, maxNetworkRetries: 0 } as const

export async function createTrialSubscriptions(
  customerId: string,
  venueId: string,
  featureCodes: string[],
  trialPeriodDays: number = 5,
  venueName?: string,
  venueSlug?: string,
  paymentMethodId?: string,
): Promise<string[]> {
  // 🔴 Venta suelta CERRADA (founder, 21-sep): el candado vive AQUÍ, en el único punto que crea
  // suscripciones sueltas, para que ningún camino —de hoy o futuro— se lo salte.
  if (!ventaSueltaAbierta()) {
    throw new Error('La venta de funciones sueltas está cerrada por ahora; se contratan con nuestro equipo.')
  }

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
    // 🔴 Lo que ESTA llamada crea en Stripe es suyo y de nadie más (Codex, 21-sep, ronda 4): si algo
    // falla antes de quedar ligado, se cancela aquí. La llave de idempotencia es de esta invocación
    // —nunca se deriva del vínculo leído— así que ninguna otra compra puede recibir esta misma
    // suscripción, y compensarla no toca la de nadie.
    let creadaAqui: string | null = null
    try {
      const claveDelCandado = `venue-feature-sub:${venueId}:${feature.id}`
      const llaveDeEstaCompra = `${claveDelCandado}:${randomUUID()}`
      const crearSuscripcion = async (): Promise<Stripe.Subscription> => {
        const creada = await retry(
          () =>
            stripe.subscriptions.create(
              {
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
                // Stripe debe REINTENTAR la misma invoice en lugar de crear nuevas.
                collection_method: 'charge_automatically',
                // Sin cobro automático al crear: si hubiera que compensar, no hay cargo que devolver.
                payment_behavior: 'default_incomplete',
                payment_settings: {
                  save_default_payment_method: 'on_subscription',
                  payment_method_types: ['card'],
                },
              },
              // Sólo deduplica los REINTENTOS de red de esta misma llamada. Tiempo máximo propio y sin
              // reintentos internos del SDK (80 s × 2 por defecto): todo tiene que caber en la transacción.
              { idempotencyKey: llaveDeEstaCompra, ...STRIPE_DENTRO_DEL_CANDADO },
            ),
          { retries: 2, shouldRetry: shouldRetryStripeError, context: 'stripe.createSubscription' },
        )
        creadaAqui = creada.id
        return creada
      }

      // 🔴 Dos compras de la MISMA función se SERIALIZAN (Codex, 21-sep, #2 y ronda 4). El candado
      // cubre leer → crear o reusar → ligar: la segunda compra espera y lee lo que dejó la primera.
      // Deduplicar con una llave compartida entre compras reabría tres huecos (cuerpo guardado de una
      // suscripción ya cancelada, `idempotency_error` al cambiar de tarjeta, y compensar la ajena).
      const { subscription, isActive } = await prisma.$transaction(
        async tx => {
          // 🔴 SIN espera (Codex, ronda 5, P2-7): esperar el candado retenía una conexión del pool por
          // cada compra encolada detrás de una llamada a Stripe. La segunda compra falla YA y reintenta.
          const [{ tomado }] = await tx.$queryRaw<
            { tomado: boolean }[]
          >`SELECT pg_try_advisory_xact_lock(hashtextextended(${claveDelCandado}, 0)) AS tomado`
          if (!tomado) {
            throw new Error(`Ya hay una compra de ${feature.name} en curso para este negocio. Espera unos segundos y vuelve a intentarlo.`)
          }

          const existingVenueFeature = await tx.venueFeature.findUnique({
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
          const previa = existingVenueFeature?.stripeSubscriptionId ?? null

          let subscription: Stripe.Subscription

          if (previa) {
            // VenueFeature exists with a subscription - check if it's still valid
            logger.info(`  🔍 Found existing subscription ${previa} for feature ${feature.code}`)

            try {
              // Retrieve the existing subscription from Stripe
              const existingSubscription = await stripe.subscriptions.retrieve(previa, {}, STRIPE_DENTRO_DEL_CANDADO)

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
                    const paidInvoice = await stripe.invoices.pay(invoiceId, {}, STRIPE_DENTRO_DEL_CANDADO)

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

                // 🔴 «¿Quedó activa?» se decide con el estado VIGENTE, no con la foto de antes de pagar
                // (Codex, 21-sep, #7). Con la vieja (`past_due`) se escribía `active:false` y se pisaba
                // lo que el webhook acababa de activar al cobrarse la factura: pagaba y perdía el acceso.
                //
                // 🔴 Y si la relectura FALLA no se escribe nada (Codex, ronda 5, P1-6): la foto de antes de
                // pagar dice `past_due` y pisaría con `active:false` la fila que el webhook del cobro ya
                // activó. Sin estado vigente no hay veredicto: se aborta y manda el webhook.
                try {
                  subscription = await stripe.subscriptions.retrieve(existingSubscription.id, {}, STRIPE_DENTRO_DEL_CANDADO)
                } catch (lecturaError: any) {
                  logger.warn(`  ⚠️ No se pudo releer la suscripción tras el pago; no se toca el vínculo`, {
                    subscriptionId: existingSubscription.id,
                    error: lecturaError?.message,
                  })
                  throw new Error(
                    `Se intentó cobrar la factura pendiente de ${feature.name} pero no pudimos confirmar el resultado; se reflejará en unos minutos.`,
                  )
                }
              } else if (existingSubscription.status === 'canceled') {
                // If canceled, create a new one
                logger.info(`  🆕 Existing subscription canceled, creating new one`)
                subscription = await crearSuscripcion()
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
                logger.error(`  🚨 No se pudo consultar la suscripción ${previa}: NO se crea otra`, {
                  venueId,
                  featureCode: feature.code,
                  subscriptionId: previa,
                  errorType: error?.type,
                  errorCode: error?.code,
                  statusCode: error?.statusCode,
                })
                throw error
              }
              // Subscription not found in Stripe - create new one
              logger.warn(`  ⚠️ Subscription ${previa} not found in Stripe, creating new one`)
              subscription = await crearSuscripcion()
            }
          } else {
            // No existing VenueFeature or no subscription - create new subscription
            logger.info(`  🆕 Creating new subscription for feature ${feature.code}`)
            subscription = await crearSuscripcion()
          }

          // Create or update VenueFeature record
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

          // 🔴 Una suscripción NUEVA, o una que Stripe ya da por cobrada, no arrastra la cobranza del
          // ciclo anterior (Codex, 21-sep, R4-7). La suspensión que dejó el job de impago seguía en la
          // fila y el resolver negaba el acceso que el cliente acababa de pagar. Si la reusada SIGUE
          // atrasada, las banderas se quedan: la cobranza está viva.
          const cobranzaAlDia = subscription.id === creadaAqui || subscription.status === 'active' || subscription.status === 'trialing'

          // 🔴 El vínculo sólo se escribe si sigue apuntando a la suscripción que se LEYÓ (Codex,
          // 21-sep, #2). El candado serializa las compras; el CAS cubre a los escritores que no lo
          // toman (webhooks, superadmin, jobs).
          const datosDelVinculo = {
            active: isActive,
            monthlyPrice: feature.monthlyPrice,
            startDate: new Date(),
            endDate,
            stripeSubscriptionId: subscription.id,
            stripePriceId: feature.stripePriceId,
            ...(cobranzaAlDia && { suspendedAt: null, gracePeriodEndsAt: null, paymentFailureCount: 0 }),
          }
          if (existingVenueFeature) {
            const { count } = await tx.venueFeature.updateMany({
              where: { id: existingVenueFeature.id, stripeSubscriptionId: previa },
              data: datosDelVinculo,
            })
            if (count === 0) throw new Error(`Otro proceso cambió el vínculo de ${feature.code} mientras se contrataba`)
          } else {
            // Un P2002 aquí sólo puede venir de un escritor sin candado; aborta la transacción y se
            // reporta como fallo (la compensación de abajo decide si cancelar lo creado).
            await tx.venueFeature.create({ data: { venueId, featureId: feature.id, ...datosDelVinculo } })
          }

          return { subscription, isActive }
        },
        // El candado se sostiene durante las llamadas a Stripe. Peor caso: releer (15 s) + crear con 3
        // intentos de 15 s y 3 s de espera ≈ 63 s; o releer + pagar + releer = 45 s. 90 s deja margen.
        { maxWait: 10_000, timeout: 90_000 },
      )

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
      // 🔴 Lo creado aquí y NO ligado se cancela (Codex, 21-sep, R4-1). Se relee FUERA de la
      // transacción: si la escritura sí llegó a la base (el fallo vino después), la suscripción es
      // la del cliente y no se toca. Como se creó con `default_incomplete` y la primera factura aún
      // no se intentó cobrar, cancelarla no deja ningún cargo que devolver.
      const huerfana: string | null = creadaAqui
      if (huerfana) {
        let ligada: string | null | undefined
        try {
          // 🔴 Antes de releer se vuelve a tomar el MISMO candado, esperando (Codex, ronda 5, P1-5): si el
          // COMMIT de la transacción anterior sigue en vuelo, un SELECT suelto vería el vínculo viejo y
          // cancelaríamos una suscripción que sí quedó ligada. Postgres suelta el candado al terminar
          // esa transacción, así que tomarlo prueba que ya terminó. Espera acotada a 15 s.
          const vigente = await prisma.$transaction(async tx => {
            await tx.$executeRaw`SET LOCAL lock_timeout = '15s'`
            await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`venue-feature-sub:${venueId}:${feature.id}`}, 0))::text`
            return tx.venueFeature.findUnique({
              where: { venueId_featureId: { venueId, featureId: feature.id } },
              select: { stripeSubscriptionId: true },
            })
          })
          ligada = vigente?.stripeSubscriptionId ?? null
        } catch {
          ligada = undefined // no se sabe: no se cancela algo que quizá sí quedó ligado
        }
        if (ligada === undefined) {
          logger.error(`  🚨 No se pudo verificar si la suscripción ${huerfana} quedó ligada: revisar en Stripe`, {
            venueId,
            featureCode: feature.code,
            subscriptionId: huerfana,
          })
        } else if (ligada !== huerfana) {
          try {
            await stripe.subscriptions.cancel(huerfana)
            logger.warn(`  ↩️ Se canceló la suscripción ${huerfana}: se creó pero no quedó ligada`, { venueId, featureCode: feature.code })
          } catch (cancelError: any) {
            logger.error(`  🚨 Suscripción huérfana SIN cancelar: revisar en Stripe`, {
              venueId,
              featureCode: feature.code,
              subscriptionId: huerfana,
              error: cancelError?.message,
            })
          }
        }
      }
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
  /**
   * 🔴 Se invoca en el INSTANTE siguiente a crear la suscripción en Stripe, antes de cualquier
   * otra escritura. Existe porque entre el cargo y el retorno de esta función (y la entrega que el
   * llamador corre después) hay trabajo que puede fallar: si falla, el llamador nunca ve el id y pierde el
   * rastro del cobro que YA ocurrió — y su reintento acaba creando un segundo cargo (Codex,
   * 21-sep). Lo que este gancho haga NO puede tumbar el cobro: se invoca protegido.
   */
  alCrearEnStripe?: (subscriptionId: string) => Promise<void>
  /**
   * Se invoca JUSTO antes del POST a Stripe (Codex C15): la frontera entre «preparar» (catálogo, precio, reuso — un fallo
   * aquí es seguro: nada pudo cobrarse) y «pudo cobrarse». El llamador la usa para decidir qué suelta ante un error.
   */
  antesDeCobrar?: () => void
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
export async function estadoDeLaSuscripcion(subscriptionId: string, opciones?: Stripe.RequestOptions): Promise<Stripe.Subscription.Status> {
  return (await suscripcionVigente(subscriptionId, opciones)).status
}

/**
 * ¿Esta suscripción puede cobrar (o recuperarse y cobrar)? TRES respuestas, no dos (R0, Codex 21-sep):
 * `SI` para todo estado no terminal —también `past_due`, `unpaid`, `incomplete` y `paused`, que pueden
 * volver—; `NO` sólo si Stripe la da por terminada o AFIRMA que no existe; `INCIERTO` si no contestó.
 * Un `INCIERTO` nunca se trata como `NO`.
 */
export async function suscripcionPuedeCobrar(
  subscriptionId: string | null | undefined,
  opciones?: Stripe.RequestOptions,
): Promise<'SI' | 'NO' | 'INCIERTO'> {
  if (!subscriptionId) return 'NO'
  try {
    const estado = await estadoDeLaSuscripcion(subscriptionId, opciones)
    return estado === 'canceled' || estado === 'incomplete_expired' ? 'NO' : 'SI'
  } catch (error) {
    return stripeAfirmaQueNoExiste(error) ? 'NO' : 'INCIERTO'
  }
}

/**
 * 🔴 R0 (Codex, 21-sep): una escritura LOCAL que borra o apaga el vínculo de una suscripción que sigue
 * cobrando deja al negocio pagando sin acceso, o a la suscripción sin representación local. Se RECHAZA
 * —nunca se cancela por debajo: cancelar es otra operación, con su propio resultado—.
 */
export async function exigirSinObligacionViva(subscriptionId: string | null | undefined, accion: string): Promise<void> {
  const puede = await suscripcionPuedeCobrar(subscriptionId)
  if (puede === 'SI') {
    throw new AppError(
      `No se puede ${accion}: el negocio tiene una suscripción en Stripe que sigue cobrando (${subscriptionId}). Cancélala primero en Stripe, o haz el cambio desde el flujo de planes.`,
      409,
      true,
      'LIVE_SUBSCRIPTION_LINKED',
    )
  }
  if (puede === 'INCIERTO') {
    throw new AppError(
      'No pudimos confirmar el estado de la suscripción en Stripe. Inténtalo de nuevo en unos minutos.',
      503,
      true,
      'SUBSCRIPTION_STATE_UNVERIFIED',
    )
  }
}

/**
 * La suscripción VIGENTE, con los datos que hacen falta para escribir el acceso.
 *
 * 🔴 No basta el `status`: el `trial_end` del EVENTO también puede estar vencido. Un aviso atrasado
 * de `trialing` sobre un plan que hoy está pagado volvía a escribir el vencimiento viejo y, si ya
 * había pasado, le quitaba el acceso a quien paga. (8ª auditoría de Codex, 19-sep.)
 */
export async function suscripcionVigente(subscriptionId: string, opciones?: Stripe.RequestOptions): Promise<SuscripcionVigente> {
  const suscripcion = opciones
    ? await stripe.subscriptions.retrieve(subscriptionId, {}, opciones)
    : await stripe.subscriptions.retrieve(subscriptionId)
  return {
    status: suscripcion.status,
    trialEnd: suscripcion.trial_end ? new Date(suscripcion.trial_end * 1000) : null,
    ...itemsDeSuscripcion(suscripcion),
  }
}

/** Estado, vencimiento e ítems de UNA misma consulta a Stripe: quien decide con uno no puede escribir con otra foto. */
export interface SuscripcionVigente {
  status: Stripe.Subscription.Status
  trialEnd: Date | null
  items: ItemDeSuscripcion[]
  /** `false` si Stripe dejó ítems fuera de la página: lo que vende no se conoce entero. */
  itemsCompletos: boolean
}

/** Los ítems de una suscripción, como los clasifica el núcleo de obligaciones (por precio, producto y lookup_key). */
function itemsDeSuscripcion(subscription: Stripe.Subscription): { items: ItemDeSuscripcion[]; itemsCompletos: boolean } {
  return {
    items: (subscription.items?.data ?? []).map(it => ({
      priceId: it.price?.id ?? '',
      productId: (typeof it.price?.product === 'string' ? it.price.product : (it.price?.product as { id?: string } | undefined)?.id) ?? '',
      lookupKey: it.price?.lookup_key ?? null,
    })),
    itemsCompletos: subscription.items?.has_more !== true,
  }
}

/** Tope de lectura del catálogo en la entrega: si no cabe entero, no se clasifica nada (mismo criterio del inventario). */
const TOPE_CATALOGO_DE_ENTREGA = 200

/**
 * El catálogo COMPLETO de cobro (Codex R11): todo `Feature` con producto de Stripe, no sólo los planes. Lo que el
 * catálogo reconoce deja de ser «desconocido», y por tanto la retirada demostrable puede correr.
 */
function catalogoCompleto(funciones: { code: string; stripeProductId: string | null }[]): CatalogoDeCobro {
  return {
    productoAFuncion: Object.fromEntries(funciones.filter(f => f.stripeProductId).map(f => [f.stripeProductId as string, f.code])),
    productosAjenos: new Set(),
  }
}

/** El catálogo de cobro de los PLANES (la clasificación por lookup_key cubre también los precios históricos). */
function catalogoDePlanes(planes: { code: string; stripeProductId: string | null }[]): CatalogoDeCobro {
  return {
    productoAFuncion: Object.fromEntries(planes.filter(p => p.stripeProductId).map(p => [p.stripeProductId as string, p.code])),
    productosAjenos: new Set(),
  }
}

/**
 * 🔴 Codex R13: ¿qué TIER vende hoy esta suscripción? Es la única fuente honesta de «qué se cobró» cuando el alta
 * recupera un cobro anterior: el formulario del reintento puede pedir otro plan, y contestarle con lo que pidió
 * anunciaba PREMIUM sobre un cobro PRO. `null` = no se pudo determinar (no se adivina).
 */
export async function tierQueVendeLaSuscripcion(subscription: Stripe.Subscription): Promise<Tier | null> {
  const { items, itemsCompletos } = itemsDeSuscripcion(subscription)
  if (!itemsCompletos) return null
  const planes = await prisma.feature.findMany({
    where: { code: { in: ['PLAN_PRO', 'PLAN_PREMIUM'] } },
    select: { code: true, stripeProductId: true },
    take: 2,
  })
  const { proyecciones } = clasificarSuscripcion(items, catalogoDePlanes(planes))
  const tiers = proyecciones.flatMap(p => (p.tipo === 'PLAN' ? [p.tier] : []))
  return tiers.length === 1 ? tiers[0] : null
}

/**
 * 🔴 V5-A paso 6 (Codex, P1-3): ¿vende HOY esta suscripción exactamente ese plan, y nada más?
 *
 * Los manejadores viejos (`subscription.updated`, `invoice.payment_succeeded` y el barrido que los reusa) encuentran la
 * fila POR EL VÍNCULO. Si la suscripción cambió de plan, esa fila ya no la respalda: sólo cuando esto contesta que sí
 * pueden seguir escribiéndola. Si no, decide la entrega, que ve las dos filas bajo el candado del negocio.
 */
export async function suscripcionVendeElPlan(
  vigente: Pick<SuscripcionVigente, 'items' | 'itemsCompletos'>,
  planCode: string,
): Promise<boolean> {
  if (!vigente.itemsCompletos) return false
  const planes = await prisma.feature.findMany({
    where: { code: { in: ['PLAN_PRO', 'PLAN_PREMIUM'] } },
    select: { code: true, stripeProductId: true },
    take: 2,
  })
  const { proyecciones } = clasificarSuscripcion(vigente.items, catalogoDePlanes(planes))
  return proyecciones.length === 1 && proyecciones[0].tipo === 'PLAN' && CODIGO_DEL_TIER[proyecciones[0].tier] === planCode
}

export async function createPlanSubscription(input: CreatePlanSubscriptionInput): Promise<CreatePlanSubscriptionResult> {
  const feature = await prisma.feature.findFirst({ where: { code: input.tierCode, active: true } })
  if (!feature) throw new Error(`Feature ${input.tierCode} not found or inactive`)

  // Idempotency: reuse existing subscription for this venue+feature.
  const existing = await prisma.venueFeature.findUnique({
    where: { venueId_featureId: { venueId: input.venueId, featureId: feature.id } },
    select: { stripeSubscriptionId: true },
  })
  // 🔴 Sólo se reusa lo que todavía puede cobrar: reusar una suscripción que Stripe ya dio por terminada cerraba el alta
  // con un plan muerto. Sin respuesta de Stripe no se decide a ciegas (ni reusar ni cobrar otra vez).
  const reusable = existing?.stripeSubscriptionId
    ? await suscripcionPuedeCobrar(existing.stripeSubscriptionId, STRIPE_DENTRO_DEL_CANDADO)
    : 'NO'
  if (reusable === 'INCIERTO') {
    throw new AppError(
      'No pudimos confirmar el estado de la suscripción en Stripe. Inténtalo de nuevo en unos minutos.',
      503,
      true,
      'SUBSCRIPTION_STATE_UNVERIFIED',
    )
  }
  if (existing?.stripeSubscriptionId && reusable === 'SI') {
    logger.info(`createPlanSubscription: reusing existing sub ${existing.stripeSubscriptionId} for venue ${input.venueId}`)
    // 🔴 Se DICE que se reusó. El llamador decide si eso es legítimo (un reintento idempotente
    // del mismo cobro) o si tiene que negarse a cerrar (una oferta que nunca se cobró).
    return { subscriptionId: existing.stripeSubscriptionId, reused: true }
  }

  const lookupKey = planLookupKey(input.tierCode, input.interval)
  // 🔴 Corre bajo el candado de la regla común (Codex C3): cada llamada con tiempo propio y sin reintentos del SDK.
  const prices = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 }, STRIPE_DENTRO_DEL_CANDADO)
  const price = prices.data[0]
  if (!price) throw new Error(`Stripe price not found for lookup_key ${lookupKey} — run scripts/seed-plan-pro.ts`)

  input.antesDeCobrar?.()
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
        input.idempotencyKey ? { idempotencyKey: input.idempotencyKey, ...STRIPE_DENTRO_DEL_CANDADO } : STRIPE_DENTRO_DEL_CANDADO,
      ),
    { retries: 3, shouldRetry: shouldRetryStripeError, context: 'stripe.createPlanSubscription' },
  )

  // 🔴 ANTES que cualquier otra escritura: el cargo ya ocurrió y el llamador necesita su rastro
  // aunque lo de abajo falle.
  if (input.alCrearEnStripe) {
    await input.alCrearEnStripe(subscription.id).catch(error => {
      logger.error('🚨 createPlanSubscription: el gancho posterior al cargo falló', {
        subscriptionId: subscription.id,
        venueId: input.venueId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  // 🔴 V5-A paso 6: aquí sólo se COBRA. El acceso lo escribe `entregarSuscripcionDePlan`, que el llamador corre después
  // (fuera del candado de la regla común, que la entrega también toma).

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
  // 🔴 Corre bajo el candado de la regla común (Codex C3): cada llamada con tiempo propio y sin reintentos del SDK.
  const prices = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 }, STRIPE_DENTRO_DEL_CANDADO)
  const price = prices.data[0]
  if (!price) throw new Error(`Stripe price not found for lookup_key ${lookupKey} — run scripts/seed-plan-pro.ts`)

  const description = input.venueName ? `Plan Avoqado ${planLabel(tierCode)} - ${input.venueName}` : `Plan Avoqado ${planLabel(tierCode)}`

  const session = await retry(
    () =>
      stripe.checkout.sessions.create(
        {
          mode: 'subscription',
          customer: input.customerId,
          line_items: [{ price: price.id, quantity: 1 }],
          allow_promotion_codes: true,
          // V5-A: sólo tarjeta (un pago diferido dejaría `active` sin haber cobrado) y caducidad de 30 min, el mínimo que
          // Stripe permite: una sesión que nadie abrió no queda viva para siempre.
          payment_method_types: ['card'],
          expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
          subscription_data: {
            description,
            metadata: {
              kind: 'PLAN_CHECKOUT',
              venueId: input.venueId,
              tierCode,
              featureId: feature.id,
              featureCode: feature.code,
              interval: input.interval,
              ...(input.venueName ? { venueName: input.venueName } : {}),
              ...(input.venueSlug ? { venueSlug: input.venueSlug } : {}),
            },
          },
          // `kind` la marca como NUESTRA para la regla común de compra, que expira las abiertas antes de abrir otra.
          metadata: {
            kind: 'PLAN_CHECKOUT',
            venueId: input.venueId,
            tierCode,
            interval: input.interval,
          },
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
        },
        STRIPE_DENTRO_DEL_CANDADO,
      ),
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

  return entregarSuscripcionDePlan({ venueId, subscriptionId, detectedBy: 'checkout.session.completed' })
}

const CODIGO_DEL_TIER: Record<Tier, PlanTierCode> = { PRO: 'PLAN_PRO', PREMIUM: 'PLAN_PREMIUM' }

/**
 * 🔴 V5-A (diseño v5.2): entrega una suscripción de PLAN sin pisar nunca otra obligación viva.
 *
 * Sustituye la lógica de `fulfillPlanCheckout`, que miraba sólo la fila del tier de la METADATA: con dos pestañas
 * pagadas, la segunda REAPUNTABA la fila a su suscripción y la primera quedaba cobrando sin representación. Ahora:
 *   - el tier sale del PRECIO vigente (la metadata queda vieja tras un cambio de plan);
 *   - se leen las filas de LOS DOS tiers ANTES de consultar Stripe (el CAS sobre `updatedAt` vigila la ventana buena);
 *   - `decidirEntregaDePlan` (núcleo puro, auditado) dice qué operación va en cada fila;
 *   - todo se aplica en UNA transacción con CAS; una obligación que no se puede representar queda en
 *     `BillingObligationConflict` (durable), y se audita después de confirmar;
 *   - si faltó una respuesta de Stripe, lo que sí se sabe se aplica y el evento se reprocesa (se lanza).
 */
export async function entregarSuscripcionDePlan(entrada: {
  venueId: string
  subscriptionId: string
  detectedBy: string
}): Promise<FulfillPlanCheckoutResult | null> {
  const { venueId, subscriptionId, detectedBy } = entrada
  const reintentar = (motivo: string) => new Error(`entregarSuscripcionDePlan: ${motivo} de ${venueId}; se reintentará`)
  const LECTURA_EN_CANDADO = STRIPE_DENTRO_DEL_CANDADO

  type Salida =
    | { tipo: 'NADA' }
    /** 🔴 Codex R6: la suscripción no es de este negocio. No concede nada y no se registra como conflicto suyo. */
    | { tipo: 'AJENA'; venueDeLaMetadata: string | null; customerId: string | null }
    | { tipo: 'DESCONOCIDA'; conflictoCreado: boolean; proyecciones: unknown }
    | {
        tipo: 'DECIDIDA'
        decision: ReturnType<typeof decidirEntregaDePlan>
        concedido: FulfillPlanCheckoutResult | null
        conflictoCreado: boolean
      }

  // 🔴 Todo bajo el candado del NEGOCIO (el mismo de la regla común), tomado ANTES de leer las filas y de consultar
  // Stripe (Codex, pasos 2-5, P1-1): dos entregas simultáneas de PRO y PREMIUM leían «no hay filas» y cada una creaba
  // la suya. El CAS sobre `updatedAt` se conserva frente a los escritores que todavía no comparten el candado.
  const salida: Salida = await prisma.$transaction(
    async tx => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '15s'`
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`stripe-obligaciones:${venueId}`}))`

      // 1. Las filas de los DOS tiers, ANTES de Stripe.
      const planes = await tx.feature.findMany({
        where: { code: { in: ['PLAN_PRO', 'PLAN_PREMIUM'] } },
        select: { id: true, code: true, monthlyPrice: true, stripeProductId: true },
        take: 2,
      })
      // 🔴 Codex R11: la entrega clasificaba con un catálogo de SÓLO los dos planes, así que una función normal
      // (Inventario) salía `DESCONOCIDO` y la retirada demostrable se saltaba: una fila PREMIUM ligada a una
      // suscripción que hoy vende PRO + Inventario conservaba PREMIUM. Se clasifica con el catálogo COMPLETO y
      // acotado —el mismo criterio del inventario de obligaciones—; la forma mixta se sigue bloqueando igual.
      const funcionesDelCatalogo = await tx.feature.findMany({
        where: { stripeProductId: { not: null } },
        select: { code: true, stripeProductId: true },
        orderBy: { id: 'asc' },
        take: TOPE_CATALOGO_DE_ENTREGA + 1,
      })
      if (funcionesDelCatalogo.length > TOPE_CATALOGO_DE_ENTREGA) throw reintentar('el catálogo es más grande de lo que se lee')
      const filas = await tx.venueFeature.findMany({
        where: { venueId, featureId: { in: planes.map(p => p.id) } },
        select: {
          id: true,
          featureId: true,
          active: true,
          stripeSubscriptionId: true,
          suspendedAt: true,
          gracePeriodEndsAt: true,
          paymentFailureCount: true,
          updatedAt: true,
        },
        take: 2,
      })
      const planDeTier = (t: Tier) => planes.find(p => p.code === CODIGO_DEL_TIER[t])
      const filaDeTier = (t: Tier) => filas.find(f => f.featureId === planDeTier(t)?.id)
      const cas = async (fila: { id: string; updatedAt: Date }, data: Prisma.VenueFeatureUpdateManyMutationInput) => {
        const { count } = await tx.venueFeature.updateMany({ where: { id: fila.id, updatedAt: fila.updatedAt }, data })
        if (count === 0) throw reintentar('un registro de plan cambió mientras consultábamos Stripe')
      }

      // 2. El estado VIGENTE en Stripe y qué vende (por el precio, no por la metadata).
      const subscription = await retry(() => stripe.subscriptions.retrieve(subscriptionId, {}, LECTURA_EN_CANDADO), {
        retries: 2,
        shouldRetry: shouldRetryStripeError,
        context: 'stripe.entregarSuscripcionDePlan.retrieveSubscription',
      })
      const estado = clasificarEstado(subscription.status)
      const { items, itemsCompletos } = itemsDeSuscripcion(subscription)
      const { proyecciones } = clasificarSuscripcion(items, catalogoCompleto(funcionesDelCatalogo))
      const planesVendidos = proyecciones.flatMap(p => (p.tipo === 'PLAN' ? [p.tier] : []))
      const customerId = typeof subscription.customer === 'string' ? subscription.customer : (subscription.customer?.id ?? null)

      // 🔴 Codex R6: sólo se entrega lo que ES del negocio. Nuestras suscripciones llevan su `venueId` en la metadata
      // (la ponemos al crearlas); una vieja sin él se reconoce por el cliente de Stripe del negocio. Una ajena no concede
      // nada aquí ni se registra como conflicto de ESTE negocio: el 🚨 del log la señala.
      const venue = await tx.venue.findUnique({ where: { id: venueId }, select: { stripeCustomerId: true } })
      const venueDeLaMetadata = subscription.metadata?.venueId
      const esDelNegocio = venueDeLaMetadata ? venueDeLaMetadata === venueId : !!customerId && customerId === venue?.stripeCustomerId
      if (!esDelNegocio) return { tipo: 'AJENA' as const, venueDeLaMetadata: venueDeLaMetadata ?? null, customerId }

      // Un ítem fuera de la página puede ser justo el incompatible: lo que no se vio entero no se entiende (Codex P2-7).
      if (!itemsCompletos || proyecciones.length !== 1 || planesVendidos.length !== 1) {
        // Una TERMINADA pierde el acceso de las filas que la ligan aunque no se sepa qué vendía (Codex, P2-5).
        if (estado === 'TERMINAL') {
          for (const f of filas) if (f.stripeSubscriptionId === subscriptionId && f.active) await cas(f, { active: false })
          // 🔴 Codex R12: y su conflicto pendiente se cierra — ya no cobra, así que no puede seguir bloqueando compras.
          await cerrarConflictoTerminado(tx, subscriptionId)
          return { tipo: 'NADA' }
        }
        // Lo DEMOSTRABLE se retira aunque la suscripción quede en conflicto (Codex C10): con todos sus ítems leídos y
        // reconocidos, una fila ligada a ella cuyo tier ya no vende no está respaldada. Con un ítem desconocido no se sabe.
        if (itemsCompletos && !proyecciones.some(p => p.tipo === 'DESCONOCIDO')) {
          for (const t of ['PRO', 'PREMIUM'] as Tier[]) {
            const f = filaDeTier(t)
            if (f?.stripeSubscriptionId === subscriptionId && f.active && !planesVendidos.includes(t)) await cas(f, { active: false })
          }
        }
        // Si no vende ningún plan, no es de este camino; si lo vende junto con otra cosa (o no se sabe qué vende), no se
        // representa y queda como conflicto: nunca se concede lo que no se entiende.
        if (itemsCompletos && planesVendidos.length === 0 && !proyecciones.some(p => p.tipo === 'DESCONOCIDO')) return { tipo: 'NADA' }
        const r = await registrarConflictoDeObligacion(tx, {
          venueId,
          subscriptionId,
          customerId,
          kind: 'UNKNOWN_PRODUCT',
          conflictsWith: [],
          detectedBy,
        })
        return { tipo: 'DESCONOCIDA', conflictoCreado: r === 'CREADO', proyecciones }
      }
      const tier = planesVendidos[0]
      const plan = planDeTier(tier)
      if (!plan) throw new Error(`Feature ${CODIGO_DEL_TIER[tier]} not found`)

      // 3. ¿Pueden cobrar los vínculos AJENOS que aparecen en las filas? (sin respuesta ⇒ INCIERTO, nunca terminado)
      const puedeCobrar: Record<string, Cobrable> = {}
      for (const f of filas) {
        if (f.stripeSubscriptionId && f.stripeSubscriptionId !== subscriptionId)
          puedeCobrar[f.stripeSubscriptionId] = await suscripcionPuedeCobrar(f.stripeSubscriptionId, LECTURA_EN_CANDADO)
      }

      // 4. Decidir con el núcleo auditado.
      const aFila = (t: Tier) => {
        const f = filaDeTier(t)
        return f ? { vinculo: f.stripeSubscriptionId, active: f.active } : undefined
      }
      const decision = decidirEntregaDePlan({
        subscriptionId,
        tier,
        estado,
        filas: { PRO: aFila('PRO'), PREMIUM: aFila('PREMIUM') },
        puedeCobrar,
      })

      // 5. Aplicar TODO con CAS. SOLTAR y RETIRAR van primero (el vínculo es único).
      const trialEnd = subscription.status === 'trialing' && subscription.trial_end ? new Date(subscription.trial_end * 1000) : null
      const stripePriceId = subscription.items?.data?.[0]?.price?.id ?? null
      const concesion = {
        active: true,
        stripeSubscriptionId: subscriptionId,
        stripePriceId,
        monthlyPrice: plan.monthlyPrice,
        endDate: trialEnd,
        trialEndDate: trialEnd,
        suspendedAt: null,
        gracePeriodEndsAt: null,
        paymentFailureCount: 0,
      }
      // Una obligación NUEVA en la fila (LIGAR/SUSTITUIR) arranca con su propia cobranza y vigencia: heredar el
      // `suspendedAt` o la gracia de la anterior haría que el job de cancelación cancelara la NUEVA (Codex, P1-2).
      const obligacionNueva = (activar: boolean) =>
        activar
          ? { ...concesion, stripeSubscriptionItemId: null }
          : {
              stripeSubscriptionId: subscriptionId,
              stripeSubscriptionItemId: null,
              stripePriceId,
              monthlyPrice: plan.monthlyPrice,
              active: false,
              endDate: null,
              trialEndDate: trialEnd,
              suspendedAt: null,
              gracePeriodEndsAt: null,
              paymentFailureCount: 0,
            }
      // 🔴 Codex C9: si ESTA suscripción ya estaba en la fila del otro tier, cambiar de precio la TRASLADA — no nace una
      // obligación nueva. Su cobranza viaja con ella, y una suspensión por impago sólo la levanta `active` (una prueba no
      // salda una deuda); limpiar sus marcas aquí le perdonaba el impago al cambiar de plan.
      const trasladada = filas.find(f => f.stripeSubscriptionId === subscriptionId && f.featureId !== plan.id)
      const datosDelDestino = (activar: boolean) => {
        if (!trasladada) return { data: obligacionNueva(activar), concede: activar }
        const levanta = activar && !(trasladada.suspendedAt && subscription.status !== 'active')
        if (levanta) return { data: { ...concesion, stripeSubscriptionItemId: null }, concede: true }
        return {
          data: {
            stripeSubscriptionId: subscriptionId,
            stripeSubscriptionItemId: null,
            stripePriceId,
            monthlyPrice: plan.monthlyPrice,
            active: false,
            endDate: null,
            trialEndDate: trialEnd,
            suspendedAt: trasladada.suspendedAt,
            gracePeriodEndsAt: trasladada.gracePeriodEndsAt,
            paymentFailureCount: trasladada.paymentFailureCount,
          },
          concede: false,
        }
      }
      const ordenDeOps = (['SOLTAR', 'RETIRAR_ACCESO', 'APLICAR_ESTADO', 'SUSTITUIR', 'LIGAR'] as const).flatMap(op =>
        (['PRO', 'PREMIUM'] as Tier[]).flatMap(t =>
          decision.filas[t]?.op === op ? [[t, decision.filas[t] as OperacionDeFila] as const] : [],
        ),
      )
      let concedido = false
      for (const [t, op] of ordenDeOps) {
        const fila = filaDeTier(t)
        if (op.op === 'SOLTAR') await cas(fila!, { stripeSubscriptionId: null, stripeSubscriptionItemId: null, active: false })
        else if (op.op === 'RETIRAR_ACCESO') await cas(fila!, { active: false })
        else if (op.op === 'APLICAR_ESTADO') {
          // Mismo vínculo: si habilita, se concede como siempre; si es recuperable, la cobranza (gracia, suspensión) la
          // gobierna su propio manejador y aquí no se toca. Y una suspensión por impago sólo la levanta `active`: una
          // prueba no salda una deuda (la misma regla de `veredictoDeActivacion` en los webhooks).
          if (estado === 'HABILITANTE' && !(fila!.suspendedAt && subscription.status !== 'active')) {
            await cas(fila!, concesion)
            concedido = true
          }
        } else {
          const { data, concede } = datosDelDestino(op.activar)
          if (fila) await cas(fila, data)
          else
            // Otro escritor (sin este candado) creó la fila primero: la transacción ya quedó abortada, se reintenta entera.
            await tx.venueFeature.create({ data: { venueId, featureId: plan.id, ...data } }).catch(e => {
              throw (e as { code?: string })?.code === 'P2002' ? reintentar('otro evento creó el registro del plan') : e
            })
          if (concede) concedido = true
        }
      }
      if (concedido) await cerrarConflictoEntregado(tx, subscriptionId)
      let conflictoCreado = false
      if (decision.conflictoCon?.length) {
        const r = await registrarConflictoDeObligacion(tx, {
          venueId,
          subscriptionId,
          customerId,
          kind: 'DUPLICATE_PLAN',
          conflictsWith: decision.conflictoCon,
          featureCode: CODIGO_DEL_TIER[tier],
          detectedBy,
        })
        conflictoCreado = r === 'CREADO'
      }
      return {
        tipo: 'DECIDIDA',
        decision,
        conflictoCreado,
        concedido: concedido ? { venueId, featureId: plan.id, featureCode: plan.code, subscriptionId, endDate: trialEnd } : null,
      }
    },
    // Peor caso (Codex C3): la consulta con `retry` (3 × 15 s) + dos vínculos ajenos (2 × 15 s) + la base: 120 s bastan.
    { maxWait: 10_000, timeout: 120_000 },
  )

  // Después de confirmar: auditoría, alertas y, si faltó una respuesta de Stripe, el reintento.
  if (salida.tipo === 'NADA') return null
  if (salida.tipo === 'AJENA') {
    logger.error('🚨 entregarSuscripcionDePlan: la suscripción NO es de este negocio — no se concede', {
      venueId,
      subscriptionId,
      venueDeLaMetadata: salida.venueDeLaMetadata,
      customerId: salida.customerId,
    })
    return null
  }
  if (salida.tipo === 'DESCONOCIDA') {
    if (salida.conflictoCreado) avisarConflictoCreado({ venueId, subscriptionId, kind: 'UNKNOWN_PRODUCT', detectedBy })
    logger.error('🚨 entregarSuscripcionDePlan: suscripción con una forma que no se puede representar — queda en conflicto', {
      venueId,
      subscriptionId,
      proyecciones: salida.proyecciones,
    })
    return null
  }
  if (salida.decision.conflictoCon?.length) {
    logger.error('🚨 entregarSuscripcionDePlan: dos planes vivos — la suscripción queda en conflicto, sin pisar la otra', {
      venueId,
      subscriptionId,
      conflictoCon: salida.decision.conflictoCon,
    })
    if (salida.conflictoCreado)
      avisarConflictoCreado({ venueId, subscriptionId, kind: 'DUPLICATE_PLAN', conflictsWith: salida.decision.conflictoCon, detectedBy })
  }
  if (salida.decision.reintentar) throw reintentar('no se pudo verificar en Stripe un vínculo existente')
  if (salida.concedido) logger.info(`✅ entregarSuscripcionDePlan: ${salida.concedido.featureCode} para ${venueId} (sub ${subscriptionId})`)
  return salida.concedido
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
/**
 * 🔴 Codex N3: la pausa de cobranza vigente de una suscripción. Una pausa SIN `resumes_at` (indefinida) cuenta como
 * vigente: es la más peligrosa de todas, no la más inocente.
 */
function pausaDe(sub: Stripe.Subscription): Date | null {
  const pausa = (sub as unknown as { pause_collection?: { resumes_at?: number | null } | null }).pause_collection
  if (!pausa) return null
  return pausa.resumes_at ? new Date(pausa.resumes_at * 1000) : new Date(8640000000000000)
}

export async function retrievePlanSubscription(subscriptionId: string): Promise<{
  status: string
  cancelAtPeriodEnd: boolean
  currentPeriodEnd: Date | null
  /** Subscription creation timestamp (Stripe `created`, unix seconds → Date) — used for tenure/anti-abuse checks. */
  createdAt: Date | null
  /** Whether the subscription currently carries an active discount (single `discount` or `discounts[]`). */
  hasActiveDiscount: boolean
  /**
   * 🔴 Codex N3: hasta cuándo está PAUSADA la cobranza (`pause_collection.resumes_at`), o `null` si no lo está.
   * Nadie lo leía, y por eso una pausa se podía extender indefinidamente pidiéndola otra vez antes de que venciera.
   */
  pausedUntil: Date | null
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
    pausedUntil: pausaDe(sub),
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
/**
 * 🔴 R0 (Codex, 21-sep): la configuración del Billing Portal que usan LAS DOS puertas que lo abren. Sin
 * fijarla, Stripe usa la de la cuenta — y si ésa deja cambiar de plan o de precio, el cliente se salta la
 * coordinación de la compra. Se crea UNA vez en la cuenta (sin «cambiar suscripción») y su id va en
 * `STRIPE_BILLING_PORTAL_CONFIGURATION_ID`. Sin la variable, todo sigue como antes.
 */
function configuracionDelPortal(): { configuration: string } | Record<string, never> {
  const id = process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID
  return id ? { configuration: id } : {}
}

export async function createCustomerPortalSession(customerId: string, returnUrl: string): Promise<string> {
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
    ...configuracionDelPortal(),
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
/**
 * 🔴 ¿Es esta factura del cliente de Stripe de ESTE negocio? El id llega en la URL: sin esto, con el id
 * de una factura ajena se entregaba su PDF o se cobraba a la tarjeta de otro negocio (21-sep-2026).
 * Se responde 404, no 403: no se confirma que la factura exista.
 */
function exigirFacturaDelCliente(invoice: Stripe.Invoice, customerId: string): void {
  const dueño = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id
  if (!dueño || dueño !== customerId) {
    logger.warn('🚨 Se pidió una factura de OTRO cliente de Stripe; se niega', { invoiceId: invoice.id, customerId })
    throw new AppError('Factura no encontrada', 404, true, 'INVOICE_NOT_FOUND')
  }
}

export async function getInvoicePdfUrl(invoiceId: string, customerId: string): Promise<string> {
  const invoice = await stripe.invoices.retrieve(invoiceId)
  exigirFacturaDelCliente(invoice, customerId)

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
export async function updateSubscriptionPrice(
  subscriptionId: string,
  newPriceId: string,
  opciones?: {
    /**
     * 🔴 Codex R7: se llama JUSTO antes del POST que puede cobrar. Quien llama lo usa para saber si un error posterior
     * ya no demuestra que el cambio no ocurrió; marcarlo antes convertía un fallo de la CONSULTA —que no manda nada— en
     * un desenlace dudoso, y el negocio recibía un 202 por algo que nunca salió.
     */
    antesDeEnviar?: () => void | Promise<void>
    /** El plan que quien llama cree que vende hoy esta suscripción. Si ya no es ése, no se cambia nada. */
    planOrigen?: string
    /**
     * 🔴 Codex R5: llave ESTABLE del cambio. Un desenlace incierto se responde 202 y el cambio puede repetirse; sin
     * llave, repetirlo factura OTRO prorrateo con `always_invoice`. Con ella, Stripe devuelve el mismo resultado.
     */
    idempotencyKey?: string
  },
): Promise<Stripe.Subscription> {
  // 🔴 Corre bajo el candado de la regla común (Codex C3): cada llamada con tiempo propio y sin reintentos del SDK — un
  // reintento automático del cambio mientras el candado ya se soltó es justo lo que no puede pasar.
  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {}, STRIPE_DENTRO_DEL_CANDADO)

  if (!subscription.items.data[0]) {
    throw new Error('Subscription has no items')
  }

  // 🔴 Codex R9: se cambiaba el PRIMER ítem sin mirar la forma. Con dos conceptos —o con la página incompleta— «el
  // primero» es el que Stripe devolvió de primeras: se podía sustituir el precio de una función suelta creyendo cambiar
  // el plan, y cobrarlo con `always_invoice`. Lo que no se puede identificar ENTERO no se toca.
  const { items, itemsCompletos } = itemsDeSuscripcion(subscription)
  if (!itemsCompletos || items.length !== 1) {
    throw new ConflictError('Tu suscripción tiene más de un concepto; escríbenos para cambiar de plan.', 'CAMBIO_AMBIGUO')
  }
  if (opciones?.planOrigen && !(await suscripcionVendeElPlan({ items, itemsCompletos }, opciones.planOrigen))) {
    throw new ConflictError('Tu suscripción ya no vende el plan que se quiere cambiar; escríbenos.', 'CAMBIO_AMBIGUO')
  }

  const currentItem = subscription.items.data[0]

  logger.info(`🔄 Updating subscription ${subscriptionId} to new price ${newPriceId}`)

  await opciones?.antesDeEnviar?.()
  const updatedSubscription = await stripe.subscriptions.update(
    subscriptionId,
    {
      items: [
        {
          id: currentItem.id,
          price: newPriceId,
        },
      ],
      proration_behavior: 'always_invoice',
      // 🔴 Codex R5: NO se manda `proration_date`. La llave de idempotencia exige que el cuerpo sea idéntico en un
      // reintento, y un `Date.now()` cambia entre intentos: Stripe rechazaría la repetición por «parámetros
      // distintos». Omitirlo deja que Stripe use la hora de la petición, que es EXACTAMENTE lo que hacía antes —
      // se cobran los días que faltan del periodo. 🔴 Anclarlo al inicio del periodo también estabilizaría el
      // cuerpo, pero cambia el DINERO: cobraría el periodo completo en vez del remanente.
    },
    { ...STRIPE_DENTRO_DEL_CANDADO, ...(opciones?.idempotencyKey ? { idempotencyKey: opciones.idempotencyKey } : {}) },
  )

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
export async function retryInvoicePayment(invoiceId: string, customerId: string): Promise<Stripe.Invoice> {
  // First retrieve the invoice to check its status
  const invoice = await stripe.invoices.retrieve(invoiceId)
  exigirFacturaDelCliente(invoice, customerId)

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
      ...configuracionDelPortal(),
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
