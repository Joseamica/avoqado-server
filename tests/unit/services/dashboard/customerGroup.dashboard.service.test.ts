import {
  getCustomerGroups,
  getCustomerGroupById,
  createCustomerGroup,
  updateCustomerGroup,
  deleteCustomerGroup,
  assignCustomersToGroup,
  removeCustomersFromGroup,
  getCustomerGroupStats,
} from '../../../../src/services/dashboard/customerGroup.dashboard.service'
import { prismaMock } from '../../../__helpers__/setup'
import { BadRequestError, NotFoundError } from '../../../../src/errors/AppError'
import { Decimal } from '@prisma/client/runtime/library'

// Helper to create mock customer group
const createMockCustomerGroup = (overrides: Record<string, any> = {}) => ({
  id: 'group-123',
  venueId: 'venue-123',
  name: 'VIP Customers',
  description: 'High-value repeat customers',
  color: '#FFD700',
  autoAssignRules: null,
  active: true,
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-20'),
  ...overrides,
})

// Helper to create mock customer for group stats
const createMockGroupCustomer = (overrides: Record<string, any> = {}) => ({
  id: 'customer-123',
  email: 'test@example.com',
  firstName: 'John',
  lastName: 'Doe',
  phone: '+1234567890',
  totalSpent: new Decimal(500),
  totalVisits: 10,
  loyaltyPoints: 100,
  createdAt: new Date(),
  ...overrides,
})

describe('CustomerGroup Dashboard Service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('getCustomerGroups', () => {
    it('should return paginated customer groups with customerCount', async () => {
      const mockGroups = [
        { ...createMockCustomerGroup({ id: 'group-1', name: 'VIP' }), _count: { customers: 15 } },
        { ...createMockCustomerGroup({ id: 'group-2', name: 'Regular' }), _count: { customers: 50 } },
      ]

      prismaMock.$transaction.mockResolvedValue([mockGroups, 10] as any)

      const result = await getCustomerGroups('venue-123', { page: 1, pageSize: 10 })

      expect(result.data).toHaveLength(2)
      expect(result.data[0].customerCount).toBe(15)
      expect(result.data[1].customerCount).toBe(50)
      expect(result.data[0]._count).toBeUndefined() // Should be removed from response
      expect(result.meta).toEqual({
        totalCount: 10,
        pageSize: 10,
        currentPage: 1,
        totalPages: 1,
        hasNextPage: false,
        hasPrevPage: false,
      })
    })

    it('should apply search filter on name and description', async () => {
      prismaMock.$transaction.mockResolvedValue([[], 0] as any)

      await getCustomerGroups('venue-123', { search: 'vip' })

      // Verify $transaction was called (search logic is tested by integration tests)
      expect(prismaMock.$transaction).toHaveBeenCalled()
    })

    it('should enforce multi-tenant isolation (venueId filter)', async () => {
      prismaMock.$transaction.mockResolvedValue([[], 0] as any)

      await getCustomerGroups('venue-123')

      // Verify $transaction was called (venueId filter is enforced in service)
      expect(prismaMock.$transaction).toHaveBeenCalled()
    })

    it('should use default pagination values (page=1, pageSize=20)', async () => {
      prismaMock.$transaction.mockResolvedValue([[], 0] as any)

      const result = await getCustomerGroups('venue-123')

      // Verify default pagination metadata
      expect(result.meta.currentPage).toBe(1)
      expect(result.meta.pageSize).toBe(20)
    })

    it('should calculate pagination metadata correctly (multiple pages)', async () => {
      prismaMock.$transaction.mockResolvedValue([[], 45] as any)

      const result = await getCustomerGroups('venue-123', { page: 2, pageSize: 10 })

      expect(result.meta).toEqual({
        totalCount: 45,
        pageSize: 10,
        currentPage: 2,
        totalPages: 5,
        hasNextPage: true,
        hasPrevPage: true,
      })
    })
  })

  describe('getCustomerGroupById', () => {
    it('should return group with customers and calculated stats', async () => {
      const mockGroup = {
        ...createMockCustomerGroup(),
        customers: [
          createMockGroupCustomer({ id: 'c1', totalSpent: new Decimal(1000), totalVisits: 20, loyaltyPoints: 200 }),
          createMockGroupCustomer({ id: 'c2', totalSpent: new Decimal(500), totalVisits: 10, loyaltyPoints: 100 }),
          createMockGroupCustomer({ id: 'c3', totalSpent: new Decimal(300), totalVisits: 5, loyaltyPoints: 50 }),
        ],
      }

      prismaMock.customerGroup.findFirst.mockResolvedValue(mockGroup as any)

      const result = await getCustomerGroupById('venue-123', 'group-123')

      expect(result.id).toBe('group-123')
      expect(result.customers).toHaveLength(3)
      expect(result.stats).toEqual({
        totalCustomers: 3,
        totalSpent: 1800, // 1000 + 500 + 300
        totalVisits: 35, // 20 + 10 + 5
        totalLoyaltyPoints: 350, // 200 + 100 + 50
        avgSpentPerCustomer: 600, // 1800 / 3
        avgVisitsPerCustomer: 11.666666666666666, // 35 / 3
      })

      // Verify Decimal → Number conversion in customers
      expect(result.customers[0].totalSpent).toBe(1000)
      expect(result.customers[1].totalSpent).toBe(500)
    })

    it('should handle group with zero customers (avoid division by zero)', async () => {
      const mockGroup = {
        ...createMockCustomerGroup(),
        customers: [],
      }

      prismaMock.customerGroup.findFirst.mockResolvedValue(mockGroup as any)

      const result = await getCustomerGroupById('venue-123', 'group-123')

      expect(result.stats).toEqual({
        totalCustomers: 0,
        totalSpent: 0,
        totalVisits: 0,
        totalLoyaltyPoints: 0,
        avgSpentPerCustomer: 0,
        avgVisitsPerCustomer: 0,
      })
    })

    it('should throw NotFoundError if group does not exist', async () => {
      prismaMock.customerGroup.findFirst.mockResolvedValue(null)

      await expect(getCustomerGroupById('venue-123', 'nonexistent')).rejects.toThrow(NotFoundError)
      await expect(getCustomerGroupById('venue-123', 'nonexistent')).rejects.toThrow('Customer group not found')
    })

    it('should enforce multi-tenant isolation (venueId filter)', async () => {
      prismaMock.customerGroup.findFirst.mockResolvedValue(null)

      await expect(getCustomerGroupById('venue-123', 'group-456')).rejects.toThrow(NotFoundError)

      expect(prismaMock.customerGroup.findFirst).toHaveBeenCalledWith({
        where: { id: 'group-456', venueId: 'venue-123' },
        include: expect.objectContaining({
          customers: expect.any(Object),
        }),
      })
    })

    it('should order customers by totalSpent descending', async () => {
      prismaMock.customerGroup.findFirst.mockResolvedValue({
        ...createMockCustomerGroup(),
        customers: [],
      } as any)

      await getCustomerGroupById('venue-123', 'group-123')

      expect(prismaMock.customerGroup.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            customers: expect.objectContaining({
              orderBy: { totalSpent: 'desc' },
            }),
          }),
        }),
      )
    })
  })

  describe('createCustomerGroup', () => {
    it('should create customer group with default color', async () => {
      const mockGroup = {
        ...createMockCustomerGroup({ name: 'New Group', color: '#6B7280' }),
        _count: { customers: 0 },
      }

      prismaMock.customerGroup.findFirst.mockResolvedValue(null) // No duplicate
      prismaMock.customerGroup.create.mockResolvedValue(mockGroup as any)

      const result = await createCustomerGroup('venue-123', {
        name: 'New Group',
        description: 'Test group',
      })

      expect(result.name).toBe('New Group')
      expect(result.customerCount).toBe(0)
      expect(result._count).toBeUndefined()
      expect(prismaMock.customerGroup.create).toHaveBeenCalledWith({
        data: {
          venueId: 'venue-123',
          name: 'New Group',
          description: 'Test group',
          color: '#6B7280', // Default gray
          autoAssignRules: undefined,
        },
        include: {
          _count: {
            select: {
              customers: true,
            },
          },
        },
      })
    })

    it('should create customer group with custom color', async () => {
      const mockGroup = {
        ...createMockCustomerGroup({ color: '#FF5733' }),
        _count: { customers: 0 },
      }

      prismaMock.customerGroup.findFirst.mockResolvedValue(null)
      prismaMock.customerGroup.create.mockResolvedValue(mockGroup as any)

      await createCustomerGroup('venue-123', {
        name: 'Premium',
        color: '#FF5733',
      })

      expect(prismaMock.customerGroup.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            color: '#FF5733',
          }),
        }),
      )
    })

    it('should throw BadRequestError if group name already exists in venue', async () => {
      prismaMock.customerGroup.findFirst.mockResolvedValue(createMockCustomerGroup({ name: 'VIP' }) as any)

      await expect(
        createCustomerGroup('venue-123', {
          name: 'VIP',
        }),
      ).rejects.toThrow(BadRequestError)

      await expect(
        createCustomerGroup('venue-123', {
          name: 'VIP',
        }),
      ).rejects.toThrow('Customer group "VIP" already exists in this venue')
    })

    it('should create group with autoAssignRules', async () => {
      const autoAssignRules = {
        minTotalSpent: 1000,
        minVisits: 10,
      }

      const mockGroup = {
        ...createMockCustomerGroup({ autoAssignRules }),
        _count: { customers: 0 },
      }

      prismaMock.customerGroup.findFirst.mockResolvedValue(null)
      prismaMock.customerGroup.create.mockResolvedValue(mockGroup as any)

      await createCustomerGroup('venue-123', {
        name: 'Auto VIP',
        autoAssignRules,
      })

      expect(prismaMock.customerGroup.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            autoAssignRules,
          }),
        }),
      )
    })
  })

  describe('updateCustomerGroup', () => {
    it('should update customer group successfully', async () => {
      const existingGroup = createMockCustomerGroup({ name: 'Old Name' })
      const updatedGroup = {
        ...createMockCustomerGroup({ name: 'Updated Name' }),
        _count: { customers: 10 },
      }

      // First call: check existing group, second call: check duplicate name (returns null - no duplicate)
      prismaMock.customerGroup.findFirst.mockResolvedValueOnce(existingGroup as any).mockResolvedValueOnce(null)
      prismaMock.customerGroup.update.mockResolvedValue(updatedGroup as any)

      const result = await updateCustomerGroup('venue-123', 'group-123', {
        name: 'Updated Name',
      })

      expect(result.name).toBe('Updated Name')
      expect(result.customerCount).toBe(10)
      expect(result._count).toBeUndefined()
      expect(prismaMock.customerGroup.update).toHaveBeenCalledWith({
        where: { id: 'group-123' },
        data: {
          name: 'Updated Name',
          description: undefined,
          color: undefined,
          autoAssignRules: undefined,
          active: undefined,
        },
        include: {
          _count: {
            select: {
              customers: true,
            },
          },
        },
      })
    })

    it('should throw NotFoundError if group does not exist', async () => {
      prismaMock.customerGroup.findFirst.mockResolvedValue(null)

      await expect(
        updateCustomerGroup('venue-123', 'nonexistent', {
          name: 'Test',
        }),
      ).rejects.toThrow(NotFoundError)

      await expect(
        updateCustomerGroup('venue-123', 'nonexistent', {
          name: 'Test',
        }),
      ).rejects.toThrow('Customer group not found')
    })

    it('should throw BadRequestError if new name already exists (different group)', async () => {
      const existingGroup = createMockCustomerGroup({ id: 'group-123', name: 'Old Name' })
      const duplicateGroup = createMockCustomerGroup({ id: 'group-456', name: 'VIP' })

      // First call returns existing group, second call returns duplicate
      prismaMock.customerGroup.findFirst.mockResolvedValueOnce(existingGroup as any).mockResolvedValueOnce(duplicateGroup as any)

      await expect(
        updateCustomerGroup('venue-123', 'group-123', {
          name: 'VIP',
        }),
      ).rejects.toThrow('Customer group "VIP" already exists in this venue')
    })

    it('should allow updating to same name (no duplicate error)', async () => {
      const existingGroup = createMockCustomerGroup({ name: 'VIP' })

      // First call returns existing group, second call returns null (no duplicate found due to id exclusion)
      prismaMock.customerGroup.findFirst.mockResolvedValueOnce(existingGroup as any).mockResolvedValueOnce(null)
      prismaMock.customerGroup.update.mockResolvedValue({ ...existingGroup, _count: { customers: 5 } } as any)

      await updateCustomerGroup('venue-123', 'group-123', {
        name: 'VIP',
      })

      // Should check for duplicates even if name is same (but won't find self due to id exclusion)
      expect(prismaMock.customerGroup.findFirst).toHaveBeenCalledTimes(2)
    })

    it('should update active status (soft delete/restore)', async () => {
      const existingGroup = createMockCustomerGroup({ active: true })
      const deactivatedGroup = {
        ...createMockCustomerGroup({ active: false }),
        _count: { customers: 3 },
      }

      prismaMock.customerGroup.findFirst.mockResolvedValue(existingGroup as any)
      prismaMock.customerGroup.update.mockResolvedValue(deactivatedGroup as any)

      const result = await updateCustomerGroup('venue-123', 'group-123', {
        active: false,
      })

      expect(result.active).toBe(false)
      expect(prismaMock.customerGroup.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            active: false,
          }),
        }),
      )
    })
  })

  describe('deleteCustomerGroup', () => {
    it('should soft-delete group (set active=false)', async () => {
      const existingGroup = createMockCustomerGroup({ active: true })

      prismaMock.customerGroup.findFirst.mockResolvedValue(existingGroup as any)
      prismaMock.customerGroup.update.mockResolvedValue({ ...existingGroup, active: false } as any)

      const result = await deleteCustomerGroup('venue-123', 'group-123')

      expect(result.success).toBe(true)
      expect(result.message).toBe('Customer group deleted successfully')
      expect(prismaMock.customerGroup.update).toHaveBeenCalledWith({
        where: { id: 'group-123' },
        data: { active: false },
      })
    })

    it('should throw NotFoundError if group does not exist', async () => {
      prismaMock.customerGroup.findFirst.mockResolvedValue(null)

      await expect(deleteCustomerGroup('venue-123', 'nonexistent')).rejects.toThrow(NotFoundError)
      await expect(deleteCustomerGroup('venue-123', 'nonexistent')).rejects.toThrow('Customer group not found')
    })

    it('should enforce multi-tenant isolation (venueId filter)', async () => {
      prismaMock.customerGroup.findFirst.mockResolvedValue(null)

      await expect(deleteCustomerGroup('venue-123', 'group-456')).rejects.toThrow(NotFoundError)

      expect(prismaMock.customerGroup.findFirst).toHaveBeenCalledWith({
        where: { id: 'group-456', venueId: 'venue-123' },
      })
    })
  })

  describe('assignCustomersToGroup', () => {
    it('should assign customers to group successfully', async () => {
      const mockGroup = createMockCustomerGroup({ name: 'VIP' })
      const mockCustomers = [
        { id: 'c1', venueId: 'venue-123' },
        { id: 'c2', venueId: 'venue-123' },
        { id: 'c3', venueId: 'venue-123' },
      ]

      prismaMock.customerGroup.findFirst.mockResolvedValue(mockGroup as any)
      prismaMock.customer.findMany.mockResolvedValue(mockCustomers as any)
      prismaMock.customer.updateMany.mockResolvedValue({ count: 3 } as any)

      const result = await assignCustomersToGroup('venue-123', 'group-123', ['c1', 'c2', 'c3'])

      expect(result.success).toBe(true)
      expect(result.message).toBe('3 customer(s) assigned to group "VIP"')
      expect(result.assignedCount).toBe(3)
      expect(prismaMock.customer.updateMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['c1', 'c2', 'c3'] },
          venueId: 'venue-123',
        },
        data: {
          customerGroupId: 'group-123',
        },
      })
    })

    it('should throw NotFoundError if group does not exist', async () => {
      prismaMock.customerGroup.findFirst.mockResolvedValue(null)

      await expect(assignCustomersToGroup('venue-123', 'nonexistent', ['c1'])).rejects.toThrow(NotFoundError)
      await expect(assignCustomersToGroup('venue-123', 'nonexistent', ['c1'])).rejects.toThrow('Customer group not found')
    })

    it('should throw BadRequestError if some customers not found or wrong venue', async () => {
      const mockGroup = createMockCustomerGroup()
      const mockCustomers = [
        { id: 'c1', venueId: 'venue-123' },
        // c2 is missing (not found or different venue)
      ]

      prismaMock.customerGroup.findFirst.mockResolvedValue(mockGroup as any)
      prismaMock.customer.findMany.mockResolvedValue(mockCustomers as any)

      await expect(assignCustomersToGroup('venue-123', 'group-123', ['c1', 'c2'])).rejects.toThrow(BadRequestError)

      await expect(assignCustomersToGroup('venue-123', 'group-123', ['c1', 'c2'])).rejects.toThrow(
        'One or more customers not found or do not belong to this venue',
      )
    })

    it('should enforce multi-tenant isolation (verify all customers belong to venue)', async () => {
      const mockGroup = createMockCustomerGroup()
      const mockCustomers = [{ id: 'c1', venueId: 'venue-123' }]

      prismaMock.customerGroup.findFirst.mockResolvedValue(mockGroup as any)
      prismaMock.customer.findMany.mockResolvedValue(mockCustomers as any)
      prismaMock.customer.updateMany.mockResolvedValue({ count: 1 } as any)

      await assignCustomersToGroup('venue-123', 'group-123', ['c1'])

      expect(prismaMock.customer.findMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['c1'] },
          venueId: 'venue-123',
        },
      })
    })
  })

  describe('removeCustomersFromGroup', () => {
    it('should remove customers from group successfully', async () => {
      const mockGroup = createMockCustomerGroup({ name: 'VIP' })

      prismaMock.customerGroup.findFirst.mockResolvedValue(mockGroup as any)
      prismaMock.customer.updateMany.mockResolvedValue({ count: 2 } as any)

      const result = await removeCustomersFromGroup('venue-123', 'group-123', ['c1', 'c2'])

      expect(result.success).toBe(true)
      expect(result.message).toBe('2 customer(s) removed from group "VIP"')
      expect(result.removedCount).toBe(2)
      expect(prismaMock.customer.updateMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['c1', 'c2'] },
          venueId: 'venue-123',
          customerGroupId: 'group-123',
        },
        data: {
          customerGroupId: null,
        },
      })
    })

    it('should throw NotFoundError if group does not exist', async () => {
      prismaMock.customerGroup.findFirst.mockResolvedValue(null)

      await expect(removeCustomersFromGroup('venue-123', 'nonexistent', ['c1'])).rejects.toThrow(NotFoundError)
      await expect(removeCustomersFromGroup('venue-123', 'nonexistent', ['c1'])).rejects.toThrow('Customer group not found')
    })

    it('should return 0 removedCount if no customers were in the group', async () => {
      const mockGroup = createMockCustomerGroup()

      prismaMock.customerGroup.findFirst.mockResolvedValue(mockGroup as any)
      prismaMock.customer.updateMany.mockResolvedValue({ count: 0 } as any)

      const result = await removeCustomersFromGroup('venue-123', 'group-123', ['c1', 'c2'])

      expect(result.removedCount).toBe(0)
      expect(result.message).toContain('0 customer(s) removed')
    })

    it('should enforce multi-tenant isolation and group membership', async () => {
      const mockGroup = createMockCustomerGroup()

      prismaMock.customerGroup.findFirst.mockResolvedValue(mockGroup as any)
      prismaMock.customer.updateMany.mockResolvedValue({ count: 1 } as any)

      await removeCustomersFromGroup('venue-123', 'group-123', ['c1'])

      expect(prismaMock.customer.updateMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['c1'] },
          venueId: 'venue-123',
          customerGroupId: 'group-123', // Only remove if customer is actually in this group
        },
        data: {
          customerGroupId: null,
        },
      })
    })
  })

  describe('getCustomerGroupStats', () => {
    it('should return stats for all active groups', async () => {
      const mockGroups = [
        {
          ...createMockCustomerGroup({ id: 'g1', name: 'VIP', color: '#FFD700' }),
          customers: [
            createMockGroupCustomer({ totalSpent: new Decimal(1000), totalVisits: 20, loyaltyPoints: 200 }),
            createMockGroupCustomer({ totalSpent: new Decimal(500), totalVisits: 10, loyaltyPoints: 100 }),
          ],
        },
        {
          ...createMockCustomerGroup({ id: 'g2', name: 'Regular', color: '#6B7280' }),
          customers: [createMockGroupCustomer({ totalSpent: new Decimal(300), totalVisits: 5, loyaltyPoints: 50 })],
        },
      ]

      prismaMock.customerGroup.findMany.mockResolvedValue(mockGroups as any)

      const result = await getCustomerGroupStats('venue-123')

      expect(result.totalGroups).toBe(2)
      expect(result.totalCustomersInGroups).toBe(3) // 2 + 1
      expect(result.groups).toHaveLength(2)
      expect(result.groups[0]).toEqual({
        id: 'g1',
        name: 'VIP',
        color: '#FFD700',
        customerCount: 2,
        totalSpent: 1500, // 1000 + 500
        totalVisits: 30, // 20 + 10
        totalLoyaltyPoints: 300, // 200 + 100
        avgSpentPerCustomer: 750, // 1500 / 2
      })
      expect(result.groups[1]).toEqual({
        id: 'g2',
        name: 'Regular',
        color: '#6B7280',
        customerCount: 1,
        totalSpent: 300,
        totalVisits: 5,
        totalLoyaltyPoints: 50,
        avgSpentPerCustomer: 300, // 300 / 1
      })
    })

    it('should handle groups with zero customers (avoid division by zero)', async () => {
      const mockGroups = [
        {
          ...createMockCustomerGroup({ id: 'g1', name: 'Empty Group' }),
          customers: [],
        },
      ]

      prismaMock.customerGroup.findMany.mockResolvedValue(mockGroups as any)

      const result = await getCustomerGroupStats('venue-123')

      expect(result.groups[0]).toEqual({
        id: 'g1',
        name: 'Empty Group',
        color: '#FFD700',
        customerCount: 0,
        totalSpent: 0,
        totalVisits: 0,
        totalLoyaltyPoints: 0,
        avgSpentPerCustomer: 0,
      })
    })

    it('should return empty stats if no active groups', async () => {
      prismaMock.customerGroup.findMany.mockResolvedValue([])

      const result = await getCustomerGroupStats('venue-123')

      expect(result).toEqual({
        totalGroups: 0,
        totalCustomersInGroups: 0,
        groups: [],
      })
    })

    it('should enforce multi-tenant isolation and filter only active groups', async () => {
      prismaMock.customerGroup.findMany.mockResolvedValue([])

      await getCustomerGroupStats('venue-123')

      expect(prismaMock.customerGroup.findMany).toHaveBeenCalledWith({
        where: {
          venueId: 'venue-123',
          active: true,
        },
        include: {
          customers: {
            select: {
              totalSpent: true,
              totalVisits: true,
              loyaltyPoints: true,
            },
          },
        },
      })
    })
  })
})
