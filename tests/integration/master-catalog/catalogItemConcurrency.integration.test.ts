/**
 * Real PostgreSQL concurrency proof for the shared Task 5 mutation lock.
 *
 * This suite owns only two FAMILY roots and exercises separate connections;
 * it never resets or migrates the guarded H1 disposable database.
 */
import { CatalogReferenceStatus, Prisma, type PrismaClient } from '@prisma/client'
import type { CatalogCommandContext } from '@/types/master-catalog'

const fixtureKey = `${process.pid}-${Date.now()}-concurrency`
const organizationId = `h1a-lock-org-${fixtureKey}`
const staffId = `h1a-lock-staff-${fixtureKey}`
const raceRootAId = `h1a-lock-root-a-${fixtureKey}`
const raceRootBId = `h1a-lock-root-b-${fixtureKey}`

let prisma: PrismaClient | null = null
let catalogReferences: typeof import('@/services/master-catalog/catalogReference.service')
let disposableDatabaseVerified = false
let fixtureRowsMayExist = false

function assertDisposableH1Database(): void {
  const effective = new URL(process.env.DATABASE_URL ?? '')
  const declaredTestUrl = new URL(process.env.TEST_DATABASE_URL ?? '')
  // WHY: Both environment aliases must resolve to the exact local disposable
  // database before this concurrency suite opens either transaction.
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

async function waitForAdvisoryWait(client: PrismaClient, applicationName: string): Promise<boolean> {
  // WHY: Poll PostgreSQL's own wait state instead of trusting scheduler timing;
  // removing the advisory lock makes this bounded observation fail deterministically.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await client.$queryRaw<Array<{ waitEventType: string | null; waitEvent: string | null }>>(Prisma.sql`
      SELECT wait_event_type AS "waitEventType", wait_event AS "waitEvent"
      FROM pg_stat_activity
      WHERE datname = current_database() AND application_name = ${applicationName}
    `)
    if (rows.some(row => row.waitEventType === 'Lock' && row.waitEvent === 'advisory')) return true
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return false
}

const context: CatalogCommandContext = {
  organizationId,
  actor: { type: 'HUMAN', staffId, impersonating: false },
  orgRole: 'OWNER',
}

beforeAll(async () => {
  assertDisposableH1Database()
  disposableDatabaseVerified = true
  // WHY: Dynamic imports occur only after the guard, preventing Prisma from
  // connecting to an unverified database while the suite module loads.
  prisma = (await import('@/utils/prismaClient')).default
  catalogReferences = await import('@/services/master-catalog/catalogReference.service')
  const client = db()
  await client.organization.create({
    data: {
      id: organizationId,
      name: `H1A Lock ${fixtureKey}`,
      email: `h1a-lock-${fixtureKey}@example.test`,
      phone: '5500000000',
    },
  })
  fixtureRowsMayExist = true
  await client.staff.create({
    data: { id: staffId, email: `h1a-lock-staff-${fixtureKey}@example.test`, firstName: 'H1A', lastName: 'Lock' },
  })
  for (const family of [
    { id: raceRootAId, name: 'Race A', normalizedName: `RACE-A-${fixtureKey}` },
    { id: raceRootBId, name: 'Race B', normalizedName: `RACE-B-${fixtureKey}` },
  ]) {
    await client.catalogFamily.create({
      data: {
        ...family,
        organizationId,
        parentId: null,
        status: CatalogReferenceStatus.ACTIVE,
        createdById: staffId,
        updatedById: staffId,
      },
    })
  }
})

afterAll(async () => {
  if (!disposableDatabaseVerified || !prisma) return
  assertDisposableH1Database()
  const client = prisma
  if (!fixtureRowsMayExist) {
    await client.$disconnect()
    return
  }
  // WHY: Cleanup breaks either possible race edge before deleting roots, so a
  // failed assertion cannot strand a cyclic fixture in the shared test DB.
  await client.catalogFamily.updateMany({
    where: { id: { in: [raceRootAId, raceRootBId] }, organizationId },
    data: { parentId: null },
  })
  await client.catalogFamily.deleteMany({ where: { id: { in: [raceRootAId, raceRootBId] }, organizationId } })
  await client.organization.deleteMany({ where: { id: organizationId } })
  await client.staff.deleteMany({ where: { id: staffId } })
  await client.$disconnect()
})

describe('CatalogItem/reference shared mutation lock — real concurrency', () => {
  it('serializes opposite family moves so no cycle or third level can commit', async () => {
    const client = db()
    const secondApplicationName = `h1a-task5-lock-${fixtureKey}`
    let releaseFirst!: () => void
    let firstReady!: () => void
    let secondStarted!: () => void
    let secondSettled = false
    const holdFirst = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    const ready = new Promise<void>(resolve => {
      firstReady = resolve
    })
    const competingReady = new Promise<void>(resolve => {
      secondStarted = resolve
    })

    // WHY: Transaction one keeps the shared org advisory lock after A→B; the
    // competing B→A command must wait, then revalidate against committed A→B.
    const first = client.$transaction(async tx => {
      await catalogReferences.applyCatalogReferenceProposalsTx(
        tx,
        context,
        [
          {
            operation: 'UPDATE',
            referenceType: 'FAMILY',
            referenceId: raceRootAId,
            expectedRevision: 1,
            name: 'Race A',
            parentId: raceRootBId,
          },
        ],
        { auditOwnership: { kind: 'BATCH', batchId: `race-a-${fixtureKey}` } },
      )
      firstReady()
      await holdFirst
    })
    await ready
    const second = client
      .$transaction(async tx => {
        await tx.$queryRaw(Prisma.sql`SELECT set_config('application_name', ${secondApplicationName}, true)`)
        secondStarted()
        return catalogReferences.applyCatalogReferenceProposalsTx(
          tx,
          context,
          [
            {
              operation: 'UPDATE',
              referenceType: 'FAMILY',
              referenceId: raceRootBId,
              expectedRevision: 1,
              name: 'Race B',
              parentId: raceRootAId,
            },
          ],
          { auditOwnership: { kind: 'BATCH', batchId: `race-b-${fixtureKey}` } },
        )
      })
      .finally(() => {
        secondSettled = true
      })
    await competingReady
    // WHY: Merely scheduling the second transaction could pass without a lock.
    // PostgreSQL must report tx2 waiting specifically on an advisory lock while
    // transaction one remains open, not merely a convenient sequential outcome.
    const advisoryWaitObserved = await waitForAdvisoryWait(client, secondApplicationName)
    const settledWhileFirstHeld = secondSettled
    releaseFirst()
    await first
    expect(advisoryWaitObserved).toBe(true)
    expect(settledWhileFirstHeld).toBe(false)
    await expect(second).rejects.toMatchObject({ statusCode: 422, code: 'CATALOG_FAMILY_HIERARCHY_INVALID' })

    await expect(
      client.catalogFamily.findMany({
        where: { id: { in: [raceRootAId, raceRootBId] }, organizationId },
        select: { id: true, parentId: true },
        orderBy: { id: 'asc' },
      }),
    ).resolves.toEqual([
      { id: raceRootAId, parentId: raceRootBId },
      { id: raceRootBId, parentId: null },
    ])
  })
})
