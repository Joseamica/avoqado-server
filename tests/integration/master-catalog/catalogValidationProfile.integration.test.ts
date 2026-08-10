/** Real PostgreSQL proof for immutable validation-profile preview/confirm. */
import {
  BusinessType,
  ModuleScope,
  OrganizationEntitlementSource,
  OrganizationEntitlementStatus,
  OrgRole,
  Prisma,
  PrismaClient,
  VenueOperationalRole,
} from '@prisma/client'
import type { CatalogCommandContext, CatalogValidationProfilePreviewInput } from '@/types/master-catalog'

jest.unmock('@/utils/prismaClient')
jest.unmock('@/services/master-catalog/catalogAudit.service')

const fixtureKey = `${process.pid}-${Date.now()}`
const writerApplicationName = `h1a-profile-writers-${fixtureKey}`
const blockerApplicationName = `h1a-profile-blocker-${fixtureKey}`
const observerApplicationName = `h1a-profile-observer-${fixtureKey}`
const organizationId = `h1a-profile-org-${fixtureKey}`
const staffId = `h1a-profile-staff-${fixtureKey}`
const moduleId = `h1a-profile-module-${fixtureKey}`
const catalogConfig = {
  schemaVersion: 1,
  catalogCoreEnabled: true,
  identifiersEnabled: false,
  regionalPricingEnabled: false,
  governanceMode: 'ADVISORY',
}

let prisma: PrismaClient | null = null
let blockerPrisma: PrismaClient | null = null
let observerPrisma: PrismaClient | null = null
let validationProfiles: typeof import('@/services/master-catalog/catalogValidation.service')
let catalogAudit: typeof import('@/services/master-catalog/catalogAudit.service')
let disposableDatabaseVerified = false
let fixtureRowsMayExist = false
let priorModule: { id: string; active: boolean; scope: ModuleScope; defaultConfig: unknown } | null = null

const context: CatalogCommandContext = {
  organizationId,
  actor: { type: 'HUMAN', staffId, impersonating: false },
  orgRole: 'OWNER',
}

function assertDisposableH1Database(): void {
  const effective = new URL(process.env.DATABASE_URL ?? '')
  const declaredTestUrl = new URL(process.env.TEST_DATABASE_URL ?? '')
  // WHY: Profile tests mutate commercial/module state, so both aliases must be
  // the exact disposable H1 database before a Prisma connection is imported.
  for (const candidate of [effective, declaredTestUrl]) {
    expect(['localhost', '127.0.0.1']).toContain(candidate.hostname)
    expect(candidate.pathname).toBe('/avoqado_h1a_test_20260808')
  }
  expect(declaredTestUrl.toString()).toBe(effective.toString())
}

function db(): PrismaClient {
  if (!disposableDatabaseVerified || !prisma) throw new Error('H1 disposable database was not verified')
  return prisma
}

function applicationDatabaseUrl(applicationName: string): string {
  const url = new URL(process.env.TEST_DATABASE_URL ?? '')
  url.searchParams.set('application_name', applicationName)
  return url.toString()
}

async function waitForProfileAdvisoryWaiters(expected: number): Promise<void> {
  const observer = observerPrisma
  if (!observer) throw new Error('H1 profile observer was not initialized')
  const deadline = Date.now() + 4_000
  let lastObserved: Array<{ pid: number; waitEventType: string | null; waitEvent: string | null; query: string }> = []

  // WHY: Two PostgreSQL advisory waiters prove both confirms reached the same
  // org+name lock; Promise scheduling alone could pass after removing the lock.
  while (Date.now() < deadline) {
    lastObserved = await observer.$queryRaw<
      Array<{ pid: number; waitEventType: string | null; waitEvent: string | null; query: string }>
    >(Prisma.sql`
      SELECT pid, wait_event_type AS "waitEventType", wait_event AS "waitEvent", query
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND application_name = ${writerApplicationName}
        AND wait_event_type = 'Lock'
        AND wait_event = 'advisory'
        AND query LIKE '%pg_advisory_xact_lock%'
    `)
    if (lastObserved.length >= expected) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }

  throw new Error(`Timed out waiting for ${expected} profile advisory waiters; observed ${JSON.stringify(lastObserved)}`)
}

async function startConfirmsBehindProfileLock<T, U>(
  profileName: string,
  startWriters: () => [Promise<T>, Promise<U>],
): Promise<[Promise<T>, Promise<U>]> {
  const blockerClient = blockerPrisma
  if (!blockerClient) throw new Error('H1 profile blocker was not initialized')
  let signalLockHeld!: () => void
  let releaseProfileLock!: () => void
  const lockHeld = new Promise<void>(resolve => (signalLockHeld = resolve))
  const release = new Promise<void>(resolve => (releaseProfileLock = resolve))
  const lockKey = `h1a:validation-profile:${organizationId}:${profileName}`
  const blocker = blockerClient.$transaction(
    async tx => {
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`)
      signalLockHeld()
      await release
    },
    { timeout: 10_000 },
  )
  await lockHeld
  const writers = startWriters()

  try {
    await waitForProfileAdvisoryWaiters(2)
  } catch (error) {
    releaseProfileLock()
    await blocker
    await Promise.allSettled(writers)
    throw error
  }

  releaseProfileLock()
  await blocker
  return writers
}

function profileInput(
  name: string,
  idempotencyKey: string,
  scope: { businessType?: BusinessType | null; operationalRole?: VenueOperationalRole | null } = {},
): CatalogValidationProfilePreviewInput {
  return {
    idempotencyKey,
    name,
    businessType: scope.businessType ?? null,
    operationalRole: scope.operationalRole ?? null,
    requiredFields: ['supplierCode'],
    additionalRules: { enforcePositiveShelfLife: true },
  }
}

async function confirmPreview(input: CatalogValidationProfilePreviewInput) {
  const preview = await validationProfiles.previewCatalogValidationProfile(context, input)
  const result = await validationProfiles.confirmCatalogValidationProfile(context, {
    profileBatchId: preview.profileBatchId,
    idempotencyKey: input.idempotencyKey,
    previewToken: preview.previewToken,
    confirm: true,
  })
  return { preview, result }
}

beforeAll(async () => {
  assertDisposableH1Database()
  // WHY: Both production confirms share one identifiable pool application;
  // blocker and observer use independent connections and cannot inflate count.
  const writerUrl = applicationDatabaseUrl(writerApplicationName)
  process.env.DATABASE_URL = writerUrl
  process.env.TEST_DATABASE_URL = writerUrl
  blockerPrisma = new PrismaClient({ datasources: { db: { url: applicationDatabaseUrl(blockerApplicationName) } } })
  observerPrisma = new PrismaClient({ datasources: { db: { url: applicationDatabaseUrl(observerApplicationName) } } })
  disposableDatabaseVerified = true
  prisma = (await import('@/utils/prismaClient')).default
  catalogAudit = await import('@/services/master-catalog/catalogAudit.service')
  validationProfiles = await import('@/services/master-catalog/catalogValidation.service')
  const client = db()

  priorModule = await client.module.findUnique({
    where: { code: 'MASTER_CATALOG' },
    select: { id: true, active: true, scope: true, defaultConfig: true },
  })
  await client.module.upsert({
    where: { code: 'MASTER_CATALOG' },
    create: {
      id: moduleId,
      code: 'MASTER_CATALOG',
      name: 'Master Catalog H1A integration',
      scope: ModuleScope.ORGANIZATION_ONLY,
      defaultConfig: catalogConfig,
      active: true,
    },
    update: { scope: ModuleScope.ORGANIZATION_ONLY, defaultConfig: catalogConfig, active: true },
  })
  await client.organization.create({
    data: {
      id: organizationId,
      name: `H1A validation profiles ${fixtureKey}`,
      email: `h1a-profiles-${fixtureKey}@example.test`,
      phone: '5500000000',
    },
  })
  fixtureRowsMayExist = true
  await client.staff.create({
    data: { id: staffId, email: `h1a-profile-owner-${fixtureKey}@example.test`, firstName: 'H1A', lastName: 'Profile Owner' },
  })
  await client.staffOrganization.create({
    data: { staffId, organizationId, role: OrgRole.OWNER, isActive: true, isPrimary: true },
  })
  const module = await client.module.findUniqueOrThrow({ where: { code: 'MASTER_CATALOG' }, select: { id: true } })
  await client.organizationModule.create({
    data: { organizationId, moduleId: module.id, enabled: true, enabledBy: staffId },
  })
  await client.organizationEntitlement.create({
    data: {
      organizationId,
      featureCode: 'MASTER_CATALOG',
      status: OrganizationEntitlementStatus.ACTIVE,
      source: OrganizationEntitlementSource.CONTRACT,
      startsAt: new Date(Date.now() - 60_000),
      endsAt: null,
      grantedById: staffId,
      reason: 'Task 6 disposable integration fixture',
    },
  })
})

afterAll(async () => {
  try {
    if (!disposableDatabaseVerified || !prisma) return
    assertDisposableH1Database()
    if (fixtureRowsMayExist) {
      // WHY: Durable audit/idempotency rows are removed before their restrictive
      // actor and tenant principals; every predicate is fixture-owned.
      await prisma.activityLog.deleteMany({ where: { organizationId } })
      await prisma.catalogIdempotencyRecord.deleteMany({ where: { organizationId } })
      await prisma.catalogValidationProfile.deleteMany({ where: { organizationId } })
      await prisma.organization.deleteMany({ where: { id: organizationId } })
      await prisma.staff.deleteMany({ where: { id: staffId } })
    }
    if (priorModule) {
      await prisma.module.update({
        where: { id: priorModule.id },
        data: { active: priorModule.active, scope: priorModule.scope, defaultConfig: priorModule.defaultConfig as any },
      })
    } else {
      await prisma.module.deleteMany({ where: { id: moduleId, code: 'MASTER_CATALOG' } })
    }
  } finally {
    await Promise.allSettled([prisma?.$disconnect(), blockerPrisma?.$disconnect(), observerPrisma?.$disconnect()])
  }
})

describe('CatalogValidationProfile — real preview/confirm transaction', () => {
  it('uses only CatalogIdempotencyRecord, stores no raw token, and commits profile+audit atomically', async () => {
    const input = profileInput(`basic-${fixtureKey}`, `basic-key-${fixtureKey}`)
    const preview = await validationProfiles.previewCatalogValidationProfile(context, input)
    const recordBefore = await db().catalogIdempotencyRecord.findFirstOrThrow({
      where: { id: preview.profileBatchId, organizationId, operation: 'VALIDATION_PROFILE_CHANGE' },
    })

    expect(recordBefore.state).toBe('PREVIEWED')
    expect(recordBefore.previewTokenHash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(recordBefore)).not.toContain(preview.previewToken)
    expect(preview.requiredFields).toEqual(expect.arrayContaining(['sku', 'updatedById', 'updatedAt', 'supplierCode']))

    const result = await validationProfiles.confirmCatalogValidationProfile(context, {
      profileBatchId: preview.profileBatchId,
      idempotencyKey: input.idempotencyKey,
      previewToken: preview.previewToken,
      confirm: true,
    })
    const [recordAfter, profile, audits] = await Promise.all([
      db().catalogIdempotencyRecord.findUniqueOrThrow({ where: { id: preview.profileBatchId } }),
      db().catalogValidationProfile.findUniqueOrThrow({ where: { id: result.profileId } }),
      db().activityLog.count({
        where: { organizationId, action: 'CATALOG_VALIDATION_PROFILE_CONFIRMED', entityId: result.profileId },
      }),
    ])

    expect(recordAfter.state).toBe('APPLIED')
    expect(recordAfter.resourceId).toBe(profile.id)
    expect(profile).toEqual(expect.objectContaining({ profileVersion: 1, rulesSchemaVersion: 1, active: true }))
    expect(audits).toBe(1)
  })

  it('re-reads P2002 idempotency reservations and keeps exactly one row', async () => {
    const input = profileInput(`duplicate-${fixtureKey}`, `duplicate-key-${fixtureKey}`)
    const preview = await validationProfiles.previewCatalogValidationProfile(context, input)

    await expect(validationProfiles.previewCatalogValidationProfile(context, input)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CATALOG_VALIDATION_PROFILE_PREVIEW_TOKEN_NOT_RECOVERABLE',
    })
    await expect(
      validationProfiles.previewCatalogValidationProfile(context, { ...input, name: `different-${fixtureKey}` }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' })
    await expect(
      db().catalogIdempotencyRecord.count({
        where: { organizationId, operation: 'VALIDATION_PROFILE_CHANGE', idempotencyKey: input.idempotencyKey },
      }),
    ).resolves.toBe(1)

    await validationProfiles.confirmCatalogValidationProfile(context, {
      profileBatchId: preview.profileBatchId,
      idempotencyKey: input.idempotencyKey,
      previewToken: preview.previewToken,
      confirm: true,
    })
  })

  it('returns one APPLIED result when the same profileBatch is confirmed concurrently', async () => {
    const input = profileInput(`same-batch-${fixtureKey}`, `same-batch-key-${fixtureKey}`)
    const preview = await validationProfiles.previewCatalogValidationProfile(context, input)
    const confirmation = {
      profileBatchId: preview.profileBatchId,
      idempotencyKey: input.idempotencyKey,
      previewToken: preview.previewToken,
      confirm: true as const,
    }

    const [first, second] = await Promise.all(
      await startConfirmsBehindProfileLock(input.name, () => [
        validationProfiles.confirmCatalogValidationProfile(context, confirmation),
        validationProfiles.confirmCatalogValidationProfile(context, confirmation),
      ]),
    )
    expect(second).toEqual(first)
    await expect(db().catalogValidationProfile.count({ where: { organizationId, name: input.name } })).resolves.toBe(1)
    await expect(
      db().activityLog.count({ where: { organizationId, action: 'CATALOG_VALIDATION_PROFILE_CONFIRMED', entityId: first.profileId } }),
    ).resolves.toBe(1)
  })

  it('serializes absent/different scopes on global name versions without P2002', async () => {
    const name = `scopes-${fixtureKey}`
    const storeInput = profileInput(name, `scope-store-${fixtureKey}`, {
      businessType: BusinessType.RESTAURANT,
      operationalRole: VenueOperationalRole.STORE,
    })
    const cedisInput = profileInput(name, `scope-cedis-${fixtureKey}`, {
      businessType: BusinessType.RESTAURANT,
      operationalRole: VenueOperationalRole.CEDIS,
    })
    const [storePreview, cedisPreview] = await Promise.all([
      validationProfiles.previewCatalogValidationProfile(context, storeInput),
      validationProfiles.previewCatalogValidationProfile(context, cedisInput),
    ])
    const confirmations = await Promise.allSettled(
      await startConfirmsBehindProfileLock(name, () => [
        validationProfiles.confirmCatalogValidationProfile(context, {
          profileBatchId: storePreview.profileBatchId,
          idempotencyKey: storeInput.idempotencyKey,
          previewToken: storePreview.previewToken,
          confirm: true,
        }),
        validationProfiles.confirmCatalogValidationProfile(context, {
          profileBatchId: cedisPreview.profileBatchId,
          idempotencyKey: cedisInput.idempotencyKey,
          previewToken: cedisPreview.previewToken,
          confirm: true,
        }),
      ]),
    )

    expect(confirmations.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = confirmations.find(result => result.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({ statusCode: 409, code: 'CATALOG_VALIDATION_PROFILE_STALE' })
    const retryInput = confirmations[0].status === 'rejected' ? storeInput : cedisInput
    await confirmPreview({ ...retryInput, idempotencyKey: `${retryInput.idempotencyKey}-retry` })

    const profiles = await db().catalogValidationProfile.findMany({
      where: { organizationId, name },
      orderBy: { profileVersion: 'asc' },
    })
    expect(profiles.map(profile => profile.profileVersion)).toEqual([1, 2])
    expect(profiles.every(profile => profile.active)).toBe(true)
  })

  it('rolls profile/version changes back when classified audit throws', async () => {
    const input = profileInput(`audit-rollback-${fixtureKey}`, `audit-rollback-key-${fixtureKey}`)
    const preview = await validationProfiles.previewCatalogValidationProfile(context, input)
    const auditFailure = jest.spyOn(catalogAudit, 'writeCatalogAudit').mockRejectedValueOnce(new Error('forced audit failure'))

    try {
      await expect(
        validationProfiles.confirmCatalogValidationProfile(context, {
          profileBatchId: preview.profileBatchId,
          idempotencyKey: input.idempotencyKey,
          previewToken: preview.previewToken,
          confirm: true,
        }),
      ).rejects.toThrow('forced audit failure')
    } finally {
      auditFailure.mockRestore()
    }

    await expect(db().catalogValidationProfile.count({ where: { organizationId, name: input.name } })).resolves.toBe(0)
    await expect(db().catalogIdempotencyRecord.findUniqueOrThrow({ where: { id: preview.profileBatchId } })).resolves.toEqual(
      expect.objectContaining({ state: 'PREVIEWED', resourceId: null, completedAt: null }),
    )
  })
})
