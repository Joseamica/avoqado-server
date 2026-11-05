/**
 * The team's e-mail consent (the box on «Nuevo prospecto» and on the HubSpot import). Its own file so `accounts.service`
 * and `inbound.service` do not import each other.
 */
import type { Prisma } from '@prisma/client'
import { normalizeEmail } from '../marketing/emailSuppression.service'
import { erasedEmailsTx } from './erase.service'
import { addEvent } from './timeline.service'

/** `noticeVersion` of a consent the team recorded by ticking the box on a prospect it created or imported. */
export const AVISO_DE_LA_CASILLA_DEL_EQUIPO = 'casilla-del-equipo-v1'

/**
 * The team's consent (the box on «Nuevo prospecto», or the HubSpot import): one row per normalized email, written with
 * `skipDuplicates` so it NEVER overwrites a consent that already exists (the landing's stays). Skips (and does not count) the emails deleted from the CRM. Returns how many rows it
 * wrote; with at least one, the account's timeline says THAT a consent was recorded (no email). The caller's transaction.
 */
export async function escribirConsentimientoDelEquipoTx(
  tx: Prisma.TransactionClient,
  p: { emails: string[]; accountId: string; source: 'MANUAL' | 'IMPORTACION'; staffId: string; at: Date },
): Promise<number> {
  const all = [...new Set(p.emails.filter(email => email.trim()).map(normalizeEmail))]
  // Like the landing: whoever was deleted from the CRM (D7) is neither written nor counted — and nothing is thrown.
  const erased = await erasedEmailsTx(tx, all)
  const emails = all.filter(email => !erased.has(email))
  if (emails.length === 0) return 0
  const { count } = await tx.crmEmailConsent.createMany({
    data: emails.map(email => ({
      email,
      accountId: p.accountId,
      entryId: null,
      grantedById: p.staffId,
      consentAt: p.at,
      source: p.source,
      noticeVersion: AVISO_DE_LA_CASILLA_DEL_EQUIPO,
    })),
    skipDuplicates: true,
  })
  if (count > 0) {
    await addEvent(tx, {
      accountId: p.accountId,
      kind: 'FIELD_CHANGE',
      actorStaffId: p.staffId,
      sourceKey: `consent:${p.source}:${p.accountId}`,
      data: { campo: 'consentimiento' },
    })
  }
  return count
}
