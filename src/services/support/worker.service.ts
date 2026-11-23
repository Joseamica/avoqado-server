import type OpenAI from 'openai'
import type { Prisma, SupportConversation, SupportOutcome } from '@prisma/client'
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { utcTs } from '@/utils/sqlDates'
import { runWithContext } from '@/observability/executionContext'
import { conNegocio } from '@/services/demo/candadoDemo'
import { markSupportMessageReadTyping } from '@/services/whatsapp.service'
import {
  getSupportAiConfig,
  getSupportHandoffConfig,
  isSupportDataEnabled,
  isSupportFreeTextEnabled,
  isSupportHybridEnabled,
  isSupportPublicHelpEnabled,
  isSupportWhatsappEnabled,
  supportPhoneNumberId,
  type SupportHandoffConfig,
} from '@/config/supportWhatsapp'
import {
  searchVerifiedHelp,
  loadVerifiedSections,
  loadSupportLibrary,
  resolveSourceRefs,
  sourceRef,
  type VerifiedSection,
  type HelpApp,
  type LibraryGuide,
} from './knowledge.service'
import { claimNext, readCurrentClaim, completeClaim, type SupportClaim } from './store.service'
import { readSupportContext, isSupportWindowOpen, isSupportAccessLost } from './context.service'
import type { HelpAccess } from './access.service'
import { createSupportAiClient, selectSections, composeSupportAnswer, type SectionSelection } from './answer.service'
import {
  understandSupportMessage,
  draftSupportAnswer,
  judgeSupportDraft,
  literalSupportAnswer,
  hybridHistory,
  hybridFixedReply,
  hybridDraftGuides,
  hybridDraftOutcome,
  hybridFallback,
  hybridAnswerText,
  hybridNeeds,
  savedGuidesNeed,
  scopeSupportLibrary,
  topSupportCandidates,
  guideIdsOf,
  type HybridNeed,
  type HybridScope,
  type SupportDraft,
} from './hybrid.service'
import { resolveSupportDeviceContext } from './deviceContext.service'
import { reserveAiAttempt, startAiAttempt, finishAiAttempt, releaseUnstartedAiAttempt } from './budget.service'
import { resetSupportConversation, takeDailyStaticReply } from './router.service'
import { resolveRegisteredSupportPhone } from './registeredPhone.service'
import { addPublicStrike, clearPublicStrikes, isPublicPaused, publicDayKey, publicDaySpent } from './publicHelp.service'
import { buildHumanSummary } from './humanSummary.service'
import {
  SUPPORT_FAILURE_OUTCOMES,
  handoffDedupeKey,
  isHandoffEligible,
  isHandoffYes,
  recordSupportEvent,
  requestSupportHandoff,
  secondFailureText,
  type HandoffMeta,
} from './handoff.service'
import {
  SUPPORT_ASK_APP,
  SUPPORT_ASK_DEVICE,
  SUPPORT_ASK_VERSION,
  SUPPORT_CONTACT,
  SUPPORT_HANDOFF_OFFER,
  SUPPORT_HYBRID_UNKNOWN,
  SUPPORT_LITERAL_CAP,
  SUPPORT_NO_COVERAGE,
  SUPPORT_SEND_RETRY_NOTICE,
  SUPPORT_UNREGISTERED,
  keepOtherQuestion,
  supportNotice,
  supportOldVersion,
  supportPublicNotice,
  supportPublicPause,
  supportTextCap,
  withOtherQuestion,
} from './texts'
import { DATA_CAPABILITIES, dataCatalogForAi, dataLabel, type DataCatalog } from './data/catalog'
import { prepareDataAnswer, sealDataEnvelope, type DataLog } from './data/answer.service'
import { recordSupportDataQuery } from './data/log'
import {
  SUPPORT_DATA_OFF,
  SUPPORT_DATA_RETRY,
  SUPPORT_DATA_STALE,
  isSupportDataRefusalWithoutCapability,
  supportDataHistoryMark,
} from './data/texts'
export interface SupportWorkerDependencies {
  client?: OpenAI
  sections?: VerifiedSection[]
  /** Hybrid mode only: the approved library (tests inject one; production loads the signed manifest). */
  library?: LibraryGuide[]
  /** La B: the capabilities (tests inject the fake one; production uses DATA_CAPABILITIES). */
  dataCapabilities?: DataCatalog
}
export async function runSupportBatch(
  now = new Date(),
  dependencies: SupportWorkerDependencies = {},
): Promise<{ claimed: number; completed: number; unknown: number }> {
  const stats = { claimed: 0, completed: 0, unknown: 0 }
  if (!isSupportWhatsappEnabled()) return stats
  const clock = () => new Date(Math.max(now.getTime(), Date.now()))
  const receiverId = supportPhoneNumberId()!
  await prisma.$executeRaw`
    WITH chosen AS (
      SELECT m.id, (m."expiresAt" > ${utcTs(clock())} AND c."lastUserMessageAt" <= ${utcTs(clock())}
        AND c."lastUserMessageAt" > ${utcTs(clock())} - INTERVAL '24 hours'
        AND c."lastActivityAt" <= ${utcTs(clock())} AND c."lastActivityAt" > ${utcTs(clock())} - INTERVAL '30 minutes') AS valid
      FROM "SupportMessage" m JOIN "SupportConversation" c ON c.id = m."conversationId"
      WHERE m.status = 'AI_UNKNOWN' AND m.generation = c.generation AND c.mode <> 'CLOSED' AND c."receiverId" = ${receiverId}
      ORDER BY m."createdAt", m.id LIMIT 20 FOR UPDATE OF m SKIP LOCKED
    ) UPDATE "SupportMessage" m SET status = CASE WHEN chosen.valid THEN 'ANSWER_READY' ELSE 'EXPIRED' END::"SupportMessageStatus",
      answer = CASE WHEN chosen.valid THEN ${SUPPORT_AI_UNCERTAIN} ELSE NULL END, "sourceIds" = '{}', "accessFingerprint" = NULL,
      "answerCipher" = NULL, "claimToken" = NULL, "leaseUntil" = NULL, "nextAttemptAt" = ${utcTs(clock())}
    FROM chosen WHERE m.id = chosen.id`
  // Delivery uses the public-reset helper below; defer loading it until both modules have initialized.
  const { deliverSupportMessage } = await import('./delivery.service')
  let units = 0
  const consume = async () => {
    while (units++ < 20) {
      if (!isSupportWhatsappEnabled()) return
      const claim = await claimNext(clock(), receiverId)
      if (!claim) return
      stats.claimed++
      const message = await prisma.supportMessage.findUnique({ where: { id: claim.messageId }, include: { conversation: true } })
      if (!message) continue
      const personal = message.conversation.mode === 'PERSONAL'
      const result = await runWithContext(
        {
          correlationId: randomUUID(),
          source: 'job',
          entrypoint: 'support-whatsapp.message',
          ...(personal && message.conversation.staffId ? { userId: message.conversation.staffId } : {}),
        },
        () =>
          // Candado demo, capa 3: cada fila lleva su negocio, nunca el del tick o mensaje anterior.
          conNegocio(personal ? message.conversation.venueId : null, () =>
            message.answer || message.answerCipher
              ? deliverSupportMessage(claim, dependencies.sections, dependencies.library, dependencies.dataCapabilities)
              : prepareSupportAnswer(claim, dependencies, clock()),
          ),
      )
      if (result === 'SENT') stats.completed++
      if (result === 'UNKNOWN') stats.unknown++
    }
  }
  // Both lanes must finish before the job releases its single-flight guard, even if one fails.
  const results = await Promise.allSettled([consume(), consume()])
  if (results.some(result => result.status === 'rejected')) throw new Error('SUPPORT_BATCH_FAILED')
  return stats
}
export const SUPPORT_AI_UNCERTAIN = `No pude confirmar la respuesta del asistente. No la repetiré automáticamente. Puedes escribir REINTENTAR una sola vez; podría contar como otra consulta. ${SUPPORT_CONTACT}`
/** A handoff offer or an old-version notice is sent and resent as saved, never rebuilt (R2-02, T2-c2). */
export const savedAsIs = (m: { handoffOffered: boolean; outcome: SupportOutcome | null }) => m.handoffOffered || m.outcome === 'OLD_VERSION'
/**
 * The outcome of a hybrid answer; `event: false` only repeats one (a resend) and is not counted again. `guideIds`: what the
 * event counts when it is not what the answer cites (a «no encontré» after drafting with a guide cites none).
 */
type AnswerMark = { outcome: SupportOutcome; offered?: boolean; event?: boolean; guideIds?: string[] }
/** A DATA answer keeps its text only in `answerCipher`, never in `answer` (the purpose check of SupportMessage). */
type AnswerPatch = {
  status: 'ANSWER_READY'
  answer: string | null
  sourceIds: string[]
  accessFingerprint: string | null
  purpose?: 'HELP' | 'DATA'
  answerCipher?: string | null
  dataCapability?: string | null
}
/**
 * completeClaim and its SupportEvent in one transaction: a message retaken or retried never counts twice. With `log` (la B),
 * its row in the same transaction, only when the claim was won: a lost claim leaves no row.
 */
async function completeAnswer(
  tx: Prisma.TransactionClient,
  claim: SupportClaim,
  message: { sequence: number; conversation: { app: string | null } },
  patch: AnswerPatch,
  mark: AnswerMark,
  now: Date,
  log?: DataLog | null,
): Promise<boolean> {
  if (!(await completeClaim(claim, { ...patch, outcome: mark.outcome, handoffOffered: !!mark.offered }, now, tx))) return false
  if (log) await recordSupportDataQuery(tx, log)
  if (mark.event !== false)
    await recordSupportEvent(tx, {
      kind: mark.outcome,
      app: message.conversation.app,
      guideIds: mark.guideIds ?? guideIdsOf(patch.sourceIds),
      conversationId: claim.conversationId,
      generation: claim.generation,
      sequence: message.sequence,
      now,
    })
  return true
}

/** What goes out in place of what was prepared: its text, the sources it SHOWS and, if it changed, its outcome. */
export type ShownSupportAnswer = {
  answer: string
  /** `id@hash8` of what the text shows, with the CURRENT hash when the text was rebuilt from today's guides. */
  sourceIds: string[]
  outcome?: SupportOutcome
  handoffOffered?: boolean
  /** The correcting event's guides; by default, those of the event it corrects (what was tried). */
  guideIds?: string[]
}
/**
 * T-F6 (Codex H6): the ONE writer of a substitution, in the caller's transaction (right after readCurrentClaim): what is shown
 * and its sources, the outcome of what it is now (an unmarked message, from before the flag, stays unmarked) and, if the
 * message was already counted as something else, a correcting SupportEvent appended: the old one is never edited. Every reader
 * of the events takes the latest one of each message (the weekly list). `patch`: what else changes on the row (the claim, the
 * purpose of a data answer…); `where`: the row guard (by default, the claim). false = the claim was lost: nothing was written.
 */
export async function recordShownSupportAnswer(
  tx: Prisma.TransactionClient,
  claim: SupportClaim,
  message: { sequence: number; outcome: SupportOutcome | null; conversation: { app: string | null } },
  shown: ShownSupportAnswer,
  patch: Prisma.SupportMessageUpdateManyMutationInput,
  now: Date,
  where: Prisma.SupportMessageWhereInput = {
    id: claim.messageId,
    status: 'CLAIMED',
    claimToken: claim.claimToken,
    generation: claim.generation,
  },
): Promise<boolean> {
  const outcome = message.outcome ? (shown.outcome ?? message.outcome) : undefined
  const done = await tx.supportMessage.updateMany({
    where,
    data: {
      ...patch,
      answer: shown.answer,
      sourceIds: shown.sourceIds,
      ...(outcome ? { outcome } : {}),
      ...(shown.handoffOffered === undefined ? {} : { handoffOffered: shown.handoffOffered }),
    },
  })
  if (done.count !== 1) return false
  if (outcome && outcome !== message.outcome) {
    // Index SupportEvent [conversationId, generation, sequence].
    const key = { conversationId: claim.conversationId, generation: claim.generation, sequence: message.sequence }
    const counted = await tx.supportEvent.findFirst({
      where: key,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { kind: true, guideIds: true },
    })
    if (counted && counted.kind !== outcome)
      await recordSupportEvent(tx, {
        kind: outcome,
        app: message.conversation.app,
        guideIds: shown.guideIds ?? counted.guideIds,
        ...key,
        now,
      })
  }
  return true
}

export async function replaceWithPublicNotice(claim: SupportClaim, now = new Date()): Promise<void> {
  // The phone lock first, as the router (phone, conversation, then its messages): AYUDA or SALIR at the same time never waits on
  // this message while this waits on its conversation.
  const owner = await prisma.supportConversation.findUnique({
    where: { id: claim.conversationId },
    select: { receiverId: true, phone: true },
  })
  await prisma.$transaction(async tx => {
    if (owner)
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`support-phone:${owner.receiverId}:${owner.phone}`}, 0))`
    const message = await readCurrentClaim(tx, claim, now)
    if (!message) return
    const conversation = await resetSupportConversation(tx, message.conversation)
    // The reset already cancelled the claim: the row is guarded by its id, as before. A correcting event (FIXED) only if the
    // message had already been counted, under the generation it was counted in.
    await recordShownSupportAnswer(
      tx,
      claim,
      message,
      {
        answer: `Tu acceso cambió o esta selección ya no está vigente. Escribe AYUDA para seguir con ayuda pública. ${SUPPORT_CONTACT}`,
        sourceIds: [],
        outcome: 'FIXED',
        // It offers no person and answers nothing: a «sí» to it never hands off, and it is no failure in a row.
        handoffOffered: false,
      },
      {
        generation: conversation.generation,
        body: '',
        status: 'ANSWER_READY',
        // A DATA answer it replaces becomes a plain HELP notice: no cipher, no capability.
        purpose: 'HELP',
        answerCipher: null,
        dataCapability: null,
        outcome: 'FIXED',
        accessFingerprint: null,
        claimToken: null,
        leaseUntil: null,
        nextAttemptAt: now,
      },
      now,
      { id: message.id },
    )
  })
}
export async function prepareSupportAnswer(
  claim: SupportClaim,
  dependencies: SupportWorkerDependencies = {},
  now = new Date(),
): Promise<'READY' | 'UNKNOWN' | 'EXPIRED' | 'CANCELLED'> {
  const clock = () => new Date(Math.max(now.getTime(), Date.now()))
  const message = await prisma.$transaction(tx => readCurrentClaim(tx, claim, clock()))
  if (!message) return 'CANCELLED'
  const conversation = message.conversation
  // A marked answer (flag on) commits with its outcome and its SupportEvent; an unmarked one, exactly as today.
  const save = async (
    answer: string,
    sourceIds: string[] = [],
    fingerprint?: string,
    mark?: AnswerMark,
    dataCapability?: string | null,
  ) => {
    const patch = {
      status: 'ANSWER_READY' as const,
      answer,
      sourceIds,
      accessFingerprint: fingerprint ?? null,
      ...(dataCapability ? { dataCapability } : {}),
    }
    const done = mark
      ? await prisma.$transaction(tx => completeAnswer(tx, claim, message, patch, mark, clock()))
      : await completeClaim(claim, patch, clock())
    return done ? ('READY' as const) : ('CANCELLED' as const)
  }
  if (!isSupportWhatsappEnabled() || conversation.receiverId !== supportPhoneNumberId()) {
    await completeClaim(claim, { status: 'CANCELLED' }, clock())
    return 'CANCELLED'
  }
  if (!isSupportWindowOpen(conversation, clock())) {
    await completeClaim(claim, { status: 'EXPIRED', answerCipher: null }, clock())
    return 'EXPIRED'
  }
  if (message.answer || message.answerCipher) {
    await completeClaim(claim, { status: 'ANSWER_READY' }, clock())
    return 'READY'
  }
  // Hybrid refs (`id@hash8`) are read with or without the flag: a message prepared with it may be resent after it.
  const library = () => dependencies.library ?? loadSupportLibrary()
  const unregistered = async () =>
    isSupportFreeTextEnabled() && !(await resolveRegisteredSupportPhone(conversation.phone, prisma)).registered
  // The fixed message keeps the router's one-per-day cap; once it went out today the question ends silently.
  // Cap and reply commit together on a still-valid claim, so a lost save never spends the day's message. The phone lock goes
  // first, as in the router (phone, its control rows, then the messages): the two never wait on each other's rows.
  const fixedReply = () =>
    prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`support-phone:${conversation.receiverId}:${conversation.phone}`}, 0))`
      if (!(await readCurrentClaim(tx, claim, clock()))) return 'CANCELLED' as const
      const first = await takeDailyStaticReply(tx, conversation.receiverId, conversation.phone, clock())
      await tx.supportMessage.update({
        where: { id: claim.messageId },
        data: first
          ? {
              status: 'ANSWER_READY',
              answer: SUPPORT_UNREGISTERED,
              sourceIds: [],
              accessFingerprint: null,
              claimToken: null,
              leaseUntil: null,
            }
          : { status: 'CANCELLED', claimToken: null, leaseUntil: null },
      })
      return first ? ('READY' as const) : ('CANCELLED' as const)
    })
  // Public help (an unknown phone): what its caps say instead of an answer; null = it is answered. Off, not public, or the day's
  // US$ spent: the fixed message, as with it off. Paused: silence.
  const publicStop = async (): Promise<'READY' | 'CANCELLED' | null> => {
    if (!isSupportPublicHelpEnabled() || conversation.mode !== 'PUBLIC') return fixedReply()
    if (await isPublicPaused(prisma, conversation.receiverId, conversation.phone, clock())) {
      await completeClaim(claim, { status: 'CANCELLED' }, clock())
      return 'CANCELLED'
    }
    const ai = getSupportAiConfig()
    if (ai && publicDaySpent(await prisma.supportBudget.findUnique({ where: { key: publicDayKey(clock()) } }), ai.pricing))
      return fixedReply()
    return null
  }
  let publicHelp = false
  if (await unregistered()) {
    const stop = await publicStop()
    if (stop) return stop
    publicHelp = true
  }
  // Public help never shows a page of the internal manual, not even one a registered person of this phone got in this same
  // conversation before (a message prepared in public right after losing the registration). Anything that is not a public
  // guide today counts as internal: a retired page included.
  let publicIds: Set<string> | undefined
  const citesInternal = (sourceIds: string[]) => {
    publicIds ??= new Set(library().flatMap(g => (g.internal ? [] : [g.id])))
    return guideIdsOf(sourceIds).some(id => !publicIds!.has(id))
  }
  // A model call that could not start: the message may have expired, lost its registration or its personal context.
  // null = the message is still current (a hybrid call 2 or 3 then answers with the literal guide).
  const notStarted = async () => {
    const stopped = await prisma.$transaction(tx => readCurrentClaim(tx, claim, clock()))
    if (stopped && !isSupportWindowOpen(stopped.conversation, clock())) {
      await completeClaim(claim, { status: 'EXPIRED', answerCipher: null }, clock())
      return 'EXPIRED' as const
    }
    if (await unregistered()) {
      if (!publicHelp) return fixedReply()
      const stop = await publicStop()
      if (stop) return stop
    }
    // A personal context the phone no longer belongs to only gets the public notice (readSupportContext throws).
    if (stopped && isSupportFreeTextEnabled()) await readSupportContext(stopped.conversation, [], clock())
    return stopped ? null : ('CANCELLED' as const)
  }
  let attemptId: string | undefined,
    started = false
  try {
    const initial = await readSupportContext(conversation, [], clock())
    if (message.body.toUpperCase() === 'RECUPERAR') {
      // Public help keeps no memory of another conversation.
      if (publicHelp) return save(`No encontré una guía guardada vigente para esa app. ${SUPPORT_CONTACT}`)
      const saved = await prisma.supportMessage.findFirst({
        where: {
          purpose: 'HELP',
          sourceIds: { isEmpty: false },
          // Options offered are not an answer: the last real one is recovered.
          NOT: { sourceIds: { has: '#clarify' } },
          expiresAt: { gt: clock() },
          conversation: { receiverId: conversation.receiverId, phone: conversation.phone, mode: 'CLOSED', app: conversation.app },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { sourceIds: true },
      })
      if (!saved) return save(`No encontré una guía guardada vigente para esa app. ${SUPPORT_CONTACT}`)
      const hybrid = resolveSourceRefs(saved.sourceIds, library)
      if (hybrid) {
        // T-F5 (Codex P1, all or nothing): every saved guide still fits today's scope, as for a new question, or nothing is
        // recovered. One that needs an unknown version or terminal asks first; one that is gone or no longer fits, «no encontré».
        const need = savedGuidesNeed(saved.sourceIds, hybrid.guides, {
          app: conversation.app as HelpApp,
          ...(await resolveSupportDeviceContext(conversation, clock())),
        })
        if (need === 'GONE') return save(`No encontré una guía guardada vigente para esa app. ${SUPPORT_CONTACT}`)
        if (need) return askVersionOrDevice(claim, message, need, clock, save)
        const fresh = await readSupportContext(conversation, hybrid.guides, clock())
        return save(literalSupportAnswer(hybrid.guides, fresh.access), hybrid.guides.map(sourceRef), fresh.fingerprint)
      }
      const restored: VerifiedSection[] = []
      for (const sectionId of saved.sourceIds.slice(0, 3)) {
        const result = await searchVerifiedHelp(
          {
            topic: '',
            sectionId,
            app: conversation.app as HelpApp,
            appVersion: conversation.appVersion ?? undefined,
            deviceFamily: conversation.deviceFamily as 'PAX' | 'NEXGO' | undefined,
          },
          null,
          dependencies.sections ?? loadVerifiedSections(),
        )
        if (result.kind !== 'ANSWER') return save(SUPPORT_NO_COVERAGE)
        restored.push(...result.sections)
      }
      const fresh = await readSupportContext(conversation, restored, clock())
      return save(
        composeSupportAnswer(restored, fresh.access),
        restored.map(s => s.id),
        fresh.fingerprint,
      )
    }
    if (message.body.toUpperCase() === 'REINTENTAR') {
      // Right after a data answer (delivered, uncertain or cancelled), or after the «vuelve a preguntar» that delivery left in
      // its place, nothing is resent nor read again (T-B20). Index SupportMessage @@unique([conversationId, sequence]).
      const last = await prisma.supportMessage.findFirst({
        where: { conversationId: conversation.id, generation: claim.generation, sequence: { lt: message.sequence } },
        orderBy: { sequence: 'desc' },
        select: { purpose: true, answer: true },
      })
      if (last?.purpose === 'DATA' || last?.answer === SUPPORT_DATA_STALE || last?.answer === SUPPORT_DATA_OFF)
        return save(SUPPORT_DATA_RETRY)
      const previous = await prisma.supportMessage.findFirst({
        where: {
          conversationId: conversation.id,
          generation: claim.generation,
          purpose: 'HELP',
          sequence: { lt: message.sequence },
          expiresAt: { gt: clock() },
          OR: [
            { attempts: { some: { kind: 'SEND', state: 'UNKNOWN' } } },
            // With the hybrid flag, a lost call 2 or 3 still sent the literal guide (it cites guides): only a message left
            // without an answer (SUPPORT_AI_UNCERTAIN, no sources) asked for REINTENTAR. Flag off: the same as any UNKNOWN.
            { attempts: { some: { kind: 'AI', state: 'UNKNOWN' } }, ...(isSupportHybridEnabled() ? { sourceIds: { isEmpty: true } } : {}) },
            { attempts: { some: { kind: 'AI', state: 'SUCCEEDED', usage: { path: ['resultUnavailable'], equals: true } } } },
            { status: 'AI_UNKNOWN', attempts: { some: { kind: 'AI', state: 'SUCCEEDED' } } },
          ],
        },
        orderBy: { sequence: 'desc' },
        // Only the uncertain SEND decides the resend branch. SEND is always ordinal 1, so an ordinal-ordered take shared
        // with up to three AI calls could leave it out.
        include: { attempts: { where: { kind: 'SEND', state: 'UNKNOWN' }, take: 1 } },
      })
      if (
        !previous ||
        previous.retryOfId ||
        (publicHelp && citesInternal(previous.sourceIds)) ||
        (await prisma.supportMessage.findUnique({ where: { retryOfId: previous.id } }))
      )
        return save(`No hay otra consulta incierta que pueda repetir. Se permite un solo reintento por pregunta. ${SUPPORT_CONTACT}`)
      const attached = await prisma.$transaction(async tx => {
        if (!(await readCurrentClaim(tx, claim, clock()))) return false
        await tx.supportMessage.update({ where: { id: message.id }, data: { retryOfId: previous.id, body: previous.body } })
        return true
      })
      if (!attached) return 'CANCELLED'
      if (previous.attempts.some(a => a.kind === 'SEND') && previous.answer) {
        const hybrid = resolveSourceRefs(previous.sourceIds, library)
        const sections = hybrid?.guides ?? (dependencies.sections ?? loadVerifiedSections()).filter(s => previous.sourceIds.includes(s.id))
        const fresh = await readSupportContext(conversation, sections, clock())
        if (!previous.accessFingerprint || fresh.fingerprint !== previous.accessFingerprint) {
          await replaceWithPublicNotice(claim, clock())
          return 'CANCELLED'
        }
        const warning = SUPPORT_SEND_RETRY_NOTICE
        const body = `${warning}\n\n${previous.answer}`
        // A clarification is resent as it was (delivery rebuilds it if a guide changed); an answer, as the literal guide. A
        // handoff offer or an old-version notice keeps its saved text, which a rebuilt guide would lose (R3-05).
        const shorter = savedAsIs(previous)
          ? previous.answer
          : !hybrid
            ? composeSupportAnswer(sections, fresh.access, warning)
            : hybrid.clarify
              ? previous.answer
              : keepOtherQuestion(previous.answer, literalSupportAnswer(hybrid.guides, fresh.access, warning), SUPPORT_LITERAL_CAP)
        // The resend keeps the offer, the outcome and the capability of a «no puedo» of la B (a «sí» to it still hands off,
        // naming the data), but repeats an answer: no new event. T-F6 (Codex H6): a drafted answer resent as the literal guide is
        // no longer the drafted answer: LITERAL.
        // T-F10c: the cap of the answer it resends (read without the notice): a drafted answer keeps its 1,500, the literal guide
        // goes up to SUPPORT_LITERAL_CAP.
        const text = body.length <= supportTextCap(previous.answer) ? body : shorter
        const literal = text !== body && !!hybrid && !hybrid.clarify && !savedAsIs(previous)
        const outcome = literal && previous.outcome === 'ANSWERED' ? 'LITERAL' : previous.outcome
        const mark = outcome ? { outcome, offered: previous.handoffOffered, event: false } : undefined
        return save(text, previous.sourceIds, fresh.fingerprint, mark, previous.dataCapability)
      }
      message.body = previous.body
    }
    if (!conversation.noticeAcceptedAt) return save(publicHelp ? supportPublicNotice() : supportNotice())
    if (!['dashboard', 'android', 'windows', 'tpv'].includes(conversation.app ?? '')) return save(SUPPORT_ASK_APP)
    if (isSupportHybridEnabled())
      return await prepareHybridAnswer({
        claim,
        message,
        dependencies,
        clock,
        initial: initial.fingerprint,
        save,
        notStarted,
        publicHelp: publicHelp ? { stop: publicStop, citesInternal } : undefined,
      })
    const result = await searchVerifiedHelp(
      {
        topic: message.body,
        app: conversation.app as HelpApp,
        appVersion: conversation.appVersion ?? undefined,
        deviceFamily: conversation.deviceFamily as 'PAX' | 'NEXGO' | undefined,
      },
      initial.context,
      dependencies.sections ?? loadVerifiedSections(),
    )
    if (result.kind === 'ASK_VERSION' || result.kind === 'ASK_DEVICE')
      return askVersionOrDevice(claim, message, result.kind === 'ASK_VERSION' ? 'VERSION' : 'DEVICE', clock, save)
    if (!result.sections.length) return save(SUPPORT_NO_COVERAGE)
    const before = await readSupportContext(conversation, result.sections, clock())
    const config = getSupportAiConfig()
    if (!config) return save(`El asistente todavía no está activado. ${SUPPORT_CONTACT}`)
    const attempt = await reserveAiAttempt(claim, config, clock())
    if (!attempt) return save(`Por ahora se alcanzó el límite de consultas del asistente. ${SUPPORT_CONTACT}`)
    attemptId = attempt.id
    const current = await prisma.$transaction(tx => readCurrentClaim(tx, claim, clock()))
    if (!current) {
      await releaseUnstartedAiAttempt(attemptId, clock())
      return 'CANCELLED'
    }
    const ready = await readSupportContext(current.conversation, result.sections, clock())
    if (ready.fingerprint !== before.fingerprint) {
      await releaseUnstartedAiAttempt(attemptId, clock())
      await replaceWithPublicNotice(claim, clock())
      return 'CANCELLED'
    }
    const history = await prisma.supportMessage.findMany({
      where: {
        conversationId: conversation.id,
        generation: claim.generation,
        purpose: 'HELP',
        status: 'SENT',
        sourceIds: { isEmpty: false },
        sequence: { lt: message.sequence },
        expiresAt: { gt: clock() },
      },
      orderBy: { sequence: 'desc' },
      take: 3,
      select: { body: true, answer: true },
    })
    if (!(await startAiAttempt(attemptId, claim, clock()))) {
      await releaseUnstartedAiAttempt(attemptId, clock())
      return (await notStarted()) ?? 'CANCELLED'
    }
    started = true
    let selected: SectionSelection
    try {
      selected = await selectSections(
        dependencies.client ?? createSupportAiClient(config),
        {
          topic: message.body,
          candidates: result.sections,
          history: history.reverse().flatMap(h => [
            { role: 'user' as const, text: h.body },
            { role: 'assistant' as const, text: h.answer ?? '' },
          ]),
        },
        config.pricing,
      )
    } catch {
      await finishAiAttempt(attemptId, null, undefined, clock())
      await save(SUPPORT_AI_UNCERTAIN)
      return 'UNKNOWN'
    }
    await finishAiAttempt(attemptId, selected.usage, selected.requestId, clock())
    const fresh = await prisma.$transaction(tx => readCurrentClaim(tx, claim, clock()))
    if (!fresh) return 'CANCELLED'
    const after = await readSupportContext(fresh.conversation, result.sections, clock())
    if (after.fingerprint !== before.fingerprint) {
      await replaceWithPublicNotice(claim, clock())
      return 'CANCELLED'
    }
    const chosen = selected.valid && !selected.needsClarification ? result.sections.filter(s => selected.sectionIds.includes(s.id)) : []
    const finalAccess = await readSupportContext(fresh.conversation, chosen, clock())
    return save(
      composeSupportAnswer(chosen, finalAccess.access),
      chosen.map(s => s.id),
      finalAccess.fingerprint,
    )
  } catch (err) {
    if (attemptId && !started) await releaseUnstartedAiAttempt(attemptId, clock())
    // Also a venue lost after the last check, in the final reads (finish, notStarted).
    if (isSupportAccessLost(err)) {
      await replaceWithPublicNotice(claim, clock())
      return 'CANCELLED'
    }
    throw err
  }
}

/** La pregunta de versión o de terminal pendiente, con su tema, por 10 minutos (el worker y la cola). */
export function holdVersionOrDevice(tx: Prisma.TransactionClient, conversationId: string, needs: HybridNeed, topic: string, now: Date) {
  return tx.supportConversation.update({
    where: { id: conversationId },
    data: {
      pendingSelection: needs,
      selectionOptions: {
        topic,
        items:
          needs === 'VERSION'
            ? []
            : [
                { value: 'PAX', label: 'PAX' },
                { value: 'NEXGO', label: 'Nexgo' },
              ],
      },
      selectionExpiresAt: new Date(now.getTime() + 600000),
    },
  })
}
/** Pregunta la versión o la terminal y guarda el tema; el router recibe la respuesta y vuelve a encolar el tema (los dos caminos). */
async function askVersionOrDevice(
  claim: SupportClaim,
  message: { conversationId: string; body: string },
  needs: HybridNeed,
  clock: () => Date,
  save: (answer: string, sourceIds?: string[], fingerprint?: string, mark?: AnswerMark) => Promise<'READY' | 'CANCELLED'>,
  mark?: AnswerMark,
) {
  await prisma.$transaction(async tx => {
    if (!(await readCurrentClaim(tx, claim, clock()))) return
    await holdVersionOrDevice(tx, message.conversationId, needs, message.body, clock())
  })
  return save(needs === 'VERSION' ? SUPPORT_ASK_VERSION : SUPPORT_ASK_DEVICE, [], undefined, mark)
}

// ── Modo híbrido: entender → (aclarar | redactar → revisar → juez) ─────────────────────────────────
// Cada llamada al modelo es su propio intento AI, con la misma secuencia de hoy: reservar → releer el claim → mismo
// contexto que al empezar → arrancar (con `verify` bajo el candado) → llamar → liquidar.

type Prepared = 'READY' | 'UNKNOWN' | 'EXPIRED' | 'CANCELLED'
type CurrentMessage = NonNullable<Awaited<ReturnType<typeof readCurrentClaim>>>
class CallNotStarted extends Error {}
/** The claim was lost inside a transaction that must leave nothing behind. */
class ClaimLost extends Error {}

async function prepareHybridAnswer(job: {
  claim: SupportClaim
  message: CurrentMessage
  dependencies: SupportWorkerDependencies
  clock: () => Date
  initial: string
  save: (answer: string, sourceIds?: string[], fingerprint?: string, mark?: AnswerMark) => Promise<'READY' | 'CANCELLED'>
  notStarted: () => Promise<Prepared | null>
  /** Public help (an unknown phone): its state check and the internal-page test of prepareSupportAnswer. */
  publicHelp?: { stop: () => Promise<Prepared | null>; citesInternal: (sourceIds: string[]) => boolean }
}): Promise<Prepared> {
  const { claim, message, dependencies, clock, initial, save, notStarted, publicHelp } = job
  const conversation = message.conversation
  const begun = Date.now()
  let kind: string | undefined,
    fallback: string | undefined,
    calls = 0,
    // T-F14: understand saw another question in this message: every answer below ends with SUPPORT_OTHER_QUESTION.
    also = false,
    // La B: which capability answered and its log result (never a figure nor a parameter).
    capability: string | undefined,
    dataResult: string | undefined
  const caps = dependencies.dataCapabilities ?? DATA_CAPABILITIES
  // T-B44: the frozen label of the catalog; the mark for the model never prints the key saved in the database.
  const labelOf = (key: string) => dataLabel(caps, key)
  try {
    // Pasar a una persona (null = como hoy: el resumen, sin oferta ni aviso).
    const handoff = getSupportHandoffConfig()
    // A data answer reaches the model only as a mark with its label: its text lives in the cipher and is never read here.
    const previous = (
      await prisma.supportMessage.findMany({
        where: {
          conversationId: conversation.id,
          generation: claim.generation,
          purpose: { in: ['HELP', 'DATA'] },
          status: { in: ['SENT', 'SEND_UNKNOWN'] },
          sequence: { lt: message.sequence },
          expiresAt: { gt: clock() },
        },
        orderBy: { sequence: 'desc' },
        take: 4,
        select: { body: true, answer: true, sourceIds: true, outcome: true, handoffOffered: true, purpose: true, dataCapability: true },
      })
    )
      // Public help: an answer with a page of the internal manual (given while this phone was registered) never reaches the model.
      .filter(p => !publicHelp?.citesInternal(p.sourceIds))
      .map(p => (p.purpose === 'DATA' ? { ...p, answer: supportDataHistoryMark(labelOf(p.dataCapability ?? '')) } : p))
    // Same context as the first read. A revoked link or a lost venue (readSupportContext or getUserAccess throw) is a change.
    const unchanged = async (current: SupportConversation, db?: Prisma.TransactionClient) => {
      try {
        return (await readSupportContext(current, [], clock(), db)).fingerprint === initial
      } catch (err) {
        if (isSupportAccessLost(err)) return false
        throw err
      }
    }
    // The claim read again, in the same context as the first read; a changed one gets today's public notice. null = stop.
    const recheck = async (): Promise<CurrentMessage | null> => {
      const fresh = await prisma.$transaction(tx => readCurrentClaim(tx, claim, clock()))
      if (!fresh) return null
      if (await unchanged(fresh.conversation)) return fresh
      await replaceWithPublicNotice(claim, clock())
      return null
    }
    // The same final reads as finish, then ONE transaction: phone lock (the router's, before the message row) → the claim →
    // the notice → completeClaim. A lost claim throws, so no notice is left behind.
    const finishHandoff = async (
      reason: HandoffMeta['reason'],
      config: SupportHandoffConfig,
      extra?: { dataCapability?: string },
    ): Promise<Prepared> => {
      const fresh = await recheck()
      if (!fresh) return 'CANCELLED'
      const final = await readSupportContext(fresh.conversation, [], clock())
      try {
        return await prisma.$transaction(async tx => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`support-phone:${conversation.receiverId}:${conversation.phone}`}, 0))`
          const current = await readCurrentClaim(tx, claim, clock())
          if (!current) throw new ClaimLost()
          const done = await requestSupportHandoff(tx, current.conversation, reason, clock(), config, dependencies.library, extra)
          const patch = { status: 'ANSWER_READY' as const, answer: done.text, sourceIds: [], accessFingerprint: final.fingerprint }
          if (!(await completeAnswer(tx, claim, current, patch, { outcome: done.outcome }, clock()))) throw new ClaimLost()
          return 'READY' as const
        })
      } catch (err) {
        if (err instanceof ClaimLost) return 'CANCELLED'
        throw err
      }
    }
    // «Sí» to the offer: no model call (R1-13).
    if (handoff && previous[0]?.handoffOffered && isHandoffYes(message.body)) {
      fallback = 'handoff-yes'
      // After a «no puedo» of la B, with its capability or one of those that have none: reason DATA, and the notice names
      // the data it tried (its label, never a figure; without one, the email says «otro dato»).
      const tried = previous[0].dataCapability
      if (tried || isSupportDataRefusalWithoutCapability(previous[0].answer))
        return finishHandoff('DATA', handoff, tried ? { dataCapability: labelOf(tried) ?? tried } : undefined)
      return finishHandoff(previous[0].outcome === 'OLD_VERSION' ? 'OLD_VERSION' : 'TWO_FAILURES', handoff)
    }
    // Only a conversation that may hand off and has no notice in this generation is offered a person.
    const offerable = async (current: SupportConversation) =>
      (await isHandoffEligible(prisma, current)).eligible &&
      !(await prisma.supportNotice.findUnique({
        where: { dedupeKey: handoffDedupeKey(current.id, current.generation) },
        select: { id: true },
      }))
    const failed = (outcome?: SupportOutcome | null) => !!outcome && SUPPORT_FAILURE_OUTCOMES.includes(outcome)
    // Same final checks as today; the fingerprint is read with the gates of the guides the answer cites. With the handoff on,
    // a second failure in a row is the short text with the nearest guide and the offer, and an old version carries the offer.
    // `tried`: the guides the answer was attempted with; the event counts them, and an offer cites them (R2-02, T5-c1).
    const finish = async (
      guides: LibraryGuide[],
      compose: (access: HelpAccess | null, offer: boolean) => string,
      outcome: SupportOutcome,
      sourceIds = guides.map(sourceRef),
      tried = guides,
    ) => {
      const fresh = await recheck()
      if (!fresh) return 'CANCELLED' as const
      const wanted = outcome === 'OLD_VERSION' || (failed(outcome) && failed(previous[0]?.outcome))
      const offer = !!handoff && wanted && (await offerable(fresh.conversation))
      // The offer is saved and delivered as is. T-F5 (P3): it cites only the guide it shows («Lo más cercano», the first one
      // tried), and its fingerprint reads that guide's gates; the event still counts every guide tried.
      const failure = offer && outcome !== 'OLD_VERSION'
      const nearest = tried.slice(0, 1)
      const final = await readSupportContext(fresh.conversation, failure ? nearest : guides, clock())
      // «Lo más cercano»: the literal guide, or after covered:false the drafted one (already gated and cited) (T5-c5).
      const composed = failure ? secondFailureText(nearest[0] ?? null) : compose(final.access, offer)
      // A drafted answer that did not render went out as the literal guide.
      const kept = outcome === 'ANSWERED' && fallback === 'render' ? 'LITERAL' : outcome
      // T-F14: the literal guide (even a short one) has its cap; any other text, 1,500 (supportTextCap).
      const literal = !failure && ['LITERAL', 'JUDGE_LITERAL', 'OLD_VERSION'].includes(kept)
      const text = withOtherQuestion(composed, also, literal ? SUPPORT_LITERAL_CAP : undefined)
      return save(text, failure ? nearest.map(sourceRef) : sourceIds, final.fingerprint, {
        outcome: kept,
        offered: offer && text.includes(SUPPORT_HANDOFF_OFFER),
        guideIds: [...new Set(tried.map(g => g.id))],
      })
    }

    // Capa 2 (public help): the strike commits with its answer, once (a retried message never counts twice), under the phone lock
    // first, as the router. The third in a row answers with the pause and silences what this phone left in line; a link code asked
    // from the panel is not cancelled: linking is the way out of public help.
    const strike = async (text: string): Promise<Prepared> => {
      const fresh = await recheck()
      if (!fresh) return 'CANCELLED'
      const final = await readSupportContext(fresh.conversation, [], clock())
      try {
        return await prisma.$transaction(async tx => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`support-phone:${conversation.receiverId}:${conversation.phone}`}, 0))`
          const current = await readCurrentClaim(tx, claim, clock())
          if (!current) throw new ClaimLost()
          // Registered meanwhile: no strike (and nothing it queued as registered is cancelled).
          const registered = (await resolveRegisteredSupportPhone(conversation.phone, tx)).registered
          const days = registered ? 0 : await addPublicStrike(tx, conversation.receiverId, conversation.phone, clock())
          if (days)
            await tx.supportMessage.updateMany({
              where: {
                conversationId: current.conversationId,
                purpose: 'HELP',
                sequence: { gt: current.sequence },
                status: { in: ['QUEUED', 'ANSWER_READY', 'AI_UNKNOWN'] },
              },
              data: { status: 'CANCELLED', claimToken: null, leaseUntil: null },
            })
          const answer = days ? supportPublicPause(days) : text
          const patch = { status: 'ANSWER_READY' as const, answer, sourceIds: [], accessFingerprint: final.fingerprint }
          if (!(await completeAnswer(tx, claim, current, patch, { outcome: 'FIXED' }, clock()))) throw new ClaimLost()
          return 'READY' as const
        })
      } catch (err) {
        if (err instanceof ClaimLost) return 'CANCELLED'
        throw err
      }
    }

    // Public help: only the public guides (never the internal manual).
    const library = (dependencies.library ?? loadSupportLibrary()).filter(g => !publicHelp || !g.internal)
    // Through finish, like any «no encontré»: two in a row offer a person (T5-c2).
    if (!library.length) return finish([], () => SUPPORT_HYBRID_UNKNOWN, 'UNKNOWN')
    const config = getSupportAiConfig()
    if (!config) return save(`El asistente todavía no está activado. ${SUPPORT_CONTACT}`)
    const client = dependencies.client ?? createSupportAiClient(config)
    // Entender sólo ve las páginas de su app, su equipo y su versión (lo que se sabe de la plática o de su sucursal).
    const scope: HybridScope = { app: conversation.app as HelpApp, ...(await resolveSupportDeviceContext(conversation, clock())) }
    const scoped = scopeSupportLibrary(library, scope)

    const inbound = message.inboundEventId
      ? await prisma.whatsappInboundEvent.findUnique({ where: { id: message.inboundEventId }, select: { wamid: true, rawBody: true } })
      : null
    const contextId = (inbound?.rawBody as { contextId?: unknown } | null)?.contextId
    // Only our own HELP answer in this conversation and generation can be quoted.
    const quotedMessage =
      typeof contextId === 'string'
        ? await prisma.supportMessage.findFirst({
            where: {
              outboundWamid: contextId,
              conversationId: conversation.id,
              generation: claim.generation,
              purpose: 'HELP',
              expiresAt: { gt: clock() },
            },
            select: { answer: true, sourceIds: true },
          })
        : null
    const quoted = quotedMessage && !publicHelp?.citesInternal(quotedMessage.sourceIds) ? (quotedMessage.answer ?? undefined) : undefined
    const { history, clarifiedTwice } = hybridHistory(previous, library)
    // Arriba del tope, entender ve las mejores para la plática; siempre las de las dos últimas respuestas y la citada.
    const candidates = topSupportCandidates(scoped.guides, {
      text: [message.body, ...previous.slice(0, 2).map(p => p.body), quoted ?? ''].join('\n'),
      keep: [...previous.slice(0, 2), ...(quotedMessage ? [quotedMessage] : [])].flatMap(p => guideIdsOf(p.sourceIds)),
      app: conversation.app as HelpApp,
    })

    const call = async <T extends { usage: unknown; requestId?: string }>(
      n: 1 | 2 | 3,
      run: (gated: OpenAI) => Promise<T>,
    ): Promise<{ value: T } | 'limit' | 'refused' | 'changed' | 'gone' | 'threw'> => {
      const attempt = await reserveAiAttempt(claim, config, clock(), { call: n, ...(publicHelp ? { publicHelp: true } : {}) })
      if (!attempt) return 'limit'
      let started = false,
        changed = false
      const release = () => releaseUnstartedAiAttempt(attempt.id, clock())
      // The attempt starts only when the request is about to leave: a function that sends nothing leaves it to release.
      const gated = {
        responses: {
          create: async (body: unknown, options?: unknown) => {
            started = await startAiAttempt(attempt.id, claim, clock(), {
              requestBytes: Buffer.byteLength(JSON.stringify(body)),
              verify: async tx => {
                const current = await readCurrentClaim(tx, claim, clock())
                if (!current) return false
                changed = !(await unchanged(current.conversation, tx))
                return !changed
              },
            })
            if (!started) throw new CallNotStarted()
            calls++
            if (n === 1 && inbound) void markSupportMessageReadTyping(inbound.wamid)
            return client.responses.create(body as never, options as never)
          },
        },
      } as unknown as OpenAI
      let result: T
      try {
        const current = await prisma.$transaction(tx => readCurrentClaim(tx, claim, clock()))
        if (!current || !(await unchanged(current.conversation))) {
          await release()
          return current ? 'changed' : 'gone'
        }
        result = await run(gated)
      } catch (err) {
        if (started) {
          await finishAiAttempt(attempt.id, null, undefined, clock())
          return 'threw'
        }
        await release()
        if (err instanceof CallNotStarted) return changed ? 'changed' : 'refused'
        throw err
      }
      if (started) await finishAiAttempt(attempt.id, result.usage, result.requestId, clock())
      else await release() // called: false — nothing reached the provider
      return { value: result }
    }
    // A call that did not run: null = the message is still current.
    const stop = async (outcome: 'limit' | 'refused' | 'changed' | 'gone', n: 1 | 2 | 3): Promise<Prepared | null> => {
      if (outcome === 'gone') return 'CANCELLED'
      if (outcome === 'changed') {
        await replaceWithPublicNotice(claim, clock())
        return 'CANCELLED'
      }
      if (outcome === 'limit' && n === 1)
        return (
          (publicHelp && (await publicHelp.stop())) || save(`Por ahora se alcanzó el límite de consultas del asistente. ${SUPPORT_CONTACT}`)
        )
      return notStarted()
    }

    const first = await call(1, gated =>
      understandSupportMessage(
        gated,
        {
          message: message.body,
          app: conversation.app as HelpApp,
          history,
          library: candidates,
          quoted,
          // With la B off, no catalog: the request of phase 1, byte for byte.
          data: isSupportDataEnabled() ? dataCatalogForAi(caps) : undefined,
        },
        config.pricing,
      ),
    )
    if (first === 'threw') {
      await save(SUPPORT_AI_UNCERTAIN)
      return 'UNKNOWN'
    }
    if (typeof first === 'string') return (await stop(first, 1)) ?? 'CANCELLED'
    const understood = first.value.result
    kind = understood.kind
    also = first.value.otherQuestion === true
    if (publicHelp) {
      // Capa 2: sin sentido o fuera de tema (el ataque también) cuenta; una pregunta de Avoqado empieza la cuenta otra vez. Un saludo
      // o un «no sé» (que también es una salida inválida del modelo) no cuentan ni la borran.
      if (understood.kind === 'nonsense' || understood.kind === 'off_topic')
        return await strike(hybridFixedReply(understood, false, [])!.text)
      // Only while the message is still current: a late result after AYUDA or APP never touches the count of what came after.
      if (understood.kind !== 'greeting' && understood.kind !== 'unknown')
        await prisma.$transaction(async tx => {
          if (await readCurrentClaim(tx, claim, clock())) await clearPublicStrikes(tx, conversation.receiverId, conversation.phone)
        })
    }
    if (understood.kind === 'human') {
      if (handoff) return await finishHandoff('REQUESTED', handoff)
      const summary = await buildHumanSummary(conversation.id, claim.generation, undefined, library)
      return finish([], () => summary, 'FIXED')
    }
    // La B: fresh gates, one bounded read and a fixed template. Neither the drafter nor the judge: no model writes a figure.
    if (understood.kind === 'data') {
      const fresh = await recheck()
      if (!fresh) return 'CANCELLED'
      const prepared = await prepareDataAnswer(
        { conversation: fresh.conversation, request: understood.request, message: message.body, now: clock() },
        caps,
      )
      capability = prepared.capability ?? 'none'
      dataResult = prepared.log?.result ?? 'none'
      let patch: AnswerPatch, mark: AnswerMark
      if (prepared.kind === 'answer') {
        patch = {
          status: 'ANSWER_READY',
          purpose: 'DATA',
          answer: null,
          // T-F14: the line goes after the checked figures, inside the same envelope (it carries no figure, link or email).
          answerCipher: sealDataEnvelope({ ...prepared.envelope, text: withOtherQuestion(prepared.envelope.text, also) }),
          sourceIds: [],
          accessFingerprint: prepared.accessFingerprint,
          dataCapability: prepared.capability,
        }
        mark = { outcome: 'ANSWERED' }
      } else {
        // A «no puedo» offers a person under the rule of phase 1; it is saved and delivered as is.
        const offered = !!handoff && (await offerable(fresh.conversation))
        const final = await readSupportContext(fresh.conversation, [], clock())
        patch = {
          status: 'ANSWER_READY',
          answer: withOtherQuestion(offered ? `${prepared.text}\n\n${SUPPORT_HANDOFF_OFFER}` : prepared.text, also),
          sourceIds: [],
          accessFingerprint: final.fingerprint,
          dataCapability: prepared.capability,
        }
        mark = { outcome: 'FIXED', offered }
      }
      const saved = await prisma.$transaction(tx => completeAnswer(tx, claim, fresh, patch, mark, clock(), prepared.log))
      return saved ? 'READY' : 'CANCELLED'
    }
    if (understood.kind !== 'question') {
      const fixed = hybridFixedReply(understood, clarifiedTwice, scoped.guides, history.length > 0)!
      fallback = fixed.fallback
      const outcome = fixed.text === SUPPORT_HYBRID_UNKNOWN ? 'UNKNOWN' : fixed.sourceIds[0] === '#clarify' ? 'CLARIFIED' : 'FIXED'
      return finish(fixed.guides, () => fixed.text, outcome, fixed.sourceIds)
    }

    // Una guía de un solo equipo o de ciertas versiones que no se saben: se pregunta (una vez) en vez de redactar, aunque otra
    // elegida no dependa de eso (T-F5: se quitó la respuesta parcial de T-F2/T-F3).
    const chosen = hybridDraftGuides(understood.guideIds, scoped.guides)
    const needs = hybridNeeds(chosen, scope)
    if (needs) {
      fallback = `ask-${needs.toLowerCase()}`
      return askVersionOrDevice(claim, message, needs, clock, save, { outcome: 'ASKED' })
    }
    // Todas las elegidas son de una versión más nueva que la suya: la guía literal con el aviso, sin redactar ni juez. Si alguna
    // le aplica, se redacta sólo con las que le aplican (T2-m1).
    const old = chosen.length > 0 && chosen.every(g => scoped.outdated.has(g.id)) ? chosen[0] : undefined
    if (old) {
      fallback = 'old-version'
      const notice = supportOldVersion(scoped.outdated.get(old.id)!)
      return finish(
        [old],
        (access, offer) => literalSupportAnswer([old], access, offer ? `${notice}\n\n${SUPPORT_HANDOFF_OFFER}` : notice),
        'OLD_VERSION',
      )
    }
    const guides = chosen.filter(g => !scoped.outdated.has(g.id))
    const settle = (outcome: { reply: 'literal' | 'unknown'; fallback: string }) => {
      fallback = outcome.fallback
      const next = hybridFallback(outcome, guides)
      const marked = outcome.reply === 'unknown' ? 'UNKNOWN' : outcome.fallback === 'judge-rejected' ? 'JUDGE_LITERAL' : 'LITERAL'
      // A «no encontré» after drafting cites no guide, but the drafted ones were tried (T5-c1).
      return finish(next.guides, next.compose, marked, undefined, guides)
    }
    const literal = (reason: string) => settle({ reply: 'literal', fallback: reason })
    const second = await call(2, gated => draftSupportAnswer(gated, { question: understood.standalone, guides, history }, config.pricing))
    if (second === 'threw') return literal('draft-threw')
    if (typeof second === 'string') return (await stop(second, 2)) ?? literal(`draft-${second}`)
    const { draft } = second.value
    const drafted = hybridDraftOutcome(draft, guides)
    if (drafted) return settle(drafted)
    const approved = draft as SupportDraft
    const third = await call(3, gated =>
      judgeSupportDraft(gated, { question: understood.standalone, draft: approved, guides }, config.pricing),
    )
    if (third === 'threw') return literal('judge-threw')
    if (typeof third === 'string') return (await stop(third, 3)) ?? literal(`judge-${third}`)
    // T-F13: a false claim, or a real line of a cited guide given as missing, sends the literal guide (whole up to
    // SUPPORT_LITERAL_CAP, else its card); nothing the judge says is appended to the draft. No new model call.
    const { supported, missing } = third.value
    const judged = hybridDraftOutcome(approved, guides, supported, missing)
    if (judged) return settle(judged)
    // T-F3 (Codex P3): only the guides the draft cites are shown, so only those are saved as its sources (and counted).
    const cited = guides.filter(g => [approved.intro, ...approved.steps].some(line => line?.guideId === g.id))
    return finish(
      cited,
      access => {
        const answer = hybridAnswerText(approved, cited, access)
        if (answer.fallback) fallback = answer.fallback
        return answer.text
      },
      'ANSWERED',
    )
  } finally {
    // Never the person's text: what was understood, why it fell back, how many calls started and how long it took.
    logger.info('Support hybrid answer', {
      kind,
      fallback,
      calls,
      ms: Date.now() - begun,
      capability,
      result: dataResult,
      otherQuestion: also || undefined,
    })
  }
}
