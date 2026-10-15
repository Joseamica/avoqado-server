import { Prisma } from '@prisma/client'

import { issueAreaTicket } from '@/services/mobile/areaTicketV7.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

/**
 * D5 (mesas40, 14-oct): la nota de un artículo se guarda recortada a 500 caracteres (`buildOrderItemsData`). El vale
 * congela esa nota recortada; la REPETICIÓN del mismo vale (misma llave, la misma nota larga que manda el aparato)
 * tiene que reconocerlo y devolverlo — no responder un 409 de idempotencia por comparar la nota cruda contra la guardada.
 */
const notaLarga = 'a'.repeat(499) + '🌮' + 'b'.repeat(9_537)
const recortada = 'a'.repeat(499) + '🌮'

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
})
