import { createMasterCatalogControlPlaneService } from '@/services/master-catalog/masterCatalogControlPlane.service'

const actor = { type: 'HUMAN' as const, staffId: 'staff-root', impersonating: false }

function harness() {
  const tx = {
    organization: { findUnique: jest.fn(), findMany: jest.fn() },
    staffVenue: { findFirst: jest.fn().mockResolvedValue({ id: 'superadmin-role' }) },
    venue: { findFirst: jest.fn().mockResolvedValue({ id: 'venue-pits' }) },
    organizationEntitlement: { upsert: jest.fn() },
    module: { findUnique: jest.fn() },
    organizationModule: { upsert: jest.fn(), updateMany: jest.fn() },
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
})
