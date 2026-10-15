import { AreaTicketCheckoutStatus, AreaTicketStatus, FulfillmentMode, Prisma } from '@prisma/client'

import { canonicalSnapshotHash, issueAreaTicket, materializeAreaTicketCheckout } from '@/services/mobile/areaTicketV7.mobile.service'
import { capItemNote } from '@/services/shared/inputCaps'
import { prismaMock } from '../../../__helpers__/setup'

/**
 * D5 (mesas40, 14-oct): la nota de un artículo se guarda recortada a 500 caracteres (`buildOrderItemsData`). El vale
 * congela esa nota recortada; la REPETICIÓN del mismo vale (misma llave, la misma nota larga que manda el aparato)
 * tiene que reconocerlo y devolverlo — no responder un 409 de idempotencia por comparar la nota cruda contra la guardada.
 */
const notaLarga = 'a'.repeat(499) + '🌮' + 'b'.repeat(9_537)
// D5 v3: prefijo + «…» + huella (`capItemNote`, formato fijado en `inputCaps.test.ts`).
const recortada = capItemNote(notaLarga)

function valeGuardado(notes: string) {
  const cero = new Prisma.Decimal(0)
  return {
    id: 'ticket-1',
    code: '812345678',
    status: 'ISSUED',
    fulfillmentModeSnapshot: 'IMMEDIATE',
    settlementRoute: 'AVOQADO',
    fulfillmentArea: null,
    sourceTerminal: null,
    currency: 'MXN',
    subtotal: new Prisma.Decimal(55),
    discountAmount: cero,
    taxAmount: cero,
    total: new Prisma.Decimal(55),
    pricingSnapshotHash: 'hash',
    printStatus: 'PENDING',
    version: 1,
    lines: [
      {
        id: 'line-1',
        clientLineId: 'l1',
        productId: 'p-latte',
        productNameSnapshot: 'Latte',
        skuSnapshot: null,
        categoryNameSnapshot: null,
        modifiersSnapshot: [],
        quantity: new Prisma.Decimal(1),
        weightKg: null,
        unitPrice: new Prisma.Decimal(55),
        discountAmount: cero,
        appliedDiscountId: null,
        taxAmount: cero,
        total: new Prisma.Decimal(55),
        notes,
        orderItem: null,
      },
    ],
    fulfillment: null,
    externalSettlement: null,
  }
}

const repeticion = (notes: string) => ({
  idempotencyKey: 'k-vale',
  deviceUid: 'device-1',
  lines: [{ clientLineId: 'l1', productId: 'p-latte', quantity: '1', notes }],
})

describe('D5: repetir un vale con nota larga devuelve el MISMO vale', () => {
  beforeEach(() => jest.clearAllMocks())

  it('🔴 el vale guardado con la nota recortada se reconoce al repetirse con la nota larga (no 409)', async () => {
    prismaMock.areaTicket.findUnique.mockResolvedValue(valeGuardado(recortada))

    await expect(issueAreaTicket('venue-1', repeticion(notaLarga))).resolves.toMatchObject({ id: 'ticket-1' })
  })

  it('un vale emitido ANTES del tope (nota larga guardada entera) también se reconoce al repetirse', async () => {
    prismaMock.areaTicket.findUnique.mockResolvedValue(valeGuardado(notaLarga))

    await expect(issueAreaTicket('venue-1', repeticion(notaLarga))).resolves.toMatchObject({ id: 'ticket-1' })
  })

  it('control: una nota DISTINTA con la misma llave sigue siendo conflicto de idempotencia', async () => {
    prismaMock.areaTicket.findUnique.mockResolvedValue(valeGuardado(recortada))

    await expect(issueAreaTicket('venue-1', repeticion('sin hielo'))).rejects.toMatchObject({ code: 'AREA_TICKET_IDEMPOTENCY_CONFLICT' })
  })

  // D5 v3 (Codex P2): con el recorte pelón, los dos lados quedaban en «500 letras» y el reintento con OTRA nota se
  // aceptaba como el mismo vale. Con la huella, la diferencia después del carácter 500 vuelve a contar.
  it('🔴 vale viejo con «500 letras + A» contra reintento «500 letras + B» ⇒ 409 AREA_TICKET_IDEMPOTENCY_CONFLICT', async () => {
    const base = 'a'.repeat(500)
    prismaMock.areaTicket.findUnique.mockResolvedValue(valeGuardado(base + 'A'))

    await expect(issueAreaTicket('venue-1', repeticion(base + 'B'))).rejects.toMatchObject({ code: 'AREA_TICKET_IDEMPOTENCY_CONFLICT' })
  })
})

/**
 * D5 v3 (Codex P2): materializar un vale v7 emitido ANTES del tope copiaba `line.notes` completa al `OrderItem` nuevo.
 * El renglón nace con la nota recortada; el vale histórico NO se reescribe.
 */
describe('D5 v3: materializar un vale viejo con nota larga escribe el renglón con la nota recortada', () => {
  beforeEach(() => jest.clearAllMocks())

  it('🔴 la nota del OrderItem queda recortada y el vale guardado conserva la suya', async () => {
    const now = new Date()
    const cero = new Prisma.Decimal(0)
    const lineaVieja = {
      id: 'line-vieja',
      clientLineId: 'l1',
      productId: 'p-latte',
      productNameSnapshot: 'Latte',
      skuSnapshot: null,
      categoryNameSnapshot: null,
      modifiersSnapshot: [],
      quantity: new Prisma.Decimal(1),
      weightKg: null,
      unitPrice: new Prisma.Decimal(55),
      discountAmount: cero,
      appliedDiscountId: null,
      taxAmount: cero,
      total: new Prisma.Decimal(55),
      notes: notaLarga,
      createdAt: now,
    }
    const ticket = {
      id: 'ticket-viejo',
      code: '9000000001',
      status: AreaTicketStatus.CLAIMED,
      fulfillmentAreaId: 'area-1',
      fulfillmentModeSnapshot: FulfillmentMode.IMMEDIATE,
      fulfillmentArea: { id: 'area-1', name: 'Cafetería', fulfillmentMode: FulfillmentMode.IMMEDIATE },
      sourceTerminalId: 'terminal-issue',
      sourceTerminal: { id: 'terminal-issue', name: 'Cafetería' },
      currency: 'MXN',
      subtotal: new Prisma.Decimal(55),
      discountAmount: cero,
      taxAmount: cero,
      total: new Prisma.Decimal(55),
      pricingSnapshotHash: canonicalSnapshotHash('MXN', [lineaVieja as any]),
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
      lines: [lineaVieja],
      fulfillment: null,
    }
    const session = {
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
    let creada: any
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
    prismaMock.order.create.mockImplementation(async ({ data }: any) => (creada = { id: 'order-created', ...data }))
    prismaMock.areaTicket.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.areaTicketCheckoutSession.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.areaTicketCheckoutSession.findUniqueOrThrow.mockImplementation(async () => ({
      ...session,
      status: AreaTicketCheckoutStatus.MATERIALIZED,
      orderId: creada.id,
      order: creada,
    }))

    await materializeAreaTicketCheckout('venue-1', session.id, { idempotencyKey: 'materializar-viejo', deviceUid: 'checkout-device' })

    const notes = (prismaMock.orderItem.create as jest.Mock).mock.calls[0][0].data.notes
    expect(notes).toBe(capItemNote(notaLarga))
    expect(notes).toMatch(/…[0-9a-f]{8}$/)
    // El vale histórico no se toca: ninguna escritura a sus líneas, y la que se leyó sigue completa.
    expect(prismaMock.areaTicketLine.update).not.toHaveBeenCalled()
    expect(lineaVieja.notes).toBe(notaLarga)
  })
})
