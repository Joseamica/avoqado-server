/**
 * C2 A-R4 (decisión A del founder, 9-oct): los dos detalles que alimentan las pantallas de reembolso traen, por artículo, el campo
 * OPCIONAL `chargedTotal` (pesos): lo que cobró el renglón completo, con el MISMO cargador que usa el escritor. Se omite si la venta no
 * es atribuible (A-R3). Nunca se quita ni renombra un campo: `total` sigue siendo el de siempre.
 *  - POS móvil (Android/iOS): `getTransactionDetail` → `items[]`.
 *  - Dashboard (`PaymentDrawerContent.tsx` lee `GET /dashboard/venues/:venueId/payments/:paymentId`): `getPaymentById` → `order.items[]`.
 */
import { Decimal } from '@prisma/client/runtime/library'
import prisma from '@/utils/prismaClient'
import * as refundService from '@/services/dashboard/refund.dashboard.service'
import { getTransactionDetail } from '@/services/mobile/transaction.mobile.service'
import { getPaymentById } from '@/services/dashboard/payment.dashboard.service'

jest.mock('@/services/dashboard/refund.dashboard.service', () => ({ listRefundsForPayment: jest.fn() }))

const prismaMock = prisma as any
const espejo = (renglones: Record<string, number>) => ({ v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: true, renglones })

/** Un renglón con lo que leen los detalles y el cargador (`SELECT_RENGLON`). */
const linea = (id: string, o: Record<string, unknown> = {}) => ({
  id,
  orderId: 'order-1',
  productName: id,
  quantity: 1,
  unitPrice: new Decimal(100),
  total: new Decimal(100),
  discountAmount: new Decimal(0),
  orderPromotionId: null,
  isCortesia: false,
  ivaTratamiento: null,
  product: { name: id, imageUrl: null, trackInventory: false, taxRate: new Decimal(0.16), ivaTratamiento: 'IVA_16' },
  modifiers: [],
  ...o,
})
/** E2: A $100 −$10 propio + B $50. */
const E2 = [linea('A', { discountAmount: new Decimal(10) }), linea('B', { unitPrice: new Decimal(50), total: new Decimal(50) })]

/** La venta que ve el cargador: cabecera, renglones y filas de descuento. */
function venta(lineas: unknown[], cabecera: number, filas: Array<{ amount: number; reparto: unknown }>) {
  prismaMock.order.findUnique.mockResolvedValue({ discountAmount: new Decimal(cabecera), contratoDePrecio: null, originSystem: null })
  prismaMock.orderItem.findMany.mockResolvedValue(lineas)
  prismaMock.$queryRaw.mockResolvedValue(
    filas.map((f, i) => ({ id: `d${i}`, orderId: 'order-1', amount: new Decimal(f.amount), reparto: f.reparto })),
  )
}
const pago = (lineas: unknown[]) => ({
  id: 'pay_1',
  orderId: 'order-1',
  amount: new Decimal(140),
  tipAmount: new Decimal(0),
  method: 'CASH',
  status: 'COMPLETED',
  cardBrand: null,
  maskedPan: null,
  referenceNumber: null,
  authorizationNumber: null,
  createdAt: new Date('2026-10-09T16:00:00.000Z'),
  processedBy: null,
  processorData: {},
  order: { id: 'order-1', orderNumber: 'A-1', items: lineas },
})

beforeEach(() => {
  jest.clearAllMocks()
  ;(refundService.listRefundsForPayment as jest.Mock).mockResolvedValue([])
})
afterEach(() => {
  prismaMock.$queryRaw.mockReset()
  prismaMock.orderItem.findMany.mockReset()
  prismaMock.orderItem.findMany.mockResolvedValue([])
})

describe('C2 A-R4 · `chargedTotal` en el detalle del POS móvil', () => {
  it('🔴 cada artículo trae lo que cobró (A $90, B $50); `total` sigue siendo el bruto de siempre', async () => {
    prismaMock.payment.findFirst.mockResolvedValue(pago(E2))
    venta(E2, 10, [{ amount: 10, reparto: espejo({ A: 1000 }) }])

    const d = await getTransactionDetail('venue_1', 'pay_1')

    expect(d.items).toEqual([
      expect.objectContaining({ id: 'A', total: 100, chargedTotal: 90 }),
      expect.objectContaining({ id: 'B', total: 50, chargedTotal: 50 }),
    ])
  })

  it('🔴 venta no atribuible (descuento sin reparto mayor que lo vendido) ⇒ el campo se OMITE', async () => {
    prismaMock.payment.findFirst.mockResolvedValue(pago(E2))
    venta(E2, 300, [{ amount: 300, reparto: null }])

    const d = await getTransactionDetail('venue_1', 'pay_1')

    for (const it of d.items) expect(it).not.toHaveProperty('chargedTotal')
    expect(d.items[0]).toMatchObject({ total: 100 })
  })
})

describe('C2 A-R4 · `chargedTotal` en el detalle del pago del dashboard', () => {
  it('🔴 `order.items[]` trae lo que cobró cada artículo (A $90, B $50) sin tocar los campos de siempre', async () => {
    prismaMock.payment.findFirst.mockResolvedValue(pago(E2))
    venta(E2, 10, [{ amount: 10, reparto: espejo({ A: 1000 }) }])

    const p: any = await getPaymentById('venue_1', 'pay_1')

    expect(p.order.items).toEqual([
      expect.objectContaining({ id: 'A', total: new Decimal(100), chargedTotal: 90 }),
      expect.objectContaining({ id: 'B', total: new Decimal(50), chargedTotal: 50 }),
    ])
    expect(p.order.orderNumber).toBe('A-1')
  })

  it('🔴 venta no atribuible ⇒ el campo se OMITE', async () => {
    prismaMock.payment.findFirst.mockResolvedValue(pago(E2))
    venta(E2, 300, [{ amount: 300, reparto: null }])

    const p: any = await getPaymentById('venue_1', 'pay_1')

    for (const it of p.order.items) expect(it).not.toHaveProperty('chargedTotal')
  })

  it('control — un pago sin orden se devuelve tal cual', async () => {
    prismaMock.payment.findFirst.mockResolvedValue({ ...pago([]), orderId: null, order: null })

    const p: any = await getPaymentById('venue_1', 'pay_1')

    expect(p.order).toBeNull()
  })
})
