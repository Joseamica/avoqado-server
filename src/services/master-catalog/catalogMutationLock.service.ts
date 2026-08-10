import { Prisma } from '@prisma/client'

const CATALOG_MUTATION_LOCK_NAMESPACE = 'h1a:catalog-mutation:v1'

export async function acquireCatalogMutationLock(tx: Prisma.TransactionClient, organizationId: string): Promise<void> {
  // WHY: A single versioned per-organization xact lock linearizes reference
  // retirement/hierarchy changes with item ACTIVE-reference assignment. The
  // lock is reentrant inside Task 7's outer transaction and releases at commit.
  if (!organizationId.trim()) throw new Error('CATALOG_MUTATION_LOCK_ORGANIZATION_REQUIRED')
  const lockKey = `${CATALOG_MUTATION_LOCK_NAMESPACE}:${organizationId}`

  // WHY: Prisma.sql parameterizes the tenant value; `$executeRaw` deliberately
  // avoids deserializing PostgreSQL's `void` lock return into a JS value.
  await tx.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
  `)
}
