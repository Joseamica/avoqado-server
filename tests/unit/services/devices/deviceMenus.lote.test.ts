/**
 * Aparatos claros (Codex r1 #4): `resolveDeviceMenuFilters` da, para varios aparatos, lo mismo que `resolveDeviceMenuFilter`
 * aparato por aparato, en lecturas fijas (no cuatro por aparato).
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { resolveDeviceMenuFilters, TODO } from '@/services/devices/deviceMenus.service'

jest.mock('@/services/access/basePlan.service', () => ({ venueHasFeatureAccess: jest.fn() }))
const tienePro = venueHasFeatureAccess as jest.Mock
const V = 'venue-1'

function prepara(filas: Array<[string, string]>, asignaciones: Array<[string, string]>, categorias: string[]) {
  prismaMock.terminalMenu.findMany.mockResolvedValue(filas.map(([terminalId, menuId]) => ({ terminalId, menuId })) as any)
  prismaMock.menuCategoryAssignment.findMany.mockResolvedValue(asignaciones.map(([menuId, categoryId]) => ({ menuId, categoryId })) as any)
  prismaMock.menuCategory.findMany.mockResolvedValue(categorias.map(id => ({ id, parentId: null })) as any)
}

describe('resolveDeviceMenuFilters (por lote)', () => {
  beforeEach(() => tienePro.mockReset().mockResolvedValue(true))

  it('cada aparato recibe sus categorías; el que no eligió nada, TODO; en 3 lecturas y un plan', async () => {
    prepara(
      [
        ['t_cre', 'm_cre'],
        ['t_caf', 'm_caf'],
      ],
      [
        ['m_cre', 'c_quesos'],
        ['m_cre', 'c_pan'],
        ['m_caf', 'c_cafe'],
      ],
      ['c_quesos', 'c_pan', 'c_cafe'],
    )
    const r = (await resolveDeviceMenuFilters(V, ['t_cre', 't_caf', 't_caja']))!
    expect(r.get('t_cre')).toEqual({ visibleCategoryIds: ['c_pan', 'c_quesos'], visibleMenuIds: ['m_cre'] })
    expect(r.get('t_caf')).toEqual({ visibleCategoryIds: ['c_cafe'], visibleMenuIds: ['m_caf'] })
    expect(r.get('t_caja')).toEqual(TODO)
    expect(prismaMock.terminalMenu.findMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.terminalMenu.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { terminalId: { in: ['t_cre', 't_caf', 't_caja'] }, menu: { venueId: V, active: true, appliesToDevices: true } } }),
    )
    expect(prismaMock.menuCategoryAssignment.findMany).toHaveBeenCalledTimes(1)
    expect(tienePro).toHaveBeenCalledTimes(1)
  })

  it('sin el plan todos ven TODO, como en la PC', async () => {
    prepara([['t_cre', 'm_cre']], [['m_cre', 'c_quesos']], ['c_quesos'])
    tienePro.mockResolvedValue(false)
    expect((await resolveDeviceMenuFilters(V, ['t_cre']))!.get('t_cre')).toEqual(TODO)
  })

  it('sin aparatos no lee nada', async () => {
    expect((await resolveDeviceMenuFilters(V, []))!.size).toBe(0)
    expect(prismaMock.terminalMenu.findMany).not.toHaveBeenCalled()
  })

  it('Codex r2 #2: pasado el tope de la lectura junta devuelve null (no se sabe), nunca «Todos» inventado', async () => {
    prismaMock.terminalMenu.findMany.mockResolvedValue([{ terminalId: 't1', menuId: 'm1' }] as any)
    prismaMock.menuCategoryAssignment.findMany.mockResolvedValue(
      Array.from({ length: 5001 }, (_, i) => ({ menuId: 'm1', categoryId: `c${i}` })) as any,
    )
    prismaMock.menuCategory.findMany.mockResolvedValue([] as any)
    expect(await resolveDeviceMenuFilters(V, ['t1'])).toBeNull()
  })
})
