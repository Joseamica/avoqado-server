import type { Prisma } from '@prisma/client'

/**
 * Termina un intento de publicación: CAS doble `APPLYING`(attemptId, leaseExpiresAt) → `FAILED` sobre el lote y su registro de
 * idempotencia, con el motivo. Lo comparten el watchdog (intento vencido) y el confirm (barrera de IVA, Ruling R12). El `tx` ya
 * trae el candado de intento (`acquireCatalogPublicationAttemptLockTx`).
 *
 * `true` si cambió una fila de cada uno; `false` si ninguna (otro ya terminó ese intento); lanza si cambió una y la otra no.
 */
export async function failCatalogPublicationAttemptTx(
  tx: Prisma.TransactionClient,
  p: {
    organizationId: string
    batchId: string
    operation: string
    attemptId: string
    leaseExpiresAt: Date
    failureCode: string
    failureMessage: string
    now: Date
  },
): Promise<boolean> {
  const vivo = { state: 'APPLYING' as const, attemptId: p.attemptId, leaseExpiresAt: p.leaseExpiresAt }
  const terminal = {
    state: 'FAILED' as const,
    attemptId: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    failureCode: p.failureCode,
    failureMessage: p.failureMessage,
    completedAt: p.now,
  }
  const batch = await tx.catalogPublicationBatch.updateMany({
    where: { id: p.batchId, organizationId: p.organizationId, ...vivo },
    data: terminal,
  })
  const record = await tx.catalogIdempotencyRecord.updateMany({
    where: {
      organizationId: p.organizationId,
      operation: p.operation,
      resourceType: 'CatalogPublicationBatch',
      resourceId: p.batchId,
      ...vivo,
    },
    data: terminal,
  })
  if (batch.count === 0 && record.count === 0) return false
  if (batch.count !== 1 || record.count !== 1) throw new Error('CATALOG_PUBLICATION_WATCHDOG_DUAL_CAS_INVALID')
  return true
}
