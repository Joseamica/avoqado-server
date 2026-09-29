/**
 * El detalle de una venta para el POS trae el saldo reembolsable POR COMPONENTE (venta y propina), de forma ADITIVA.
 *
 * Origen (Testarudo, 17-sep-2026): un cobro CASH de $200 + $20 de propina. El cajero desmarcó «Incluir propina» y dejó el
 * importe en $220 (el máximo que la app muestra INCLUYE la propina), la app mandó `amount: 22000, tipRefundCents: 0` y el
 * servidor rechazó, con razón, «Sale portion of refund (22000) exceeds original sale amount (20000)». Cinco 400 seguidos; el
 * reembolso salió 4.7 h después por otro camino. La app no puede calcular el tope correcto con lo que hoy le mandamos: el
 * detalle sólo trae `remainingRefundable` (venta + propina) y cada reembolso previo sólo con su total, sin su reparto.
 *
 * Contrato aditivo — nada se quita ni cambia de significado:
 *   - `remainingRefundableSale` = venta original − Σ venta ya devuelta (nunca negativo)
 *   - `remainingRefundableTip`  = propina original − Σ propina ya devuelta (nunca negativo)
 *   - cada reembolso trae `saleAmount` y `tipAmount` (positivos, como su `amount`)
 * Un reembolso HISTÓRICO sin reparto (anterior al 19-abr-2026: todo en `amount`, propina 0) se descuenta entero de la
 * venta: la app ofrece de MENOS, nunca de más, y el servidor sigue siendo quien valida.
 */
import prisma from '@/utils/prismaClient'
import * as refundService from '@/services/dashboard/refund.dashboard.service'
import { getTransactionDetail } from '@/services/mobile/transaction.mobile.service'

jest.mock('@/services/dashboard/refund.dashboard.service', () => ({ listRefundsForPayment: jest.fn() }))

const prismaMock = prisma as any
const listRefunds = refundService.listRefundsForPayment as jest.Mock

const cobro = (over: Record<string, unknown> = {}) => ({
  id: 'pay_1',
  amount: 200,
  tipAmount: 20,
  method: 'CASH',
  status: 'COMPLETED',
  cardBrand: null,
  maskedPan: null,
  referenceNumber: null,
  authorizationNumber: null,
  createdAt: new Date('2026-09-17T16:37:14.456Z'),
  processedBy: null,
  order: null,
  ...over,
})
/** Lo que devuelve `listRefundsForPayment`: `amount` = total NEGATIVO; `saleAmount`/`tipAmount` = el reparto, negativos. */
const reembolso = (sale: number, tip: number, id = `ref_${sale}_${tip}`) => ({
  id,
  amount: -(sale + tip),
  saleAmount: -sale,
  tipAmount: -tip,
  status: 'COMPLETED',
  method: 'CASH',
  createdAt: new Date('2026-09-17T18:00:00.000Z'),
  processedBy: null,
  processorData: { originalPaymentId: 'pay_1', refundReason: 'OTHER' },
})

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.payment.findFirst.mockResolvedValue(cobro())
})

describe('getTransactionDetail · saldo reembolsable por componente', () => {
  it('sin reembolsos: la venta y la propina completas, y el total de siempre intacto', async () => {
    listRefunds.mockResolvedValue([])
    const detalle = await getTransactionDetail('venue_1', 'pay_1')
    expect(detalle).toMatchObject({ remainingRefundable: 220, remainingRefundableSale: 200, remainingRefundableTip: 20 })
  })

  it('con un reembolso repartido ($50 de venta + $5 de propina): cada componente descuenta lo suyo y el reembolso expone su reparto', async () => {
    listRefunds.mockResolvedValue([reembolso(50, 5)])
    const detalle = await getTransactionDetail('venue_1', 'pay_1')
    expect(detalle).toMatchObject({ remainingRefundable: 165, remainingRefundableSale: 150, remainingRefundableTip: 15 })
    expect(detalle.refunds[0]).toMatchObject({ amount: 55, saleAmount: 50, tipAmount: 5 })
  })

  it('un reembolso «sólo venta» ($90, propina 0) deja la propina completa y la venta en $110', async () => {
    listRefunds.mockResolvedValue([reembolso(90, 0)])
    const detalle = await getTransactionDetail('venue_1', 'pay_1')
    expect(detalle).toMatchObject({ remainingRefundableSale: 110, remainingRefundableTip: 20 })
  })

  it('un reembolso HISTÓRICO sin reparto (todo en amount) se descuenta de la venta: la app ofrece de menos, nunca de más', async () => {
    listRefunds.mockResolvedValue([{ ...reembolso(0, 0, 'ref_legacy'), amount: -60, saleAmount: -60, tipAmount: 0 }])
    const detalle = await getTransactionDetail('venue_1', 'pay_1')
    expect(detalle).toMatchObject({ remainingRefundable: 160, remainingRefundableSale: 140, remainingRefundableTip: 20 })
  })

  it('nunca negativo: devoluciones que exceden un componente lo dejan en 0', async () => {
    listRefunds.mockResolvedValue([reembolso(200, 0), reembolso(10, 20, 'ref_b')])
    const detalle = await getTransactionDetail('venue_1', 'pay_1')
    expect(detalle).toMatchObject({ remainingRefundable: 0, remainingRefundableSale: 0, remainingRefundableTip: 0 })
  })

  // ── Task 6 (Codex, 29-sep): los topes cuentan EXACTAMENTE como `issueRefund` (`centavosYaDevueltos` +
  //    `centavosDevueltosPorComponente`): sólo COMPLETED, el MÁXIMO contra el acumulado histórico, en centavos enteros.

  it('B2: un reembolso FAILED de $220 no se resta — no movió dinero, el reintento sigue ofreciendo todo', async () => {
    listRefunds.mockResolvedValue([{ ...reembolso(200, 20, 'ref_failed'), status: 'FAILED' }])
    const detalle = await getTransactionDetail('venue_1', 'pay_1')
    expect(detalle).toMatchObject({ remainingRefundable: 220, remainingRefundableSale: 200, remainingRefundableTip: 20 })
  })

  it('B2: PENDING y CANCELLED tampoco cuentan; el COMPLETED de la misma lista sí', async () => {
    listRefunds.mockResolvedValue([
      { ...reembolso(100, 0, 'ref_pending'), status: 'PENDING' },
      { ...reembolso(60, 0, 'ref_cancelled'), status: 'CANCELLED' },
      reembolso(50, 5, 'ref_ok'),
    ])
    const detalle = await getTransactionDetail('venue_1', 'pay_1')
    expect(detalle).toMatchObject({ remainingRefundable: 165, remainingRefundableSale: 150, remainingRefundableTip: 15 })
  })

  it('B4: acumulado histórico SIN filas ($60 en processorData) — la app ofrece lo que el servidor permite, no más', async () => {
    prismaMock.payment.findFirst.mockResolvedValue(cobro({ processorData: { refundedAmountCents: 6000 } }))
    listRefunds.mockResolvedValue([])
    const detalle = await getTransactionDetail('venue_1', 'pay_1')
    // total 220 − 60 = 160; la venta (200) se topa con ese total; la propina (20) cabe entera.
    expect(detalle).toMatchObject({ remainingRefundable: 160, remainingRefundableSale: 160, remainingRefundableTip: 20 })
  })

  it('B4: acumulado histórico que agota TODO ($210 de $220, sin filas) — la propina también se topa con el total restante', async () => {
    prismaMock.payment.findFirst.mockResolvedValue(cobro({ processorData: { refundedAmountCents: 21000 } }))
    listRefunds.mockResolvedValue([])
    const detalle = await getTransactionDetail('venue_1', 'pay_1')
    // total 220 − 210 = 10; ni la venta (200) ni la propina (20) pueden ofrecer más que eso.
    expect(detalle).toMatchObject({ remainingRefundable: 10, remainingRefundableSale: 10, remainingRefundableTip: 10 })
  })

  it('B4: gana el MÁXIMO entre las filas y el acumulado — el acumulado más corto no afloja nada', async () => {
    prismaMock.payment.findFirst.mockResolvedValue(cobro({ processorData: { refundedAmountCents: 1000 } }))
    listRefunds.mockResolvedValue([reembolso(50, 5)])
    const detalle = await getTransactionDetail('venue_1', 'pay_1')
    expect(detalle).toMatchObject({ remainingRefundable: 165, remainingRefundableSale: 150, remainingRefundableTip: 15 })
  })

  it('B4: acumulado en pesos (formato viejo, sin `refundedAmountCents`) también se respeta', async () => {
    prismaMock.payment.findFirst.mockResolvedValue(cobro({ processorData: { refundedAmount: 60 } }))
    listRefunds.mockResolvedValue([])
    const detalle = await getTransactionDetail('venue_1', 'pay_1')
    expect(detalle.remainingRefundable).toBe(160)
  })

  it('centavos enteros: $1.00 − $0.67 es exactamente 0.33 (no 0.32999999999999996)', async () => {
    prismaMock.payment.findFirst.mockResolvedValue(cobro({ amount: 1, tipAmount: 0 }))
    listRefunds.mockResolvedValue([reembolso(0.67, 0)])
    const detalle = await getTransactionDetail('venue_1', 'pay_1')
    expect(detalle.remainingRefundable).toBe(0.33)
    expect(detalle.remainingRefundableSale).toBe(0.33)
  })

  it('las CANTIDADES por artículo siguen contando TODOS los estados (el servidor reserva el offset por pieza así)', async () => {
    prismaMock.payment.findFirst.mockResolvedValue(
      cobro({
        order: {
          orderNumber: 'ORD-1',
          items: [{ id: 'oi_1', productName: 'Café', quantity: 3, unitPrice: 50, total: 150, product: null, modifiers: [] }],
        },
      }),
    )
    const fallido = {
      ...reembolso(50, 0, 'ref_failed_item'),
      status: 'FAILED',
      processorData: { originalPaymentId: 'pay_1', refundedItems: [{ orderItemId: 'oi_1', quantity: 1, amountCents: 5000 }] },
    }
    listRefunds.mockResolvedValue([fallido])
    const detalle = await getTransactionDetail('venue_1', 'pay_1')
    expect(detalle.remainingRefundable).toBe(220) // el dinero: el FAILED no cuenta
    expect(detalle.items[0]).toMatchObject({ refundedQty: 1, remainingQty: 2 }) // la pieza: el FAILED sí reserva
  })
})
