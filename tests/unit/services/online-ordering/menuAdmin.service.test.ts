// 1b (tarea 4): el «menú en línea» del panel. Conteos por categoría con agregados acotados al negocio y lista paginada.
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { getOnlineMenuSummary, listOnlineMenuProducts } from '@/services/online-ordering/menuAdmin.service'

/** Evalúa el subconjunto de `where` de Prisma que usa el servicio: así las pruebas miden QUÉ cuenta, no la forma de la consulta. */
const cumple = (p: Record<string, any>, w: Record<string, any>): boolean =>
  Object.entries(w).every(([k, v]) => {
    if (k === 'OR') return v.some((o: Record<string, any>) => cumple(p, o))
    if (v === null || typeof v !== 'object') return p[k] === v
    if ('in' in v) return v.in.includes(p[k])
    if ('notIn' in v) return !v.notIn.includes(p[k])
    if ('not' in v) return p[k] !== v.not
    if ('contains' in v) return v.mode === 'insensitive' && String(p[k]).toLowerCase().includes(v.contains.toLowerCase())
    throw new Error(`filtro no soportado en la prueba: ${k}`)
  })

const prod = (id: string, o: Record<string, any> = {}) => ({
  id,
  venueId: 'v1',
  categoryId: 'c1',
  name: id,
  price: new Prisma.Decimal('50'),
  imageUrl: 'https://img/x.jpg',
  active: true,
  availableOnline: true,
  deletedAt: null,
  soldByWeight: false,
  type: 'FOOD',
  ...o,
})

/** La base en memoria: categorías y platillos; cada llamada de Prisma responde con su `where`. */
function base(categorias: Array<{ id: string; name: string; active: boolean }>, productos: Array<Record<string, any>>) {
  prismaMock.menuCategory.findMany.mockImplementation(async (a: any) =>
    categorias.filter(c => cumple({ ...c, venueId: 'v1' }, a.where)).slice(0, a.take),
  )
  prismaMock.product.groupBy.mockImplementation(async (a: any) => {
    const porCategoria = new Map<string, number>()
    for (const p of productos.filter(x => cumple(x, a.where))) porCategoria.set(p.categoryId, (porCategoria.get(p.categoryId) ?? 0) + 1)
    return [...porCategoria].map(([categoryId, n]) => ({ categoryId, _count: { _all: n } }))
  })
  prismaMock.product.count.mockImplementation(async (a: any) => productos.filter(x => cumple(x, a.where)).length)
  prismaMock.product.findMany.mockImplementation(async (a: any) =>
    productos
      .filter(x => cumple(x, a.where))
      .sort((x, y) => (x.name === y.name ? (x.id < y.id ? -1 : 1) : x.name < y.name ? -1 : 1))
      .slice(0, a.take)
      .map(x => Object.fromEntries(Object.keys(a.select).map(k => [k, x[k]]))),
  )
}

describe('getOnlineMenuSummary: conteos por categoría', () => {
  const CATS = [
    { id: 'c1', name: 'Tacos', active: true },
    { id: 'c2', name: 'Bebidas', active: false },
    { id: 'c3', name: 'Postres', active: true },
  ]
  const PRODUCTOS = [
    prod('p1'), // en línea con foto
    prod('p2', { imageUrl: null }), // en línea sin foto
    prod('p3', { imageUrl: '' }), // en línea con foto vacía = sin foto
    prod('p4', { availableOnline: false, imageUrl: null }), // vendible, no publicado
    prod('p5', { active: false }), // inactivo: no cuenta
    prod('p6', { deletedAt: new Date() }), // borrado: no cuenta
    prod('p7', { soldByWeight: true }), // por peso: la tienda no lo vende
    prod('p8', { type: 'APPOINTMENTS_SERVICE' }), // servicio: no es comida
    prod('p9', { type: 'CLASS', imageUrl: null }),
    prod('q1', { categoryId: 'c2' }),
    prod('x1', { venueId: 'v2' }), // de otro negocio
  ]

  it('cuenta sólo lo vendible y activo; en línea; y en línea sin foto (nulo o vacío). Servicio, peso, borrado e inactivo no cuentan', async () => {
    base(CATS, PRODUCTOS)
    const r = await getOnlineMenuSummary('v1')
    expect(r).toEqual({
      categories: [
        { id: 'c1', name: 'Tacos', active: true, total: 4, online: 3, onlineWithoutPhoto: 2 },
        { id: 'c2', name: 'Bebidas', active: false, total: 1, online: 1, onlineWithoutPhoto: 0 },
        { id: 'c3', name: 'Postres', active: true, total: 0, online: 0, onlineWithoutPhoto: 0 },
      ],
      totals: { total: 5, online: 4, onlineWithoutPhoto: 2 },
      truncated: false,
    })
  })

  it('categorías en el orden de la carta con tope 100 (+1), sin `_count` de relación; agregados acotados al negocio', async () => {
    base(CATS, PRODUCTOS)
    await getOnlineMenuSummary('v1')
    expect(prismaMock.menuCategory.findMany).toHaveBeenCalledWith({
      where: { venueId: 'v1' },
      orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
      take: 101,
      select: { id: true, name: true, active: true },
    })
    const agrupados = prismaMock.product.groupBy.mock.calls.map((c: any[]) => c[0])
    expect(agrupados.length).toBeGreaterThan(0)
    for (const a of agrupados) {
      expect(a.by).toEqual(['categoryId'])
      expect(a.where).toMatchObject({ venueId: 'v1', categoryId: { in: ['c1', 'c2', 'c3'] } })
    }
    for (const [a] of prismaMock.product.count.mock.calls as any[]) expect(a.where.venueId).toBe('v1')
    expect(prismaMock.product.findMany).not.toHaveBeenCalled()
  })

  it('sin categorías no corre los agregados por categoría (nada de `IN ()`); los totales del negocio sí', async () => {
    base([], [prod('a')])
    const r = await getOnlineMenuSummary('v1')
    expect(r).toEqual({ categories: [], totals: { total: 1, online: 1, onlineWithoutPhoto: 0 }, truncated: false })
    expect(prismaMock.product.groupBy).not.toHaveBeenCalled()
  })

  it('con 101 categorías devuelve 100 y truncated:true; los totales siguen siendo exactos del negocio', async () => {
    const cats = Array.from({ length: 101 }, (_, i) => ({ id: `c${String(i).padStart(3, '0')}`, name: `Cat ${i}`, active: true }))
    base(cats, [prod('a', { categoryId: 'c000' }), prod('z', { categoryId: 'c100', imageUrl: null })])
    const r = await getOnlineMenuSummary('v1')
    expect(r.categories).toHaveLength(100)
    expect(r.truncated).toBe(true)
    expect(r.totals).toEqual({ total: 2, online: 2, onlineWithoutPhoto: 1 })
    for (const [a] of prismaMock.product.groupBy.mock.calls as any[]) expect(a.where.categoryId.in).toHaveLength(100)
  })
})

describe('listOnlineMenuProducts: lista paginada', () => {
  const PRODUCTOS = [
    prod('pa', { name: 'Agua de horchata', categoryId: 'c2' }),
    prod('pb', { name: 'Flautas de pollo', price: new Prisma.Decimal('45.50'), imageUrl: null }),
    prod('pc', { name: 'Taco al pastor', active: false }), // inactivo: SÍ sale (el panel lo enseña apagado)
    prod('pd', { name: 'Taco de suadero', availableOnline: false }),
    prod('pe', { name: 'Masaje', type: 'APPOINTMENTS_SERVICE' }),
    prod('pf', { name: 'Queso por kilo', soldByWeight: true }),
    prod('pg', { name: 'Taco borrado', deletedAt: new Date() }),
    prod('ph', { name: 'Taco ajeno', venueId: 'v2' }),
  ]

  it('por omisión 50 (+1), por nombre e id; sólo vendibles (activos e inactivos); total exacto con el mismo filtro', async () => {
    base([], PRODUCTOS)
    const r = await listOnlineMenuProducts({ venueId: 'v1' })
    const a = prismaMock.product.findMany.mock.calls[0][0] as any
    expect(a.take).toBe(51)
    expect(a.orderBy).toEqual([{ name: 'asc' }, { id: 'asc' }])
    expect(a.cursor).toBeUndefined()
    expect(r.items.map(i => i.id)).toEqual(['pa', 'pb', 'pc', 'pd'])
    expect(r.items[1]).toEqual({
      id: 'pb',
      name: 'Flautas de pollo',
      price: 45.5,
      imageUrl: null,
      active: true,
      availableOnline: true,
      categoryId: 'c1',
    })
    expect(r.total).toBe(4)
    expect(r.nextCursor).toBeNull()
    expect((prismaMock.product.count.mock.calls[0][0] as any).where).toEqual(a.where)
  })

  it('con limit+1 filas devuelve `limit` y nextCursor = id del último devuelto', async () => {
    base(
      [],
      Array.from({ length: 5 }, (_, i) => prod(`p${i}`, { name: `Plato ${i}` })),
    )
    const r = await listOnlineMenuProducts({ venueId: 'v1', limit: 2 })
    expect((prismaMock.product.findMany.mock.calls[0][0] as any).take).toBe(3)
    expect(r.items.map(i => i.id)).toEqual(['p0', 'p1'])
    expect(r.nextCursor).toBe('p1')
    expect(r.total).toBe(5)
  })

  it('con cursor: cursor nativo por id, sin repetir la fila del cursor aunque ya no cumpla el filtro (sin OFFSET a ciegas)', async () => {
    base([], PRODUCTOS)
    await listOnlineMenuProducts({ venueId: 'v1', categoryId: 'c1', cursor: 'pb', limit: 10 })
    const a = prismaMock.product.findMany.mock.calls[0][0] as any
    expect(a.cursor).toEqual({ id: 'pb' })
    expect(a.skip).toBeUndefined()
    expect(a.where).toMatchObject({ venueId: 'v1', categoryId: 'c1', id: { not: 'pb' } })
    // El total no depende de la página.
    expect((prismaMock.product.count.mock.calls[0][0] as any).where.id).toBeUndefined()
  })

  it('`%`, `_` y `\\` se buscan literales: `contains` de Prisma no los escapa solo', async () => {
    base([], PRODUCTOS)
    for (const [busca, patron] of [
      ['50%', '50\\%'],
      ['a_b', 'a\\_b'],
      ['c\\d', 'c\\\\d'],
    ]) {
      prismaMock.product.findMany.mockClear()
      prismaMock.product.count.mockClear()
      await listOnlineMenuProducts({ venueId: 'v1', search: busca })
      const a = prismaMock.product.findMany.mock.calls[0][0] as any
      expect({ busca, contains: a.where.name.contains }).toEqual({ busca, contains: patron })
      expect((prismaMock.product.count.mock.calls[0][0] as any).where.name.contains).toBe(patron)
    }
  })

  it('búsqueda sin mayúsculas sobre el nombre; el total cuenta la búsqueda', async () => {
    base([], PRODUCTOS)
    const r = await listOnlineMenuProducts({ venueId: 'v1', search: 'TACO' })
    expect(r.items.map(i => i.id)).toEqual(['pc', 'pd'])
    expect(r.total).toBe(2)
  })
})
