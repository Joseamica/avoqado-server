import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { registerInventoryTools } from '../../../src/mcp/tools/inventory'
import type { McpScope } from '../../../src/mcp/scope'

jest.mock('@/mcp/planGate', () => ({ planGateMessage: jest.fn().mockResolvedValue(null) }))
jest.mock('@/mcp/guard', () => ({ createGuard: () => ({ venueFilter: jest.fn(), requirePermission: jest.fn() }) }))
jest.mock('@/services/serialized-inventory/serializedInventory.service', () => ({ serializedInventoryService: {} }))
jest.mock('@/services/dashboard/productInventory.service', () => ({ adjustInventoryStock: jest.fn() }))
jest.mock('@/services/dashboard/rawMaterial.service', () => ({ createRawMaterial: jest.fn() }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: {} }))

// El portal del directorio de Claude marca «Add a type to these parameters» cuando un parámetro sale como
// `{"$ref": "#/properties/otro"}`: pasa al reutilizar la MISMA instancia de Zod en dos campos de una herramienta.
it('cada parámetro de las herramientas de inventario declara su tipo, sin $ref a otro parámetro', async () => {
  const server = new McpServer({ name: 'inventory-schema', version: '1' })
  const client = new Client({ name: 'test', version: '1' })
  registerInventoryTools(server, { staffId: 's', activeOrg: 'o', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  try {
    const { tools } = await client.listTools()
    const sinTipo: string[] = []
    for (const t of tools) {
      for (const [k, v] of Object.entries((t.inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>)) {
        if ('$ref' in v || !(v.type || v.anyOf || v.enum)) sinTipo.push(`${t.name}.${k}`)
      }
    }
    expect(tools.map(t => t.name)).toEqual(expect.arrayContaining(['create_raw_material', 'update_raw_material']))
    expect(sinTipo).toEqual([])
  } finally {
    await client.close()
    await server.close()
  }
})
