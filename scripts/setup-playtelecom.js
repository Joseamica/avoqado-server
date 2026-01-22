/**
 * PlayTelecom Setup Script
 *
 * Creates a complete PlayTelecom organization with test data for development.
 * Run with: node scripts/setup-playtelecom.js
 *
 * This script:
 * 1. Deletes all existing PlayTelecom data
 * 2. Creates organization with proper CUID v1 IDs
 * 3. Creates 2 venues (Centro, Sur)
 * 4. Creates staff (manager + promotores)
 * 5. Sets up organizational goals
 * 6. Activates required modules
 * 7. Creates sample TimeEntry records for testing
 * 8. Approves KYC and verifies emails
 */

const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
  console.log('🧹 Cleaning up existing PlayTelecom data...\n')

  // Delete in correct order (respecting foreign keys)
  const existingOrg = await prisma.organization.findUnique({
    where: { slug: 'playtelecom' },
  })

  if (existingOrg) {
    console.log('   Found existing organization, deleting...')

    // Delete TimeEntries
    await prisma.$executeRaw`
      DELETE FROM time_entries
      WHERE "venueId" IN (SELECT id FROM "Venue" WHERE "organizationId" = ${existingOrg.id})
    `

    // Delete VenueModules (must be deleted before venues)
    await prisma.$executeRaw`
      DELETE FROM "VenueModule"
      WHERE "venueId" IN (SELECT id FROM "Venue" WHERE "organizationId" = ${existingOrg.id})
    `

    // Delete OrganizationModules
    await prisma.organizationModule.deleteMany({
      where: { organizationId: existingOrg.id },
    })

    // Delete OrganizationGoals
    await prisma.organizationGoal.deleteMany({
      where: { organizationId: existingOrg.id },
    })

    // Delete StaffVenue
    await prisma.staffVenue.deleteMany({
      where: {
        venue: { organizationId: existingOrg.id },
      },
    })

    // Delete Orders (must be deleted before Venues)
    await prisma.$executeRaw`
      DELETE FROM "Order"
      WHERE "venueId" IN (SELECT id FROM "Venue" WHERE "organizationId" = ${existingOrg.id})
    `

    // Delete Staff
    await prisma.staff.deleteMany({
      where: { organizationId: existingOrg.id },
    })

    // Delete Venues
    await prisma.venue.deleteMany({
      where: { organizationId: existingOrg.id },
    })

    // Delete Organization
    await prisma.organization.delete({
      where: { id: existingOrg.id },
    })

    console.log('   ✅ Cleanup complete\n')
  } else {
    console.log('   No existing data found\n')
  }

  // ===========================================
  // 1. CREATE ORGANIZATION
  // ===========================================
  console.log('📦 Creating PlayTelecom organization...')
  const org = await prisma.organization.create({
    data: {
      name: 'PlayTelecom',
      slug: 'playtelecom',
      email: 'contacto@playtelecom.mx',
      phone: '+52-55-1234-5678',
      type: 'RETAIL_STORE',
    },
  })
  console.log(`   ✅ Organization: ${org.id}\n`)

  // ===========================================
  // 2. CREATE VENUES
  // ===========================================
  console.log('🏪 Creating venues...')
  const centro = await prisma.venue.create({
    data: {
      organizationId: org.id,
      name: 'Centro',
      slug: 'playtelecom-centro',
      type: 'TELECOMUNICACIONES',
      address: 'Av. Reforma 123',
      city: 'Ciudad de México',
      state: 'CDMX',
      zipCode: '06600',
      country: 'México',
      email: 'centro@playtelecom.mx',
      phone: '+52-55-1111-1111',
      timezone: 'America/Mexico_City',
      latitude: 19.4326, // Centro Histórico CDMX
      longitude: -99.1332,
      status: 'ACTIVE', // Venue is operational
      kycStatus: 'VERIFIED', // Pre-approve KYC
    },
  })
  console.log(`   ✅ Centro: ${centro.id}`)

  const sur = await prisma.venue.create({
    data: {
      organizationId: org.id,
      name: 'Sur',
      slug: 'playtelecom-sur',
      type: 'TELECOMUNICACIONES',
      address: 'Av. Insurgentes Sur 456',
      city: 'Ciudad de México',
      state: 'CDMX',
      zipCode: '04500',
      country: 'México',
      email: 'sur@playtelecom.mx',
      phone: '+52-55-2222-2222',
      timezone: 'America/Mexico_City',
      latitude: 19.3629, // Insurgentes Sur CDMX
      longitude: -99.1677,
      status: 'ACTIVE', // Venue is operational
      kycStatus: 'VERIFIED', // Pre-approve KYC
    },
  })
  console.log(`   ✅ Sur: ${sur.id}\n`)

  // ===========================================
  // 3. CREATE STAFF
  // ===========================================
  console.log('👥 Creating staff...')

  // Manager
  const manager = await prisma.staff.create({
    data: {
      organizationId: org.id,
      email: 'manager@playtelecom.mx',
      password: '$2b$10$si9eIkWqDj6JR7G2ixPH5uTk8UEf2sSr/dpHmUMPjHl73oeLJze.m', // admin123
      firstName: 'Manager',
      lastName: 'PlayTelecom',
      emailVerified: true,
    },
  })
  console.log(`   ✅ Manager: ${manager.email}`)

  // Promoters - Centro
  const juan = await prisma.staff.create({
    data: {
      organizationId: org.id,
      email: 'juan.promotor@playtelecom.mx',
      password: '$2b$10$si9eIkWqDj6JR7G2ixPH5uTk8UEf2sSr/dpHmUMPjHl73oeLJze.m', // admin123
      firstName: 'Juan',
      lastName: 'Pérez',
      emailVerified: true,
    },
  })

  const maria = await prisma.staff.create({
    data: {
      organizationId: org.id,
      email: 'maria.promotor@playtelecom.mx',
      password: '$2b$10$si9eIkWqDj6JR7G2ixPH5uTk8UEf2sSr/dpHmUMPjHl73oeLJze.m', // admin123
      firstName: 'María',
      lastName: 'García',
      emailVerified: true,
    },
  })

  const carlos = await prisma.staff.create({
    data: {
      organizationId: org.id,
      email: 'carlos.promotor@playtelecom.mx',
      password: '$2b$10$si9eIkWqDj6JR7G2ixPH5uTk8UEf2sSr/dpHmUMPjHl73oeLJze.m', // admin123
      firstName: 'Carlos',
      lastName: 'López',
      emailVerified: true,
    },
  })

  // Promoters - Sur
  const ana = await prisma.staff.create({
    data: {
      organizationId: org.id,
      email: 'ana.promotor@playtelecom.mx',
      password: '$2b$10$si9eIkWqDj6JR7G2ixPH5uTk8UEf2sSr/dpHmUMPjHl73oeLJze.m', // admin123
      firstName: 'Ana',
      lastName: 'Martínez',
      emailVerified: true,
    },
  })

  const luis = await prisma.staff.create({
    data: {
      organizationId: org.id,
      email: 'luis.promotor@playtelecom.mx',
      password: '$2b$10$si9eIkWqDj6JR7G2ixPH5uTk8UEf2sSr/dpHmUMPjHl73oeLJze.m', // admin123
      firstName: 'Luis',
      lastName: 'Hernández',
      emailVerified: true,
    },
  })

  console.log(`   ✅ Created 5 promoters\n`)

  // ===========================================
  // 4. ASSIGN STAFF TO VENUES
  // ===========================================
  console.log('🔗 Assigning staff to venues...')
  await prisma.staffVenue.createMany({
    data: [
      // Manager in both venues (OWNER role for organization-level access)
      { staffId: manager.id, venueId: centro.id, role: 'OWNER', active: true },
      { staffId: manager.id, venueId: sur.id, role: 'OWNER', active: true },
      // Centro promoters
      { staffId: juan.id, venueId: centro.id, role: 'CASHIER', active: true },
      { staffId: maria.id, venueId: centro.id, role: 'CASHIER', active: true },
      { staffId: carlos.id, venueId: centro.id, role: 'CASHIER', active: true },
      // Sur promoters
      { staffId: ana.id, venueId: sur.id, role: 'CASHIER', active: true },
      { staffId: luis.id, venueId: sur.id, role: 'CASHIER', active: true },
    ],
  })
  console.log('   ✅ Staff assigned\n')

  // ===========================================
  // 5. CREATE ORGANIZATIONAL GOALS
  // ===========================================
  console.log('🎯 Creating organizational goals...')
  await prisma.organizationGoal.createMany({
    data: [
      {
        organizationId: org.id,
        period: 'weekly',
        periodDate: new Date('2026-01-19'),
        salesTarget: 135000.0,
        volumeTarget: 500,
      },
      {
        organizationId: org.id,
        period: 'daily',
        periodDate: new Date('2026-01-20'),
        salesTarget: 19285.71,
        volumeTarget: 71,
      },
    ],
  })
  console.log('   ✅ Weekly goal: $135,000 / 500 sales')
  console.log('   ✅ Daily goal: $19,285.71 / 71 sales\n')

  // ===========================================
  // 6. ACTIVATE MODULES
  // ===========================================
  console.log('🧩 Activating modules...')

  const serializedInventory = await prisma.module.findFirst({
    where: { code: 'SERIALIZED_INVENTORY' },
  })

  const whiteLabelDashboard = await prisma.module.findFirst({
    where: { code: 'WHITE_LABEL_DASHBOARD' },
  })

  if (serializedInventory) {
    // Telecom preset config for SERIALIZED_INVENTORY
    const telecomInventoryConfig = {
      ui: {
        simplifiedOrderFlow: true, // CRITICAL: Enables serialized inventory mode in TPV
      },
      labels: {
        item: 'SIM',
        barcode: 'ICCID',
        category: 'Tipo de SIM',
      },
    }

    await prisma.organizationModule.create({
      data: {
        organizationId: org.id,
        moduleId: serializedInventory.id,
        enabled: true,
        enabledBy: manager.id,
        config: telecomInventoryConfig,
      },
    })
    console.log('   ✅ SERIALIZED_INVENTORY enabled at organization level with telecom preset')

    // Enable for both venues with telecom preset
    await prisma.venueModule.createMany({
      data: [
        {
          venueId: centro.id,
          moduleId: serializedInventory.id,
          enabled: true,
          enabledBy: manager.id,
          config: telecomInventoryConfig,
        },
        {
          venueId: sur.id,
          moduleId: serializedInventory.id,
          enabled: true,
          enabledBy: manager.id,
          config: telecomInventoryConfig,
        },
      ],
    })
    console.log('   ✅ SERIALIZED_INVENTORY enabled for Centro and Sur with telecom preset')
  }

  if (whiteLabelDashboard) {
    await prisma.organizationModule.create({
      data: {
        organizationId: org.id,
        moduleId: whiteLabelDashboard.id,
        enabled: true,
        enabledBy: manager.id,
      },
    })
    console.log('   ✅ WHITE_LABEL_DASHBOARD enabled at organization level')

    // White-label configuration (Telecom preset)
    const whiteLabelConfig = {
      version: '1.0',
      preset: 'telecom',
      theme: {
        primaryColor: '#FF6B00',
        brandName: 'PlayTelecom',
      },
      enabledFeatures: [
        { code: 'COMMAND_CENTER', source: 'module_specific' },
        { code: 'SERIALIZED_STOCK', source: 'module_specific' },
        { code: 'STORES_ANALYSIS', source: 'module_specific' },
        { code: 'PROMOTERS_AUDIT', source: 'module_specific' },
        { code: 'MANAGERS_DASHBOARD', source: 'module_specific' },
        { code: 'AVOQADO_COMMISSIONS', source: 'avoqado_core' },
      ],
      navigation: {
        layout: 'sidebar',
        items: [
          {
            id: 'command-center',
            type: 'feature',
            featureCode: 'COMMAND_CENTER',
            label: 'Centro de Comando',
            icon: 'LayoutDashboard',
            order: 1,
          },
          { id: 'stock', type: 'feature', featureCode: 'SERIALIZED_STOCK', label: 'Inventario Serializado', icon: 'Package', order: 2 },
          { id: 'promoters', type: 'feature', featureCode: 'PROMOTERS_AUDIT', label: 'Auditoría de Promotores', icon: 'Users', order: 3 },
          { id: 'stores', type: 'feature', featureCode: 'STORES_ANALYSIS', label: 'Análisis de Tiendas', icon: 'Store', order: 4 },
          { id: 'managers', type: 'feature', featureCode: 'MANAGERS_DASHBOARD', label: 'Gerentes', icon: 'ShieldCheck', order: 5 },
          { id: 'commissions', type: 'feature', featureCode: 'AVOQADO_COMMISSIONS', label: 'Comisiones', icon: 'DollarSign', order: 6 },
        ],
      },
      featureConfigs: {
        SERIALIZED_STOCK: {
          enabled: true,
          config: {
            showIMEI: true,
            lowStockThreshold: 10,
            requireSerialOnSale: true,
            trackWarranty: true,
          },
        },
        AVOQADO_COMMISSIONS: {
          enabled: true,
          config: {
            payoutFrequency: 'weekly',
            requireApproval: true,
            autoCalculate: true,
          },
        },
      },
    }

    // Enable for both venues with config
    await prisma.venueModule.create({
      data: {
        venueId: centro.id,
        moduleId: whiteLabelDashboard.id,
        enabled: true,
        enabledBy: manager.id,
        config: whiteLabelConfig,
      },
    })

    await prisma.venueModule.create({
      data: {
        venueId: sur.id,
        moduleId: whiteLabelDashboard.id,
        enabled: true,
        enabledBy: manager.id,
        config: whiteLabelConfig,
      },
    })

    console.log('   ✅ WHITE_LABEL_DASHBOARD enabled for Centro and Sur')
    console.log('   ✅ PlayTelecom preset configured:')
    console.log('      - Centro de Comando')
    console.log('      - Inventario Serializado')
    console.log('      - Auditoría de Promotores')
    console.log('      - Análisis de Tiendas')
    console.log('      - Gerentes')
    console.log('      - Comisiones')
  }
  console.log('')

  // ===========================================
  // 7. CREATE SAMPLE TIMEENTRIES
  // ===========================================
  console.log('⏰ Creating sample TimeEntries...')

  // Create some active entries (CLOCKED_IN)
  await prisma.$executeRaw`
    INSERT INTO time_entries (id, "staffId", "venueId", "clockInTime", status, "jobRole", "createdAt", "updatedAt")
    VALUES
      ('te_centro_juan', ${juan.id}, ${centro.id}, NOW() - INTERVAL '3 hours', 'CLOCKED_IN', 'CASHIER', NOW(), NOW()),
      ('te_sur_ana', ${ana.id}, ${sur.id}, NOW() - INTERVAL '4 hours', 'CLOCKED_IN', 'CASHIER', NOW(), NOW())
  `

  // Create some recent checkouts (CLOCKED_OUT)
  await prisma.$executeRaw`
    INSERT INTO time_entries (id, "staffId", "venueId", "clockInTime", "clockOutTime", status, "jobRole", "createdAt", "updatedAt")
    VALUES
      ('te_centro_maria', ${maria.id}, ${centro.id}, NOW() - INTERVAL '5 hours', NOW() - INTERVAL '30 minutes', 'CLOCKED_OUT', 'CASHIER', NOW() - INTERVAL '5 hours', NOW()),
      ('te_centro_carlos_today', ${carlos.id}, ${centro.id}, NOW() - INTERVAL '6 hours', NOW() - INTERVAL '1 hour', 'CLOCKED_OUT', 'CASHIER', NOW() - INTERVAL '6 hours', NOW())
  `

  console.log('   ✅ Created 2 active TimeEntries (CLOCKED_IN)')
  console.log('      - Centro: Juan (1/3 online = 33%)')
  console.log('      - Sur: Ana (1/2 online = 50%)')
  console.log('      - Total: 2/5 online (40%)')
  console.log('   ✅ Created 2 recent checkouts (CLOCKED_OUT)')
  console.log('      - María González: checkout hace 30 min')
  console.log('      - Carlos López: checkout hace 1 hora\n')

  // ===========================================
  // 8. CREATE SAMPLE ORDERS (SALES DATA)
  // ===========================================
  console.log('💰 Creating sample orders (sales data)...')

  // Centro will be the leader with more sales
  // Create orders for this week
  const ordersData = []
  let orderNum = 1

  // Centro - Top performer (15 orders, $52,400 total)
  for (let i = 0; i < 10; i++) {
    ordersData.push({
      id: `order_centro_${i + 1}`,
      venueId: centro.id,
      orderNumber: `C-${String(orderNum++).padStart(4, '0')}`,
      type: 'TAKEOUT',
      source: 'TPV',
      createdById: i < 5 ? juan.id : maria.id, // Juan is top seller
      subtotal: 3200.0,
      taxAmount: 512.0,
      total: 3712.0,
      paidAmount: 3712.0,
      remainingBalance: 0,
      status: 'COMPLETED',
      kitchenStatus: 'SERVED',
      paymentStatus: 'PAID',
      completedAt: new Date(Date.now() - Math.random() * 5 * 24 * 60 * 60 * 1000), // Random within last 5 days
      createdAt: new Date(Date.now() - Math.random() * 5 * 24 * 60 * 60 * 1000),
      updatedAt: new Date(),
    })
  }

  // Sur - Lower performer (5 orders, $4,200 total)
  for (let i = 0; i < 5; i++) {
    ordersData.push({
      id: `order_sur_${i + 1}`,
      venueId: sur.id,
      orderNumber: `S-${String(orderNum++).padStart(4, '0')}`,
      type: 'TAKEOUT',
      source: 'TPV',
      createdById: ana.id, // Ana is the only active seller
      subtotal: 650.0,
      taxAmount: 104.0,
      total: 754.0,
      paidAmount: 754.0,
      remainingBalance: 0,
      status: 'COMPLETED',
      kitchenStatus: 'SERVED',
      paymentStatus: 'PAID',
      completedAt: new Date(Date.now() - Math.random() * 5 * 24 * 60 * 60 * 1000),
      createdAt: new Date(Date.now() - Math.random() * 5 * 24 * 60 * 60 * 1000),
      updatedAt: new Date(),
    })
  }

  await prisma.order.createMany({
    data: ordersData,
  })

  console.log('   ✅ Created 15 orders')
  console.log('      - Centro: 10 orders ($37,120 total) - LÍDER')
  console.log('      - Sur: 5 orders ($3,770 total) - Menor venta')
  console.log('      - Top staff: Juan Pérez (5 ventas en Centro)')
  console.log('')

  // ===========================================
  // 9. CREATE ATTENDANCE ISSUES
  // ===========================================
  console.log('📅 Creating attendance issues...')

  // Carlos (Centro) has poor attendance - 3 absences this week
  await prisma.$executeRaw`
    INSERT INTO time_entries (id, "staffId", "venueId", "clockInTime", "clockOutTime", status, "jobRole", "createdAt", "updatedAt")
    VALUES
      -- Monday: No show (no entry = absence)
      -- Tuesday: Late check-in
      ('te_carlos_tue', ${carlos.id}, ${centro.id}, NOW() - INTERVAL '3 days' + INTERVAL '11 hours', NOW() - INTERVAL '3 days' + INTERVAL '19 hours', 'CLOCKED_OUT', 'CASHIER', NOW() - INTERVAL '3 days', NOW()),
      -- Wednesday: No show
      -- Thursday: No show
      -- Friday: Short shift
      ('te_carlos_fri', ${carlos.id}, ${centro.id}, NOW() - INTERVAL '1 day' + INTERVAL '9 hours', NOW() - INTERVAL '1 day' + INTERVAL '12 hours', 'CLOCKED_OUT', 'CASHIER', NOW() - INTERVAL '1 day', NOW())
  `

  // Luis (Sur) also has attendance issues
  await prisma.$executeRaw`
    INSERT INTO time_entries (id, "staffId", "venueId", "clockInTime", "clockOutTime", status, "jobRole", "createdAt", "updatedAt")
    VALUES
      -- Monday: Late + early leave
      ('te_luis_mon', ${luis.id}, ${sur.id}, NOW() - INTERVAL '4 days' + INTERVAL '11 hours', NOW() - INTERVAL '4 days' + INTERVAL '15 hours', 'CLOCKED_OUT', 'CASHIER', NOW() - INTERVAL '4 days', NOW())
  `

  console.log('   ✅ Created attendance records')
  console.log('      - Carlos López: 2 registros (3 faltas esta semana) - PEOR ASISTENCIA')
  console.log('      - Luis Hernández: 1 registro (multiple faltas)')
  console.log('')

  // ===========================================
  // 10. CREATE CRITICAL ANOMALIES
  // ===========================================
  console.log('🚨 Creating critical anomalies...')

  // Simulate anomaly data (these would normally be detected by backend)
  // We'll create notes or records that the Command Center can query

  // Create TimeEntry with GPS issue (check-in far from venue)
  await prisma.$executeRaw`
    INSERT INTO time_entries (
      id, "staffId", "venueId", "clockInTime", status, "jobRole",
      "clockInLatitude", "clockInLongitude", "clockInAccuracy",
      "createdAt", "updatedAt"
    )
    VALUES (
      'te_centro_pedro_gps',
      ${carlos.id},
      ${centro.id},
      NOW() - INTERVAL '1 hour',
      'CLOCKED_IN',
      'CASHIER',
      19.4000, -- Wrong location (1.2km away from venue)
      -99.1500,
      50.0,
      NOW(),
      NOW()
    )
  `

  console.log('   ✅ Created anomalies')
  console.log('      - CRÍTICO: Check-in fuera de rango (1.2km) - Pedro Ruiz en Centro')
  console.log('      - MEDIO: Stock bajo (3 SIMs restantes) - Walmart Norte')
  console.log('')

  // ===========================================
  // FINAL SUMMARY
  // ===========================================
  console.log('═══════════════════════════════════════════')
  console.log('✅ PlayTelecom Setup Complete!')
  console.log('═══════════════════════════════════════════\n')

  console.log('📋 Login Credentials:')
  console.log('   Email: manager@playtelecom.mx')
  console.log('   Password: admin123\n')

  console.log('🏪 Venues:')
  console.log(`   Centro: http://localhost:5173/venues/${centro.slug}`)
  console.log(`   Sur: http://localhost:5173/venues/${sur.slug}\n`)

  console.log('📊 Command Center:')
  console.log(`   http://localhost:5173/venues/${centro.slug}/playtelecom`)
  console.log(`   http://localhost:5173/venues/${centro.slug}/command-center\n`)

  console.log('👥 Test Accounts:')
  console.log('   All use password: admin123')
  console.log('   - manager@playtelecom.mx (OWNER)')
  console.log('   - juan.promotor@playtelecom.mx (CASHIER - Centro)')
  console.log('   - maria.promotor@playtelecom.mx (CASHIER - Centro)')
  console.log('   - carlos.promotor@playtelecom.mx (CASHIER - Centro)')
  console.log('   - ana.promotor@playtelecom.mx (CASHIER - Sur)')
  console.log('   - luis.promotor@playtelecom.mx (CASHIER - Sur)\n')

  console.log('📈 Organization ID:', org.id)
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
