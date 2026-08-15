/**
 * checkPermission Middleware Tests
 *
 * Tests the core permission middleware that handles:
 * 1. SUPERADMIN bypass
 * 2. Permission resolution with VenueRolePermission
 * 3. Multi-venue support (URL params vs token)
 * 4. Error handling
 */

import { Request, Response, NextFunction } from 'express'
import { StaffRole } from '@prisma/client'
import { checkPermission, checkAnyPermission, checkAllPermissions } from '@/middlewares/checkPermission.middleware'
import * as permissionsLib from '@/lib/permissions'
import prisma from '@/utils/prismaClient'

// Mock dependencies
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staffVenue: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
    },
    venue: {
      findUnique: jest.fn(),
    },
    staffOrganization: {
      findUnique: jest.fn(),
    },
    venueRolePermission: {
      findUnique: jest.fn(),
    },
    venueSettings: {
      findUnique: jest.fn(),
    },
    permissionOverride: {
      updateMany: jest.fn(),
      findUnique: jest.fn(),
    },
  },
}))

jest.mock('@/lib/permissions', () => ({
  hasPermission: jest.fn(),
  evaluatePermissionList: jest.fn(),
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}))

describe('checkPermission Middleware', () => {
  let mockReq: Partial<Request>
  let mockRes: Partial<Response>
  let mockNext: NextFunction
  let jsonMock: jest.Mock
  let statusMock: jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()

    jsonMock = jest.fn()
    statusMock = jest.fn(() => mockRes as Response)

    mockReq = {
      params: { venueId: 'venue_123' },
      authContext: {
        userId: 'user_123',
        venueId: 'venue_123',
        orgId: 'org_123',
        role: 'MANAGER',
      },
    } as any

    mockRes = {
      status: statusMock,
      json: jsonMock,
    }

    mockNext = jest.fn()

    // Default: not a superadmin
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(null)
    // Default: if venue resolution fallback is needed
    ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ organizationId: 'org_123' })
    ;(prisma.staffOrganization.findUnique as jest.Mock).mockResolvedValue(null)
    // Default: no custom permissions
    ;(prisma.venueRolePermission.findUnique as jest.Mock).mockResolvedValue(null)
  })

  describe('Authentication Validation', () => {
    it('should return 401 if no authContext', async () => {
      mockReq.authContext = undefined
      const middleware = checkPermission('tpv:read')

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(statusMock).toHaveBeenCalledWith(401)
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Unauthorized',
        }),
      )
    })

    it('should return 401 if no userId in authContext', async () => {
      ;(mockReq as any).authContext = { venueId: 'venue_123' }
      const middleware = checkPermission('tpv:read')

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(statusMock).toHaveBeenCalledWith(401)
    })

    it('should return 400 if no venueId available', async () => {
      mockReq.params = {}
      ;(mockReq as any).authContext = { userId: 'user_123' }
      const middleware = checkPermission('tpv:read')

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(statusMock).toHaveBeenCalledWith(400)
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Venue ID required',
        }),
      )
    })
  })

  describe('SUPERADMIN Bypass', () => {
    it('should allow SUPERADMIN to bypass permission checks', async () => {
      ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue({ id: 'sv_superadmin' })

      const middleware = checkPermission('admin:nuclear-launch')

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalledWith()
      expect(permissionsLib.hasPermission).not.toHaveBeenCalled()
    })
  })

  describe('Permission Checks', () => {
    it('should allow access when user has permission', async () => {
      ;(permissionsLib.hasPermission as jest.Mock).mockReturnValue(true)

      const middleware = checkPermission('menu:read')

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(permissionsLib.hasPermission).toHaveBeenCalledWith(StaffRole.MANAGER, null, 'menu:read')
      expect(mockNext).toHaveBeenCalledWith()
    })

    it('should deny access when user lacks permission', async () => {
      ;(permissionsLib.hasPermission as jest.Mock).mockReturnValue(false)

      const middleware = checkPermission('admin:delete')

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(statusMock).toHaveBeenCalledWith(403)
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Forbidden',
          required: 'admin:delete',
        }),
      )
    })

    it('should use custom permissions from VenueRolePermission', async () => {
      const customPerms = ['custom:read', 'custom:write']
      ;(prisma.venueRolePermission.findUnique as jest.Mock).mockResolvedValue({
        permissions: customPerms,
      })
      ;(permissionsLib.hasPermission as jest.Mock).mockReturnValue(true)

      const middleware = checkPermission('custom:read')

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(permissionsLib.hasPermission).toHaveBeenCalledWith(StaffRole.MANAGER, customPerms, 'custom:read')
    })
  })

  describe('Multi-Venue Support', () => {
    it('should use venueId from URL params when different from token', async () => {
      mockReq.params = { venueId: 'different_venue_456' }
      ;(prisma.staffVenue.findUnique as jest.Mock).mockResolvedValue({ role: StaffRole.ADMIN, active: true })
      ;(permissionsLib.hasPermission as jest.Mock).mockReturnValue(true)

      const middleware = checkPermission('menu:read')

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(prisma.staffVenue.findUnique).toHaveBeenCalledWith({
        where: {
          staffId_venueId: {
            staffId: 'user_123',
            venueId: 'different_venue_456',
          },
        },
        select: { role: true, active: true, permissionSetId: true, permissionSet: true },
      })
      expect(permissionsLib.hasPermission).toHaveBeenCalledWith(StaffRole.ADMIN, null, 'menu:read')
    })

    it('should allow org OWNER fallback when no direct StaffVenue exists', async () => {
      mockReq.params = { venueId: 'different_venue_456' }
      ;(prisma.staffVenue.findUnique as jest.Mock).mockResolvedValue(null)
      ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ organizationId: 'org_123' })
      ;(prisma.staffOrganization.findUnique as jest.Mock).mockResolvedValue({
        role: 'OWNER',
        isActive: true,
      })
      ;(permissionsLib.hasPermission as jest.Mock).mockReturnValue(true)

      const middleware = checkPermission('menu:read')

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(permissionsLib.hasPermission).toHaveBeenCalledWith(StaffRole.OWNER, null, 'menu:read')
      expect(mockNext).toHaveBeenCalledWith()
    })

    it('should return 403 when user has no access to URL venue', async () => {
      mockReq.params = { venueId: 'inaccessible_venue' }
      ;(prisma.staffVenue.findUnique as jest.Mock).mockResolvedValue(null)
      ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ organizationId: 'org_other' })
      ;(prisma.staffOrganization.findUnique as jest.Mock).mockResolvedValue(null)

      const middleware = checkPermission('menu:read')

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(statusMock).toHaveBeenCalledWith(403)
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'No access to this venue',
        }),
      )
    })

    describe('x-venue-id header (org-scoped endpoints)', () => {
      it('uses x-venue-id header when no URL param is present', async () => {
        // Org-scoped endpoint: URL has no :venueId. Client passes header so the
        // backend evaluates the user's role in THAT venue, not the stale JWT venue.
        mockReq.params = {}
        ;(mockReq as any).headers = { 'x-venue-id': 'venue_from_header' }
        ;(prisma.staffVenue.findUnique as jest.Mock).mockResolvedValue({
          role: StaffRole.MANAGER,
          active: true,
          permissionSetId: null,
          permissionSet: null,
        })
        ;(permissionsLib.hasPermission as jest.Mock).mockReturnValue(true)

        const middleware = checkPermission('sim-custody:collect-from-promoter')
        await middleware(mockReq as Request, mockRes as Response, mockNext)

        expect(prisma.staffVenue.findUnique).toHaveBeenCalledWith({
          where: { staffId_venueId: { staffId: 'user_123', venueId: 'venue_from_header' } },
          select: { role: true, active: true, permissionSetId: true, permissionSet: true },
        })
        expect(mockNext).toHaveBeenCalledWith()
      })

      it('URL param wins over x-venue-id header (URL is the most explicit)', async () => {
        mockReq.params = { venueId: 'venue_from_url' }
        ;(mockReq as any).headers = { 'x-venue-id': 'venue_from_header' }
        ;(prisma.staffVenue.findUnique as jest.Mock).mockResolvedValue({
          role: StaffRole.MANAGER,
          active: true,
          permissionSetId: null,
          permissionSet: null,
        })
        ;(permissionsLib.hasPermission as jest.Mock).mockReturnValue(true)

        const middleware = checkPermission('menu:read')
        await middleware(mockReq as Request, mockRes as Response, mockNext)

        expect(prisma.staffVenue.findUnique).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { staffId_venueId: { staffId: 'user_123', venueId: 'venue_from_url' } },
          }),
        )
      })

      it('falls back to JWT venueId when neither URL param nor header is present', async () => {
        mockReq.params = {}
        ;(mockReq as any).headers = {}
        ;(permissionsLib.hasPermission as jest.Mock).mockReturnValue(true)

        const middleware = checkPermission('menu:read')
        await middleware(mockReq as Request, mockRes as Response, mockNext)

        // venue_123 comes from authContext.venueId in beforeEach
        expect(permissionsLib.hasPermission).toHaveBeenCalledWith(StaffRole.MANAGER, null, 'menu:read')
      })

      it('SECURITY: client cannot grant itself a role by sending an arbitrary x-venue-id', async () => {
        // User claims a venue where they have NO StaffVenue row and are not org owner.
        // The DB lookup is the source of truth, so role resolves to null → 403.
        mockReq.params = {}
        ;(mockReq as any).headers = { 'x-venue-id': 'venue_user_cannot_access' }
        ;(prisma.staffVenue.findUnique as jest.Mock).mockResolvedValue(null)
        ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ organizationId: 'org_other' })
        ;(prisma.staffOrganization.findUnique as jest.Mock).mockResolvedValue(null)

        const middleware = checkPermission('sim-custody:collect-from-promoter')
        await middleware(mockReq as Request, mockRes as Response, mockNext)

        expect(statusMock).toHaveBeenCalledWith(403)
        expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ message: 'No access to this venue' }))
        expect(mockNext).not.toHaveBeenCalled()
      })

      it('empty x-venue-id header is ignored (falls back to JWT)', async () => {
        mockReq.params = {}
        ;(mockReq as any).headers = { 'x-venue-id': '' }
        ;(permissionsLib.hasPermission as jest.Mock).mockReturnValue(true)

        const middleware = checkPermission('menu:read')
        await middleware(mockReq as Request, mockRes as Response, mockNext)

        // Falls back to JWT venue_123 → uses token role MANAGER directly
        expect(permissionsLib.hasPermission).toHaveBeenCalledWith(StaffRole.MANAGER, null, 'menu:read')
      })
    })
  })

  describe('Error Handling', () => {
    it('should return 500 on unexpected errors', async () => {
      ;(prisma.staffVenue.findFirst as jest.Mock).mockRejectedValue(new Error('Database error'))

      const middleware = checkPermission('menu:read')

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(statusMock).toHaveBeenCalledWith(500)
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Internal Server Error',
        }),
      )
    })
  })

  describe('PIN de autorización de gerente (override)', () => {
    beforeEach(() => {
      // Por default: el switch APAGADO y sin token en el header.
      ;(prisma.venueSettings.findUnique as jest.Mock).mockResolvedValue({ managerPinOverrideEnabled: false })
      ;(prisma.permissionOverride.updateMany as jest.Mock).mockResolvedValue({ count: 0 })
      ;(permissionsLib.hasPermission as jest.Mock).mockReturnValue(false)
      ;(mockReq as any).headers = {}
      ;(mockReq as any).method = 'POST'
      ;(mockReq as any).originalUrl = '/api/v1/mobile/venues/venue_123/orders/o1/merge'
    })

    // 1. NUEVO
    it('switch OFF → el 403 NO lleva overridable', async () => {
      await checkPermission('orders:merge')(mockReq as Request, mockRes as Response, mockNext)

      expect(statusMock).toHaveBeenCalledWith(403)
      const body = jsonMock.mock.calls[0][0]
      expect(body).toEqual({
        error: 'Forbidden',
        message: "Permission 'orders:merge' required",
        required: 'orders:merge',
        userRole: 'MANAGER',
      })
      expect(body.overridable).toBeUndefined()
      expect(mockNext).not.toHaveBeenCalled()
    })

    it('switch ON → el 403 lleva overridable: true SIN perder ningún campo viejo', async () => {
      ;(prisma.venueSettings.findUnique as jest.Mock).mockResolvedValue({ managerPinOverrideEnabled: true })

      await checkPermission('orders:merge')(mockReq as Request, mockRes as Response, mockNext)

      expect(statusMock).toHaveBeenCalledWith(403)
      expect(jsonMock).toHaveBeenCalledWith({
        error: 'Forbidden',
        message: "Permission 'orders:merge' required",
        required: 'orders:merge',
        userRole: 'MANAGER',
        overridable: true,
      })
    })

    it('🔴 el 403 de MEMBRESÍA nunca lleva overridable (ningún PIN arregla no pertenecer al venue)', async () => {
      ;(prisma.venueSettings.findUnique as jest.Mock).mockResolvedValue({ managerPinOverrideEnabled: true })
      ;(prisma.staffVenue.findUnique as jest.Mock).mockResolvedValue(null)
      ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ organizationId: 'org_999' })
      ;(prisma.staffOrganization.findUnique as jest.Mock).mockResolvedValue(null)
      ;(mockReq as any).authContext = { userId: 'user_123', venueId: 'otro_venue', orgId: 'org_123', role: undefined }

      await checkPermission('orders:merge')(mockReq as Request, mockRes as Response, mockNext)

      expect(statusMock).toHaveBeenCalledWith(403)
      expect(jsonMock).toHaveBeenCalledWith({ error: 'Forbidden', message: 'No access to this venue' })
    })

    it('token válido en el header → deja pasar y expone quién autorizó', async () => {
      ;(mockReq as any).headers = { 'x-permission-override': 'tok_abc' }
      ;(prisma.permissionOverride.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
      ;(prisma.permissionOverride.findUnique as jest.Mock).mockResolvedValue({ authorizedById: 'sv_manager' })

      await checkPermission('orders:merge')(mockReq as Request, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalled()
      expect(statusMock).not.toHaveBeenCalled()
      expect((mockReq as any).authContext.overrideAuthorizedBy).toBe('sv_manager')
    })

    it('el consumo exige token + venue + permiso, sin usar y sin expirar', async () => {
      ;(mockReq as any).headers = { 'x-permission-override': 'tok_abc' }
      ;(prisma.permissionOverride.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
      ;(prisma.permissionOverride.findUnique as jest.Mock).mockResolvedValue({ authorizedById: 'sv_manager' })

      await checkPermission('orders:merge')(mockReq as Request, mockRes as Response, mockNext)

      const where = (prisma.permissionOverride.updateMany as jest.Mock).mock.calls[0][0].where
      expect(where).toMatchObject({
        token: 'tok_abc',
        venueId: 'venue_123',
        permission: 'orders:merge',
        consumedAt: null,
      })
      expect(where.expiresAt.gt).toBeInstanceOf(Date)
    })

    it('🔴 token ya usado o expirado (count 0) → 403, NO pasa', async () => {
      ;(mockReq as any).headers = { 'x-permission-override': 'tok_usado' }
      ;(prisma.venueSettings.findUnique as jest.Mock).mockResolvedValue({ managerPinOverrideEnabled: true })
      ;(prisma.permissionOverride.updateMany as jest.Mock).mockResolvedValue({ count: 0 })

      await checkPermission('orders:merge')(mockReq as Request, mockRes as Response, mockNext)

      expect(mockNext).not.toHaveBeenCalled()
      expect(statusMock).toHaveBeenCalledWith(403)
      expect(jsonMock.mock.calls[0][0]).toMatchObject({ required: 'orders:merge', overridable: true })
    })

    it('token de OTRO permiso no sirve (el WHERE lo filtra → count 0 → 403)', async () => {
      ;(mockReq as any).headers = { 'x-permission-override': 'tok_de_refund' }
      ;(prisma.permissionOverride.updateMany as jest.Mock).mockResolvedValue({ count: 0 })

      await checkPermission('orders:merge')(mockReq as Request, mockRes as Response, mockNext)

      expect(statusMock).toHaveBeenCalledWith(403)
      expect((prisma.permissionOverride.updateMany as jest.Mock).mock.calls[0][0].where.permission).toBe('orders:merge')
    })

    it('un fallo al leer el switch NO convierte el 403 en 500', async () => {
      ;(prisma.venueSettings.findUnique as jest.Mock).mockRejectedValue(new Error('db down'))

      await checkPermission('orders:merge')(mockReq as Request, mockRes as Response, mockNext)

      expect(statusMock).toHaveBeenCalledWith(403)
      expect(statusMock).not.toHaveBeenCalledWith(500)
    })

    it('un fallo al consumir el token NO convierte el 403 en 500', async () => {
      ;(mockReq as any).headers = { 'x-permission-override': 'tok_abc' }
      ;(prisma.permissionOverride.updateMany as jest.Mock).mockRejectedValue(new Error('db down'))

      await checkPermission('orders:merge')(mockReq as Request, mockRes as Response, mockNext)

      expect(statusMock).toHaveBeenCalledWith(403)
      expect(statusMock).not.toHaveBeenCalledWith(500)
      expect(mockNext).not.toHaveBeenCalled()
    })

    // 2. REGRESIÓN
    it('con permiso, el override ni se consulta', async () => {
      ;(permissionsLib.hasPermission as jest.Mock).mockReturnValue(true)

      await checkPermission('orders:merge')(mockReq as Request, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalled()
      expect(prisma.venueSettings.findUnique).not.toHaveBeenCalled()
      expect(prisma.permissionOverride.updateMany).not.toHaveBeenCalled()
    })

    it('SUPERADMIN sigue pasando sin tocar nada del override', async () => {
      ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue({ id: 'sv_super' })

      await checkPermission('orders:merge')(mockReq as Request, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalled()
      expect(prisma.permissionOverride.updateMany).not.toHaveBeenCalled()
    })
  })
})

describe('checkAnyPermission Middleware', () => {
  let mockReq: Partial<Request>
  let mockRes: Partial<Response>
  let mockNext: NextFunction
  let jsonMock: jest.Mock
  let statusMock: jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()

    jsonMock = jest.fn()
    statusMock = jest.fn(() => mockRes as Response)

    mockReq = {
      params: { venueId: 'venue_123' },
      authContext: {
        userId: 'user_123',
        venueId: 'venue_123',
        orgId: 'org_123',
        role: 'MANAGER',
      },
    } as any

    mockRes = {
      status: statusMock,
      json: jsonMock,
    }

    mockNext = jest.fn()
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(null)
    ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ organizationId: 'org_123' })
    ;(prisma.staffOrganization.findUnique as jest.Mock).mockResolvedValue(null)
    ;(prisma.venueRolePermission.findUnique as jest.Mock).mockResolvedValue(null)
  })

  it('should allow access if user has ANY of the permissions', async () => {
    ;(permissionsLib.hasPermission as jest.Mock)
      .mockReturnValueOnce(false) // First permission
      .mockReturnValueOnce(true) // Second permission

    const middleware = checkAnyPermission(['admin:delete', 'menu:read'])

    await middleware(mockReq as Request, mockRes as Response, mockNext)

    expect(mockNext).toHaveBeenCalledWith()
  })

  it('should deny access if user has NONE of the permissions', async () => {
    ;(permissionsLib.hasPermission as jest.Mock).mockReturnValue(false)

    const middleware = checkAnyPermission(['admin:delete', 'admin:nuclear'])

    await middleware(mockReq as Request, mockRes as Response, mockNext)

    expect(statusMock).toHaveBeenCalledWith(403)
  })
})

describe('checkAllPermissions Middleware', () => {
  let mockReq: Partial<Request>
  let mockRes: Partial<Response>
  let mockNext: NextFunction
  let jsonMock: jest.Mock
  let statusMock: jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()

    jsonMock = jest.fn()
    statusMock = jest.fn(() => mockRes as Response)

    mockReq = {
      params: { venueId: 'venue_123' },
      authContext: {
        userId: 'user_123',
        venueId: 'venue_123',
        orgId: 'org_123',
        role: 'MANAGER',
      },
    } as any

    mockRes = {
      status: statusMock,
      json: jsonMock,
    }

    mockNext = jest.fn()
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(null)
    ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ organizationId: 'org_123' })
    ;(prisma.staffOrganization.findUnique as jest.Mock).mockResolvedValue(null)
    ;(prisma.venueRolePermission.findUnique as jest.Mock).mockResolvedValue(null)
  })

  it('should allow access if user has ALL of the permissions', async () => {
    ;(permissionsLib.hasPermission as jest.Mock).mockReturnValue(true)

    const middleware = checkAllPermissions(['menu:read', 'orders:read'])

    await middleware(mockReq as Request, mockRes as Response, mockNext)

    expect(mockNext).toHaveBeenCalledWith()
    expect(permissionsLib.hasPermission).toHaveBeenCalledTimes(2)
  })

  it('should deny access if user is missing ANY of the permissions', async () => {
    ;(permissionsLib.hasPermission as jest.Mock)
      .mockReturnValueOnce(true) // First permission
      .mockReturnValueOnce(false) // Second permission

    const middleware = checkAllPermissions(['menu:read', 'admin:delete'])

    await middleware(mockReq as Request, mockRes as Response, mockNext)

    expect(statusMock).toHaveBeenCalledWith(403)
  })
})
