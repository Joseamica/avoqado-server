/**
 * D41 «C» (founder, 16-nov; tarjeta `hz:nube0000:naec8c3f`): la reimpresión de las apps pinta los renglones con lo que cuadra con el
 * comprobante. Coca $25 + Agua $20 de cortesía + Café $30, 10 % de cuenta, cobrado $49.50. Mesas guarda la Agua en $0; el comprobante ya
 * dice $75 · −$25.50. Las apps publicadas siguen leyendo `ticketTotals` sin la cortesía ($55, cuadra con sus renglones en $0); la nueva
 * suma `cortesiaDelTicket` y pinta cada renglón con `totalEnElTicket` (aditivos). `total` NO cambia: lo leen las devoluciones.
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import * as refundService from '@/services/dashboard/refund.dashboard.service'
import { getTransactionDetail } from '@/services/mobile/transaction.mobile.service'

jest.mock('@/services/dashboard/refund.dashboard.service', () => ({ listRefundsForPayment: jest.fn() }))
jest.mock('@/services/exchanges/exchangeDetail', () => ({
  exchangeDetailFields: jest.fn(async () => ({ fields: {}, itemExtras: new Map() })),
}))

const prismaMock = prisma as any

const renglon = (id: string, nombre: string, total: number, extra: Record<string, unknown> = {}) => ({
  id,
  productName: nombre,
  quantity: 1,
  unitPrice: total,
  total: new Prisma.Decimal(total),
  isCortesia: false,
  discountAmount: new Prisma.Decimal(0),
  product: null,
  modifiers: [],
  ...extra,
})
const coca = renglon('i1', 'Coca', 25)
const agua = renglon('i2', 'Agua', 0, { unitPrice: 20, isCortesia: true, discountAmount: new Prisma.Decimal(20) })
const cafe = renglon('i3', 'Café', 30)

const cobro = {
  id: 'pay_1',
  amount: new Prisma.Decimal('49.50'),
  tipAmount: new Prisma.Decimal('0'),
  method: 'CASH',
  status: 'COMPLETED',
  type: 'REGULAR',
  cardBrand: null,
  maskedPan: null,
  referenceNumber: null,
  authorizationNumber: null,
  createdAt: new Date('2026-11-17T18:00:00.000Z'),
  processedBy: null,
  orderId: 'o1',
  order: {
    orderNumber: '42',
    type: 'DINE_IN',
    status: 'COMPLETED',
    paymentStatus: 'PAID',
    customerId: null,
    orderCustomers: [],
    table: { number: '5' },
    items: [coca, agua, cafe],
  },
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(refundService.listRefundsForPayment as jest.Mock).mockResolvedValue([])
  prismaMock.orderItem.findMany.mockResolvedValue([])
  prismaMock.$queryRaw.mockResolvedValue([])
  prismaMock.payment.findFirst.mockResolvedValue(cobro)
})

describe('getTransactionDetail · la cortesía en $0 de Mesas (D41 «C»)', () => {
  it('sin recibo emitido: las apps publicadas leen $55 · −$5.50 (sus renglones suman $55); la nueva suma `cortesiaDelTicket`', async () => {
    prismaMock.digitalReceipt.findFirst.mockResolvedValue(null)
    // `cargarTotalesDelTicket`: el cobro, los importes guardados de la orden y la suma de su cortesía en $0 (en la base).
    prismaMock.payment.findUnique.mockResolvedValue({
      amount: cobro.amount,
      tipAmount: cobro.tipAmount,
      type: 'REGULAR',
      status: 'COMPLETED',
      orderId: 'o1',
      order: {
        subtotal: new Prisma.Decimal(55),
        discountAmount: new Prisma.Decimal('5.50'),
        serviceChargeAmount: new Prisma.Decimal(0),
        taxAmount: new Prisma.Decimal(0),
        contratoDePrecio: 'IVA_INCLUIDO',
        status: 'COMPLETED',
        _count: { payments: 1 },
      },
    })
    prismaMock.orderItem.aggregate.mockResolvedValue({ _sum: { discountAmount: new Prisma.Decimal(20) } })
    const detalle: any = await getTransactionDetail('v1', 'pay_1')
    // Codex r2 #1: iOS publicado y ANDROID viejo pintan la Agua con `total` (0): su comprobante sigue siendo el de hoy.
    expect(detalle.ticketTotals).toEqual({
      kind: 'COBRO',
      desglosado: true,
      subtotal: 55,
      discount: 5.5,
      serviceCharge: 0,
      addedTax: 0,
      tip: 0,
      total: 49.5,
    })
    expect(detalle.cortesiaDelTicket).toBe(20)
    expect(detalle.items.map((i: any) => [i.productName, i.total, i.totalEnElTicket])).toEqual([
      ['Coca', 25, 25],
      ['Agua', 0, 20],
      ['Café', 30, 30],
    ])
    const select = prismaMock.payment.findFirst.mock.calls[0][0].select
    expect(select.order.select.items.select).toMatchObject({ total: true, isCortesia: true, discountAmount: true })
  })

  it('con un recibo NUEVO (congeló $75 · −$25.50 con `cortesia`): mismo contrato que sin recibo', async () => {
    const congelado = {
      kind: 'COBRO',
      desglosado: true,
      subtotal: 75,
      discount: 25.5,
      cortesia: 20,
      serviceCharge: 0,
      addedTax: 0,
      tip: 0,
      total: 49.5,
    }
    prismaMock.digitalReceipt.findFirst.mockResolvedValue({
      dataSnapshot: { ticketTotals: congelado, payment: { amount: 49.5, tipAmount: 0 } },
    })
    const detalle: any = await getTransactionDetail('v1', 'pay_1')
    expect(detalle.ticketTotals).toEqual({
      kind: 'COBRO',
      desglosado: true,
      subtotal: 55,
      discount: 5.5,
      serviceCharge: 0,
      addedTax: 0,
      tip: 0,
      total: 49.5,
    })
    expect(detalle.cortesiaDelTicket).toBe(20)
    expect(detalle.items.map((i: any) => i.totalEnElTicket)).toEqual([25, 20, 30])
  })

  it('con un recibo emitido ANTES (congeló $55 · −$5.50, sin `cortesia`): todo como se guardó, sin `cortesiaDelTicket`', async () => {
    const congelado = { kind: 'COBRO', desglosado: true, subtotal: 55, discount: 5.5, serviceCharge: 0, addedTax: 0, tip: 0, total: 49.5 }
    prismaMock.digitalReceipt.findFirst.mockResolvedValue({
      dataSnapshot: { ticketTotals: congelado, payment: { amount: 49.5, tipAmount: 0 } },
    })
    const detalle: any = await getTransactionDetail('v1', 'pay_1')
    expect(detalle.ticketTotals).toEqual(congelado)
    expect(detalle).not.toHaveProperty('cortesiaDelTicket')
    expect(detalle.items.map((i: any) => i.totalEnElTicket)).toEqual([25, 0, 30])
  })
})
