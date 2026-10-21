/**
 * IVA por producto, plan 7 (r2 R2-13): el detalle de orden dice el IVA que la orden de verdad SUMA aparte. Con contrato
 * IVA_INCLUIDO y un `taxAmount` escrito (el contraejemplo de la Tarea 1) no hay IVA agregado.
 */
import prisma from '@/utils/prismaClient'
import { getOrder } from '@/services/mobile/order.mobile.service'

const prismaMock = prisma as any
const orden = (o: Record<string, unknown>) => ({
  id: 'o1',
  orderNumber: '42',
  status: 'COMPLETED',
  paymentStatus: 'PAID',
  type: 'TAKEOUT',
  source: 'AVOQADO_ANDROID',
  subtotal: 100,
  discountAmount: 0,
  tipAmount: 0,
  total: 100,
  servedBy: null,
  servedById: null,
  items: [],
  payments: [],
  ...o,
})

it('🔴 contrato IVA_INCLUIDO con taxAmount 16 escrito: addedTaxAmount 0 (el precio ya lo traía)', async () => {
  prismaMock.order.findUnique.mockResolvedValue(orden({ taxAmount: 16, contratoDePrecio: 'IVA_INCLUIDO' }))
  expect((await getOrder('v1', 'o1')).addedTaxAmount).toBe(0)
})

it('IVA aparte (SoftRestaurant, DESCONOCIDO): addedTaxAmount = el IVA de la orden; taxAmount de siempre intacto', async () => {
  prismaMock.order.findUnique.mockResolvedValue(orden({ taxAmount: 16, total: 116, contratoDePrecio: 'DESCONOCIDO' }))
  const o = await getOrder('v1', 'o1')
  expect(o.addedTaxAmount).toBe(16)
  expect(o.taxAmount).toBe(16)
})

it('🔴 orden CANCELADA con taxAmount 16 y contrato DESCONOCIDO: addedTaxAmount 0 (una cancelada no cobró IVA aparte; revisión T4 M2)', async () => {
  prismaMock.order.findUnique.mockResolvedValue(orden({ status: 'CANCELLED', taxAmount: 16, total: 116, contratoDePrecio: 'DESCONOCIDO' }))
  expect((await getOrder('v1', 'o1')).addedTaxAmount).toBe(0)
})

describe('getOrder — saldo aditivo para precuenta, sin cambiar los importes legacy', () => {
  // Captura la omisión del snapshot o una resta local que trate la propina/refund como mercancía.
  // Sólo Prisma está aislado: getOrder y el calculador monetario son los reales.
  const pago = (amount: number, tipAmount = 0, status = 'COMPLETED', type = 'REGULAR') => ({
    id: `FULLTEST-${status}-${type}-${amount}-${tipAmount}`,
    amount,
    tipAmount,
    status,
    type,
    method: 'CASH',
    createdAt: new Date('2026-10-12T12:00:00Z'),
    processedBy: null,
  })

  const casos = [
    {
      nombre: 'sin abonos: 170 + cargo17 = 187, pagado0, restante187',
      datos: {},
      saldo: { orderTotalCents: 18700, totalPaidCents: 0, remainingBalanceCents: 18700, tipAmountCents: 0 },
    },
    {
      nombre: 'abono50 sin propina deja137 por pagar',
      datos: { payments: [pago(50)], paymentStatus: 'PARTIAL' },
      saldo: { orderTotalCents: 18700, totalPaidCents: 5000, remainingBalanceCents: 13700, tipAmountCents: 0 },
    },
    {
      nombre: 'abono50 + propina10: total197, pagado60, restante137, nunca127',
      datos: { payments: [pago(50, 10)], tipAmount: 10, total: 197, paymentStatus: 'PARTIAL' },
      saldo: { orderTotalCents: 19700, totalPaidCents: 6000, remainingBalanceCents: 13700, tipAmountCents: 1000 },
    },
    {
      nombre: 'total legacy187 con propina cobrada10 conserva187 pero el snapshot canónico es197',
      datos: { payments: [pago(50, 10)], paymentStatus: 'PARTIAL' },
      saldo: { orderTotalCents: 19700, totalPaidCents: 6000, remainingBalanceCents: 13700, tipAmountCents: 1000 },
    },
    {
      nombre: 'refund COMPLETED completo no reabre deuda ni resta la propina cobrada',
      datos: { payments: [pago(187, 10), pago(-187, -10, 'COMPLETED', 'REFUND')], tipAmount: 10, total: 197, paymentStatus: 'PAID' },
      saldo: { orderTotalCents: 19700, totalPaidCents: 19700, remainingBalanceCents: 0, tipAmountCents: 1000 },
      refundState: 'FULL',
      refundedAmount: 197,
    },
    {
      nombre: 'abono50 y refund parcial20 COMPLETED: pagado50, restante137',
      datos: { payments: [pago(50), pago(-20, 0, 'COMPLETED', 'REFUND')], paymentStatus: 'PARTIAL' },
      saldo: { orderTotalCents: 18700, totalPaidCents: 5000, remainingBalanceCents: 13700, tipAmountCents: 0 },
      refundState: 'PARTIAL',
      refundedAmount: 20,
    },
    {
      nombre: 'pagos PENDING/FAILED y refunds PENDING/FAILED no cuentan como dinero ocurrido',
      datos: {
        payments: [
          pago(50),
          pago(70, 10, 'PENDING'),
          pago(67, 5, 'FAILED'),
          pago(-20, 0, 'PENDING', 'REFUND'),
          pago(-30, 0, 'FAILED', 'REFUND'),
        ],
        paymentStatus: 'PARTIAL',
      },
      saldo: { orderTotalCents: 18700, totalPaidCents: 5000, remainingBalanceCents: 13700, tipAmountCents: 0 },
    },
    {
      nombre: 'IVA incluido16 histórico no suma IVA aparte al saldo170/17',
      datos: { taxAmount: 16 },
      saldo: { orderTotalCents: 18700, totalPaidCents: 0, remainingBalanceCents: 18700, tipAmountCents: 0 },
    },
    {
      nombre: 'DESCONOCIDO100 + IVA registrado16 =116 sin inventar porcentaje',
      datos: { subtotal: 100, serviceChargeAmount: 0, taxAmount: 16, contratoDePrecio: 'DESCONOCIDO', total: 116 },
      saldo: { orderTotalCents: 11600, totalPaidCents: 0, remainingBalanceCents: 11600, tipAmountCents: 0 },
      addedTax: 16,
    },
    {
      nombre: 'descuento10 mantiene170 +17 -10 =177, abono50 deja127',
      datos: { discountAmount: 10, total: 177, payments: [pago(50)], paymentStatus: 'PARTIAL' },
      saldo: { orderTotalCents: 17700, totalPaidCents: 5000, remainingBalanceCents: 12700, tipAmountCents: 0 },
    },
  ]

  it.each(casos)('$nombre', async ({ datos, saldo, addedTax = 0, refundState = 'NONE', refundedAmount = 0 }) => {
    const fixture = orden({
      id: 'FULLTEST-prebill-order',
      venueId: 'FULLTEST-prebill-venue',
      status: 'PENDING',
      paymentStatus: 'PENDING',
      type: 'DINE_IN',
      orderType: 'DINE_IN',
      subtotal: 170,
      serviceChargeAmount: 17,
      total: 187,
      taxAmount: 0,
      contratoDePrecio: 'IVA_INCLUIDO',
      createdAt: new Date('2026-10-12T12:00:00Z'),
      version: 9,
      serviceCharges: [],
      orderDiscounts: [],
      promotions: [],
      ...datos,
    })
    prismaMock.order.findUnique.mockClear()
    prismaMock.order.findUnique.mockResolvedValue(fixture)

    const result = await getOrder('FULLTEST-prebill-venue', 'FULLTEST-prebill-order')

    expect(result).toHaveProperty('preBillBalance')
    expect(result).toMatchObject({ preBillBalance: saldo, total: fixture.total, tipAmount: fixture.tipAmount })
    expect(result).toMatchObject({ addedTaxAmount: addedTax, refundState, refundedAmount })
    expect(prismaMock.order.findUnique).toHaveBeenCalledTimes(1)
    expect(prismaMock.order.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'FULLTEST-prebill-order', venueId: 'FULLTEST-prebill-venue' } }),
    )
  })
})
