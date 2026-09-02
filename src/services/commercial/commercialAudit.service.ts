import type { Prisma } from '@prisma/client'
import type { CommercialDraftActor } from '@/types/commercial'

export interface CommercialAuditInput {
  action: string
  entity: 'CommercialDraft' | 'CommercialPublication' | 'CommercialPublicationActivation' | 'CommercialPublicationOutbox'
  entityId: string
  actor: CommercialDraftActor
  before?: Record<string, unknown> | null
  after: Record<string, unknown>
}

export function commercialActivityLogData(input: CommercialAuditInput): Prisma.ActivityLogCreateInput {
  return {
    staff: { connect: { id: input.actor.staffId } },
    // Commercial control-plane changes are global, so there is no truthful
    // organizationId to attach. The DB contract requires classified HUMAN
    // actors to be tenant-scoped, so global audit retains the legacy staff FK.
    actorType: null,
    action: input.action,
    entity: input.entity,
    entityId: input.entityId,
    ipAddress: input.actor.ipAddress,
    userAgent: input.actor.userAgent,
    data: {
      reason: input.actor.reason,
      ...(input.before ? { before: input.before as Prisma.InputJsonObject } : {}),
      after: input.after as Prisma.InputJsonObject,
    } as Prisma.InputJsonObject,
  }
}
