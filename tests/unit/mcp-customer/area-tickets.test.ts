import { registerAreaTicketTools } from '../../../src/mcp/tools/areaTickets'
import type { McpScope } from '../../../src/mcp/scope'
import { prismaMock } from '../../__helpers__/setup'

const requirePermission = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (venueId: string) => {
      if (venueId === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [venueId] } }
    },
    requirePermission,
  }),
}))

const handlers = new Map<string, (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = {
  staffId: 'staff-1',
  activeOrg: 'org-1',
  allowedVenueIds: ['venue-1'],
  perVenueAccess: new Map(),
} as McpScope
const call = (tool: string, args: Record<string, unknown>) => handlers.get(tool)!(args, {})
const parse = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text)

beforeAll(() => {
  registerAreaTicketTools(
    {
      tool: (...args: unknown[]) => handlers.set(args[0] as string, args[args.length - 1] as never),
    } as never,
    scope,
  )
})

beforeEach(() => {
  prismaMock.areaTicket.findUnique.mockResolvedValue(null)
  prismaMock.order.findUnique.mockResolvedValue(null)
  prismaMock.areaTicket.findMany.mockResolvedValue([])
  prismaMock.areaTicketCheckoutSession.findMany.mockResolvedValue([])
})

describe('area ticket MCP tools', () => {
  it('rejects cross-tenant status probes before querying', async () => {
    await expect(call('area_ticket_status', { venueId: 'foreign', code: '9000000001' })).rejects.toThrow('out of scope')
    expect(prismaMock.areaTicket.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.order.findUnique).not.toHaveBeenCalled()
  })

  it('returns an area ticket by code with money as a decimal string', async () => {
    prismaMock.areaTicket.findUnique.mockResolvedValueOnce({
      id: 'ticket-1',
      code: '9000000001',
      status: 'PAID',
      total: { toString: () => '36.74' },
      fulfillment: null,
    })

    const result = parse(
      await call('area_ticket_status', {
        venueId: 'venue-1',
        code: '9000000001',
      }),
    )

    expect(requirePermission).toHaveBeenCalledWith('orders:read', 'venue-1')
    expect(result).toMatchObject({
      found: true,
      kind: 'AREA_TICKET',
      ticket: { id: 'ticket-1', total: '36.74' },
    })
  })

  it('gates pending deliveries with the delivery-specific permission', async () => {
    const result = parse(
      await call('pending_area_ticket_deliveries', {
        venueId: 'venue-1',
        limit: 20,
      }),
    )

    expect(requirePermission).toHaveBeenCalledWith('area-tickets:deliver', 'venue-1')
    expect(result).toEqual({ count: 0, tickets: [] })
  })

  it('gates reconciliation with configure and never mutates state', async () => {
    const result = parse(
      await call('area_ticket_reconciliation_queue', {
        venueId: 'venue-1',
        limit: 20,
      }),
    )

    expect(requirePermission).toHaveBeenCalledWith('area-tickets:configure', 'venue-1')
    expect(result.count).toBe(0)
    expect(prismaMock.areaTicketCheckoutSession.update).not.toHaveBeenCalled()
    expect(prismaMock.areaTicket.update).not.toHaveBeenCalled()
  })
})
