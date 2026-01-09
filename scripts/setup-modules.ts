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
