import { prismaMock } from '../../../__helpers__/setup'
import { getOrder, listOrders } from '@/services/mobile/order.mobile.service'

const pago = (amount: number, tipAmount = 0, type = 'REGULAR', thirdPartyCashAmount: number | null = null) => ({
  id: `p-${amount}-${type}`, amount, tipAmount, type, status: 'COMPLETED', method: 'CASH',
  tenderType: null, thirdPartyCashAmount, createdAt: new Date('2026-11-10T18:00:00Z'), processedBy: null,
})
const orden = (o: Record<string, unknown> = {}) => ({
  id: 'o1', orderNumber: '7', status: 'PENDING', paymentStatus: 'PENDING', type: 'TAKEOUT', source: 'AVOQADO_ANDROID',
  subtotal: 100, discountAmount: 0, taxAmount: 0, serviceChargeAmount: 0, tipAmount: 0, total: 100,
  contratoDePrecio: 'IVA_INCLUIDO', thirdPartyCashDue: null, cashTipDue: null, areaDeliveryCode: null, areaTicketCode: null,
  tableId: null, servedBy: null, servedById: null, customerName: null, createdAt: new Date('2026-11-10T17:00:00Z'),
  _count: { items: 1 }, items: [], payments: [], serviceCharges: [], orderDiscounts: [], promotions: [], ...o,
})

beforeEach(() => {
  jest.clearAllMocks()
  ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (ops: any) => (Array.isArray(ops) ? Promise.all(ops) : ops(prismaMock)))
  prismaMock.order.count.mockResolvedValue(1)
})

const casos = [
  ['sin abonos', orden(), 10000],
  ['abono de $40', orden({ payments: [pago(40)], paymentStatus: 'PARTIAL' }), 6000],
  ['abono de $40 + propina $10', orden({ payments: [pago(40, 10)], tipAmount: 10, total: 110, paymentStatus: 'PARTIAL' }), 6000],
  // cambia cuando se arregle D19 (hz:433063d4:D19)
  ['D19 heredado: abono de $40 devuelto', orden({ payments: [pago(40), pago(-40, 0, 'REFUND')], paymentStatus: 'PARTIAL' }), 6000],
  ['Rappi 2b: debe venta + propina + terceros', orden({ source: 'RAPPI', thirdPartyCashDue: 30, cashTipDue: 5 }), 13500],
  ['pagada de más: nunca negativo', orden({ payments: [pago(150)], paymentStatus: 'PARTIAL' }), 0],
] as const

describe('D12 · saldo por cobrar en la lista', () => {
  it.each(casos)('%s: la lista dice el MISMO saldo que el detalle', async (_c, o, centavos) => {
    prismaMock.order.findMany.mockResolvedValue([o])
    prismaMock.order.findUnique.mockResolvedValue(o)
    const fila = (await listOrders('v1', { page: 1, pageSize: 20 })).data[0]
    const detalle = await getOrder('v1', 'o1')
    expect(fila.saldoPendienteCents).toBe(centavos)
    expect(fila.saldoPendienteCents).toBe(detalle.preBillBalance!.remainingBalanceCents)
  })

  it('la lista pide el dinero de terceros de cada pago (Rappi 2b) sin otra consulta', async () => {
    prismaMock.order.findMany.mockResolvedValue([])
    await listOrders('v1', { page: 1, pageSize: 20 })
    const args = (prismaMock.order.findMany as jest.Mock).mock.calls[0][0]
    expect(args.include.payments.select.thirdPartyCashAmount).toBe(true)
    expect(prismaMock.order.findMany).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['sin abonos', orden(), 0],
    ['abono de $40', orden({ payments: [pago(40)], paymentStatus: 'PARTIAL' }), 1],
    ['abono de $40 devuelto (cuenta las dos filas, como la compuerta de ANDROID)', orden({ payments: [pago(40), pago(-40, 0, 'REFUND')] }), 2],
  ])('pagosCompletados: %s', async (_c, o, n) => {
    prismaMock.order.findMany.mockResolvedValue([o])
    expect((await listOrders('v1', { page: 1, pageSize: 20 })).data[0].pagosCompletados).toBe(n)
  })

  it.each([
    ['venta de vales v7', { areaDeliveryCode: 'X1' }, true],
    ['vale legado v3', { areaTicketCode: '9010000017' }, true],
    ['venta normal', {}, false],
  ])('esDeVales: %s', async (_c, extra, esperado) => {
    prismaMock.order.findMany.mockResolvedValue([orden(extra)])
    expect((await listOrders('v1', { page: 1, pageSize: 20 })).data[0].esDeVales).toBe(esperado)
  })

  it('no quita ni renombra ningún campo de la fila (apps viejas)', async () => {
    prismaMock.order.findMany.mockResolvedValue([orden()])
    const fila = (await listOrders('v1', { page: 1, pageSize: 20 })).data[0]
    for (const k of ['id', 'orderNumber', 'status', 'paymentStatus', 'total', 'refundState', 'refundedAmount', 'esCuentaDeTarjetas', 'cobrosConSaldo', 'esDeMesa'])
      expect(fila).toHaveProperty(k)
  })
})
