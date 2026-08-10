import { createCatalogGovernanceService, resolveLegacyCatalogActor } from '@/services/master-catalog/catalogGovernance.service'

const NOW = new Date('2026-08-09T12:00:00.000Z')
const humanActor = { type: 'HUMAN' as const, staffId: 'staff-1', impersonating: false }

function governanceTx() {
  return {
    module: {
      findUnique: jest.fn().mockResolvedValue({
        defaultConfig: {
          schemaVersion: 1,
          catalogCoreEnabled: true,
          identifiersEnabled: false,
          regionalPricingEnabled: false,
          governanceMode: 'ENFORCED',
        },
        organizationModules: [{ config: null }],
      }),
    },
    catalogVenueRollout: {
      findUnique: jest.fn().mockResolvedValue({ governanceState: 'ENFORCED' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    venue: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  }
}

function harness(cutoff: Date | null = NOW) {
  const tx = governanceTx()
  const dependencies = {
    acquireFence: jest.fn().mockResolvedValue({
      id: 'venue-1',
      organizationId: 'org-1',
      catalogGovernanceEnforcedAt: cutoff,
    }),
    writeCatalogAudit: jest.fn().mockResolvedValue(undefined),
    assertControlPlaneAccess: jest.fn().mockResolvedValue(undefined),
    now: jest.fn(() => NOW),
  }
  return { tx, dependencies, service: createCatalogGovernanceService(dependencies) }
}

describe('catalogGovernance.service — legacy gate', () => {
  it('classifies the synthetic break-glass identity as SERVICE instead of a Staff FK', () => {
    expect(resolveLegacyCatalogActor('MASTER_ADMIN', false)).toEqual({
      type: 'SERVICE',
      servicePrincipalId: 'MASTER_ADMIN',
    })
    expect(resolveLegacyCatalogActor('staff-1', true)).toEqual({
      type: 'HUMAN',
      staffId: 'staff-1',
      impersonating: true,
    })
  })

  it('derives activation from the tenant Product locked after the Venue fence', async () => {
    const h = harness()
    const lockProduct = jest.fn().mockResolvedValue({ id: 'product-1', active: false })
    const service = createCatalogGovernanceService({ ...h.dependencies, lockProduct } as never)

    await expect(
      service.assertLegacyProductUpdate(h.tx as never, {
        organizationId: 'org-1',
        venueId: 'venue-1',
        productId: 'product-1',
        requestedActive: true,
        actor: humanActor,
      }),
    ).rejects.toMatchObject({ code: 'CATALOG_GOVERNANCE_REQUIRED' })

    expect(h.dependencies.acquireFence.mock.invocationCallOrder[0]).toBeLessThan(lockProduct.mock.invocationCallOrder[0]!)
    expect(lockProduct).toHaveBeenCalledWith(h.tx, {
      organizationId: 'org-1',
      venueId: 'venue-1',
      productId: 'product-1',
    })
  })

  it('takes one Venue fence before computing a bulk CREATE preflight', async () => {
    const h = harness()
    const inspect = jest.fn().mockResolvedValue(false)

    await h.service.assertLegacyComputed(
      h.tx as never,
      {
        organizationId: 'org-1',
        venueId: 'venue-1',
        operation: 'CREATE',
        actor: humanActor,
      },
      inspect,
    )

    expect(h.dependencies.acquireFence).toHaveBeenCalledTimes(1)
    expect(h.dependencies.acquireFence.mock.invocationCallOrder[0]).toBeLessThan(inspect.mock.invocationCallOrder[0]!)
  })

  it('does not treat a still-active locked Product as a new activation', async () => {
    const h = harness()
    const service = createCatalogGovernanceService({
      ...h.dependencies,
      lockProduct: jest.fn().mockResolvedValue({ id: 'product-1', active: true }),
    } as never)

    await expect(
      service.assertLegacyProductUpdate(h.tx as never, {
        organizationId: 'org-1',
        venueId: 'venue-1',
        productId: 'product-1',
        requestedActive: true,
        actor: humanActor,
      }),
    ).resolves.toEqual({ id: 'product-1', active: true })
    expect(h.tx.module.findUnique).not.toHaveBeenCalled()
  })

  it('uses the null-cutoff byte-compatible fast path without rollout/config dependencies', async () => {
    const h = harness(null)

    await expect(
      h.service.assertLegacy(h.tx as never, {
        organizationId: 'org-1',
        venueId: 'venue-1',
        operation: 'CREATE',
        willBeVendable: true,
        actor: humanActor,
      }),
    ).resolves.toBeUndefined()
    expect(h.tx.module.findUnique).not.toHaveBeenCalled()
    expect(h.tx.catalogVenueRollout.findUnique).not.toHaveBeenCalled()
  })

  it.each([
    ['OFF org', 'OFF', 'ENFORCED', true],
    ['ADVISORY org', 'ADVISORY', 'ENFORCED', true],
    ['venue not ENFORCED', 'ENFORCED', 'READY_TO_ENFORCE', true],
    ['both ENFORCED', 'ENFORCED', 'ENFORCED', false],
  ])('implements the exact two-dimensional truth table: %s', async (_label, governanceMode, governanceState, allowed) => {
    const h = harness()
    h.tx.module.findUnique.mockResolvedValue({
      defaultConfig: {
        schemaVersion: 1,
        catalogCoreEnabled: false,
        identifiersEnabled: false,
        regionalPricingEnabled: false,
        governanceMode,
      },
      organizationModules: [{ enabled: false, config: null }],
    })
    h.tx.catalogVenueRollout.findUnique.mockResolvedValue({ governanceState })

    const result = h.service.assertLegacy(h.tx as never, {
      organizationId: 'org-1',
      venueId: 'venue-1',
      operation: 'ACTIVATE',
      willBeVendable: true,
      actor: humanActor,
    })

    if (allowed) await expect(result).resolves.toBeUndefined()
    else {
      await expect(result).rejects.toMatchObject({
        statusCode: 422,
        code: 'CATALOG_GOVERNANCE_REQUIRED',
        message: 'Este producto debe crearse o activarse desde el Catálogo maestro.',
        details: { action: 'OPEN_MASTER_CATALOG' },
      })
    }
  })

  it('allows inactive placeholders after the shared fence without consulting live governance dependencies', async () => {
    const h = harness()

    await expect(
      h.service.assertLegacy(h.tx as never, {
        organizationId: 'org-1',
        venueId: 'venue-1',
        operation: 'CREATE',
        willBeVendable: false,
        actor: { type: 'SERVICE', servicePrincipalId: 'DELIVERY_INGESTION' },
      }),
    ).resolves.toBeUndefined()
    expect(h.tx.module.findUnique).not.toHaveBeenCalled()
    expect(h.tx.catalogVenueRollout.findUnique).not.toHaveBeenCalled()
  })

  it('writes SERVICE Product provenance in the same caller transaction', async () => {
    const h = harness(null)
    const actor = { type: 'SERVICE' as const, servicePrincipalId: 'POS_SYNC' }

    await h.service.writeLegacyServiceProductCreationAudit(h.tx as never, {
      organizationId: 'org-1',
      venueId: 'venue-1',
      productId: 'product-1',
      actor,
    })

    expect(h.dependencies.writeCatalogAudit).toHaveBeenCalledWith(h.tx, {
      organizationId: 'org-1',
      venueId: 'venue-1',
      actor,
      action: 'CATALOG_LEGACY_PRODUCT_CREATED',
      entity: 'Product',
      entityId: 'product-1',
    })
  })

  it('fails closed with a dependency error instead of the business 422 when stored config is malformed', async () => {
    const h = harness()
    h.tx.module.findUnique.mockResolvedValue({ defaultConfig: { schemaVersion: 99 }, organizationModules: [] })

    await expect(
      h.service.assertLegacy(h.tx as never, {
        organizationId: 'org-1',
        venueId: 'venue-1',
        operation: 'CREATE',
        willBeVendable: true,
        actor: humanActor,
      }),
    ).rejects.toMatchObject({ statusCode: 503, code: 'CATALOG_GOVERNANCE_DEPENDENCY_UNAVAILABLE' })
  })
})

describe('catalogGovernance.service — ENFORCED transition', () => {
  it('co-commits the first cutoff, rollout state and classified audit under the Venue fence', async () => {
    const h = harness(null)

    await expect(
      h.service.transitionToEnforced(h.tx as never, {
        organizationId: 'org-1',
        venueId: 'venue-1',
        actor: humanActor,
        enforcedAt: NOW,
      }),
    ).resolves.toEqual({ governanceState: 'ENFORCED', catalogGovernanceEnforcedAt: NOW })
    expect(h.tx.venue.updateMany).toHaveBeenCalledWith({
      where: { id: 'venue-1', organizationId: 'org-1', catalogGovernanceEnforcedAt: null },
      data: { catalogGovernanceEnforcedAt: NOW },
    })
    expect(h.tx.catalogVenueRollout.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', venueId: 'venue-1' },
      data: { governanceState: 'ENFORCED', updatedById: 'staff-1' },
    })
    expect(h.dependencies.writeCatalogAudit).toHaveBeenCalledWith(
      h.tx,
      expect.objectContaining({ action: 'CATALOG_GOVERNANCE_ENFORCED', venueId: 'venue-1', actor: humanActor }),
    )
    expect(h.dependencies.assertControlPlaneAccess).toHaveBeenCalledWith(h.tx, 'org-1', humanActor)
  })

  it('accepts exact cutoff replay but rejects attempts to move the write-once chronology', async () => {
    const exact = harness(NOW)
    await expect(
      exact.service.transitionToEnforced(exact.tx as never, {
        organizationId: 'org-1',
        venueId: 'venue-1',
        actor: humanActor,
        enforcedAt: NOW,
      }),
    ).resolves.toEqual({ governanceState: 'ENFORCED', catalogGovernanceEnforcedAt: NOW })
    expect(exact.tx.venue.updateMany).not.toHaveBeenCalled()
    expect(exact.tx.catalogVenueRollout.updateMany).not.toHaveBeenCalled()
    expect(exact.dependencies.writeCatalogAudit).not.toHaveBeenCalled()

    const paused = harness(NOW)
    paused.tx.catalogVenueRollout.findUnique.mockResolvedValue({ governanceState: 'PAUSED' })
    await expect(
      paused.service.transitionToEnforced(paused.tx as never, {
        organizationId: 'org-1',
        venueId: 'venue-1',
        actor: humanActor,
        enforcedAt: NOW,
      }),
    ).resolves.toEqual({ governanceState: 'ENFORCED', catalogGovernanceEnforcedAt: NOW })
    expect(paused.tx.catalogVenueRollout.updateMany).toHaveBeenCalledTimes(1)
    expect(paused.dependencies.writeCatalogAudit).toHaveBeenCalledTimes(1)

    const moved = harness(NOW)
    await expect(
      moved.service.transitionToEnforced(moved.tx as never, {
        organizationId: 'org-1',
        venueId: 'venue-1',
        actor: humanActor,
        enforcedAt: new Date('2026-08-09T12:00:01.000Z'),
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CATALOG_GOVERNANCE_CUTOFF_IMMUTABLE' })
  })
})
