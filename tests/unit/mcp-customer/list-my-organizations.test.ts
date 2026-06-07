import { registerOrganizationTools } from '../../../src/mcp/tools/organizations'
import type { McpScope } from '../../../src/mcp/scope'

const mockOrgFind = jest.fn()

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { staffOrganization: { findMany: (...a: unknown[]) => mockOrgFind(...(a as [])) } },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 'staff-1', activeOrg: 'org-a', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = () => handlers.get('list_my_organizations')!({}, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerOrganizationTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('list_my_organizations', () => {
  it("lists only the caller's own active memberships and flags the connected org", async () => {
    mockOrgFind.mockResolvedValueOnce([
      { role: 'OWNER', isPrimary: true, organization: { id: 'org-a', name: 'Grupo Avoqado', slug: 'avoqado' } },
      { role: 'ADMIN', isPrimary: false, organization: { id: 'org-b', name: 'PlayTelecom', slug: 'playtelecom' } },
    ])
    const out = parse(await call())

    // queried strictly for the caller, active memberships only
    expect((mockOrgFind.mock.calls[0][0] as { where: Record<string, unknown> }).where).toEqual({ staffId: 'staff-1', isActive: true })
    expect(out.connectedOrgId).toBe('org-a')
    expect(out.count).toBe(2)
    expect(out.organizations[0]).toMatchObject({ id: 'org-a', name: 'Grupo Avoqado', yourRole: 'OWNER', isPrimary: true, connected: true })
    expect(out.organizations[1]).toMatchObject({ id: 'org-b', yourRole: 'ADMIN', connected: false })
  })
})
