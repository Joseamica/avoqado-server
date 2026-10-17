/**
 * A4 (P1-03): en marca blanca, los permisos se filtran por la función de la configuración del negocio
 * (`PERMISSION_TO_FEATURE_MAP` contra `featureAccess`). Un permiso SIN entrada se conserva tal cual, así que los de pedidos en
 * línea pasaban el filtro aunque el negocio tuviera apagada la función de pedidos. Se prueba con el filtro REAL
 * (`getUserAccess`), sólo con la base simulada.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { getUserAccess, hasPermission, PERMISSION_TO_FEATURE_MAP } from '@/services/access/access.service'

const PEDIDOS_EN_LINEA = ['online-orders:manage', 'online-orders:pause']

function negocio(marcaBlanca: { enabledFeatures: Array<{ code: string; source: string; access?: unknown }> } | null) {
  prismaMock.staffVenue.findFirst.mockResolvedValue(null) // no es superadmin
  prismaMock.staffVenue.findUnique.mockResolvedValue({
    role: 'MANAGER',
    active: true,
    permissionSetId: null,
    permissionSet: null,
    venue: { organizationId: 'org1' },
  } as any)
  prismaMock.venue.findUnique.mockResolvedValue({ organizationId: 'org1' } as any)
  prismaMock.venueModule.findFirst.mockResolvedValue(marcaBlanca ? ({ enabled: true, config: marcaBlanca } as any) : null)
  prismaMock.organizationModule.findFirst.mockResolvedValue(null)
  prismaMock.venueRolePermission.findMany.mockResolvedValue([])
  prismaMock.staffOrganization.findMany.mockResolvedValue([])
  prismaMock.staff.findUnique.mockResolvedValue({ active: true } as any)
}

describe('marca blanca: los permisos de pedidos en línea siguen a la función de pedidos (AVOQADO_ORDERS)', () => {
  it.each(PEDIDOS_EN_LINEA)('%s está mapeado al MISMO código que los pedidos (no a uno que la configuración no usa)', permiso => {
    expect(PERMISSION_TO_FEATURE_MAP[permiso]).toBe('AVOQADO_ORDERS')
    expect(PERMISSION_TO_FEATURE_MAP['orders:read']).toBe('AVOQADO_ORDERS')
  })

  it('pedidos APAGADOS en la marca blanca ⇒ el gerente pierde administrar y pausar la tienda en línea', async () => {
    negocio({ enabledFeatures: [{ code: 'AVOQADO_MENU', source: 'core' }] })
    const access = await getUserAccess('staff1', 'v1')
    expect(access.whiteLabelEnabled).toBe(true)
    for (const permiso of PEDIDOS_EN_LINEA) expect(hasPermission(access, permiso)).toBe(false)
  })

  it('pedidos PRENDIDOS para su rol ⇒ los conserva', async () => {
    negocio({ enabledFeatures: [{ code: 'AVOQADO_ORDERS', source: 'core' }] })
    const access = await getUserAccess('staff1', 'v1')
    for (const permiso of PEDIDOS_EN_LINEA) expect(hasPermission(access, permiso)).toBe(true)
  })

  it('pedidos prendidos sólo para el DUEÑO ⇒ el gerente no los conserva', async () => {
    negocio({
      enabledFeatures: [{ code: 'AVOQADO_ORDERS', source: 'core', access: { allowedRoles: ['OWNER'], dataScope: 'venue' } }],
    })
    const access = await getUserAccess('staff1', 'v1')
    for (const permiso of PEDIDOS_EN_LINEA) expect(hasPermission(access, permiso)).toBe(false)
  })

  it('sin marca blanca no cambia nada: el gerente los tiene por default', async () => {
    negocio(null)
    const access = await getUserAccess('staff1', 'v1')
    expect(access.whiteLabelEnabled).toBe(false)
    for (const permiso of PEDIDOS_EN_LINEA) expect(hasPermission(access, permiso)).toBe(true)
  })
})
