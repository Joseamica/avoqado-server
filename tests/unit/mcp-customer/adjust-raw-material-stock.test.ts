import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Decimal } from '@prisma/client/runtime/library'
import { configureToolCatalog } from '@/mcp/catalog'
import { registerInventoryTools } from '@/mcp/tools/inventory'
import type { McpScope } from '@/mcp/scope'

const mockFind = jest.fn()
const mockAdjust = jest.fn()
const mockPlan = jest.fn()
const mockAudit = jest.fn()
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { rawMaterial: { findFirst: (...a: unknown[]) => mockFind(...a) } },
}))
jest.mock('@/services/dashboard/rawMaterial.service', () => ({ adjustStock: (...a: unknown[]) => mockAdjust(...a) }))
jest.mock('@/services/dashboard/productInventory.service', () => ({ adjustInventoryStock: jest.fn() }))
jest.mock('@/services/serialized-inventory/serializedInventory.service', () => ({ serializedInventoryService: {} }))
jest.mock('@/services/access/access.service', () => ({
  hasPermission: (a: { corePermissions: string[] }, p: string) => a.corePermissions.includes(p),
}))
jest.mock('@/mcp/planGate', () => ({ planGateMessage: (...a: unknown[]) => mockPlan(...a) }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...a) }))

const tool = 'adjust_raw_material_stock'
const ingredient = { id: 'milk', name: 'Leche', unit: 'LITER', currentStock: new Decimal(0), costPerUnit: new Decimal(20) }
const args = { venueId: 'A', rawMaterialId: 'milk', delta: 82, unit: 'LITER', reason: 'Existencias iniciales verificadas' }

async function connected(scopes = ['mcp:read', 'mcp:write']) {
  const scope: McpScope = {
    staffId: 'daniel',
    activeOrg: 'org',
    scopes,
    allowedVenueIds: ['A', 'B'],
    perVenueAccess: new Map([
      ['A', { role: 'OWNER', corePermissions: ['inventory:read', 'inventory:adjust'] } as never],
      ['B', { role: 'CASHIER', corePermissions: ['inventory:read'] } as never],
    ]),
  }
  const server = new McpServer({ name: 'stock-test', version: '1' })
  configureToolCatalog(server, scope)
  registerInventoryTools(server, scope)
  const client = new Client({ name: 'test', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  return {
    client,
    call: async (input: Record<string, unknown>) => {
      const result = await client.callTool({ name: tool, arguments: input })
      return { result, data: (result.structuredContent as { data?: Record<string, any> } | undefined)?.data }
    },
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

let c: Awaited<ReturnType<typeof connected>>
beforeEach(async () => {
  jest.clearAllMocks()
  mockFind.mockResolvedValue(ingredient)
  mockPlan.mockResolvedValue(null)
  mockAdjust.mockResolvedValue({ ...ingredient, currentStock: new Decimal(82) })
  c = await connected()
})
afterEach(async () => c.close())

describe('adjust_raw_material_stock — stock and confirmation', () => {
  it('previsualiza el insumo, su unidad y el cambio sin escribir', async () => {
    const { result, data } = await c.call(args)
    expect(result.structuredContent).toMatchObject({ status: 'needs_input' })
    expect(data).toMatchObject({
      requiresConfirmation: true,
      change: { rawMaterialId: 'milk', ingredient: 'Leche', unit: 'LITER', from: 0, delta: 82, to: 82 },
    })
    expect(data?.confirmationToken).toEqual(expect.any(String))
    expect(mockFind).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'milk', venueId: 'A', active: true, deletedAt: null } }))
    expect(mockAdjust).not.toHaveBeenCalled()
  })

  it('confirma el delta con el servicio compartido y el actor, sin duplicar su auditoría', async () => {
    const { data } = await c.call(args)
    const confirmed = await c.call({ ...data?.confirmationArguments, confirm: true, confirmationToken: data?.confirmationToken })
    expect(confirmed.data).toMatchObject({ ok: true, newStock: 82, unit: 'LITER' })
    expect(mockAdjust).toHaveBeenCalledTimes(1)
    expect(mockAdjust).toHaveBeenCalledWith(
      'A',
      'milk',
      expect.objectContaining({ quantity: 82, type: 'ADJUSTMENT', reason: args.reason }),
      'daniel',
    )
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('no permite confirmar sin token ni cambiar la cantidad confirmada', async () => {
    expect((await c.call({ ...args, confirm: true })).data?.needsInput).toBe(true)
    const { data } = await c.call(args)
    expect((await c.call({ ...args, delta: 169, confirm: true, confirmationToken: data?.confirmationToken })).data?.needsInput).toBe(true)
    expect(mockAdjust).not.toHaveBeenCalled()
  })

  it('usa decimales exactos en el preview, incluso para un delta negativo', async () => {
    mockFind.mockResolvedValue({ ...ingredient, currentStock: new Decimal('0.3') })
    const { data } = await c.call({ ...args, delta: -0.1 })
    expect(data?.change).toMatchObject({ from: 0.3, delta: -0.1, to: 0.2 })
  })

  it.each([
    ['unidad incompatible', { unit: 'GRAM' }],
    ['unidad compatible pero diferente', { unit: 'MILLILITER' }],
    ['cantidad que se perdería al guardar', { delta: 0.0001 }],
    ['stock negativo', { delta: -1 }],
  ])('rechaza %s antes de confirmar', async (_label, over) => {
    const { data } = await c.call({ ...args, ...over })
    expect(data?.ok).toBe(false)
    expect(data?.requiresConfirmation).not.toBe(true)
    expect(mockAdjust).not.toHaveBeenCalled()
  })

  it('rechaza cantidades fuera del rango permitido', async () => {
    expect((await c.call({ ...args, delta: 1_000_000_000 })).result.isError).toBe(true)
    expect(mockFind).not.toHaveBeenCalled()
    expect(mockAdjust).not.toHaveBeenCalled()
  })

  it('un insumo inexistente no se sustituye por otro', async () => {
    mockFind.mockResolvedValue(null)
    expect((await c.call(args)).data).toMatchObject({ ok: false, needsInput: true })
    expect(mockAdjust).not.toHaveBeenCalled()
  })
})

describe('adjust_raw_material_stock — permission regressions', () => {
  it('ser OWNER en A no autoriza ajustar en B', async () => {
    expect((await c.call({ ...args, venueId: 'B' })).result.isError).toBe(true)
    expect(mockFind).not.toHaveBeenCalled()
    expect(mockPlan).not.toHaveBeenCalled()
    expect(mockAdjust).not.toHaveBeenCalled()
  })

  it('rechaza un venue ajeno antes de consultar datos', async () => {
    expect((await c.call({ ...args, venueId: 'foreign' })).result.isError).toBe(true)
    expect(mockFind).not.toHaveBeenCalled()
    expect(mockAdjust).not.toHaveBeenCalled()
  })

  it('requiere PREMIUM como el dashboard', async () => {
    mockPlan.mockResolvedValue('El control de inventario requiere PREMIUM')
    expect((await c.call(args)).data?.planRequired).toBe(true)
    expect(mockPlan).toHaveBeenCalledWith('A', 'INVENTORY_TRACKING', 'El control de inventario')
    expect(mockFind).not.toHaveBeenCalled()
    expect(mockAdjust).not.toHaveBeenCalled()
  })

  it('una conexión de lectura no descubre ni ejecuta el ajuste', async () => {
    await c.close()
    c = await connected(['mcp:read'])
    expect((await c.client.listTools()).tools.map(t => t.name)).not.toContain(tool)
    expect((await c.call(args)).result.isError).toBe(true)
    expect(mockFind).not.toHaveBeenCalled()
    expect(mockAdjust).not.toHaveBeenCalled()
  })
})
