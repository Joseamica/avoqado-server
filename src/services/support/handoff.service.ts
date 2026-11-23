// Pasar a una persona: quién puede, qué ve el cliente y qué se guarda. El aviso (SupportNotice) nace en la misma transacción
// que la respuesta; el correo lo manda su propio job. Nunca se copia texto escrito por el cliente (R1-01, R1-03).
import crypto from 'crypto'
import type { Prisma, SupportConversation, SupportOutcome } from '@prisma/client'
import { ForbiddenError } from '@/errors/AppError'
import { isActiveSuperAdmin } from '@/mcp/scope'
import { isSupportPublicHelpEnabled, type SupportHandoffConfig } from '@/config/supportWhatsapp'
import { venueDayKey } from '@/utils/venueDateKeys'
import { listSupportVenues } from './access.service'
import { normalizeAppVersion } from './deviceContext.service'
import { buildHumanSummary, citedTitle } from './humanSummary.service'
import { loadSupportLibrary, resolveSourceRefs, type LibraryGuide } from './knowledge.service'
import { listRegisteredSupportStaff, resolveRegisteredSupportPhone } from './registeredPhone.service'
import { SUPPORT_HANDOFF_OFFER, SUPPORT_LINK, SUPPORT_SECOND_FAILURE, supportHandoffAlready, supportHandoffDone } from './texts'

/** La foto que se copia a SupportNotice.meta al nacer el aviso (R1-03); nunca texto del cliente. */
export interface HandoffMeta {
  requestedAt: string
  reason: 'REQUESTED' | 'TWO_FAILURES' | 'OLD_VERSION' | 'DATA'
  /** Del cliente, para el botón de WhatsApp. */
  phone: string
  app: string | null
  appVersion: string | null
  deviceFamily: string | null
  multipleProfiles: boolean
  /** venues: todas las sucursales que el correo muestra, con su id, para revalidar cada una al enviar (R2-01); PERSONAL = la elegida. */
  people: { staffId: string; name: string; role: string | null; venues: { id: string; name: string }[]; organization: string | null }[]
  /** Títulos de lo que intentó el asistente, ≤ 5. */
  guides: string[]
  /** DATA: la etiqueta del dato que intentó la B (nunca una cifra). */
  dataCapability?: string | null
  /** Ayuda pública: el número no es de ninguna cuenta (sin personas que mostrar ni revalidar). */
  unregistered?: true
}
export const SUPPORT_FAILURE_OUTCOMES: SupportOutcome[] = ['UNKNOWN', 'JUDGE_LITERAL']
const CDMX = 'America/Mexico_City'

export const handoffDedupeKey = (conversationId: string, generation: number) => `handoff:${conversationId}:${generation}`
export function supportPhoneHash(receiverId: string, phone: string): string {
  return crypto.createHash('sha256').update(`${receiverId}:${phone}`).digest('hex')
}

const YES = /^(si|sip|claro|ok|okay|va|sale|dale|porfa|por favor|si por favor|si porfa|si gracias|si quiero|quiero|yes)$/
/** «Sí» a la oferta: las palabras sin acentos ni signos, unidas por un espacio. */
export function isHandoffYes(body: string): boolean {
  const words = body
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  return YES.test(words.join(' '))
}

/** La segunda falla seguida: corta, con lo más cercano (una página interna no lleva enlace) y la oferta. */
export function secondFailureText(nearest: LibraryGuide | null): string {
  return [
    SUPPORT_SECOND_FAILURE,
    nearest ? `Lo más cercano: ${nearest.title} ${nearest.internal ? '(manual de Avoqado)' : nearest.publicUrl}` : '',
    SUPPORT_HANDOFF_OFFER,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * Una plática vinculada, o un número dado de alta como del equipo de un negocio (un superadmin también). Desconocido → no, salvo
 * con la ayuda pública prendida: entonces sí, sin staff (`unregistered`).
 */
export async function isHandoffEligible(
  tx: Prisma.TransactionClient,
  conversation: SupportConversation,
): Promise<{ eligible: boolean; staffId: string | null; unregistered?: true }> {
  if (conversation.mode === 'PERSONAL') return { eligible: !!conversation.staffId, staffId: conversation.staffId }
  if (conversation.mode !== 'PUBLIC') return { eligible: false, staffId: null }
  const { registered, soleStaffId } = await resolveRegisteredSupportPhone(conversation.phone, tx)
  if (!registered && isSupportPublicHelpEnabled()) return { eligible: true, staffId: null, unregistered: true }
  return { eligible: registered, staffId: soleStaffId }
}

type Venue = { id: string; name: string; organizationId: string }
async function venuesOf(tx: Prisma.TransactionClient, staffId: string): Promise<Venue[]> {
  // listSupportVenues gives a superadmin every venue of the platform: the notice shows only the ones it belongs to.
  if (await isActiveSuperAdmin(staffId, tx))
    return (
      await tx.staffVenue.findMany({
        where: { staffId, active: true, venue: { status: { notIn: ['CLOSED', 'LIVE_DEMO'] } } },
        orderBy: [{ venue: { name: 'asc' } }, { id: 'asc' }],
        take: 3,
        select: { venue: { select: { id: true, name: true, organizationId: true } } },
      })
    ).map(row => row.venue)
  try {
    return (await listSupportVenues(staffId, { limit: 3 }, tx)).items
  } catch (err) {
    if (err instanceof ForbiddenError) return []
    throw err
  }
}
async function personOf(tx: Prisma.TransactionClient, staffId: string, venues: Venue[]): Promise<HandoffMeta['people'][number]> {
  const staff = await tx.staff.findUnique({ where: { id: staffId }, select: { firstName: true, lastName: true } })
  const highest = { orderBy: [{ role: 'asc' as const }, { id: 'asc' as const }], select: { role: true } }
  // Its role in a venue shown; a superadmin or an owner may have none there: then its highest active one.
  const role =
    (await tx.staffVenue.findFirst({ where: { staffId, active: true, venueId: { in: venues.map(v => v.id) } }, ...highest })) ??
    (await tx.staffVenue.findFirst({ where: { staffId, active: true }, ...highest }))
  const organization = venues[0]
    ? await tx.organization.findUnique({ where: { id: venues[0].organizationId }, select: { name: true } })
    : null
  return {
    staffId,
    name: [staff?.firstName, staff?.lastName].filter(Boolean).join(' '),
    role: role?.role ?? null,
    venues: venues.map(v => ({ id: v.id, name: v.name })),
    organization: organization?.name ?? null,
  }
}

/** Sólo metadatos, en la misma transacción que el aviso (R1-03): nunca `body` ni `answer` de un mensaje. */
export async function snapshotHandoffMeta(
  tx: Prisma.TransactionClient,
  conversation: SupportConversation,
  reason: HandoffMeta['reason'],
  now: Date,
  library?: LibraryGuide[],
  extra?: { dataCapability?: string },
): Promise<HandoffMeta> {
  const people: HandoffMeta['people'] = []
  if (conversation.mode === 'PERSONAL') {
    const venue = conversation.venueId
      ? await tx.venue.findUnique({ where: { id: conversation.venueId }, select: { id: true, name: true, organizationId: true } })
      : null
    if (conversation.staffId) people.push(await personOf(tx, conversation.staffId, venue ? [venue] : []))
  } else
    for (const staffId of await listRegisteredSupportStaff(conversation.phone, tx))
      people.push(await personOf(tx, staffId, await venuesOf(tx, staffId)))
  const answers = await tx.supportMessage.findMany({
    where: { conversationId: conversation.id, generation: conversation.generation, sourceIds: { isEmpty: false }, expiresAt: { gt: now } },
    orderBy: { sequence: 'desc' },
    take: 6,
    select: { sourceIds: true },
  })
  // Hybrid refs (`id@hash8`) take their titles from the library; it loads once, if needed. T-F10a (Codex P2): a version that is no
  // longer the published one says so (citedTitle).
  let loaded: LibraryGuide[] | undefined
  const load = () => (loaded ??= library ?? loadSupportLibrary())
  const titles = answers.flatMap(m => resolveSourceRefs(m.sourceIds, load)?.guides.map(g => citedTitle(g, m.sourceIds)) ?? [])
  return {
    requestedAt: now.toISOString(),
    reason,
    phone: conversation.phone,
    app: conversation.app,
    // Normalized: a typed suffix (up to 40 characters today) never reaches the notice (F-20).
    appVersion: normalizeAppVersion(conversation.appVersion),
    deviceFamily: conversation.deviceFamily,
    multipleProfiles: people.length > 1,
    people,
    guides: [...new Set(titles)].slice(0, 5),
    ...(extra?.dataCapability ? { dataCapability: extra.dataCapability } : {}),
  }
}

/**
 * Pide una persona, todo en `tx`: el candado del teléfono (el del router, antes que la fila del mensaje), quién puede, un
 * aviso por plática y generación, y los topes del día (CDMX). Un tope alcanzado deja el aviso `HELD` para el resumen del
 * día y el cliente no se entera: ve el texto de «ya se avisó».
 */
export async function requestSupportHandoff(
  tx: Prisma.TransactionClient,
  conversation: SupportConversation,
  reason: HandoffMeta['reason'],
  now: Date,
  config: SupportHandoffConfig,
  library?: LibraryGuide[],
  extra?: { dataCapability?: string },
): Promise<{ text: string; outcome: 'HANDOFF' | 'FIXED' }> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`support-phone:${conversation.receiverId}:${conversation.phone}`}, 0))`
  const { eligible, staffId, unregistered } = await isHandoffEligible(tx, conversation)
  if (!eligible) {
    // Never an email for an unknown phone: today's summary and how to link, if it fits.
    const summary = await buildHumanSummary(conversation.id, conversation.generation, tx, library)
    const linked = `${summary}\n\n${SUPPORT_LINK}`
    return { text: linked.length <= 1500 ? linked : summary, outcome: 'FIXED' }
  }
  const dedupeKey = handoffDedupeKey(conversation.id, conversation.generation)
  const already = { text: supportHandoffAlready(config.whatsappDisplay), outcome: 'HANDOFF' as const }
  if (await tx.supportNotice.findUnique({ where: { dedupeKey }, select: { id: true } })) return already
  // The snapshot does not depend on the counts: it is read before the global lock, which then only covers them.
  const snapshot = await snapshotHandoffMeta(tx, conversation, reason, now, library, extra)
  const meta: HandoffMeta = unregistered ? { ...snapshot, people: [], multipleProfiles: false, unregistered } : snapshot
  // ponytail: un candado global por día; los avisos son pocos. Contadores por fila si un día pasan de cientos.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('support-handoff-day', 0))`
  const day = venueDayKey(now, CDMX),
    phoneHash = supportPhoneHash(conversation.receiverId, conversation.phone)
  const counted = { kind: 'HANDOFF' as const, day, status: { not: 'HELD' as const } }
  // Ayuda pública: los números sin cuenta tienen su propio cupo del día, con los mismos topes (por teléfono y en total), contado en
  // filas propias: nunca le quitan lugar a un registrado, ni al mismo teléfono cuando se registra. Sólo suman los que no se retienen.
  const publicKeys = [
    `CONTROL:${conversation.receiverId}:HANDOFF_PUBLIC:${day}`,
    `CONTROL:${conversation.receiverId}:HANDOFF_PUBLIC:${day}:${phoneHash}`,
  ]
  const publicRows = await tx.supportBudget.findMany({ where: { key: { in: publicKeys } }, select: { key: true, callCount: true } })
  const [publicAll, publicPhone] = publicKeys.map(key => publicRows.find(r => r.key === key)?.callCount ?? 0)
  const phoneCount = await tx.supportNotice.count({ where: { ...counted, phoneHash } }),
    allCount = await tx.supportNotice.count({ where: counted })
  const held = unregistered
    ? publicPhone >= config.phoneDailyCap || publicAll >= config.dailyCap
    : phoneCount - publicPhone >= config.phoneDailyCap || allCount - publicAll >= config.dailyCap
  if (unregistered && !held)
    for (const key of publicKeys)
      await tx.supportBudget.upsert({
        where: { key },
        create: { key, windowStart: now, callCount: 1 },
        update: { callCount: { increment: 1 } },
      })
  const personal = conversation.mode === 'PERSONAL'
  await tx.supportNotice.create({
    data: {
      kind: 'HANDOFF',
      dedupeKey,
      status: held ? 'HELD' : 'PENDING',
      day,
      app: conversation.app,
      reason,
      conversationId: conversation.id,
      generation: conversation.generation,
      staffId,
      linkId: personal ? conversation.linkId : null,
      // Public: the venues live in `meta`, one per person shown.
      venueId: personal ? conversation.venueId : null,
      phoneHash,
      meta: meta as unknown as Prisma.InputJsonObject,
    },
  })
  return held ? already : { text: supportHandoffDone(config.whatsappDisplay), outcome: 'HANDOFF' }
}

/** Una fila por respuesta del híbrido, sin texto; se escribe en la transacción que completa el mensaje (nunca dos). */
export async function recordSupportEvent(
  tx: Prisma.TransactionClient,
  input: {
    kind: SupportOutcome
    app: string | null
    guideIds: string[]
    conversationId: string
    generation: number
    sequence: number
    now: Date
  },
): Promise<void> {
  const { now, ...event } = input
  await tx.supportEvent.create({ data: { ...event, day: venueDayKey(now, CDMX) } })
}
