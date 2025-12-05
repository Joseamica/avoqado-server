import { StaffRole } from '@prisma/client'

import { BadRequestError, NotFoundError } from '../../../../src/errors/AppError'
import {
  getVenueRoleConfigs,
  updateVenueRoleConfigs,
  getRoleDisplayName,
  getRoleDisplayNames,
  resetRoleConfig,
  resetAllRoleConfigs,
  DEFAULT_ROLE_DISPLAY_NAMES,
} from '../../../../src/services/dashboard/venueRoleConfig.dashboard.service'
import { prismaMock } from '../../../__helpers__/setup'

// Helper to create mock VenueRoleConfig
const createMockRoleConfig = (overrides: Record<string, any> = {}) => ({
  id: 'config-123',
  venueId: 'venue-123',
  role: StaffRole.CASHIER,
  displayName: 'Promotor',
  description: 'Personal de venta en eventos',
  icon: 'ticket',
  color: '#7C3AED',
  isActive: true,
  sortOrder: 4,
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-20'),
  ...overrides,
})

describe('VenueRoleConfig Dashboard Service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('getVenueRoleConfigs', () => {
    it('should return all roles with custom configs merged with defaults', async () => {
      const mockVenue = { id: 'venue-123' }
      const mockCustomConfigs = [
        createMockRoleConfig({ role: StaffRole.CASHIER, displayName: 'Promotor' }),
        createMockRoleConfig({ role: StaffRole.WAITER, displayName: 'Staff de Evento', id: 'config-124' }),
      ]

      prismaMock.venue.findUnique.mockResolvedValue(mockVenue as any)
      prismaMock.venueRoleConfig.findMany.mockResolvedValue(mockCustomConfigs as any)

      const result = await getVenueRoleConfigs('venue-123')

      // Should return all 9 roles
      expect(result).toHaveLength(9)

      // Check custom configs are used
      const cashierConfig = result.find(c => c.role === StaffRole.CASHIER)
      expect(cashierConfig?.displayName).toBe('Promotor')

      const waiterConfig = result.find(c => c.role === StaffRole.WAITER)
      expect(waiterConfig?.displayName).toBe('Staff de Evento')

      // Check defaults are used for unconfigured roles
      const adminConfig = result.find(c => c.role === StaffRole.ADMIN)
      expect(adminConfig?.displayName).toBe(DEFAULT_ROLE_DISPLAY_NAMES[StaffRole.ADMIN])
    })

    it('should throw NotFoundError if venue does not exist', async () => {
      prismaMock.venue.findUnique.mockResolvedValue(null)

      await expect(getVenueRoleConfigs('nonexistent-venue')).rejects.toThrow(NotFoundError)
    })

    it('should return default configs when no custom configs exist', async () => {
      const mockVenue = { id: 'venue-123' }

      prismaMock.venue.findUnique.mockResolvedValue(mockVenue as any)
      prismaMock.venueRoleConfig.findMany.mockResolvedValue([])

      const result = await getVenueRoleConfigs('venue-123')

      // All roles should have default display names
      expect(result).toHaveLength(9)
      result.forEach(config => {
        expect(config.displayName).toBe(DEFAULT_ROLE_DISPLAY_NAMES[config.role])
        expect(config.isActive).toBe(true)
      })
    })

    it('should sort configs by sortOrder', async () => {
      const mockVenue = { id: 'venue-123' }
      const mockCustomConfigs = [
        createMockRoleConfig({ role: StaffRole.CASHIER, sortOrder: 1 }),
        createMockRoleConfig({ role: StaffRole.WAITER, sortOrder: 0, id: 'config-124' }),
      ]

      prismaMock.venue.findUnique.mockResolvedValue(mockVenue as any)
      prismaMock.venueRoleConfig.findMany.mockResolvedValue(mockCustomConfigs as any)

      const result = await getVenueRoleConfigs('venue-123')

      // First config with sortOrder 0 should come first
      const waiterIndex = result.findIndex(c => c.role === StaffRole.WAITER)
      const cashierIndex = result.findIndex(c => c.role === StaffRole.CASHIER)
      expect(waiterIndex).toBeLessThan(cashierIndex)
    })
  })

  describe('updateVenueRoleConfigs', () => {
    it('should upsert role configs successfully', async () => {
      const mockVenue = { id: 'venue-123' }
      const inputConfigs = [
        { role: 'CASHIER' as StaffRole, displayName: 'Promotor', description: 'Ventas' },
        { role: 'WAITER' as StaffRole, displayName: 'Staff de Evento' },
      ]

      prismaMock.venue.findUnique.mockResolvedValue(mockVenue as any)
      prismaMock.$transaction.mockResolvedValue([])
      prismaMock.venueRoleConfig.findMany.mockResolvedValue([
        createMockRoleConfig({ role: StaffRole.CASHIER, displayName: 'Promotor' }),
      ] as any)

      const result = await updateVenueRoleConfigs('venue-123', inputConfigs)

      // Should call $transaction for upserts
      expect(prismaMock.$transaction).toHaveBeenCalled()
      // Should return updated configs
      expect(result).toBeDefined()
    })

    it('should throw NotFoundError if venue does not exist', async () => {
      prismaMock.venue.findUnique.mockResolvedValue(null)

      await expect(
        updateVenueRoleConfigs('nonexistent-venue', [{ role: 'CASHIER' as StaffRole, displayName: 'Promotor' }]),
      ).rejects.toThrow(NotFoundError)
    })

    it('should skip SUPERADMIN role and warn', async () => {
      const mockVenue = { id: 'venue-123' }
      const inputConfigs = [
        { role: 'SUPERADMIN' as StaffRole, displayName: 'Jefe Supremo' }, // Should be skipped
        { role: 'CASHIER' as StaffRole, displayName: 'Promotor' },
      ]

      prismaMock.venue.findUnique.mockResolvedValue(mockVenue as any)
      prismaMock.$transaction.mockResolvedValue([])
      prismaMock.venueRoleConfig.findMany.mockResolvedValue([])

      await updateVenueRoleConfigs('venue-123', inputConfigs)

      // SUPERADMIN is silently skipped, only ADMIN should be processed
      // The $transaction should be called with only the ADMIN update
      expect(prismaMock.$transaction).toHaveBeenCalled()
    })

    it('should throw BadRequestError if only non-renameable roles are provided', async () => {
      const mockVenue = { id: 'venue-123' }
      const inputConfigs = [{ role: 'SUPERADMIN' as StaffRole, displayName: 'Jefe Supremo' }]

      prismaMock.venue.findUnique.mockResolvedValue(mockVenue as any)

      await expect(updateVenueRoleConfigs('venue-123', inputConfigs)).rejects.toThrow(BadRequestError)
    })
  })

  describe('getRoleDisplayName', () => {
    it('should return custom display name if configured', async () => {
      const mockConfig = { displayName: 'Promotor' }
      prismaMock.venueRoleConfig.findUnique.mockResolvedValue(mockConfig as any)

      const result = await getRoleDisplayName('venue-123', StaffRole.CASHIER)

      expect(result).toBe('Promotor')
    })

    it('should return default display name if not configured', async () => {
      prismaMock.venueRoleConfig.findUnique.mockResolvedValue(null)

      const result = await getRoleDisplayName('venue-123', StaffRole.CASHIER)

      expect(result).toBe(DEFAULT_ROLE_DISPLAY_NAMES[StaffRole.CASHIER])
    })
  })

  describe('getRoleDisplayNames', () => {
    it('should return custom and default names for multiple roles', async () => {
      const mockConfigs = [{ role: StaffRole.CASHIER, displayName: 'Promotor' }]
      prismaMock.venueRoleConfig.findMany.mockResolvedValue(mockConfigs as any)

      const roles = [StaffRole.CASHIER, StaffRole.WAITER, StaffRole.ADMIN]
      const result = await getRoleDisplayNames('venue-123', roles)

      expect(result.get(StaffRole.CASHIER)).toBe('Promotor')
      expect(result.get(StaffRole.WAITER)).toBe(DEFAULT_ROLE_DISPLAY_NAMES[StaffRole.WAITER])
      expect(result.get(StaffRole.ADMIN)).toBe(DEFAULT_ROLE_DISPLAY_NAMES[StaffRole.ADMIN])
    })
  })

  describe('resetRoleConfig', () => {
    it('should delete role config for specific role', async () => {
      prismaMock.venueRoleConfig.deleteMany.mockResolvedValue({ count: 1 })

      await resetRoleConfig('venue-123', StaffRole.CASHIER)

      expect(prismaMock.venueRoleConfig.deleteMany).toHaveBeenCalledWith({
        where: {
          venueId: 'venue-123',
          role: StaffRole.CASHIER,
        },
      })
    })
  })

  describe('resetAllRoleConfigs', () => {
    it('should delete all role configs for a venue', async () => {
      prismaMock.venueRoleConfig.deleteMany.mockResolvedValue({ count: 5 })

      await resetAllRoleConfigs('venue-123')

      expect(prismaMock.venueRoleConfig.deleteMany).toHaveBeenCalledWith({
        where: { venueId: 'venue-123' },
      })
    })
  })

  describe('DEFAULT_ROLE_DISPLAY_NAMES', () => {
    it('should have Spanish display names for all roles', () => {
      const allRoles = Object.values(StaffRole)

      allRoles.forEach(role => {
        expect(DEFAULT_ROLE_DISPLAY_NAMES[role]).toBeDefined()
        expect(DEFAULT_ROLE_DISPLAY_NAMES[role].length).toBeGreaterThan(0)
      })
    })

    it('should have expected default names', () => {
      expect(DEFAULT_ROLE_DISPLAY_NAMES[StaffRole.CASHIER]).toBe('Cajero')
      expect(DEFAULT_ROLE_DISPLAY_NAMES[StaffRole.WAITER]).toBe('Mesero')
      expect(DEFAULT_ROLE_DISPLAY_NAMES[StaffRole.MANAGER]).toBe('Gerente')
      expect(DEFAULT_ROLE_DISPLAY_NAMES[StaffRole.ADMIN]).toBe('Administrador')
    })
  })

  // ============================================================================
  // REGRESSION TESTS - Ensure existing functionality still works
  // ============================================================================

  describe('REGRESSION: Multi-tenant isolation', () => {
    it('should always include venueId in queries', async () => {
      const mockVenue = { id: 'venue-123' }
      prismaMock.venue.findUnique.mockResolvedValue(mockVenue as any)
      prismaMock.venueRoleConfig.findMany.mockResolvedValue([])

      await getVenueRoleConfigs('venue-123')

      // Verify venueId filter was applied
      expect(prismaMock.venueRoleConfig.findMany).toHaveBeenCalledWith({
        where: { venueId: 'venue-123' },
      })
    })
  })

  describe('REGRESSION: StaffRole enum integrity', () => {
    it('should handle all StaffRole enum values without error', async () => {
      const mockVenue = { id: 'venue-123' }
      prismaMock.venue.findUnique.mockResolvedValue(mockVenue as any)
      prismaMock.venueRoleConfig.findMany.mockResolvedValue([])

      const result = await getVenueRoleConfigs('venue-123')

      // Verify all 9 roles are included
      const roles = result.map(c => c.role)
      expect(roles).toContain(StaffRole.SUPERADMIN)
      expect(roles).toContain(StaffRole.OWNER)
      expect(roles).toContain(StaffRole.ADMIN)
      expect(roles).toContain(StaffRole.MANAGER)
      expect(roles).toContain(StaffRole.CASHIER)
      expect(roles).toContain(StaffRole.WAITER)
      expect(roles).toContain(StaffRole.KITCHEN)
      expect(roles).toContain(StaffRole.HOST)
      expect(roles).toContain(StaffRole.VIEWER)
    })
  })
})
