import {
  PrismaClient,
  StaffRole,
  VenueType,
  BusinessType,
  ProductType,
  MenuType,
  OrderType,
  OrderSource,
  OrderStatus,
  KitchenStatus,
  PaymentStatus,
  PosType,
  FeeType,
  SyncStatus,
  PaymentMethod,
  TransactionStatus,
  TransactionType,
  SettlementStatus,
  FeatureCategory,
  MovementType,
  TerminalType,
  TerminalStatus,
  InvoiceStatus,
  ChargeType,
} from '@prisma/client'
import { faker } from '@faker-js/faker'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

const HASH_ROUNDS = 10

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w-]+/g, '')
}

// Función para obtener un elemento aleatorio de un array
function getRandomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

async function main() {
  console.log(`Start seeding ...`)

  // --- Limpieza de Datos Existentes (en orden de dependencia inversa estricto) ---
  console.log('Cleaning up existing data...')
  // Nivel más profundo
  await prisma.orderItemModifier.deleteMany()
  await prisma.activityLog.deleteMany()
  await prisma.digitalReceipt.deleteMany()
  await prisma.venueTransaction.deleteMany()
  await prisma.invoiceItem.deleteMany()

  // Nivel intermedio
  await prisma.orderItem.deleteMany()
  await prisma.payment.deleteMany()
  await prisma.productModifierGroup.deleteMany()
  await prisma.inventoryMovement.deleteMany()

  // Nivel superior
  await prisma.order.deleteMany()
  await prisma.shift.deleteMany()
  await prisma.inventory.deleteMany()
  await prisma.modifier.deleteMany()
  await prisma.staffVenue.deleteMany()
  await prisma.venueSettings.deleteMany()
  await prisma.table.deleteMany()
  await prisma.terminal.deleteMany()
  await prisma.review.deleteMany()
  await prisma.menuCategoryAssignment.deleteMany()

  // Nivel base de Venue
  await prisma.menu.deleteMany()
  await prisma.modifierGroup.deleteMany()
  await prisma.product.deleteMany()
  await prisma.menuCategory.deleteMany()
  await prisma.venueFeature.deleteMany()
  await prisma.invoice.deleteMany()
  await prisma.invitation.deleteMany()

  // Nivel de Organización
  await prisma.staff.deleteMany()
  await prisma.venue.deleteMany()
  await prisma.organization.deleteMany()

  // Datos Globales
  await prisma.feeTier.deleteMany()
  await prisma.feeSchedule.deleteMany()
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

    if (orgIndex === 0) {
      console.log(`  Creating specific users for ${org.name}...`)
      const staffToCreate = [
        { email: 'superadmin@superadmin.com', password: 'superadmin', role: StaffRole.SUPERADMIN, firstName: 'Super', lastName: 'Admin' },
        { email: 'owner@owner.com', password: 'owner', role: StaffRole.OWNER, firstName: 'Main', lastName: 'Owner' },
        { email: 'admin@admin.com', password: 'admin', role: StaffRole.ADMIN, firstName: 'Venue', lastName: 'Admin' },
        { email: 'manager@manager.com', password: 'manager', role: StaffRole.MANAGER, firstName: 'Shift', lastName: 'Manager' },
        { email: 'waiter@waiter.com', password: 'waiter', role: StaffRole.WAITER, firstName: 'John', lastName: 'Waiter' },
        { email: 'waiter2@waiter.com', password: 'waiter', role: StaffRole.WAITER, firstName: 'Jane', lastName: 'Waitress' },
      ]

      for (const staffData of staffToCreate) {
        const passwordHash = await bcrypt.hash(staffData.password, HASH_ROUNDS)
        const staffMember = await prisma.staff.create({
          data: {
            organizationId: org.id,
            email: staffData.email,
            password: passwordHash,
            pin: faker.string.numeric(4),
            firstName: staffData.firstName,
            lastName: staffData.lastName,
            phone: faker.phone.number(),
            active: true,
            emailVerified: true,
          },
        })
        createdStaffList.push({ ...staffMember, assignedRole: staffData.role })
      }
    } else {
      // Staff aleatorio para otras organizaciones
      for (let i = 0; i < 5; i++) {
        const firstName = faker.person.firstName()
        const lastName = faker.person.lastName()
        const staffMember = await prisma.staff.create({
          data: {
            organizationId: org.id,
            email: faker.internet.email({ firstName, lastName }),
            password: await bcrypt.hash('Password123!', HASH_ROUNDS),
            pin: faker.string.numeric(4),
            firstName,
            lastName,
            active: true,
            emailVerified: true,
          },
        })
        createdStaffList.push({ ...staffMember, assignedRole: StaffRole.WAITER })
      }
    }
    console.log(`  Created ${createdStaffList.length} staff members.`)

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
          email: faker.internet.email({ firstName: 'contact', lastName: venueSlug }).toLowerCase(),
          logo: faker.image.urlLoremFlickr({ category: 'restaurant,logo' }),
          feeValue: 0.025, // 2.5%
        },
      })
      console.log(`    -> Created Venue: ${venue.name}.`)

      // Asignar Staff a este Venue
      for (const staffWithRole of createdStaffList) {
        if ([StaffRole.SUPERADMIN, StaffRole.OWNER].includes(staffWithRole.assignedRole) || Math.random() > 0.3) {
          await prisma.staffVenue.create({
            data: { staffId: staffWithRole.id, venueId: venue.id, role: staffWithRole.assignedRole, active: true },
          })
        }
      }
      console.log(`      - Assigned staff to ${venue.name}.`)

      // Settings y Features
      await prisma.venueSettings.create({ data: { venueId: venue.id, trackInventory: true } })
      for (const feature of allFeatures) {
        if (Math.random() > 0.5) {
          await prisma.venueFeature.create({ data: { venueId: venue.id, featureId: feature.id, monthlyPrice: feature.monthlyPrice } })
        }
      }
      console.log(`      - Created VenueSettings and assigned Features.`)

      // Mesas (Tables)
      const tables = []
      for (let t = 1; t <= 15; t++) {
        tables.push(
          await prisma.table.create({
            data: {
              venueId: venue.id,
              number: `M${t}`,
              section: t > 10 ? 'Terraza' : 'Interior',
              capacity: getRandomItem([2, 4, 6]),
              qrCode: faker.string.uuid(),
            },
          }),
        )
      }
      console.log(`      - Created ${tables.length} tables.`)

      // Categorías de Menú
      const categories = []
      const categoryNames = ['Entradas', 'Platos Fuertes', 'Postres', 'Bebidas', 'Sopas']
      for (const name of categoryNames) {
        categories.push(
          await prisma.menuCategory.create({
            data: { venueId: venue.id, name, slug: generateSlug(name), displayOrder: categories.length },
          }),
        )
      }
      console.log(`      - Created ${categories.length} menu categories.`)

      // Productos
      let products = []
      for (const category of categories) {
        for (let p = 0; p < 8; p++) {
          const productName = faker.commerce.productName()
          products.push(
            await prisma.product.create({
              data: {
                venueId: venue.id,
                name: productName,
                sku: `${category.slug.toUpperCase()}-${faker.string.alphanumeric(6)}`,
                categoryId: category.id,
                price: parseFloat(faker.commerce.price({ min: 50, max: 450 })),
                trackInventory: true,
                type: category.name === 'Bebidas' ? ProductType.BEVERAGE : ProductType.FOOD,
                tags: [faker.lorem.word(), faker.lorem.word()],
                imageUrl: faker.image.urlLoremFlickr({ category: 'food' }),
              },
            }),
          )
        }
      }
      console.log(`      - Created ${products.length} products.`)
      // Filtrar productos que no son de tipo 'OTHER' o 'SERVICE'
      const sellableProductTypes: ProductType[] = [ProductType.FOOD, ProductType.BEVERAGE, ProductType.ALCOHOL, ProductType.RETAIL];
      // Filtrar la lista de productos para usar solo los vendibles en las órdenes
      const sellableProducts = products.filter(p => sellableProductTypes.includes(p.type));

      // Grupos de Modificadores y Modificadores
      const modifierGroup = await prisma.modifierGroup.create({
        data: {
          venueId: venue.id,
          name: 'Aderezos',
          allowMultiple: true,
          required: false,
        },
      })
      const modifiers = await Promise.all([
        prisma.modifier.create({ data: { groupId: modifierGroup.id, name: 'Ranch', price: 10 } }),
        prisma.modifier.create({ data: { groupId: modifierGroup.id, name: 'BBQ', price: 12.5 } }),
        prisma.modifier.create({ data: { groupId: modifierGroup.id, name: 'Chipotle Mayo', price: 15 } }),
      ])
      console.log(`      - Created ${modifiers.length} modifiers in 1 group.`)
      // Asignar grupo de modificadores a algunos productos
      const productsToAssign = new Set<string>();
      // Asegurarse de que hay suficientes productos para elegir
      const sampleSize = Math.min(5, sellableProducts.length);
      
      while (productsToAssign.size < sampleSize) {
        const randomProduct = getRandomItem(sellableProducts);
        productsToAssign.add(randomProduct.id);
      }
      
      for (const productId of productsToAssign) {
        await prisma.productModifierGroup.create({
          data: {
            productId: productId,
            groupId: modifierGroup.id,
          },
        });
      }

      // Órdenes, Items, Pagos y Recibos
      console.log('      - Creating orders, payments, receipts...')
      const venueStaff = await prisma.staffVenue.findMany({
        where: { venueId: venue.id, role: { in: [StaffRole.WAITER, StaffRole.MANAGER] } },
        include: { staff: true },
      })
      if (venueStaff.length === 0) continue // Saltar si no hay meseros

      for (let k = 0; k < 25; k++) {
        const orderStatus = getRandomItem([OrderStatus.COMPLETED, OrderStatus.COMPLETED, OrderStatus.PENDING, OrderStatus.CANCELLED])
        const createdByStaff = getRandomItem(venueStaff)
        const order = await prisma.order.create({
          data: {
            venueId: venue.id,
            orderNumber: `ORD-${faker.string.alphanumeric(8).toUpperCase()}`,
            type: getRandomItem([OrderType.DINE_IN, OrderType.TAKEOUT]),
            source: getRandomItem([OrderSource.TPV, OrderSource.QR]),
            tableId: getRandomItem(tables).id,
            createdById: createdByStaff.staffId,
            servedById: createdByStaff.staffId,
            subtotal: 0, // Se calculará después
            taxAmount: 0, // Se calculará después
            total: 0, // Se calculará después
            status: orderStatus,
            paymentStatus: orderStatus === OrderStatus.COMPLETED ? PaymentStatus.PAID : PaymentStatus.PENDING,
            kitchenStatus: orderStatus === OrderStatus.COMPLETED ? KitchenStatus.SERVED : KitchenStatus.PENDING,
            completedAt: orderStatus === OrderStatus.COMPLETED ? faker.date.recent({ days: 10 }) : undefined,
          },
        })

        // Crear OrderItems para la orden
        let subtotal = 0
        const orderItems = []
        const numItems = faker.number.int({ min: 1, max: 5 })
        for (let j = 0; j < numItems; j++) {
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
          orderItems.push(orderItem)

          // 20% de probabilidad de agregar un modificador
          if (Math.random() < 0.2) {
            const modifier = getRandomItem(modifiers)
            await prisma.orderItemModifier.create({
              data: {
                orderItemId: orderItem.id,
                modifierId: modifier.id,
                quantity: 1,
                price: modifier.price,
              },
            })
            subtotal += parseFloat(modifier.price.toString())
          }
        }

        const taxAmount = subtotal * 0.16
        const tipAmount = order.status === OrderStatus.COMPLETED ? subtotal * getRandomItem([0.1, 0.15, 0.2]) : 0
        const total = subtotal + taxAmount + tipAmount

        // Actualizar la orden con los totales calculados
        await prisma.order.update({
          where: { id: order.id },
          data: {
            subtotal,
            taxAmount,
            tipAmount,
            total,
          },
        })

        // Log de actividad para creación de orden
        await prisma.activityLog.create({
          data: {
            venueId: venue.id,
            staffId: createdByStaff.staffId,
            action: 'CREATE_ORDER',
            entity: 'Order',
            entityId: order.id,
            data: { total: total },
          },
        })

        // Crear Pago, Recibo y Transacción si la orden está completada
        if (order.status === OrderStatus.COMPLETED) {
          const paymentMethod = getRandomItem([PaymentMethod.CASH, PaymentMethod.CREDIT_CARD, PaymentMethod.DEBIT_CARD])
          const feePercentage = parseFloat(venue.feeValue.toString())
          const feeAmount = total * feePercentage
          const netAmount = total - feeAmount

          const payment = await prisma.payment.create({
            data: {
              venueId: venue.id,
              orderId: order.id,
              processedById: createdByStaff.staffId,
              amount: total,
              tipAmount: tipAmount,
              method: paymentMethod,
              status: TransactionStatus.COMPLETED,
              processor: paymentMethod !== 'CASH' ? 'stripe' : null,
              processorId: paymentMethod !== 'CASH' ? `pi_${faker.string.alphanumeric(24)}` : null,
              feePercentage: feePercentage,
              feeAmount: feeAmount,
              netAmount: netAmount,
            },
          })

          await prisma.digitalReceipt.create({
            data: {
              paymentId: payment.id,
              dataSnapshot: {
                venueName: venue.name,
                orderNumber: order.orderNumber,
                items: await prisma.orderItem.findMany({ where: { orderId: order.id } }),
                subtotal,
                taxAmount,
                tipAmount,
                total,
                paymentMethod,
              },
              status: 'SENT',
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
              feeAmount: feeAmount,
              netAmount: netAmount,
              status: SettlementStatus.PENDING,
            },
          })

          // Log de actividad para pago
          await prisma.activityLog.create({
            data: {
              venueId: venue.id,
              staffId: createdByStaff.staffId,
              action: 'PROCESS_PAYMENT',
              entity: 'Payment',
              entityId: payment.id,
              data: { amount: total, method: paymentMethod },
            },
          })
        }
      }
      console.log(`      - Finished creating orders and related data.`)
    }
  }

  console.log(`\nSeeding finished successfully.`)
}

main()
  .catch(async (e) => {
    console.error(e)
    await prisma.$disconnect()
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })