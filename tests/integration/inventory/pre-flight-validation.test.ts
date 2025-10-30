/**
 * Pre-Flight Validation Integration Tests
 *
 * ⚠️ CRITICAL: These tests verify that inventory is validated BEFORE payment capture.
 * This prevents charging customers for orders we can't fulfill.
 *
 * World-Class Pattern: Stripe Payment Intent Flow
 *
 * Tests:
 * - Validate inventory before full payment
 * - Reject payment if any item has insufficient stock
 * - Allow payment if all items have sufficient stock
 * - Handle partial payments (no validation until fully paid)
 * - Validate across multiple products in one order
 *
 * Uses REAL PostgreSQL database, NOT mocks!
 */

import prisma from '@/utils/prismaClient'
import { setupTestData, teardownTestData } from '@tests/helpers/test-data-setup'
import { setupLimitedStock, createOrder, cleanupInventoryTestData } from '@tests/helpers/inventory-test-helpers'
import { recordOrderPayment } from '@/services/tpv/payment.tpv.service'

// Increase timeout for integration tests (Neon cold start can be slow)
jest.setTimeout(60000)

describe('Pre-Flight Validation - Inventory Check Before Payment', () => {
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

  describe('Pre-Flight Validation on Full Payment', () => {
    it('should validate inventory BEFORE capturing full payment', async () => {
      // Setup: Product with limited stock
      const category = await prisma.menuCategory.create({
        data: {
          venueId: testData.venue.id,
          name: 'Pre-flight Test',
          slug: `test-${Date.now()}`,
        },
      })

      const scenario = await setupLimitedStock(testData.venue.id, category.id, testData.staff[0].id, {
        productName: 'Burger',
        stockQuantity: 5, // Only 5 KG available
        recipeQuantity: 1, // 1 KG per burger
        costPerUnit: 10,
      })

      // Create order for 10 burgers (exceeds available stock)
      const order = await createOrder(testData.venue.id, testData.staff[0].id, [
        { productId: scenario.product.id, quantity: 10 }, // 10 KG needed, only 5 available
      ])

      // Try to process full payment (should fail during pre-flight validation)
      await expect(
        recordOrderPayment(
          testData.venue.id,
          order.id,
          {
            venueId: testData.venue.id,
            amount: parseFloat(order.total.toString()) * 100, // cents
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

      // Verify: No payment was created (pre-flight validation failed)
      const payments = await prisma.payment.findMany({
        where: { orderId: order.id, status: 'COMPLETED' },
      })
      expect(payments.length).toBe(0)

      // Verify: Order remains PENDING
      const finalOrder = await prisma.order.findUnique({
        where: { id: order.id },
      })
      expect(finalOrder?.status).toBe('PENDING')
      expect(finalOrder?.paymentStatus).toBe('PENDING')
    })

    it('should allow payment when all items have sufficient stock', async () => {
      // Setup: Product with sufficient stock
      const category = await prisma.menuCategory.create({
        data: {
          venueId: testData.venue.id,
          name: 'Sufficient Stock Test',
          slug: `test-${Date.now()}`,
        },
      })

      const scenario = await setupLimitedStock(testData.venue.id, category.id, testData.staff[0].id, {
        productName: 'Burger',
        stockQuantity: 20, // 20 KG available
        recipeQuantity: 1, // 1 KG per burger
        costPerUnit: 10,
      })

      // Create order for 5 burgers (well within stock limits)
      const order = await createOrder(testData.venue.id, testData.staff[0].id, [
        { productId: scenario.product.id, quantity: 5 }, // 5 KG needed, 20 available
      ])

      // Process full payment (should succeed)
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

      // Verify: Payment was created
      expect(payment).toBeDefined()
      expect(payment.status).toBe('COMPLETED')

      // Verify: Order is completed
      const finalOrder = await prisma.order.findUnique({
        where: { id: order.id },
      })
      expect(finalOrder?.status).toBe('COMPLETED')
      expect(finalOrder?.paymentStatus).toBe('PAID')
    })
  })

  describe('Pre-Flight Validation with Multiple Products', () => {
    it('should reject payment if ANY product has insufficient stock', async () => {
      const category = await prisma.menuCategory.create({
        data: {
          venueId: testData.venue.id,
          name: 'Multi-Product Test',
          slug: `test-${Date.now()}`,
        },
      })

      // Product 1: Sufficient stock
      const scenario1 = await setupLimitedStock(testData.venue.id, category.id, testData.staff[0].id, {
        productName: 'Burger',
        stockQuantity: 20,
        recipeQuantity: 1,
        costPerUnit: 10,
      })

      // Product 2: Insufficient stock
      const scenario2 = await setupLimitedStock(testData.venue.id, category.id, testData.staff[0].id, {
        productName: 'Fries',
        stockQuantity: 3, // Only 3 KG available
        recipeQuantity: 0.5, // 0.5 KG per order
        costPerUnit: 5,
      })

      // Create order with both products
      const order = await createOrder(testData.venue.id, testData.staff[0].id, [
        { productId: scenario1.product.id, quantity: 2 }, // 2 KG burger (sufficient)
        { productId: scenario2.product.id, quantity: 10 }, // 5 KG fries (insufficient - only 3 KG available)
      ])

      // Try to process payment (should fail due to fries)
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

      // Verify: No inventory was deducted for either product
      const burgerStock = await prisma.rawMaterial.findFirst({
        where: { venueId: testData.venue.id, name: scenario1.rawMaterial.name },
      })
      const friesStock = await prisma.rawMaterial.findFirst({
        where: { venueId: testData.venue.id, name: scenario2.rawMaterial.name },
      })

      expect(parseFloat(burgerStock!.currentStock.toString())).toBe(20) // No deduction
      expect(parseFloat(friesStock!.currentStock.toString())).toBe(3) // No deduction
    })

    it('should succeed if all products have sufficient stock', async () => {
      const category = await prisma.menuCategory.create({
        data: {
          venueId: testData.venue.id,
          name: 'Multi-Product Success Test',
          slug: `test-${Date.now()}`,
        },
      })

      // Product 1: Sufficient stock
      const scenario1 = await setupLimitedStock(testData.venue.id, category.id, testData.staff[0].id, {
        productName: 'Burger',
        stockQuantity: 20,
        recipeQuantity: 1,
        costPerUnit: 10,
      })

      // Product 2: Sufficient stock
      const scenario2 = await setupLimitedStock(testData.venue.id, category.id, testData.staff[0].id, {
        productName: 'Fries',
        stockQuantity: 10,
        recipeQuantity: 0.5,
        costPerUnit: 5,
      })

      // Create order with both products (both have enough stock)
      const order = await createOrder(testData.venue.id, testData.staff[0].id, [
        { productId: scenario1.product.id, quantity: 5 }, // 5 KG burger (20 available)
        { productId: scenario2.product.id, quantity: 10 }, // 5 KG fries (10 available)
      ])

      // Process payment (should succeed)
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

      expect(payment).toBeDefined()

      // Verify: Inventory was deducted correctly
      const burgerStock = await prisma.rawMaterial.findFirst({
        where: { venueId: testData.venue.id, name: scenario1.rawMaterial.name },
      })
      const friesStock = await prisma.rawMaterial.findFirst({
        where: { venueId: testData.venue.id, name: scenario2.rawMaterial.name },
      })

      expect(parseFloat(burgerStock!.currentStock.toString())).toBe(15) // 20 - 5
      expect(parseFloat(friesStock!.currentStock.toString())).toBe(5) // 10 - 5
    })
  })

  describe('Partial Payments - No Pre-Flight Validation', () => {
    it('should NOT validate inventory on partial payments', async () => {
      const category = await prisma.menuCategory.create({
        data: {
          venueId: testData.venue.id,
          name: 'Partial Payment No Validation',
          slug: `test-${Date.now()}`,
        },
      })

      const scenario = await setupLimitedStock(testData.venue.id, category.id, testData.staff[0].id, {
        productName: 'Burger',
        stockQuantity: 3, // Only 3 KG available
        recipeQuantity: 1,
        costPerUnit: 10,
      })

      // Create order for 10 burgers (exceeds stock)
      const order = await createOrder(testData.venue.id, testData.staff[0].id, [
        { productId: scenario.product.id, quantity: 10 }, // 10 KG needed, only 3 available
      ])

      const orderTotal = parseFloat(order.total.toString())

      // Make partial payment (50%) - should succeed without validation
      const payment = await recordOrderPayment(
        testData.venue.id,
        order.id,
        {
          venueId: testData.venue.id,
          amount: orderTotal * 0.5 * 100, // 50% in cents
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

      // Verify: Partial payment succeeded (no validation)
      expect(payment).toBeDefined()
      expect(payment.status).toBe('COMPLETED')

      // Verify: Order is still PENDING (not fully paid)
      const partialOrder = await prisma.order.findUnique({
        where: { id: order.id },
      })
      expect(partialOrder?.status).toBe('PENDING')
      expect(partialOrder?.paymentStatus).toBe('PARTIAL')

      // Try to complete with second payment (should NOW fail validation)
      await expect(
        recordOrderPayment(
          testData.venue.id,
          order.id,
          {
            venueId: testData.venue.id,
            amount: orderTotal * 0.5 * 100, // Remaining 50%
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
        ),
      ).rejects.toThrow(/insufficient inventory/i)

      // Verify: Order is still PENDING (payment failed due to validation)
      const finalOrder = await prisma.order.findUnique({
        where: { id: order.id },
      })
      expect(finalOrder?.status).toBe('PENDING')
      expect(finalOrder?.paymentStatus).toBe('PARTIAL') // First payment succeeded, second failed
    })
  })

  describe('REGRESSION - Products Without Inventory Tracking', () => {
    it('should allow payment for products without inventory tracking', async () => {
      const category = await prisma.menuCategory.create({
        data: {
          venueId: testData.venue.id,
          name: 'No Tracking Test',
          slug: `test-${Date.now()}`,
        },
      })

      // Product WITHOUT inventory tracking
      const product = await prisma.product.create({
        data: {
          venueId: testData.venue.id,
          categoryId: category.id,
          name: 'Digital Service',
          sku: `SERVICE-${Date.now()}`,
          price: 100,
          trackInventory: false, // No tracking
          inventoryMethod: null,
        },
      })

      const order = await createOrder(testData.venue.id, testData.staff[0].id, [
        { productId: product.id, quantity: 5 }, // No inventory to check
      ])

      // Process payment (should succeed without validation)
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

      expect(payment).toBeDefined()

      // Verify: Order completed successfully
      const finalOrder = await prisma.order.findUnique({
        where: { id: order.id },
      })
      expect(finalOrder?.status).toBe('COMPLETED')
      expect(finalOrder?.paymentStatus).toBe('PAID')
    })
  })
})
