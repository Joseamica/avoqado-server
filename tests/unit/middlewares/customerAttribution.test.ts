const mockRole = jest.fn()
const mockPermission = jest.fn()
const mockSuperadmin = jest.fn()
jest.mock('@/middlewares/checkPermission.middleware', () => ({ resolveUserRoleForVenue: (...a: unknown[]) => mockRole(...a) }))
jest.mock('@/middlewares/permissionFlag.middleware', () => ({ tienePermisoEnVenue: (...a: unknown[]) => mockPermission(...a) }))
jest.mock('@/services/access/rolVigente', () => ({ esSuperadminReal: (...a: unknown[]) => mockSuperadmin(...a) }))

import { customerAttributionActor, customerAttributionActorForRecordedPayment } from '@/middlewares/customerAttribution.middleware'

const request = (auth: Record<string, unknown> = {}) =>
  ({
    params: { venueId: 'venue-1' },
    authContext: { userId: 'staff-1', venueId: 'venue-old', role: 'OWNER', ...auth },
    body: { staffId: 'forged', canAssignHistorical: true },
  }) as any

beforeEach(() => {
  mockRole.mockResolvedValue({ role: 'MANAGER' })
  mockPermission.mockResolvedValue(true)
  mockSuperadmin.mockResolvedValue(false)
})

describe('autoridad del actor HTTP', () => {
  it('lee el rol en la sucursal de la URL y toma el actor del token, nunca el body', async () => {
    expect(await customerAttributionActor(request())).toEqual({ staffId: 'staff-1', canAssignHistorical: true, canAttachAtReceipt: true })
    expect(mockRole).toHaveBeenCalledWith(expect.objectContaining({ userId: 'staff-1', targetVenueId: 'venue-1' }))
  })
  it('un token viejo de OWNER o un permiso concedido a caja no supera el piso MANAGER', async () => {
    mockRole.mockResolvedValue({ role: 'CASHIER' })
    expect((await customerAttributionActor(request())).canAssignHistorical).toBe(false)
  })
  it('gerencia respeta el permiso negado por el negocio', async () => {
    mockPermission.mockImplementation(async (_req, permission) => permission !== 'orders:attach-customer')
    expect((await customerAttributionActor(request())).canAssignHistorical).toBe(false)
  })
  it('un superadmin impersonando a caja no recupera su autoridad global', async () => {
    mockSuperadmin.mockResolvedValue(true)
    mockRole.mockResolvedValue({ role: 'CASHIER' })
    expect((await customerAttributionActor(request({ isImpersonating: true }))).canAssignHistorical).toBe(false)
  })
  it('un fallo de permisos no impide registrar dinero recibido, pero tampoco autoriza la liga', async () => {
    mockPermission.mockRejectedValue(new Error('database unavailable'))
    expect(await customerAttributionActorForRecordedPayment(request())).toEqual({ staffId: 'staff-1' })
  })
})
