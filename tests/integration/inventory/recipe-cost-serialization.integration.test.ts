/**
 * Real PostgreSQL proof that yield and RM unit writers serialize through the
 * same Venue graph lock and persist one post-lock cost snapshot.
 */
import { BusinessType, ProductType, Unit, UnitType, PrismaClient } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'

jest.unmock('@/utils/prismaClient')
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

const fixtureKey = `${process.pid}-${Date.now()}`
const writerApplicationName = `h1a-recipe-writers-${fixtureKey}`
const blockerApplicationName = `h1a-recipe-blocker-${fixtureKey}`
const observerApplicationName = `h1a-recipe-observer-${fixtureKey}`
const organizationId = `h1a-recipe-race-org-${fixtureKey}`
const staffId = `h1a-recipe-race-staff-${fixtureKey}`
let prisma: PrismaClient | null = null
let venueId = ''
let productId = ''
let rawMaterialId = ''
let recipeLineId = ''
let updateRecipe: typeof import('@/services/dashboard/recipe.service').updateRecipe
let updateRecipeLine: typeof import('@/services/dashboard/recipe.service').updateRecipeLine
let updateRawMaterial: typeof import('@/services/dashboard/rawMaterial.service').updateRawMaterial
let acquireRecipeCostGraphVenueLockV1: typeof import('@/services/dashboard/recipe-cost-graph-lock').acquireRecipeCostGraphVenueLockV1
let blockerPrisma: PrismaClient | null = null
let observerPrisma: PrismaClient | null = null
let disposableDatabaseVerified = false

function assertDisposableH1Database(): void {
  const effective = new URL(process.env.DATABASE_URL ?? '')
  const declared = new URL(process.env.TEST_DATABASE_URL ?? '')
  // WHY: Setup and teardown may delete rows, so both URLs must independently
  // prove the dedicated local H1 database before Prisma is imported.
  for (const candidate of [effective, declared]) {
    expect(['localhost', '127.0.0.1']).toContain(candidate.hostname)
    expect(candidate.pathname).toBe('/avoqado_h1a_test_20260808')
  }
  expect(effective.toString()).toBe(declared.toString())
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

async function waitForWriterAdvisoryWaiters(expected: number): Promise<void> {
  const observer = observerPrisma
  if (!observer) throw new Error('H1 recipe-cost observer was not initialized')
  const deadline = Date.now() + 4_000
  let lastObserved: Array<{ pid: number; waitEventType: string | null; waitEvent: string | null; query: string }> = []

  // WHY: PostgreSQL's own wait state proves both production writers reached
  // the advisory seam; scheduling or a commutative final value cannot do so.
  while (Date.now() < deadline) {
    lastObserved = await observer.$queryRaw<Array<{ pid: number; waitEventType: string | null; waitEvent: string | null; query: string }>>`
      SELECT pid, wait_event_type AS "waitEventType", wait_event AS "waitEvent", query
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND application_name = ${writerApplicationName}
        AND wait_event_type = 'Lock'
        AND wait_event = 'advisory'
        AND query LIKE '%pg_advisory_xact_lock%'
    `
    if (lastObserved.length >= expected) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }

  throw new Error(`Timed out waiting for ${expected} recipe-cost advisory waiters; observed ${JSON.stringify(lastObserved)}`)
}

async function runWhileVenueLockIsBlocked<T, U>(startWriters: () => [Promise<T>, Promise<U>]): Promise<[T, U]> {
  const blockerClient = blockerPrisma
  if (!blockerClient) throw new Error('H1 recipe-cost blocker was not initialized')
  let signalLockHeld!: () => void
  let releaseVenueLock!: () => void
  const lockHeld = new Promise<void>(resolve => (signalLockHeld = resolve))
  const release = new Promise<void>(resolve => (releaseVenueLock = resolve))
  const blocker = blockerClient.$transaction(
    async tx => {
      await acquireRecipeCostGraphVenueLockV1(tx, venueId)
      signalLockHeld()
      await release
    },
    { timeout: 10_000 },
  )
  await lockHeld
  const writers = startWriters()

  try {
    await waitForWriterAdvisoryWaiters(2)
  } catch (error) {
    releaseVenueLock()
    await blocker
    await Promise.allSettled(writers)
    throw error
  }

  releaseVenueLock()
  await blocker
  return Promise.all(writers)
}

async function recipeGraphSnapshot(): Promise<string> {
  const client = db()
  const [rawMaterial, recipe] = await Promise.all([
    client.rawMaterial.findUniqueOrThrow({
      where: { id: rawMaterialId },
      select: { unit: true, unitType: true, costPerUnit: true, updatedAt: true },
    }),
    client.recipe.findUniqueOrThrow({
      where: { productId },
      select: {
        portionYield: true,
        totalCost: true,
        updatedAt: true,
        lines: {
          select: { id: true, quantity: true, unit: true, costPerServing: true, updatedAt: true },
          orderBy: { id: 'asc' },
        },
      },
    }),
  ])

  // WHY: Decimal/date normalization makes a rollback assertion compare every
  // authoritative and derived graph value byte-for-byte, not by object identity.
  return JSON.stringify({
    rawMaterial: {
      ...rawMaterial,
      costPerUnit: rawMaterial.costPerUnit.toFixed(4),
      updatedAt: rawMaterial.updatedAt.toISOString(),
    },
    recipe: {
      ...recipe,
      totalCost: recipe.totalCost.toFixed(4),
      updatedAt: recipe.updatedAt.toISOString(),
      lines: recipe.lines.map(line => ({
        ...line,
        quantity: line.quantity.toFixed(3),
        costPerServing: line.costPerServing?.toFixed(4) ?? null,
        updatedAt: line.updatedAt.toISOString(),
      })),
    },
  })
}

beforeAll(async () => {
  assertDisposableH1Database()
  // WHY: A shared writer application name lets the observer distinguish both
  // production-pool waiters from its own and the independent blocker session.
  const writerUrl = applicationDatabaseUrl(writerApplicationName)
  process.env.DATABASE_URL = writerUrl
  process.env.TEST_DATABASE_URL = writerUrl
  blockerPrisma = new PrismaClient({ datasources: { db: { url: applicationDatabaseUrl(blockerApplicationName) } } })
  observerPrisma = new PrismaClient({ datasources: { db: { url: applicationDatabaseUrl(observerApplicationName) } } })
  disposableDatabaseVerified = true
  prisma = (await import('@/utils/prismaClient')).default
  ;({ updateRecipe, updateRecipeLine } = await import('@/services/dashboard/recipe.service'))
  ;({ updateRawMaterial } = await import('@/services/dashboard/rawMaterial.service'))
  ;({ acquireRecipeCostGraphVenueLockV1 } = await import('@/services/dashboard/recipe-cost-graph-lock'))
  const client = db()

  await client.organization.create({
    data: { id: organizationId, name: `Recipe race ${fixtureKey}`, email: `recipe-race-${fixtureKey}@example.test`, phone: '5500000000' },
  })
  await client.staff.create({
    data: { id: staffId, email: `recipe-race-staff-${fixtureKey}@example.test`, firstName: 'Recipe', lastName: 'Race' },
  })
  const venue = await client.venue.create({
    data: {
      organizationId,
      name: `Recipe race ${fixtureKey}`,
      slug: `recipe-race-${fixtureKey}`.toLowerCase(),
      address: 'test',
      city: 'test',
      country: 'MX',
      timezone: 'America/Mexico_City',
      currency: 'MXN',
      type: BusinessType.RESTAURANT,
    },
  })
  venueId = venue.id
  const category = await client.menuCategory.create({
    data: { venueId, name: 'Race', slug: `recipe-race-${fixtureKey}`.toLowerCase() },
  })
  const product = await client.product.create({
    data: {
      venueId,
      categoryId: category.id,
      sku: `RACE-${fixtureKey}`,
      name: 'Concurrent recipe',
      type: ProductType.FOOD_AND_BEV,
      price: new Decimal('10'),
      cost: new Decimal('250'),
      taxRate: new Decimal('0.16'),
      active: true,
      createdById: staffId,
    },
  })
  productId = product.id
  const rawMaterial = await client.rawMaterial.create({
    data: {
      venueId,
      name: 'Concurrent ingredient',
      sku: `RACE-RM-${fixtureKey}`,
      category: 'OTHER',
      currentStock: new Decimal('1000'),
      minimumStock: new Decimal('0'),
      reorderPoint: new Decimal('0'),
      costPerUnit: new Decimal('0.5'),
      avgCostPerUnit: new Decimal('0.5'),
      unit: Unit.GRAM,
      unitType: UnitType.WEIGHT,
    },
  })
  rawMaterialId = rawMaterial.id
  const recipe = await client.recipe.create({
    data: {
      productId,
      portionYield: 2,
      prepTime: 10,
      totalCost: new Decimal('250'),
      lines: {
        create: {
          rawMaterialId,
          quantity: new Decimal('1'),
          unit: Unit.KILOGRAM,
          costPerServing: new Decimal('250'),
          displayOrder: 0,
        },
      },
    },
    include: { lines: true },
  })
  recipeLineId = recipe.lines[0].id
})

beforeEach(async () => {
  const client = db()
  // WHY: Each race starts from the same mathematically discriminating graph,
  // so earlier unit/yield mutations cannot make the next assertion vacuous.
  await client.rawMaterial.update({
    where: { id: rawMaterialId },
    data: { unit: Unit.GRAM, unitType: UnitType.WEIGHT, costPerUnit: new Decimal('0.5') },
  })
  await client.recipe.update({ where: { productId }, data: { portionYield: 2, totalCost: new Decimal('250') } })
  await client.recipeLine.update({
    where: { id: recipeLineId },
    data: { quantity: new Decimal('1'), unit: Unit.KILOGRAM, costPerServing: new Decimal('250') },
  })
})

afterAll(async () => {
  try {
    if (!disposableDatabaseVerified || !prisma) return
    assertDisposableH1Database()
    await prisma.product.deleteMany({ where: { venueId } })
    await prisma.rawMaterial.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { organizationId } })
    await prisma.organization.deleteMany({ where: { id: organizationId } })
    await prisma.staff.deleteMany({ where: { id: staffId } })
  } finally {
    await Promise.allSettled([prisma?.$disconnect(), blockerPrisma?.$disconnect(), observerPrisma?.$disconnect()])
  }
})

it('serializes a RM unit change with a metadata-only yield change', async () => {
  const client = db()
  await runWhileVenueLockIsBlocked(() => [
    updateRecipe(venueId, productId, { portionYield: 8 } as any),
    updateRawMaterial(venueId, rawMaterialId, { unit: Unit.KILOGRAM } as any, staffId),
  ])

  const finalRecipe = await client.recipe.findUniqueOrThrow({ where: { productId }, include: { lines: true } })
  const finalRawMaterial = await client.rawMaterial.findUniqueOrThrow({ where: { id: rawMaterialId } })
  expect(finalRawMaterial.unit).toBe(Unit.KILOGRAM)
  expect(finalRecipe.portionYield).toBe(8)
  expect(finalRecipe.totalCost.toFixed(4)).toBe('0.0625')
  expect(finalRecipe.lines[0].costPerServing?.toFixed(4)).toBe('0.0625')
})

it('serializes a line quantity change with a metadata-only yield change', async () => {
  const client = db()
  await runWhileVenueLockIsBlocked(() => [
    updateRecipe(venueId, productId, { portionYield: 8 } as any),
    updateRecipeLine(venueId, productId, recipeLineId, { quantity: 2 }, staffId),
  ])

  const finalRecipe = await client.recipe.findUniqueOrThrow({ where: { productId }, include: { lines: true } })
  expect(finalRecipe.portionYield).toBe(8)
  expect(finalRecipe.lines[0].quantity.toFixed(4)).toBe('2.0000')
  // WHY: 2kg * 0.5/g / 8 = 125. Either unlocked stale snapshot would instead
  // persist a derived total based on only one of the two authoritative inputs.
  expect(finalRecipe.totalCost.toFixed(4)).toBe('125.0000')
  expect(finalRecipe.lines[0].costPerServing?.toFixed(4)).toBe('125.0000')
})

it('rolls back the RM and the complete graph when a unit change becomes incompatible', async () => {
  const before = await recipeGraphSnapshot()

  await expect(updateRawMaterial(venueId, rawMaterialId, { unit: Unit.LITER } as any, staffId)).rejects.toMatchObject({
    statusCode: 422,
    code: 'RECIPE_COST_INPUT_INVALID',
  })

  expect(await recipeGraphSnapshot()).toBe(before)
})
