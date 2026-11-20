import { Prisma } from '@prisma/client'
import { ForbiddenError } from '@/errors/AppError'
import { canonicalPhoneE164, phoneLast10, phonesMatch } from '@/utils/phone'
import { listSupportVenues } from './access.service'
import { usableLink } from './link.service'

const none = { registered: false, soleStaffId: null }

async function hasSupportVenue(staffId: string, tx: Prisma.TransactionClient) {
  try {
    return (await listSupportVenues(staffId, { limit: 1 }, tx)).items.length > 0
  } catch (err) {
    if (err instanceof ForbiddenError) return false
    throw err
  }
}

/**
 * The accounts with access whose saved phone is this one, in id order (at most `limit`, each confirmed with a venue); with
 * none, the owner of a code-verified link. The same answer as resolveRegisteredSupportPhone, which asks it for two.
 */
export async function listRegisteredSupportStaff(phone: string, tx: Prisma.TransactionClient, limit = 5): Promise<string[]> {
  const canonical = canonicalPhoneE164(phone)
  if (!canonical) return []
  // Same access rules as listSupportVenues, applied before the LIMIT so accounts without access cannot crowd out a valid one.
  // The digits expression must stay identical to the Staff_phone_last10_idx index.
  const rows = await tx.$queryRaw<{ id: string; phone: string }[]>`
    SELECT s."id", s."phone"
    FROM "Staff" s
    WHERE s."phone" IS NOT NULL
      AND right(regexp_replace(s."phone", '\\D', '', 'g'), 10) = ${phoneLast10(canonical)}
      AND s."active" = true
      AND (
        EXISTS (SELECT 1 FROM "StaffVenue" sa WHERE sa."staffId" = s."id" AND sa."role" = 'SUPERADMIN' AND sa."active" = true)
        OR EXISTS (
          SELECT 1 FROM "Venue" v
          WHERE v."status" NOT IN ('CLOSED', 'LIVE_DEMO')
            AND NOT EXISTS (
              SELECT 1 FROM "StaffOrganization" gone
              WHERE gone."staffId" = s."id" AND gone."organizationId" = v."organizationId"
                AND (gone."isActive" = false OR gone."leftAt" IS NOT NULL)
            )
            AND (
              EXISTS (SELECT 1 FROM "StaffVenue" sv WHERE sv."staffId" = s."id" AND sv."venueId" = v."id" AND sv."active" = true)
              OR (
                v."active" = true
                AND EXISTS (
                  SELECT 1 FROM "StaffOrganization" so
                  WHERE so."staffId" = s."id" AND so."organizationId" = v."organizationId"
                    AND so."role" = 'OWNER' AND so."isActive" = true AND so."leftAt" IS NULL
                )
              )
            )
        )
      )
    ORDER BY s."id"
    LIMIT 20`
  // ponytail: 20 candidatos con acceso y 10 confirmaciones por mensaje; más de 20 cuentas vigentes con los mismos 10 dígitos pueden dejar fuera a la válida.
  const staff: string[] = []
  for (const row of rows.filter(r => phonesMatch(r.phone, canonical)).slice(0, 10)) {
    if (staff.length === limit) break
    if (await hasSupportVenue(row.id, tx)) staff.push(row.id)
  }
  if (staff.length) return staff
  const link = await usableLink(tx, canonical)
  // A code-verified link with no saved Staff.phone match is the sole account; Task 4 relies on soleStaffId === link.staffId.
  return link && (await hasSupportVenue(link.staffId, tx)) ? [link.staffId] : []
}

export async function resolveRegisteredSupportPhone(
  phone: string,
  tx: Prisma.TransactionClient,
): Promise<{ registered: boolean; soleStaffId: string | null }> {
  // Two confirmed accounts are enough to know the phone has several profiles.
  const staff = await listRegisteredSupportStaff(phone, tx, 2)
  return staff.length ? { registered: true, soleStaffId: staff.length === 1 ? staff[0] : null } : none
}

export async function isRelayOperatorPhone(phone: string, tx: Prisma.TransactionClient): Promise<boolean> {
  const canonical = canonicalPhoneE164(phone)
  if (!canonical) return false
  // The relay saves the opt-in sender as received, so an old Mexican `+521…` sender stays in that form.
  const saved = /^\+52\d{10}$/.test(canonical) ? [canonical, `+521${canonical.slice(3)}`] : [canonical]
  const venue = await tx.venue.findFirst({
    where: { whatsappContactMode: 'RELAY', whatsappOptInPhone: { in: saved } },
    select: { id: true },
  })
  return !!venue
}
