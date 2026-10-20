import cuid from 'cuid'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpScope } from '@/mcp/scope'
import { TOOL_EFFECTS } from '@/mcp/catalog'
import { registerDocumentRequestTools } from '@/mcp/tools/documentRequests'
import * as requests from '@/services/document-requests/documentRequests.service'

jest.mock('@/services/document-requests/documentRequests.service', () => ({
  getPreviewUrl: jest.fn().mockResolvedValue({ url: 'signed', mimeType: 'application/pdf', fileName: 'Documento.pdf' }),
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

jest.mock('@/services/document-requests/venueLinks.service', () => ({
  listVenueDocumentRequests: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 }),
  listVenueOptions: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 }),
  listRequestVenueLinks: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 }),
  getVenueDocumentRequest: jest.fn().mockResolvedValue({ documents: [] }),
  getVenueDocumentPreview: jest.fn().mockResolvedValue({ url: 'signed', mimeType: 'image/png', fileName: 'Foto.png' }),
  getVenueDocumentDownload: jest.fn().mockResolvedValue({ url: 'signed' }),
  previewRequestVenueLink: jest.fn().mockResolvedValue({ businessName: 'Estudio', venue: { name: 'Centro', organizationName: 'Grupo' } }),
  linkRequestToVenue: jest.fn().mockResolvedValue({ created: true, link: { id: 'linked' } }),
}))
import * as venueLinks from '@/services/document-requests/venueLinks.service'
describe('venue document links MCP', () => {
  beforeEach(() => jest.clearAllMocks())
  test('all registered tools have an explicit protocol effect', () => {
    const { server } = setup()
    expect(server.tool.mock.calls.map(([name]) => name)).toContain('link_document_request_to_venue')
    for (const [name] of server.tool.mock.calls) expect(TOOL_EFFECTS[name as keyof typeof TOOL_EFFECTS]).toMatch(/^(read|write)$/)
    expect(TOOL_EFFECTS.link_document_request_to_venue).toBe('write')
  })
  test('preview requires confirmation and includes selected business and organization', async () => {
    const response: any = await setup().handlers.link_document_request_to_venue({
      id: 'request',
      venueId: 'venue',
      submissionVersion: 1,
      confirm: false,
    })
    const data = JSON.parse(response.content[0].text)
    expect(data.requiresConfirmation).toBe(true)
    expect(data.preview.venue.organizationName).toBe('Grupo')
    expect(venueLinks.linkRequestToVenue).not.toHaveBeenCalled()
  })
  test('confirmed write forwards explicit confirmation and actor to audited service', async () => {
    await setup().handlers.link_document_request_to_venue({ id: 'request', venueId: 'venue', submissionVersion: 1, confirm: true })
    expect(venueLinks.linkRequestToVenue).toHaveBeenCalledWith(
      'request',
      { venueId: 'venue', submissionVersion: 1, confirmed: true },
      'actor',
    )
  })
  test('new read and write recheck role and refuse a read-only superadmin write', async () => {
    const { handlers, scope } = setup()
    scope.isSuperAdmin = false
    await handlers.list_venue_document_requests({ venueId: 'venue', page: 1, pageSize: 10 })
    await handlers.link_document_request_to_venue({ id: 'request', venueId: 'venue', submissionVersion: 1, confirm: true })
    expect(venueLinks.listVenueDocumentRequests).not.toHaveBeenCalled()
    expect(venueLinks.linkRequestToVenue).not.toHaveBeenCalled()
    await expect(
      setup(true, ['mcp:read']).handlers.link_document_request_to_venue({
        id: 'request',
        venueId: 'venue',
        submissionVersion: 1,
        confirm: true,
      }),
    ).rejects.toThrow('solo lectura')
  })
})

describe('private preview MCP', () => {
  const requestId = cuid(),
    venueId = cuid(),
    linkId = cuid(),
    documentId = cuid()
  beforeEach(() => jest.clearAllMocks())
  test('read-only superadmin previews each exact scope and declares a read effect', async () => {
    const { handlers } = setup(true, ['mcp:read'])
    expect(TOOL_EFFECTS.preview_document_request_document).toBe('read')
    await handlers.preview_document_request_document({ target: { requestId, documentId } })
    expect(requests.getPreviewUrl).toHaveBeenCalledWith(requestId, documentId)
    await handlers.preview_document_request_document({ target: { venueId, linkId, documentId } })
    expect(venueLinks.getVenueDocumentPreview).toHaveBeenCalledWith(venueId, linkId, documentId)
  })
  test('registered schema rejects incomplete or mixed scopes, also when invoked directly', async () => {
    const { server, handlers } = setup()
    const registration = server.tool.mock.calls.find(([name]) => name === 'preview_document_request_document')!
    expect(registration).toBeDefined()
    const schema = z.object(registration[2])
    expect(schema.safeParse({ target: { requestId, documentId } }).success).toBe(true)
    expect(schema.safeParse({ target: { venueId, linkId, documentId } }).success).toBe(true)
    for (const target of [
      { documentId },
      { venueId, documentId },
      { linkId, documentId },
      { requestId, venueId, linkId, documentId },
      { requestId, linkId, documentId },
    ]) {
      expect(schema.safeParse({ target }).success).toBe(false)
      await expect(handlers.preview_document_request_document({ target })).rejects.toThrow()
    }
    expect(requests.getPreviewUrl).not.toHaveBeenCalled()
    expect(venueLinks.getVenueDocumentPreview).not.toHaveBeenCalled()
  })
  test('rechecks superadmin before either preview service', async () => {
    const { handlers, scope } = setup()
    scope.isSuperAdmin = false
    await handlers.preview_document_request_document({ target: { requestId, documentId } })
    await handlers.preview_document_request_document({ target: { venueId, linkId, documentId } })
    expect(requests.getPreviewUrl).not.toHaveBeenCalled()
    expect(venueLinks.getVenueDocumentPreview).not.toHaveBeenCalled()
  })
})
