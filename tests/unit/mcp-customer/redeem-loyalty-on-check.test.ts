/**
 * D18 (12-nov): el MCP `redeem_loyalty_on_check` es «previa → confirm:true». Entre las dos llamadas la cuenta puede cambiar; la
 * previa le pide al modelo que mande su monto (`expectedDiscount`) al confirmar, y el canje usa el mismo candado que la tablet: si ya
 * no es lo que se previó, no canjea y dice la oferta de ahora. Sin el monto, como antes.
 */
import { registerLoyaltyTools } from '../../../src/mcp/tools/loyalty'
import type { McpScope } from '../../../src/mcp/scope'

const mockCustomerFind = jest.fn()
const mockPrevia = jest.fn()
const mockRedeem = jest.fn()
const mockAudit = jest.fn()

jest.mock('@/mcp/planGate', () => ({ planGateMessage: jest.fn().mockResolvedValue(null) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({ venueFilter: (v: string) => ({ venueId: { in: [v] } }), requirePermission: () => undefined }),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/services/mobile/loyalty.mobile.service', () => {
  const real = jest.requireActual('@/services/mobile/loyalty.mobile.service')
  return {
    ...real,
    previaDelCanjeEnCuenta: (...a: unknown[]) => mockPrevia(...(a as [])),
    redeemPointsToOrder: (...a: unknown[]) => mockRedeem(...(a as [])),
  }
})
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    loyaltyConfig: { findFirst: jest.fn() },
    customer: { findMany: (...a: unknown[]) => mockCustomerFind(...(a as [])) },
    staffVenue: { findFirst: jest.fn() },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('redeem_loyalty_on_check')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)
const ana = { id: 'c1', firstName: 'Ana', lastName: 'López', loyaltyPoints: 500 }

beforeAll(() => {
  registerLoyaltyTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => {
  jest.clearAllMocks()
  mockCustomerFind.mockResolvedValue([ana])
})

describe('redeem_loyalty_on_check · candado de la oferta', () => {
  it('la previa da el monto y le pide al modelo mandarlo al confirmar', async () => {
    mockPrevia.mockResolvedValue({ ok: true, puntos: 500, monto: 50, vista: { balance: 500, minPointsRedeem: 100 } })
    const out = parse(await call({ venueId: 'v1', orderId: 'o1', search: 'ana', points: 500 }))
    expect(out.requiresConfirmation).toBe(true)
    expect(out.preview.discount).toBe(50)
    expect(out.message).toContain('expectedDiscount: 50')
    expect(mockRedeem).not.toHaveBeenCalled()
  })

  it('al confirmar con el monto de la previa, el canje lleva el candado', async () => {
    mockRedeem.mockResolvedValue({ pointsRedeemed: 500, discountAmount: 50, newBalance: 0, order: { total: 450 } })
    const out = parse(await call({ venueId: 'v1', orderId: 'o1', search: 'ana', points: 500, confirm: true, expectedDiscount: 50 }))
    expect(mockRedeem).toHaveBeenCalledWith('v1', 'o1', 'c1', 500, 's1', 50)
    expect(out).toMatchObject({ ok: true, pointsRedeemed: 500, discountAmount: 50 })
  })

  it('si la cuenta cambió entre la previa y el confirm: no canjea y dice la oferta de ahora con su código', async () => {
    const { OfertaDeCanjeCambio } = jest.requireActual('@/services/mobile/loyalty.mobile.service')
    mockRedeem.mockRejectedValue(new OfertaDeCanjeCambio(10, 1))
    const out = parse(await call({ venueId: 'v1', orderId: 'o1', search: 'ana', points: 500, confirm: true, expectedDiscount: 50 }))
    expect(out).toMatchObject({ ok: false, code: 'LOYALTY_OFFER_CHANGED' })
    expect(out.error).toContain('10 puntos por $1.00')
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('sin el monto (llamadas de antes): canjea como siempre, sin candado', async () => {
    mockRedeem.mockResolvedValue({ pointsRedeemed: 10, discountAmount: 1, newBalance: 490, order: { total: 0 } })
    await call({ venueId: 'v1', orderId: 'o1', search: 'ana', points: 500, confirm: true })
    expect(mockRedeem).toHaveBeenCalledWith('v1', 'o1', 'c1', 500, 's1', undefined)
  })
})
