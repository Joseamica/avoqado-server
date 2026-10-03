import { DEFAULT_PERMISSIONS, INDIVIDUAL_PERMISSIONS_BY_RESOURCE, PERMISSION_DEPENDENCIES } from '@/lib/permissions'

describe('staffpay:close (spec §9.2)', () => {
  it('existe en el catálogo del recurso staffpay', () => {
    expect(INDIVIDUAL_PERMISSIONS_BY_RESOURCE.staffpay).toEqual(['staffpay:read', 'staffpay:manage', 'staffpay:close'])
  })
  it('sólo OWNER lo trae por default; ADMIN no', () => {
    expect(DEFAULT_PERMISSIONS.OWNER).toContain('staffpay:close')
    expect(DEFAULT_PERMISSIONS.ADMIN).not.toContain('staffpay:close')
  })
  it('arrastra leer y configurar (quien cierra tiene que ver lo que cierra)', () => {
    expect(PERMISSION_DEPENDENCIES['staffpay:close']).toEqual(
      expect.arrayContaining(['staffpay:read', 'staffpay:manage', 'teams:read', 'reservations:read']),
    )
  })
})
