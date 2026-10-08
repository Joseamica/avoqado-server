const mockPrisma: any = {
  venue: { findUnique: jest.fn() },
  printStation: { count: jest.fn(), findMany: jest.fn() },
  menuCategory: { count: jest.fn(), findMany: jest.fn() },
  product: { count: jest.fn(), findMany: jest.fn() },
}
jest.mock('../../../../src/utils/prismaClient', () => ({ __esModule: true, default: mockPrisma }))
jest.mock('../../../../src/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('../../../../src/services/printing/printConfig.service', () => ({ buildPrintConfig: jest.fn(), routingConfigFrom: jest.fn() }))
import * as svc from '../../../../src/services/dashboard/printStation.dashboard.service'
import * as schemas from '../../../../src/schemas/dashboard/printStation.schema'
const VENUE = 'venue_1'
let products: any[], categories: any[], stations: any[]
const matches = (row: any, where: any): boolean => {
  for (const field of ['venueId', 'deletedAt', 'categoryId', 'active', 'isDefault', 'printStationId']) {
    if (where[field] !== undefined && row[field] !== where[field]) return false
  }
  if (where.name && !row.name.toLowerCase().includes(where.name.contains.toLowerCase())) return false
  if (where.OR && !where.OR.some((w: any) => matches(row, w))) return false
  if (where.printStation?.isNot) {
    const station = stations.find(s => s.id === row.printStationId)
    if (station && matches(station, where.printStation.isNot)) return false
  }
  return true
}
const page = (rows: any[], args: any) => {
  const filtered = rows.filter(row => matches(row, args.where))
  const orders = Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy]
  filtered.sort((a, b) => {
    for (const order of orders) {
      const field = Object.keys(order)[0]
      const diff = typeof a[field] === 'number' ? a[field] - b[field] : String(a[field]).localeCompare(String(b[field]))
      if (diff) return diff
    }
    return 0
  })
  return filtered.slice(args.skip ?? 0, args.take === undefined ? undefined : (args.skip ?? 0) + args.take)
}
beforeEach(() => {
  jest.clearAllMocks()
  products = [
    { id: 'p_cafe', venueId: VENUE, name: 'Café', categoryId: 'c1', printStationId: null, deletedAt: null },
    { id: 'p_pan', venueId: VENUE, name: 'Pan', categoryId: 'c1', printStationId: null, deletedAt: new Date() },
    { id: 'p_other', venueId: 'venue_2', name: 'Café', categoryId: 'c1', printStationId: null, deletedAt: null },
  ]
  categories = [{ id: 'c1', venueId: VENUE, name: 'Bebidas', displayOrder: 0, printStationId: null }]
  stations = []
  mockPrisma.venue.findUnique.mockResolvedValue({ id: VENUE })
  mockPrisma.product.findMany.mockImplementation((a: any) => Promise.resolve(page(products, a)))
  mockPrisma.product.count.mockImplementation(({ where }: any) => Promise.resolve(products.filter(p => matches(p, where)).length))
  mockPrisma.menuCategory.findMany.mockImplementation((a: any) =>
    Promise.resolve(
      page(categories, a).map(c => ({
        ...c,
        _count: { products: products.filter(p => p.categoryId === c.id && p.venueId === VENUE && p.deletedAt === null).length },
      })),
    ),
  )
  mockPrisma.menuCategory.count.mockImplementation(({ where }: any) => Promise.resolve(categories.filter(c => matches(c, where)).length))
  mockPrisma.printStation.findMany.mockImplementation(({ where }: any) => Promise.resolve(stations.filter(s => matches(s, where))))
  mockPrisma.printStation.count.mockImplementation(({ where }: any) => Promise.resolve(stations.filter(s => matches(s, where)).length))
})
const get = (query?: any) => (svc.getRouting as any)(VENUE, query)
describe('CFG02: archived products and bounded routing', () => {
  it('legacy excludes archived and foreign products', async () => {
    expect((await get()).products.map((p: any) => p.id)).toEqual(['p_cafe'])
  })
  it('product pages scope venue, live products, search and category with exact totals', async () => {
    products.push({ ...products[0], id: 'p_cafe2' }, { ...products[0], id: 'p_other_category', categoryId: 'c2' })
    const res = await get({ section: 'products', page: 2, pageSize: 1, search: 'Caf', categoryId: 'c1' })
    expect(res.products.map((p: any) => p.id)).toEqual(['p_cafe2'])
    expect(res.categories).toEqual([])
    expect(res.pagination).toEqual({ page: 2, pageSize: 1, total: 2, totalPages: 2 })
    expect(mockPrisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { venueId: VENUE, deletedAt: null, categoryId: 'c1', name: { contains: 'Caf', mode: 'insensitive' } },
        take: 1,
        skip: 1,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
    )
  })
  it('categories use stable ties, live productCount and filtered total independent of global unrouted', async () => {
    categories.push({ ...categories[0], id: 'c2', name: 'Comidas' }, { ...categories[0], id: 'c3', venueId: 'venue_2' })
    const res = await get({ section: 'categories', pageSize: 1, search: 'Beb' })
    expect(res.categories).toEqual([expect.objectContaining({ id: 'c1', productCount: 1 })])
    expect(res.products).toEqual([])
    expect(res.pagination.total).toBe(1)
    expect(res.unroutedCategories).toBe(2)
    expect(mockPrisma.product.findMany).not.toHaveBeenCalled()
    expect(mockPrisma.menuCategory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 1, orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }] }),
    )
  })
  it('summary never downloads catalogs and counts null, inactive and foreign destinations globally', async () => {
    stations = [
      { id: 'active', venueId: VENUE, active: true, isDefault: false },
      { id: 'inactive', venueId: VENUE, active: false },
      { id: 'foreign', venueId: 'venue_2', active: true },
    ]
    categories.push(...['active', 'inactive', 'foreign'].map(id => ({ ...categories[0], id, printStationId: id })))
    const res = await get({ section: 'summary' })
    expect(res).toEqual({ categories: [], products: [], hasDefault: false, unroutedCategories: 3 })
    expect(mockPrisma.menuCategory.findMany).not.toHaveBeenCalled()
    expect(mockPrisma.product.findMany).not.toHaveBeenCalled()
    stations.push({ id: 'default', venueId: VENUE, active: true, isDefault: true })
    expect((await get({ section: 'summary' })).unroutedCategories).toBe(0)
  })
  it('legacy catalogs larger than 100 remain complete through bounded pages', async () => {
    categories = Array.from({ length: 205 }, (_, i) => ({ ...categories[0], id: `c${String(i).padStart(3, '0')}` }))
    products = Array.from({ length: 207 }, (_, i) => ({ ...products[0], id: `p${String(i).padStart(3, '0')}` }))
    const res = await get()
    expect(new Set(res.categories.map((c: any) => c.id)).size).toBe(205)
    expect(new Set(res.products.map((p: any) => p.id)).size).toBe(207)
    for (const model of [mockPrisma.menuCategory, mockPrisma.product]) {
      expect(model.findMany).toHaveBeenCalledTimes(3)
      expect(model.findMany.mock.calls.every(([a]: any) => a.take === 100)).toBe(true)
    }
  })
  it('service imposes maximum and empty pages retain metadata', async () => {
    const res = await get({ section: 'products', pageSize: 1000, page: 9 })
    expect(res.pagination).toEqual({ page: 9, pageSize: 100, total: 1, totalPages: 1 })
    expect(res.products).toEqual([])
  })
  it.each([
    { page: 'NaN' },
    { page: '1.5' },
    { page: '0' },
    { page: '-1' },
    { pageSize: '101' },
    { pageSize: '1.1' },
    { search: 'x'.repeat(101) },
    { section: 'wrong' },
  ])('canonical query schema rejects %j', query => {
    const schema = (schemas as any).getRoutingSchema
    expect(schema).toBeDefined()
    const parsed = schema.safeParse({ params: { venueId: VENUE }, query })
    expect(parsed.success).toBe(false)
    expect(parsed.error.issues[0].message).not.toMatch(/must|Invalid|Expected/)
  })
  it('query defaults are 1/50 and legacy section stays optional', () => {
    expect((schemas as any).getRoutingSchema.parse({ params: { venueId: VENUE }, query: {} }).query).toEqual({ page: 1, pageSize: 50 })
  })
})
