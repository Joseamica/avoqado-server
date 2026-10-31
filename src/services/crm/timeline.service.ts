/**
 * An account's timeline (spec 2026-10-30 §5.2): who did what and when. It is only ever appended to — nothing edits or
 * deletes an event — and it is the CRM's own audit trail.
 */
import { Prisma } from '@prisma/client'

export const TIMELINE_KINDS = [
  'NOTE',
  'STAGE_CHANGE',
  'OWNER_CHANGE',
  'FIELD_CHANGE',
  'ACTIVITY_DONE',
  'LINKED',
  'WON',
  'LOST',
  'ARCHIVED',
  'REACTIVATED',
  'ENTRY_APPLIED',
  'SYSTEM',
] as const

export type TimelineKind = (typeof TIMELINE_KINDS)[number]

export interface TimelineEventInput {
  accountId: string
  kind: TimelineKind
  /** null = the system. */
  actorStaffId: string | null
  data: Prisma.InputJsonObject
  /** Writers that may run twice for the same fact (a sweep, a retried entry) pass one, and the second write adds nothing. */
  sourceKey?: string
}

/**
 * Appends one event inside the caller's transaction. Returns false when an event with the same `sourceKey` already
 * exists. `ON CONFLICT DO NOTHING` instead of catching P2002: a unique violation aborts the whole Postgres transaction,
 * and with it the change the event describes.
 */
export async function addEvent(tx: Prisma.TransactionClient, event: TimelineEventInput): Promise<boolean> {
  const { count } = await tx.crmTimelineEvent.createMany({ data: [event], skipDuplicates: true })
  return count === 1
}
