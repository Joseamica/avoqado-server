import { prismaMock } from '@tests/__helpers__/setup'
import logger from '@/config/logger'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { resolveDeviceMenuFilter, visiblesDe, TODO, DEVICE_MENUS_CODE } from '@/services/devices/deviceMenus.service'
import { listMenus } from '@/services/mobile/menu.mobile.service'

jest.mock('@/services/access/basePlan.service', () => ({ venueHasFeatureAccess: jest.fn() }))
const tieneProMock = venueHasFeatureAccess as jest.Mock

const V = 'venue-1'
const T = 'term-1'
const cat = (id: string, parentId: string | null = null) => ({ id, parentId })

/** Prepara las tres lecturas: filas del aparato, asignaciones de esos menús y categorías activas. */
function prepara(opts: {
  filas: string[]
  asignaciones?: Array<[string, string]>
  categorias?: Array<{ id: string; parentId: string | null }>
}) {
  prismaMock.terminalMenu.findMany.mockResolvedValue(opts.filas.map(menuId => ({ menuId })) as any)
  prismaMock.menuCategoryAssignment.findMany.mockResolvedValue(
    (opts.asignaciones ?? []).map(([menuId, categoryId]) => ({ menuId, categoryId })) as any,
  )
  prismaMock.menuCategory.findMany.mockResolvedValue((opts.categorias ?? []) as any)
}

describe('visiblesDe (pura)', () => {
  it('une las categorías de los menús dados con sus subcategorías y ordena', () => {
    const r = visiblesDe(
      ['m2', 'm1'],
      [
        { menuId: 'm1', categoryId: 'c2' },
        { menuId: 'm2', categoryId: 'c1' },
        { menuId: 'm3', categoryId: 'c9' },
      ],
      [cat('c1'), cat('c2'), cat('c1a', 'c1'), cat('c9')],
    )
    expect(r).toEqual({ visibleCategoryIds: ['c1', 'c1a', 'c2'], visibleMenuIds: ['m1', 'm2'] })
  })
  it('sin categorías asignadas es TODO', () => {
    expect(visiblesDe(['m1'], [{ menuId: 'm2', categoryId: 'c1' }], [cat('c1')])).toEqual(TODO)
  })
  it('Ruling 15: una directa apagada sí va (como en Mesas), pero lo que cuelga de ella no se suma', () => {
    // c2 está apagada (no viene en las activas); c2a, activa, cuelga de ella
    const r = visiblesDe(['m1'], [{ menuId: 'm1', categoryId: 'c2' }], [cat('c1'), cat('c2a', 'c2')])
    expect(r).toEqual({ visibleCategoryIds: ['c2'], visibleMenuIds: ['m1'] })
  })
})

describe('resolveDeviceMenuFilter', () => {
  beforeEach(() => {
    tieneProMock.mockReset().mockResolvedValue(true)
  })

  it('sinFilasEsTodoYNoPreguntaElPlan', async () => {
    prepara({ filas: [] })
    expect(await resolveDeviceMenuFilter(V, T)).toEqual(TODO)
    expect(tieneProMock).not.toHaveBeenCalled()
    expect(prismaMock.menuCategoryAssignment.findMany).not.toHaveBeenCalled()
  })

  it('sinProEsTodoYNoBorraFilas', async () => {
    tieneProMock.mockResolvedValue(false)
    prepara({ filas: ['m1'] })
    expect(await resolveDeviceMenuFilter(V, T)).toEqual(TODO)
    expect(tieneProMock).toHaveBeenCalledWith(V, DEVICE_MENUS_CODE)
    expect(prismaMock.terminalMenu.deleteMany).not.toHaveBeenCalled()
    expect(prismaMock.menuCategoryAssignment.findMany).not.toHaveBeenCalled()
  })

  it('unMenuDaSusCategorias', async () => {
    prepara({ filas: ['m1'], asignaciones: [['m1', 'c1']], categorias: [cat('c1'), cat('c2')] })
    expect(await resolveDeviceMenuFilter(V, T)).toEqual({ visibleCategoryIds: ['c1'], visibleMenuIds: ['m1'] })
  })

  it('dosMenusDanLaUnion', async () => {
    prepara({
      filas: ['m1', 'm2'],
      asignaciones: [
        ['m1', 'c1'],
        ['m2', 'c2'],
        ['m2', 'c1'],
      ],
      categorias: [cat('c1'), cat('c2'), cat('c3')],
    })
    expect(await resolveDeviceMenuFilter(V, T)).toEqual({ visibleCategoryIds: ['c1', 'c2'], visibleMenuIds: ['m1', 'm2'] })
  })

  it('incluyeSubcategoriasActivasDeVariosNiveles', async () => {
    prepara({ filas: ['m1'], asignaciones: [['m1', 'c1']], categorias: [cat('c1'), cat('c2', 'c1'), cat('c3', 'c2'), cat('c4')] })
    expect((await resolveDeviceMenuFilter(V, T)).visibleCategoryIds).toEqual(['c1', 'c2', 'c3'])
  })

  it('conservaLasDirectasApagadas, sin sumar lo que cuelga de ellas (Ruling 15, igual que Mesas)', async () => {
    // c2 está apagada: no viene en la lista de activas. Va porque el menú la trae directo; c3 (activa, hija de c2) no se suma.
    prepara({
      filas: ['m1'],
      asignaciones: [
        ['m1', 'c1'],
        ['m1', 'c2'],
      ],
      categorias: [cat('c1'), cat('c3', 'c2')],
    })
    expect((await resolveDeviceMenuFilter(V, T)).visibleCategoryIds).toEqual(['c1', 'c2'])
  })

  it('unMenuSoloConUnaApagadaLaEntrega: la app decide si tiene productos', async () => {
    prepara({ filas: ['m1'], asignaciones: [['m1', 'c2']], categorias: [cat('c1')] })
    expect(await resolveDeviceMenuFilter(V, T)).toEqual({ visibleCategoryIds: ['c2'], visibleMenuIds: ['m1'] })
  })

  it('menuSinCategoriasEsTodo', async () => {
    prepara({ filas: ['m1'], asignaciones: [], categorias: [cat('c1')] })
    expect(await resolveDeviceMenuFilter(V, T)).toEqual(TODO)
  })

  it('ignoraMenusDeOtroNegocio', async () => {
    prepara({ filas: [] })
    await resolveDeviceMenuFilter('venue-actual', T)
    expect(prismaMock.terminalMenu.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { terminalId: T, menu: expect.objectContaining({ venueId: 'venue-actual' }) } }),
    )
  })

  it('menuApagadoONoParaAparatosNoCuenta', async () => {
    prepara({ filas: [] })
    await resolveDeviceMenuFilter(V, T)
    expect(prismaMock.terminalMenu.findMany).toHaveBeenCalledWith({
      where: { terminalId: T, menu: { venueId: V, active: true, appliesToDevices: true } },
      select: { menuId: true },
      orderBy: { menuId: 'asc' },
      take: 50,
    })
  })

  it('topeDeCategoriasPasadoEsTodoConAviso', async () => {
    prepara({ filas: ['m1'], asignaciones: [['m1', 'c1']], categorias: Array.from({ length: 2001 }, (_, i) => cat(`c${i}`)) })
    expect(await resolveDeviceMenuFilter(V, T)).toEqual(TODO)
    expect(logger.warn).toHaveBeenCalled()
  })

  it('topeDeAsignacionesPasadoEsTodoConAviso', async () => {
    prepara({
      filas: ['m1'],
      asignaciones: Array.from({ length: 5001 }, (_, i) => ['m1', `c${i}`] as [string, string]),
      categorias: [cat('c1')],
    })
    expect(await resolveDeviceMenuFilter(V, T)).toEqual(TODO)
    expect(logger.warn).toHaveBeenCalled()
  })

  it('ordenaLosIds', async () => {
    prepara({
      filas: ['m2', 'm1'],
      asignaciones: [
        ['m2', 'c9'],
        ['m1', 'c1'],
      ],
      categorias: [cat('c9'), cat('c1')],
    })
    expect(await resolveDeviceMenuFilter(V, T)).toEqual({ visibleCategoryIds: ['c1', 'c9'], visibleMenuIds: ['m1', 'm2'] })
  })
})

describe('Cobrar (/settings) y Mesas (/menus) dan las mismas categorías para el mismo aparato (Ruling 15, Codex r3 #1)', () => {
  beforeEach(() => tieneProMock.mockReset().mockResolvedValue(true))

  it('un menú con A encendida y B apagada: /settings trae lo mismo que categoryIds de ese menú en Mesas', async () => {
    // A (encendida) con su hija A1; B (apagada) con su hija B1, encendida: B va por directa, B1 no se suma en ninguno de los dos.
    const activas = [cat('A'), cat('A1', 'A'), cat('B1', 'B')]
    prepara({
      filas: ['m1'],
      asignaciones: [
        ['m1', 'A'],
        ['m1', 'B'],
      ],
      categorias: activas,
    })
    prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' } as any)
    prismaMock.menu.findMany.mockResolvedValue([
      {
        id: 'm1',
        name: 'Barra',
        description: null,
        isDefault: true,
        availableFrom: null,
        availableUntil: null,
        availableDays: [],
        startDate: null,
        endDate: null,
        categories: [
          { categoryId: 'A', displayOrder: 0 },
          { categoryId: 'B', displayOrder: 1 },
        ],
      },
    ] as any)

    const cobrar = await resolveDeviceMenuFilter(V, T)
    const mesas = (await listMenus(V)).menus.find(m => m.id === 'm1')!

    expect(cobrar.visibleCategoryIds).toEqual([...mesas.categoryIds].sort())
    expect(cobrar.visibleCategoryIds).toEqual(['A', 'A1', 'B'])
  })
})
