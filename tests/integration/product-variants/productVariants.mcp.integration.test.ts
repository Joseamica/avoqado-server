/**
 * `product_variants` con rango de fechas contra Postgres REAL (Tarea 14): un `$queryRaw` mockeado devolvería lo que se le diga y no
 * probaría la ventana del negocio, los estados excluidos ni que el total de la familia cuadra al centavo con sus variantes y con lo
 * que `product_sales` (certificada, sin cambios) contesta para cada una.
 *
 * TEST_DATABASE_URL=… npx jest --selectProjects=integration --runInBand --runTestsByPath tests/integration/product-variants/productVariants.mcp.integration.test.ts
 * (correrla también con TZ=UTC, la zona del host de producción).
 */
import prisma from '@/utils/prismaClient'
import { createProductWithVariants } from '@/services/product-variants/productGroup.service'
import { registerProductVariantTools } from '@/mcp/tools/productVariants'
import { registerProductTools } from '@/mcp/tools/products'
import type { McpScope } from '@/mcp/scope'
import { crearNegocio, NegocioDePrueba } from './fixtures'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))
jest.mock('@/mcp/planGate', () => ({ planGateMessage: jest.fn().mockResolvedValue(null) }))

// 11-mar-2025 en Ciudad de México = 06:00Z del 11 a 05:59:59.999Z del 12.
const DAY = new Date('2025-03-11T18:00:00.000Z')
const LAST_LOCAL_SECOND = new Date('2025-03-12T05:59:59.000Z') // 23:59:59 del 11 en el negocio: cuenta
const NEXT_LOCAL_DAY = new Date('2025-03-12T06:00:00.000Z') // 00:00 del 12 en el negocio: no cuenta
const cents = (n: number): number => Math.round(n * 100)

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }> }>

describe('product_variants: ventas por variante y total de la familia', () => {
  let n: NegocioDePrueba
  let tallaS: string
  let tallaM: string
  let tallaXS: string
  const handlers = new Map<string, Handler>()
  const call = async (name: string, args: Record<string, unknown>) => JSON.parse((await handlers.get(name)!(args, {})).content[0].text)

  beforeAll(async () => {
    n = await crearNegocio('mcp-variantes')
    const scope = {
      staffId: n.staffId,
      activeOrg: n.organizationId,
      allowedVenueIds: [n.venueId],
      scopes: ['mcp:read', 'mcp:write'],
      perVenueAccess: new Map([[n.venueId, { role: 'OWNER', corePermissions: ['*:*'], isSuperAdmin: false }]]),
    } as unknown as McpScope
    const reg = { tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as Handler) } as never
    registerProductVariantTools(reg, scope)
    registerProductTools(reg, scope)

    const familia = await createProductWithVariants(
      n.venueId,
      {
        name: 'Playera',
        categoryId: n.categoryId,
        options: [{ name: 'Talla', values: ['S', 'M', 'XS'] }],
        variants: [
          { values: ['S'], price: 299.1 },
          { values: ['M'], price: 329.45 },
          { values: ['XS'], price: 199.99 },
        ],
      },
      n.actor,
    )
    ;[tallaS, tallaM, tallaXS] = familia.productIds
    const gorra = await prisma.product.create({
      data: { venueId: n.venueId, categoryId: n.categoryId, sku: `GORRA-${Date.now()}`, name: 'Gorra', price: 150 } as any,
    })

    const line = (productId: string, productName: string, quantity: number, unitPrice: number, discountAmount: number) => ({
      productId,
      productName,
      quantity,
      unitPrice,
      discountAmount,
      taxAmount: 0,
      total: Math.round((unitPrice * quantity - discountAmount) * 100) / 100,
    })
    const order = (num: string, createdAt: Date, items: ReturnType<typeof line>[], status: 'COMPLETED' | 'CANCELLED' = 'COMPLETED') => {
      const total = items.reduce((s, i) => s + i.total, 0)
      return prisma.order.create({
        data: {
          venueId: n.venueId,
          orderNumber: `MCPV-${num}-${Date.now()}`,
          createdAt,
          subtotal: total,
          taxAmount: 0,
          total,
          status,
          paymentStatus: status === 'COMPLETED' ? 'PAID' : 'PENDING',
          items: { create: items },
        },
      })
    }
    await order('1', DAY, [
      line(tallaS, 'Playera · S', 3, 299.1, 12.34), // 884.96
      line(tallaM, 'Playera · M', 1, 329.45, 0), // 329.45
      line(tallaXS, 'Playera · XS', 1, 199.99, 0), // 199.99 — talla que luego se archiva
      line(gorra.id, 'Gorra', 2, 150, 0), // no es de la familia
    ])
    await order('2', LAST_LOCAL_SECOND, [line(tallaM, 'Playera · M', 3, 329.45, 5.55)]) // 982.80
    await order('3', NEXT_LOCAL_DAY, [line(tallaS, 'Playera · S', 10, 299.1, 0)]) // otro día del negocio
    await order('4', DAY, [line(tallaS, 'Playera · S', 5, 299.1, 0)], 'CANCELLED') // cancelada
    // Archivar la XS no borra su historia: sus ventas siguen sumando a la familia.
    await prisma.product.update({ where: { id: tallaXS }, data: { deletedAt: new Date() } })
  })

  afterAll(async () => {
    if (!n?.venueId) return
    await prisma.orderItem.deleteMany({ where: { order: { venueId: n.venueId } } })
    await prisma.order.deleteMany({ where: { venueId: n.venueId } })
    await n.limpiar()
  })

  it('🔴 cada variante y el total de la familia, al centavo, en el día del NEGOCIO', async () => {
    const r = await call('product_variants', { venueId: n.venueId, name: 'Playera', fromDate: '2025-03-11', toDate: '2025-03-11' })
    expect(r.found).toBe(true)
    expect(r.product.breakdown.map((v: { name: string }) => v.name)).toEqual(['Playera · S', 'Playera · M'])
    expect(r.sales.window).toEqual({ start: '2025-03-11T06:00:00.000Z', end: '2025-03-12T05:59:59.999Z' })
    expect(r.sales.byVariant).toEqual([
      { name: 'Playera · S', sku: expect.any(String), unitsSold: 3, revenue: 884.96, timesOrdered: 1 },
      { name: 'Playera · M', sku: expect.any(String), unitsSold: 4, revenue: 1312.25, timesOrdered: 2 },
      { name: 'Playera · XS', sku: expect.any(String), unitsSold: 1, revenue: 199.99, timesOrdered: 1, archived: true },
    ])
    expect(cents(r.sales.revenue)).toBe(88496 + 131225 + 19999)
    expect(cents(r.sales.revenue)).toBe(r.sales.byVariant.reduce((s: number, v: { revenue: number }) => s + cents(v.revenue), 0))
    expect(r.sales.unitsSold).toBe(8)
    expect(r.sales.timesOrdered).toBe(4)
    expect(JSON.stringify(r)).not.toMatch(/"variants"/)
  })

  it('cada variante cuadra con lo que product_sales (certificada) contesta para ella', async () => {
    const r = await call('product_variants', { venueId: n.venueId, name: 'Playera', fromDate: '2025-03-11', toDate: '2025-03-11' })
    for (const nombre of ['Playera · S', 'Playera · M']) {
      const ps = await call('product_sales', { venueId: n.venueId, name: nombre, fromDate: '2025-03-11', toDate: '2025-03-11' })
      const v = r.sales.byVariant.find((x: { name: string }) => x.name === nombre)
      expect([cents(v.revenue), v.unitsSold, v.timesOrdered]).toEqual([cents(ps.revenue), ps.unitsSold, ps.timesOrdered])
    }
  })

  it('el día siguiente del negocio sólo trae lo de ese día; la variante sin ventas sale en cero', async () => {
    const r = await call('product_variants', { venueId: n.venueId, name: 'Playera', fromDate: '2025-03-12', toDate: '2025-03-12' })
    expect(r.sales.byVariant).toEqual([
      { name: 'Playera · S', sku: expect.any(String), unitsSold: 10, revenue: 2991, timesOrdered: 1 },
      { name: 'Playera · M', sku: expect.any(String), unitsSold: 0, revenue: 0, timesOrdered: 0 },
    ])
    expect(r.sales).toMatchObject({ unitsSold: 10, revenue: 2991, timesOrdered: 1 })
  })

  it('sin fechas no consulta ventas', async () => {
    const r = await call('product_variants', { venueId: n.venueId, name: 'Playera' })
    expect(r).toMatchObject({ found: true, product: { name: 'Playera', variantCount: 2, archivedVariantCount: 1 } })
    expect(r.sales).toBeUndefined()
  })

  it('🔴 I-1 (/full-testing): repetir la MISMA confirmación de create_product_with_variants no crea otra familia', async () => {
    const { name: category } = await prisma.menuCategory.findUniqueOrThrow({ where: { id: n.categoryId } })
    const args = { venueId: n.venueId, name: 'Gorra MCP', category, options: [{ name: 'Talla', values: ['U'] }], price: 150 }
    const preview = await call('create_product_with_variants', args)
    expect(preview.requiresConfirmation).toBe(true)
    const confirmar = () =>
      call('create_product_with_variants', { ...args, confirm: true, expectedSourceFingerprint: preview.expectedSourceFingerprint })
    expect(await confirmar()).toMatchObject({ ok: true, variantCount: 1 })
    expect(await confirmar()).toMatchObject({ ok: false, code: 'PRODUCT_GROUP_NAME_TAKEN' })
    expect(await prisma.productGroup.count({ where: { venueId: n.venueId, name: 'Gorra MCP' } })).toBe(1)
    // Y una vista previa nueva ya lo avisa, en vez de prometer algo que la confirmación rechazará.
    expect(await call('create_product_with_variants', args)).toMatchObject({ ok: false, code: 'PRODUCT_GROUP_NAME_TAKEN' })
  })
})
