/** Prepared PostgreSQL proof for the shared Venue chronology fence. */
import type { PrismaClient } from '@prisma/client'
import {
  assertDisposableCatalogPublicationDatabase,
  cleanupCatalogPublicationFixture,
  createCatalogPublicationFixture,
  createCatalogPublicationIntegrationHarness,
  type CatalogPublicationFixture,
  type CatalogPublicationIntegrationHarness,
} from './catalogPublicationIntegrationHarness'

jest.unmock('@/utils/prismaClient')
jest.unmock('@/services/master-catalog/catalogAudit.service')
jest.setTimeout(60_000)

let harness: CatalogPublicationIntegrationHarness | null = null
const fixtures: CatalogPublicationFixture[] = []
let createCatalogGovernanceService: typeof import('@/services/master-catalog/catalogGovernance.service').createCatalogGovernanceService

function h(): CatalogPublicationIntegrationHarness {
  if (!harness) throw new Error('Governance harness was not initialized')
  return harness
}

function human(fixture: CatalogPublicationFixture) {
  return { type: 'HUMAN' as const, staffId: fixture.staffId, impersonating: false }
}

async function setEnforcedPolicy(client: PrismaClient, fixture: CatalogPublicationFixture): Promise<void> {
  await client.organizationModule.updateMany({
    where: { organizationId: fixture.organizationId },
    data: {
      config: {
        schemaVersion: 1,
        catalogCoreEnabled: true,
        identifiersEnabled: false,
        regionalPricingEnabled: false,
        governanceMode: 'ENFORCED',
      },
    },
  })
}

beforeAll(async () => {
  assertDisposableCatalogPublicationDatabase()
  harness = await createCatalogPublicationIntegrationHarness('governance')
  fixtures.push(
    await createCatalogPublicationFixture(h().primary, 'governance-null'),
    await createCatalogPublicationFixture(h().primary, 'governance-writer-first'),
    await createCatalogPublicationFixture(h().primary, 'governance-transition-first'),
    await createCatalogPublicationFixture(h().primary, 'governance-rollback'),
  )
  ;({ createCatalogGovernanceService } = await import('@/services/master-catalog/catalogGovernance.service'))
})

afterAll(async () => {
  try {
    if (harness) {
      for (const fixture of fixtures) await cleanupCatalogPublicationFixture(harness.primary, fixture)
    }
  } finally {
    await harness?.disconnect()
  }
})

describe('CatalogGovernance — real fence ordering and rollback', () => {
  it('keeps the null-cutoff path byte-compatible with all policy dependencies absent', async () => {
    const fixture = fixtures[0]
    await h().primary.catalogVenueRollout.deleteMany({ where: { organizationId: fixture.organizationId } })
    await h().primary.organizationEntitlement.deleteMany({ where: { organizationId: fixture.organizationId } })
    await h().primary.organizationModule.deleteMany({ where: { organizationId: fixture.organizationId } })
    const service = createCatalogGovernanceService()

    await expect(
      h().primary.$transaction(tx =>
        service.assertLegacy(tx, {
          organizationId: fixture.organizationId,
          venueId: fixture.venueId,
          operation: 'CREATE',
          willBeVendable: true,
          actor: human(fixture),
        }),
      ),
    ).resolves.toBeUndefined()
  })

  it('makes transition wait behind a writer Venue fence and preserves the writer-first chronology', async () => {
    const fixture = fixtures[1]
    await setEnforcedPolicy(h().primary, fixture)
    const service = createCatalogGovernanceService({ assertControlPlaneAccess: async () => undefined } as never)
    let held!: () => void
    let release!: () => void
    const isHeld = new Promise<void>(resolve => (held = resolve))
    const released = new Promise<void>(resolve => (release = resolve))
    const writer = h().blocker.$transaction(async tx => {
      await service.assertLegacy(tx, {
        organizationId: fixture.organizationId,
        venueId: fixture.venueId,
        operation: 'CREATE',
        willBeVendable: true,
        actor: human(fixture),
      })
      held()
      await released
    })
    await isHeld
    const cutoff = new Date('2026-08-09T18:00:00.000Z')
    const transition = h().writerOne.$transaction(tx =>
      service.transitionToEnforced(tx, {
        organizationId: fixture.organizationId,
        venueId: fixture.venueId,
        actor: human(fixture),
        enforcedAt: cutoff,
      }),
    )

    // WHY: pg_stat_activity wait evidence proves the real row lock blocked;
    // final state alone could pass after deleting the shared fence.
    await h().waitForLockWaiter(h().names.writerOne, 'row')
    release()
    await writer
    await expect(transition).resolves.toMatchObject({ governanceState: 'ENFORCED', catalogGovernanceEnforcedAt: cutoff })
  })

  it('makes a vendable legacy writer wait behind transition and then observe ENFORCED', async () => {
    const fixture = fixtures[2]
    await setEnforcedPolicy(h().primary, fixture)
    const service = createCatalogGovernanceService({ assertControlPlaneAccess: async () => undefined } as never)
    let transitioned!: () => void
    let release!: () => void
    const isTransitioned = new Promise<void>(resolve => (transitioned = resolve))
    const released = new Promise<void>(resolve => (release = resolve))
    const transition = h().blocker.$transaction(async tx => {
      await service.transitionToEnforced(tx, {
        organizationId: fixture.organizationId,
        venueId: fixture.venueId,
        actor: human(fixture),
        enforcedAt: new Date('2026-08-09T18:01:00.000Z'),
      })
      transitioned()
      await released
    })
    await isTransitioned
    const writer = h().writerTwo.$transaction(tx =>
      service.assertLegacy(tx, {
        organizationId: fixture.organizationId,
        venueId: fixture.venueId,
        operation: 'ACTIVATE',
        willBeVendable: true,
        actor: human(fixture),
      }),
    )

    await h().waitForLockWaiter(h().names.writerTwo, 'row')
    release()
    await transition
    await expect(writer).rejects.toMatchObject({ statusCode: 422, code: 'CATALOG_GOVERNANCE_REQUIRED' })
  })

  it('rolls back rollout and write-once cutoff when audit fails in the transition transaction', async () => {
    const fixture = fixtures[3]
    const auditFailure = new Error('forced audit rollback')
    const service = createCatalogGovernanceService({
      assertControlPlaneAccess: async () => undefined,
      writeCatalogAudit: async () => {
        throw auditFailure
      },
    } as never)

    await expect(
      h().primary.$transaction(tx =>
        service.transitionToEnforced(tx, {
          organizationId: fixture.organizationId,
          venueId: fixture.venueId,
          actor: human(fixture),
          enforcedAt: new Date('2026-08-09T18:02:00.000Z'),
        }),
      ),
    ).rejects.toBe(auditFailure)

    await expect(
      h().primary.venue.findUniqueOrThrow({
        where: { id: fixture.venueId },
        select: { catalogGovernanceEnforcedAt: true },
      }),
    ).resolves.toEqual({ catalogGovernanceEnforcedAt: null })
    await expect(
      h().primary.catalogVenueRollout.findUniqueOrThrow({
        where: { organizationId_venueId: { organizationId: fixture.organizationId, venueId: fixture.venueId } },
        select: { governanceState: true },
      }),
    ).resolves.toEqual({ governanceState: 'READY_TO_ENFORCE' })
  })
})
