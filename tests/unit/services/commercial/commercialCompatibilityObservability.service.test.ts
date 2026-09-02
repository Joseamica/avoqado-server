import logger from '@/config/logger'
import { runWithContext } from '@/observability/executionContext'
import {
  CommercialCatalogOfferCompatibilityError,
  type CommercialCatalogOfferCompatibilityCounts,
} from '@/services/commercial/offers/commercialCatalogOfferCompatibility.service'
import {
  runWithCommercialCompatibilityObservation,
  type CommercialWriterGuardRejectionEvent,
} from '@/services/commercial/offers/commercialCompatibilityObservability.service'
import { CommercialOfferEligibilityError } from '@/services/commercial/offers/commercialOfferEligibility.service'

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

const counts: CommercialCatalogOfferCompatibilityCounts = {
  identityCount: 500,
  matchedIdentityCount: 499,
  maxMatchingRulesPerIdentity: 100,
  resolverInvocationCount: 4,
}

describe('commercial compatibility rejection observability', () => {
  beforeEach(() => jest.clearAllMocks())

  it('observes a compatibility rejection only after the writer transaction has unwound', async () => {
    let transactionOpen = false
    const observe = jest.fn((event: CommercialWriterGuardRejectionEvent) => {
      expect(transactionOpen).toBe(false)
      expect(event).toEqual({
        correlationId: 'corr-task5-observe-001',
        operation: 'CATALOG_PUBLISH',
        code: 'COMMERCIAL_CATALOG_OFFER_INCOMPATIBLE',
        counts,
      })
      expect(event).not.toHaveProperty('rule')
      expect(event).not.toHaveProperty('snapshot')
    })

    await runWithContext(
      { correlationId: 'corr-task5-observe-001', source: 'http', entrypoint: 'POST /commercial/publications' },
      () =>
        expect(
          runWithCommercialCompatibilityObservation(
            'CATALOG_PUBLISH',
            async () => {
              transactionOpen = true
              try {
                throw new CommercialCatalogOfferCompatibilityError('RESOLUTION', counts)
              } finally {
                transactionOpen = false
              }
            },
            observe,
          ),
        ).rejects.toMatchObject({ code: 'COMMERCIAL_CATALOG_OFFER_INCOMPATIBLE' }),
    )

    expect(observe).toHaveBeenCalledTimes(1)
  })

  it('emits one safe structured rejection log and one low-cardinality metric event', async () => {
    await runWithContext(
      { correlationId: 'corr-task5-observe-002', source: 'http', entrypoint: 'POST /commercial/offers' },
      () =>
        expect(
          runWithCommercialCompatibilityObservation('OFFER_PUBLISH', async () => {
            throw new CommercialCatalogOfferCompatibilityError('CROSS_BENEFIT_MATCH', counts)
          }),
        ).rejects.toMatchObject({ code: 'COMMERCIAL_CATALOG_OFFER_INCOMPATIBLE' }),
    )

    const safeFields = {
      correlationId: 'corr-task5-observe-002',
      operation: 'OFFER_PUBLISH',
      code: 'COMMERCIAL_CATALOG_OFFER_INCOMPATIBLE',
      identityCount: 500,
      matchedIdentityCount: 499,
      maxMatchingRulesPerIdentity: 100,
      resolverInvocationCount: 4,
    }
    expect(logger.warn).toHaveBeenCalledWith('Commercial catalog-offer compatibility rejected', {
      event: 'commercial.catalog_offer_compatibility.rejected',
      ...safeFields,
    })
    expect(logger.info).toHaveBeenCalledWith('Commercial metric increment', {
      event: 'metric.increment',
      metricName: 'commercial_catalog_offer_compatibility_rejections_total',
      metricIncrement: 1,
      metricLabels: {
        operation: 'OFFER_PUBLISH',
        code: 'COMMERCIAL_CATALOG_OFFER_INCOMPATIBLE',
      },
      ...safeFields,
    })
    const telemetry = JSON.stringify([
      ...(logger.warn as jest.Mock).mock.calls,
      ...(logger.info as jest.Mock).mock.calls,
    ]).toLowerCase()
    for (const forbidden of ['cross_benefit_match', 'snapshot', 'utm_', 'gclid', 'fbclid', 'email', 'phone', 'rfc', 'curp']) {
      expect(telemetry).not.toContain(forbidden)
    }
  })

  it('does not hide the business rejection when observability itself fails', async () => {
    const compatibilityError = new CommercialCatalogOfferCompatibilityError('RESOLUTION', counts)

    await expect(
      runWithCommercialCompatibilityObservation(
        'CATALOG_ACTIVATE',
        async () => {
          throw compatibilityError
        },
        () => {
          throw new Error('telemetry unavailable')
        },
      ),
    ).rejects.toBe(compatibilityError)
  })

  it('emits a bounded alert and counter when the eligible-offer capacity fails closed', async () => {
    await runWithContext(
      { correlationId: 'corr-task5-capacity-001', source: 'http', entrypoint: 'POST /commercial/publications' },
      () =>
        expect(
          runWithCommercialCompatibilityObservation('CATALOG_PUBLISH', async () => {
            throw new CommercialOfferEligibilityError('COMMERCIAL_OFFER_ELIGIBILITY_CAPACITY_EXCEEDED')
          }),
        ).rejects.toMatchObject({ code: 'COMMERCIAL_OFFER_ELIGIBILITY_CAPACITY_EXCEEDED' }),
    )

    expect(logger.warn).toHaveBeenCalledWith('Commercial offer eligibility capacity exceeded', {
      event: 'commercial.offer_eligibility.capacity_exceeded',
      correlationId: 'corr-task5-capacity-001',
      operation: 'CATALOG_PUBLISH',
      code: 'COMMERCIAL_OFFER_ELIGIBILITY_CAPACITY_EXCEEDED',
    })
    expect(logger.info).toHaveBeenCalledWith('Commercial metric increment', {
      event: 'metric.increment',
      metricName: 'commercial_offer_eligibility_capacity_exceeded_total',
      metricIncrement: 1,
      metricLabels: {
        operation: 'CATALOG_PUBLISH',
        code: 'COMMERCIAL_OFFER_ELIGIBILITY_CAPACITY_EXCEEDED',
      },
      correlationId: 'corr-task5-capacity-001',
      operation: 'CATALOG_PUBLISH',
      code: 'COMMERCIAL_OFFER_ELIGIBILITY_CAPACITY_EXCEEDED',
    })
  })

  it('does not emit compatibility telemetry for unrelated failures', async () => {
    const observe = jest.fn()
    const infrastructureFailure = new Error('database disconnected')

    await expect(
      runWithCommercialCompatibilityObservation(
        'CATALOG_ROLLBACK',
        async () => {
          throw infrastructureFailure
        },
        observe,
      ),
    ).rejects.toBe(infrastructureFailure)
    expect(observe).not.toHaveBeenCalled()
  })
})
