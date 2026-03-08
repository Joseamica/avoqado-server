import { getAll, getById, create, update, remove, duplicate } from '../../../../src/services/dashboard/permissionSet.service'
import { prismaMock } from '../../../__helpers__/setup'
import { BadRequestError, NotFoundError } from '../../../../src/errors/AppError'

const mockPermissionSet = (overrides: Record<string, any> = {}) => ({
  id: 'ps-1',
  venueId: 'venue-1',
  name: 'Bar Lead',
  description: 'Permissions for bar team leads',
  permissions: ['products:read', 'shifts:create', 'inventory:read'],
  color: '#7C3AED',
  createdBy: 'staff-1',
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  _count: { staffVenues: 3 },
  ...overrides,
})

describe('PermissionSet Service', () => {
  // ==========================================
  // CRUD OPERATIONS
  // ==========================================

  describe('getAll', () => {
    it('should return all permission sets for a venue', async () => {
      const mockSets = [mockPermissionSet(), mockPermissionSet({ id: 'ps-2', name: 'Shift Manager' })]
      prismaMock.permissionSet.findMany.mockResolvedValue(mockSets)

      const result = await getAll('venue-1')

      expect(result).toEqual(mockSets)
      expect(prismaMock.permissionSet.findMany).toHaveBeenCalledWith({
        where: { venueId: 'venue-1' },
        include: { _count: { select: { staffVenues: true } } },
        orderBy: { name: 'asc' },
      })
    })

    it('should return empty array when no permission sets exist', async () => {
      prismaMock.permissionSet.findMany.mockResolvedValue([])

      const result = await getAll('venue-1')

      expect(result).toEqual([])
    })
  })

  describe('getById', () => {
    it('should return a permission set by id', async () => {
      const mock = mockPermissionSet()
      prismaMock.permissionSet.findFirst.mockResolvedValue(mock)

      const result = await getById('venue-1', 'ps-1')

      expect(result).toEqual(mock)
      expect(prismaMock.permissionSet.findFirst).toHaveBeenCalledWith({
        where: { id: 'ps-1', venueId: 'venue-1' },
        include: { _count: { select: { staffVenues: true } } },
      })
    })

    it('should throw NotFoundError when set does not exist', async () => {
      prismaMock.permissionSet.findFirst.mockResolvedValue(null)

      await expect(getById('venue-1', 'nonexistent')).rejects.toThrow(NotFoundError)
    })
  })

  describe('create', () => {
    it('should create a permission set with valid data', async () => {
      prismaMock.permissionSet.count.mockResolvedValue(0)
      const mock = mockPermissionSet()
      prismaMock.permissionSet.create.mockResolvedValue(mock)

      const result = await create(
        'venue-1',
        {
          name: 'Bar Lead',
          description: 'Permissions for bar team leads',
          permissions: ['products:read', 'shifts:create', 'inventory:read'],
          color: '#7C3AED',
        },
        'staff-1',
      )

      expect(result).toEqual(mock)
      expect(prismaMock.permissionSet.create).toHaveBeenCalledWith({
        data: {
          venueId: 'venue-1',
          name: 'Bar Lead',
          description: 'Permissions for bar team leads',
          permissions: ['products:read', 'shifts:create', 'inventory:read'],
          color: '#7C3AED',
          createdBy: 'staff-1',
        },
        include: { _count: { select: { staffVenues: true } } },
      })
    })

    it('should throw BadRequestError when max limit reached', async () => {
      prismaMock.permissionSet.count.mockResolvedValue(20)

      await expect(
        create(
          'venue-1',
          {
            name: 'New Set',
            permissions: ['products:read'],
          },
          'staff-1',
        ),
      ).rejects.toThrow(BadRequestError)
    })

    it('should throw BadRequestError for invalid permission format', async () => {
      prismaMock.permissionSet.count.mockResolvedValue(0)

      await expect(
        create(
          'venue-1',
          {
            name: 'Bad Set',
            permissions: ['not-a-valid-permission'],
          },
          'staff-1',
        ),
      ).rejects.toThrow(BadRequestError)
    })
  })

  describe('update', () => {
    it('should update a permission set', async () => {
      const existing = mockPermissionSet()
      prismaMock.permissionSet.findFirst.mockResolvedValue(existing)
      const updated = mockPermissionSet({ name: 'Updated Name' })
      prismaMock.permissionSet.update.mockResolvedValue(updated)

      const result = await update('venue-1', 'ps-1', { name: 'Updated Name' })

      expect(result.name).toBe('Updated Name')
    })

    it('should throw NotFoundError when set does not exist', async () => {
      prismaMock.permissionSet.findFirst.mockResolvedValue(null)

      await expect(update('venue-1', 'nonexistent', { name: 'X' })).rejects.toThrow(NotFoundError)
    })

    it('should validate permissions when updating them', async () => {
      prismaMock.permissionSet.findFirst.mockResolvedValue(mockPermissionSet())

      await expect(update('venue-1', 'ps-1', { permissions: ['invalid:perm:extra:segments'] })).rejects.toThrow(BadRequestError)
    })
  })

  describe('remove', () => {
    it('should delete a permission set and return affected staff count', async () => {
      prismaMock.permissionSet.findFirst.mockResolvedValue(mockPermissionSet())
      prismaMock.permissionSet.delete.mockResolvedValue(mockPermissionSet())

      const result = await remove('venue-1', 'ps-1')

      expect(result).toEqual({ deleted: true, affectedStaff: 3 })
      expect(prismaMock.permissionSet.delete).toHaveBeenCalledWith({ where: { id: 'ps-1' } })
    })

    it('should throw NotFoundError when set does not exist', async () => {
      prismaMock.permissionSet.findFirst.mockResolvedValue(null)

      await expect(remove('venue-1', 'nonexistent')).rejects.toThrow(NotFoundError)
    })
  })

  describe('duplicate', () => {
    it('should duplicate a permission set with a new name', async () => {
      const original = mockPermissionSet()
      prismaMock.permissionSet.findFirst.mockResolvedValue(original)
      prismaMock.permissionSet.count.mockResolvedValue(1)
      const duplicated = mockPermissionSet({ id: 'ps-2', name: 'Bar Lead (Copy)' })
      prismaMock.permissionSet.create.mockResolvedValue(duplicated)

      const result = await duplicate('venue-1', 'ps-1', 'Bar Lead (Copy)', 'staff-1')

      expect(result.name).toBe('Bar Lead (Copy)')
      expect(prismaMock.permissionSet.create).toHaveBeenCalledWith({
        data: {
          venueId: 'venue-1',
          name: 'Bar Lead (Copy)',
          description: original.description,
          permissions: original.permissions,
          color: original.color,
          createdBy: 'staff-1',
        },
        include: { _count: { select: { staffVenues: true } } },
      })
    })

    it('should throw NotFoundError when source does not exist', async () => {
      prismaMock.permissionSet.findFirst.mockResolvedValue(null)

      await expect(duplicate('venue-1', 'nonexistent', 'Copy', 'staff-1')).rejects.toThrow(NotFoundError)
    })

    it('should throw BadRequestError when max limit reached', async () => {
      prismaMock.permissionSet.findFirst.mockResolvedValue(mockPermissionSet())
      prismaMock.permissionSet.count.mockResolvedValue(20)

      await expect(duplicate('venue-1', 'ps-1', 'Copy', 'staff-1')).rejects.toThrow(BadRequestError)
    })
  })

  // ==========================================
  // REGRESSION TESTS
  // ==========================================

  describe('Venue isolation', () => {
    it('should always filter by venueId in getAll', async () => {
      prismaMock.permissionSet.findMany.mockResolvedValue([])

      await getAll('venue-specific')

      expect(prismaMock.permissionSet.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { venueId: 'venue-specific' },
        }),
      )
    })

    it('should always filter by venueId in getById', async () => {
      prismaMock.permissionSet.findFirst.mockResolvedValue(mockPermissionSet())

      await getById('venue-specific', 'ps-1')

      expect(prismaMock.permissionSet.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ps-1', venueId: 'venue-specific' },
        }),
      )
    })

    it('should always filter by venueId in remove', async () => {
      prismaMock.permissionSet.findFirst.mockResolvedValue(mockPermissionSet({ venueId: 'venue-specific' }))
      prismaMock.permissionSet.delete.mockResolvedValue({})

      await remove('venue-specific', 'ps-1')

      expect(prismaMock.permissionSet.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ps-1', venueId: 'venue-specific' },
        }),
      )
    })
  })
})
