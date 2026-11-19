import crypto from 'crypto'
import { Prisma, type SupportAttempt } from '@prisma/client'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import { utcTs } from '@/utils/sqlDates'
import {
  getSupportAiConfig,
  isSupportFreeTextEnabled,
  isSupportHybridEnabled,
  LUNA_SUPPORT_PRICING,
  maximumSupportCost,
  observedSupportCost,
  parseSupportUsage,
  type SupportAiConfig,
} from '@/config/supportWhatsapp'
import { readCurrentClaim, type SupportClaim } from './store.service'
import { isSupportWindowOpen } from './context.service'
import { resolveRegisteredSupportPhone } from './registeredPhone.service'

const reservationSchema = z.object({
  reservation: z.object({ monthKey: z.string().startsWith('AI:MONTH:'), countKeys: z.array(z.string().startsWith('AI:')).max(3) }),
})
const lock = (tx: Prisma.TransactionClient) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('support-ai-budget', 0))`
async function releaseReservation(tx: Prisma.TransactionClient, attempt: SupportAttempt, now: Date) {
  if (attempt.state !== 'RESERVED') return
  const { reservation } = reservationSchema.parse(attempt.usage)
  await tx.supportBudget.update({ where: { key: 'AI:GLOBAL' }, data: { heldUsd: { decrement: attempt.reservedUsd } } })
  for (const key of reservation.countKeys) await tx.supportBudget.update({ where: { key }, data: { callCount: { decrement: 1 } } })
  await tx.supportAttempt.update({ where: { id: attempt.id }, data: { state: 'DEFINITIVE_FAILURE', finishedAt: now } })
}

/** Hybrid mode: `call` n (1-3) of one message is one model call; only call 1 counts against the hour/day question caps. */
export async function reserveAiAttempt(
  claim: SupportClaim,
  config: SupportAiConfig,
  now = new Date(),
  options?: { call: 1 | 2 | 3 },
): Promise<SupportAttempt | null> {
  const call = options && isSupportHybridEnabled() ? options.call : undefined
  return prisma.$transaction(async tx => {
    await lock(tx)
    const current = getSupportAiConfig()
    if (!current || current.pricing.version !== config.pricing.version) return null
    const message = await readCurrentClaim(tx, claim, now)
    if (!message || message.purpose !== 'HELP') return null
    if (call !== undefined) {
      // Released (DEFINITIVE_FAILURE) calls do not count; three live rows already refuse any call.
      const live = await tx.supportAttempt.findMany({
        where: { messageId: message.id, kind: 'AI', state: { in: ['STARTED', 'UNKNOWN', 'SUCCEEDED'] } },
        select: { state: true },
        take: 3,
      })
      if (call > 3 || live.length !== call - 1 || live.some(a => a.state !== 'SUCCEEDED')) return null
    }
    const previous = await tx.supportAttempt.findFirst({ where: { messageId: message.id, kind: 'AI' }, orderBy: { ordinal: 'desc' } })
    if (call === undefined && previous && ['STARTED', 'UNKNOWN', 'SUCCEEDED'].includes(previous.state)) return null
    if (previous?.state === 'RESERVED') {
      if (previous.claimToken === claim.claimToken) return previous
      await releaseReservation(tx, previous, now)
    }
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
      day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
      hour = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000),
      hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex'),
      monthKey = `AI:MONTH:${month.toISOString()}`,
      limits =
        (call ?? 1) > 1
          ? []
          : [
              { key: `AI:PHONE_HOUR:${hash(message.conversation.phone)}:${hour.toISOString()}`, start: hour, maximum: 10 },
              { key: `AI:PHONE_DAY:${hash(message.conversation.phone)}:${day.toISOString()}`, start: day, maximum: 30 },
              ...(message.conversation.staffId
                ? [{ key: `AI:STAFF_DAY:${hash(message.conversation.staffId)}:${day.toISOString()}`, start: day, maximum: 30 }]
                : []),
            ]
    const global = await tx.supportBudget.upsert({
      where: { key: 'AI:GLOBAL' },
      create: { key: 'AI:GLOBAL', windowStart: month },
      update: {},
    })
    const monthly = await tx.supportBudget.upsert({ where: { key: monthKey }, create: { key: monthKey, windowStart: month }, update: {} })
    const reserve = maximumSupportCost(current.pricing)
    if (monthly.spentUsd.plus(global.heldUsd).plus(reserve).gt(current.monthlyLimitUsd)) return null
    for (const limit of limits) {
      const row = await tx.supportBudget.upsert({
        where: { key: limit.key },
        create: { key: limit.key, windowStart: limit.start },
        update: {},
      })
      if (row.callCount >= limit.maximum) return null
    }
    for (const limit of limits) await tx.supportBudget.update({ where: { key: limit.key }, data: { callCount: { increment: 1 } } })
    await tx.supportBudget.update({ where: { key: 'AI:GLOBAL' }, data: { heldUsd: { increment: reserve } } })
    return tx.supportAttempt.create({
      data: {
        messageId: message.id,
        kind: 'AI',
        ordinal: (previous?.ordinal ?? 0) + 1,
        claimToken: claim.claimToken,
        state: 'RESERVED',
        reservedUsd: reserve,
        pricingVersion: current.pricing.version,
        usage: { reservation: { monthKey, countKeys: limits.map(l => l.key) } },
      },
    })
  })
}
/** `verify` runs under the budget lock, after the claim/registration/window checks and before the call is marked STARTED. */
export async function startAiAttempt(
  attemptId: string,
  claim: SupportClaim,
  now = new Date(),
  options?: { verify?: (tx: Prisma.TransactionClient) => Promise<boolean> },
): Promise<boolean> {
  return prisma.$transaction(async tx => {
    await lock(tx)
    const message = await readCurrentClaim(tx, claim, new Date(Math.max(now.getTime(), Date.now())))
    // Read under the budget lock: a registration withdrawn while this waited stops the call, and a personal history
    // only goes out while the phone still belongs only to its owner (same rule as readSupportContext).
    if (message && isSupportFreeTextEnabled()) {
      const owner = await resolveRegisteredSupportPhone(message.conversation.phone, tx)
      if (!owner.registered || (message.conversation.mode === 'PERSONAL' && owner.soleStaffId !== message.conversation.staffId))
        return false
    }
    const current = getSupportAiConfig(),
      at = new Date(Math.max(now.getTime(), Date.now()))
    if (!current || !message || !message.conversation.noticeAcceptedAt || !isSupportWindowOpen(message.conversation, at)) return false
    if (options?.verify && !(await options.verify(tx))) return false
    // The window can expire while the write waits; the statement checks its own UTC clock too.
    const count = await tx.$executeRaw`
      UPDATE "SupportAttempt" a SET state = 'STARTED', "startedAt" = t.at
      FROM (SELECT GREATEST(${utcTs(at)}, clock_timestamp() AT TIME ZONE 'UTC') AS at) t
      WHERE a.id = ${attemptId} AND a."messageId" = ${claim.messageId} AND a.kind = 'AI' AND a.state = 'RESERVED'
        AND a."claimToken" = ${claim.claimToken} AND a."pricingVersion" = ${current.pricing.version}
        AND EXISTS (SELECT 1 FROM "SupportMessage" m JOIN "SupportConversation" c ON c.id = m."conversationId"
          WHERE m.id = a."messageId" AND m.status = 'CLAIMED' AND m."claimToken" = ${claim.claimToken}
            AND m.generation = ${claim.generation} AND c.generation = m.generation AND c.mode <> 'CLOSED'
            AND m."leaseUntil" > t.at AND m."expiresAt" > t.at AND c."noticeAcceptedAt" IS NOT NULL
            AND c."lastUserMessageAt" <= t.at AND c."lastUserMessageAt" > t.at - INTERVAL '24 hours'
            AND c."lastActivityAt" <= t.at AND c."lastActivityAt" > t.at - INTERVAL '30 minutes')`
    return count === 1
  })
}
export async function finishAiAttempt(attemptId: string, usage: unknown, requestId?: string, now = new Date()): Promise<void> {
  await prisma.$transaction(async tx => {
    await lock(tx)
    await tx.$queryRaw`SELECT id FROM "SupportAttempt" WHERE id = ${attemptId} FOR UPDATE`
    const attempt = await tx.supportAttempt.findUnique({ where: { id: attemptId } })
    if (!attempt || attempt.kind !== 'AI' || !['STARTED', 'UNKNOWN'].includes(attempt.state)) return
    const actual = attempt.pricingVersion === LUNA_SUPPORT_PRICING.version ? observedSupportCost(usage, LUNA_SUPPORT_PRICING) : null
    if (!actual || actual.gt(attempt.reservedUsd)) {
      await tx.supportAttempt.update({ where: { id: attempt.id }, data: { state: 'UNKNOWN', finishedAt: now } })
      return
    }
    const { reservation } = reservationSchema.parse(attempt.usage)
    const resultUnavailable = (attempt.usage as Prisma.JsonObject).resultUnavailable === true
    await tx.supportBudget.update({ where: { key: 'AI:GLOBAL' }, data: { heldUsd: { decrement: attempt.reservedUsd } } })
    await tx.supportBudget.update({ where: { key: reservation.monthKey }, data: { spentUsd: { increment: actual } } })
    await tx.supportAttempt.update({
      where: { id: attempt.id },
      data: {
        state: 'SUCCEEDED',
        actualUsd: actual,
        finishedAt: now,
        requestId: requestId && /^[a-zA-Z0-9_-]{1,200}$/.test(requestId) ? requestId : null,
        usage: {
          reservation,
          ...(resultUnavailable ? { resultUnavailable: true } : {}),
          provider: JSON.parse(JSON.stringify(parseSupportUsage(usage, LUNA_SUPPORT_PRICING))) as Prisma.InputJsonValue,
        },
      },
    })
  })
}
export async function releaseUnstartedAiAttempt(attemptId: string, now = new Date()): Promise<void> {
  await prisma.$transaction(async tx => {
    await lock(tx)
    const attempt = await tx.supportAttempt.findUnique({ where: { id: attemptId } })
    if (attempt?.kind === 'AI') await releaseReservation(tx, attempt, now)
  })
}
