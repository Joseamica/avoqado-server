import { registerTableTools } from '../../../src/mcp/tools/tables'
import type { McpScope } from '../../../src/mcp/scope'

const mockGetFloorPlan = jest.fn()
const mockRequire = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: (...a: unknown[]) => mockRequire(...a),
  }),
}))
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: {} }))
jest.mock('@/services/dashboard/floorPlan/floorPlan.read', () => ({ getFloorPlan: (...a: unknown[]) => mockGetFloorPlan(...a) }))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('floor_plan')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerTableTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

const plan = {
  fingerprint: 'abc',
  overLimit: false,
  limits: { areas: 30, tables: 500, elements: 1500 },
  areas: [{ id: 'a1', name: 'Salón', floorShape: null, sortOrder: 0, externalId: null }],
  tables: [
    { id: 't1', number: '1', capacity: 4, shape: 'SQUARE', rotation: 0, positionX: 0.2, positionY: 0.3, areaId: 'a1', hasOpenOrder: false },
    {
      id: 't2',
      number: '2',
      capacity: 2,
      shape: 'ROUND',
      rotation: 0,
      positionX: null,
      positionY: null,
      areaId: null,
      hasOpenOrder: false,
    },
  ],
  elements: [
    {
      id: 'e1',
      type: 'WALL',
      areaId: 'a1',
      positionX: 0,
      positionY: 0,
      width: null,
      height: null,
      rotation: 0,
      endX: 1,
      endY: 0,
      label: null,
      color: null,
    },
    {
      id: 'e2',
      type: 'SERVICE_AREA',
      areaId: 'a1',
      positionX: 0.7,
      positionY: 0,
      width: 0.2,
      height: 0.3,
      rotation: 0,
      endX: null,
      endY: null,
      label: 'Cocina',
      color: null,
    },
  ],
}

describe('floor_plan', () => {
  it('rechaza un venue fuera del alcance', async () => {
    await expect(call({ venueId: 'foreign' })).rejects.toThrow('out of scope')
    expect(mockGetFloorPlan).not.toHaveBeenCalled()
  })

  it('resume el plano por área y lista las mesas sin acomodar', async () => {
    mockGetFloorPlan.mockResolvedValueOnce(plan)
    const out = parse(await call({ venueId: 'v1' }))
    expect(mockRequire).toHaveBeenCalledWith('tables:read', 'v1', 'read')
    expect(out.areas).toEqual([
      {
        name: 'Salón',
        shape: 'ancha',
        seats: 4,
        tables: [{ number: '1', seats: 4, shape: 'cuadrada', placed: true }],
        walls: 1,
        bars: 0,
        serviceAreas: ['Cocina'],
        doors: 0,
        labels: [],
      },
    ])
    expect(out.unplacedTables).toEqual(['2'])
  })

  it('una mesa con capacity 0 («sin dato») no suma lugares y sale con seats null', async () => {
    const sinDato = { ...plan.tables[0], id: 't4', number: '4', capacity: 0 }
    mockGetFloorPlan.mockResolvedValueOnce({ ...plan, tables: [plan.tables[0], sinDato] })
    const out = parse(await call({ venueId: 'v1' }))
    expect(out.areas[0].seats).toBe(4)
    expect(out.areas[0].tables).toContainEqual({ number: '4', seats: null, shape: 'cuadrada', placed: true })
  })

  it('una mesa con una sola coordenada no está acomodada (misma regla que «placed»)', async () => {
    const mediaMesa = { ...plan.tables[0], id: 't3', number: '3', positionX: 0.4, positionY: null }
    mockGetFloorPlan.mockResolvedValueOnce({ ...plan, tables: [...plan.tables, mediaMesa] })
    const out = parse(await call({ venueId: 'v1' }))
    expect(out.areas[0].tables).toContainEqual({ number: '3', seats: 4, shape: 'cuadrada', placed: false })
    expect(out.unplacedTables).toEqual(['2', '3'])
  })

  it('los letreros sin texto no salen como null ni vacíos', async () => {
    const letrero = (id: string, label: string | null) => ({ ...plan.elements[1], id, type: 'LABEL', label })
    mockGetFloorPlan.mockResolvedValueOnce({
      ...plan,
      elements: [...plan.elements, letrero('e3', null), letrero('e4', '   '), letrero('e5', 'Terraza')],
    })
    const out = parse(await call({ venueId: 'v1' }))
    expect(out.areas[0].labels).toEqual(['Terraza'])
  })

  it('los letreros y las áreas de servicio salen sin espacios de más (datos viejos de la PAX)', async () => {
    const letrero = { ...plan.elements[1], id: 'e3', type: 'LABEL', label: '  Terraza  ' }
    const banoViejo = { ...plan.elements[1], id: 'e4', label: '  Baño ' }
    const sinTexto = { ...plan.elements[1], id: 'e5', label: '   ' }
    mockGetFloorPlan.mockResolvedValueOnce({ ...plan, elements: [...plan.elements, letrero, banoViejo, sinTexto] })
    const out = parse(await call({ venueId: 'v1' }))
    expect(out.areas[0].labels).toEqual(['Terraza'])
    expect(out.areas[0].serviceAreas).toEqual(['Cocina', 'Baño', 'Área de servicio'])
  })
})
