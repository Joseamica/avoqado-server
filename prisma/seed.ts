import { faker } from '@faker-js/faker'
import {
  ChargeType,
  FeatureCategory,
  InvitationStatus,
  InvitationType,
  InvoiceStatus,
  KitchenStatus,
  MenuType,
  MovementType,
  OrderSource,
  OrderStatus,
  OrderType,
  PaymentMethod,
  PaymentStatus,
  PrismaClient,
  ProductType,
  ReceiptStatus,
  ReviewSource,
  SettlementStatus,
  StaffRole,
  TerminalStatus,
  TerminalType,
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
    .replace(/[&\/\\#,+()$~%.'":*?<>{}]/g, '') // Remove special characters
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
      code: 'INVENTORY_TRACKING',
      name: 'Control de Inventario',
      description: 'Gestión de stock de productos y alertas.',
      category: FeatureCategory.OPERATIONS,
      monthlyPrice: 24.99,
    },
  ]
  await prisma.feature.createMany({ data: featuresData })
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

    let createdStaffList: (any & { assignedRole: StaffRole })[] = []

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
        }
      }
      console.log(`      - Assigned staff to ${venue.name}.`)

      // Settings y Features
      await prisma.venueSettings.create({ data: { venueId: venue.id, trackInventory: true, allowReservations: true } })
      for (const feature of allFeatures) {
        if (Math.random() > 0.5) {
          await prisma.venueFeature.create({ data: { venueId: venue.id, featureId: feature.id, monthlyPrice: feature.monthlyPrice } })
        }
      }
      console.log(`      - Created VenueSettings and assigned Features.`)

      const terminals = await Promise.all(
        Array.from({ length: 2 }).map((_, t) =>
          prisma.terminal.create({
            data: {
              venueId: venue.id,
              serialNumber: faker.string.uuid(),
              name: `TPV ${t + 1}`,
              type: TerminalType.TPV_ANDROID,
              status: TerminalStatus.ACTIVE,
              lastHeartbeat: new Date(),
            },
          }),
        ),
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
      const shift = await prisma.shift.create({
        data: { venueId: venue.id, staffId: activeWaiter.staffId, startTime: faker.date.recent({ days: 3 }) },
      })

      console.log('      - Creating shifts, orders, payments...')
      for (let k = 0; k < 10; k++) {
        const orderStatus = getRandomItem([OrderStatus.COMPLETED, OrderStatus.COMPLETED, OrderStatus.PENDING, OrderStatus.CANCELLED])
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
            completedAt: orderStatus === OrderStatus.COMPLETED ? faker.date.recent({ days: 1 }) : undefined,
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
              processor: paymentMethod !== 'CASH' ? 'stripe' : null,
              processorId: paymentMethod !== 'CASH' ? `pi_${faker.string.alphanumeric(24)}` : null,
              feePercentage,
              feeAmount,
              netAmount,
              allocations: { create: { orderId: order.id, amount: total } },
            },
          })

          await prisma.digitalReceipt.create({
            data: {
              paymentId: payment.id,
              dataSnapshot: { venueName: venue.name, orderNumber: order.orderNumber, total, paymentMethod },
              status: ReceiptStatus.SENT,
              recipientEmail: faker.internet.email(),
              sentAt: new Date(),
            },
          })

          await prisma.venueTransaction.create({
            data: {
              venueId: venue.id,
              paymentId: payment.id,
              type: TransactionType.PAYMENT,
              grossAmount: total,
              feeAmount,
              netAmount,
              status: SettlementStatus.PENDING,
            },
          })

          if (Math.random() > 0.5) {
            await prisma.review.create({
              data: {
                venueId: venue.id,
                paymentId: payment.id,
                terminalId: getRandomItem(terminals).id,
                servedById: activeWaiter.staffId,
                overallRating: faker.number.int({ min: 3, max: 5 }),
                comment: faker.lorem.sentence(),
                source: ReviewSource.AVOQADO,
              },
            })
          }
        }
      }
      console.log(`      - Finished creating orders and related data for one shift.`)
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
