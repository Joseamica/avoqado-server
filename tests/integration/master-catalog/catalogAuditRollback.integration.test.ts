/**
 * Real PostgreSQL proof for the H1A audit atomicity boundary.
 *
 * CatalogBrand is the smallest complete catalog aggregate that can be written
 * without triggering CatalogItem's deferred baseline constraints. The test uses
 * only the hardened H1 disposable-database wrapper and deletes only its own IDs.
 */
import { CatalogReferenceStatus, type PrismaClient } from '@prisma/client'
import { writeCatalogAudit } from '@/services/master-catalog/catalogAudit.service'

const fixtureKey = `${process.pid}-${Date.now()}`
const organizationId = `h1a-audit-org-${fixtureKey}`
const staffId = `h1a-audit-staff-${fixtureKey}`
const invalidActorId = `h1a-audit-missing-staff-${fixtureKey}`
const rolledBackBrandId = `h1a-audit-brand-rollback-${fixtureKey}`
const committedBrandId = `h1a-audit-brand-commit-${fixtureKey}`
let prisma: PrismaClient | null = null
let disposableDatabaseVerified = false

function assertDisposableH1Database(): void {
  const effective = new URL(process.env.DATABASE_URL ?? '')
  const declaredTestUrl = new URL(process.env.TEST_DATABASE_URL ?? '')
  // This duplicate guard makes the individual test refuse execution even if a
  // caller bypasses the wrapper or points the test alias away from Prisma's
  // effective connection string.
  for (const candidate of [effective, declaredTestUrl]) {
    expect(['localhost', '127.0.0.1']).toContain(candidate.hostname)
    expect(candidate.pathname).toBe('/avoqado_h1a_test_20260808')
  }
  expect(declaredTestUrl.toString()).toBe(effective.toString())
}

function verifiedPrisma(): PrismaClient {
  if (!disposableDatabaseVerified || !prisma) throw new Error('H1 disposable database was not verified')
  return prisma
}

beforeAll(async () => {
  assertDisposableH1Database()
  disposableDatabaseVerified = true
  // Import Prisma only after validating the exact effective URL so this test
  // cannot establish a connection before its destructive boundary is proven.
  prisma = (await import('@/utils/prismaClient')).default
  const db = verifiedPrisma()
  await db.organization.create({
    data: {
      id: organizationId,
      name: `H1A audit ${fixtureKey}`,
      email: `h1a-audit-${fixtureKey}@example.test`,
      phone: '5500000000',
    },
  })
  await db.staff.create({
    data: {
      id: staffId,
      email: `h1a-audit-actor-${fixtureKey}@example.test`,
      firstName: 'H1A',
      lastName: 'Audit Actor',
    },
  })
})

afterAll(async () => {
  if (!disposableDatabaseVerified || !prisma) return
  // Revalidation closes the cleanup window if process environment is mutated
  // after setup; no delete may run once the disposable invariant is lost.
  assertDisposableH1Database()
  // H1 actor and organization FKs are intentionally restrictive, so cleanup
  // removes the owned audit evidence before its fixture principals.
  await prisma.activityLog.deleteMany({ where: { organizationId } })
  await prisma.catalogBrand.deleteMany({ where: { organizationId } })
  await prisma.organization.deleteMany({ where: { id: organizationId } })
  await prisma.staff.deleteMany({ where: { id: staffId } })
  await prisma.$disconnect()
})

describe('writeCatalogAudit — real transaction rollback', () => {
  it('rolls back CatalogBrand when classified ActivityLog actor FK insertion fails', async () => {
    const db = verifiedPrisma()
    let transactionError: unknown

    try {
      await db.$transaction(async tx => {
        await tx.catalogBrand.create({
          data: {
            id: rolledBackBrandId,
            organizationId,
            name: 'Brand that must roll back',
            normalizedName: `ROLLBACK-${fixtureKey}`,
            status: CatalogReferenceStatus.ACTIVE,
            createdById: staffId,
            updatedById: staffId,
          },
        })
        await writeCatalogAudit(tx, {
          organizationId,
          actor: { type: 'HUMAN', staffId: invalidActorId, impersonating: false },
          action: 'CATALOG_BRAND_CREATED',
          entity: 'CatalogBrand',
          entityId: rolledBackBrandId,
        })
      })
    } catch (error) {
      transactionError = error
    }

    // Requiring Prisma's FK classification prevents an earlier validation or
    // unrelated database failure from masquerading as rollback evidence.
    expect(transactionError).toMatchObject({ code: 'P2003' })
    // Both HUMAN columns intentionally receive the same actor. PostgreSQL
    // evaluates the legacy-compatible staffId FK first in this schema.
    expect(JSON.stringify((transactionError as { meta?: unknown }).meta)).toContain('ActivityLog_staffId_fkey')

    await expect(db.catalogBrand.count({ where: { id: rolledBackBrandId } })).resolves.toBe(0)
    await expect(db.activityLog.count({ where: { organizationId, entityId: rolledBackBrandId } })).resolves.toBe(0)
  })

  it('commits CatalogBrand and classified ActivityLog together for a valid HUMAN actor', async () => {
    const db = verifiedPrisma()
    await db.$transaction(async tx => {
      await tx.catalogBrand.create({
        data: {
          id: committedBrandId,
          organizationId,
          name: 'Brand committed with audit',
          normalizedName: `COMMIT-${fixtureKey}`,
          status: CatalogReferenceStatus.ACTIVE,
          createdById: staffId,
          updatedById: staffId,
        },
      })
      await writeCatalogAudit(tx, {
        organizationId,
        actor: { type: 'HUMAN', staffId, impersonating: false },
        action: 'CATALOG_BRAND_CREATED',
        entity: 'CatalogBrand',
        entityId: committedBrandId,
      })
    })

    await expect(db.catalogBrand.count({ where: { id: committedBrandId } })).resolves.toBe(1)
    await expect(
      db.activityLog.findFirst({
        where: { organizationId, entityId: committedBrandId },
        select: { actorType: true, staffId: true, actorStaffId: true, servicePrincipalId: true },
      }),
    ).resolves.toEqual({
      actorType: 'HUMAN',
      staffId,
      actorStaffId: staffId,
      servicePrincipalId: null,
    })
  })
})
