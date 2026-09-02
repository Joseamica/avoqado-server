import type Stripe from 'stripe'
import type { PlatformWebhookClassificationResult } from './platformWebhookClassifier.service'
import {
  getDispatchFailureContext,
  type CurrentDispatchFailureContext,
  type CurrentDispatchTrace,
} from './platformWebhookCurrentDispatcher.service'
import {
  PLATFORM_WEBHOOK_LIMITS,
  type ClassificationResolution,
  type StripeEventRouteKey,
  type WebhookLease,
  type WebhookShadowState,
} from './platformWebhookInbox.service'

export type DispatchComparisonCode =
  | 'MATCH'
  | 'CLASSIFIED_CURRENT_NO_MATCH'
  | 'CLASSIFIED_CURRENT_ROUTE_MISMATCH'
  | 'CURRENT_EFFECT_WITHOUT_AUTHORITY'
  | 'MULTIPLE_CURRENT_BRANCHES'
  | 'CLASSIFICATION_PENDING'
  | 'NO_AUTHORITY_NO_CURRENT_EFFECT'

interface ProcessorInbox {
  load(eventId: string): Promise<{ id: string; stripeEventId: string; eventType: string; payload: unknown }>
  loadShadowState(eventId: string): Promise<WebhookShadowState>
  acquire(eventId: string, phase: 'CLASSIFICATION' | 'EFFECT', options?: { manual?: boolean }): Promise<WebhookLease | null>
  renew(lease: WebhookLease): Promise<WebhookLease>
  finalizeClassification(lease: WebhookLease, resolution: ClassificationResolution): Promise<void>
  retry(lease: WebhookLease, error: { code?: string; message?: string }): Promise<void>
  heartbeat(lease: WebhookLease): Promise<WebhookLease>
  finalizeEffectWithObservation(
    lease: WebhookLease,
    observation: {
      webhookEventId: string
      effectAttempt: number
      steps: unknown[]
      effectOutcome: 'SUCCESS' | 'FAILED'
      failureStep: string | null
      comparisonCode: DispatchComparisonCode
    },
    result:
      | { outcome: 'SUCCESS'; processingTime?: number }
      | { outcome: 'FAILED'; processingTime?: number; error: { code: string; message: string } },
  ): Promise<void>
}

interface ProcessorClassifier {
  classify(event: {
    webhookEventId: string
    stripeEventId: string
    type: string
    object: unknown
  }): Promise<PlatformWebhookClassificationResult>
}

interface ProcessorLogger {
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

interface HeartbeatHandle {
  stop(): void
}

function defaultHeartbeatScheduler(callback: () => Promise<void>, intervalMs: number): HeartbeatHandle {
  const timer = setInterval(() => void callback(), intervalMs)
  timer.unref?.()
  return { stop: () => clearInterval(timer) }
}

function durableObject(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('WEBHOOK_CANONICAL_PAYLOAD_MISMATCH')
  }
  const data = (payload as Record<string, unknown>).data
  if (typeof data !== 'object' || data === null || Array.isArray(data) || !('object' in data)) {
    throw new Error('WEBHOOK_CANONICAL_PAYLOAD_MISMATCH')
  }
  return (data as Record<string, unknown>).object
}

function classificationResolution(result: PlatformWebhookClassificationResult): ClassificationResolution | null {
  if (result.state === 'PENDING') return null
  if (result.state === 'CLASSIFIED') return { state: 'CLASSIFIED', authority: result.authority }
  if (result.state === 'IGNORED') return { state: 'IGNORED', code: result.code }
  return { state: 'UNRESOLVED', code: result.code }
}

export function compareCurrentDispatchToClassification(
  classification: WebhookShadowState,
  currentRoutes: StripeEventRouteKey[],
): DispatchComparisonCode {
  const routes = [...new Set(currentRoutes)]
  if (classification.classificationState === 'PENDING_CLASSIFICATION') return 'CLASSIFICATION_PENDING'
  if (routes.length > 1) return 'MULTIPLE_CURRENT_BRANCHES'

  const authority = classification.classificationState === 'CLASSIFIED' ? classification.authority : null
  if (!authority) return routes.length === 0 ? 'NO_AUTHORITY_NO_CURRENT_EFFECT' : 'CURRENT_EFFECT_WITHOUT_AUTHORITY'
  if (routes.length === 0) return 'CLASSIFIED_CURRENT_NO_MATCH'
  return routes[0] === authority.routeKey ? 'MATCH' : 'CLASSIFIED_CURRENT_ROUTE_MISMATCH'
}

export function createPlatformWebhookShadowProcessor(dependencies: {
  inbox: ProcessorInbox
  classifier: ProcessorClassifier
  dispatch(event: Stripe.Event, localWebhookEventId: string): Promise<CurrentDispatchTrace>
  logger: ProcessorLogger
  scheduleHeartbeat?: (callback: () => Promise<void>, intervalMs: number) => HeartbeatHandle
  now?: () => number
}) {
  const scheduleHeartbeat = dependencies.scheduleHeartbeat ?? defaultHeartbeatScheduler
  const now = dependencies.now ?? Date.now

  function isStaleLease(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'STALE_WEBHOOK_LEASE'
  }

  async function validatedLease(
    eventId: string,
    phase: 'CLASSIFICATION' | 'EFFECT',
    providedLease?: WebhookLease,
  ): Promise<WebhookLease | null> {
    if (!providedLease) return dependencies.inbox.acquire(eventId, phase)
    try {
      return await dependencies.inbox.renew(providedLease)
    } catch (error) {
      if (!isStaleLease(error)) throw error
      dependencies.logger.warn('Platform webhook stale provided lease skipped before phase execution', {
        webhookEventId: eventId,
        phase,
        attempt: providedLease.attempt,
      })
      return null
    }
  }

  async function processClassification(eventId: string, providedLease?: WebhookLease): Promise<'COMPLETED' | 'SKIPPED'> {
    const lease = await validatedLease(eventId, 'CLASSIFICATION', providedLease)
    if (!lease) return 'SKIPPED'
    const durable = await dependencies.inbox.load(eventId)
    const signedObject = durableObject(durable.payload)

    let result: PlatformWebhookClassificationResult
    try {
      result = await dependencies.classifier.classify({
        webhookEventId: durable.id,
        stripeEventId: durable.stripeEventId,
        type: durable.eventType,
        object: signedObject,
      })
    } catch (error) {
      try {
        await dependencies.inbox.retry(lease, {
          code: error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code) : 'WEBHOOK_CLASSIFICATION_FAILED',
          message: error instanceof Error ? error.message : 'Platform webhook classification failed',
        })
      } catch (retryError) {
        dependencies.logger.error('Platform webhook classification retry bookkeeping failed', {
          webhookEventId: eventId,
          error: retryError instanceof Error ? retryError.message : String(retryError),
        })
      }
      throw error
    }

    const resolution = classificationResolution(result)
    if (result.state === 'PENDING') {
      await dependencies.inbox.retry(lease, {
        code: result.code,
        message: 'Platform webhook classification remains pending',
      })
    } else {
      await dependencies.inbox.finalizeClassification(lease, resolution!)
    }
    return 'COMPLETED'
  }

  async function shadowState(eventId: string): Promise<WebhookShadowState> {
    try {
      return await dependencies.inbox.loadShadowState(eventId)
    } catch (error) {
      dependencies.logger.warn('Platform webhook classification state unavailable during effect observation', {
        webhookEventId: eventId,
        error: error instanceof Error ? error.message : String(error),
      })
      return { classificationState: 'PENDING_CLASSIFICATION', authority: null }
    }
  }

  function failureContext(error: unknown): CurrentDispatchFailureContext {
    const fromDispatcher = getDispatchFailureContext(error)
    if (fromDispatcher) return fromDispatcher
    const attached =
      typeof error === 'object' && error !== null && 'dispatchFailureContext' in error
        ? (error as { dispatchFailureContext?: CurrentDispatchFailureContext }).dispatchFailureContext
        : undefined
    return attached ?? { failureStep: 'COMMERCIAL_ADAPTER', steps: [], effectiveRouteKeys: [] }
  }

  async function processEffect(eventId: string, providedLease?: WebhookLease): Promise<'COMPLETED' | 'SKIPPED'> {
    const lease = await validatedLease(eventId, 'EFFECT', providedLease)
    if (!lease) return 'SKIPPED'
    let activeLease = lease
    const durable = await dependencies.inbox.load(eventId)
    const event = durable.payload as Stripe.Event
    durableObject(event)
    const startedAt = now()
    const heartbeat = scheduleHeartbeat(async () => {
      try {
        activeLease = await dependencies.inbox.heartbeat(activeLease)
      } catch (error) {
        dependencies.logger.error('Platform webhook EFFECT heartbeat failed', {
          webhookEventId: eventId,
          effectAttempt: activeLease.attempt,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }, PLATFORM_WEBHOOK_LIMITS.effectHeartbeatMs)

    try {
      let dispatchError: unknown
      let trace: CurrentDispatchTrace
      try {
        trace = await dependencies.dispatch(event, durable.id)
      } catch (error) {
        dispatchError = error
        trace = failureContext(error)
      }

      const classification = await shadowState(eventId)
      const comparisonCode = compareCurrentDispatchToClassification(classification, trace.effectiveRouteKeys)
      const processingTime = Math.max(0, now() - startedAt)
      const failed = dispatchError !== undefined
      const context = failed ? failureContext(dispatchError) : null
      const observation = {
        webhookEventId: eventId,
        effectAttempt: lease.attempt,
        steps: trace.steps,
        effectOutcome: failed ? ('FAILED' as const) : ('SUCCESS' as const),
        failureStep: context?.failureStep ?? null,
        comparisonCode,
      }

      try {
        await dependencies.inbox.finalizeEffectWithObservation(
          activeLease,
          observation,
          failed
            ? {
                outcome: 'FAILED',
                processingTime,
                error: {
                  code:
                    dispatchError instanceof Error && 'code' in dispatchError
                      ? String((dispatchError as { code?: unknown }).code)
                      : 'WEBHOOK_EFFECT_FAILED',
                  message: dispatchError instanceof Error ? dispatchError.message : 'Platform webhook effect dispatch failed',
                },
              }
            : { outcome: 'SUCCESS', processingTime },
        )
      } catch (finalizeError) {
        if (failed) {
          dependencies.logger.error('Platform webhook failed effect observation could not be persisted', {
            webhookEventId: eventId,
            effectAttempt: lease.attempt,
            error: finalizeError instanceof Error ? finalizeError.message : String(finalizeError),
          })
        } else {
          throw finalizeError
        }
      }

      dependencies.logger.info('Platform webhook EFFECT observed', {
        webhookEventId: eventId,
        effectAttempt: activeLease.attempt,
        effectOutcome: observation.effectOutcome,
        comparisonCode,
      })
      if (failed) throw dispatchError
      dependencies.logger.info('Platform webhook EFFECT completed', {
        webhookEventId: eventId,
        effectAttempt: activeLease.attempt,
        comparisonCode,
      })
      return 'COMPLETED'
    } finally {
      heartbeat.stop()
    }
  }

  async function processIngress(
    eventId: string,
    input: { mode: 'OFF' | 'SHADOW'; created: boolean },
  ): Promise<{ classification: 'COMPLETED' | 'FAILED' | 'SKIPPED'; effect: 'COMPLETED' | 'FAILED' | 'SKIPPED' }> {
    let classification: 'COMPLETED' | 'FAILED' | 'SKIPPED' = 'SKIPPED'
    let effect: 'COMPLETED' | 'FAILED' | 'SKIPPED' = 'SKIPPED'
    if (input.mode === 'SHADOW') {
      try {
        classification = await processClassification(eventId)
      } catch (error) {
        classification = 'FAILED'
        dependencies.logger.error('Platform webhook inline CLASSIFICATION failed after durability', {
          webhookEventId: eventId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    if (input.mode === 'SHADOW' || input.created) {
      try {
        effect = await processEffect(eventId)
      } catch (error) {
        effect = 'FAILED'
        dependencies.logger.error('Platform webhook inline EFFECT failed after durability', {
          webhookEventId: eventId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return { classification, effect }
  }

  return { processClassification, processEffect, processIngress }
}
