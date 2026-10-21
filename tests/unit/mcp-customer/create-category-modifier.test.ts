import { z } from 'zod'
import { registerMenuTools } from '../../../src/mcp/tools/menu'
import type { McpScope } from '../../../src/mcp/scope'
import { CreateModifierGroupSchema } from '../../../src/schemas/dashboard/menu.schema'

const mockCat = jest.fn()
const mockMod = jest.fn()
const mockAudit = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: (_perm: string, v: string) => {
      if (v === 'no-perm') throw new Error('Forbidden: missing menu:create')
    },
  }),
}))
jest.mock('@/services/dashboard/product.dashboard.service', () => ({ updateProduct: jest.fn(), createProduct: jest.fn() }))
jest.mock('@/services/dashboard/menu.dashboard.service', () => ({
  createMenuCategory: (...a: unknown[]) => mockCat(...(a as [])),
  createModifierGroup: (...a: unknown[]) => mockMod(...(a as [])),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { product: { findMany: jest.fn(), findFirst: jest.fn() }, menuCategory: { findMany: jest.fn(), findFirst: jest.fn() } },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const shapes = new Map<string, Record<string, z.ZodTypeAny>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (n: string, args: Record<string, unknown>) => handlers.get(n)!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerMenuTools(
    {
      tool: (...a: unknown[]) => {
        handlers.set(a[0] as string, a[a.length - 1] as never)
        if (a.length >= 4) shapes.set(a[0] as string, a[2] as never)
      },
    } as never,
    scope,
  )
})
beforeEach(() => jest.clearAllMocks())

describe('create_category', () => {
  it('rejects out-of-scope / no-perm', async () => {
    await expect(call('create_category', { venueId: 'foreign', name: 'X' })).rejects.toThrow('out of scope')
    await expect(call('create_category', { venueId: 'no-perm', name: 'X' })).rejects.toThrow('Forbidden')
    expect(mockCat).not.toHaveBeenCalled()
  })
  it('creates a category + audits', async () => {
    mockCat.mockResolvedValueOnce({ id: 'cat-1', name: 'Bebidas' })
    const out = parse(await call('create_category', { venueId: 'v1', name: 'Bebidas', description: 'Frías' }))
    expect(mockCat).toHaveBeenCalledWith('v1', expect.objectContaining({ name: 'Bebidas', description: 'Frías' }))
    expect(out).toMatchObject({ ok: true, category: { id: 'cat-1', name: 'Bebidas' } })
    expect(mockAudit.mock.calls[0][1]).toMatchObject({ action: 'MENU_CATEGORY_CREATED', entityId: 'cat-1' })
  })
})

describe('create_modifier_group', () => {
  it('creates a group with its options (extraPrice -> price, default 0) + audits', async () => {
    mockMod.mockResolvedValueOnce({ id: 'mg-1', name: 'Extras' })
    const out = parse(
      await call('create_modifier_group', {
        venueId: 'v1',
        name: 'Extras',
        required: false,
        allowMultiple: true,
        options: [{ name: 'Queso extra', extraPrice: 15 }, { name: 'Sin cebolla' }],
      }),
    )
    const dto = mockMod.mock.calls[0][1] as { name: string; modifiers: Array<{ name: string; price: number }> }
    expect(dto.name).toBe('Extras')
    expect(dto.modifiers).toEqual([
      { name: 'Queso extra', price: 15 },
      { name: 'Sin cebolla', price: 0 },
    ])
    expect(out).toMatchObject({ ok: true, modifierGroup: { id: 'mg-1', options: 2 } })
    expect(mockAudit.mock.calls[0][1]).toMatchObject({ action: 'MODIFIER_GROUP_CREATED', entityId: 'mg-1' })
  })

  it('manda el SKU de cada opción al servicio; la que no lo trae no lleva la llave', async () => {
    mockMod.mockResolvedValueOnce({ id: 'mg-2', name: 'Extras' })
    await call('create_modifier_group', {
      venueId: 'v1',
      name: 'Extras',
      options: [{ name: 'Shot de espresso', extraPrice: 15, sku: 'P000672' }, { name: 'Sin azúcar' }],
    })
    // toStrictEqual, no toEqual: toEqual ignora una llave con valor undefined, y aquí lo que se exige es que NO exista.
    expect(mockMod.mock.calls[0][1].modifiers).toStrictEqual([
      { name: 'Shot de espresso', price: 15, sku: 'P000672' },
      { name: 'Sin azúcar', price: 0 },
    ])
  })

  it('la entrada rechaza un SKU que la API HTTP también rechaza', () => {
    const schema = z.object(shapes.get('create_modifier_group')!)
    const base = { venueId: 'v1', name: 'Extras' }
    expect(schema.safeParse({ ...base, options: [{ name: 'Shot', sku: 'P 000672' }] }).success).toBe(false)
    expect(schema.safeParse({ ...base, options: [{ name: 'Shot', sku: 'X'.repeat(65) }] }).success).toBe(false)
    expect(schema.safeParse({ ...base, options: [{ name: 'Shot', sku: 'P000672' }] }).success).toBe(true)
  })

  // Paridad con la API HTTP: las mismas entradas pasan por los dos esquemas. Si alguien quita el `.trim()` o cambia el
  // formato en uno solo, esta prueba lo dice.
  it('paridad con la API HTTP: mismo veredicto, mismo valor guardado y el mismo mensaje de formato en español', () => {
    const mcp = z.object(shapes.get('create_modifier_group')!)
    const porMcp = (sku: string) => {
      const r = mcp.safeParse({ venueId: 'v1', name: 'Extras', options: [{ name: 'Shot', sku }] })
      return r.success
        ? { valido: true, sku: r.data.options[0].sku, mensajes: [] as string[] }
        : { valido: false, sku: undefined, mensajes: r.error.issues.map(i => i.message) }
    }
    const porHttp = (sku: string) => {
      const r = CreateModifierGroupSchema.safeParse({
        params: { venueId: 'cjld2cjxh0000qzrmn831i7rn' },
        body: { name: 'Extras', modifiers: [{ name: 'Shot', sku }] },
      })
      return r.success
        ? { valido: true, sku: r.data.body.modifiers?.[0].sku, mensajes: [] as string[] }
        : { valido: false, sku: undefined, mensajes: r.error.issues.map(i => i.message) }
    }

    for (const entrada of ['P 1', ' P000672 ', 'X'.repeat(65), 'Ñ1']) {
      const [m, h] = [porMcp(entrada), porHttp(entrada)]
      expect([entrada, m.valido, m.sku]).toEqual([entrada, h.valido, h.sku])
    }
    expect(porMcp(' P000672 ')).toMatchObject({ valido: true, sku: 'P000672' })

    // El agente lee el mismo texto que el dashboard, no un «Invalid» pelón.
    for (const entrada of ['P 1', 'Ñ1']) {
      expect(porMcp(entrada).mensajes).toEqual(['El SKU sólo admite letras, números, guion y guion bajo'])
      expect(porHttp(entrada).mensajes).toEqual(['El SKU sólo admite letras, números, guion y guion bajo'])
    }

    // En blanco NO hay paridad, a propósito (decisión de la Task 5): el MCP lo rechaza —un agente puede omitir el campo y
    // rechazar es más claro que adivinar— y la API lo guarda como «sin SKU».
    expect(porMcp('   ').valido).toBe(false)
    expect(porHttp('   ')).toMatchObject({ valido: true, sku: null })
  })
})
