import { StaffRole } from '@prisma/client'
import { hasWastePermission } from '@/services/shared/inventoryWaste.service'
import type { UserAccess } from '@/services/access/access.service'

jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: {} }))

const acceso = (over: Partial<UserAccess>): UserAccess => ({
  userId: 'u',
  venueId: 'v',
  organizationId: 'o',
  role: StaffRole.WAITER,
  corePermissions: ['inventory:log-waste'],
  whiteLabelEnabled: false,
  enabledFeatures: [],
  featureAccess: {},
  featureMetadata: {},
  ...over,
})

describe('hasWastePermission · white-label', () => {
  it('sin white-label manda el permiso', () => {
    expect(hasWastePermission(acceso({}), 'inventory:log-waste')).toBe(true)
    expect(hasWastePermission(acceso({ corePermissions: [] }), 'inventory:log-waste')).toBe(false)
  })

  it('🔴 white-label SIN AVOQADO_INVENTORY lo niega aunque el rol lo traiga', () => {
    expect(hasWastePermission(acceso({ whiteLabelEnabled: true }), 'inventory:log-waste')).toBe(false)
  })

  it('white-label con AVOQADO_INVENTORY NO permitido para el rol también lo niega', () => {
    const a = acceso({ whiteLabelEnabled: true, featureAccess: { AVOQADO_INVENTORY: { allowed: false } as never } })
    expect(hasWastePermission(a, 'inventory:log-waste')).toBe(false)
  })

  it('white-label CON AVOQADO_INVENTORY permitido lo concede', () => {
    const a = acceso({ whiteLabelEnabled: true, featureAccess: { AVOQADO_INVENTORY: { allowed: true } as never } })
    expect(hasWastePermission(a, 'inventory:log-waste')).toBe(true)
  })

  it('🔴 el plan (INVENTORY_TRACKING) no sustituye a la activación white-label', () => {
    const a = acceso({ whiteLabelEnabled: true, featureAccess: { INVENTORY_TRACKING: { allowed: true } as never } })
    expect(hasWastePermission(a, 'inventory:log-waste')).toBe(false)
  })

  it('SUPERADMIN pasa siempre', () => {
    expect(
      hasWastePermission(acceso({ role: StaffRole.SUPERADMIN, whiteLabelEnabled: true, corePermissions: [] }), 'inventory:log-waste'),
    ).toBe(true)
  })
})
