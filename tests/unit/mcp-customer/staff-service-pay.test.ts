import { registerStaffPayTools } from '../../../src/mcp/tools/staffPay'
import type { McpScope } from '../../../src/mcp/scope'

const mockReporte = jest.fn()
const mockDetalle = jest.fn()
const mockAccess = jest.fn()
const mockHasPermission = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v?: string) => { if (v === 'foreign') throw new Error('ScopeError: venue out of scope'); return { venueId: { in: [v ?? 'v1'] } } },
  }),
}))
jest.mock('@/services/access/access.service', () => ({ hasPermission: (...a: unknown[]) => mockHasPermission(...a) }))
jest.mock('@/services/dashboard/staffPay/acceso', () => ({ venueHasServicePayAccess: (...a: unknown[]) => mockAccess(...a) }))
jest.mock('@/services/dashboard/staffPay/reporte.service', () => ({
  reportePeriodo: (...a: unknown[]) => mockReporte(...a),
  detallePersona: (...a: unknown[]) => mockDetalle(...a),
}))
jest.mock('@/services/dashboard/staffPay/niveles.service', () => ({ listarNiveles: jest.fn().mockResolvedValue([]), nivelesVigentes: jest.fn().mockResolvedValue([]) }))
jest.mock('@/services/dashboard/staffPay/tablas.service', () => ({ listarTablas: jest.fn().mockResolvedValue([]) }))
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: { venue: { findUnique: jest.fn().mockResolvedValue({ organizationId: 'o1', timezone: 'America/Mexico_City' }) } } }))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map([['v1', { role: 'OWNER' }]]) } as unknown as McpScope
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => registerStaffPayTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope))
beforeEach(() => { jest.clearAllMocks(); mockHasPermission.mockReturnValue(true); mockAccess.mockResolvedValue(true) })

describe('staff_service_pay — feature nueva', () => {
  it('summary devuelve el reporte del periodo en pesos', async () => {
    mockReporte.mockResolvedValue({ periodo: { start: '2026-10-01', end: '2026-10-31' }, parcial: false, tarjetas: { total: '36620.00' }, personas: { items: [] } })
    const r = parse(await handlers.get('staff_service_pay_summary')!({ venueId: 'v1' }, {}))
    expect(r.tarjetas.total).toBe('36620.00')
    expect(mockReporte).toHaveBeenCalledWith(expect.objectContaining({ userId: 's1', venueId: 'v1' }))
  })
})

describe('staff_service_pay — regresión', () => {
  it('rechaza una sede fuera del alcance', async () => {
    await expect(handlers.get('staff_service_pay_summary')!({ venueId: 'foreign' }, {})).rejects.toThrow('out of scope')
  })
  it('sin staffpay:read no lee nada', async () => {
    mockHasPermission.mockReturnValue(false)
    const r = parse(await handlers.get('staff_service_pay_detail')!({ venueId: 'v1', staffId: 'cxxxxxxxxxxxxxxxxxxxxxxxx' }, {}))
    expect(r.ok).toBe(false); expect(mockDetalle).not.toHaveBeenCalled()
  })
  it('módulo apagado se explica, no responde vacío', async () => {
    mockAccess.mockResolvedValue(false)
    const r = parse(await handlers.get('staff_service_pay_config')!({ venueId: 'v1' }, {}))
    expect(r.ok).toBe(false); expect(r.error).toMatch(/no está activo/)
  })
})
