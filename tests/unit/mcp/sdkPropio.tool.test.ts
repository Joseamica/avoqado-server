/**
 * `set_terminal_in_house_sdk` (fase 3, bloque 2a): lo que no necesita base. Quién la VE (sólo un SUPERADMIN, por `server.ts` y el
 * protocolo real), que el handler vuelve a frenar a quien no es SUPERADMIN aunque la tenga registrada, y su efecto en el catálogo.
 * Lo que necesita Postgres (la serie bajo el candado, el 409, la elegibilidad) va en
 * `tests/integration/mcp/sdkPropio.integration.test.ts`.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { configureToolCatalog, TOOL_EFFECTS } from '@/mcp/catalog'
import { DIRECTORY_TOOLS } from '@/mcp/directory/catalog'
import { registerAllTools } from '@/mcp/server'
import type { McpScope } from '@/mcp/scope'
import { registerSdkPropioTools } from '@/mcp/tools/sdkPropio'
import { cambiarSdkPropioDeTerminal } from '@/services/superadmin/sdkPropioDeTerminal.service'

jest.mock('@/services/superadmin/sdkPropioDeTerminal.service', () => ({
  cambiarSdkPropioDeTerminal: jest.fn(),
  elegibilidadDelSdkPropio: jest.fn(),
}))

const NOMBRE = 'set_terminal_in_house_sdk'
const base = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map(), scopes: ['mcp:read', 'mcp:write'] }

/** El catálogo como lo arma `server.ts` (`registerAllTools`) detrás de `configureToolCatalog`, listado por el protocolo real. */
async function listar(scope: Partial<McpScope>): Promise<string[]> {
  const s = { ...base, ...scope } as McpScope
  const server = new McpServer({ name: 'sdk-propio', version: '1' })
  configureToolCatalog(server, s)
  registerAllTools(server, s, { serializedEnabled: true, whiteLabelEnabled: true, catalogEnabled: true })
  const client = new Client({ name: 'prueba', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  try {
    return (await client.listTools()).tools.map(t => t.name)
  } finally {
    await client.close()
    await server.close()
  }
}

describe('set_terminal_in_house_sdk', () => {
  it('tools/list de un SUPERADMIN incluye set_terminal_in_house_sdk', async () => {
    expect(await listar({ isSuperAdmin: true })).toContain(NOMBRE)
  })

  it('tools/list de un OWNER con mcp:write NO la incluye', async () => {
    const owner = {
      isSuperAdmin: false,
      perVenueAccess: new Map([['v1', { role: 'OWNER', corePermissions: ['*:*'], isSuperAdmin: false }]]),
    } as unknown as Partial<McpScope>
    const nombres = await listar(owner)
    expect(nombres.length).toBeGreaterThan(100) // sí listó el catálogo; sólo falta ésta
    expect(nombres).not.toContain(NOMBRE)
  })

  it('ejecutarla sin ser SUPERADMIN (registrada a mano en la prueba) ⇒ ok:false', async () => {
    const handlers: Record<string, (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>> = {}
    const server = { tool: (...a: unknown[]) => (handlers[a[0] as string] = a[a.length - 1] as never) } as unknown as McpServer
    registerSdkPropioTools(server, { ...base, isSuperAdmin: false } as McpScope)

    for (const confirm of [undefined, true]) {
      const out = JSON.parse(
        (await handlers[NOMBRE]({ terminalId: 't1', enabled: true, expectedSerialNumber: 'AVQD-9900000300', confirm })).content[0].text,
      )
      expect(out).toEqual({ ok: false, error: 'Sólo el equipo de Avoqado puede cambiar con qué motor cobra una terminal.' })
    }
    expect(cambiarSdkPropioDeTerminal).not.toHaveBeenCalled()
  })

  it('está en TOOL_EFFECTS como write', () => {
    expect(TOOL_EFFECTS[NOMBRE]).toBe('write')
    // Nace sólo en el MCP libre.
    expect(DIRECTORY_TOOLS.has(NOMBRE)).toBe(false)
  })
})
