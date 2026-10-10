/**
 * IVA por producto, plan 7a (D3; r1 #1, #2, #9; r2 R2-6, R2-9; r3 R3-11): la reimpresión sale del MISMO comprobante que vio el
 * cliente (`totalesDelComprobante`), COMPLETO: del recibo digital si ya existe —con su importe y su propina—; si no, de la orden.
 */
import { Prisma } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import prisma from '@/utils/prismaClient'
import * as refundService from '@/services/dashboard/refund.dashboard.service'
import { getTransactionDetail } from '@/services/mobile/transaction.mobile.service'

jest.mock('@/services/dashboard/refund.dashboard.service', () => ({ listRefundsForPayment: jest.fn() }))

const prismaMock = prisma as any
const detalle = (amount: number, tipAmount: number) => ({
  id: 'pay_1',
  amount,
  tipAmount,
  method: 'CASH',
  status: 'COMPLETED',
  cardBrand: null,
  maskedPan: null,
  referenceNumber: null,
  authorizationNumber: null,
  createdAt: new Date('2026-10-05T18:00:00.000Z'),
  processedBy: null,
  order: { orderNumber: '42', items: [] },
})
/** Lo que lee `cargarTotalesDelTicket` cuando el cobro NO tiene recibo (una consulta aparte, por id). */
const paraElTicket = (amount: number, tipAmount: number, order: Record<string, unknown>, cobrosDeVenta = 1, type = 'REGULAR') => ({
  amount: new Prisma.Decimal(amount),
  tipAmount: new Prisma.Decimal(tipAmount),
  type,
  status: 'COMPLETED',
  order: {
    subtotal: 100,
    discountAmount: 0,
    serviceChargeAmount: 0,
    taxAmount: 0,
    contratoDePrecio: 'IVA_INCLUIDO',
    status: 'COMPLETED',
    _count: { payments: cobrosDeVenta },
    ...order,
  },
})

beforeEach(() => {
  jest.clearAllMocks()
  ;(refundService.listRefundsForPayment as jest.Mock).mockResolvedValue([])
  prismaMock.digitalReceipt.findFirst.mockResolvedValue(null) // sin recibo: se calcula con la orden
})

describe('getTransactionDetail · totales del comprobante', () => {
  it('una venta vieja con IVA aparte, cobrada completa en un solo pago y sin recibo: el comprobante desglosa el IVA agregado', async () => {
    prismaMock.payment.findFirst.mockResolvedValue(detalle(116, 10))
    prismaMock.payment.findUnique.mockResolvedValue(paraElTicket(116, 10, { taxAmount: 16, contratoDePrecio: 'DESCONOCIDO' }))
    const d = await getTransactionDetail('venue_1', 'pay_1')
    expect(d.ticketTotals).toEqual({ kind: 'COBRO', desglosado: true, subtotal: 100, serviceCharge: 0, addedTax: 16, tip: 10, total: 126 })
  })
  it('🔴 r2 R2-9: con recibo emitido manda el recibo aunque la orden se haya movido después', async () => {
    prismaMock.payment.findFirst.mockResolvedValue(detalle(116, 0))
    prismaMock.digitalReceipt.findFirst.mockResolvedValue({
      dataSnapshot: {
        ticketTotals: { kind: 'COBRO', desglosado: true, subtotal: 100, serviceCharge: 0, addedTax: 16, tip: 0, total: 116 },
      },
    })
    prismaMock.payment.findUnique.mockResolvedValue(paraElTicket(116, 0, { subtotal: 110, taxAmount: 6, contratoDePrecio: 'DESCONOCIDO' }))
    expect((await getTransactionDetail('venue_1', 'pay_1')).ticketTotals?.addedTax).toBe(16)
    // Revisión T4 M1: el recibo se busca por el id del COBRO consultado (no por el venue ni por la orden).
    expect(prismaMock.digitalReceipt.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ paymentId: 'pay_1' }) }),
    )
  })
  it('🔴 r3 R3-11: emitido por $116 + $10 de propina; después se corrigió la propina a $5: el comprobante sigue diciendo $10 y $126', async () => {
    prismaMock.payment.findFirst.mockResolvedValue(detalle(116, 5)) // el pago vivo ya trae la propina corregida
    prismaMock.digitalReceipt.findFirst.mockResolvedValue({
      dataSnapshot: {
        ticketTotals: { kind: 'COBRO', desglosado: true, subtotal: 100, serviceCharge: 0, addedTax: 16, tip: 10, total: 126 },
      },
    })
    const d = await getTransactionDetail('venue_1', 'pay_1')
    expect(d.ticketTotals).toEqual({ kind: 'COBRO', desglosado: true, subtotal: 100, serviceCharge: 0, addedTax: 16, tip: 10, total: 126 })
    expect(d.tipAmount).toBe(5) // los campos de siempre no cambian: siguen siendo el pago vivo
  })
  it('🔴 r3 R3-11: recibo VIEJO sin totales congelados y con el importe corregido después: los importes del recibo, sin desglose', async () => {
    prismaMock.payment.findFirst.mockResolvedValue(detalle(120, 0))
    prismaMock.digitalReceipt.findFirst.mockResolvedValue({ dataSnapshot: { payment: { amount: 116, tipAmount: 10 } } })
    expect((await getTransactionDetail('venue_1', 'pay_1')).ticketTotals).toEqual({
      kind: 'COBRO',
      desglosado: false,
      subtotal: 116,
      serviceCharge: 0,
      addedTax: 0,
      tip: 10,
      total: 126,
    })
  })
  it('🔴 Codex r1 #1: $100 + $16 de propina sobre una cuenta de $116 con IVA aparte: sin desglose', async () => {
    prismaMock.payment.findFirst.mockResolvedValue(detalle(100, 16))
    prismaMock.payment.findUnique.mockResolvedValue(paraElTicket(100, 16, { taxAmount: 16, contratoDePrecio: 'DESCONOCIDO' }))
    const t = (await getTransactionDetail('venue_1', 'pay_1')).ticketTotals
    expect([t?.desglosado, t?.addedTax, t?.subtotal, t?.total]).toEqual([false, 0, 100, 116])
  })
  it('cargo por servicio de una venta cobrada completa: en el comprobante', async () => {
    prismaMock.payment.findFirst.mockResolvedValue(detalle(115, 0))
    prismaMock.payment.findUnique.mockResolvedValue(paraElTicket(115, 0, { serviceChargeAmount: 15 }))
    const t = (await getTransactionDetail('venue_1', 'pay_1')).ticketTotals
    expect([t?.subtotal, t?.serviceCharge, t?.addedTax, t?.total]).toEqual([100, 15, 0, 115])
  })
  it('🔴 una devolución: magnitudes, kind DEVOLUCION, sin IVA agregado ni cargo', async () => {
    prismaMock.payment.findFirst.mockResolvedValue(detalle(-116, -10))
    prismaMock.payment.findUnique.mockResolvedValue(
      paraElTicket(-116, -10, { taxAmount: 16, contratoDePrecio: 'DESCONOCIDO' }, 1, 'REFUND'),
    )
    expect((await getTransactionDetail('venue_1', 'pay_1')).ticketTotals).toEqual({
      kind: 'DEVOLUCION',
      desglosado: false,
      subtotal: 116,
      serviceCharge: 0,
      addedTax: 0,
      tip: 10,
      total: 126,
    })
  })
  it('🔴 r2 R2-6: una devolución de SÓLO propina ($0, −$10) es devolución', async () => {
    prismaMock.payment.findFirst.mockResolvedValue(detalle(0, -10))
    prismaMock.payment.findUnique.mockResolvedValue(paraElTicket(0, -10, {}, 1, 'REFUND'))
    const t = (await getTransactionDetail('venue_1', 'pay_1')).ticketTotals
    expect([t?.kind, t?.subtotal, t?.tip, t?.total]).toEqual(['DEVOLUCION', 0, 10, 10])
  })
  it('control — un cobro que no es del negocio sigue siendo 404 y no consulta los totales', async () => {
    prismaMock.payment.findFirst.mockResolvedValue(null)
    await expect(getTransactionDetail('venue_1', 'pay_x')).rejects.toThrow('no encontrado')
    expect(prismaMock.digitalReceipt.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.payment.findUnique).not.toHaveBeenCalled()
  })

  // Ruling A7-R6 (brief T4, ajuste 1): el descuento viaja en `discount` (sólo desglosado y > 0) y `subtotal` es el BRUTO.
  it('🔴 A7-R6: venta sin recibo de $100 con $10 de descuento cobrada en un pago de $90: subtotal bruto y el descuento en su campo', async () => {
    prismaMock.payment.findFirst.mockResolvedValue(detalle(90, 0))
    prismaMock.payment.findUnique.mockResolvedValue(paraElTicket(90, 0, { discountAmount: 10 }))
    expect((await getTransactionDetail('venue_1', 'pay_1')).ticketTotals).toEqual({
      kind: 'COBRO',
      desglosado: true,
      subtotal: 100,
      discount: 10,
      serviceCharge: 0,
      addedTax: 0,
      tip: 0,
      total: 90,
    })
  })
  it('🔴 A7-R6 + r2 R2-9: el recibo congeló `discount: 10`; la orden perdió el descuento después: el detalle dice lo del recibo', async () => {
    const congelado = { kind: 'COBRO', desglosado: true, subtotal: 100, discount: 10, serviceCharge: 0, addedTax: 0, tip: 0, total: 90 }
    prismaMock.payment.findFirst.mockResolvedValue(detalle(90, 0))
    prismaMock.digitalReceipt.findFirst.mockResolvedValue({ dataSnapshot: { ticketTotals: congelado } })
    // Lo que diría la orden HOY (sin descuento, subtotal 90): no se consulta, manda el recibo.
    prismaMock.payment.findUnique.mockResolvedValue(paraElTicket(90, 0, { subtotal: 90, discountAmount: 0 }))
    expect((await getTransactionDetail('venue_1', 'pay_1')).ticketTotals).toEqual(congelado)
  })
})

describe('getTransactionDetail · comprobante junto al `chargedTotal` de C2 (cobro con orden)', () => {
  afterEach(() => {
    prismaMock.$queryRaw.mockReset()
    prismaMock.orderItem.findMany.mockReset()
    prismaMock.orderItem.findMany.mockResolvedValue([])
  })

  it('🔴 un cobro con `orderId`: cada renglón trae lo que cobró (C2) y el detalle trae el comprobante completo (7a)', async () => {
    /** E2 de la prueba de C2: A $100 −$10 propio (espejado en la cabecera) + B $50; cobrada completa en un pago de $140 + $10 de propina. */
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
    const E2 = [linea('A', { discountAmount: new Decimal(10) }), linea('B', { unitPrice: new Decimal(50), total: new Decimal(50) })]
    prismaMock.payment.findFirst.mockResolvedValue({ ...detalle(140, 10), orderId: 'order-1', order: { orderNumber: '42', items: E2 } })
    // Lo que lee `leerCobradoDeLaOrden` (C2): cabecera, renglones y filas de descuento.
    prismaMock.order.findUnique.mockResolvedValue({ discountAmount: new Decimal(10), contratoDePrecio: null, originSystem: null })
    prismaMock.orderItem.findMany.mockResolvedValue(E2)
    prismaMock.$queryRaw.mockResolvedValue([
      {
        id: 'd0',
        orderId: 'order-1',
        amount: new Decimal(10),
        reparto: { v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: true, renglones: { A: 1000 } },
      },
    ])
    // Lo que lee `cargarTotalesDelTicket` (7a): sin recibo; la venta de $150 − $10 se cobró completa.
    prismaMock.payment.findUnique.mockResolvedValue(paraElTicket(140, 10, { subtotal: 150, discountAmount: 10 }))

    const d = await getTransactionDetail('venue_1', 'pay_1')

    expect(d.items).toEqual([
      expect.objectContaining({ id: 'A', total: 100, chargedTotal: 90 }),
      expect.objectContaining({ id: 'B', total: 50, chargedTotal: 50 }),
    ])
    expect(d.ticketTotals).toEqual({
      kind: 'COBRO',
      desglosado: true,
      subtotal: 150,
      discount: 10,
      serviceCharge: 0,
      addedTax: 0,
      tip: 10,
      total: 150,
    })
    expect(d.amount).toBe(140) // los campos de siempre, intactos
    expect(prismaMock.order.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'order-1' } }))
    expect(prismaMock.payment.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'pay_1' } }))
  })
})
