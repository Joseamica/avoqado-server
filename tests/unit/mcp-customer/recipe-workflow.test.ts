import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Decimal } from '@prisma/client/runtime/library'
import { configureToolCatalog } from '@/mcp/catalog'
import { registerRecipeTools } from '@/mcp/tools/recipes'
import { registerInventoryTools } from '@/mcp/tools/inventory'
import { registerProcurementTools } from '@/mcp/tools/procurement'
import type { McpScope } from '@/mcp/scope'

const mockProductFind = jest.fn(),
  mockProductList = jest.fn(),
  mockProductCount = jest.fn()
const mockIngredientFind = jest.fn(),
  mockIngredientList = jest.fn(),
  mockIngredientCount = jest.fn()
const mockRecipe = jest.fn(),
  mockEnable = jest.fn(),
  mockUpdate = jest.fn()
const mockSuppliers = jest.fn(),
  mockSupplierFind = jest.fn(),
  mockCreateSupplier = jest.fn(),
  mockPlan = jest.fn()
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    product: {
      findFirst: (...a: unknown[]) => mockProductFind(...a),
      findMany: (...a: unknown[]) => mockProductList(...a),
      count: (...a: unknown[]) => mockProductCount(...a),
    },
    rawMaterial: {
      findFirst: (...a: unknown[]) => mockIngredientFind(...a),
      findMany: (...a: unknown[]) => mockIngredientList(...a),
      count: (...a: unknown[]) => mockIngredientCount(...a),
    },
    supplier: { findFirst: (...a: unknown[]) => mockSupplierFind(...a) },
  },
}))
jest.mock('@/services/dashboard/recipe.service', () => ({ getRecipe: (...a: unknown[]) => mockRecipe(...a), createRecipe: jest.fn() }))
jest.mock('@/services/dashboard/productInventoryIntegration.service', () => ({
  recipeInventoryFingerprint: () => 'recipe-fingerprint',
  setProductInventoryMethod: (...a: unknown[]) => mockEnable(...a),
}))
jest.mock('@/services/dashboard/rawMaterial.service', () => ({
  updateRawMaterial: (...a: unknown[]) => mockUpdate(...a),
  adjustStock: jest.fn(),
  createRawMaterial: jest.fn(),
}))
jest.mock('@/services/dashboard/productInventory.service', () => ({ adjustInventoryStock: jest.fn() }))
jest.mock('@/services/serialized-inventory/serializedInventory.service', () => ({ serializedInventoryService: {} }))
jest.mock('@/services/dashboard/supplier.service', () => ({
  getSuppliersPage: (...a: unknown[]) => mockSuppliers(...a),
  createSupplier: (...a: unknown[]) => mockCreateSupplier(...a),
}))
jest.mock('@/services/access/access.service', () => ({
  hasPermission: (a: { corePermissions: string[] }, p: string) => a.corePermissions.includes(p),
}))
jest.mock('@/mcp/planGate', () => ({ planGateMessage: (...a: unknown[]) => mockPlan(...a) }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))

const updatedAt = new Date('2026-09-01T00:00:00Z')
const product = {
  id: 'coffee',
  name: 'Café',
  price: new Decimal(40),
  cost: null,
  trackInventory: false,
  inventoryMethod: null,
  updatedAt,
  recipe: { id: 'recipe', totalCost: new Decimal(5), portionYield: 1, _count: { lines: 1 } },
}
const ingredient = {
  id: 'milk',
  name: 'Leche',
  unit: 'LITER',
  sku: 'MILK',
  costPerUnit: new Decimal(20),
  minimumStock: new Decimal(1),
  reorderPoint: new Decimal(2),
  maximumStock: null,
  updatedAt,
}

async function connected(scopes = ['mcp:read', 'mcp:write']) {
  const scope = {
    staffId: 'daniel',
    activeOrg: 'org',
    scopes,
    allowedVenueIds: ['A', 'B'],
    perVenueAccess: new Map([
      ['A', { role: 'OWNER', corePermissions: ['inventory:read', 'inventory:create', 'inventory:update'] }],
      ['B', { role: 'CASHIER', corePermissions: ['inventory:read'] }],
    ]),
  } as unknown as McpScope
  const server = new McpServer({ name: 'workflow-test', version: '1' })
  configureToolCatalog(server, scope)
  registerRecipeTools(server, scope)
  registerInventoryTools(server, scope)
  registerProcurementTools(server, scope)
  const client = new Client({ name: 'test', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  return {
    client,
    call: async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args })
      return { result, data: (result.structuredContent as { data?: Record<string, any> })?.data }
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
  mockPlan.mockResolvedValue(null)
  mockProductFind.mockResolvedValue(product)
  mockProductList.mockResolvedValue([product])
  mockProductCount.mockResolvedValue(151)
  mockIngredientFind.mockResolvedValue(ingredient)
  mockIngredientList.mockResolvedValue([ingredient])
  mockIngredientCount.mockResolvedValue(151)
  mockSupplierFind.mockResolvedValue(null)
  mockSuppliers.mockResolvedValue({ rows: [{ id: 'supplier', name: 'Proveedor' }], total: 151, limit: 50, offset: 0 })
  mockRecipe.mockResolvedValue({
    id: 'recipe',
    product: { ...product, venueId: 'A' },
    totalCost: new Decimal(5),
    portionYield: 1,
    lines: [],
  })
  mockEnable.mockResolvedValue({ success: true, inventoryMethod: 'RECIPE' })
  mockUpdate.mockResolvedValue({ ...ingredient, name: 'Leche entera', costPerUnit: new Decimal(22) })
  mockCreateSupplier.mockResolvedValue({ id: 'supplier', name: 'Proveedor' })
  c = await connected()
})
afterEach(async () => c.close())

it('una receta existente con costo manual null conserva su costo real y muestra el descuento desactivado', async () => {
  const { data } = await c.call('list_product_recipes', { venueId: 'A', limit: 1, offset: 1 })
  expect(data).toMatchObject({
    total: 151,
    count: 1,
    hasMore: true,
    nextOffset: 2,
    products: [{ id: 'coffee', manualCost: null, recipeCostPerPortion: 5, hasRecipe: true, inventoryTrackingEnabled: false }],
  })
  expect(mockProductList).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ venueId: 'A', deletedAt: null }),
      take: 1,
      skip: 1,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    }),
  )
})
it('filtra los productos sin receta antes de paginar', async () => {
  await c.call('list_product_recipes', { venueId: 'A', hasRecipe: false, search: 'Café' })
  expect(mockProductCount).toHaveBeenCalledWith({
    where: expect.objectContaining({ venueId: 'A', recipe: { is: null }, name: { contains: 'Café', mode: 'insensitive' } }),
  })
})
it('get_recipe distingue una receta del descuento automático', async () => {
  expect((await c.call('get_recipe', { venueId: 'A', product: 'coffee' })).data).toMatchObject({
    inventoryTrackingEnabled: false,
    recipeDeductionEnabled: false,
    receta: { costoPorPorcion: 5 },
  })
})
it('el listado de insumos permite continuar y devuelve el total real con orden estable', async () => {
  const { data } = await c.call('list_raw_materials', { venueId: 'A', search: 'Leche', limit: 1, offset: 1 })
  expect(data).toMatchObject({ total: 151, count: 1, hasMore: true, nextOffset: 2 })
  expect(mockIngredientList).toHaveBeenCalledWith(expect.objectContaining({ take: 1, skip: 1, orderBy: [{ name: 'asc' }, { id: 'asc' }] }))
  expect(mockIngredientCount).toHaveBeenCalledWith({
    where: expect.objectContaining({ venueId: 'A', name: { contains: 'Leche', mode: 'insensitive' } }),
  })
})
it('el tope de insumos se impone en el servidor conservando la compatibilidad del límite anterior', async () => {
  await c.call('list_raw_materials', { venueId: 'A', limit: 200 })
  expect(mockIngredientList).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }))
  expect((await c.call('list_raw_materials', { venueId: 'A', limit: 201 })).result.isError).toBe(true)
})

it('el alta inicial rechaza cantidades y costos que se redondearían al guardarse', async () => {
  const args = {
    venueId: 'A',
    name: 'Leche nueva',
    category: 'DAIRY',
    unit: 'LITER',
    currentStock: 82,
    minimumStock: 1,
    reorderPoint: 2,
    costPerUnit: 20,
  }
  for (const extra of [{ currentStock: 0.0001 }, { minimumStock: 0.0001 }, { costPerUnit: 0.00001 }, { costPerUnit: 1000000 }]) {
    expect((await c.call('create_raw_material', { ...args, ...extra })).result.isError).toBe(true)
  }
  expect(mockIngredientFind).not.toHaveBeenCalled()
})
it('el listado de proveedores usa una página acotada con filtros y continuidad', async () => {
  const { data } = await c.call('list_suppliers', { venueId: 'A', search: 'Prov', offset: 50 })
  expect(data).toMatchObject({ total: 151, count: 1, hasMore: true, nextOffset: 51 })
  expect(mockSuppliers).toHaveBeenCalledWith('A', { active: true, search: 'Prov' }, { limit: 50, offset: 50 })
})

const writes = [
  ['enable_recipe_inventory', { venueId: 'A', productId: 'coffee' }, mockEnable],
  ['update_raw_material', { venueId: 'A', rawMaterialId: 'milk', name: 'Leche entera', costPerUnit: 22 }, mockUpdate],
  ['create_supplier', { venueId: 'A', name: 'Proveedor' }, mockCreateSupplier],
] as const
it.each(writes)('%s requiere preview y token, escribe una vez y atribuye el actor', async (name, args, service) => {
  expect((await c.call(name, { ...args, confirm: true })).data?.needsInput).toBe(true)
  const { data } = await c.call(name, args)
  expect(data).toMatchObject({ requiresConfirmation: true })
  expect(service).not.toHaveBeenCalled()
  expect(
    (await c.call(name, { ...data?.confirmationArguments, venueId: 'B', confirm: true, confirmationToken: data?.confirmationToken })).data
      ?.needsInput,
  ).toBe(true)
  expect((await c.call(name, { ...data?.confirmationArguments, confirm: true, confirmationToken: data?.confirmationToken })).data?.ok).toBe(
    true,
  )
  expect(service).toHaveBeenCalledTimes(1)
  expect(service.mock.calls[0]).toEqual(
    expect.arrayContaining(['A', name === 'update_raw_material' ? 'daniel' : expect.objectContaining({ staffId: 'daniel' })]),
  )
})
it.each(writes)('%s nunca hereda el rol de otra sucursal', async (name, args, service) => {
  const { result } = await c.call(name, { ...args, venueId: 'B' })
  expect(result.isError).toBe(true)
  expect(service).not.toHaveBeenCalled()
  expect(mockPlan).not.toHaveBeenCalled()
})
it.each(writes)('%s conserva el candado PREMIUM', async (name, args, service) => {
  mockPlan.mockResolvedValue('Requiere PREMIUM')
  expect((await c.call(name, args)).data?.planRequired).toBe(true)
  expect(service).not.toHaveBeenCalled()
})
it('una conexión de lectura no descubre ni ejecuta las nuevas escrituras', async () => {
  const read = await connected(['mcp:read'])
  try {
    const names = (await read.client.listTools()).tools.map(t => t.name)
    for (const [name, args, service] of writes) {
      expect(names).not.toContain(name)
      expect((await read.call(name, args)).result.isError).toBe(true)
      expect(service).not.toHaveBeenCalled()
    }
  } finally {
    await read.close()
  }
})

it('las anotaciones distinguen lectura de escritura y los previews atan la versión del registro', async () => {
  const tools = (await c.client.listTools()).tools
  for (const [name, args] of writes) {
    expect(tools.find(t => t.name === name)?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    })
    const { data } = await c.call(name, args)
    if (name === 'enable_recipe_inventory') expect(data?.confirmationArguments.expectedSourceFingerprint).toBe('recipe-fingerprint')
    if (name === 'update_raw_material') expect(data?.confirmationArguments.expectedUpdatedAt).toBe(updatedAt.toISOString())
  }
  expect(tools.find(t => t.name === 'list_product_recipes')?.annotations?.readOnlyHint).toBe(true)
})

it.each(['list_raw_materials', 'list_product_recipes', 'list_suppliers'])(
  '%s rechaza un venue ajeno antes de consultar datos',
  async name => {
    expect((await c.call(name, { venueId: 'foreign' })).result.isError).toBe(true)
    expect(mockProductList).not.toHaveBeenCalled()
    expect(mockIngredientList).not.toHaveBeenCalled()
    expect(mockSuppliers).not.toHaveBeenCalled()
  },
)

it('una activación ya vigente es un no-op sin nueva auditoría ni escritura', async () => {
  mockProductFind.mockResolvedValue({ ...product, trackInventory: true, inventoryMethod: 'RECIPE' })
  expect((await c.call('enable_recipe_inventory', { venueId: 'A', productId: 'coffee' })).data).toMatchObject({ ok: true, changed: false })
  expect(mockEnable).not.toHaveBeenCalled()
})
it('no activa inventario sin una receta con ingredientes', async () => {
  mockProductFind.mockResolvedValue({ ...product, recipe: null })
  expect((await c.call('enable_recipe_inventory', { venueId: 'A', productId: 'coffee' })).data?.ok).toBe(false)
  expect(mockEnable).not.toHaveBeenCalled()
})
it('no usa update_raw_material para cambiar existencias ni unidades', async () => {
  expect(
    (await c.call('update_raw_material', { venueId: 'A', rawMaterialId: 'milk', currentStock: 82, unit: 'MILLILITER' })).data?.ok,
  ).toBe(false)
  expect(mockUpdate).not.toHaveBeenCalled()
})
it.each([{ costPerUnit: 0.00001 }, { minimumStock: 0.0001 }, { costPerUnit: 1000000 }, { minimumStock: 3 }])(
  'rechaza pérdida de precisión o umbrales inconsistentes: %j',
  async fields => {
    const { result, data } = await c.call('update_raw_material', { venueId: 'A', rawMaterialId: 'milk', ...fields })
    expect(result.isError || data?.ok === false).toBe(true)
    expect(mockUpdate).not.toHaveBeenCalled()
  },
)
it('un proveedor existente se identifica sin crearlo de nuevo', async () => {
  mockSupplierFind.mockResolvedValue({ id: 'existing', name: 'Proveedor', active: true, deletedAt: null })
  expect((await c.call('create_supplier', { venueId: 'A', name: 'Proveedor' })).data).toMatchObject({
    ok: false,
    existingSupplier: { id: 'existing' },
  })
  expect(mockCreateSupplier).not.toHaveBeenCalled()
})
