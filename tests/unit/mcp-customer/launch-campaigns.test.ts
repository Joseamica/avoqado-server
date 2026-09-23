/**
 * S11 — las tools de campañas de lanzamiento (spec 2026-09-17 § 3.9).
 *
 * 🔴 Lo que se guarda aquí: que NO aparezcan en el catálogo de un cliente, que un scope que no
 * es superadmin no pueda usarlas aunque las alcance, y que una escritura sin `mcp:write` corte.
 */
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))

import { registerAllTools } from '@/mcp/server'
import { registerLaunchCampaignTools } from '@/mcp/tools/launchCampaigns'
import { ScopeError } from '@/mcp/errors'
import type { McpScope } from '@/mcp/scope'
import { prismaMock } from '@tests/__helpers__/setup'

const NOMBRES = ['list_launch_campaigns', 'get_launch_campaign', 'create_launch_campaign', 'set_launch_campaign_status']

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
