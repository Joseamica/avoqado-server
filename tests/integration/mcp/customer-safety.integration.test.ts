import prisma from '@/utils/prismaClient'
import { createManualPayment } from '@/services/dashboard/manualPayment.service'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { registerInventoryTools } from '@/mcp/tools/inventory'
import type { McpScope } from '@/mcp/scope'
import { randomUUID } from 'crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { configureToolCatalog } from '@/mcp/catalog'
import { registerRecipeTools } from '@/mcp/tools/recipes'

const auditWrites: Promise<unknown>[] = []
jest.mock('@/services/dashboard/activity-log.service', () => {
  const actual = jest.requireActual('@/services/dashboard/activity-log.service')
  return {
    ...actual,
    logAction: (...args: unknown[]) => {
      const result = actual.logAction(...args)
      auditWrites.push(result)
      return result
    },
  }
})

// Only external effects / plan gating are replaced. Money, locks and inventory SQL use PostgreSQL.
jest.mock('@/mcp/planGate', () => ({ planGateMessage: jest.fn().mockResolvedValue(null) }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))
jest.setTimeout(60000)

let venueId: string
let staffId: string
let orgId: string
let foreignVenueId: string
beforeAll(async () => {
  const suffix = randomUUID()
  const org = await prisma.organization.create({
    data: { name: `FULLTEST-MCP-${suffix}`, email: `${suffix}@example.test`, phone: '0000000000', type: 'RESTAURANT' },
  })
  orgId = org.id
  const venue = await prisma.venue.create({
    data: {
      name: 'FULLTEST-Centro',
      slug: `fulltest-${suffix}`,
      organizationId: org.id,
      timezone: 'America/Mexico_City',
      currency: 'MXN',
      address: 'Ficticia 1',
      city: 'Pruebas',
      country: 'Mexico',
    },
  })
  venueId = venue.id
  foreignVenueId = (
    await prisma.venue.create({
      data: {
        name: 'FULLTEST-Fuera',
        slug: `fulltest-other-${suffix}`,
        organizationId: org.id,
        address: 'Ficticia 2',
        city: 'Pruebas',
        country: 'Mexico',
      },
    })
  ).id
  staffId = (
    await prisma.staff.create({
      data: { email: `${suffix}@example.test`, firstName: 'FULLTEST', lastName: 'MCP', venues: { create: { venueId, role: 'OWNER' } } },
    })
  ).id
})
// The runner creates and drops an ENTIRE isolated DB; never call broad shared teardown helpers here.
afterAll(async () => {
  await prisma.$disconnect()
})

it('dos cobros simultáneos con la misma intención dejan UN Payment/Order/asiento y recuperan el resultado', async () => {
  const input = { amount: '100.00', tipAmount: '0', method: 'BANK_TRANSFER' as const, source: 'POS' as const, idempotencyKey: randomUUID() }
  const results = await Promise.allSettled([createManualPayment(venueId, staffId, input), createManualPayment(venueId, staffId, input)])
  expect(results.every(r => r.status === 'fulfilled')).toBe(true)
  const replay = await createManualPayment(venueId, staffId, input)
  for (const result of results) if (result.status === 'fulfilled') expect(result.value.id).toBe(replay.id)
  expect(await prisma.payment.count({ where: { venueId, idempotencyKey: input.idempotencyKey } })).toBe(1)
  expect(await prisma.order.count({ where: { venueId } })).toBe(1)
  expect(await prisma.venueTransaction.count({ where: { paymentId: replay.id } })).toBe(1)
  expect(await prisma.paymentAllocation.count({ where: { paymentId: replay.id } })).toBe(1)
  await expect(createManualPayment(venueId, staffId, { ...input, amount: '101.00' })).rejects.toMatchObject({ statusCode: 409 })
})

it('dos reembolsos simultáneos con la misma intención descuentan una sola vez', async () => {
  const original = await createManualPayment(venueId, staffId, {
    amount: '200.00',
    tipAmount: '0',
    method: 'BANK_TRANSFER',
    source: 'POS',
    idempotencyKey: randomUUID(),
  })
  const input = { venueId, staffId, paymentId: original.id, amount: 5000, reason: 'RETURNED_GOODS' as const, idempotencyKey: randomUUID() }
  const [a, b] = await Promise.all([issueRefund(input), issueRefund(input)])
  expect(a).toEqual(b)
  expect(a).toMatchObject({ amount: 50, remainingRefundable: 150 })
  expect(await prisma.payment.count({ where: { venueId, idempotencyKey: input.idempotencyKey, type: 'REFUND' } })).toBe(1)
  expect(await issueRefund(input)).toEqual(a)
  await expect(issueRefund({ ...input, amount: 6000 })).rejects.toMatchObject({ statusCode: 409 })
  const row = await prisma.payment.findUniqueOrThrow({ where: { id: a.refundId } })
  expect(Number(row.amount)).toBe(-50)
})

it('las consultas SQL de inventario conservan total, redondeo, paginación y aislamiento', async () => {
  const category = await prisma.menuCategory.create({ data: { venueId, name: 'FULLTEST', slug: randomUUID() } })
  for (const [n, stock, cost, price] of [
    [1, 4, 100, 250],
    [2, 10, 12, 35],
    [3, 6, null, 5],
  ] as const) {
    await prisma.product.create({
      data: {
        venueId,
        categoryId: category.id,
        name: `FULLTEST-${n}`,
        sku: randomUUID(),
        price,
        cost,
        type: 'FOOD_AND_BEV',
        inventory: { create: { venueId, currentStock: stock, minimumStock: 20, lastRestockedAt: new Date('2026-09-30T18:00:00.000Z') } },
      },
    })
  }
  const otherCategory = await prisma.menuCategory.create({ data: { venueId: foreignVenueId, name: 'FULLTEST', slug: randomUUID() } })
  await prisma.product.create({
    data: {
      venueId: foreignVenueId,
      categoryId: otherCategory.id,
      name: 'FULLTEST-AJENO',
      sku: randomUUID(),
      price: 999999,
      cost: 99999,
      type: 'FOOD_AND_BEV',
      inventory: { create: { venueId: foreignVenueId, currentStock: 100, minimumStock: 200 } },
    },
  })
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<any>>()
  registerInventoryTools(
    { tool: (...a: any[]) => handlers.set(a[0], a.at(-1)) } as never,
    {
      staffId,
      activeOrg: orgId,
      allowedVenueIds: [venueId],
      scopes: ['mcp:read'],
      perVenueAccess: new Map([[venueId, { role: 'OWNER', corePermissions: ['*:*'], isSuperAdmin: false }]]),
    } as unknown as McpScope,
  )
  const call = async (name: string, args: Record<string, unknown>) =>
    JSON.parse((await handlers.get(name)!({ venueId, ...args })).content[0].text)
  expect(await call('stock_value', { limit: 1, offset: 1 })).toMatchObject({
    productsInStock: 3,
    totalCostValue: 520,
    totalRetailValue: 1380,
    potentialMargin: 860,
    count: 1,
    hasMore: true,
    nextOffset: 2,
    topItems: [{ product: 'FULLTEST-2' }],
  })
  expect(await call('stock_value', { limit: 1, offset: 100 })).toMatchObject({
    productsInStock: 3,
    totalCostValue: 520,
    count: 0,
    hasMore: false,
  })
  expect(await call('low_stock', { limit: 1 })).toMatchObject({
    total: 3,
    lowStock: [{ product: 'FULLTEST-1', shortBy: 16, lastRestockedAt: '2026-09-30T18:00:00.000Z' }],
    hasMore: true,
  })
})

it('el protocolo confirma existencias de un insumo, conserva FIFO y registra un solo ajuste con su actor', async () => {
  const ingredient = await prisma.rawMaterial.create({
    data: {
      venueId,
      name: 'FULLTEST-Leche',
      sku: randomUUID(),
      unit: 'LITER',
      unitType: 'VOLUME',
      currentStock: 0,
      minimumStock: 0,
      reorderPoint: 0,
      costPerUnit: 20,
      avgCostPerUnit: 20,
    },
  })
  const server = new McpServer({ name: 'fulltest-stock', version: '1' })
  const client = new Client({ name: 'fulltest', version: '1' })
  const scope = {
    staffId,
    activeOrg: orgId,
    allowedVenueIds: [venueId],
    scopes: ['mcp:read', 'mcp:write'],
    perVenueAccess: new Map([[venueId, { role: 'OWNER', corePermissions: ['*:*'] }]]),
  } as unknown as McpScope
  configureToolCatalog(server, scope)
  registerInventoryTools(server, scope)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  try {
    const preview = await client.callTool({
      name: 'adjust_raw_material_stock',
      arguments: { venueId, rawMaterialId: ingredient.id, delta: 82, unit: 'LITER', reason: 'FULLTEST conteo inicial' },
    })
    const data = (preview.structuredContent as { data: Record<string, any> }).data
    expect(data.requiresConfirmation).toBe(true)
    expect(Number((await prisma.rawMaterial.findUniqueOrThrow({ where: { id: ingredient.id } })).currentStock)).toBe(0)
    const result = await client.callTool({
      name: 'adjust_raw_material_stock',
      arguments: { ...data.confirmationArguments, confirm: true, confirmationToken: data.confirmationToken },
    })
    expect(result.structuredContent).toMatchObject({ status: 'success', data: { newStock: 82, unit: 'LITER' } })
    const updated = await prisma.rawMaterial.findUniqueOrThrow({ where: { id: ingredient.id } })
    expect(Number(updated.currentStock)).toBe(82)
    expect(
      Number(
        (await prisma.stockBatch.aggregate({ where: { venueId, rawMaterialId: ingredient.id }, _sum: { remainingQuantity: true } }))._sum
          .remainingQuantity,
      ),
    ).toBe(82)
    const movements = await prisma.rawMaterialMovement.findMany({ where: { venueId, rawMaterialId: ingredient.id }, take: 2 })
    expect(movements).toHaveLength(1)
    expect(movements[0]).toMatchObject({ type: 'ADJUSTMENT', createdBy: staffId, unit: 'LITER' })
    expect(Number(movements[0].previousStock)).toBe(0)
    expect(Number(movements[0].newStock)).toBe(82)
    await Promise.all(auditWrites)
    expect(await prisma.activityLog.count({ where: { venueId, entityId: ingredient.id, action: 'STOCK_ADJUSTED', staffId } })).toBe(1)
  } finally {
    await client.close()
    await server.close()
  }
})

it('el protocolo crea la receta confirmada completa con el costo previsto en PostgreSQL', async () => {
  const category = await prisma.menuCategory.create({ data: { venueId, name: 'FULLTEST-Recetas', slug: randomUUID() } })
  const product = await prisma.product.create({
    data: { venueId, categoryId: category.id, name: 'FULLTEST-Café con leche', sku: randomUUID(), price: 40, type: 'FOOD_AND_BEV' },
  })
  const ingredient = await prisma.rawMaterial.create({
    data: {
      venueId,
      name: 'FULLTEST-Leche para receta',
      sku: randomUUID(),
      unit: 'LITER',
      unitType: 'VOLUME',
      currentStock: 0,
      minimumStock: 0,
      reorderPoint: 0,
      costPerUnit: 20,
      avgCostPerUnit: 20,
    },
  })
  const server = new McpServer({ name: 'fulltest-recipe', version: '1' })
  const client = new Client({ name: 'fulltest', version: '1' })
  const scope = {
    staffId,
    activeOrg: orgId,
    allowedVenueIds: [venueId],
    scopes: ['mcp:read', 'mcp:write'],
    perVenueAccess: new Map([[venueId, { role: 'OWNER', corePermissions: ['*:*'] }]]),
  } as unknown as McpScope
  configureToolCatalog(server, scope)
  registerRecipeTools(server, scope)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  try {
    const preview = await client.callTool({
      name: 'create_recipe',
      arguments: { venueId, product: product.id, lines: [{ ingredient: ingredient.id, quantity: 0.25, unit: 'LITER' }] },
    })
    const data = (preview.structuredContent as { data: Record<string, any> }).data
    expect(data.confirmationToken).toEqual(expect.any(String))
    expect(data.receta.costoPorPorcion).toBe(5)
    expect(await prisma.recipe.count({ where: { productId: product.id } })).toBe(0)
    const result = await client.callTool({
      name: 'create_recipe',
      arguments: { ...data.confirmationArguments, confirm: true, confirmationToken: data.confirmationToken },
    })
    expect(result.structuredContent).toMatchObject({ status: 'success', data: { ok: true } })
    const saved = await prisma.recipe.findUniqueOrThrow({ where: { productId: product.id }, include: { lines: true } })
    expect(Number(saved.totalCost)).toBe(5)
    expect(saved.lines).toHaveLength(1)
    expect(saved.lines[0].rawMaterialId).toBe(ingredient.id)
  } finally {
    await client.close()
    await server.close()
  }
})
