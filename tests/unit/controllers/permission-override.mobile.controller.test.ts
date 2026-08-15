import { Request, Response, NextFunction } from 'express'
import { StaffRole } from '@prisma/client'
import { createOverride } from '@/controllers/mobile/permission-override.mobile.controller'
import * as service from '@/services/mobile/permission-override.mobile.service'
import { OverrideInvalidPinError, OverrideInsufficientError } from '@/services/mobile/permission-override.mobile.service'
import { logAction } from '@/services/dashboard/activity-log.service'

jest.mock('@/services/mobile/permission-override.mobile.service', () => {
  const actual = jest.requireActual('@/services/mobile/permission-override.mobile.service')
  return { ...actual, createPermissionOverride: jest.fn() }
})

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { staffVenue: { findUnique: jest.fn().mockResolvedValue({ id: 'sv_waiter' }) } },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

describe('POST /mobile/venues/:venueId/permission-overrides', () => {
  let req: Partial<Request>
  let res: Partial<Response>
  let next: NextFunction
  let json: jest.Mock
  let status: jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()
    json = jest.fn()
    status = jest.fn(() => res as Response)
    res = { status, json } as any
    next = jest.fn()
    req = {
      params: { venueId: 'venue_1' },
      body: { pin: '1234567890', permission: 'orders:merge' },
      authContext: { userId: 'user_waiter', venueId: 'venue_1', role: 'WAITER' },
    } as any
  })

  it('201 con el token y quién autorizó', async () => {
    const expiresAt = new Date('2026-08-15T18:01:00.000Z')
    ;(service.createPermissionOverride as jest.Mock).mockResolvedValue({
      token: 'tok_abc',
      expiresAt,
      authorizedBy: { id: 'sv_manager', name: 'Laura Méndez' },
    })

    await createOverride(req as Request, res as Response, next)

    expect(status).toHaveBeenCalledWith(201)
    expect(json).toHaveBeenCalledWith({
      success: true,
      data: { token: 'tok_abc', expiresAt: expiresAt.toISOString(), authorizedBy: { id: 'sv_manager', name: 'Laura Méndez' } },
    })
  })

  it('401 OVERRIDE_INVALID_PIN cuando el código no existe', async () => {
    ;(service.createPermissionOverride as jest.Mock).mockRejectedValue(new OverrideInvalidPinError())
    await createOverride(req as Request, res as Response, next)
    expect(status).toHaveBeenCalledWith(401)
    expect(json).toHaveBeenCalledWith({ success: false, code: 'OVERRIDE_INVALID_PIN', message: 'Código incorrecto' })
  })

  it('403 OVERRIDE_INSUFFICIENT cuando el código existe pero no puede', async () => {
    ;(service.createPermissionOverride as jest.Mock).mockRejectedValue(new OverrideInsufficientError())
    await createOverride(req as Request, res as Response, next)
    expect(status).toHaveBeenCalledWith(403)
    expect(json).toHaveBeenCalledWith({
      success: false,
      code: 'OVERRIDE_INSUFFICIENT',
      message: 'Ese código tampoco tiene este permiso',
    })
  })

  it('🔴 un PIN válido SIN el permiso queda escrito en ActivityLog — es la señal de fraude interno', async () => {
    ;(service.createPermissionOverride as jest.Mock).mockRejectedValue(
      new OverrideInsufficientError({ staffVenueId: 'sv_cajero', role: StaffRole.CASHIER }),
    )

    await createOverride(req as Request, res as Response, next)

    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: 'user_waiter',
        venueId: 'venue_1',
        action: 'PERMISSION_OVERRIDE_INSUFFICIENT',
        entity: 'permission',
        entityId: 'orders:merge',
        data: expect.objectContaining({
          permission: 'orders:merge',
          authorizedByStaffVenueId: 'sv_cajero',
          authorizerRole: StaffRole.CASHIER,
        }),
      }),
    )
  })

  it('🔴 el PIN NUNCA se escribe en la bitácora', async () => {
    ;(service.createPermissionOverride as jest.Mock).mockRejectedValue(
      new OverrideInsufficientError({ staffVenueId: 'sv_cajero', role: StaffRole.CASHIER }),
    )

    await createOverride(req as Request, res as Response, next)

    expect(JSON.stringify((logAction as jest.Mock).mock.calls[0][0])).not.toContain('1234567890')
  })

  it('un código inexistente NO escribe el intento insuficiente (ese es otro caso)', async () => {
    ;(service.createPermissionOverride as jest.Mock).mockRejectedValue(new OverrideInvalidPinError())
    await createOverride(req as Request, res as Response, next)
    expect(logAction).not.toHaveBeenCalled()
  })

  it('un error inesperado va a next() — no se traga como 401', async () => {
    const boom = new Error('db down')
    ;(service.createPermissionOverride as jest.Mock).mockRejectedValue(boom)
    await createOverride(req as Request, res as Response, next)
    expect(next).toHaveBeenCalledWith(boom)
    expect(status).not.toHaveBeenCalled()
  })

  it('pasa el venueId de la ruta y el StaffVenue del bloqueado al servicio', async () => {
    ;(service.createPermissionOverride as jest.Mock).mockResolvedValue({
      token: 't',
      expiresAt: new Date(),
      authorizedBy: { id: 'x', name: 'y' },
    })
    await createOverride(req as Request, res as Response, next)
    expect(service.createPermissionOverride).toHaveBeenCalledWith(
      expect.objectContaining({ venueId: 'venue_1', pin: '1234567890', permission: 'orders:merge', requestedById: 'sv_waiter' }),
    )
  })
})
