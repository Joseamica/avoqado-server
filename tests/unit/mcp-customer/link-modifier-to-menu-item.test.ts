/**
 * MCP `link_modifier_to_menu_item` (encargo 27771e): ligar un extra a un platillo del menú, con vista previa y confirmación,
 * candado de plan sólo para PONER, y nombres ambiguos que se devuelven en vez de adivinar. Desde el 20-nov (founder «B» y «A»,
 * Flautas) un platillo sin inventario también se liga (no descuenta y sólo cuenta en «Dentro de paquete») y el plan es Pro y Premium
 * (`ADVANCED_REPORTS`, el del reporte), ya no sólo Premium.
 */
import { registerMenuTools } from '../../../src/mcp/tools/menu'
import type { McpScope } from '../../../src/mcp/scope'

const mockUpdateModifier = jest.fn()
const mockAudit = jest.fn()
const mockGate = jest.fn()
const modifierFindMany = jest.fn()
const productFindMany = jest.fn()
const productFindFirst = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: (perm: string, v: string) => {
      if (v === 'no-perm') throw new Error(`Forbidden: missing ${perm}`)
    },
  }),
}))
jest.mock('@/services/dashboard/product.dashboard.service', () => ({ updateProduct: jest.fn(), createProduct: jest.fn() }))
jest.mock('@/services/dashboard/menu.dashboard.service', () => ({
  createMenuCategory: jest.fn(),
  createModifierGroup: jest.fn(),
  updateModifier: (...a: unknown[]) => mockUpdateModifier(...(a as [])),
  LIGA_DE_EXTRA_PLAN: { feature: 'ADVANCED_REPORTS', plan: 'Pro' },
  LIGA_QUE_DESCUENTA_PLAN: { feature: 'INVENTORY_TRACKING', plan: 'Premium' },
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/mcp/planGate', () => ({ planGateMessage: (...a: unknown[]) => mockGate(...(a as [])) }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    product: {
      findMany: (...a: unknown[]) => productFindMany(...(a as [])),
      findFirst: (...a: unknown[]) => productFindFirst(...(a as [])),
    },
    modifier: { findMany: (...a: unknown[]) => modifierFindMany(...(a as [])) },
    menuCategory: { findMany: jest.fn(), findFirst: jest.fn() },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('link_modifier_to_menu_item')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

const extraPapas = {
  id: 'mod-papas',
  name: 'Papas',
  groupId: 'g1',
  rawMaterialId: null,
  linkedProductId: null,
  group: { name: 'Acompañantes' },
  linkedProduct: null,
}
const platillo = { id: 'p-papas', name: 'Papas a la francesa', active: true, price: 45, ivaTratamiento: 'IVA_16' }

beforeAll(() => {
  registerMenuTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => {
  jest.clearAllMocks()
  mockGate.mockResolvedValue(null)
  modifierFindMany.mockResolvedValue([extraPapas])
  productFindMany.mockResolvedValue([platillo])
  productFindFirst.mockResolvedValue({ trackInventory: true, inventoryMethod: 'QUANTITY', recipe: null })
  mockUpdateModifier.mockResolvedValue({ id: 'mod-papas' })
})

describe('link_modifier_to_menu_item', () => {
  it('fuera de alcance o sin menu:update no hace nada', async () => {
    await expect(call({ venueId: 'foreign', modifierName: 'Papas', menuItemName: 'Papas' })).rejects.toThrow('out of scope')
    await expect(call({ venueId: 'no-perm', modifierName: 'Papas', menuItemName: 'Papas' })).rejects.toThrow('menu:update')
    expect(mockUpdateModifier).not.toHaveBeenCalled()
  })

  it('sin confirm sólo da la vista previa (de → a) y no escribe', async () => {
    const out = parse(await call({ venueId: 'v1', modifierName: 'Papas', menuItemName: 'Papas a la' }))
    expect(out).toMatchObject({
      ok: false,
      requiresConfirmation: true,
      resolvedModifierId: 'mod-papas',
      resolvedProductId: 'p-papas',
      change: { item: 'Acompañantes › Papas', from: 'no descuenta inventario', to: 'descuenta «Papas a la francesa»' },
    })
    expect(out.message).toMatch(/No contará como venta/)
    expect(mockUpdateModifier).not.toHaveBeenCalled()
  })

  it('con confirm y la huella de la vista previa, liga por el servicio y deja rastro', async () => {
    const preview = parse(await call({ venueId: 'v1', modifierName: 'Papas', menuItemName: 'Papas a la' }))
    const out = parse(
      await call({
        venueId: 'v1',
        modifierName: 'Papas',
        menuItemName: 'Papas a la',
        confirm: true,
        resolvedModifierId: preview.resolvedModifierId,
        resolvedProductId: preview.resolvedProductId,
        expectedSourceFingerprint: preview.expectedSourceFingerprint,
      }),
    )
    expect(out).toEqual({ ok: true, extra: 'Papas', deductsMenuItem: 'Papas a la francesa', deductsInventory: true })
    expect(mockUpdateModifier).toHaveBeenCalledWith('v1', 'g1', 'mod-papas', { linkedProductId: 'p-papas' })
    expect(mockAudit.mock.calls[0][1]).toMatchObject({
      action: 'MODIFIER_LINKED_PRODUCT_SET',
      entityId: 'mod-papas',
      data: { to: 'p-papas' },
    })
  })

  it('confirm con una huella vieja (el extra cambió) no escribe', async () => {
    const out = parse(
      await call({
        venueId: 'v1',
        modifierName: 'Papas',
        menuItemName: 'Papas a la',
        confirm: true,
        resolvedModifierId: 'mod-papas',
        resolvedProductId: 'p-papas',
        expectedSourceFingerprint: 'vieja',
      }),
    )
    expect(out.needsInput).toBe(true)
    expect(mockUpdateModifier).not.toHaveBeenCalled()
  })

  it('sin Pro (plan Gratis) no liga y explica el plan; pide el del reporte, ADVANCED_REPORTS', async () => {
    mockGate.mockResolvedValue('Ligar un extra a un platillo del menú no está incluido en el plan actual…')
    const out = parse(await call({ venueId: 'v1', modifierName: 'Papas', menuItemName: 'Papas' }))
    expect(out).toMatchObject({ ok: false, planRequired: true })
    expect(mockGate).toHaveBeenCalledWith('v1', 'ADVANCED_REPORTS', expect.any(String))
    expect(modifierFindMany).not.toHaveBeenCalled()
  })

  it('quitar el ligado no pide plan', async () => {
    mockGate.mockResolvedValue('sin plan')
    modifierFindMany.mockResolvedValue([{ ...extraPapas, linkedProductId: 'p-papas', linkedProduct: { name: 'Papas a la francesa' } }])
    const out = parse(await call({ venueId: 'v1', modifierName: 'Papas', unlink: true }))
    expect(out).toMatchObject({
      requiresConfirmation: true,
      change: { from: 'descuenta «Papas a la francesa»', to: 'no descuenta inventario' },
    })
    expect(mockGate).not.toHaveBeenCalled()
  })

  it('un nombre que coincide con varios extras devuelve los candidatos (grupo › extra), sin escoger', async () => {
    modifierFindMany.mockResolvedValue([extraPapas, { ...extraPapas, id: 'mod-2', group: { name: 'Combos' } }])
    const out = parse(await call({ venueId: 'v1', modifierName: 'Papas', menuItemName: 'Papas' }))
    expect(out).toMatchObject({ ok: false, ambiguous: true, matches: ['Acompañantes › Papas', 'Combos › Papas'] })
  })

  it('un platillo ambiguo también devuelve los candidatos', async () => {
    productFindMany.mockResolvedValue([platillo, { ...platillo, id: 'p-2', name: 'Papas gajo' }])
    const out = parse(await call({ venueId: 'v1', modifierName: 'Papas', menuItemName: 'Papas' }))
    expect(out).toMatchObject({ ok: false, ambiguous: true, matches: ['Papas a la francesa', 'Papas gajo'] })
  })

  it('un platillo SIN inventario también se liga: la vista previa dice que no descuenta y dónde se cuenta', async () => {
    productFindFirst.mockResolvedValue({ trackInventory: false, inventoryMethod: null, recipe: null })
    const preview = parse(await call({ venueId: 'v1', modifierName: 'Papas', menuItemName: 'Papas a la' }))
    expect(preview).toMatchObject({
      requiresConfirmation: true,
      change: { from: 'no descuenta inventario', to: 'cuenta como «Papas a la francesa» (sin inventario: no descuenta)' },
    })
    expect(preview.message).toMatch(/no lleva inventario/)
    expect(preview.message).toMatch(/Dentro de paquete/)
    expect(productFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'p-papas', venueId: 'v1' } }))
    const out = parse(
      await call({
        venueId: 'v1',
        modifierName: 'Papas',
        menuItemName: 'Papas a la',
        confirm: true,
        resolvedModifierId: preview.resolvedModifierId,
        resolvedProductId: preview.resolvedProductId,
        expectedSourceFingerprint: preview.expectedSourceFingerprint,
      }),
    )
    expect(out).toEqual({ ok: true, extra: 'Papas', deductsMenuItem: 'Papas a la francesa', deductsInventory: false })
    expect(mockUpdateModifier).toHaveBeenCalledWith('v1', 'g1', 'mod-papas', { linkedProductId: 'p-papas' })
  })

  it('Codex r1 #1: un negocio Pro no liga un platillo que DESCONTARÍA (pide Premium); uno sin inventario sí', async () => {
    mockGate.mockImplementation(async (_venueId: string, code: string) =>
      code === 'INVENTORY_TRACKING' ? 'Que el extra descuente el inventario no está incluido en el plan actual…' : null,
    )
    const out = parse(await call({ venueId: 'v1', modifierName: 'Papas', menuItemName: 'Papas a la' }))
    expect(out).toMatchObject({ ok: false, planRequired: true })
    expect(mockGate).toHaveBeenCalledWith('v1', 'INVENTORY_TRACKING', expect.stringContaining('Papas a la francesa'))

    productFindFirst.mockResolvedValue({ trackInventory: false, inventoryMethod: null, recipe: null })
    const sinInventario = parse(await call({ venueId: 'v1', modifierName: 'Papas', menuItemName: 'Papas a la' }))
    expect(sinInventario.requiresConfirmation).toBe(true)
  })

  it('Codex r1 #14: si le prenden el inventario al platillo entre la vista previa y la confirmación, la confirmación ya no vale', async () => {
    productFindFirst.mockResolvedValue({ trackInventory: false, inventoryMethod: null, recipe: null })
    const preview = parse(await call({ venueId: 'v1', modifierName: 'Papas', menuItemName: 'Papas a la' }))
    productFindFirst.mockResolvedValue({ trackInventory: true, inventoryMethod: 'QUANTITY', recipe: null })
    const out = parse(
      await call({
        venueId: 'v1',
        modifierName: 'Papas',
        menuItemName: 'Papas a la',
        confirm: true,
        resolvedModifierId: preview.resolvedModifierId,
        resolvedProductId: preview.resolvedProductId,
        expectedSourceFingerprint: preview.expectedSourceFingerprint,
      }),
    )
    expect(out.needsInput).toBe(true)
    expect(mockUpdateModifier).not.toHaveBeenCalled()
  })

  it('Codex r1 #14: un platillo por kilo se rechaza en la vista previa, sin ofrecer confirmación', async () => {
    productFindFirst.mockResolvedValue({ trackInventory: true, inventoryMethod: 'QUANTITY', soldByWeight: true, recipe: null })
    const out = parse(await call({ venueId: 'v1', modifierName: 'Papas', menuItemName: 'Papas a la' }))
    expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/por kilo/) })
    expect(out.requiresConfirmation).toBeUndefined()
  })

  it('un platillo con receta (sin método marcado) cuenta como que descuenta', async () => {
    productFindFirst.mockResolvedValue({ trackInventory: true, inventoryMethod: null, recipe: { id: 'r1' } })
    const preview = parse(await call({ venueId: 'v1', modifierName: 'Papas', menuItemName: 'Papas a la' }))
    expect(preview.change.to).toBe('descuenta «Papas a la francesa»')
  })

  it('el rechazo del servicio (p. ej. platillo por kilo) llega tal cual', async () => {
    const preview = parse(await call({ venueId: 'v1', modifierName: 'Papas', menuItemName: 'Papas a la' }))
    mockUpdateModifier.mockRejectedValue(new Error('«Papas a la francesa» se vende por kilo: un extra no puede descontarlo.'))
    const out = parse(
      await call({
        venueId: 'v1',
        modifierName: 'Papas',
        menuItemName: 'Papas a la',
        confirm: true,
        resolvedModifierId: preview.resolvedModifierId,
        resolvedProductId: preview.resolvedProductId,
        expectedSourceFingerprint: preview.expectedSourceFingerprint,
      }),
    )
    expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/se vende por kilo/) })
    expect(mockAudit).not.toHaveBeenCalled()
  })
})
