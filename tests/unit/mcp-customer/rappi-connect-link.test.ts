/**
 * rappi_connect_link (self-onboarding de Rappi, 2026-09-29): el MISMO enlace que
 * `GET /venues/:venueId/channels/rappi/connect-url`, con las mismas guardas
 * (delivery-channels:manage + DELIVERY_CHANNELS/PREMIUM). El `staffId` del intent es quien
 * está conectado al MCP: el callback público revalida a ESE usuario en cada paso.
 */
import { registerDeliveryChannelTools } from '../../../src/mcp/tools/deliveryChannels'
import type { McpScope } from '../../../src/mcp/scope'

const mockHasFeatureAccess = jest.fn()
const mockRequirePermission = jest.fn()
const mockCrearIntent = jest.fn()
const mockAudit = jest.fn()

jest.mock('@/services/access/basePlan.service', () => ({
  venueHasFeatureAccess: (...a: unknown[]) => mockHasFeatureAccess(...(a as [])),
}))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => ({ venueId: { in: [v] } }),
    requirePermission: (...a: unknown[]) => mockRequirePermission(...(a as [])),
  }),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: {} }))
const mockPreflight = jest.fn()
jest.mock('@/services/delivery-channels/providers/rappi/rappi.client', () => ({
  preflightSelfOnboardingRappi: () => mockPreflight(),
}))
jest.mock('@/services/delivery-channels/providers/rappi/rappi.connect', () => ({
  depsDesdeEnv: async () => ({ llave: 'k', ambiente: 'sandbox', clientId: 'c' }),
  crearIntentRappi: (...a: unknown[]) => mockCrearIntent(...(a as [])),
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('rappi_connect_link')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerDeliveryChannelTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => {
  jest.clearAllMocks()
  mockHasFeatureAccess.mockResolvedValue(true)
  mockCrearIntent.mockResolvedValue({ id: 'intent1', firmado: 'firmado+/=' })
  mockPreflight.mockReturnValue('https://api.avoqado.test')
})

describe('rappi_connect_link', () => {
  it('sin el permiso delivery-channels:manage se rechaza y NO se crea ningún intent', async () => {
    mockRequirePermission.mockImplementationOnce(() => {
      throw new Error('Missing permission delivery-channels:manage for venue v1')
    })
    await expect(call({ venueId: 'v1' })).rejects.toThrow('Missing permission')
    expect(mockRequirePermission).toHaveBeenCalledWith('delivery-channels:manage', 'v1')
    expect(mockCrearIntent).not.toHaveBeenCalled()
  })

  it('sin el plan PREMIUM devuelve planRequired y NO se crea ningún intent', async () => {
    mockHasFeatureAccess.mockResolvedValueOnce(false)
    const out = parse(await call({ venueId: 'v1' }))
    expect(out).toMatchObject({ ok: false, planRequired: true, feature: 'DELIVERY_CHANNELS' })
    expect(mockCrearIntent).not.toHaveBeenCalled()
  })

  // F2: la misma guarda que el REST — sin la base de webhooks, Rappi aprovisionaba una tienda que no recibe pedidos.
  it('con la configuración de Rappi incompleta se niega y NO crea el intent ni audita', async () => {
    mockPreflight.mockImplementationOnce(() => {
      throw new Error('Falta RAPPI_WEBHOOK_BASE_URL')
    })
    await expect(call({ venueId: 'v1' })).rejects.toMatchObject({ statusCode: 500, code: 'RAPPI_CONNECT_NOT_CONFIGURED' })
    expect(mockCrearIntent).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('camino feliz: entrega el enlace firmado a nombre de quien pide y lo audita', async () => {
    const out = parse(await call({ venueId: 'v1' }))
    expect(out.ok).toBe(true)
    expect(out.url).toBe('https://api.avoqado.test/api/v1/delivery/rappi/oauth/start?intent=firmado%2B%2F%3D')
    expect(out.venceEnMinutos).toBe(10)
    expect(out.instrucciones).toMatch(/10 minutos/)
    expect(mockCrearIntent).toHaveBeenCalledWith(expect.anything(), { venueId: 'v1', staffId: 's1' })
    expect(mockAudit).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ action: 'RAPPI_CONNECT_LINK_CREATED', entityId: 'intent1', venueId: 'v1' }),
    )
  })
})
