import { faker } from '@faker-js/faker'
import {
  AccountType,
  AlertStatus,
  AlertType,
  ChargeType,
  FeatureCategory,
  InvitationStatus,
  InvitationType,
  InventoryMethod,
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
  OriginSystem,
  PaymentMethod,
  PaymentSource,
  PaymentStatus,
  PrismaClient,
  ProductType,
  ProviderType,
  RawMaterialCategory,
  RawMaterialMovementType,
  ReceiptStatus,
  ReviewSource,
  SettlementDayType,
  SettlementStatus,
  StaffRole,
  SyncStatus,
  TerminalStatus,
  TerminalType,
  TransactionCardType,
  TransactionStatus,
  TransactionType,
  Unit,
  UnitType,
  VenueType,
  VenueStatus,
  VerificationStatus,
  EntityType,
} from '@prisma/client'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import { getUnitType } from '../src/services/dashboard/rawMaterial.service'
import { calculatePaymentSettlement } from '../src/services/payments/settlementCalculation.service'

const prisma = new PrismaClient()

const HASH_ROUNDS = 10

// ==========================================
// API KEY GENERATION & HASHING HELPERS
// ==========================================
// These are duplicated from sdk-auth.middleware.ts to avoid import issues with path aliases in seed

/**
 * Generate public and secret API keys for EcommerceMerchant
 * Also generates SHA-256 hash of secret key for O(1) database lookup
 */
function generateAPIKeys(sandboxMode: boolean): { publicKey: string; secretKey: string; secretKeyHash: string } {
  const prefix = sandboxMode ? 'test' : 'live'
  const publicKey = `pk_${prefix}_${crypto.randomBytes(32).toString('hex')}`
  const secretKey = `sk_${prefix}_${crypto.randomBytes(32).toString('hex')}`
  const secretKeyHash = hashSecretKey(secretKey)
  return { publicKey, secretKey, secretKeyHash }
}

/**
 * Hash secret key using SHA-256 (one-way, non-reversible)
 * Used for O(1) authentication lookup without storing plaintext
 */
function hashSecretKey(secretKey: string): string {
  return crypto.createHash('sha256').update(secretKey).digest('hex')
}

// ==========================================
// SEED CONFIGURATION FROM ENVIRONMENT
// ==========================================
const SEED_CONFIG = {
  // Time series configuration
  DAYS: parseInt(process.env.SEED_DAYS || '60'), // Default to ~2 months of historical data
  TIMEZONE: process.env.SEED_TIMEZONE || 'America/Mexico_City',

  // Volume configuration
  STORES: parseInt(process.env.SEED_STORES || '3'),
  CUSTOMERS: parseInt(process.env.SEED_CUSTOMERS || '300'), // Reduced from 2000 to 300
  PRODUCTS: parseInt(process.env.SEED_PRODUCTS || '40'), // Reduced from 200 to 40

  // Order patterns (significantly reduced)
  ORDERS_PER_DAY_MIN: parseInt(process.env.SEED_ORDERS_PER_DAY_MIN || '3'), // Reduced from 15 to 3
  ORDERS_PER_DAY_MAX: parseInt(process.env.SEED_ORDERS_PER_DAY_MAX || '8'), // Reduced from 45 to 8

  // Business hours
  OPEN_HOURS: process.env.SEED_OPEN_HOURS || '08:00-22:00',
  PEAK_HOURS: process.env.SEED_PEAK_HOURS || '12:00-14:00,19:00-21:00',

  // Order characteristics
  ITEMS_PER_ORDER_MIN: parseInt(process.env.SEED_ITEMS_PER_ORDER_MIN || '1'),
  ITEMS_PER_ORDER_MAX: parseInt(process.env.SEED_ITEMS_PER_ORDER_MAX || '3'), // Reduced from 6 to 3
  AOV_MIN: parseFloat(process.env.SEED_AOV_MIN || '120'),
  AOV_MAX: parseFloat(process.env.SEED_AOV_MAX || '850'),

  // Customer behavior
  TIP_MIN_PERCENT: parseFloat(process.env.SEED_TIP_MIN_PERCENT || '0.08'),
  TIP_MAX_PERCENT: parseFloat(process.env.SEED_TIP_MAX_PERCENT || '0.25'),
  REVIEW_PROBABILITY: parseFloat(process.env.SEED_REVIEW_PROB || '0.2'), // Reduced from 0.4 to 0.2
  GOOD_REVIEW_RATE: parseFloat(process.env.SEED_GOOD_REVIEW_RATE || '0.8'),

  // Payment patterns
  CASH_RATIO: parseFloat(process.env.SEED_CASH_RATIO || '0.25'),
  CARD_RATIO: parseFloat(process.env.SEED_CARD_RATIO || '0.75'),

  // Anomalies & variations
  WEEKEND_MULTIPLIER: parseFloat(process.env.SEED_WEEKEND_MULTIPLIER || '1.2'), // Reduced from 1.4 to 1.2
  REFUND_RATE: parseFloat(process.env.SEED_REFUND_RATE || '0.03'),

  // Reproducibility
  SEED: process.env.SEED_SEED ? parseInt(process.env.SEED_SEED) : undefined,

  // Promotion windows (JSON format)
  PROMO_WINDOWS: process.env.SEED_PROMO_WINDOWS || '[{"start":"2024-12-15","end":"2024-12-25","discount":0.2,"name":"Holiday Promo"}]',
}

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

// ==========================================
// ADVANCED TIME-SERIES GENERATION
// ==========================================

// Set deterministic seed if provided
if (SEED_CONFIG.SEED) {
  faker.seed(SEED_CONFIG.SEED)
  console.log(`🎲 Using deterministic seed: ${SEED_CONFIG.SEED}`)
}

// Parse business hours
function parseTimeRange(range: string) {
  const [start, end] = range.split('-')
  const startHour = parseInt(start.split(':')[0])
  const endHour = parseInt(end.split(':')[0])
  return { start: startHour, end: endHour }
}

const businessHours = parseTimeRange(SEED_CONFIG.OPEN_HOURS)
const peakHours = SEED_CONFIG.PEAK_HOURS.split(',').map(parseTimeRange)
const promoWindows = JSON.parse(SEED_CONFIG.PROMO_WINDOWS)

// Advanced date helpers for realistic time distribution
function daysAgo(n: number): Date {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d
}

function randomDateBetween(from: Date, to: Date): Date {
  return faker.date.between({ from, to })
}

// Generate realistic business hours with peak patterns
function generateBusinessHourTimestamp(baseDate: Date): Date {
  const result = new Date(baseDate)

  // Determine if it's a peak hour
  const isPeakTime = Math.random() < 0.4 // 40% chance of peak time

  let hour: number
  if (isPeakTime && peakHours.length > 0) {
    // Select a random peak period
    const peakPeriod = getRandomItem(peakHours)
    hour = faker.number.int({ min: peakPeriod.start, max: peakPeriod.end - 1 })
  } else {
    // Regular business hours
    hour = faker.number.int({ min: businessHours.start, max: businessHours.end - 1 })
  }

  const minute = faker.number.int({ min: 0, max: 59 })
  const second = faker.number.int({ min: 0, max: 59 })

  result.setHours(hour, minute, second, 0)
  return result
}

// Calculate day-of-week multiplier for realistic weekly patterns
function getDayOfWeekMultiplier(date: Date): number {
  const dayOfWeek = date.getDay() // 0 = Sunday, 6 = Saturday

  // Weekend boost
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return SEED_CONFIG.WEEKEND_MULTIPLIER
  }

  // Weekday patterns (Tuesday-Thursday slightly higher)
  if (dayOfWeek >= 2 && dayOfWeek <= 4) {
    return 1.1
  }

  // Monday and Friday slightly lower
  return 0.9
}

// Check if date is within a promotion window
function isPromotionDay(date: Date): { active: boolean; discount: number; name?: string } {
  const dateStr = date.toISOString().split('T')[0]

  for (const promo of promoWindows) {
    if (dateStr >= promo.start && dateStr <= promo.end) {
      return { active: true, discount: promo.discount, name: promo.name }
    }
  }

  return { active: false, discount: 0 }
}

// Generate realistic order volume for a given day
function getOrderVolumeForDay(date: Date): number {
  const baseVolume = faker.number.int({
    min: SEED_CONFIG.ORDERS_PER_DAY_MIN,
    max: SEED_CONFIG.ORDERS_PER_DAY_MAX,
  })

  // Apply day-of-week multiplier
  const dayMultiplier = getDayOfWeekMultiplier(date)

  // Apply promotion multiplier
  const promo = isPromotionDay(date)
  const promoMultiplier = promo.active ? 1 + promo.discount * 0.5 : 1 // Promos increase volume

  // Add some random variance (±20%)
  const varianceMultiplier = faker.number.float({ min: 0.8, max: 1.2 })

  // Occasionally have very slow days (2% chance)
  const isSlowDay = Math.random() < 0.02
  const slowDayMultiplier = isSlowDay ? 0.3 : 1

  const finalVolume = Math.round(baseVolume * dayMultiplier * promoMultiplier * varianceMultiplier * slowDayMultiplier)

  return Math.max(1, finalVolume) // At least 1 order
}

// Generate realistic AOV with promotions and variance
function generateRealisticAOV(date: Date, baseAov?: number): number {
  const targetAov = baseAov || faker.number.float({ min: SEED_CONFIG.AOV_MIN, max: SEED_CONFIG.AOV_MAX })

  // Apply promotion discount
  const promo = isPromotionDay(date)
  const promoMultiplier = promo.active ? 1 - promo.discount : 1

  // Weekend AOV tends to be higher
  const dayMultiplier = date.getDay() === 0 || date.getDay() === 6 ? 1.15 : 1

  // Evening orders tend to be higher
  const hour = date.getHours()
  const timeMultiplier = hour >= 18 && hour <= 21 ? 1.2 : 1

  return targetAov * promoMultiplier * dayMultiplier * timeMultiplier
}

// Generate customer cohorts with realistic retention patterns
function generateCustomerCohort(customerIndex: number, totalCustomers: number) {
  // 20% are new customers (recent signups)
  // 60% are regular customers
  // 20% are VIP/frequent customers

  const cohortType = customerIndex < totalCustomers * 0.2 ? 'new' : customerIndex < totalCustomers * 0.8 ? 'regular' : 'vip'

  return {
    type: cohortType,
    orderFrequency: cohortType === 'new' ? 0.1 : cohortType === 'regular' ? 0.3 : 0.7,
    tipMultiplier: cohortType === 'new' ? 0.8 : cohortType === 'regular' ? 1.0 : 1.3,
    avgOrderValue: cohortType === 'new' ? 0.9 : cohortType === 'regular' ? 1.0 : 1.4,
  }
}

// ==========================================
// IDEMPOTENT RESET FUNCTIONALITY
// ==========================================
async function resetDatabase() {
  console.log('🧹 Performing idempotent database reset...')

  // Helper to safely delete with logging
  const safeDelete = async (modelName: string, deleteOperation: () => Promise<any>) => {
    try {
      const result = await deleteOperation()
      if (result.count > 0) {
        console.log(`  ✅ Deleted ${result.count} ${modelName} records`)
      }
    } catch (error: any) {
      // Ignore FK constraint errors during cleanup
      if (!error.message.includes('foreign key constraint')) {
        console.warn(`  ⚠️  Warning deleting ${modelName}: ${error.message}`)
      }
    }
  }

  // Delete in proper FK dependency order
  const deleteOrder = [
    ['OrderItemModifiers', () => prisma.orderItemModifier.deleteMany()],
    ['ActivityLogs', () => prisma.activityLog.deleteMany()],
    ['DigitalReceipts', () => prisma.digitalReceipt.deleteMany()],
    ['InvoiceItems', () => prisma.invoiceItem.deleteMany()],
    ['PaymentAllocations', () => prisma.paymentAllocation.deleteMany()],
    ['Reviews', () => prisma.review.deleteMany()],
    ['ProductModifierGroups', () => prisma.productModifierGroup.deleteMany()],
    // Inventory Management - most dependent first
    ['RecipeLines', () => prisma.recipeLine.deleteMany()],
    ['Recipes', () => prisma.recipe.deleteMany()],
    ['LowStockAlerts', () => prisma.lowStockAlert.deleteMany()],
    ['RawMaterialMovements', () => prisma.rawMaterialMovement.deleteMany()],
    ['StockBatches', () => prisma.stockBatch.deleteMany()],
    ['SupplierPricing', () => prisma.supplierPricing.deleteMany()],
    ['PurchaseOrderItems', () => prisma.purchaseOrderItem.deleteMany()],
    ['PurchaseOrders', () => prisma.purchaseOrder.deleteMany()],
    ['RawMaterials', () => prisma.rawMaterial.deleteMany()],
    ['Suppliers', () => prisma.supplier.deleteMany()],
    // End Inventory Management
    ['InventoryMovements', () => prisma.inventoryMovement.deleteMany()],
    ['MenuCategoryAssignments', () => prisma.menuCategoryAssignment.deleteMany()],
    ['VenueFeatures', () => prisma.venueFeature.deleteMany()],
    ['FeeTiers', () => prisma.feeTier.deleteMany()],
    ['OrderItems', () => prisma.orderItem.deleteMany()],
    ['VenueTransactions', () => prisma.venueTransaction.deleteMany()],
    ['Payments', () => prisma.payment.deleteMany()],
    ['Orders', () => prisma.order.deleteMany()],
    ['Shifts', () => prisma.shift.deleteMany()],
    ['Inventories', () => prisma.inventory.deleteMany()],
    ['Modifiers', () => prisma.modifier.deleteMany()],
    ['StaffVenues', () => prisma.staffVenue.deleteMany()],
    ['VenueRolePermissions', () => prisma.venueRolePermission.deleteMany()],
    ['VenueSettings', () => prisma.venueSettings.deleteMany()],
    ['PosCommands', () => prisma.posCommand.deleteMany()],
    ['PosConnectionStatuses', () => prisma.posConnectionStatus.deleteMany()],
    ['Notifications', () => prisma.notification.deleteMany()],
    ['NotificationPreferences', () => prisma.notificationPreference.deleteMany()],
    ['NotificationTemplates', () => prisma.notificationTemplate.deleteMany()],
    ['TransactionCosts', () => prisma.transactionCost.deleteMany()],
    ['MonthlyVenueProfits', () => prisma.monthlyVenueProfit.deleteMany()],
    ['VenuePricingStructures', () => prisma.venuePricingStructure.deleteMany()],
    ['ProviderCostStructures', () => prisma.providerCostStructure.deleteMany()],
    ['VenuePaymentConfigs', () => prisma.venuePaymentConfig.deleteMany()],
    // ⚠️ DON'T delete EcommerceMerchants with Blumon OAuth credentials
    // Delete only Menta merchants (no OAuth), preserve Blumon merchants with OAuth tokens
    [
      'EcommerceMerchants',
      async () => {
        // Delete Menta merchants (demo credentials, safe to recreate)
        const mentaProvider = await prisma.paymentProvider.findFirst({ where: { code: 'MENTA' } })
        if (mentaProvider) {
          await prisma.ecommerceMerchant.deleteMany({ where: { providerId: mentaProvider.id } })
        }

        // Delete Blumon merchants WITHOUT OAuth credentials (incomplete setup)
        const blumonProvider = await prisma.paymentProvider.findFirst({ where: { code: 'BLUMON' } })
        if (blumonProvider) {
          const blumonMerchants = await prisma.ecommerceMerchant.findMany({
            where: { providerId: blumonProvider.id },
          })

          for (const merchant of blumonMerchants) {
            const credentials = merchant.providerCredentials as any
            // Delete if no OAuth tokens (incomplete setup)
            if (!credentials?.accessToken || !credentials?.refreshToken) {
              await prisma.ecommerceMerchant.delete({ where: { id: merchant.id } })
              console.log(`      🗑️ Deleted Blumon merchant "${merchant.channelName}" (no OAuth credentials)`)
            } else {
              console.log(`      ✅ Preserved Blumon merchant "${merchant.channelName}" (has OAuth credentials)`)
            }
          }
        }
      },
    ],
    ['MerchantAccounts', () => prisma.merchantAccount.deleteMany()],
    // ⚠️ DON'T delete PaymentProviders if any EcommerceMerchants are preserved
    // Delete only providers that aren't referenced by preserved merchants
    [
      'PaymentProviders',
      async () => {
        // Get all preserved EcommerceMerchants
        const preservedMerchants = await prisma.ecommerceMerchant.findMany({
          select: { providerId: true },
        })
        const preservedProviderIds = [...new Set(preservedMerchants.map(m => m.providerId))]

        if (preservedProviderIds.length > 0) {
          // Delete only providers NOT referenced by preserved merchants
          await prisma.paymentProvider.deleteMany({
            where: {
              id: {
                notIn: preservedProviderIds,
              },
            },
          })
          console.log(`      ✅ Preserved ${preservedProviderIds.length} payment providers (referenced by preserved merchants)`)
        } else {
          // No preserved merchants, delete all providers
          await prisma.paymentProvider.deleteMany()
        }
      },
    ],
    ['Tables', () => prisma.table.deleteMany()],
    ['Areas', () => prisma.area.deleteMany()],
    ['Terminals', () => prisma.terminal.deleteMany()],
    ['Invitations', () => prisma.invitation.deleteMany()],
    ['Invoices', () => prisma.invoice.deleteMany()],
    ['Menus', () => prisma.menu.deleteMany()],
    ['ModifierGroups', () => prisma.modifierGroup.deleteMany()],
    ['Products', () => prisma.product.deleteMany()],
    ['MenuCategories', () => prisma.menuCategory.deleteMany()],
    ['FeeSchedules', () => prisma.feeSchedule.deleteMany()],
    ['Staff', () => prisma.staff.deleteMany()],
    ['Venues', () => prisma.venue.deleteMany()],
    ['Organizations', () => prisma.organization.deleteMany()],
    // ⚠️ DON'T delete Features - they keep Stripe IDs across seed runs
    // Upsert will update existing features without losing stripeProductId/stripePriceId
    // ['Features', () => prisma.feature.deleteMany()],
    ['Customers', () => prisma.customer.deleteMany()],
  ]

  for (const [modelName, deleteOperation] of deleteOrder) {
    await safeDelete(modelName as string, deleteOperation as () => Promise<any>)
  }

  console.log('🧹 Database reset completed successfully.')
}

async function main() {
  console.log(`🚀 Starting intelligent Prisma seed generation...`)
  console.log(`📊 Configuration:`)
  console.log(`   - Days: ${SEED_CONFIG.DAYS}`)
  console.log(`   - Business Hours: ${SEED_CONFIG.OPEN_HOURS}`)
  console.log(`   - Peak Hours: ${SEED_CONFIG.PEAK_HOURS}`)
  console.log(`   - Orders/day: ${SEED_CONFIG.ORDERS_PER_DAY_MIN}-${SEED_CONFIG.ORDERS_PER_DAY_MAX}`)
  console.log(`   - AOV Range: $${SEED_CONFIG.AOV_MIN}-${SEED_CONFIG.AOV_MAX}`)
  console.log(`   - Tip Range: ${(SEED_CONFIG.TIP_MIN_PERCENT * 100).toFixed(1)}%-${(SEED_CONFIG.TIP_MAX_PERCENT * 100).toFixed(1)}%`)
  if (promoWindows.length > 0) {
    console.log(`   - Promotions: ${promoWindows.length} promotion windows configured`)
  }
  console.log('')

  await resetDatabase()

  // --- Seed de Datos Globales/Independientes ---
  console.log('Seeding global data...')
  const featuresData = [
    {
      code: 'CHATBOT',
      name: 'Chatbot Inteligente',
      description: 'Chatbot con IA para atención automática de clientes 24/7.',
      category: FeatureCategory.OPERATIONS,
      monthlyPrice: 399.0, // MXN
    },
    {
      code: 'ADVANCED_ANALYTICS',
      name: 'Analíticas Avanzadas',
      description: 'Reportes detallados, tendencias de ventas, y análisis predictivo.',
      category: FeatureCategory.ANALYTICS,
      monthlyPrice: 499.0, // MXN
    },
    {
      code: 'INVENTORY_TRACKING',
      name: 'Control de Inventario',
      description: 'Gestión FIFO de inventario, recetas, y alertas de stock bajo.',
      category: FeatureCategory.OPERATIONS,
      monthlyPrice: 299.0, // MXN
    },
    {
      code: 'LOYALTY_PROGRAM',
      name: 'Programa de Lealtad',
      description: 'Sistema de puntos y recompensas para clientes frecuentes.',
      category: FeatureCategory.MARKETING,
      monthlyPrice: 599.0, // MXN
    },
    {
      code: 'ONLINE_ORDERING',
      name: 'Pedidos en Línea',
      description: 'Permite a los clientes ordenar desde la web o app con QR.',
      category: FeatureCategory.INTEGRATIONS,
      monthlyPrice: 799.0, // MXN
    },
    {
      code: 'RESERVATIONS',
      name: 'Sistema de Reservas',
      description: 'Gestión de reservas de mesas con confirmación automática.',
      category: FeatureCategory.OPERATIONS,
      monthlyPrice: 399.0, // MXN
    },
    {
      code: 'AVAILABLE_BALANCE',
      name: 'Saldo Disponible',
      description: 'Visualización de saldo disponible, liquidaciones pendientes, y proyecciones de flujo de efectivo.',
      category: FeatureCategory.PAYMENTS,
      monthlyPrice: 0.0, // MXN - Free feature
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

  // Note: Seed creates features in DB, but Stripe sync happens separately
  // Stripe products/prices are created automatically during:
  // 1. Onboarding (venueCreation.service.ts calls syncFeaturesToStripe)
  // 2. Demo conversion (venue.dashboard.service.ts calls syncFeaturesToStripe)
  // To manually sync: npx ts-node -r tsconfig-paths/register scripts/sync-features-to-stripe.ts
  console.log('  💡 To sync features to Stripe, run: npx ts-node -r tsconfig-paths/register scripts/sync-features-to-stripe.ts')

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

  // ⚠️ MOVED: Customer creation moved to AFTER venue creation (needs venueId)
  // See customer creation around line 1300+ inside venue loop
  const customerCohortMap = new Map<string, { type: string; joinedAt: Date }>() // Track cohort info separately

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
      message: '{{rawMaterialName}} ({{sku}}) tiene stock bajo ({{currentStock}} {{unit}}).',
      actionLabel: 'Gestionar Inventario',
      variables: ['rawMaterialName', 'sku', 'currentStock', 'unit'],
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

  // ============================
  // PAYMENT PROVIDER TEMPLATES
  // ============================
  // These records are the source of truth for each upstream vendor.
  // Keep `configSchema` aligned with the shape you expect inside
  // `MerchantAccount.providerConfig` so the intent stays obvious for
  // developers (and any validation layer you wire up later).
  // Secrets (API keys, tokens, etc.) are *not* described here—they live in
  // `credentialsEncrypted` in the accounts seeded below.
  // Create or update payment providers (upsert to handle preserved providers)
  const mentaProvider = await prisma.paymentProvider.upsert({
    where: { code: 'BANORTE' },
    update: {},
    create: {
      code: 'BANORTE',
      name: 'Menta Payment Solutions - Banorte',
      type: ProviderType.PAYMENT_PROCESSOR,
      countryCode: ['MX', 'AR'],
      active: true,
      configSchema: {
        required: ['acquirerId', 'countryCode', 'currencyCode'],
        properties: {
          acquirerId: { type: 'string', description: 'Acquirer identifier (BANORTE, GPS, etc.)' },
          countryCode: {
            type: 'string',
            enum: ['484', '032'],
            description: 'ISO numeric country code as string (484 = MX, 032 = AR)',
          },
          currencyCode: {
            type: 'string',
            enum: ['MX'],
            description: 'Processor-specific currency code (Menta expects MX)',
          },
          terminalId: {
            type: 'string',
            description: 'Preferred terminal UUID used for this account (non-sensitive)',
          },
          invoiceCapable: { type: 'boolean', description: 'Marks accounts that support electronic invoicing flows' },
        },
      },
    },
  })

  const clipProvider = await prisma.paymentProvider.upsert({
    where: { code: 'CLIP' },
    update: {},
    create: {
      code: 'CLIP',
      name: 'Clip Digital Wallet',
      type: ProviderType.WALLET,
      countryCode: ['MX'],
      active: true,
      configSchema: {
        required: ['countryCode', 'currencyCode'],
        properties: {
          countryCode: { type: 'string', enum: ['484'], description: 'ISO numeric country code (484 = MX)' },
          currencyCode: { type: 'string', enum: ['MX'], description: 'Settlement currency code used by Clip' },
          webhookUrl: { type: 'string', description: 'URL where Clip will send webhook events' },
        },
      },
    },
  })

  const blumonProvider = await prisma.paymentProvider.upsert({
    where: { code: 'BLUMON' },
    update: {},
    create: {
      code: 'BLUMON',
      name: 'Blumon PAX Payment Solutions',
      type: ProviderType.PAYMENT_PROCESSOR,
      countryCode: ['MX'],
      active: true,
      configSchema: {
        required: ['serialNumber', 'posId', 'environment'],
        properties: {
          serialNumber: {
            type: 'string',
            description: 'Blumon device serial number (e.g., 2841548417)',
          },
          posId: {
            type: 'string',
            description: 'Momentum API position ID (CRITICAL for payment routing)',
          },
          environment: {
            type: 'string',
            enum: ['SANDBOX', 'PRODUCTION'],
            description: 'Blumon environment',
          },
          merchantId: {
            type: 'string',
            description: 'Blumon merchant identifier',
          },
        },
      },
    },
  })

  await prisma.paymentProvider.upsert({
    where: { code: 'BANORTE_DIRECT' },
    update: {},
    create: {
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

  console.log(`  Created 4 payment providers (Menta, Clip, Blumon, Banorte).`)

  // 🆕 Create Stripe merchant account (gateway for online payments)
  const stripeMerchant = await prisma.merchantAccount.create({
    data: {
      providerId: mentaProvider.id, // Using Menta provider as fallback (could be a dedicated Stripe provider)
      externalMerchantId: 'acct_stripe_demo_12345',
      alias: 'Stripe Gateway Account',
      displayName: 'Cuenta Stripe (Online)',
      displayOrder: 0,
      active: true,
      bankName: 'Stripe Mexico',
      clabeNumber: '646180157000000004', // STP CLABE for Stripe
      accountHolder: 'Stripe Payments Mexico S. de R.L.',
      credentialsEncrypted: {
        // Stripe API credentials (mock for seed)
        publishableKey: 'pk_test_mock_stripe_publishable_key',
        secretKey: 'sk_test_mock_stripe_secret_key',
        webhookSecret: 'whsec_mock_stripe_webhook_secret',
      },
      providerConfig: {
        accountId: 'acct_stripe_demo_12345',
        countryCode: 'MX',
        currencyCode: 'MXN',
        paymentMethods: ['card', 'oxxo', 'spei'],
        webhookUrl: 'https://api.avoqado.com/webhooks/stripe',
      },
    },
  })

  // 🆕 Blumon Merchant Accounts (Multi-Merchant Support - 2025-11-06)
  // These match the actual Blumon sandbox devices registered with Edgardo
  const blumonMerchantA = await prisma.merchantAccount.create({
    data: {
      providerId: blumonProvider.id,
      externalMerchantId: 'blumon_merchant_2841548417',
      alias: 'Blumon Account A',
      displayName: 'Cuenta Blumon A (Sandbox)',
      displayOrder: 20,
      active: true,
      // Blumon-specific fields (Phase 2 - Multi-Merchant)
      blumonSerialNumber: '2841548417',
      blumonPosId: '376',
      blumonEnvironment: 'SANDBOX',
      blumonMerchantId: 'blumon_merchant_2841548417',
      credentialsEncrypted: {
        // OAuth tokens and DUKPT keys (mock for seed)
        // Real credentials are fetched from Blumon API and encrypted
        clientId: 'mock_client_id_2841548417',
        clientSecret: 'mock_client_secret_2841548417',
        serialNumber: '2841548417',
        environment: 'SANDBOX',
      },
      providerConfig: {
        serialNumber: '2841548417',
        posId: '376',
        environment: 'SANDBOX',
        brand: 'PAX',
        model: 'A910S',
      },
    },
  })

  const blumonMerchantB = await prisma.merchantAccount.create({
    data: {
      providerId: blumonProvider.id,
      externalMerchantId: 'blumon_merchant_2841548418',
      alias: 'Blumon Account B',
      displayName: 'Cuenta Blumon B (Sandbox)',
      displayOrder: 21,
      active: true,
      // Blumon-specific fields (Phase 2 - Multi-Merchant)
      blumonSerialNumber: '2841548418',
      blumonPosId: '378',
      blumonEnvironment: 'SANDBOX',
      blumonMerchantId: 'blumon_merchant_2841548418',
      credentialsEncrypted: {
        // OAuth tokens and DUKPT keys (mock for seed)
        clientId: 'mock_client_id_2841548418',
        clientSecret: 'mock_client_secret_2841548418',
        serialNumber: '2841548418',
        environment: 'SANDBOX',
      },
      providerConfig: {
        serialNumber: '2841548418',
        posId: '378',
        environment: 'SANDBOX',
        brand: 'PAX',
        model: 'A910S',
      },
    },
  })

  console.log(`  Created 3 merchant accounts (Stripe, Blumon x2).`)

  // Create provider cost structures (what providers charge Avoqado)
  const stripeCosts = await prisma.providerCostStructure.create({
    data: {
      providerId: mentaProvider.id,
      merchantAccountId: stripeMerchant.id,
      debitRate: 0.029, // 2.9% for all cards (Stripe standard rate)
      creditRate: 0.029, // Same rate for all card types
      amexRate: 0.029,
      internationalRate: 0.044, // 4.4% for international cards (2.9% + 1.5%)
      fixedCostPerTransaction: 3.0, // $3 MXN fixed fee
      monthlyFee: 0.0, // No monthly fee
      effectiveFrom: new Date('2024-01-01'),
      active: true,
      proposalReference: 'STRIPE-2024-001',
      notes: 'Stripe standard rates for Mexico (2.9% + $3 MXN)',
    },
  })

  const blumonACosts = await prisma.providerCostStructure.create({
    data: {
      providerId: blumonProvider.id,
      merchantAccountId: blumonMerchantA.id,
      debitRate: 0.015, // 1.5% for all cards
      creditRate: 0.015, // 1.5% for all cards
      amexRate: 0.015, // 1.5% for all cards
      internationalRate: 0.015, // 1.5% for all cards
      fixedCostPerTransaction: null, // No fixed cost
      monthlyFee: null, // No monthly fee
      effectiveFrom: new Date('2024-01-01'),
      active: true,
      proposalReference: 'BLUMON-2024-A-001',
      notes: 'Blumon Account A rates - Flat 1.5% for all cards',
    },
  })

  const blumonBCosts = await prisma.providerCostStructure.create({
    data: {
      providerId: blumonProvider.id,
      merchantAccountId: blumonMerchantB.id,
      debitRate: 0.015, // 1.5% for all cards
      creditRate: 0.015, // 1.5% for all cards
      amexRate: 0.015, // 1.5% for all cards
      internationalRate: 0.015, // 1.5% for all cards
      fixedCostPerTransaction: null, // No fixed cost
      monthlyFee: null, // No monthly fee
      effectiveFrom: new Date('2024-01-01'),
      active: true,
      proposalReference: 'BLUMON-2024-B-001',
      notes: 'Blumon Account B rates - Flat 1.5% for all cards',
    },
  })

  console.log(`  Created 3 provider cost structures (Stripe, Blumon x2).`)

  // Create settlement configurations for each merchant account
  console.log('Seeding settlement configurations...')

  // Stripe Account - Fast settlements
  const stripeSettlementTypes = [
    { cardType: TransactionCardType.DEBIT, settlementDays: 2, notes: 'Stripe débito - 2 días hábiles' },
    { cardType: TransactionCardType.CREDIT, settlementDays: 2, notes: 'Stripe crédito - 2 días hábiles' },
    { cardType: TransactionCardType.AMEX, settlementDays: 2, notes: 'Stripe Amex - 2 días hábiles' },
    { cardType: TransactionCardType.INTERNATIONAL, settlementDays: 3, notes: 'Stripe internacional - 3 días hábiles' },
    { cardType: TransactionCardType.OTHER, settlementDays: 2, notes: 'Stripe otras - 2 días hábiles' },
  ]

  for (const config of stripeSettlementTypes) {
    await prisma.settlementConfiguration.create({
      data: {
        merchantAccountId: stripeMerchant.id,
        cardType: config.cardType,
        settlementDays: config.settlementDays,
        settlementDayType: SettlementDayType.BUSINESS_DAYS,
        cutoffTime: '23:59',
        cutoffTimezone: 'America/Mexico_City',
        effectiveFrom: new Date('2024-01-01'),
        notes: config.notes,
      },
    })
  }

  // Blumon Account A - Standard settlement times
  const blumonSettlementTypes = [
    { cardType: TransactionCardType.DEBIT, settlementDays: 1, notes: 'Tarjetas de débito - 1 día hábil' },
    { cardType: TransactionCardType.CREDIT, settlementDays: 2, notes: 'Tarjetas de crédito - 2 días hábiles' },
    { cardType: TransactionCardType.AMEX, settlementDays: 3, notes: 'American Express - 3 días hábiles' },
    { cardType: TransactionCardType.INTERNATIONAL, settlementDays: 5, notes: 'Tarjetas internacionales - 5 días hábiles' },
    { cardType: TransactionCardType.OTHER, settlementDays: 2, notes: 'Otras tarjetas - 2 días hábiles' },
  ]

  for (const config of blumonSettlementTypes) {
    await prisma.settlementConfiguration.create({
      data: {
        merchantAccountId: blumonMerchantA.id,
        cardType: config.cardType,
        settlementDays: config.settlementDays,
        settlementDayType: SettlementDayType.BUSINESS_DAYS,
        cutoffTime: '23:00',
        cutoffTimezone: 'America/Mexico_City',
        effectiveFrom: new Date('2024-01-01'),
        notes: config.notes,
      },
    })
  }

  // Blumon Account B - Same settlement times
  for (const config of blumonSettlementTypes) {
    await prisma.settlementConfiguration.create({
      data: {
        merchantAccountId: blumonMerchantB.id,
        cardType: config.cardType,
        settlementDays: config.settlementDays,
        settlementDayType: SettlementDayType.BUSINESS_DAYS,
        cutoffTime: '23:00',
        cutoffTimezone: 'America/Mexico_City',
        effectiveFrom: new Date('2024-01-01'),
        notes: config.notes,
      },
    })
  }

  console.log(
    `  Created ${stripeSettlementTypes.length + blumonSettlementTypes.length * 2} settlement configurations (Stripe + Blumon x2).`,
  )

  // --- 1. Organizaciones ---
  console.log('Seeding organizations...')
  const organizations = await Promise.all([
    prisma.organization.create({
      data: { name: 'Grupo Avoqado Prime', email: 'hola@avoqado.com', phone: faker.phone.number(), taxId: 'AVP123456XYZ' },
    }),
  ])
  console.log(`  Created ${organizations.length} organizations.`)

  // --- Bucle principal para poblar cada organización ---
  for (const [orgIndex, org] of organizations.entries()) {
    console.log(`\nSeeding for Organization: ${org.name} (ID: ${org.id})`)

    const createdStaffList: (any & { assignedRole: StaffRole })[] = []

    // --- Staff de la Organización ---
    // Solo crear SUPERADMIN y OWNER a nivel organización (tienen acceso a todos los venues)
    const staffToCreate =
      orgIndex === 0
        ? [
            // Staff global con acceso a todos los venues
            {
              email: 'superadmin@superadmin.com',
              password: 'superadmin',
              role: StaffRole.SUPERADMIN,
              firstName: 'Super',
              lastName: 'Admin',
            },
            { email: 'owner@owner.com', password: 'owner', role: StaffRole.OWNER, firstName: 'Main', lastName: 'Owner' },
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
    console.log(`  Created ${createdStaffList.length} global staff members (SUPERADMIN, OWNER).`)

    // Para invitaciones usamos OWNER como invitador
    const mainInviter = createdStaffList.find(s => s.assignedRole === StaffRole.OWNER)

    // --- Invitaciones ---
    if (mainInviter) {
      await prisma.invitation.create({
        data: {
          email: faker.internet.email(),
          role: StaffRole.ADMIN,
          type: InvitationType.VENUE_ADMIN,
          organizationId: org.id,
          token: faker.string.uuid(),
          expiresAt: faker.date.future(),
          status: InvitationStatus.PENDING,
          invitedById: mainInviter.id,
          message: 'Te invito a ser admin de nuestro nuevo local.',
        },
      })
      console.log(`  Created a sample invitation.`)
    }

    // --- Bucle de Venues: diferentes venues con distintos estados para testing ---
    // Cada venue tiene un status y kycStatus diferente para probar todos los flujos
    const venuesConfig =
      orgIndex === 0
        ? [
            // 1. Venue principal: ACTIVE con KYC VERIFIED (full data)
            {
              name: 'Avoqado Full',
              slug: 'avoqado-full',
              seedFullData: true,
              status: VenueStatus.ACTIVE,
              kycStatus: VerificationStatus.VERIFIED,
            },
            // 2. Venue en TRIAL (demo de onboarding, 30 días)
            {
              name: 'Avoqado Trial',
              slug: 'avoqado-trial',
              seedFullData: false,
              status: VenueStatus.TRIAL,
              kycStatus: VerificationStatus.NOT_SUBMITTED,
              demoExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
            },
            // 3. Venue en ONBOARDING con KYC PENDING_REVIEW (esperando revisión)
            {
              name: 'Avoqado Onboarding',
              slug: 'avoqado-onboarding',
              seedFullData: false,
              status: VenueStatus.ONBOARDING,
              kycStatus: VerificationStatus.PENDING_REVIEW,
            },
            // 4. Venue PENDING_ACTIVATION (KYC en revisión por Avoqado)
            {
              name: 'Avoqado Pending',
              slug: 'avoqado-pending',
              seedFullData: false,
              status: VenueStatus.PENDING_ACTIVATION,
              kycStatus: VerificationStatus.IN_REVIEW,
            },
            // 5. Venue SUSPENDED (suspendido por owner)
            {
              name: 'Avoqado Suspended',
              slug: 'avoqado-suspended',
              seedFullData: false,
              status: VenueStatus.SUSPENDED,
              kycStatus: VerificationStatus.VERIFIED,
              suspensionReason: 'Vacaciones de temporada - reabrimos en enero',
            },
            // 6. Venue con KYC REJECTED (necesita reenviar)
            {
              name: 'Avoqado Rejected',
              slug: 'avoqado-rejected',
              seedFullData: false,
              status: VenueStatus.ONBOARDING,
              kycStatus: VerificationStatus.REJECTED,
            },
          ]
        : []

    for (const [index, venueConfig] of venuesConfig.entries()) {
      const venueName = venueConfig.name
      const venueSlug = venueConfig.slug || generateSlug(venueName)
      const isFullVenue = venueConfig.seedFullData
      const venue = await prisma.venue.create({
        data: {
          organizationId: org.id,
          name: venueName,
          slug: venueSlug,
          type: VenueType.RESTAURANT,
          entityType: index === 0 ? EntityType.PERSONA_MORAL : EntityType.PERSONA_FISICA,
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
          // Use status and kycStatus from venueConfig
          status: venueConfig.status,
          kycStatus: venueConfig.kycStatus,
          statusChangedAt: new Date(),
          // Optional fields from config
          ...('demoExpiresAt' in venueConfig && { demoExpiresAt: venueConfig.demoExpiresAt }),
          ...('suspensionReason' in venueConfig && { suspensionReason: venueConfig.suspensionReason }),
        },
      })
      console.log(`    -> Created Venue: ${venue.name} (status: ${venueConfig.status}, kyc: ${venueConfig.kycStatus})`)

      // Crear staff específico para este venue (solo para org 0)
      const venueSpecificStaff: (any & { assignedRole: StaffRole })[] = []
      if (orgIndex === 0) {
        // Use short suffix based on venue slug for unique emails
        // avoqado-full -> '', avoqado-trial -> 'trial', etc.
        const suffix = index === 0 ? '' : venueSlug.replace('avoqado-', '')
        const emailSuffix = suffix ? `.${suffix}` : ''
        const venueStaffToCreate = [
          {
            email: `admin${emailSuffix}@admin.com`,
            password: suffix || 'admin',
            role: StaffRole.ADMIN,
            firstName: 'Admin',
            lastName: `Venue ${index + 1}`,
          },
          {
            email: `manager${emailSuffix}@manager.com`,
            password: suffix || 'manager',
            role: StaffRole.MANAGER,
            firstName: 'Manager',
            lastName: `Venue ${index + 1}`,
          },
          {
            email: `cashier${emailSuffix}@cashier.com`,
            password: suffix || 'cashier',
            role: StaffRole.CASHIER,
            firstName: 'Cashier',
            lastName: `Venue ${index + 1}`,
          },
          {
            email: `waiter${emailSuffix}@waiter.com`,
            password: suffix || 'waiter',
            role: StaffRole.WAITER,
            firstName: 'Waiter',
            lastName: `Venue ${index + 1}`,
          },
          {
            email: `waiter2${emailSuffix}@waiter.com`,
            password: suffix ? `waiter2.${suffix}` : 'waiter2',
            role: StaffRole.WAITER,
            firstName: 'María',
            lastName: 'González',
          },
          {
            email: `waiter3${emailSuffix}@waiter.com`,
            password: suffix ? `waiter3.${suffix}` : 'waiter3',
            role: StaffRole.WAITER,
            firstName: 'Carlos',
            lastName: 'Rodríguez',
          },
          {
            email: `waiter4${emailSuffix}@waiter.com`,
            password: suffix ? `waiter4.${suffix}` : 'waiter4',
            role: StaffRole.WAITER,
            firstName: 'Ana',
            lastName: 'Martínez',
          },
          {
            email: `kitchen${emailSuffix}@kitchen.com`,
            password: suffix || 'kitchen',
            role: StaffRole.KITCHEN,
            firstName: 'Kitchen',
            lastName: `Venue ${index + 1}`,
          },
          {
            email: `host${emailSuffix}@host.com`,
            password: suffix || 'host',
            role: StaffRole.HOST,
            firstName: 'Host',
            lastName: `Venue ${index + 1}`,
          },
          {
            email: `viewer${emailSuffix}@viewer.com`,
            password: suffix || 'viewer',
            role: StaffRole.VIEWER,
            firstName: 'Viewer',
            lastName: `Venue ${index + 1}`,
          },
        ]

        for (const staffData of venueStaffToCreate) {
          const staffMember = await prisma.staff.create({
            data: {
              organizationId: org.id,
              email: staffData.email,
              password: await bcrypt.hash(staffData.password, HASH_ROUNDS),
              firstName: staffData.firstName,
              lastName: staffData.lastName,
              phone: faker.phone.number(),
              active: true,
              emailVerified: true,
            },
          })
          venueSpecificStaff.push({ ...staffMember, assignedRole: staffData.role })
        }
        console.log(`      - Created ${venueSpecificStaff.length} venue-specific staff members.`)
      }

      let venueAssignments = 0

      // Asignar staff global (SUPERADMIN, OWNER) a este venue
      for (const staffWithRole of createdStaffList) {
        if ([StaffRole.SUPERADMIN, StaffRole.OWNER].includes(staffWithRole.assignedRole)) {
          const pin = staffWithRole.assignedRole === StaffRole.SUPERADMIN && isFullVenue ? '0000' : faker.string.numeric(4)

          await prisma.staffVenue.create({
            data: {
              staffId: staffWithRole.id,
              venueId: venue.id,
              role: staffWithRole.assignedRole,
              active: true,
              pin,
            },
          })
          venueAssignments += 1

          if (!isFullVenue) {
            continue
          }

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
            let enabled = true
            let priority: NotificationPriority = NotificationPriority.NORMAL
            let channels: NotificationChannel[] = [NotificationChannel.IN_APP]

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
                enabled = false
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

      // Asignar staff específico del venue
      for (const staffWithRole of venueSpecificStaff) {
        const pin = faker.string.numeric(4)

        await prisma.staffVenue.create({
          data: {
            staffId: staffWithRole.id,
            venueId: venue.id,
            role: staffWithRole.assignedRole,
            active: true,
            pin,
          },
        })
        venueAssignments += 1

        if (!isFullVenue) {
          continue
        }

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
          let enabled = true
          let priority: NotificationPriority = NotificationPriority.NORMAL
          let channels: NotificationChannel[] = [NotificationChannel.IN_APP]

          if (staffWithRole.assignedRole === StaffRole.ADMIN) {
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
              enabled = false
            }
            if (type === NotificationType.NEW_ORDER || type === NotificationType.ORDER_READY) {
              priority = NotificationPriority.HIGH
            }
          } else if (staffWithRole.assignedRole === StaffRole.KITCHEN) {
            if (type === NotificationType.NEW_ORDER || type === NotificationType.ORDER_READY) {
              priority = NotificationPriority.HIGH
            }
          } else if (staffWithRole.assignedRole === StaffRole.CASHIER) {
            if (type === NotificationType.PAYMENT_RECEIVED) {
              priority = NotificationPriority.HIGH
            }
          } else if (staffWithRole.assignedRole === StaffRole.VIEWER) {
            // Viewer has minimal notifications
            if (
              type !== NotificationType.ANNOUNCEMENT &&
              type !== NotificationType.SHIFT_REMINDER &&
              type !== NotificationType.NEW_REVIEW
            ) {
              enabled = false
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

      if (isFullVenue) {
        console.log(
          `      - Assigned ${venueAssignments} staff to ${venue.name} (${createdStaffList.length} global + ${venueSpecificStaff.length} venue-specific) and created notification preferences.`,
        )
      } else {
        console.log(
          `      - Assigned ${venueAssignments} staff to ${venue.name} (${createdStaffList.length} global + ${venueSpecificStaff.length} venue-specific).`,
        )
      }

      await prisma.venueSettings.create({
        data: {
          venueId: venue.id,
          trackInventory: isFullVenue,
          allowReservations: isFullVenue,
          // Bad review notification settings
          notifyBadReviews: true,
          badReviewThreshold: 3, // Notify for ratings 1, 2, 3 (less than 4)
          badReviewAlertRoles: ['OWNER', 'ADMIN', 'MANAGER'],
        },
      })
      if (isFullVenue) {
        for (const feature of allFeatures) {
          await prisma.venueFeature.create({
            data: {
              venueId: venue.id,
              featureId: feature.id,
              monthlyPrice: feature.monthlyPrice,
            },
          })
        }
        console.log(`      - Created VenueSettings and assigned all Features.`)
      } else {
        console.log(`      - Created minimal VenueSettings for ${venue.name}.`)
      }

      // --- Payment Configuration for this Venue ---
      if (isFullVenue) {
        await prisma.venuePaymentConfig.create({
          data: {
            venueId: venue.id,
            primaryAccountId: blumonMerchantA.id,
            secondaryAccountId: blumonMerchantB.id,
            tertiaryAccountId: index === 0 ? stripeMerchant.id : null,
            routingRules: {
              factura: 'secondary',
              amount_over: 5000,
              customer_type: {
                business: 'secondary',
              },
              bin_routing: {
                '4111': 'secondary',
                '5555': 'tertiary',
              },
              time_based: {
                peak_hours: {
                  start: '18:00',
                  end: '22:00',
                  account: 'tertiary',
                },
              },
            },
          },
        })
      }

      // --- Venue Pricing Structures (what you charge venues) ---
      if (isFullVenue) {
        await prisma.venuePricingStructure.create({
          data: {
            venueId: venue.id,
            accountType: AccountType.PRIMARY,
            debitRate: 0.025, // 2.5% flat for all cards (Blumon A)
            creditRate: 0.025, // 2.5% flat for all cards
            amexRate: 0.025, // 2.5% flat for all cards
            internationalRate: 0.025, // 2.5% flat for all cards
            fixedFeePerTransaction: null, // No fixed fee
            monthlyServiceFee: null, // No monthly service fee
            active: true,
            effectiveFrom: new Date('2024-01-01'),
            contractReference: 'MENTA-2024-PRIMARY-RT01',
          },
        })
        await prisma.venuePricingStructure.create({
          data: {
            venueId: venue.id,
            accountType: AccountType.SECONDARY,
            debitRate: 0.06, // 6% flat for all cards (Blumon B)
            creditRate: 0.06, // 6% flat for all cards
            amexRate: 0.06, // 6% flat for all cards
            internationalRate: 0.06, // 6% flat for all cards
            fixedFeePerTransaction: 1.0, // 1 peso fixed fee per transaction
            monthlyServiceFee: null, // No monthly service fee
            active: true,
            effectiveFrom: new Date('2024-01-01'),
            contractReference: 'MENTA-2024-SECONDARY-RT01',
          },
        })
        console.log(`      - Created venue pricing structures.`)
      }

      // --- E-commerce Merchants (card-not-present channels) ---
      if (isFullVenue) {
        const ecommerceMerchantsData = [
          {
            channelName: 'Tienda Web (Menta)',
            businessName: `${venue.name} E-commerce`,
            rfc: 'XEXX010101000',
            contactEmail: `ecommerce@${venueSlug}.com`,
            contactPhone: '+52 55 1234 5678',
            website: `https://${venueSlug}.com`,
            providerId: mentaProvider.id,
            providerCredentials: {
              merchantId: 'demo-web-merchant-001',
              apiKey: 'demo_web_api_key_12345',
              apiSecret: 'demo_web_secret_67890',
              webhookSecret: 'demo_webhook_secret_abcde',
            },
            sandboxMode: true,
            active: true,
          },
          {
            channelName: 'App Móvil (Menta)',
            businessName: `${venue.name} Mobile App`,
            rfc: 'XEXX010101000',
            contactEmail: `app@${venueSlug}.com`,
            contactPhone: '+52 55 1234 5679',
            website: `https://app.${venueSlug}.com`,
            providerId: mentaProvider.id,
            providerCredentials: {
              merchantId: 'demo-app-merchant-002',
              apiKey: 'demo_app_api_key_54321',
              apiSecret: 'demo_app_secret_09876',
              webhookSecret: 'demo_webhook_secret_fghij',
            },
            sandboxMode: true,
            active: true,
          },
          {
            channelName: 'Tienda Web (Blumon)',
            businessName: `${venue.name} Blumon E-commerce`,
            rfc: 'XEXX010101000',
            contactEmail: `blumon@${venueSlug}.com`,
            contactPhone: '+52 55 1234 5680',
            website: `https://blumon.${venueSlug}.com`,
            providerId: blumonProvider.id,
            providerCredentials: {
              // OAuth tokens will be populated by blumon-authenticate-master.ts script
              merchantEmail: 'jose@avoqado.io',
              environment: 'SANDBOX',
              // accessToken, refreshToken, expiresAt will be added by auth script
            },
            sandboxMode: true,
            active: true,
          },
        ]

        let createdCount = 0
        let skippedCount = 0

        for (const merchantData of ecommerceMerchantsData) {
          // Check if Blumon merchant already exists with OAuth credentials (preserve it)
          const isBlumonMerchant = merchantData.providerId === blumonProvider.id
          if (isBlumonMerchant) {
            const existingBlumonMerchant = await prisma.ecommerceMerchant.findFirst({
              where: {
                venueId: venue.id,
                providerId: blumonProvider.id,
                channelName: merchantData.channelName,
              },
            })

            if (existingBlumonMerchant) {
              const credentials = existingBlumonMerchant.providerCredentials as any
              // Skip if it has OAuth tokens (already authenticated)
              if (credentials?.accessToken && credentials?.refreshToken) {
                console.log(`      ✅ Skipped "${merchantData.channelName}" (has OAuth credentials)`)
                skippedCount++
                continue
              }
            }
          }

          // Generate API keys for this merchant
          const { publicKey, secretKey, secretKeyHash } = generateAPIKeys(merchantData.sandboxMode)

          await prisma.ecommerceMerchant.create({
            data: {
              venueId: venue.id,
              channelName: merchantData.channelName,
              businessName: merchantData.businessName,
              rfc: merchantData.rfc,
              contactEmail: merchantData.contactEmail,
              contactPhone: merchantData.contactPhone,
              website: merchantData.website,
              providerId: merchantData.providerId,
              providerCredentials: merchantData.providerCredentials,
              publicKey,
              secretKeyHash,
              sandboxMode: merchantData.sandboxMode,
              active: merchantData.active,
            },
          })
          createdCount++
        }
        console.log(
          `      - Created ${createdCount} e-commerce merchants${skippedCount > 0 ? `, skipped ${skippedCount} (OAuth preserved)` : ''}.`,
        )

        // --- Sample Checkout Sessions (for testing SDK integration) ---
        // Get Blumon merchant for this venue
        const blumonMerchant = await prisma.ecommerceMerchant.findFirst({
          where: {
            venueId: venue.id,
            providerId: blumonProvider.id,
          },
        })

        if (blumonMerchant) {
          const now = new Date()
          const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
          const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000)

          const checkoutSessionsData = [
            {
              sessionId: `cs_test_pending_${Date.now()}_001`,
              amount: 299.0,
              description: 'Orden en línea #12345 - 2x Tacos al Pastor',
              customerEmail: 'cliente@example.com',
              customerName: 'María González',
              customerPhone: '+52 55 1234 5678',
              externalOrderId: 'order_12345',
              status: 'PENDING' as const,
              expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000), // 24 hours from now
              createdAt: now,
              metadata: {
                items: [{ name: 'Tacos al Pastor', quantity: 2, price: 149.5 }],
                source: 'web_store',
              },
            },
            {
              sessionId: `cs_test_completed_${Date.now()}_002`,
              amount: 450.0,
              description: 'Orden en línea #12344 - Combo Familiar',
              customerEmail: 'juan@example.com',
              customerName: 'Juan Pérez',
              customerPhone: '+52 55 9876 5432',
              externalOrderId: 'order_12344',
              status: 'COMPLETED' as const,
              blumonCheckoutId: `checkout_${Date.now()}_blumon`,
              blumonCheckoutUrl: 'https://sandbox-ecommerce.blumonpay.com/checkout/xxx',
              expiresAt: yesterday,
              completedAt: yesterday,
              createdAt: twoDaysAgo,
              metadata: {
                items: [{ name: 'Combo Familiar', quantity: 1, price: 450.0 }],
                source: 'mobile_app',
              },
            },
            {
              sessionId: `cs_test_failed_${Date.now()}_003`,
              amount: 199.0,
              description: 'Orden en línea #12343 - Burrito California',
              customerEmail: 'ana@example.com',
              customerName: 'Ana Martínez',
              externalOrderId: 'order_12343',
              status: 'FAILED' as const,
              blumonCheckoutId: `checkout_${Date.now()}_failed`,
              blumonCheckoutUrl: 'https://sandbox-ecommerce.blumonpay.com/checkout/yyy',
              errorMessage: 'La tarjeta fue rechazada',
              expiresAt: yesterday,
              failedAt: yesterday,
              createdAt: twoDaysAgo,
              metadata: {
                items: [{ name: 'Burrito California', quantity: 1, price: 199.0 }],
                source: 'web_store',
              },
            },
            {
              sessionId: `cs_test_expired_${Date.now()}_004`,
              amount: 350.0,
              description: 'Orden en línea #12342 - Quesadillas + Bebidas',
              customerEmail: 'carlos@example.com',
              externalOrderId: 'order_12342',
              status: 'EXPIRED' as const,
              expiresAt: twoDaysAgo,
              createdAt: new Date(twoDaysAgo.getTime() - 24 * 60 * 60 * 1000),
              metadata: {
                items: [
                  { name: 'Quesadillas', quantity: 3, price: 120.0 },
                  { name: 'Bebidas', quantity: 3, price: 30.0 },
                ],
                source: 'web_store',
              },
            },
            {
              sessionId: `cs_test_processing_${Date.now()}_005`,
              amount: 599.0,
              description: 'Orden en línea #12346 - Pedido Grande',
              customerEmail: 'sofia@example.com',
              customerName: 'Sofia Ramírez',
              customerPhone: '+52 55 2468 1357',
              externalOrderId: 'order_12346',
              status: 'PROCESSING' as const,
              blumonCheckoutId: `checkout_${Date.now()}_processing`,
              blumonCheckoutUrl: 'https://sandbox-ecommerce.blumonpay.com/checkout/zzz',
              expiresAt: new Date(now.getTime() + 12 * 60 * 60 * 1000), // 12 hours from now
              createdAt: new Date(now.getTime() - 30 * 60 * 1000), // 30 minutes ago
              metadata: {
                items: [{ name: 'Pedido Grande', quantity: 1, price: 599.0 }],
                source: 'mobile_app',
              },
            },
          ]

          for (const sessionData of checkoutSessionsData) {
            await prisma.checkoutSession.create({
              data: {
                ecommerceMerchantId: blumonMerchant.id,
                sessionId: sessionData.sessionId,
                amount: sessionData.amount,
                currency: 'MXN',
                description: sessionData.description,
                customerEmail: sessionData.customerEmail,
                customerName: sessionData.customerName,
                customerPhone: sessionData.customerPhone,
                externalOrderId: sessionData.externalOrderId,
                metadata: sessionData.metadata,
                blumonCheckoutId: sessionData.blumonCheckoutId,
                blumonCheckoutUrl: sessionData.blumonCheckoutUrl,
                status: sessionData.status,
                expiresAt: sessionData.expiresAt,
                completedAt: sessionData.completedAt,
                failedAt: sessionData.failedAt,
                errorMessage: sessionData.errorMessage,
                createdAt: sessionData.createdAt,
              },
            })
          }
          console.log(`      - Created ${checkoutSessionsData.length} sample checkout sessions.`)
        }
      }

      if (!isFullVenue) {
        console.log(`      - Skipping detailed seeding for ${venue.name} (empty sandbox).`)
        continue
      }

      // ✅ CREATE CUSTOMERS FOR THIS VENUE (Phase 1: Customer System)
      console.log(`      - Creating ${SEED_CONFIG.CUSTOMERS} customers for ${venue.name}...`)
      const customersData = []

      for (let i = 0; i < SEED_CONFIG.CUSTOMERS; i++) {
        const cohort = generateCustomerCohort(i, SEED_CONFIG.CUSTOMERS)
        const email = faker.internet.email()

        customersData.push({
          email,
          phone: faker.phone.number(),
          firstName: faker.person.firstName(),
          lastName: faker.person.lastName(),
          marketingConsent: Math.random() < 0.7, // 70% consent rate
          venueId: venue.id, // ✅ REQUIRED: Assign customer to this venue
        })

        // Store cohort info separately
        customerCohortMap.set(email, {
          type: cohort.type,
          joinedAt: faker.date.past({ years: cohort.type === 'new' ? 0.25 : cohort.type === 'regular' ? 1 : 2 }),
        })
      }

      await prisma.customer.createMany({ data: customersData })
      const customers = await prisma.customer.findMany({ where: { venueId: venue.id } })
      console.log(`      - Created ${customers.length} customers for ${venue.name}.`)

      const areaNames = ['Salon Principal', 'Terraza', 'Barra']
      const createdAreas = await Promise.all(
        areaNames.map(name =>
          prisma.area.create({
            data: {
              venueId: venue.id,
              name,
              description: `Area de ${name.toLowerCase()} del restaurante.`,
            },
          }),
        ),
      )
      console.log(`      - Created ${createdAreas.length} areas.`)

      // Create 13 tables with floor plan coordinates
      const tablesData = [
        // Area 1: Small tables (2-4 person)
        { number: 'M1', capacity: 2, positionX: 0.1, positionY: 0.2, shape: 'SQUARE', rotation: 0, status: 'AVAILABLE' },
        { number: 'M2', capacity: 2, positionX: 0.3, positionY: 0.2, shape: 'SQUARE', rotation: 0, status: 'AVAILABLE' },
        { number: 'M3', capacity: 4, positionX: 0.5, positionY: 0.2, shape: 'SQUARE', rotation: 0, status: 'AVAILABLE' },
        { number: 'M4', capacity: 4, positionX: 0.7, positionY: 0.2, shape: 'ROUND', rotation: 0, status: 'AVAILABLE' },

        // Area 2: Medium tables (4 person)
        { number: 'M5', capacity: 4, positionX: 0.1, positionY: 0.5, shape: 'SQUARE', rotation: 0, status: 'AVAILABLE' },
        { number: 'M6', capacity: 4, positionX: 0.3, positionY: 0.5, shape: 'ROUND', rotation: 0, status: 'AVAILABLE' },
        { number: 'M7', capacity: 4, positionX: 0.5, positionY: 0.5, shape: 'SQUARE', rotation: 0, status: 'AVAILABLE' },

        // Area 3: Large tables (6+ person)
        { number: 'M8', capacity: 6, positionX: 0.1, positionY: 0.8, shape: 'RECTANGLE', rotation: 0, status: 'AVAILABLE' },
        { number: 'M9', capacity: 6, positionX: 0.4, positionY: 0.8, shape: 'RECTANGLE', rotation: 90, status: 'AVAILABLE' },
        { number: 'M10', capacity: 8, positionX: 0.7, positionY: 0.8, shape: 'RECTANGLE', rotation: 0, status: 'AVAILABLE' },

        // Special/VIP area
        { number: 'M11', capacity: 4, positionX: 0.85, positionY: 0.5, shape: 'ROUND', rotation: 0, status: 'AVAILABLE' },
        { number: 'M12', capacity: 6, positionX: 0.85, positionY: 0.7, shape: 'RECTANGLE', rotation: 90, status: 'AVAILABLE' },
        { number: 'M13', capacity: 8, positionX: 0.85, positionY: 0.3, shape: 'RECTANGLE', rotation: 0, status: 'AVAILABLE' },
      ]

      const tables = await Promise.all(
        tablesData.map(tableData =>
          prisma.table.create({
            data: {
              venueId: venue.id,
              number: tableData.number,
              areaId: getRandomItem(createdAreas).id,
              capacity: tableData.capacity,
              qrCode: faker.string.uuid(),
              positionX: tableData.positionX,
              positionY: tableData.positionY,
              shape: tableData.shape as any,
              rotation: tableData.rotation,
              status: tableData.status as any,
            },
          }),
        ),
      )
      console.log(`      - Created ${tables.length} tables with floor plan coordinates.`)

      const terminals = await Promise.all(
        Array.from({ length: 3 }).map((_, t) => {
          const scenarios = [
            {
              status: TerminalStatus.ACTIVE,
              lastHeartbeat: new Date(Date.now() - 30 * 1000),
              version: '2.1.4',
              systemInfo: {
                platform: 'Android 13',
                memory: { total: 4096, free: 2048, used: 2048 },
                uptime: 86400,
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
              lastHeartbeat: new Date(Date.now() - 10 * 60 * 1000),
              version: '2.1.3',
              systemInfo: {
                platform: 'Android 12',
                memory: { total: 2048, free: 512, used: 1536 },
                uptime: 43200,
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
              lastHeartbeat: new Date(Date.now() - 5 * 60 * 1000),
              version: '2.0.8',
              systemInfo: {
                platform: 'Android 11',
                memory: { total: 1024, free: 128, used: 896 },
                uptime: 7200,
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
          const isPrimaryVenueTerminal = t === 0 && venue.name.includes('Avoqado Full')

          const serialNumber = isPrimaryVenueTerminal ? 'AVQD-2841548417' : faker.string.uuid()

          return prisma.terminal.create({
            data: {
              id: isPrimaryVenueTerminal ? 'cmhtgsr3100gi9k1we6pyr777' : undefined,
              venueId: venue.id,
              serialNumber,
              name: isPrimaryVenueTerminal ? 'TPV Desarrollo (Android)' : `TPV ${t + 1}`,
              type: TerminalType.TPV_ANDROID,
              // 🆕 Hardware information (Phase 2 - Multi-Merchant)
              brand: isPrimaryVenueTerminal ? 'PAX' : null,
              model: isPrimaryVenueTerminal ? 'A910S' : null,
              // 🆕 Assign both Blumon merchant accounts to primary terminal
              assignedMerchantIds: isPrimaryVenueTerminal ? [blumonMerchantA.id, blumonMerchantB.id] : [],
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

      // 🆕 Add secondary development terminal for Avoqado Full venue only
      if (venue.name.includes('Avoqado Full')) {
        const superAdmin = createdStaffList.find(s => s.assignedRole === StaffRole.SUPERADMIN)
        const secondaryTerminal = await prisma.terminal.create({
          data: {
            id: 'f71607dc-cade-402f-8af8-798ce6d1dc66',
            venueId: venue.id,
            serialNumber: 'AVQD-6d52cb5103bb42dc',
            name: 'Terminal 6d52cb',
            type: TerminalType.TPV_ANDROID,
            brand: 'PAX',
            model: 'A920 Pro',
            status: TerminalStatus.ACTIVE,
            assignedMerchantIds: [blumonMerchantA.id, blumonMerchantB.id],
            lastHeartbeat: new Date(Date.now() - 45 * 1000),
            version: '2.1.4',
            systemInfo: {
              platform: 'Android 12',
              memory: { total: 4096, free: 2560, used: 1536 },
              uptime: 172800,
              cpuUsage: 12.5,
              diskSpace: { total: 128000, free: 96000, used: 32000 },
              batteryLevel: 92,
              wifiSignal: -38,
              lastRestart: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
            },
            ipAddress: faker.internet.ipv4(),
            activatedAt: new Date('2025-11-10T22:36:26.335Z'),
            activatedBy: superAdmin?.id,
          },
        })
        console.log(`      - Created secondary terminal: ${secondaryTerminal.serialNumber}`)
      }

      // Category colors for visual distinction (Square/Toast pattern)
      const categoryColors: Record<string, string> = {
        Hamburguesas: '#FF5722', // Deep Orange
        'Tacos Mexicanos': '#4CAF50', // Green
        Pizzas: '#E91E63', // Pink
        Entradas: '#9C27B0', // Purple
        Bebidas: '#2196F3', // Blue
        Postres: '#FFEB3B', // Yellow
      }

      const categories = await Promise.all(
        ['Hamburguesas', 'Tacos Mexicanos', 'Pizzas', 'Entradas', 'Bebidas', 'Postres'].map((name, index) =>
          prisma.menuCategory.create({
            data: {
              venueId: venue.id,
              name,
              slug: generateSlug(name),
              displayOrder: index,
              color: categoryColors[name],
            },
          }),
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

      // Define realistic products for each category
      const realProductsData: Record<string, { name: string; price: number; description: string }[]> = {
        Hamburguesas: [
          { name: 'Hamburguesa Clásica', price: 129.0, description: 'Carne de res, queso cheddar, lechuga, tomate, cebolla y pepinillos' },
          { name: 'Hamburguesa BBQ', price: 149.0, description: 'Carne de res, tocino, queso, salsa BBQ y aros de cebolla' },
          { name: 'Hamburguesa Doble', price: 169.0, description: 'Doble carne, doble queso, lechuga y tomate' },
          { name: 'Hamburguesa de Pollo', price: 119.0, description: 'Pechuga de pollo, lechuga, mayonesa y tomate' },
        ],
        'Tacos Mexicanos': [
          { name: 'Tacos de Carne Asada', price: 89.0, description: 'Tres tacos de carne asada con cebolla, cilantro y salsa' },
          { name: 'Tacos al Pastor', price: 89.0, description: 'Tres tacos al pastor con piña, cebolla, cilantro y salsa' },
          { name: 'Tacos de Pollo', price: 79.0, description: 'Tres tacos de pollo con lechuga, crema y queso' },
          { name: 'Tacos de Pescado', price: 99.0, description: 'Tres tacos de pescado con col morada y mayonesa chipotle' },
        ],
        Pizzas: [
          { name: 'Pizza Pepperoni', price: 189.0, description: 'Salsa de tomate, mozzarella y pepperoni' },
          { name: 'Pizza Hawaiana', price: 179.0, description: 'Salsa de tomate, mozzarella, jamón y piña' },
          {
            name: 'Pizza Vegetariana',
            price: 169.0,
            description: 'Salsa de tomate, mozzarella, pimientos, cebolla, champiñones y aceitunas',
          },
          { name: 'Pizza 4 Quesos', price: 199.0, description: 'Salsa de tomate, mozzarella, parmesano, gorgonzola y manchego' },
        ],
        Entradas: [
          { name: 'Alitas Buffalo', price: 129.0, description: 'Alitas de pollo con salsa buffalo y aderezo ranch' },
          { name: 'Nachos con Queso', price: 89.0, description: 'Totopos con queso cheddar fundido, jalapeños y crema' },
          { name: 'Papas a la Francesa', price: 49.0, description: 'Papas fritas crujientes con ketchup' },
          { name: 'Aros de Cebolla', price: 69.0, description: 'Aros de cebolla empanizados con salsa ranch' },
        ],
        Bebidas: [
          { name: 'Coca-Cola 600ml', price: 25.0, description: 'Refresco de cola' },
          { name: 'Agua Mineral 1L', price: 20.0, description: 'Agua mineral natural' },
          { name: 'Cerveza Corona', price: 45.0, description: 'Cerveza clara mexicana' },
          { name: 'Limonada Natural', price: 35.0, description: 'Limonada fresca hecha en casa' },
          { name: 'Jugo de Naranja', price: 40.0, description: 'Jugo de naranja recién exprimido' },
          { name: 'Café Americano', price: 30.0, description: 'Café americano caliente' },
          { name: 'Té Helado', price: 30.0, description: 'Té negro helado con limón' },
        ],
        Postres: [
          { name: 'Pastel de Chocolate', price: 75.0, description: 'Pastel de chocolate con cobertura de ganache' },
          { name: 'Helado de Vainilla', price: 50.0, description: 'Tres bolas de helado de vainilla' },
          { name: 'Flan Napolitano', price: 65.0, description: 'Flan casero con caramelo' },
          { name: 'Churros con Chocolate', price: 70.0, description: 'Churros crujientes con chocolate caliente' },
          { name: 'Tarta de Queso', price: 80.0, description: 'Cheesecake clásico con fresas' },
          { name: 'Pay de Limón', price: 70.0, description: 'Pay de limón con merengue' },
        ],
      }

      // Helper function to determine inventory configuration for each product
      const getInventoryConfig = (categoryName: string, productName: string) => {
        // NO TRACKING: Simple products that don't need inventory
        const noTrackingProducts = ['Papas a la Francesa', 'Aros de Cebolla']
        if (noTrackingProducts.includes(productName)) {
          return { trackInventory: false, inventoryMethod: null }
        }

        // QUANTITY TRACKING: Bottled/packaged items that are counted as units
        const quantityProducts = ['Coca-Cola 600ml', 'Agua Mineral 1L', 'Cerveza Corona']
        if (quantityProducts.includes(productName)) {
          return { trackInventory: true, inventoryMethod: InventoryMethod.QUANTITY }
        }

        // RECIPE TRACKING: All other products (burgers, tacos, pizzas, appetizers with recipes, made drinks)
        // This includes: Hamburguesas, Tacos, Pizzas, Alitas Buffalo, Nachos, Limonada
        return { trackInventory: true, inventoryMethod: InventoryMethod.RECIPE }
      }

      const products = await Promise.all(
        categories.flatMap(category => {
          const categoryProducts = realProductsData[category.name] || []
          return categoryProducts.map((productData, index) => {
            const inventoryConfig = getInventoryConfig(category.name, productData.name)
            return prisma.product.create({
              data: {
                venueId: venue.id,
                name: productData.name,
                sku: `${category.slug.toUpperCase()}-${String(index + 1).padStart(3, '0')}`,
                categoryId: category.id,
                price: productData.price,
                description: productData.description,
                trackInventory: inventoryConfig.trackInventory,
                inventoryMethod: inventoryConfig.inventoryMethod,
                type: category.name === 'Bebidas' ? ProductType.BEVERAGE : ProductType.FOOD,
                tags: category.name === 'Bebidas' ? ['Bebida'] : ['Plato'],
                imageUrl: faker.image.urlLoremFlickr({ category: 'food' }),
              },
            })
          })
        }),
      )
      // Only create Inventory records for QUANTITY products
      const quantityProducts = products.filter(p => p.inventoryMethod === InventoryMethod.QUANTITY)
      await Promise.all(
        quantityProducts.map(async product => {
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

      const noTrackingCount = products.filter(p => !p.trackInventory).length
      const quantityCount = products.filter(p => p.inventoryMethod === InventoryMethod.QUANTITY).length
      const recipeCount = products.filter(p => p.inventoryMethod === InventoryMethod.RECIPE).length

      console.log(`      - Created ${products.length} products:`)
      console.log(`        * ${noTrackingCount} without inventory tracking`)
      console.log(`        * ${quantityCount} with QUANTITY tracking (Inventory table)`)
      console.log(`        * ${recipeCount} with RECIPE tracking (will have recipes created later)`)

      // ==========================================
      // CREATE PENDING ORDERS FOR OCCUPIED TABLES
      // ==========================================
      console.log(`      - Creating pending orders for occupied tables...`)

      // Get waiters for serving
      const staffVenues = await prisma.staffVenue.findMany({
        where: { venueId: venue.id, role: StaffRole.WAITER },
        include: { staff: true },
        take: 4,
      })

      // Create 3 pending orders on tables M1, M2, M3
      const tablesToOccupy = tables.slice(0, 3)
      const pendingOrdersData = [
        {
          table: tablesToOccupy[0],
          covers: 2,
          staffVenue: staffVenues[0],
          productNames: ['Hamburguesa Clásica', 'Coca-Cola 600ml', 'Papas a la Francesa'],
        },
        {
          table: tablesToOccupy[1],
          covers: 4,
          staffVenue: staffVenues[1],
          productNames: ['Pizza Pepperoni', 'Agua Mineral 1L', 'Agua Mineral 1L'],
        },
        {
          table: tablesToOccupy[2],
          covers: 3,
          staffVenue: staffVenues[2],
          productNames: ['Tacos al Pastor', 'Cerveza Corona', 'Nachos con Queso'],
        },
      ]

      for (const orderData of pendingOrdersData) {
        // Create order
        const order = await prisma.order.create({
          data: {
            venueId: venue.id,
            tableId: orderData.table.id,
            covers: orderData.covers,
            orderNumber: `ORD-${Math.floor(Math.random() * 10000)}`,
            servedById: orderData.staffVenue?.staffId,
            status: OrderStatus.PENDING,
            paymentStatus: PaymentStatus.PENDING,
            kitchenStatus: KitchenStatus.PENDING,
            subtotal: 0,
            discountAmount: 0,
            taxAmount: 0,
            total: 0,
            version: 1,
            createdAt: new Date(),
          },
        })

        // Add order items
        let orderTotal = 0
        for (const productName of orderData.productNames) {
          const product = products.find(p => p.name === productName)
          if (product) {
            const itemPrice = Number(product.price)
            await prisma.orderItem.create({
              data: {
                orderId: order.id,
                productId: product.id,
                quantity: 1,
                unitPrice: product.price,
                taxAmount: 0,
                total: product.price,
                notes: null,
              },
            })
            orderTotal += itemPrice
          }
        }

        // Update order totals
        await prisma.order.update({
          where: { id: order.id },
          data: {
            subtotal: orderTotal,
            total: orderTotal,
          },
        })

        // Update table status and link to order
        await prisma.table.update({
          where: { id: orderData.table.id },
          data: {
            status: 'OCCUPIED' as any,
            currentOrderId: order.id,
          },
        })

        // 👥 Add customers to pending orders (multi-customer demo)
        // First table: 1 customer, Second table: 2 customers, Third table: 3 customers
        const tableIndex = tablesToOccupy.indexOf(orderData.table)
        const customersToAdd = Math.min(tableIndex + 1, customers.length)

        for (let i = 0; i < customersToAdd; i++) {
          if (customers[i]) {
            await prisma.orderCustomer.create({
              data: {
                orderId: order.id,
                customerId: customers[i].id,
                isPrimary: i === 0, // First customer is primary
                addedAt: new Date(Date.now() + i * 1000),
              },
            })
          }
        }

        const customerCount = customersToAdd > 0 ? ` (${customersToAdd} customers)` : ''
        console.log(
          `        * Table ${orderData.table.number}: Order ${order.orderNumber} - ${orderData.covers} covers - $${orderTotal}${customerCount}`,
        )
      }

      // ==========================================
      // PAY LATER ORDER (Completed but unpaid)
      // ==========================================
      console.log('      - 💳 Creating pay-later order (completed but pending payment)...')

      // Create a completed order with pending payment (pay-later)
      const payLaterTotal = 250.0
      const payLaterOrder = await prisma.order.create({
        data: {
          venueId: venue.id,
          orderNumber: `PL-${Math.floor(Math.random() * 10000)}`,
          type: OrderType.DINE_IN,
          status: OrderStatus.COMPLETED, // ✅ Order is completed (food served)
          paymentStatus: PaymentStatus.PENDING, // ❌ Payment is pending
          kitchenStatus: KitchenStatus.SERVED, // Kitchen completed service
          subtotal: payLaterTotal,
          discountAmount: 0,
          taxAmount: 0,
          total: payLaterTotal,
          paidAmount: 0, // No payment yet
          remainingBalance: payLaterTotal, // Full amount outstanding
          version: 1,
          createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000), // 5 days ago (for aging report)
        },
      })

      // Add items to pay-later order
      const payLaterProducts = products.slice(0, 3) // First 3 products
      for (const product of payLaterProducts) {
        await prisma.orderItem.create({
          data: {
            orderId: payLaterOrder.id,
            productId: product.id,
            quantity: 1,
            unitPrice: product.price,
            taxAmount: 0,
            total: product.price,
          },
        })
      }

      // Associate customer to make it a pay-later order
      if (customers.length > 0) {
        await prisma.orderCustomer.create({
          data: {
            orderId: payLaterOrder.id,
            customerId: customers[0].id, // Primary customer
            isPrimary: true,
          },
        })
        console.log(
          `        * Pay-Later Order ${payLaterOrder.orderNumber}: $${payLaterTotal} - Customer: ${customers[0].firstName} ${customers[0].lastName} - 5 days overdue`,
        )
      }

      // ==========================================
      // INVENTORY MANAGEMENT SEEDING (Avoqado Full ONLY)
      // ==========================================
      if (venue.name === 'Avoqado Full') {
        console.log(`      - 🥑 Seeding comprehensive inventory data for ${venue.name}...`)

        // Enable INVENTORY_MANAGEMENT feature for Avoqado Full
        const inventoryFeature = allFeatures.find(f => f.code === 'INVENTORY_TRACKING')
        if (inventoryFeature) {
          const existingVenueFeature = await prisma.venueFeature.findFirst({
            where: { venueId: venue.id, featureId: inventoryFeature.id },
          })
          if (!existingVenueFeature) {
            await prisma.venueFeature.create({
              data: { venueId: venue.id, featureId: inventoryFeature.id, monthlyPrice: inventoryFeature.monthlyPrice },
            })
            console.log(`      - ✅ Enabled INVENTORY_TRACKING feature`)
          }
        }

        // Create comprehensive RawMaterials for burgers, tacos, pizzas, appetizers, and drinks
        const rawMaterialsData = [
          // ==================== MEAT ====================
          {
            name: 'Carne Molida de Res',
            sku: 'MEAT-BEEF-001',
            category: RawMaterialCategory.MEAT,
            currentStock: 50,
            unit: Unit.KILOGRAM,
            minimumStock: 10,
            reorderPoint: 15,
            maximumStock: 100,
            costPerUnit: 120.0,
            avgCostPerUnit: 120.0,
            perishable: true,
            shelfLifeDays: 3,
            description: 'Carne molida de res 80/20 para hamburguesas',
          },
          {
            name: 'Carne de Res para Asar',
            sku: 'MEAT-BEEF-002',
            category: RawMaterialCategory.MEAT,
            currentStock: 40,
            unit: Unit.KILOGRAM,
            minimumStock: 8,
            reorderPoint: 12,
            maximumStock: 80,
            costPerUnit: 150.0,
            avgCostPerUnit: 150.0,
            perishable: true,
            shelfLifeDays: 5,
            description: 'Carne de res para tacos de carne asada',
          },
          {
            name: 'Pechuga de Pollo',
            sku: 'MEAT-CHICKEN-001',
            category: RawMaterialCategory.MEAT,
            currentStock: 45,
            unit: Unit.KILOGRAM,
            minimumStock: 10,
            reorderPoint: 15,
            maximumStock: 90,
            costPerUnit: 85.0,
            avgCostPerUnit: 85.0,
            perishable: true,
            shelfLifeDays: 5,
            description: 'Pechuga de pollo sin hueso para hamburguesas y tacos',
          },
          {
            name: 'Alitas de Pollo',
            sku: 'MEAT-WINGS-001',
            category: RawMaterialCategory.MEAT,
            currentStock: 30,
            unit: Unit.KILOGRAM,
            minimumStock: 8,
            reorderPoint: 12,
            maximumStock: 60,
            costPerUnit: 75.0,
            avgCostPerUnit: 75.0,
            perishable: true,
            shelfLifeDays: 5,
            description: 'Alitas de pollo frescas para alitas buffalo',
          },
          {
            name: 'Carne de Cerdo Marinada',
            sku: 'MEAT-PORK-001',
            category: RawMaterialCategory.MEAT,
            currentStock: 35,
            unit: Unit.KILOGRAM,
            minimumStock: 7,
            reorderPoint: 10,
            maximumStock: 70,
            costPerUnit: 110.0,
            avgCostPerUnit: 110.0,
            perishable: true,
            shelfLifeDays: 3,
            description: 'Carne de cerdo marinada estilo al pastor',
          },
          {
            name: 'Tocino',
            sku: 'MEAT-BACON-001',
            category: RawMaterialCategory.MEAT,
            currentStock: 20,
            unit: Unit.KILOGRAM,
            minimumStock: 5,
            reorderPoint: 8,
            maximumStock: 40,
            costPerUnit: 180.0,
            avgCostPerUnit: 180.0,
            perishable: true,
            shelfLifeDays: 14,
            description: 'Tocino ahumado en rebanadas',
          },
          {
            name: 'Jamón',
            sku: 'MEAT-HAM-001',
            category: RawMaterialCategory.MEAT,
            currentStock: 15,
            unit: Unit.KILOGRAM,
            minimumStock: 4,
            reorderPoint: 6,
            maximumStock: 30,
            costPerUnit: 140.0,
            avgCostPerUnit: 140.0,
            perishable: true,
            shelfLifeDays: 14,
            description: 'Jamón de pavo para pizza hawaiana',
          },
          {
            name: 'Pepperoni',
            sku: 'MEAT-PEPP-001',
            category: RawMaterialCategory.MEAT,
            currentStock: 25,
            unit: Unit.KILOGRAM,
            minimumStock: 5,
            reorderPoint: 10,
            maximumStock: 50,
            costPerUnit: 200.0,
            avgCostPerUnit: 200.0,
            perishable: true,
            shelfLifeDays: 21,
            description: 'Pepperoni en rebanadas para pizza',
          },
          {
            name: 'Filete de Pescado',
            sku: 'MEAT-FISH-001',
            category: RawMaterialCategory.MEAT,
            currentStock: 20,
            unit: Unit.KILOGRAM,
            minimumStock: 5,
            reorderPoint: 8,
            maximumStock: 40,
            costPerUnit: 160.0,
            avgCostPerUnit: 160.0,
            perishable: true,
            shelfLifeDays: 2,
            description: 'Filete de pescado blanco para tacos',
          },
          // ==================== DAIRY ====================
          {
            name: 'Queso Cheddar',
            sku: 'DAIRY-CHEDDAR-001',
            category: RawMaterialCategory.DAIRY,
            currentStock: 30,
            unit: Unit.KILOGRAM,
            minimumStock: 8,
            reorderPoint: 12,
            maximumStock: 60,
            costPerUnit: 180.0,
            avgCostPerUnit: 180.0,
            perishable: true,
            shelfLifeDays: 30,
            description: 'Queso cheddar en rebanadas para hamburguesas y nachos',
          },
          {
            name: 'Queso Mozzarella',
            sku: 'DAIRY-MOZZ-001',
            category: RawMaterialCategory.DAIRY,
            currentStock: 40,
            unit: Unit.KILOGRAM,
            minimumStock: 10,
            reorderPoint: 15,
            maximumStock: 80,
            costPerUnit: 160.0,
            avgCostPerUnit: 160.0,
            perishable: true,
            shelfLifeDays: 21,
            description: 'Queso mozzarella para pizzas',
          },
          {
            name: 'Queso Manchego',
            sku: 'DAIRY-MANCH-001',
            category: RawMaterialCategory.DAIRY,
            currentStock: 20,
            unit: Unit.KILOGRAM,
            minimumStock: 5,
            reorderPoint: 8,
            maximumStock: 40,
            costPerUnit: 220.0,
            avgCostPerUnit: 220.0,
            perishable: true,
            shelfLifeDays: 30,
            description: 'Queso manchego rallado para tacos y pizza',
          },
          {
            name: 'Queso Parmesano',
            sku: 'DAIRY-PARM-001',
            category: RawMaterialCategory.DAIRY,
            currentStock: 15,
            unit: Unit.KILOGRAM,
            minimumStock: 3,
            reorderPoint: 5,
            maximumStock: 30,
            costPerUnit: 280.0,
            avgCostPerUnit: 280.0,
            perishable: true,
            shelfLifeDays: 60,
            description: 'Queso parmesano rallado para pizza 4 quesos',
          },
          {
            name: 'Queso Gorgonzola',
            sku: 'DAIRY-GORG-001',
            category: RawMaterialCategory.DAIRY,
            currentStock: 10,
            unit: Unit.KILOGRAM,
            minimumStock: 2,
            reorderPoint: 4,
            maximumStock: 20,
            costPerUnit: 320.0,
            avgCostPerUnit: 320.0,
            perishable: true,
            shelfLifeDays: 30,
            description: 'Queso gorgonzola para pizza 4 quesos',
          },
          {
            name: 'Crema Ácida',
            sku: 'DAIRY-CREAM-001',
            category: RawMaterialCategory.DAIRY,
            currentStock: 20,
            unit: Unit.LITER,
            minimumStock: 5,
            reorderPoint: 8,
            maximumStock: 40,
            costPerUnit: 45.0,
            avgCostPerUnit: 45.0,
            perishable: true,
            shelfLifeDays: 14,
            description: 'Crema ácida para tacos y nachos',
          },
          // ==================== VEGETABLES ====================
          {
            name: 'Lechuga Romana',
            sku: 'VEG-LETTUCE-001',
            category: RawMaterialCategory.VEGETABLES,
            currentStock: 25,
            unit: Unit.KILOGRAM,
            minimumStock: 5,
            reorderPoint: 10,
            maximumStock: 50,
            costPerUnit: 28.0,
            avgCostPerUnit: 28.0,
            perishable: true,
            shelfLifeDays: 5,
            description: 'Lechuga romana fresca para hamburguesas y tacos',
          },
          {
            name: 'Tomate Roma',
            sku: 'VEG-TOMATO-001',
            category: RawMaterialCategory.VEGETABLES,
            currentStock: 30,
            unit: Unit.KILOGRAM,
            minimumStock: 8,
            reorderPoint: 12,
            maximumStock: 60,
            costPerUnit: 18.5,
            avgCostPerUnit: 18.5,
            perishable: true,
            shelfLifeDays: 7,
            description: 'Tomate roma fresco para hamburguesas',
          },
          {
            name: 'Cebolla Blanca',
            sku: 'VEG-ONION-001',
            category: RawMaterialCategory.VEGETABLES,
            currentStock: 40,
            unit: Unit.KILOGRAM,
            minimumStock: 10,
            reorderPoint: 15,
            maximumStock: 80,
            costPerUnit: 22.0,
            avgCostPerUnit: 22.0,
            perishable: true,
            shelfLifeDays: 14,
            description: 'Cebolla blanca para hamburguesas, tacos y pizza',
          },
          {
            name: 'Pepinillos',
            sku: 'VEG-PICKLES-001',
            category: RawMaterialCategory.VEGETABLES,
            currentStock: 50,
            unit: Unit.UNIT,
            minimumStock: 10,
            reorderPoint: 20,
            maximumStock: 100,
            costPerUnit: 35.0,
            avgCostPerUnit: 35.0,
            perishable: true,
            shelfLifeDays: 180,
            description: 'Pepinillos en vinagre (frasco 500g)',
          },
          {
            name: 'Cilantro',
            sku: 'VEG-CILANTRO-001',
            category: RawMaterialCategory.VEGETABLES,
            currentStock: 5,
            unit: Unit.KILOGRAM,
            minimumStock: 1,
            reorderPoint: 2,
            maximumStock: 10,
            costPerUnit: 40.0,
            avgCostPerUnit: 40.0,
            perishable: true,
            shelfLifeDays: 7,
            description: 'Cilantro fresco para tacos',
          },
          {
            name: 'Col Morada',
            sku: 'VEG-CABBAGE-001',
            category: RawMaterialCategory.VEGETABLES,
            currentStock: 15,
            unit: Unit.KILOGRAM,
            minimumStock: 3,
            reorderPoint: 5,
            maximumStock: 30,
            costPerUnit: 15.0,
            avgCostPerUnit: 15.0,
            perishable: true,
            shelfLifeDays: 14,
            description: 'Col morada para tacos de pescado',
          },
          {
            name: 'Pimientos Morrones',
            sku: 'VEG-BELL-001',
            category: RawMaterialCategory.VEGETABLES,
            currentStock: 20,
            unit: Unit.KILOGRAM,
            minimumStock: 5,
            reorderPoint: 8,
            maximumStock: 40,
            costPerUnit: 35.0,
            avgCostPerUnit: 35.0,
            perishable: true,
            shelfLifeDays: 10,
            description: 'Pimientos morrones mixtos para pizza vegetariana',
          },
          {
            name: 'Champiñones',
            sku: 'VEG-MUSHROOM-001',
            category: RawMaterialCategory.VEGETABLES,
            currentStock: 12,
            unit: Unit.KILOGRAM,
            minimumStock: 3,
            reorderPoint: 5,
            maximumStock: 25,
            costPerUnit: 55.0,
            avgCostPerUnit: 55.0,
            perishable: true,
            shelfLifeDays: 7,
            description: 'Champiñones frescos para pizza',
          },
          {
            name: 'Aceitunas Negras',
            sku: 'VEG-OLIVES-001',
            category: RawMaterialCategory.VEGETABLES,
            currentStock: 30,
            unit: Unit.UNIT,
            minimumStock: 8,
            reorderPoint: 12,
            maximumStock: 60,
            costPerUnit: 45.0,
            avgCostPerUnit: 45.0,
            perishable: true,
            shelfLifeDays: 180,
            description: 'Aceitunas negras rebanadas (lata 400g)',
          },
          {
            name: 'Piña',
            sku: 'VEG-PINEAPPLE-001',
            category: RawMaterialCategory.VEGETABLES,
            currentStock: 25,
            unit: Unit.KILOGRAM,
            minimumStock: 5,
            reorderPoint: 10,
            maximumStock: 50,
            costPerUnit: 25.0,
            avgCostPerUnit: 25.0,
            perishable: true,
            shelfLifeDays: 5,
            description: 'Piña fresca para pizza hawaiana y tacos al pastor',
          },
          {
            name: 'Jalapeños',
            sku: 'VEG-JALAP-001',
            category: RawMaterialCategory.VEGETABLES,
            currentStock: 20,
            unit: Unit.UNIT,
            minimumStock: 5,
            reorderPoint: 10,
            maximumStock: 40,
            costPerUnit: 30.0,
            avgCostPerUnit: 30.0,
            perishable: true,
            shelfLifeDays: 90,
            description: 'Jalapeños en vinagre (frasco 500g) para nachos',
          },
          // ==================== GRAINS ====================
          {
            name: 'Pan de Hamburguesa',
            sku: 'GRAIN-BUN-001',
            category: RawMaterialCategory.GRAINS,
            currentStock: 200,
            unit: Unit.UNIT,
            minimumStock: 40,
            reorderPoint: 60,
            maximumStock: 400,
            costPerUnit: 8.0,
            avgCostPerUnit: 8.0,
            perishable: true,
            shelfLifeDays: 7,
            description: 'Pan para hamburguesa con ajonjolí',
          },
          {
            name: 'Tortillas de Maíz',
            sku: 'GRAIN-TORTILLA-001',
            category: RawMaterialCategory.GRAINS,
            currentStock: 500,
            unit: Unit.UNIT,
            minimumStock: 100,
            reorderPoint: 150,
            maximumStock: 1000,
            costPerUnit: 2.0,
            avgCostPerUnit: 2.0,
            perishable: true,
            shelfLifeDays: 10,
            description: 'Tortillas de maíz para tacos',
          },
          {
            name: 'Masa para Pizza',
            sku: 'GRAIN-DOUGH-001',
            category: RawMaterialCategory.GRAINS,
            currentStock: 30,
            unit: Unit.KILOGRAM,
            minimumStock: 8,
            reorderPoint: 12,
            maximumStock: 60,
            costPerUnit: 35.0,
            avgCostPerUnit: 35.0,
            perishable: true,
            shelfLifeDays: 3,
            description: 'Masa fresca para pizza',
          },
          {
            name: 'Papas',
            sku: 'GRAIN-POTATO-001',
            category: RawMaterialCategory.GRAINS,
            currentStock: 80,
            unit: Unit.KILOGRAM,
            minimumStock: 20,
            reorderPoint: 30,
            maximumStock: 150,
            costPerUnit: 15.0,
            avgCostPerUnit: 15.0,
            perishable: false,
            description: 'Papas para papas a la francesa',
          },
          {
            name: 'Totopos',
            sku: 'GRAIN-CHIPS-001',
            category: RawMaterialCategory.GRAINS,
            currentStock: 50,
            unit: Unit.UNIT,
            minimumStock: 10,
            reorderPoint: 20,
            maximumStock: 100,
            costPerUnit: 40.0,
            avgCostPerUnit: 40.0,
            perishable: false,
            description: 'Totopos de maíz (bolsa 1kg) para nachos',
          },
          // ==================== SAUCES ====================
          {
            name: 'Salsa BBQ',
            sku: 'SAUCE-BBQ-001',
            category: RawMaterialCategory.SAUCES,
            currentStock: 20,
            unit: Unit.LITER,
            minimumStock: 5,
            reorderPoint: 8,
            maximumStock: 40,
            costPerUnit: 85.0,
            avgCostPerUnit: 85.0,
            perishable: true,
            shelfLifeDays: 180,
            description: 'Salsa BBQ para hamburguesas',
          },
          {
            name: 'Mayonesa',
            sku: 'SAUCE-MAYO-001',
            category: RawMaterialCategory.SAUCES,
            currentStock: 25,
            unit: Unit.LITER,
            minimumStock: 5,
            reorderPoint: 10,
            maximumStock: 50,
            costPerUnit: 65.0,
            avgCostPerUnit: 65.0,
            perishable: true,
            shelfLifeDays: 120,
            description: 'Mayonesa para hamburguesas y tacos',
          },
          {
            name: 'Mayonesa Chipotle',
            sku: 'SAUCE-CHIPMAYO-001',
            category: RawMaterialCategory.SAUCES,
            currentStock: 15,
            unit: Unit.LITER,
            minimumStock: 3,
            reorderPoint: 5,
            maximumStock: 30,
            costPerUnit: 95.0,
            avgCostPerUnit: 95.0,
            perishable: true,
            shelfLifeDays: 120,
            description: 'Mayonesa chipotle para tacos de pescado',
          },
          {
            name: 'Salsa de Tomate',
            sku: 'SAUCE-TOMATO-001',
            category: RawMaterialCategory.SAUCES,
            currentStock: 30,
            unit: Unit.LITER,
            minimumStock: 8,
            reorderPoint: 12,
            maximumStock: 60,
            costPerUnit: 50.0,
            avgCostPerUnit: 50.0,
            perishable: true,
            shelfLifeDays: 180,
            description: 'Salsa de tomate para pizza',
          },
          {
            name: 'Salsa Verde',
            sku: 'SAUCE-GREEN-001',
            category: RawMaterialCategory.SAUCES,
            currentStock: 20,
            unit: Unit.LITER,
            minimumStock: 5,
            reorderPoint: 8,
            maximumStock: 40,
            costPerUnit: 70.0,
            avgCostPerUnit: 70.0,
            perishable: true,
            shelfLifeDays: 90,
            description: 'Salsa verde para tacos',
          },
          {
            name: 'Salsa Roja',
            sku: 'SAUCE-RED-001',
            category: RawMaterialCategory.SAUCES,
            currentStock: 20,
            unit: Unit.LITER,
            minimumStock: 5,
            reorderPoint: 8,
            maximumStock: 40,
            costPerUnit: 70.0,
            avgCostPerUnit: 70.0,
            perishable: true,
            shelfLifeDays: 90,
            description: 'Salsa roja picante para tacos',
          },
          {
            name: 'Salsa Buffalo',
            sku: 'SAUCE-BUFFALO-001',
            category: RawMaterialCategory.SAUCES,
            currentStock: 15,
            unit: Unit.LITER,
            minimumStock: 3,
            reorderPoint: 5,
            maximumStock: 30,
            costPerUnit: 95.0,
            avgCostPerUnit: 95.0,
            perishable: true,
            shelfLifeDays: 180,
            description: 'Salsa buffalo picante para alitas',
          },
          {
            name: 'Ketchup',
            sku: 'SAUCE-KETCHUP-001',
            category: RawMaterialCategory.SAUCES,
            currentStock: 25,
            unit: Unit.LITER,
            minimumStock: 5,
            reorderPoint: 10,
            maximumStock: 50,
            costPerUnit: 60.0,
            avgCostPerUnit: 60.0,
            perishable: true,
            shelfLifeDays: 180,
            description: 'Ketchup para papas',
          },
          {
            name: 'Mostaza',
            sku: 'SAUCE-MUSTARD-001',
            category: RawMaterialCategory.SAUCES,
            currentStock: 15,
            unit: Unit.LITER,
            minimumStock: 3,
            reorderPoint: 5,
            maximumStock: 30,
            costPerUnit: 55.0,
            avgCostPerUnit: 55.0,
            perishable: true,
            shelfLifeDays: 180,
            description: 'Mostaza amarilla para hamburguesas',
          },
          {
            name: 'Aderezo Ranch',
            sku: 'SAUCE-RANCH-001',
            category: RawMaterialCategory.SAUCES,
            currentStock: 18,
            unit: Unit.LITER,
            minimumStock: 4,
            reorderPoint: 6,
            maximumStock: 36,
            costPerUnit: 75.0,
            avgCostPerUnit: 75.0,
            perishable: true,
            shelfLifeDays: 120,
            description: 'Aderezo ranch para alitas y aros de cebolla',
          },
          // ==================== OILS ====================
          {
            name: 'Aceite Vegetal',
            sku: 'OIL-VEG-001',
            category: RawMaterialCategory.OILS,
            currentStock: 50,
            unit: Unit.LITER,
            minimumStock: 15,
            reorderPoint: 20,
            maximumStock: 100,
            costPerUnit: 32.0,
            avgCostPerUnit: 32.0,
            perishable: false,
            description: 'Aceite vegetal para freír',
          },
          // ==================== BEVERAGES ====================
          {
            name: 'Coca-Cola 600ml',
            sku: 'BEV-COCA-001',
            category: RawMaterialCategory.BEVERAGES,
            currentStock: 200,
            unit: Unit.UNIT,
            minimumStock: 50,
            reorderPoint: 80,
            maximumStock: 400,
            costPerUnit: 12.5,
            avgCostPerUnit: 12.5,
            perishable: true,
            shelfLifeDays: 180,
            description: 'Coca-Cola botella 600ml',
          },
          {
            name: 'Agua Mineral 1L',
            sku: 'BEV-AGUA-001',
            category: RawMaterialCategory.BEVERAGES,
            currentStock: 300,
            unit: Unit.UNIT,
            minimumStock: 80,
            reorderPoint: 120,
            maximumStock: 600,
            costPerUnit: 8.0,
            avgCostPerUnit: 8.0,
            perishable: false,
            description: 'Agua mineral embotellada 1L',
          },
          {
            name: 'Cerveza Corona 355ml',
            sku: 'BEV-CORONA-001',
            category: RawMaterialCategory.BEVERAGES,
            currentStock: 150,
            unit: Unit.UNIT,
            minimumStock: 40,
            reorderPoint: 60,
            maximumStock: 300,
            costPerUnit: 20.0,
            avgCostPerUnit: 20.0,
            perishable: true,
            shelfLifeDays: 365,
            description: 'Cerveza Corona clara 355ml',
          },
          {
            name: 'Limones',
            sku: 'BEV-LIME-001',
            category: RawMaterialCategory.BEVERAGES,
            currentStock: 10,
            unit: Unit.KILOGRAM,
            minimumStock: 2,
            reorderPoint: 4,
            maximumStock: 20,
            costPerUnit: 30.0,
            avgCostPerUnit: 30.0,
            perishable: true,
            shelfLifeDays: 14,
            description: 'Limones frescos para limonada y tacos',
          },
          {
            name: 'Azúcar',
            sku: 'BEV-SUGAR-001',
            category: RawMaterialCategory.BEVERAGES,
            currentStock: 40,
            unit: Unit.KILOGRAM,
            minimumStock: 10,
            reorderPoint: 15,
            maximumStock: 80,
            costPerUnit: 20.0,
            avgCostPerUnit: 20.0,
            perishable: false,
            description: 'Azúcar blanca para limonada',
          },
          // ==================== OTHER ====================
          {
            name: 'Aros de Cebolla Empanizados',
            sku: 'OTHER-ONIONRINGS-001',
            category: RawMaterialCategory.OTHER,
            currentStock: 30,
            unit: Unit.KILOGRAM,
            minimumStock: 8,
            reorderPoint: 12,
            maximumStock: 60,
            costPerUnit: 90.0,
            avgCostPerUnit: 90.0,
            perishable: true,
            shelfLifeDays: 180,
            description: 'Aros de cebolla empanizados congelados',
          },
        ]

        const createdRawMaterials: any[] = []
        for (const rmData of rawMaterialsData) {
          const rawMaterial = await prisma.rawMaterial.create({
            data: {
              ...rmData,
              venueId: venue.id,
              unitType: getUnitType(rmData.unit),
              active: true,
            },
          })

          // Create initial stock batch for each raw material
          const batch = await prisma.stockBatch.create({
            data: {
              rawMaterialId: rawMaterial.id,
              venueId: venue.id,
              batchNumber: `BATCH-${Date.now()}-${Math.random().toString(36).substring(7)}`,
              initialQuantity: rmData.currentStock,
              remainingQuantity: rmData.currentStock,
              unit: rmData.unit,
              costPerUnit: rmData.costPerUnit,
              receivedDate: faker.date.recent({ days: 15 }),
              expirationDate:
                rmData.perishable && rmData.shelfLifeDays ? new Date(Date.now() + rmData.shelfLifeDays * 24 * 60 * 60 * 1000) : null,
            },
          })

          // Create initial movement record
          await prisma.rawMaterialMovement.create({
            data: {
              rawMaterialId: rawMaterial.id,
              venueId: venue.id,
              batchId: batch.id,
              type: RawMaterialMovementType.PURCHASE,
              quantity: rmData.currentStock,
              unit: rmData.unit,
              previousStock: 0,
              newStock: rmData.currentStock,
              costImpact: rmData.costPerUnit * rmData.currentStock,
              reason: 'Stock inicial - Seed data',
              reference: `SEED-${Date.now()}`,
            },
          })

          createdRawMaterials.push(rawMaterial)
        }

        console.log(`      - ✅ Created ${createdRawMaterials.length} raw materials with stock batches`)

        // ==================== CREATE RECIPES ====================
        let recipeCount = 0

        // Helper function to find product by name
        const findProduct = (name: string) => products.find(p => p.name === name)
        const findRM = (sku: string) => createdRawMaterials.find(rm => rm.sku === sku)

        // ===== BEBIDAS =====
        // NOTE: Coca-Cola, Agua Mineral, and Cerveza use QUANTITY tracking (Inventory table)
        // They do NOT need recipes - only Limonada (made from ingredients) needs a recipe
        const limonadaProduct = findProduct('Limonada Natural')

        // ✅ FIX: Only create recipe if product uses RECIPE inventory method
        if (limonadaProduct && limonadaProduct.inventoryMethod === InventoryMethod.RECIPE) {
          const limones = findRM('BEV-LIME-001')
          const azucar = findRM('BEV-SUGAR-001')
          if (limones && azucar) {
            const recipe = await prisma.recipe.create({
              data: {
                productId: limonadaProduct.id,
                portionYield: 1,
                totalCost: 0,
                prepTime: 5,
                cookTime: 0,
                notes: 'Exprimir limones, mezclar con agua y azúcar, servir con hielo',
              },
            })
            await prisma.recipeLine.createMany({
              data: [
                { recipeId: recipe.id, rawMaterialId: limones.id, quantity: 0.15, unit: Unit.KILOGRAM, isOptional: false }, // ~3 limones
                { recipeId: recipe.id, rawMaterialId: azucar.id, quantity: 0.05, unit: Unit.KILOGRAM, isOptional: false }, // 50g azúcar
              ],
            })
            recipeCount++
          }
        }

        // ===== HAMBURGUESAS =====
        const hamburguesaClasica = findProduct('Hamburguesa Clásica')
        if (hamburguesaClasica && hamburguesaClasica.inventoryMethod === InventoryMethod.RECIPE) {
          const recipe = await prisma.recipe.create({
            data: {
              productId: hamburguesaClasica.id,
              portionYield: 1,
              totalCost: 0,
              prepTime: 10,
              cookTime: 12,
              notes: 'Cocinar la carne en plancha a fuego medio-alto por 6 min por lado. Armar la hamburguesa con los ingredientes.',
            },
          })
          await prisma.recipeLine.createMany({
            data: [
              { recipeId: recipe.id, rawMaterialId: findRM('GRAIN-BUN-001')!.id, quantity: 1, unit: Unit.UNIT, isOptional: false },
              { recipeId: recipe.id, rawMaterialId: findRM('MEAT-BEEF-001')!.id, quantity: 0.15, unit: Unit.KILOGRAM, isOptional: false }, // 150g beef patty
              {
                recipeId: recipe.id,
                rawMaterialId: findRM('DAIRY-CHEDDAR-001')!.id,
                quantity: 0.03,
                unit: Unit.KILOGRAM,
                isOptional: false,
              }, // 30g cheese
              { recipeId: recipe.id, rawMaterialId: findRM('VEG-LETTUCE-001')!.id, quantity: 0.02, unit: Unit.KILOGRAM, isOptional: false }, // 20g lettuce
              { recipeId: recipe.id, rawMaterialId: findRM('VEG-TOMATO-001')!.id, quantity: 0.05, unit: Unit.KILOGRAM, isOptional: false }, // 50g tomato (2 slices)
              { recipeId: recipe.id, rawMaterialId: findRM('VEG-ONION-001')!.id, quantity: 0.02, unit: Unit.KILOGRAM, isOptional: false }, // 20g onion
              { recipeId: recipe.id, rawMaterialId: findRM('VEG-PICKLES-001')!.id, quantity: 0.01, unit: Unit.UNIT, isOptional: false }, // few pickles
              { recipeId: recipe.id, rawMaterialId: findRM('SAUCE-MAYO-001')!.id, quantity: 0.015, unit: Unit.LITER, isOptional: false }, // 15ml mayo
              { recipeId: recipe.id, rawMaterialId: findRM('SAUCE-KETCHUP-001')!.id, quantity: 0.015, unit: Unit.LITER, isOptional: false }, // 15ml ketchup
              { recipeId: recipe.id, rawMaterialId: findRM('SAUCE-MUSTARD-001')!.id, quantity: 0.01, unit: Unit.LITER, isOptional: false }, // 10ml mustard
            ],
          })
          recipeCount++
        }

        const hamburguesaBBQ = findProduct('Hamburguesa BBQ')
        if (hamburguesaBBQ && hamburguesaBBQ.inventoryMethod === InventoryMethod.RECIPE) {
          const recipe = await prisma.recipe.create({
            data: {
              productId: hamburguesaBBQ.id,
              portionYield: 1,
              totalCost: 0,
              prepTime: 12,
              cookTime: 15,
              notes: 'Cocinar la carne y el tocino. Armar con salsa BBQ y aros de cebolla.',
            },
          })
          await prisma.recipeLine.createMany({
            data: [
              { recipeId: recipe.id, rawMaterialId: findRM('GRAIN-BUN-001')!.id, quantity: 1, unit: Unit.UNIT, isOptional: false },
              { recipeId: recipe.id, rawMaterialId: findRM('MEAT-BEEF-001')!.id, quantity: 0.15, unit: Unit.KILOGRAM, isOptional: false },
              { recipeId: recipe.id, rawMaterialId: findRM('MEAT-BACON-001')!.id, quantity: 0.04, unit: Unit.KILOGRAM, isOptional: false }, // 40g bacon (2 strips)
              {
                recipeId: recipe.id,
                rawMaterialId: findRM('DAIRY-CHEDDAR-001')!.id,
                quantity: 0.03,
                unit: Unit.KILOGRAM,
                isOptional: false,
              },
              { recipeId: recipe.id, rawMaterialId: findRM('SAUCE-BBQ-001')!.id, quantity: 0.03, unit: Unit.LITER, isOptional: false }, // 30ml BBQ sauce
              {
                recipeId: recipe.id,
                rawMaterialId: findRM('OTHER-ONIONRINGS-001')!.id,
                quantity: 0.05,
                unit: Unit.KILOGRAM,
                isOptional: false,
              }, // 50g onion rings
            ],
          })
          recipeCount++
        }

        const hamburguesaDoble = findProduct('Hamburguesa Doble')
        if (hamburguesaDoble && hamburguesaDoble.inventoryMethod === InventoryMethod.RECIPE) {
          const recipe = await prisma.recipe.create({
            data: {
              productId: hamburguesaDoble.id,
              portionYield: 1,
              totalCost: 0,
              prepTime: 10,
              cookTime: 15,
              notes: 'Dos carnes de 150g, doble queso. Armar como hamburguesa clásica.',
            },
          })
          await prisma.recipeLine.createMany({
            data: [
              { recipeId: recipe.id, rawMaterialId: findRM('GRAIN-BUN-001')!.id, quantity: 1, unit: Unit.UNIT, isOptional: false },
              { recipeId: recipe.id, rawMaterialId: findRM('MEAT-BEEF-001')!.id, quantity: 0.3, unit: Unit.KILOGRAM, isOptional: false }, // 300g (2x150g)
              {
                recipeId: recipe.id,
                rawMaterialId: findRM('DAIRY-CHEDDAR-001')!.id,
                quantity: 0.06,
                unit: Unit.KILOGRAM,
                isOptional: false,
              }, // 60g cheese (2 slices)
              { recipeId: recipe.id, rawMaterialId: findRM('VEG-LETTUCE-001')!.id, quantity: 0.02, unit: Unit.KILOGRAM, isOptional: false },
              { recipeId: recipe.id, rawMaterialId: findRM('VEG-TOMATO-001')!.id, quantity: 0.05, unit: Unit.KILOGRAM, isOptional: false },
              { recipeId: recipe.id, rawMaterialId: findRM('SAUCE-MAYO-001')!.id, quantity: 0.015, unit: Unit.LITER, isOptional: false },
              { recipeId: recipe.id, rawMaterialId: findRM('SAUCE-KETCHUP-001')!.id, quantity: 0.015, unit: Unit.LITER, isOptional: false },
            ],
          })
          recipeCount++
        }

        const hamburguesaPollo = findProduct('Hamburguesa de Pollo')
        if (hamburguesaPollo && hamburguesaPollo.inventoryMethod === InventoryMethod.RECIPE) {
          const recipe = await prisma.recipe.create({
            data: {
              productId: hamburguesaPollo.id,
              portionYield: 1,
              totalCost: 0,
              prepTime: 10,
              cookTime: 12,
              notes: 'Cocinar la pechuga de pollo a la plancha. Armar con mayonesa.',
            },
          })
          await prisma.recipeLine.createMany({
            data: [
              { recipeId: recipe.id, rawMaterialId: findRM('GRAIN-BUN-001')!.id, quantity: 1, unit: Unit.UNIT, isOptional: false },
              {
                recipeId: recipe.id,
                rawMaterialId: findRM('MEAT-CHICKEN-001')!.id,
                quantity: 0.15,
                unit: Unit.KILOGRAM,
                isOptional: false,
              }, // 150g chicken breast
              { recipeId: recipe.id, rawMaterialId: findRM('VEG-LETTUCE-001')!.id, quantity: 0.02, unit: Unit.KILOGRAM, isOptional: false },
              { recipeId: recipe.id, rawMaterialId: findRM('VEG-TOMATO-001')!.id, quantity: 0.05, unit: Unit.KILOGRAM, isOptional: false },
              { recipeId: recipe.id, rawMaterialId: findRM('SAUCE-MAYO-001')!.id, quantity: 0.02, unit: Unit.LITER, isOptional: false }, // 20ml mayo
            ],
          })
          recipeCount++
        }

        // ===== TACOS MEXICANOS =====
        const tacosCarneAsada = findProduct('Tacos de Carne Asada')
        if (tacosCarneAsada && tacosCarneAsada.inventoryMethod === InventoryMethod.RECIPE) {
          const recipe = await prisma.recipe.create({
            data: {
              productId: tacosCarneAsada.id,
              portionYield: 3,
              totalCost: 0,
              prepTime: 10,
              cookTime: 8,
              notes: 'Cocinar la carne a la parrilla. Servir en 3 tortillas con cebolla y cilantro picado.',
            },
          })
          await prisma.recipeLine.createMany({
            data: [
              { recipeId: recipe.id, rawMaterialId: findRM('GRAIN-TORTILLA-001')!.id, quantity: 3, unit: Unit.UNIT, isOptional: false },
              { recipeId: recipe.id, rawMaterialId: findRM('MEAT-BEEF-002')!.id, quantity: 0.15, unit: Unit.KILOGRAM, isOptional: false }, // 150g beef
              { recipeId: recipe.id, rawMaterialId: findRM('VEG-ONION-001')!.id, quantity: 0.03, unit: Unit.KILOGRAM, isOptional: false }, // 30g onion
              {
                recipeId: recipe.id,
                rawMaterialId: findRM('VEG-CILANTRO-001')!.id,
                quantity: 0.01,
                unit: Unit.KILOGRAM,
                isOptional: false,
              }, // 10g cilantro
              { recipeId: recipe.id, rawMaterialId: findRM('BEV-LIME-001')!.id, quantity: 0.02, unit: Unit.KILOGRAM, isOptional: false }, // 1 lime
              { recipeId: recipe.id, rawMaterialId: findRM('SAUCE-GREEN-001')!.id, quantity: 0.03, unit: Unit.LITER, isOptional: false }, // 30ml salsa
            ],
          })
          recipeCount++
        }

        const tacosAlPastor = findProduct('Tacos al Pastor')
        if (tacosAlPastor && tacosAlPastor.inventoryMethod === InventoryMethod.RECIPE) {
          const recipe = await prisma.recipe.create({
            data: {
              productId: tacosAlPastor.id,
              portionYield: 3,
              totalCost: 0,
              prepTime: 10,
              cookTime: 10,
              notes: 'Cocinar la carne al pastor con piña. Servir en 3 tortillas con cebolla y cilantro.',
            },
          })
          await prisma.recipeLine.createMany({
            data: [
              { recipeId: recipe.id, rawMaterialId: findRM('GRAIN-TORTILLA-001')!.id, quantity: 3, unit: Unit.UNIT, isOptional: false },
              { recipeId: recipe.id, rawMaterialId: findRM('MEAT-PORK-001')!.id, quantity: 0.15, unit: Unit.KILOGRAM, isOptional: false }, // 150g pork
              {
                recipeId: recipe.id,
                rawMaterialId: findRM('VEG-PINEAPPLE-001')!.id,
                quantity: 0.05,
                unit: Unit.KILOGRAM,
                isOptional: false,
              }, // 50g pineapple
              { recipeId: recipe.id, rawMaterialId: findRM('VEG-ONION-001')!.id, quantity: 0.03, unit: Unit.KILOGRAM, isOptional: false },
              {
                recipeId: recipe.id,
                rawMaterialId: findRM('VEG-CILANTRO-001')!.id,
                quantity: 0.01,
                unit: Unit.KILOGRAM,
                isOptional: false,
              },
              { recipeId: recipe.id, rawMaterialId: findRM('SAUCE-RED-001')!.id, quantity: 0.03, unit: Unit.LITER, isOptional: false },
            ],
          })
          recipeCount++
        }

        const tacosPollo = findProduct('Tacos de Pollo')
        if (tacosPollo && tacosPollo.inventoryMethod === InventoryMethod.RECIPE) {
          const recipe = await prisma.recipe.create({
            data: {
              productId: tacosPollo.id,
              portionYield: 3,
              totalCost: 0,
              prepTime: 10,
              cookTime: 12,
              notes: 'Cocinar pollo desmenuzado. Servir en 3 tortillas con lechuga, crema y queso.',
            },
          })
          await prisma.recipeLine.createMany({
            data: [
              { recipeId: recipe.id, rawMaterialId: findRM('GRAIN-TORTILLA-001')!.id, quantity: 3, unit: Unit.UNIT, isOptional: false },
              {
                recipeId: recipe.id,
                rawMaterialId: findRM('MEAT-CHICKEN-001')!.id,
                quantity: 0.15,
                unit: Unit.KILOGRAM,
                isOptional: false,
              },
              { recipeId: recipe.id, rawMaterialId: findRM('VEG-LETTUCE-001')!.id, quantity: 0.03, unit: Unit.KILOGRAM, isOptional: false },
              { recipeId: recipe.id, rawMaterialId: findRM('DAIRY-CREAM-001')!.id, quantity: 0.03, unit: Unit.LITER, isOptional: false }, // 30ml cream
              { recipeId: recipe.id, rawMaterialId: findRM('DAIRY-MANCH-001')!.id, quantity: 0.03, unit: Unit.KILOGRAM, isOptional: false }, // 30g cheese
            ],
          })
          recipeCount++
        }

        const tacosPescado = findProduct('Tacos de Pescado')
        if (tacosPescado && tacosPescado.inventoryMethod === InventoryMethod.RECIPE) {
          const recipe = await prisma.recipe.create({
            data: {
              productId: tacosPescado.id,
              portionYield: 3,
              totalCost: 0,
              prepTime: 10,
              cookTime: 8,
              notes: 'Freír el pescado empanizado. Servir en 3 tortillas con col morada y mayonesa chipotle.',
            },
          })
          await prisma.recipeLine.createMany({
            data: [
              { recipeId: recipe.id, rawMaterialId: findRM('GRAIN-TORTILLA-001')!.id, quantity: 3, unit: Unit.UNIT, isOptional: false },
              { recipeId: recipe.id, rawMaterialId: findRM('MEAT-FISH-001')!.id, quantity: 0.15, unit: Unit.KILOGRAM, isOptional: false }, // 150g fish
              { recipeId: recipe.id, rawMaterialId: findRM('VEG-CABBAGE-001')!.id, quantity: 0.05, unit: Unit.KILOGRAM, isOptional: false }, // 50g cabbage
              { recipeId: recipe.id, rawMaterialId: findRM('SAUCE-CHIPMAYO-001')!.id, quantity: 0.03, unit: Unit.LITER, isOptional: false }, // 30ml chipotle mayo
              { recipeId: recipe.id, rawMaterialId: findRM('BEV-LIME-001')!.id, quantity: 0.02, unit: Unit.KILOGRAM, isOptional: false }, // 1 lime
              { recipeId: recipe.id, rawMaterialId: findRM('OIL-VEG-001')!.id, quantity: 0.05, unit: Unit.LITER, isOptional: false }, // 50ml oil for frying
            ],
          })
          recipeCount++
        }

        // ===== PIZZAS =====
        const pizzaPepperoni = findProduct('Pizza Pepperoni')
        if (pizzaPepperoni && pizzaPepperoni.inventoryMethod === InventoryMethod.RECIPE) {
          const recipe = await prisma.recipe.create({
            data: {
              productId: pizzaPepperoni.id,
              portionYield: 1,
              totalCost: 0,
              prepTime: 15,
              cookTime: 18,
              notes: 'Estirar la masa, agregar salsa y queso mozzarella, cubrir con pepperoni. Hornear a 220°C por 18 min.',
            },
          })
          await prisma.recipeLine.createMany({
            data: [
              { recipeId: recipe.id, rawMaterialId: findRM('GRAIN-DOUGH-001')!.id, quantity: 0.3, unit: Unit.KILOGRAM, isOptional: false }, // 300g dough
              { recipeId: recipe.id, rawMaterialId: findRM('SAUCE-TOMATO-001')!.id, quantity: 0.08, unit: Unit.LITER, isOptional: false }, // 80ml sauce
              { recipeId: recipe.id, rawMaterialId: findRM('DAIRY-MOZZ-001')!.id, quantity: 0.2, unit: Unit.KILOGRAM, isOptional: false }, // 200g mozzarella
              { recipeId: recipe.id, rawMaterialId: findRM('MEAT-PEPP-001')!.id, quantity: 0.08, unit: Unit.KILOGRAM, isOptional: false }, // 80g pepperoni
            ],
          })
          recipeCount++
        }

        const pizzaHawaiana = findProduct('Pizza Hawaiana')
        if (pizzaHawaiana && pizzaHawaiana.inventoryMethod === InventoryMethod.RECIPE) {
          const recipe = await prisma.recipe.create({
            data: {
              productId: pizzaHawaiana.id,
              portionYield: 1,
              totalCost: 0,
              prepTime: 15,
              cookTime: 18,
              notes: 'Masa con salsa, mozzarella, jamón y piña. Hornear a 220°C por 18 min.',
            },
          })
          await prisma.recipeLine.createMany({
            data: [
              { recipeId: recipe.id, rawMaterialId: findRM('GRAIN-DOUGH-001')!.id, quantity: 0.3, unit: Unit.KILOGRAM, isOptional: false },
              { recipeId: recipe.id, rawMaterialId: findRM('SAUCE-TOMATO-001')!.id, quantity: 0.08, unit: Unit.LITER, isOptional: false },
              { recipeId: recipe.id, rawMaterialId: findRM('DAIRY-MOZZ-001')!.id, quantity: 0.2, unit: Unit.KILOGRAM, isOptional: false },
              { recipeId: recipe.id, rawMaterialId: findRM('MEAT-HAM-001')!.id, quantity: 0.1, unit: Unit.KILOGRAM, isOptional: false }, // 100g ham
              {
                recipeId: recipe.id,
                rawMaterialId: findRM('VEG-PINEAPPLE-001')!.id,
                quantity: 0.15,
                unit: Unit.KILOGRAM,
                isOptional: false,
              }, // 150g pineapple
            ],
          })
          recipeCount++
        }

        const pizzaVegetariana = findProduct('Pizza Vegetariana')
        if (pizzaVegetariana && pizzaVegetariana.inventoryMethod === InventoryMethod.RECIPE) {
          const recipe = await prisma.recipe.create({
            data: {
              productId: pizzaVegetariana.id,
              portionYield: 1,
              totalCost: 0,
              prepTime: 20,
              cookTime: 18,
              notes: 'Masa con salsa, mozzarella y vegetales variados. Hornear a 220°C por 18 min.',
            },
          })
          await prisma.recipeLine.createMany({
            data: [
              { recipeId: recipe.id, rawMaterialId: findRM('GRAIN-DOUGH-001')!.id, quantity: 0.3, unit: Unit.KILOGRAM, isOptional: false },
              { recipeId: recipe.id, rawMaterialId: findRM('SAUCE-TOMATO-001')!.id, quantity: 0.08, unit: Unit.LITER, isOptional: false },
              { recipeId: recipe.id, rawMaterialId: findRM('DAIRY-MOZZ-001')!.id, quantity: 0.2, unit: Unit.KILOGRAM, isOptional: false },
              { recipeId: recipe.id, rawMaterialId: findRM('VEG-BELL-001')!.id, quantity: 0.08, unit: Unit.KILOGRAM, isOptional: false }, // 80g bell peppers
              { recipeId: recipe.id, rawMaterialId: findRM('VEG-ONION-001')!.id, quantity: 0.06, unit: Unit.KILOGRAM, isOptional: false }, // 60g onion
              {
                recipeId: recipe.id,
                rawMaterialId: findRM('VEG-MUSHROOM-001')!.id,
                quantity: 0.08,
                unit: Unit.KILOGRAM,
                isOptional: false,
              }, // 80g mushrooms
              { recipeId: recipe.id, rawMaterialId: findRM('VEG-OLIVES-001')!.id, quantity: 0.03, unit: Unit.UNIT, isOptional: false }, // ~30g olives
            ],
          })
          recipeCount++
        }

        const pizza4Quesos = findProduct('Pizza 4 Quesos')
        if (pizza4Quesos && pizza4Quesos.inventoryMethod === InventoryMethod.RECIPE) {
          const recipe = await prisma.recipe.create({
            data: {
              productId: pizza4Quesos.id,
              portionYield: 1,
              totalCost: 0,
              prepTime: 15,
              cookTime: 18,
              notes: 'Masa con salsa y cuatro tipos de queso. Hornear a 220°C por 18 min.',
            },
          })
          await prisma.recipeLine.createMany({
            data: [
              { recipeId: recipe.id, rawMaterialId: findRM('GRAIN-DOUGH-001')!.id, quantity: 0.3, unit: Unit.KILOGRAM, isOptional: false },
              { recipeId: recipe.id, rawMaterialId: findRM('SAUCE-TOMATO-001')!.id, quantity: 0.08, unit: Unit.LITER, isOptional: false },
              { recipeId: recipe.id, rawMaterialId: findRM('DAIRY-MOZZ-001')!.id, quantity: 0.12, unit: Unit.KILOGRAM, isOptional: false }, // 120g mozzarella
              { recipeId: recipe.id, rawMaterialId: findRM('DAIRY-PARM-001')!.id, quantity: 0.05, unit: Unit.KILOGRAM, isOptional: false }, // 50g parmesan
              { recipeId: recipe.id, rawMaterialId: findRM('DAIRY-GORG-001')!.id, quantity: 0.05, unit: Unit.KILOGRAM, isOptional: false }, // 50g gorgonzola
              { recipeId: recipe.id, rawMaterialId: findRM('DAIRY-MANCH-001')!.id, quantity: 0.05, unit: Unit.KILOGRAM, isOptional: false }, // 50g manchego
            ],
          })
          recipeCount++
        }

        // ===== ENTRADAS =====
        const alitasBuffalo = findProduct('Alitas Buffalo')
        if (alitasBuffalo && alitasBuffalo.inventoryMethod === InventoryMethod.RECIPE) {
          const recipe = await prisma.recipe.create({
            data: {
              productId: alitasBuffalo.id,
              portionYield: 1,
              totalCost: 0,
              prepTime: 10,
              cookTime: 20,
              notes: 'Freír las alitas hasta que estén crujientes. Bañar con salsa buffalo y servir con aderezo ranch.',
            },
          })
          await prisma.recipeLine.createMany({
            data: [
              { recipeId: recipe.id, rawMaterialId: findRM('MEAT-WINGS-001')!.id, quantity: 0.3, unit: Unit.KILOGRAM, isOptional: false }, // 300g wings (~6 pieces)
              { recipeId: recipe.id, rawMaterialId: findRM('SAUCE-BUFFALO-001')!.id, quantity: 0.05, unit: Unit.LITER, isOptional: false }, // 50ml buffalo sauce
              { recipeId: recipe.id, rawMaterialId: findRM('SAUCE-RANCH-001')!.id, quantity: 0.03, unit: Unit.LITER, isOptional: false }, // 30ml ranch
              { recipeId: recipe.id, rawMaterialId: findRM('OIL-VEG-001')!.id, quantity: 0.1, unit: Unit.LITER, isOptional: false }, // 100ml oil for frying
            ],
          })
          recipeCount++
        }

        const nachosQueso = findProduct('Nachos con Queso')
        if (nachosQueso && nachosQueso.inventoryMethod === InventoryMethod.RECIPE) {
          const recipe = await prisma.recipe.create({
            data: {
              productId: nachosQueso.id,
              portionYield: 1,
              totalCost: 0,
              prepTime: 5,
              cookTime: 5,
              notes: 'Calentar totopos en horno. Derretir queso cheddar y servir con jalapeños y crema.',
            },
          })
          await prisma.recipeLine.createMany({
            data: [
              { recipeId: recipe.id, rawMaterialId: findRM('GRAIN-CHIPS-001')!.id, quantity: 0.15, unit: Unit.UNIT, isOptional: false }, // 150g chips
              {
                recipeId: recipe.id,
                rawMaterialId: findRM('DAIRY-CHEDDAR-001')!.id,
                quantity: 0.1,
                unit: Unit.KILOGRAM,
                isOptional: false,
              }, // 100g cheese
              { recipeId: recipe.id, rawMaterialId: findRM('VEG-JALAP-001')!.id, quantity: 0.02, unit: Unit.UNIT, isOptional: false }, // jalapeños
              { recipeId: recipe.id, rawMaterialId: findRM('DAIRY-CREAM-001')!.id, quantity: 0.03, unit: Unit.LITER, isOptional: false }, // 30ml cream
            ],
          })
          recipeCount++
        }

        const papasFrancesas = findProduct('Papas a la Francesa')
        if (papasFrancesas && papasFrancesas.inventoryMethod === InventoryMethod.RECIPE) {
          const recipe = await prisma.recipe.create({
            data: {
              productId: papasFrancesas.id,
              portionYield: 1,
              totalCost: 0,
              prepTime: 10,
              cookTime: 8,
              notes: 'Cortar papas en bastones. Freír hasta que estén doradas y crujientes. Servir con ketchup.',
            },
          })
          await prisma.recipeLine.createMany({
            data: [
              {
                recipeId: recipe.id,
                rawMaterialId: findRM('GRAIN-POTATO-001')!.id,
                quantity: 0.25,
                unit: Unit.KILOGRAM,
                isOptional: false,
              }, // 250g potatoes
              { recipeId: recipe.id, rawMaterialId: findRM('OIL-VEG-001')!.id, quantity: 0.1, unit: Unit.LITER, isOptional: false }, // 100ml oil
              { recipeId: recipe.id, rawMaterialId: findRM('SAUCE-KETCHUP-001')!.id, quantity: 0.03, unit: Unit.LITER, isOptional: false }, // 30ml ketchup
            ],
          })
          recipeCount++
        }

        const arosCebolla = findProduct('Aros de Cebolla')
        if (arosCebolla && arosCebolla.inventoryMethod === InventoryMethod.RECIPE) {
          const recipe = await prisma.recipe.create({
            data: {
              productId: arosCebolla.id,
              portionYield: 1,
              totalCost: 0,
              prepTime: 5,
              cookTime: 8,
              notes: 'Freír los aros de cebolla empanizados congelados. Servir con aderezo ranch.',
            },
          })
          await prisma.recipeLine.createMany({
            data: [
              {
                recipeId: recipe.id,
                rawMaterialId: findRM('OTHER-ONIONRINGS-001')!.id,
                quantity: 0.15,
                unit: Unit.KILOGRAM,
                isOptional: false,
              }, // 150g onion rings
              { recipeId: recipe.id, rawMaterialId: findRM('OIL-VEG-001')!.id, quantity: 0.08, unit: Unit.LITER, isOptional: false }, // 80ml oil
              { recipeId: recipe.id, rawMaterialId: findRM('SAUCE-RANCH-001')!.id, quantity: 0.03, unit: Unit.LITER, isOptional: false }, // 30ml ranch
            ],
          })
          recipeCount++
        }

        console.log(`      - ✅ Created ${recipeCount} realistic recipes with ingredient details`)

        // Recalculate recipe costs based on ingredients
        console.log(`      - 🔄 Recalculating recipe costs...`)
        const allRecipes = await prisma.recipe.findMany({
          where: { product: { venueId: venue.id } },
          include: {
            lines: {
              include: {
                rawMaterial: true,
              },
            },
          },
        })

        for (const recipe of allRecipes) {
          let totalCost = 0

          // Update costPerServing for each recipe line
          for (const line of recipe.lines) {
            const costPerUnit = Number(line.rawMaterial.costPerUnit)
            const quantity = Number(line.quantity)
            const lineCost = quantity * costPerUnit
            const costPerServing = lineCost / recipe.portionYield

            totalCost += lineCost

            // Update the recipe line with costPerServing
            await prisma.recipeLine.update({
              where: { id: line.id },
              data: { costPerServing },
            })
          }

          // Update recipe total cost
          await prisma.recipe.update({
            where: { id: recipe.id },
            data: { totalCost },
          })
        }
        console.log(`      - ✅ Updated costs for ${allRecipes.length} recipes`)

        // Create some additional movements (purchases and usage) for realistic history
        const sampleMovements = []
        for (let i = 0; i < 10; i++) {
          const randomRawMaterial = getRandomItem(createdRawMaterials.slice(0, 5))
          const movementDate = faker.date.recent({ days: 7 })
          const isDeduction = Math.random() > 0.6 // 40% purchases, 60% deductions

          if (isDeduction) {
            const deductionQuantity = faker.number.float({ min: 0.5, max: 3, fractionDigits: 2 })
            const previousStock = Number(randomRawMaterial.currentStock)
            const newStock = Math.max(0, previousStock - deductionQuantity)

            sampleMovements.push({
              rawMaterialId: randomRawMaterial.id,
              venueId: venue.id,
              type: RawMaterialMovementType.USAGE,
              quantity: -deductionQuantity,
              unit: randomRawMaterial.unit,
              previousStock,
              newStock,
              costImpact: -(Number(randomRawMaterial.costPerUnit) * deductionQuantity),
              reason: 'Uso en preparación de platillos',
              createdAt: movementDate,
            })

            // Update raw material stock
            await prisma.rawMaterial.update({
              where: { id: randomRawMaterial.id },
              data: { currentStock: newStock },
            })
          } else {
            const additionQuantity = faker.number.float({ min: 5, max: 20, fractionDigits: 2 })
            const previousStock = Number(randomRawMaterial.currentStock)
            const newStock = previousStock + additionQuantity

            sampleMovements.push({
              rawMaterialId: randomRawMaterial.id,
              venueId: venue.id,
              type: RawMaterialMovementType.PURCHASE,
              quantity: additionQuantity,
              unit: randomRawMaterial.unit,
              previousStock,
              newStock,
              costImpact: Number(randomRawMaterial.costPerUnit) * additionQuantity,
              reason: 'Compra a proveedor',
              reference: `PO-${faker.string.alphanumeric(6).toUpperCase()}`,
              createdAt: movementDate,
            })

            // Update raw material stock
            await prisma.rawMaterial.update({
              where: { id: randomRawMaterial.id },
              data: { currentStock: newStock },
            })
          }
        }

        if (sampleMovements.length > 0) {
          await prisma.rawMaterialMovement.createMany({ data: sampleMovements })
          console.log(`      - ✅ Created ${sampleMovements.length} sample stock movements (purchases and usage)`)
        }

        // Create a low stock alert for demonstration
        const lowStockItem = createdRawMaterials.find(rm => Number(rm.currentStock) <= Number(rm.reorderPoint))
        if (lowStockItem) {
          await prisma.lowStockAlert.create({
            data: {
              venueId: venue.id,
              rawMaterialId: lowStockItem.id,
              alertType: Number(lowStockItem.currentStock) === 0 ? AlertType.OUT_OF_STOCK : AlertType.LOW_STOCK,
              threshold: lowStockItem.reorderPoint,
              currentLevel: lowStockItem.currentStock,
              status: AlertStatus.ACTIVE,
            },
          })
          console.log(`      - ✅ Created low stock alert for demonstration`)
        }

        console.log(`      - 🎉 Inventory seeding completed for ${venue.name}!`)
      }

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

      // Helper to get a rotating waiter for each order
      let waiterIndex = 0
      const getNextWaiter = () => {
        const waiter = venueWaiters[waiterIndex % venueWaiters.length]
        waiterIndex++
        return waiter
      }

      // ==========================================
      // INTELLIGENT TIME-SERIES ORDER GENERATION
      // ==========================================
      console.log(`      - Generating ${SEED_CONFIG.DAYS} days of realistic time-series data...`)
      const isAvoqadoVenue = orgIndex === 0

      // Generate orders day by day with realistic patterns
      let totalOrdersGenerated = 0
      const startDate = daysAgo(SEED_CONFIG.DAYS)

      for (let dayOffset = 0; dayOffset < SEED_CONFIG.DAYS; dayOffset++) {
        const currentDate = new Date(startDate)
        currentDate.setDate(currentDate.getDate() + dayOffset)

        // Skip future dates
        if (currentDate > new Date()) continue

        const dayVolume = getOrderVolumeForDay(currentDate)
        const dayMultiplier = isAvoqadoVenue ? 1 : 0.3 // Avoqado venues get full data
        const scaledVolume = Math.round(dayVolume * dayMultiplier)
        const actualVolume = isFullVenue ? Math.max(1, scaledVolume) : scaledVolume

        if (actualVolume === 0) continue

        // Create a shift for this day (simplified - one shift per day)
        const shiftStart = new Date(currentDate)
        shiftStart.setHours(businessHours.start, 0, 0, 0)
        const shiftEnd = new Date(currentDate)
        shiftEnd.setHours(businessHours.end, 0, 0, 0)

        let shift: any = null
        if (actualVolume > 5) {
          // Only create shift if significant volume (use first waiter for the day's shift)
          shift = await prisma.shift.create({
            data: {
              venueId: venue.id,
              staffId: venueWaiters[0].staffId,
              startTime: shiftStart,
              endTime: shiftEnd,
            },
          })
        }

        // Generate orders for this day
        for (let orderIndex = 0; orderIndex < actualVolume; orderIndex++) {
          // Get the waiter for this order (rotates through all waiters)
          const currentWaiter = getNextWaiter()

          // Generate realistic order timing within business hours
          const orderCreatedAt = generateBusinessHourTimestamp(currentDate)

          // Higher completion rate for Avoqado venues (95% vs 70%)
          const completionRate = isAvoqadoVenue ? 0.95 : 0.7
          const orderStatus =
            Math.random() < completionRate ? OrderStatus.COMPLETED : Math.random() < 0.8 ? OrderStatus.PENDING : OrderStatus.CANCELLED

          const orderCompletedAt =
            orderStatus === OrderStatus.COMPLETED
              ? new Date(orderCreatedAt.getTime() + faker.number.int({ min: 15, max: 45 }) * 60 * 1000)
              : undefined

          // Select customer with cohort-based probability
          const customer = getRandomItem(customers)
          const cohortInfo = customer.email ? customerCohortMap.get(customer.email) : null
          const shouldAddCustomer = Math.random() < (cohortInfo?.type === 'vip' ? 0.8 : cohortInfo?.type === 'regular' ? 0.4 : 0.2)

          const order = await prisma.order.create({
            data: {
              venueId: venue.id,
              shiftId: shift?.id,
              orderNumber: `ORD-${faker.string.alphanumeric(8).toUpperCase()}`,
              type: getRandomItem([OrderType.DINE_IN, OrderType.TAKEOUT]),
              source: getRandomItem([OrderSource.TPV, OrderSource.QR]),
              tableId: getRandomItem(tables).id,
              customerEmail: shouldAddCustomer ? customer.email : null,
              customerName: shouldAddCustomer ? `${customer.firstName || ''} ${customer.lastName || ''}`.trim() : null,
              customerPhone: shouldAddCustomer ? customer.phone : null,
              createdById: currentWaiter.staffId,
              servedById: currentWaiter.staffId,
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

          // Generate realistic items per order based on configuration
          const numItems = faker.number.int({
            min: SEED_CONFIG.ITEMS_PER_ORDER_MIN,
            max: SEED_CONFIG.ITEMS_PER_ORDER_MAX,
          })

          let subtotal = 0
          const createdOrderItems: any[] = []

          // Target AOV for this order based on customer cohort and timing
          generateRealisticAOV(currentDate) // Generate realistic AOV patterns

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
                taxAmount: itemTotal - itemTotal / 1.16, // Mexico: IVA already included in price
                total: itemTotal,
                createdAt: orderCreatedAt,
              },
            })

            const itemModifiers: any[] = []
            // Higher modifier probability for Avoqado venues
            const modifierProbability = isAvoqadoVenue ? 0.35 : 0.15
            if (Math.random() < modifierProbability) {
              const modifier = getRandomItem(modifiers)
              await prisma.orderItemModifier.create({
                data: { orderItemId: orderItem.id, modifierId: modifier.id, quantity: 1, price: modifier.price },
              })
              subtotal += parseFloat(modifier.price.toString())
              itemModifiers.push({
                name: modifier.name,
                price: parseFloat(modifier.price.toString()),
              })
            }

            createdOrderItems.push({
              name: product.name,
              quantity,
              price: parseFloat(product.price.toString()),
              totalPrice: itemTotal + itemModifiers.reduce((sum, mod) => sum + mod.price, 0),
              modifiers: itemModifiers,
            })
          }

          // Mexico model: prices INCLUDE IVA (16%)
          // taxAmount is the IVA portion already included in subtotal, NOT added on top
          // Formula: taxAmount = subtotal - (subtotal / 1.16)
          const taxAmount = subtotal - subtotal / 1.16

          // Generate realistic tip based on customer cohort and service quality
          let tipAmount = 0
          if (order.status === OrderStatus.COMPLETED) {
            const baseTipPercent = faker.number.float({
              min: SEED_CONFIG.TIP_MIN_PERCENT,
              max: SEED_CONFIG.TIP_MAX_PERCENT,
            })

            // Apply cohort multiplier for tips
            const cohortTipMultiplier = cohortInfo?.type === 'vip' ? 1.3 : cohortInfo?.type === 'regular' ? 1.0 : 0.8

            // Better venues get better tips
            const venueQualityMultiplier = isAvoqadoVenue ? 1.2 : 1.0

            // Weekend tips tend to be higher
            const weekendMultiplier = currentDate.getDay() === 0 || currentDate.getDay() === 6 ? 1.15 : 1.0

            const finalTipPercent = baseTipPercent * cohortTipMultiplier * venueQualityMultiplier * weekendMultiplier
            tipAmount = subtotal * Math.min(finalTipPercent, 0.3) // Cap at 30%
          }

          // Mexico: total = subtotal + tip (taxAmount is already included in subtotal)
          const total = subtotal + tipAmount

          await prisma.order.update({
            where: { id: order.id },
            data: { subtotal, taxAmount, tipAmount, total },
          })

          // 👥 Create OrderCustomer records (multi-customer support)
          // If order has a customer, create OrderCustomer junction record
          if (shouldAddCustomer && customer) {
            // Create primary customer association
            await prisma.orderCustomer.create({
              data: {
                orderId: order.id,
                customerId: customer.id,
                isPrimary: true,
                addedAt: orderCreatedAt,
              },
            })

            // For ~30% of orders with customers, add a second customer (party of 2+)
            let secondCustomerId: string | null = null
            if (Math.random() < 0.3 && customers.length > 1) {
              // Pick a different customer
              const secondCustomer = customers.find(c => c.id !== customer.id) || customers[0]
              if (secondCustomer && secondCustomer.id !== customer.id) {
                secondCustomerId = secondCustomer.id
                await prisma.orderCustomer.create({
                  data: {
                    orderId: order.id,
                    customerId: secondCustomer.id,
                    isPrimary: false,
                    addedAt: new Date(orderCreatedAt.getTime() + 1000), // 1 second after
                  },
                })
              }
            }

            // For ~10% of orders, add a third customer (larger party)
            if (Math.random() < 0.1 && customers.length > 2) {
              const thirdCustomer = customers.find(c => c.id !== customer.id && c.id !== secondCustomerId)
              if (thirdCustomer) {
                await prisma.orderCustomer.create({
                  data: {
                    orderId: order.id,
                    customerId: thirdCustomer.id,
                    isPrimary: false,
                    addedAt: new Date(orderCreatedAt.getTime() + 2000), // 2 seconds after
                  },
                })
              }
            }
          }

          totalOrdersGenerated++

          if (order.status === OrderStatus.COMPLETED) {
            // Realistic payment method distribution
            const paymentMethod =
              Math.random() < SEED_CONFIG.CASH_RATIO
                ? PaymentMethod.CASH
                : getRandomItem([PaymentMethod.CREDIT_CARD, PaymentMethod.DEBIT_CARD])

            const paymentSource = getRandomItem([
              PaymentSource.TPV,
              PaymentSource.DASHBOARD_TEST,
              PaymentSource.QR,
              PaymentSource.WEB,
              PaymentSource.POS,
            ])

            const feePercentage = parseFloat(venue.feeValue.toString())
            const feeAmount = total * feePercentage
            const netAmount = total - feeAmount

            const paymentCreatedAt =
              orderCompletedAt || new Date(orderCreatedAt.getTime() + faker.number.int({ min: 5, max: 30 }) * 60 * 1000)

            // 🆕 Determine merchant account BEFORE creating payment (for both payment and transaction cost)
            // Simulate routing logic: 70% PRIMARY, 30% SECONDARY
            const accountType = Math.random() > 0.7 ? AccountType.SECONDARY : AccountType.PRIMARY
            const merchantAccountId =
              paymentMethod !== PaymentMethod.CASH
                ? accountType === AccountType.SECONDARY
                  ? blumonMerchantB.id
                  : blumonMerchantA.id
                : undefined // Cash payments don't have merchant accounts

            const payment = await prisma.payment.create({
              data: {
                venueId: venue.id,
                orderId: order.id,
                shiftId: shift?.id,
                processedById: currentWaiter.staffId,
                amount: total,
                tipAmount,
                method: paymentMethod,
                source: paymentSource,
                status: TransactionStatus.COMPLETED,
                splitType: 'FULLPAYMENT',
                processor: paymentMethod !== PaymentMethod.CASH ? 'stripe' : null,
                processorId: paymentMethod !== PaymentMethod.CASH ? `pi_${faker.string.alphanumeric(24)}` : null,
                merchantAccountId, // 🆕 Link payment to merchant account
                feePercentage,
                feeAmount,
                netAmount,
                createdAt: paymentCreatedAt,
                allocations: { create: { orderId: order.id, amount: total, createdAt: paymentCreatedAt } },
              },
            })

            // --- Add Transaction Cost Tracking (only for card payments with merchant account) ---
            if (paymentMethod !== PaymentMethod.CASH && merchantAccountId) {
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

              // Get the cost structures
              const providerCost = accountType === AccountType.SECONDARY ? blumonBCosts : blumonACosts
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

            // Create proper dataSnapshot structure for the digital receipt
            const dataSnapshot = {
              payment: {
                id: payment.id,
                amount: parseFloat(payment.amount.toString()),
                tipAmount: parseFloat(payment.tipAmount.toString()),
                totalAmount: parseFloat(payment.amount.toString()) + parseFloat(payment.tipAmount.toString()),
                method: payment.method.toString(),
                status: payment.status.toString(),
                createdAt: payment.createdAt.toISOString(),
                splitType: payment.splitType?.toString(),
              },
              venue: {
                id: venue.id,
                name: venue.name,
                address: venue.address || '',
                city: venue.city || '',
                state: venue.state || '',
                zipCode: venue.zipCode || '',
                phone: venue.phone || '',
                email: venue.email || '',
                logo: venue.logo || undefined,
                primaryColor: venue.primaryColor || undefined,
                currency: 'MXN',
              },
              order: {
                id: order.id,
                number: order.orderNumber,
                items: createdOrderItems,
                subtotal: subtotal,
                taxAmount: taxAmount,
                total: total,
                createdAt: order.createdAt.toISOString(),
                type: order.type?.toString(),
                source: order.source?.toString(),
                table: order.tableId
                  ? {
                      number: tables.find(t => t.id === order.tableId)?.number || 'N/A',
                      area: createdAreas.find(a => a.id === tables.find(t => t.id === order.tableId)?.areaId)?.name || 'N/A',
                    }
                  : undefined,
              },
              processedBy: {
                name: `${currentWaiter.staff.firstName} ${currentWaiter.staff.lastName}`,
              },
            }

            await prisma.digitalReceipt.create({
              data: {
                paymentId: payment.id,
                dataSnapshot,
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

            // Calculate settlement information if transaction cost exists
            let settlementInfo = null
            if (paymentMethod !== PaymentMethod.CASH) {
              try {
                // Find the transaction cost that was just created
                const transactionCost = await prisma.transactionCost.findUnique({
                  where: { paymentId: payment.id },
                })

                if (transactionCost) {
                  // Calculate settlement date and amount
                  settlementInfo = await calculatePaymentSettlement(
                    payment,
                    transactionCost.merchantAccountId,
                    transactionCost.transactionType,
                  )
                }
              } catch (error) {
                console.log(`    ⚠️  Warning: Could not calculate settlement for payment ${payment.id}`)
              }
            }

            await prisma.venueTransaction.create({
              data: {
                venueId: venue.id,
                paymentId: payment.id,
                type: TransactionType.PAYMENT,
                grossAmount: total,
                feeAmount,
                netAmount,
                status: settlementInfo ? SettlementStatus.PENDING : SettlementStatus.PENDING,
                estimatedSettlementDate: settlementInfo?.estimatedSettlementDate,
                netSettlementAmount: settlementInfo?.netSettlementAmount,
                settlementConfigId: settlementInfo?.settlementConfigId,
                createdAt: transactionCreatedAt,
              },
            })

            // Generate reviews with realistic patterns
            if (Math.random() < SEED_CONFIG.REVIEW_PROBABILITY) {
              const reviewCreatedAt = new Date(paymentCreatedAt.getTime() + faker.number.int({ min: 30, max: 180 }) * 60 * 1000)

              // Good venues get better ratings, customer cohort affects rating too
              const baseRating = isAvoqadoVenue ? 4.5 : 3.8
              const cohortBonus = cohortInfo?.type === 'vip' ? 0.3 : cohortInfo?.type === 'regular' ? 0.1 : 0
              const ratingFloat = Math.min(5, baseRating + cohortBonus + faker.number.float({ min: -0.5, max: 0.5 }))
              const finalRating = Math.round(ratingFloat)

              // Generate realistic comments based on rating
              const comments: Record<number, string[]> = {
                5: [
                  'Excellent service and food!',
                  'Outstanding experience, highly recommend!',
                  'Perfect in every way!',
                  'Amazing food and great staff!',
                ],
                4: [
                  'Very good, will come back!',
                  'Great service, food was delicious!',
                  'Good experience overall!',
                  'Nice place, good food!',
                ],
                3: ['Decent food, average service', 'It was okay, nothing special', 'Average experience', 'Food was fine'],
                2: ['Service could be better', 'Food was cold when served', 'Long wait time', 'Not impressed'],
                1: ['Terrible experience', 'Would not recommend', 'Very disappointed', 'Poor service and food'],
              }

              const commentOptions = comments[finalRating] || comments[3]
              const selectedComment = getRandomItem(commentOptions) as string

              await prisma.review.create({
                data: {
                  venueId: venue.id,
                  paymentId: payment.id,
                  terminalId: getRandomItem(terminals).id,
                  servedById: currentWaiter.staffId,
                  overallRating: finalRating,
                  comment: selectedComment,
                  source: ReviewSource.AVOQADO,
                  createdAt: reviewCreatedAt,
                },
              })
            }
          }
        }
      }
      console.log(`      - Generated ${totalOrdersGenerated} orders with realistic time-series patterns for ${venue.name}.`)

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
      for (const [, data] of monthlyData) {
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

      // Get existing raw materials for this venue to use in LOW_INVENTORY notifications
      const venueRawMaterials = await prisma.rawMaterial.findMany({
        where: { venueId: venue.id, active: true },
        select: { id: true, name: true, sku: true, currentStock: true, unit: true },
        take: 5,
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
              // Use a real raw material if available, otherwise create fake data
              if (venueRawMaterials.length > 0) {
                const rawMaterial = getRandomItem(venueRawMaterials)
                const currentStock = Number(rawMaterial.currentStock)
                title = '📉 Stock Bajo'
                message = `${rawMaterial.name} (${rawMaterial.sku}) tiene stock bajo (${currentStock.toFixed(2)} ${rawMaterial.unit}).`
                actionUrl = `/inventory/raw-materials?highlight=${rawMaterial.id}`
                actionLabel = 'Gestionar Inventario'
                entityType = 'RawMaterial'
                entityId = rawMaterial.id
                metadata = {
                  rawMaterialName: rawMaterial.name,
                  sku: rawMaterial.sku,
                  currentStock,
                  unit: rawMaterial.unit,
                  alertType: 'LOW_STOCK',
                }
              } else {
                // Fallback if no raw materials exist
                const productName = faker.commerce.productName()
                const currentStock = faker.number.int({ min: 1, max: 9 })
                title = 'Stock Bajo'
                message = `El producto ${productName} tiene stock bajo (${currentStock} unidades).`
                actionUrl = '/inventory/raw-materials'
                actionLabel = 'Gestionar Inventario'
                entityType = 'RawMaterial'
                entityId = null
                metadata = { productName, currentStock }
              }
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

      // ========================================
      // CREATE TEST TRANSACTIONS FOR SETTLEMENT INCIDENT TESTING
      // ========================================
      // Only create test incidents for the first full venue to keep data clean
      if (isFullVenue && index === 0) {
        console.log(`      - Creating test transactions with delayed settlements...`)

        const testTransactions = []
        const yesterday = new Date()
        yesterday.setDate(yesterday.getDate() - 1)
        yesterday.setHours(10, 0, 0, 0)

        const twoDaysAgo = new Date()
        twoDaysAgo.setDate(twoDaysAgo.getDate() - 2)
        twoDaysAgo.setHours(14, 30, 0, 0)

        // Get venue payment config to access merchant accounts
        const venuePaymentConfig = await prisma.venuePaymentConfig.findUnique({
          where: { venueId: venue.id },
          include: {
            primaryAccount: {
              include: { provider: true },
            },
            secondaryAccount: {
              include: { provider: true },
            },
          },
        })

        if (venuePaymentConfig?.primaryAccount) {
          // Test Transaction 1: Primary account (usually Blumonpay) Debit - Expected yesterday, not arrived
          const primaryAccount = venuePaymentConfig.primaryAccount

          const testOrder1 = await prisma.order.create({
            data: {
              venueId: venue.id,
              orderNumber: `TEST-INCIDENT-001`,
              status: OrderStatus.COMPLETED,
              subtotal: 5000,
              taxAmount: 800,
              discountAmount: 0,
              tipAmount: 750,
              total: 6550,
              createdAt: yesterday,
              updatedAt: yesterday,
            },
          })

          const testPayment1 = await prisma.payment.create({
            data: {
              venueId: venue.id,
              orderId: testOrder1.id,
              amount: 6550,
              tipAmount: 750,
              method: PaymentMethod.DEBIT_CARD,
              source: PaymentSource.WEB,
              status: TransactionStatus.COMPLETED,
              processor: primaryAccount.provider?.name || 'Blumonpay',
              feePercentage: 0.03,
              feeAmount: 196.5,
              netAmount: 6353.5,
              originSystem: OriginSystem.AVOQADO,
              syncStatus: SyncStatus.SYNCED,
              createdAt: yesterday,
              updatedAt: yesterday,
            },
          })

          // Create transaction cost
          await prisma.transactionCost.create({
            data: {
              paymentId: testPayment1.id,
              merchantAccountId: primaryAccount.id,
              transactionType: TransactionCardType.DEBIT,
              amount: 6550,
              providerRate: 0.025,
              providerCostAmount: 163.75,
              providerFixedFee: 0,
              venueRate: 0.03,
              venueChargeAmount: 196.5,
              venueFixedFee: 0,
              grossProfit: 32.75,
              profitMargin: 0.1667,
            },
          })

          // Create VenueTransaction with estimated settlement date = yesterday (should trigger incident)
          await prisma.venueTransaction.create({
            data: {
              venueId: venue.id,
              paymentId: testPayment1.id,
              type: TransactionType.PAYMENT,
              grossAmount: 6550,
              feeAmount: 196.5,
              netAmount: 6353.5,
              status: SettlementStatus.PENDING,
              estimatedSettlementDate: yesterday, // Expected yesterday!
              actualSettlementDate: null, // Not arrived yet!
              netSettlementAmount: 6353.5,
              createdAt: yesterday,
            },
          })

          testTransactions.push({
            amount: 6550,
            processor: primaryAccount.provider?.name || 'Primary',
            cardType: 'DEBIT',
            expectedDate: yesterday,
          })

          // Test Transaction 2: Secondary account Credit - Expected 2 days ago, not arrived
          const secondaryAccount = venuePaymentConfig.secondaryAccount || primaryAccount

          const testOrder2 = await prisma.order.create({
            data: {
              venueId: venue.id,
              orderNumber: `TEST-INCIDENT-002`,
              status: OrderStatus.COMPLETED,
              subtotal: 8500,
              taxAmount: 1360,
              discountAmount: 0,
              tipAmount: 1275,
              total: 11135,
              createdAt: twoDaysAgo,
              updatedAt: twoDaysAgo,
            },
          })

          const testPayment2 = await prisma.payment.create({
            data: {
              venueId: venue.id,
              orderId: testOrder2.id,
              amount: 11135,
              tipAmount: 1275,
              method: PaymentMethod.CREDIT_CARD,
              source: PaymentSource.WEB,
              status: TransactionStatus.COMPLETED,
              processor: secondaryAccount.provider?.name || 'Secondary',
              feePercentage: 0.035,
              feeAmount: 389.73,
              netAmount: 10745.27,
              originSystem: OriginSystem.AVOQADO,
              syncStatus: SyncStatus.SYNCED,
              createdAt: twoDaysAgo,
              updatedAt: twoDaysAgo,
            },
          })

          // Create transaction cost
          await prisma.transactionCost.create({
            data: {
              paymentId: testPayment2.id,
              merchantAccountId: secondaryAccount.id,
              transactionType: TransactionCardType.CREDIT,
              amount: 11135,
              providerRate: 0.03,
              providerCostAmount: 334.05,
              providerFixedFee: 0,
              venueRate: 0.035,
              venueChargeAmount: 389.73,
              venueFixedFee: 0,
              grossProfit: 55.68,
              profitMargin: 0.1429,
            },
          })

          // Create VenueTransaction with estimated settlement date = 2 days ago
          await prisma.venueTransaction.create({
            data: {
              venueId: venue.id,
              paymentId: testPayment2.id,
              type: TransactionType.PAYMENT,
              grossAmount: 11135,
              feeAmount: 389.73,
              netAmount: 10745.27,
              status: SettlementStatus.PENDING,
              estimatedSettlementDate: twoDaysAgo, // Expected 2 days ago!
              actualSettlementDate: null, // Not arrived yet!
              netSettlementAmount: 10745.27,
              createdAt: twoDaysAgo,
            },
          })

          testTransactions.push({
            amount: 11135,
            processor: secondaryAccount.provider?.name || 'Secondary',
            cardType: 'CREDIT',
            expectedDate: twoDaysAgo,
          })

          console.log(`        ✅ Created ${testTransactions.length} test transactions with delayed settlements:`)
          testTransactions.forEach(tx => {
            console.log(
              `          - $${tx.amount} (${tx.processor} ${tx.cardType}) - Expected: ${tx.expectedDate.toISOString().split('T')[0]}`,
            )
          })
          console.log(
            `        💡 Run the settlement detection job to create incidents: \`npx ts-node -e "import('./src/jobs/settlement-detection.job').then(m => m.settlementDetectionJob.runNow())"\``,
          )
        }
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

  // ==========================================
  // SEED SUMMARY REPORT
  // ==========================================
  console.log(`\n🎉 Intelligent Prisma seed completed successfully!`)
  console.log(`\n📊 Generated Data Summary:`)
  console.log(`   - Time Period: ${SEED_CONFIG.DAYS} days`)
  console.log(`   - Organizations: ${organizations.length}`)

  // Get final counts
  const finalCounts = {
    venues: await prisma.venue.count(),
    orders: await prisma.order.count(),
    payments: await prisma.payment.count(),
    reviews: await prisma.review.count(),
    customers: await prisma.customer.count(),
    products: await prisma.product.count(),
  }

  console.log(`   - Venues: ${finalCounts.venues}`)
  console.log(`   - Customers: ${finalCounts.customers}`)
  console.log(`   - Products: ${finalCounts.products}`)
  console.log(`   - Orders: ${finalCounts.orders}`)
  console.log(`   - Payments: ${finalCounts.payments}`)
  console.log(`   - Reviews: ${finalCounts.reviews}`)

  console.log(`\n🚀 Ready for analytics! Run the validation script to verify metrics:`)
  console.log(`   pnpm ts-node scripts/check-analytics.ts`)
  console.log(``)

  if (SEED_CONFIG.SEED) {
    console.log(`🎲 Deterministic seed used: ${SEED_CONFIG.SEED}`)
    console.log(`   To reproduce this data: SEED_SEED=${SEED_CONFIG.SEED} pnpm prisma db seed`)
  } else {
    console.log(`🎲 Random seed generated. To reproduce, use: SEED_SEED=<number> pnpm prisma db seed`)
  }
  console.log(``)
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
