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
  cortesiaEnCeroDe,
  totalDelRenglonEnElTicket,
  ticketTotals,
  ticketTotalsDelSnapshot,
  totalesDelComprobante,
  totalesSinLaCortesia,
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
    // D15: además es una PARTE: la venta debía $116 sin propina y este cobro pagó $100.
    expect(ticketTotals({ payment: cobro(100, 16), order: o, cobrosDeVenta: 1 })).toEqual({
      kind: 'COBRO',
      desglosado: false,
      subtotal: 100,
      serviceCharge: 0,
      addedTax: 0,
      tip: 16,
      total: 116,
      parcial: true,
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
      // D41 «C»: Mesas con cortesía en $0, con cargo y con una cortesía mayor que lo cobrado.
      { payment: cobro(49.5, 5), order: orden({ subtotal: 55, discountAmount: 5.5, cortesiaEnCero: 20 }), cobrosDeVenta: 1 },
      { payment: cobro(25, 0), order: orden({ subtotal: 20, serviceChargeAmount: 5, cortesiaEnCero: 80 }), cobrosDeVenta: 1 },
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

// D15 (28-oct): el comprobante de UNA parte de una venta dividida lleva `parcial: true`, para que la reimpresión, el recibo digital y el
// correo pinten «Pago parcial» en vez de toda la venta. Sólo para un cobro de venta real (COMPLETED, > 0) y nunca por un centavo de
// tolerancia (Codex plan r1 #1 y #2).
describe('ticketTotals · parcial (D15)', () => {
  const o30 = orden({ subtotal: 30 })

  it('parte 1 de 2: un solo cobro que paga menos de lo que la orden debe', () => {
    expect(ticketTotals({ payment: cobro(15), order: o30, cobrosDeVenta: 1 })).toMatchObject({
      kind: 'COBRO',
      desglosado: false,
      parcial: true,
      total: 15,
    })
  })

  it('parte 2 de 2: la orden ya tiene dos cobros de venta', () => {
    expect(ticketTotals({ payment: cobro(15, 2), order: o30, cobrosDeVenta: 2 })).toMatchObject({
      desglosado: false,
      parcial: true,
      total: 17,
    })
  })

  it('venta pagada completa en un solo cobro: sin la llave', () => {
    expect(ticketTotals({ payment: cobro(30, 3), order: o30, cobrosDeVenta: 1 })).not.toHaveProperty('parcial')
  })

  it('cuenta de $2.01 saldada con $2.00 (tolerancia de un centavo): venta completa, sin la llave', () => {
    expect(ticketTotals({ payment: cobro(2), order: orden({ subtotal: 2.01 }), cobrosDeVenta: 1 })).not.toHaveProperty('parcial')
  })

  it('intento fallido de $15 sobre $30: no es una parte cobrada', () => {
    expect(ticketTotals({ payment: cobro(15, 0, 'REGULAR', 'FAILED'), order: o30, cobrosDeVenta: 1 })).not.toHaveProperty('parcial')
    expect(ticketTotals({ payment: cobro(15, 0, 'REGULAR', 'FAILED'), order: o30, cobrosDeVenta: 2 })).not.toHaveProperty('parcial')
  })

  it('registro de sólo propina ($0 + propina): no es una parte', () => {
    expect(ticketTotals({ payment: cobro(0, 5), order: o30, cobrosDeVenta: 1 })).not.toHaveProperty('parcial')
  })

  it('cobro rápido sin orden, devolución y cortesía de $0: sin la llave', () => {
    expect(ticketTotals({ payment: cobro(15), order: null, cobrosDeVenta: 0 })).not.toHaveProperty('parcial')
    expect(ticketTotals({ payment: cobro(-15, 0, 'REFUND'), order: o30, cobrosDeVenta: 2 })).not.toHaveProperty('parcial')
    expect(ticketTotals({ payment: cobro(0), order: orden({ subtotal: 0 }), cobrosDeVenta: 0 })).not.toHaveProperty('parcial')
  })
})

// D41 «C» (founder, 16-nov; tarjeta `hz:nube0000:naec8c3f`): la MISMA venta con cortesía dice lo mismo en Mostrador y en Mesas, como
// Square («Discounts & Comps» restan del bruto). Coca $25 + Agua $20 de cortesía + Café $30, 10 % de cuenta, cobrado $49.50.
// Mostrador guarda la Agua a precio lleno + su descuento (subtotal $75, descuento $25.50); Mesas la guarda en $0 con su regalo en el
// `discountAmount` del renglón (subtotal $55, descuento $5.50). El regalo en $0 vuelve al bruto y al descuento: el total no cambia.
describe('ticketTotals · la cortesía en $0 de Mesas (D41 «C»)', () => {
  const mostrador = orden({ subtotal: 75, discountAmount: 25.5 })
  const mesas = orden({ subtotal: 55, discountAmount: 5.5, cortesiaEnCero: 20 })

  it('Mesas da el MISMO ticket que Mostrador: $75 · −$25.50 · $49.50', () => {
    const esperado = { kind: 'COBRO', desglosado: true, subtotal: 75, discount: 25.5, serviceCharge: 0, addedTax: 0, tip: 5, total: 54.5 }
    expect(ticketTotals({ payment: cobro(49.5, 5), order: mostrador, cobrosDeVenta: 1 })).toEqual(esperado)
    // Mesas además dice cuánto de su desglose es cortesía en $0: así sus renglones se pintan a su bruto y cuadran con el subtotal.
    expect(ticketTotals({ payment: cobro(49.5, 5), order: mesas, cobrosDeVenta: 1 })).toEqual({ ...esperado, cortesia: 20 })
  })

  it('sólo cortesía, sin descuento de cuenta: el regalo es el descuento', () => {
    expect(ticketTotals({ payment: cobro(55), order: orden({ subtotal: 55, cortesiaEnCero: 20 }), cobrosDeVenta: 1 })).toEqual({
      kind: 'COBRO',
      desglosado: true,
      subtotal: 75,
      discount: 20,
      cortesia: 20,
      serviceCharge: 0,
      addedTax: 0,
      tip: 0,
      total: 55,
    })
  })

  it('con cargo por servicio y con IVA aparte: el regalo sólo mueve bruto y descuento', () => {
    expect(
      ticketTotals({
        payment: cobro(54.45),
        order: orden({ subtotal: 55, discountAmount: 5.5, serviceChargeAmount: 4.95, cortesiaEnCero: 20 }),
        cobrosDeVenta: 1,
      }),
    ).toMatchObject({ desglosado: true, subtotal: 75, discount: 25.5, serviceCharge: 4.95, total: 54.45 })
    const aparte = orden({ subtotal: 55, discountAmount: 5.5, taxAmount: 7.92, contratoDePrecio: 'IVA_APARTE', cortesiaEnCero: 20 })
    expect(ticketTotals({ payment: cobro(57.42), order: aparte, cobrosDeVenta: 1 })).toMatchObject({
      desglosado: true,
      subtotal: 75,
      discount: 25.5,
      addedTax: 7.92,
      total: 57.42,
    })
  })

  it('cuenta toda de cortesía cerrada con un solo cobro de $0: Mesas y Mostrador dicen $20 − $20 = $0 (encargo 27fd34, Codex r6 #3)', () => {
    const enMesas = ticketTotals({ payment: cobro(0), order: orden({ subtotal: 0, cortesiaEnCero: 20 }), cobrosDeVenta: 0 })
    const enMostrador = ticketTotals({ payment: cobro(0), order: orden({ subtotal: 20, discountAmount: 20 }), cobrosDeVenta: 0 })
    expect(enMesas).toEqual({
      kind: 'COBRO',
      desglosado: true,
      subtotal: 20,
      discount: 20,
      cortesia: 20,
      serviceCharge: 0,
      addedTax: 0,
      tip: 0,
      total: 0,
    })
    expect(enMostrador).toEqual({
      kind: 'COBRO',
      desglosado: true,
      subtotal: 20,
      discount: 20,
      serviceCharge: 0,
      addedTax: 0,
      tip: 0,
      total: 0,
    })
  })

  it('cuenta en $0 cuyo desglose no cabe en el papel de ANDROID (carrito gratis de $25 millones): sin desglose, como antes (Codex r2 #6)', () => {
    expect(
      ticketTotals({ payment: cobro(0), order: orden({ subtotal: 25_000_000, discountAmount: 25_000_000 }), cobrosDeVenta: 0 }),
    ).toMatchObject({ desglosado: false, subtotal: 0, total: 0 })
  })

  it('cobro de $0 que NO cierra la cuenta: sin desglose, como hoy', () => {
    // La cuenta todavía debe $20 (un «cobro» de $0 no la paga), o ya tiene otro cobro de venta (un registro de sólo propina).
    expect(ticketTotals({ payment: cobro(0), order: orden({ subtotal: 20 }), cobrosDeVenta: 0 })).toMatchObject({
      desglosado: false,
      total: 0,
    })
    expect(ticketTotals({ payment: cobro(0, 5), order: orden({ subtotal: 30 }), cobrosDeVenta: 1 })).toMatchObject({
      desglosado: false,
      total: 5,
    })
    // Codex r1 #1 (encargo 27fd34): la mesa se cerró en $0 y después llega de la cola un registro de $0 con $15 de propina: es sólo
    // propina, no vuelve a pintar la Agua ni su descuento.
    expect(ticketTotals({ payment: cobro(0, 15), order: orden({ subtotal: 0, cortesiaEnCero: 20 }), cobrosDeVenta: 0 })).toEqual({
      kind: 'COBRO',
      desglosado: false,
      subtotal: 0,
      serviceCharge: 0,
      addedTax: 0,
      tip: 15,
      total: 15,
    })
    // Un intento fallido de $0 no es venta.
    expect(
      ticketTotals({ payment: cobro(0, 0, 'REGULAR', 'FAILED'), order: orden({ subtotal: 0, cortesiaEnCero: 20 }), cobrosDeVenta: 0 }),
    ).toMatchObject({
      desglosado: false,
    })
  })

  it('cortesía que no cabe en el papel de ANDROID (centavos en Int, $21,474,836.47): no se suma, digital y reimpresión iguales (Codex r7 #2)', () => {
    // Dos renglones de $12,000,000 de cortesía y un artículo de $100 cobrado: como antes de D41.
    expect(ticketTotals({ payment: cobro(100), order: orden({ subtotal: 100, cortesiaEnCero: 24_000_000 }), cobrosDeVenta: 1 })).toEqual({
      kind: 'COBRO',
      desglosado: true,
      subtotal: 100,
      serviceCharge: 0,
      addedTax: 0,
      tip: 0,
      total: 100,
    })
    // Justo en el tope sí se suma.
    expect(
      ticketTotals({ payment: cobro(100), order: orden({ subtotal: 100, cortesiaEnCero: 21_474_736.47 }), cobrosDeVenta: 1 }),
    ).toMatchObject({ subtotal: 21_474_836.47, discount: 21_474_736.47, cortesia: 21_474_736.47 })
  })

  it('cuenta toda de cortesía pagada en partes: nada se desglosa, como hoy', () => {
    expect(ticketTotals({ payment: cobro(20), order: mesas, cobrosDeVenta: 1 })).toMatchObject({
      desglosado: false,
      parcial: true,
      total: 20,
    })
    expect(ticketTotals({ payment: cobro(29.5), order: mesas, cobrosDeVenta: 2 })).toMatchObject({ desglosado: false, parcial: true })
    expect(ticketTotals({ payment: cobro(-49.5, 0, 'REFUND'), order: mesas, cobrosDeVenta: 1 })).toMatchObject({
      kind: 'DEVOLUCION',
      desglosado: false,
      subtotal: 49.5,
    })
  })

  it('sin el dato (recibo de antes, llamador viejo), en 0 o negativo: igual que hoy', () => {
    for (const cortesiaEnCero of [undefined, null, 0, -20, '']) {
      expect(
        ticketTotals({ payment: cobro(49.5), order: orden({ subtotal: 55, discountAmount: 5.5, cortesiaEnCero }), cobrosDeVenta: 1 }),
      ).toEqual({
        kind: 'COBRO',
        desglosado: true,
        subtotal: 55,
        discount: 5.5,
        serviceCharge: 0,
        addedTax: 0,
        tip: 0,
        total: 49.5,
      })
    }
  })

  it('Codex r3 #1: un cobro ÚNICO que paga toda la cuenta es venta completa aunque se haya elegido «Monto personalizado» (sin copia D1)', () => {
    // La regla no lee `splitType` (D15): un solo cobro de venta que cubre lo que la cuenta debe se desglosa, hoy ($55) y ahora ($75).
    expect(ticketTotals({ payment: { ...cobro(49.5), splitType: 'CUSTOMAMOUNT' } as any, order: mesas, cobrosDeVenta: 1 })).toMatchObject({
      desglosado: true,
      subtotal: 75,
      discount: 25.5,
    })
  })

  it('cortesiaEnCeroDe: sólo los renglones de cortesía guardados en $0 (Mostrador ya la trae en su bruto)', () => {
    const renglones = [
      { isCortesia: false, total: 25, discountAmount: 0 },
      { isCortesia: true, total: 0, discountAmount: new Prisma.Decimal('20') }, // Mesas
      { isCortesia: true, total: new Prisma.Decimal('18'), discountAmount: 18 }, // Mostrador: bruto + descuento
      { isCortesia: false, total: 0, discountAmount: 9 }, // renglón en $0 que no es cortesía
      { isCortesia: true, total: '0.00', discountAmount: '12.50' },
      { isCortesia: true, total: 0, discountAmount: null },
      { isCortesia: null, total: 0, discountAmount: 7 },
      // Codex r4 #1: una pieza de combo dada de cortesía no entra (las promociones quedan fuera; su ticket sigue como hoy).
      { isCortesia: true, total: 0, discountAmount: 99, orderPromotionId: 'promo_1' },
    ]
    expect(cortesiaEnCeroDe(renglones).toNumber()).toBe(32.5)
    expect(cortesiaEnCeroDe([]).toNumber()).toBe(0)
  })

  it('totalDelRenglonEnElTicket: la cortesía en $0 a su bruto sólo si el desglose la sumó; lo demás, su total', () => {
    const agua = { isCortesia: true, total: 0, discountAmount: new Prisma.Decimal('20') }
    expect(totalDelRenglonEnElTicket(agua, { cortesia: 20 })).toBe(20)
    expect(totalDelRenglonEnElTicket(agua, {})).toBe(0) // recibo de antes, parcial o devolución: como se guardó
    expect(totalDelRenglonEnElTicket(agua, null)).toBe(0)
    expect(totalDelRenglonEnElTicket({ isCortesia: true, total: 20, discountAmount: 20 }, { cortesia: 20 })).toBe(20) // Mostrador
    expect(totalDelRenglonEnElTicket({ isCortesia: false, total: '25.00', discountAmount: 0 }, { cortesia: 20 })).toBe(25)
    expect(
      totalDelRenglonEnElTicket({ isCortesia: true, total: 0, discountAmount: 99, orderPromotionId: 'promo_1' }, { cortesia: 20 }),
    ).toBe(0)
  })

  it('cargarTotalesDelTicket suma la cortesía en $0 EN LA BASE, acotada a la orden del cobro (Codex r2 #3)', async () => {
    const prismaMock = prisma as any
    jest.clearAllMocks()
    const cobroDeMesa = {
      amount: new Prisma.Decimal('49.50'),
      tipAmount: new Prisma.Decimal('0'),
      type: 'REGULAR',
      status: 'COMPLETED',
      orderId: 'o1',
      order: {
        subtotal: new Prisma.Decimal('55'),
        discountAmount: new Prisma.Decimal('5.50'),
        serviceChargeAmount: new Prisma.Decimal('0'),
        taxAmount: new Prisma.Decimal('0'),
        contratoDePrecio: 'IVA_INCLUIDO',
        status: 'COMPLETED',
        _count: { payments: 1 },
      },
    }
    prismaMock.payment.findUnique.mockResolvedValue(cobroDeMesa)
    prismaMock.orderItem.aggregate.mockResolvedValue({ _sum: { discountAmount: new Prisma.Decimal('20') } })
    expect(await cargarTotalesDelTicket(prismaMock, 'pay_mesa')).toMatchObject({
      desglosado: true,
      subtotal: 75,
      discount: 25.5,
      cortesia: 20,
      total: 49.5,
    })
    expect(prismaMock.payment.findUnique.mock.calls[0][0].select.order.select).not.toHaveProperty('items')
    expect(prismaMock.orderItem.aggregate).toHaveBeenCalledWith({
      where: { orderId: 'o1', isCortesia: true, total: 0, orderPromotionId: null, discountAmount: { gt: 0 } },
      _sum: { discountAmount: true },
    })
    // Un intento fallido no se desglosa: ni siquiera se suma la cortesía.
    jest.clearAllMocks()
    prismaMock.payment.findUnique.mockResolvedValue({ ...cobroDeMesa, status: 'FAILED' })
    expect(await cargarTotalesDelTicket(prismaMock, 'pay_mesa')).toMatchObject({ desglosado: false, total: 49.5 })
    expect(prismaMock.orderItem.aggregate).not.toHaveBeenCalled()
    // Codex r4 #2: el PRIMER abono ($20 de $49.50, un solo cobro) ya es «parcial» con la misma regla: no se consulta.
    jest.clearAllMocks()
    prismaMock.payment.findUnique.mockResolvedValue({ ...cobroDeMesa, amount: new Prisma.Decimal('20') })
    expect(await cargarTotalesDelTicket(prismaMock, 'pay_mesa')).toMatchObject({ desglosado: false, parcial: true, total: 20 })
    expect(prismaMock.orderItem.aggregate).not.toHaveBeenCalled()
    // Codex r3 #2: un abono de una cuenta con dos cobros ya es «parcial»: tampoco se consulta.
    jest.clearAllMocks()
    prismaMock.payment.findUnique.mockResolvedValue({
      ...cobroDeMesa,
      amount: new Prisma.Decimal('20'),
      order: { ...cobroDeMesa.order, _count: { payments: 2 } },
    })
    expect(await cargarTotalesDelTicket(prismaMock, 'pay_mesa')).toMatchObject({ desglosado: false, parcial: true, total: 20 })
    expect(prismaMock.orderItem.aggregate).not.toHaveBeenCalled()
  })

  it('totalesSinLaCortesia: lo que leen las apps publicadas (sin la cortesía) y aparte cuánto era (Codex r2 #1)', () => {
    const conCortesia = ticketTotals({
      payment: cobro(49.5, 5),
      order: orden({ subtotal: 55, discountAmount: 5.5, cortesiaEnCero: 20 }),
      cobrosDeVenta: 1,
    })
    const viejo = ticketTotals({ payment: cobro(49.5, 5), order: orden({ subtotal: 55, discountAmount: 5.5 }), cobrosDeVenta: 1 })
    expect(totalesSinLaCortesia(conCortesia)).toEqual({ totales: viejo, cortesia: 20 })
    // Sólo cortesía: sin descuento que quede, la llave no existe (como hoy).
    const soloCortesia = ticketTotals({ payment: cobro(55), order: orden({ subtotal: 55, cortesiaEnCero: 20 }), cobrosDeVenta: 1 })
    expect(totalesSinLaCortesia(soloCortesia)).toEqual({
      totales: ticketTotals({ payment: cobro(55), order: orden({ subtotal: 55 }), cobrosDeVenta: 1 }),
      cortesia: 20,
    })
    expect(totalesSinLaCortesia(viejo)).toEqual({ totales: viejo, cortesia: 0 })
    expect(totalesSinLaCortesia(null)).toEqual({ totales: null, cortesia: 0 })
  })
})
