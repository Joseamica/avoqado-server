import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { TOOL_EFFECTS } from '@/mcp/catalog'
import { DIRECTORY_TOOLS } from '@/mcp/directory/catalog'
import type { McpScope } from '@/mcp/scope'
import { registerAllTools } from '@/mcp/server'
import { registerPosAppVersionTools } from '@/mcp/tools/posAppVersions'
import { getPolicies } from '@/services/posAppVersion/policy.service'

jest.mock('@/services/posAppVersion/policy.service', () => ({
  ...jest.requireActual('@/services/posAppVersion/policy.service'),
  getPolicies: jest.fn(),
}))

const getPoliciesMock = getPolicies as jest.Mock

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>

const POLICIES = {
  ANDROID: {
    exists: true,
    version: 3,
    required: { code: 120, name: '2.30.0' },
    recommended: { code: 130, name: '2.31.0', noticeStyle: 'BANNER' },
    message: 'Actualiza la app',
    updatedAt: '2026-11-04T10:00:00.000Z',
    updatedBy: { id: 'staff1', name: 'Ana' },
  },
  IOS: { exists: false, version: null, required: null, recommended: null, message: null, updatedAt: null, updatedBy: null },
}

function setup(scopeOver: Partial<McpScope> = { isSuperAdmin: true }) {
  const registered: Record<string, { description: string; handler: Handler }> = {}
  const server = {
    tool: jest.fn((name: string, description: string, _shape: unknown, handler: Handler) => {
      registered[name] = { description, handler }
    }),
  }
  const scope = { staffId: 'actor', scopes: ['mcp:read'], ...scopeOver } as McpScope
  registerPosAppVersionTools(server as unknown as McpServer, scope)
  return { server, registered, scope }
}

describe('MCP get_pos_app_version_policies', () => {
  beforeEach(() => getPoliciesMock.mockReset())

  it('no registra nada si no es SUPERADMIN', () => {
    expect(setup({ isSuperAdmin: false }).server.tool).not.toHaveBeenCalled()
    expect(setup({}).server.tool).not.toHaveBeenCalled()
  })

  it('con SUPERADMIN registra la tool y contesta lo que regresa getPolicies', async () => {
    getPoliciesMock.mockResolvedValue(POLICIES)
    const { server, registered } = setup()
    expect(server.tool.mock.calls.map(([name]) => name)).toEqual(['get_pos_app_version_policies'])
    expect(registered.get_pos_app_version_policies.description).toMatch(/no es la terminal de cobro \(TPV\)/i)
    const result = JSON.parse((await registered.get_pos_app_version_policies.handler({})).content[0].text)
    expect(result.ok).toBe(true)
    expect(result.politicas).toEqual(POLICIES)
  })

  it('el handler vuelve a comprobar SUPERADMIN', async () => {
    const { registered, scope } = setup()
    scope.isSuperAdmin = false
    const result = JSON.parse((await registered.get_pos_app_version_policies.handler({})).content[0].text)
    expect(result.ok).toBe(false)
    expect(getPoliciesMock).not.toHaveBeenCalled()
  })

  it('es de lectura y no entra al directorio certificado', () => {
    expect(TOOL_EFFECTS.get_pos_app_version_policies).toBe('read')
    expect(DIRECTORY_TOOLS.has('get_pos_app_version_policies')).toBe(false)
  })

  it('registerAllTools la ofrece sólo a SUPERADMIN', () => {
    const names = (scope: Partial<McpScope>) => {
      const tools: string[] = []
      registerAllTools(
        { tool: (...a: unknown[]) => tools.push(a[0] as string) } as never,
        { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map(), ...scope } as McpScope,
        { serializedEnabled: true, whiteLabelEnabled: true, catalogEnabled: true },
      )
      return tools
    }
    expect(names({ isSuperAdmin: true })).toContain('get_pos_app_version_policies')
    expect(names({ isSuperAdmin: false })).not.toContain('get_pos_app_version_policies')
  })
})
