/**
 * D4 (hz:72be07e6:D4) — mesa dividida con propina: la TPV pedía la propina OTRA VEZ en la segunda parte.
 *
 * Medido el 12-nov en la PAX: cuenta de $50, parte 1 = $25 + $10 de propina con tarjeta → la parte 2 decía «Restante $35»
 * (debía ser $25). Al pagar $25 en efectivo la terminal seguía pidiendo $10 con la mesa sin liberar, aunque la orden ya
 * estaba PAID con `remainingBalance` 0.
 *
 * Causa: `amount_left = order.total − Σ payment.amount`. Al cobrar, el SERVIDOR reescribe `order.total` CON la propina
 * (mercancía + propinas, `computeStoredOrderTotal`), pero aquí sólo se restaba `amount`, que NO la trae. La propina quedaba
 * sumada en el total y nunca se descontaba.
 *
 * Arreglo: restar `amount + tipAmount` de cada pago. La forma de la respuesta no cambia (versiones viejas de la TPV leen
 * `amount_left`).
 */

import { Decimal } from '@prisma/client/runtime/library'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    order: { findUnique: jest.fn() },
    onlineOrder: { findFirst: jest.fn().mockResolvedValue(null) },
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import prisma from '@/utils/prismaClient'
import * as orderTpvService from '@/services/tpv/order.tpv.service'

const findUniqueMock = (prisma as any).order.findUnique as jest.Mock

const VENUE_ID = 'venue-1'
const ORDER_ID = 'order-1'

function cuenta(overrides: Record<string, any> = {}) {
  return {
    id: ORDER_ID,
    venueId: VENUE_ID,
    orderNumber: 'ORD-1794548257592',
    status: 'CONFIRMED',
    paymentStatus: 'PARTIAL',
    type: 'DINE_IN',
    subtotal: new Decimal('50.00'),
    discountAmount: new Decimal('0.00'),
    serviceChargeAmount: new Decimal('0.00'),
    taxAmount: new Decimal('0.00'),
    tipAmount: new Decimal('0.00'),
    total: new Decimal('50.00'),
    version: 1,
    splitType: null,
    items: [],
    payments: [],
    createdBy: null,
    servedBy: null,
    table: { id: 'table-1', number: 4 },
    orderDiscounts: [],
    serviceCharges: [],
    ...overrides,
  }
}

const pago = (amount: string, tipAmount: string | null, extra: Record<string, any> = {}) => ({
  id: `pay-${amount}-${tipAmount}`,
  amount: new Decimal(amount),
  tipAmount: tipAmount == null ? null : new Decimal(tipAmount),
  status: 'COMPLETED',
  type: 'REGULAR',
  splitType: 'CUSTOMAMOUNT',
  createdAt: new Date('2026-11-12T18:00:00Z'),
  allocations: [],
  ...extra,
})

describe('order.tpv.service.getOrder — D4: el restante no cobra la propina dos veces', () => {
  beforeEach(() => jest.clearAllMocks())

  // NUEVO ─────────────────────────────────────────────────────────────────────

  it('la mesa de $50 con la parte 1 de $25 + $10 de propina deja $25 por cobrar (no $35)', async () => {
    // El cobro reescribió el total CON la propina: 50 + 10 = 60.
    findUniqueMock.mockResolvedValue(
      cuenta({ total: new Decimal('60.00'), tipAmount: new Decimal('10.00'), payments: [pago('25.00', '10.00')] }),
    )

    const result: any = await orderTpvService.getOrder(VENUE_ID, ORDER_ID)

    expect(result.amount_left).toBe(25)
  })

  it('con la parte 2 de $25 en efectivo la mesa queda en $0 (la terminal ya no pide los $10)', async () => {
    findUniqueMock.mockResolvedValue(
      cuenta({
        paymentStatus: 'PAID',
        total: new Decimal('60.00'),
        tipAmount: new Decimal('10.00'),
        payments: [pago('25.00', '0.00', { id: 'pay-cash' }), pago('25.00', '10.00', { id: 'pay-card' })],
      }),
    )

    const result: any = await orderTpvService.getOrder(VENUE_ID, ORDER_ID)

    expect(result.amount_left).toBe(0)
  })

  it('la propina en las dos partes tampoco se vuelve a pedir', async () => {
    // $100 de cuenta; parte 1 = $40 + $5, parte 2 = $30 + $3 → total 108, faltan $30.
    findUniqueMock.mockResolvedValue(
      cuenta({
        subtotal: new Decimal('100.00'),
        total: new Decimal('108.00'),
        tipAmount: new Decimal('8.00'),
        payments: [pago('30.00', '3.00', { id: 'p2' }), pago('40.00', '5.00', { id: 'p1' })],
      }),
    )

    const result: any = await orderTpvService.getOrder(VENUE_ID, ORDER_ID)

    expect(result.amount_left).toBe(30)
  })

  it('no deja residuo de punto flotante con centavos (0.10 + 0.20)', async () => {
    findUniqueMock.mockResolvedValue(
      cuenta({
        subtotal: new Decimal('10.30'),
        total: new Decimal('10.60'),
        tipAmount: new Decimal('0.30'),
        payments: [pago('10.00', '0.10', { id: 'a' }), pago('0.30', '0.20', { id: 'b' })],
      }),
    )

    const result: any = await orderTpvService.getOrder(VENUE_ID, ORDER_ID)

    expect(result.amount_left).toBe(0)
  })

  // Codex r1 (13-nov): restar `amount + tipAmount` a la COLUMNA `order.total` no basta ──────────────────────────

  it('agregar productos después del primer abono (la columna total queda SIN propina) no cobra de menos', async () => {
    // Mesa de $50, abono $25 + $10; luego una ronda de $10: `addItemsToOrder` guarda subtotal 60 y total 60 (sin la propina).
    findUniqueMock.mockResolvedValue(
      cuenta({
        subtotal: new Decimal('60.00'),
        total: new Decimal('60.00'),
        tipAmount: new Decimal('0.00'),
        payments: [pago('25.00', '10.00')],
      }),
    )

    const result: any = await orderTpvService.getOrder(VENUE_ID, ORDER_ID)

    expect(result.amount_left).toBe(35)
  })

  it('un intento que FALLÓ (p. ej. cripto vencido) no descuenta ni su importe ni su propina', async () => {
    findUniqueMock.mockResolvedValue(cuenta({ payments: [pago('25.00', '10.00', { id: 'cripto-fallido', status: 'FAILED' })] }))

    const result: any = await orderTpvService.getOrder(VENUE_ID, ORDER_ID)

    expect(result.amount_left).toBe(50)
  })

  it('un cobro todavía EN CURSO (QR de cripto vigente) sigue apartando su importe: otra terminal no lo vuelve a ofrecer (Codex r2 #2)', async () => {
    findUniqueMock.mockResolvedValue(cuenta({ payments: [pago('50.00', '0.00', { id: 'cripto-en-vuelo', status: 'PENDING' })] }))

    const result: any = await orderTpvService.getOrder(VENUE_ID, ORDER_ID)

    expect(result.amount_left).toBe(0)
  })

  it('un pedido de Deliverect llevado a la mesa conserva lo que sólo vive en su total (envío/comisión del canal) (Codex r2 #1)', async () => {
    // La ingesta guarda subtotal 140, total 165 (+ $25 del canal) y cargo por servicio 0; su total nunca trae propina.
    findUniqueMock.mockResolvedValue(cuenta({ subtotal: new Decimal('140.00'), total: new Decimal('165.00'), paymentStatus: 'PENDING' }))

    const result: any = await orderTpvService.getOrder(VENUE_ID, ORDER_ID)

    expect(result.amount_left).toBe(165)
  })

  it('un pedido de Deliverect con propina cobrada no resta una propina que su total no trae', async () => {
    findUniqueMock.mockResolvedValue(
      cuenta({ subtotal: new Decimal('140.00'), total: new Decimal('165.00'), payments: [pago('100.00', '15.00', { id: 'externo' })] }),
    )

    const result: any = await orderTpvService.getOrder(VENUE_ID, ORDER_ID)

    expect(result.amount_left).toBe(65)
  })

  it('Deliverect con envío IGUAL a la propina cobrada no se confunde: el envío no es propina (Codex r3 #2)', async () => {
    // Productos $140 + envío $25 = total 165 (sin propina; su `tipAmount` es la del canal, 0). Abono cripto $100 + $25 de propina:
    // B4Bit no reescribe total ni tipAmount. 140 + 25 coincide con 165, pero la columna de propina no: faltan $65 (como antes).
    findUniqueMock.mockResolvedValue(
      cuenta({ subtotal: new Decimal('140.00'), total: new Decimal('165.00'), payments: [pago('100.00', '25.00', { id: 'cripto' })] }),
    )

    const result: any = await orderTpvService.getOrder(VENUE_ID, ORDER_ID)

    expect(result.amount_left).toBe(65)
  })

  it('si no es seguro que el total traiga la propina, queda como antes (abono cripto con propina tras uno con tarjeta)', async () => {
    // $100; tarjeta $25 + $10 (total 110, tipAmount 10); cripto $25 + $5 (B4Bit deja 110 y 10). Antes: 110 − 50 = $60; sigue $60.
    findUniqueMock.mockResolvedValue(
      cuenta({
        subtotal: new Decimal('100.00'),
        total: new Decimal('110.00'),
        tipAmount: new Decimal('10.00'),
        payments: [pago('25.00', '5.00', { id: 'cripto' }), pago('25.00', '10.00', { id: 'tarjeta' })],
      }),
    )

    const result: any = await orderTpvService.getOrder(VENUE_ID, ORDER_ID)

    expect(result.amount_left).toBe(60)
  })

  it('un reembolso de una venta ya pagada no la vuelve a poner a deber (founder, 18-ago)', async () => {
    findUniqueMock.mockResolvedValue(
      cuenta({
        paymentStatus: 'PAID',
        total: new Decimal('60.00'),
        tipAmount: new Decimal('10.00'),
        payments: [
          pago('-5.00', '-2.00', { id: 'devolucion', type: 'REFUND', reopenedAmount: null, reopenedTipAmount: null }),
          pago('50.00', '10.00', { id: 'cobro' }),
        ],
      }),
    )

    const result: any = await orderTpvService.getOrder(VENUE_ID, ORDER_ID)

    expect(result.amount_left).toBe(0)
  })

  it('un abono devuelto que reabre saldo (D19) vuelve a deberse, sin la propina dos veces', async () => {
    // Abono $25 + $10 sobre $50; se devuelven $5 + $2 marcados como reabiertos → faltan 25 + 5 = $30. D19 guarda el total con la
    // regla común: 50 + (10 − 2) = 58.
    findUniqueMock.mockResolvedValue(
      cuenta({
        total: new Decimal('58.00'),
        tipAmount: new Decimal('8.00'),
        payments: [
          pago('-5.00', '-2.00', {
            id: 'devolucion',
            type: 'REFUND',
            reopenedAmount: new Decimal('5.00'),
            reopenedTipAmount: new Decimal('2.00'),
          }),
          pago('25.00', '10.00', { id: 'abono' }),
        ],
      }),
    )

    const result: any = await orderTpvService.getOrder(VENUE_ID, ORDER_ID)

    expect(result.amount_left).toBe(30)
  })

  it('cobrado de más nunca da un restante negativo (la TPV lo lee como «no falta nada»)', async () => {
    findUniqueMock.mockResolvedValue(cuenta({ payments: [pago('60.00', '0.00')] }))

    const result: any = await orderTpvService.getOrder(VENUE_ID, ORDER_ID)

    expect(result.amount_left).toBe(0)
  })

  // REGRESIÓN ─────────────────────────────────────────────────────────────────

  it('sigue igual sin propina: $50 con $20 pagados deja $30', async () => {
    findUniqueMock.mockResolvedValue(cuenta({ payments: [pago('20.00', '0.00')] }))

    const result: any = await orderTpvService.getOrder(VENUE_ID, ORDER_ID)

    expect(result.amount_left).toBe(30)
  })

  it('un pago sin `tipAmount` (null, filas viejas) cuenta como propina 0', async () => {
    findUniqueMock.mockResolvedValue(cuenta({ payments: [pago('20.00', null)] }))

    const result: any = await orderTpvService.getOrder(VENUE_ID, ORDER_ID)

    expect(result.amount_left).toBe(30)
  })

  it('sin pagos el restante es el total de la cuenta', async () => {
    findUniqueMock.mockResolvedValue(cuenta())

    const result: any = await orderTpvService.getOrder(VENUE_ID, ORDER_ID)

    expect(result.amount_left).toBe(50)
  })

  it('la forma de la respuesta no cambia: amount_left sigue siendo un número junto a tableName, lastSplitType y paidItemIds', async () => {
    findUniqueMock.mockResolvedValue(cuenta({ total: new Decimal('60.00'), payments: [pago('25.00', '10.00')] }))

    const result: any = await orderTpvService.getOrder(VENUE_ID, ORDER_ID)

    expect(typeof result.amount_left).toBe('number')
    expect(result.tableName).toBe('Mesa 4')
    expect(result.lastSplitType).toBe('CUSTOMAMOUNT')
    expect(result.paidItemIds).toEqual([])
  })
})
