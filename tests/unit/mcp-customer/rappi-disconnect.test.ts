/**
 * rappi_disconnect (Rappi fase 3): el MISMO servicio que `POST .../channels/:linkId/disconnect`, con las mismas guardas
 * (delivery-channels:manage + DELIVERY_CHANNELS/PREMIUM) y en dos pasos: vista previa sin escribir → confirm:true con el
 * conexionId de la vista previa. Sólo en el MCP libre, nunca en el certificado.
 */
import { registerDeliveryChannelTools } from '../../../src/mcp/tools/deliveryChannels'
import type { McpScope } from '../../../src/mcp/scope'
import { TOOL_EFFECTS } from '../../../src/mcp/catalog'
import { DIRECTORY_TIERS } from '../../../src/mcp/directory/catalog'

const mockHasFeatureAccess = jest.fn()
const mockRequirePermission = jest.fn()
const mockAudit = jest.fn()
const mockFindFirst = jest.fn()
const mockDesconectar = jest.fn()
const mockContar = jest.fn()

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
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { deliveryChannelLink: { findFirst: (...a: unknown[]) => mockFindFirst(...(a as [])) } },
}))
jest.mock('@/services/delivery-channels/providers/rappi/rappi.desconectar', () => ({
  conexionIdDe: (l: { externalLocationId: string }) => `i1:${l.externalLocationId}`,
  contarPedidosEnCurso: (...a: unknown[]) => mockContar(...(a as [])),
  desconectarTiendaRappi: (...a: unknown[]) => mockDesconectar(...(a as [])),
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('rappi_disconnect')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)
const LINK = { id: 'l1', provider: 'RAPPI', status: 'ACTIVE', externalLocationId: '900', externalAccountId: 'Tacos QA', config: {} }

beforeAll(() => {
  registerDeliveryChannelTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => {
  jest.clearAllMocks()
  mockHasFeatureAccess.mockResolvedValue(true)
  mockFindFirst.mockResolvedValue(LINK)
  mockContar.mockResolvedValue(new Map([['l1', 0]]))
  mockDesconectar.mockResolvedValue({ link: { ...LINK, status: 'DISABLED' }, yaEstaba: false, forzada: false })
})

describe('rappi_disconnect', () => {
  it('sin el permiso delivery-channels:manage se rechaza y no lee ni escribe', async () => {
    mockRequirePermission.mockImplementationOnce(() => {
      throw new Error('Missing permission delivery-channels:manage for venue v1')
    })
    await expect(call({ venueId: 'v1', linkId: 'l1' })).rejects.toThrow('Missing permission')
    expect(mockRequirePermission).toHaveBeenCalledWith('delivery-channels:manage', 'v1')
    expect(mockDesconectar).not.toHaveBeenCalled()
  })

  it('sin el plan PREMIUM devuelve planRequired y no desconecta', async () => {
    mockHasFeatureAccess.mockResolvedValueOnce(false)
    expect(parse(await call({ venueId: 'v1', linkId: 'l1', confirm: true, conexionId: 'i1:900' }))).toMatchObject({
      ok: false,
      planRequired: true,
    })
    expect(mockDesconectar).not.toHaveBeenCalled()
  })

  it('sin confirm devuelve la vista previa con el conexionId y no escribe', async () => {
    const out = parse(await call({ venueId: 'v1', linkId: 'l1' }))
    expect(out).toMatchObject({
      ok: false,
      requiresConfirmation: true,
      tienda: 'Tacos QA',
      storeId: '900',
      estado: 'ACTIVE',
      pedidosEnCurso: 0,
      conexionId: 'i1:900',
    })
    expect(mockFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'l1', venueId: 'v1' } }))
    expect(mockDesconectar).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('confirm:true sin conexionId sigue siendo sólo vista previa', async () => {
    expect(parse(await call({ venueId: 'v1', linkId: 'l1', confirm: true })).requiresConfirmation).toBe(true)
    expect(mockDesconectar).not.toHaveBeenCalled()
  })

  it('con confirm:true y conexionId llama al servicio con origen MCP y lo audita', async () => {
    const out = parse(await call({ venueId: 'v1', linkId: 'l1', confirm: true, conexionId: 'i1:900', forzar: true }))
    expect(out).toMatchObject({ ok: true, estado: 'DISABLED', yaEstaba: false })
    expect(mockDesconectar).toHaveBeenCalledWith({
      venueId: 'v1',
      linkId: 'l1',
      conexionId: 'i1:900',
      forzar: true,
      performedBy: 's1',
      origen: 'MCP',
    })
    expect(mockAudit).toHaveBeenCalledWith(scope, expect.objectContaining({ action: 'RAPPI_DISCONNECTED', entityId: 'l1', venueId: 'v1' }))
  })

  it('si ya estaba desconectada no audita un hecho que no ocurrió', async () => {
    mockDesconectar.mockResolvedValueOnce({ link: { ...LINK, status: 'DISABLED' }, yaEstaba: true, forzada: false })
    await call({ venueId: 'v1', linkId: 'l1', confirm: true, conexionId: 'i1:900' })
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('está en el MCP libre como write y NO en el catálogo certificado', () => {
    expect(TOOL_EFFECTS.rappi_disconnect).toBe('write')
    expect(DIRECTORY_TIERS.flatMap(t => t.tools)).not.toContain('rappi_disconnect')
  })
})
