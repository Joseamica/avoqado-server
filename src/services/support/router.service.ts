import crypto from 'crypto'
import { Prisma, type SupportConversation, type SupportOutcome } from '@prisma/client'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import { scrubSupportText } from './privacy'
export { scrubSupportText } from './privacy'
import { ForbiddenError, ServiceUnavailableError } from '@/errors/AppError'
import { admitSupportMessage, type SupportInput } from './store.service'
import { supportEnabled, usableLink } from './link.service'
import { listSupportVenues } from './access.service'
import { buildHumanSummary } from './humanSummary.service'
import { resolveRegisteredSupportPhone } from './registeredPhone.service'
import {
  getSupportHandoffConfig,
  isSupportFreeTextEnabled,
  isSupportHybridEnabled,
  isSupportPublicHelpEnabled,
  supportPhoneNumberId,
} from '@/config/supportWhatsapp'
import { recordSupportEvent, requestSupportHandoff } from './handoff.service'
import { normalizeAppVersion } from './deviceContext.service'
import {
  countPublicMessage,
  forgetPublicConversation,
  isPublicConversation,
  isPublicPaused,
  markPublicConversation,
  mexicoDay,
  takePublicLimitNotice,
} from './publicHelp.service'
import {
  SUPPORT_ASK_APP,
  SUPPORT_CONTACT,
  SUPPORT_GREETING,
  SUPPORT_LINK,
  SUPPORT_NOTICE_TEXTS,
  SUPPORT_PUBLIC_DAY_LIMIT,
  SUPPORT_PUBLIC_HOUR_LIMIT,
  SUPPORT_PUBLIC_NOTICE_TEXTS,
  SUPPORT_SENSITIVE,
  SUPPORT_UNREGISTERED,
  supportNotice,
  supportPublicNotice,
} from './texts'

const appItems = [
  { value: 'dashboard', label: 'Dashboard web' },
  { value: 'android', label: 'POS Android' },
  { value: 'windows', label: 'POS Windows' },
  { value: 'tpv', label: 'Terminal PAX/Nexgo' },
]
export const supportSelectionSchema = z.object({
  items: z.array(z.object({ value: z.string().max(100), label: z.string().max(80), orgId: z.string().cuid().optional() })).max(10),
  nextCursor: z.string().cuid().nullable().optional(),
  cursor: z.string().cuid().nullable().optional(),
  search: z.string().max(200).optional(),
  topic: z.string().max(2000).optional(),
})

export function supportInboundClock(timestamp: string, receivedAt: Date, previous: Date | null): Date | null {
  const at = Number(timestamp) * 1000
  if (!Number.isFinite(at) || at <= 0 || at > receivedAt.getTime() + 300_000) return previous
  return new Date(Math.max(previous?.getTime() ?? 0, Math.min(at, receivedAt.getTime())))
}
export async function changeSupportGeneration(
  tx: Prisma.TransactionClient,
  conversation: SupportConversation,
  patch: Prisma.SupportConversationUncheckedUpdateInput = {},
) {
  await tx.supportMessage.updateMany({
    where: { conversationId: conversation.id, status: { notIn: ['SENT', 'FAILED', 'EXPIRED', 'CANCELLED'] } },
    data: { status: 'CANCELLED', claimToken: null, leaseUntil: null },
  })
  await tx.supportMessage.updateMany({
    where: { conversationId: conversation.id },
    data: {
      body: '',
      answer: null,
      answerCipher: null,
      accessFingerprint: null,
      sourceIds: [],
    },
  })
  return tx.supportConversation.update({ where: { id: conversation.id }, data: { ...patch, generation: { increment: 1 } } })
}
export function resetSupportConversation(
  tx: Prisma.TransactionClient,
  conversation: SupportConversation,
  mode: 'PUBLIC' | 'CLOSED' = 'PUBLIC',
) {
  return changeSupportGeneration(tx, conversation, {
    mode,
    staffId: null,
    orgId: null,
    venueId: null,
    linkId: null,
    app: null,
    appVersion: null,
    deviceFamily: null,
    pendingSelection: null,
    selectionOptions: Prisma.DbNull,
    selectionExpiresAt: null,
    noticeAcceptedAt: null,
  })
}

// The pending question, only while its selection is still valid.
export function liveTopic(conversation: SupportConversation, now: Date): string | undefined {
  const parsed = supportSelectionSchema.safeParse(conversation.selectionOptions)
  return parsed.success && conversation.selectionExpiresAt && conversation.selectionExpiresAt > now ? parsed.data.topic : undefined
}

// Only the latest closed conversation counts: one emptied by SALIR or AYUDA leaves nothing to inherit.
export async function inheritSupportMemory(tx: Prisma.TransactionClient, receiverId: string, phone: string, now: Date) {
  const last = await tx.supportConversation.findFirst({
    where: { receiverId, phone, mode: 'CLOSED' },
    orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }],
    select: { noticeAcceptedAt: true, app: true, staffId: true, linkId: true, orgId: true, venueId: true },
  })
  const notice = last?.noticeAcceptedAt
  return {
    noticeAcceptedAt: notice && notice.getTime() > now.getTime() - 30 * 86400_000 ? notice : null,
    app: last?.app ?? null,
    staffId: last?.staffId ?? null,
    linkId: last?.linkId ?? null,
    orgId: last?.orgId ?? null,
    venueId: last?.venueId ?? null,
  }
}

export async function closeIdleSupport(tx: Prisma.TransactionClient, conversation: SupportConversation) {
  await tx.supportMessage.updateMany({
    where: { conversationId: conversation.id, status: { in: ['QUEUED', 'CLAIMED', 'ANSWER_READY'] } },
    data: { status: 'EXPIRED', claimToken: null, leaseUntil: null, answerCipher: null },
  })
  // La B: a data answer of a closed conversation is never sent nor repeated again, so its cipher goes now (the command that
  // follows acts on a new conversation and never reaches these rows). Index SupportMessage @@unique([conversationId, sequence]).
  await tx.supportMessage.updateMany({
    where: { conversationId: conversation.id, purpose: 'DATA', answerCipher: { not: null } },
    data: { answerCipher: null },
  })
  // Keep saved public-guide references for explicit recovery; unlink still finds the closed staff history.
  return tx.supportConversation.update({
    where: { id: conversation.id },
    data: {
      mode: 'CLOSED',
      generation: { increment: 1 },
      pendingSelection: null,
      selectionOptions: Prisma.DbNull,
      selectionExpiresAt: null,
      // With free text the accepted notice is remembered for the next conversation (inheritSupportMemory).
      ...(isSupportFreeTextEnabled() ? {} : { noticeAcceptedAt: null }),
    },
  })
}

// With free text, a personal context also needs the phone's only current account to own the link.
async function ownLink(tx: Prisma.TransactionClient, phone: string, soleStaffId?: string | null) {
  const link = await usableLink(tx, phone)
  if (!link || !isSupportFreeTextEnabled()) return link
  const sole = soleStaffId === undefined ? (await resolveRegisteredSupportPhone(phone, tx)).soleStaffId : soleStaffId
  return sole === link.staffId ? link : null
}

// A null answer means the venue is set and the pending question can be processed now.
async function afterVenue(
  tx: Prisma.TransactionClient,
  conversation: SupportConversation,
  now: Date,
  topic?: string,
): Promise<{ conversation: SupportConversation; answer: string | null }> {
  if (conversation.app)
    return { conversation, answer: topic ? null : 'Ya puedes preguntar. Antes de cada respuesta comprobaré tu acceso actual.' }
  const updated = await tx.supportConversation.update({
    where: { id: conversation.id },
    data: {
      pendingSelection: 'APP',
      selectionOptions: { items: appItems, ...(topic ? { topic } : {}) },
      selectionExpiresAt: new Date(now.getTime() + 600000),
    },
  })
  return { conversation: updated, answer: SUPPORT_ASK_APP }
}

async function selectVenue(
  tx: Prisma.TransactionClient,
  conversation: SupportConversation,
  now: Date,
  search = '',
  cursor?: string,
  topic?: string,
): Promise<{ conversation: SupportConversation; answer: string | null }> {
  const link = await ownLink(tx, conversation.phone)
  if (!link) return { conversation, answer: `Seguimos con ayuda pública. ${SUPPORT_LINK}` }
  const page = await listSupportVenues(link.staffId, { limit: 10, search, cursor }, tx)
  if (!page.items.length) return { conversation, answer: `No encontré sucursales disponibles para tu cuenta. ${SUPPORT_CONTACT}` }
  if (isSupportFreeTextEnabled() && !search && !cursor && page.total === 1) {
    const updated = await tx.supportConversation.update({
      where: { id: conversation.id },
      data: {
        staffId: link.staffId,
        linkId: link.id,
        mode: 'PERSONAL',
        orgId: page.items[0].organizationId,
        venueId: page.items[0].id,
        pendingSelection: null,
        selectionOptions: Prisma.DbNull,
        selectionExpiresAt: null,
      },
    })
    return afterVenue(tx, updated, now, topic)
  }
  const items = page.items.map(v => ({ value: v.id, orgId: v.organizationId, label: v.name.slice(0, 80) }))
  const updated = await tx.supportConversation.update({
    where: { id: conversation.id },
    data: {
      staffId: link.staffId,
      linkId: link.id,
      mode: 'PERSONAL',
      orgId: null,
      venueId: null,
      pendingSelection: 'VENUE',
      selectionOptions: { items, nextCursor: page.nextCursor, cursor: cursor ?? null, search, ...(topic ? { topic } : {}) },
      selectionExpiresAt: new Date(now.getTime() + 600_000),
    },
  })
  return {
    conversation: updated,
    answer: `Elige sucursal de las ${page.total} disponibles:\n${items.map((v, i) => `${i + 1}. ${v.label}`).join('\n')}\n${page.nextCursor ? 'Escribe SIGUIENTE para ver más. ' : ''}Puedes buscar con SUCURSAL y su nombre.`,
  }
}

const phoneHash = (phone: string) => crypto.createHash('sha256').update(phone).digest('hex')
export const isSupportNoticeAcceptance = (command: string) => ['CONTINUAR', 'SÍ', 'SI', 'ACEPTO', 'OK'].includes(command)
// CONTINUAR keeps re-accepting as today; the short words only answer a notice still pending.
const acceptsNotice = (command: string, conversation: SupportConversation) =>
  command === 'CONTINUAR' || (isSupportNoticeAcceptance(command) && !conversation.noticeAcceptedAt)
// «ok» or «sí» only counts as consent when this generation actually showed the privacy notice.
const noticeShown = async (tx: Prisma.TransactionClient, conversation: SupportConversation) =>
  !!(await tx.supportMessage.findFirst({
    where: {
      conversationId: conversation.id,
      generation: conversation.generation,
      answer: { in: [...SUPPORT_NOTICE_TEXTS, ...SUPPORT_PUBLIC_NOTICE_TEXTS] },
      status: { in: ['SENT', 'SEND_UNKNOWN'] },
    },
    select: { id: true },
  }))
// A person's non-text message gets the fixed text-only reply, with the usual caps: media, a shared contact, and «unsupported» (what
// WhatsApp sends for a poll, a view-once message…) (T-F15b). Ignored on purpose: reaction, system, button, interactive, order,
// request_welcome and any other type.
const answeredMedia = ['image', 'audio', 'video', 'sticker', 'document', 'location', 'contacts', 'unsupported']
const ignoredType = (type: string) => type !== 'text' && !answeredMedia.includes(type)
async function overMinuteCap(tx: Prisma.TransactionClient, input: SupportInput, now: Date) {
  const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000)
  const key = `CONTROL:${input.receiverId}:${phoneHash(input.phone)}:${minute.toISOString()}`
  const rate = await tx.supportBudget.upsert({
    where: { key },
    create: { key, windowStart: minute, callCount: 1 },
    update: { callCount: { increment: 1 } },
  })
  return rate.callCount > 10
}
// True only for the first fixed «not registered» message of this phone on this day (router and worker share it). The day is
// UTC, or CDMX with public help on: the same day as its caps and its US$, so the fixed message never comes twice in one day.
export async function takeDailyStaticReply(tx: Prisma.TransactionClient, receiverId: string, phone: string, now: Date) {
  const day = isSupportPublicHelpEnabled() ? mexicoDay(now) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const key = `CONTROL:${receiverId}:${phoneHash(phone)}:STATIC:${day.toISOString()}`
  const sent = await tx.supportBudget.upsert({
    where: { key },
    create: { key, windowStart: day, callCount: 1 },
    update: { callCount: { increment: 1 } },
  })
  return sent.callCount === 1
}
// Lowercase words without accents or punctuation, for matching what a person typed.
const words = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9ñ]+/)
    .filter(Boolean)
export const isGreeting = (body: string) =>
  /^(hola|ola|hey|hi|hello|saludos|buenas|buen dia|buenos dias|buenas tardes|buenas noches|que tal)( (que tal|buenas|buen dia|buenos dias|buenas tardes|buenas noches))?$/.test(
    words(body).join(' '),
  )
// What may go around the version when a person answers the version question («uso la 2.25.7», «tengo la 2.25.7», «2.19.0
// (130)»). Any other word («no tengo la 2.25.7», «¿necesito instalar la 2.25.7?») means the message is not that reply (T-F5).
// T-F6 (Codex H5): no question word: «que» (qué) made «qué es la versión 2.25.7» pure filler. «creo que es la 2.25.7» goes with it.
const REPLY_FILLER = new Set(
  'la el lo los mi es son una un uso usamos tengo tenemos traigo estoy estamos en de del version app aplicacion terminal v creo dice me sale aparece ya si ok va pues gracias escritorio'.split(
    ' ',
  ),
)
const withoutFiller = (text: string) => words(text).filter(w => !REPLY_FILLER.has(w) && !/^\d+$/.test(w))
/**
 * With the hybrid, the version that answers the pending version question: the bare version of what was written («2.19.0
 * (130)» → 2.19.0), only if the message is that reply and nothing else (T-F5, Codex r2-1). T-F6 (Codex H5): a message with «?»
 * or «¿» is a question, never the reply («¿Qué es la versión 2.25.7?», «¿Ya tengo la 2.25.7?»).
 */
export function hybridVersionReply(body: string): string | null {
  if (/[?¿]/.test(body)) return null
  const said = normalizeAppVersion(body)
  return said && !withoutFiller(body.replace(said, ' ')).length ? said : null
}
// A router word, a menu number or a greeting is not a question worth keeping for later.
const questionOf = (body: string) =>
  /^(APP|SIGUIENTE|SUCURSAL(\s.*)?|CONTINUAR|SÍ|SI|ACEPTO|OK|\d{1,2})$/.test(body.trim().toUpperCase()) ||
  (isSupportFreeTextEnabled() && isGreeting(body))
    ? ''
    : body

function editDistance(a: string, b: string) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = row
  }
  return prev[b.length]
}
// One typo per short word, two for long ones; very short words must be exact.
const sameWord = (a: string, b: string) =>
  a === b ||
  (Math.min(a.length, b.length) >= 4 &&
    Math.abs(a.length - b.length) <= 2 &&
    editDistance(a, b) <= (Math.max(a.length, b.length) >= 7 ? 2 : 1))
const optionWords = (text: string) => {
  const all = words(text)
  // «suursal» is still the word sucursal, not a name.
  const kept = all.filter(w => !['sucursal', 'app', 'la', 'el', 'de', 'en', 'mi'].some(s => sameWord(w, s)))
  return kept.length ? kept : all
}
// The option named by the text («norte», «la nrte», «pos android»). Every typed word must belong to the option, so
// «Centro Sur» names nothing. Tiers: the exact name, then part of a name, then with typos; the first tier with a match
// decides, and two matches there name nothing.
function optionByName<T extends { label: string }>(items: T[], text: string): T | undefined {
  const typed = optionWords(text)
  if (!typed.length || typed.length > 6) return undefined
  const labels = items.map(item => ({ item, words: optionWords(item.label) }))
  const tiers = [
    (l: string[]) => l.length === typed.length && typed.every(w => l.includes(w)),
    (l: string[]) => typed.every(w => l.includes(w)),
    (l: string[]) => typed.every(w => l.some(v => sameWord(w, v))),
  ]
  for (const fits of tiers) {
    const found = labels.filter(l => fits(l.words))
    if (found.length) return found.length === 1 ? found[0].item : undefined
  }
  return undefined
}

export async function decideSupportAdmission(
  input: SupportInput,
  conversation: SupportConversation | null,
  command: string,
  tx: Prisma.TransactionClient,
  now = new Date(),
): Promise<{
  route: 'SUPPORT' | 'STATIC' | 'IGNORED'
  registered: boolean
  soleStaffId?: string | null
  /** Ayuda pública: un número sin cuenta que sigue en el modo público (con sus topes). */
  publicHelp?: boolean
  /** STATIC: el texto, si no es SUPPORT_UNREGISTERED (el aviso de un tope de la ayuda pública). */
  text?: string
}> {
  // T-F15: on the support's own number nothing is left to the old relay. A person who also answers customer chats is one more
  // person, and a message without text and without a conversation takes the normal way (media answer, or the day's fixed message).
  if (!conversation) {
    // A reaction or another type the router never answers opens nothing (and spends no fixed message).
    if (ignoredType(input.type)) return { route: 'IGNORED', registered: false }
    if (command === 'SALIR') {
      const last = await tx.supportConversation.findFirst({
        where: { receiverId: input.receiverId, phone: input.phone, mode: 'CLOSED' },
        orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }],
      })
      if (last) await resetSupportConversation(tx, last, 'CLOSED')
      return { route: 'IGNORED', registered: false }
    }
  }
  // SALIR must always close, so it never counts toward or waits on the cap.
  if (command !== 'SALIR' && (await overMinuteCap(tx, input, now))) return { route: 'IGNORED', registered: false }
  const { registered, soleStaffId } = await resolveRegisteredSupportPhone(input.phone, tx)
  if (registered) {
    // A registered answer may cite the internal manual: this conversation is no longer one public help can keep using.
    if (conversation && !ignoredType(input.type)) await forgetPublicConversation(tx, input.receiverId, input.phone, conversation.id)
    return { route: 'SUPPORT', registered, soleStaffId }
  }
  // Public help (founder, 22-nov): an unknown phone talks like anyone else, within its caps. The day's US$ only stops what would
  // use the model, in the worker (the fixed message, once a day): the notice, the app menu and «persona» keep working.
  if (isSupportPublicHelpEnabled()) {
    // Paused (three strikes): nothing is answered, SALIR included, so the pause notice is never cancelled before it goes out.
    if (await isPublicPaused(tx, input.receiverId, input.phone, now)) return { route: 'IGNORED', registered }
    if (command === 'SALIR' || ignoredType(input.type)) return { route: 'SUPPORT', registered, publicHelp: true }
    const over = await countPublicMessage(tx, input.receiverId, input.phone, now)
    if (!over) return { route: 'SUPPORT', registered, publicHelp: true }
    if (!(await takePublicLimitNotice(tx, input.receiverId, input.phone, over, now))) return { route: 'IGNORED', registered }
    // Its notice goes in the open conversation: what it already queued under the cap still goes out.
    return { route: 'STATIC', registered, text: over === 'DAY' ? SUPPORT_PUBLIC_DAY_LIMIT : SUPPORT_PUBLIC_HOUR_LIMIT }
  }
  // The only AI-free way in for an unknown phone: reading the notice, leaving, or accepting it to link a code.
  if (command === 'AYUDA' || command === 'SALIR') return { route: 'SUPPORT', registered, soleStaffId }
  // An unknown phone may only accept the privacy notice this generation actually showed it.
  if (conversation && acceptsNotice(command, conversation) && (await noticeShown(tx, conversation)))
    return { route: 'SUPPORT', registered, soleStaffId }
  // The router ignores these anyway, so they must not spend the day's fixed message nor close the notice.
  if (conversation && ignoredType(input.type)) return { route: 'IGNORED', registered }
  if (!(await takeDailyStaticReply(tx, input.receiverId, input.phone, now))) return { route: 'IGNORED', registered }
  if (conversation) await resetSupportConversation(tx, conversation, 'CLOSED')
  return { route: 'STATIC', registered }
}

/**
 * T-F14/T-F15: only the support's own number reaches this router, so it never leaves a person's message to the old relay.
 * 'LEGACY' only means «not for support»: another receiver, or an event this number already stored under a non-support route.
 */
export async function tryRouteSupport(input: SupportInput): Promise<'QUEUED' | 'IGNORED' | 'LEGACY'> {
  // T-F14: only the support's own number (never the central nor sales: supportPhoneNumberId is null if it equals either).
  if (!input.receiverId || input.receiverId !== supportPhoneNumberId()) return 'LEGACY'
  return prisma
    .$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`support-event:${input.wamid}`}, 0))`
      const old = await tx.whatsappInboundEvent.findUnique({ where: { wamid: input.wamid } })
      if (old) return old.routedAs === 'SUPPORT_QUEUED' ? 'QUEUED' : old.routedAs === 'SUPPORT_IGNORED' ? 'IGNORED' : 'LEGACY'
      const now = new Date(),
        scrubbed = scrubSupportText(input.body),
        command = scrubbed.body.toUpperCase()
      // What support keeps of a message it does not answer: never its text. «Ignored» stays in the record (T-F15).
      const recordIgnored = async () =>
        tx.whatsappInboundEvent.create({
          data: {
            wamid: input.wamid,
            receiverId: input.receiverId,
            fromPhone: input.phone,
            messageType: input.type,
            rawBody: {
              id: input.wamid,
              type: input.type,
              timestamp: input.timestamp,
              ...(input.contextId ? { contextId: input.contextId } : {}),
            },
            routedAs: 'SUPPORT_IGNORED',
            processedAt: now,
            supportTombstoneUntil: new Date(now.getTime() + 90 * 86400_000),
          },
        })
      // T-F15: ACTIVAR, DESACTIVAR and a quote of an old relay message are plain text on this number (the relay lives on the
      // central one): they neither close an open conversation nor go anywhere else.
      const eventAt = Number(input.timestamp) * 1000
      if (Number.isFinite(eventAt) && eventAt > 0 && eventAt < now.getTime() - 30 * 86400_000) {
        await recordIgnored()
        return 'IGNORED'
      }
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`support-phone:${input.receiverId}:${input.phone}`}, 0))`
      let conversation = await tx.supportConversation.findFirst({
        where: { receiverId: input.receiverId, phone: input.phone, mode: { not: 'CLOSED' } },
      })
      // Support switched off: nothing is answered on its number; each message stays recorded as ignored (T-F15).
      if (!supportEnabled()) {
        if (conversation && command === 'SALIR') await resetSupportConversation(tx, conversation, 'CLOSED')
        await recordIgnored()
        return 'IGNORED'
      }
      if (conversation && conversation.lastActivityAt < new Date(now.getTime() - 1800_000)) {
        await closeIdleSupport(tx, conversation)
        conversation = null
      }
      const freeText = isSupportFreeTextEnabled()
      let unregistered = false,
        // Public help: an unknown phone answered in the public mode (decideSupportAdmission).
        publicHelp = false,
        soleStaffId: string | null | undefined,
        // Pick the venue now: the remembered identity's venue lost access, or the person just linked (`linked`).
        relist = false,
        linked = false,
        created = false
      if (!freeText) {
        // Without free text the number only answers AYUDA (and what follows it): production runs with free text on.
        if (!conversation && !['AYUDA', 'PERSONA'].includes(command) && !input.contextId) {
          await recordIgnored()
          return 'IGNORED'
        }
      } else {
        const admission = await decideSupportAdmission(input, conversation, command, tx, now)
        if (admission.route === 'IGNORED') {
          await recordIgnored()
          return 'IGNORED'
        }
        if (admission.route === 'STATIC') {
          // The notice of a public cap goes in the open conversation. The fixed message of today: any open conversation was just
          // closed, so it gets its own deliverable one.
          if (conversation && admission.text)
            await tx.supportConversation.update({
              where: { id: conversation.id },
              data: {
                lastUserMessageAt: supportInboundClock(input.timestamp, now, conversation.lastUserMessageAt),
                lastActivityAt: new Date(Math.max(now.getTime(), conversation.lastActivityAt.getTime())),
              },
            })
          else
            await tx.supportConversation.create({
              data: {
                receiverId: input.receiverId,
                phone: input.phone,
                lastUserMessageAt: supportInboundClock(input.timestamp, now, null),
                lastActivityAt: now,
              },
            })
          const admitted = await admitSupportMessage({ ...input, body: '' }, tx)
          await tx.supportMessage.update({
            where: { id: admitted.messageId },
            data: { answer: admission.text ?? SUPPORT_UNREGISTERED, status: 'ANSWER_READY' },
          })
          return 'QUEUED'
        }
        unregistered = !admission.registered
        publicHelp = !!admission.publicHelp
        soleStaffId = admission.soleStaffId
        if (conversation?.mode === 'PERSONAL') {
          const link = await ownLink(tx, input.phone, soleStaffId)
          if (!link || link.id !== conversation.linkId || link.staffId !== conversation.staffId) {
            const consent = conversation.noticeAcceptedAt,
              app = conversation.app
            conversation = await resetSupportConversation(tx, conversation)
            conversation = await tx.supportConversation.update({ where: { id: conversation.id }, data: { noticeAcceptedAt: consent, app } })
          }
        }
        // Public help never continues a conversation used while this phone was of an account (its answers may cite the internal
        // manual, and history, quotes and REINTENTAR read them): it closes, and a fresh public one starts with the notice.
        if (publicHelp && conversation && !(await isPublicConversation(tx, input.receiverId, input.phone, conversation.id))) {
          await resetSupportConversation(tx, conversation, 'CLOSED')
          conversation = null
          if (command === 'SALIR') {
            await recordIgnored()
            return 'IGNORED'
          }
        }
      }
      if (!conversation) {
        const memory = freeText && !unregistered ? await inheritSupportMemory(tx, input.receiverId, input.phone, now) : null
        let identity: Partial<Prisma.SupportConversationUncheckedCreateInput> = {}
        const link = memory?.noticeAcceptedAt && memory.staffId && memory.linkId ? await ownLink(tx, input.phone, soleStaffId) : null
        if (memory && link && link.id === memory.linkId && link.staffId === memory.staffId) {
          const venue = memory.venueId
            ? (await listSupportVenues(link.staffId, { limit: 1, venueId: memory.venueId }, tx)).items[0]
            : undefined
          if (venue && venue.organizationId === memory.orgId)
            identity = { mode: 'PERSONAL', staffId: link.staffId, linkId: link.id, orgId: venue.organizationId, venueId: venue.id }
          else relist = true
        }
        conversation = await tx.supportConversation.create({
          data: {
            receiverId: input.receiverId,
            phone: input.phone,
            ...(memory ? { noticeAcceptedAt: memory.noticeAcceptedAt, app: memory.app } : {}),
            ...identity,
          },
        })
        created = true
      }
      if (publicHelp) await markPublicConversation(tx, input.receiverId, input.phone, conversation.id, now)
      // Only the first message after linking recognizes the person: its code was confirmed after the last message of this
      // conversation (or of the closed one it inherits from), so a later PUBLICA keeps public help.
      if (!relist && conversation.mode === 'PUBLIC' && soleStaffId && conversation.noticeAcceptedAt) {
        const last = created
          ? await tx.supportConversation.findFirst({
              where: { receiverId: input.receiverId, phone: input.phone, mode: 'CLOSED' },
              orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }],
              select: { id: true, lastActivityAt: true },
            })
          : conversation
        const confirmed =
          last &&
          (await tx.supportLinkChallenge.findFirst({
            where: { phone: input.phone, conversationId: last.id, staffId: soleStaffId, consumedAt: { gt: last.lastActivityAt } },
            select: { id: true },
          }))
        if (confirmed && (await ownLink(tx, input.phone, soleStaffId))) relist = linked = true
      }
      const clock = supportInboundClock(input.timestamp, now, conversation.lastUserMessageAt)
      conversation = await tx.supportConversation.update({
        where: { id: conversation.id },
        // A webhook that took its clock before the phone lock never moves the activity back (that would revive a promotion).
        data: {
          lastUserMessageAt: clock,
          lastActivityAt: freeText ? new Date(Math.max(now.getTime(), conversation.lastActivityAt.getTime())) : now,
        },
      })
      // Only a handoff answer carries an outcome here; it is saved with the answer and counted in a SupportEvent.
      let outcome: SupportOutcome | undefined
      // Reject before selectors can search or persist any partially scrubbed text.
      let answer: string | null = scrubbed.sensitive
          ? SUPPORT_SENSITIVE
          : scrubbed.tooLong
            ? 'Escribe tu pregunta en un máximo de 2,000 caracteres, sin datos sensibles.'
            : null,
        body = answer ? '' : scrubbed.body
      // Public help: the first contact always gets the notice (it also says not to send passwords or cards); the text stays out.
      if (answer && publicHelp && !conversation.noticeAcceptedAt) answer = supportPublicNotice()
      if (!answer && input.contextId) {
        const original = await tx.supportMessage.findUnique({ where: { outboundWamid: input.contextId }, include: { conversation: true } })
        if (
          !original ||
          original.conversationId !== conversation.id ||
          original.generation !== conversation.generation ||
          original.expiresAt <= now ||
          original.conversation.receiverId !== input.receiverId ||
          original.conversation.phone !== input.phone
        ) {
          body = ''
          answer = 'No puedo identificar esa respuesta en esta conversación. Escribe AYUDA para empezar; no usaré la conversación citada.'
        }
      }
      if (!answer && command === 'SALIR') {
        await resetSupportConversation(tx, conversation, 'CLOSED')
        await recordIgnored()
        return 'IGNORED'
      }
      // Public help: even CONTINUAR only accepts a notice this generation showed (an unknown phone never saw one before).
      const accepting = freeText
        ? acceptsNotice(command, conversation) && ((command === 'CONTINUAR' && !publicHelp) || (await noticeShown(tx, conversation)))
        : command === 'CONTINUAR'
      const notice = publicHelp ? supportPublicNotice : supportNotice
      if (!answer && command === 'AYUDA') {
        conversation = await resetSupportConversation(tx, conversation)
        answer = notice()
      } else if (!answer && command === 'PUBLICA' && (!publicHelp || conversation.noticeAcceptedAt)) {
        const consent = conversation.noticeAcceptedAt
        conversation = await resetSupportConversation(tx, conversation)
        conversation = await tx.supportConversation.update({ where: { id: conversation.id }, data: { noticeAcceptedAt: consent } })
        answer = `Seguimos con ayuda pública. Escribe APP para elegir la app. ${SUPPORT_CONTACT}`
      } else if (!answer && accepting) {
        const topic = freeText ? liveTopic(conversation, now) : undefined
        const expired = freeText && !topic && conversation.pendingSelection === 'NOTICE'
        conversation = await resetSupportConversation(tx, conversation)
        conversation = await tx.supportConversation.update({
          where: { id: conversation.id },
          data:
            unregistered && !publicHelp
              ? { noticeAcceptedAt: now }
              : {
                  noticeAcceptedAt: now,
                  pendingSelection: 'APP',
                  selectionOptions: { items: appItems, ...(topic ? { topic } : {}) },
                  selectionExpiresAt: new Date(now.getTime() + 600_000),
                },
        })
        answer =
          unregistered && !publicHelp
            ? SUPPORT_LINK
            : expired
              ? `Tu pregunta anterior venció. Escríbela otra vez después de elegir la app.\n\n${SUPPORT_ASK_APP}`
              : SUPPORT_ASK_APP
      } else if (!answer && command === 'PERSONA' && (!publicHelp || conversation.noticeAcceptedAt)) {
        const handoff = getSupportHandoffConfig()
        // The notice row commits with this answer, or not at all.
        if (handoff) ({ text: answer, outcome } = await requestSupportHandoff(tx, conversation, 'REQUESTED', now, handoff))
        else answer = await buildHumanSummary(conversation.id, conversation.generation, tx)
      } else if (!answer && !conversation.noticeAcceptedAt && (command !== 'REINTENTAR' || publicHelp)) {
        // Public help: nothing to retry before the notice was accepted, so REINTENTAR gets the notice too.
        answer = notice()
        // The question waits for the notice to be accepted (media arrives with an empty body).
        if (freeText && questionOf(body))
          conversation = await tx.supportConversation.update({
            where: { id: conversation.id },
            data: {
              pendingSelection: 'NOTICE',
              selectionOptions: { items: [], topic: body },
              selectionExpiresAt: new Date(now.getTime() + 600_000),
            },
          })
      } else if (!answer && command === 'APP') {
        const consent = conversation.noticeAcceptedAt,
          topic = freeText ? liveTopic(conversation, now) : undefined
        conversation = await resetSupportConversation(tx, conversation)
        conversation = await tx.supportConversation.update({
          where: { id: conversation.id },
          data: {
            noticeAcceptedAt: consent,
            pendingSelection: 'APP',
            selectionOptions: { items: appItems, ...(topic ? { topic } : {}) },
            selectionExpiresAt: new Date(now.getTime() + 600_000),
          },
        })
        answer = SUPPORT_ASK_APP
      } else if (!answer && /^SUCURSAL(?:\s|$)/.test(command)) {
        const app = conversation.app,
          consent = conversation.noticeAcceptedAt,
          topic = freeText ? liveTopic(conversation, now) : undefined
        conversation = await resetSupportConversation(tx, conversation)
        conversation = await tx.supportConversation.update({ where: { id: conversation.id }, data: { app, noticeAcceptedAt: consent } })
        const selected = await selectVenue(tx, conversation, now, body.slice(8).trim().slice(0, 200), undefined, topic)
        conversation = selected.conversation
        answer = selected.answer
        if (!answer) body = topic ?? ''
      } else if (!answer && conversation.pendingSelection && conversation.pendingSelection !== 'NOTICE') {
        const parsed = supportSelectionSchema.safeParse(conversation.selectionOptions)
        if (!parsed.success || !conversation.selectionExpiresAt || conversation.selectionExpiresAt <= now) {
          conversation = await tx.supportConversation.update({
            where: { id: conversation.id },
            data: { pendingSelection: null, selectionOptions: Prisma.DbNull, selectionExpiresAt: null },
          })
          answer = 'La selección venció. Escribe APP o SUCURSAL para elegir de nuevo.'
        } else if (command === 'REINTENTAR') {
          // The worker replays the saved control; this command does not choose an option.
        } else if (conversation.pendingSelection === 'VENUE' && command === 'SIGUIENTE' && parsed.data.nextCursor) {
          const topic = freeText ? liveTopic(conversation, now) : undefined
          conversation = await changeSupportGeneration(tx, conversation)
          const selected = await selectVenue(tx, conversation, now, parsed.data.search, parsed.data.nextCursor, topic)
          conversation = selected.conversation
          answer = selected.answer
        } else {
          const option = /^\d{1,2}$/.test(command)
            ? parsed.data.items[Number(command) - 1]
            : freeText
              ? optionByName(parsed.data.items, body)
              : undefined
          const pending = conversation.pendingSelection
          // Con el modo híbrido vale la versión suelta de lo que escribió («2.19.0 (130)» → 2.19.0), pero sólo si el mensaje es
          // esa respuesta y nada más (T-F5, Codex r2-1): «no tengo la 2.25.7» o «¿necesito instalar la 2.25.7?» nombran una
          // versión que no es la suya, y se leen como cualquier otro mensaje que no contesta. Sin el modo híbrido, como hoy.
          const version =
            pending !== 'VERSION'
              ? null
              : isSupportHybridEnabled()
                ? hybridVersionReply(body)
                : /^\d+\.\d+(?:\.\d+)?(?:-[a-z0-9.-]+)?$/i.test(body) && body.length <= 40
                  ? body
                  : null
          if (version) {
            conversation = await changeSupportGeneration(tx, conversation, {
              appVersion: version,
              pendingSelection: null,
              selectionOptions: Prisma.DbNull,
              selectionExpiresAt: null,
            })
            body = parsed.data.topic ?? ''
            answer = body ? null : 'Gracias. ¿Qué necesitas hacer?'
          } else if (!option)
            answer = !freeText
              ? 'Responde con una de las opciones indicadas o escribe APP o SUCURSAL para cambiar.'
              : pending === 'APP'
                ? `No encontré esa opción. ${SUPPORT_ASK_APP}`
                : `No encontré esa opción. Responde con el número o el nombre:\n${parsed.data.items.map((o, i) => `${i + 1}. ${o.label}`).join('\n')}\n${parsed.data.nextCursor ? 'Escribe SIGUIENTE para ver más. ' : ''}O escribe APP o SUCURSAL para cambiar.`
          else if (pending === 'APP' && appItems.some(a => a.value === option.value)) {
            const topic = freeText ? parsed.data.topic : undefined
            conversation = await changeSupportGeneration(tx, conversation, {
              app: option.value,
              appVersion: null,
              deviceFamily: null,
              pendingSelection: null,
              selectionOptions: Prisma.DbNull,
              selectionExpiresAt: null,
            })
            // A personal conversation that already has its venue keeps it.
            const selected =
              freeText && conversation.mode === 'PERSONAL' && conversation.venueId
                ? await afterVenue(tx, conversation, now, topic)
                : await selectVenue(tx, conversation, now, '', undefined, topic)
            conversation = selected.conversation
            if (selected.answer && !selected.answer.startsWith('Seguimos con ayuda pública.')) answer = selected.answer
            else if (topic) body = topic
            else answer = `¿Qué necesitas hacer? ${SUPPORT_LINK}`
          } else if (pending === 'VENUE' && option.orgId && conversation.staffId && conversation.linkId) {
            const link = await ownLink(tx, conversation.phone, soleStaffId),
              topic = freeText ? liveTopic(conversation, now) : undefined
            if (!link || link.id !== conversation.linkId || link.staffId !== conversation.staffId) {
              conversation = await resetSupportConversation(tx, conversation)
              answer = SUPPORT_LINK
            } else {
              try {
                const allowed = await listSupportVenues(link.staffId, { limit: 1, venueId: option.value }, tx)
                if (allowed.items[0]?.organizationId !== option.orgId)
                  throw new ForbiddenError('El acceso cambió.', 'SUPPORT_ACCESS_REVOKED')
                conversation = await changeSupportGeneration(tx, conversation, {
                  orgId: option.orgId,
                  venueId: option.value,
                  pendingSelection: null,
                  selectionOptions: Prisma.DbNull,
                  selectionExpiresAt: null,
                })
                const next = await afterVenue(tx, conversation, now, topic)
                conversation = next.conversation
                // Say which venue was chosen, so a name typed with a typo is confirmed.
                answer = next.answer && freeText ? `Listo: viendo ${option.label}. ${next.answer}` : next.answer
                if (!answer) body = topic ?? ''
              } catch (err) {
                if (!(err instanceof ForbiddenError)) throw err
                conversation = await resetSupportConversation(tx, conversation)
                answer = `Tu acceso cambió. Seguimos con ayuda pública. ${SUPPORT_LINK}`
              }
            }
          } else if (pending === 'DEVICE' && ['PAX', 'NEXGO'].includes(option.value)) {
            conversation = await changeSupportGeneration(tx, conversation, {
              deviceFamily: option.value,
              pendingSelection: null,
              selectionOptions: Prisma.DbNull,
              selectionExpiresAt: null,
            })
            body = parsed.data.topic ?? ''
            answer = body ? null : 'Gracias. ¿Qué necesitas hacer?'
          } else answer = 'No pude identificar esa opción. Escribe APP o SUCURSAL para elegir de nuevo.'
        }
      }
      if (!answer && relist && conversation.mode === 'PUBLIC' && command !== 'REINTENTAR') {
        const topic = questionOf(body) || undefined
        // A new generation: public work still running for the old one only cancels itself, never this question.
        if (linked) conversation = await changeSupportGeneration(tx, conversation)
        const selected = await selectVenue(tx, conversation, now, '', undefined, topic)
        conversation = selected.conversation
        answer = selected.answer
        if (!answer) body = topic ?? ''
      }
      // A bare greeting is not a question: invite one instead of searching the guides for «hola».
      if (!answer && freeText && isGreeting(body)) answer = SUPPORT_GREETING
      if (!answer && !conversation.app && command !== 'REINTENTAR') {
        conversation = await tx.supportConversation.update({
          where: { id: conversation.id },
          data: {
            pendingSelection: 'APP',
            selectionOptions: { items: appItems, ...(freeText && questionOf(body) ? { topic: body } : {}) },
            selectionExpiresAt: new Date(now.getTime() + 600_000),
          },
        })
        answer = SUPPORT_ASK_APP
      }
      if (input.type !== 'text') {
        body = ''
        if (ignoredType(input.type)) {
          await recordIgnored()
          return 'IGNORED'
        }
        // Public help: the first contact always gets the notice, even if it starts with a photo or a voice note.
        if (!publicHelp || conversation.noticeAcceptedAt)
          answer = `Por ahora sólo puedo ayudarte con texto; no descargo ni interpreto archivos. ${SUPPORT_CONTACT}`
      }
      if (!freeText && (await overMinuteCap(tx, input, now))) {
        await recordIgnored()
        return 'IGNORED'
      }
      const admitted = await admitSupportMessage({ ...input, body }, tx)
      if (answer) {
        const saved = await tx.supportMessage.update({
          where: { id: admitted.messageId },
          data: { answer, status: 'ANSWER_READY', ...(outcome ? { outcome } : {}) },
        })
        if (outcome)
          await recordSupportEvent(tx, {
            kind: outcome,
            app: conversation.app,
            guideIds: [],
            conversationId: saved.conversationId,
            generation: saved.generation,
            sequence: saved.sequence,
            now,
          })
      }
      return 'QUEUED'
    })
    .catch(() => {
      throw new ServiceUnavailableError('No se pudo guardar la solicitud de ayuda. Intenta otra vez.', 'SUPPORT_ADMISSION_FAILED')
    })
}
