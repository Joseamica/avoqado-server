/**
 * Test Data Setup Helper
 *
 * Creates realistic test data for integration tests.
 * Ensures dashboard and chatbot have consistent data to validate against.
 */

import prisma from '@/utils/prismaClient'
import { Prisma } from '@prisma/client'

export interface TestVenue {
  id: string
  name: string
  slug: string
  timezone: string
  currency: string
}

export interface TestUser {
  id: string
  email: string
  firstName: string
  lastName: string
}

export interface TestData {
  venue: TestVenue
  user: TestUser
  organization: { id: string }
  staff: Array<{ id: string; name: string }>
  products: Array<{ id: string; name: string }>
  orders: Array<{ id: string; total: number }>
  payments: Array<{ id: string; amount: number }>
  reviews: Array<{ id: string; rating: number }>
}

/**
 * Setup realistic test data
 *
 * Creates a test venue with:
 * - 10 products
 * - 5 staff members
 * - 50 orders (last 30 days)
 * - 50 payments
 * - 20 reviews
 */
export async function setupTestData(): Promise<TestData> {
  // Create organization
  const org = await prisma.organization.create({
    data: {
      name: 'Test Restaurant Group',
      email: 'test@avoqado.com',
      phone: '5551234567',
      type: 'RESTAURANT',
    },
  })

  // Create venue
  const venue = await prisma.venue.create({
    data: {
      name: 'Test Restaurant',
      slug: `test-restaurant-${Date.now()}`,
      organizationId: org.id,
      timezone: 'America/Mexico_City',
      currency: 'MXN',
      address: '123 Test St',
      city: 'Test City',
      country: 'Mexico',
    },
  })

  // Create test user
  const user = await prisma.staff.create({
    data: {
      email: `test-${Date.now()}@avoqado.com`,
      firstName: 'Test',
      lastName: 'User',
      phone: '1234567890',
      organizationId: org.id,
      venues: {
        create: {
          venueId: venue.id,
          role: 'ADMIN',
          permissions: ['*:*'], // All permissions
        },
      },
    },
  })

  // Create menu category for products
  const category = await prisma.menuCategory.create({
    data: {
      venueId: venue.id,
      name: 'Test Menu',
      slug: 'test-menu',
    },
  })

  // Create products
  const products = await Promise.all(
    [
      { name: 'Hamburguesa Clásica', price: 120, sku: 'BURG-001' },
      { name: 'Pizza Margherita', price: 180, sku: 'PIZZA-001' },
      { name: 'Tacos al Pastor', price: 80, sku: 'TACO-001' },
      { name: 'Ensalada César', price: 90, sku: 'SAL-001' },
      { name: 'Cerveza Artesanal', price: 60, sku: 'BEV-001' },
      { name: 'Refresco', price: 30, sku: 'BEV-002' },
      { name: 'Agua Mineral', price: 25, sku: 'BEV-003' },
      { name: 'Pastel de Chocolate', price: 70, sku: 'DES-001' },
      { name: 'Café Americano', price: 35, sku: 'BEV-004' },
      { name: 'Jugo Natural', price: 45, sku: 'BEV-005' },
    ].map(product =>
      prisma.product.create({
        data: {
          venueId: venue.id,
          categoryId: category.id,
          sku: product.sku,
          name: product.name,
          description: `Delicious ${product.name}`,
          price: new Prisma.Decimal(product.price),
        },
      }),
    ),
  )

  // Create staff members with unique emails (timestamp to avoid conflicts)
  const timestamp = Date.now()
  const staff = await Promise.all(
    [
      { firstName: 'Juan', lastName: 'Pérez', role: 'WAITER' },
      { firstName: 'María', lastName: 'González', role: 'WAITER' },
      { firstName: 'Carlos', lastName: 'Rodríguez', role: 'CASHIER' },
      { firstName: 'Ana', lastName: 'Martínez', role: 'KITCHEN' },
      { firstName: 'Luis', lastName: 'López', role: 'MANAGER' },
    ].map((s, index) =>
      prisma.staff.create({
        data: {
          email: `${s.firstName.toLowerCase()}.${s.lastName.toLowerCase()}.${timestamp}.${index}@test.com`,
          firstName: s.firstName,
          lastName: s.lastName,
          phone: '1234567890',
          organizationId: org.id,
          venues: {
            create: {
              venueId: venue.id,
              role: s.role as any,
              permissions: [],
            },
          },
        },
      }),
    ),
  )

  // Create orders and payments (last 30 days)
  const orders: any[] = []
  const payments: any[] = []

  const now = new Date()

  for (let i = 0; i < 50; i++) {
    // Random date in last 30 days
    const daysAgo = Math.floor(Math.random() * 30)
    const orderDate = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000)

    // Random items (1-5 products)
    const numItems = Math.floor(Math.random() * 4) + 1
    const orderTotal = numItems * (Math.random() * 200 + 50) // $50-$250

    const order = await prisma.order.create({
      data: {
        venueId: venue.id,
        orderNumber: `TEST-${i + 1}`,
        total: new Prisma.Decimal(orderTotal),
        subtotal: new Prisma.Decimal(orderTotal * 0.9),
        taxAmount: new Prisma.Decimal(orderTotal * 0.1),
        status: 'COMPLETED',
        createdAt: orderDate,
        createdById: staff[Math.floor(Math.random() * staff.length)].id,
      },
    })

    orders.push(order)

    // Create payment for order
    const paymentMethod = ['CASH', 'CREDIT_CARD', 'DEBIT_CARD'][Math.floor(Math.random() * 3)] as any
    const tipAmount = orderTotal * (Math.random() * 0.2) // 0-20% tip
    const totalAmount = orderTotal + tipAmount

    // Calculate fees (2.9% for cards, 0% for cash)
    const feePercentage = paymentMethod === 'CASH' ? 0 : 0.029
    const feeAmount = totalAmount * feePercentage
    const netAmount = totalAmount - feeAmount

    const payment = await prisma.payment.create({
      data: {
        venueId: venue.id,
        orderId: order.id,
        amount: new Prisma.Decimal(orderTotal),
        tipAmount: new Prisma.Decimal(tipAmount),
        method: paymentMethod,
        status: 'COMPLETED',
        createdAt: orderDate,
        processedById: staff[Math.floor(Math.random() * staff.length)].id,
        feePercentage: new Prisma.Decimal(feePercentage),
        feeAmount: new Prisma.Decimal(feeAmount),
        netAmount: new Prisma.Decimal(netAmount),
      },
    })

    payments.push(payment)
  }

  // Create reviews (last 30 days)
  const reviews: any[] = []

  for (let i = 0; i < 20; i++) {
    const daysAgo = Math.floor(Math.random() * 30)
    const reviewDate = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000)

    // Rating distribution: mostly 4-5 stars
    const rating = Math.random() < 0.7 ? (Math.random() < 0.5 ? 5 : 4) : Math.floor(Math.random() * 3) + 1

    const review = await prisma.review.create({
      data: {
        venueId: venue.id,
        overallRating: rating,
        foodRating: rating,
        serviceRating: rating,
        ambienceRating: rating,
        comment: `Test review ${i + 1}`,
        source: 'GOOGLE',
        createdAt: reviewDate,
      },
    })

    reviews.push(review)
  }

  return {
    venue: {
      id: venue.id,
      name: venue.name,
      slug: venue.slug,
      timezone: venue.timezone,
      currency: venue.currency,
    },
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
    },
    organization: { id: org.id },
    staff: staff.map((s: any) => ({ id: s.id, name: `${s.firstName} ${s.lastName}` })),
    products: products.map((p: any) => ({ id: p.id, name: p.name })),
    orders: orders.map(o => ({ id: o.id, total: o.total.toNumber() })),
    payments: payments.map(p => ({ id: p.id, amount: p.amount.toNumber() })),
    reviews: reviews.map(r => ({ id: r.id, rating: r.overallRating })),
  }
}

/**
 * Cleanup test data
 *
 * Deletes all test data created by setupTestData().
 */
export async function teardownTestData(): Promise<void> {
  // Delete in reverse order of dependencies
  await prisma.payment.deleteMany({
    where: {
      venue: {
        name: 'Test Restaurant',
      },
    },
  })

  await prisma.orderItem.deleteMany({
    where: {
      order: {
        venue: {
          name: 'Test Restaurant',
        },
      },
    },
  })

  await prisma.order.deleteMany({
    where: {
      venue: {
        name: 'Test Restaurant',
      },
    },
  })

  await prisma.review.deleteMany({
    where: {
      venue: {
        name: 'Test Restaurant',
      },
    },
  })

  await prisma.product.deleteMany({
    where: {
      venue: {
        name: 'Test Restaurant',
      },
    },
  })

  await prisma.menuCategory.deleteMany({
    where: {
      venue: {
        name: 'Test Restaurant',
      },
    },
  })

  await prisma.staffVenue.deleteMany({
    where: {
      venue: {
        name: 'Test Restaurant',
      },
    },
  })

  await prisma.staff.deleteMany({
    where: {
      email: {
        contains: '@test.com',
      },
    },
  })

  // Delete staff first (foreign key dependency)
  await prisma.staff.deleteMany({
    where: {
      email: { contains: '@avoqado.com' },
    },
  })

  await prisma.venue.deleteMany({
    where: {
      name: 'Test Restaurant',
    },
  })

  await prisma.organization.deleteMany({
    where: {
      name: 'Test Restaurant Group',
    },
  })
}
