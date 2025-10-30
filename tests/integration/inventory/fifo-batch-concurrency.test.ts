/**
 * FIFO Batch Concurrency Integration Tests
 *
 * ⚠️ CRITICAL: These tests verify that row-level locking prevents race conditions
 * in concurrent stock deductions. This is essential for production reliability.
 *
 * World-Class Pattern: Shopify Inventory Reservation System
 *
 * Tests:
 * - 2 simultaneous orders for same product (limited stock)
 * - FOR UPDATE NOWAIT behavior with PostgreSQL
 * - No double deduction in concurrent scenarios
 * - Stress test: 10 concurrent orders
 *
 * Uses REAL PostgreSQL database, NOT mocks!
 */

import prisma from '@/utils/prismaClient'
import { setupTestData, teardownTestData } from '@tests/helpers/test-data-setup'
import { setupLimitedStock, createOrder, cleanupInventoryTestData, createStockBatch } from '@tests/helpers/inventory-test-helpers'
import { recordOrderPayment } from '@/services/tpv/payment.tpv.service'
import { deductStockFIFO } from '@/services/dashboard/fifoBatch.service'
import { Prisma } from '@prisma/client'

// Increase timeout for integration tests (Neon cold start can be slow)
jest.setTimeout(60000)

describe('FIFO Batch Concurrency - Race Condition Prevention', () => {
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

  describe('Concurrent Order Processing', () => {
    it('should handle 2 simultaneous orders for same product (limited stock)', async () => {
      // Setup: Product with only 10 units total stock
      const category = await prisma.menuCategory.create({
        data: {
          venueId: testData.venue.id,
          name: 'Concurrency Test',
          slug: `test-${Date.now()}`,
        },
      })

      const scenario = await setupLimitedStock(testData.venue.id, category.id, testData.staff[0].id, {
        productName: 'Limited Burger',
        stockQuantity: 10, // Only 10 KG available
        recipeQuantity: 1, // 1 KG per burger
        costPerUnit: 5,
      })

      // Create 2 orders (8 burgers each = 16 total, exceeds 10 available)
      const order1 = await createOrder(testData.venue.id, testData.staff[0].id, [{ productId: scenario.product.id, quantity: 8 }])

      const order2 = await createOrder(testData.venue.id, testData.staff[1].id, [{ productId: scenario.product.id, quantity: 8 }])

      // Process payments concurrently
      const payment1Promise = recordOrderPayment(
        testData.venue.id,
        order1.id,
        {
          venueId: testData.venue.id,
          amount: parseFloat(order1.total.toString()) * 100, // cents
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

      const payment2Promise = recordOrderPayment(
        testData.venue.id,
        order2.id,
        {
          venueId: testData.venue.id,
          amount: parseFloat(order2.total.toString()) * 100, // cents
          tip: 0,
          status: 'COMPLETED',
          method: 'CASH',
          source: 'TPV',
          splitType: 'FULLPAYMENT',
          tpvId: 'test-tpv',
          staffId: testData.staff[1].id,
          paidProductsId: [],
          currency: 'MXN',
          isInternational: false,
        },
        testData.staff[1].id,
      )

      // Execute concurrently
      const results = await Promise.allSettled([payment1Promise, payment2Promise])

      // Verify: One payment succeeds, one fails
      const succeeded = results.filter(r => r.status === 'fulfilled')
      const failed = results.filter(r => r.status === 'rejected')

      expect(succeeded.length).toBe(1)
      expect(failed.length).toBe(1)

      // Verify: Failed payment mentions insufficient inventory
      const failedResult = failed[0] as PromiseRejectedResult
      expect(failedResult.reason.message).toMatch(/insufficient inventory/i)

      // Verify: Stock is correct (10 - 8 = 2 KG remaining)
      const finalBatch = await prisma.stockBatch.findFirst({
        where: { venueId: testData.venue.id },
        orderBy: { createdAt: 'desc' },
      })

      expect(parseFloat(finalBatch!.remainingQuantity.toString())).toBe(2)

      // Verify: No double deduction (only 1 usage movement)
      const movements = await prisma.rawMaterialMovement.findMany({
        where: {
          venueId: testData.venue.id,
          type: 'USAGE',
        },
      })

      expect(movements.length).toBe(1) // Only one deduction happened
      expect(parseFloat(movements[0].quantity.toString())).toBe(-8) // 8 KG deducted
    })

    it('should handle concurrent FIFO deductions at low level', async () => {
      // Direct test of deductStockFIFO with concurrency
      const category = await prisma.menuCategory.create({
        data: {
          venueId: testData.venue.id,
          name: 'Low Level Test',
          slug: `test-${Date.now()}`,
        },
      })

      // Create raw material
      const rawMaterial = await prisma.rawMaterial.create({
        data: {
          venueId: testData.venue.id,
          name: 'Concurrent Test Material',
          sku: 'CONC-001',
          unit: 'KILOGRAM',
          unitType: 'WEIGHT',
          costPerUnit: new Prisma.Decimal(10),
          avgCostPerUnit: new Prisma.Decimal(10),
          currentStock: new Prisma.Decimal(0),
          minimumStock: new Prisma.Decimal(0),
          reorderPoint: new Prisma.Decimal(0),
          active: true,
        },
      })

      // Create batch with limited stock
      await createStockBatch(testData.venue.id, rawMaterial.id, {
        quantity: 5,
        costPerUnit: 10,
        receivedDate: new Date('2025-01-01'),
        batchNumber: `BATCH-CONC-${Date.now()}`,
      })

      // Try to deduct 3 KG twice concurrently (total 6 KG, but only 5 available)
      const deduct1 = deductStockFIFO(testData.venue.id, rawMaterial.id, 3, 'USAGE', {
        reason: 'Concurrent test 1',
        reference: 'test-1',
      })

      const deduct2 = deductStockFIFO(testData.venue.id, rawMaterial.id, 3, 'USAGE', {
        reason: 'Concurrent test 2',
        reference: 'test-2',
      })

      const results = await Promise.allSettled([deduct1, deduct2])

      // Log errors for debugging
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          console.log(`❌ Deduction ${i + 1} failed:`, r.reason?.message || r.reason)
        } else {
          console.log(`✅ Deduction ${i + 1} succeeded`)
        }
      })

      // One should succeed, one should fail
      const succeeded = results.filter(r => r.status === 'fulfilled')
      const failed = results.filter(r => r.status === 'rejected')

      expect(succeeded.length).toBe(1)
      expect(failed.length).toBe(1)

      // Verify final stock: 5 - 3 = 2 KG
      const finalMaterial = await prisma.rawMaterial.findUnique({
        where: { id: rawMaterial.id },
      })

      expect(parseFloat(finalMaterial!.currentStock.toString())).toBe(2)
    })

    it('should handle 5 concurrent orders gracefully (stress test)', async () => {
      // Stress test: Multiple concurrent orders for same product
      const category = await prisma.menuCategory.create({
        data: {
          venueId: testData.venue.id,
          name: 'Stress Test',
          slug: `test-${Date.now()}`,
        },
      })

      const scenario = await setupLimitedStock(testData.venue.id, category.id, testData.staff[0].id, {
        productName: 'Stress Test Product',
        stockQuantity: 20, // 20 KG available
        recipeQuantity: 2, // 2 KG per unit (max 10 units)
        costPerUnit: 5,
      })

      // Create 5 orders (3 units each = 6 KG each, 30 KG total needed, only 20 available)
      const orders = await Promise.all(
        Array.from({ length: 5 }).map((_, i) =>
          createOrder(testData.venue.id, testData.staff[0].id, [{ productId: scenario.product.id, quantity: 3 }]),
        ),
      )

      // Process all payments concurrently
      const paymentPromises = orders.map((order: any) =>
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
      )

      const results = await Promise.allSettled(paymentPromises)

      const succeeded = results.filter((r: any) => r.status === 'fulfilled')
      const failed = results.filter((r: any) => r.status === 'rejected')

      // Max 3 orders can succeed (3 orders × 3 units × 2 KG = 18 KG ≤ 20 KG)
      // Remaining 2 orders should fail
      expect(succeeded.length).toBeLessThanOrEqual(3)
      expect(failed.length).toBeGreaterThanOrEqual(2)

      // Verify: Final stock should be correct
      const finalBatch = await prisma.stockBatch.findFirst({
        where: { venueId: testData.venue.id },
        orderBy: { createdAt: 'desc' },
      })

      const finalStock = parseFloat(finalBatch!.remainingQuantity.toString())
      expect(finalStock).toBeGreaterThanOrEqual(0) // Should not go negative
      expect(finalStock).toBeLessThanOrEqual(20) // Should not exceed initial

      // Verify: No orphan movements or double deductions
      const movements = await prisma.rawMaterialMovement.findMany({
        where: {
          venueId: testData.venue.id,
          type: 'USAGE',
        },
      })

      const totalDeducted = movements.reduce((sum, m) => sum + Math.abs(parseFloat(m.quantity.toString())), 0)

      expect(totalDeducted).toBeLessThanOrEqual(20) // Cannot deduct more than available
    })
  })

  describe('FIFO Row-Level Locking Behavior', () => {
    it('should use FOR UPDATE NOWAIT (fail fast, no deadlocks)', async () => {
      // This test verifies that PostgreSQL row-level locking works
      // We can't directly test SQL commands, but we verify the behavior

      const category = await prisma.menuCategory.create({
        data: {
          venueId: testData.venue.id,
          name: 'Locking Test',
          slug: `test-${Date.now()}`,
        },
      })

      const rawMaterial = await prisma.rawMaterial.create({
        data: {
          venueId: testData.venue.id,
          name: 'Lock Test Material',
          sku: 'LOCK-001',
          unit: 'KILOGRAM',
          unitType: 'WEIGHT',
          costPerUnit: new Prisma.Decimal(10),
          avgCostPerUnit: new Prisma.Decimal(10),
          currentStock: new Prisma.Decimal(0),
          minimumStock: new Prisma.Decimal(0),
          reorderPoint: new Prisma.Decimal(0),
          active: true,
        },
      })

      await createStockBatch(testData.venue.id, rawMaterial.id, {
        quantity: 10,
        costPerUnit: 10,
        receivedDate: new Date('2025-01-01'),
        batchNumber: `BATCH-LOCK-${Date.now()}`,
      })

      // Rapid-fire concurrent deductions
      const deductions = Array.from({ length: 10 }).map(() =>
        deductStockFIFO(testData.venue.id, rawMaterial.id, 2, 'USAGE', {
          reason: 'Lock test',
          reference: `test-${Math.random()}`,
        }),
      )

      const results = await Promise.allSettled(deductions)

      // Some succeed, some fail due to locking or insufficient stock
      const succeeded = results.filter(r => r.status === 'fulfilled')
      const failed = results.filter(r => r.status === 'rejected')

      // Cannot succeed more than 5 times (10 KG / 2 KG = 5)
      expect(succeeded.length).toBeLessThanOrEqual(5)

      // Verify: Final stock should be exactly correct
      const finalMaterial = await prisma.rawMaterial.findUnique({
        where: { id: rawMaterial.id },
      })

      const finalStock = parseFloat(finalMaterial!.currentStock.toString())
      expect(finalStock).toBeGreaterThanOrEqual(0)
      expect(finalStock).toBe(10 - succeeded.length * 2)
    })
  })

  describe('REGRESSION TESTS - Existing Functionality', () => {
    it('should still handle sequential orders correctly (non-concurrent)', async () => {
      // Verify that normal sequential processing still works
      const category = await prisma.menuCategory.create({
        data: {
          venueId: testData.venue.id,
          name: 'Sequential Test',
          slug: `test-${Date.now()}`,
        },
      })

      const scenario = await setupLimitedStock(testData.venue.id, category.id, testData.staff[0].id, {
        productName: 'Sequential Product',
        stockQuantity: 10,
        recipeQuantity: 1,
        costPerUnit: 5,
      })

      // Process orders sequentially
      const order1 = await createOrder(testData.venue.id, testData.staff[0].id, [{ productId: scenario.product.id, quantity: 3 }])

      await recordOrderPayment(
        testData.venue.id,
        order1.id,
        {
          venueId: testData.venue.id,
          amount: parseFloat(order1.total.toString()) * 100,
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

      const order2 = await createOrder(testData.venue.id, testData.staff[0].id, [{ productId: scenario.product.id, quantity: 5 }])

      await recordOrderPayment(
        testData.venue.id,
        order2.id,
        {
          venueId: testData.venue.id,
          amount: parseFloat(order2.total.toString()) * 100,
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

      // Verify: Stock should be 10 - 3 - 5 = 2 KG
      const finalBatch = await prisma.stockBatch.findFirst({
        where: { venueId: testData.venue.id },
        orderBy: { createdAt: 'desc' },
      })

      expect(parseFloat(finalBatch!.remainingQuantity.toString())).toBe(2)
    })
  })
})
