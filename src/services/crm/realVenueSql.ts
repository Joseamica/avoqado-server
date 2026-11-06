/**
 * «Real venue» and «real money» in raw SQL (spec §8), the twins of `MONEY` and `REAL_VENUE` in `sweep.service.ts`. A LEAF
 * (only `@prisma/client` and the status list), so the SQL of «Clientes» can be built and printed without loading a service.
 */
import { Prisma } from '@prisma/client'
import { PRODUCTION_VENUE_STATUSES } from '../../lib/venueStatus.constants'

/**
 * The same two rules in raw SQL over a venue aliased `v` (ruling 51): «has it charged real money?» is a correlated
 * `EXISTS` that stops at the first charge on `Payment(venueId, status, createdAt)`. A Prisma `payments.some` becomes
 * `IN (SELECT "venueId" FROM "Payment" …)`, which inside an `OR` Postgres runs as a hashed subplan that reads EVERY
 * completed payment of the platform. Only the statuses travel as binds.
 */
export const REAL_VENUE_SQL = Prisma.sql`v."status"::text IN (${Prisma.join(PRODUCTION_VENUE_STATUSES)}) AND v."demoExpiresAt" IS NULL`
export const VENUE_HAS_MONEY_SQL = Prisma.sql`EXISTS (SELECT 1 FROM "Payment" p WHERE p."venueId" = v."id" AND p."status" = 'COMPLETED' AND p."amount" > 0)`
