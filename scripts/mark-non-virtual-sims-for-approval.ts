/**
 * Marks NON-Virtual serialized SIMs as requiring OWNER approval (PlayTelecom).
 *
 * Business rule (Isaac, 2026-05-30): only SIMs registered from the "Virtual"
 * venue are trusted. Everything else (physical stores) must be approved by the
 * OWNER before it can be sold — even SIMs already in a promoter's hands.
 *
 * This script sets `requiresOwnerApproval = true` on every AVAILABLE
 * SerializedItem of the org whose `registeredFromVenueId` is NOT the Virtual
 * venue (or is NULL). The sale gate (applyCustodyPrecheck) then blocks them
 * until the OWNER approves via the dashboard queue.
 *
 * SAFETY:
 *   - Dry-run by default (prints counts, writes nothing).
 *   - Pass `--apply` to actually run the UPDATE.
 *   - Idempotent: only flips items that aren't already flagged.
 *   - Scoped to one org + status=AVAILABLE; never touches sold/other-org stock.
 *
 * Usage:
 *   npx ts-node scripts/mark-non-virtual-sims-for-approval.ts            # dry-run
 *   npx ts-node scripts/mark-non-virtual-sims-for-approval.ts --apply    # execute
 *   ORG_ID=... VIRTUAL_VENUE_ID=... npx ts-node ... --apply              # overrides
 */
import prisma from '../src/utils/prismaClient'
import { logger } from '../src/config/logger'

const ORG_ID = process.env.ORG_ID || 'cmietitbn000zpr2d8213qkzq' // PlayTelecom
const VIRTUAL_VENUE_ID = process.env.VIRTUAL_VENUE_ID || 'cmnv_virtual_playtelecom'
const APPLY = process.argv.includes('--apply')

async function main() {
  logger.info(`[mark-non-virtual] org=${ORG_ID} virtualVenue=${VIRTUAL_VENUE_ID} apply=${APPLY}`)

  // Items in scope: this org, AVAILABLE, NOT from the Virtual venue (incl. NULL origin).
  const scopeWhere = {
    organizationId: ORG_ID,
    status: 'AVAILABLE' as const,
    NOT: { registeredFromVenueId: VIRTUAL_VENUE_ID },
  }

  const total = await prisma.serializedItem.count({ where: scopeWhere })
  const alreadyFlagged = await prisma.serializedItem.count({
    where: { ...scopeWhere, requiresOwnerApproval: true },
  })
  const toFlag = await prisma.serializedItem.count({
    where: { ...scopeWhere, requiresOwnerApproval: false },
  })

  // Sanity: how many Virtual items we are intentionally NOT touching.
  const virtualUntouched = await prisma.serializedItem.count({
    where: { organizationId: ORG_ID, status: 'AVAILABLE', registeredFromVenueId: VIRTUAL_VENUE_ID },
  })

  logger.info(`[mark-non-virtual] non-Virtual AVAILABLE total : ${total}`)
  logger.info(`[mark-non-virtual]   already flagged           : ${alreadyFlagged}`)
  logger.info(`[mark-non-virtual]   to flag now               : ${toFlag}`)
  logger.info(`[mark-non-virtual] Virtual AVAILABLE (untouched): ${virtualUntouched}`)

  if (!APPLY) {
    logger.info('[mark-non-virtual] DRY-RUN — nothing written. Re-run with --apply to execute.')
    return
  }

  const res = await prisma.serializedItem.updateMany({
    where: { ...scopeWhere, requiresOwnerApproval: false },
    data: { requiresOwnerApproval: true },
  })
  logger.info(`[mark-non-virtual] ✅ APPLIED — ${res.count} items flagged requiresOwnerApproval=true`)
}

main()
  .then(() => prisma.$disconnect())
  .catch(async err => {
    logger.error('[mark-non-virtual] FAILED', { error: err instanceof Error ? err.message : String(err) })
    await prisma.$disconnect()
    process.exit(1)
  })
