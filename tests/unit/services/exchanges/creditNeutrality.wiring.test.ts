/**
 * El crédito de cambio es neutro (spec 2026-10-20 §7.6 y §6.2): una devolución con tender EXCHANGE_CREDIT no es dinero que
 * regresó a la clienta, así que no mide la comisión que se revierte, no cuenta para anular el referido de la venta original y no
 * genera costo de transacción negativo. Estas pruebas fijan que cada lector lleva la marca; el efecto en la base real lo prueban
 * las de integración del cambio.
 */
import { Decimal } from '@prisma/client/runtime/library'
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { createRefundCommission } from '@/services/dashboard/commission/commission-calculation.service'
import { isOrderFullyReversed } from '@/services/referrals/referralReversalPolicy.service'
import { asegurarObligacionDeCostoNegativo, convergerCostoDeTransaccion } from '@/services/payments/deferredTransactionCost.service'
import { WHERE_PAYMENT_IS_NOT_EXCHANGE_CREDIT, sqlPaymentIsNotExchangeCredit } from '@/services/exchanges/exchangeMarks'

const mock = prismaMock as any

/** El texto SQL de una llamada a `$queryRaw`, sea con `Prisma.sql` o como plantilla etiquetada. */
const textoDe = (args: unknown[]): string => {
  const [primero, ...valores] = args as [readonly string[] | { sql: string }, ...unknown[]]
  return Array.isArray(primero) ? Prisma.sql(primero, ...(valores as Prisma.Sql[])).sql : (primero as { sql: string }).sql
}

describe('commission: the exchange credit refund neither measures nor counts as reverted (spec §7.6)', () => {
  /** Un cobro de $100 con comisión de $10 y una devolución en efectivo de $40. */
  function armarReverso() {
    mock.payment.findUnique.mockResolvedValue({
      id: 'ref-1',
      venueId: 'venue-1',
      orderId: 'order-1',
      type: 'REFUND',
      processorData: { originalPaymentId: 'pay-orig' },
      amount: new Decimal(-40),
      tipAmount: new Decimal(0),
      createdAt: new Date('2026-10-21T18:00:00Z'),
    })
    mock.payment.findFirst.mockResolvedValue({
      id: 'pay-orig',
      venueId: 'venue-1',
      orderId: 'order-1',
      amount: new Decimal(100),
      tipAmount: new Decimal(0),
    })
    mock.commissionCalculation.findMany.mockResolvedValue([
      {
        id: 'calc-1',
        venueId: 'venue-1',
        staffId: 'staff-1',
        paymentId: 'pay-orig',
        orderId: 'order-1',
        shiftId: null,
        configId: 'cfg-1',
        baseAmount: new Decimal(100),
        tipAmount: new Decimal(0),
        discountAmount: new Decimal(0),
        taxAmount: new Decimal(0),
        effectiveRate: new Decimal(0.1),
        grossCommission: new Decimal(10),
        netCommission: new Decimal(10),
        calcType: 'PERCENTAGE',
        tier: null,
        tierName: null,
        status: 'CALCULATED',
      },
    ])
    mock.paymentEffect.findMany.mockResolvedValue([])
    mock.paymentEffect.findFirst.mockResolvedValue(null)
    mock.commissionCalculation.findFirst.mockResolvedValue(null)
    mock.payment.aggregate.mockResolvedValue({ _sum: { amount: new Decimal(-40), tipAmount: new Decimal(0) } })
    mock.$queryRaw.mockImplementation(async (...args: unknown[]) =>
      textoDe(args).includes('revertido')
        ? [
            {
              baseAmount: new Decimal(0),
              tipAmount: new Decimal(0),
              discountAmount: new Decimal(0),
              taxAmount: new Decimal(0),
              grossCommission: new Decimal(0),
              netCommission: new Decimal(0),
            },
          ]
        : [],
    )
    mock.commissionCalculation.create.mockImplementation(async (a: { data: object }) => ({ id: 'rev-1', ...a.data }))
  }

  it('createRefundCommission measures refunded money without EXCHANGE_CREDIT refunds', async () => {
    armarReverso()
    await createRefundCommission('ref-1', 'pay-orig', { db: prismaMock as any })
    expect(mock.payment.aggregate).toHaveBeenCalledTimes(1)
    expect(mock.payment.aggregate.mock.calls[0][0].where).toEqual({
      venueId: 'venue-1',
      type: 'REFUND',
      status: 'COMPLETED',
      AND: [
        {
          OR: [
            { processorData: { path: ['rootPaymentId'], equals: 'pay-orig' } },
            {
              AND: [
                { processorData: { path: ['rootPaymentId'], equals: Prisma.AnyNull } },
                { processorData: { path: ['originalPaymentId'], equals: 'pay-orig' } },
              ],
            },
          ],
        },
        WHERE_PAYMENT_IS_NOT_EXCHANGE_CREDIT,
      ],
    })
  })

  it('createRefundCommission does not count what EXCHANGE_CREDIT refunds reverted as already reverted', async () => {
    armarReverso()
    await createRefundCommission('ref-1', 'pay-orig', { db: prismaMock as any })
    const cte = mock.$queryRaw.mock.calls.map((c: unknown[]) => textoDe(c)).find((t: string) => t.includes('revertido'))
    expect(cte).toBeDefined()
    expect(cte).toContain(`WITH devoluciones AS`)
    expect(cte).toContain(sqlPaymentIsNotExchangeCredit('p').sql)
  })
})

describe('referrals: the exchange credit refund does not reverse the original sale', () => {
  it('isOrderFullyReversed ignores EXCHANGE_CREDIT refunds', async () => {
    mock.order.findUnique.mockResolvedValue({ status: 'COMPLETED', paymentStatus: 'PAID', total: 500, tipAmount: 0 })
    mock.payment.findMany.mockResolvedValue([])
    await expect(isOrderFullyReversed('order-1', 'venue-1', prismaMock as any)).resolves.toBe(false)
    expect(mock.payment.findMany.mock.calls[0][0].where).toEqual({
      orderId: 'order-1',
      venueId: 'venue-1',
      type: 'REFUND',
      status: 'COMPLETED',
      AND: [WHERE_PAYMENT_IS_NOT_EXCHANGE_CREDIT],
    })
  })
})

describe('transaction cost: the exchange credit refund has no negative cost', () => {
  /** El cobro original con tarjeta procesada por Avoqado y su obligación de costo ya cumplida (DONE). */
  function armarOriginalConTarjeta(tenderDeLaDevolucion: { systemKind: string | null } | null) {
    mock.payment.findUnique.mockImplementation(async (a: { where: { id: string } }) =>
      a.where.id === 'p1'
        ? {
            id: 'p1',
            venueId: 'venue-1',
            orderId: 'order-1',
            status: 'COMPLETED',
            method: 'CREDIT_CARD',
            fundsFlow: 'AVOQADO_PROCESSED',
            tenderTypeId: null,
            tenderCountsAsCash: null,
          }
        : { tenderType: tenderDeLaDevolucion },
    )
    mock.paymentEffect.findFirst.mockResolvedValue({ id: 'effect-1', status: 'DONE', payload: {} })
    mock.paymentEffect.updateMany.mockResolvedValue({ count: 1 })
    mock.$executeRaw.mockResolvedValue(1)
  }

  it('asegurarObligacionDeCostoNegativo returns SIN_OBLIGACION when the refund row carries the EXCHANGE_CREDIT tender', async () => {
    armarOriginalConTarjeta({ systemKind: 'EXCHANGE_CREDIT' })
    await expect(asegurarObligacionDeCostoNegativo(prismaMock as any, 'p1', 'refund-1')).resolves.toBe('SIN_OBLIGACION')
    expect(mock.payment.findUnique).toHaveBeenCalledWith({
      where: { id: 'refund-1' },
      select: { tenderType: { select: { systemKind: true } } },
    })
    expect(mock.paymentEffect.updateMany).not.toHaveBeenCalled()
    expect(mock.$executeRaw).not.toHaveBeenCalled()
  })

  it('regression: a card refund over the same payment still reopens the cost obligation', async () => {
    armarOriginalConTarjeta(null)
    await expect(asegurarObligacionDeCostoNegativo(prismaMock as any, 'p1', 'refund-1')).resolves.toBe('REABIERTA')
  })

  it('reembolsosConTrabajoPendiente excludes EXCHANGE_CREDIT refunds', async () => {
    mock.$transaction.mockImplementation(async (fn: unknown) => (fn as (tx: unknown) => unknown)(prismaMock))
    // El candado de la fila del cobro responde con la fila; la página de reembolsos, vacía.
    mock.$queryRaw.mockImplementation(async (...args: unknown[]) =>
      textoDe(args).includes('LEFT JOIN "TransactionCost"') ? [] : [{ id: 'p1' }],
    )
    mock.payment.findUniqueOrThrow.mockResolvedValue({
      id: 'p1',
      venueId: 'venue-1',
      status: 'COMPLETED',
      method: 'CREDIT_CARD',
      fundsFlow: 'AVOQADO_PROCESSED',
      feeAmount: new Decimal(2),
      netAmount: new Decimal(98),
    })
    mock.transactionCost.findUnique.mockResolvedValue({
      id: 'tc-1',
      amount: new Decimal(100),
      venueChargeAmount: new Decimal(2),
      venueFixedFee: new Decimal(0),
      merchantAccountId: 'ma-1',
      transactionType: 'DEBIT',
    })
    mock.venueTransaction.updateMany.mockResolvedValue({ count: 1 })
    mock.venueTransaction.findUnique.mockResolvedValue({ estimatedSettlementDate: new Date(), settlementConfigId: 'sc-1' })
    mock.$executeRaw.mockResolvedValue(1)
    mock.paymentEffect.updateMany.mockResolvedValue({ count: 1 })

    await expect(convergerCostoDeTransaccion('p1', { tipo: 'REST' })).resolves.toBe('CONVERGIO')
    const pagina = mock.$queryRaw.mock.calls
      .map((c: unknown[]) => textoDe(c))
      .find((t: string) => t.includes('LEFT JOIN "TransactionCost"'))
    expect(pagina).toBeDefined()
    expect(pagina).toContain(sqlPaymentIsNotExchangeCredit('r').sql)
  })
})
