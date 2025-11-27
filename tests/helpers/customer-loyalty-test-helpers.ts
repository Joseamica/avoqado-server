/**
 * Customer & Loyalty Test Helpers
 *
 * Helper functions for setting up customer/loyalty test data:
 * - Customers with loyalty points
 * - Customer groups
 * - Loyalty configurations
 * - Loyalty transactions
 *
 * Used by integration tests to verify customer/loyalty flows.
 */

import prisma from '@/utils/prismaClient'
import { Customer, CustomerGroup, LoyaltyConfig, LoyaltyTransaction, LoyaltyTransactionType } from '@prisma/client'

export interface TestCustomerData {
  customer: Customer
  loyaltyPoints: number
}

export interface TestLoyaltyData {
  config: LoyaltyConfig
  customers: Customer[]
  transactions: LoyaltyTransaction[]
}

/**
 * Create a test customer with optional initial loyalty points
 */
export async function createTestCustomer(
  venueId: string,
  data: {
    email: string
    phone: string
    firstName?: string
    lastName?: string
    customerGroupId?: string
    initialPoints?: number
  },
): Promise<TestCustomerData> {
  const customer = await prisma.customer.create({
    data: {
      venueId,
      email: data.email,
      phone: data.phone,
      firstName: data.firstName || 'Test',
      lastName: data.lastName || 'Customer',
      loyaltyPoints: data.initialPoints || 0,
      customerGroupId: data.customerGroupId || null,
      totalSpent: 0,
      averageOrderValue: 0,
      totalVisits: 0,
      lastVisitAt: null,
      active: true,
    },
  })

  return {
    customer,
    loyaltyPoints: data.initialPoints || 0,
  }
}

/**
 * Create a test customer group
 */
export async function createTestCustomerGroup(
  venueId: string,
  data: {
    name: string
    color?: string
    description?: string
    autoAssignRules?: any
  },
): Promise<CustomerGroup> {
  const group = await prisma.customerGroup.create({
    data: {
      venueId,
      name: data.name,
      color: data.color || '#3B82F6',
      description: data.description || null,
      autoAssignRules: data.autoAssignRules || null,
      active: true,
    },
  })

  return group
}

/**
 * Create or update loyalty config for a venue
 */
export async function createTestLoyaltyConfig(
  venueId: string,
  data?: Partial<{
    pointsPerDollar: number
    pointsPerVisit: number
    redemptionRate: number
    minPointsRedeem: number
    pointsExpireDays: number | null
    active: boolean
  }>,
): Promise<LoyaltyConfig> {
  // Check if config already exists
  const existingConfig = await prisma.loyaltyConfig.findUnique({
    where: { venueId },
  })

  if (existingConfig) {
    // Update existing
    return prisma.loyaltyConfig.update({
      where: { venueId },
      data: {
        pointsPerDollar: data?.pointsPerDollar ?? 1,
        pointsPerVisit: data?.pointsPerVisit ?? 0,
        redemptionRate: data?.redemptionRate ?? 0.01,
        minPointsRedeem: data?.minPointsRedeem ?? 100,
        pointsExpireDays: data?.pointsExpireDays !== undefined ? data.pointsExpireDays : 365,
        active: data?.active ?? true,
      },
    })
  }

  // Create new
  const config = await prisma.loyaltyConfig.create({
    data: {
      venueId,
      pointsPerDollar: data?.pointsPerDollar ?? 1,
      pointsPerVisit: data?.pointsPerVisit ?? 0,
      redemptionRate: data?.redemptionRate ?? 0.01,
      minPointsRedeem: data?.minPointsRedeem ?? 100,
      pointsExpireDays: data?.pointsExpireDays !== undefined ? data.pointsExpireDays : 365,
      active: data?.active ?? true,
    },
  })

  return config
}

/**
 * Award loyalty points to a customer and verify they were recorded
 */
export async function awardAndVerifyPoints(
  customerId: string,
  venueId: string,
  points: number,
  reason: string,
  orderId?: string,
  staffId?: string,
): Promise<LoyaltyTransaction> {
  // Ensure config exists
  await createTestLoyaltyConfig(venueId)

  // Create transaction
  const transaction = await prisma.loyaltyTransaction.create({
    data: {
      customerId,
      type: LoyaltyTransactionType.EARN,
      points,
      reason,
      orderId: orderId || null,
      createdById: staffId || null,
    },
  })

  // Update customer balance
  await prisma.customer.update({
    where: { id: customerId },
    data: {
      loyaltyPoints: { increment: points },
    },
  })

  return transaction
}

/**
 * Redeem loyalty points and verify transaction
 */
export async function redeemAndVerifyPoints(
  customerId: string,
  venueId: string,
  points: number,
  orderId: string,
  staffId?: string,
): Promise<{ transaction: LoyaltyTransaction; discountAmount: number; newBalance: number }> {
  // Get config for discount calculation
  const config = await createTestLoyaltyConfig(venueId)

  // Get current balance
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { loyaltyPoints: true },
  })

  if (!customer) {
    throw new Error('Customer not found')
  }

  if (customer.loyaltyPoints < points) {
    throw new Error('Insufficient points')
  }

  // Calculate discount
  const redemptionRate = typeof config.redemptionRate === 'number' ? config.redemptionRate : parseFloat(config.redemptionRate.toString())
  const discountAmount = points * redemptionRate

  // Create REDEEM transaction (negative points)
  const transaction = await prisma.loyaltyTransaction.create({
    data: {
      customerId,
      type: LoyaltyTransactionType.REDEEM,
      points: -points,
      reason: `Redeemed ${points} points for $${discountAmount.toFixed(2)} discount`,
      orderId,
      createdById: staffId || null,
    },
  })

  // Update customer balance
  const updatedCustomer = await prisma.customer.update({
    where: { id: customerId },
    data: {
      loyaltyPoints: { decrement: points },
    },
    select: { loyaltyPoints: true },
  })

  return {
    transaction,
    discountAmount: Math.round(discountAmount * 100) / 100,
    newBalance: updatedCustomer.loyaltyPoints,
  }
}

/**
 * Adjust points manually (bonus or penalty)
 */
export async function adjustPoints(
  customerId: string,
  points: number,
  reason: string,
  staffId: string,
): Promise<{ transaction: LoyaltyTransaction; newBalance: number }> {
  // Create ADJUST transaction
  const transaction = await prisma.loyaltyTransaction.create({
    data: {
      customerId,
      type: LoyaltyTransactionType.ADJUST,
      points,
      reason,
      createdById: staffId,
    },
  })

  // Update customer balance
  const updatedCustomer = await prisma.customer.update({
    where: { id: customerId },
    data: {
      loyaltyPoints: { increment: points },
    },
    select: { loyaltyPoints: true },
  })

  return {
    transaction,
    newBalance: updatedCustomer.loyaltyPoints,
  }
}

/**
 * Create an old loyalty transaction (for expiration testing)
 */
export async function createOldLoyaltyTransaction(
  customerId: string,
  points: number,
  daysAgo: number,
  reason: string = 'Old purchase',
): Promise<LoyaltyTransaction> {
  const oldDate = new Date()
  oldDate.setDate(oldDate.getDate() - daysAgo)

  const transaction = await prisma.loyaltyTransaction.create({
    data: {
      customerId,
      type: LoyaltyTransactionType.EARN,
      points,
      reason,
      createdAt: oldDate,
    },
  })

  // Also update customer balance
  await prisma.customer.update({
    where: { id: customerId },
    data: {
      loyaltyPoints: { increment: points },
    },
  })

  return transaction
}

/**
 * Cleanup all customer/loyalty test data for a venue
 */
export async function cleanupCustomerTestData(venueId: string): Promise<void> {
  // Delete in order to respect foreign keys
  await prisma.loyaltyTransaction.deleteMany({
    where: {
      customer: { venueId },
    },
  })

  await prisma.customer.deleteMany({
    where: { venueId },
  })

  await prisma.customerGroup.deleteMany({
    where: { venueId },
  })

  await prisma.loyaltyConfig.deleteMany({
    where: { venueId },
  })
}

/**
 * Get customer's current loyalty points balance
 */
export async function getCustomerBalance(customerId: string): Promise<number> {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { loyaltyPoints: true },
  })

  return customer?.loyaltyPoints || 0
}

/**
 * Verify loyalty transaction exists with expected values
 */
export async function verifyLoyaltyTransaction(
  customerId: string,
  type: LoyaltyTransactionType,
  expectedPoints: number,
  orderId?: string,
): Promise<LoyaltyTransaction | null> {
  const transaction = await prisma.loyaltyTransaction.findFirst({
    where: {
      customerId,
      type,
      points: expectedPoints,
      ...(orderId && { orderId }),
    },
    orderBy: { createdAt: 'desc' },
  })

  return transaction
}

/**
 * Create a complete test scenario with customer, group, and loyalty config
 */
export async function createCompleteTestScenario(
  venueId: string,
  options?: {
    customersCount?: number
    initialPoints?: number
    groupName?: string
  },
): Promise<TestLoyaltyData> {
  const config = await createTestLoyaltyConfig(venueId)

  const group = await createTestCustomerGroup(venueId, {
    name: options?.groupName || 'Test VIP Group',
    color: '#FFD700',
  })

  const customersCount = options?.customersCount || 3
  const customers: Customer[] = []

  for (let i = 0; i < customersCount; i++) {
    const { customer } = await createTestCustomer(venueId, {
      email: `test-customer-${i}@example.com`,
      phone: `+123456789${i}`,
      firstName: `TestFirst${i}`,
      lastName: `TestLast${i}`,
      customerGroupId: group.id,
      initialPoints: options?.initialPoints || 0,
    })
    customers.push(customer)
  }

  return {
    config,
    customers,
    transactions: [],
  }
}
