/**
 * Cleanup: PlayTelecom ex-collaborators & ex-promoters
 * Asana: https://app.asana.com/1/12709793723059/project/1213523434401320/task/1215884464715725
 *
 * Removes 18 users from the PlayTelecom org while PRESERVING all sales history:
 *   - HARD DELETE (11): accounts with ZERO sales/financial/data footprint
 *     (test/junk + back-office who never sold). Verified at runtime to have no
 *     blocking references before each delete — the script SKIPS any account that
 *     has gained a sales reference, so it can never destroy data.
 *   - SOFT DELETE (7): accounts that carry sales history (orders, payments,
 *     SaleVerifications, SIMs). Deactivated like the dashboard's "remove member":
 *     StaffOrganization.isActive=false + leftAt, every PlayTelecom StaffVenue
 *     active=false + endDate, and Staff.active=false. Fully reversible; 100% of
 *     sales rows stay attributed via Staff.id.
 *
 * DRY RUN by default. Pass --confirm to apply.
 *
 * Run against PRODUCTION (the org lives only in prod):
 *   cd avoqado-server
 *   export $(grep -E '^RENDER_DATABASE_URL=' .env | sed 's/"//g')
 *   DATABASE_URL="$RENDER_DATABASE_URL" tsx scripts/cleanup-playtelecom-users.ts            # dry run
 *   DATABASE_URL="$RENDER_DATABASE_URL" tsx scripts/cleanup-playtelecom-users.ts --confirm  # apply
 */

import prisma from '../src/utils/prismaClient'
import { logAction } from '../src/services/dashboard/activity-log.service'

const ORG_ID = 'cmietitbn000zpr2d8213qkzq' // PlayTelecom (production)
// Actor recorded in the audit trail (jose amieva / devjamica@gmail.com). Override with PERFORMED_BY=<staffId>.
const PERFORMED_BY = process.env.PERFORMED_BY || 'cmkfzy25903j7lg28lely51d8'

const APPLY = process.argv.includes('--confirm')

// Accounts with zero footprint → safe to remove permanently.
const HARD_DELETE: Array<{ id: string; name: string }> = [
  { id: 'cmltz5ztu002woq2892xx3scl', name: 'a a' },
  { id: 'cmm9od65c0010op28lyv5eq2b', name: 'bae seminario 2939' },
  { id: 'cmnqgk15700pqrp1qi5vt8iw7', name: 'Test Test' },
  { id: 'cmouix41o000enb27oc4c31ct', name: 'edgar tpv' },
  { id: 'cmmwt9pvn00mwmo287ada5myz', name: 'Daniel Rojas' },
  { id: 'cmmwt7m8k00f0mo288te3tazv', name: 'Gabriela Ortiz' },
  { id: 'cmmwh9qlu0004mo28zoa618d1', name: 'Isaac J M Navarro' },
  { id: 'cmkyppjg7000ht71qb2b681op', name: 'Jordi Mota' },
  { id: 'cmn7w1pps00gtrf2cxl5j894x', name: 'Juan Jose Montes' },
  { id: 'cmm15vo5c001an828dhpbt095', name: 'Luis Perez' },
  { id: 'cmmwt8ut500ixmo28w39jl3th', name: 'Neymi Rocha' },
]

// Accounts that carry sales history → soft delete only (preserve history).
const SOFT_DELETE: Array<{ id: string; name: string }> = [
  { id: 'cmn6jzm4x00gsny28rll09geg', name: 'Carlos Alejo' },
  { id: 'cmn6kaylf00kwny28mja25zbc', name: 'Claudia Velázquez' },
  { id: 'cmn7vwt5l00gkrf2cyce91q4b', name: 'Cristina Franco' },
  { id: 'cmn6k1h5800h5ny28uhck4gl2', name: 'Efraín Castañeda' },
  { id: 'cytgy6n8cl27nnnwi3g4f8ida', name: 'Ignacio Mitre' },
  { id: 'cmnxvdbp1042tqi2dvm159q9r', name: 'Juan Carlos Vargas' },
  { id: 'cmn6jqtw800eyny28ud4pliqe', name: 'Nancy Joselyn López' },
]

function maskedHost(): string {
  const url = process.env.DATABASE_URL || ''
  const m = url.match(/@([^/:]+)/)
  return m ? m[1] : '(unknown)'
}

// Count references that would either block a hard delete or destroy
// sales/financial data on cascade. If any > 0, the account is NOT empty and
// must not be hard-deleted.
async function blockingRefs(staffId: string): Promise<Record<string, number>> {
  const [
    ordersCreated,
    ordersServed,
    payments,
    verifsPromoter,
    verifsReviewer,
    shifts,
    orderActions,
    commissionPayouts,
    commissionCalcs,
    serializedItems,
    invitations,
    terminalOrders,
    cashDeposits,
    paymentLinks,
    milestones,
  ] = await Promise.all([
    prisma.order.count({ where: { createdById: staffId } }),
    prisma.order.count({ where: { servedById: staffId } }),
    prisma.payment.count({ where: { processedById: staffId } }),
    prisma.saleVerification.count({ where: { staffId } }),
    prisma.saleVerification.count({ where: { reviewedById: staffId } }),
    prisma.shift.count({ where: { staffId } }),
    prisma.orderAction.count({ where: { performedById: staffId } }),
    prisma.commissionPayout.count({ where: { OR: [{ staffId }, { processedById: staffId }] } }),
    prisma.commissionCalculation.count({ where: { staffId } }),
    prisma.serializedItem.count({
      where: { OR: [{ assignedPromoterId: staffId }, { assignedSupervisorId: staffId }] },
    }),
    prisma.invitation.count({ where: { invitedById: staffId } }),
    prisma.terminalOrder.count({ where: { createdById: staffId } }),
    prisma.cashDeposit.count({ where: { OR: [{ staffId }, { approvedById: staffId }] } }),
    prisma.paymentLink.count({ where: { createdById: staffId } }),
    prisma.milestoneAchievement.count({ where: { staffId } }),
  ])

  const refs = {
    ordersCreated,
    ordersServed,
    payments,
    verifsPromoter,
    verifsReviewer,
    shifts,
    orderActions,
    commissionPayouts,
    commissionCalcs,
    serializedItems,
    invitations,
    terminalOrders,
    cashDeposits,
    paymentLinks,
    milestones,
  }
  return Object.fromEntries(Object.entries(refs).filter(([, n]) => n > 0))
}

async function resolveStaff(id: string, expectedName: string) {
  const staff = await prisma.staff.findUnique({
    where: { id },
    include: { organizations: { where: { organizationId: ORG_ID } } },
  })
  if (!staff) return { ok: false as const, reason: 'NOT_FOUND' }
  const name = `${staff.firstName} ${staff.lastName}`
  if (name.trim() !== expectedName.trim()) {
    return { ok: false as const, reason: `NAME_MISMATCH (db="${name}" expected="${expectedName}")` }
  }
  if (staff.organizations.length === 0) {
    return { ok: false as const, reason: 'NOT_IN_PLAYTELECOM_ORG' }
  }
  return { ok: true as const, staff, membership: staff.organizations[0] }
}

async function main() {
  console.log('='.repeat(72))
  console.log(`PlayTelecom user cleanup — ${APPLY ? '🔴 APPLY (--confirm)' : '🟡 DRY RUN'}`)
  console.log(`DB host : ${maskedHost()}`)
  console.log(`Org     : ${ORG_ID}`)
  console.log(`Actor   : ${PERFORMED_BY}`)
  console.log('='.repeat(72))

  // ---- SOFT DELETE (7, keep sales history) ----
  console.log(`\n── SOFT DELETE (${SOFT_DELETE.length}) — deactivate, preserve sales ──`)
  for (const { id, name } of SOFT_DELETE) {
    const r = await resolveStaff(id, name)
    if (!r.ok) {
      console.log(`  ⚠️  SKIP ${name} (${id}): ${r.reason}`)
      continue
    }
    const refs = await blockingRefs(id)
    const footprint = Object.entries(refs)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')
    console.log(`  • ${name} (${id})  [${footprint || 'no refs'}]`)

    if (!APPLY) continue

    await prisma.$transaction(async tx => {
      await tx.staffOrganization.update({
        where: { staffId_organizationId: { staffId: id, organizationId: ORG_ID } },
        data: { isActive: false, leftAt: new Date() },
      })
      const orgVenues = await tx.venue.findMany({ where: { organizationId: ORG_ID }, select: { id: true } })
      const venueIds = orgVenues.map(v => v.id)
      if (venueIds.length > 0) {
        await tx.staffVenue.updateMany({
          where: { staffId: id, venueId: { in: venueIds }, active: true },
          data: { active: false, endDate: new Date() },
        })
      }
      await tx.staff.update({ where: { id }, data: { active: false } })
    })
    await logAction({
      staffId: PERFORMED_BY,
      venueId: null,
      action: 'STAFF_ROLE_REMOVED',
      entity: 'Staff',
      entityId: id,
      data: { organizationId: ORG_ID, role: r.membership.role, reason: 'asana-1215884464715725-cleanup', mode: 'soft-delete' },
    })
    console.log(`    ✅ deactivated`)
  }

  // ---- HARD DELETE (11, zero footprint) ----
  console.log(`\n── HARD DELETE (${HARD_DELETE.length}) — only if zero footprint at runtime ──`)
  for (const { id, name } of HARD_DELETE) {
    const r = await resolveStaff(id, name)
    if (!r.ok) {
      console.log(`  ⚠️  SKIP ${name} (${id}): ${r.reason}`)
      continue
    }
    const refs = await blockingRefs(id)
    if (Object.keys(refs).length > 0) {
      const footprint = Object.entries(refs)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')
      console.log(`  ⛔ SKIP ${name} (${id}): now has data [${footprint}] → soft-delete manually instead`)
      continue
    }
    console.log(`  • ${name} (${id}) <${r.staff.email}>  [empty — safe to delete]`)

    if (!APPLY) continue

    // Audit BEFORE the row disappears.
    await logAction({
      staffId: PERFORMED_BY,
      venueId: null,
      action: 'STAFF_DELETED',
      entity: 'Staff',
      entityId: id,
      data: { email: r.staff.email, organizationId: ORG_ID, reason: 'asana-1215884464715725-cleanup', mode: 'hard-delete' },
    })
    await prisma.staff.delete({ where: { id } })
    console.log(`    ✅ deleted`)
  }

  if (!APPLY) {
    console.log(`\n🟡 DRY RUN complete — nothing changed. Re-run with --confirm to apply.`)
  } else {
    console.log(`\n✅ Cleanup applied.`)
  }
}

main()
  .catch(e => {
    console.error('❌ Cleanup failed:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
