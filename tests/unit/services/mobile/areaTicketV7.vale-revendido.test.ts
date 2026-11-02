import { AreaTicketCheckoutStatus, AreaTicketStatus, FulfillmentMode, Prisma } from '@prisma/client'

import { canonicalSnapshotHash, materializeAreaTicketCheckout } from '@/services/mobile/areaTicketV7.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

/**
 * 🔴 D1 (21-oct-2026, tablero hz:11d84b54:D1), Codex r4 #1: una caja re-arma el vale de una venta cancelada mientras el dinero tardío
 * de esa venta la reabre (R12-1). La transacción Serializable de la caja ya tenía su foto: al bloquear la cuenta vieja, Postgres contesta
 * con un conflicto de serialización. Antes salía como 500 sin código; ahora se reintenta y el reintento ve la cuenta viva: 409 con la cuenta.
 */
function sesionConUnVale() {
  const now = new Date()
  const cero = new Prisma.Decimal(0)
  const linea = {
    id: 'line-1',
    clientLineId: 'l1',
    productId: 'p-cafe',
    productNameSnapshot: 'Café americano',
    skuSnapshot: null,
    categoryNameSnapshot: null,
    modifiersSnapshot: [],
    quantity: new Prisma.Decimal(1),
    weightKg: null,
    unitPrice: new Prisma.Decimal(30),
    discountAmount: cero,
    appliedDiscountId: null,
    taxAmount: cero,
    total: new Prisma.Decimal(30),
    notes: null,
    createdAt: now,
  }
  const ticket = {
    id: 'ticket-1',
    code: '9696971106',
    status: AreaTicketStatus.CLAIMED,
    fulfillmentAreaId: 'area-1',
    fulfillmentModeSnapshot: FulfillmentMode.HOLD_UNTIL_PAID,
    fulfillmentArea: { id: 'area-1', name: 'Cocina', fulfillmentMode: FulfillmentMode.HOLD_UNTIL_PAID },
    sourceTerminalId: 'terminal-issue',
    sourceTerminal: { id: 'terminal-issue', name: 'Cocina' },
    currency: 'MXN',
    subtotal: new Prisma.Decimal(30),
    discountAmount: cero,
    taxAmount: cero,
    total: new Prisma.Decimal(30),
    pricingSnapshotHash: canonicalSnapshotHash('MXN', [linea as any]),
    printStatus: 'NOT_PRINTED',
    version: 1,
    issuedAt: now,
    printedAt: null,
    claimedAt: now,
    claimExpiresAt: new Date(now.getTime() + 60_000),
    paidAt: null,
    expiresAt: null,
    orderId: null,
    checkoutSessionId: 'checkout-session',
    lines: [linea],
    fulfillment: null,
  }
  return {
    id: 'checkout-session',
    status: AreaTicketCheckoutStatus.OPEN,
    terminalId: 'terminal-checkout',
    terminal: { id: 'terminal-checkout', name: 'Caja' },
    staffId: null,
    orderId: null,
    order: null,
    materializeIdempotencyKey: null,
    activePaymentAttemptId: null,
    version: 1,
    lastHeartbeatAt: now,
    expiresAt: new Date(now.getTime() + 60_000),
    createdAt: now,
    tickets: [ticket],
    paymentAttempts: [],
  }
}

describe('D1: re-armar el vale de una venta cancelada mientras el dinero tardío la reabre', () => {
  beforeEach(() => jest.clearAllMocks())

  it('🔴 Codex r4 #1: el bloqueo de la cuenta vieja choca por serialización ⇒ se reintenta y contesta 409 con la cuenta viva, no 500', async () => {
    const session = sesionConUnVale()
    prismaMock.areaTicketCheckoutSession.findFirst.mockResolvedValue(session)
    prismaMock.terminal.findFirst.mockResolvedValue({
      id: 'terminal-checkout',
      name: 'Caja',
      fulfillmentAreaId: null,
      fulfillmentArea: null,
      canIssueAreaTickets: false,
      canCheckoutAreaTickets: true,
      canDeliverAreaTickets: false,
      defaultWorkspace: 'AREA_OPERATIONS',
      scaleProfile: null,
    })
    prismaMock.venueAreaTicketSettings.findUnique.mockResolvedValue({ allowMixedCart: true })
    // El renglón del vale está en la cuenta A; al releerla ya bajo su candado, A está viva (el dinero tardío la reabrió).
    prismaMock.orderItem.findMany.mockImplementation(async (args: any) =>
      args?.select?.order
        ? [
            {
              id: 'oi-a',
              orderId: 'order-a',
              areaTicketLineId: 'line-1',
              order: { venueId: 'venue-1', status: 'COMPLETED', orderNumber: 'ORD-A' },
            },
          ]
        : [{ orderId: 'order-a' }],
    )
    let candadosDeA = 0
    ;(prismaMock.$queryRaw as jest.Mock).mockImplementation(async (sql: TemplateStringsArray) => {
      if (Array.isArray(sql) && sql.join('?').includes('FROM "Order"') && ++candadosDeA === 1) {
        throw new Prisma.PrismaClientKnownRequestError('could not serialize access due to concurrent update', {
          code: 'P2034',
          clientVersion: 'test',
        })
      }
      return []
    })

    await expect(
      materializeAreaTicketCheckout('venue-1', session.id, { idempotencyKey: 'rearmar', deviceUid: 'checkout-device' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'AREA_TICKET_LINE_IN_OTHER_ORDER' })
    expect(candadosDeA).toBe(2)
    expect(prismaMock.order.create).not.toHaveBeenCalled()
    expect(prismaMock.orderItem.update).not.toHaveBeenCalled()
  })
})
