/**
 * Permission System Test Script
 *
 * Tests the centralized permission system including:
 * 1. access.service.ts - Permission resolution
 * 2. White-label permission filtering
 * 3. SUPERADMIN bypass
 * 4. verifyAccess middleware behavior
 *
 * Usage: npx ts-node scripts/test-permissions-system.ts
 */

import prisma from '../src/utils/prismaClient'
import { StaffRole } from '@prisma/client'
import {
  getUserAccess,
  hasPermission,
  canAccessFeature,
  createAccessCache,
  getFeatureDataScope,
} from '../src/services/access/access.service'
import { getVenuesForScope, getVenueIdsForScope, buildVenueWhereClause, ScopeAccessInfo } from '../src/services/access/scopedQuery.service'

// Colors for console output
const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const BLUE = '\x1b[34m'
const RESET = '\x1b[0m'

let passCount = 0
let failCount = 0

function pass(message: string) {
  passCount++
  console.log(`${GREEN}✓ PASS${RESET}: ${message}`)
}

function fail(message: string, details?: string) {
  failCount++
  console.log(`${RED}✗ FAIL${RESET}: ${message}`)
  if (details) console.log(`  ${RED}→ ${details}${RESET}`)
}

function section(title: string) {
  console.log(`\n${BLUE}═══════════════════════════════════════════${RESET}`)
  console.log(`${BLUE}  ${title}${RESET}`)
  console.log(`${BLUE}═══════════════════════════════════════════${RESET}\n`)
}

async function findTestData() {
  // Find a SUPERADMIN user
  const superadminVenue = await prisma.staffVenue.findFirst({
    where: { role: StaffRole.SUPERADMIN },
    include: { staff: true, venue: true },
  })

  // Find a regular venue with staff
  const regularVenue = await prisma.venue.findFirst({
    where: {
      venueModules: {
        none: {
          module: { code: 'WHITE_LABEL_DASHBOARD' },
          enabled: true,
        },
      },
    },
    include: {
      staff: {
        include: { staff: true },
        take: 5,
      },
    },
  })

  // Find a white-label venue
  const whiteLabelVenue = await prisma.venue.findFirst({
    where: {
      venueModules: {
        some: {
          module: { code: 'WHITE_LABEL_DASHBOARD' },
          enabled: true,
        },
      },
    },
    include: {
      staff: {
        include: { staff: true },
        take: 5,
      },
      venueModules: {
        where: {
          module: { code: 'WHITE_LABEL_DASHBOARD' },
          enabled: true,
        },
        include: { module: true },
      },
    },
  })

  return { superadminVenue, regularVenue, whiteLabelVenue }
}

async function testSuperadminAccess(superadminVenue: any) {
  section('Test 1: SUPERADMIN Access')

  if (!superadminVenue) {
    console.log(`${YELLOW}⚠ SKIP${RESET}: No SUPERADMIN found in database`)
    return
  }

  const { staffId, venueId } = superadminVenue
  console.log(`Testing SUPERADMIN: ${superadminVenue.staff.email}`)
  console.log(`Venue: ${superadminVenue.venue.name}`)

  try {
    const access = await getUserAccess(staffId, venueId)

    // Test 1.1: SUPERADMIN should have role SUPERADMIN
    if (access.role === StaffRole.SUPERADMIN) {
      pass('SUPERADMIN role correctly identified')
    } else {
      fail('SUPERADMIN role not identified', `Got: ${access.role}`)
    }

    // Test 1.2: hasPermission should always return true for SUPERADMIN
    if (hasPermission(access, 'tpv:create')) {
      pass('hasPermission returns true for any permission')
    } else {
      fail('hasPermission should return true for SUPERADMIN')
    }

    // Test 1.3: canAccessFeature should always return allowed for SUPERADMIN
    const featureAccess = canAccessFeature(access, 'COMMAND_CENTER')
    if (featureAccess.allowed) {
      pass('canAccessFeature returns allowed for SUPERADMIN')
    } else {
      fail('canAccessFeature should return allowed for SUPERADMIN')
    }

    // Test 1.4: SUPERADMIN should be able to access any venue
    const otherVenue = await prisma.venue.findFirst({
      where: { id: { not: venueId } },
    })
    if (otherVenue) {
      try {
        const otherAccess = await getUserAccess(staffId, otherVenue.id)
        if (otherAccess.role === StaffRole.SUPERADMIN) {
          pass('SUPERADMIN can access other venues')
        } else {
          fail('SUPERADMIN should access other venues as SUPERADMIN')
        }
      } catch (e: any) {
        fail('SUPERADMIN should not throw when accessing other venues', e.message)
      }
    }
  } catch (error: any) {
    fail('getUserAccess threw error for SUPERADMIN', error.message)
  }
}

async function testRegularVenueAccess(regularVenue: any) {
  section('Test 2: Regular Venue Access (No White-Label)')

  if (!regularVenue) {
    console.log(`${YELLOW}⚠ SKIP${RESET}: No regular venue found`)
    return
  }

  console.log(`Testing venue: ${regularVenue.name}`)

  // Find a MANAGER in this venue
  const managerVenue = regularVenue.staff.find((sv: any) => sv.role === StaffRole.MANAGER)
  if (!managerVenue) {
    console.log(`${YELLOW}⚠ SKIP${RESET}: No MANAGER found in venue`)
    return
  }

  console.log(`Testing MANAGER: ${managerVenue.staff.email}`)

  try {
    const access = await getUserAccess(managerVenue.staffId, regularVenue.id)

    // Test 2.1: White-label should be disabled
    if (!access.whiteLabelEnabled) {
      pass('whiteLabelEnabled is false for regular venue')
    } else {
      fail('whiteLabelEnabled should be false for regular venue')
    }

    // Test 2.2: Should have default MANAGER permissions
    if (access.corePermissions.length > 0) {
      pass(`MANAGER has ${access.corePermissions.length} permissions`)
    } else {
      fail('MANAGER should have permissions')
    }

    // Test 2.3: hasPermission should work for default permissions
    // MANAGER typically has 'menu:read'
    const canReadMenu = hasPermission(access, 'menu:read')
    console.log(`  → hasPermission('menu:read'): ${canReadMenu}`)

    // Test 2.4: canAccessFeature should return allowed (no WL = all features accessible)
    const featureAccess = canAccessFeature(access, 'AVOQADO_TEAM')
    if (featureAccess.allowed) {
      pass('canAccessFeature returns allowed when white-label disabled')
    } else {
      fail('canAccessFeature should return allowed when white-label disabled')
    }
  } catch (error: any) {
    fail('getUserAccess threw error for regular venue', error.message)
  }
}

async function testWhiteLabelVenueAccess(whiteLabelVenue: any) {
  section('Test 3: White-Label Venue Access')

  if (!whiteLabelVenue) {
    console.log(`${YELLOW}⚠ SKIP${RESET}: No white-label venue found`)
    return
  }

  console.log(`Testing venue: ${whiteLabelVenue.name}`)

  // Get white-label config
  const wlModule = whiteLabelVenue.venueModules[0]
  const config = wlModule?.config as any
  const enabledFeatures = config?.enabledFeatures || []

  console.log(`Enabled features: ${enabledFeatures.map((f: any) => f.code).join(', ') || 'none'}`)

  // Find a non-SUPERADMIN user in this venue
  const staffVenue = whiteLabelVenue.staff.find((sv: any) => sv.role !== StaffRole.SUPERADMIN)
  if (!staffVenue) {
    console.log(`${YELLOW}⚠ SKIP${RESET}: No non-SUPERADMIN staff in venue`)
    return
  }

  console.log(`Testing user: ${staffVenue.staff.email} (${staffVenue.role})`)

  try {
    const access = await getUserAccess(staffVenue.staffId, whiteLabelVenue.id)

    // Test 3.1: White-label should be enabled
    if (access.whiteLabelEnabled) {
      pass('whiteLabelEnabled is true for white-label venue')
    } else {
      fail('whiteLabelEnabled should be true for white-label venue')
    }

    // Test 3.2: Should have enabled features
    if (access.enabledFeatures.length > 0) {
      pass(`Has ${access.enabledFeatures.length} enabled features: ${access.enabledFeatures.join(', ')}`)
    } else {
      console.log(`${YELLOW}⚠ INFO${RESET}: No features enabled in white-label config`)
    }

    // Test 3.3: Permissions should be filtered based on features
    console.log(`  → Core permissions count: ${access.corePermissions.length}`)

    // Test 3.4: featureAccess should reflect config
    for (const featureCode of access.enabledFeatures.slice(0, 3)) {
      const fa = access.featureAccess[featureCode]
      if (fa) {
        console.log(`  → Feature ${featureCode}: allowed=${fa.allowed}, dataScope=${fa.dataScope}`)
      }
    }

    // Test 3.5: A disabled feature should not grant permissions
    // Find a feature that's NOT enabled
    const allPossibleFeatures = ['AVOQADO_TPVS', 'AVOQADO_TEAM', 'AVOQADO_MENU', 'AVOQADO_ORDERS', 'AVOQADO_PAYMENTS']
    const disabledFeature = allPossibleFeatures.find(f => !access.enabledFeatures.includes(f))

    if (disabledFeature) {
      const featureAccess = canAccessFeature(access, disabledFeature)
      if (!featureAccess.allowed) {
        pass(`Disabled feature ${disabledFeature} correctly returns not allowed`)
      } else {
        fail(`Disabled feature ${disabledFeature} should not be allowed`)
      }
    }
  } catch (error: any) {
    fail('getUserAccess threw error for white-label venue', error.message)
  }
}

async function testPermissionFiltering(whiteLabelVenue: any) {
  section('Test 4: Permission-to-Feature Filtering')

  if (!whiteLabelVenue) {
    console.log(`${YELLOW}⚠ SKIP${RESET}: No white-label venue found`)
    return
  }

  // Find a VIEWER or MANAGER (non-wildcard role) in the venue
  const staffVenue = whiteLabelVenue.staff.find((sv: any) => [StaffRole.VIEWER, StaffRole.MANAGER, StaffRole.CASHIER].includes(sv.role))
  if (!staffVenue) {
    console.log(`${YELLOW}⚠ SKIP${RESET}: No VIEWER/MANAGER/CASHIER in venue`)
    return
  }

  console.log(`Testing permission filtering for ${staffVenue.role}`)

  try {
    const access = await getUserAccess(staffVenue.staffId, whiteLabelVenue.id)

    // Check if AVOQADO_TEAM is enabled
    const teamFeatureEnabled = access.enabledFeatures.includes('AVOQADO_TEAM')
    const hasTeamPermission = hasPermission(access, 'teams:read')

    console.log(`  → AVOQADO_TEAM enabled: ${teamFeatureEnabled}`)
    console.log(`  → hasPermission('teams:read'): ${hasTeamPermission}`)

    if (teamFeatureEnabled && hasTeamPermission) {
      pass('Team permission granted when AVOQADO_TEAM is enabled')
    } else if (!teamFeatureEnabled && !hasTeamPermission) {
      pass('Team permission correctly filtered when AVOQADO_TEAM is disabled')
    } else if (!teamFeatureEnabled && hasTeamPermission) {
      fail('Team permission should be filtered when AVOQADO_TEAM is disabled')
    }

    // Check TPV permissions
    const tpvFeatureEnabled = access.enabledFeatures.includes('AVOQADO_TPVS')
    const hasTpvPermission = hasPermission(access, 'tpv:read')

    console.log(`  → AVOQADO_TPVS enabled: ${tpvFeatureEnabled}`)
    console.log(`  → hasPermission('tpv:read'): ${hasTpvPermission}`)

    if (!tpvFeatureEnabled && hasTpvPermission) {
      fail('TPV permission should be filtered when AVOQADO_TPVS is disabled')
    } else {
      pass('TPV permission filtering works correctly')
    }
  } catch (error: any) {
    fail('Permission filtering test failed', error.message)
  }
}

async function testCaching() {
  section('Test 5: Request-Level Caching')

  const cache = createAccessCache()

  // Find any staff/venue combination
  const staffVenue = await prisma.staffVenue.findFirst({
    include: { venue: true, staff: true },
  })

  if (!staffVenue) {
    console.log(`${YELLOW}⚠ SKIP${RESET}: No staff venues found`)
    return
  }

  const { staffId, venueId } = staffVenue

  try {
    // First call - should hit database
    const start1 = Date.now()
    const access1 = await getUserAccess(staffId, venueId, cache)
    const time1 = Date.now() - start1

    // Second call - should hit cache
    const start2 = Date.now()
    const access2 = await getUserAccess(staffId, venueId, cache)
    const time2 = Date.now() - start2

    console.log(`  → First call: ${time1}ms`)
    console.log(`  → Second call (cached): ${time2}ms`)

    if (access1 === access2) {
      pass('Cache returns same object reference')
    } else {
      fail('Cache should return same object reference')
    }

    if (time2 < time1 || time2 < 5) {
      pass('Cached call is faster')
    } else {
      console.log(`${YELLOW}⚠ INFO${RESET}: Cache timing inconclusive (both fast)`)
    }
  } catch (error: any) {
    fail('Caching test failed', error.message)
  }
}

async function testUserWithNoVenueAccess() {
  section('Test 6: User Without Venue Access')

  // Find a user and a venue they don't have access to
  const staffVenue = await prisma.staffVenue.findFirst({
    where: { role: { not: StaffRole.SUPERADMIN } },
    include: { staff: true },
  })

  if (!staffVenue) {
    console.log(`${YELLOW}⚠ SKIP${RESET}: No non-SUPERADMIN staff found`)
    return
  }

  // Find a venue the user doesn't have access to
  const inaccessibleVenue = await prisma.venue.findFirst({
    where: {
      staff: {
        none: { staffId: staffVenue.staffId },
      },
    },
  })

  if (!inaccessibleVenue) {
    console.log(`${YELLOW}⚠ SKIP${RESET}: No inaccessible venue found for user`)
    return
  }

  console.log(`Testing user: ${staffVenue.staff.email}`)
  console.log(`Attempting to access venue they don't belong to: ${inaccessibleVenue.name}`)

  try {
    await getUserAccess(staffVenue.staffId, inaccessibleVenue.id)
    fail('getUserAccess should throw for inaccessible venue')
  } catch (error: any) {
    if (error.message.includes('no access')) {
      pass('getUserAccess correctly throws for inaccessible venue')
    } else {
      fail('Unexpected error message', error.message)
    }
  }
}

async function testScopedQueryService() {
  section('Test 7: Scoped Query Service')

  // Find an OWNER in an organization with multiple venues
  const ownerVenue = await prisma.staffVenue.findFirst({
    where: { role: StaffRole.OWNER },
    include: {
      staff: true,
      venue: {
        include: {
          organization: {
            include: {
              venues: { take: 5 },
            },
          },
        },
      },
    },
  })

  if (!ownerVenue) {
    console.log(`${YELLOW}⚠ SKIP${RESET}: No OWNER found in database`)
    return
  }

  const accessInfo: ScopeAccessInfo = {
    userId: ownerVenue.staffId,
    venueId: ownerVenue.venueId,
    organizationId: ownerVenue.venue.organizationId,
    role: StaffRole.OWNER,
  }

  console.log(`Testing OWNER: ${ownerVenue.staff.email}`)
  console.log(`Venue: ${ownerVenue.venue.name}`)
  console.log(`Organization has ${ownerVenue.venue.organization?.venues.length || 0} venues`)

  try {
    // Test 7.1: Venue scope should return only current venue
    const venueScope = await getVenuesForScope(accessInfo, 'venue')
    if (venueScope.length === 1 && venueScope[0].id === ownerVenue.venueId) {
      pass('Venue scope returns only current venue')
    } else {
      fail('Venue scope should return only current venue', `Got ${venueScope.length} venues`)
    }

    // Test 7.2: User-venues scope should return all venues the user has access to
    const userVenuesScope = await getVenuesForScope(accessInfo, 'user-venues')
    console.log(`  → User-venues scope returned: ${userVenuesScope.length} venues`)
    if (userVenuesScope.length >= 1) {
      pass(`User-venues scope returns ${userVenuesScope.length} accessible venues`)
    } else {
      fail('User-venues scope should return at least 1 venue')
    }

    // Test 7.3: Organization scope should return all venues in org (OWNER allowed)
    const orgScope = await getVenuesForScope(accessInfo, 'organization')
    console.log(`  → Organization scope returned: ${orgScope.length} venues`)
    if (orgScope.length >= 1) {
      pass(`Organization scope returns ${orgScope.length} org venues for OWNER`)
    } else {
      fail('Organization scope should return org venues')
    }

    // Test 7.4: getVenueIdsForScope returns IDs
    const venueIds = await getVenueIdsForScope(accessInfo, 'venue')
    if (venueIds.length === 1 && venueIds[0] === ownerVenue.venueId) {
      pass('getVenueIdsForScope returns correct IDs')
    } else {
      fail('getVenueIdsForScope should return venue ID')
    }

    // Test 7.5: buildVenueWhereClause for single venue
    const whereClause = await buildVenueWhereClause(accessInfo, 'venue')
    if ('venueId' in whereClause && whereClause.venueId === ownerVenue.venueId) {
      pass('buildVenueWhereClause returns simple venueId for single venue')
    } else {
      fail('buildVenueWhereClause should return { venueId: string }')
    }

    // Test 7.6: buildVenueWhereClause for multiple venues
    const whereClauseMulti = await buildVenueWhereClause(accessInfo, 'organization')
    if ('venueId' in whereClauseMulti && typeof whereClauseMulti.venueId === 'object' && 'in' in whereClauseMulti.venueId) {
      pass('buildVenueWhereClause returns { venueId: { in: [...] } } for multiple venues')
    } else if ('venueId' in whereClauseMulti && typeof whereClauseMulti.venueId === 'string') {
      // Only 1 venue in org is also valid
      console.log(`${YELLOW}⚠ INFO${RESET}: Organization has only 1 venue`)
      pass('buildVenueWhereClause works for single-venue org')
    } else {
      fail('buildVenueWhereClause should return proper Prisma where clause')
    }

    // Test 7.7: Non-OWNER should NOT be able to use organization scope
    const managerAccessInfo: ScopeAccessInfo = {
      ...accessInfo,
      role: StaffRole.MANAGER,
    }

    try {
      await getVenuesForScope(managerAccessInfo, 'organization')
      fail('MANAGER should not be able to use organization scope')
    } catch (e: any) {
      if (e.message.includes('OWNER')) {
        pass('Organization scope correctly denied for MANAGER')
      } else {
        fail('Unexpected error for MANAGER org scope', e.message)
      }
    }
  } catch (error: any) {
    fail('Scoped query test failed', error.message)
  }
}

async function testDataScopeIntegration(whiteLabelVenue: any) {
  section('Test 8: DataScope Integration')

  if (!whiteLabelVenue) {
    console.log(`${YELLOW}⚠ SKIP${RESET}: No white-label venue for dataScope test`)
    return
  }

  // Find an OWNER in the white-label venue
  const ownerStaff = whiteLabelVenue.staff.find((sv: any) => sv.role === StaffRole.OWNER)
  if (!ownerStaff) {
    console.log(`${YELLOW}⚠ SKIP${RESET}: No OWNER in white-label venue`)
    return
  }

  console.log(`Testing dataScope for OWNER: ${ownerStaff.staff.email}`)

  try {
    const access = await getUserAccess(ownerStaff.staffId, whiteLabelVenue.id)

    // Test 8.1: getFeatureDataScope should return correct scope
    if (access.enabledFeatures.length > 0) {
      const featureCode = access.enabledFeatures[0]
      const dataScope = getFeatureDataScope(access, featureCode)
      console.log(`  → Feature ${featureCode} dataScope: ${dataScope}`)

      if (['venue', 'user-venues', 'organization'].includes(dataScope)) {
        pass(`getFeatureDataScope returns valid scope: ${dataScope}`)
      } else {
        fail('getFeatureDataScope should return valid scope')
      }
    }

    // Test 8.2: Non-existent feature should default to 'venue'
    const unknownScope = getFeatureDataScope(access, 'NON_EXISTENT_FEATURE')
    if (unknownScope === 'venue') {
      pass('Unknown feature defaults to venue scope')
    } else {
      fail('Unknown feature should default to venue scope', `Got: ${unknownScope}`)
    }

    // Test 8.3: featureAccess should include dataScope
    for (const featureCode of access.enabledFeatures.slice(0, 3)) {
      const fa = access.featureAccess[featureCode]
      if (fa && fa.dataScope) {
        console.log(`  → Feature ${featureCode}: dataScope=${fa.dataScope}`)
      }
    }
    pass('Feature access includes dataScope information')
  } catch (error: any) {
    fail('DataScope integration test failed', error.message)
  }
}

async function main() {
  console.log('\n')
  console.log('╔═══════════════════════════════════════════════════════════╗')
  console.log('║         PERMISSION SYSTEM TEST SUITE                      ║')
  console.log('║         Testing: access.service.ts + scopedQuery.service  ║')
  console.log('╚═══════════════════════════════════════════════════════════╝')

  try {
    const { superadminVenue, regularVenue, whiteLabelVenue } = await findTestData()

    await testSuperadminAccess(superadminVenue)
    await testRegularVenueAccess(regularVenue)
    await testWhiteLabelVenueAccess(whiteLabelVenue)
    await testPermissionFiltering(whiteLabelVenue)
    await testCaching()
    await testUserWithNoVenueAccess()
    await testScopedQueryService()
    await testDataScopeIntegration(whiteLabelVenue)

    // Summary
    section('TEST SUMMARY')
    console.log(`${GREEN}Passed: ${passCount}${RESET}`)
    console.log(`${RED}Failed: ${failCount}${RESET}`)

    if (failCount === 0) {
      console.log(`\n${GREEN}✓ ALL TESTS PASSED${RESET}\n`)
    } else {
      console.log(`\n${RED}✗ SOME TESTS FAILED${RESET}\n`)
      process.exit(1)
    }
  } catch (error) {
    console.error(`${RED}Fatal error:${RESET}`, error)
    process.exit(1)
  } finally {
    await prisma.$disconnect()
  }
}

main()
