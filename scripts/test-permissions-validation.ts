/**
 * Manual test script for permission validation features
 * Run with: npx ts-node -r tsconfig-paths/register scripts/test-permissions-validation.ts
 */

import prisma from '../src/utils/prismaClient'
import {
  updateRolePermissions,
  getAllRolePermissions,
  deleteRolePermissions,
} from '../src/services/dashboard/rolePermission.service'
import { StaffRole } from '@prisma/client'

async function testPermissionValidation() {
  console.log('🧪 Testing Permission Validation Features\n')

  // Get test data from seed
  const venue = await prisma.venue.findFirst()
  if (!venue) {
    console.error('❌ No venue found. Run: npm run seed')
    process.exit(1)
  }

  const owner = await prisma.staff.findFirst({
    where: {
      venues: { some: { venueId: venue.id, role: StaffRole.OWNER } },
    },
  })

  const admin = await prisma.staff.findFirst({
    where: {
      venues: { some: { venueId: venue.id, role: StaffRole.ADMIN } },
    },
  })

  if (!owner || !admin) {
    console.error('❌ No OWNER or ADMIN found. Run: npm run seed')
    process.exit(1)
  }

  console.log(`✅ Test data ready:`)
  console.log(`   Venue: ${venue.name} (${venue.id})`)
  console.log(`   OWNER: ${owner.firstName} ${owner.lastName} (${owner.id})`)
  console.log(`   ADMIN: ${admin.firstName} ${admin.lastName} (${admin.id})\n`)

  // TEST 1: Typo Detection
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('TEST 1: Typo Detection & Warnings')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

  console.log('📝 Attempting to save permissions with typos for MANAGER role...')
  try {
    await updateRolePermissions(
      venue.id,
      StaffRole.MANAGER,
      [
        'orders:read',
        'menu:reads', // ⚠️ Typo: should be "menu:read"
        'tpv:deletes', // ⚠️ Typo: should be "tpv:delete"
        'payments:create',
      ],
      owner.id,
      StaffRole.OWNER,
    )
    console.log('✅ Permissions saved (with warnings logged)')
    console.log('   Check logs above for warning messages ⬆️\n')
  } catch (error: any) {
    console.log(`❌ Failed: ${error.message}\n`)
  }

  // TEST 2: Invalid Format (should block)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('TEST 2: Invalid Permission Format (Should Block)')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

  console.log('📝 Attempting to save invalid permission format...')
  try {
    await updateRolePermissions(
      venue.id,
      StaffRole.MANAGER,
      [
        'orders:read',
        'invalidformat', // ❌ Invalid: no colon
        'menu:', // ❌ Invalid: missing action
      ],
      owner.id,
      StaffRole.OWNER,
    )
    console.log('❌ Should have been blocked!\n')
  } catch (error: any) {
    console.log(`✅ Correctly blocked: ${error.message}\n`)
  }

  // TEST 3: Override Mode - ADMIN trying to modify OWNER (should block)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('TEST 3: Override Mode - ADMIN → OWNER (Should Block)')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

  console.log('📝 ADMIN attempting to customize OWNER permissions...')
  try {
    await updateRolePermissions(
      venue.id,
      StaffRole.OWNER,
      ['orders:read', 'payments:read'], // Restrict OWNER to just 2 permissions
      admin.id,
      StaffRole.ADMIN,
    )
    console.log('❌ Should have been blocked!\n')
  } catch (error: any) {
    console.log(`✅ Correctly blocked: ${error.message}\n`)
  }

  // TEST 4: Override Mode - OWNER customizing OWNER (should allow)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('TEST 4: Override Mode - OWNER → OWNER (Should Allow)')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

  console.log('📝 OWNER customizing OWNER permissions (override mode)...')
  try {
    await updateRolePermissions(
      venue.id,
      StaffRole.OWNER,
      ['orders:read', 'payments:read', 'settings:manage', 'settings:read', 'teams:read', 'teams:update'], // Must include critical perms
      owner.id,
      StaffRole.OWNER,
    )
    console.log('✅ Override mode activated successfully')
    console.log('   Check logs above for info message ⬆️\n')
  } catch (error: any) {
    console.log(`❌ Failed: ${error.message}\n`)
  }

  // TEST 5: Self-lockout protection (should block)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('TEST 5: Self-Lockout Protection (Should Block)')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

  console.log('📝 OWNER trying to remove critical permissions from own role...')
  try {
    await updateRolePermissions(
      venue.id,
      StaffRole.OWNER,
      ['orders:read', 'payments:read'], // Missing settings:manage!
      owner.id,
      StaffRole.OWNER,
    )
    console.log('❌ Should have been blocked!\n')
  } catch (error: any) {
    console.log(`✅ Correctly blocked: ${error.message}\n`)
  }

  // ═══════════════════════════════════════════════
  // REGRESSION TESTS - Ensure existing functionality still works
  // ═══════════════════════════════════════════════

  console.log('\n')
  console.log('═══════════════════════════════════════════════')
  console.log('🔄 REGRESSION TESTS - Existing Functionality')
  console.log('═══════════════════════════════════════════════\n')

  // TEST 6: Normal permission update (no typos, no override mode)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('TEST 6: Regression - Normal Permission Update')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

  console.log('📝 OWNER updating CASHIER permissions with valid permissions...')
  try {
    const result = await updateRolePermissions(
      venue.id,
      StaffRole.CASHIER,
      ['orders:read', 'orders:create', 'payments:read', 'payments:create', 'tpv:read'],
      owner.id,
      StaffRole.OWNER,
    )
    if (result.isCustom && result.permissions.length === 5) {
      console.log('✅ Normal update works correctly')
      console.log(`   Custom permissions: ${result.permissions.length} permissions\n`)
    } else {
      console.log('❌ Unexpected result structure\n')
    }
  } catch (error: any) {
    console.log(`❌ Failed: ${error.message}\n`)
  }

  // TEST 7: MANAGER can modify WAITER (basic hierarchy)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('TEST 7: Regression - MANAGER → WAITER Hierarchy')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

  console.log('📝 MANAGER updating WAITER permissions...')
  try {
    const result = await updateRolePermissions(
      venue.id,
      StaffRole.WAITER,
      ['orders:read', 'orders:create', 'menu:read', 'tables:read'],
      admin.id, // Using admin as MANAGER equivalent (both can modify WAITER)
      StaffRole.ADMIN,
    )
    if (result.isCustom) {
      console.log('✅ Hierarchy check works correctly')
      console.log(`   ADMIN can modify WAITER permissions\n`)
    } else {
      console.log('❌ Unexpected result\n')
    }
  } catch (error: any) {
    console.log(`❌ Failed: ${error.message}\n`)
  }

  // TEST 8: Reverting to defaults works
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('TEST 8: Regression - Revert to Defaults')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

  console.log('📝 Reverting CASHIER to default permissions...')
  try {
    const result = await deleteRolePermissions(venue.id, StaffRole.CASHIER, StaffRole.OWNER)
    if (!result.isCustom && result.permissions.length > 0) {
      console.log('✅ Revert to defaults works correctly')
      console.log(`   Using default permissions: ${result.permissions.length} permissions\n`)
    } else {
      console.log('❌ Unexpected result\n')
    }
  } catch (error: any) {
    console.log(`❌ Failed: ${error.message}\n`)
  }

  // TEST 9: getAllRolePermissions returns correct data
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('TEST 9: Regression - Get All Role Permissions')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

  console.log('📝 Fetching all role permissions for venue...')
  try {
    const allPermissions = await getAllRolePermissions(venue.id)
    const roleCount = allPermissions.length
    const hasOwner = allPermissions.some(r => r.role === StaffRole.OWNER)
    const hasWaiter = allPermissions.some(r => r.role === StaffRole.WAITER)

    if (roleCount >= 9 && hasOwner && hasWaiter) {
      console.log('✅ getAllRolePermissions works correctly')
      console.log(`   Returned ${roleCount} roles with permissions`)
      console.log(`   Includes OWNER: ${hasOwner}, WAITER: ${hasWaiter}\n`)
    } else {
      console.log('❌ Incomplete data returned\n')
    }
  } catch (error: any) {
    console.log(`❌ Failed: ${error.message}\n`)
  }

  // TEST 10: Merge mode for non-wildcard roles
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('TEST 10: Regression - Merge Mode (Non-Wildcard Roles)')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

  console.log('📝 Adding custom permissions to WAITER (merge mode)...')
  try {
    // WAITER doesn't have *:* so custom perms should merge with defaults
    const result = await updateRolePermissions(
      venue.id,
      StaffRole.WAITER,
      ['orders:read', 'orders:create', 'menu:read', 'inventory:read'], // Added inventory:read
      owner.id,
      StaffRole.OWNER,
    )

    if (result.isCustom && result.permissions.includes('inventory:read')) {
      console.log('✅ Merge mode works correctly')
      console.log(`   Custom permissions stored in database\n`)
    } else {
      console.log('❌ Merge mode not working as expected\n')
    }
  } catch (error: any) {
    console.log(`❌ Failed: ${error.message}\n`)
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('✅ All tests completed (5 new features + 5 regression tests)!')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

  await prisma.$disconnect()
}

testPermissionValidation().catch(console.error)
