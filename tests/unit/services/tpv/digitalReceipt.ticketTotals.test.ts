/**
 * IVA por producto, plan 7 (D3; r1 #4, r2 R2-10): el recibo digital de la TPV congela, al crearse, los totales que muestra el
 * comprobante de ESE cobro, armados con el MISMO cobro y la MISMA orden que el resto del snapshot.
 */
import prisma from '@/utils/prismaClient'
import { generateDigitalReceipt } from '@/services/tpv/digitalReceipt.tpv.service'

const prismaMock = prisma as any

const centavos = (n: number) => Math.round(n * 100)

const cobro = (overrides: { amount?: number; tipAmount?: number; order?: Record<string, unknown> } = {}) => ({
  id: 'pay_1',
  orderId: 'o1',
  amount: overrides.amount ?? 115,
  tipAmount: overrides.tipAmount ?? 10,
  type: 'REGULAR',
  method: 'CASH',
  status: 'COMPLETED',
  splitType: 'FULLPAYMENT',
  createdAt: new Date('2026-10-05T18:00:00.000Z'),
  venue: { id: 'v1', name: 'La Ribera', currency: 'MXN' },
  order: {
    id: 'o1',
    orderNumber: 'A-7',
    type: 'DINE_IN',
    source: 'AVOQADO_ANDROID',
    subtotal: 100,
    discountAmount: 0,
    serviceChargeAmount: 15,
    taxAmount: 0,
    contratoDePrecio: 'IVA_INCLUIDO',
    status: 'COMPLETED',
    tipAmount: 10,
    total: 125,
    table: null,
    items: [],
    ...overrides.order,
  },
  processedBy: null,
})

const snapshotCreado = () => prismaMock.digitalReceipt.create.mock.calls[0][0].data.dataSnapshot

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.$queryRaw.mockResolvedValue([])
  prismaMock.digitalReceipt.findFirst.mockResolvedValue(null)
  prismaMock.digitalReceipt.create.mockImplementation(async ({ data }: any) => ({ id: 'r1', accessKey: 'k1', ...data }))
  prismaMock.payment.count.mockResolvedValue(1)
  prismaMock.payment.findUnique.mockResolvedValue(cobro())
})

describe('generateDigitalReceipt · ticketTotals', () => {
  it('el snapshot nuevo lleva los totales del cobro: cargo en su renglón y todo cuadra', async () => {
    await generateDigitalReceipt('pay_1')
    expect(snapshotCreado().ticketTotals).toEqual({
      kind: 'COBRO',
      desglosado: true,
      subtotal: 100,
      serviceCharge: 15,
      addedTax: 0,
      tip: 10,
      total: 125,
    })
  })

  it('🔴 r2 R2-10: los totales salen del MISMO cobro que el snapshot (una sola lectura) y son el mismo dinero', async () => {
    await generateDigitalReceipt('pay_1')
    const snapshot = snapshotCreado()
    expect(prismaMock.payment.findUnique).toHaveBeenCalledTimes(1)
    expect(snapshot.payment.amount + snapshot.payment.tipAmount).toBe(snapshot.ticketTotals?.total)
    expect(prismaMock.payment.count.mock.calls[0][0].where).toMatchObject({ orderId: 'o1', status: 'COMPLETED' })
  })

  it('🔴 A7-R6: una venta con descuento congela el subtotal BRUTO y el descuento en pesos (las cifras del papel del cobro)', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(
      cobro({ amount: 90, tipAmount: 0, order: { subtotal: 100, discountAmount: 10, serviceChargeAmount: 0, total: 90 } }),
    )
    await generateDigitalReceipt('pay_1')
    const t = snapshotCreado().ticketTotals
    expect(t).toEqual({ kind: 'COBRO', desglosado: true, subtotal: 100, discount: 10, serviceCharge: 0, addedTax: 0, tip: 0, total: 90 })
    expect(centavos(t.subtotal) - centavos(t.discount) + centavos(t.serviceCharge) + centavos(t.addedTax) + centavos(t.tip)).toBe(
      centavos(t.total),
    )
  })

  it('🔴 una devolución (importe negativo) se congela en magnitudes y como DEVOLUCION, sin IVA ni cargo', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(cobro({ amount: -115, tipAmount: -10 }))
    await generateDigitalReceipt('pay_1')
    expect(snapshotCreado().ticketTotals).toEqual({
      kind: 'DEVOLUCION',
      desglosado: false,
      subtotal: 115,
      serviceCharge: 0,
      addedTax: 0,
      tip: 10,
      total: 125,
    })
  })

  it('control — los campos de siempre del snapshot siguen ahí (contrato aditivo)', async () => {
    await generateDigitalReceipt('pay_1')
    const snapshot = snapshotCreado()
    expect(snapshot.payment).toMatchObject({ id: 'pay_1', amount: 115, tipAmount: 10 })
    expect(snapshot.order).toMatchObject({ subtotal: 100, taxAmount: 0, total: 125 })
    expect(snapshot.receiptInfo.taxRate).toBe(0.16)
  })
})
