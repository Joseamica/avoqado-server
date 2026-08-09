import type { Prisma } from '@prisma/client'
import { NotFoundError, ValidationError } from '../../errors/AppError'
import type { CatalogAuditInput } from '../../types/master-catalog'

const SHA256_HEX = /^[0-9a-f]{64}$/
const HAS_NON_WHITESPACE = /\S/u

function requireSemanticText(value: string, field: string): void {
  // Unicode-aware whitespace rejection prevents technically NOT NULL audit
  // records whose tenant/action/entity has no usable semantic identity.
  if (!HAS_NON_WHITESPACE.test(value)) throw new ValidationError(`${field} no puede estar vacío`)
}

function buildAuditData(input: CatalogAuditInput): Prisma.InputJsonObject | undefined {
  // Only classified optional details belong in the JSON envelope; actor,
  // tenant and request provenance remain queryable first-class columns.
  const data: Prisma.InputJsonObject = {
    ...(input.batchId != null ? { batchId: input.batchId } : {}),
    ...(input.idempotencyKeyHash != null ? { idempotencyKeyHash: input.idempotencyKeyHash } : {}),
    ...(input.reason != null ? { reason: input.reason } : {}),
    ...(input.before !== undefined ? { before: input.before } : {}),
    ...(input.after !== undefined ? { after: input.after } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  }

  return Object.keys(data).length > 0 ? data : undefined
}

export async function writeCatalogAudit(tx: Prisma.TransactionClient, input: CatalogAuditInput): Promise<void> {
  requireSemanticText(input.organizationId, 'organizationId')
  requireSemanticText(input.action, 'action')
  requireSemanticText(input.entity, 'entity')

  if (input.reason != null) requireSemanticText(input.reason, 'reason')

  if (input.idempotencyKeyHash != null && !SHA256_HEX.test(input.idempotencyKeyHash)) {
    // The writer accepts only the digest-shaped contract and never hashes or
    // double-hashes it; the caller boundary must compute the SHA-256 digest.
    throw new ValidationError('idempotencyKeyHash debe ser un SHA-256 hexadecimal en minúsculas')
  }

  // Both actor variants cross FK/provenance boundaries, so neither may carry a
  // semantically empty identifier into the immutable audit record.
  if (input.actor.type === 'HUMAN') requireSemanticText(input.actor.staffId, 'staffId')
  else requireSemanticText(input.actor.servicePrincipalId, 'servicePrincipalId')

  if (input.venueId != null) {
    // The ownership check uses the same transaction as the audit insert so a
    // concurrent tenant change cannot create cross-organization attribution.
    const venue = await tx.venue.findFirst({
      where: { id: input.venueId, organizationId: input.organizationId },
      select: { id: true },
    })
    if (!venue) throw new NotFoundError('Sucursal no encontrada')
  }

  const humanStaffId = input.actor.type === 'HUMAN' ? input.actor.staffId : null
  const servicePrincipalId = input.actor.type === 'SERVICE' ? input.actor.servicePrincipalId : null

  // There is intentionally no catch: catalog state and its classified audit
  // must succeed or roll back together under the caller's transaction.
  await tx.activityLog.create({
    data: {
      organizationId: input.organizationId,
      venueId: input.venueId ?? null,
      actorType: input.actor.type,
      staffId: humanStaffId,
      actorStaffId: humanStaffId,
      servicePrincipalId,
      action: input.action,
      entity: input.entity,
      entityId: input.entityId ?? null,
      data: buildAuditData(input),
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
  })
}
