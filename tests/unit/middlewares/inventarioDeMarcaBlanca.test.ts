/**
 * Tarjeta `hz:nube0000:na1d52b5`, Codex r10 #1: el portero real (`verifyAccess`) con el acceso que calcula la plataforma. Con marca blanca
 * e Inventario apagado, el filtro le quita `inventory:update` a Admin y Dueño pero les deja el comodín `inventory:*`: pedir sólo el permiso
 * deja pasar; pedir también la función `AVOQADO_INVENTORY` (como el alta con inventario y la recomendación) no.
 */
jest.mock('@/services/access/access.service', () => ({
  ...jest.requireActual('@/services/access/access.service'),
  getUserAccess: jest.fn(),
}))

import { StaffRole } from '@prisma/client'
import { getUserAccess } from '@/services/access/access.service'
import { verifyAccess } from '@/middlewares/verifyAccess.middleware'

const acceso = (extra: Record<string, unknown>) => ({
  userId: 'u1',
  venueId: 'v1',
  organizationId: 'o1',
  role: StaffRole.ADMIN,
  corePermissions: ['inventory:*', 'menu:*'],
  whiteLabelEnabled: true,
  enabledFeatures: ['AVOQADO_MENU'],
  featureAccess: { AVOQADO_MENU: { allowed: true, dataScope: 'venue' } },
  ...extra,
})

async function pasa(opciones: Parameters<typeof verifyAccess>[0]): Promise<boolean | number> {
  const req: any = { authContext: { userId: 'u1', venueId: 'v1' }, params: { venueId: 'v1' } }
  return new Promise(resolve => {
    void verifyAccess(opciones)(req, {} as any, (error?: any) => resolve(error ? (error.statusCode ?? 500) : true))
  })
}

describe('verifyAccess con Inventario de marca blanca (na1d52b5, Codex r10)', () => {
  beforeEach(() => jest.clearAllMocks())

  // NEW FEATURE TESTS
  it('Admin con comodín `inventory:*` y marca blanca SIN Inventario: el permiso solo pasa (el hueco); permiso + función no (403)', async () => {
    ;(getUserAccess as jest.Mock).mockResolvedValue(acceso({}))
    expect(await pasa({ permission: 'inventory:update' })).toBe(true)
    expect(await pasa({ permission: 'inventory:update', featureCode: 'AVOQADO_INVENTORY' })).toBe(403)
  })

  // REGRESSION TESTS
  it('marca blanca CON Inventario: pasa', async () => {
    ;(getUserAccess as jest.Mock).mockResolvedValue(
      acceso({
        enabledFeatures: ['AVOQADO_MENU', 'AVOQADO_INVENTORY'],
        featureAccess: { AVOQADO_INVENTORY: { allowed: true, dataScope: 'venue' } },
      }),
    )
    expect(await pasa({ permission: 'inventory:update', featureCode: 'AVOQADO_INVENTORY' })).toBe(true)
  })

  it('sin marca blanca: la función siempre pasa y manda el permiso', async () => {
    ;(getUserAccess as jest.Mock).mockResolvedValue(acceso({ whiteLabelEnabled: false, enabledFeatures: [], featureAccess: {} }))
    expect(await pasa({ permission: 'inventory:update', featureCode: 'AVOQADO_INVENTORY' })).toBe(true)
    ;(getUserAccess as jest.Mock).mockResolvedValue(
      acceso({ whiteLabelEnabled: false, corePermissions: ['menu:read'], enabledFeatures: [], featureAccess: {} }),
    )
    expect(await pasa({ permission: 'inventory:update', featureCode: 'AVOQADO_INVENTORY' })).toBe(403)
  })
})
