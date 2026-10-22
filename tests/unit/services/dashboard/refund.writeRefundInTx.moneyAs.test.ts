/**
 * El núcleo del reembolso (`writeRefundInTx`) con la semántica de dinero que dicta quien llama (`moneyAs`), la marca del cambio
 * (`exchangeMark`) y el salto de la obligación de costo negativo. Y lo ya devuelto POR ORDEN (`refundedItemsOfOrder`), que la
 * devolución por artículos y el cambio leen igual.
 *
 * Lo que protege:
 * - el gemelo del crédito de un cambio sobre un cobro con tarjeta NO hereda la tarjeta: es `OTHER`, fuera del banco, sin comercio
 *   y con el tender del crédito (forma SAT 17); heredarla haría que el corte, la póliza y el costo creyeran que regresó dinero
 *   por la terminal;
 * - sin `moneyAs` la fila es EXACTAMENTE la de siempre (se compara el `create` entero);
 * - una devolución que no es el crédito y que sale del dinero de una raíz apunta a esa raíz y conserva su método fiscal;
 * - el ancla de $0 sólo existe para el crédito de un cambio: cualquier otro reembolso de $0 se sigue rechazando.
 */
import { PaymentType, Prisma, TransactionStatus } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import cuid from 'cuid'

jest.mock('@/services/payments/deferredTransactionCost.service', () => ({
  ...jest.requireActual('@/services/payments/deferredTransactionCost.service'),
  asegurarObligacionDeCostoNegativo: jest.fn().mockResolvedValue('SIN_OBLIGACION'),
}))

import {
  issueRefund,
  refundedItemsOfOrder,
  writeRefundInTx,
  type CobroBloqueado,
  type RefundMoneySemantics,
  type WriteRefundInput,
} from '@/services/dashboard/refund.dashboard.service'
import { asegurarObligacionDeCostoNegativo } from '@/services/payments/deferredTransactionCost.service'
import { NO_SE_PUEDE_POR_ARTICULOS } from '@/services/fiscal/cobradoDeLaOrden'
import { TOPES_POR_ORDEN } from '@/services/fiscal/librosDeOrdenes'
import { metodoParaAlcanceFiscal, paymentInFiscalScope } from '@/services/fiscal/fiscalScope'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'cmvixy2n100006kwa5fvmb7r7'
const ORDER = 'cmvixy2n200016kwa586a3ucx'
const ORIGINAL = 'cmvixy2n200026kwa0nkl078r'
const REFUND = 'cmvixy2n200036kwaf9s420p2'
const SHIFT = 'cmvixy2n200046kwa3mm6dzvi'
const STAFF = 'cmvixy2n200056kwa8y39hsli'
const MERCHANT = 'cmvixy2n200066kwad0rtcdnh'
const EC_TENDER = 'cmvixy2n200076kwafwkmecvb'
const EXCHANGE = 'cmvixy2n200086kwag5o5hmlh'
const ROOT = 'cmvixy2n200096kwa56t464pb'
const ORDER_ITEM = 'cmvixy2n3000a6kwa0amkd1ny'
const PAYMENT_2 = 'cmvixy2n3000b6kwa8c9y3ehr'

const pesos = (centavos: number) => new Prisma.Decimal(centavos).div(100)
const tx = prismaMock as unknown as Prisma.TransactionClient

/** El texto (un `?` por valor) y los valores de una llamada a `$queryRaw`, sea plantilla etiquetada o `Prisma.sql`. */
function consulta(args: unknown[]): { sql: string; valores: unknown[] } {
  const q = args[0]
  if (Array.isArray(q)) return { sql: q.join('?'), valores: args.slice(1) }
  return { sql: (q as Prisma.Sql).strings.join('?'), valores: [...(q as Prisma.Sql).values] }
}

/** El cobro ya bloqueado y leído, como lo deja `bloquearCobroParaReembolso`. Por default, una tarjeta de $200 sin devoluciones. */
function cobroBloqueado(original: Partial<CobroBloqueado['original']> = {}): CobroBloqueado {
  return {
    original: {
      id: ORIGINAL,
      venueId: VENUE,
      status: 'COMPLETED',
      type: PaymentType.REGULAR,
      method: 'CREDIT_CARD',
      source: 'TPV',
      amount: new Decimal(200),
      tipAmount: new Decimal(0),
      orderId: ORDER,
      shiftId: null,
      merchantAccountId: MERCHANT,
      processorData: {},
      fundsFlow: 'AVOQADO_PROCESSED',
      externalSource: null,
      tenderTypeId: null,
      tenderCountsAsCash: null,
      tenderRevision: null,
      tenderLabel: null,
      tenderCaptureTip: null,
      tenderSatFormaPago: null,
      tenderCommissionPercent: null,
      tenderSystemKind: null,
      ...original,
    },
    existingRefunds: [],
    alreadyRefundedCents: 0,
    refundedSalesCents: 0,
    refundedTipsCents: 0,
    unclassifiedPriorRefundCents: 0,
    remainingBeforeCents: 20000,
  }
}

/** La semántica del tender «Crédito de cambio», resuelta como la pasa el cambio. */
const creditoDeCambio: RefundMoneySemantics = {
  method: 'OTHER',
  fundsFlow: 'EXTERNAL_RECORDED',
  merchantAccountId: null,
  source: 'TPV',
  tenderTypeId: EC_TENDER,
  tenderRevision: 1,
  tenderLabel: 'Crédito de cambio',
  tenderCountsAsCash: false,
  tenderCaptureTip: false,
  tenderSatFormaPago: '17',
}

/** La semántica de una raíz pagada en efectivo (lo que hereda la cadena), sin comercio. */
const raizEnEfectivo: RefundMoneySemantics = {
  method: 'CASH',
  fundsFlow: 'CASH_DRAWER',
  merchantAccountId: null,
  source: 'TPV',
  tenderTypeId: null,
  tenderRevision: null,
  tenderLabel: null,
  tenderCountsAsCash: null,
  tenderCaptureTip: null,
  tenderSatFormaPago: null,
}

const entrada = (extra: Partial<WriteRefundInput> = {}, bloqueado: CobroBloqueado = cobroBloqueado()): WriteRefundInput =>
  ({
    originalPaymentId: bloqueado.original.id,
    venueId: VENUE,
    salesRefundCents: 12000,
    tipRefundCents: 0,
    refundedItems: [{ orderItemId: ORDER_ITEM, quantity: 1, amountCents: 12000 }],
    reason: 'RETURNED_GOODS',
    note: null,
    staffId: STAFF,
    tenderCommission: 'NONE',
    shift: 'CLAIM_LIVE',
    provenance: 'MANUAL',
    bloqueado,
    ...extra,
  }) as WriteRefundInput

const filaCreada = () => prismaMock.payment.create.mock.calls[0][0].data as Record<string, any>

describe('writeRefundInTx — semántica de dinero explícita y marca del cambio', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.shift.findFirst.mockResolvedValue({ id: SHIFT, status: 'OPEN' } as never)
    prismaMock.shift.updateMany.mockResolvedValue({ count: 1 } as never)
    prismaMock.payment.create.mockResolvedValue({ id: REFUND } as never)
    prismaMock.payment.update.mockResolvedValue({ id: ORIGINAL } as never)
    prismaMock.venueTransaction.create.mockResolvedValue({ id: 'cmviy09ma0008mywab26u6rlv' } as never)
  })

  it('writes a credit refund over a card payment with method OTHER, fundsFlow EXTERNAL_RECORDED, merchantAccountId null and the EC tender snapshot', async () => {
    // original: CREDIT_CARD, AVOQADO_PROCESSED, merchantAccountId MERCHANT
    await writeRefundInTx(
      tx,
      entrada({ moneyAs: creditoDeCambio, skipNegativeCostObligation: true, exchangeMark: { exchangeId: EXCHANGE, role: 'CREDIT' } }),
    )

    expect(prismaMock.payment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        method: 'OTHER',
        fundsFlow: 'EXTERNAL_RECORDED',
        merchantAccountId: undefined,
        tenderTypeId: EC_TENDER,
        tenderSatFormaPago: '17',
        processorData: expect.objectContaining({ exchange: { exchangeId: EXCHANGE, role: 'CREDIT' } }),
      }),
    })
    const fila = filaCreada()
    expect(fila).toMatchObject({
      source: 'TPV',
      tenderRevision: 1,
      tenderLabel: 'Crédito de cambio',
      tenderCountsAsCash: false,
      tenderCaptureTip: false,
    })
    // El crédito no es una comisión devuelta: ni su % ni su monto.
    expect(fila.tenderCommissionPercent).toBeUndefined()
    expect(fila.tenderCommissionAmount).toBeUndefined()
    // El gemelo del crédito apunta a la venta original, y su raíz va SÓLO en la marca del cambio.
    expect(fila.processorData.originalPaymentId).toBe(ORIGINAL)
    expect(fila.processorData.originalMethod).toBe('CREDIT_CARD')
    expect(fila.processorData).not.toHaveProperty('rootPaymentId')
  })

  it('the tender commission reversal never rides on a moneyAs row', async () => {
    const conComision = cobroBloqueado({ tenderTypeId: 'cmviy09m80000mywa91q33l6q', tenderCommissionPercent: new Prisma.Decimal(30) })
    await writeRefundInTx(
      tx,
      entrada(
        { moneyAs: creditoDeCambio, tenderCommission: 'REVERSE_PROPORTIONAL', exchangeMark: { exchangeId: EXCHANGE, role: 'CREDIT' } },
        conComision,
      ),
    )
    expect(filaCreada().tenderCommissionPercent).toBeUndefined()
    expect(filaCreada().tenderCommissionAmount).toBeUndefined()
    expect(filaCreada().tenderTypeId).toBe(EC_TENDER)
  })

  it('does not open the negative cost obligation with skipNegativeCostObligation', async () => {
    await writeRefundInTx(
      tx,
      entrada({ moneyAs: creditoDeCambio, skipNegativeCostObligation: true, exchangeMark: { exchangeId: EXCHANGE, role: 'CREDIT' } }),
    )
    expect(asegurarObligacionDeCostoNegativo).not.toHaveBeenCalled()

    // Control: sin la bandera, la obligación se abre como siempre, en la misma transacción.
    jest.clearAllMocks()
    prismaMock.payment.create.mockResolvedValue({ id: REFUND } as never)
    await writeRefundInTx(tx, entrada())
    expect(asegurarObligacionDeCostoNegativo).toHaveBeenCalledWith(tx, ORIGINAL, REFUND)
  })

  it('throws when moneyAs and devolverCon come together', async () => {
    await expect(writeRefundInTx(tx, entrada({ moneyAs: creditoDeCambio, devolverCon: 'CASH' }))).rejects.toMatchObject({ statusCode: 400 })
    // Tampoco «Devolver con» el mismo medio del cobro (que solo valdría «como siempre»): son dos respuestas a la misma pregunta.
    const efectivo = cobroBloqueado({ method: 'CASH', merchantAccountId: null, fundsFlow: 'CASH_DRAWER' })
    await expect(writeRefundInTx(tx, entrada({ moneyAs: creditoDeCambio, devolverCon: 'CASH' }, efectivo))).rejects.toMatchObject({
      statusCode: 400,
    })
    expect(prismaMock.shift.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('without moneyAs creates exactly the same row as before for a cash refund', async () => {
    const efectivo = cobroBloqueado({ method: 'CASH', merchantAccountId: null, fundsFlow: 'CASH_DRAWER' })
    await writeRefundInTx(tx, entrada({ salesRefundCents: 5000 }, efectivo))

    expect(prismaMock.payment.create.mock.calls[0][0]).toStrictEqual({
      data: {
        venueId: VENUE,
        orderId: ORDER,
        shiftId: SHIFT,
        processedById: STAFF,
        idempotencyKey: undefined,
        merchantAccountId: undefined,
        amount: pesos(-5000),
        tipAmount: pesos(-0),
        netAmount: pesos(-5000),
        feeAmount: new Prisma.Decimal(0),
        feePercentage: 0,
        method: 'CASH',
        tenderTypeId: undefined,
        tenderRevision: undefined,
        tenderLabel: undefined,
        tenderCountsAsCash: undefined,
        tenderCaptureTip: undefined,
        tenderSatFormaPago: undefined,
        tenderCommissionPercent: undefined,
        tenderCommissionAmount: undefined,
        fundsFlow: 'CASH_DRAWER',
        source: 'TPV',
        status: 'COMPLETED',
        type: PaymentType.REFUND,
        processor: 'dashboard',
        processorData: {
          originalPaymentId: ORIGINAL,
          originalMethod: 'CASH',
          refundReason: 'RETURNED_GOODS',
          note: null,
          amountCents: 5000,
          amount: 50,
          refundedItems: [{ orderItemId: ORDER_ITEM, quantity: 1, amountCents: 12000 }],
          shiftBackfilled: true,
          provenance: 'MANUAL',
        },
      },
    })
    expect(asegurarObligacionDeCostoNegativo).toHaveBeenCalledWith(tx, ORIGINAL, REFUND)
  })

  it('a non-CREDIT row with moneyAs and rootPaymentId points to the root and keeps the root method as originalMethod', async () => {
    // Lo devuelto de algo pagado con crédito: el cobro devuelto es el del crédito; el dinero salió de la raíz (efectivo).
    const cobroConCredito = cobroBloqueado({
      method: 'OTHER',
      merchantAccountId: null,
      fundsFlow: 'EXTERNAL_RECORDED',
      tenderTypeId: EC_TENDER,
      tenderSystemKind: 'EXCHANGE_CREDIT',
    })
    await writeRefundInTx(
      tx,
      entrada(
        { moneyAs: raizEnEfectivo, exchangeMark: { exchangeId: EXCHANGE, role: 'DIFFERENCE', rootPaymentId: ROOT } },
        cobroConCredito,
      ),
    )

    const pd = filaCreada().processorData
    // Los topes siguen leyendo el cobro devuelto; el origen económico y el alcance fiscal, la raíz.
    expect(pd.originalPaymentId).toBe(ORIGINAL)
    expect(pd.rootPaymentId).toBe(ROOT)
    expect(pd.originalMethod).toBe('CASH')
    expect(pd.exchange).toEqual({ exchangeId: EXCHANGE, role: 'DIFFERENCE', rootPaymentId: ROOT })
    expect(filaCreada()).toMatchObject({ method: 'CASH', fundsFlow: 'CASH_DRAWER' })
  })

  it('a CREDIT row carries rootPaymentId only inside the exchange mark', async () => {
    await writeRefundInTx(
      tx,
      entrada({ moneyAs: creditoDeCambio, exchangeMark: { exchangeId: EXCHANGE, role: 'CREDIT', rootPaymentId: ROOT } }),
    )

    const pd = filaCreada().processorData
    expect(pd.exchange).toEqual({ exchangeId: EXCHANGE, role: 'CREDIT', rootPaymentId: ROOT })
    expect(pd).not.toHaveProperty('rootPaymentId')
    expect(pd.originalMethod).toBe('CREDIT_CARD')
  })

  it('with cash excluded from accounting, a chain cash refund is excluded from autoposting like an ordinary cash refund', async () => {
    const efectivo = cobroBloqueado({ method: 'CASH', merchantAccountId: null, fundsFlow: 'CASH_DRAWER' })
    await writeRefundInTx(tx, entrada({}, efectivo))
    const cobroConCredito = cobroBloqueado({
      id: PAYMENT_2,
      method: 'OTHER',
      merchantAccountId: null,
      fundsFlow: 'EXTERNAL_RECORDED',
      tenderTypeId: EC_TENDER,
      tenderSystemKind: 'EXCHANGE_CREDIT',
    })
    await writeRefundInTx(
      tx,
      entrada({ moneyAs: raizEnEfectivo, exchangeMark: { exchangeId: EXCHANGE, role: 'CHAIN', rootPaymentId: ROOT } }, cobroConCredito),
    )

    // Mismo predicado que el autoposteo: la devolución sigue el alcance de su VENTA; sin el efectivo en la contabilidad, fuera.
    const [ordinaria, cadena] = prismaMock.payment.create.mock.calls.map((c: any[]) => c[0].data as Record<string, any>)
    const enLosLibros = (fila: Record<string, any>) =>
      paymentInFiscalScope(metodoParaAlcanceFiscal(fila.method, fila.processorData), null, false)
    expect(enLosLibros(ordinaria)).toBe(false)
    expect(enLosLibros(cadena)).toBe(false)
  })

  it('accepts a $0 credit anchor only with the CREDIT mark and moneyAs', async () => {
    const r = await writeRefundInTx(
      tx,
      entrada({
        salesRefundCents: 0,
        refundedItems: [{ orderItemId: ORDER_ITEM, quantity: 1, amountCents: 0 }],
        moneyAs: creditoDeCambio,
        skipNegativeCostObligation: true,
        exchangeMark: { exchangeId: EXCHANGE, role: 'CREDIT', rootPaymentId: ORIGINAL },
      }),
    )
    expect(r).toEqual({ refundPaymentId: REFUND, replay: false })
    const fila = filaCreada()
    expect(fila.amount.isZero()).toBe(true)
    expect(fila.processorData).toMatchObject({ amountCents: 0, refundedItems: [{ orderItemId: ORDER_ITEM, quantity: 1, amountCents: 0 }] })
    expect(fila.processorData.exchange.role).toBe('CREDIT')
  })

  it.each([
    ['moneyAs with a non-CREDIT role', { moneyAs: raizEnEfectivo, exchangeMark: { exchangeId: EXCHANGE, role: 'DIFFERENCE' as const } }],
    ['the CREDIT mark without moneyAs', { exchangeMark: { exchangeId: EXCHANGE, role: 'CREDIT' as const } }],
    ['moneyAs without a mark', { moneyAs: creditoDeCambio }],
    ['an ordinary refund', {}],
  ])('rejects a $0 refund with %s', async (_caso, extra) => {
    await expect(writeRefundInTx(tx, entrada({ salesRefundCents: 0, ...extra }))).rejects.toThrow(
      'El monto a devolver debe ser mayor que cero.',
    )
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
    expect(prismaMock.shift.updateMany).not.toHaveBeenCalled()
  })
})

describe('refundedItemsOfOrder — lo ya devuelto de cada renglón, en TODA la orden', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.$queryRaw.mockReset()
  })

  it('sums the quantities and cents returned by every refund of the order, whatever payment it came from', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([
      { id: 'cmviy09ma0001mywaffvohgms', processorData: { refundedItems: [{ orderItemId: ORDER_ITEM, quantity: 1, amountCents: 5000 }] } },
      { id: 'cmviy09ma0002mywa4zt0g4mj', processorData: { refundedItems: [{ orderItemId: ORDER_ITEM, quantity: 0, amountCents: 2000 }] } },
      { id: 'cmviy09ma0003mywa79ni97du', processorData: { refundedItems: null } },
    ])

    const devuelto = await refundedItemsOfOrder(tx, VENUE, ORDER)

    expect([...devuelto.values()]).toEqual([{ orderItemId: ORDER_ITEM, quantity: 1, amountCents: 7000 }])
    const { sql, valores } = consulta(prismaMock.$queryRaw.mock.calls[0])
    expect(sql).toContain(`jsonb_build_object('refundedItems'`)
    // SIN filtro de `status` a propósito: son CANTIDADES devueltas (una devolución no completada sigue contando).
    expect(sql).not.toMatch(/status/i)
    expect(valores).toEqual([VENUE, ORDER, PaymentType.REFUND, TOPES_POR_ORDEN.movimientos + 1])
  })

  it('over the cap throws the same 400 as before', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce(
      Array.from({ length: TOPES_POR_ORDEN.movimientos + 1 }, () => ({ id: cuid(), processorData: {} })),
    )
    const fallo = refundedItemsOfOrder(tx, VENUE, ORDER)
    await expect(fallo).rejects.toThrow(NO_SE_PUEDE_POR_ARTICULOS.TOPE)
    await expect(fallo).rejects.toMatchObject({ statusCode: 400, code: 'REFUND_ITEMS_NOT_ATTRIBUTABLE' })
  })
})

describe('issueRefund — por artículos y de $0, por el camino de siempre', () => {
  // El arnés de la devolución del dashboard: los candados y lecturas de `bloquearCobroParaReembolso`, el cargador de lo cobrado y lo
  // ya devuelto de la ORDEN, con la misma intercepción de `$queryRaw` que `refund.dashboard.service.test.ts`.
  let devolucionesDeLaOrden: Array<{ id: string; processorData: unknown }> = []
  let sqlDeLaOrden: Array<{ sql: string; valores: unknown[] }> = []

  const cobro = (id: string, amount: number) => ({
    id,
    venueId: VENUE,
    status: TransactionStatus.COMPLETED,
    type: PaymentType.REGULAR,
    method: 'CASH',
    source: 'APP',
    amount,
    tipAmount: 0,
    orderId: ORDER,
    shiftId: null,
    merchantAccountId: null,
    processorData: {},
    fundsFlow: null,
    tenderTypeId: null,
    tenderCountsAsCash: null,
  })
  const linea = (id: string, productName: string, o: Record<string, unknown> = {}) => ({
    id,
    orderId: ORDER,
    productId: null,
    productName,
    quantity: 1,
    unitPrice: new Decimal(100),
    total: new Decimal(100),
    discountAmount: new Decimal(0),
    orderPromotionId: null,
    isCortesia: false,
    ivaTratamiento: null,
    product: { taxRate: new Decimal(0.16), ivaTratamiento: 'IVA_16' },
    ...o,
  })
  const venta = (lineas: Array<ReturnType<typeof linea>>, cabecera: number) => {
    prismaMock.order.findUnique.mockResolvedValue({
      discountAmount: new Decimal(cabecera),
      contratoDePrecio: null,
      originSystem: null,
    } as never)
    prismaMock.orderItem.findMany.mockImplementation((async (a: any) =>
      a?.where?.id?.in ? lineas.filter(l => a.where.id.in.includes(l.id)) : lineas) as never)
  }

  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.$queryRaw.mockReset()
    prismaMock.orderItem.findMany.mockReset()
    devolucionesDeLaOrden = []
    sqlDeLaOrden = []
    prismaMock.payment.findFirst.mockResolvedValue({ orderId: ORDER, order: { updatedAt: new Date('2026-10-20T09:00:00.000Z') } } as never)
    prismaMock.$transaction.mockImplementation((async (callback: any) => {
      const queryRaw = jest.fn(async (...args: any[]) => {
        const leida = consulta(args)
        if (leida.sql.includes('FROM "Order"')) return [{ id: ORDER }]
        if (leida.sql.includes('FROM "OrderDiscount"')) return []
        if (leida.sql.includes(`jsonb_build_object('refundedItems'`)) {
          sqlDeLaOrden.push(leida)
          return devolucionesDeLaOrden
        }
        return (prismaMock.$queryRaw as any)(...args)
      })
      return callback({ ...(prismaMock as any), $queryRaw: queryRaw })
    }) as never)
  })
  afterEach(() => {
    prismaMock.orderItem.findMany.mockReset()
    prismaMock.orderItem.findMany.mockResolvedValue([])
  })

  it('issueRefund counts items by order through refundedItemsOfOrder, with the same message as before', async () => {
    const A = 'cmviy09ma0004mywa6qrt59pv'
    venta([linea(A, 'A'), linea('cmviy09ma0005mywa2zd92n10', 'B')], 0)
    // El segundo cobro de la cuenta no tiene devoluciones propias, pero la ORDEN ya devolvió A por el primero.
    devolucionesDeLaOrden = [{ id: REFUND, processorData: { refundedItems: [{ orderItemId: A, quantity: 1, amountCents: 10000 }] } }]
    prismaMock.$queryRaw.mockResolvedValueOnce([cobro(PAYMENT_2, 100)]).mockResolvedValueOnce([])

    await expect(
      issueRefund({ venueId: VENUE, paymentId: PAYMENT_2, items: [{ orderItemId: A }], reason: 'RETURNED_GOODS' }),
    ).rejects.toThrow('Este artículo («A») ya se devolvió en otro cobro de la misma cuenta; quedan 0 de 1 por devolver.')
    expect(prismaMock.payment.create).not.toHaveBeenCalled()

    // La lectura que hizo `issueRefund` es, texto y valores, la de `refundedItemsOfOrder`.
    expect(sqlDeLaOrden).toHaveLength(1)
    prismaMock.$queryRaw.mockResolvedValueOnce([])
    await refundedItemsOfOrder(tx, VENUE, ORDER)
    expect(sqlDeLaOrden[0]).toEqual(consulta(prismaMock.$queryRaw.mock.calls.at(-1)!))
  })

  it('a $0 REFUND is still rejected by issueRefund outside the exchange path', async () => {
    // Una cortesía de la TPV (total $100, descuento $100) cobró $0: devolverla sola daría una fila de $0.
    const regalo = 'cmviy09ma0006mywa00t7evai'
    venta(
      [
        linea(regalo, 'Regalo', { isCortesia: true, discountAmount: new Decimal(100) }),
        linea('cmviy09ma0007mywa84crhfqm', 'B', { unitPrice: new Decimal(150), total: new Decimal(150) }),
      ],
      100,
    )
    prismaMock.$queryRaw.mockResolvedValueOnce([cobro(ORIGINAL, 150)]).mockResolvedValueOnce([])

    await expect(
      issueRefund({ venueId: VENUE, paymentId: ORIGINAL, items: [{ orderItemId: regalo }], reason: 'RETURNED_GOODS' }),
    ).rejects.toThrow('El monto a devolver debe ser mayor que cero.')
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
    expect(prismaMock.shift.updateMany).not.toHaveBeenCalled()
  })
})
