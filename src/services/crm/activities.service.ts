/**
 * Activities (spec 2026-10-30 §5.2 and §5.4): someone's next step on an account — a call, a WhatsApp, an email, a
 * meeting, a demo or a task — with a due date and a person in charge.
 *
 * The account's `nextActivityAt` is ALWAYS its earliest pending activity: the traffic light, «Mis pendientes» and the
 * cards read it. So every change recomputes it in the same transaction, after `touchEditableTx` has locked the account's
 * row — two changes at once queue there, and the second one recomputes with the first one already in.
 */
import { Prisma } from '@prisma/client'
import { ConflictError, NotFoundError } from '../../errors/AppError'
import type { ACTIVITY_TYPES } from '../../schemas/crm.schema'
import prisma from '../../utils/prismaClient'
import { scopeWhere, type CrmAccess } from './access.service'
import { touchEditableTx } from './accounts.service'
import { addEvent } from './timeline.service'

export type ActivityType = (typeof ACTIVITY_TYPES)[number]

/** Leaves `nextActivityAt` = the account's earliest pending activity, or null when nothing is pending (🟡). */
export async function recomputeNext(tx: Prisma.TransactionClient, accountId: string): Promise<void> {
  const next = await tx.crmActivity.findFirst({
    where: { accountId, doneAt: null },
    orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
    select: { dueAt: true },
  })
  await tx.crmAccount.update({ where: { id: accountId }, data: { nextActivityAt: next?.dueAt ?? null } })
}

/**
 * Schedules an activity. It is the account owner's to do — an admin scheduling a call on Ana's account schedules it for
 * Ana — or, on an account nobody owns yet, whoever scheduled it (ruling 12 moves it with the account afterwards).
 */
export async function addActivity(access: CrmAccess, accountId: string, input: { type: ActivityType; title: string; dueAt: Date }) {
  const now = new Date()
  return prisma.$transaction(async tx => {
    const account = await touchEditableTx(tx, access, accountId, now)
    const activity = await tx.crmActivity.create({
      data: {
        accountId,
        type: input.type,
        title: input.title,
        dueAt: input.dueAt,
        assigneeStaffId: account.ownerStaffId ?? access.staffId,
      },
    })
    // Every change leaves its event (spec §5.10), and the activity itself does not keep who scheduled it.
    await addEvent(tx, {
      accountId,
      kind: 'SYSTEM',
      actorStaffId: access.staffId,
      data: {
        event: 'ACTIVITY_SCHEDULED',
        activityId: activity.id,
        type: activity.type,
        title: activity.title,
        dueAt: activity.dueAt.toISOString(),
        assigneeStaffId: activity.assigneeStaffId,
      },
    })
    await recomputeNext(tx, accountId)
    return activity
  })
}

/**
 * «Hecha»: compare-and-set on «not done yet», so two people pressing it at once complete it ONCE — the other one gets a
 * 409 — and the timeline says it once.
 */
export async function completeActivity(access: CrmAccess, id: string, input: { result?: string }) {
  // On an account the caller cannot see, the activity does not exist for them either: the same 404 as a wrong id.
  const found = await prisma.crmActivity.findFirst({ where: { id, account: scopeWhere(access, 'ver') }, select: { accountId: true } })
  if (!found) throw new NotFoundError('No encontramos esa actividad', 'CRM_ACTIVITY_NOT_FOUND')
  const { accountId } = found
  const now = new Date()

  return prisma.$transaction(async tx => {
    await touchEditableTx(tx, access, accountId, now)
    const { count } = await tx.crmActivity.updateMany({
      where: { id, doneAt: null },
      data: { doneAt: now, doneById: access.staffId, result: input.result || null },
    })
    if (count === 0) throw new ConflictError('Esta actividad ya estaba hecha', 'CRM_ACTIVIDAD_YA_HECHA')

    const activity = await tx.crmActivity.findUniqueOrThrow({ where: { id } })
    await addEvent(tx, {
      accountId,
      kind: 'ACTIVITY_DONE',
      actorStaffId: access.staffId,
      data: {
        activityId: id,
        type: activity.type,
        title: activity.title,
        dueAt: activity.dueAt.toISOString(),
        result: activity.result,
      },
    })
    await recomputeNext(tx, accountId)
    return activity
  })
}

/**
 * «Reagendar» (ruling 55): moves a PENDING activity to another moment — the call of Thursday goes to Friday. The same
 * scope as «Hecha»: found through the caller's «Ver» (a 404 otherwise), and the account locked and touched with their
 * «Editar». A compare-and-set on «not done yet» (409 if it already was), the account's next step recomputed in the same
 * transaction, and a SYSTEM event with the date before and after (the contract the console reads: `fromDueAt` and
 * `toDueAt`, ISO). Like the other activity changes, the timeline is its audit trail.
 */
export async function rescheduleActivity(access: CrmAccess, id: string, input: { dueAt: Date }) {
  const found = await prisma.crmActivity.findFirst({ where: { id, account: scopeWhere(access, 'ver') }, select: { accountId: true } })
  if (!found) throw new NotFoundError('No encontramos esa actividad', 'CRM_ACTIVITY_NOT_FOUND')
  const { accountId } = found
  const now = new Date()

  return prisma.$transaction(async tx => {
    await touchEditableTx(tx, access, accountId, now)
    // Read under the account's lock: «Hecha» takes the same lock, so nothing completes it in between.
    const before = await tx.crmActivity.findUnique({ where: { id }, select: { dueAt: true, doneAt: true, type: true, title: true } })
    if (!before) throw new NotFoundError('No encontramos esa actividad', 'CRM_ACTIVITY_NOT_FOUND')
    if (before.doneAt) throw new ConflictError('Esta actividad ya estaba hecha', 'CRM_ACTIVIDAD_YA_HECHA')
    const { count } = await tx.crmActivity.updateMany({ where: { id, doneAt: null }, data: { dueAt: input.dueAt } })
    if (count === 0) throw new ConflictError('Esta actividad ya estaba hecha', 'CRM_ACTIVIDAD_YA_HECHA')

    await addEvent(tx, {
      accountId,
      kind: 'SYSTEM',
      actorStaffId: access.staffId,
      data: {
        event: 'ACTIVITY_RESCHEDULED',
        activityId: id,
        type: before.type,
        title: before.title,
        fromDueAt: before.dueAt.toISOString(),
        toDueAt: input.dueAt.toISOString(),
      },
    })
    await recomputeNext(tx, accountId)
    return tx.crmActivity.findUniqueOrThrow({ where: { id } })
  })
}
