/**
 * Setup inicial para sistema de módulos.
 * Crear módulo SERIALIZED_INVENTORY con presets por industria.
 *
 * Usage: npx ts-node scripts/setup-modules.ts
 */

import prisma from '../src/utils/prismaClient'

async function main() {
  console.log('🚀 Setting up modules...\n')

  // Create SERIALIZED_INVENTORY module
  const serializedInventoryModule = await prisma.module.upsert({
    where: { code: 'SERIALIZED_INVENTORY' },
    create: {
      code: 'SERIALIZED_INVENTORY',
      name: 'Inventario Serializado',
      description:
        'Productos con código de barras único (SIMs, joyas, electrónicos). Cada item tiene un identificador único y se vende individualmente.',
      defaultConfig: {
        labels: {
          item: 'Producto',
          barcode: 'Código de Barras',
          category: 'Categoría',
          scan: 'Escanear',
          register: 'Registrar',
        },
        features: {
          allowUnregisteredSale: true, // Allow selling items not in inventory
          requireCategorySelection: true, // Require category when registering unregistered items
          showStockCounts: true, // Show available/sold counts in UI
        },
        ui: {
          simplifiedOrderFlow: false, // Normal multi-step order flow
          skipTipScreen: false, // Show tip screen
          skipReviewScreen: false, // Show review screen
          enableShifts: true, // Enable shift management
        },
        attendance: {
          requireClockInPhoto: false, // No photo required at clock-in
          requireClockInGps: false, // No GPS required at clock-in
          requireClockOutPhoto: false, // No photo required at clock-out
          requireClockOutGps: false, // No GPS required at clock-out
        },
      },
      presets: {
        telecom: {
          labels: {
            item: 'SIM',
            barcode: 'ICCID',
            category: 'Tipo de SIM',
            scan: 'Escanear SIM',
            register: 'Alta de SIM',
          },
          ui: {
            simplifiedOrderFlow: true, // Single button "Vender" on welcome
            skipTipScreen: true, // No tips for telecom
            skipReviewScreen: true, // Skip review, go direct to payment
            enableShifts: false, // No shift management, just breaks
          },
          attendance: {
            requireClockInPhoto: true, // Photo required at clock-in
            requireClockInGps: true, // GPS location required at clock-in
            requireClockOutPhoto: true, // Photo required at clock-out
            requireClockOutGps: false, // No GPS at clock-out
          },
        },
        jewelry: {
          labels: {
            item: 'Pieza',
            barcode: 'Certificado',
            category: 'Tipo de Piedra',
            scan: 'Escanear Certificado',
            register: 'Registrar Pieza',
          },
          ui: {
            simplifiedOrderFlow: false, // Normal flow for jewelry
            skipTipScreen: true, // No tips for jewelry
            skipReviewScreen: false, // Show review for high-value items
            enableShifts: true, // Normal shift management
          },
          attendance: {
            requireClockInPhoto: false,
            requireClockInGps: false,
            requireClockOutPhoto: false,
            requireClockOutGps: false,
          },
        },
        electronics: {
          labels: {
            item: 'Dispositivo',
            barcode: 'Número de Serie',
            category: 'Tipo de Dispositivo',
            scan: 'Escanear Serie',
            register: 'Registrar Dispositivo',
          },
          ui: {
            simplifiedOrderFlow: false, // Normal flow
            skipTipScreen: true, // No tips
            skipReviewScreen: false, // Show review for electronics
            enableShifts: true, // Normal shift management
          },
          attendance: {
            requireClockInPhoto: false,
            requireClockInGps: false,
            requireClockOutPhoto: false,
            requireClockOutGps: false,
          },
        },
      },
      configSchema: {
        type: 'object',
        properties: {
          labels: {
            type: 'object',
            properties: {
              item: { type: 'string' },
              barcode: { type: 'string' },
              category: { type: 'string' },
              scan: { type: 'string' },
              register: { type: 'string' },
            },
          },
          features: {
            type: 'object',
            properties: {
              allowUnregisteredSale: { type: 'boolean' },
              requireCategorySelection: { type: 'boolean' },
              showStockCounts: { type: 'boolean' },
            },
          },
          ui: {
            type: 'object',
            properties: {
              simplifiedOrderFlow: { type: 'boolean' },
              skipTipScreen: { type: 'boolean' },
              skipReviewScreen: { type: 'boolean' },
              enableShifts: { type: 'boolean' },
            },
          },
          attendance: {
            type: 'object',
            properties: {
              requireClockInPhoto: { type: 'boolean' },
              requireClockInGps: { type: 'boolean' },
              requireClockOutPhoto: { type: 'boolean' },
              requireClockOutGps: { type: 'boolean' },
            },
          },
        },
      },
    },
    update: {
      // Update all config when module already exists
      name: 'Inventario Serializado',
      description:
        'Productos con código de barras único (SIMs, joyas, electrónicos). Cada item tiene un identificador único y se vende individualmente.',
      defaultConfig: {
        labels: {
          item: 'Producto',
          barcode: 'Código de Barras',
          category: 'Categoría',
          scan: 'Escanear',
          register: 'Registrar',
        },
        features: {
          allowUnregisteredSale: true,
          requireCategorySelection: true,
          showStockCounts: true,
        },
        ui: {
          simplifiedOrderFlow: false,
          skipTipScreen: false,
          skipReviewScreen: false,
          enableShifts: true,
        },
        attendance: {
          requireClockInPhoto: false,
          requireClockInGps: false,
          requireClockOutPhoto: false,
          requireClockOutGps: false,
        },
      },
      presets: {
        telecom: {
          labels: {
            item: 'SIM',
            barcode: 'ICCID',
            category: 'Tipo de SIM',
            scan: 'Escanear SIM',
            register: 'Alta de SIM',
          },
          ui: {
            simplifiedOrderFlow: true,
            skipTipScreen: true,
            skipReviewScreen: true,
            enableShifts: false,
          },
          attendance: {
            requireClockInPhoto: true,
            requireClockInGps: true,
            requireClockOutPhoto: true,
            requireClockOutGps: false,
          },
        },
        jewelry: {
          labels: {
            item: 'Pieza',
            barcode: 'Certificado',
            category: 'Tipo de Piedra',
            scan: 'Escanear Certificado',
            register: 'Registrar Pieza',
          },
          ui: {
            simplifiedOrderFlow: false,
            skipTipScreen: true,
            skipReviewScreen: false,
            enableShifts: true,
          },
          attendance: {
            requireClockInPhoto: false,
            requireClockInGps: false,
            requireClockOutPhoto: false,
            requireClockOutGps: false,
          },
        },
        electronics: {
          labels: {
            item: 'Dispositivo',
            barcode: 'Número de Serie',
            category: 'Tipo de Dispositivo',
            scan: 'Escanear Serie',
            register: 'Registrar Dispositivo',
          },
          ui: {
            simplifiedOrderFlow: false,
            skipTipScreen: true,
            skipReviewScreen: false,
            enableShifts: true,
          },
          attendance: {
            requireClockInPhoto: false,
            requireClockInGps: false,
            requireClockOutPhoto: false,
            requireClockOutGps: false,
          },
        },
      },
      configSchema: {
        type: 'object',
        properties: {
          labels: {
            type: 'object',
            properties: {
              item: { type: 'string' },
              barcode: { type: 'string' },
              category: { type: 'string' },
              scan: { type: 'string' },
              register: { type: 'string' },
            },
          },
          features: {
            type: 'object',
            properties: {
              allowUnregisteredSale: { type: 'boolean' },
              requireCategorySelection: { type: 'boolean' },
              showStockCounts: { type: 'boolean' },
            },
          },
          ui: {
            type: 'object',
            properties: {
              simplifiedOrderFlow: { type: 'boolean' },
              skipTipScreen: { type: 'boolean' },
              skipReviewScreen: { type: 'boolean' },
              enableShifts: { type: 'boolean' },
            },
          },
          attendance: {
            type: 'object',
            properties: {
              requireClockInPhoto: { type: 'boolean' },
              requireClockInGps: { type: 'boolean' },
              requireClockOutPhoto: { type: 'boolean' },
              requireClockOutGps: { type: 'boolean' },
            },
          },
        },
      },
    },
  })

  console.log(`✅ Module: ${serializedInventoryModule.code}`)
  console.log(`   ID: ${serializedInventoryModule.id}`)
  console.log(`   Name: ${serializedInventoryModule.name}`)
  console.log(`   Presets: telecom, jewelry, electronics\n`)

  // Create ATTENDANCE_TRACKING module (placeholder for future)
  const attendanceModule = await prisma.module.upsert({
    where: { code: 'ATTENDANCE_TRACKING' },
    create: {
      code: 'ATTENDANCE_TRACKING',
      name: 'Control de Asistencia',
      description: 'Registro de entradas y salidas de empleados con foto y ubicación.',
      defaultConfig: {
        labels: {
          checkIn: 'Entrada',
          checkOut: 'Salida',
          break: 'Descanso',
        },
        features: {
          requirePhoto: false,
          requireLocation: false,
          allowManualEntry: true,
        },
      },
      presets: {
        strict: {
          features: {
            requirePhoto: true,
            requireLocation: true,
            allowManualEntry: false,
          },
        },
        flexible: {
          features: {
            requirePhoto: false,
            requireLocation: false,
            allowManualEntry: true,
          },
        },
      },
    },
    update: {
      name: 'Control de Asistencia',
      description: 'Registro de entradas y salidas de empleados con foto y ubicación.',
    },
  })

  console.log(`✅ Module: ${attendanceModule.code}`)
  console.log(`   ID: ${attendanceModule.id}`)
  console.log(`   Name: ${attendanceModule.name}`)
  console.log(`   Presets: strict, flexible\n`)

  // Create WHITE_LABEL_DASHBOARD module
  const whiteLabelModule = await prisma.module.upsert({
    where: { code: 'WHITE_LABEL_DASHBOARD' },
    create: {
      code: 'WHITE_LABEL_DASHBOARD',
      name: 'Dashboard White Label',
      description:
        'Dashboards personalizados con branding y características específicas para clientes enterprise. Permite customización de tema, navegación y funcionalidades habilitadas.',
      defaultConfig: {
        version: '1.0',
        theme: {
          primaryColor: '#3b82f6',
          brandName: 'Mi Empresa',
          logo: null,
          favicon: null,
        },
        enabledFeatures: [],
        navigation: {
          layout: 'default',
          items: [],
        },
        featureConfigs: {},
      },
      presets: {
        telecom: {
          theme: {
            primaryColor: '#ff6b00',
            brandName: 'Telecom Dashboard',
          },
          enabledFeatures: [
            { code: 'COMMAND_CENTER', source: 'builtin' },
            { code: 'SERIALIZED_STOCK', source: 'builtin' },
            { code: 'STORES_ANALYSIS', source: 'builtin' },
            { code: 'PROMOTERS_AUDIT', source: 'builtin' },
            { code: 'AVOQADO_COMMISSIONS', source: 'builtin' },
          ],
          navigation: {
            layout: 'sidebar-left',
            items: [
              {
                id: 'command-center',
                label: 'Centro de Comando',
                icon: 'LayoutDashboard',
                route: '/wl/command-center',
                order: 0,
              },
              { id: 'stock', label: 'Stock', icon: 'Package', route: '/wl/stock', order: 1 },
              { id: 'stores', label: 'Tiendas', icon: 'Store', route: '/wl/stores', order: 2 },
              { id: 'promoters', label: 'Promotores', icon: 'Users', route: '/wl/promoters', order: 3 },
              {
                id: 'commissions',
                label: 'Comisiones',
                icon: 'DollarSign',
                route: '/wl/commissions',
                order: 4,
              },
            ],
          },
        },
        jewelry: {
          theme: {
            primaryColor: '#d4af37',
            brandName: 'Jewelry Management',
          },
          enabledFeatures: [
            { code: 'APPRAISALS', source: 'builtin' },
            { code: 'CONSIGNMENT', source: 'builtin' },
            { code: 'AVOQADO_REPORTS', source: 'builtin' },
          ],
          navigation: {
            layout: 'sidebar-left',
            items: [
              { id: 'appraisals', label: 'Valuaciones', icon: 'Gem', route: '/wl/appraisals', order: 0 },
              {
                id: 'consignment',
                label: 'Consignación',
                icon: 'Handshake',
                route: '/wl/consignment',
                order: 1,
              },
              { id: 'reports', label: 'Reportes', icon: 'FileText', route: '/wl/reports', order: 2 },
            ],
          },
        },
        retail: {
          theme: {
            primaryColor: '#10b981',
            brandName: 'Retail Dashboard',
          },
          enabledFeatures: [
            { code: 'AVOQADO_REPORTS', source: 'builtin' },
            { code: 'AVOQADO_TIPS', source: 'builtin' },
            { code: 'AVOQADO_COMMISSIONS', source: 'builtin' },
          ],
          navigation: {
            layout: 'sidebar-left',
            items: [
              { id: 'reports', label: 'Reportes', icon: 'FileText', route: '/wl/reports', order: 0 },
              { id: 'tips', label: 'Propinas', icon: 'Gift', route: '/wl/tips', order: 1 },
              {
                id: 'commissions',
                label: 'Comisiones',
                icon: 'DollarSign',
                route: '/wl/commissions',
                order: 2,
              },
            ],
          },
        },
        custom: {
          theme: {
            primaryColor: '#6b7280',
            brandName: 'Custom Dashboard',
          },
          enabledFeatures: [],
          navigation: {
            layout: 'sidebar-left',
            items: [],
          },
        },
      },
      configSchema: {
        type: 'object',
        required: ['version', 'theme', 'enabledFeatures', 'navigation'],
        properties: {
          version: { type: 'string' },
          theme: {
            type: 'object',
            required: ['primaryColor', 'brandName'],
            properties: {
              primaryColor: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
              brandName: { type: 'string', minLength: 1, maxLength: 50 },
              logo: { type: ['string', 'null'] },
              favicon: { type: ['string', 'null'] },
            },
          },
          enabledFeatures: {
            type: 'array',
            items: {
              type: 'object',
              required: ['code', 'source'],
              properties: {
                code: { type: 'string' },
                source: { enum: ['builtin', 'custom'] },
              },
            },
          },
          navigation: {
            type: 'object',
            required: ['layout', 'items'],
            properties: {
              layout: { enum: ['sidebar-left', 'sidebar-right', 'top-nav'] },
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['id', 'label', 'route', 'order'],
                  properties: {
                    id: { type: 'string' },
                    label: { type: 'string' },
                    icon: { type: 'string' },
                    route: { type: 'string' },
                    order: { type: 'number' },
                  },
                },
              },
            },
          },
          featureConfigs: {
            type: 'object',
            additionalProperties: true,
          },
        },
      },
    },
    update: {
      name: 'Dashboard White Label',
      description:
        'Dashboards personalizados con branding y características específicas para clientes enterprise. Permite customización de tema, navegación y funcionalidades habilitadas.',
      defaultConfig: {
        version: '1.0',
        theme: {
          primaryColor: '#3b82f6',
          brandName: 'Mi Empresa',
          logo: null,
          favicon: null,
        },
        enabledFeatures: [],
        navigation: {
          layout: 'default',
          items: [],
        },
        featureConfigs: {},
      },
      presets: {
        telecom: {
          theme: {
            primaryColor: '#ff6b00',
            brandName: 'Telecom Dashboard',
          },
          enabledFeatures: [
            { code: 'COMMAND_CENTER', source: 'builtin' },
            { code: 'SERIALIZED_STOCK', source: 'builtin' },
            { code: 'STORES_ANALYSIS', source: 'builtin' },
            { code: 'PROMOTERS_AUDIT', source: 'builtin' },
            { code: 'AVOQADO_COMMISSIONS', source: 'builtin' },
          ],
          navigation: {
            layout: 'sidebar-left',
            items: [
              {
                id: 'command-center',
                label: 'Centro de Comando',
                icon: 'LayoutDashboard',
                route: '/wl/command-center',
                order: 0,
              },
              { id: 'stock', label: 'Stock', icon: 'Package', route: '/wl/stock', order: 1 },
              { id: 'stores', label: 'Tiendas', icon: 'Store', route: '/wl/stores', order: 2 },
              { id: 'promoters', label: 'Promotores', icon: 'Users', route: '/wl/promoters', order: 3 },
              {
                id: 'commissions',
                label: 'Comisiones',
                icon: 'DollarSign',
                route: '/wl/commissions',
                order: 4,
              },
            ],
          },
        },
        jewelry: {
          theme: {
            primaryColor: '#d4af37',
            brandName: 'Jewelry Management',
          },
          enabledFeatures: [
            { code: 'APPRAISALS', source: 'builtin' },
            { code: 'CONSIGNMENT', source: 'builtin' },
            { code: 'AVOQADO_REPORTS', source: 'builtin' },
          ],
          navigation: {
            layout: 'sidebar-left',
            items: [
              { id: 'appraisals', label: 'Valuaciones', icon: 'Gem', route: '/wl/appraisals', order: 0 },
              {
                id: 'consignment',
                label: 'Consignación',
                icon: 'Handshake',
                route: '/wl/consignment',
                order: 1,
              },
              { id: 'reports', label: 'Reportes', icon: 'FileText', route: '/wl/reports', order: 2 },
            ],
          },
        },
        retail: {
          theme: {
            primaryColor: '#10b981',
            brandName: 'Retail Dashboard',
          },
          enabledFeatures: [
            { code: 'AVOQADO_REPORTS', source: 'builtin' },
            { code: 'AVOQADO_TIPS', source: 'builtin' },
            { code: 'AVOQADO_COMMISSIONS', source: 'builtin' },
          ],
          navigation: {
            layout: 'sidebar-left',
            items: [
              { id: 'reports', label: 'Reportes', icon: 'FileText', route: '/wl/reports', order: 0 },
              { id: 'tips', label: 'Propinas', icon: 'Gift', route: '/wl/tips', order: 1 },
              {
                id: 'commissions',
                label: 'Comisiones',
                icon: 'DollarSign',
                route: '/wl/commissions',
                order: 2,
              },
            ],
          },
        },
        custom: {
          theme: {
            primaryColor: '#6b7280',
            brandName: 'Custom Dashboard',
          },
          enabledFeatures: [],
          navigation: {
            layout: 'sidebar-left',
            items: [],
          },
        },
      },
      configSchema: {
        type: 'object',
        required: ['version', 'theme', 'enabledFeatures', 'navigation'],
        properties: {
          version: { type: 'string' },
          theme: {
            type: 'object',
            required: ['primaryColor', 'brandName'],
            properties: {
              primaryColor: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
              brandName: { type: 'string', minLength: 1, maxLength: 50 },
              logo: { type: ['string', 'null'] },
              favicon: { type: ['string', 'null'] },
            },
          },
          enabledFeatures: {
            type: 'array',
            items: {
              type: 'object',
              required: ['code', 'source'],
              properties: {
                code: { type: 'string' },
                source: { enum: ['builtin', 'custom'] },
              },
            },
          },
          navigation: {
            type: 'object',
            required: ['layout', 'items'],
            properties: {
              layout: { enum: ['sidebar-left', 'sidebar-right', 'top-nav'] },
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['id', 'label', 'route', 'order'],
                  properties: {
                    id: { type: 'string' },
                    label: { type: 'string' },
                    icon: { type: 'string' },
                    route: { type: 'string' },
                    order: { type: 'number' },
                  },
                },
              },
            },
          },
          featureConfigs: {
            type: 'object',
            additionalProperties: true,
          },
        },
      },
    },
  })

  console.log(`✅ Module: ${whiteLabelModule.code}`)
  console.log(`   ID: ${whiteLabelModule.id}`)
  console.log(`   Name: ${whiteLabelModule.name}`)
  console.log(`   Presets: telecom, jewelry, retail, custom\n`)

  // Summary
  const moduleCount = await prisma.module.count({ where: { active: true } })
  console.log(`\n📊 Summary: ${moduleCount} active modules in system`)
  console.log('✅ Setup complete!\n')
}

main()
  .catch(e => {
    console.error('❌ Error:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
