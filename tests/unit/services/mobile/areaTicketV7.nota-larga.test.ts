import { AreaTicketCheckoutStatus, AreaTicketStatus, FulfillmentMode, Prisma } from '@prisma/client'

import { canonicalSnapshotHash, issueAreaTicket, materializeAreaTicketCheckout } from '@/services/mobile/areaTicketV7.mobile.service'
import { createHash } from 'crypto'
import { prismaMock } from '../../../__helpers__/setup'

/**
 * D5 v5 (mesas40, 15-oct): el server NO recorta `OrderItem.notes` (decisión tras Codex r3; el tope vive en la captura del
 * aparato). El vale congela la nota COMPLETA, como en `a2e999c0f`; la repetición del mismo vale se compara con el texto
 * íntegro y el renglón que nace al materializar lleva la nota entera.
 */
const notaLarga = 'a'.repeat(499) + '🌮' + 'b'.repeat(9_537)

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

describe('D5: repetir un vale con nota larga', () => {
  beforeEach(() => jest.clearAllMocks())

  it('un vale con la nota larga guardada entera se reconoce al repetirse con la misma nota (no 409)', async () => {
    prismaMock.areaTicket.findUnique.mockResolvedValue(valeGuardado(notaLarga))

    await expect(issueAreaTicket('venue-1', repeticion(notaLarga))).resolves.toMatchObject({ id: 'ticket-1' })
  })

  it('control: una nota DISTINTA con la misma llave sigue siendo conflicto de idempotencia', async () => {
    prismaMock.areaTicket.findUnique.mockResolvedValue(valeGuardado(notaLarga))

    await expect(issueAreaTicket('venue-1', repeticion('sin hielo'))).rejects.toMatchObject({ code: 'AREA_TICKET_IDEMPOTENCY_CONFLICT' })
  })

  // D5 v3 (Codex P2): con un recorte, los dos lados quedaban en «500 letras» y el reintento con OTRA nota se aceptaba como
  // el mismo vale. Sin recorte la diferencia después del carácter 500 cuenta; la prueba se queda de guarda.
  it('🔴 vale viejo con «500 letras + A» contra reintento «500 letras + B» ⇒ 409 AREA_TICKET_IDEMPOTENCY_CONFLICT', async () => {
    const base = 'a'.repeat(500)
    prismaMock.areaTicket.findUnique.mockResolvedValue(valeGuardado(base + 'A'))

    await expect(issueAreaTicket('venue-1', repeticion(base + 'B'))).rejects.toMatchObject({ code: 'AREA_TICKET_IDEMPOTENCY_CONFLICT' })
  })

  // D5 v4 (Codex r2): recortar los dos lados confundía la nota larga X con la forma que le daba el recorte v3, escrita
  // LITERALMENTE (Y). Con el texto íntegro, como antes de D5, son distintas; la prueba se queda de guarda.
  it('🔴 vale viejo con X (500a+A, guardado entero) contra reintento con su forma recortada literal Y ⇒ 409', async () => {
    const X = 'a'.repeat(500) + 'A'
    const Y = 'a'.repeat(491) + '…' + createHash('sha256').update(X).digest('hex').slice(0, 8)
    prismaMock.areaTicket.findUnique.mockResolvedValue(valeGuardado(X))

    await expect(issueAreaTicket('venue-1', repeticion(Y))).rejects.toMatchObject({ code: 'AREA_TICKET_IDEMPOTENCY_CONFLICT' })
  })
})

/**
 * D5 v5: materializar un vale v7 copia `line.notes` COMPLETA al `OrderItem` nuevo, como en `a2e999c0f`. Si el renglón
 * naciera recortado, el carrito completo de la TPV con la nota original ya no lo reconocería ($100 → $200, Codex r3).
 */
describe('D5 v5: materializar un vale con nota larga escribe el renglón con la nota completa', () => {
  beforeEach(() => jest.clearAllMocks())

  it('🔴 la nota del OrderItem queda completa y el vale guardado no se reescribe', async () => {
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

    expect((prismaMock.orderItem.create as jest.Mock).mock.calls[0][0].data.notes).toBe(notaLarga)
    // El vale histórico no se toca: ninguna escritura a sus líneas, y la que se leyó sigue completa.
    expect(prismaMock.areaTicketLine.update).not.toHaveBeenCalled()
    expect(lineaVieja.notes).toBe(notaLarga)
  })
})
