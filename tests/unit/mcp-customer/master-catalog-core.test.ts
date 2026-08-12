import { ScopeError, requireCatalogWriteScope } from '@/mcp/guard'
import type { McpScope } from '@/mcp/scope'
import { DEFAULT_PERMISSIONS } from '@/lib/permissions'
import { StaffRole } from '@prisma/client'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

jest.mock('@/services/master-catalog/catalogAuthorization.service', () => ({ authorizeCatalogRequest: jest.fn() }))
jest.mock('@/services/master-catalog/catalogItem.service', () => ({ listCatalogItems: jest.fn(), getCatalogItem: jest.fn() }))
jest.mock('@/services/master-catalog/catalogImport.service', () => ({ previewCatalogImport: jest.fn(), confirmCatalogImport: jest.fn() }))
jest.mock('@/services/master-catalog/catalogPublication.service', () => ({
  catalogPublicationService: { preview: jest.fn(), confirm: jest.fn() },
}))
jest.mock('@/services/master-catalog/masterCatalogRead.service', () => ({ resolveCatalogVenueContext: jest.fn() }))
jest.mock('@/services/master-catalog/catalogOverride.service', () => ({
  CATALOG_OVERRIDE_REQUEST_CAP: 25,
  previewCatalogOverrideRequest: jest.fn(),
  confirmCatalogOverrideRequest: jest.fn(),
}))

import { authorizeCatalogRequest } from '@/services/master-catalog/catalogAuthorization.service'
import { registerMasterCatalogTools } from '@/mcp/tools/masterCatalog'
import { confirmCatalogOverrideRequest, previewCatalogOverrideRequest } from '@/services/master-catalog/catalogOverride.service'
import { catalogPublicationService } from '@/services/master-catalog/catalogPublication.service'
import { resolveCatalogVenueContext } from '@/services/master-catalog/masterCatalogRead.service'

function scope(scopes?: string[]): McpScope {
  return {
    staffId: 'staff-owner',
    activeOrg: 'org-pits',
    organizationId: 'org-pits',
    orgRole: 'OWNER',
    allowedVenueIds: ['venue-pits'],
    perVenueAccess: new Map(),
    scopes,
  }
}

describe('H1A master-catalog MCP write scope', () => {
  const previousFlag = process.env.MCP_ENFORCE_WRITE_SCOPE

  afterEach(() => {
    if (previousFlag === undefined) delete process.env.MCP_ENFORCE_WRITE_SCOPE
    else process.env.MCP_ENFORCE_WRITE_SCOPE = previousFlag
  })

  it.each([undefined, [], ['mcp:read']])('rejects %p without mcp:write even when legacy enforcement is off', granted => {
    delete process.env.MCP_ENFORCE_WRITE_SCOPE

    expect(() => requireCatalogWriteScope(scope(granted))).toThrow(ScopeError)
  })

  it('accepts a token that explicitly grants mcp:write', () => {
    expect(() => requireCatalogWriteScope(scope(['mcp:read', 'mcp:write']))).not.toThrow()
  })
})

describe('H1A venue catalog permission defaults', () => {
  it.each([StaffRole.OWNER, StaffRole.ADMIN, StaffRole.MANAGER, StaffRole.VIEWER])('%s can read local catalog state', role => {
    expect(DEFAULT_PERMISSIONS[role]).toContain('catalog-venue:read')
  })

  it.each([StaffRole.OWNER, StaffRole.ADMIN, StaffRole.MANAGER])('%s can request a local override', role => {
    expect(DEFAULT_PERMISSIONS[role]).toContain('catalog-venue:request-override')
  })

  it('does not grant override requests to VIEWER', () => {
    expect(DEFAULT_PERMISSIONS[StaffRole.VIEWER]).not.toContain('catalog-venue:request-override')
  })
})

describe('H1A exact MCP tool surface', () => {
  beforeEach(() => jest.clearAllMocks())

  it('lists exactly seven tools and enforces schemas through the real MCP protocol', async () => {
    const server = new McpServer({ name: 'catalog-test', version: '1.0.0' })
    const client = new Client({ name: 'catalog-client-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    registerMasterCatalogTools(server, scope(['mcp:read', 'mcp:write']))
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const listed = await client.listTools()
    expect(listed.tools.map(tool => tool.name)).toEqual([
      'list_catalog_items',
      'get_catalog_item',
      'preview_catalog_import',
      'confirm_catalog_import',
      'preview_catalog_publication',
      'confirm_catalog_publication',
      'request_catalog_override',
    ])
    const invalid = await client.callTool({ name: 'confirm_catalog_publication', arguments: {} })
    expect(invalid.isError).toBe(true)
    await client.close()
    await server.close()
  })

  it('keeps publication and override bulk boundaries aligned with the shared services', async () => {
    const server = new McpServer({ name: 'catalog-bulk-test', version: '1.0.0' })
    const client = new Client({ name: 'catalog-bulk-client-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    ;(authorizeCatalogRequest as jest.Mock).mockResolvedValue({
      organizationId: 'org-pits',
      actor: { type: 'HUMAN', staffId: 'staff-owner', impersonating: false },
      orgRole: 'OWNER',
    })
    ;(resolveCatalogVenueContext as jest.Mock).mockResolvedValue({
      organizationId: 'org-pits',
      venueId: 'venue-pits',
      actor: { type: 'HUMAN', staffId: 'staff-owner', impersonating: false },
      orgRole: 'OWNER',
    })
    ;(catalogPublicationService.preview as jest.Mock).mockResolvedValue({ publicationBatchId: 'publication-1' })
    ;(previewCatalogOverrideRequest as jest.Mock).mockResolvedValue({ requestBatchId: 'request-1' })
    registerMasterCatalogTools(server, scope(['mcp:read', 'mcp:write']))
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const publicationAtLimit = await client.callTool({
      name: 'preview_catalog_publication',
      arguments: {
        operation: 'CATALOG_FIELDS_PUBLISH',
        idempotencyKey: 'publication-at-limit',
        targets: Array.from({ length: 10_000 }, () => ({})),
      },
    })
    expect(publicationAtLimit.isError).not.toBe(true)
    expect(catalogPublicationService.preview).toHaveBeenCalledTimes(1)

    const publicationOverLimit = await client.callTool({
      name: 'preview_catalog_publication',
      arguments: {
        operation: 'CATALOG_FIELDS_PUBLISH',
        idempotencyKey: 'publication-over-limit',
        targets: Array.from({ length: 10_001 }, () => ({})),
      },
    })
    expect(publicationOverLimit.isError).toBe(true)
    expect(catalogPublicationService.preview).toHaveBeenCalledTimes(1)

    const overrideRequest = { field: 'name', reason: 'Corrección local' }
    const overrideAtLimit = await client.callTool({
      name: 'request_catalog_override',
      arguments: {
        phase: 'PREVIEW',
        venueId: 'venue-pits',
        bindingId: 'binding-1',
        idempotencyKey: 'override-at-limit',
        requests: Array.from({ length: 25 }, () => overrideRequest),
      },
    })
    expect(overrideAtLimit.isError).not.toBe(true)
    expect(previewCatalogOverrideRequest).toHaveBeenCalledTimes(1)

    const overrideOverLimit = await client.callTool({
      name: 'request_catalog_override',
      arguments: {
        phase: 'PREVIEW',
        venueId: 'venue-pits',
        bindingId: 'binding-1',
        idempotencyKey: 'override-over-limit',
        requests: Array.from({ length: 26 }, () => overrideRequest),
      },
    })
    expect(overrideOverLimit.isError).toBe(true)
    expect(previewCatalogOverrideRequest).toHaveBeenCalledTimes(1)

    await client.close()
    await server.close()
  })

  it('uses the shared publication idempotency byte boundary for preview and confirm', async () => {
    const server = new McpServer({ name: 'catalog-key-test', version: '1.0.0' })
    const client = new Client({ name: 'catalog-key-client-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    ;(authorizeCatalogRequest as jest.Mock).mockResolvedValue({
      organizationId: 'org-pits',
      actor: { type: 'HUMAN', staffId: 'staff-owner', impersonating: false },
      orgRole: 'OWNER',
    })
    ;(catalogPublicationService.preview as jest.Mock).mockResolvedValue({ publicationBatchId: 'publication-1' })
    ;(catalogPublicationService.confirm as jest.Mock).mockResolvedValue({ publicationBatchId: 'publication-1' })
    registerMasterCatalogTools(server, scope(['mcp:read', 'mcp:write']))
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    for (const idempotencyKey of ['k'.repeat(256), 'é'.repeat(128)]) {
      const result = await client.callTool({
        name: 'preview_catalog_publication',
        arguments: { operation: 'CATALOG_FIELDS_PUBLISH', idempotencyKey, targets: [{}] },
      })
      expect(result.isError).not.toBe(true)
    }
    for (const idempotencyKey of ['k'.repeat(257), 'é'.repeat(129)]) {
      const result = await client.callTool({
        name: 'preview_catalog_publication',
        arguments: { operation: 'CATALOG_FIELDS_PUBLISH', idempotencyKey, targets: [{}] },
      })
      expect(result.isError).toBe(true)
    }
    expect(catalogPublicationService.preview).toHaveBeenCalledTimes(2)

    for (const idempotencyKey of ['k'.repeat(256), 'é'.repeat(128)]) {
      const result = await client.callTool({
        name: 'confirm_catalog_publication',
        arguments: { publicationBatchId: 'publication-1', previewToken: 'token-1', idempotencyKey, confirm: true },
      })
      expect(result.isError).not.toBe(true)
    }
    for (const idempotencyKey of ['k'.repeat(257), 'é'.repeat(129)]) {
      const result = await client.callTool({
        name: 'confirm_catalog_publication',
        arguments: { publicationBatchId: 'publication-1', previewToken: 'token-1', idempotencyKey, confirm: true },
      })
      expect(result.isError).toBe(true)
    }
    expect(catalogPublicationService.confirm).toHaveBeenCalledTimes(2)

    await client.close()
    await server.close()
  })

  it('rechecks live organization authorization on every call', async () => {
    const handlers = new Map<string, (input: any) => Promise<unknown>>()
    const fake = { tool: (name: string, _description: string, _schema: unknown, handler: any) => handlers.set(name, handler) } as never
    ;(authorizeCatalogRequest as jest.Mock).mockResolvedValue({
      organizationId: 'org-pits',
      actor: { type: 'HUMAN', staffId: 'staff-owner', impersonating: false },
      orgRole: 'OWNER',
    })
    registerMasterCatalogTools(fake, scope(['mcp:read', 'mcp:write']))

    await handlers.get('list_catalog_items')!({})
    await handlers.get('get_catalog_item')!({ catalogItemId: 'item-1' })

    expect(authorizeCatalogRequest).toHaveBeenCalledTimes(2)
    expect(authorizeCatalogRequest).toHaveBeenCalledWith(
      expect.objectContaining({ routeOrganizationId: 'org-pits', requiredGate: 'CORE', capability: 'READ' }),
    )
  })

  it('blocks catalog writes before service invocation when mcp:write is absent', async () => {
    const handlers = new Map<string, (input: any) => Promise<unknown>>()
    const fake = { tool: (name: string, _description: string, _schema: unknown, handler: any) => handlers.set(name, handler) } as never
    registerMasterCatalogTools(fake, scope(['mcp:read']))

    await expect(handlers.get('confirm_catalog_publication')!({})).rejects.toBeInstanceOf(ScopeError)
    expect(authorizeCatalogRequest).not.toHaveBeenCalled()
  })

  it('routes explicit override PREVIEW and CONFIRM phases to the matching shared service', async () => {
    const handlers = new Map<string, (input: any) => Promise<unknown>>()
    const fake = { tool: (name: string, _description: string, _schema: unknown, handler: any) => handlers.set(name, handler) } as never
    const context = {
      organizationId: 'org-pits',
      actor: { type: 'HUMAN', staffId: 'staff-owner', impersonating: false },
      orgRole: 'OWNER',
    }
    ;(authorizeCatalogRequest as jest.Mock).mockResolvedValue(context)
    ;(resolveCatalogVenueContext as jest.Mock).mockResolvedValue({ ...context, venueId: 'venue-pits' })
    registerMasterCatalogTools(fake, scope(['mcp:write']))
    const invoke = handlers.get('request_catalog_override')!

    await invoke({
      phase: 'PREVIEW',
      venueId: 'venue-pits',
      bindingId: 'binding-1',
      idempotencyKey: 'key-1',
      requests: [{ field: 'name', reason: 'Corrección local' }],
    })
    expect(previewCatalogOverrideRequest).toHaveBeenCalledTimes(1)
    expect(confirmCatalogOverrideRequest).not.toHaveBeenCalled()
    expect(authorizeCatalogRequest).toHaveBeenLastCalledWith(expect.objectContaining({ capability: 'READ' }))

    await invoke({
      phase: 'CONFIRM',
      venueId: 'venue-pits',
      requestBatchId: 'request-1',
      previewToken: 'token-1',
      idempotencyKey: 'key-1',
      confirm: true,
    })
    expect(confirmCatalogOverrideRequest).toHaveBeenCalledWith(expect.objectContaining({ venueId: 'venue-pits' }), {
      requestBatchId: 'request-1',
      previewToken: 'token-1',
      idempotencyKey: 'key-1',
      confirm: true,
    })
  })
})
