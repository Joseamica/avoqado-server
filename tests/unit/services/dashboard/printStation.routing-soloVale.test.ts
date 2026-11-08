/**
 * Aparatos claros, Paso 1: el Ruteo dice qué categorías son «Sólo vale · sin comanda» y cuántas de las «sin ruta» lo son,
 * sin cambiar `unroutedCategories` (lo leen dashboards viejos y el MCP).
 */
const mockPrisma: any = {
  venue: { findUnique: jest.fn() },
  printStation: { count: jest.fn() },
  menuCategory: { count: jest.fn(), findMany: jest.fn() },
  product: { count: jest.fn(), findMany: jest.fn() },
}
const mockSoloVale = jest.fn()
jest.mock('../../../../src/utils/prismaClient', () => ({ __esModule: true, default: mockPrisma }))
jest.mock('../../../../src/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('../../../../src/services/printing/printConfig.service', () => ({ buildPrintConfig: jest.fn(), routingConfigFrom: jest.fn() }))
jest.mock('../../../../src/services/dashboard/routingSoloVale', () => ({ leerSoloVale: (...a: unknown[]) => mockSoloVale(...a) }))
import * as svc from '../../../../src/services/dashboard/printStation.dashboard.service'

const VENUE = 'v1'
const CREMERIA = [{ id: 'a_cre', name: 'Cremería' }]
let categories: Array<{ id: string; printStationId: string | null }>
let hasDefault: boolean

beforeEach(() => {
  jest.clearAllMocks()
  hasDefault = false
  categories = [
    { id: 'c_quesos', printStationId: null },
    { id: 'c_pan', printStationId: null },
    { id: 'c_cafe', printStationId: null },
    { id: 'c_alimentos', printStationId: 'st_cocina' },
  ]
  mockPrisma.venue.findUnique.mockResolvedValue({ id: VENUE })
  mockPrisma.printStation.count.mockImplementation(() => Promise.resolve(hasDefault ? 1 : 0))
  // Sin ruta = sin estación (las estaciones de esta prueba existen y están activas).
  mockPrisma.menuCategory.count.mockImplementation(({ where }: any) =>
    Promise.resolve(
      categories.filter(c => (where.OR ? c.printStationId === null : true) && (where.id?.in ? where.id.in.includes(c.id) : true)).length,
    ),
  )
  mockPrisma.menuCategory.findMany.mockImplementation(() =>
    Promise.resolve(categories.map(c => ({ ...c, name: c.id, _count: { products: 1 } }))),
  )
  mockPrisma.product.findMany.mockResolvedValue([])
  mockPrisma.product.count.mockResolvedValue(0)
  mockSoloVale.mockResolvedValue({ categoryIds: new Set(['c_quesos', 'c_pan', 'c_alimentos']), areas: CREMERIA })
})

const get = (query?: any) => (svc.getRouting as any)(VENUE, query)

describe('Ruteo con «Sólo vale»', () => {
  it('marca las categorías «Sólo vale» y deja las demás sin el campo', async () => {
    const res = await get({ section: 'categories' })
    const marca = Object.fromEntries(res.categories.map((c: any) => [c.id, c.areaTicketOnly]))
    expect(marca).toEqual({ c_quesos: true, c_pan: true, c_cafe: undefined, c_alimentos: true })
  })

  it('sin estación por defecto: cuenta cuántas «sin ruta» son «Sólo vale» y no toca unroutedCategories', async () => {
    const res = await get({ section: 'summary' })
    expect(res).toEqual({
      categories: [],
      products: [],
      hasDefault: false,
      unroutedCategories: 3,
      areaTicketOnlyUnrouted: 2,
      areasWithoutComanda: CREMERIA,
    })
  })

  it('con estación por defecto nada queda sin ruta: 0 y 0', async () => {
    hasDefault = true
    const res = await get({ section: 'summary' })
    expect(res.unroutedCategories).toBe(0)
    expect(res.areaTicketOnlyUnrouted).toBe(0)
    expect(res.areasWithoutComanda).toEqual(CREMERIA)
  })

  it('un negocio sin «Sólo vale» responde exactamente como antes (sin campos nuevos)', async () => {
    mockSoloVale.mockResolvedValue({ categoryIds: new Set(), areas: [] })
    expect(await get({ section: 'summary' })).toEqual({ categories: [], products: [], hasDefault: false, unroutedCategories: 3 })
    const res = await get({ section: 'categories' })
    expect(res.categories.every((c: any) => !('areaTicketOnly' in c))).toBe(true)
  })

  it('si la lectura de «Sólo vale» falla, el Ruteo se ve como siempre', async () => {
    mockSoloVale.mockRejectedValue(new Error('se cayó'))
    expect(await get({ section: 'summary' })).toEqual({ categories: [], products: [], hasDefault: false, unroutedCategories: 3 })
  })

  it('la lista de productos de una categoría no recalcula «Sólo vale» (no lo usa)', async () => {
    await get({ section: 'products', categoryId: 'c_quesos' })
    expect(mockSoloVale).not.toHaveBeenCalled()
  })
})
