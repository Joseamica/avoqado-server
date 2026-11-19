import crypto from 'crypto'
import type { Prisma, SupportConversation } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { ForbiddenError } from '@/errors/AppError'
import { assertSupportPrincipal } from './link.service'
import { resolveHelpAccess, type HelpGate, type HelpContext, type HelpAccess } from './access.service'
import { resolveRegisteredSupportPhone } from './registeredPhone.service'
import { isSupportFreeTextEnabled } from '@/config/supportWhatsapp'

export interface SupportContext {
  context: HelpContext | null
  access: HelpAccess | null
  fingerprint: string
}
// getUserAccess reports a lost venue with a plain Error: for the worker it is an access change like any other.
const NO_VENUE_ACCESS = /has no access to venue|^Venue \S+ not found$/
/**
 * true si el error dice que el vínculo o el acceso a la sucursal ya no existen: el ForbiddenError de readSupportContext y de
 * resolveHelpAccess, o el Error simple con el que getUserAccess dice que la persona ya no tiene esa sucursal
 * («User … has no access to venue …», «Venue … not found»). Es la regla que el worker traía en worker.service.ts; vive aquí
 * para que el worker y `checkDataDelivery` usen LA MISMA sin que se importen entre sí.
 */
export function isSupportAccessLost(err: unknown): boolean {
  return err instanceof ForbiddenError || (err instanceof Error && NO_VENUE_ACCESS.test(err.message))
}
export function isSupportWindowOpen(
  conversation: Pick<SupportConversation, 'mode' | 'lastUserMessageAt' | 'lastActivityAt'>,
  now = new Date(),
): boolean {
  const clock = now.getTime(),
    lastUser = conversation.lastUserMessageAt?.getTime(),
    activity = conversation.lastActivityAt.getTime()
  return (
    conversation.mode !== 'CLOSED' &&
    lastUser !== undefined &&
    Number.isFinite(lastUser) &&
    lastUser <= clock &&
    lastUser > clock - 86400000 &&
    activity <= clock &&
    activity > clock - 1800000
  )
}
/** `db`: a transaction reads only through it while `gates` is empty (plan and module gates still read through the global client). */
export async function readSupportContext(
  conversation: SupportConversation,
  gates: HelpGate[] = [],
  now = new Date(),
  db: Prisma.TransactionClient = prisma,
): Promise<SupportContext> {
  const revoked = () => new ForbiddenError('Tu acceso cambió. Continúa con ayuda pública.', 'SUPPORT_ACCESS_REVOKED')
  if (conversation.mode === 'CLOSED') throw revoked()
  let context: HelpContext | null = null,
    access: HelpAccess | null = null
  if (conversation.mode === 'PERSONAL') {
    if (!conversation.staffId || !conversation.linkId) throw revoked()
    const link = await db.supportWhatsappLink.findUnique({ where: { staffId: conversation.staffId } })
    if (
      !link ||
      link.id !== conversation.linkId ||
      link.staffId !== conversation.staffId ||
      link.phone !== conversation.phone ||
      link.expiresAt <= now
    )
      throw revoked()
    await assertSupportPrincipal(link.staffId, link.verifiedAt, db)
    // With free text the phone must still belong only to the link's owner (saved on a second account, or moved).
    // Reads only: the client directly, so no interactive transaction holds a connection or times out.
    if (isSupportFreeTextEnabled() && (await resolveRegisteredSupportPhone(conversation.phone, db)).soleStaffId !== link.staffId)
      throw revoked()
    if (conversation.orgId && conversation.venueId) {
      context = { staffId: link.staffId, orgId: conversation.orgId, venueId: conversation.venueId }
      access = await resolveHelpAccess(context, gates, db)
    } else if (conversation.pendingSelection !== 'VENUE') throw revoked()
  }
  const fingerprint = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        conversationId: conversation.id,
        generation: conversation.generation,
        mode: conversation.mode,
        staffId: context?.staffId ?? (conversation.mode === 'PERSONAL' ? conversation.staffId : null),
        linkId: conversation.mode === 'PERSONAL' ? conversation.linkId : null,
        orgId: context?.orgId,
        venueId: context?.venueId,
        app: conversation.app,
        appVersion: conversation.appVersion,
        deviceFamily: conversation.deviceFamily,
        pendingSelection: conversation.pendingSelection,
        selectionOptions: conversation.selectionOptions,
        selectionExpiresAt: conversation.selectionExpiresAt,
        access: access?.fingerprint ?? null,
      }),
    )
    .digest('hex')
  return { context, access, fingerprint }
}
