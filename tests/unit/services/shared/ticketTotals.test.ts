/**
 * IVA por producto, plan 7 (D3 + regla de cuadre, Codex r2 N10 / r3 R3-4; plan 7 r1 #1 y #2): lo que muestra el comprobante
 * de UN cobro fuera del momento de cobrar (recibo digital, HTML legado, correo, reimpresión de las apps). Se desglosa sólo si
 * ese cobro es el ÚNICO cobro de venta y paga EXACTAMENTE lo que la cuenta debe; si no, sólo total y leyenda. Nunca se lee
 * `Order.total` (doble semántica) ni `splitType`. Una devolución sale en magnitudes y nunca con IVA agregado.
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import {
  COBROS_DE_VENTA,
  type EntradaDelTicket,
  cargarTotalesDelTicket,
  contarCobrosDeVenta,
  ticketTotals,
  ticketTotalsDelSnapshot,
  totalesDelComprobante,
} from '@/services/shared/ticketTotals'

type Orden = NonNullable<EntradaDelTicket['order']>
const orden = (o: Partial<Orden> = {}): Orden => ({
  subtotal: 100,
  discountAmount: 0,
  serviceChargeAmount: 0,
  taxAmount: 0,
  contratoDePrecio: 'IVA_INCLUIDO',
  status: 'COMPLETED',
  ...o,
})
const cobro = (
  amount: number | string | null,
  tipAmount: number | null = 0,
  type: string | null = 'REGULAR',
  status: string | null = 'COMPLETED',
) => ({
  amount,
  tipAmount,
  type,
  status,
})
const centavos = (n: number) => Math.round(n * 100)

describe('ticketTotals', () => {
  it('IVA incluido (la norma), cobro único y completo: desglosado, sin IVA agregado', () => {
    expect(ticketTotals({ payment: cobro(290, 10), order: orden({ subtotal: 290 }), cobrosDeVenta: 1 })).toEqual({
      kind: 'COBRO',
      desglosado: true,
      subtotal: 290,
      serviceCharge: 0,
      addedTax: 0,
      tip: 10,
      total: 300,
    })
  })

  it('IVA aparte (SoftRestaurant, contrato DESCONOCIDO), cobro único y completo: IVA agregado = el de la orden', () => {
    const o = orden({ subtotal: 100, taxAmount: 16, contratoDePrecio: 'DESCONOCIDO' })
    expect(ticketTotals({ payment: cobro(116, 10), order: o, cobrosDeVenta: 1 })).toMatchObject({
      desglosado: true,
      subtotal: 100,
      addedTax: 16,
      tip: 10,
      total: 126,
    })
  })

  it('🔴 Codex r1 #1: $100 cobrados + $16 de propina sobre una cuenta de $116 NO es un cobro completo: leyenda', () => {
    const o = orden({ subtotal: 100, taxAmount: 16, contratoDePrecio: 'DESCONOCIDO' })
    expect(ticketTotals({ payment: cobro(100, 16), order: o, cobrosDeVenta: 1 })).toEqual({
      kind: 'COBRO',
      desglosado: false,
      subtotal: 100,
      serviceCharge: 0,
      addedTax: 0,
      tip: 16,
      total: 116,
    })
  })

  it('dos cobros de venta (SoftRestaurant registra cada uno como FULLPAYMENT): ninguno se desglosa', () => {
    const o = orden({ subtotal: 100, taxAmount: 16, contratoDePrecio: 'DESCONOCIDO' })
    expect(ticketTotals({ payment: cobro(116), order: o, cobrosDeVenta: 2 })).toMatchObject({
      desglosado: false,
      subtotal: 116,
      addedTax: 0,
    })
    expect(ticketTotals({ payment: cobro(58), order: o, cobrosDeVenta: 2 })).toMatchObject({ desglosado: false, subtotal: 58, addedTax: 0 })
  })

  it('cobro PARCIAL: no se reparte un IVA que nadie calculó', () => {
    const o = orden({ subtotal: 100, taxAmount: 16, contratoDePrecio: 'IVA_APARTE' })
    expect(ticketTotals({ payment: cobro(50), order: o, cobrosDeVenta: 1 })).toMatchObject({
      desglosado: false,
      subtotal: 50,
      addedTax: 0,
      total: 50,
    })
  })

  it('🔴 ronda 1 (A7-R6): $100 − $10 de descuento = $90, igual que el papel del cobro (subtotal BRUTO y su descuento)', () => {
    const o = orden({ subtotal: 100, discountAmount: 10 })
    expect(ticketTotals({ payment: cobro(90), order: o, cobrosDeVenta: 1 })).toEqual({
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

  it('🔴 ronda 1: cargo por servicio y descuento: subtotal bruto, el descuento y el cargo en su renglón, y todo cuadra', () => {
    const o = orden({ subtotal: 100, discountAmount: 10, serviceChargeAmount: 15 })
    expect(ticketTotals({ payment: cobro(105, 5), order: o, cobrosDeVenta: 1 })).toEqual({
      kind: 'COBRO',
      desglosado: true,
      subtotal: 100,
      discount: 10,
      serviceCharge: 15,
      addedTax: 0,
      tip: 5,
      total: 110,
    })
  })

  it('cargo por servicio con IVA aparte: cada uno en su lugar', () => {
    const o = orden({ subtotal: 100, serviceChargeAmount: 10, taxAmount: 16, contratoDePrecio: 'IVA_APARTE' })
    expect(ticketTotals({ payment: cobro(126), order: o, cobrosDeVenta: 1 })).toMatchObject({
      desglosado: true,
      subtotal: 100,
      serviceCharge: 10,
      addedTax: 16,
    })
  })

  it('🔴 contrato IVA_INCLUIDO con un taxAmount escrito: el precio ya lo traía, no hay IVA agregado (respuesta 1 afinada)', () => {
    const o = orden({ subtotal: 100, taxAmount: 16, contratoDePrecio: 'IVA_INCLUIDO' })
    expect(ticketTotals({ payment: cobro(100), order: o, cobrosDeVenta: 1 })).toMatchObject({
      desglosado: true,
      subtotal: 100,
      addedTax: 0,
    })
  })

  it('un IVA negativo (motor de descuentos viejo, H13) nunca se pinta ni suma', () => {
    const o = orden({ subtotal: 100, discountAmount: 3, taxAmount: -3, contratoDePrecio: 'DESCONOCIDO' })
    expect(ticketTotals({ payment: cobro(97), order: o, cobrosDeVenta: 1 })).toMatchObject({
      desglosado: true,
      subtotal: 100,
      discount: 3,
      addedTax: 0,
    })
  })

  it('🔴 devolución total con propina (importes negativos): magnitudes, DEVOLUCION, sin IVA agregado ni cargo', () => {
    const o = orden({ subtotal: 100, serviceChargeAmount: 0, taxAmount: 16, contratoDePrecio: 'DESCONOCIDO' })
    expect(ticketTotals({ payment: cobro(-116, -10, 'REFUND'), order: o, cobrosDeVenta: 1 })).toEqual({
      kind: 'DEVOLUCION',
      desglosado: false,
      subtotal: 116,
      serviceCharge: 0,
      addedTax: 0,
      tip: 10,
      total: 126,
    })
  })

  it('devolución parcial sin propina, con `type` NULL (filas viejas): se reconoce por el importe negativo', () => {
    expect(ticketTotals({ payment: cobro(-50, 0, null), order: orden(), cobrosDeVenta: 1 })).toMatchObject({
      kind: 'DEVOLUCION',
      subtotal: 50,
      tip: 0,
      total: 50,
    })
  })

  it('cobro sin orden (cobro rápido): sin desglose', () => {
    expect(ticketTotals({ payment: cobro(80, 5), order: null, cobrosDeVenta: 0 })).toMatchObject({
      desglosado: false,
      subtotal: 80,
      tip: 5,
      total: 85,
    })
  })

  it('🔴 r2 R2-8: un intento FALLIDO por el mismo importe que el cobro bueno no se desglosa (no es el cobro contado)', () => {
    const o = orden({ subtotal: 100, taxAmount: 16, contratoDePrecio: 'DESCONOCIDO' })
    expect(ticketTotals({ payment: cobro(116, 0, 'REGULAR', 'FAILED'), order: o, cobrosDeVenta: 1 })).toMatchObject({
      desglosado: false,
      subtotal: 116,
      addedTax: 0,
      total: 116,
    })
    expect(ticketTotals({ payment: cobro(116, 0, 'REGULAR', 'PENDING'), order: o, cobrosDeVenta: 1 })).toMatchObject({
      desglosado: false,
      subtotal: 116,
      addedTax: 0,
    })
  })

  it('🔴 r2 R2-6: una devolución de SÓLO propina (importe 0, propina −10) es devolución, también sin `type`', () => {
    const esperado = { kind: 'DEVOLUCION', desglosado: false, subtotal: 0, serviceCharge: 0, addedTax: 0, tip: 10, total: 10 }
    expect(ticketTotals({ payment: cobro(0, -10, 'REFUND'), order: orden(), cobrosDeVenta: 1 })).toEqual(esperado)
    expect(ticketTotals({ payment: cobro(0, -10, null), order: orden(), cobrosDeVenta: 1 })).toEqual(esperado)
  })

  it('aritmética de Decimal: 0.30 − 0.10 cubre un cobro de 0.20 (con flotantes daría 0.19999999999999998 y no cubriría)', () => {
    const o = orden({ subtotal: '0.30', discountAmount: '0.10' })
    expect(ticketTotals({ payment: cobro('0.20'), order: o, cobrosDeVenta: 1 })).toMatchObject({
      desglosado: true,
      subtotal: 0.3,
      discount: 0.1,
    })
  })

  it('🔴 ronda 1: un descuento MAYOR que el subtotal (cortesía encima de un descuento) descuenta sólo el subtotal, como el papel', () => {
    const o = orden({ subtotal: 100, discountAmount: 120, serviceChargeAmount: 15 })
    expect(ticketTotals({ payment: cobro(15), order: o, cobrosDeVenta: 1 })).toEqual({
      kind: 'COBRO',
      desglosado: true,
      subtotal: 100,
      discount: 100,
      serviceCharge: 15,
      addedTax: 0,
      tip: 0,
      total: 15,
    })
  })

  it('control — ronda 1: sin desglose (cobro parcial de una cuenta con descuento) no hay renglón de descuento', () => {
    const t = ticketTotals({ payment: cobro(45), order: orden({ subtotal: 100, discountAmount: 10 }), cobrosDeVenta: 1 })
    expect(t).toMatchObject({ desglosado: false, subtotal: 45, total: 45 })
    expect(t.discount).toBeUndefined()
  })

  it('control — todo nulo: ceros, nunca NaN', () => {
    expect(ticketTotals({ payment: { amount: null, tipAmount: undefined, status: 'COMPLETED' }, order: null, cobrosDeVenta: 0 })).toEqual({
      kind: 'COBRO',
      desglosado: false,
      subtotal: 0,
      serviceCharge: 0,
      addedTax: 0,
      tip: 0,
      total: 0,
    })
  })

  it('la regla de cuadre se cumple en todos los casos', () => {
    const casos: EntradaDelTicket[] = [
      { payment: cobro(116, 10), order: orden({ subtotal: 100, taxAmount: 16, contratoDePrecio: 'DESCONOCIDO' }), cobrosDeVenta: 1 },
      { payment: cobro(100, 16), order: orden({ subtotal: 100, taxAmount: 16, contratoDePrecio: 'DESCONOCIDO' }), cobrosDeVenta: 1 },
      { payment: cobro(105, 5), order: orden({ subtotal: 100, discountAmount: 10, serviceChargeAmount: 15 }), cobrosDeVenta: 1 },
      { payment: cobro(90), order: orden({ subtotal: 100, discountAmount: 10 }), cobrosDeVenta: 1 },
      {
        payment: cobro(104.4, 3),
        order: orden({ subtotal: 100, discountAmount: 10, taxAmount: 14.4, contratoDePrecio: 'IVA_APARTE' }),
        cobrosDeVenta: 1,
      },
      { payment: cobro(15), order: orden({ subtotal: 100, discountAmount: 120, serviceChargeAmount: 15 }), cobrosDeVenta: 1 },
      { payment: cobro(-116, -10, 'REFUND'), order: orden(), cobrosDeVenta: 1 },
    ]
    for (const e of casos) {
      const t = ticketTotals(e)
      // Ronda 1: subtotal − descuento + cargo + IVA agregado + propina = total (todo en pesos, comparado en centavos).
      expect(centavos(t.subtotal) - centavos(t.discount ?? 0) + centavos(t.serviceCharge) + centavos(t.addedTax) + centavos(t.tip)).toBe(
        centavos(t.total),
      )
      // Y el TOTAL es siempre lo cobrado + la propina, en magnitud: el comprobante nunca inventa ni pierde dinero.
      expect(centavos(t.total)).toBe(centavos(Math.abs(Number(e.payment.amount)) + Math.abs(Number(e.payment.tipAmount))))
    }
  })
})

describe('ticketTotalsDelSnapshot', () => {
  const congelado = { kind: 'COBRO', desglosado: true, subtotal: 100, serviceCharge: 0, addedTax: 16, tip: 10, total: 126 }

  it('un recibo nuevo trae sus totales congelados al cobrar: se usan tal cual', () => {
    expect(ticketTotalsDelSnapshot({ ticketTotals: congelado, payment: { amount: 116, tipAmount: 10 } })).toEqual(congelado)
  })

  it('🔴 un recibo viejo (sin totales congelados) de un cobro parcial: sin desglose, NUNCA lee la orden', () => {
    expect(ticketTotalsDelSnapshot({ payment: { amount: 50, tipAmount: 0 }, order: { subtotal: 100, taxAmount: 16, total: 116 } })).toEqual(
      {
        kind: 'COBRO',
        desglosado: false,
        subtotal: 50,
        serviceCharge: 0,
        addedTax: 0,
        tip: 0,
        total: 50,
      },
    )
  })

  it('un recibo viejo de una devolución: magnitudes y DEVOLUCION', () => {
    expect(ticketTotalsDelSnapshot({ payment: { amount: -116, tipAmount: -10 } })).toMatchObject({
      kind: 'DEVOLUCION',
      subtotal: 116,
      tip: 10,
      total: 126,
    })
  })

  it('🔴 un recibo viejo de una devolución de sólo propina (importe 0, propina −10): DEVOLUCION por $10', () => {
    expect(ticketTotalsDelSnapshot({ payment: { amount: 0, tipAmount: -10 } })).toMatchObject({
      kind: 'DEVOLUCION',
      subtotal: 0,
      tip: 10,
      total: 10,
    })
  })

  it('control — sin cobro no hay totales', () => {
    expect(ticketTotalsDelSnapshot({ order: { taxAmount: 16 } })).toBeNull()
    expect(ticketTotalsDelSnapshot(null)).toBeNull()
  })
})

describe('cargarTotalesDelTicket', () => {
  const prismaMock = prisma as any

  beforeEach(() => jest.clearAllMocks())

  it('lee el cobro, los importes de la orden y CUÁNTOS cobros de venta tiene, en una sola consulta acotada por id', async () => {
    prismaMock.payment.findUnique.mockResolvedValue({
      amount: new Prisma.Decimal('116'),
      tipAmount: new Prisma.Decimal('10'),
      type: 'REGULAR',
      status: 'COMPLETED',
      order: {
        subtotal: new Prisma.Decimal('100'),
        discountAmount: new Prisma.Decimal('0'),
        serviceChargeAmount: new Prisma.Decimal('0'),
        taxAmount: new Prisma.Decimal('16'),
        contratoDePrecio: 'DESCONOCIDO',
        status: 'COMPLETED',
        _count: { payments: 1 },
      },
    })
    expect(await cargarTotalesDelTicket(prismaMock, 'pay_1')).toMatchObject({ desglosado: true, addedTax: 16, total: 126 })
    const args = prismaMock.payment.findUnique.mock.calls[0][0]
    expect(args.where).toEqual({ id: 'pay_1' })
    expect(args.select.order.select._count.select.payments.where).toEqual(COBROS_DE_VENTA)
  })

  it('🔴 el conteo cuenta los cobros con `type` NULL: `{ not: "REFUND" }` solo los excluiría en SQL', () => {
    expect(COBROS_DE_VENTA).toEqual({
      status: 'COMPLETED',
      amount: { gt: 0 },
      OR: [{ type: null }, { type: { not: 'REFUND' } }],
    })
  })

  it('un cobro sin orden: sin desglose; un cobro que no existe: null', async () => {
    prismaMock.payment.findUnique.mockResolvedValueOnce({ amount: 80, tipAmount: 5, type: 'FAST', status: 'COMPLETED', order: null })
    expect(await cargarTotalesDelTicket(prismaMock, 'pay_2')).toMatchObject({ desglosado: false, total: 85 })
    prismaMock.payment.findUnique.mockResolvedValueOnce(null)
    expect(await cargarTotalesDelTicket(prismaMock, 'nope')).toBeNull()
  })
})

describe('totalesDelComprobante (r2 R2-9: un comprobante ya emitido no cambia al reimprimir)', () => {
  const prismaMock = prisma as any
  beforeEach(() => jest.clearAllMocks())

  it('🔴 con recibo emitido manda el recibo, aunque la orden se haya movido después ($100 + $16 congelados; hoy $110 + $6)', async () => {
    const congelado = { kind: 'COBRO', desglosado: true, subtotal: 100, serviceCharge: 0, addedTax: 16, tip: 0, total: 116 }
    prismaMock.digitalReceipt.findFirst.mockResolvedValue({
      dataSnapshot: { ticketTotals: congelado, payment: { amount: 116, tipAmount: 0 } },
    })
    expect(await totalesDelComprobante(prismaMock, 'pay_1')).toEqual(congelado)
    expect(prismaMock.payment.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.digitalReceipt.findFirst.mock.calls[0][0]).toMatchObject({
      where: { paymentId: 'pay_1' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
  })

  it('con un recibo de antes del plan (sin totales congelados): sin desglose, igual que el visor', async () => {
    prismaMock.digitalReceipt.findFirst.mockResolvedValue({
      dataSnapshot: { payment: { amount: 116, tipAmount: 0 }, order: { taxAmount: 16 } },
    })
    expect(await totalesDelComprobante(prismaMock, 'pay_1')).toMatchObject({ desglosado: false, addedTax: 0, total: 116 })
  })

  it('sin recibo emitido: se calcula con la orden', async () => {
    prismaMock.digitalReceipt.findFirst.mockResolvedValue(null)
    prismaMock.payment.findUnique.mockResolvedValue({
      amount: 116,
      tipAmount: 0,
      type: 'REGULAR',
      status: 'COMPLETED',
      order: {
        subtotal: 100,
        discountAmount: 0,
        serviceChargeAmount: 0,
        taxAmount: 16,
        contratoDePrecio: 'DESCONOCIDO',
        status: 'COMPLETED',
        _count: { payments: 1 },
      },
    })
    expect(await totalesDelComprobante(prismaMock, 'pay_1')).toMatchObject({ desglosado: true, addedTax: 16 })
  })

  it('contarCobrosDeVenta cuenta con el mismo predicado; sin orden, 0', async () => {
    prismaMock.payment.count.mockResolvedValue(2)
    expect(await contarCobrosDeVenta(prismaMock, 'o1')).toBe(2)
    expect(prismaMock.payment.count.mock.calls[0][0]).toEqual({ where: { orderId: 'o1', ...COBROS_DE_VENTA } })
    expect(await contarCobrosDeVenta(prismaMock, null)).toBe(0)
  })
})
