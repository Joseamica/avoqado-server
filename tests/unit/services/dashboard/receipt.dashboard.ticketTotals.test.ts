/**
 * IVA por producto, plan 7 (D3; r1 #4): el recibo del dashboard congela `ticketTotals` y el correo lo usa. Un recibo viejo
 * (sin totales congelados) de un cobro PARCIAL ya no manda el total de toda la orden.
 */
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import emailService from '@/services/email.service'
import { generateAndStoreReceipt, sendReceiptByEmail } from '@/services/dashboard/receipt.dashboard.service'

const prismaMock = prisma as any
const envio = () => (emailService.sendReceiptEmail as jest.Mock).mock.calls[0][1]

beforeEach(() => {
  jest.clearAllMocks()
  jest.spyOn(emailService, 'sendReceiptEmail').mockResolvedValue(true)
  prismaMock.digitalReceipt.update.mockResolvedValue({ id: 'r1' })
})

describe('generateAndStoreReceipt · ticketTotals', () => {
  const preparar = (pago: { amount: number; tipAmount: number }, orden: Record<string, unknown>) => {
    prismaMock.payment.count.mockResolvedValue(1)
    prismaMock.payment.findUnique.mockResolvedValue({
      id: 'pay_1',
      venueId: 'v1',
      orderId: 'o1',
      ...pago,
      type: 'REGULAR',
      method: 'CASH',
      status: 'COMPLETED',
      createdAt: new Date('2026-10-05T18:00:00.000Z'),
      processedById: null,
    })
    prismaMock.digitalReceipt.findFirst.mockResolvedValue(null)
    prismaMock.venue.findUnique.mockResolvedValue({ id: 'v1', name: 'Testarudo', currency: 'MXN' })
    prismaMock.order.findUnique.mockResolvedValue({
      id: 'o1',
      orderNumber: 42,
      discountAmount: 0,
      serviceChargeAmount: 0,
      contratoDePrecio: 'DESCONOCIDO',
      status: 'COMPLETED',
      createdAt: new Date('2026-10-05T18:00:00.000Z'),
      ...orden,
    })
    prismaMock.orderItem.findMany.mockResolvedValue([])
    prismaMock.orderItemModifier.findMany.mockResolvedValue([])
    prismaMock.digitalReceipt.create.mockImplementation(async ({ data }: any) => ({ id: 'r1', ...data }))
  }

  it('el snapshot nuevo lleva los totales del cobro, del MISMO cobro y la MISMA orden que el resto (r2 R2-10)', async () => {
    preparar({ amount: 116, tipAmount: 10 }, { subtotal: 100, taxAmount: 16, total: 116 })
    await generateAndStoreReceipt('pay_1')
    const snapshot = prismaMock.digitalReceipt.create.mock.calls[0][0].data.dataSnapshot
    expect(snapshot.ticketTotals).toEqual({
      kind: 'COBRO',
      desglosado: true,
      subtotal: 100,
      serviceCharge: 0,
      addedTax: 16,
      tip: 10,
      total: 126,
    })
    expect(prismaMock.payment.findUnique).toHaveBeenCalledTimes(1)
    expect(snapshot.payment.totalAmount).toBe(snapshot.ticketTotals?.total)
  })

  it('🔴 A7-R6: descuento, cargo e IVA aparte: subtotal BRUTO y descuento en pesos, y la suma da lo cobrado', async () => {
    preparar({ amount: 121, tipAmount: 0 }, { subtotal: 100, discountAmount: 10, serviceChargeAmount: 15, taxAmount: 16, total: 121 })
    await generateAndStoreReceipt('pay_1')
    const snapshot = prismaMock.digitalReceipt.create.mock.calls[0][0].data.dataSnapshot
    expect(snapshot.ticketTotals).toEqual({
      kind: 'COBRO',
      desglosado: true,
      subtotal: 100,
      discount: 10,
      serviceCharge: 15,
      addedTax: 16,
      tip: 0,
      total: 121,
    })
    expect(snapshot.payment.totalAmount).toBe(snapshot.ticketTotals?.total)
  })
})

describe('sendReceiptByEmail · totales del correo', () => {
  // `payment` es el cobro VIVO que trae el `include` de hoy: corregido después de emitir el recibo. Nunca se usa para los totales.
  const recibo = (dataSnapshot: Record<string, unknown>) =>
    prismaMock.digitalReceipt.findUnique.mockResolvedValue({
      id: 'r1',
      accessKey: 'abcd1234',
      recipientEmail: 'cliente@x.mx',
      dataSnapshot,
      payment: { id: 'pay_1', amount: 999, tipAmount: 77 },
    })

  it('🔴 recibo viejo de un cobro PARCIAL de $50 sobre una orden de $116: el correo dice $50, sin IVA inventado', async () => {
    recibo({
      payment: { amount: 50, tipAmount: 0, method: 'CASH' },
      order: { subtotal: 100, taxAmount: 16, total: 116 },
      venue: { name: 'Testarudo' },
    })
    await sendReceiptByEmail('r1')
    expect(envio()).toMatchObject({ subtotal: 50, taxAmount: 0, tipAmount: 0, totalAmount: 50, leyendaIva: true, esDevolucion: false })
    expect(envio().discountAmount).toBeUndefined()
  })

  it('🔴 un recibo viejo NO se recalcula con datos de hoy: no consulta el cobro ni la orden, usa lo que el recibo guardó', async () => {
    recibo({
      payment: { amount: 50, tipAmount: 5, method: 'CASH' },
      order: { subtotal: 100, taxAmount: 16, total: 116 },
      venue: { name: 'Testarudo' },
    })
    await sendReceiptByEmail('r1')
    expect(envio()).toMatchObject({ subtotal: 50, tipAmount: 5, totalAmount: 55 })
    expect(prismaMock.payment.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.payment.count).not.toHaveBeenCalled()
    expect(prismaMock.order.findUnique).not.toHaveBeenCalled()
  })

  it('recibo nuevo de una venta con IVA aparte y cargo: los renglones congelados', async () => {
    recibo({
      payment: { amount: 141, tipAmount: 10, method: 'CASH' },
      order: { subtotal: 100, taxAmount: 16, total: 141 },
      venue: { name: 'Testarudo' },
      ticketTotals: { kind: 'COBRO', desglosado: true, subtotal: 100, serviceCharge: 25, addedTax: 16, tip: 10, total: 151 },
    })
    await sendReceiptByEmail('r1')
    expect(envio()).toMatchObject({
      subtotal: 100,
      serviceChargeAmount: 25,
      taxAmount: 16,
      tipAmount: 10,
      totalAmount: 151,
      leyendaIva: false,
    })
    expect(envio().discountAmount).toBeUndefined()
  })

  it('🔴 A7-R6: recibo nuevo con descuento: el correo manda el subtotal BRUTO y el descuento congelados', async () => {
    recibo({
      payment: { amount: 121, tipAmount: 5, method: 'CASH' },
      order: { subtotal: 100, taxAmount: 16, total: 121 },
      venue: { name: 'Testarudo' },
      ticketTotals: { kind: 'COBRO', desglosado: true, subtotal: 100, discount: 10, serviceCharge: 15, addedTax: 16, tip: 5, total: 126 },
    })
    await sendReceiptByEmail('r1')
    expect(envio()).toMatchObject({
      subtotal: 100,
      discountAmount: 10,
      serviceChargeAmount: 15,
      taxAmount: 16,
      tipAmount: 5,
      totalAmount: 126,
      leyendaIva: false,
      esDevolucion: false,
    })
  })

  it('🔴 una devolución: importes en positivo y marcada como devolución', async () => {
    recibo({
      payment: { amount: -116, tipAmount: -10, method: 'CARD' },
      order: { subtotal: 100, taxAmount: 16, total: 116 },
      venue: { name: 'Testarudo' },
    })
    await sendReceiptByEmail('r1')
    expect(envio()).toMatchObject({ subtotal: 116, taxAmount: 0, tipAmount: 10, totalAmount: 126, esDevolucion: true })
  })

  it('🔴 r2 R2-6: una devolución de SÓLO propina ($0 + −$10) sale como devolución de $10, no como cobro', async () => {
    recibo({
      payment: { amount: 0, tipAmount: -10, method: 'CARD' },
      order: { subtotal: 100, taxAmount: 0, total: 110 },
      venue: { name: 'Testarudo' },
    })
    await sendReceiptByEmail('r1')
    expect(envio()).toMatchObject({ subtotal: 0, tipAmount: 10, totalAmount: 10, esDevolucion: true })
  })

  it('🔴 un recibo cuyo snapshot no trae el cobro: el correo sale en $0 y deja un aviso en el log (revisión T3 m2)', async () => {
    recibo({ order: { subtotal: 100, taxAmount: 0, total: 100 }, venue: { name: 'Testarudo' } })
    await sendReceiptByEmail('r1')
    expect(envio()).toMatchObject({ subtotal: 0, totalAmount: 0 })
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('$0'), expect.objectContaining({ receiptId: 'r1' }))
  })
})
