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

beforeEach(() => {
  clearPublicMenuCache()
  prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' } as any)
  prismaMock.menuCategoryAssignment.findMany.mockResolvedValue([])
  prismaMock.product.groupBy.mockResolvedValue([] as any)
})

describe('loadVisibleMenu', () => {
  it('pide sólo lo que se vende en línea: activo, no borrado, marcado, por pieza y comida (R17), con topes + 1 (H10)', async () => {
    prismaMock.menuCategory.findMany.mockResolvedValue([])
    await loadVisibleMenu('v1', NOW)
    const args = prismaMock.menuCategory.findMany.mock.calls[0][0] as any
    expect(args.where).toEqual({ venueId: 'v1', active: true })
    expect(args.take).toBe(101) // tope + 1: así se sabe si sobró una
    expect(args.include.products.where).toEqual({
      active: true,
      deletedAt: null,
      availableOnline: true,
      soldByWeight: false,
      type: { notIn: ['APPOINTMENTS_SERVICE', 'CLASS', 'EVENT', 'DONATION'] },
    })
    expect(args.include.products.take).toBe(201)
    // un grupo y una opción de más, a propósito: así se sabe que el producto no cupo completo
    expect(args.include.products.select.modifierGroups.take).toBe(21)
    expect(args.include.products.select.modifierGroups.select.group.select.modifiers.take).toBe(51)
  })

  it('omite categorías sin platillos y mapea grupos, modificadores, el nombre de la categoría y su conteo', async () => {
    prismaMock.menuCategory.findMany.mockResolvedValue([category('cat1', [product('p1')]), category('vacia', [])] as any)
    prismaMock.product.groupBy.mockResolvedValue([{ categoryId: 'cat1', _count: { _all: 1 } }] as any)
    const menu = await loadVisibleMenu('v1', NOW)
    expect(menu.categories.map(c => c.id)).toEqual(['cat1'])
    expect(menu.categories[0].productCount).toBe(1)
    expect(menu.categories[0].products[0]).toMatchObject({ categoryId: 'cat1', categoryName: 'Flautas' })
    expect(menu.categories[0].products[0].groups[0].modifiers.map(m => m.id)).toEqual(['m1', 'm2'])
    expect(menu.truncated).toBe(false)
  })

  it('oculta la categoría de un menú con horario que no aplica ahora y deja la que no está en ningún menú', async () => {
    prismaMock.menuCategory.findMany.mockResolvedValue([
      category('desayunos', [product('p1', { categoryId: 'desayunos' })]),
      category('siempre', [product('p2', { categoryId: 'siempre' })]),
    ] as any)
    prismaMock.menuCategoryAssignment.findMany.mockResolvedValue([
      { categoryId: 'desayunos', menu: { ...MENU_SIEMPRE, availableFrom: '07:00', availableUntil: '11:00' } },
    ] as any)
    const menu = await loadVisibleMenu('v1', NOW) // 12:30 CDMX: fuera del desayuno
    expect(menu.categories.map(c => c.id)).toEqual(['siempre'])
  })

  it('H4: una categoría con horario PROPIO fuera de hora no se muestra, aunque no esté en ningún menú', async () => {
    prismaMock.menuCategory.findMany.mockResolvedValue([
      category('desayunos', [product('p1', { categoryId: 'desayunos' })], { availableFrom: '07:00', availableUntil: '11:00' }),
      category('entre-semana', [product('p2', { categoryId: 'entre-semana' })], { availableDays: ['WED'] }),
    ] as any)
    const menu = await loadVisibleMenu('v1', NOW) // miércoles 12:30 CDMX
    expect(menu.categories.map(c => c.id)).toEqual(['entre-semana'])
  })

  it('H10: exactamente el tope de categorías NO es recorte; una de más sí, y se registra (nunca recorta en silencio)', async () => {
    const cats = (n: number) => Array.from({ length: n }, (_, i) => category(`c${i}`, [product(`p${i}`, { categoryId: `c${i}` })]))
    prismaMock.menuCategory.findMany.mockResolvedValue(cats(100) as any)
    expect((await loadVisibleMenu('v1', NOW)).truncated).toBe(false)

    prismaMock.menuCategory.findMany.mockResolvedValue(cats(101) as any)
    const menu = await loadVisibleMenu('v1', NOW)
    expect(menu.truncated).toBe(true)
    expect(menu.categories).toHaveLength(100)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('recort'), expect.objectContaining({ venueId: 'v1' }))
  })

  it('H10: con 201 platillos muestra 200, marca truncated y el conteo sale del agregado, no de la lista', async () => {
    const muchos = Array.from({ length: 201 }, (_, i) => product(`p${i}`))
    prismaMock.menuCategory.findMany.mockResolvedValue([category('cat1', muchos)] as any)
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
    prismaMock.menuCategory.findMany.mockResolvedValue([category('cat1', [enorme, product('p-normal')])] as any)
    const menu = await loadVisibleMenu('v1', NOW)
    expect(menu.categories[0].products.map(p => p.id)).toEqual(['p-normal'])
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

describe('getPublicMenu', () => {
  it('devuelve precios como números en pesos, `soldOut: false` (1a, R17) y el conteo de la categoría', async () => {
    prismaMock.menuCategory.findMany.mockResolvedValue([category('cat1', [product('p1')])] as any)
    const menu = await getPublicMenu('v1', NOW)
    expect(menu.categories[0].productCount).toBe(1) // sin agregado (mock vacío), cae a lo que se lista
    const p = menu.categories[0].products[0]
    expect(p.price).toBe(93)
    expect(p.soldOut).toBe(false)
    expect(p.modifierGroups[0].modifiers[1]).toEqual({ id: 'm2', name: 'mod-m2', price: 10 })
  })

  it('cachea 60 s por venue: la segunda lectura no vuelve a la base', async () => {
    prismaMock.menuCategory.findMany.mockResolvedValue([category('cat1', [product('p1')])] as any)
    await getPublicMenu('v1', NOW)
    await getPublicMenu('v1', new Date(NOW.getTime() + 30_000))
    expect(prismaMock.menuCategory.findMany).toHaveBeenCalledTimes(1)
    await getPublicMenu('v1', new Date(NOW.getTime() + 61_000))
    expect(prismaMock.menuCategory.findMany).toHaveBeenCalledTimes(2)
  })
})
