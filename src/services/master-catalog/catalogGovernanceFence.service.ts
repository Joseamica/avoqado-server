import { Prisma } from '@prisma/client'
import { NotFoundError, ValidationError } from '../../errors/AppError'

export interface CatalogGovernanceVenueFence {
  id: string
  organizationId: string
  catalogGovernanceEnforcedAt: Date | null
}

export interface CatalogGovernanceVenueFenceInput {
  venueId: string
  organizationId: string
}

export async function acquireCatalogGovernanceVenueFence(
  tx: Prisma.TransactionClient,
  input: CatalogGovernanceVenueFenceInput,
): Promise<CatalogGovernanceVenueFence> {
  // WHY: Every legacy Product create/activation and ENFORCED transition takes
  // this same row fence so commit order decides which side owns the cutoff.
  if (!input.venueId.trim() || !input.organizationId.trim()) {
    throw new ValidationError('La organización y la sucursal son requeridas')
  }

  const rows = await tx.$queryRaw<CatalogGovernanceVenueFence[]>(Prisma.sql`
    SELECT id, "organizationId", "catalogGovernanceEnforcedAt"
    FROM "Venue"
    WHERE id = ${input.venueId}
    FOR NO KEY UPDATE
  `)
  const venue = rows[0]

  // WHY: Missing and foreign venues intentionally share one 404 so the fence
  // cannot become a tenant-enumeration oracle.
  if (!venue || venue.organizationId !== input.organizationId) {
    throw new NotFoundError('Sucursal no encontrada')
  }
  return venue
}
