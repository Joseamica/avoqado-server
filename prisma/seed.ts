import { faker } from '@faker-js/faker'
import {
  AccountType,
  ChargeType,
  FeatureCategory,
  InvitationStatus,
  InvitationType,
  InvoiceStatus,
  KitchenStatus,
  MenuType,
  MovementType,
  NotificationChannel,
  NotificationPriority,
  NotificationType,
  OrderSource,
  OrderStatus,
  OrderType,
  PaymentMethod,
  PaymentStatus,
  PrismaClient,
  ProductType,
  ProviderType,
  ReceiptStatus,
  ReviewSource,
  SettlementStatus,
  StaffRole,
  TerminalStatus,
  TerminalType,
  TransactionCardType,
  TransactionStatus,
  TransactionType,
  VenueType,
} from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

const HASH_ROUNDS = 10

export function generateSlug(text: string): string {
  if (!text) return ''
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-') // Replace spaces with -
    .replace(/[&/\\#,+()$~%.'":*?<>{}]/g, '') // Remove special characters
    .replace(/--+/g, '-') // Replace multiple - with single -
    .replace(/^-+/, '') // Trim - from start of text
    .replace(/-+$/, '') // Trim - from end of text
}

// Función para obtener un elemento aleatorio de un array
function getRandomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

// Para obtener una muestra aleatoria de un array
function getRandomSample<T>(arr: T[], count: number): T[] {
  const shuffled = [...arr].sort(() => 0.5 - Math.random())
  return shuffled.slice(0, count)
}

// --- Date helpers for realistic time distribution ---
function daysAgo(n: number): Date {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d
}

function randomDateBetween(from: Date, to: Date): Date {
  return faker.date.between({ from, to })
}

async function main() {
  console.log(`Start seeding ...`)

  console.log('Cleaning up existing data...')
  // All records that depend on other tables must be deleted first.
  await prisma.orderItemModifier.deleteMany()
  await prisma.activityLog.deleteMany()
  await prisma.digitalReceipt.deleteMany()
  await prisma.invoiceItem.deleteMany()
  await prisma.paymentAllocation.deleteMany()
  await prisma.review.deleteMany()
  await prisma.productModifierGroup.deleteMany()
  await prisma.inventoryMovement.deleteMany()
  await prisma.menuCategoryAssignment.deleteMany()
  await prisma.venueFeature.deleteMany()
  await prisma.feeTier.deleteMany()
  await prisma.orderItem.deleteMany()
  await prisma.venueTransaction.deleteMany()
  await prisma.payment.deleteMany()
  await prisma.order.deleteMany()
  await prisma.shift.deleteMany()
  await prisma.inventory.deleteMany()
  await prisma.modifier.deleteMany()
  await prisma.staffVenue.deleteMany()
  await prisma.venueSettings.deleteMany()
  await prisma.posCommand.deleteMany()
  await prisma.posConnectionStatus.deleteMany()

  // Clean notification system
  await prisma.notification.deleteMany()
  await prisma.notificationPreference.deleteMany()
  await prisma.notificationTemplate.deleteMany()

  // Clean cost management models
  await prisma.transactionCost.deleteMany()
  await prisma.monthlyVenueProfit.deleteMany()
  await prisma.venuePricingStructure.deleteMany()
  await prisma.providerCostStructure.deleteMany()
  await prisma.venuePaymentConfig.deleteMany()
  await prisma.merchantAccount.deleteMany()
  await prisma.paymentProvider.deleteMany()

  // ✅ CORRECTED ORDER: Delete Tables before Areas
  await prisma.table.deleteMany()
  await prisma.area.deleteMany()

  await prisma.terminal.deleteMany()
  await prisma.invitation.deleteMany()
  await prisma.invoice.deleteMany()
  await prisma.menu.deleteMany()
  await prisma.modifierGroup.deleteMany()
  await prisma.product.deleteMany()
  await prisma.menuCategory.deleteMany()
  await prisma.feeSchedule.deleteMany()
  await prisma.staff.deleteMany()

  // Now it's safe to delete Venues and Organizations
  await prisma.venue.deleteMany()
  await prisma.organization.deleteMany()

  // Independent models
  await prisma.feature.deleteMany()
  await prisma.customer.deleteMany()
  console.log('Cleaned up existing data successfully.')

  // --- Seed de Datos Globales/Independientes ---
  console.log('Seeding global data...')
  const featuresData = [
    {
      code: 'ONLINE_ORDERING',
      name: 'Pedidos en Línea',
      description: 'Permite a los clientes ordenar desde la web o app QR.',
      category: FeatureCategory.OPERATIONS,
      monthlyPrice: 29.99,
    },
    {
      code: 'ADVANCED_REPORTS',
      name: 'Reportes Avanzados',
      description: 'Acceso a analíticas y reportes detallados.',
      category: FeatureCategory.ANALYTICS,
      monthlyPrice: 19.99,
    },
    {
      code: 'AI_ASSISTANT_BUBBLE',
      name: 'Asistente IA',
      description: 'Asistente inteligente para análisis de datos y consultas sobre el restaurante.',
      category: FeatureCategory.ANALYTICS,
      monthlyPrice: 39.99,
    },
    {
      code: 'INVENTORY_TRACKING',
      name: 'Control de Inventario',
      description: 'Gestión de stock de productos y alertas.',
      category: FeatureCategory.OPERATIONS,
      monthlyPrice: 24.99,
    },
  ]

  // Usar upsert para crear o actualizar características
  for (const featureData of featuresData) {
    await prisma.feature.upsert({
      where: { code: featureData.code },
      update: featureData,
      create: featureData,
    })
  }
  const allFeatures = await prisma.feature.findMany()
  console.log(`  Created ${allFeatures.length} global features.`)

  const feeSchedule = await prisma.feeSchedule.create({
    data: {
      name: 'Comisión Estándar por Volumen',
      tiers: {
        create: [
          { minVolume: 0, maxVolume: 50000, percentage: 0.025 },
          { minVolume: 50000.01, maxVolume: 100000, percentage: 0.022 },
          { minVolume: 100000.01, percentage: 0.02 },
        ],
      },
    },
  })
  console.log(`  Created 1 FeeSchedule with tiers.`)

  await prisma.customer.createMany({
    data: [
      { email: faker.internet.email(), phone: faker.phone.number(), firstName: 'John', lastName: 'Doe', marketingConsent: true },
      { email: faker.internet.email(), phone: faker.phone.number(), firstName: 'Jane', lastName: 'Smith', marketingConsent: false },
    ],
  })
  console.log(`  Created 2 sample customers.`)

  // --- Notification Templates ---
  const notificationTemplates = [
    {
      type: NotificationType.NEW_ORDER,
      language: 'es',
      title: 'Nueva Orden Recibida',
      message: 'Nueva orden #{{orderNumber}} recibida en mesa {{tableNumber}}.',
      actionLabel: 'Ver Orden',
      variables: ['orderNumber', 'tableNumber'],
    },
    {
      type: NotificationType.ORDER_READY,
      language: 'es',
      title: 'Orden Lista',
      message: 'La orden #{{orderNumber}} está lista para servir.',
      actionLabel: 'Marcar como Servida',
      variables: ['orderNumber'],
    },
    {
      type: NotificationType.PAYMENT_RECEIVED,
      language: 'es',
      title: 'Pago Recibido',
      message: 'Pago de ${{amount}} recibido para la orden #{{orderNumber}}.',
      actionLabel: 'Ver Detalles',
      variables: ['amount', 'orderNumber'],
    },
    {
      type: NotificationType.LOW_INVENTORY,
      language: 'es',
      title: 'Stock Bajo',
      message: 'El producto {{productName}} tiene stock bajo ({{currentStock}} unidades).',
      actionLabel: 'Gestionar Inventario',
      variables: ['productName', 'currentStock'],
    },
    {
      type: NotificationType.NEW_REVIEW,
      language: 'es',
      title: 'Nueva Reseña',
      message: 'Nueva reseña de {{rating}} estrellas: "{{comment}}"',
      actionLabel: 'Ver Reseña',
      variables: ['rating', 'comment'],
    },
    {
      type: NotificationType.SHIFT_REMINDER,
      language: 'es',
      title: 'Recordatorio de Turno',
      message: 'Tu turno comienza en 30 minutos.',
      actionLabel: 'Ver Horario',
      variables: [],
    },
    {
      type: NotificationType.POS_DISCONNECTED,
      language: 'es',
      title: 'TPV Desconectado',
      message: 'El terminal {{terminalName}} se ha desconectado.',
      actionLabel: 'Verificar Conexión',
      variables: ['terminalName'],
    },
    {
      type: NotificationType.ANNOUNCEMENT,
      language: 'es',
      title: 'Anuncio Importante',
      message: '{{announcementText}}',
      actionLabel: 'Leer Más',
      variables: ['announcementText'],
    },
  ]

  await prisma.notificationTemplate.createMany({ data: notificationTemplates })
  console.log(`  Created ${notificationTemplates.length} notification templates.`)

  // --- Payment Providers and Cost Management ---
  console.log('Seeding payment providers and cost structures...')

  // Create payment providers
  const mentaProvider = await prisma.paymentProvider.create({
    data: {
      code: 'MENTA',
      name: 'Menta Payment Solutions',
      type: ProviderType.PAYMENT_PROCESSOR,
      countryCode: ['MX', 'AR'],
      active: true,
      configSchema: {
        required: ['apiKey', 'customerId', 'merchantId'],
        properties: {
          apiKey: { type: 'string', description: 'Encrypted API key' },
          customerId: { type: 'string', description: 'Customer ID in Menta' },
          merchantId: { type: 'string', description: 'Merchant ID in Menta' },
          acquirerId: { type: 'string', description: 'Acquirer ID (BANORTE, GPS, etc.)' },
        },
      },
    },
  })

  const clipProvider = await prisma.paymentProvider.create({
    data: {
      code: 'CLIP',
      name: 'Clip Digital Wallet',
      type: ProviderType.WALLET,
      countryCode: ['MX'],
      active: true,
      configSchema: {
        required: ['apiKey', 'merchantId'],
        properties: {
          apiKey: { type: 'string', description: 'Clip API key' },
          merchantId: { type: 'string', description: 'Clip merchant ID' },
        },
      },
    },
  })

  const banorteProvider = await prisma.paymentProvider.create({
    data: {
      code: 'BANORTE_DIRECT',
      name: 'Banorte Direct Integration',
      type: ProviderType.BANK_DIRECT,
      countryCode: ['MX'],
      active: true,
      configSchema: {
        required: ['clientId', 'clientSecret'],
        properties: {
          clientId: { type: 'string', description: 'Bank client ID' },
          clientSecret: { type: 'string', description: 'Bank client secret' },
          environment: { type: 'string', enum: ['sandbox', 'production'] },
        },
      },
    },
  })

  console.log(`  Created 3 payment providers (Menta, Clip, Banorte).`)

  // Create merchant accounts for different scenarios
  const mentaMerchantPrimary = await prisma.merchantAccount.create({
    data: {
      providerId: mentaProvider.id,
      externalMerchantId: '7acd6930-bef7-4306-91be-c18ccb537423',
      alias: 'Menta Primary Account',
      credentialsEncrypted: {
        apiKey: 'encrypted_menta_api_key_primary',
        customerId: 'bbee0460-d1f3-419f-898e-49bd0d63516d',
        merchantId: '7acd6930-bef7-4306-91be-c18ccb537423',
      },
      providerConfig: {
        acquirerId: 'BANORTE',
        terminalId: '3780f095-2ed4-46d2-b6e1-44d0659afd69',
        country: 'MX',
        currency: 'MXN',
      },
    },
  })

  const mentaMerchantSecondary = await prisma.merchantAccount.create({
    data: {
      providerId: mentaProvider.id,
      externalMerchantId: '8bcd6930-bef7-4306-91be-c18ccb537424',
      alias: 'Menta Secondary Account (Factura)',
      credentialsEncrypted: {
        apiKey: 'encrypted_menta_api_key_secondary',
        customerId: 'ccee0460-d1f3-419f-898e-49bd0d63516e',
        merchantId: '8bcd6930-bef7-4306-91be-c18ccb537424',
      },
      providerConfig: {
        acquirerId: 'BANORTE',
        terminalId: '4780f095-2ed4-46d2-b6e1-44d0659afd70',
        country: 'MX',
        currency: 'MXN',
        invoiceCapable: true,
      },
    },
  })

  const clipMerchant = await prisma.merchantAccount.create({
    data: {
      providerId: clipProvider.id,
      externalMerchantId: 'clip_merchant_12345',
      alias: 'Clip Digital Wallet',
      credentialsEncrypted: {
        apiKey: 'encrypted_clip_api_key',
        merchantId: 'clip_merchant_12345',
      },
      providerConfig: {
        webhookUrl: 'https://api.avoqado.com/webhooks/clip',
        country: 'MX',
        currency: 'MXN',
      },
    },
  })

  console.log(`  Created 3 merchant accounts.`)

  // Create provider cost structures (what Menta/providers charge Avoqado)
  const mentaPrimaryCosts = await prisma.providerCostStructure.create({
    data: {
      providerId: mentaProvider.id,
      merchantAccountId: mentaMerchantPrimary.id,
      debitRate: 0.015, // 1.5% for debit cards
      creditRate: 0.025, // 2.5% for credit cards
      amexRate: 0.035, // 3.5% for Amex (higher cost)
      internationalRate: 0.04, // 4.0% for international cards
      fixedCostPerTransaction: 0.5, // 0.50 MXN per transaction
      monthlyFee: 500.0, // 500 MXN monthly fee
      effectiveFrom: new Date('2024-01-01'),
      active: true,
      proposalReference: 'MENTA-2024-PRIMARY-001',
      notes: 'Standard rates for primary Menta account',
    },
  })

  const mentaSecondaryCosts = await prisma.providerCostStructure.create({
    data: {
      providerId: mentaProvider.id,
      merchantAccountId: mentaMerchantSecondary.id,
      debitRate: 0.016, // Slightly higher for secondary account
      creditRate: 0.027,
      amexRate: 0.037,
      internationalRate: 0.042,
      fixedCostPerTransaction: 0.6,
      monthlyFee: 600.0, // Higher monthly fee for invoice-capable account
      effectiveFrom: new Date('2024-01-01'),
      active: true,
      proposalReference: 'MENTA-2024-SECONDARY-001',
      notes: 'Rates for secondary account with invoice capabilities',
    },
  })

  const clipCosts = await prisma.providerCostStructure.create({
    data: {
      providerId: clipProvider.id,
      merchantAccountId: clipMerchant.id,
      debitRate: 0.028, // Clip rates (typically higher than traditional processors)
      creditRate: 0.029,
      amexRate: 0.035,
      internationalRate: 0.04,
      fixedCostPerTransaction: 0.0, // No fixed fee for Clip
      monthlyFee: 0.0, // No monthly fee
      effectiveFrom: new Date('2024-01-01'),
      active: true,
      proposalReference: 'CLIP-2024-001',
      notes: 'Standard Clip wallet processing rates',
    },
  })

  console.log(`  Created 3 provider cost structures.`)

  // --- 1. Organizaciones ---
  console.log('Seeding organizations...')
  const organizations = await Promise.all([
    prisma.organization.create({
      data: { name: 'Grupo Avoqado Prime', email: 'billing@avoqadoprime.com', phone: faker.phone.number(), taxId: 'AVP123456XYZ' },
    }),
    prisma.organization.create({ data: { name: faker.company.name(), email: faker.internet.email(), phone: faker.phone.number() } }),
  ])
  console.log(`  Created ${organizations.length} organizations.`)

  // --- Bucle principal para poblar cada organización ---
  for (const [orgIndex, org] of organizations.entries()) {
    console.log(`\nSeeding for Organization: ${org.name} (ID: ${org.id})`)

    const createdStaffList: (any & { assignedRole: StaffRole })[] = []

    // --- Staff de la Organización ---
    const staffToCreate =
      orgIndex === 0
        ? [
            // Staff específico para la primera organización
            {
              email: 'superadmin@superadmin.com',
              password: 'superadmin',
              role: StaffRole.SUPERADMIN,
              firstName: 'Super',
              lastName: 'Admin',
            },
            { email: 'owner@owner.com', password: 'owner', role: StaffRole.OWNER, firstName: 'Main', lastName: 'Owner' },
            { email: 'admin@admin.com', password: 'admin', role: StaffRole.ADMIN, firstName: 'Venue', lastName: 'Admin' },
            { email: 'manager@manager.com', password: 'manager', role: StaffRole.MANAGER, firstName: 'Shift', lastName: 'Manager' },
            { email: 'waiter@waiter.com', password: 'waiter', role: StaffRole.WAITER, firstName: 'John', lastName: 'Waiter' },
            { email: 'waiter2@waiter.com', password: 'waiter', role: StaffRole.WAITER, firstName: 'Jane', lastName: 'Waitress' },
          ]
        : [
            // Staff para organizaciones aleatorias
            // Asegurar que siempre exista un admin
            {
              email: `admin.${generateSlug(org.name)}@example.com`,
              password: 'admin',
              role: StaffRole.ADMIN,
              firstName: 'Org',
              lastName: 'Admin',
            },
            // Crear el resto del personal con roles aleatorios
            ...Array.from({ length: 4 }, () => ({
              email: faker.internet.email(),
              password: 'Password123!',
              role: getRandomItem([StaffRole.MANAGER, StaffRole.WAITER, StaffRole.CASHIER]),
              firstName: faker.person.firstName(),
              lastName: faker.person.lastName(),
            })),
          ]

    for (const staffData of staffToCreate) {
      const staffMember = await prisma.staff.create({
        data: {
          organizationId: org.id,
          email: staffData.email,
          password: await bcrypt.hash(staffData.password, HASH_ROUNDS),
          // PIN removed - now venue-specific on StaffVenue
          firstName: staffData.firstName,
          lastName: staffData.lastName,
          phone: faker.phone.number(),
          active: true,
          emailVerified: true,
        },
      })
      createdStaffList.push({ ...staffMember, assignedRole: staffData.role })
    }
    console.log(`  Created ${createdStaffList.length} staff members.`)

    const mainAdmin = createdStaffList.find(s => [StaffRole.ADMIN, StaffRole.OWNER].includes(s.assignedRole))!

    // --- Invitaciones ---
    await prisma.invitation.create({
      data: {
        email: faker.internet.email(),
        role: StaffRole.ADMIN,
        type: InvitationType.VENUE_ADMIN,
        organizationId: org.id,
        token: faker.string.uuid(),
        expiresAt: faker.date.future(),
        status: InvitationStatus.PENDING,
        invitedById: mainAdmin.id,
        message: 'Te invito a ser admin de nuestro nuevo local.',
      },
    })
    console.log(`  Created a sample invitation.`)

    // --- Bucle de Venues (2 por Organización) ---
    for (let i = 0; i < 2; i++) {
      const venueName = orgIndex === 0 ? `Avoqado ${i === 0 ? 'Centro' : 'Sur'}` : `${faker.company.name()} Branch`
      const venueSlug = generateSlug(venueName)
      const venue = await prisma.venue.create({
        data: {
          organizationId: org.id,
          name: venueName,
          slug: venueSlug,
          type: VenueType.RESTAURANT,
          address: faker.location.streetAddress(),
          city: faker.location.city(),
          state: faker.location.state(),
          zipCode: faker.location.zipCode(),
          country: 'MX',
          phone: faker.phone.number(),
          email: `contact@${venueSlug}.com`,
          logo: faker.image.urlLoremFlickr({ category: 'restaurant,logo' }),
          feeValue: 0.025,
          feeScheduleId: feeSchedule.id,
        },
      })
      console.log(`    -> Created Venue: ${venue.name}.`)

      // ✅ PASO 1: CREAR ÁREAS PARA CADA VENUE
      const areaNames = ['Salón Principal', 'Terraza', 'Barra']
      const createdAreas = await Promise.all(
        areaNames.map(name =>
          prisma.area.create({
            data: {
              venueId: venue.id,
              name: name,
              description: `Área de ${name.toLowerCase()} del restaurante.`,
            },
          }),
        ),
      )
      console.log(`      - Created ${createdAreas.length} areas.`)
      // Asignar Staff a este Venue
      for (const staffWithRole of createdStaffList) {
        if ([StaffRole.SUPERADMIN, StaffRole.OWNER, StaffRole.ADMIN].includes(staffWithRole.assignedRole) || Math.random() > 0.3) {
          await prisma.staffVenue.create({
            data: {
              staffId: staffWithRole.id,
              venueId: venue.id,
              role: staffWithRole.assignedRole,
              active: true,
              pin: faker.string.numeric(4), // Set venue-specific PIN
            },
          })

          // Create notification preferences for this staff member at this venue
          const notificationTypes = [
            NotificationType.NEW_ORDER,
            NotificationType.ORDER_READY,
            NotificationType.PAYMENT_RECEIVED,
            NotificationType.LOW_INVENTORY,
            NotificationType.NEW_REVIEW,
            NotificationType.SHIFT_REMINDER,
            NotificationType.POS_DISCONNECTED,
            NotificationType.ANNOUNCEMENT,
          ]

          for (const type of notificationTypes) {
            // Different roles get different notification preferences
            let enabled = true
            let priority: NotificationPriority = NotificationPriority.NORMAL
            let channels: NotificationChannel[] = [NotificationChannel.IN_APP]

            // Customize based on role
            if (staffWithRole.assignedRole === StaffRole.ADMIN || staffWithRole.assignedRole === StaffRole.OWNER) {
              channels = [NotificationChannel.IN_APP, NotificationChannel.EMAIL]
              if (type === NotificationType.POS_DISCONNECTED || type === NotificationType.LOW_INVENTORY) {
                priority = NotificationPriority.HIGH
              }
            } else if (staffWithRole.assignedRole === StaffRole.MANAGER) {
              if (type === NotificationType.NEW_ORDER || type === NotificationType.ORDER_READY) {
                priority = NotificationPriority.HIGH
                channels = [NotificationChannel.IN_APP, NotificationChannel.PUSH]
              }
            } else if (staffWithRole.assignedRole === StaffRole.WAITER) {
              if (type === NotificationType.LOW_INVENTORY) {
                enabled = false // Waiters don't need inventory alerts
              }
              if (type === NotificationType.NEW_ORDER || type === NotificationType.ORDER_READY) {
                priority = NotificationPriority.HIGH
              }
            }

            await prisma.notificationPreference.create({
              data: {
                staffId: staffWithRole.id,
                venueId: venue.id,
                type,
                enabled,
                channels,
                priority,
                quietStart: faker.helpers.arrayElement(['22:00', '23:00', null]),
                quietEnd: faker.helpers.arrayElement(['07:00', '08:00', null]),
              },
            })
          }
        }
      }
      console.log(`      - Assigned staff to ${venue.name} and created notification preferences.`)

      // Settings y Features
      await prisma.venueSettings.create({ data: { venueId: venue.id, trackInventory: true, allowReservations: true } })
      for (const feature of allFeatures) {
        if (Math.random() > 0.5) {
          await prisma.venueFeature.create({ data: { venueId: venue.id, featureId: feature.id, monthlyPrice: feature.monthlyPrice } })
        }
      }
      console.log(`      - Created VenueSettings and assigned Features.`)

      // --- Payment Configuration for this Venue ---
      const paymentConfig = await prisma.venuePaymentConfig.create({
        data: {
          venueId: venue.id,
          primaryAccountId: mentaMerchantPrimary.id,
          secondaryAccountId: mentaMerchantSecondary.id,
          tertiaryAccountId: i === 0 ? clipMerchant.id : null, // Only first venue gets Clip as tertiary
          routingRules: {
            factura: 'secondary', // Use secondary account when customer needs invoice
            amount_over: 5000, // Use tertiary for amounts over $5000 MXN
            customer_type: {
              business: 'secondary', // Business customers use secondary
            },
            bin_routing: {
              '4111': 'secondary', // Route specific BINs to secondary
              '5555': 'tertiary',
            },
            time_based: {
              peak_hours: {
                start: '18:00',
                end: '22:00',
                account: 'tertiary', // Use tertiary during peak hours
              },
            },
          },
        },
      })

      // --- Venue Pricing Structures (what you charge venues) ---
      // Primary account pricing (with margins over provider costs)
      const primaryPricing = await prisma.venuePricingStructure.create({
        data: {
          venueId: venue.id,
          accountType: AccountType.PRIMARY,
          debitRate: 0.02, // 2.0% (0.5% margin over 1.5% cost)
          creditRate: 0.03, // 3.0% (0.5% margin over 2.5% cost)
          amexRate: 0.0425, // 4.25% (0.75% margin over 3.5% cost)
          internationalRate: 0.045, // 4.5% (0.5% margin over 4.0% cost)
          fixedFeePerTransaction: 0.75, // 0.75 MXN (0.25 margin over 0.50 cost)
          monthlyServiceFee: 799.0, // 799 MXN (299 margin over 500 cost)
          effectiveFrom: new Date('2024-01-01'),
          active: true,
          contractReference: `CONTRACT-${venue.slug.toUpperCase()}-PRIMARY`,
          notes: `Standard pricing for ${venue.name} - Primary Account`,
        },
      })

      // Secondary account pricing (higher margins due to invoice capability)
      const secondaryPricing = await prisma.venuePricingStructure.create({
        data: {
          venueId: venue.id,
          accountType: AccountType.SECONDARY,
          debitRate: 0.022, // 2.2% (0.6% margin over 1.6% cost)
          creditRate: 0.032, // 3.2% (0.5% margin over 2.7% cost)
          amexRate: 0.045, // 4.5% (0.8% margin over 3.7% cost)
          internationalRate: 0.048, // 4.8% (0.6% margin over 4.2% cost)
          fixedFeePerTransaction: 0.9, // 0.90 MXN (0.30 margin over 0.60 cost)
          monthlyServiceFee: 999.0, // 999 MXN (399 margin over 600 cost)
          effectiveFrom: new Date('2024-01-01'),
          active: true,
          contractReference: `CONTRACT-${venue.slug.toUpperCase()}-SECONDARY`,
          notes: `Premium pricing for ${venue.name} - Secondary Account with invoice capability`,
        },
      })

      // Tertiary account pricing (if Clip is available)
      if (i === 0) {
        const tertiaryPricing = await prisma.venuePricingStructure.create({
          data: {
            venueId: venue.id,
            accountType: AccountType.TERTIARY,
            debitRate: 0.035, // 3.5% (0.7% margin over 2.8% Clip cost)
            creditRate: 0.036, // 3.6% (0.7% margin over 2.9% cost)
            amexRate: 0.0425, // 4.25% (0.75% margin over 3.5% cost)
            internationalRate: 0.045, // 4.5% (0.5% margin over 4.0% cost)
            fixedFeePerTransaction: 0.5, // 0.50 MXN (0.50 margin since Clip has no fixed fee)
            monthlyServiceFee: 299.0, // 299 MXN (299 margin since Clip has no monthly fee)
            effectiveFrom: new Date('2024-01-01'),
            active: true,
            contractReference: `CONTRACT-${venue.slug.toUpperCase()}-TERTIARY`,
            notes: `Digital wallet pricing for ${venue.name} - Clip integration`,
          },
        })
      }

      console.log(`      - Created payment configuration and pricing structures.`)

      const terminals = await Promise.all(
        Array.from({ length: 3 }).map((_, t) => {
          // Create varied TPV health scenarios for testing
          const scenarios = [
            {
              status: TerminalStatus.ACTIVE,
              lastHeartbeat: new Date(Date.now() - 30 * 1000), // 30 seconds ago - online
              version: '2.1.4',
              systemInfo: {
                platform: 'Android 13',
                memory: { total: 4096, free: 2048, used: 2048 },
                uptime: 86400, // 24 hours in seconds
                cpuUsage: 15.2,
                diskSpace: { total: 64000, free: 32000, used: 32000 },
                batteryLevel: 85,
                wifiSignal: -42,
                lastRestart: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
              },
              ipAddress: faker.internet.ipv4(),
            },
            {
              status: TerminalStatus.MAINTENANCE,
              lastHeartbeat: new Date(Date.now() - 10 * 60 * 1000), // 10 minutes ago - maintenance
              version: '2.1.3',
              systemInfo: {
                platform: 'Android 12',
                memory: { total: 2048, free: 512, used: 1536 },
                uptime: 43200, // 12 hours in seconds
                cpuUsage: 5.8,
                diskSpace: { total: 32000, free: 8000, used: 24000 },
                batteryLevel: 45,
                wifiSignal: -58,
                lastRestart: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
              },
              ipAddress: faker.internet.ipv4(),
            },
            {
              status: TerminalStatus.INACTIVE,
              lastHeartbeat: new Date(Date.now() - 5 * 60 * 1000), // 5 minutes ago - will be detected as offline
              version: '2.0.8',
              systemInfo: {
                platform: 'Android 11',
                memory: { total: 4096, free: 1024, used: 3072 },
                uptime: 7200, // 2 hours in seconds
                cpuUsage: 35.7,
                diskSpace: { total: 64000, free: 16000, used: 48000 },
                batteryLevel: 12,
                wifiSignal: -75,
                lastRestart: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
              },
              ipAddress: faker.internet.ipv4(),
            },
          ]

          const scenario = scenarios[t] || scenarios[0]

          // Use actual device serial for the first terminal (development device)
          const serialNumber =
            t === 0 && venue.name.includes('Avoqado Centro')
              ? '9701a1cbf798fb92' // Your actual Android device serial
              : faker.string.uuid()

          return prisma.terminal.create({
            data: {
              id:
                t === 0 && venue.name.includes('Avoqado Centro')
                  ? '9701a1cbf798fb92' // Use device serial as ID for development terminal
                  : undefined, // Let Prisma generate UUID for others
              venueId: venue.id,
              serialNumber,
              name:
                t === 0 && venue.name.includes('Avoqado Centro')
                  ? 'TPV Desarrollo (Android)' // Clear name for development device
                  : `TPV ${t + 1}`,
              type: TerminalType.TPV_ANDROID,
              status: scenario.status,
              lastHeartbeat: scenario.lastHeartbeat,
              version: scenario.version,
              systemInfo: scenario.systemInfo,
              ipAddress: scenario.ipAddress,
            },
          })
        }),
      )
      console.log(`      - Created ${terminals.length} terminals.`)

      const tables = await Promise.all(
        Array.from({ length: 5 }).map((_, t) =>
          prisma.table.create({
            data: {
              venueId: venue.id,
              number: `M${t + 1}`,
              areaId: getRandomItem(createdAreas).id,

              capacity: getRandomItem([2, 4, 6]),
              qrCode: faker.string.uuid(),
            },
          }),
        ),
      )
      console.log(`      - Created ${tables.length} tables.`)

      const categories = await Promise.all(
        ['Entradas', 'Platos Fuertes', 'Postres', 'Bebidas', 'Sopas'].map((name, index) =>
          prisma.menuCategory.create({ data: { venueId: venue.id, name, slug: generateSlug(name), displayOrder: index } }),
        ),
      )
      console.log(`      - Created ${categories.length} menu categories.`)

      const mainMenu = await prisma.menu.create({
        data: { venueId: venue.id, name: 'Menú Principal', isDefault: true, type: MenuType.REGULAR },
      })
      await Promise.all(
        categories.map(category => prisma.menuCategoryAssignment.create({ data: { menuId: mainMenu.id, categoryId: category.id } })),
      )
      console.log(`      - Created a main menu and assigned categories.`)

      const products = await Promise.all(
        categories.flatMap(category =>
          Array.from({ length: 8 }).map(() =>
            prisma.product.create({
              data: {
                venueId: venue.id,
                name: faker.commerce.productName(),
                sku: `${category.slug.toUpperCase()}-${faker.string.alphanumeric(6)}`,
                categoryId: category.id,
                price: parseFloat(faker.commerce.price({ min: 50, max: 450 })),
                trackInventory: true,
                type: category.name === 'Bebidas' ? ProductType.BEVERAGE : ProductType.FOOD,
                tags: [faker.lorem.word(), faker.lorem.word()],
                imageUrl: faker.image.urlLoremFlickr({ category: 'food' }),
              },
            }),
          ),
        ),
      )
      await Promise.all(
        products.map(async product => {
          const inventory = await prisma.inventory.create({
            data: { productId: product.id, venueId: venue.id, currentStock: 100, minimumStock: 10 },
          })
          await prisma.inventoryMovement.create({
            data: {
              inventoryId: inventory.id,
              type: MovementType.PURCHASE,
              quantity: 100,
              previousStock: 0,
              newStock: 100,
              reason: 'Stock inicial',
            },
          })
        }),
      )
      console.log(`      - Created ${products.length} products with initial inventory.`)

      // ✅ LÍNEA CORREGIDA: Se añade el tipo explícito al array
      const sellableProductTypes: ProductType[] = [ProductType.FOOD, ProductType.BEVERAGE, ProductType.ALCOHOL, ProductType.RETAIL]
      const sellableProducts = products.filter(p => sellableProductTypes.includes(p.type))

      const modifierGroup = await prisma.modifierGroup.create({ data: { venueId: venue.id, name: 'Aderezos', allowMultiple: true } })
      const modifiers = await Promise.all([
        prisma.modifier.create({ data: { groupId: modifierGroup.id, name: 'Ranch', price: 10 } }),
        prisma.modifier.create({ data: { groupId: modifierGroup.id, name: 'BBQ', price: 12.5 } }),
        prisma.modifier.create({ data: { groupId: modifierGroup.id, name: 'Chipotle Mayo', price: 15 } }),
      ])
      await Promise.all(
        getRandomSample(sellableProducts, 5).map(product =>
          prisma.productModifierGroup.create({ data: { productId: product.id, groupId: modifierGroup.id } }),
        ),
      )
      console.log(`      - Created modifiers and assigned to products.`)

      const venueWaiters = await prisma.staffVenue.findMany({
        where: { venueId: venue.id, role: { in: [StaffRole.WAITER] } },
        include: { staff: true },
      })
      if (venueWaiters.length === 0) continue

      const activeWaiter = getRandomItem(venueWaiters)

      console.log('      - Creating shifts, orders, payments over the last 60 days...')
      const shiftsToCreate = faker.number.int({ min: 8, max: 16 })
      for (let s = 0; s < shiftsToCreate; s++) {
        const startTime = randomDateBetween(daysAgo(60), new Date())
        const shiftDurationHours = faker.number.int({ min: 5, max: 9 })
        const rawEndTime = new Date(startTime.getTime() + shiftDurationHours * 60 * 60 * 1000)
        const endTime = new Date(Math.min(rawEndTime.getTime(), Date.now()))

        const shift = await prisma.shift.create({
          data: { venueId: venue.id, staffId: activeWaiter.staffId, startTime, endTime },
        })

        const ordersInShift = faker.number.int({ min: 6, max: 14 })
        for (let k = 0; k < ordersInShift; k++) {
          const orderStatus = getRandomItem([OrderStatus.COMPLETED, OrderStatus.COMPLETED, OrderStatus.PENDING, OrderStatus.CANCELLED])

          const orderCreatedAt = randomDateBetween(startTime, endTime)
          const orderCompletedAt =
            orderStatus === OrderStatus.COMPLETED
              ? randomDateBetween(orderCreatedAt, new Date(Math.min(endTime.getTime() + 60 * 60 * 1000, Date.now())))
              : undefined

          const order = await prisma.order.create({
            data: {
              venueId: venue.id,
              shiftId: shift.id,
              orderNumber: `ORD-${faker.string.alphanumeric(8).toUpperCase()}`,
              type: getRandomItem([OrderType.DINE_IN, OrderType.TAKEOUT]),
              source: getRandomItem([OrderSource.TPV, OrderSource.QR]),
              tableId: getRandomItem(tables).id,
              createdById: activeWaiter.staffId,
              servedById: activeWaiter.staffId,
              subtotal: 0,
              taxAmount: 0,
              total: 0,
              status: orderStatus,
              paymentStatus: orderStatus === OrderStatus.COMPLETED ? PaymentStatus.PAID : PaymentStatus.PENDING,
              kitchenStatus: orderStatus === OrderStatus.COMPLETED ? KitchenStatus.SERVED : KitchenStatus.PENDING,
              createdAt: orderCreatedAt,
              completedAt: orderCompletedAt,
            },
          })

          let subtotal = 0
          const numItems = faker.number.int({ min: 1, max: 4 })
          for (let j = 0; j < numItems; j++) {
            if (sellableProducts.length === 0) continue // Evitar error si no hay productos vendibles
            const product = getRandomItem(sellableProducts)
            const quantity = faker.number.int({ min: 1, max: 2 })
            const itemTotal = parseFloat(product.price.toString()) * quantity
            subtotal += itemTotal

            const orderItem = await prisma.orderItem.create({
              data: {
                orderId: order.id,
                productId: product.id,
                quantity,
                unitPrice: product.price,
                taxAmount: itemTotal * 0.16,
                total: itemTotal,
                createdAt: orderCreatedAt,
              },
            })
            if (Math.random() < 0.2) {
              const modifier = getRandomItem(modifiers)
              await prisma.orderItemModifier.create({
                data: { orderItemId: orderItem.id, modifierId: modifier.id, quantity: 1, price: modifier.price },
              })
              subtotal += parseFloat(modifier.price.toString())
            }
          }

          const taxAmount = subtotal * 0.16
          const tipAmount = order.status === OrderStatus.COMPLETED ? subtotal * getRandomItem([0.1, 0.15, 0.2]) : 0
          const total = subtotal + taxAmount + tipAmount

          await prisma.order.update({ where: { id: order.id }, data: { subtotal, taxAmount, tipAmount, total } })

          if (order.status === OrderStatus.COMPLETED) {
            const paymentMethod = getRandomItem([PaymentMethod.CASH, PaymentMethod.CREDIT_CARD, PaymentMethod.DEBIT_CARD])
            const feePercentage = parseFloat(venue.feeValue.toString())
            const feeAmount = total * feePercentage
            const netAmount = total - feeAmount

            const paymentCreatedAt = randomDateBetween(
              orderCompletedAt ?? orderCreatedAt,
              new Date(Math.min((orderCompletedAt ?? orderCreatedAt).getTime() + 30 * 60 * 1000, Date.now())),
            )

            const payment = await prisma.payment.create({
              data: {
                venueId: venue.id,
                orderId: order.id,
                shiftId: shift.id,
                processedById: activeWaiter.staffId,
                amount: total,
                tipAmount,
                method: paymentMethod,
                status: TransactionStatus.COMPLETED,
                splitType: 'FULLPAYMENT', // Add required splitType field
                processor: paymentMethod !== 'CASH' ? 'stripe' : null,
                processorId: paymentMethod !== 'CASH' ? `pi_${faker.string.alphanumeric(24)}` : null,
                feePercentage,
                feeAmount,
                netAmount,
                createdAt: paymentCreatedAt,
                allocations: { create: { orderId: order.id, amount: total, createdAt: paymentCreatedAt } },
              },
            })

            // --- Add Transaction Cost Tracking (only for card payments) ---
            if (paymentMethod !== PaymentMethod.CASH) {
              // Simulate different card types based on payment method
              const cardType =
                paymentMethod === PaymentMethod.DEBIT_CARD
                  ? TransactionCardType.DEBIT
                  : getRandomItem([
                      TransactionCardType.CREDIT,
                      TransactionCardType.CREDIT,
                      TransactionCardType.CREDIT, // Higher probability for credit
                      TransactionCardType.AMEX,
                      TransactionCardType.INTERNATIONAL,
                    ])

              // Determine which account was used (simulate routing logic)
              const accountType = Math.random() > 0.7 ? AccountType.SECONDARY : AccountType.PRIMARY
              const merchantAccountId = accountType === AccountType.SECONDARY ? mentaMerchantSecondary.id : mentaMerchantPrimary.id

              // Get the cost structures
              const providerCost = accountType === AccountType.SECONDARY ? mentaSecondaryCosts : mentaPrimaryCosts
              const venuePricing = await prisma.venuePricingStructure.findFirst({
                where: { venueId: venue.id, accountType, active: true },
              })

              if (venuePricing) {
                // Calculate rates based on card type
                const getRate = (structure: any, type: TransactionCardType) => {
                  switch (type) {
                    case TransactionCardType.DEBIT:
                      return Number(structure.debitRate)
                    case TransactionCardType.CREDIT:
                      return Number(structure.creditRate)
                    case TransactionCardType.AMEX:
                      return Number(structure.amexRate)
                    case TransactionCardType.INTERNATIONAL:
                      return Number(structure.internationalRate)
                    default:
                      return Number(structure.creditRate)
                  }
                }

                const providerRate = getRate(providerCost, cardType)
                const venueRate = getRate(venuePricing, cardType)

                const providerCostAmount = total * providerRate
                const providerFixedFee = Number(providerCost.fixedCostPerTransaction || 0)
                const venueChargeAmount = total * venueRate
                const venueFixedFee = Number(venuePricing.fixedFeePerTransaction || 0)

                const totalProviderCost = providerCostAmount + providerFixedFee
                const totalVenueCharge = venueChargeAmount + venueFixedFee
                const grossProfit = totalVenueCharge - totalProviderCost
                const profitMargin = totalVenueCharge > 0 ? grossProfit / totalVenueCharge : 0

                await prisma.transactionCost.create({
                  data: {
                    paymentId: payment.id,
                    merchantAccountId,
                    transactionType: cardType,
                    amount: total,
                    providerRate,
                    providerCostAmount,
                    providerFixedFee,
                    venueRate,
                    venueChargeAmount,
                    venueFixedFee,
                    grossProfit,
                    profitMargin,
                    providerCostStructureId: providerCost.id,
                    venuePricingStructureId: venuePricing.id,
                    createdAt: paymentCreatedAt,
                  },
                })
              }
            }

            await prisma.digitalReceipt.create({
              data: {
                paymentId: payment.id,
                dataSnapshot: { venueName: venue.name, orderNumber: order.orderNumber, total, paymentMethod },
                status: ReceiptStatus.SENT,
                recipientEmail: faker.internet.email(),
                sentAt: paymentCreatedAt,
                createdAt: paymentCreatedAt,
              },
            })

            const transactionCreatedAt = randomDateBetween(
              paymentCreatedAt,
              new Date(Math.min(paymentCreatedAt.getTime() + 2 * 24 * 60 * 60 * 1000, Date.now())),
            )

            await prisma.venueTransaction.create({
              data: {
                venueId: venue.id,
                paymentId: payment.id,
                type: TransactionType.PAYMENT,
                grossAmount: total,
                feeAmount,
                netAmount,
                status: SettlementStatus.PENDING,
                createdAt: transactionCreatedAt,
              },
            })

            if (Math.random() > 0.5) {
              const reviewCreatedAt = randomDateBetween(
                paymentCreatedAt,
                new Date(Math.min(paymentCreatedAt.getTime() + 3 * 60 * 60 * 1000, Date.now())),
              )
              await prisma.review.create({
                data: {
                  venueId: venue.id,
                  paymentId: payment.id,
                  terminalId: getRandomItem(terminals).id,
                  servedById: activeWaiter.staffId,
                  overallRating: faker.number.int({ min: 3, max: 5 }),
                  comment: faker.lorem.sentence(),
                  source: ReviewSource.AVOQADO,
                  createdAt: reviewCreatedAt,
                },
              })
            }
          }
        }
      }
      console.log(`      - Finished creating orders and related data across multiple shifts.`)

      // --- Generate Monthly Profit Summary ---
      console.log(`      - Generating monthly profit summaries for ${venue.name}...`)

      // Get all transaction costs for this venue
      const transactionCosts = await prisma.transactionCost.findMany({
        where: {
          payment: { venueId: venue.id },
        },
        include: {
          payment: true,
        },
      })

      // Group by month and calculate totals
      const monthlyData = new Map()

      transactionCosts.forEach(cost => {
        const date = new Date(cost.createdAt)
        const year = date.getFullYear()
        const month = date.getMonth() + 1
        const key = `${year}-${month}`

        if (!monthlyData.has(key)) {
          monthlyData.set(key, {
            year,
            month,
            totalTransactions: 0,
            totalVolume: 0,
            debitTransactions: 0,
            debitVolume: 0,
            creditTransactions: 0,
            creditVolume: 0,
            amexTransactions: 0,
            amexVolume: 0,
            internationalTransactions: 0,
            internationalVolume: 0,
            totalProviderCosts: 0,
            totalVenueCharges: 0,
            totalGrossProfit: 0,
          })
        }

        const data = monthlyData.get(key)
        data.totalTransactions++
        data.totalVolume += Number(cost.amount)
        data.totalProviderCosts += Number(cost.providerCostAmount) + Number(cost.providerFixedFee)
        data.totalVenueCharges += Number(cost.venueChargeAmount) + Number(cost.venueFixedFee)
        data.totalGrossProfit += Number(cost.grossProfit)

        // Track by card type
        switch (cost.transactionType) {
          case TransactionCardType.DEBIT:
            data.debitTransactions++
            data.debitVolume += Number(cost.amount)
            break
          case TransactionCardType.CREDIT:
            data.creditTransactions++
            data.creditVolume += Number(cost.amount)
            break
          case TransactionCardType.AMEX:
            data.amexTransactions++
            data.amexVolume += Number(cost.amount)
            break
          case TransactionCardType.INTERNATIONAL:
            data.internationalTransactions++
            data.internationalVolume += Number(cost.amount)
            break
        }
      })

      // Create MonthlyVenueProfit records
      for (const [key, data] of monthlyData) {
        const averageProfitMargin = data.totalVenueCharges > 0 ? data.totalGrossProfit / data.totalVenueCharges : 0

        await prisma.monthlyVenueProfit.create({
          data: {
            venueId: venue.id,
            year: data.year,
            month: data.month,
            totalTransactions: data.totalTransactions,
            totalVolume: data.totalVolume,
            debitTransactions: data.debitTransactions,
            debitVolume: data.debitVolume,
            creditTransactions: data.creditTransactions,
            creditVolume: data.creditVolume,
            amexTransactions: data.amexTransactions,
            amexVolume: data.amexVolume,
            internationalTransactions: data.internationalTransactions,
            internationalVolume: data.internationalVolume,
            totalProviderCosts: data.totalProviderCosts,
            totalVenueCharges: data.totalVenueCharges,
            totalGrossProfit: data.totalGrossProfit,
            averageProfitMargin,
            monthlyProviderFees: 500.0, // Base monthly fee
            monthlyServiceFees: 799.0, // What we charge venue
          },
        })
      }

      console.log(`      - Created ${monthlyData.size} monthly profit summaries.`)

      // Create sample notifications for this venue
      const venueStaff = await prisma.staffVenue.findMany({
        where: { venueId: venue.id, active: true },
        include: { staff: true },
      })

      if (venueStaff.length > 0) {
        const notifications = []

        // Create different types of notifications
        for (let n = 0; n < 15; n++) {
          const recipient = getRandomItem(venueStaff)
          const notificationType = getRandomItem([
            NotificationType.NEW_ORDER,
            NotificationType.ORDER_READY,
            NotificationType.PAYMENT_RECEIVED,
            NotificationType.LOW_INVENTORY,
            NotificationType.NEW_REVIEW,
            NotificationType.SHIFT_REMINDER,
            NotificationType.POS_DISCONNECTED,
            NotificationType.ANNOUNCEMENT,
          ])

          let title, message, actionUrl, actionLabel, entityType, entityId, metadata

          switch (notificationType) {
            case NotificationType.NEW_ORDER:
              const orderNumber = `ORD-${faker.string.alphanumeric(6).toUpperCase()}`
              const tableNumber = `M${faker.number.int({ min: 1, max: 10 })}`
              title = 'Nueva Orden Recibida'
              message = `Nueva orden #${orderNumber} recibida en mesa ${tableNumber}.`
              actionUrl = `/orders/${orderNumber}`
              actionLabel = 'Ver Orden'
              entityType = 'order'
              entityId = faker.string.uuid()
              metadata = { orderNumber, tableNumber }
              break

            case NotificationType.ORDER_READY:
              const readyOrderNumber = `ORD-${faker.string.alphanumeric(6).toUpperCase()}`
              title = 'Orden Lista'
              message = `La orden #${readyOrderNumber} está lista para servir.`
              actionUrl = `/orders/${readyOrderNumber}`
              actionLabel = 'Marcar como Servida'
              entityType = 'order'
              entityId = faker.string.uuid()
              metadata = { orderNumber: readyOrderNumber }
              break

            case NotificationType.PAYMENT_RECEIVED:
              const amount = faker.commerce.price({ min: 50, max: 500 })
              const paymentOrderNumber = `ORD-${faker.string.alphanumeric(6).toUpperCase()}`
              title = 'Pago Recibido'
              message = `Pago de $${amount} recibido para la orden #${paymentOrderNumber}.`
              actionUrl = `/payments/${faker.string.uuid()}`
              actionLabel = 'Ver Detalles'
              entityType = 'payment'
              entityId = faker.string.uuid()
              metadata = { amount, orderNumber: paymentOrderNumber }
              break

            case NotificationType.LOW_INVENTORY:
              const productName = faker.commerce.productName()
              const currentStock = faker.number.int({ min: 1, max: 9 })
              title = 'Stock Bajo'
              message = `El producto ${productName} tiene stock bajo (${currentStock} unidades).`
              actionUrl = '/inventory'
              actionLabel = 'Gestionar Inventario'
              entityType = 'inventory'
              entityId = faker.string.uuid()
              metadata = { productName, currentStock }
              break

            case NotificationType.NEW_REVIEW:
              const rating = faker.number.int({ min: 1, max: 5 })
              const comment = faker.lorem.sentence()
              title = 'Nueva Reseña'
              message = `Nueva reseña de ${rating} estrellas: "${comment}"`
              actionUrl = '/reviews'
              actionLabel = 'Ver Reseña'
              entityType = 'review'
              entityId = faker.string.uuid()
              metadata = { rating, comment }
              break

            case NotificationType.SHIFT_REMINDER:
              title = 'Recordatorio de Turno'
              message = 'Tu turno comienza en 30 minutos.'
              actionUrl = '/schedule'
              actionLabel = 'Ver Horario'
              entityType = 'shift'
              entityId = faker.string.uuid()
              break

            case NotificationType.POS_DISCONNECTED:
              const terminalName = getRandomItem(['TPV 1', 'TPV 2', 'TPV 3'])
              const disconnectionTypes = [
                {
                  title: 'TPV Desconectado',
                  message: `El terminal ${terminalName} se ha desconectado.`,
                  actionLabel: 'Verificar Conexión',
                },
                {
                  title: 'TPV En Mantenimiento',
                  message: `El terminal ${terminalName} entró en modo mantenimiento.`,
                  actionLabel: 'Ver Estado',
                },
                {
                  title: 'TPV Batería Baja',
                  message: `El terminal ${terminalName} tiene batería baja (${faker.number.int({ min: 5, max: 20 })}%).`,
                  actionLabel: 'Verificar Terminal',
                },
              ]
              const disconnectionScenario = getRandomItem(disconnectionTypes)
              title = disconnectionScenario.title
              message = disconnectionScenario.message
              actionUrl = `/terminals/${terminalName.toLowerCase().replace(' ', '-')}`
              actionLabel = disconnectionScenario.actionLabel
              entityType = 'terminal'
              entityId = faker.string.uuid()
              metadata = { terminalName }
              break

            case NotificationType.ANNOUNCEMENT:
              const announcementTexts = [
                'Nueva actualización del sistema disponible',
                'Reunión de equipo programada para mañana',
                'Nuevo menú especial disponible',
                'Promoción de fin de semana activa',
                'Mantenimiento programado este domingo',
              ]
              const announcementText = getRandomItem(announcementTexts)
              title = 'Anuncio Importante'
              message = announcementText
              actionUrl = '/announcements'
              actionLabel = 'Leer Más'
              entityType = 'announcement'
              entityId = faker.string.uuid()
              metadata = { announcementText }
              break
          }

          const isRead = faker.datatype.boolean({ probability: 0.7 }) // 70% read
          const sentDate = faker.date.recent({ days: 7 })

          notifications.push({
            recipientId: recipient.staffId,
            venueId: venue.id,
            type: notificationType,
            title,
            message,
            actionUrl,
            actionLabel,
            entityType,
            entityId,
            metadata,
            isRead,
            readAt: isRead ? faker.date.between({ from: sentDate, to: new Date() }) : null,
            priority: getRandomItem([
              NotificationPriority.LOW,
              NotificationPriority.NORMAL,
              NotificationPriority.NORMAL,
              NotificationPriority.HIGH,
            ]) as NotificationPriority,
            channels: [NotificationChannel.IN_APP],
            sentAt: sentDate,
            createdAt: sentDate,
            updatedAt: sentDate,
          })
        }

        await prisma.notification.createMany({ data: notifications })
        console.log(`      - Created ${notifications.length} sample notifications for ${venue.name}.`)
      }
    }

    if (orgIndex === 0) {
      console.log(`  Creating invoice for ${org.name}...`)
      const periodStart = faker.date.recent({ days: 30 })
      const periodEnd = new Date()
      const transactionFees = 1234.56
      const featureFees = 99.99
      const subtotal = transactionFees + featureFees
      const taxAmount = subtotal * 0.16
      const total = subtotal + taxAmount
      await prisma.invoice.create({
        data: {
          organizationId: org.id,
          invoiceNumber: `INV-${faker.string.numeric(6)}`,
          periodStart,
          periodEnd,
          dueDate: faker.date.future({ years: 0.1 }),
          subtotal,
          taxAmount,
          total,
          status: InvoiceStatus.PENDING,
          items: {
            create: [
              {
                type: ChargeType.TRANSACTION_FEE,
                description: 'Comisiones por procesamiento de pagos',
                quantity: 1,
                unitPrice: transactionFees,
                amount: transactionFees,
              },
              {
                type: ChargeType.FEATURE_FEE,
                description: 'Suscripción a Features Premium',
                quantity: 1,
                unitPrice: featureFees,
                amount: featureFees,
              },
            ],
          },
        },
      })
      console.log('    - Created 1 invoice with 2 items.')
    }
  }

  console.log(`\nSeeding finished successfully.`)
}

main()
  .catch(async e => {
    console.error(e)
    await prisma.$disconnect()
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
