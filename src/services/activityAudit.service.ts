import type { Prisma } from '@prisma/client'
import { normalizeLegacyActivityActor } from '../lib/activityAuditActor'

export interface LegacyActivityAuditInput {
  staffId?: string | null
  venueId?: string | null
  action: string
  entity?: string
  entityId?: string
  data?: Prisma.InputJsonValue
  ipAddress?: string
  userAgent?: string
}

type ActivityAuditTransaction = Pick<Prisma.TransactionClient, 'activityLog'>

/**
 * Atomic counterpart to the best-effort legacy logAction writer.
 *
 * Callers deliberately use this inside the business transaction when the
 * operation must never commit without its audit row. It does not catch: a
 * rejected audit insert must reject and roll back the surrounding callback.
 */
export async function writeLegacyActivityAuditTx(tx: ActivityAuditTransaction, input: LegacyActivityAuditInput): Promise<void> {
  const { staffId, data } = normalizeLegacyActivityActor(input.staffId, input.data)
  await tx.activityLog.create({
    data: {
      staffId,
      venueId: input.venueId ?? null,
      action: input.action,
      entity: input.entity ?? null,
      entityId: input.entityId ?? null,
      data,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
  })
}
