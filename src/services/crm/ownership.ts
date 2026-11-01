import { Prisma } from '@prisma/client'

/** Why accounts changed hands; it travels in each OWNER_CHANGE event. */
export type OwnerChangeReason = 'TEAM_MEMBER_REMOVED' | 'STAFF_DELETED' | 'TAKEN' | 'REASSIGNED'

/**
 * Ruling 12: an account's PENDING activities go wherever the account goes — to its new owner, or to nobody when it is
 * left «Sin dueño» (then they show in its ficha and in the admins' daily digest). Done ones keep who did them. Every
 * owner change calls it: taking, reassigning, a team removal and a staff deletion (`moveOpenAccountsTx`).
 */
export async function movePendingActivitiesTx(tx: Prisma.TransactionClient, accountIds: string[], toStaffId: string | null) {
  if (!accountIds.length) return
  await tx.crmActivity.updateMany({ where: { accountId: { in: accountIds }, doneAt: null }, data: { assigneeStaffId: toStaffId } })
}

/**
 * Moves every OPEN account of `fromStaffId` to `toStaffId` (null = «Sin dueño»), with their pending activities, and
 * writes one OWNER_CHANGE event per account that really moved, inside the caller's transaction. Won and lost accounts
 * keep their owner: that is history.
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
    await movePendingActivitiesTx(
      tx,
      moved.map(({ id }) => id),
      move.toStaffId,
    )
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
