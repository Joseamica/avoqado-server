/**
 * Marks NON-Virtual serialized SIMs as requiring OWNER approval (PlayTelecom).
 *
 * Business rule (Isaac, 2026-05-30): only SIMs registered from the "Virtual"
 * venue are trusted. Everything else (physical stores) must be approved by the
 * OWNER before it can be sold — even SIMs already in a promoter's hands.
 *
 * eSIMs are EXEMPT — they are always sellable and are never flagged
 * ("los eSIM sí se venden, no se deben restringir").
 *
 * This script sets `requiresOwnerApproval = true` on every AVAILABLE
 * SerializedItem of the org whose `registeredFromVenueId` is NOT the Virtual
 * venue (or is NULL) AND whose category is not an eSIM. The sale gate
 * (applyCustodyPrecheck) then blocks them until the OWNER approves via the
 * dashboard queue.
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
import logger from '../src/config/logger'

const ORG_ID = process.env.ORG_ID || 'cmietitbn000zpr2d8213qkzq' // PlayTelecom
const VIRTUAL_VENUE_ID = process.env.VIRTUAL_VENUE_ID || 'cmnv_virtual_playtelecom'
const APPLY = process.argv.includes('--apply')

async function main() {
  logger.info(`[mark-non-virtual] org=${ORG_ID} virtualVenue=${VIRTUAL_VENUE_ID} apply=${APPLY}`)

  // eSIMs are NEVER restricted (business rule: "los eSIM sí se venden"). Resolve
  // the eSIM category ids so we can exclude them from the flagging scope.
  const esimCategories = await prisma.itemCategory.findMany({
    where: {
      OR: [{ name: { contains: 'e-sim', mode: 'insensitive' } }, { name: { contains: 'esim', mode: 'insensitive' } }],
    },
    select: { id: true, name: true },
  })
  const esimCategoryIds = esimCategories.map(c => c.id)
  logger.info(`[mark-non-virtual] eSIM categories excluded: ${esimCategories.map(c => c.name).join(', ') || '(none)'}`)

  // Items in scope: this org, AVAILABLE, NOT from the Virtual venue (incl. NULL
  // origin), and NOT an eSIM category.
  const scopeWhere = {
    organizationId: ORG_ID,
    status: 'AVAILABLE' as const,
    NOT: { registeredFromVenueId: VIRTUAL_VENUE_ID },
    categoryId: { notIn: esimCategoryIds },
  }

  const total = await prisma.serializedItem.count({ where: scopeWhere })
  const alreadyFlagged = await prisma.serializedItem.count({
    where: { ...scopeWhere, requiresOwnerApproval: true },
  })
  const toFlag = await prisma.serializedItem.count({
    where: { ...scopeWhere, requiresOwnerApproval: false },
  })

  // Sanity: how many we are intentionally NOT touching.
  const virtualUntouched = await prisma.serializedItem.count({
    where: { organizationId: ORG_ID, status: 'AVAILABLE', registeredFromVenueId: VIRTUAL_VENUE_ID },
  })
  const esimUntouched =
    esimCategoryIds.length > 0
      ? await prisma.serializedItem.count({
          where: { organizationId: ORG_ID, status: 'AVAILABLE', categoryId: { in: esimCategoryIds } },
        })
      : 0

  logger.info(`[mark-non-virtual] non-Virtual non-eSIM AVAILABLE total : ${total}`)
  logger.info(`[mark-non-virtual]   already flagged                   : ${alreadyFlagged}`)
  logger.info(`[mark-non-virtual]   to flag now                       : ${toFlag}`)
  logger.info(`[mark-non-virtual] Virtual AVAILABLE (untouched)       : ${virtualUntouched}`)
  logger.info(`[mark-non-virtual] eSIM AVAILABLE (untouched)          : ${esimUntouched}`)

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
