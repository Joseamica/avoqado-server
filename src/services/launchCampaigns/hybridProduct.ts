import { Prisma } from '@prisma/client'
import { ConflictError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'
import type { HybridOfferDefinition } from './hybridOffer.schema'

export type ProductKey = `FEATURE:${string}` | 'PLAN:PRO' | 'PLAN:PREMIUM'

/** The single product an offer prices, or null for bundles/choice (they never enter the list-price rule). */
export function productKeyOf(definition: HybridOfferDefinition): ProductKey | null {
  if (definition.kind === 'PLAN') return `PLAN:${definition.planTier}`
  if (definition.kind === 'FEATURES' && definition.featureCodes.length === 1) return `FEATURE:${definition.featureCodes[0]}`
  return null
}

/**
 * SQL twin of `productKeyOf` over `<alias>.definition` (jsonb): NULL for bundles and choices. Both must agree
 * (integration test `hybrid-price-rule`), since the list-price rule and the best-offer query filter products in SQL.
 */
export function productKeySql(alias: string): Prisma.Sql {
  if (!/^[a-z_]+$/.test(alias)) throw new Error(`Invalid SQL alias: ${alias}`)
  const d = Prisma.raw(`${alias}.definition`)
  return Prisma.sql`(CASE WHEN ${d}->>'kind' = 'PLAN' THEN 'PLAN:' || (${d}->>'planTier') WHEN ${d}->>'kind' = 'FEATURES' AND jsonb_array_length(${d}->'featureCodes') = 1 THEN 'FEATURE:' || (${d}->'featureCodes'->>0) END)`
}

/** Catalog price writes queue on the product locks behind each other (list saves, groups, the editor): room to wait. */
const LOCK_WAIT = { timeout: 15_000 }

/**
 * Every catalog transaction that takes product locks: it may wait LOCK_WAIT for them, and running out of it (P2028) is a
 * retryable 409, never a 500.
 */
export async function priceTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  try {
    return await prisma.$transaction(fn, LOCK_WAIT)
  } catch (error) {
    if ((error as { code?: string }).code === 'P2028')
      throw Object.assign(
        new ConflictError('Otra operación está cambiando el precio de este producto; reintenta en unos segundos.', 'HYBRID_PRICE_BUSY'),
        { cause: error },
      )
    throw error
  }
}

/** Catalog price writes serialize per product; many products are locked deduplicated and sorted (no inverse-order deadlock). */
export async function lockProducts(tx: Prisma.TransactionClient, keys: string[]) {
  for (const key of [...new Set(keys)].sort()) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'precio:' + key}))`
}

/** PROMOTION window/capacity are guaranteed by the DB CHECK; this narrows the nullable columns without `!` noise. */
export function promotionWindow(c: { purpose: string; endsAt: Date | null; capacity: number | null }) {
  if (c.purpose !== 'PROMOTION' || c.endsAt === null || c.capacity === null) return null
  return { endsAt: c.endsAt, capacity: c.capacity }
}
