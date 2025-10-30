/**
 * Order → Payment → Inventory Flow Integration Tests
 *
 * ⚠️ CRITICAL: These tests verify the complete end-to-end flow
 * from order creation to payment processing to inventory deduction.
 *
 * World-Class Pattern: Shopify Order Processing Pipeline
 *
 * Tests:
 * - Full payment with sufficient stock (happy path)
 * - Full payment with insufficient stock (should fail)
 * - Partial payments (inventory deducted only when fully paid)
 * - Multiple items in one order
 * - Products without inventory tracking (should not fail)
 *
 * Uses REAL PostgreSQL database, NOT mocks!
 */

import prisma from '@/utils/prismaClient'
import { setupTestData, teardownTestData } from '@tests/helpers/test-data-setup'
import { setupLimitedStock, createOrder, cleanupInventoryTestData } from '@tests/helpers/inventory-test-helpers'
import { recordOrderPayment } from '@/services/tpv/payment.tpv.service'

// Increase timeout for integration tests (Neon cold start can be slow)
jest.setTimeout(60000)

describe('Order → Payment → Inventory Flow Integration', () => {
  let testData: Awaited<ReturnType<typeof setupTestData>>

  beforeAll(async () => {
    testData = await setupTestData()
  })

  afterAll(async () => {
    await cleanupInventoryTestData(testData.venue.id)
    await teardownTestData()
  })

  beforeEach(async () => {
    // Clean inventory data between tests
    await cleanupInventoryTestData(testData.venue.id)
  })

  describe('Happy Path - Full Payment with Sufficient Stock', () => {
    it('should successfully complete order and deduct inventory', async () => {
      // Setup: Product with sufficient stock
      const category = await prisma.menuCategory.create({
        data: {
          venueId: testData.venue.id,
          name: 'Happy Path Test',
          slug: `test-${Date.now()}`,
        },
      })

      const scenario = await setupLimitedStock(testData.venue.id, category.id, testData.staff[0].id, {
        productName: 'Happy Path Burger',
        stockQuantity: 20, // 20 KG available
        recipeQuantity: 2, // 2 KG per burger
        costPerUnit: 5,
      })

      // Create order for 5 burgers (10 KG needed, 20 KG available)
      const order = await createOrder(testData.venue.id, testData.staff[0].id, [{ productId: scenario.product.id, quantity: 5 }])

      // Verify order is PENDING before payment
      expect(order.status).toBe('PENDING')
      expect(order.paymentStatus).toBe('PENDING')

      // Process full payment
      const payment = await recordOrderPayment(
        testData.venue.id,
        order.id,
        {
          venueId: testData.venue.id,
          amount: parseFloat(order.total.toString()) * 100,
          tip: 0,
          status: 'COMPLETED',
          method: 'CASH',
          source: 'TPV',
          splitType: 'FULLPAYMENT',
          tpvId: 'test-tpv',
          staffId: testData.staff[0].id,
          paidProductsId: [],
          currency: 'MXN',
          isInternational: false,
        },
        testData.staff[0].id,
      )

      // Verify payment succeeded
      expect(payment).toBeDefined()

      // Verify order is COMPLETED
      const completedOrder = await prisma.order.findUnique({
        where: { id: order.id },
      })
      expect(completedOrder?.status).toBe('COMPLETED')
      expect(completedOrder?.paymentStatus).toBe('PAID')
      expect(completedOrder?.completedAt).not.toBeNull()

      // Verify inventory was deducted (20 - 10 = 10 KG)
      const finalBatch = await prisma.stockBatch.findFirst({
        where: { venueId: testData.venue.id },
        orderBy: { createdAt: 'desc' },
      })
      expect(parseFloat(finalBatch!.remainingQuantity.toString())).toBe(10)

      // Verify raw material stock was updated
      const finalMaterial = await prisma.rawMaterial.findFirst({
        where: { venueId: testData.venue.id },
      })
      expect(parseFloat(finalMaterial!.currentStock.toString())).toBe(10)

      // Verify movement record was created
      const movements = await prisma.rawMaterialMovement.findMany({
        where: {
          venueId: testData.venue.id,
          type: 'USAGE',
        },
      })
      expect(movements.length).toBe(1)
      expect(parseFloat(movements[0].quantity.toString())).toBe(-10) // Negative for deduction
    })
  })

  describe('Error Handling - Insufficient Stock', () => {
    it('should fail payment and rollback order when stock is insufficient', async () => {
      // Setup: Product with limited stock
      const category = await prisma.menuCategory.create({
        data: {
          venueId: testData.venue.id,
          name: 'Insufficient Stock Test',
          slug: `test-${Date.now()}`,
        },
      })

      const scenario = await setupLimitedStock(testData.venue.id, category.id, testData.staff[0].id, {
        productName: 'Limited Burger',
        stockQuantity: 5, // Only 5 KG available
        recipeQuantity: 2, // 2 KG per burger
        costPerUnit: 5,
      })

      // Create order for 5 burgers (10 KG needed, only 5 KG available)
      const order = await createOrder(testData.venue.id, testData.staff[0].id, [{ productId: scenario.product.id, quantity: 5 }])

      // Try to process full payment (should fail due to insufficient stock)
      await expect(
        recordOrderPayment(
          testData.venue.id,
          order.id,
          {
            venueId: testData.venue.id,
            amount: parseFloat(order.total.toString()) * 100,
            tip: 0,
            status: 'COMPLETED',
            method: 'CASH',
            source: 'TPV',
            splitType: 'FULLPAYMENT',
            tpvId: 'test-tpv',
            staffId: testData.staff[0].id,
            paidProductsId: [],
            currency: 'MXN',
            isInternational: false,
          },
          testData.staff[0].id,
        ),
      ).rejects.toThrow(/insufficient inventory/i)

      // Verify order was rolled back to PENDING
      const rolledBackOrder = await prisma.order.findUnique({
        where: { id: order.id },
      })
      expect(rolledBackOrder?.status).toBe('PENDING')
      expect(rolledBackOrder?.paymentStatus).toBe('PENDING') // No successful payment, so still PENDING
      expect(rolledBackOrder?.completedAt).toBeNull()

      // Verify no inventory was deducted (still 5 KG)
      const finalBatch = await prisma.stockBatch.findFirst({
        where: { venueId: testData.venue.id },
        orderBy: { createdAt: 'desc' },
      })
      expect(parseFloat(finalBatch!.remainingQuantity.toString())).toBe(5)

      // Verify no movement records were created
      const movements = await prisma.rawMaterialMovement.findMany({
        where: {
          venueId: testData.venue.id,
          type: 'USAGE',
        },
      })
      expect(movements.length).toBe(0)
    })
  })

  describe('Partial Payments - Inventory Deduction Timing', () => {
    it('should NOT deduct inventory on partial payment, only on full payment', async () => {
      // Setup: Product with sufficient stock
      const category = await prisma.menuCategory.create({
        data: {
          venueId: testData.venue.id,
          name: 'Partial Payment Test',
          slug: `test-${Date.now()}`,
        },
      })

      const scenario = await setupLimitedStock(testData.venue.id, category.id, testData.staff[0].id, {
        productName: 'Partial Payment Burger',
        stockQuantity: 20,
        recipeQuantity: 2,
        costPerUnit: 5,
      })

      const order = await createOrder(testData.venue.id, testData.staff[0].id, [
        { productId: scenario.product.id, quantity: 5 }, // 10 KG needed
      ])

      const orderTotal = parseFloat(order.total.toString())

      // Make first partial payment (50%)
      await recordOrderPayment(
        testData.venue.id,
        order.id,
        {
          venueId: testData.venue.id,
          amount: orderTotal * 0.5 * 100,
          tip: 0,
          status: 'COMPLETED',
          method: 'CASH',
          source: 'TPV',
          splitType: 'EQUALPARTS',
          tpvId: 'test-tpv',
          staffId: testData.staff[0].id,
          paidProductsId: [],
          currency: 'MXN',
          isInternational: false,
        },
        testData.staff[0].id,
      )

      // Verify order is still PENDING (partial payment)
      const partialOrder = await prisma.order.findUnique({
        where: { id: order.id },
      })
      expect(partialOrder?.status).toBe('PENDING')
      expect(partialOrder?.paymentStatus).toBe('PARTIAL')

      // Verify NO inventory was deducted yet (still 20 KG)
      let currentBatch = await prisma.stockBatch.findFirst({
        where: { venueId: testData.venue.id },
        orderBy: { createdAt: 'desc' },
      })
      expect(parseFloat(currentBatch!.remainingQuantity.toString())).toBe(20)

      // Make second payment to complete (remaining 50%)
      await recordOrderPayment(
        testData.venue.id,
        order.id,
        {
          venueId: testData.venue.id,
          amount: orderTotal * 0.5 * 100,
          tip: 0,
          status: 'COMPLETED',
          method: 'CASH',
          source: 'TPV',
          splitType: 'EQUALPARTS',
          tpvId: 'test-tpv',
          staffId: testData.staff[0].id,
          paidProductsId: [],
          currency: 'MXN',
          isInternational: false,
        },
        testData.staff[0].id,
      )

      // Verify order is now COMPLETED
      const completedOrder = await prisma.order.findUnique({
        where: { id: order.id },
      })
      expect(completedOrder?.status).toBe('COMPLETED')
      expect(completedOrder?.paymentStatus).toBe('PAID')

      // Verify inventory WAS deducted after full payment (20 - 10 = 10 KG)
      currentBatch = await prisma.stockBatch.findFirst({
        where: { venueId: testData.venue.id },
        orderBy: { createdAt: 'desc' },
      })
      expect(parseFloat(currentBatch!.remainingQuantity.toString())).toBe(10)
    })
  })

  describe('Multiple Items - Mixed Inventory Tracking', () => {
    it('should handle orders with multiple products (some tracked, some not)', async () => {
      const category = await prisma.menuCategory.create({
        data: {
          venueId: testData.venue.id,
          name: 'Mixed Items Test',
          slug: `test-${Date.now()}`,
        },
      })

      // Product 1: WITH inventory tracking
      const scenario1 = await setupLimitedStock(testData.venue.id, category.id, testData.staff[0].id, {
        productName: 'Tracked Burger',
        stockQuantity: 20,
        recipeQuantity: 2,
        costPerUnit: 5,
      })

      // Product 2: WITHOUT inventory tracking
      const product2 = await prisma.product.create({
        data: {
          venueId: testData.venue.id,
          categoryId: category.id,
          name: 'Untracked Soda',
          sku: `SODA-${Date.now()}`,
          price: 50,
          trackInventory: false, // No inventory tracking
          inventoryMethod: null,
        },
      })

      // Create order with both products
      const order = await createOrder(testData.venue.id, testData.staff[0].id, [
        { productId: scenario1.product.id, quantity: 3 }, // 6 KG tracked
        { productId: product2.id, quantity: 2 }, // Untracked
      ])

      // Process payment
      await recordOrderPayment(
        testData.venue.id,
        order.id,
        {
          venueId: testData.venue.id,
          amount: parseFloat(order.total.toString()) * 100,
          tip: 0,
          status: 'COMPLETED',
          method: 'CASH',
          source: 'TPV',
          splitType: 'FULLPAYMENT',
          tpvId: 'test-tpv',
          staffId: testData.staff[0].id,
          paidProductsId: [],
          currency: 'MXN',
          isInternational: false,
        },
        testData.staff[0].id,
      )

      // Verify order completed successfully
      const completedOrder = await prisma.order.findUnique({
        where: { id: order.id },
      })
      expect(completedOrder?.status).toBe('COMPLETED')

      // Verify only tracked product had inventory deducted (20 - 6 = 14 KG)
      const finalBatch = await prisma.stockBatch.findFirst({
        where: { venueId: testData.venue.id },
        orderBy: { createdAt: 'desc' },
      })
      expect(parseFloat(finalBatch!.remainingQuantity.toString())).toBe(14)

      // Verify movement records only for tracked product
      const movements = await prisma.rawMaterialMovement.findMany({
        where: {
          venueId: testData.venue.id,
          type: 'USAGE',
        },
      })
      expect(movements.length).toBe(1) // Only one movement for tracked item
      expect(parseFloat(movements[0].quantity.toString())).toBe(-6)
    })
  })

  describe('REGRESSION - Existing Flow Still Works', () => {
    it('should handle standard orders without breaking existing behavior', async () => {
      const category = await prisma.menuCategory.create({
        data: {
          venueId: testData.venue.id,
          name: 'Regression Test',
          slug: `test-${Date.now()}`,
        },
      })

      const scenario = await setupLimitedStock(testData.venue.id, category.id, testData.staff[0].id, {
        productName: 'Standard Burger',
        stockQuantity: 100,
        recipeQuantity: 1,
        costPerUnit: 5,
      })

      // Create and pay for order
      const order = await createOrder(testData.venue.id, testData.staff[0].id, [{ productId: scenario.product.id, quantity: 10 }])

      await recordOrderPayment(
        testData.venue.id,
        order.id,
        {
          venueId: testData.venue.id,
          amount: parseFloat(order.total.toString()) * 100,
          tip: 0,
          status: 'COMPLETED',
          method: 'CASH',
          source: 'TPV',
          splitType: 'FULLPAYMENT',
          tpvId: 'test-tpv',
          staffId: testData.staff[0].id,
          paidProductsId: [],
          currency: 'MXN',
          isInternational: false,
        },
        testData.staff[0].id,
      )

      // Verify everything worked as expected
      const completedOrder = await prisma.order.findUnique({
        where: { id: order.id },
      })
      expect(completedOrder?.status).toBe('COMPLETED')

      const finalBatch = await prisma.stockBatch.findFirst({
        where: { venueId: testData.venue.id },
        orderBy: { createdAt: 'desc' },
      })
      expect(parseFloat(finalBatch!.remainingQuantity.toString())).toBe(90)
    })
  })
})
