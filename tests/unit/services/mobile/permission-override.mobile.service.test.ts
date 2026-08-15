import { StaffRole } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import {
  createPermissionOverride,
  consumePermissionOverride,
  isManagerPinOverrideEnabled,
  OverrideInvalidPinError,
  OverrideInsufficientError,
  OVERRIDE_TTL_MS,
} from '@/services/mobile/permission-override.mobile.service'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staffVenue: { findFirst: jest.fn() },
    venueRolePermission: { findUnique: jest.fn() },
    venueSettings: { findUnique: jest.fn() },
    permissionOverride: { create: jest.fn(), updateMany: jest.fn(), findUnique: jest.fn() },
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

const VENUE = 'venue_1'
const NOW = new Date('2026-08-15T18:00:00.000Z')

const managerStaffVenue = {
  id: 'sv_manager',
  role: StaffRole.MANAGER,
  permissionSetId: null,
  permissionSet: null,
  staff: { firstName: 'Laura', lastName: 'Méndez' },
}

const waiterStaffVenue = {
  ...managerStaffVenue,
  id: 'sv_waiter',
  role: StaffRole.WAITER,
  staff: { firstName: 'Beto', lastName: 'Cruz' },
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(prisma.venueRolePermission.findUnique as jest.Mock).mockResolvedValue(null)
  ;(prisma.permissionOverride.create as jest.Mock).mockImplementation(async ({ data }: any) => data)
})

describe('createPermissionOverride', () => {
  // 1. NUEVO
  it('PIN que no existe en el venue → OverrideInvalidPinError', async () => {
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(null)
    await expect(createPermissionOverride({ venueId: VENUE, pin: '9999', permission: 'orders:merge', now: NOW })).rejects.toBeInstanceOf(
      OverrideInvalidPinError,
    )
    expect(prisma.permissionOverride.create).not.toHaveBeenCalled()
  })

  it('PIN correcto pero SIN ese permiso → OverrideInsufficientError', async () => {
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(waiterStaffVenue)
    await expect(createPermissionOverride({ venueId: VENUE, pin: '1234', permission: 'orders:merge', now: NOW })).rejects.toBeInstanceOf(
      OverrideInsufficientError,
    )
    expect(prisma.permissionOverride.create).not.toHaveBeenCalled()
  })

  it('🔴 el rechazo por insuficiencia dice de QUIÉN era el código — es lo que se audita', async () => {
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(waiterStaffVenue)
    await expect(createPermissionOverride({ venueId: VENUE, pin: '1234', permission: 'orders:merge', now: NOW })).rejects.toMatchObject({
      code: 'OVERRIDE_INSUFFICIENT',
      authorizer: { staffVenueId: 'sv_waiter', role: StaffRole.WAITER },
    })
  })

  it('PIN correcto CON el permiso → token de 60 s atado a ese permiso y venue', async () => {
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(managerStaffVenue)
    const result = await createPermissionOverride({
      venueId: VENUE,
      pin: '1234567890',
      permission: 'orders:merge',
      requestedById: 'sv_waiter',
      now: NOW,
    })
    expect(result.token).toEqual(expect.any(String))
    expect(result.token.length).toBeGreaterThan(20)
    expect(result.expiresAt.getTime()).toBe(NOW.getTime() + OVERRIDE_TTL_MS)
    expect(result.authorizedBy).toEqual({ id: 'sv_manager', name: 'Laura Méndez' })
    expect(prisma.permissionOverride.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        venueId: VENUE,
        permission: 'orders:merge',
        authorizedById: 'sv_manager',
        requestedById: 'sv_waiter',
      }),
    })
  })

  it('busca sólo empleados ACTIVOS de ESE venue', async () => {
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(managerStaffVenue)
    await createPermissionOverride({ venueId: VENUE, pin: '1234', permission: 'orders:merge', now: NOW })
    expect(prisma.staffVenue.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ venueId: VENUE, pin: '1234', active: true }) }),
    )
  })

  it('respeta un permissionSet asignado en vez del rol', async () => {
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue({
      ...waiterStaffVenue,
      permissionSetId: 'ps_1',
      permissionSet: { permissions: ['orders:read', 'orders:update', 'orders:merge'] },
    })
    const result = await createPermissionOverride({ venueId: VENUE, pin: '1111', permission: 'orders:merge', now: NOW })
    expect(result.authorizedBy.id).toBe('sv_waiter')
    // El permissionSet MANDA: ni siquiera se consulta VenueRolePermission.
    expect(prisma.venueRolePermission.findUnique).not.toHaveBeenCalled()
  })

  it('un permissionSet SIN el permiso sigue siendo insuficiente', async () => {
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue({
      ...waiterStaffVenue,
      permissionSetId: 'ps_1',
      permissionSet: { permissions: ['orders:read', 'orders:update'] },
    })
    await expect(createPermissionOverride({ venueId: VENUE, pin: '1111', permission: 'orders:merge', now: NOW })).rejects.toBeInstanceOf(
      OverrideInsufficientError,
    )
  })

  it('🔴 un VenueRolePermission del venue que SÍ concede el permiso alcanza — mismo camino que checkPermission', async () => {
    // Sin conjunto asignado, la puerta mira VenueRolePermission + rol. Un venue
    // que le dio orders:merge a sus meseros debe poder autorizar con ese PIN:
    // si aquí resolviéramos distinto, el PIN se aceptaría (o se rechazaría) y
    // luego la acción haría lo contrario.
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(waiterStaffVenue)
    ;(prisma.venueRolePermission.findUnique as jest.Mock).mockResolvedValue({
      permissions: ['orders:read', 'orders:update', 'orders:merge'],
    })
    const result = await createPermissionOverride({ venueId: VENUE, pin: '1234', permission: 'orders:merge', now: NOW })
    expect(result.authorizedBy.id).toBe('sv_waiter')
    expect(prisma.venueRolePermission.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId_role: { venueId: VENUE, role: StaffRole.WAITER } } }),
    )
  })
})

describe('consumePermissionOverride', () => {
  it('consume con un update ATÓMICO que exige sin usar y sin expirar', async () => {
    ;(prisma.permissionOverride.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
    ;(prisma.permissionOverride.findUnique as jest.Mock).mockResolvedValue({ authorizedById: 'sv_manager' })

    const result = await consumePermissionOverride({
      token: 'tok_1',
      venueId: VENUE,
      permission: 'orders:merge',
      route: 'POST /api/v1/mobile/venues/:venueId/orders/:orderId/merge',
      now: NOW,
    })

    expect(result).toEqual({ authorizedById: 'sv_manager' })
    expect(prisma.permissionOverride.updateMany).toHaveBeenCalledWith({
      where: {
        token: 'tok_1',
        venueId: VENUE,
        permission: 'orders:merge',
        consumedAt: null,
        expiresAt: { gt: NOW },
      },
      data: { consumedAt: NOW, consumedRoute: 'POST /api/v1/mobile/venues/:venueId/orders/:orderId/merge' },
    })
  })

  it('🔴 segundo consumo del MISMO token → null (count 0 = otro ganó la carrera)', async () => {
    ;(prisma.permissionOverride.updateMany as jest.Mock).mockResolvedValue({ count: 0 })
    const result = await consumePermissionOverride({
      token: 'tok_1',
      venueId: VENUE,
      permission: 'orders:merge',
      route: 'r',
      now: NOW,
    })
    expect(result).toBeNull()
    expect(prisma.permissionOverride.findUnique).not.toHaveBeenCalled()
  })

  it('un token de OTRO permiso no sirve', async () => {
    ;(prisma.permissionOverride.updateMany as jest.Mock).mockResolvedValue({ count: 0 })
    const result = await consumePermissionOverride({
      token: 'tok_1',
      venueId: VENUE,
      permission: 'payments:refund',
      route: 'r',
      now: NOW,
    })
    expect(result).toBeNull()
  })

  it('un token de OTRO venue no sirve', async () => {
    ;(prisma.permissionOverride.updateMany as jest.Mock).mockResolvedValue({ count: 0 })
    const result = await consumePermissionOverride({
      token: 'tok_1',
      venueId: 'venue_2',
      permission: 'orders:merge',
      route: 'r',
      now: NOW,
    })
    expect(result).toBeNull()
  })

  it('nunca lanza si la base falla al consumir — el 403 de siempre gana', async () => {
    ;(prisma.permissionOverride.updateMany as jest.Mock).mockRejectedValue(new Error('db down'))
    await expect(
      consumePermissionOverride({ token: 'tok_1', venueId: VENUE, permission: 'orders:merge', route: 'r', now: NOW }),
    ).resolves.toBeNull()
  })
})

describe('isManagerPinOverrideEnabled', () => {
  it('true cuando el switch del venue está ON', async () => {
    ;(prisma.venueSettings.findUnique as jest.Mock).mockResolvedValue({ managerPinOverrideEnabled: true })
    await expect(isManagerPinOverrideEnabled(VENUE)).resolves.toBe(true)
  })

  it('false cuando está OFF', async () => {
    ;(prisma.venueSettings.findUnique as jest.Mock).mockResolvedValue({ managerPinOverrideEnabled: false })
    await expect(isManagerPinOverrideEnabled(VENUE)).resolves.toBe(false)
  })

  it('false — y NUNCA lanza — si el venue no tiene fila de settings', async () => {
    ;(prisma.venueSettings.findUnique as jest.Mock).mockResolvedValue(null)
    await expect(isManagerPinOverrideEnabled(VENUE)).resolves.toBe(false)
  })

  it('false — y NUNCA lanza — si la consulta revienta', async () => {
    ;(prisma.venueSettings.findUnique as jest.Mock).mockRejectedValue(new Error('db down'))
    await expect(isManagerPinOverrideEnabled(VENUE)).resolves.toBe(false)
  })
})
