jest.mock('@/services/support/access.service', () => ({
  resolveHelpAccess: jest.fn().mockResolvedValue({ permissions: [], features: {}, fingerprint: 'test' }),
}))
import fs from 'fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { configureToolCatalog, TOOL_EFFECTS } from '@/mcp/catalog'
import { registerAllTools } from '@/mcp/server'
import { DIRECTORY_TOOLS } from '@/mcp/directory/catalog'
import type { McpScope } from '@/mcp/scope'
import { readLibrarySources, SUPPORT_HELP_DIRECTORY, SUPPORT_MANUAL_DIRECTORY } from '@/services/support/libraryFiles'

async function connect(isSuperAdmin = false, directory = false) {
  const scope = {
    staffId: 'staff',
    activeOrg: 'org',
    allowedVenueIds: ['c1234567890123456789012345'],
    perVenueAccess: new Map(),
    scopes: ['mcp:read'],
    isSuperAdmin,
  } as McpScope
  const server = new McpServer({ name: 'support-read-test', version: '1' })
  configureToolCatalog(server, scope, directory ? 'directory' : 'manual')
  registerAllTools(server, scope, { serializedEnabled: false, whiteLabelEnabled: false, catalogEnabled: false })
  const client = new Client({ name: 'support-test', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  return {
    server,
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

it.each([false, true])('real read-only catalog includes public support help; SUPERADMIN=%s', async admin => {
  const c = await connect(admin)
  try {
    const tools = (await c.client.listTools()).tools
    expect(tools.some(t => t.name === 'avoqado_help_context')).toBe(true)
    expect(tools.some(t => t.name === 'avoqado_help')).toBe(true)
    expect(tools.some(t => t.name === 'avoqado_internal_docs')).toBe(admin)
    const result = await c.client.callTool({ name: 'avoqado_help_context', arguments: { topic: 'tema sin cobertura', app: 'android' } })
    expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toMatchObject({ kind: 'NO_COVERAGE', access: null })
    const denied = await c.client.callTool({
      name: 'avoqado_help_context',
      arguments: { topic: 'ayuda', app: 'dashboard', venueId: 'c9999999999999999999999999' },
    })
    expect(denied.isError || (denied.content as Array<{ text: string }>)[0].text.includes('scope')).toBeTruthy()
  } finally {
    await c.close()
  }
})

// T-F6 (Codex H3): each guide comes with its whole text, and the tool tells the client to give its steps only with it.
it('avoqado_help_context tells the client to keep the conditions and warnings of the whole guide', async () => {
  const c = await connect()
  try {
    const tool = (await c.client.listTools()).tools.find(t => t.name === 'avoqado_help_context')!
    expect(tool.description).toContain('Cada guía trae su texto completo (whole) con sus condiciones y advertencias')
  } finally {
    await c.close()
  }
})

it('stays out of the certified catalog and never needs write scope', async () => {
  expect(TOOL_EFFECTS.avoqado_help_context).toBe('read')
  expect(DIRECTORY_TOOLS.has('avoqado_help_context')).toBe(false)
  const c = await connect(false, true)
  try {
    expect((await c.client.listTools()).tools.some(t => t.name === 'avoqado_help_context')).toBe(false)
  } finally {
    await c.close()
  }
})

it('avoqado_help_context never returns a manual id', async () => {
  // El manual interno es sólo del asistente de WhatsApp: el MCP ni siquiera lee su carpeta.
  expect(fs.existsSync(SUPPORT_MANUAL_DIRECTORY)).toBe(true)
  const internals = readLibrarySources().filter(s => s.internal)
  const manualIds = new Set(internals.map(s => s.id))
  const queries = [
    ...internals.map(s => ({ topic: s.title, app: s.app })),
    { topic: 'abrir la caja', app: 'android' },
    { topic: 'cobrar con tarjeta', app: 'tpv' },
    { topic: 'cambiar de sucursal', app: 'dashboard' },
  ]
  const spies = (['readdirSync', 'readFileSync', 'existsSync', 'statSync'] as const).map(name => jest.spyOn(fs, name))
  const c = await connect()
  try {
    for (const query of queries) {
      const result = await c.client.callTool({ name: 'avoqado_help_context', arguments: query })
      const { sections } = JSON.parse((result.content as Array<{ text: string }>)[0].text) as { sections: { id: string }[] }
      expect(sections.filter(s => manualIds.has(s.id))).toEqual([])
    }
    const paths = spies.flatMap(spy => spy.mock.calls.map(call => String(call[0])))
    expect(paths.some(p => p.startsWith(SUPPORT_HELP_DIRECTORY))).toBe(true)
    expect(paths.filter(p => p.startsWith(SUPPORT_MANUAL_DIRECTORY))).toEqual([])
  } finally {
    for (const spy of spies) spy.mockRestore()
    await c.close()
  }
})
