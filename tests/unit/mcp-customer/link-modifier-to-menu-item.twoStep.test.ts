/**
 * `link_modifier_to_menu_item` atravesando el catálogo REAL (Codex r2 #4, encargo 27771e): la confirmación habitual —los
 * `confirmationArguments` y el token de la vista previa— tiene que poder aplicarse, atando el extra y el platillo que se VIERON.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { configureToolCatalog } from '@/mcp/catalog'
import type { McpScope } from '@/mcp/scope'
import { registerMenuTools } from '@/mcp/tools/menu'

const mockUpdateModifier = jest.fn()
const modifierFindMany = jest.fn()
const productFindMany = jest.fn()
jest.mock('@/services/dashboard/menu.dashboard.service', () => ({
  createMenuCategory: jest.fn(),
  createModifierGroup: jest.fn(),
  updateModifier: (...a: unknown[]) => mockUpdateModifier(...a),
  LIGA_DE_EXTRA_PLAN: { feature: 'ADVANCED_REPORTS', plan: 'Pro' },
}))
jest.mock('@/services/dashboard/product.dashboard.service', () => ({
  updateProduct: jest.fn(),
  createProduct: jest.fn(),
  getProduct: jest.fn(),
}))
jest.mock('@/mcp/planGate', () => ({ planGateMessage: jest.fn().mockResolvedValue(null) }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    product: { findMany: (...a: unknown[]) => productFindMany(...a), findFirst: jest.fn() },
    modifier: { findMany: (...a: unknown[]) => modifierFindMany(...a) },
    menuCategory: { findMany: jest.fn(), findFirst: jest.fn() },
  },
}))
jest.mock('@/services/access/access.service', () => ({
  hasPermission: (access: { corePermissions: string[] }, permission: string) => access.corePermissions.includes(permission),
}))

const venueId = 'cm12345678901234567890123'
const scope: McpScope = {
  staffId: 'cm32345678901234567890123',
  activeOrg: 'cm42345678901234567890123',
  scopes: ['mcp:read', 'mcp:write'],
  allowedVenueIds: [venueId],
  perVenueAccess: new Map([[venueId, { corePermissions: ['menu:read', 'menu:update'] } as never]]),
}

let server: McpServer
let client: Client
const call = async (a: Record<string, unknown>) => {
  const r = await client.callTool({ name: 'link_modifier_to_menu_item', arguments: a })
  return JSON.parse((r.content as Array<{ text: string }>)[0].text)
}

beforeEach(async () => {
  jest.clearAllMocks()
  modifierFindMany.mockResolvedValue([
    {
      id: 'mod-papas',
      name: 'Papas',
      groupId: 'g1',
      rawMaterialId: null,
      linkedProductId: null,
      group: { name: 'Acompañantes' },
      linkedProduct: null,
    },
  ])
  productFindMany.mockResolvedValue([{ id: 'p-papas', name: 'Papas a la francesa', active: true, price: 45, ivaTratamiento: 'IVA_16' }])
  mockUpdateModifier.mockResolvedValue({ id: 'mod-papas' })
  server = new McpServer({ name: 'menu', version: '1' })
  configureToolCatalog(server, scope)
  registerMenuTools(server, scope)
  client = new Client({ name: 'link-two-step', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
})
afterEach(async () => {
  await client.close()
  await server.close()
})

it('confirm:true sin token no escribe', async () => {
  expect(await call({ venueId, modifierName: 'Papas', menuItemName: 'Papas', confirm: true })).toMatchObject({ needsInput: true })
  expect(mockUpdateModifier).not.toHaveBeenCalled()
})

it('la vista previa trae los argumentos firmados (con el extra y el platillo vistos) y con ellos SÍ se liga', async () => {
  const preview = await call({ venueId, modifierName: 'Papas', menuItemName: 'Papas' })
  expect(preview).toMatchObject({ requiresConfirmation: true, confirmationToken: expect.any(String) })
  expect(preview.confirmationArguments).toMatchObject({ resolvedModifierId: 'mod-papas', resolvedProductId: 'p-papas' })

  const r = await call({ ...preview.confirmationArguments, confirm: true, confirmationToken: preview.confirmationToken })
  expect(r).toMatchObject({ ok: true, deductsMenuItem: 'Papas a la francesa' })
  expect(mockUpdateModifier).toHaveBeenCalledWith(venueId, 'g1', 'mod-papas', { linkedProductId: 'p-papas' }, { linkedDeducts: false })
})

it('con otro platillo distinto al de la vista previa no escribe', async () => {
  const preview = await call({ venueId, modifierName: 'Papas', menuItemName: 'Papas' })
  const r = await call({
    ...preview.confirmationArguments,
    menuItemName: 'Aros',
    confirm: true,
    confirmationToken: preview.confirmationToken,
  })
  expect(r).toMatchObject({ needsInput: true })
  expect(mockUpdateModifier).not.toHaveBeenCalled()
})
