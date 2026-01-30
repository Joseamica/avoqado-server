/**
 * Pre-Launch User Flow Tests
 *
 * Simulates real user scenarios to catch bugs that code audits miss.
 * Run: npx ts-node scripts/test-user-flows.ts
 */

import { PrismaClient, VenueStatus, StaffRole } from '@prisma/client'
import { OPERATIONAL_VENUE_STATUSES } from '../src/lib/venueStatus.constants'

const prisma = new PrismaClient()

interface TestResult {
  test: string
  passed: boolean
  details: string
}

const results: TestResult[] = []

function test(name: string, passed: boolean, details: string) {
  results.push({ test: name, passed, details })
  const icon = passed ? '✅' : '❌'
  console.log(`${icon} ${name}`)
  if (!passed || details) console.log(`   ${details}`)
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════')
  console.log('  PRE-LAUNCH USER FLOW TESTS')
  console.log('═══════════════════════════════════════════════════════════════\n')

  // ============================================
  // TEST 1: Venue Status Distribution
  // ============================================
  console.log('📋 1. VENUE STATUS DISTRIBUTION\n')

  const venuesByStatus = await prisma.venue.groupBy({
    by: ['status'],
    _count: { status: true },
  })

  console.log('   Current venues:')
  venuesByStatus.forEach(v => console.log(`   - ${v.status}: ${v._count.status}`))

  const hasTrialVenues = venuesByStatus.some(v => v.status === 'TRIAL' && v._count.status > 0)
  const hasActiveVenues = venuesByStatus.some(v => v.status === 'ACTIVE' && v._count.status > 0)

  test('Has TRIAL venues to test with', hasTrialVenues, hasTrialVenues ? '' : 'Create a TRIAL venue for testing!')
  test('Has ACTIVE venues to test with', hasActiveVenues, '')

  // ============================================
  // TEST 2: SUPERADMIN Access
  // ============================================
  console.log('\n📋 2. SUPERADMIN ACCESS SIMULATION\n')

  const superadmin = await prisma.staff.findFirst({
    where: { venues: { some: { role: StaffRole.SUPERADMIN } } },
    include: {
      venues: {
        where: { active: true },
        include: { venue: { select: { id: true, name: true, status: true } } },
      },
    },
  })

  if (superadmin) {
    // Simulate what getAuthStatus does for SUPERADMIN
    const allOperationalVenues = await prisma.venue.findMany({
      where: { status: { in: OPERATIONAL_VENUE_STATUSES } },
      select: { id: true, name: true, status: true },
    })

    const trialVenuesVisible = allOperationalVenues.filter(v => v.status === 'TRIAL')
    const activeVenuesVisible = allOperationalVenues.filter(v => v.status === 'ACTIVE')

    console.log(`   SUPERADMIN (${superadmin.email}) would see:`)
    allOperationalVenues.forEach(v => console.log(`   - ${v.name} (${v.status})`))

    test(
      'SUPERADMIN sees TRIAL venues',
      trialVenuesVisible.length > 0 || !hasTrialVenues,
      trialVenuesVisible.length > 0 ? `${trialVenuesVisible.length} TRIAL venues visible` : 'No TRIAL venues exist',
    )
    test('SUPERADMIN sees ACTIVE venues', activeVenuesVisible.length > 0, `${activeVenuesVisible.length} ACTIVE venues visible`)
  } else {
    test('SUPERADMIN exists', false, 'No SUPERADMIN user found!')
  }

  // ============================================
  // TEST 3: OWNER Access (Organization Scope)
  // ============================================
  console.log('\n📋 3. OWNER ACCESS SIMULATION\n')

  const owners = await prisma.staff.findMany({
    where: { venues: { some: { role: StaffRole.OWNER } } },
    include: {
      organizations: {
        include: { organization: { select: { id: true, name: true } } },
        take: 1,
      },
      venues: {
        where: { active: true, role: StaffRole.OWNER },
        include: { venue: { select: { name: true, status: true } } },
      },
    },
    take: 3, // Check first 3 owners
  })

  for (const owner of owners) {
    // Simulate what getAuthStatus does for OWNER
    const orgId = owner.organizations[0]?.organizationId
    const orgName = owner.organizations[0]?.organization?.name

    const orgVenues = orgId
      ? await prisma.venue.findMany({
          where: { organizationId: orgId, active: true },
          select: { id: true, name: true, status: true },
        })
      : []

    console.log(`   OWNER ${owner.email} (Org: ${orgName}):`)
    orgVenues.forEach(v => console.log(`   - ${v.name} (${v.status})`))

    test(`OWNER ${owner.email} sees all org venues`, orgVenues.length >= owner.venues.length, `${orgVenues.length} venues in org`)
  }

  // ============================================
  // TEST 4: Login Filter Consistency
  // ============================================
  console.log('\n📋 4. LOGIN FILTER CHECK\n')

  const allStaffWithVenues = await prisma.staff.findMany({
    where: { venues: { some: { active: true } } },
    include: {
      venues: {
        where: { active: true },
        include: { venue: { select: { status: true, name: true } } },
      },
    },
    take: 10,
  })

  let usersWithOnlyNonOperationalVenues = 0

  for (const staff of allStaffWithVenues) {
    const operationalVenues = staff.venues.filter(sv => OPERATIONAL_VENUE_STATUSES.includes(sv.venue.status))

    if (operationalVenues.length === 0 && staff.venues.length > 0) {
      usersWithOnlyNonOperationalVenues++
      console.log(`   ⚠️ ${staff.email} has ${staff.venues.length} venues but 0 operational`)
    }
  }

  test(
    'No users locked out due to non-operational venues',
    usersWithOnlyNonOperationalVenues === 0,
    usersWithOnlyNonOperationalVenues > 0 ? `${usersWithOnlyNonOperationalVenues} users affected` : '',
  )

  // ============================================
  // TEST 5: StaffVenue Integrity
  // ============================================
  console.log('\n📋 5. STAFFVENUE INTEGRITY\n')

  const orphanedStaffVenues = await prisma.staffVenue.count({
    where: {
      active: true,
      venue: { active: false },
    },
  })

  test(
    'No active StaffVenue pointing to inactive Venue',
    orphanedStaffVenues === 0,
    orphanedStaffVenues > 0 ? `${orphanedStaffVenues} orphaned relationships!` : '',
  )

  const inconsistentStatus = await prisma.venue.count({
    where: {
      active: true,
      status: { notIn: OPERATIONAL_VENUE_STATUSES },
    },
  })

  test(
    'Venue.active matches status',
    inconsistentStatus === 0,
    inconsistentStatus > 0 ? `${inconsistentStatus} venues have active=true but non-operational status!` : '',
  )

  // ============================================
  // SUMMARY
  // ============================================
  console.log('\n═══════════════════════════════════════════════════════════════')
  console.log('  SUMMARY')
  console.log('═══════════════════════════════════════════════════════════════\n')

  const passed = results.filter(r => r.passed).length
  const failed = results.filter(r => !r.passed).length

  console.log(`   Total: ${results.length}`)
  console.log(`   ✅ Passed: ${passed}`)
  console.log(`   ❌ Failed: ${failed}`)

  if (failed > 0) {
    console.log('\n   ⚠️ FAILURES FOUND - FIX BEFORE LAUNCH!')
    results
      .filter(r => !r.passed)
      .forEach(r => {
        console.log(`   - ${r.test}: ${r.details}`)
      })
  } else {
    console.log('\n   🎉 ALL TESTS PASSED!')
  }

  console.log('\n═══════════════════════════════════════════════════════════════')
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
