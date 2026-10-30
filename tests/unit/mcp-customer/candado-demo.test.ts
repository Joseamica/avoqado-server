/**
 * Negocios demo (candado, capa 4): conectado a un negocio demo, el asistente sólo consulta. Si no, el MCP sería una
 * puerta trasera para lo que el panel y la app bloquean. Plan: Avoqado/docs/audit/2026-10-28-negocios-demo/plan.md.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { configureToolCatalog } from '@/mcp/catalog'
import { registerMenuTools } from '@/mcp/tools/menu'
import type { McpScope } from '@/mcp/scope'

const mockProducts = jest.fn()
const mockProductWrite = jest.fn()
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { product: { findMany: (...a: unknown[]) => mockProducts(...a) } },
}))
jest.mock('@/services/dashboard/product.dashboard.service', () => ({ updateProduct: (...a: unknown[]) => mockProductWrite(...a) }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))

const product = { id: 'product-A', name: 'Cafe', price: 30, active: true }

async function conectar(venueId: string) {
  const server = new McpServer({ name: 'demo', version: '1' })
  const scope = {
    staffId: 'owner',
    activeOrg: 'org',
    allowedVenueIds: [venueId],
    scopes: ['mcp:read', 'mcp:write'],
    perVenueAccess: new Map([[venueId, { role: 'OWNER', corePermissions: ['*:*'], isSuperAdmin: false }]]),
    // resolveScope la pone cuando todos los negocios de la conexión son LIVE_DEMO (scope.test.ts)
    ...(venueId.startsWith('demo') ? { soloNegociosDemo: true } : {}),
  } as unknown as McpScope
  configureToolCatalog(server, scope)
  registerMenuTools(server, scope)
  const client = new Client({ name: 'demo-test', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  return client
}

const textoDe = (r: any) => (r.content ?? []).map((c: any) => c.text ?? '').join(' ')

beforeEach(() => {
  jest.clearAllMocks()
  mockProducts.mockResolvedValue([product])
  mockProductWrite.mockResolvedValue({ ...product, price: 45 })
})

it('en un negocio demo, una herramienta que escribe se niega con su razón y no toca nada', async () => {
  const client = await conectar('demo-salon')
  const r: any = await client.callTool({ name: 'set_menu_item_price', arguments: { venueId: 'demo-salon', name: 'Cafe', price: 45 } })
  expect(r.isError).toBe(true)
  expect(textoDe(r)).toMatch(/sólo puede consultar/)
  expect(mockProductWrite).not.toHaveBeenCalled()
})

it('en un negocio demo, leer sigue funcionando', async () => {
  const client = await conectar('demo-salon')
  const r: any = await client.callTool({ name: 'list_menu', arguments: {} })
  expect(textoDe(r)).not.toMatch(/sólo puede consultar/)
})

it('regresión: en un negocio real el candado no se mete (la herramienta llega a su propia lógica)', async () => {
  const client = await conectar('centro')
  const r: any = await client.callTool({ name: 'set_menu_item_price', arguments: { venueId: 'centro', name: 'Cafe', price: 45 } })
  expect(textoDe(r)).not.toMatch(/sólo puede consultar/)
})
