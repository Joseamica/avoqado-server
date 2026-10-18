import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpScope } from '@/mcp/scope'
import { TOOL_EFFECTS } from '@/mcp/catalog'
import { registerDocumentRequestTools } from '@/mcp/tools/documentRequests'
import * as requests from '@/services/document-requests/documentRequests.service'

jest.mock('@/services/document-requests/documentRequests.service', () => ({
  listRequests: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25 }),
  getAdminRequest: jest.fn().mockResolvedValue({ request: { id: 'request' }, documents: [] }),
  createRequest: jest.fn().mockResolvedValue({ uploadUrl: 'https://dashboard.example/documentos/request#token=secret' }),
  renewRequest: jest.fn().mockResolvedValue({ uploadUrl: 'https://dashboard.example/documentos/request#token=new' }),
  revokeRequest: jest.fn().mockResolvedValue({ request: { status: 'REVOKED' } }),
}))

function setup(isSuperAdmin = true, scopes = ['mcp:read', 'mcp:write']) {
  const handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {}
  const server = { tool: jest.fn((name, _description, _schema, handler) => (handlers[name] = handler)) }
  const scope = { staffId: 'actor', isSuperAdmin, scopes } as McpScope
  registerDocumentRequestTools(server as unknown as McpServer, scope)
  return { server, handlers, scope }
}

describe('Document requests MCP — new capability', () => {
  beforeEach(() => jest.clearAllMocks())

  it('does not register platform prospect files for a customer', () => {
    expect(setup(false).server.tool).not.toHaveBeenCalled()
  })

  it('declares reads and mutations for the protocol catalog scope gate', () => {
    expect({
      list: TOOL_EFFECTS.list_document_requests,
      detail: TOOL_EFFECTS.get_document_request,
      create: TOOL_EFFECTS.create_document_request,
      manage: TOOL_EFFECTS.manage_document_request,
    }).toEqual({ list: 'read', detail: 'read', create: 'write', manage: 'write' })
  })

  it('lists through the bounded shared service', async () => {
    await setup().handlers.list_document_requests({ page: 2, pageSize: 25, search: 'Tienda' })
    expect(requests.listRequests).toHaveBeenCalledWith({ page: 2, pageSize: 25, search: 'Tienda', status: undefined })
  })

  it('creates a link with the exact provider/personality and audited actor', async () => {
    await setup().handlers.create_document_request({ provider: 'ANGELPAY', entityType: 'PERSONA_FISICA', businessName: 'Estudio' })
    expect(requests.createRequest).toHaveBeenCalledWith(
      { provider: 'ANGELPAY', entityType: 'PERSONA_FISICA', businessName: 'Estudio' },
      'actor',
    )
  })

  it('previews revocation and renewal without executing them', async () => {
    const { handlers } = setup()
    await handlers.manage_document_request({ id: 'request', action: 'revoke', confirm: false })
    await handlers.manage_document_request({ id: 'request', action: 'renew', confirm: false })
    expect(requests.revokeRequest).not.toHaveBeenCalled()
    expect(requests.renewRequest).not.toHaveBeenCalled()
  })

  it('executes confirmed revocation through audited service', async () => {
    await setup().handlers.manage_document_request({ id: 'request', action: 'revoke', confirm: true })
    expect(requests.revokeRequest).toHaveBeenCalledWith('request', 'actor')
  })
})

describe('Document requests MCP — access regression', () => {
  beforeEach(() => jest.clearAllMocks())

  it('rechecks superadmin at call time', async () => {
    const { handlers, scope } = setup()
    scope.isSuperAdmin = false
    await handlers.list_document_requests({ page: 1, pageSize: 25 })
    expect(requests.listRequests).not.toHaveBeenCalled()
  })

  it('requires an explicit write scope even for a superadmin', async () => {
    const { handlers } = setup(true, ['mcp:read'])
    await expect(
      handlers.create_document_request({ provider: 'BLUMON', entityType: 'PERSONA_MORAL', businessName: 'Comercio' }),
    ).rejects.toThrow('solo lectura')
    expect(requests.createRequest).not.toHaveBeenCalled()
  })
})
