import type { McpScope } from '@/mcp/scope'
const board = jest.fn(),
  save = jest.fn(),
  gapSummary = jest.fn(),
  gapVenues = jest.fn(),
  preview = jest.fn(),
  create = jest.fn(),
  group = jest.fn(),
  groupStatus = jest.fn()
jest.mock('@/services/launchCampaigns/hybridListPrice.service', () => ({
  ...jest.requireActual('@/services/launchCampaigns/hybridListPrice.service'),
  listPriceBoard: (...args: unknown[]) => board(...args),
  saveListPrice: (...args: unknown[]) => save(...args),
}))
jest.mock('@/services/launchCampaigns/hybridPriceGap.service', () => ({
  ...jest.requireActual('@/services/launchCampaigns/hybridPriceGap.service'),
  priceGapSummary: (...args: unknown[]) => gapSummary(...args),
  priceGapVenues: (...args: unknown[]) => gapVenues(...args),
}))
jest.mock('@/services/launchCampaigns/hybridPromotionGroup.service', () => ({
  ...jest.requireActual('@/services/launchCampaigns/hybridPromotionGroup.service'),
  previewPercentPromotion: (...args: unknown[]) => preview(...args),
  createPercentPromotion: (...args: unknown[]) => create(...args),
  getPromotionGroup: (...args: unknown[]) => group(...args),
  setPromotionGroupStatus: (...args: unknown[]) => groupStatus(...args),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))
import { registerAllTools } from '@/mcp/server'
import { registerLaunchCampaignTools } from '@/mcp/tools/launchCampaigns'
import { registerHybridBillingTools } from '@/mcp/tools/hybridBilling'
import { auditMcpWrite } from '@/mcp/audit'
import { ConflictError } from '@/errors/AppError'

const TOOLS = [
  'list_prices',
  'set_feature_list_price',
  'price_gap_report',
  'preview_percent_promotion',
  'create_percent_promotion',
  'set_promotion_group_status',
]
const superadmin = {
  staffId: 'staff',
  activeOrg: 'org',
  allowedVenueIds: [],
  perVenueAccess: new Map(),
  scopes: ['mcp:write'],
  isSuperAdmin: true,
} as unknown as McpScope
type Handler = (args: any) => Promise<any>
function toolsFor(overrides: Partial<McpScope> = {}) {
  const handlers = new Map<string, Handler>()
  const descriptions = new Map<string, string>()
  const server = {
    tool: (...args: any[]) => {
      handlers.set(args[0], args[args.length - 1])
      descriptions.set(args[0], args[1])
    },
  } as any
  registerLaunchCampaignTools(server, { ...superadmin, ...overrides })
  registerHybridBillingTools(server, { ...superadmin, ...overrides })
  return { handlers, descriptions }
}
const call = (name: string, args: object, overrides: Partial<McpScope> = {}) => toolsFor(overrides).handlers.get(name)!(args)
const read = (value: any) => JSON.parse(value.content[0].text)
const cfdi = {
  productKey: 'FEATURE:CFDI',
  featureCode: 'CFDI',
  planTier: null,
  name: 'Facturación electrónica',
  category: 'fiscal',
  minimumTier: 'PREMIUM',
  editable: true,
  notEditableReason: null,
  campaignId: 'list-cfdi',
  revision: 3,
  status: 'ACTIVE',
  price: 199,
  pendingPrice: null,
  activeGroups: [] as { id: string; name: string; revision: number }[],
}
const percentBody = {
  name: 'Septiembre 20 %',
  percentOff: 20,
  target: { kind: 'FEATURES', featureCodes: ['CFDI'] },
  startsAt: new Date(Date.now() + 3600000).toISOString(),
  endsAt: new Date(Date.now() + 30 * 86400000).toISOString(),
  promotionCycles: 3,
  capacityPerFeature: 10,
}

beforeEach(() => {
  jest.clearAllMocks()
  board.mockResolvedValue([cfdi, { ...cfdi, productKey: 'FEATURE:BASE_POS', editable: false, price: null, campaignId: null }])
  gapSummary.mockResolvedValue([{ productKey: 'FEATURE:CFDI', venues: 12, monthlyGap: '1200.50', aboveListVenues: 1, bundleVenues: 2 }])
  save.mockResolvedValue({ ...cfdi, price: 249, revision: 5 })
  preview.mockResolvedValue({
    creatable: true,
    rows: [
      { featureCode: 'CFDI', name: 'Facturación electrónica', listPrice: 599, price: 479.2, renewalPrice: 599, status: 'OK', requires: [] },
    ],
  })
  create.mockResolvedValue({ groupId: 'group-1', campaignIds: ['c1'] })
  group.mockResolvedValue({
    id: 'group-1',
    name: 'Septiembre 20 %',
    percentOff: 20,
    status: 'PAUSED',
    revision: 2,
    campaigns: [
      { id: 'c1', name: 'Septiembre 20 % · Facturación', status: 'PAUSED', publication: { definition: { terms: { price: 479.2 } } } },
    ],
  })
  groupStatus.mockResolvedValue({ id: 'group-1', status: 'ACTIVE', revision: 3 })
})

describe('list prices and «% de descuento» from the customer MCP (superadmin only)', () => {
  it('a customer catalog never lists them; Avoqado sees all six', () => {
    const names = (scope: Partial<McpScope>) => {
      const list: string[] = []
      registerAllTools({ tool: (...a: unknown[]) => list.push(a[0] as string) } as never, { ...superadmin, ...scope } as McpScope, {
        serializedEnabled: true,
        whiteLabelEnabled: true,
        catalogEnabled: true,
      })
      return list
    }
    const customer = names({ isSuperAdmin: undefined })
    for (const name of TOOLS) expect(customer).not.toContain(name)
    expect(names({})).toEqual(expect.arrayContaining(TOOLS))
  })

  it('every tool refuses a scope that is not Avoqado, without touching a service', async () => {
    for (const name of TOOLS) {
      const result = read(
        await call(name, { productKey: 'FEATURE:CFDI', price: 249, expectedRevision: 3, confirm: true }, { isSuperAdmin: false }),
      )
      expect(result).toEqual({ ok: false, error: expect.stringMatching(/^Solo Avoqado/) })
    }
    for (const fn of [board, save, gapSummary, gapVenues, preview, create, group, groupStatus]) expect(fn).not.toHaveBeenCalled()
  })

  it('set_feature_list_price without confirm shows current → new and writes nothing', async () => {
    const result = read(await call('set_feature_list_price', { productKey: 'FEATURE:CFDI', price: 249, expectedRevision: 3 }))
    expect(result).toMatchObject({
      ok: false,
      requiresConfirmation: true,
      preview: { producto: 'FEATURE:CFDI', nombre: 'Facturación electrónica', precioActual: 199, precioNuevo: 249 },
    })
    expect(result.mensaje).toMatch(/\$199\.00 → \$249\.00/)
    expect(result.mensaje).not.toMatch(/Descuentos activos/)
    expect(save).not.toHaveBeenCalled()
    expect(auditMcpWrite).not.toHaveBeenCalled()
  })

  it('set_feature_list_price without confirm names the % groups on sale over it, to recalculate after saving', async () => {
    board.mockResolvedValue([{ ...cfdi, activeGroups: [{ id: 'group-1', name: 'Septiembre 20 %', revision: 4 }] }])
    const result = read(await call('set_feature_list_price', { productKey: 'FEATURE:CFDI', price: 249, expectedRevision: 3 }))
    expect(result.preview.descuentosActivos).toEqual([{ id: 'group-1', name: 'Septiembre 20 %', revision: 4 }])
    expect(result.mensaje).toMatch(/Descuentos activos que la abarcan: «Septiembre 20 %»; después de guardar, recalcúlalos/)
  })

  it('set_feature_list_price with confirm saves through the same operation as the screen and audits it', async () => {
    const result = read(
      await call('set_feature_list_price', { productKey: 'FEATURE:CFDI', price: 249, expectedRevision: 3, confirm: true }),
    )
    expect(save).toHaveBeenCalledWith({ productKey: 'FEATURE:CFDI', price: 249, expectedRevision: 3 }, 'staff')
    expect(result).toMatchObject({ ok: true, precio: { precioLista: 249, revision: 5 } })
    expect(auditMcpWrite).toHaveBeenCalledWith(
      expect.objectContaining({ staffId: 'staff' }),
      expect.objectContaining({ venueId: null, action: 'MCP_HYBRID_LIST_PRICE_SAVED', entityId: 'list-cfdi' }),
    )
  })

  it('a list that would break promotions comes back with the promotions to pause', async () => {
    const violations = [{ campaignId: 'c1', campaignName: 'CFDI 20 %', price: 479.2, renewalPrice: 599, listPrice: 450 }]
    save.mockRejectedValue(new ConflictError('Rompe promociones.', 'HYBRID_LIST_BREAKS_PROMOTIONS', violations))
    const result = read(
      await call('set_feature_list_price', { productKey: 'FEATURE:CFDI', price: 450, expectedRevision: 3, confirm: true }),
    )
    expect(result).toEqual({ ok: false, error: 'Rompe promociones.', codigo: 'HYBRID_LIST_BREAKS_PROMOTIONS', detalles: violations })
    expect(auditMcpWrite).not.toHaveBeenCalled()
  })

  it('a read-only connection cannot change a price even with confirm', async () => {
    await expect(
      call(
        'set_feature_list_price',
        { productKey: 'FEATURE:CFDI', price: 249, expectedRevision: 3, confirm: true },
        { scopes: ['mcp:read'] },
      ),
    ).rejects.toThrow(/solo lectura/)
    expect(save).not.toHaveBeenCalled()
  })

  it('list_prices reads each product in pesos, with its previous-rate warning', async () => {
    const result = read(await call('list_prices', {}))
    expect(result.ok).toBe(true)
    expect(result.productos[0]).toMatchObject({
      producto: 'FEATURE:CFDI',
      precioLista: 199,
      estado: 'ACTIVE',
      descuentosActivos: [],
      tarifaAnterior: { negocios: 12, diferenciaMensual: 1200.5, negociosPaganMas: 1, negociosEnPaquetes: 2 },
    })
    expect(result.productos[1]).toMatchObject({ producto: 'FEATURE:BASE_POS', editable: false, tarifaAnterior: null })
  })

  it('price_gap_report sums per product, or pages who pays less for one product', async () => {
    expect(read(await call('price_gap_report', {})).resumen[0]).toMatchObject({ diferenciaMensual: 1200.5, negocios: 12 })
    gapVenues.mockResolvedValue({
      total: 51,
      items: [
        {
          contractId: 'k1',
          venueId: 'v1',
          venueName: 'Café',
          organizationName: 'Org',
          rate: '479.20',
          listPrice: '599.00',
          gap: '119.80',
          since: '2026-09-01T00:00:00.000Z',
          reason: 'PROMO_FOREVER',
          reasonUntil: null,
        },
      ],
    })
    const page = read(await call('price_gap_report', { productKey: 'FEATURE:CFDI', page: 2 }))
    expect(gapVenues).toHaveBeenCalledWith('FEATURE:CFDI', 2, 50)
    expect(page).toMatchObject({ ok: true, total: 51, pagina: 2, paginas: 2 })
    expect(page.contratos[0]).toMatchObject({
      negocio: 'Café',
      tarifa: 479.2,
      precioLista: 599,
      diferencia: 119.8,
      motivo: 'PROMO_FOREVER',
    })
  })

  it('create_percent_promotion previews per function before creating; with confirm it creates and audits', async () => {
    const first = read(await call('create_percent_promotion', percentBody))
    expect(first).toMatchObject({ ok: false, requiresConfirmation: true })
    expect(first.preview.funciones[0]).toMatchObject({ precioLista: 599, precioConDescuento: 479.2, renovacion: 599 })
    expect(preview).toHaveBeenCalledWith(percentBody)
    expect(create).not.toHaveBeenCalled()
    const done = read(await call('create_percent_promotion', { ...percentBody, confirm: true }))
    expect(create).toHaveBeenCalledWith(percentBody, 'staff')
    expect(done).toMatchObject({ ok: true, groupId: 'group-1' })
    expect(auditMcpWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ venueId: null, action: 'MCP_HYBRID_PERCENT_PROMOTION_CREATED', entityId: 'group-1' }),
    )
  })

  it('preview_percent_promotion only previews', async () => {
    expect(read(await call('preview_percent_promotion', percentBody))).toMatchObject({ ok: true, creatable: true })
    expect(create).not.toHaveBeenCalled()
  })

  it('set_promotion_group_status shows the group current → new before changing every campaign at once', async () => {
    const first = read(await call('set_promotion_group_status', { groupId: 'group-1', status: 'ACTIVE', expectedRevision: 2 }))
    expect(first).toMatchObject({
      ok: false,
      requiresConfirmation: true,
      preview: { nombre: 'Septiembre 20 %', estadoActual: 'PAUSED', nuevoEstado: 'ACTIVE' },
    })
    expect(groupStatus).not.toHaveBeenCalled()
    await call('set_promotion_group_status', { groupId: 'group-1', status: 'ACTIVE', expectedRevision: 2, confirm: true })
    expect(groupStatus).toHaveBeenCalledWith('group-1', { status: 'ACTIVE', expectedRevision: 2 }, 'staff')
    expect(auditMcpWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ venueId: null, action: 'MCP_HYBRID_PROMOTION_GROUP_STATUS', entityId: 'group-1' }),
    )
  })

  it('descriptions speak the operator language, and the existing tools describe the list price', () => {
    const { descriptions } = toolsFor()
    for (const name of TOOLS) expect(descriptions.get(name)).not.toMatch(/prisma|Hybrid[A-Z]|ActivityLog|listProductKey|productKey/)
    expect(descriptions.get('venue_feature_grid')).toMatch(/incluye precio de lista y la alternativa de lista/)
    expect(descriptions.get('get_hybrid_campaign')).not.toMatch(/última versión publicada/)
  })
})
