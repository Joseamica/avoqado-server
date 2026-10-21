import { registerVenueTools } from '../../../src/mcp/tools/venues'
import type { McpScope } from '../../../src/mcp/scope'

const mockVenueFindMany = jest.fn()
const mockOrgFindUnique = jest.fn()
const mockSoCount = jest.fn()
const mockVenueCount = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({ venueFilter: () => ({ venueId: { in: ['v1'] } }), requirePermission: jest.fn() }),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: {
      count: (...a: unknown[]) => mockVenueCount(...a),
      findMany: (...a: unknown[]) => mockVenueFindMany(...(a as [])),
      findFirst: jest.fn(),
    },
    organization: { findUnique: (...a: unknown[]) => mockOrgFindUnique(...(a as [])) },
    staffOrganization: { count: (...a: unknown[]) => mockSoCount(...(a as [])) },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

function register(scope: McpScope) {
  handlers.clear()
  registerVenueTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
}

beforeEach(() => {
  jest.clearAllMocks()
  mockVenueFindMany.mockResolvedValue([{ id: 'v1', name: 'Avoqado Full', slug: 'full', status: 'ACTIVE', city: 'CDMX' }])
  mockVenueCount.mockResolvedValue(1)
  mockOrgFindUnique.mockResolvedValue({ name: 'Grupo Avoqado Prime' })
})

describe('list_my_venues — org context (regression: founder asked for venue IQ from another org)', () => {
  it('multi-org staff: names the active org and warns about the N other orgs (never substitute a venue)', async () => {
    register({ staffId: 's1', activeOrg: 'org-a', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope)
    mockSoCount.mockResolvedValue(2) // belongs to 2 OTHER orgs
    const out = parse(await handlers.get('list_my_venues')!({}, {}))

    expect(out.activeOrganization).toBe('Grupo Avoqado Prime')
    expect(out.note).toMatch(/2 organización/)
    expect(out.note).toMatch(/No uses otro venue como sustituto/)
    expect(out.venues).toHaveLength(1)
  })

  it('single-org staff: no warning note', async () => {
    register({ staffId: 's1', activeOrg: 'org-a', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope)
    mockSoCount.mockResolvedValue(0)
    const out = parse(await handlers.get('list_my_venues')!({}, {}))
    expect(out.activeOrganization).toBe('Grupo Avoqado Prime')
    expect(out.note).toBeUndefined()
  })

  it('superadmin: global-access note, no other-org counting', async () => {
    register({ staffId: 'super', activeOrg: 'org-a', allowedVenueIds: ['v1'], perVenueAccess: new Map(), isSuperAdmin: true } as McpScope)
    const out = parse(await handlers.get('list_my_venues')!({}, {}))
    expect(out.note).toMatch(/SUPERADMIN/)
    expect(mockSoCount).not.toHaveBeenCalled()
  })
})

it('pagina sin perder el total y explica el rol efectivo en cada sucursal', async () => {
  register({
    staffId: 's1',
    activeOrg: 'org-a',
    orgRole: 'MEMBER',
    allowedVenueIds: ['v1', 'v2'],
    perVenueAccess: new Map([
      ['v1', { role: 'ADMIN', corePermissions: ['orders:read', 'menu:read'] }],
      ['v2', { role: 'WAITER', corePermissions: ['orders:read'] }],
    ]),
    scopes: ['mcp:read'],
  } as unknown as McpScope)
  mockVenueCount.mockResolvedValue(2)
  const first = parse(await handlers.get('list_my_venues')!({ limit: 1, offset: 0 }, {}))
  expect(first).toMatchObject({
    count: 1,
    total: 2,
    hasMore: true,
    nextOffset: 1,
    organizationRole: 'MEMBER',
    connectionScopes: ['mcp:read'],
  })
  expect(first.venues[0]).toMatchObject({ role: 'ADMIN', permissions: ['orders:read', 'menu:read'] })
  expect(mockVenueFindMany.mock.calls[0][0]).toMatchObject({ take: 1, skip: 0, orderBy: [{ name: 'asc' }, { id: 'asc' }] })
})

it('busca el nombre en servidor dentro de los venues autorizados', async () => {
  register({ staffId: 's1', activeOrg: 'org-a', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope)
  await handlers.get('list_my_venues')!({ search: 'Centro', limit: 100, offset: 2 }, {})
  const query = mockVenueFindMany.mock.calls[0][0]
  expect(query).toMatchObject({ where: { id: { in: ['v1'] }, OR: expect.any(Array) }, take: 100, skip: 2 })
  expect(mockVenueCount.mock.calls[0][0].where).toEqual(query.where)
})
