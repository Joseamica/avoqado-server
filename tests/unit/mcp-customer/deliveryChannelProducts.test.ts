/**
 * D1: productos de cada canal de delivery por MCP (modo libre): lectura acotada y escritura en dos pasos.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { configureToolCatalog } from '@/mcp/catalog'
import { DIRECTORY_TIERS } from '@/mcp/directory/catalog'
import type { McpScope } from '@/mcp/scope'
import AppError from '@/errors/AppError'
import { registerDeliveryChannelProductTools } from '../../../src/mcp/tools/deliveryChannelProducts'

const mockLinks = jest.fn()
const mockProducts = jest.fn()
const mockCount = jest.fn()
const mockPoner = jest.fn()
const mockAudit = jest.fn()
const mockGate = jest.fn()
const mockPermission = jest.fn()

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    deliveryChannelLink: { findMany: (...a: unknown[]) => mockLinks(...a) },
    product: { findMany: (...a: unknown[]) => mockProducts(...a), count: (...a: unknown[]) => mockCount(...a) },
  },
}))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({ venueFilter: (v: string) => ({ venueId: v }), requirePermission: (...a: unknown[]) => mockPermission(...a) }),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...a) }))
jest.mock('@/mcp/requireWriteScopeAlways', () => ({ requireWriteScopeAlways: jest.fn() }))
jest.mock('@/mcp/planGate', () => ({ planGateMessage: (...a: unknown[]) => mockGate(...a) }))
jest.mock('@/services/delivery-channels/core/productoEnCanales.service', () => ({
  ponerProductoEnCanales: (...a: unknown[]) => mockPoner(...a),
}))

const scope = {
  staffId: 's1',
  activeOrg: 'o1',
  allowedVenueIds: ['v1'],
  perVenueAccess: new Map(),
  scopes: ['mcp:read', 'mcp:write'],
} as unknown as McpScope

let server: McpServer
let client: Client
const call = async (name: string, args: Record<string, unknown>) =>
  JSON.parse(((await client.callTool({ name, arguments: args })).content as Array<{ text: string }>)[0].text)

const link = (id: string, provider: string, config: unknown = {}) => ({
  id,
  provider,
  status: 'ACTIVE',
  createdAt: new Date('2026-01-01'),
  config,
})
const prod = (id: string, sku: string, price: number) => ({ id, sku, name: `P ${sku}`, active: true, price })

beforeEach(async () => {
  ;[mockLinks, mockProducts, mockCount, mockPoner, mockAudit, mockGate, mockPermission].forEach(m => m.mockReset())
  mockGate.mockResolvedValue(null)
  mockCount.mockResolvedValue(0)
  mockProducts.mockResolvedValue([])
  mockPoner.mockResolvedValue([{ linkId: 'l1', dentro: true }])
  server = new McpServer({ name: 'p', version: '1' })
  configureToolCatalog(server, scope)
  registerDeliveryChannelProductTools(server, scope)
  client = new Client({ name: 't', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
})
afterEach(async () => {
  await client.close()
  await server.close()
})

describe('delivery_channel_products', () => {
  it('lista por id: archivado va a yaNoExisten, nuevos sale del count con notIn de lista y revisados', async () => {
    mockLinks.mockResolvedValue([link('l1', 'RAPPI', { productoIds: ['a', 'b'], productosRevisados: ['z'] })])
    mockProducts.mockResolvedValue([prod('a', 'SKU-A', 10)])
    mockCount.mockResolvedValue(3)
    const r = await call('delivery_channel_products', { venueId: 'v1' })
    const c = r.channels[0]
    expect(c.productos).toEqual([{ productId: 'a', sku: 'SKU-A', nombre: 'P SKU-A', activo: true, precioQueSePublica: 10 }])
    expect(c.yaNoExisten).toEqual(['b'])
    expect(c.nuevos).toBe(3)
    expect(c.todoElCatalogo).toBe(false)
    const q = mockProducts.mock.calls[0][0]
    expect(q.where.id.in).toEqual(['a', 'b'])
    expect(q.where.deletedAt).toBeNull()
    expect(q.take).toBe(2)
    const w = mockCount.mock.calls[0][0].where
    expect(w.id.notIn.sort()).toEqual(['a', 'b', 'z'])
    expect(w.createdAt.gt).toEqual(new Date('2026-01-01'))
  })

  it('sin lista: todoElCatalogo y total contado en la base', async () => {
    mockLinks.mockResolvedValue([link('l1', 'UBER_EATS')])
    mockCount.mockResolvedValue(111)
    const c = (await call('delivery_channel_products', { venueId: 'v1' })).channels[0]
    expect(c).toMatchObject({ todoElCatalogo: true, totalEnCatalogo: 111, nuevos: 0 })
    expect(mockProducts).not.toHaveBeenCalled()
    expect(mockCount.mock.calls[0][0].where).toEqual({ venueId: 'v1', deletedAt: null })
  })

  it('lista vieja por código: lee por sku IN y reporta códigos sin producto', async () => {
    mockLinks.mockResolvedValue([link('l1', 'RAPPI', { productos: ['X1', 'X2'] })])
    mockProducts.mockResolvedValue([prod('a', 'X1', 5)])
    const c = (await call('delivery_channel_products', { venueId: 'v1' })).channels[0]
    expect(mockProducts.mock.calls[0][0].where.sku.in).toEqual(['X1', 'X2'])
    expect(mockProducts.mock.calls[0][0].take).toBe(2)
    expect(c.yaNoExisten).toEqual(['X2'])
    expect(c.nuevos).toBe(0)
  })

  it('precio fijo 79.5: Rappi 80, Uber 79.5', async () => {
    const config = (extra: object) => ({ productoIds: ['a'], precios: { porProducto: { a: 79.5 }, ...extra } })
    mockProducts.mockResolvedValue([prod('a', 'S', 65)])
    mockLinks.mockResolvedValue([link('l1', 'RAPPI', config({})), link('l2', 'UBER_EATS', config({}))])
    const r = await call('delivery_channel_products', { venueId: 'v1' })
    expect(r.channels[0].productos[0].precioQueSePublica).toBe(80)
    expect(r.channels[1].productos[0].precioQueSePublica).toBe(79.5)
  })

  it('margen 20 % sobre 65 en Rappi: 78', async () => {
    mockLinks.mockResolvedValue([link('l1', 'RAPPI', { productoIds: ['a'], precios: { markupPercent: 20 } })])
    mockProducts.mockResolvedValue([prod('a', 'S', 65)])
    expect((await call('delivery_channel_products', { venueId: 'v1' })).channels[0].productos[0].precioQueSePublica).toBe(78)
  })

  it('linkId filtra por canal y toda consulta es acotada', async () => {
    mockLinks.mockResolvedValue([link('l1', 'RAPPI')])
    await call('delivery_channel_products', { venueId: 'v1', linkId: 'l1' })
    expect(mockLinks.mock.calls[0][0].where).toMatchObject({ venueId: 'v1', id: 'l1' })
    expect(mockLinks.mock.calls[0][0].take).toBeGreaterThan(0)
  })

  it('sin plan: planRequired', async () => {
    mockGate.mockResolvedValue('Mejora tu plan')
    expect((await call('delivery_channel_products', { venueId: 'v1' })).planRequired).toBe(true)
    expect(mockLinks).not.toHaveBeenCalled()
  })
})

describe('set_delivery_channel_product', () => {
  const args = { venueId: 'v1', productId: 'p1', linkId: 'l1', vender: true }
  beforeEach(() => mockLinks.mockResolvedValue([link('l1', 'RAPPI', {})]))

  it('sin confirmar: vista previa con token y no escribe', async () => {
    const r = await call('set_delivery_channel_product', args)
    expect(r).toMatchObject({ requiresConfirmation: true, confirmationToken: expect.any(String) })
    expect(mockPoner).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('quitar con el canal publicando todo: avisa que la lista se vuelve explícita', async () => {
    const r = await call('set_delivery_channel_product', { ...args, vender: false })
    expect(r.aviso).toMatch(/lista/i)
  })

  it('con token y mismos argumentos: llama al servicio una vez y audita', async () => {
    const p = await call('set_delivery_channel_product', args)
    const r = await call('set_delivery_channel_product', {
      ...p.confirmationArguments,
      confirm: true,
      confirmationToken: p.confirmationToken,
    })
    expect(r.ok).toBe(true)
    expect(mockPoner).toHaveBeenCalledTimes(1)
    expect(mockPoner).toHaveBeenCalledWith('v1', 'p1', { l1: true }, 's1')
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'DELIVERY_CHANNEL_PRODUCT_SET' }))
  })

  it('un AppError vuelve como ok:false', async () => {
    mockPoner.mockRejectedValue(new AppError('Producto no encontrado', 404, true, 'NOT_FOUND'))
    const p = await call('set_delivery_channel_product', args)
    const r = await call('set_delivery_channel_product', {
      ...p.confirmationArguments,
      confirm: true,
      confirmationToken: p.confirmationToken,
    })
    expect(r).toEqual({ ok: false, error: 'Producto no encontrado' })
  })

  it('un canal que no existe (o de otro negocio) vuelve como ok:false, igual que los demás errores', async () => {
    mockLinks.mockResolvedValue([])
    expect(await call('set_delivery_channel_product', args)).toEqual({ ok: false, error: 'Canal de delivery no encontrado' })
    expect(mockPoner).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('sin plan: planRequired y no escribe', async () => {
    mockGate.mockResolvedValue('Mejora tu plan')
    expect((await call('set_delivery_channel_product', args)).planRequired).toBe(true)
    expect(mockPoner).not.toHaveBeenCalled()
  })
})

it('ninguna de las dos está en el catálogo certificado', () => {
  const all: string[] = DIRECTORY_TIERS.flatMap(t => t.tools)
  expect(all).not.toContain('delivery_channel_products')
  expect(all).not.toContain('set_delivery_channel_product')
})
