// tests/unit/services/online-ordering/menu.service.test.ts
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import logger from '@/config/logger'
import { MAX_MENUS } from '@/services/online-ordering/constants'
import { clearPublicMenuCache, getPublicMenu, loadCategoryVisibility, loadVisibleMenu } from '@/services/online-ordering/menu.service'

const NOW = new Date('2026-10-14T18:30:00.000Z') // miércoles 12:30 CDMX
const D = (v: string) => new Prisma.Decimal(v)

const modifier = (id: string, price: string) => ({ id, name: `mod-${id}`, price: D(price) })
const group = (id = 'g1') => ({
  group: {
    id,
    name: 'Salsa',
    required: true,
    allowMultiple: false,
    minSelections: 1,
    maxSelections: 1,
    modifiers: [modifier('m1', '0.00'), modifier('m2', '10.00')],
  },
})
const product = (id: string, o: Record<string, unknown> = {}) => ({
  id,
  name: `plato-${id}`,
  sku: `SKU-${id}`,
  description: null,
  price: D('93.00'),
  imageUrl: null,
  categoryId: 'cat1',
  category: { name: 'Flautas' },
  modifierGroups: [group()],
  ...o,
})
const SIN_HORARIO = { availableFrom: null, availableUntil: null, availableDays: [] as string[] }
const category = (id: string, products: unknown[], o: Record<string, unknown> = {}) => ({
  id,
  name: `cat-${id}`,
  displayOrder: 0,
  ...SIN_HORARIO,
  products,
  ...o,
})
/** El `menu` de una asignación menú↔categoría, como lo devuelve el `select`. */
const MENU_SIEMPRE = { ...SIN_HORARIO, startDate: null, endDate: null }

const porId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
const en = (ids: string[]) => {
  const s = new Set(ids)
  return (id: string) => s.has(id)
}

/**
 * Una base en memoria para la carta: cada consulta responde con su `where`, su orden y su `take`, como Postgres. Las pruebas de
 * negocio describen la carta (categorías → platillos → grupos → opciones, en el orden en que se muestran) y no dependen de la
 * forma de las consultas. Un grupo es UNA fila: el mismo `id` en dos platillos es el mismo grupo.
 */
function carta(cats: any[]) {
  const productos = cats.flatMap(c => c.products)
  const grupos = new Map<string, any>()
  for (const p of productos) for (const { group: g } of p.modifierGroups) if (!grupos.has(g.id)) grupos.set(g.id, g)
  const sinOpciones = ({ modifiers: _m, ...g }: any) => g
  prismaMock.menuCategory.findMany.mockImplementation((async (a: any) => cats.slice(0, a.take)) as any)
  prismaMock.product.groupBy.mockImplementation((async (a: any) => {
    const pedida = en(a.where.categoryId.in)
    return cats.filter(c => pedida(c.id) && c.products.length > 0).map(c => ({ categoryId: c.id, _count: { _all: c.products.length } }))
  }) as any)
  // ORDER BY categoryId, displayOrder, id: dentro de cada categoría, el orden del arreglo es el `displayOrder`.
  prismaMock.product.findMany.mockImplementation((async (a: any) => {
    const pedida = en(a.where.categoryId.in)
    return productos
      .filter(p => pedida(p.categoryId))
      .sort((x, y) => (x.categoryId < y.categoryId ? -1 : x.categoryId > y.categoryId ? 1 : 0))
      .slice(0, a.take)
      .map(({ modifierGroups: _g, category: _c, ...p }) => p)
  }) as any)
  prismaMock.productModifierGroup.groupBy.mockImplementation((async (a: any) => {
    const pedido = en(a.where.productId.in)
    return productos
      .filter(p => pedido(p.id) && p.modifierGroups.length > 0)
      .map(p => ({ productId: p.id, _count: { _all: p.modifierGroups.length } }))
  }) as any)
  prismaMock.productModifierGroup.findMany.mockImplementation((async (a: any) => {
    const pedido = en(a.where.productId.in)
    return productos
      .filter(p => pedido(p.id))
      .sort(porId)
      .flatMap(p => p.modifierGroups.map(({ group: { id } }: any) => ({ productId: p.id, group: sinOpciones(grupos.get(id)) })))
      .slice(0, a.take)
  }) as any)
  prismaMock.modifier.groupBy.mockImplementation((async (a: any) => {
    const pedido = en(a.where.groupId.in)
    return [...grupos.values()]
      .filter(g => pedido(g.id) && g.modifiers.length > 0)
      .map(g => ({ groupId: g.id, _count: { _all: g.modifiers.length } }))
  }) as any)
  prismaMock.modifier.findMany.mockImplementation((async (a: any) => {
    const pedido = en(a.where.groupId.in)
    return [...grupos.values()]
      .filter(g => pedido(g.id))
      .sort(porId)
      .flatMap(g => g.modifiers.map((m: any) => ({ ...m, groupId: g.id })))
      .slice(0, a.take)
  }) as any)
}

beforeEach(() => {
  clearPublicMenuCache()
  prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' } as any)
  prismaMock.menuCategoryAssignment.findMany.mockResolvedValue([])
  prismaMock.menuCategory.findMany.mockResolvedValue([])
  prismaMock.product.groupBy.mockResolvedValue([] as any)
  prismaMock.product.findMany.mockResolvedValue([])
  prismaMock.productModifierGroup.groupBy.mockResolvedValue([] as any)
  prismaMock.productModifierGroup.findMany.mockResolvedValue([])
  prismaMock.modifier.groupBy.mockResolvedValue([] as any)
  prismaMock.modifier.findMany.mockResolvedValue([])
})

describe('loadVisibleMenu', () => {
  it('pide sólo lo que se vende en línea: activo, no borrado, marcado, por pieza y comida (R17), con topes + 1 (H10)', async () => {
    carta([category('cat1', [product('p1')])])
    await loadVisibleMenu('v1', NOW)
    const cats = prismaMock.menuCategory.findMany.mock.calls[0][0] as any
    expect(cats.where).toEqual({ venueId: 'v1', active: true })
    expect(cats.take).toBe(101) // tope + 1: así se sabe si sobró una
    const platillos = prismaMock.product.findMany.mock.calls[0][0] as any
    expect(platillos.where).toEqual({
      venueId: 'v1',
      categoryId: { in: ['cat1'] },
      active: true,
      deletedAt: null,
      availableOnline: true,
      soldByWeight: false,
      type: { notIn: ['APPOINTMENTS_SERVICE', 'CLASS', 'EVENT', 'DONATION'] },
    })
    // Grupos y opciones se CUENTAN antes de leerse (sólo los activos), con agregados acotados por `IN` a lo ya leído (nunca un
    // COUNT de relación: Prisma lo compila como un agregado de toda la tabla); se lee sólo lo que cabe, con 1 de más.
    expect(platillos.select._count).toBeUndefined()
    const cuentaVinculos = prismaMock.productModifierGroup.groupBy.mock.calls[0][0] as any
    expect(cuentaVinculos).toMatchObject({ by: ['productId'], where: { productId: { in: ['p1'] }, group: { active: true } } })
    const cuentaOpciones = prismaMock.modifier.groupBy.mock.calls[0][0] as any
    expect(cuentaOpciones).toMatchObject({ by: ['groupId'], where: { groupId: { in: ['g1'] }, active: true } })
    const vinculos = prismaMock.productModifierGroup.findMany.mock.calls[0][0] as any
    expect(vinculos.select.group.select._count).toBeUndefined()
    expect(vinculos.where).toEqual({ productId: { in: ['p1'] }, group: { active: true } })
    expect(vinculos.take).toBe(2)
    const opciones = prismaMock.modifier.findMany.mock.calls[0][0] as any
    expect(opciones.where).toEqual({ groupId: { in: ['g1'] }, active: true })
    expect(opciones.take).toBe(3)
  })

  it('omite categorías sin platillos y mapea grupos, modificadores, el nombre de la categoría y su conteo', async () => {
    carta([category('cat1', [product('p1')], { name: 'Flautas' }), category('vacia', [])])
    const menu = await loadVisibleMenu('v1', NOW)
    expect(menu.categories.map(c => c.id)).toEqual(['cat1'])
    expect(menu.categories[0].productCount).toBe(1)
    expect(menu.categories[0].products[0]).toMatchObject({ categoryId: 'cat1', categoryName: 'Flautas' })
    expect(menu.categories[0].products[0].groups[0].modifiers.map(m => m.id)).toEqual(['m1', 'm2'])
    expect(menu.truncated).toBe(false)
  })

  it('oculta la categoría de un menú con horario que no aplica ahora y deja la que no está en ningún menú', async () => {
    carta([
      category('desayunos', [product('p1', { categoryId: 'desayunos' })]),
      category('siempre', [product('p2', { categoryId: 'siempre' })]),
    ])
    prismaMock.menuCategoryAssignment.findMany.mockResolvedValue([
      { categoryId: 'desayunos', menu: { ...MENU_SIEMPRE, availableFrom: '07:00', availableUntil: '11:00' } },
    ] as any)
    const menu = await loadVisibleMenu('v1', NOW) // 12:30 CDMX: fuera del desayuno
    expect(menu.categories.map(c => c.id)).toEqual(['siempre'])
  })

  it('H4: una categoría con horario PROPIO fuera de hora no se muestra, aunque no esté en ningún menú', async () => {
    carta([
      category('desayunos', [product('p1', { categoryId: 'desayunos' })], { availableFrom: '07:00', availableUntil: '11:00' }),
      category('entre-semana', [product('p2', { categoryId: 'entre-semana' })], { availableDays: ['WED'] }),
    ])
    const menu = await loadVisibleMenu('v1', NOW) // miércoles 12:30 CDMX
    expect(menu.categories.map(c => c.id)).toEqual(['entre-semana'])
  })

  it('H10: exactamente el tope de categorías NO es recorte; una de más sí, y se registra (nunca recorta en silencio)', async () => {
    const cats = (n: number) => Array.from({ length: n }, (_, i) => category(`c${i}`, [product(`p${i}`, { categoryId: `c${i}` })]))
    carta(cats(100))
    expect((await loadVisibleMenu('v1', NOW)).truncated).toBe(false)

    carta(cats(101))
    const menu = await loadVisibleMenu('v1', NOW)
    expect(menu.truncated).toBe(true)
    expect(menu.categories).toHaveLength(100)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('recort'), expect.objectContaining({ venueId: 'v1' }))
  })

  it('H10: con 201 platillos muestra 200, marca truncated y el conteo sale del agregado, no de la lista', async () => {
    const muchos = Array.from({ length: 201 }, (_, i) => product(`p${i}`))
    carta([category('cat1', muchos)])
    prismaMock.product.groupBy.mockResolvedValue([{ categoryId: 'cat1', _count: { _all: 230 } }] as any)
    const menu = await loadVisibleMenu('v1', NOW)
    expect(menu.categories[0].products).toHaveLength(200)
    expect(menu.categories[0].productCount).toBe(230)
    expect(menu.truncated).toBe(true)
    const agregado = prismaMock.product.groupBy.mock.calls[0][0] as any
    expect(agregado.by).toEqual(['categoryId'])
    expect(agregado.where).toMatchObject({ venueId: 'v1', categoryId: { in: ['cat1'] }, availableOnline: true, soldByWeight: false })
  })

  it('un platillo con más grupos que el tope no se ofrece a medias (R17): se omite y marca truncated', async () => {
    const enorme = product('p-enorme', { modifierGroups: Array.from({ length: 21 }, (_, i) => group(`g${i}`)) })
    carta([category('cat1', [enorme, product('p-normal')])])
    const menu = await loadVisibleMenu('v1', NOW)
    expect(menu.categories[0].products.map(p => p.id)).toEqual(['p-normal'])
    expect(menu.truncated).toBe(true)
  })

  /** M-4: grupos que nadie puede cumplir (p. ej. desactivaron todos los sabores agotados de un obligatorio). */
  const IMPOSIBLES: Array<[string, Record<string, unknown>]> = [
    ['obligatorio sin opciones activas', { required: true, minSelections: 0, modifiers: [] }],
    ['con mínimo y sin opciones activas', { required: false, minSelections: 1, modifiers: [] }],
    ['selección única con mínimo de 2', { required: true, allowMultiple: false, minSelections: 2, maxSelections: null }],
    ['mínimo mayor que el máximo', { required: true, allowMultiple: true, minSelections: 2, maxSelections: 1 }],
  ]

  it.each(IMPOSIBLES)(
    'M-4: un platillo con un grupo imposible (%s) no se ofrece, y el conteo de su categoría no lo cuenta',
    async (_caso, o) => {
      const imposible = product('p-imposible', { modifierGroups: [{ group: { ...group('g-imposible').group, ...o } }] })
      carta([category('cat1', [imposible, product('p-normal')])])
      prismaMock.product.groupBy.mockResolvedValue([{ categoryId: 'cat1', _count: { _all: 2 } }] as any)
      const menu = await loadVisibleMenu('v1', NOW)
      expect(menu.categories[0].products.map(p => p.id)).toEqual(['p-normal'])
      expect(menu.categories[0].productCount).toBe(1)
      expect(menu.truncated).toBe(false) // no es un recorte: el platillo no se puede pedir
    },
  )

  it('M-4: los grupos que SÍ se pueden cumplir siguen en la carta (opcional sin opciones, mínimo igual a las opciones)', async () => {
    const opcionalVacio = product('p-a', {
      modifierGroups: [{ group: { ...group('g-a').group, required: false, minSelections: 0, modifiers: [] } }],
    })
    const justo = product('p-b', {
      modifierGroups: [{ group: { ...group('g-b').group, allowMultiple: true, minSelections: 2, maxSelections: 2 } }],
    })
    carta([category('cat1', [opcionalVacio, justo])])
    const menu = await loadVisibleMenu('v1', NOW)
    expect(menu.categories[0].products.map(p => p.id)).toEqual(['p-a', 'p-b'])
  })

  it('M-4: un grupo de VARIAS opciones con mínimo mayor que las activas SÍ se ofrece: se llena repitiendo una (el cotizador suma cantidades)', async () => {
    // «Elige 3 salsas» con sólo 2 activas: verde × 2 + roja × 1 cumple.
    const repitiendo = product('p-salsas', {
      modifierGroups: [{ group: { ...group().group, required: true, allowMultiple: true, minSelections: 3, maxSelections: null } }],
    })
    carta([category('cat1', [repitiendo])])
    const menu = await loadVisibleMenu('v1', NOW)
    expect(menu.categories[0].products.map(p => p.id)).toEqual(['p-salsas'])
  })
})

describe('P1-09: presupuesto GLOBAL de la carta (400 platillos · 2,000 vínculos · 4,000 opciones)', () => {
  /** Un grupo opcional (nunca imposible) con `n` opciones. */
  const opcional = (id: string, n: number) => ({
    group: {
      id,
      name: `grupo-${id}`,
      required: false,
      allowMultiple: true,
      minSelections: 0,
      maxSelections: null,
      modifiers: Array.from({ length: n }, (_, i) => modifier(`${id}-m${i}`, '1.00')),
    },
  })
  /** `n` platillos de la categoría, en orden (el id con ceros: el orden por id es el de la carta). */
  const platillos = (cat: string, n: number, grupos: (i: number) => unknown[] = () => [group()]) =>
    Array.from({ length: n }, (_, i) => product(`${cat}-p${String(i).padStart(3, '0')}`, { categoryId: cat, modifierGroups: grupos(i) }))
  const ids = (menu: { categories: Array<{ products: Array<{ id: string }> }> }) => menu.categories.flatMap(c => c.products.map(p => p.id))
  const takes = (m: jest.Mock) => m.mock.calls.map(c => c[0].take)
  const entradas = (menu: { categories: Array<{ products: Array<{ groups: Array<{ modifiers: unknown[] }> }> }> }) =>
    menu.categories.reduce((s, c) => s + c.products.reduce((t, p) => t + p.groups.reduce((u, x) => u + x.modifiers.length, 0), 0), 0)

  it('con la carta llena, cada consulta trae a lo más su tope + 1: 101 categorías, 401 platillos, 2,001 vínculos y 4,001 opciones', async () => {
    // 400 grupos de 10 opciones (4,000) repartidos de 5 en 5 entre 400 platillos (2,000 vínculos, cada grupo en 5 platillos):
    // 20,000 entradas en la respuesta, justo el tope. Una categoría de más no cabe.
    const g = Array.from({ length: 400 }, (_, i) => opcional(`g${String(i).padStart(3, '0')}`, 10))
    const cinco = (base: number) => (i: number) => Array.from({ length: 5 }, (_, k) => g[((base + i) * 5 + k) % 400])
    carta([
      category('c0', platillos('c0', 200, cinco(0))),
      category('c1', platillos('c1', 200, cinco(200))),
      category('c2', platillos('c2', 1)),
    ])
    const menu = await loadVisibleMenu('v1', NOW)
    expect(takes(prismaMock.menuCategory.findMany as any)).toEqual([101])
    expect(takes(prismaMock.product.findMany as any)).toEqual([401])
    expect(takes(prismaMock.productModifierGroup.findMany as any)).toEqual([2001])
    expect(takes(prismaMock.modifier.findMany as any)).toEqual([4001])
    // los conteos van acotados por `IN` a lo ya leído: 400 platillos y 400 grupos distintos
    expect((prismaMock.productModifierGroup.groupBy.mock.calls[0][0] as any).where.productId.in).toHaveLength(400)
    expect((prismaMock.modifier.groupBy.mock.calls[0][0] as any).where.groupId.in).toHaveLength(400)
    expect(menu.categories.map(c => c.products.length)).toEqual([200, 200])
    expect(entradas(menu)).toBe(20_000)
    expect(menu.truncated).toBe(true) // c2 no cupo
  })

  it('tope de ENTRADAS de la respuesta (20,000; una opción cuenta cada vez que aparece): el platillo que lo pasaría se omite ENTERO', async () => {
    // 3 grupos compartidos de 50: cada platillo pone 150 entradas. 133 × 150 = 19,950; el 134.º llegaría a 20,100. El siguiente,
    // con un solo grupo (50), sí cabe: 20,000.
    const g = ['ga', 'gb', 'gc'].map(id => opcional(id, 50))
    carta([category('cat1', [...platillos('cat1', 134, () => g), product('cat1-p134', { modifierGroups: [g[0]] })])])
    const menu = await loadVisibleMenu('v1', NOW)
    expect(ids(menu)).toHaveLength(134)
    expect(ids(menu)).not.toContain('cat1-p133')
    expect(ids(menu)).toContain('cat1-p134')
    expect(entradas(menu)).toBe(20_000)
    expect(menu.truncated).toBe(true)
  })

  it('400 platillos visibles ⇒ los 400 en el orden de la carta y sin recorte; uno más ⇒ 400 y `truncated`, con el conteo exacto', async () => {
    // El orden de la carta (tacos antes que aguas) no es el de los ids.
    const dos = [category('tacos', platillos('tacos', 200)), category('aguas', platillos('aguas', 200))]
    carta(dos)
    let menu = await loadVisibleMenu('v1', NOW)
    expect(ids(menu)).toEqual(dos.flatMap(c => c.products.map((p: any) => p.id)))
    expect(menu.truncated).toBe(false)

    carta([...dos, category('postres', platillos('postres', 1))])
    menu = await loadVisibleMenu('v1', NOW)
    expect(ids(menu)).toHaveLength(400)
    expect(menu.categories.map(c => [c.id, c.productCount])).toEqual([
      ['tacos', 200],
      ['aguas', 200],
    ])
    expect(menu.truncated).toBe(true)
  })

  it('una categoría enorme no se come la carta: de 300 se ven 200 y la siguiente sale completa', async () => {
    carta([category('vinos', platillos('vinos', 300)), category('postres', platillos('postres', 10))])
    const menu = await loadVisibleMenu('v1', NOW)
    expect(menu.categories.map(c => [c.id, c.products.length, c.productCount])).toEqual([
      ['vinos', 200, 300],
      ['postres', 10, 10],
    ])
    expect(menu.truncated).toBe(true)
    expect(takes(prismaMock.product.findMany as any).reduce((a: number, b: number) => a + b, 0)).toBeLessThanOrEqual(401)
  })

  it('un platillo cuyo último grupo no cabe en los 2,000 vínculos se omite ENTERO (nunca con grupos a medias)', async () => {
    const g = Array.from({ length: 20 }, (_, i) => opcional(`g${String(i).padStart(2, '0')}`, 2))
    // 99 × 20 + 18 = 1,998 vínculos; el siguiente trae 3 y sólo caben 2.
    carta([
      category('cat1', [
        ...platillos('cat1', 99, () => g),
        product('cat1-p099', { modifierGroups: g.slice(0, 18) }),
        product('cat1-p100', { modifierGroups: g.slice(0, 3) }),
      ]),
    ])
    const menu = await loadVisibleMenu('v1', NOW)
    expect(ids(menu)).toHaveLength(100)
    expect(ids(menu)).not.toContain('cat1-p100')
    expect(menu.categories[0].products[99].groups).toHaveLength(18)
    expect(menu.truncated).toBe(true)
    expect(takes(prismaMock.productModifierGroup.findMany as any)[0]).toBeLessThanOrEqual(2001)
  })

  it('un platillo cuyo último grupo no cabe en las 4,000 opciones se omite ENTERO', async () => {
    // 79 platillos con su propio grupo de 50 opciones (3,950); el siguiente pide 50 + 1 y sólo caben 50.
    carta([
      category('cat1', [
        ...platillos('cat1', 79, i => [opcional(`g${String(i).padStart(3, '0')}`, 50)]),
        product('cat1-p079', { modifierGroups: [opcional('gA', 50), opcional('gB', 1)] }),
      ]),
    ])
    const menu = await loadVisibleMenu('v1', NOW)
    expect(ids(menu)).toHaveLength(79)
    expect(ids(menu)).not.toContain('cat1-p079')
    expect(menu.truncated).toBe(true)
    expect(takes(prismaMock.modifier.findMany as any)[0]).toBeLessThanOrEqual(4001)
  })

  it('si la carta cambia entre el conteo y la lectura, el platillo que no se leyó completo no sale (y lo dice)', async () => {
    carta([category('cat1', [product('p1'), product('p2', { modifierGroups: [group('g1'), group('g2')] })])])
    const contar = prismaMock.productModifierGroup.groupBy.getMockImplementation()!
    prismaMock.productModifierGroup.groupBy.mockImplementation((async (a: any) =>
      ((await contar(a)) as any[]).map(g => (g.productId === 'p2' ? { ...g, _count: { _all: 1 } } : g))) as any) // contó 1; ya son 2
    const menu = await loadVisibleMenu('v1', NOW)
    expect(ids(menu)).toEqual(['p1'])
    expect(menu.truncated).toBe(true)
  })
})

describe('loadCategoryVisibility (H4)', () => {
  it('lee las asignaciones SÓLO de las categorías dadas, de menús activos del negocio, con tope + 1', async () => {
    await loadCategoryVisibility('v1', NOW, [
      { id: 'a', ...SIN_HORARIO },
      { id: 'b', ...SIN_HORARIO },
    ])
    const args = prismaMock.menuCategoryAssignment.findMany.mock.calls[0][0] as any
    expect(args.where).toEqual({ categoryId: { in: ['a', 'b'] }, menu: { venueId: 'v1', active: true } })
    expect(args.orderBy).toEqual([{ categoryId: 'asc' }, { id: 'asc' }])
    expect(args.take).toBe(2 * MAX_MENUS + 1)
  })

  it('si las asignaciones pasan el tope, la categoría que no se pudo evaluar completa NO se ofrece (nunca «sin restricción»)', async () => {
    const tope = 2 * MAX_MENUS
    prismaMock.menuCategoryAssignment.findMany.mockResolvedValue([
      { categoryId: 'a', menu: MENU_SIEMPRE },
      ...Array.from({ length: tope }, () => ({ categoryId: 'b', menu: MENU_SIEMPRE })),
    ] as any)
    const visible = await loadCategoryVisibility('v1', NOW, [
      { id: 'a', ...SIN_HORARIO },
      { id: 'b', ...SIN_HORARIO },
    ])
    expect(visible('a')).toBe(true) // leída completa antes del recorte
    expect(visible('b')).toBe(false) // pudo quedar a medias
    expect(logger.warn).toHaveBeenCalled()
  })
})

describe('A7: horario nocturno en la carta y el cotizador (el mismo evaluador que el POS)', () => {
  it('una categoría del viernes 22:00–02:00 sigue el sábado a la 01:00 y NO aparece el viernes a la 01:00', async () => {
    const noche = { id: 'bar', availableFrom: '22:00', availableUntil: '02:00', availableDays: ['FRI'] }
    expect((await loadCategoryVisibility('v1', new Date('2026-10-17T07:00:00Z'), [noche]))('bar')).toBe(true)
    expect((await loadCategoryVisibility('v1', new Date('2026-10-16T07:00:00Z'), [noche]))('bar')).toBe(false)
  })
})

describe('getPublicMenu', () => {
  it('devuelve precios como números en pesos, `soldOut: false` (1a, R17) y el conteo de la categoría', async () => {
    carta([category('cat1', [product('p1')])])
    const menu = await getPublicMenu('v1', NOW)
    expect(menu.categories[0].productCount).toBe(1)
    const p = menu.categories[0].products[0]
    expect(p.price).toBe(93)
    expect(p.soldOut).toBe(false)
    expect(p.modifierGroups[0].modifiers[1]).toEqual({ id: 'm2', name: 'mod-m2', price: 10 })
  })

  it('un grupo compartido lleva sus opciones UNA vez en memoria (mismo JSON)', async () => {
    carta([category('cat1', [product('p1'), product('p2')])])
    const [a, b] = (await getPublicMenu('v1', NOW)).categories[0].products
    expect(b.modifierGroups[0].modifiers).toBe(a.modifierGroups[0].modifiers)
    expect(a.modifierGroups[0].modifiers).toEqual([
      { id: 'm1', name: 'mod-m1', price: 0 },
      { id: 'm2', name: 'mod-m2', price: 10 },
    ])
  })

  it('cachea 60 s por venue: la segunda lectura no vuelve a la base', async () => {
    carta([category('cat1', [product('p1')])])
    await getPublicMenu('v1', NOW)
    await getPublicMenu('v1', new Date(NOW.getTime() + 30_000))
    expect(prismaMock.menuCategory.findMany).toHaveBeenCalledTimes(1)
    await getPublicMenu('v1', new Date(NOW.getTime() + 61_000))
    expect(prismaMock.menuCategory.findMany).toHaveBeenCalledTimes(2)
  })

  it('P1-09: 10 peticiones simultáneas con la caché fría comparten UNA lectura', async () => {
    carta([category('cat1', [product('p1')])])
    const menus = await Promise.all(Array.from({ length: 10 }, () => getPublicMenu('v1', NOW)))
    expect(prismaMock.menuCategory.findMany).toHaveBeenCalledTimes(1)
    expect(new Set(menus).size).toBe(1)
  })

  it('una recarga que falla no se guarda: la siguiente petición vuelve a leer', async () => {
    carta([category('cat1', [product('p1')])])
    prismaMock.menuCategory.findMany.mockRejectedValueOnce(new Error('se cayó la base'))
    await expect(getPublicMenu('v1', NOW)).rejects.toThrow('se cayó la base')
    const menu = await getPublicMenu('v1', NOW)
    expect(menu.categories).toHaveLength(1)
    expect(prismaMock.menuCategory.findMany).toHaveBeenCalledTimes(2)
  })

  it('clearPublicMenuCache(venueId) descarta la recarga en curso: lo leído antes del cambio no se guarda ni se reparte', async () => {
    let soltar!: (filas: unknown[]) => void
    prismaMock.menuCategory.findMany.mockImplementationOnce((() => new Promise(r => (soltar = r))) as any) // lectura en curso
    const vieja = getPublicMenu('v1', NOW)
    clearPublicMenuCache('v1') // p. ej. el negocio marcó un platillo «en línea»
    carta([category('cat1', [product('p1')])])
    const nueva = await getPublicMenu('v1', NOW) // no se suma a la lectura vieja: lee de nuevo
    expect(nueva.categories).toHaveLength(1)
    soltar([]) // la vieja termina DESPUÉS, con la carta de antes
    expect((await vieja).categories).toHaveLength(0)
    expect(await getPublicMenu('v1', NOW)).toBe(nueva)
    expect(prismaMock.menuCategory.findMany).toHaveBeenCalledTimes(2)
  })

  it('P2-07: la caché guarda a lo más 500 negocios y saca al guardado hace más tiempo', async () => {
    for (let i = 0; i <= 500; i++) await getPublicMenu(`v${i}`, NOW) // 501 negocios
    expect(prismaMock.menuCategory.findMany).toHaveBeenCalledTimes(501)
    await getPublicMenu('v1', NOW)
    await getPublicMenu('v500', NOW)
    expect(prismaMock.menuCategory.findMany).toHaveBeenCalledTimes(501) // siguen en caché
    await getPublicMenu('v0', NOW)
    expect(prismaMock.menuCategory.findMany).toHaveBeenCalledTimes(502) // el primero ya había salido
  })
})
