/**
 * IVA por producto, plan 6b (Tarea 9, D20) — el MCP: `set_product_iva`, el IVA en `list_menu`/`menu_item_detail`.
 * El diagnóstico (sólo el negocio) pide permiso de LECTURA, nunca `cfdi:*`; cambiar pide `products:update` y va por el MISMO servicio
 * que el dashboard (`updateProduct`, con origen MCP). Mock-first: sin base ni servidor MCP.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { configureToolCatalog } from '../../../src/mcp/catalog'
import { registerMenuTools } from '../../../src/mcp/tools/menu'
import type { McpScope } from '../../../src/mcp/scope'
import { ConflictError } from '../../../src/errors/AppError'
import logger from '@/config/logger'

const mockProductFindMany = jest.fn()
const mockProductCount = jest.fn()
const mockUpdateProduct = jest.fn()
const mockAudit = jest.fn()
const mockPermiso = jest.fn()
const mockEstado = jest.fn()

jest.mock('@/services/dashboard/product.dashboard.service', () => ({
  updateProduct: (...a: unknown[]) => mockUpdateProduct(...(a as [])),
  createProduct: jest.fn(),
  getProduct: jest.fn(),
}))
jest.mock('@/services/dashboard/menu.dashboard.service', () => ({ createMenuCategory: jest.fn(), createModifierGroup: jest.fn() }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v?: string) => ({ venueId: { in: [v ?? 'v1'] } }),
    requirePermission: (...a: unknown[]) => mockPermiso(...(a as [])),
  }),
}))
jest.mock('@/services/fiscal/encendidoIva.service', () => ({ estadoIvaPorProducto: (...a: unknown[]) => mockEstado(...(a as [])) }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    product: {
      findMany: (...a: unknown[]) => mockProductFindMany(...(a as [])),
      count: (...a: unknown[]) => mockProductCount(...(a as [])),
    },
  },
}))

const MENSAJE_ENCENDIDO_BLOQUEADO = 'Para vender productos con un IVA distinto de 16 % falta resolver esto:'

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (n: string, args: Record<string, unknown>) => handlers.get(n)!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  const reg = { tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never
  registerMenuTools(reg, scope)
})
beforeEach(() => {
  jest.clearAllMocks()
  mockProductCount.mockResolvedValue(0)
})

const apagado = {
  encendido: false,
  habilitadoAt: null,
  contabilidad: false,
  bloqueos: [{ codigo: 'APARATO_VIEJO', mensaje: 'Caja 2 imprime el IVA de forma incorrecta', comoArreglar: '…' }],
  avisos: [],
  facturasSinSello: [],
}
const cafe = { id: 'p1', name: 'Café en grano', active: true, price: 250, ivaTratamiento: 'IVA_16' }

describe('set_product_iva', () => {
  it('D20 · con sólo el negocio es el diagnóstico: estado, bloqueos y avisos; permiso de LECTURA, nunca cfdi:*', async () => {
    mockEstado.mockResolvedValue(apagado)
    const out = parse(await call('set_product_iva', { venueId: 'v1' }))
    expect(out).toMatchObject({
      ok: true,
      diagnostico: true,
      encendido: false,
      bloqueos: apagado.bloqueos,
      dondeSeCambia: 'dashboard → producto, junto al precio',
    })
    expect(mockPermiso).toHaveBeenCalledWith('menu:read', 'v1')
    expect(mockPermiso.mock.calls.flat().join()).not.toMatch(/cfdi:/)
    expect(mockUpdateProduct).not.toHaveBeenCalled()
  })

  it('el diagnóstico pide la revisión completa (T5-a): con la hora de ahora y conRevision', async () => {
    mockEstado.mockResolvedValue(apagado)
    await call('set_product_iva', { venueId: 'v1' })
    expect(mockEstado).toHaveBeenCalledWith('v1', expect.any(Date), { conRevision: true })
  })

  it('sin confirmar sólo previsualiza: 16 % → 0 %, avisa que enciende el negocio y lo que la revisión diría hoy', async () => {
    mockEstado.mockResolvedValue(apagado)
    mockProductFindMany.mockResolvedValue([cafe])
    const out = parse(await call('set_product_iva', { venueId: 'v1', name: 'café', iva: 'IVA_0' }))
    expect(out).toMatchObject({
      requiresConfirmation: true,
      resolvedProductId: 'p1',
      change: { item: 'Café en grano', label: 'IVA', from: '16 %', to: '0 %' },
      encenderaElNegocio: true,
      soloDuenoOAdministrador: true,
      bloqueos: apagado.bloqueos,
    })
    expect(out.message).toContain('Sólo lo puede confirmar el dueño o un administrador')
    expect(mockPermiso).toHaveBeenCalledWith('products:update', 'v1')
    expect(mockUpdateProduct).not.toHaveBeenCalled()
    expect(mockEstado).toHaveBeenCalledWith('v1', expect.any(Date), { conRevision: true })
  })

  it('con el negocio YA encendido, la vista previa no avisa de encendido', async () => {
    mockEstado.mockResolvedValue({ ...apagado, encendido: true, bloqueos: [] })
    mockProductFindMany.mockResolvedValue([cafe])
    const out = parse(await call('set_product_iva', { venueId: 'v1', name: 'café', iva: 'EXENTO' }))
    expect(out.requiresConfirmation).toBe(true)
    expect(out.encenderaElNegocio).toBeUndefined()
    expect(out.message).not.toContain('Sólo lo puede confirmar el dueño')
  })

  it('volver a 16 % o pedir el mismo valor no enciende nada', async () => {
    mockEstado.mockResolvedValue(apagado)
    mockProductFindMany.mockResolvedValue([cafe])
    expect(parse(await call('set_product_iva', { venueId: 'v1', name: 'café', iva: 'IVA_16' })).encenderaElNegocio).toBeUndefined()
    mockProductFindMany.mockResolvedValue([{ ...cafe, ivaTratamiento: 'IVA_0' }])
    expect(parse(await call('set_product_iva', { venueId: 'v1', name: 'café', iva: 'IVA_0' })).encenderaElNegocio).toBeUndefined()
  })

  it('con confirm y la huella de la vista previa, cambia por el MISMO servicio del dashboard, con origen MCP', async () => {
    mockEstado.mockResolvedValue(apagado)
    mockProductFindMany.mockResolvedValue([cafe])
    const previa = parse(await call('set_product_iva', { venueId: 'v1', name: 'café', iva: 'IVA_0' }))
    mockUpdateProduct.mockResolvedValue({ name: 'Café en grano', ivaTratamiento: 'IVA_0' })
    const out = parse(
      await call('set_product_iva', {
        venueId: 'v1',
        name: 'café',
        iva: 'IVA_0',
        confirm: true,
        resolvedProductId: 'p1',
        expectedSourceFingerprint: previa.expectedSourceFingerprint,
      }),
    )
    expect(out).toEqual({ ok: true, item: { name: 'Café en grano', iva: '0 %' } })
    expect(mockUpdateProduct).toHaveBeenCalledWith(
      'v1',
      'p1',
      { ivaTratamiento: 'IVA_0' },
      expect.objectContaining({ type: 'HUMAN' }),
      { name: 'Café en grano', price: 250, active: true, ivaTratamiento: 'IVA_16' },
      { origen: 'MCP' },
    )
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'PRODUCT_IVA_SET', entityId: 'p1' }))
  })

  it('confirm con una huella vieja (el IVA cambió desde la vista previa) no escribe', async () => {
    mockEstado.mockResolvedValue(apagado)
    mockProductFindMany.mockResolvedValue([cafe])
    const previa = parse(await call('set_product_iva', { venueId: 'v1', name: 'café', iva: 'IVA_0' }))
    mockProductFindMany.mockResolvedValue([{ ...cafe, ivaTratamiento: 'EXENTO' }])
    const out = parse(
      await call('set_product_iva', {
        venueId: 'v1',
        name: 'café',
        iva: 'IVA_0',
        confirm: true,
        resolvedProductId: 'p1',
        expectedSourceFingerprint: previa.expectedSourceFingerprint,
      }),
    )
    expect(out.needsInput).toBe(true)
    expect(mockUpdateProduct).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  // Codex código r1 #5 (Ruling CX-5): la huella liga la confirmación al IVA que se MOSTRÓ. Una vista previa a 16 % (sin aviso de encendido)
  // no sirve para confirmar 0 % (que enciende el negocio): rechazo, nada escrito.
  it('CX-5 · vista previa a 16 % y confirmación a 0 % con la misma huella ⇒ rechazo, no escribe', async () => {
    mockEstado.mockResolvedValue(apagado)
    mockProductFindMany.mockResolvedValue([{ ...cafe, ivaTratamiento: 'EXENTO' }])
    const previa = parse(await call('set_product_iva', { venueId: 'v1', name: 'café', iva: 'IVA_16' }))
    expect(previa.encenderaElNegocio).toBeUndefined() // la vista previa NO advirtió del encendido
    const out = parse(
      await call('set_product_iva', {
        venueId: 'v1',
        name: 'café',
        iva: 'IVA_0',
        confirm: true,
        resolvedProductId: 'p1',
        expectedSourceFingerprint: previa.expectedSourceFingerprint,
      }),
    )
    expect(out.needsInput).toBe(true)
    expect(mockUpdateProduct).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('si el encendido se detiene, devuelve los bloqueos con cómo arreglarlos', async () => {
    mockEstado.mockResolvedValue(apagado)
    mockProductFindMany.mockResolvedValue([cafe])
    const previa = parse(await call('set_product_iva', { venueId: 'v1', name: 'café', iva: 'IVA_0' }))
    mockUpdateProduct.mockRejectedValue(
      new ConflictError(MENSAJE_ENCENDIDO_BLOQUEADO, 'IVA_ENCENDIDO_BLOQUEADO', { bloqueos: apagado.bloqueos }),
    )
    const out = parse(
      await call('set_product_iva', {
        venueId: 'v1',
        name: 'café',
        iva: 'IVA_0',
        confirm: true,
        resolvedProductId: 'p1',
        expectedSourceFingerprint: previa.expectedSourceFingerprint,
      }),
    )
    expect(out).toEqual({ ok: false, error: MENSAJE_ENCENDIDO_BLOQUEADO, code: 'IVA_ENCENDIDO_BLOQUEADO', bloqueos: apagado.bloqueos })
    expect(mockAudit).not.toHaveBeenCalled()
  })

  // Revisión final, Minor nuevo 1: un error inesperado (un P2028 de Prisma) no llega crudo al asistente ni se pierde sin rastro.
  const confirmarConError = async (error: unknown) => {
    mockEstado.mockResolvedValue(apagado)
    mockProductFindMany.mockResolvedValue([cafe])
    const previa = parse(await call('set_product_iva', { venueId: 'v1', name: 'café', iva: 'IVA_0' }))
    mockUpdateProduct.mockRejectedValue(error)
    return parse(
      await call('set_product_iva', {
        venueId: 'v1',
        name: 'café',
        iva: 'IVA_0',
        confirm: true,
        resolvedProductId: 'p1',
        expectedSourceFingerprint: previa.expectedSourceFingerprint,
      }),
    )
  }

  it('un error que no es AppError: texto genérico en español (nunca el de Prisma) y logger.error con el negocio', async () => {
    const prisma = Object.assign(new Error('Transaction already closed: A query cannot be executed on an expired transaction (P2028)'), {
      code: 'P2028',
    })
    const out = await confirmarConError(prisma)
    expect(out.ok).toBe(false)
    expect(out.error).not.toMatch(/P2028|Transaction|query/i)
    expect(out.error).toMatch(/inesperado/i)
    expect(out.code).toBeUndefined()
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ venueId: 'v1', error: prisma.message }))
    expect(logger.warn).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('un AppError 4xx (409 IVA_ENCENDIDO_OCUPADO) conserva su mensaje y código, y queda como warn con el negocio', async () => {
    const ocupado = new ConflictError(
      'Hay facturas o ventas en proceso en tu organización; vuelve a intentar en un momento.',
      'IVA_ENCENDIDO_OCUPADO',
    )
    const out = await confirmarConError(ocupado)
    expect(out).toEqual({ ok: false, error: ocupado.message, code: 'IVA_ENCENDIDO_OCUPADO' })
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ venueId: 'v1', code: 'IVA_ENCENDIDO_OCUPADO' }))
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('un nombre ambiguo pregunta, nunca previsualiza', async () => {
    mockProductFindMany.mockResolvedValue([cafe, { ...cafe, id: 'p2', name: 'Café molido' }])
    const out = parse(await call('set_product_iva', { venueId: 'v1', name: 'café', iva: 'IVA_0' }))
    expect(out.ambiguous).toBe(true)
    expect(out.requiresConfirmation).toBeUndefined()
    expect(mockUpdateProduct).not.toHaveBeenCalled()
  })
})

describe('list_menu · el IVA de cada producto', () => {
  it('list_menu muestra el IVA de cada producto', async () => {
    mockProductFindMany.mockResolvedValue([
      {
        name: 'Consulta',
        price: 500,
        active: true,
        type: 'SERVICE',
        soldByWeight: false,
        unit: null,
        category: null,
        ivaTratamiento: 'EXENTO',
      },
      {
        name: 'Café en grano',
        price: 250,
        active: true,
        type: 'REGULAR',
        soldByWeight: false,
        unit: null,
        category: null,
        ivaTratamiento: 'BLOQUEADO_04',
      },
    ])
    mockProductCount.mockResolvedValue(2)
    const out = parse(await call('list_menu', { venueId: 'v1' }))
    expect(out.items.map((i: { iva: string }) => i.iva)).toEqual(['Exento', 'Por revisar'])
  })

  it('pide ivaTratamiento en el select y conserva los campos de siempre', async () => {
    mockProductFindMany.mockResolvedValue([
      {
        name: 'Taco',
        price: 30,
        active: true,
        type: 'REGULAR',
        soldByWeight: false,
        unit: null,
        category: { name: 'Antojitos' },
        ivaTratamiento: 'IVA_16',
      },
    ])
    mockProductCount.mockResolvedValue(1)
    const out = parse(await call('list_menu', { venueId: 'v1' }))
    expect(mockProductFindMany.mock.calls[0][0].select.ivaTratamiento).toBe(true)
    expect(out.items[0]).toEqual({ name: 'Taco', price: 30, active: true, type: 'REGULAR', category: 'Antojitos', iva: '16 %' })
  })
})

describe('por el catálogo real: efecto declarado y confirmación atada a la vista previa', () => {
  it('registra como escritura; el token ata producto y huella; si el IVA cambió en medio ya no escribe', async () => {
    const server = new McpServer({ name: 'iva', version: '1' })
    const client = new Client({ name: 'iva-test', version: '1' })
    const real = {
      staffId: 's1',
      activeOrg: 'o1',
      allowedVenueIds: ['v1'],
      scopes: ['mcp:read', 'mcp:write'],
      perVenueAccess: new Map(),
    } as unknown as McpScope
    configureToolCatalog(server, real)
    registerMenuTools(server, real) // sin efecto declarado en TOOL_EFFECTS el registro truena
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    try {
      expect((await client.listTools()).tools.find(t => t.name === 'set_product_iva')?.annotations).toMatchObject({ readOnlyHint: false })
      const llama = async (args: Record<string, unknown>) =>
        JSON.parse(((await client.callTool({ name: 'set_product_iva', arguments: args })).content as Array<{ text: string }>)[0].text)
      mockEstado.mockResolvedValue(apagado)
      mockProductFindMany.mockResolvedValue([cafe])
      mockUpdateProduct.mockResolvedValue({ name: 'Café en grano', ivaTratamiento: 'IVA_0' })
      const previa = await llama({ venueId: 'v1', name: 'café', iva: 'IVA_0' })
      expect(previa.confirmationArguments).toMatchObject({ resolvedProductId: 'p1', expectedSourceFingerprint: expect.any(String) })
      const firmado = { ...previa.confirmationArguments, confirm: true, confirmationToken: previa.confirmationToken }
      mockProductFindMany.mockResolvedValue([{ ...cafe, ivaTratamiento: 'EXENTO' }])
      expect(await llama(firmado)).toMatchObject({ needsInput: true })
      expect(mockUpdateProduct).not.toHaveBeenCalled()
      mockProductFindMany.mockResolvedValue([cafe])
      expect(await llama(firmado)).toEqual({ ok: true, item: { name: 'Café en grano', iva: '0 %' } })
    } finally {
      await client.close()
      await server.close()
    }
  })
})
