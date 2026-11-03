import { prismaMock } from '@tests/__helpers__/setup'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import {
  listDeviceMenus,
  listDeviceMenuOptions,
  listVenueMenuUsage,
  setTerminalMenus,
  POS_TERMINAL_TYPES,
} from '@/services/devices/deviceMenus.service'
import { DEVICE_MENUS_MIN_APP_VERSION } from '@/services/devices/deviceMenusAppVersion'

jest.mock('@/services/access/basePlan.service', () => ({ venueHasFeatureAccess: jest.fn() }))
const tieneProMock = venueHasFeatureAccess as jest.Mock
const logActionMock = logAction as jest.Mock

const V = 'cmvenue0000000000000000001'
const ORDEN_DE_MESAS = [{ isDefault: 'desc' }, { displayOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }]

/** Un aparato como lo regresa la lectura de la página (con sus menús ya filtrados al negocio, activos y para aparatos). */
const aparato = (id: string, menus: Array<[string, string]> = [], extra: Record<string, unknown> = {}) => ({
  id,
  name: `Caja ${id}`,
  type: 'POS_ANDROID',
  model: 'T2',
  version: '2.25.20',
  fulfillmentArea: null,
  menus: menus.map(([mid, name]) => ({ menu: { id: mid, name } })),
  ...extra,
})

/**
 * Catálogo de prueba: c1 (3 productos), c2 (2), c2a hija de c2 (1), c3 (0 productos), cX apagada (4).
 * «Todos» es lo que pinta la cuadrícula sin filtro: los productos activos y sus categorías, encendidas o apagadas (Ruling 15):
 * c1, c2, c2a y cX = 4 categorías y 10 productos.
 */
function catalogo(opts: { aparatos: any[]; total?: number; asignaciones?: Array<[string, string]> }) {
  prismaMock.terminal.findMany.mockResolvedValue(opts.aparatos)
  prismaMock.terminal.count.mockResolvedValue(opts.total ?? opts.aparatos.length)
  prismaMock.product.groupBy.mockResolvedValue([
    { categoryId: 'c1', _count: 3 },
    { categoryId: 'c2', _count: 2 },
    { categoryId: 'c2a', _count: 1 },
    { categoryId: 'cX', _count: 4 },
  ])
  prismaMock.menuCategory.findMany.mockResolvedValue([
    { id: 'c1', parentId: null },
    { id: 'c2', parentId: null },
    { id: 'c2a', parentId: 'c2' },
    { id: 'c3', parentId: null },
  ])
  prismaMock.menuCategoryAssignment.findMany.mockResolvedValue(
    (opts.asignaciones ?? []).map(([menuId, categoryId]) => ({ menuId, categoryId })),
  )
}

const TODOS = { categories: 4, products: 10 }

/** La 2.25.20 de estas pruebas es menor que la mínima real; aquí se finge que ANDROID 2.25.20 ya lo aplica. */
const versionesOriginales = { ...DEVICE_MENUS_MIN_APP_VERSION }
const androidYaLoAplica = () => (DEVICE_MENUS_MIN_APP_VERSION.POS_ANDROID = '2.25.20')
afterEach(() => Object.assign(DEVICE_MENUS_MIN_APP_VERSION, versionesOriginales))

describe('listDeviceMenus', () => {
  beforeEach(() => tieneProMock.mockReset().mockResolvedValue(true))

  it('listarCuentaLoQueVeCadaAparato: con «Todos» y con un menú', async () => {
    catalogo({
      aparatos: [aparato('t1'), aparato('t2', [['mB', 'Bebidas']])],
      asignaciones: [
        ['mB', 'c2'],
        ['mB', 'c3'],
      ],
    })
    androidYaLoAplica()
    const r = await listDeviceMenus(V, 1, 50)
    expect(r.everything).toEqual(TODOS)
    expect(r.terminals[0]).toMatchObject({ id: 't1', menus: [], sees: TODOS, seesAfterUpdate: null })
    // c2 (2) + su hija c2a (1); c3 no tiene productos y no cuenta como categoría que se ve
    expect(r.terminals[1]).toMatchObject({ id: 't2', needsAppUpdate: false, sees: { categories: 2, products: 3 }, seesAfterUpdate: null })
    // una sola lectura de conteos para toda la página, sin consultas por aparato
    expect(prismaMock.product.groupBy).toHaveBeenCalledTimes(1)
    expect(prismaMock.product.groupBy).toHaveBeenCalledWith({
      by: ['categoryId'],
      where: { venueId: V, active: true, deletedAt: null },
      _count: true,
    })
    expect(prismaMock.menuCategoryAssignment.findMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.menuCategory.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { venueId: V, active: true } }))
  })

  it('seesEsLoQueMuestraHoy: con la app vieja ve todo, y lo filtrado va en seesAfterUpdate (Ruling 11)', async () => {
    catalogo({ aparatos: [aparato('t1', [['mB', 'Bebidas']])], asignaciones: [['mB', 'c2']] })
    const r = await listDeviceMenus(V, 1, 50)
    expect(r.terminals[0]).toMatchObject({
      needsAppUpdate: true,
      menus: [{ id: 'mB', name: 'Bebidas' }],
      sees: TODOS,
      seesAfterUpdate: { categories: 2, products: 3 },
    })
  })

  it('con la app vieja y sin elección, seesAfterUpdate es null', async () => {
    catalogo({ aparatos: [aparato('t1')] })
    const r = await listDeviceMenus(V, 1, 50)
    expect(r.terminals[0]).toMatchObject({ needsAppUpdate: true, sees: TODOS, seesAfterUpdate: null })
  })

  it('dos aparatos con menús distintos en la misma página: cada uno cuenta sólo los suyos', async () => {
    androidYaLoAplica()
    catalogo({
      aparatos: [aparato('t1', [['mA', 'Comida']]), aparato('t2', [['mB', 'Bebidas']])],
      asignaciones: [
        ['mA', 'c1'],
        ['mB', 'c2'],
      ],
    })
    const r = await listDeviceMenus(V, 1, 50)
    expect(r.terminals[0]).toMatchObject({ id: 't1', menus: [{ id: 'mA', name: 'Comida' }], sees: { categories: 1, products: 3 } })
    expect(r.terminals[1]).toMatchObject({ id: 't2', menus: [{ id: 'mB', name: 'Bebidas' }], sees: { categories: 2, products: 3 } })
    // Las asignaciones de los dos menús se leen juntas, una sola vez.
    expect(prismaMock.menuCategoryAssignment.findMany).toHaveBeenCalledTimes(1)
  })

  it('listarCuentaComoTodoSiSuSeleccionNoTieneProductos: el aparato muestra todo', async () => {
    androidYaLoAplica()
    catalogo({ aparatos: [aparato('t1', [['mV', 'Vacío']])], asignaciones: [['mV', 'c3']] })
    const r = await listDeviceMenus(V, 1, 50)
    expect(r.terminals[0].sees).toEqual(TODOS)
    expect(r.terminals[0].seesAfterUpdate).toBeNull()
    expect(r.terminals[0].menus).toEqual([{ id: 'mV', name: 'Vacío' }]) // la elección sigue a la vista
  })

  it('una categoría apagada que el menú trae directo cuenta, con sus productos (Ruling 15: la cuadrícula la pinta, como Mesas)', async () => {
    catalogo({
      aparatos: [
        aparato('t1', [
          ['mA', 'Comida'],
          ['mZ', 'Apagada'],
        ]),
      ],
      asignaciones: [
        ['mA', 'c1'],
        ['mZ', 'cX'],
      ],
    })
    androidYaLoAplica()
    const r = await listDeviceMenus(V, 1, 50)
    expect(r.terminals[0].sees).toEqual({ categories: 2, products: 7 })
  })

  it('«Todos» cuenta una categoría apagada con productos: la API de productos y la cuadrícula no miran si está encendida', async () => {
    catalogo({ aparatos: [aparato('t1')] })
    const r = await listDeviceMenus(V, 1, 50)
    // cX está apagada (no viene en las activas) y sus 4 productos cuentan.
    expect(r.everything).toEqual({ categories: 4, products: 10 })
    expect(r.terminals[0].sees).toEqual(r.everything)
  })

  it('una subcategoría APAGADA no se suma al menú de su padre (sólo se suman las activas, como en Mesas)', async () => {
    catalogo({ aparatos: [aparato('t1', [['mB', 'Bebidas']])], asignaciones: [['mB', 'c2']] })
    prismaMock.product.groupBy.mockResolvedValue([
      { categoryId: 'c2', _count: 2 },
      { categoryId: 'c2a', _count: 1 },
      { categoryId: 'c2z', _count: 5 }, // apagada, hija de c2: no viene en las activas
    ] as any)
    androidYaLoAplica()
    const r = await listDeviceMenus(V, 1, 50)
    expect(r.terminals[0].sees).toEqual({ categories: 2, products: 3 })
    expect(r.everything).toEqual({ categories: 3, products: 8 })
  })

  it('el conteo de un aparato no depende de sus vecinos de página (Codex r3 #3): si la página pasa el tope, cada uno se cuenta solo', async () => {
    // A: un menú de una categoría. B: 50 menús que juntos pasan las 5000 asignaciones del tope.
    const deB = Array.from({ length: 50 }, (_, i) => `mB${i}`)
    const filas = [
      { menuId: 'mA', categoryId: 'c1' },
      ...deB.flatMap(menuId => Array.from({ length: 101 }, (_, j) => ({ menuId, categoryId: `cB${j}` }))),
    ]
    const aparatoA = aparato('tA', [['mA', 'Comida']])
    const aparatoB = aparato(
      'tB',
      deB.map(m => [m, m] as [string, string]),
    )
    catalogo({ aparatos: [aparatoA, aparatoB] })
    prismaMock.menuCategoryAssignment.findMany.mockImplementation(((args: any) =>
      Promise.resolve(filas.filter(f => args.where.menuId.in.includes(f.menuId)).slice(0, args.take))) as any)
    androidYaLoAplica()

    const pagina = await listDeviceMenus(V, 1, 50)
    expect(pagina.terminals[0]).toMatchObject({ id: 'tA', sees: { categories: 1, products: 3 } })
    // B solo también pasa el tope: muestra todo, con aviso.
    expect(pagina.terminals[1]).toMatchObject({ id: 'tB', sees: TODOS })

    // El PUT de A (que relee sólo su fila) da lo mismo que la página.
    prismaMock.terminal.findFirst.mockResolvedValue({ id: 'tA', name: 'Caja tA' } as any)
    prismaMock.menu.findMany.mockResolvedValue([{ id: 'mA', name: 'Comida' }] as any)
    prismaMock.terminalMenu.findMany.mockResolvedValue([{ menu: { id: 'mA', name: 'Comida' } }] as any)
    prismaMock.terminal.findMany.mockResolvedValue([aparatoA] as any)
    const put = await setTerminalMenus(V, 'tA', ['mA'], 'staff')
    expect(put.sees).toEqual(pagina.terminals[0].sees)
  })

  it('listarTraeNombresDeLosMenusElegidos y sólo los del negocio, activos y para aparatos', async () => {
    catalogo({
      aparatos: [
        aparato('t1', [
          ['mA', 'Comida'],
          ['mB', 'Bebidas'],
        ]),
      ],
    })
    const r = await listDeviceMenus(V, 1, 50)
    expect(r.terminals[0].menus).toEqual([
      { id: 'mA', name: 'Comida' },
      { id: 'mB', name: 'Bebidas' },
    ])
    const leida = prismaMock.terminal.findMany.mock.calls[0][0]
    expect(leida.select.menus).toMatchObject({
      where: { menu: { venueId: V, active: true, appliesToDevices: true } },
      select: { menu: { select: { id: true, name: true } } },
      take: 50,
    })
  })

  it('sin Pro el aparato muestra todo: su elección se ve, pero cuenta «Todos»', async () => {
    tieneProMock.mockResolvedValue(false)
    catalogo({ aparatos: [aparato('t1', [['mB', 'Bebidas']])], asignaciones: [['mB', 'c2']] })
    const r = await listDeviceMenus(V, 1, 50)
    expect(r.terminals[0]).toMatchObject({ menus: [{ id: 'mB', name: 'Bebidas' }], sees: TODOS, seesAfterUpdate: null })
    expect(tieneProMock).toHaveBeenCalledWith(V, 'DEVICE_MENUS')
  })

  it('una página sin elecciones no pregunta el plan ni lee asignaciones', async () => {
    catalogo({ aparatos: [aparato('t1'), aparato('t2')] })
    await listDeviceMenus(V, 1, 50)
    expect(tieneProMock).not.toHaveBeenCalled()
    expect(prismaMock.menuCategoryAssignment.findMany).not.toHaveBeenCalled()
  })

  it('listarSoloAparatosPos: POS_* no retirados, por nombre', async () => {
    catalogo({ aparatos: [] })
    const r = await listDeviceMenus(V, 1, 50)
    const where = { venueId: V, type: { in: POS_TERMINAL_TYPES }, status: { not: 'RETIRED' } }
    expect(prismaMock.terminal.findMany).toHaveBeenCalledWith(expect.objectContaining({ where, orderBy: [{ name: 'asc' }, { id: 'asc' }] }))
    expect(prismaMock.terminal.count).toHaveBeenCalledWith({ where })
    expect(r.terminals).toEqual([])
  })

  it('listarPaginaConTotal: salta lo de las páginas anteriores, regresa el total y topa en 100', async () => {
    catalogo({ aparatos: [aparato('t3')], total: 7 })
    const r = await listDeviceMenus(V, 2, 2)
    expect(prismaMock.terminal.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 2, take: 2 }))
    expect(r).toMatchObject({ total: 7, page: 2, pageSize: 2 })

    await listDeviceMenus(V, 1, 500)
    expect(prismaMock.terminal.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ skip: 0, take: 100 }))
  })

  it('la fila trae área, modelo, versión y si la app debe actualizarse', async () => {
    catalogo({ aparatos: [aparato('t1', [], { fulfillmentArea: { name: 'Cremería' } })] })
    const r = await listDeviceMenus(V, 1, 50)
    expect(r.terminals[0]).toEqual({
      id: 't1',
      name: 'Caja t1',
      type: 'POS_ANDROID',
      model: 'T2',
      version: '2.25.20',
      areaName: 'Cremería',
      needsAppUpdate: true, // la 2.25.20 es menor que la versión mínima
      menus: [],
      sees: TODOS,
      seesAfterUpdate: null,
    })
  })
})

describe('listDeviceMenuOptions', () => {
  beforeEach(() => {
    prismaMock.menu.findMany.mockResolvedValue([{ id: 'mA', name: 'Comida', appliesToOnline: true, _count: { categories: 4 } }])
    prismaMock.menu.count.mockResolvedValue(1)
  })

  it('opcionesSoloMenusActivosParaAparatos, con su número de categorías', async () => {
    const r = await listDeviceMenuOptions(V, { page: 1, pageSize: 100 })
    expect(prismaMock.menu.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId: V, active: true, appliesToDevices: true } }),
    )
    expect(r).toEqual({ menus: [{ id: 'mA', name: 'Comida', appliesToOnline: true, categoryCount: 4 }], total: 1, page: 1, pageSize: 100 })
  })

  it('categoryCount cuenta todas las categorías del menú, también las apagadas: el aparato las pinta (Ruling 15)', async () => {
    await listDeviceMenuOptions(V, { page: 1, pageSize: 100 })
    expect(prismaMock.menu.findMany.mock.calls[0][0].select._count).toEqual({ select: { categories: true } })
  })

  it('opcionesBuscaPorNombre, sin importar mayúsculas', async () => {
    await listDeviceMenuOptions(V, { search: '  bebi ', page: 1, pageSize: 100 })
    const where = { venueId: V, active: true, appliesToDevices: true, name: { contains: 'bebi', mode: 'insensitive' } }
    expect(prismaMock.menu.findMany).toHaveBeenCalledWith(expect.objectContaining({ where }))
    expect(prismaMock.menu.count).toHaveBeenCalledWith({ where })
  })

  it('opcionesTopeDe100AunquePidan500', async () => {
    const r = await listDeviceMenuOptions(V, { page: 1, pageSize: 500 })
    expect(prismaMock.menu.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }))
    expect(r.pageSize).toBe(100)
  })

  it('opcionesTotalYPaginaSiguiente', async () => {
    prismaMock.menu.count.mockResolvedValue(130)
    const r = await listDeviceMenuOptions(V, { page: 2, pageSize: 100 })
    expect(prismaMock.menu.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 100, take: 100 }))
    expect(r).toMatchObject({ total: 130, page: 2, pageSize: 100 })
  })

  it('opcionesOrdenDeMesas: el default primero, luego displayOrder, nombre e id', async () => {
    await listDeviceMenuOptions(V, { page: 1, pageSize: 100 })
    expect(prismaMock.menu.findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: ORDEN_DE_MESAS }))
  })
})

describe('setTerminalMenus', () => {
  const T = 'cmterm00000000000000000001'
  const STAFF = 'cmstaff0000000000000000001'

  beforeEach(() => {
    tieneProMock.mockReset().mockResolvedValue(true)
    prismaMock.terminal.findFirst.mockResolvedValue({ id: T, name: 'Caja 1' })
    // antes: Comida
    prismaMock.terminalMenu.findMany.mockResolvedValue([{ menu: { id: 'mA', name: 'Comida' } }])
    prismaMock.terminalMenu.deleteMany.mockResolvedValue({ count: 1 })
    prismaMock.terminalMenu.createMany.mockResolvedValue({ count: 1 })
    // la fila que regresa, releída
    catalogo({ aparatos: [aparato(T, [['mB', 'Bebidas']])], asignaciones: [['mB', 'c2']] })
  })

  it('guardarVacioRegresaATodos: borra las filas del aparato y no crea ninguna', async () => {
    prismaMock.terminal.findMany.mockResolvedValue([aparato(T)])
    const fila = await setTerminalMenus(V, T, [], STAFF)
    expect(prismaMock.terminalMenu.deleteMany).toHaveBeenCalledWith({ where: { terminalId: T } })
    expect(prismaMock.terminalMenu.createMany).not.toHaveBeenCalled()
    expect(prismaMock.menu.findMany).not.toHaveBeenCalled()
    expect(fila).toMatchObject({ id: T, menus: [], sees: TODOS })
  })

  it('guarda en una transacción, con el aparato bloqueado, y regresa la fila', async () => {
    prismaMock.menu.findMany.mockResolvedValue([{ id: 'mB', name: 'Bebidas' }])
    const fila = await setTerminalMenus(V, T, ['mB', 'mB'], STAFF)
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1) // el candado del aparato
    expect(prismaMock.terminalMenu.createMany).toHaveBeenCalledWith({ data: [{ terminalId: T, menuId: 'mB' }] })
    // La fila del PUT sigue la misma regla que la lista: con la app vieja ve todo hoy.
    expect(fila).toMatchObject({
      id: T,
      menus: [{ id: 'mB', name: 'Bebidas' }],
      sees: TODOS,
      seesAfterUpdate: { categories: 2, products: 3 },
    })
  })

  it('si el aparato se borra antes de releerlo: 404 TERMINAL_NOT_FOUND, nunca una respuesta vacía', async () => {
    prismaMock.menu.findMany.mockResolvedValue([{ id: 'mB', name: 'Bebidas' }])
    prismaMock.terminal.findMany.mockResolvedValue([])
    await expect(setTerminalMenus(V, T, ['mB'], STAFF)).rejects.toMatchObject({ statusCode: 404, code: 'TERMINAL_NOT_FOUND' })
  })

  it.each([['guardarRechazaMenuDeOtroNegocio'], ['guardarRechazaMenuApagado'], ['guardarRechazaMenuSoloEnLinea']])(
    '%s: 400 MENU_NO_DISPONIBLE y no toca nada',
    async () => {
      // La lectura pide el menú del negocio, activo y para aparatos: uno de otro negocio, apagado o sólo en línea no regresa.
      prismaMock.menu.findMany.mockResolvedValue([])
      await expect(setTerminalMenus(V, T, ['mOtro'], STAFF)).rejects.toMatchObject({
        statusCode: 400,
        code: 'MENU_NO_DISPONIBLE',
        message: 'Ese menú no existe, está apagado o no es para aparatos.',
      })
      expect(prismaMock.menu.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: { in: ['mOtro'] }, venueId: V, active: true, appliesToDevices: true } }),
      )
      expect(prismaMock.terminalMenu.deleteMany).not.toHaveBeenCalled()
      expect(logActionMock).not.toHaveBeenCalled()
    },
  )

  it('guardarRechazaUnaTpv (o un aparato de otro negocio): 404 TERMINAL_NOT_FOUND', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue(null)
    await expect(setTerminalMenus(V, T, [], STAFF)).rejects.toMatchObject({ statusCode: 404, code: 'TERMINAL_NOT_FOUND' })
    expect(prismaMock.terminal.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: T, venueId: V, type: { in: POS_TERMINAL_TYPES } } }),
    )
    expect(prismaMock.terminalMenu.deleteMany).not.toHaveBeenCalled()
  })

  it('más de 50 menús se rechaza antes de leer nada', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `m${i}`)
    await expect(setTerminalMenus(V, T, ids, STAFF)).rejects.toMatchObject({ statusCode: 400 })
    expect(prismaMock.terminal.findFirst).not.toHaveBeenCalled()
  })

  it('guardarDejaRegistroAntesYDespues', async () => {
    prismaMock.menu.findMany.mockResolvedValue([{ id: 'mB', name: 'Bebidas' }])
    await setTerminalMenus(V, T, ['mB'], STAFF)
    expect(logActionMock).toHaveBeenCalledWith({
      staffId: STAFF,
      venueId: V,
      action: 'TERMINAL_MENUS_UPDATED',
      entity: 'Terminal',
      entityId: T,
      data: { terminalName: 'Caja 1', antes: [{ id: 'mA', name: 'Comida' }], despues: [{ id: 'mB', name: 'Bebidas' }] },
    })
  })

  it('con la procedencia del MCP deja UNA fila con esa procedencia', async () => {
    prismaMock.menu.findMany.mockResolvedValue([{ id: 'mB', name: 'Bebidas' }])
    await setTerminalMenus(V, T, ['mB'], STAFF, { source: 'customer-mcp', mcpClientId: 'app-1' })
    expect(logActionMock).toHaveBeenCalledTimes(1)
    expect(logActionMock.mock.calls[0][0].data).toEqual({
      terminalName: 'Caja 1',
      antes: [{ id: 'mA', name: 'Comida' }],
      despues: [{ id: 'mB', name: 'Bebidas' }],
      source: 'customer-mcp',
      mcpClientId: 'app-1',
    })
  })

  it('guardar lo mismo que ya tenía no deja registro', async () => {
    prismaMock.menu.findMany.mockResolvedValue([{ id: 'mA', name: 'Comida' }])
    await setTerminalMenus(V, T, ['mA'], STAFF)
    expect(logActionMock).not.toHaveBeenCalled()
  })
})

describe('listVenueMenuUsage (todos los menús del negocio y dónde se usa cada uno)', () => {
  beforeEach(() => {
    prismaMock.menu.findMany.mockResolvedValue([{ id: 'mW', name: 'Web', active: false, appliesToDevices: false, appliesToOnline: true }])
    prismaMock.menu.count.mockResolvedValue(130)
  })

  it('lee todos los menús del negocio (encendidos y apagados), en el orden de Mesas y con su total', async () => {
    const r = await listVenueMenuUsage(V, 1)
    expect(prismaMock.menu.findMany).toHaveBeenCalledWith({
      where: { venueId: V },
      select: { id: true, name: true, active: true, appliesToDevices: true, appliesToOnline: true },
      orderBy: ORDEN_DE_MESAS,
      skip: 0,
      take: 100,
    })
    expect(prismaMock.menu.count).toHaveBeenCalledWith({ where: { venueId: V } })
    expect(r).toEqual({
      menus: [{ id: 'mW', name: 'Web', active: false, appliesToDevices: false, appliesToOnline: true }],
      total: 130,
      page: 1,
      pageSize: 100,
    })
  })

  it('pagina de 100 en 100', async () => {
    const r = await listVenueMenuUsage(V, 2)
    expect(prismaMock.menu.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 100, take: 100 }))
    expect(r).toMatchObject({ page: 2, pageSize: 100, total: 130 })
  })
})
