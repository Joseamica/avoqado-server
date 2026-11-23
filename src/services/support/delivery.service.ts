import cuid from 'cuid'
import { createHash, randomUUID } from 'crypto'
import type { Prisma, SupportConversation, SupportMessage } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { utcTs } from '@/utils/sqlDates'
import { stripWhatsappControls, isWhatsappWamid } from '@/utils/whatsappSanitize'
import { ForbiddenError } from '@/errors/AppError'
import {
  isSupportFreeTextEnabled,
  isSupportHybridEnabled,
  isSupportPublicHelpEnabled,
  isSupportWhatsappEnabled,
  supportPhoneNumberId,
  supportWhatsappAccessToken,
} from '@/config/supportWhatsapp'
import { sendServiceMessage, WhatsappCloudApiError } from '@/services/whatsapp.service'
import { esCorreoDemo, conNegocio } from '@/services/demo/candadoDemo'
import { runWithContext } from '@/observability/executionContext'
import { readCurrentClaim, completeClaim, type SupportClaim } from './store.service'
import { readSupportContext, isSupportWindowOpen, isSupportAccessLost } from './context.service'
import { resolveRegisteredSupportPhone } from './registeredPhone.service'
import { supportCipher, assertSupportPrincipal } from './link.service'
import { listSupportVenues } from './access.service'
import { supportSelectionSchema, resetSupportConversation } from './router.service'
import {
  holdVersionOrDevice,
  recordShownSupportAnswer,
  replaceWithPublicNotice,
  savedAsIs,
  type ShownSupportAnswer,
} from './worker.service'
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
import { composeSupportAnswer } from './answer.service'
import { clarificationText, guideIdsOf, literalSupportAnswer, savedGuidesNeed, type HybridScope } from './hybrid.service'
import { secondFailureText } from './handoff.service'
import { resolveSupportDeviceContext } from './deviceContext.service'
import type { HelpAccess } from './access.service'
import {
  SUPPORT_ASK_DEVICE,
  SUPPORT_ASK_VERSION,
  SUPPORT_HYBRID_UNKNOWN,
  SUPPORT_NO_COVERAGE,
  SUPPORT_LITERAL_CAP,
  SUPPORT_SEND_RETRY_NOTICE,
  keepOtherQuestion,
  supportTextCap,
} from './texts'
import { persistSupportOutboundRoutes } from './outboundRoutes.service'
import { checkDataDelivery, openDataEnvelope } from './data/answer.service'
import { DATA_CAPABILITIES, type DataCatalog } from './data/catalog'
import { SUPPORT_DATA_OFF, SUPPORT_DATA_STALE } from './data/texts'

const failureKey = (wamid: string, receiverId: string) =>
  `support-status:${createHash('sha256')
    .update(JSON.stringify([receiverId, wamid]))
    .digest('hex')}`

async function assertVenueSelection(conversation: SupportConversation) {
  if (conversation.pendingSelection !== 'VENUE') return
  const options = supportSelectionSchema.safeParse(conversation.selectionOptions)
  if (!options.success || !conversation.staffId || !conversation.selectionExpiresAt || conversation.selectionExpiresAt <= new Date())
    throw new ForbiddenError('La selección venció.', 'SUPPORT_ACCESS_REVOKED')
  const page = await listSupportVenues(conversation.staffId, {
    limit: 10,
    search: options.data.search,
    cursor: options.data.cursor ?? undefined,
  })
  const items = page.items.map(v => ({ value: v.id, orgId: v.organizationId, label: v.name.slice(0, 80) }))
  if (
    items.length !== options.data.items.length ||
    items.some((item, index) => {
      const saved = options.data.items[index]
      return item.value !== saved.value || item.label !== saved.label || item.orgId !== saved.orgId
    }) ||
    page.nextCursor !== options.data.nextCursor
  )
    throw new ForbiddenError('El acceso cambió.', 'SUPPORT_ACCESS_REVOKED')
}
class SupportSendCancelled extends Error {}

export async function supportVenueNotice(conversation: SupportConversation): Promise<string> {
  if (!isSupportFreeTextEnabled() || conversation.mode !== 'PERSONAL' || !conversation.staffId || !conversation.venueId) return ''
  const [all, current] = await Promise.all([
    listSupportVenues(conversation.staffId, { limit: 1 }),
    listSupportVenues(conversation.staffId, { limit: 1, venueId: conversation.venueId }),
  ])
  const name = current.items[0]?.name.slice(0, 80)
  return all.total > 1 && name ? `Viendo ${name}. Escribe SUCURSAL para cambiar.` : ''
}
const RETRY_PREFIX = `${SUPPORT_SEND_RETRY_NOTICE}\n\n`
const VENUE_LINE = /^Viendo [^\n]+\. Escribe SUCURSAL para cambiar\.\n\n/
/** A saved text keeps the venue line it was sent with (a resend copies it): drop it before adding the current one. */
const withoutVenueLine = (text: string) =>
  text.startsWith(RETRY_PREFIX) ? RETRY_PREFIX + text.slice(RETRY_PREFIX.length).replace(VENUE_LINE, '') : text.replace(VENUE_LINE, '')
/**
 * The notices go in front only while they fit in the text's cap (supportTextCap: 1,500 for a drafted answer; the literal guide,
 * longer than that, 3,500); the venue line is the first to go, and never the guide (T-F10c).
 */
function prepend(notices: string[], text: string): string {
  const kept = notices.filter(Boolean)
  while (kept.length && [...kept, text].join('\n\n').length > supportTextCap(text)) kept.shift()
  return [...kept, text].join('\n\n')
}
/** Saved for the next round: no fingerprint, so it goes out with the usual checks (and the claim is released). */
const FOR_NEXT_ROUND = { status: 'ANSWER_READY', accessFingerprint: null, claimToken: null, leaseUntil: null } as const
/** A substitution saved for the next round, through the one writer of what goes out (T-F6, H6). false = the claim was lost. */
async function saveForNextRound(
  claim: SupportClaim,
  shown: ShownSupportAnswer,
  extra: Prisma.SupportMessageUpdateManyMutationInput = {},
  before?: (tx: Prisma.TransactionClient, message: NonNullable<Awaited<ReturnType<typeof readCurrentClaim>>>) => Promise<unknown>,
): Promise<boolean> {
  return prisma.$transaction(async tx => {
    const message = await readCurrentClaim(tx, claim)
    if (!message) return false
    await before?.(tx, message)
    return recordShownSupportAnswer(tx, claim, message, shown, { ...FOR_NEXT_ROUND, ...extra }, new Date())
  })
}
type HybridMessage = Pick<SupportMessage, 'sourceIds' | 'outcome' | 'handoffOffered' | 'body'>
/**
 * T-F6 (Codex H4): EVERY hybrid delivery checks its guides against today's scope, all or nothing, as T-F5 did only for a rebuilt
 * answer: also a handoff offer, an old-version notice and a text whose hashes all match. Today's scope is the version and the
 * terminal said in the conversation or deduced NOW from the venue's devices. The deduced context stays out of the fingerprint:
 * this check covers it, and a change in the devices is no access change (the fingerprint would send the conversation back to
 * public help). null = every guide still fits; otherwise the answer saved in its place for the next round (CANCELLED now).
 */
async function hybridOutOfScope(
  claim: SupportClaim,
  message: HybridMessage,
  sources: NonNullable<ReturnType<typeof resolveSourceRefs>>,
  scope: HybridScope,
): Promise<'CANCELLED' | null> {
  // An old-version notice names, on purpose, a guide newer than the person's version.
  const need = savedGuidesNeed(message.sourceIds, sources.guides, scope, message.outcome === 'OLD_VERSION')
  // A second-failure offer only names «Lo más cercano» (title and link, no steps): it goes without it (hybridShown).
  if (!need || (message.handoffOffered && message.outcome !== 'OLD_VERSION')) return null
  // One that is gone or no longer fits: SUPPORT_NO_COVERAGE, as the verified sections do, a «no encontré» (UNKNOWN). One that
  // needs an unknown version or terminal: the question, as a new question asks it (ASKED). Neither cites a guide nor offers a
  // person (T-F5, Codex P1 and r2-3).
  await saveForNextRound(
    claim,
    need === 'GONE'
      ? { answer: SUPPORT_NO_COVERAGE, sourceIds: [], outcome: 'UNKNOWN', handoffOffered: false }
      : {
          answer: need === 'VERSION' ? SUPPORT_ASK_VERSION : SUPPORT_ASK_DEVICE,
          sourceIds: [],
          outcome: 'ASKED',
          handoffOffered: false,
          guideIds: [],
        },
    {},
    need === 'GONE' ? undefined : (tx, current) => holdVersionOrDevice(tx, current.conversationId, need, message.body, new Date()),
  )
  return 'CANCELLED'
}
/**
 * A hybrid answer or clarification that passed hybridOutOfScope: what was saved, if its guides kept their hash and the flag is
 * still on; otherwise the literal current guides, or the clarification rebuilt with the options that still fit. Nothing the
 * AI wrote goes out with the flag off, and no option is ever picked for the person. A handoff offer or an old-version notice
 * (code-written text) goes out as saved: a rebuilt guide would drop the offer or the notice (R2-02, T2-c2); an offer whose
 * nearest guide no longer fits goes without it. T-F6 (Codex H6): with the sources it shows (their current hash) and the
 * outcome of what it now is.
 */
async function hybridShown(
  sources: NonNullable<ReturnType<typeof resolveSourceRefs>>,
  message: HybridMessage,
  saved: string,
  access: HelpAccess | null,
  conversation: SupportConversation,
  scope: HybridScope,
): Promise<ShownSupportAnswer> {
  const venue = await supportVenueNotice(conversation)
  const asSaved = { answer: prepend([venue], withoutVenueLine(saved)), sourceIds: message.sourceIds }
  const retry = saved.startsWith(SUPPORT_SEND_RETRY_NOTICE) ? SUPPORT_SEND_RETRY_NOTICE : ''
  // T-F14: what is rebuilt keeps the other-question line the saved text had (the venue line is the first to go, as always).
  const tail = (text: string, cap?: number) => keepOtherQuestion(saved, text, cap)
  if (sources.clarify) {
    // An option that is gone or no longer fits is not offered; one that needs the version is (choosing it asks the version).
    const kept = sources.guides.filter(g => savedGuidesNeed([sourceRef(g)], [g], scope) !== 'GONE')
    if (isSupportHybridEnabled() && sources.same && kept.length === guideIdsOf(message.sourceIds).length) return asSaved
    const text = clarificationText(kept)
    return text === SUPPORT_HYBRID_UNKNOWN
      ? { answer: prepend([venue, retry], tail(text)), sourceIds: [], outcome: 'UNKNOWN' }
      : { answer: prepend([venue, retry], tail(text)), sourceIds: ['#clarify', ...kept.map(sourceRef)] }
  }
  if (savedAsIs(message)) {
    const offer = message.handoffOffered && message.outcome !== 'OLD_VERSION'
    if (offer && savedGuidesNeed(message.sourceIds, sources.guides, scope))
      return { answer: prepend([venue, retry], tail(secondFailureText(null))), sourceIds: [] }
    return asSaved
  }
  if (isSupportHybridEnabled() && sources.same) return asSaved
  // T-F10c: the resend notice is part of what is resent; the venue line goes in front only while the whole guide still fits, as
  // for a saved one, so the guide never shrinks to its card to make room for it.
  const text = literalSupportAnswer(sources.guides, access, retry)
  // The drafted answer did not go out: the literal guide did (or «no sé», if nothing fits).
  if (text === SUPPORT_HYBRID_UNKNOWN) return { answer: tail(text), sourceIds: [], outcome: 'UNKNOWN' }
  return {
    answer: prepend([venue], tail(text, SUPPORT_LITERAL_CAP)),
    sourceIds: sources.guides.map(sourceRef),
    ...(message.outcome === 'ANSWERED' ? { outcome: 'LITERAL' as const } : {}),
  }
}

export async function deliverSupportMessage(
  claim: SupportClaim,
  sections = loadVerifiedSections(),
  library?: LibraryGuide[],
  dataCapabilities: DataCatalog = DATA_CAPABILITIES,
): Promise<'SENT' | 'UNKNOWN' | 'EXPIRED' | 'CANCELLED'> {
  const message = await prisma.$transaction(tx => readCurrentClaim(tx, claim))
  if (!message) return 'CANCELLED'
  const conversation = message.conversation
  if (!isSupportWhatsappEnabled() || conversation.receiverId !== supportPhoneNumberId() || !supportWhatsappAccessToken()) {
    await completeClaim(claim, { status: 'CANCELLED', answerCipher: null })
    return 'CANCELLED'
  }
  if (!isSupportWindowOpen(conversation)) {
    await completeClaim(claim, { status: 'EXPIRED', answerCipher: null })
    return 'EXPIRED'
  }
  let body = message.answer ?? '',
    venueId: string | undefined,
    staffId: string | undefined,
    expectedFingerprint: string | undefined,
    // T-F6 (H6): what a HELP message shows, recorded with the text when it is sent.
    shown: ShownSupportAnswer | undefined
  const current: VerifiedSection[] = []
  if (message.purpose === 'HELP') {
    try {
      // Hybrid refs (`id@hash8`) are read with or without the flag: a message prepared with it may go out after it.
      const hybrid = resolveSourceRefs(message.sourceIds, () => library ?? loadSupportLibrary())
      // Public help keeps no memory of another conversation: a RECUPERAR prepared while this phone was of an account (it cites the
      // guide of a closed conversation) does not go out once the phone is not.
      if (
        message.body.trim().toUpperCase() === 'RECUPERAR' &&
        message.sourceIds.length > 0 &&
        conversation.mode === 'PUBLIC' &&
        isSupportPublicHelpEnabled() &&
        !(await resolveRegisteredSupportPhone(conversation.phone, prisma)).registered
      ) {
        await replaceWithPublicNotice(claim)
        return 'CANCELLED'
      }
      // Public help switched off: an answer it prepared with the model (its call was reserved as public) no longer goes out.
      if (
        !isSupportPublicHelpEnabled() &&
        isSupportFreeTextEnabled() &&
        (await prisma.supportAttempt.findFirst({
          where: {
            messageId: message.id,
            kind: 'AI',
            usage: { path: ['reservation', 'publicDayKey'], string_starts_with: 'AI:PUBLIC_DAY:' },
          },
          select: { id: true },
        }))
      ) {
        await completeClaim(claim, { status: 'CANCELLED', answerCipher: null })
        return 'CANCELLED'
      }
      if (hybrid) current.push(...hybrid.guides)
      else
        for (const sectionId of message.sourceIds.slice(0, 3)) {
          const result = await searchVerifiedHelp(
            {
              app: conversation.app as HelpApp,
              topic: '',
              sectionId,
              appVersion: conversation.appVersion ?? undefined,
              deviceFamily: conversation.deviceFamily as 'PAX' | 'NEXGO' | undefined,
            },
            null,
            sections,
          )
          if (result.kind !== 'ANSWER' || message.sourceIds.length > 3) {
            await saveForNextRound(claim, { answer: SUPPORT_NO_COVERAGE, sourceIds: [], outcome: 'UNKNOWN', handoffOffered: false })
            return 'CANCELLED'
          }
          current.push(...result.sections)
        }
      const fresh = await readSupportContext(conversation, current)
      expectedFingerprint = fresh.fingerprint
      venueId = fresh.context?.venueId
      staffId = fresh.context?.staffId
      if (message.accessFingerprint && fresh.fingerprint !== message.accessFingerprint) {
        await replaceWithPublicNotice(claim)
        return 'CANCELLED'
      }
      await assertVenueSelection(conversation)
      if (hybrid) {
        const scope = { app: conversation.app as HelpApp, ...(await resolveSupportDeviceContext(conversation, new Date())) }
        if (!hybrid.clarify && (await hybridOutOfScope(claim, message, hybrid, scope))) return 'CANCELLED'
        shown = await hybridShown(hybrid, message, body, fresh.access, conversation, scope)
      } else if (current.length) {
        // T-F10c: as the hybrid rebuild, the venue line goes in front only while the whole guide still fits.
        const text = composeSupportAnswer(
          current,
          fresh.access,
          body.startsWith(SUPPORT_SEND_RETRY_NOTICE) ? SUPPORT_SEND_RETRY_NOTICE : '',
        )
        const answer = text === SUPPORT_NO_COVERAGE ? text : prepend([await supportVenueNotice(conversation)], text)
        shown = { answer, sourceIds: message.sourceIds }
      }
      if (shown) body = shown.answer
    } catch (err) {
      if (!isSupportAccessLost(err)) throw err
      await replaceWithPublicNotice(claim)
      return 'CANCELLED'
    }
  }
  // La B, first checkpoint: the sealed text goes out only if the access and the validity it was prepared with still hold.
  // Only this checkpoint writes a text instead («vuelve a preguntar», «todavía no consulto…»); the second one only cancels.
  const envelope = message.purpose === 'DATA' ? openDataEnvelope(message.answerCipher) : null
  if (message.purpose === 'DATA') {
    const verdict = await checkDataDelivery(conversation, message.accessFingerprint, envelope, new Date(), dataCapabilities)
    // Without a venue of its own (PUBLIC, or still choosing it) no verdict is for a linked person: the public notice.
    const personal = conversation.mode === 'PERSONAL' && !!conversation.orgId && !!conversation.venueId
    if (verdict === 'ACCESS' || verdict === 'GONE' || (verdict !== 'OK' && !personal)) {
      await replaceWithPublicNotice(claim)
      return 'CANCELLED'
    }
    if (verdict !== 'OK') {
      // As saved, with no offer: delivered next time as a fixed HELP text, and the conversation stays personal. It is no longer
      // an answered data question: no capability, and the outcome of a fixed text (a «no puedo» of la B is FIXED too), with
      // its correcting event (T-F6, H6).
      await saveForNextRound(
        claim,
        { answer: verdict === 'OFF' ? SUPPORT_DATA_OFF : SUPPORT_DATA_STALE, sourceIds: [], outcome: 'FIXED' },
        { purpose: 'HELP', answerCipher: null, dataCapability: null, outcome: 'FIXED' },
      )
      return 'CANCELLED'
    }
    body = envelope?.text ?? ''
    staffId = conversation.staffId ?? undefined
    venueId = conversation.venueId ?? undefined
  }
  const attemptId = cuid()
  const started = await prisma.$transaction(async tx => {
    const fresh = await readCurrentClaim(tx, claim)
    if (!fresh) return 'CANCELLED' as const
    if (!isSupportWhatsappEnabled() || fresh.conversation.receiverId !== supportPhoneNumberId()) {
      await tx.supportMessage.update({
        where: { id: fresh.id },
        data: { status: 'CANCELLED', answerCipher: null, claimToken: null, leaseUntil: null },
      })
      return 'CANCELLED' as const
    }
    if (!isSupportWindowOpen(fresh.conversation)) {
      await tx.supportMessage.update({
        where: { id: fresh.id },
        data: { status: 'EXPIRED', answerCipher: null, claimToken: null, leaseUntil: null },
      })
      return 'EXPIRED' as const
    }
    if (fresh.purpose === 'LINK_CODE') {
      const challenge = fresh.challengeId ? await tx.supportLinkChallenge.findUnique({ where: { id: fresh.challengeId } }) : null
      if (
        !challenge ||
        challenge.conversationId !== fresh.conversationId ||
        challenge.phone !== fresh.conversation.phone ||
        challenge.consumedAt ||
        challenge.invalidatedAt ||
        challenge.expiresAt <= new Date() ||
        !fresh.conversation.noticeAcceptedAt ||
        !fresh.answerCipher
      ) {
        await tx.supportMessage.update({
          where: { id: fresh.id },
          data: { status: 'EXPIRED', answerCipher: null, claimToken: null, leaseUntil: null },
        })
        return 'EXPIRED' as const
      }
      try {
        await assertSupportPrincipal(challenge.staffId, challenge.createdAt, tx)
      } catch (err) {
        if (!(err instanceof ForbiddenError)) throw err
        await tx.supportMessage.update({
          where: { id: fresh.id },
          data: { status: 'CANCELLED', answerCipher: null, claimToken: null, leaseUntil: null },
        })
        return 'CANCELLED' as const
      }
      const principal = await tx.staff.findUnique({ where: { id: challenge.staffId }, select: { email: true } })
      if (!principal || esCorreoDemo(principal.email)) {
        await tx.supportMessage.update({
          where: { id: fresh.id },
          data: { status: 'CANCELLED', answerCipher: null, claimToken: null, leaseUntil: null },
        })
        return 'CANCELLED' as const
      }
      const code = supportCipher.decryptFromBase64(fresh.answerCipher)
      if (!/^\d{6}$/.test(code)) throw new Error('SUPPORT_CODE_INVALID')
      body = `Tu código para vincular tu WhatsApp personal con Avoqado es ${code}. Vence en 10 minutos. No lo compartas; escríbelo sólo en el panel de Avoqado.`
      staffId = challenge.staffId
    }
    body = stripWhatsappControls(body)
    // T-F10c: a HELP text within the drafted cap (1,500) or, longer, the literal guide up to SUPPORT_LITERAL_CAP (3,500:
    // supportTextCap); the drafted cap is held where drafted answers are composed. DATA and LINK_CODE, 1,500 as always.
    if (!body.trim() || body.length > (fresh.purpose === 'HELP' ? supportTextCap(body) : 1500)) {
      await tx.supportMessage.update({
        where: { id: fresh.id },
        data: { status: 'FAILED', answerCipher: null, claimToken: null, leaseUntil: null },
      })
      return 'CANCELLED' as const
    }
    // T-F6 (Codex H6): the text that goes out, with the sources it shows (the current hash of a rebuilt guide) and the outcome of
    // what it now is, through the one writer of substitutions (a correcting event if that outcome changed).
    if (
      fresh.purpose === 'HELP' &&
      !(await recordShownSupportAnswer(
        tx,
        claim,
        fresh,
        { ...(shown ?? { sourceIds: fresh.sourceIds }), answer: body },
        { accessFingerprint: expectedFingerprint },
        new Date(),
      ))
    )
      return 'CANCELLED' as const
    const at = new Date()
    const count = await tx.$executeRaw`
      INSERT INTO "SupportAttempt" (id, "messageId", kind, ordinal, "claimToken", state, "reservedUsd", "pricingVersion", "startedAt")
      SELECT ${attemptId}, m.id, 'SEND', 1, ${claim.claimToken}, 'STARTED', 0, 'whatsapp-service-v1', t.at
      FROM "SupportMessage" m JOIN "SupportConversation" c ON c.id = m."conversationId"
      CROSS JOIN (SELECT GREATEST(${utcTs(at)}, clock_timestamp() AT TIME ZONE 'UTC') AS at) t
      LEFT JOIN "SupportLinkChallenge" ch ON ch.id = m."challengeId" LEFT JOIN "Staff" s ON s.id = ch."staffId"
      WHERE m.id = ${claim.messageId} AND m.status = 'CLAIMED' AND m."claimToken" = ${claim.claimToken}
        AND m.generation = ${claim.generation} AND c.generation = m.generation AND c.mode <> 'CLOSED'
        AND m."leaseUntil" > t.at AND m."expiresAt" > t.at
        AND c."lastUserMessageAt" <= t.at AND c."lastUserMessageAt" > t.at - INTERVAL '24 hours'
        AND c."lastActivityAt" <= t.at AND c."lastActivityAt" > t.at - INTERVAL '30 minutes'
        AND (m.purpose IN ('HELP', 'DATA') OR (c."noticeAcceptedAt" IS NOT NULL AND ch."consumedAt" IS NULL AND ch."invalidatedAt" IS NULL
          AND ch."expiresAt" > t.at AND s.active = TRUE AND ch."createdAt" > COALESCE(s."lastPasswordReset", '-infinity'::timestamp)
          AND ch."createdAt" > COALESCE(s."sessionsRevokedAt", '-infinity'::timestamp)))
      ON CONFLICT ("messageId", kind, ordinal) DO NOTHING`
    return count === 1 ? ('STARTED' as const) : ('UNKNOWN' as const)
  })
  if (started !== 'STARTED') return started
  let outbound: { messageId: string }
  let readyForPost = false,
    cancelled = false,
    accessChanged = false
  let disposition: 'CANCELLED' | 'EXPIRED' = 'CANCELLED'
  const beforeSend = async () => {
    let codeExpiresAt: Date | undefined
    try {
      const fresh = await prisma.$transaction(tx => readCurrentClaim(tx, claim))
      if (!fresh || !isSupportWhatsappEnabled() || fresh.conversation.receiverId !== supportPhoneNumberId())
        throw new SupportSendCancelled()
      if (fresh.purpose === 'HELP') {
        const access = await readSupportContext(fresh.conversation, current)
        if (access.fingerprint !== expectedFingerprint) throw new ForbiddenError('El acceso cambió.', 'SUPPORT_ACCESS_REVOKED')
        await assertVenueSelection(fresh.conversation)
      } else if (fresh.purpose === 'DATA') {
        const verdict = await checkDataDelivery(fresh.conversation, message.accessFingerprint, envelope, new Date(), dataCapabilities)
        // Only a link or a venue that no longer exists returns the conversation to public help; any other change (a permission,
        // the role, the plan, the validity, the switch) cancels in silence and the conversation stays personal (T-B10, T-B19).
        if (verdict === 'GONE') throw new ForbiddenError('El acceso cambió.', 'SUPPORT_ACCESS_REVOKED')
        if (verdict !== 'OK') throw new SupportSendCancelled()
      } else {
        const challenge = fresh.challengeId ? await prisma.supportLinkChallenge.findUnique({ where: { id: fresh.challengeId } }) : null
        if (
          !challenge ||
          challenge.conversationId !== fresh.conversationId ||
          challenge.phone !== fresh.conversation.phone ||
          challenge.consumedAt ||
          challenge.invalidatedAt ||
          challenge.expiresAt <= new Date() ||
          !fresh.answerCipher ||
          !fresh.conversation.noticeAcceptedAt
        )
          throw new SupportSendCancelled()
        await assertSupportPrincipal(challenge.staffId, challenge.createdAt)
        const principal = await prisma.staff.findUnique({ where: { id: challenge.staffId }, select: { email: true } })
        if (!principal || esCorreoDemo(principal.email)) throw new SupportSendCancelled()
        codeExpiresAt = challenge.expiresAt
      }
      const latest = await prisma.$transaction(tx => readCurrentClaim(tx, claim))
      const at = new Date()
      if (
        !latest ||
        !latest.leaseUntil ||
        latest.leaseUntil <= at ||
        latest.expiresAt <= at ||
        !isSupportWhatsappEnabled() ||
        latest.conversation.receiverId !== supportPhoneNumberId()
      )
        throw new SupportSendCancelled()
      if (!isSupportWindowOpen(latest.conversation, at)) {
        disposition = 'EXPIRED'
        throw new SupportSendCancelled()
      }
      if (
        (codeExpiresAt && codeExpiresAt <= at) ||
        (latest.conversation.pendingSelection === 'VENUE' &&
          (!latest.conversation.selectionExpiresAt || latest.conversation.selectionExpiresAt <= at))
      )
        throw new SupportSendCancelled()
      readyForPost = true
    } catch (err) {
      const lost = isSupportAccessLost(err)
      if (!lost && !(err instanceof SupportSendCancelled)) throw err
      accessChanged = lost
      cancelled = true
      throw new SupportSendCancelled()
    }
  }
  try {
    outbound = await runWithContext(
      { correlationId: randomUUID(), source: 'job', entrypoint: 'support-whatsapp.send', userId: staffId },
      () =>
        conNegocio(venueId, () => sendServiceMessage(conversation.phone, body, { timeoutMs: 20000, safeSupportLogs: true, beforeSend })),
    )
  } catch (err) {
    const definitive =
      !readyForPost ||
      (err instanceof WhatsappCloudApiError &&
        !!err.httpStatus &&
        err.httpStatus >= 400 &&
        err.httpStatus < 500 &&
        ![408, 429].includes(err.httpStatus))
    await prisma.$transaction(async tx => {
      await tx.supportAttempt.updateMany({
        where: { id: attemptId, state: 'STARTED' },
        data: { state: definitive ? 'DEFINITIVE_FAILURE' : 'UNKNOWN', finishedAt: new Date() },
      })
      await tx.supportMessage.updateMany({
        where: { id: claim.messageId, status: 'CLAIMED', generation: claim.generation, claimToken: claim.claimToken },
        data: {
          status: cancelled ? disposition : definitive ? 'FAILED' : 'SEND_UNKNOWN',
          answerCipher: null,
          claimToken: null,
          leaseUntil: null,
        },
      })
      if (accessChanged) {
        const currentConversation = await tx.supportConversation.findUnique({ where: { id: claim.conversationId } })
        if (currentConversation?.generation === claim.generation && currentConversation.mode !== 'CLOSED')
          await resetSupportConversation(tx, currentConversation)
      }
    })
    return cancelled ? disposition : 'UNKNOWN'
  }
  // A DATA answer keeps its cipher once sent (the retention writers erase it); HELP and LINK_CODE lose it as today.
  const sentCipher = message.purpose === 'DATA' ? {} : { answerCipher: null }
  try {
    const failed = await prisma.$transaction(async tx => {
      const key = failureKey(outbound.messageId, conversation.receiverId)
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
      await persistSupportOutboundRoutes(
        [{ receiverId: conversation.receiverId, wamid: outbound.messageId, createdAt: message.createdAt }],
        tx,
      )
      const receipt = await tx.whatsappInboundEvent.findUnique({ where: { wamid: key }, select: { id: true } })
      await tx.$queryRaw`SELECT id FROM "SupportMessage" WHERE id = ${claim.messageId} FOR UPDATE`
      await tx.supportAttempt.updateMany({
        where: { id: attemptId, state: { in: ['STARTED', 'UNKNOWN'] } },
        data: { state: receipt ? 'DEFINITIVE_FAILURE' : 'SUCCEEDED', requestId: outbound.messageId, finishedAt: new Date() },
      })
      await tx.supportMessage.updateMany({
        where: { id: claim.messageId, generation: claim.generation, status: 'CLAIMED', claimToken: claim.claimToken },
        data: {
          status: receipt ? 'FAILED' : 'SENT',
          outboundWamid: outbound.messageId,
          claimToken: null,
          leaseUntil: null,
          ...sentCipher,
        },
      })
      await tx.supportMessage.updateMany({
        where: { id: claim.messageId, generation: claim.generation, status: 'SEND_UNKNOWN' },
        data: {
          status: receipt ? 'FAILED' : 'SENT',
          outboundWamid: outbound.messageId,
          ...sentCipher,
          claimToken: null,
          leaseUntil: null,
        },
      })
      await tx.supportMessage.updateMany({
        where: {
          id: claim.messageId,
          generation: claim.generation,
          outboundWamid: null,
          status: { notIn: ['QUEUED', 'CLAIMED', 'ANSWER_READY'] },
        },
        data: { outboundWamid: outbound.messageId, ...sentCipher },
      })
      return !!receipt
    })
    return failed ? 'CANCELLED' : 'SENT'
  } catch {
    logger.error('Support delivery commit unconfirmed', { messageId: claim.messageId, attemptId, code: 'SUPPORT_DELIVERY_COMMIT_FAILED' })
    return 'UNKNOWN'
  }
}

export async function recordSupportDeliveryFailure(wamid: string, receiverId: string): Promise<boolean> {
  // T-F14: only a status of the support's own number (supportPhoneNumberId is never the central nor sales).
  if (!isWhatsappWamid(wamid) || !receiverId || receiverId !== supportPhoneNumberId()) return false
  return prisma.$transaction(async tx => {
    const key = failureKey(wamid, receiverId)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
    const message = await tx.supportMessage.findFirst({
      where: { outboundWamid: wamid, conversation: { receiverId } },
      select: { id: true },
    })
    if (
      !message &&
      !isSupportWhatsappEnabled() &&
      !(await tx.supportAttempt.findFirst({
        where: { kind: 'SEND', state: { in: ['STARTED', 'UNKNOWN'] }, message: { conversation: { receiverId } } },
        select: { id: true },
      }))
    )
      return false
    // A callback can beat the POST acknowledgement; keep only its opaque receipt, never a message body.
    await tx.whatsappInboundEvent.upsert({
      where: { wamid: key },
      update: {},
      create: {
        wamid: key,
        receiverId,
        fromPhone: '',
        messageType: 'support_delivery_failed',
        rawBody: {},
        routedAs: 'SUPPORT_IGNORED',
        processedAt: new Date(),
        supportTombstoneUntil: new Date(Date.now() + 90 * 86400000),
      },
    })
    if (!message) return false
    await tx.$queryRaw`SELECT id FROM "SupportMessage" WHERE id = ${message.id} FOR UPDATE`
    await tx.supportAttempt.updateMany({
      where: { messageId: message.id, kind: 'SEND', requestId: wamid },
      data: { state: 'DEFINITIVE_FAILURE', finishedAt: new Date() },
    })
    await tx.supportMessage.updateMany({ where: { id: message.id, status: 'SENT' }, data: { status: 'FAILED' } })
    return true
  })
}
