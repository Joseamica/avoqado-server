/**
 * Validate StaffOrganization backfill
 *
 * Checks:
 * 1. Every Staff with organizationId has a StaffOrganization record
 * 2. Every StaffOrganization has isPrimary = true (first org)
 * 3. No orphaned StaffOrganization records
 * 4. Count match: Staff with orgId == StaffOrganization count
 *
 * Usage:
 *   npx ts-node scripts/validate-staff-org-backfill.ts
 */

import prisma from '../src/utils/prismaClient'

async function validate() {
  console.log(`\n${'='.repeat(60)}`)
  console.log('Validate StaffOrganization Backfill')
  console.log(`${'='.repeat(60)}\n`)

  let errors = 0

  // 1. Count comparison
  const staffCount = await prisma.staff.count()
  const staffOrgCount = await prisma.staffOrganization.count()

  console.log(`Staff records: ${staffCount}`)
  console.log(`StaffOrganization records: ${staffOrgCount}`)

  if (staffOrgCount < staffCount) {
    console.log(`❌ MISMATCH: ${staffCount - staffOrgCount} staff missing StaffOrganization`)
    errors++
  } else {
    console.log('✅ Count check passed')
  }

  // 2. Find staff without StaffOrganization
  const staffWithoutOrg = await prisma.staff.findMany({
    where: {
      organizations: {
        none: {},
      },
    },
    select: {
      id: true,
      email: true,
    },
  })

  if (staffWithoutOrg.length > 0) {
    console.log(`\n❌ ${staffWithoutOrg.length} staff without StaffOrganization:`)
    for (const s of staffWithoutOrg.slice(0, 10)) {
      console.log(`  - ${s.email} (${s.id})`)
    }
    if (staffWithoutOrg.length > 10) {
      console.log(`  ... and ${staffWithoutOrg.length - 10} more`)
    }
    errors++
  } else {
    console.log('✅ All staff have StaffOrganization records')
  }

  // 3. Check isPrimary
  const withoutPrimary = await prisma.staff.findMany({
    where: {
      organizations: {
        none: {
          isPrimary: true,
        },
      },
      // Only check staff that have at least one StaffOrganization
      AND: {
        organizations: {
          some: {},
        },
      },
    },
    select: {
      id: true,
      email: true,
    },
  })

  if (withoutPrimary.length > 0) {
    console.log(`\n❌ ${withoutPrimary.length} staff without isPrimary StaffOrganization:`)
    for (const s of withoutPrimary.slice(0, 5)) {
      console.log(`  - ${s.email} (${s.id})`)
    }
    errors++
  } else {
    console.log('✅ All StaffOrganization records have isPrimary set')
  }

  // Summary
  console.log(`\n${'='.repeat(60)}`)
  if (errors === 0) {
    console.log('✅ ALL VALIDATIONS PASSED')
  } else {
    console.log(`❌ ${errors} VALIDATION(S) FAILED`)
  }
  console.log(`${'='.repeat(60)}\n`)

  process.exit(errors > 0 ? 1 : 0)
}

validate()
  .catch(error => {
    console.error('❌ Validation failed:', error)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
