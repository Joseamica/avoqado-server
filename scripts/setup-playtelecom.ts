/**
 * Setup específico para PlayTelecom u otro venue de telecomunicaciones.
 * Habilita módulo SERIALIZED_INVENTORY con preset telecom y crea categorías.
 *
 * Usage: npx ts-node scripts/setup-playtelecom.ts <venueId> <staffId>
 *
 * Example:
 *   npx ts-node scripts/setup-playtelecom.ts cm123abc def456ghi
 */

import prisma from '../src/utils/prismaClient'
import { moduleService, MODULE_CODES } from '../src/services/modules/module.service'

async function main() {
  const venueId = process.argv[2]
  const enabledBy = process.argv[3]

  if (!venueId || !enabledBy) {
    console.error('❌ Usage: npx ts-node scripts/setup-playtelecom.ts <venueId> <staffId>')
    console.error('')
    console.error('Arguments:')
    console.error('  venueId  - ID of the venue to configure')
    console.error('  staffId  - ID of the staff member enabling the module')
    console.error('')
    console.error('Example:')
    console.error('  npx ts-node scripts/setup-playtelecom.ts cm123abc def456ghi')
    process.exit(1)
  }

  console.log('🚀 Setting up venue for Telecom/Serialized Inventory...\n')

  // 1. Verify venue exists
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { id: true, name: true, slug: true },
  })

  if (!venue) {
    console.error(`❌ Venue not found: ${venueId}`)
    process.exit(1)
  }

  console.log(`📍 Venue: ${venue.name} (${venue.slug})`)
  console.log(`   ID: ${venue.id}\n`)

  // 2. Verify staff exists
  const staff = await prisma.staff.findUnique({
    where: { id: enabledBy },
    select: { id: true, firstName: true, lastName: true },
  })

  if (!staff) {
    console.error(`❌ Staff not found: ${enabledBy}`)
    process.exit(1)
  }

  console.log(`👤 Enabled by: ${staff.firstName} ${staff.lastName}`)
  console.log(`   ID: ${staff.id}\n`)

  // 3. Enable module with telecom preset
  console.log('📦 Enabling SERIALIZED_INVENTORY module with telecom preset...')

  const venueModule = await moduleService.enableModule(
    venueId,
    MODULE_CODES.SERIALIZED_INVENTORY,
    enabledBy,
    undefined, // No custom config
    'telecom', // Use telecom preset
  )

  console.log(`✅ Module enabled: ${venueModule.id}`)

  // Get the merged config to show what labels will be used
  const config = await moduleService.getModuleConfig(venueId, MODULE_CODES.SERIALIZED_INVENTORY)
  console.log('   Config labels:', JSON.stringify((config as any)?.labels, null, 2))
  console.log('')

  // 3.5 Disable shift system for telecom venues (module config has enableShifts: false)
  // VenueSettings.enableShifts is the source of truth for PaymentViewModel shift validation
  console.log('⚙️ Disabling shift system in VenueSettings (telecom pattern)...')
  await prisma.venueSettings.upsert({
    where: { venueId },
    update: { enableShifts: false },
    create: { venueId, enableShifts: false },
  })
  console.log('   ✅ VenueSettings.enableShifts = false\n')

  // 4. Create telecom-specific categories
  console.log('📂 Creating telecom categories...\n')

  const categories = [
    {
      name: 'Negra',
      description: 'SIMs vendidas por promotores en stands',
      color: '#000000',
      sortOrder: 1,
      requiresPreRegistration: true,
      suggestedPrice: null, // Price entered at sale
    },
    {
      name: 'Blanca',
      description: 'SIMs vendidas por cajeros en tienda',
      color: '#FFFFFF',
      sortOrder: 2,
      requiresPreRegistration: true,
      suggestedPrice: null,
    },
    {
      name: 'Roja',
      description: 'SIMs de emergencia (sin pre-registro)',
      color: '#FF0000',
      sortOrder: 3,
      requiresPreRegistration: false, // Can sell without registering first
      suggestedPrice: null,
    },
  ]

  for (const cat of categories) {
    const category = await prisma.itemCategory.upsert({
      where: { venueId_name: { venueId, name: cat.name } },
      create: {
        venueId,
        name: cat.name,
        description: cat.description,
        color: cat.color,
        sortOrder: cat.sortOrder,
        requiresPreRegistration: cat.requiresPreRegistration,
        suggestedPrice: cat.suggestedPrice,
      },
      update: {
        description: cat.description,
        color: cat.color,
        sortOrder: cat.sortOrder,
        requiresPreRegistration: cat.requiresPreRegistration,
      },
    })

    const icon = cat.requiresPreRegistration ? '🔒' : '🔓'
    console.log(`   ${icon} ${category.name} (${category.color})`)
    console.log(`      ${category.description}`)
    console.log(`      Pre-registro: ${cat.requiresPreRegistration ? 'Requerido' : 'Opcional'}`)
    console.log('')
  }

  // 5. Summary
  const categoryCount = await prisma.itemCategory.count({ where: { venueId, active: true } })
  const moduleCount = await prisma.venueModule.count({ where: { venueId, enabled: true } })

  console.log('\n📊 Summary:')
  console.log(`   Modules enabled: ${moduleCount}`)
  console.log(`   Categories created: ${categoryCount}`)
  console.log('\n✅ Setup complete!')
  console.log('')
  console.log('📱 Next steps:')
  console.log('   1. Login to TPV app')
  console.log('   2. The app will fetch enabled modules at login')
  console.log('   3. If SERIALIZED_INVENTORY is enabled, show barcode scanner UI')
  console.log('   4. Use /tpv/v1/serialized-inventory/* endpoints for operations')
  console.log('')
}

main()
  .catch(e => {
    console.error('❌ Error:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
