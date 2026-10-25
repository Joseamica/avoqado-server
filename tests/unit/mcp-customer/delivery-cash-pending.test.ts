/**
 * delivery_cash_pending (Rappi 2b, 23-oct): la misma lista «Rappi · por cobrar» que ven las apps, en el MCP de clientes (modo libre).
 * Dinero en PESOS (invariante del MCP), permiso de lectura de órdenes como la bandeja, sin candado de plan (R14: atender lo que ya
 * existe nunca se bloquea).
 */
import { registerDeliveryChannelTools } from '../../../src/mcp/tools/deliveryChannels'
import type { McpScope } from '../../../src/mcp/scope'
import { TOOL_EFFECTS } from '../../../src/mcp/catalog'

const mockRequirePermission = jest.fn()
const mockList = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => ({ venueId: { in: [v] } }),
    requirePermission: (...a: unknown[]) => mockRequirePermission(...(a as [])),
  }),
}))
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: {} }))
jest.mock('@/services/delivery-channels/core/deliveryCashPending.service', () => ({
  listDeliveryCashPending: (...a: unknown[]) => mockList(...(a as [])),
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerDeliveryChannelTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})

describe('delivery_cash_pending', () => {
  it('devuelve la lista en PESOS con el desglose, con el permiso de lectura de órdenes', async () => {
    mockList.mockResolvedValue({
      orders: [
        {
          orderId: 'o1',
          orderNumber: 'R-881',
          provider: 'RAPPI',
          status: 'CONFIRMED',
          kitchenStatus: 'PENDING',
          customerName: null,
          createdAt: '2026-10-23T12:00:00.000Z',
          remainingBalanceCents: 20500,
          saleCents: 17500,
          tipCents: 2000,
          thirdPartyCents: 1000,
          thirdPartyLabel: 'Rappi',
        },
      ],
      total: 1,
      truncated: false,
      nextCursor: null,
    })

    const r = parse(await handlers.get('delivery_cash_pending')!({ venueId: 'v1' }, {}))

    expect(mockRequirePermission).toHaveBeenCalledWith('orders:read', 'v1')
    expect(mockList).toHaveBeenCalledWith({ venueId: 'v1' })
    expect(r).toMatchObject({ total: 1, truncated: false })
    expect(r.orders[0]).toMatchObject({
      orderNumber: 'R-881',
      porCobrar: 205,
      venta: 175,
      propina: 20,
      deLaPlataforma: 10,
      plataforma: 'Rappi',
    })
    expect(JSON.stringify(r)).not.toMatch(/Cents/)
  })

  it('está en el catálogo como lectura', () => {
    expect(TOOL_EFFECTS.delivery_cash_pending).toBe('read')
  })
})
