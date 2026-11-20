/**
 * Tarjeta `hz:nube0000:na1d52b5`, Codex r11 #2: la recomendación sólo ofrece piezas sin Premium a quien puede GUARDARLAS, con el acceso
 * efectivo que dejó `verifyAccess` (`req.access`: marca blanca y suplantación ya resueltas).
 */
jest.mock('@/services/dashboard/productInventoryIntegration.service', () => ({ shouldProductUseInventory: jest.fn() }))
jest.mock('@/middlewares/checkFeatureAccess.middleware', () => ({ requestIsSuperAdmin: jest.fn().mockResolvedValue(false) }))

import { StaffRole } from '@prisma/client'
import { shouldProductUseInventory } from '@/services/dashboard/productInventoryIntegration.service'
import { shouldUseInventory } from '@/controllers/dashboard/inventory/productWizard.controller'

const recomendar = shouldProductUseInventory as jest.Mock
const ultimo = () => recomendar.mock.calls[recomendar.mock.calls.length - 1][1]
const acceso = (extra: Record<string, unknown> = {}) => ({
  role: StaffRole.MANAGER,
  corePermissions: ['inventory:read', 'inventory:update', 'menu:create'],
  whiteLabelEnabled: false,
  enabledFeatures: [],
  featureAccess: {},
  ...extra,
})

async function pide(access: unknown, authContext: Record<string, unknown> = { userId: 'u1' }): Promise<unknown> {
  recomendar.mockResolvedValue({ ok: true })
  const res: any = { json: jest.fn() }
  const next = jest.fn()
  await shouldUseInventory({ params: { venueId: 'v1' }, authContext, access } as any, res, next)
  expect(next).not.toHaveBeenCalled()
  return recomendar.mock.calls[recomendar.mock.calls.length - 1][1].puedeGuardarPiezasSinPremium
}

describe('shouldUseInventory — piezas sólo a quien puede guardarlas (na1d52b5, Codex r11 #2)', () => {
  beforeEach(() => jest.clearAllMocks())

  // NEW FEATURE TESTS
  it('rol con inventario de sólo lectura: no se ofrecen', async () => {
    expect(await pide(acceso({ corePermissions: ['inventory:read', 'menu:create'] }))).toBe(false)
  })

  it('sin permiso de alta de productos: no se ofrecen', async () => {
    expect(await pide(acceso({ corePermissions: ['inventory:read', 'inventory:update'] }))).toBe(false)
  })

  it('marca blanca con Menú apagado (aunque el rol traiga el comodín): no se ofrecen', async () => {
    expect(
      await pide(
        acceso({
          corePermissions: ['inventory:*', 'menu:*'],
          whiteLabelEnabled: true,
          enabledFeatures: ['AVOQADO_INVENTORY'],
          featureAccess: { AVOQADO_INVENTORY: { allowed: true, dataScope: 'venue' } },
        }),
      ),
    ).toBe(false)
  })

  it('sesión de soporte «ver como» (siempre de sólo lectura): no se ofrecen aunque el rol simulado tenga los permisos (encargo 27fd34, Codex r13 #2)', async () => {
    const suplantando = { userId: 'u1', isImpersonating: true, impersonation: { mode: 'role', expiresAt: 9_999_999_999 } }
    expect(await pide(acceso(), suplantando)).toBe(false)
    expect(await pide(undefined, suplantando)).toBe(false)
    expect(ultimo().puedeGuardarConInventario).toBe(false) // tampoco con Premium
  })

  it('con Premium también cuenta el permiso de escribir inventario (encargo 27fd34, Codex r1 #2)', async () => {
    await pide(acceso({ corePermissions: ['inventory:read', 'menu:create'] }))
    expect(ultimo().puedeGuardarConInventario).toBe(false)
    // Para guardar con Premium no hace falta `menu:create` (Recetas da de alta así, Codex r3 #4).
    await pide(acceso({ corePermissions: ['inventory:read', 'inventory:update'] }))
    expect(ultimo().puedeGuardarConInventario).toBe(true)
    await pide(undefined)
    expect(ultimo().puedeGuardarConInventario).toBeUndefined()
  })

  // REGRESSION TESTS
  it('con los dos permisos y sin marca blanca: se ofrecen', async () => {
    expect(await pide(acceso())).toBe(true)
  })

  it('superadmin (el portero deja sólo su rol): se ofrecen', async () => {
    expect(await pide({ role: StaffRole.SUPERADMIN })).toBe(true)
  })

  it('sin acceso efectivo en la petición (otro llamador): sin dato, como antes', async () => {
    expect(await pide(undefined)).toBeUndefined()
  })
})
