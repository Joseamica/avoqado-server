/**
 * Set sales goal for a venue's SERIALIZED_INVENTORY module.
 *
 * Usage: npx ts-node scripts/set-sales-goal.ts
 *
 * This script updates the module config to include salesGoal settings.
 * The TPV will show a progress bar based on these settings.
 */

import prisma from '../src/utils/prismaClient'

// ==========================================
// CONFIGURATION - Edit these values
// ==========================================

// Option 1: Set for a specific VENUE (overrides org-level)
const VENUE_ID = 'YOUR_VENUE_ID' // Replace with actual venue ID or set to null

// Option 2: Set for an entire ORGANIZATION (all venues inherit)
const ORGANIZATION_ID = null as string | null // Replace with org ID if you want org-level

// Sales goal configuration
const SALES_GOAL_CONFIG = {
  goal: '10000.00', // Target amount (as string for precision)
  period: 'DAILY', // 'DAILY' | 'WEEKLY' | 'MONTHLY'
  // currentSales is calculated dynamically by the backend at request time
}

// ==========================================
// SCRIPT LOGIC
// ==========================================

async function main() {
  console.log('🎯 Setting sales goal for SERIALIZED_INVENTORY module...\n')

  // Find the SERIALIZED_INVENTORY module
  const module = await prisma.module.findUnique({
    where: { code: 'SERIALIZED_INVENTORY' },
  })

  if (!module) {
    console.error('❌ SERIALIZED_INVENTORY module not found. Run setup-modules.ts first.')
    process.exit(1)
  }

  console.log(`📦 Found module: ${module.name} (${module.id})`)

  if (VENUE_ID && VENUE_ID !== 'YOUR_VENUE_ID') {
    // Update venue-level config
    const venue = await prisma.venue.findUnique({
      where: { id: VENUE_ID },
      select: { id: true, name: true, slug: true },
    })

    if (!venue) {
      console.error(`❌ Venue not found: ${VENUE_ID}`)
      process.exit(1)
    }

    console.log(`🏪 Venue: ${venue.name} (${venue.slug})`)

    // Find or create VenueModule
    const existingVenueModule = await prisma.venueModule.findUnique({
      where: { venueId_moduleId: { venueId: VENUE_ID, moduleId: module.id } },
    })

    if (existingVenueModule) {
      // Merge existing config with salesGoal
      const existingConfig = (existingVenueModule.config as Record<string, unknown>) || {}
      const updatedConfig = {
        ...existingConfig,
        salesGoal: SALES_GOAL_CONFIG,
      }

      await prisma.venueModule.update({
        where: { id: existingVenueModule.id },
        data: { config: updatedConfig },
      })

      console.log(`\n✅ Updated VenueModule config with salesGoal:`)
    } else {
      // Create new VenueModule with salesGoal
      await prisma.venueModule.create({
        data: {
          venueId: VENUE_ID,
          moduleId: module.id,
          enabled: true,
          config: { salesGoal: SALES_GOAL_CONFIG },
          enabledBy: 'system-script',
        },
      })

      console.log(`\n✅ Created VenueModule with salesGoal:`)
    }

    console.log(`   Goal: $${SALES_GOAL_CONFIG.goal}`)
    console.log(`   Period: ${SALES_GOAL_CONFIG.period}`)
  } else if (ORGANIZATION_ID) {
    // Update organization-level config
    const org = await prisma.organization.findUnique({
      where: { id: ORGANIZATION_ID },
      select: { id: true, name: true },
    })

    if (!org) {
      console.error(`❌ Organization not found: ${ORGANIZATION_ID}`)
      process.exit(1)
    }

    console.log(`🏢 Organization: ${org.name}`)

    const existingOrgModule = await prisma.organizationModule.findUnique({
      where: { organizationId_moduleId: { organizationId: ORGANIZATION_ID, moduleId: module.id } },
    })

    if (existingOrgModule) {
      const existingConfig = (existingOrgModule.config as Record<string, unknown>) || {}
      const updatedConfig = {
        ...existingConfig,
        salesGoal: SALES_GOAL_CONFIG,
      }

      await prisma.organizationModule.update({
        where: { id: existingOrgModule.id },
        data: { config: updatedConfig },
      })

      console.log(`\n✅ Updated OrganizationModule config with salesGoal:`)
    } else {
      await prisma.organizationModule.create({
        data: {
          organizationId: ORGANIZATION_ID,
          moduleId: module.id,
          enabled: true,
          config: { salesGoal: SALES_GOAL_CONFIG },
          enabledBy: 'system-script',
        },
      })

      console.log(`\n✅ Created OrganizationModule with salesGoal:`)
    }

    console.log(`   Goal: $${SALES_GOAL_CONFIG.goal}`)
    console.log(`   Period: ${SALES_GOAL_CONFIG.period}`)
    console.log(`   (All venues in ${org.name} will inherit this)`)
  } else {
    console.log('\n⚠️  No VENUE_ID or ORGANIZATION_ID configured.')
    console.log('   Edit this script and set one of:')
    console.log('   - VENUE_ID: for a specific venue')
    console.log('   - ORGANIZATION_ID: for all venues in an org')

    // List available venues with SERIALIZED_INVENTORY
    const venuesWithModule = await prisma.venueModule.findMany({
      where: {
        moduleId: module.id,
        enabled: true,
      },
      include: {
        venue: { select: { id: true, name: true, slug: true } },
      },
    })

    if (venuesWithModule.length > 0) {
      console.log('\n📋 Venues with SERIALIZED_INVENTORY enabled:')
      venuesWithModule.forEach(vm => {
        console.log(`   - ${vm.venue.name} (${vm.venue.slug})`)
        console.log(`     ID: ${vm.venueId}`)
      })
    }

    // List orgs with SERIALIZED_INVENTORY
    const orgsWithModule = await prisma.organizationModule.findMany({
      where: {
        moduleId: module.id,
        enabled: true,
      },
      include: {
        organization: { select: { id: true, name: true } },
      },
    })

    if (orgsWithModule.length > 0) {
      console.log('\n📋 Organizations with SERIALIZED_INVENTORY enabled:')
      orgsWithModule.forEach(om => {
        console.log(`   - ${om.organization.name}`)
        console.log(`     ID: ${om.organizationId}`)
      })
    }
  }

  console.log('\n✅ Done!')
}

main()
  .catch(e => {
    console.error('❌ Error:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
