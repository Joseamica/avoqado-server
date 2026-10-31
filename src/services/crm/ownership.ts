import { Prisma } from '@prisma/client'

/** Why a person's open accounts changed hands at once; it travels in each OWNER_CHANGE event. */
export type OwnerChangeReason = 'TEAM_MEMBER_REMOVED' | 'STAFF_DELETED'

/**
 * Moves every OPEN account of `fromStaffId` to `toStaffId` (null = «Sin dueño») and writes one OWNER_CHANGE event per
 * account that really moved, inside the caller's transaction. Won and lost accounts keep their owner: that is history.
 *
 * Dependency-free on purpose: the superadmin's staff deletion uses it too.
 *
 * ponytail: one UPDATE … RETURNING for all of a person's open accounts; chunk it if one person ever owns tens of
 * thousands.
 */
export async function moveOpenAccountsTx(
  tx: Prisma.TransactionClient,
  move: { fromStaffId: string; toStaffId: string | null; actorStaffId: string | null; reason: OwnerChangeReason },
): Promise<number> {
  const moved = await tx.crmAccount.updateManyAndReturn({
    where: { ownerStaffId: move.fromStaffId, stage: { kind: 'ABIERTA' } },
    data: { ownerStaffId: move.toStaffId },
    select: { id: true },
  })
  if (moved.length > 0) {
    await tx.crmTimelineEvent.createMany({
      data: moved.map(({ id }) => ({
        accountId: id,
        kind: 'OWNER_CHANGE',
        actorStaffId: move.actorStaffId,
        data: { fromStaffId: move.fromStaffId, toStaffId: move.toStaffId, reason: move.reason },
      })),
    })
  }
  return moved.length
}
