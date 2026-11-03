import type { Prisma } from '@prisma/client'
import { ConflictError } from '../errors/AppError'

export const angelPayIdentityConflict = () =>
  new ConflictError(
    'Esta cuenta conserva sus cobros anteriores. Para usar otro comercio, correo o ambiente, crea una cuenta AngelPay nueva.',
    'ANGELPAY_IDENTITY_IMMUTABLE',
  )

// All login edits, links and deletes take this lock BEFORE reading eligibility.
export async function lockAngelPayVenue(tx: Prisma.TransactionClient, venueId: string): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`angelpay-identity:${venueId}`}, 0))::text`
}
