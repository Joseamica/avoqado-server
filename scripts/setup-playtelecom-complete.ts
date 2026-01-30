/**
 * Setup completo para PlayTelecom con organización, venues, usuarios y datos de ejemplo
 *
 * Crea:
 * - Organización PlayTelecom
 * - Venues: Sur, Centro
 * - Usuarios: Superadmin, Alberto (Owner), Daniel (Manager), Rodrigo (Promotor/Waiter)
 * - Módulo de inventario serializado configurado
 * - Categorías de productos (Negra, Blanca, Roja)
 * - Datos de ejemplo para testing
 *
 * Usage: npx ts-node scripts/setup-playtelecom-complete.ts
 */

import prisma from '../src/utils/prismaClient'
import { moduleService, MODULE_CODES } from '../src/services/modules/module.service'
import { StaffRole, VenueStatus, BusinessType } from '@prisma/client'

const SUPERADMIN_EMAIL = 'superadmin@superadmin.com'
const SUPERADMIN_UID = 'XVuOWLB2LTbA22eDGxPXfE7jPi93' // UID de Firebase del superadmin

// Configuración de la organización
const ORG_CONFIG = {
  name: 'PlayTelecom',
  email: 'contacto@playtelecom.mx',
  phone: '+52 55 1234 5678',
  taxId: 'PTC123456ABC',
  type: BusinessType.ELECTRONICS, // Telecom falls under electronics/mobile
}

// Configuración de venues
const VENUES = [
  {
    name: 'PlayTelecom Sur',
    slug: 'playtelecom-sur',
    address: 'Av. Insurgentes Sur 1234',
    city: 'Ciudad de México',
    state: 'CDMX',
    zipCode: '03100',
    country: 'MX',
    timezone: 'America/Mexico_City',
    currency: 'MXN',
    email: 'sur@playtelecom.mx',
    phone: '+52 55 1111 2222',
    latitude: 19.4326,
    longitude: -99.1332,
    type: 'TELECOMUNICACIONES' as any, // BusinessType enum
    kycStatus: 'VERIFIED' as any,
  },
  {
    name: 'PlayTelecom Centro',
    slug: 'playtelecom-centro',
    address: 'Av. Juárez 456',
    city: 'Ciudad de México',
    state: 'CDMX',
    zipCode: '06050',
    country: 'MX',
    timezone: 'America/Mexico_City',
    currency: 'MXN',
    email: 'centro@playtelecom.mx',
    phone: '+52 55 3333 4444',
    latitude: 19.4326,
    longitude: -99.1332,
    type: 'TELECOMUNICACIONES' as any,
    kycStatus: 'VERIFIED' as any,
  },
]

// Configuración de usuarios
const USERS = [
  {
    firstName: 'Super',
    lastName: 'Admin',
    email: SUPERADMIN_EMAIL,
    uid: SUPERADMIN_UID,
    phone: '+52 55 9999 9999',
    role: StaffRole.SUPERADMIN,
    venues: ['sur', 'centro'], // Se agregará a ambos venues
  },
  {
    firstName: 'Alberto',
    lastName: 'García',
    email: 'alberto@playtelecom.mx',
    uid: null, // Se generará uno ficticio
    phone: '+52 55 1234 0001',
    role: StaffRole.OWNER,
    venues: ['sur', 'centro'],
  },
  {
    firstName: 'Daniel',
    lastName: 'Martínez',
    email: 'daniel@playtelecom.mx',
    uid: null,
    phone: '+52 55 1234 0002',
    role: StaffRole.MANAGER,
    venues: ['sur', 'centro'],
  },
  {
    firstName: 'Rodrigo',
    lastName: 'López',
    email: 'rodrigo@playtelecom.mx',
    uid: null,
    phone: '+52 55 1234 0003',
    role: StaffRole.WAITER, // Promotor en el contexto de telecom
    venues: ['sur'], // Solo en Sur
  },
  {
    firstName: 'Ana María',
    lastName: 'Pérez',
    email: 'anamaria@playtelecom.mx',
    uid: null,
    phone: '+52 55 1234 0004',
    role: StaffRole.WAITER,
    venues: ['centro'], // Solo en Centro
  },
  // Manager adicional
  {
    firstName: 'Manager',
    lastName: 'PlayTelecom',
    email: 'manager@playtelecom.mx',
    uid: null,
    phone: '+52 55 5555 5555',
    role: StaffRole.OWNER,
    venues: ['sur', 'centro'],
  },
  // Promotores adicionales (CASHIER)
  {
    firstName: 'Luis',
    lastName: 'Hernández',
    email: 'luis.promotor@playtelecom.mx',
    uid: null,
    phone: '+52 55 1111 0001',
    role: StaffRole.CASHIER,
    venues: ['sur'],
  },
  {
    firstName: 'Ana',
    lastName: 'Martínez',
    email: 'ana.promotor@playtelecom.mx',
    uid: null,
    phone: '+52 55 1111 0002',
    role: StaffRole.CASHIER,
    venues: ['sur'],
  },
  {
    firstName: 'María',
    lastName: 'García',
    email: 'maria.promotor@playtelecom.mx',
    uid: null,
    phone: '+52 55 2222 0001',
    role: StaffRole.CASHIER,
    venues: ['centro'],
  },
  {
    firstName: 'Juan',
    lastName: 'Pérez',
    email: 'juan.promotor@playtelecom.mx',
    uid: null,
    phone: '+52 55 2222 0002',
    role: StaffRole.CASHIER,
    venues: ['centro'],
  },
  {
    firstName: 'Carlos',
    lastName: 'López',
    email: 'carlos.promotor@playtelecom.mx',
    uid: null,
    phone: '+52 55 2222 0003',
    role: StaffRole.CASHIER,
    venues: ['centro'],
  },
]

// Categorías de productos para telecom
const CATEGORIES = [
  {
    name: 'Negra',
    description: 'SIMs vendidas por promotores en stands',
    color: '#000000',
    sortOrder: 1,
    requiresPreRegistration: true,
    suggestedPrice: null,
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
    requiresPreRegistration: false,
    suggestedPrice: null,
  },
]

async function main() {
  console.log('🚀 Configurando PlayTelecom - Setup Completo\n')
  console.log('═══════════════════════════════════════════════\n')

  // 0. Limpiar datos existentes de PlayTelecom
  console.log('🧹 Step 0: Limpiando datos existentes de PlayTelecom')
  console.log('─────────────────────────────────────')

  // Find existing organization
  const existingOrg = await prisma.organization.findFirst({
    where: { name: ORG_CONFIG.name },
  })

  if (existingOrg) {
    console.log(`   🔍 Organización encontrada: ${existingOrg.name}`)

    // Get venue IDs
    const venueIds = await prisma.venue.findMany({
      where: { organizationId: existingOrg.id },
      select: { id: true },
    })
    const venueIdList = venueIds.map(v => v.id)

    if (venueIdList.length > 0) {
      // Delete in correct order (respecting foreign keys)
      console.log('   🗑️  Eliminando Payments...')
      await prisma.payment.deleteMany({
        where: { venueId: { in: venueIdList } },
      })

      console.log('   🗑️  Eliminando OrderItems (via Orders)...')
      await prisma.orderItem.deleteMany({
        where: { order: { venueId: { in: venueIdList } } },
      })

      console.log('   🗑️  Eliminando Orders...')
      await prisma.order.deleteMany({
        where: { venueId: { in: venueIdList } },
      })

      console.log('   🗑️  Eliminando SerializedItems...')
      await prisma.serializedItem.deleteMany({
        where: { venueId: { in: venueIdList } },
      })

      console.log('   🗑️  Eliminando ItemCategories...')
      await prisma.itemCategory.deleteMany({
        where: { venueId: { in: venueIdList } },
      })

      console.log('   🗑️  Eliminando VenueSettings...')
      await prisma.venueSettings.deleteMany({
        where: { venueId: { in: venueIdList } },
      })

      console.log('   🗑️  Eliminando VenueModules...')
      await prisma.venueModule.deleteMany({
        where: { venueId: { in: venueIdList } },
      })

      console.log('   🗑️  Eliminando StaffVenue...')
      await prisma.staffVenue.deleteMany({
        where: { venueId: { in: venueIdList } },
      })

      console.log('   🗑️  Eliminando Terminals...')
      await prisma.terminal.deleteMany({
        where: { venueId: { in: venueIdList } },
      })
    }

    console.log('   🗑️  Eliminando OrganizationGoals...')
    await prisma.organizationGoal.deleteMany({
      where: { organizationId: existingOrg.id },
    })

    console.log('   🗑️  Eliminando Staff (excepto Superadmin global)...')
    await prisma.staff.deleteMany({
      where: {
        organizations: { some: { organizationId: existingOrg.id } },
        email: { not: SUPERADMIN_EMAIL }, // Keep superadmin
      },
    })

    if (venueIdList.length > 0) {
      console.log('   🗑️  Eliminando Venues...')
      await prisma.venue.deleteMany({
        where: { id: { in: venueIdList } },
      })
    }

    console.log('   🗑️  Eliminando Organization...')
    await prisma.organization.delete({
      where: { id: existingOrg.id },
    })

    console.log('   ✅ Limpieza completa\n')
  } else {
    console.log('   ℹ️  No hay datos previos de PlayTelecom\n')
  }

  // 1. Crear organización
  console.log('📋 Step 1: Crear Organización PlayTelecom')
  console.log('─────────────────────────────────────')

  const organization = await prisma.organization.create({
    data: ORG_CONFIG,
  })
  console.log(`✅ Organización creada: ${organization.name}`)
  console.log(`   ID: ${organization.id}`)
  console.log('')

  // 2. Crear venues
  console.log('🏢 Step 2: Crear Venues')
  console.log('─────────────────────────────────────')

  const venueMap: Record<string, any> = {}

  for (const venueConfig of VENUES) {
    const venue = await prisma.venue.create({
      data: {
        ...venueConfig,
        organizationId: organization.id,
        status: VenueStatus.ACTIVE,
      },
    })
    console.log(`✅ Venue creado: ${venue.name}`)
    console.log(`   ID: ${venue.id}`)
    console.log(`   Slug: ${venue.slug}`)

    // Guardar en mapa para usar después
    const key = venueConfig.slug.includes('sur') ? 'sur' : 'centro'
    venueMap[key] = venue
    console.log('')
  }

  // 3. Crear usuarios (Staff + StaffVenue)
  console.log('👥 Step 3: Crear Usuarios')
  console.log('─────────────────────────────────────')

  let pinCounter = 1000 // Start with 1000 to ensure unique PINs

  for (const userConfig of USERS) {
    // Buscar superadmin si existe globalmente, crear otros usuarios
    let staff = null
    if (userConfig.email === SUPERADMIN_EMAIL) {
      staff = await prisma.staff.findUnique({
        where: { email: userConfig.email },
      })
    }

    if (!staff) {
      staff = await prisma.staff.create({
        data: {
          firstName: userConfig.firstName,
          lastName: userConfig.lastName,
          email: userConfig.email,
          phone: userConfig.phone,
          active: true,
          emailVerified: true, // ✅ RESTORED: Email verified for authentication
          password: '$2b$10$si9eIkWqDj6JR7G2ixPH5uTk8UEf2sSr/dpHmUMPjHl73oeLJze.m', // ✅ RESTORED: Password = admin123
          organizations: {
            create: {
              organizationId: organization.id,
              role:
                (userConfig.role as string) === 'OWNER' || (userConfig.role as string) === 'SUPERADMIN'
                  ? 'OWNER'
                  : (userConfig.role as string) === 'ADMIN'
                    ? 'ADMIN'
                    : 'MEMBER',
              isActive: true,
              isPrimary: true,
              joinedAt: new Date(),
            },
          },
        },
      })
      console.log(`✅ Staff creado: ${staff.firstName} ${staff.lastName}`)
    } else {
      console.log(`✅ Staff encontrado: ${staff.firstName} ${staff.lastName}`)
      // Ensure StaffOrganization exists for this org (superadmin may belong to different org)
      await prisma.staffOrganization.upsert({
        where: {
          staffId_organizationId: {
            staffId: staff.id,
            organizationId: organization.id,
          },
        },
        update: { isActive: true, leftAt: null },
        create: {
          staffId: staff.id,
          organizationId: organization.id,
          role:
            (userConfig.role as string) === 'OWNER' || (userConfig.role as string) === 'SUPERADMIN'
              ? 'OWNER'
              : (userConfig.role as string) === 'ADMIN'
                ? 'ADMIN'
                : 'MEMBER',
          isActive: true,
          isPrimary: false,
        },
      })
    }

    // Agregar a cada venue especificado
    for (const venueKey of userConfig.venues) {
      const venue = venueMap[venueKey]
      if (!venue) {
        console.log(`⚠️  Venue no encontrado: ${venueKey}`)
        continue
      }

      // Generate unique PIN for this staff-venue combination
      const uniquePin = (pinCounter++).toString()

      await prisma.staffVenue.create({
        data: {
          staffId: staff.id,
          venueId: venue.id,
          role: userConfig.role,
          pin: uniquePin,
        },
      })
      console.log(`   ✅ Agregado a ${venue.name} como ${userConfig.role} (PIN: ${uniquePin})`)
    }
    console.log('')
  }

  // 4. Configurar módulo de inventario serializado
  console.log('📦 Step 4: Módulo SERIALIZED_INVENTORY')
  console.log('─────────────────────────────────────')

  for (const [key, venue] of Object.entries(venueMap)) {
    // Buscar un staff OWNER o SUPERADMIN para habilitar el módulo
    const staffVenue = await prisma.staffVenue.findFirst({
      where: {
        venueId: venue.id,
        role: { in: [StaffRole.OWNER, StaffRole.SUPERADMIN] },
      },
    })

    if (!staffVenue) {
      console.log(`⚠️  No hay OWNER/SUPERADMIN en ${venue.name}, saltando módulo`)
      continue
    }

    // Habilitar módulo
    await moduleService.enableModule(venue.id, MODULE_CODES.SERIALIZED_INVENTORY, staffVenue.staffId, undefined, 'telecom')
    console.log(`✅ Módulo habilitado en ${venue.name}`)

    // Deshabilitar sistema de turnos
    await prisma.venueSettings.upsert({
      where: { venueId: venue.id },
      update: { enableShifts: false },
      create: { venueId: venue.id, enableShifts: false },
    })
    console.log(`   ✅ Turnos deshabilitados`)
    console.log('')
  }

  // 5. Configurar módulo WHITE_LABEL_DASHBOARD
  console.log('🎨 Step 5: Módulo WHITE_LABEL_DASHBOARD')
  console.log('─────────────────────────────────────')

  // WHITE_LABEL_DASHBOARD configuration from original setup-playtelecom.js
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
        {
          id: 'stock',
          type: 'feature',
          featureCode: 'SERIALIZED_STOCK',
          label: 'Inventario Serializado',
          icon: 'Package',
          order: 2,
        },
        {
          id: 'promoters',
          type: 'feature',
          featureCode: 'PROMOTERS_AUDIT',
          label: 'Auditoría de Promotores',
          icon: 'Users',
          order: 3,
        },
        {
          id: 'stores',
          type: 'feature',
          featureCode: 'STORES_ANALYSIS',
          label: 'Análisis de Tiendas',
          icon: 'Store',
          order: 4,
        },
        {
          id: 'managers',
          type: 'feature',
          featureCode: 'MANAGERS_DASHBOARD',
          label: 'Gerentes',
          icon: 'ShieldCheck',
          order: 5,
        },
        {
          id: 'commissions',
          type: 'feature',
          featureCode: 'AVOQADO_COMMISSIONS',
          label: 'Comisiones',
          icon: 'DollarSign',
          order: 6,
        },
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

  // Find WHITE_LABEL_DASHBOARD module
  const whiteLabelModule = await prisma.module.findFirst({
    where: { code: 'WHITE_LABEL_DASHBOARD' },
  })

  if (whiteLabelModule) {
    // Find a staff OWNER to use as enabledBy
    const staffVenue = await prisma.staffVenue.findFirst({
      where: {
        role: { in: [StaffRole.OWNER, StaffRole.SUPERADMIN] },
      },
    })

    if (staffVenue) {
      // Create OrganizationModule for WHITE_LABEL_DASHBOARD
      await prisma.organizationModule.create({
        data: {
          organizationId: organization.id,
          moduleId: whiteLabelModule.id,
          config: whiteLabelConfig,
          enabledBy: staffVenue.staffId,
        },
      })
      console.log('✅ OrganizationModule WHITE_LABEL_DASHBOARD creado')

      // Create VenueModule for each venue
      for (const [key, venue] of Object.entries(venueMap)) {
        await prisma.venueModule.create({
          data: {
            venueId: venue.id,
            moduleId: whiteLabelModule.id,
            config: whiteLabelConfig,
            enabledBy: staffVenue.staffId,
          },
        })
        console.log(`   ✅ VenueModule habilitado en ${venue.name}`)
      }
    } else {
      console.log('⚠️  No se encontró staff OWNER/SUPERADMIN para habilitar WHITE_LABEL_DASHBOARD')
    }
  } else {
    console.log('⚠️  Módulo WHITE_LABEL_DASHBOARD no encontrado en la base de datos')
  }
  console.log('')

  // 6. Crear categorías
  console.log('📂 Step 6: Categorías de Productos')
  console.log('─────────────────────────────────────')

  for (const [key, venue] of Object.entries(venueMap)) {
    console.log(`\n🏢 ${venue.name}:`)

    for (const cat of CATEGORIES) {
      const category = await prisma.itemCategory.upsert({
        where: { venueId_name: { venueId: venue.id, name: cat.name } },
        create: {
          venueId: venue.id,
          ...cat,
        },
        update: {
          description: cat.description,
          color: cat.color,
          sortOrder: cat.sortOrder,
          requiresPreRegistration: cat.requiresPreRegistration,
        },
      })

      const icon = cat.requiresPreRegistration ? '🔒' : '🔓'
      console.log(`   ${icon} ${category.name}`)
    }
  }
  console.log('')

  // 7. Crear terminals (TPVs)
  console.log('💳 Step 7: Terminales (TPVs)')
  console.log('─────────────────────────────────────')

  // Create terminal for Sur (using numeric serial number format like Blumon)
  const surTerminal = await prisma.terminal.create({
    data: {
      venueId: venueMap.sur.id,
      name: 'Terminal Sur',
      serialNumber: '2841548417', // Numeric format like Blumon devices
      type: 'TPV_ANDROID',
      status: 'ACTIVE',
      lastHeartbeat: new Date(),
    },
  })
  console.log(`✅ Terminal creado: ${surTerminal.name} (SN: ${surTerminal.serialNumber})`)

  // Create terminal for Centro
  const centroTerminal = await prisma.terminal.create({
    data: {
      venueId: venueMap.centro.id,
      name: 'Terminal Centro',
      serialNumber: '2841548418', // Numeric format like Blumon devices
      type: 'TPV_ANDROID',
      status: 'ACTIVE',
      lastHeartbeat: new Date(),
    },
  })
  console.log(`✅ Terminal creado: ${centroTerminal.name} (SN: ${centroTerminal.serialNumber})`)
  console.log('')

  // 8. Crear metas de la organización (goals)
  console.log('🎯 Step 8: Metas de Organización')
  console.log('─────────────────────────────────────')

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const dailyGoal = await prisma.organizationGoal.upsert({
    where: {
      organizationId_period_periodDate: {
        organizationId: organization.id,
        period: 'daily',
        periodDate: today,
      },
    },
    create: {
      organizationId: organization.id,
      period: 'daily',
      periodDate: today,
      salesTarget: 75000, // Meta diaria de $75k
      volumeTarget: 80, // Meta de 80 SIMs vendidas
    },
    update: {},
  })
  console.log(`✅ Meta diaria configurada: $${dailyGoal.salesTarget} / ${dailyGoal.volumeTarget} SIMs`)
  console.log('')

  // 9. Crear TimeEntries (asistencia)
  console.log('⏰ Step 9: Registros de Asistencia (TimeEntry)')
  console.log('─────────────────────────────────────')

  // Get all staff for each venue
  const surStaffList = await prisma.staffVenue.findMany({
    where: { venueId: venueMap.sur.id },
  })

  const centroStaffList = await prisma.staffVenue.findMany({
    where: { venueId: venueMap.centro.id },
  })

  // Create TimeEntry for today for most staff (to show attendance)
  const clockInTime = new Date()
  clockInTime.setHours(9, 0, 0, 0) // Start at 9 AM

  // Sur: 3 out of 4 cashiers checked in (one missing for attendance alert)
  const surCashiers = surStaffList.filter(s => s.role === 'CASHIER')
  for (let i = 0; i < Math.min(1, surCashiers.length); i++) {
    await prisma.timeEntry.create({
      data: {
        staffId: surCashiers[i].staffId,
        venueId: venueMap.sur.id,
        clockInTime: clockInTime,
        clockOutTime: null, // Still active
      },
    })
  }

  // Centro: All cashiers checked in
  const centroCashiers = centroStaffList.filter(s => s.role === 'CASHIER')
  for (const cashier of centroCashiers) {
    await prisma.timeEntry.create({
      data: {
        staffId: cashier.staffId,
        venueId: venueMap.centro.id,
        clockInTime: clockInTime,
        clockOutTime: null,
      },
    })
  }

  console.log(`✅ ${surCashiers.length > 0 ? 1 : 0} TimeEntries creados para Sur`)
  console.log(`✅ ${centroCashiers.length} TimeEntries creados para Centro`)
  console.log('   (Simula asistencia para el día de hoy)')
  console.log('')

  // 10. Crear datos de ejemplo (ventas de prueba para esta semana)
  console.log('💰 Step 10: Datos de Ejemplo (Ventas)')
  console.log('─────────────────────────────────────')

  // Crear algunas ventas de ejemplo para el Command Center
  const surStaff = await prisma.staffVenue.findFirst({
    where: {
      venueId: venueMap.sur.id,
      role: StaffRole.WAITER,
    },
  })

  const centroStaff = await prisma.staffVenue.findFirst({
    where: {
      venueId: venueMap.centro.id,
      role: StaffRole.WAITER,
    },
  })

  if (surStaff && centroStaff) {
    // Crear categorías para usar en los items
    const negraCategory = await prisma.itemCategory.findFirst({
      where: { venueId: venueMap.sur.id, name: 'Negra' },
    })

    if (negraCategory) {
      console.log('📝 Creando ventas de ejemplo...')

      // Ventas para hoy (miércoles)
      const todaySales = [
        { venue: venueMap.sur, staff: surStaff.staffId, amount: 754, hoursAgo: 9 }, // 06:34 AM
        { venue: venueMap.sur, staff: surStaff.staffId, amount: 200, hoursAgo: 1 }, // 08:25 AM
        { venue: venueMap.centro, staff: centroStaff.staffId, amount: 410, hoursAgo: 2 }, // 07:26 AM
      ]

      for (const sale of todaySales) {
        const saleTime = new Date()
        saleTime.setHours(saleTime.getHours() - sale.hoursAgo)

        // Create Order
        const order = await prisma.order.create({
          data: {
            venueId: sale.venue.id,
            orderNumber: Math.floor(Math.random() * 1000000).toString(),
            status: 'COMPLETED',
            total: sale.amount,
            subtotal: sale.amount,
            discountAmount: 0,
            tipAmount: 0,
            taxAmount: 0,
            createdById: sale.staff,
            servedById: sale.staff,
            createdAt: saleTime,
            updatedAt: saleTime,
          },
        })

        // Create Payment associated with Order
        await prisma.payment.create({
          data: {
            venueId: sale.venue.id,
            orderId: order.id,
            amount: sale.amount,
            tipAmount: 0,
            feePercentage: 0, // No commission for test data
            feeAmount: 0,
            netAmount: sale.amount, // Net = Amount when no fees
            method: 'CASH',
            source: 'OTHER',
            status: 'COMPLETED',
            processedById: sale.staff,
            createdAt: saleTime,
            updatedAt: saleTime,
          },
        })
      }

      console.log(`   ✅ ${todaySales.length} ventas creadas para hoy`)
      console.log('')
    }
  }

  // 11. Items Serializados de Ejemplo (SIMs)
  console.log('📱 Step 11: Items Serializados de Ejemplo (SIMs)')
  console.log('─────────────────────────────────────')

  for (const [key, venue] of Object.entries(venueMap)) {
    const negraCategory = await prisma.itemCategory.findFirst({
      where: { venueId: venue.id, name: 'Negra' },
    })

    if (negraCategory) {
      // Find an OWNER or MANAGER to use as createdBy
      const staffVenue = await prisma.staffVenue.findFirst({
        where: {
          venueId: venue.id,
          role: { in: [StaffRole.OWNER, StaffRole.MANAGER, StaffRole.SUPERADMIN] },
        },
      })

      if (!staffVenue) {
        console.log(`   ⚠️  No hay staff disponible para crear SIMs en ${venue.name}`)
        continue
      }

      // Create 50 SIMs for each venue (25 sold, 25 available)
      const simsToCreate = 50
      const simsSold = 25

      for (let i = 1; i <= simsToCreate; i++) {
        const serialNumber = `SIM-${key.toUpperCase()}-${String(i).padStart(4, '0')}`
        const isSold = i <= simsSold

        await prisma.serializedItem.create({
          data: {
            venueId: venue.id,
            categoryId: negraCategory.id,
            serialNumber,
            status: isSold ? 'SOLD' : 'AVAILABLE',
            soldAt: isSold ? new Date() : null,
            createdBy: staffVenue.staffId,
            // Note: orderItemId would link to an OrderItem if this was a real sale
          },
        })
      }

      console.log(`   ✅ ${simsToCreate} SIMs creadas para ${venue.name}`)
      console.log(`      - ${simsSold} vendidas`)
      console.log(`      - ${simsToCreate - simsSold} disponibles`)
    }
  }
  console.log('')

  // 12. Configuración White-Label (slug para rutas /wl/playtelecom)
  console.log('🎨 Step 12: Configuración White-Label Slug')
  console.log('─────────────────────────────────────')

  await prisma.organization.update({
    where: { id: organization.id },
    data: {
      slug: 'playtelecom', // For white-label routes: /wl/playtelecom/*
    },
  })
  console.log('✅ White-label slug configurado: playtelecom')
  console.log('   Rutas disponibles:')
  console.log('   - /wl/playtelecom/command-center')
  console.log('   - /wl/playtelecom/stores (venues)')
  console.log('')

  // 13. Resumen final
  console.log('═══════════════════════════════════════════════')
  console.log('📊 RESUMEN DEL SETUP')
  console.log('═══════════════════════════════════════════════\n')

  const venueCount = await prisma.venue.count({ where: { organizationId: organization.id } })
  const staffCount = await prisma.staff.count({
    where: { organizations: { some: { organizationId: organization.id } } },
  })
  const categoryCount = await prisma.itemCategory.count({
    where: { venue: { organizationId: organization.id } },
  })

  console.log(`✅ Organización: ${organization.name}`)
  console.log(`   ID: ${organization.id}`)
  console.log(`   Venues: ${venueCount}`)
  console.log(`   Usuarios: ${staffCount}`)
  console.log(`   Categorías totales: ${categoryCount}`)
  console.log('')

  console.log('🏢 VENUES:')
  for (const [key, venue] of Object.entries(venueMap)) {
    const staffCount = await prisma.staffVenue.count({ where: { venueId: venue.id } })
    console.log(`   • ${venue.name} (${venue.slug})`)
    console.log(`     Staff: ${staffCount}`)
    console.log(`     ID: ${venue.id}`)
  }
  console.log('')

  console.log('👥 USUARIOS:')
  const allStaff = await prisma.staff.findMany({
    where: { organizations: { some: { organizationId: organization.id } } },
    include: {
      venues: {
        include: {
          venue: { select: { name: true } },
        },
      },
    },
    orderBy: [{ firstName: 'asc' }],
  })

  for (const staff of allStaff) {
    console.log(`   👤 ${staff.firstName} ${staff.lastName}`)
    console.log(`      Email: ${staff.email}`)
    console.log(`      Venues:`)

    for (const staffVenue of staff.venues) {
      const roleEmoji: Record<StaffRole, string> = {
        SUPERADMIN: '👑',
        OWNER: '🔑',
        ADMIN: '⚙️',
        MANAGER: '👔',
        CASHIER: '💰',
        WAITER: '👨‍💼',
        HOST: '🎯',
        KITCHEN: '👨‍🍳',
        VIEWER: '👁️',
      }
      const emoji = roleEmoji[staffVenue.role] || '👤'

      console.log(`        ${emoji} ${staffVenue.venue.name} - ${staffVenue.role}`)
    }
    console.log('')
  }

  const terminalCount = await prisma.terminal.count({
    where: { venue: { organizationId: organization.id } },
  })

  console.log(`💳 Terminales: ${terminalCount}`)
  console.log('')

  console.log('✅ Setup completo!')
  console.log('')
  console.log('📱 CREDENCIALES PARA LOGIN:')
  console.log('─────────────────────────────────────')
  console.log('Todos los usuarios:')
  console.log('   Password: admin123 (hash: $2b$10$si9eIkWqDj6JR7G2ixPH5u...)')
  console.log('   emailVerified: true')
  console.log('')
  console.log('Superadmin:')
  console.log(`   Email: ${SUPERADMIN_EMAIL}`)
  console.log(`   UID: ${SUPERADMIN_UID}`)
  console.log('')
  console.log('🔗 URLs del Dashboard:')
  console.log('   Regular mode:')
  console.log(`     Sur: http://localhost:5173/venues/playtelecom-sur/dashboard`)
  console.log(`     Centro: http://localhost:5173/venues/playtelecom-centro/dashboard`)
  console.log('')
  console.log('   White-label mode:')
  console.log(`     Org: http://localhost:5173/wl/playtelecom/command-center`)
  console.log(`     Sur: http://localhost:5173/wl/playtelecom/playtelecom-sur/dashboard`)
  console.log(`     Centro: http://localhost:5173/wl/playtelecom/playtelecom-centro/dashboard`)
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
