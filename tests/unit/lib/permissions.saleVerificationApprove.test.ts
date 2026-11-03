/** `sale-verifications:approve`: decidir una venta. Gerente, administrador y dueño lo traen; PlayTelecom lo puede negar por rol. */
import { DEFAULT_PERMISSIONS, INDIVIDUAL_PERMISSIONS_BY_RESOURCE, hasPermission } from '@/lib/permissions'

const APPROVE = 'sale-verifications:approve'

describe('sale-verifications:approve', () => {
  it.each(['MANAGER', 'ADMIN', 'OWNER'] as const)('%s lo trae por defecto', role => {
    expect(DEFAULT_PERMISSIONS[role]).toContain(APPROVE)
  })

  it('está en el catálogo del editor de roles', () => {
    expect(INDIVIDUAL_PERMISSIONS_BY_RESOURCE['sale-verifications']).toContain(APPROVE)
  })

  it('la negación del negocio lo quita aunque el rol lo traiga', () => {
    expect(hasPermission('MANAGER', [], APPROVE, [APPROVE])).toBe(false)
    expect(hasPermission('MANAGER', [], APPROVE, null)).toBe(true)
  })

  it('negar approve no quita review (ver la pantalla)', () => {
    expect(hasPermission('MANAGER', [], 'sale-verifications:review', [APPROVE])).toBe(true)
  })
})
