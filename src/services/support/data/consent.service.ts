import crypto from 'crypto'
import cuid from 'cuid'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { isSupportDataEnabled } from '@/config/supportWhatsapp'
import { ConflictError, ForbiddenError, ServiceUnavailableError } from '@/errors/AppError'
import { isActiveSuperAdmin } from '@/mcp/scope'
import { DEMO_VENUE_STATUSES } from '@/services/access/basePlan.service'
import { listSupportVenues } from '@/services/support/access.service'
import { assertSupportPrincipal, type SupportPersonalActor } from '@/services/support/link.service'
import { motivoDeConcesionInvalidada } from '@/utils/passwordChangeGuard'
import { utcTs } from '@/utils/sqlDates'
import { venueDayKey } from '@/utils/venueDateKeys'
import { SUPPORT_DATA_NOTICE, supportDataNoticeHash, supportDataNoticeHashes } from './texts'

/**
 * El permiso de «datos por WhatsApp» (la B): la aceptación del aviso (una fila por persona) y el desbloqueo del día (una fila
 * por persona, sucursal y día de la sucursal). Este archivo es su ÚNICO escritor (lo vigila
 * tests/unit/architecture/supportDataSingleWriter.test.ts), detrás de la ruta del panel con sesión fuerte.
 */

export interface DataValidity {
  venueName: string
  organizationId: string
  timezone: string
  day: string
  kycVerified: boolean
  accepted: boolean
  unlocked: boolean
  fingerprint: string
}
export interface DataAccessStatus {
  accepted: boolean
  unlocked: boolean
  venueName: string
  notice: { text: string; hash: string }
}
type NoticeLanguage = 'es' | 'en'

const venueForbidden = () => new ForbiddenError('No tienes acceso a esa sucursal.', 'SUPPORT_DATA_VENUE_FORBIDDEN')
const noticeOf = (language: NoticeLanguage = 'es') => ({ text: SUPPORT_DATA_NOTICE[language], hash: supportDataNoticeHash(language) })

/** Sólo lee, por llave: la sucursal, la aceptación (PK) y el desbloqueo (@@unique). */
export async function readDataValidity(
  db: Prisma.TransactionClient,
  input: { staffId: string; venueId: string; linkId: string | null; now: Date },
): Promise<DataValidity> {
  const venue = await db.venue.findUnique({
    where: { id: input.venueId },
    select: { name: true, timezone: true, organizationId: true, kycStatus: true, status: true },
  })
  if (!venue) throw venueForbidden()
  // The calendar day in the zone the venue has NOW, not the business day until 04:00 (T-B9).
  const day = venueDayKey(input.now, venue.timezone)
  const acceptance = await db.supportDataAcceptance.findUnique({ where: { staffId: input.staffId } })
  const unlock = await db.supportDataUnlock.findUnique({
    where: { staffId_venueId_day: { staffId: input.staffId, venueId: input.venueId, day } },
  })
  const accepted = !!acceptance && acceptance.linkId === input.linkId && supportDataNoticeHashes().includes(acceptance.noticeHash)
  const unlocked = !!unlock && unlock.linkId === input.linkId
  // The panel rule (canAccessOperationalFeatures): verification approved, or a demo venue.
  const kycVerified = venue.kycStatus === 'VERIFIED' || (DEMO_VENUE_STATUSES as readonly string[]).includes(venue.status)
  // Only what counts enters the fingerprint, so it moves whenever the acceptance or the unlock stops counting (a changed
  // notice text keeps the stored hash). No hours: tapping again with the same link and notice does not move it.
  const fingerprint = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        timezone: venue.timezone,
        day,
        unlock: unlocked ? unlock!.id : null,
        link: input.linkId,
        notice: accepted ? acceptance!.noticeHash : null,
        kyc: kycVerified,
      }),
    )
    .digest('hex')
  return {
    venueName: venue.name,
    organizationId: venue.organizationId,
    timezone: venue.timezone,
    day,
    kycVerified,
    accepted,
    unlocked,
    fingerprint,
  }
}

/** Points 1 to 4 of the panel route: data on, not a superadmin, a current link and access to the venue. Returns the link id. */
async function assertSupportDataAccess(db: Prisma.TransactionClient, staffId: string, venueId: string, now: Date): Promise<string> {
  if (!isSupportDataEnabled())
    throw new ServiceUnavailableError('Los datos por WhatsApp todavía no están activados.', 'SUPPORT_DATA_UNAVAILABLE')
  if (await isActiveSuperAdmin(staffId, db))
    throw new ForbiddenError('Con una cuenta de superadmin no se consultan datos de negocios por WhatsApp.', 'SUPPORT_DATA_SUPERADMIN')
  const link = await db.supportWhatsappLink.findUnique({ where: { staffId } })
  if (!link || link.expiresAt <= now || (await motivoDeConcesionInvalidada(staffId, link.verifiedAt, db)))
    throw new ConflictError('Vincula tu WhatsApp primero.', 'SUPPORT_DATA_LINK_REQUIRED')
  const { items } = await listSupportVenues(staffId, { venueId, limit: 1 }, db)
  if (!items.length) throw venueForbidden()
  return link.id
}

const toStatus = (validity: DataValidity, language?: NoticeLanguage): DataAccessStatus => ({
  accepted: validity.accepted,
  unlocked: validity.unlocked,
  venueName: validity.venueName,
  notice: noticeOf(language),
})

/** Sólo lee. notice = el texto vigente en ese idioma (default 'es') y su huella. */
export async function getDataAccess(staffId: string, input: { venueId: string; language?: NoticeLanguage }): Promise<DataAccessStatus> {
  const now = new Date()
  const linkId = await assertSupportDataAccess(prisma, staffId, input.venueId, now)
  return toStatus(await readDataValidity(prisma, { staffId, venueId: input.venueId, linkId, now }), input.language)
}

/** El ÚNICO escritor de SupportDataAcceptance y SupportDataUnlock. */
export async function grantDataAccess(
  staffId: string,
  // acceptNotice: true sólo desde «Aceptar» en la ventana del aviso (T-B37).
  input: { venueId: string; noticeHash?: string; language?: NoticeLanguage; acceptNotice: boolean },
  actor: SupportPersonalActor,
  // The clock of THIS request, read once on entry. The controller never passes it; the tests do. The server does not
  // recognize a repetition: every POST is a tap and its day is the day of its own clock, so no client may repeat this POST
  // on its own (T-B29): a lost answer at 23:59:59 repeated a second later would authorize tomorrow without a tap.
  now = new Date(),
): Promise<DataAccessStatus> {
  return prisma.$transaction(async tx => {
    const { venueId, noticeHash, acceptNotice } = input
    const linkId = await assertSupportDataAccess(tx, staffId, venueId, now)
    // The same recheck as every other personal writer: a password change since the strong sign-in revokes the grant.
    await assertSupportPrincipal(staffId, actor?.strongAuthAt ?? new Date(NaN), tx)
    if (!noticeHash || !supportDataNoticeHashes().includes(noticeHash))
      return toStatus(await readDataValidity(tx, { staffId, venueId, linkId, now }), input.language)
    // T-B37: only «Aceptar» in the notice dialog writes the acceptance. The everyday tap (a tab that still says «accepted»)
    // unlocks only while the acceptance counts for THIS link (readDataValidity, the same rule as everywhere); after an unlink
    // and a new link it writes nothing and answers the notice, so the panel opens it again.
    if (!acceptNotice) {
      const validity = await readDataValidity(tx, { staffId, venueId, linkId, now })
      if (!validity.accepted) return toStatus(validity, input.language)
    }
    const venue = await tx.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
    if (!venue) throw venueForbidden()
    const day = venueDayKey(now, venue.timezone)
    // Always the acceptance first, then the unlock. The WHERE makes a double click write nothing: only the statement that
    // really wrote returns a row, and only that one is audited. That holds inside ONE venue-day, and only there.
    // The acceptance is rewritten only for another link or a hash that stopped being current (T-B30): accepting in Spanish and
    // tapping with the panel in English keeps the row and its log, because the person never saw the English text as new.
    // Each statement writes only while the link it read still exists (no new locks here): an unlink or a relink that landed after
    // that read leaves nothing with the dead link, and an old link does not overwrite what a tap with the new one wrote. One window
    // remains, inside the statement itself: a relink plus a new tap that commit while this INSERT runs can still be overwritten.
    // It fails closed: the row keeps the dead link and stops counting until the person taps again.
    const accepted = !acceptNotice
      ? []
      : await tx.$queryRaw<{ staffId: string }[]>`
      INSERT INTO "SupportDataAcceptance" ("staffId", "linkId", "noticeHash", "acceptedAt")
      SELECT ${staffId}, ${linkId}, ${noticeHash}, ${utcTs(now)}
      WHERE EXISTS (SELECT 1 FROM "SupportWhatsappLink" WHERE id = ${linkId})
      ON CONFLICT ("staffId") DO UPDATE SET "linkId" = EXCLUDED."linkId", "noticeHash" = EXCLUDED."noticeHash", "acceptedAt" = EXCLUDED."acceptedAt"
      WHERE "SupportDataAcceptance"."linkId" <> EXCLUDED."linkId" OR NOT ("SupportDataAcceptance"."noticeHash" = ANY(${supportDataNoticeHashes()}::text[]))
      RETURNING "staffId"`
    const [unlock] = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "SupportDataUnlock" (id, "staffId", "venueId", day, "linkId", "unlockedAt", "createdAt")
      SELECT ${cuid()}, ${staffId}, ${venueId}, ${day}, ${linkId}, ${utcTs(now)}, ${utcTs(now)}
      WHERE EXISTS (SELECT 1 FROM "SupportWhatsappLink" WHERE id = ${linkId})
      ON CONFLICT ("staffId", "venueId", day) DO UPDATE SET "linkId" = EXCLUDED."linkId", "unlockedAt" = EXCLUDED."unlockedAt"
      WHERE "SupportDataUnlock"."linkId" <> EXCLUDED."linkId"
      RETURNING id`
    if (accepted.length)
      await tx.activityLog.create({
        data: {
          action: 'SUPPORT_DATA_NOTICE_ACCEPTED',
          entity: 'SupportDataAcceptance',
          entityId: staffId,
          staffId,
          venueId,
          data: { noticeHash },
        },
      })
    if (unlock)
      await tx.activityLog.create({
        data: { action: 'SUPPORT_DATA_UNLOCKED', entity: 'SupportDataUnlock', entityId: unlock.id, staffId, venueId, data: { day } },
      })
    // Not «true by construction»: the link may have changed since it was read. The answer re-reads it and says what counts now.
    const current = await tx.supportWhatsappLink.findUnique({ where: { staffId }, select: { id: true } })
    return toStatus(await readDataValidity(tx, { staffId, venueId, linkId: current?.id ?? null, now }), input.language)
  })
}
