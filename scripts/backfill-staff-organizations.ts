/**
 * Backfill StaffOrganization records from StaffVenue → Venue → organizationId
 *
 * This script reads all Staff records, derives their organization from their
 * venue assignments, and creates StaffOrganization junction table entries.
 *
 * OrgRole is determined by the staff's highest role across their StaffVenue records:
 * - OWNER/SUPERADMIN → OrgRole.OWNER
 * - ADMIN → OrgRole.ADMIN
 * - Everything else → OrgRole.MEMBER
 *
 * Usage:
 *   npx ts-node scripts/backfill-staff-organizations.ts
 *
 * Dry run:
 *   DRY_RUN=true npx ts-node scripts/backfill-staff-organizations.ts
 *
 * Rollback:
 *   DELETE FROM "StaffOrganization"
 */

import prisma from '../src/utils/prismaClient'
import { OrgRole, StaffRole } from '@prisma/client'

const DRY_RUN = process.env.DRY_RUN === 'true'

// Map StaffRole to OrgRole based on hierarchy
function mapStaffRoleToOrgRole(staffRoles: StaffRole[]): OrgRole {
  if (staffRoles.includes(StaffRole.OWNER) || staffRoles.includes(StaffRole.SUPERADMIN)) {
    return OrgRole.OWNER
  }
  if (staffRoles.includes(StaffRole.ADMIN)) {
    return OrgRole.ADMIN
  }
  return OrgRole.MEMBER
}

async function backfillStaffOrganizations() {
  console.log(`\n${'='.repeat(60)}`)
  console.log('Backfill StaffOrganization Records')
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`)
  console.log(`${'='.repeat(60)}\n`)

  // 1. Check existing StaffOrganization count
  const existingCount = await prisma.staffOrganization.count()
  console.log(`Existing StaffOrganization records: ${existingCount}`)

  if (existingCount > 0) {
    console.log('\nStaffOrganization records already exist.')
    console.log('Continuing to fill any missing records...\n')
  }

  // 2. Get all staff with their venue assignments (to derive org from venue)
  const allStaff = await prisma.staff.findMany({
    include: {
      venues: {
        where: { active: true },
        select: {
          role: true,
          venue: {
            select: {
              organizationId: true,
            },
          },
        },
      },
    },
  })

  console.log(`Total staff records: ${allStaff.length}`)

  // 3. Get existing StaffOrganization to avoid duplicates
  const existingMemberships = await prisma.staffOrganization.findMany({
    select: {
      staffId: true,
      organizationId: true,
    },
  })

  const existingSet = new Set(existingMemberships.map(m => `${m.staffId}-${m.organizationId}`))

  // 4. Build records to create
  let created = 0
  let skipped = 0
  let noOrg = 0

  for (const staff of allStaff) {
    // Derive unique organizations from venue assignments
    const orgMap = new Map<string, StaffRole[]>()
    for (const sv of staff.venues) {
      const orgId = sv.venue.organizationId
      if (!orgMap.has(orgId)) {
        orgMap.set(orgId, [])
      }
      orgMap.get(orgId)!.push(sv.role)
    }

    if (orgMap.size === 0) {
      noOrg++
      continue
    }

    let isFirst = true
    for (const [orgId, roles] of orgMap) {
      const key = `${staff.id}-${orgId}`
      if (existingSet.has(key)) {
        skipped++
        continue
      }

      const orgRole = mapStaffRoleToOrgRole(roles)

      if (!DRY_RUN) {
        await prisma.staffOrganization.create({
          data: {
            staffId: staff.id,
            organizationId: orgId,
            role: orgRole,
            isActive: true,
            isPrimary: isFirst, // First org is primary
            joinedAt: new Date(),
          },
        })
      }

      isFirst = false
      created++
    }
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`Results:`)
  console.log(`  Created: ${created}`)
  console.log(`  Skipped (already exist): ${skipped}`)
  console.log(`  No venue/org: ${noOrg}`)
  console.log(`  Total staff: ${allStaff.length}`)
  console.log(`${'='.repeat(60)}\n`)

  if (DRY_RUN) {
    console.log('DRY RUN - No records were created. Run without DRY_RUN=true to apply.')
  } else {
    console.log('Backfill complete.')
  }
}

backfillStaffOrganizations()
  .catch(error => {
    console.error('Backfill failed:', error)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
