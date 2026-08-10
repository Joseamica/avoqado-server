import { Prisma } from '@prisma/client'

const RECIPE_COST_GRAPH_LOCK_NAMESPACE = 'h1a:recipe-cost-graph:v1'

function requireLockId(value: string, code: string): void {
  if (!value.trim()) throw new Error(code)
}

/**
 * Serializes cooperating recipe-graph writers for one Venue until transaction
 * commit. This deliberately coarse key closes add-line versus RM-cost phantoms.
 */
export async function acquireRecipeCostGraphVenueLockV1(tx: Prisma.TransactionClient, venueId: string): Promise<void> {
  requireLockId(venueId, 'RECIPE_COST_GRAPH_LOCK_VENUE_REQUIRED')
  const lockKey = `${RECIPE_COST_GRAPH_LOCK_NAMESPACE}:${venueId}`

  // WHY: The tenant value remains a bind parameter, and an xact lock releases
  // automatically on commit/rollback without process-local cleanup state.
  await tx.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
  `)
}

/** Locks candidate ingredient costs after the Venue advisory lock is held. */
export async function lockRecipeCostRawMaterialsForShareV1(
  tx: Prisma.TransactionClient,
  venueId: string,
  rawMaterialIds: readonly string[],
): Promise<string[]> {
  requireLockId(venueId, 'RECIPE_COST_GRAPH_LOCK_VENUE_REQUIRED')
  const orderedIds = [...new Set(rawMaterialIds)].sort()
  if (orderedIds.length === 0) return []

  // WHY: Venue filtering prevents a caller from locking/accepting a foreign RM;
  // ordinal order is shared by every writer to avoid cyclical row waits.
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id
    FROM "RawMaterial"
    WHERE "venueId" = ${venueId} AND id IN (${Prisma.join(orderedIds)})
    ORDER BY id
    FOR SHARE
  `)
  return rows.map(row => row.id)
}

/** Locks the edited RM exclusively before its authoritative post-lock reread. */
export async function lockRecipeCostRawMaterialForUpdateV1(
  tx: Prisma.TransactionClient,
  venueId: string,
  rawMaterialId: string,
): Promise<boolean> {
  requireLockId(venueId, 'RECIPE_COST_GRAPH_LOCK_VENUE_REQUIRED')
  requireLockId(rawMaterialId, 'RECIPE_COST_GRAPH_LOCK_RAW_MATERIAL_REQUIRED')

  // WHY: Non-cooperating direct cost writers still conflict on this row while
  // the recomputation transaction is deriving and persisting recipe costs.
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id
    FROM "RawMaterial"
    WHERE "venueId" = ${venueId} AND id = ${rawMaterialId}
    FOR UPDATE
  `)
  return rows.length === 1
}

/** Locks a tenant-scoped Product when a Recipe row does not exist yet. */
export async function lockRecipeCostProductForUpdateV1(tx: Prisma.TransactionClient, venueId: string, productId: string): Promise<boolean> {
  requireLockId(venueId, 'RECIPE_COST_GRAPH_LOCK_VENUE_REQUIRED')
  requireLockId(productId, 'RECIPE_COST_GRAPH_LOCK_PRODUCT_REQUIRED')

  // WHY: Recipe creation has no Recipe row to anchor tenant ownership, so the
  // Product venue must stay immutable from validation through nested insert.
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id
    FROM "Product"
    WHERE "venueId" = ${venueId} AND id = ${productId}
    FOR UPDATE
  `)
  return rows.length === 1
}

/**
 * Locks one existing graph in Recipe → RecipeLine → RawMaterial order. Callers
 * must already hold the Venue advisory lock, then reread through Prisma.
 */
export async function lockRecipeCostGraphRowsV1(
  tx: Prisma.TransactionClient,
  venueId: string,
  recipeId: string,
  additionalRawMaterialIds: readonly string[] = [],
): Promise<boolean> {
  requireLockId(venueId, 'RECIPE_COST_GRAPH_LOCK_VENUE_REQUIRED')
  requireLockId(recipeId, 'RECIPE_COST_GRAPH_LOCK_RECIPE_REQUIRED')

  const recipeRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT recipe.id
    FROM "Recipe" AS recipe
    INNER JOIN "Product" AS product ON product.id = recipe."productId"
    WHERE recipe.id = ${recipeId} AND product."venueId" = ${venueId}
    FOR UPDATE OF recipe, product
  `)
  if (recipeRows.length !== 1) return false

  const lineRows = await tx.$queryRaw<Array<{ id: string; rawMaterialId: string }>>(Prisma.sql`
    SELECT id, "rawMaterialId"
    FROM "RecipeLine"
    WHERE "recipeId" = ${recipeId}
    ORDER BY id
    FOR UPDATE
  `)

  // WHY: Shared RM locks hold calculator inputs stable through all line/Recipe
  // writes; the helper also deduplicates repeated ingredients deterministically.
  await lockRecipeCostRawMaterialsForShareV1(tx, venueId, [...lineRows.map(line => line.rawMaterialId), ...additionalRawMaterialIds])
  return true
}

/**
 * Locks every graph affected by one RM cost edit, then all ingredient rows.
 * The target RM is exclusive; peer ingredients remain shared calculator inputs.
 */
export async function lockRecipeCostGraphsForRawMaterialUpdateV1(
  tx: Prisma.TransactionClient,
  venueId: string,
  recipeIds: readonly string[],
  rawMaterialId: string,
): Promise<string[]> {
  requireLockId(venueId, 'RECIPE_COST_GRAPH_LOCK_VENUE_REQUIRED')
  requireLockId(rawMaterialId, 'RECIPE_COST_GRAPH_LOCK_RAW_MATERIAL_REQUIRED')
  const lockedRecipeIds: string[] = []
  const rawMaterialIds = new Set<string>([rawMaterialId])

  for (const recipeId of [...new Set(recipeIds)].sort()) {
    const recipeRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT recipe.id
      FROM "Recipe" AS recipe
      INNER JOIN "Product" AS product ON product.id = recipe."productId"
      WHERE recipe.id = ${recipeId} AND product."venueId" = ${venueId}
      FOR UPDATE OF recipe, product
    `)
    if (recipeRows.length !== 1) continue

    const lineRows = await tx.$queryRaw<Array<{ id: string; rawMaterialId: string }>>(Prisma.sql`
      SELECT id, "rawMaterialId"
      FROM "RecipeLine"
      WHERE "recipeId" = ${recipeId}
      ORDER BY id
      FOR UPDATE
    `)
    lockedRecipeIds.push(recipeId)
    lineRows.forEach(line => rawMaterialIds.add(line.rawMaterialId))
  }

  // WHY: One global ordinal RM order prevents two mixed SHARE/UPDATE graph
  // writers from acquiring the same ingredients in opposite sequences.
  for (const candidateId of [...rawMaterialIds].sort()) {
    if (candidateId === rawMaterialId) {
      await lockRecipeCostRawMaterialForUpdateV1(tx, venueId, candidateId)
    } else {
      await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id
        FROM "RawMaterial"
        WHERE "venueId" = ${venueId} AND id = ${candidateId}
        FOR SHARE
      `)
    }
  }

  return lockedRecipeIds
}
