/**
 * S11 — las tools de campañas de lanzamiento (spec 2026-09-17 § 3.9).
 *
 * 🔴 Lo que se guarda aquí: que NO aparezcan en el catálogo de un cliente, que un scope que no
 * es superadmin no pueda usarlas aunque las alcance, y que una escritura sin `mcp:write` corte.
 */
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))

// Planes editables B1 (Task 7): Stripe simulado entero; sin respuesta configurada, una lectura falla (y la prueba que no la
// prepara la atrapa, como antes).
const mockPriceList = jest.fn()
const mockPriceRetrieve = jest.fn()
const mockCouponRetrieve = jest.fn()
const mockCouponCreate = jest.fn()
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    prices: { list: mockPriceList, retrieve: mockPriceRetrieve },
    coupons: { retrieve: mockCouponRetrieve, create: mockCouponCreate, del: jest.fn() },
    subscriptions: { create: jest.fn(), retrieve: jest.fn(), list: jest.fn() },
    paymentMethods: { retrieve: jest.fn() },
  })),
)

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { configureToolCatalog } from '@/mcp/catalog'
import { definicionDePrueba, idsDeLaVersion, punteroA } from '@tests/__helpers__/planOfferFixtures'
import { registerAllTools } from '@/mcp/server'
import { registerLaunchCampaignTools } from '@/mcp/tools/launchCampaigns'
import { ScopeError } from '@/mcp/errors'
import type { McpScope } from '@/mcp/scope'
import { prismaMock } from '@tests/__helpers__/setup'

const NOMBRES = [
  'preview_hybrid_offer',
  'list_launch_campaigns',
  'get_launch_campaign',
  'create_launch_campaign',
  'set_launch_campaign_status',
  'set_launch_campaign_featured',
]

function catalogoPara(scope: Partial<McpScope>) {
  const tools: Array<{ name: string; desc: string }> = []
  const server = { tool: (...a: unknown[]) => tools.push({ name: a[0] as string, desc: typeof a[1] === 'string' ? a[1] : '' }) } as never
  registerAllTools(server, { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map(), ...scope } as McpScope, {
    serializedEnabled: true,
    whiteLabelEnabled: true,
    catalogEnabled: true,
  })
  return tools
}

/** Registra sólo estas tools y devuelve sus handlers, para poder llamarlos. */
function handlersPara(scope: Partial<McpScope>) {
  const handlers = new Map<string, (args: never) => Promise<{ content: Array<{ text: string }> }>>()
  const server = {
    tool: (name: string, _d: string, _s: unknown, handler: (args: never) => Promise<{ content: Array<{ text: string }> }>) =>
      handlers.set(name, handler),
  } as never
  registerLaunchCampaignTools(server, {
    staffId: 's1',
    activeOrg: 'o1',
    allowedVenueIds: [],
    perVenueAccess: new Map(),
    ...scope,
  } as McpScope)
  return handlers
}

const leer = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

describe('catálogo', () => {
  it('🔴 un cliente normal NO las ve', () => {
    const nombres = catalogoPara({ isSuperAdmin: undefined }).map(t => t.name)
    for (const n of NOMBRES) expect(nombres).not.toContain(n)
  })

  it('Avoqado sí las ve', () => {
    const nombres = catalogoPara({ isSuperAdmin: true }).map(t => t.name)
    for (const n of NOMBRES) expect(nombres).toContain(n)
  })

  it('sus descripciones no nombran infraestructura ni modelos internos', () => {
    // Mismo criterio que `catalog-no-internals.test.ts`, aplicado a estas cuatro.
    const PROHIBIDO = /\bprisma\b|\bpostgres(ql)?\b|findMany|findUnique|\$transaction|\bStripe\b|LaunchCampaignRedemption/i
    for (const t of catalogoPara({ isSuperAdmin: true }).filter(t => NOMBRES.includes(t.name))) {
      expect(t.desc).not.toMatch(PROHIBIDO)
    }
  })
})

describe('defensa doble en los handlers', () => {
  it('la vista previa híbrida acepta un token de lectura y mantiene pesos en entrada y salida', async () => {
    const handlers = handlersPara({ isSuperAdmin: true, scopes: ['mcp:read'] })
    const result = leer(
      await handlers.get('preview_hybrid_offer')!({
        offer: {
          schemaVersion: 1,
          kind: 'CHOICE_BUNDLE',
          eligibleFeatureCodes: ['CFDI'],
          choiceCount: 1,
          terms: {
            currency: 'MXN',
            interval: 'MONTHLY',
            price: 149.9,
            taxIncluded: true,
            promotionCycles: null,
            renewal: { kind: 'SAME_PRICE' },
          },
        },
        selectedFeatureCodes: ['CFDI'],
      } as never),
    )
    expect(result).toMatchObject({
      mode: 'PREVIEW_ONLY',
      purchaseAvailable: false,
      selection: { valid: true },
      terms: { price: 149.9 },
      overlaps: [],
    })
    expect(JSON.stringify(result)).not.toContain('Cents')
    expect(prismaMock.launchCampaign.create).not.toHaveBeenCalled()
    expect(prismaMock.venueFeature.create).not.toHaveBeenCalled()
  })

  it('🔴 un scope que no es superadmin recibe un error, aunque alcance el handler', async () => {
    const handlers = handlersPara({ isSuperAdmin: undefined })
    for (const nombre of NOMBRES) {
      const r = leer(await handlers.get(nombre)!({ code: 'POS22', action: 'pause', reason: 'x', limit: 5 } as never))
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/Solo Avoqado/)
    }
    expect(prismaMock.launchCampaign.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.launchCampaign.create).not.toHaveBeenCalled()
  })

  it('🔴 sin `mcp:write` una escritura CORTA, aunque el token sea de Avoqado', async () => {
    const handlers = handlersPara({ isSuperAdmin: true, scopes: ['mcp:read'] })
    await expect(
      handlers.get('set_launch_campaign_status')!({ code: 'POS22', action: 'pause', reason: 'motivo', confirm: true } as never),
    ).rejects.toBeInstanceOf(ScopeError)
    expect(prismaMock.launchCampaign.updateMany).not.toHaveBeenCalled()
  })
})

describe('confirmación de dos pasos', () => {
  it('🔴 `set_launch_campaign_status` SIN confirm no escribe nada', async () => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue({
      id: 'lc-1',
      code: 'POS22',
      status: 'ACTIVE',
      redemptionCount: 3,
      redemptionCap: 100,
      planTier: 'PRO',
      advertisedPriceCents: 2200,
      discountMonths: 3,
      offerVersion: 1,
    } as never)

    const handlers = handlersPara({ isSuperAdmin: true, scopes: ['mcp:write'] })
    const r = leer(
      await handlers.get('set_launch_campaign_status')!({ code: 'POS22', action: 'pause', reason: 'se acabó el presupuesto' } as never),
    )

    expect(r).toMatchObject({ requiresConfirmation: true, actual: 'ACTIVE', siguiente: 'PAUSED', cupoTomado: '3 / 100' })
    expect(prismaMock.launchCampaign.updateMany).not.toHaveBeenCalled()
  })

  it('pausar o terminar SIN motivo se rechaza antes de tocar nada', async () => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue({ id: 'lc-1', code: 'POS22', status: 'ACTIVE' } as never)
    const handlers = handlersPara({ isSuperAdmin: true, scopes: ['mcp:write'] })

    const r = leer(await handlers.get('set_launch_campaign_status')!({ code: 'POS22', action: 'end', confirm: true } as never))
    expect(r.ok).toBe(false)
    expect(prismaMock.launchCampaign.updateMany).not.toHaveBeenCalled()
  })

  it('🔴 `create_launch_campaign` sin confirm sólo cotiza: cero escrituras', async () => {
    const handlers = handlersPara({ isSuperAdmin: true, scopes: ['mcp:write'] })
    // `previewLaunchOffer` lee el precio de Stripe; el SDK está mockeado en este proyecto por
    // el setup de pruebas, así que una llamada real es imposible.
    const r = await handlers.get('create_launch_campaign')!({
      code: 'POS22',
      name: 'POS $22',
      landingSlug: 'pos-22',
      planTier: 'PRO',
      advertisedPriceCents: 2200,
      discountMonths: 3,
      redemptionCap: 100,
      validFrom: '2026-09-01T00:00:00Z',
      validUntil: '2026-12-01T00:00:00Z',
    } as never).catch(() => null)

    // Pase lo que pase con la cotización, lo que NO puede haber es una escritura.
    expect(prismaMock.launchCampaign.create).not.toHaveBeenCalled()
    if (r) expect(leer(r)).toMatchObject({ requiresConfirmation: true })
  })
})

/**
 * La vitrina del giro desde el MCP: qué campaña enseña la página de un giro sin slug en la URL
 * (hoy `/restaurants`). Cambia lo que ve el público ⇒ va en dos pasos y la vista previa dice a
 * QUIÉN le quita la vitrina.
 */
describe('set_launch_campaign_featured', () => {
  const VISTA = new Date('2026-09-24T10:00:00Z')
  const ficha = (o: Record<string, unknown> = {}) => ({
    id: 'lc-1',
    code: 'POS22MX',
    name: 'POS $22',
    landingSlug: 'pos-22-mx',
    vertical: 'FOOD_SERVICE',
    featuredForVertical: false,
    status: 'ACTIVE',
    activatedAt: VISTA,
    redemptionCount: 0,
    redemptionCap: 100,
    validFrom: new Date('2026-09-01T00:00:00Z'),
    validUntil: new Date('2026-12-31T00:00:00Z'),
    updatedAt: VISTA,
    ...o,
  })

  it('🔴 SIN confirm no escribe, y dice qué campaña pierde la vitrina', async () => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(ficha() as never)
    prismaMock.launchCampaign.findFirst.mockResolvedValue({ code: 'META25', name: 'Meta $25' } as never)
    const handlers = handlersPara({ isSuperAdmin: true, scopes: ['mcp:write'] })

    const r = leer(await handlers.get('set_launch_campaign_featured')!({ code: 'pos22mx', featured: true } as never))

    expect(r).toMatchObject({ requiresConfirmation: true, giro: 'FOOD_SERVICE', ocupaHoy: 'META25', ocupara: 'POS22MX' })
    expect(prismaMock.launchCampaign.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.launchCampaign.update).not.toHaveBeenCalled()
  })

  it('con confirm pasa por el MISMO servicio que el superadmin (CAS + exclusividad por giro)', async () => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(ficha() as never)
    prismaMock.launchCampaign.findFirst.mockResolvedValue(null as never)
    prismaMock.launchCampaign.updateMany.mockResolvedValue({ count: 1 } as never)
    prismaMock.launchCampaign.findUniqueOrThrow.mockResolvedValue(ficha({ featuredForVertical: true }) as never)
    const handlers = handlersPara({ isSuperAdmin: true, scopes: ['mcp:write'] })

    const r = leer(await handlers.get('set_launch_campaign_featured')!({ code: 'POS22MX', featured: true, confirm: true } as never))

    expect(r).toMatchObject({ ok: true, codigo: 'POS22MX', vitrina: true })
    expect(prismaMock.launchCampaign.updateMany).toHaveBeenCalledWith({
      where: { id: 'lc-1', updatedAt: VISTA },
      data: expect.objectContaining({ featuredForVertical: true }),
    })
  })

  it('🔴 sin `mcp:write` corta aunque el token sea de Avoqado', async () => {
    const handlers = handlersPara({ isSuperAdmin: true, scopes: ['mcp:read'] })
    await expect(
      handlers.get('set_launch_campaign_featured')!({ code: 'POS22MX', featured: true, confirm: true } as never),
    ).rejects.toBeInstanceOf(ScopeError)
    expect(prismaMock.launchCampaign.updateMany).not.toHaveBeenCalled()
  })
})

/**
 * Planes editables B1 (Task 7, b1-r4 #4): la vista previa de ACTIVAR dice el precio de lista que vio (en PESOS) y el token de
 * confirmación lo ata. Si al confirmar el precio de lista ya es otro (se publicó un mensual nuevo), la activación responde
 * 409 `LAUNCH_CAMPAIGN_PREVIEW_STALE` antes de tocar el cupón: nunca se confirma una campaña con otra renovación.
 * Por `tools/call` real, con `configureToolCatalog` y el token que firma el catálogo.
 */
describe('set_launch_campaign_status: la vista previa de activar ata el precio de lista', () => {
  const LISTA = 115884
  const NETO_NUEVO = 129900
  const LISTA_NUEVA = Math.round((NETO_NUEVO * 116) / 100) // 150684
  const scope = {
    staffId: 'cm32345678901234567890123',
    activeOrg: 'cm42345678901234567890123',
    allowedVenueIds: [],
    perVenueAccess: new Map(),
    isSuperAdmin: true,
    scopes: ['mcp:read', 'mcp:write'],
  } as unknown as McpScope
  const borrador = {
    id: 'lc-1',
    code: 'POS22',
    name: 'POS $22',
    landingSlug: 'pos-22',
    vertical: 'ALL',
    channel: null,
    featuredForVertical: false,
    planTier: 'PRO',
    billingInterval: 'MONTHLY',
    advertisedPriceCents: 2200,
    discountMonths: 3,
    currency: 'MXN',
    offerVersion: 1,
    listPriceCentsSnapshot: null,
    discountAmountCents: null,
    stripePriceId: null,
    stripeCouponId: null,
    validFrom: new Date('2026-09-01T00:00:00Z'),
    validUntil: new Date('2099-01-01T00:00:00Z'),
    redemptionCap: 100,
    redemptionCount: 0,
    headline: null,
    subheadline: null,
    bullets: [],
    status: 'DRAFT',
    statusReason: null,
    activatedAt: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
  }
  const precio = (id: string, unitAmount: number) => ({
    id,
    active: true,
    product: 'prod_plan_pro',
    currency: 'mxn',
    recurring: { interval: 'month', interval_count: 1 },
    tax_behavior: 'inclusive',
    unit_amount: unitAmount,
  })

  let server: McpServer
  let client: Client
  beforeEach(async () => {
    mockPriceList.mockReset().mockResolvedValue({ data: [precio('price_key_pro_m', LISTA)] })
    mockPriceRetrieve.mockReset()
    mockCouponRetrieve.mockReset().mockRejectedValue(Object.assign(new Error('No such coupon'), { code: 'resource_missing' }))
    mockCouponCreate.mockReset().mockImplementation(async (b: Record<string, unknown>) => b)
    prismaMock.planOfferPointer.findUnique.mockReset().mockResolvedValue(null)
    prismaMock.launchCampaign.findUnique.mockReset().mockResolvedValue(borrador as never)
    prismaMock.launchCampaign.updateMany.mockReset().mockResolvedValue({ count: 1 } as never)
    prismaMock.launchCampaign.findUniqueOrThrow.mockReset().mockResolvedValue({ ...borrador, status: 'ACTIVE' } as never)
    server = new McpServer({ name: 'campanas', version: '1' })
    configureToolCatalog(server, scope)
    registerLaunchCampaignTools(server, scope)
    client = new Client({ name: 'prueba', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
  })
  afterEach(async () => {
    await client.close()
    await server.close()
  })
  const llamar = async (args: Record<string, unknown>) => {
    const r = await client.callTool({ name: 'set_launch_campaign_status', arguments: args })
    return JSON.parse((r.content as Array<{ text: string }>)[0].text)
  }

  it('🔴 vista previa de activar con lista 1158.84; se publica un mensual mayor; confirmar con el mismo token → { ok: false, codigo: LAUNCH_CAMPAIGN_PREVIEW_STALE }, la campaña sigue en borrador y no se crea cupón', async () => {
    const vista = await llamar({ code: 'POS22', action: 'activate' })
    expect(vista).toMatchObject({ requiresConfirmation: true, expectedListPrice: 1158.84 })
    expect(vista.confirmationArguments).toMatchObject({ code: 'POS22', action: 'activate', expectedListPrice: 1158.84 })

    // Entre la vista previa y la confirmación se publica la v2 con un mensual de Pro mayor.
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(
      punteroA('cv2', 2, definicionDePrueba({ ids: idsDeLaVersion('v2'), netos: { 'PRO:monthly': NETO_NUEVO } })) as never,
    )
    mockPriceRetrieve.mockResolvedValue(precio('price_v2_pro_m', LISTA_NUEVA))

    const r = await llamar({ ...vista.confirmationArguments, confirm: true, confirmationToken: vista.confirmationToken })

    expect(r).toMatchObject({ ok: false, codigo: 'LAUNCH_CAMPAIGN_PREVIEW_STALE' })
    expect(typeof r.error).toBe('string')
    expect(mockCouponRetrieve).not.toHaveBeenCalled()
    expect(mockCouponCreate).not.toHaveBeenCalled()
    expect(prismaMock.launchCampaign.updateMany).not.toHaveBeenCalled()
  })

  it('la vista previa devuelve expectedListPrice y el token lo ata: confirmar con otro valor pide una vista previa vigente', async () => {
    const vista = await llamar({ code: 'POS22', action: 'activate' })
    expect(vista.expectedListPrice).toBe(1158.84)

    const otro = await llamar({
      ...vista.confirmationArguments,
      expectedListPrice: 1506.84,
      confirm: true,
      confirmationToken: vista.confirmationToken,
    })
    expect(otro).toMatchObject({ ok: false, needsInput: true, field: 'confirmationToken' })
    // Tampoco sin el valor atado.
    const sinPrecio = { ...vista.confirmationArguments }
    delete sinPrecio.expectedListPrice
    const sin = await llamar({ ...sinPrecio, confirm: true, confirmationToken: vista.confirmationToken })
    expect(sin).toMatchObject({ ok: false, needsInput: true, field: 'confirmationToken' })
    expect(prismaMock.launchCampaign.updateMany).not.toHaveBeenCalled()

    // Con lo firmado, se activa: el servicio recibe el precio en centavos (la conversión es del borde de la herramienta).
    const bien = await llamar({ ...vista.confirmationArguments, confirm: true, confirmationToken: vista.confirmationToken })
    expect(bien).toMatchObject({ ok: true, estado: 'ACTIVE' })
    expect(mockCouponCreate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'LC_POS22_V1', amount_off: LISTA - 2200 }),
      expect.anything(),
    )
  })
})
