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
  // Task 13: sin este default, cualquier test que NO mockee explícitamente
  // esta cola revienta con "Cannot read properties of undefined (reading 'map')"
  // en cuanto area_ticket_reconciliation_queue empieza a consultarla.
  prismaMock.areaTicketExternalIncident.findMany.mockResolvedValue([])
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

// Task 13 — Plan "caja externa fase 1 — núcleo": el MCP alcanza la ruta EXTERNAL
// (otro POS cobra en su propia caja) construida en las Tasks 1-12. Solo lectura:
// ningún test de este bloque llama a un método `.update`/`.create` de Prisma.
describe('cobro externo (ruta EXTERNAL) en los tools de vales', () => {
  it('area_ticket_status expone settlementRoute EXTERNAL y el estado del cobro externo', async () => {
    prismaMock.areaTicket.findUnique.mockResolvedValueOnce({
      id: 'ticket-ext-1',
      code: '9000000099',
      status: 'ISSUED',
      total: { toString: () => '168.00' },
      settlementRoute: 'EXTERNAL',
      fulfillment: null,
      externalSettlement: {
        status: 'PENDING',
        handoffState: 'HANDED_OFF',
        confirmationMode: 'MANUAL',
        referenceAmount: { toString: () => '168.00' },
        externalAmount: null,
        externalReference: null,
        confirmedAt: null,
        notes: null,
        confirmedByStaff: null,
      },
    })

    const result = parse(await call('area_ticket_status', { venueId: 'venue-1', code: '9000000099' }))

    expect(result.ticket.settlementRoute).toBe('EXTERNAL')
    expect(result.ticket.externalSettlement).toMatchObject({
      status: 'PENDING',
      handoffState: 'HANDED_OFF',
      confirmationMode: 'MANUAL',
    })
  })

  // 🔴 Prueba de mutación (ver reporte de la Task 13): se mutó a propósito la
  // conversión de `referenceAmount`/`externalAmount` para multiplicar por 100
  // (simulando el bug clásico "centavos en vez de pesos"), se confirmó que
  // ESTE test específico fallaba, y se revirtió. Un test que solo verificara
  // "es un número" no habría detectado nada.
  it('el importe del cobro externo sale en pesos 1:1, NUNCA en centavos', async () => {
    prismaMock.areaTicket.findUnique.mockResolvedValueOnce({
      id: 'ticket-ext-2',
      code: '9000000098',
      status: 'ISSUED',
      total: { toString: () => '168.00' },
      settlementRoute: 'EXTERNAL',
      fulfillment: null,
      externalSettlement: {
        status: 'CONFIRMED',
        handoffState: 'HANDED_OFF',
        confirmationMode: 'MANUAL',
        referenceAmount: { toString: () => '168.00' },
        externalAmount: { toString: () => '168.00' },
        externalReference: 'TICKET-EXT-001',
        confirmedAt: new Date('2026-08-10T12:00:00.000Z'),
        notes: null,
        confirmedByStaff: { firstName: 'Ana', lastName: 'Pérez' },
      },
    })

    const result = parse(await call('area_ticket_status', { venueId: 'venue-1', code: '9000000098' }))

    // 168.00 pesos — NUNCA 16800 (ni "16800.00"), que sería tratar el peso como centavo.
    expect(result.ticket.externalSettlement.referenceAmount).toBe('168.00')
    expect(result.ticket.externalSettlement.externalAmount).toBe('168.00')
    expect(result.ticket.externalSettlement.confirmedBy).toBe('Ana Pérez')
  })

  it('area_ticket_reconciliation_queue incluye las incidencias externas abiertas, sin mutar nada', async () => {
    prismaMock.areaTicketExternalIncident.findMany.mockResolvedValueOnce([
      {
        id: 'incident-1',
        kind: 'UNCONFIRMED_CHARGE',
        status: 'OPEN',
        detail: { referenceAmount: '168.00', code: '9000000099' },
        openedAt: new Date('2026-08-10T06:00:00.000Z'),
        occurrenceCount: 1,
        reopenedAt: null,
        areaTicket: { id: 'ticket-ext-1', code: '9000000099', fulfillmentArea: { id: 'area-1', name: 'Panadería' } },
      },
    ])

    const result = parse(await call('area_ticket_reconciliation_queue', { venueId: 'venue-1', limit: 20 }))

    expect(requirePermission).toHaveBeenCalledWith('area-tickets:configure', 'venue-1')
    expect(result.externalIncidents.count).toBe(1)
    expect(result.externalIncidents.items[0]).toMatchObject({
      id: 'incident-1',
      kind: 'UNCONFIRMED_CHARGE',
      status: 'OPEN',
      ticket: { id: 'ticket-ext-1', code: '9000000099', area: 'Panadería' },
    })
    expect(prismaMock.areaTicketExternalIncident.update).not.toHaveBeenCalled()
    expect(prismaMock.areaTicketExternalIncident.updateMany).not.toHaveBeenCalled()
  })

  it('pending_area_ticket_deliveries incluye los vales externos ya elegibles para entregar', async () => {
    prismaMock.areaTicket.findMany.mockResolvedValueOnce([
      {
        id: 'ticket-ext-3',
        code: '9000000097',
        issuedAt: new Date('2026-08-10T10:00:00.000Z'),
        paidAt: null,
        total: { toString: () => '168.00' },
        settlementRoute: 'EXTERNAL',
        fulfillmentArea: { id: 'area-1', name: 'Panadería' },
        order: null,
        externalSettlement: {
          status: 'CONFIRMED',
          referenceAmount: { toString: () => '168.00' },
          externalAmount: { toString: () => '168.00' },
        },
        _count: { lines: 2 },
      },
    ])

    const result = parse(await call('pending_area_ticket_deliveries', { venueId: 'venue-1', limit: 20 }))

    expect(result.count).toBe(1)
    expect(result.tickets[0]).toMatchObject({
      id: 'ticket-ext-3',
      settlementRoute: 'EXTERNAL',
      externalSettlement: { status: 'CONFIRMED', referenceAmount: '168.00', externalAmount: '168.00' },
    })
  })
})
