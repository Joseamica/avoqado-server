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
      dataSnapshot: { ticketTotals: congelado, payment: { amount: 49.5, tipAmount: 0 }, order: { id: 'o1' } },
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

  it('Codex r5 #1: el recibo trae la cortesía pero el cobro ya está en OTRA orden (Soporte lo movió) sin ella: no viaja, y renglones y subtotal cuadran como antes', async () => {
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
      dataSnapshot: { ticketTotals: congelado, payment: { amount: 49.5, tipAmount: 0 }, order: { id: 'o1' } },
    })
    // La orden destino: $55 cobrables, sin cortesía.
    prismaMock.payment.findFirst.mockResolvedValue({ ...cobro, orderId: 'o2', order: { ...cobro.order, items: [coca, cafe] } })
    const detalle: any = await getTransactionDetail('v1', 'pay_1')
    expect(detalle).not.toHaveProperty('cortesiaDelTicket')
    expect(detalle.ticketTotals.subtotal).toBe(55)
    expect(detalle.items.map((i: any) => i.totalEnElTicket)).toEqual([25, 30])
  })

  it('Codex r6 #1: el cobro se movió a otra orden que TAMBIÉN regaló $20 (otros renglones): no viaja, porque el recibo es de otra orden', async () => {
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
      dataSnapshot: { ticketTotals: congelado, payment: { amount: 49.5, tipAmount: 0 }, order: { id: 'o1' } },
    })
    const te = renglon('i9', 'Té', 0, { unitPrice: 20, isCortesia: true, discountAmount: new Prisma.Decimal(20) })
    prismaMock.payment.findFirst.mockResolvedValue({ ...cobro, orderId: 'o2', order: { ...cobro.order, items: [coca, te, cafe] } })
    const detalle: any = await getTransactionDetail('v1', 'pay_1')
    expect(detalle).not.toHaveProperty('cortesiaDelTicket')
    expect(detalle.items.map((i: any) => i.totalEnElTicket)).toEqual([25, 0, 30])
  })

  it('con un recibo emitido ANTES (congeló $55 · −$5.50, sin `cortesia`): todo como se guardó, sin `cortesiaDelTicket`', async () => {
    const congelado = { kind: 'COBRO', desglosado: true, subtotal: 55, discount: 5.5, serviceCharge: 0, addedTax: 0, tip: 0, total: 49.5 }
    prismaMock.digitalReceipt.findFirst.mockResolvedValue({
      dataSnapshot: { ticketTotals: congelado, payment: { amount: 49.5, tipAmount: 0 }, order: { id: 'o1' } },
    })
    const detalle: any = await getTransactionDetail('v1', 'pay_1')
    expect(detalle.ticketTotals).toEqual(congelado)
    expect(detalle).not.toHaveProperty('cortesiaDelTicket')
    expect(detalle.items.map((i: any) => i.totalEnElTicket)).toEqual([25, 0, 30])
  })
})

// Encargo 27fd34 (Codex r7 #1): un cobro que Soporte movió a otra cuenta DESPUÉS de emitir su recibo se reimprime como la FOTOCOPIA de
// ese recibo (`lineasDelTicket`, que ANDROID e iOS 1.15.12 ya pintan desde D1): mismos renglones, subtotal y descuento que el digital.
describe('getTransactionDetail · fotocopia del recibo de un cobro movido (encargo 27fd34)', () => {
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
  // Como lo guarda el generador del DASHBOARD (`order.items`, con la Agua a su bruto porque el desglose sumó la cortesía).
  const delPanel = [
    {
      name: 'Coca',
      quantity: 1,
      price: 25,
      totalPrice: 25,
      weightKg: null,
      modifiers: [
        { name: 'Sin hielo', price: 0 },
        { name: 'Limón', price: 0, quantity: 2 },
      ],
    },
    { name: 'Agua', quantity: 1, price: 20, totalPrice: 20, weightKg: null, modifiers: [] },
    { name: 'Café', quantity: 1, price: 30, totalPrice: 30, weightKg: null, modifiers: [] },
  ]
  const movido = () =>
    prismaMock.payment.findFirst.mockResolvedValue({ ...cobro, orderId: 'o2', order: { ...cobro.order, items: [coca, cafe] } })

  it('recibo del panel: la reimpresión trae la fotocopia ($75 · −$25.50, Agua $20), igual que el digital', async () => {
    prismaMock.digitalReceipt.findFirst.mockResolvedValue({
      dataSnapshot: { ticketTotals: congelado, payment: { amount: 49.5, tipAmount: 0 }, order: { id: 'o1', items: delPanel } },
    })
    movido()
    const detalle: any = await getTransactionDetail('v1', 'pay_1')
    expect(detalle.lineasDelTicket).toEqual({
      lineas: [
        { nombre: 'Coca', cantidad: 1, unitarioCents: 2500, totalCents: 2500, modificadores: ['Sin hielo', 'Limón'] },
        { nombre: 'Agua', cantidad: 1, unitarioCents: 2000, totalCents: 2000 },
        { nombre: 'Café', cantidad: 1, unitarioCents: 3000, totalCents: 3000 },
      ],
      subtotalCents: 7500,
      descuentoCents: 2550,
    })
    // Lo que ya existía no cambia: las apps sin D1 reimprimen como antes.
    expect(detalle).not.toHaveProperty('cortesiaDelTicket')
    expect(detalle.ticketTotals.subtotal).toBe(55)
  })

  it('recibo de la terminal (`items` fuera de `order`) con un renglón pesado: conserva el peso como el digital (Codex r1 #4)', async () => {
    prismaMock.digitalReceipt.findFirst.mockResolvedValue({
      dataSnapshot: {
        ticketTotals: { kind: 'COBRO', desglosado: true, subtotal: 182.7, serviceCharge: 0, addedTax: 0, tip: 10, total: 192.7 },
        payment: { amount: 182.7, tipAmount: 10 },
        order: { id: 'o1' },
        items: [{ productName: 'Queso', quantity: 1, unitPrice: 420, total: 182.7, weightKg: 0.435, modifiers: [] }],
      },
    })
    movido()
    const detalle: any = await getTransactionDetail('v1', 'pay_1')
    expect(detalle.lineasDelTicket).toEqual({
      lineas: [{ nombre: 'Queso', cantidad: 1, unitarioCents: 42000, totalCents: 18270, peso: '0.435 kg × $420.00/kg' }],
      subtotalCents: 18270,
      descuentoCents: 0,
    })
  })

  it('sin moverse (misma orden): no hay fotocopia, como hoy', async () => {
    prismaMock.digitalReceipt.findFirst.mockResolvedValue({
      dataSnapshot: { ticketTotals: congelado, payment: { amount: 49.5, tipAmount: 0 }, order: { id: 'o1', items: delPanel } },
    })
    const detalle: any = await getTransactionDetail('v1', 'pay_1')
    expect(detalle.lineasDelTicket).toBeUndefined()
    expect(detalle.cortesiaDelTicket).toBe(20)
  })

  it('un recibo que no se puede copiar sin inventar (cargo por servicio, renglones que no suman): sin fotocopia, como hoy', async () => {
    const conCargo = { ...congelado, serviceCharge: 4.95, total: 54.45 }
    prismaMock.digitalReceipt.findFirst.mockResolvedValue({
      dataSnapshot: { ticketTotals: conCargo, payment: { amount: 54.45, tipAmount: 0 }, order: { id: 'o1', items: delPanel } },
    })
    movido()
    expect(((await getTransactionDetail('v1', 'pay_1')) as any).lineasDelTicket).toBeUndefined()
    // Renglones que no suman el subtotal del recibo ($55 contra $75).
    prismaMock.digitalReceipt.findFirst.mockResolvedValue({
      dataSnapshot: {
        ticketTotals: congelado,
        payment: { amount: 49.5, tipAmount: 0 },
        order: { id: 'o1', items: delPanel.slice(0, 1).concat(delPanel.slice(2)) },
      },
    })
    movido()
    expect(((await getTransactionDetail('v1', 'pay_1')) as any).lineasDelTicket).toBeUndefined()
  })

  it('la copia D1 del propio cobro manda sobre la fotocopia', async () => {
    const d1 = {
      lineas: [{ nombre: 'Pago de Coca', cantidad: 1, unitarioCents: 4950, totalCents: 4950 }],
      subtotalCents: 4950,
      descuentoCents: 0,
    }
    prismaMock.digitalReceipt.findFirst.mockResolvedValue({
      dataSnapshot: { ticketTotals: congelado, payment: { amount: 49.5, tipAmount: 0 }, order: { id: 'o1', items: delPanel } },
    })
    prismaMock.payment.findFirst.mockResolvedValue({
      ...cobro,
      processorData: { lineasDelTicket: d1 },
      orderId: 'o2',
      order: { ...cobro.order, items: [coca, cafe] },
    })
    expect(((await getTransactionDetail('v1', 'pay_1')) as any).lineasDelTicket).toEqual(d1)
  })
})
