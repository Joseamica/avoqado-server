import { createMasterCatalogControlPlaneService } from '@/services/master-catalog/masterCatalogControlPlane.service'

const actor = { type: 'HUMAN' as const, staffId: 'staff-root', impersonating: false }

function harness() {
  const tx = {
    organization: { findUnique: jest.fn(), findMany: jest.fn() },
    staffVenue: { findFirst: jest.fn().mockResolvedValue({ id: 'superadmin-role' }) },
    venue: { findFirst: jest.fn().mockResolvedValue({ id: 'venue-pits' }) },
    organizationEntitlement: { findUnique: jest.fn(), upsert: jest.fn() },
    module: { findUnique: jest.fn() },
    organizationModule: { findUnique: jest.fn(), upsert: jest.fn(), updateMany: jest.fn() },
    catalogClientObservation: { findMany: jest.fn() },
    catalogPublicationLine: { findMany: jest.fn() },
    catalogVenueRollout: { findUnique: jest.fn() },
  } as any
  const db = { ...tx, $transaction: jest.fn((work: any) => work(tx)) } as any
  const writeCatalogAudit = jest.fn()
  const transitionCatalogGovernanceToEnforced = jest.fn()
  const resolveMasterCatalogAccess = jest.fn().mockResolvedValue({ canConfigureControlPlane: true })
  tx.organization.findUnique.mockResolvedValue({ id: 'org-pits' })
  return {
    tx,
    db,
    writeCatalogAudit,
    transitionCatalogGovernanceToEnforced,
    resolveMasterCatalogAccess,
    service: createMasterCatalogControlPlaneService({
      db,
      writeCatalogAudit,
      transitionCatalogGovernanceToEnforced,
      resolveMasterCatalogAccess,
    }),
  }
}

describe('master catalog control plane', () => {
  it('denies a revoked SUPERADMIN before organization enumeration or target lookup', async () => {
    const h = harness()
    h.tx.staffVenue.findFirst.mockResolvedValue(null)

    await expect(h.service.listOrganizations(actor, {})).rejects.toMatchObject({ statusCode: 403 })
    await expect(h.service.getOrganization('missing-org', actor)).rejects.toMatchObject({ statusCode: 403 })

    expect(h.tx.organization.findMany).not.toHaveBeenCalled()
    expect(h.tx.organization.findUnique).not.toHaveBeenCalled()
  })

  it('returns stable not-found before entitlement writes for an unknown organization', async () => {
    const h = harness()
    h.tx.organization.findUnique.mockResolvedValue(null)

    await expect(
      h.service.updateEntitlement('missing-org', actor, {
        status: 'ACTIVE',
        source: 'CONTRACT',
        reason: 'Contrato vigente',
        startsAt: '2026-08-09T00:00:00.000Z',
        endsAt: null,
      }),
    ).rejects.toMatchObject({ statusCode: 404 })
    expect(h.tx.organizationEntitlement.upsert).not.toHaveBeenCalled()
  })

  it('rejects equal or inverted entitlement windows before transaction writes', async () => {
    const h = harness()
    for (const endsAt of ['2026-08-09T00:00:00.000Z', '2026-08-08T00:00:00.000Z']) {
      await expect(
        h.service.updateEntitlement('org-pits', actor, {
          status: 'ACTIVE',
          source: 'CONTRACT',
          reason: 'Contrato vigente',
          startsAt: '2026-08-09T00:00:00.000Z',
          endsAt,
        }),
      ).rejects.toMatchObject({ statusCode: 422 })
    }
    expect(h.tx.organizationEntitlement.upsert).not.toHaveBeenCalled()
    expect(h.writeCatalogAudit).not.toHaveBeenCalled()
  })

  it('writes entitlement and classified audit atomically', async () => {
    const h = harness()
    h.tx.organizationEntitlement.upsert.mockResolvedValue({ id: 'entitlement-1', status: 'ACTIVE' })

    await h.service.updateEntitlement('org-pits', actor, {
      status: 'ACTIVE',
      source: 'CONTRACT',
      reason: 'Contrato vigente',
      startsAt: '2026-08-09T00:00:00.000Z',
      endsAt: null,
    })

    expect(h.db.$transaction).toHaveBeenCalledTimes(1)
    expect(h.tx.organizationEntitlement.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId_featureCode: { organizationId: 'org-pits', featureCode: 'MASTER_CATALOG' } } }),
    )
    expect(h.writeCatalogAudit).toHaveBeenCalledWith(h.tx, expect.objectContaining({ action: 'CATALOG_ENTITLEMENT_UPDATED', actor }))
  })

  it('uses the organization-only module definition and audits in the same transaction', async () => {
    const h = harness()
    h.tx.module.findUnique.mockResolvedValue({ id: 'module-1', scope: 'ORGANIZATION_ONLY', active: true })
    h.tx.organizationModule.upsert.mockResolvedValue({ id: 'org-module-1', enabled: true })

    await h.service.updateModule('org-pits', actor, { enabled: true })

    expect(h.tx.organizationModule.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ enabledBy: 'staff-root' }) }),
    )
    expect(h.writeCatalogAudit).toHaveBeenCalledWith(h.tx, expect.objectContaining({ action: 'CATALOG_MODULE_UPDATED' }))
  })

  it('delegates the write-once governance transition inside one transaction', async () => {
    const h = harness()
    h.transitionCatalogGovernanceToEnforced.mockResolvedValue({ governanceState: 'ENFORCED' })

    await h.service.updateGovernance('org-pits', 'venue-pits', actor, { governanceState: 'ENFORCED' })

    expect(h.transitionCatalogGovernanceToEnforced).toHaveBeenCalledWith(h.tx, {
      organizationId: 'org-pits',
      venueId: 'venue-pits',
      actor,
    })
  })

  it('returns the complete operator read model without inventing rollout or client readiness', async () => {
    const h = harness()
    const observedAt = new Date('2026-01-01T00:00:00.000Z')
    const updatedAt = new Date('2026-08-09T18:00:00.000Z')
    h.tx.organization.findUnique.mockResolvedValue({
      id: 'org-pits',
      name: 'PITS',
      slug: 'pits',
      organizationEntitlements: [
        {
          id: 'grant-1',
          status: 'ACTIVE',
          source: 'CONTRACT',
          startsAt: new Date('2026-08-01T00:00:00.000Z'),
          endsAt: null,
          reason: 'Contrato firmado',
          grantedById: 'staff-root',
          createdAt: new Date('2026-08-01T00:00:00.000Z'),
          updatedAt,
          grantedBy: { id: 'staff-root', firstName: 'Ana', lastName: 'Admin', email: 'ana@example.com' },
        },
      ],
      organizationModules: [
        {
          id: 'org-module-1',
          enabled: true,
          enabledBy: 'staff-root',
          enabledAt: new Date('2026-08-02T00:00:00.000Z'),
          createdAt: new Date('2026-08-02T00:00:00.000Z'),
          updatedAt,
          module: { active: true, scope: 'ORGANIZATION_ONLY' },
        },
      ],
      venues: [
        {
          id: 'venue-pits',
          name: 'PITS Centro',
          currency: 'MXN',
          timezone: 'America/Mexico_City',
          catalogGovernanceEnforcedAt: null,
          catalogVenueRollouts: [
            {
              registryState: 'READY',
              aliasPublicationState: 'CLIENTS_NOT_READY',
              governanceState: 'CLIENTS_NOT_READY',
              identifierRevision: 0n,
              createdAt: new Date('2026-08-02T00:00:00.000Z'),
              updatedAt,
              updatedBy: { id: 'staff-root', firstName: 'Ana', lastName: 'Admin', email: 'ana@example.com' },
            },
          ],
          catalogVenueClientRequirements: [
            {
              family: 'TPV',
              mode: 'REQUIRED',
              minimumVersion: '2.0.0',
              maxObservationAgeDays: 30,
            },
          ],
          catalogClientReadinessOverrides: [],
        },
      ],
    })
    h.tx.catalogClientObservation.findMany.mockResolvedValue([
      {
        venueId: 'venue-pits',
        family: 'TPV',
        deviceId: 'device-1',
        appVersion: '2.1.0',
        lastSeenAt: observedAt,
        source: 'heartbeat',
      },
    ])
    h.tx.catalogPublicationLine.findMany.mockResolvedValue([
      {
        venueId: 'venue-pits',
        batch: {
          failureCode: 'CATALOG_PUBLICATION_STALE',
          failureMessage: 'La publicación quedó stale.',
          updatedAt,
          actorType: 'HUMAN',
          staffId: 'staff-root',
          servicePrincipalId: null,
          staff: { id: 'staff-root', firstName: 'Ana', lastName: 'Admin', email: 'ana@example.com' },
        },
      },
    ])
    h.resolveMasterCatalogAccess.mockResolvedValue({
      organizationId: 'org-pits',
      entitlementActive: true,
      moduleActive: true,
      config: {
        schemaVersion: 1,
        catalogCoreEnabled: true,
        identifiersEnabled: false,
        regionalPricingEnabled: false,
        governanceMode: 'ADVISORY',
      },
      reasonCode: 'ACCESSIBLE',
      canConfigureControlPlane: true,
    })

    const result = await h.service.getOrganization('org-pits', actor)

    expect(result).toMatchObject({
      organization: { id: 'org-pits', name: 'PITS', slug: 'pits' },
      entitlement: { id: 'grant-1', source: 'CONTRACT', status: 'ACTIVE' },
      module: { id: 'org-module-1', enabled: true, definitionActive: true, scope: 'ORGANIZATION_ONLY' },
      venues: [
        {
          id: 'venue-pits',
          rollout: {
            registryState: 'READY',
            aliasPublicationState: 'CLIENTS_NOT_READY',
            governanceState: 'CLIENTS_NOT_READY',
            identifierRevision: '0',
          },
          readiness: {
            state: 'NOT_READY',
            staleFamilies: ['TPV'],
            missingFamilies: [],
          },
          lastFailure: {
            code: 'CATALOG_PUBLICATION_STALE',
            message: 'La publicación quedó stale.',
          },
        },
      ],
    })
  })

  it('only treats readiness as overridden when active overrides cover every failing family', async () => {
    const h = harness()
    const activeOverride = {
      id: 'override-tpv',
      family: 'TPV' as string | null,
      status: 'ACTIVE',
      reason: 'Canary controlado',
      expiresAt: new Date('2099-08-11T00:00:00.000Z'),
      revokedAt: null,
      revocationReason: null,
      createdAt: new Date('2026-08-09T00:00:00.000Z'),
      updatedAt: new Date('2026-08-09T00:00:00.000Z'),
    }
    const organization = {
      id: 'org-pits',
      name: 'PITS',
      slug: 'pits',
      organizationEntitlements: [],
      organizationModules: [],
      venues: [
        {
          id: 'venue-pits',
          name: 'PITS Centro',
          currency: 'MXN',
          timezone: 'America/Mexico_City',
          catalogGovernanceEnforcedAt: null,
          catalogVenueRollouts: [],
          catalogVenueClientRequirements: [
            { family: 'TPV', mode: 'REQUIRED', minimumVersion: null, maxObservationAgeDays: 30 },
            { family: 'ANDROID', mode: 'REQUIRED', minimumVersion: null, maxObservationAgeDays: 30 },
          ],
          catalogClientReadinessOverrides: [activeOverride],
        },
      ],
    }
    h.tx.organization.findUnique.mockResolvedValue(organization)
    h.tx.catalogClientObservation.findMany.mockResolvedValue([])
    h.tx.catalogPublicationLine.findMany.mockResolvedValue([])

    await expect(h.service.getOrganization('org-pits', actor)).resolves.toMatchObject({
      venues: [{ readiness: { state: 'NOT_READY', missingFamilies: ['TPV', 'ANDROID'] } }],
    })

    organization.venues[0].catalogClientReadinessOverrides = [{ ...activeOverride, family: null }]
    await expect(h.service.getOrganization('org-pits', actor)).resolves.toMatchObject({
      venues: [{ readiness: { state: 'OVERRIDDEN' } }],
    })
  })

  it('returns server-authoritative before and after values for every control mutation', async () => {
    const h = harness()
    const beforeGrant = { id: 'grant-1', status: 'REVOKED', source: 'CUSTOM' }
    const afterGrant = { id: 'grant-1', status: 'ACTIVE', source: 'CONTRACT' }
    h.tx.organizationEntitlement.findUnique.mockResolvedValue(beforeGrant)
    h.tx.organizationEntitlement.upsert.mockResolvedValue(afterGrant)

    await expect(
      h.service.updateEntitlement('org-pits', actor, {
        status: 'ACTIVE',
        source: 'CONTRACT',
        reason: 'Contrato vigente',
        startsAt: '2026-08-09T00:00:00.000Z',
        endsAt: null,
      }),
    ).resolves.toEqual({ before: beforeGrant, after: afterGrant })

    const beforeModule = { id: 'org-module-1', enabled: false, config: null }
    const afterModule = { id: 'org-module-1', enabled: true, config: null }
    h.tx.module.findUnique.mockResolvedValue({ id: 'module-1', scope: 'ORGANIZATION_ONLY', active: true })
    h.tx.organizationModule.findUnique.mockResolvedValue(beforeModule)
    h.tx.organizationModule.upsert.mockResolvedValue(afterModule)
    await expect(h.service.updateModule('org-pits', actor, { enabled: true })).resolves.toEqual({
      before: beforeModule,
      after: afterModule,
    })

    const beforeConfig = {
      schemaVersion: 1,
      catalogCoreEnabled: false,
      identifiersEnabled: false,
      regionalPricingEnabled: false,
      governanceMode: 'OFF',
    }
    const afterConfig = { ...beforeConfig, catalogCoreEnabled: true, governanceMode: 'ADVISORY' }
    h.tx.organizationModule.findUnique.mockResolvedValue({ id: 'org-module-1', config: beforeConfig })
    h.tx.organizationModule.updateMany.mockResolvedValue({ count: 1 })
    await expect(h.service.updateConfig('org-pits', actor, { config: afterConfig })).resolves.toEqual({
      before: beforeConfig,
      after: afterConfig,
    })

    h.tx.venue.findFirst.mockResolvedValue({ id: 'venue-pits', catalogGovernanceEnforcedAt: null })
    h.tx.catalogVenueRollout.findUnique.mockResolvedValue({
      governanceState: 'READY_TO_ENFORCE',
      updatedAt: new Date('2026-08-09T00:00:00.000Z'),
    })
    h.transitionCatalogGovernanceToEnforced.mockResolvedValue({
      governanceState: 'ENFORCED',
      catalogGovernanceEnforcedAt: new Date('2026-08-10T00:00:00.000Z'),
    })
    await expect(h.service.updateGovernance('org-pits', 'venue-pits', actor, { governanceState: 'ENFORCED' })).resolves.toMatchObject({
      before: { governanceState: 'READY_TO_ENFORCE', catalogGovernanceEnforcedAt: null },
      after: { governanceState: 'ENFORCED' },
    })
  })
})
