import logger from '@/config/logger'
import { newCorrelationId } from '@/observability/correlationId'
import { getContext } from '@/observability/executionContext'

import {
  CommercialCatalogOfferCompatibilityError,
  type CommercialCatalogOfferCompatibilityCounts,
} from './commercialCatalogOfferCompatibility.service'
import { CommercialOfferEligibilityError } from './commercialOfferEligibility.service'

export type CommercialCompatibilityOperation =
  | 'CATALOG_PUBLISH'
  | 'OFFER_PUBLISH'
  | 'CATALOG_ACTIVATE'
  | 'CATALOG_ROLLBACK'

export interface CommercialCompatibilityRejectionEvent {
  correlationId: string
  operation: CommercialCompatibilityOperation
  code: 'COMMERCIAL_CATALOG_OFFER_INCOMPATIBLE'
  counts: Readonly<CommercialCatalogOfferCompatibilityCounts>
}

export interface CommercialOfferEligibilityCapacityEvent {
  correlationId: string
  operation: CommercialCompatibilityOperation
  code: 'COMMERCIAL_OFFER_ELIGIBILITY_CAPACITY_EXCEEDED'
}

export type CommercialWriterGuardRejectionEvent = CommercialCompatibilityRejectionEvent | CommercialOfferEligibilityCapacityEvent

type CommercialCompatibilityObserver = (event: CommercialWriterGuardRejectionEvent) => void
type OperationSource = CommercialCompatibilityOperation | (() => CommercialCompatibilityOperation)

function defaultObserver(event: CommercialWriterGuardRejectionEvent): void {
  if (event.code === 'COMMERCIAL_OFFER_ELIGIBILITY_CAPACITY_EXCEEDED') {
    const fields = {
      correlationId: event.correlationId,
      operation: event.operation,
      code: event.code,
    }
    logger.warn('Commercial offer eligibility capacity exceeded', {
      event: 'commercial.offer_eligibility.capacity_exceeded',
      ...fields,
    })
    logger.info('Commercial metric increment', {
      event: 'metric.increment',
      metricName: 'commercial_offer_eligibility_capacity_exceeded_total',
      metricIncrement: 1,
      metricLabels: { operation: event.operation, code: event.code },
      ...fields,
    })
    return
  }
  const fields = {
    correlationId: event.correlationId,
    operation: event.operation,
    code: event.code,
    identityCount: event.counts.identityCount,
    matchedIdentityCount: event.counts.matchedIdentityCount,
    maxMatchingRulesPerIdentity: event.counts.maxMatchingRulesPerIdentity,
    resolverInvocationCount: event.counts.resolverInvocationCount,
  }
  logger.warn('Commercial catalog-offer compatibility rejected', {
    event: 'commercial.catalog_offer_compatibility.rejected',
    ...fields,
  })
  // This is a log-derived counter because the server has no metrics exporter yet. Labels stay
  // bounded to operation + stable public code; the numerical proof counts are fields, never labels.
  logger.info('Commercial metric increment', {
    event: 'metric.increment',
    metricName: 'commercial_catalog_offer_compatibility_rejections_total',
    metricIncrement: 1,
    metricLabels: { operation: event.operation, code: event.code },
    ...fields,
  })
}

export async function runWithCommercialCompatibilityObservation<T>(
  operationSource: OperationSource,
  writer: () => Promise<T>,
  observe: CommercialCompatibilityObserver = defaultObserver,
): Promise<T> {
  try {
    return await writer()
  } catch (error) {
    if (
      error instanceof CommercialCatalogOfferCompatibilityError ||
      (error instanceof CommercialOfferEligibilityError && error.code === 'COMMERCIAL_OFFER_ELIGIBILITY_CAPACITY_EXCEEDED')
    ) {
      const common = {
        correlationId: getContext()?.correlationId ?? newCorrelationId(),
        operation: typeof operationSource === 'function' ? operationSource() : operationSource,
      }
      const event: CommercialWriterGuardRejectionEvent = Object.freeze(
        error instanceof CommercialCatalogOfferCompatibilityError
          ? { ...common, code: error.code, counts: error.counts }
          : { ...common, code: 'COMMERCIAL_OFFER_ELIGIBILITY_CAPACITY_EXCEEDED' as const },
      )
      try {
        observe(event)
      } catch {
        // Observability is deliberately best-effort and must never replace the stable business
        // rejection. The request-level error logger will still retain the correlation id.
      }
    }
    throw error
  }
}
