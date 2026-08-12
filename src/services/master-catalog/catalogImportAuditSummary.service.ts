import type { Prisma } from '@prisma/client'
import AppError from '../../errors/AppError'
import { canonicalizeAndHashCatalogImportRows } from './catalogImportCanonical.service'
import type { CatalogMutationAuditEnvelope } from './catalogItem.types'

const MAX_AUDIT_MUTATION_GROUPS = 32

function invalidAuditEnvelope(message: string): never {
  throw new AppError(message, 409, true, 'CATALOG_IMPORT_AUDIT_ENVELOPE_INVALID')
}

export function validateCatalogImportAuditEnvelope(
  envelope: CatalogMutationAuditEnvelope | undefined,
  batchId: string,
  entityId: string,
): CatalogMutationAuditEnvelope {
  // WHY: Task 5 suppresses row logs in BATCH mode; accepting a missing or
  // foreign envelope would silently erase a mutation from the only summary.
  if (
    !envelope ||
    envelope.batchId !== batchId ||
    envelope.entityId !== entityId ||
    !envelope.action?.trim() ||
    !envelope.entity?.trim() ||
    envelope.action.length > 128 ||
    envelope.entity.length > 128
  ) {
    return invalidAuditEnvelope('La evidencia de auditoría batch es inconsistente.')
  }
  return envelope
}

export async function summarizeCatalogImportAuditEnvelopes(
  envelopes: readonly CatalogMutationAuditEnvelope[],
): Promise<Prisma.InputJsonObject> {
  const groups = new Map<string, { action: string; entity: string; count: number }>()
  let sliceStartedAt = performance.now()
  for (const envelope of envelopes) {
    const key = `${envelope.entity}\u0000${envelope.action}`
    const current = groups.get(key)
    if (current) current.count += 1
    else groups.set(key, { action: envelope.action, entity: envelope.entity, count: 1 })
    if (performance.now() - sliceStartedAt >= 4) {
      // WHY: Group aggregation covers every mutation but yields cooperatively
      // for maximum batches before the single ActivityLog is materialized.
      await new Promise<void>(resolve => setImmediate(resolve))
      sliceStartedAt = performance.now()
    }
  }
  if (groups.size > MAX_AUDIT_MUTATION_GROUPS) {
    return invalidAuditEnvelope('La evidencia batch excede el límite de grupos.')
  }
  let auditEnvelopeDigest: string
  try {
    // WHY: The digest commits to complete before/after/metadata deltas through
    // the cooperative canonical walker, while none of that raw data is logged.
    auditEnvelopeDigest = (await canonicalizeAndHashCatalogImportRows(envelopes, { namespace: 'catalog-import-audit-envelopes:v1' })).hash
  } catch {
    return invalidAuditEnvelope('La evidencia batch no es JSON canónico válido.')
  }
  return {
    auditEnvelopeCount: envelopes.length,
    auditEnvelopeDigest,
    mutationGroups: [...groups.values()].sort((left, right) => {
      const leftKey = `${left.entity}\u0000${left.action}`
      const rightKey = `${right.entity}\u0000${right.action}`
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
    }),
  }
}
