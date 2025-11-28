/**
 * Integration Tests: TPV Customer Lookup
 *
 * Tests the customer lookup flow at checkout with real database.
 * Covers: search by phone, email, general search, quick create, recent customers.
 *
 * @see src/services/tpv/customer.tpv.service.ts
 */

import '../../__helpers__/integration-setup'
import prisma from '@/utils/prismaClient'
import * as customerTpvService from '@/services/tpv/customer.tpv.service'

describe('TPV Customer Lookup - Integration Tests', () => {
  let testVenueId: string
  let testCustomerId: string
  let testCustomerGroupId: string

  // Setup: Create test venue and customers
  beforeAll(async () => {
    // Create test organization
    const org = await prisma.organization.create({
      data: {
        name: 'TPV Customer Test Org',
        email: `tpv-test-${Date.now()}@test.com`,
        phone: '5550000000',
      },
    })

    // Create test venue
    const venue = await prisma.venue.create({
      data: {
        name: 'TPV Customer Test Venue',
        slug: `tpv-customer-test-venue-${Date.now()}`,
        organizationId: org.id,
        address: 'Test Address',
        city: 'Test City',
        state: 'Test State',
        country: 'MX',
        zipCode: '12345',
        timezone: 'America/Mexico_City',
      },
    })
    testVenueId = venue.id

    // Create customer group
    const group = await prisma.customerGroup.create({
      data: {
        venueId: testVenueId,
        name: 'VIP Test',
        color: '#FFD700',
      },
    })
    testCustomerGroupId = group.id

    // Create test customers with variety
    const customer1 = await prisma.customer.create({
      data: {
        venueId: testVenueId,
        firstName: 'María',
        lastName: 'González',
        email: 'maria.test@example.com',
        phone: '5551234567',
        customerGroupId: testCustomerGroupId,
        loyaltyPoints: 500,
        totalVisits: 15,
        totalSpent: 2500,
        lastVisitAt: new Date(),
      },
    })
    testCustomerId = customer1.id

    // Customer with only phone
    await prisma.customer.create({
      data: {
        venueId: testVenueId,
        firstName: 'Carlos',
        lastName: 'Hernández',
        phone: '5559876543',
        loyaltyPoints: 100,
        totalVisits: 5,
        totalSpent: 800,
        lastVisitAt: new Date(Date.now() - 86400000), // Yesterday
      },
    })

    // Customer with only email
    await prisma.customer.create({
      data: {
        venueId: testVenueId,
        firstName: 'Ana',
        lastName: 'López',
        email: 'ana.lopez@test.com',
        loyaltyPoints: 200,
        totalVisits: 8,
        totalSpent: 1200,
        lastVisitAt: new Date(Date.now() - 172800000), // 2 days ago
      },
    })

    // Inactive customer (should not appear in searches)
    await prisma.customer.create({
      data: {
        venueId: testVenueId,
        firstName: 'Inactive',
        lastName: 'Customer',
        phone: '5550000000',
        active: false,
      },
    })
  })

  // Cleanup: Remove test data
  afterAll(async () => {
    // Delete in correct order (foreign key constraints)
    await prisma.customer.deleteMany({ where: { venueId: testVenueId } })
    await prisma.customerGroup.deleteMany({ where: { venueId: testVenueId } })
    await prisma.venue.deleteMany({ where: { id: testVenueId } })
    await prisma.organization.deleteMany({ where: { email: { startsWith: 'tpv-test-' } } })
    await prisma.$disconnect()
  })

  // ==========================================
  // SEARCH BY PHONE
  // ==========================================

  describe('findCustomerByPhone', () => {
    it('should find customer by exact phone number', async () => {
      const results = await customerTpvService.findCustomerByPhone(testVenueId, '5551234567')

      expect(results).toHaveLength(1)
      expect(results[0].firstName).toBe('María')
      expect(results[0].phone).toBe('5551234567')
      expect(results[0].customerGroup).not.toBeNull()
      expect(results[0].customerGroup?.name).toBe('VIP Test')
    })

    it('should find customer by partial phone number', async () => {
      const results = await customerTpvService.findCustomerByPhone(testVenueId, '555123')

      expect(results.length).toBeGreaterThanOrEqual(1)
      expect(results[0].phone).toContain('555123')
    })

    it('should normalize phone with dashes/spaces', async () => {
      const results = await customerTpvService.findCustomerByPhone(testVenueId, '555-123-4567')

      expect(results).toHaveLength(1)
      expect(results[0].firstName).toBe('María')
    })

    it('should NOT return inactive customers', async () => {
      const results = await customerTpvService.findCustomerByPhone(testVenueId, '5550000000')

      expect(results).toHaveLength(0)
    })

    it('should return empty array for non-existent phone', async () => {
      const results = await customerTpvService.findCustomerByPhone(testVenueId, '9999999999')

      expect(results).toHaveLength(0)
    })

    it('should respect limit parameter', async () => {
      const results = await customerTpvService.findCustomerByPhone(testVenueId, '555', 1)

      expect(results).toHaveLength(1)
    })
  })

  // ==========================================
  // SEARCH BY EMAIL
  // ==========================================

  describe('findCustomerByEmail', () => {
    it('should find customer by exact email', async () => {
      const results = await customerTpvService.findCustomerByEmail(testVenueId, 'maria.test@example.com')

      expect(results).toHaveLength(1)
      expect(results[0].firstName).toBe('María')
      expect(results[0].email).toBe('maria.test@example.com')
    })

    it('should find customer by partial email (case insensitive)', async () => {
      const results = await customerTpvService.findCustomerByEmail(testVenueId, 'MARIA.TEST')

      expect(results.length).toBeGreaterThanOrEqual(1)
    })

    it('should return empty for non-existent email', async () => {
      const results = await customerTpvService.findCustomerByEmail(testVenueId, 'nonexistent@test.com')

      expect(results).toHaveLength(0)
    })
  })

  // ==========================================
  // GENERAL SEARCH
  // ==========================================

  describe('searchCustomers', () => {
    it('should search by firstName', async () => {
      const results = await customerTpvService.searchCustomers(testVenueId, 'María')

      expect(results.length).toBeGreaterThanOrEqual(1)
      expect(results[0].firstName).toBe('María')
    })

    it('should search by lastName', async () => {
      const results = await customerTpvService.searchCustomers(testVenueId, 'González')

      expect(results.length).toBeGreaterThanOrEqual(1)
      expect(results[0].lastName).toBe('González')
    })

    it('should search by email', async () => {
      const results = await customerTpvService.searchCustomers(testVenueId, 'ana.lopez')

      expect(results.length).toBeGreaterThanOrEqual(1)
      expect(results[0].email).toContain('ana.lopez')
    })

    it('should search by phone', async () => {
      const results = await customerTpvService.searchCustomers(testVenueId, '9876543')

      expect(results.length).toBeGreaterThanOrEqual(1)
      expect(results[0].phone).toContain('9876543')
    })

    it('should return empty for query less than 2 characters', async () => {
      const results = await customerTpvService.searchCustomers(testVenueId, 'M')

      expect(results).toHaveLength(0)
    })

    it('should return results with customer group info', async () => {
      const results = await customerTpvService.searchCustomers(testVenueId, 'María')

      expect(results[0].customerGroup).not.toBeNull()
      expect(results[0].customerGroup?.id).toBe(testCustomerGroupId)
    })
  })

  // ==========================================
  // GET CUSTOMER FOR CHECKOUT
  // ==========================================

  describe('getCustomerForCheckout', () => {
    it('should get customer by ID with full details', async () => {
      const customer = await customerTpvService.getCustomerForCheckout(testVenueId, testCustomerId)

      expect(customer.id).toBe(testCustomerId)
      expect(customer.firstName).toBe('María')
      expect(customer.loyaltyPoints).toBe(500)
      expect(customer.totalVisits).toBe(15)
      expect(customer.totalSpent).toBe(2500)
      expect(customer.customerGroup?.name).toBe('VIP Test')
    })

    it('should throw NotFoundError for non-existent customer', async () => {
      await expect(customerTpvService.getCustomerForCheckout(testVenueId, 'non-existent-id')).rejects.toThrow('not found')
    })

    it('should throw NotFoundError for customer in different venue', async () => {
      await expect(customerTpvService.getCustomerForCheckout('different-venue-id', testCustomerId)).rejects.toThrow('not found')
    })
  })

  // ==========================================
  // QUICK CREATE CUSTOMER
  // ==========================================

  describe('quickCreateCustomer', () => {
    it('should create customer with phone only', async () => {
      const customer = await customerTpvService.quickCreateCustomer(testVenueId, {
        firstName: 'Quick',
        lastName: 'Test',
        phone: '5551111111',
      })

      expect(customer.id).toBeDefined()
      expect(customer.firstName).toBe('Quick')
      expect(customer.phone).toBe('5551111111')
      expect(customer.loyaltyPoints).toBe(0)

      // Cleanup
      await prisma.customer.delete({ where: { id: customer.id } })
    })

    it('should create customer with email only', async () => {
      const customer = await customerTpvService.quickCreateCustomer(testVenueId, {
        firstName: 'Email',
        lastName: 'Only',
        email: 'emailonly@test.com',
      })

      expect(customer.id).toBeDefined()
      expect(customer.email).toBe('emailonly@test.com')

      // Cleanup
      await prisma.customer.delete({ where: { id: customer.id } })
    })

    it('should return existing customer if phone already exists', async () => {
      const result = await customerTpvService.quickCreateCustomer(testVenueId, {
        firstName: 'Duplicate',
        phone: '5551234567', // María's phone
      })

      // Should return María, not create new
      expect(result.firstName).toBe('María')
      expect(result.id).toBe(testCustomerId)
    })

    it('should return existing customer if email already exists', async () => {
      const result = await customerTpvService.quickCreateCustomer(testVenueId, {
        firstName: 'Duplicate',
        email: 'maria.test@example.com', // María's email
      })

      expect(result.firstName).toBe('María')
      expect(result.id).toBe(testCustomerId)
    })

    it('should throw error if neither phone nor email provided', async () => {
      await expect(
        customerTpvService.quickCreateCustomer(testVenueId, {
          firstName: 'No Contact',
        }),
      ).rejects.toThrow('phone or email')
    })

    it('should normalize phone number on create', async () => {
      const customer = await customerTpvService.quickCreateCustomer(testVenueId, {
        phone: '(555) 222-3333',
      })

      expect(customer.phone).toBe('5552223333') // Normalized

      // Cleanup
      await prisma.customer.delete({ where: { id: customer.id } })
    })
  })

  // ==========================================
  // RECENT CUSTOMERS
  // ==========================================

  describe('getRecentCustomers', () => {
    it('should return customers ordered by lastVisitAt', async () => {
      const results = await customerTpvService.getRecentCustomers(testVenueId)

      expect(results.length).toBeGreaterThanOrEqual(1)
      // María has most recent lastVisitAt
      expect(results[0].firstName).toBe('María')
    })

    it('should respect limit parameter', async () => {
      const results = await customerTpvService.getRecentCustomers(testVenueId, 2)

      expect(results.length).toBeLessThanOrEqual(2)
    })

    it('should only return active customers', async () => {
      const results = await customerTpvService.getRecentCustomers(testVenueId, 100)

      const inactiveCustomer = results.find(c => c.firstName === 'Inactive')
      expect(inactiveCustomer).toBeUndefined()
    })

    it('should include customer group info', async () => {
      const results = await customerTpvService.getRecentCustomers(testVenueId)

      const maria = results.find(c => c.firstName === 'María')
      expect(maria?.customerGroup).not.toBeNull()
      expect(maria?.customerGroup?.name).toBe('VIP Test')
    })
  })

  // ==========================================
  // MULTI-TENANT ISOLATION
  // ==========================================

  describe('Multi-tenant isolation', () => {
    it('should NOT find customers from other venues', async () => {
      const results = await customerTpvService.findCustomerByPhone('other-venue-id', '5551234567')

      expect(results).toHaveLength(0)
    })

    it('should NOT create customer in wrong venue context', async () => {
      const customer = await customerTpvService.quickCreateCustomer(testVenueId, {
        phone: '5553333333',
      })

      // Verify customer belongs to correct venue
      const dbCustomer = await prisma.customer.findUnique({ where: { id: customer.id } })
      expect(dbCustomer?.venueId).toBe(testVenueId)

      // Cleanup
      await prisma.customer.delete({ where: { id: customer.id } })
    })
  })
})
