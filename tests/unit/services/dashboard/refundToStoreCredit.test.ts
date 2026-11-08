/**
 * Saldo a favor (spec 2026-10-30-saldo-a-favor §5.3, tarea S3): la devolución de una venta cuyo DESTINO es el sobre de la clienta.
 *
 * Lo que protege:
 * - la fila REFUND lleva el medio de sistema `STORE_CREDIT` como destino (fuera del cajón y del banco, forma 17, sin comercio) y como
 *   ORIGEN fiscal el método del cobro devuelto o de su raíz; nunca el del destino;
 * - el cajón no se mueve (`NOT_DRAWER_CASH`) aunque la venta haya sido en efectivo;
 * - el sobre de la clienta se aparta DESPUÉS del cobro y ANTES del turno, y el abono va en la MISMA transacción que la fila: si el
 *   abono lanza, la transacción se cae entera (lo prueba contra Postgres `reembolsoASaldo.integration.test.ts`);
 * - un crédito de cambio cuya raíz es una tarjeta bancaria sí se puede pasar a saldo, pero nunca más de lo que la raíz todavía respalda
 *   (lo que cobró menos lo que de verdad salió de ella, sin el gemelo del crédito);
 * - una devolución a saldo nunca crea costo negativo del procesador: ni al momento ni al converger la obligación del cobro.
 */
import { PaymentType, Prisma, TransactionStatus } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'

jest.mock('@/services/payments/deferredTransactionCost.service', () => ({
  ...jest.requireActual('@/services/payments/deferredTransactionCost.service'),
  asegurarObligacionDeCostoNegativo: jest.fn().mockResolvedValue('SIN_OBLIGACION'),
  costearYProyectarReembolso: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/tpv/paymentEffects.service', () => ({
  ...jest.requireActual('@/services/tpv/paymentEffects.service'),
  enqueueRefundPaymentEffectsInTx: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/wallet/stampLedger.service', () => ({ reverseStampForOrder: jest.fn().mockResolvedValue({ reversed: true }) }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/giftCards/giftCardLedger', () => ({
  ...jest.requireActual('@/services/giftCards/giftCardLedger'),
  prepararSobreDeSaldoAFavorEnTx: jest.fn(),
}))
jest.mock('@/services/storeCredit/primerSobreLock', () => ({
  tomarCandadoPrimerSobreSiHaceFaltaEnTx: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/storeCredit/storeCreditTender', () => ({
  ...jest.requireActual('@/services/storeCredit/storeCreditTender'),
  resolveStoreCreditTenderInTx: jest.fn(),
}))
jest.mock('@/services/storeCredit/respaldoDeLaRaiz', () => ({
  ...jest.requireActual('@/services/storeCredit/respaldoDeLaRaiz'),
  respaldoVigenteDeLaRaiz: jest.fn(),
}))
jest.mock('@/services/shared/cashDrawerPosting', () => {
  const real = jest.requireActual('@/services/shared/cashDrawerPosting')
  return { ...real, postCashRefundToDrawer: jest.fn((...a: unknown[]) => real.postCashRefundToDrawer(...a)) }
})

import {
  issueRefund,
  writeRefundInTx,
  type AbonarSaldoAFavor,
  type CobroBloqueado,
  type RefundMoneySemantics,
  type WriteRefundInput,
} from '@/services/dashboard/refund.dashboard.service'
import { asegurarObligacionDeCostoNegativo, convergerCostoDeTransaccion } from '@/services/payments/deferredTransactionCost.service'
import { createRefundTransactionCost } from '@/services/payments/transactionCost.service'
import { prepararSobreDeSaldoAFavorEnTx, type AbonoDeSaldoAFavor, type SobrePreparado } from '@/services/giftCards/giftCardLedger'
import { GiftCardError } from '@/services/giftCards/giftCardErrors'
import { tomarCandadoPrimerSobreSiHaceFaltaEnTx } from '@/services/storeCredit/primerSobreLock'
import { resolveStoreCreditTenderInTx } from '@/services/storeCredit/storeCreditTender'
import { respaldoVigenteDeLaRaiz } from '@/services/storeCredit/respaldoDeLaRaiz'
import { postCashRefundToDrawer } from '@/services/shared/cashDrawerPosting'
import { resolveChainRefund, type ChainRefundRoot } from '@/services/exchanges/exchangeChainRefund'
import { logAction } from '@/services/dashboard/activity-log.service'
import { costearYProyectarReembolso } from '@/services/payments/deferredTransactionCost.service'
import { prismaMock } from '../../../__helpers__/setup'
import type { TxConReintento } from '@/utils/serializableRetry'

const VENUE = 'cmvixy2n100006kwa5fvmb7r7'
const ORDER = 'cmvixy2n200016kwa586a3ucx'
const ORIGINAL = 'cmvixy2n200026kwa0nkl078r'
const REFUND = 'cmvixy2n200036kwaf9s420p2'
const SHIFT = 'cmvixy2n200046kwa3mm6dzvi'
const STAFF = 'cmvixy2n200056kwa8y39hsli'
const MERCHANT = 'cmvixy2n200066kwad0rtcdnh'
const SC_TENDER = 'cmvixy2n200076kwafwkmecvb'
const EXCHANGE = 'cmvixy2n200086kwag5o5hmlh'
const ROOT = 'cmvixy2n000096kwa56t464pb' // menor que CREDIT: la raíz siempre nace antes que su crédito
const CREDIT = 'cmvixy2n3000a6kwa0amkd1ny'
const CUSTOMER = 'cmvixy2n3000b6kwa8c9y3ehr'
const GIFT = 'cmvixy2n3000c6kwa1p0q9z2a'
const EC_TENDER = 'cmvixy2n3000d6kwa7c6vfq1e'
const DRAWER = 'cmvixy2n3000e6kwa3zrb0k4m'

const tx = prismaMock as unknown as Prisma.TransactionClient

/**
 * El texto (un `?` por valor) y los valores de una llamada a `$queryRaw`, sea plantilla etiquetada o `Prisma.sql`. La plantilla se
 * arma con `Prisma.sql` para que los fragmentos anidados (`Prisma.raw`, `Prisma.sql`) queden en el texto, como los manda Prisma.
 */
function consulta(args: unknown[]): { sql: string; valores: unknown[] } {
  const q = args[0]
  const s = Array.isArray(q) ? Prisma.sql(q as readonly string[], ...(args.slice(1) as Prisma.Sql[])) : (q as Prisma.Sql)
  return { sql: s.strings.join('?'), valores: [...s.values] }
}

/** El medio «Saldo a favor» como lo resuelve el SERVIDOR (`resolveStoreCreditTenderInTx`). */
const medioDeSaldo = {
  tenderTypeId: SC_TENDER,
  tenderRevision: 1,
  method: 'OTHER' as const,
  tenderLabel: 'Saldo a favor',
  tenderCountsAsCash: false,
  tenderCaptureTip: false,
  tenderSatFormaPago: '17',
  tenderCommissionPercent: null,
  fundsFlow: 'EXTERNAL_RECORDED' as const,
}
const semanticaDeSaldo: RefundMoneySemantics = { ...medioDeSaldo, merchantAccountId: null, source: 'OTHER' }

const preparado = (): SobrePreparado => ({
  venueId: VENUE,
  customerId: CUSTOMER,
  sobre: null,
  telefonoCliente: '+525512340001',
  nombreCliente: 'Ana López',
})
const abonoHecho = (monto: number): AbonoDeSaldoAFavor => ({
  giftCardId: GIFT,
  abonado: new Prisma.Decimal(monto),
  saldoNuevo: new Prisma.Decimal(monto),
  telefonoDelSobre: '+525512340001',
  telefonoNoCoincide: false,
})

/** Cómo lo deja `bloquearCobroParaReembolso`: por default una venta en EFECTIVO de $500 sin devoluciones. */
const cobroEnEfectivo = (o: Record<string, unknown> = {}) => ({
  id: ORIGINAL,
  venueId: VENUE,
  status: TransactionStatus.COMPLETED,
  type: PaymentType.REGULAR,
  method: 'CASH',
  source: 'POS',
  amount: new Decimal(500),
  tipAmount: new Decimal(0),
  orderId: ORDER,
  shiftId: SHIFT,
  merchantAccountId: null,
  processorData: {},
  fundsFlow: 'CASH_DRAWER',
  externalSource: null,
  tenderTypeId: null,
  tenderCountsAsCash: null,
  tenderRevision: null,
  tenderLabel: null,
  tenderCaptureTip: null,
  tenderSatFormaPago: null,
  tenderCommissionPercent: null,
  ...o,
})

const filaCreada = () => prismaMock.payment.create.mock.calls[0][0].data as Record<string, any>
const orden = (m: jest.Mock, i = 0) => m.mock.invocationCallOrder[i]

describe('issueRefund a saldo a favor', () => {
  let abonar: jest.Mock
  let txDeLaTransaccion: unknown
  let laTransaccionSeCayo: unknown
  let consultasDelCandado: jest.Mock[]

  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.$queryRaw.mockReset()
    abonar = jest.fn(async (_tx: unknown, _refundPaymentId: string, _p: SobrePreparado, fila: { montoCents: number }) =>
      abonoHecho(fila.montoCents / 100),
    )
    txDeLaTransaccion = undefined
    laTransaccionSeCayo = undefined
    consultasDelCandado = []
    prismaMock.payment.findFirst.mockResolvedValue({ orderId: ORDER, order: { updatedAt: new Date('2026-10-31T09:00:00.000Z') } } as never)
    prismaMock.exchangeCreditLink.findFirst.mockResolvedValue(null)
    prismaMock.shift.findFirst.mockResolvedValue({ id: SHIFT, status: 'OPEN' } as never)
    prismaMock.shift.updateMany.mockResolvedValue({ count: 1 } as never)
    prismaMock.payment.create.mockResolvedValue({ id: REFUND } as never)
    prismaMock.payment.update.mockResolvedValue({ id: ORIGINAL } as never)
    prismaMock.venueTransaction.create.mockResolvedValue({ id: 'cmviy09ma0008mywab26u6rlv' } as never)
    ;(prepararSobreDeSaldoAFavorEnTx as jest.Mock).mockImplementation(async () => preparado())
    ;(resolveStoreCreditTenderInTx as jest.Mock).mockResolvedValue(medioDeSaldo)
    // El cajón: hay una caja ABIERTA, así que si el reembolso contara como efectivo, el PAY_OUT se escribiría.
    ;(prismaMock as any).cashDrawerSession = {
      findFirst: jest.fn().mockResolvedValue({ id: DRAWER }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
    }
    ;(prismaMock as any).cashDrawerEvent = { createMany: jest.fn().mockResolvedValue({ count: 1 }) }
    prismaMock.$transaction.mockImplementation((async (callback: any) => {
      const queryRaw = jest.fn(async (...args: any[]) => {
        const { sql, valores } = consulta(args)
        // El candado de Orders contesta la orden que se pidió (la de la venta, o la de la raíz de una cadena).
        if (sql.includes('FROM "Order"')) return [{ id: valores[0] }]
        if (sql.includes('FROM "OrderDiscount"')) return []
        if (sql.includes(`jsonb_build_object('refundedItems'`)) return []
        return (prismaMock.$queryRaw as any)(...args)
      })
      consultasDelCandado.push(queryRaw)
      txDeLaTransaccion = { ...(prismaMock as any), $queryRaw: queryRaw }
      try {
        return await callback(txDeLaTransaccion)
      } catch (error) {
        laTransaccionSeCayo = error
        throw error
      }
    }) as never)
  })

  /** El cobro original bajo candado y sus devoluciones previas (ninguna), en la cola de `$queryRaw`. */
  const conCobro = (o: Record<string, unknown> = {}) =>
    prismaMock.$queryRaw.mockResolvedValueOnce([cobroEnEfectivo(o)]).mockResolvedValueOnce([])
  const reembolsar = (extra: Partial<Parameters<typeof issueRefund>[0]> = {}) =>
    issueRefund({
      venueId: VENUE,
      paymentId: ORIGINAL,
      amount: 20000,
      reason: 'RETURNED_GOODS',
      staffId: STAFF,
      aSaldoAFavor: { customerId: CUSTOMER, abonar: abonar as unknown as AbonarSaldoAFavor },
      ...extra,
    })

  it('venta en efectivo devuelta a saldo no escribe PAY_OUT', async () => {
    conCobro()
    const r = await reembolsar()

    expect(postCashRefundToDrawer).toHaveBeenCalledTimes(1)
    await expect((postCashRefundToDrawer as jest.Mock).mock.results[0].value).resolves.toBe('NOT_DRAWER_CASH')
    expect((prismaMock as any).cashDrawerEvent.createMany).not.toHaveBeenCalled()
    // Y regresa lo que se abonó: el sobre, el monto y el saldo nuevo.
    expect(r).toMatchObject({ refundId: REFUND, amount: 200, abono: { giftCardId: GIFT } })
    expect(r.abono!.abonado.toFixed(2)).toBe('200.00')
  })

  it('la fila guarda originalMethod CASH y el medio STORE_CREDIT', async () => {
    conCobro()
    await reembolsar()

    expect(filaCreada()).toMatchObject({
      method: 'OTHER',
      fundsFlow: 'EXTERNAL_RECORDED',
      tenderTypeId: SC_TENDER,
      tenderRevision: 1,
      tenderLabel: 'Saldo a favor',
      tenderCountsAsCash: false,
      tenderSatFormaPago: '17',
      source: 'OTHER',
      type: PaymentType.REFUND,
    })
    expect(filaCreada().merchantAccountId).toBeUndefined()
    expect(filaCreada().tenderCommissionAmount).toBeUndefined()
    // El ORIGEN fiscal es la venta (efectivo), nunca el destino.
    expect(filaCreada().processorData).toMatchObject({ originalPaymentId: ORIGINAL, originalMethod: 'CASH', amountCents: 20000 })
    expect(filaCreada().processorData).not.toHaveProperty('rootPaymentId')
    // El banco no devolvió nada: ninguna obligación de costo negativo.
    expect(asegurarObligacionDeCostoNegativo).not.toHaveBeenCalled()
    // El abono, con la transacción de la devolución, el id de su fila y lo que se devolvió.
    expect(abonar).toHaveBeenCalledWith(txDeLaTransaccion, REFUND, preparado(), { orderId: ORDER, montoCents: 20000 })
    // La bitácora dice a dónde se fue el dinero.
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'REFUND_CREATED',
        data: expect.objectContaining({ refundMethod: 'STORE_CREDIT', originalMethod: 'CASH' }),
      }),
    )
  })

  it.each([
    ['tope', 'STORE_CREDIT_OVER_CAP', 422],
    ['bloqueado', 'STORE_CREDIT_CARD_BLOCKED', 422],
    ['sin teléfono', 'STORE_CREDIT_CUSTOMER_PHONE_REQUIRED', 400],
  ] as const)(
    'si abonar lanza (%s), no queda devolución, ni acumulado reembolsado, ni movimiento de turno',
    async (_caso, code, status) => {
      conCobro()
      abonar.mockRejectedValueOnce(new GiftCardError(code, 'No cabe.', status))

      await expect(reembolsar()).rejects.toMatchObject({ code, statusCode: status })

      // El abono corrió DENTRO de la transacción de la devolución (la misma `tx`), después de escribir la fila, el acumulado del
      // cobro y el reclamo del turno: el rechazo hace caer la transacción entera, y con ella esas tres escrituras.
      expect(abonar.mock.calls[0][0]).toBe(txDeLaTransaccion)
      expect(laTransaccionSeCayo).toMatchObject({ code })
      expect(orden(prismaMock.payment.create)).toBeLessThan(orden(abonar))
      expect(orden(prismaMock.payment.update)).toBeLessThan(orden(abonar))
      expect(orden(prismaMock.shift.updateMany)).toBeLessThan(orden(abonar))
      // Nada de lo que va después del commit: ni cajón, ni costo, ni recibo, ni bitácora.
      expect(postCashRefundToDrawer).not.toHaveBeenCalled()
      expect(costearYProyectarReembolso).not.toHaveBeenCalled()
      expect(logAction).not.toHaveBeenCalled()
    },
  )

  it('el sobre se bloquea antes que el turno', async () => {
    conCobro()
    await reembolsar()

    const primerSobre = orden(tomarCandadoPrimerSobreSiHaceFaltaEnTx as jest.Mock)
    const ordenDeLaVenta = orden(consultasDelCandado[0])
    const cobro = orden(prismaMock.$queryRaw)
    const sobre = orden(prepararSobreDeSaldoAFavorEnTx as jest.Mock)
    const turno = orden(prismaMock.shift.findFirst)
    // «primer-sobre» → Order → Payment → clienta + sobre → Shift → fila → abono.
    expect(primerSobre).toBeLessThan(ordenDeLaVenta)
    expect(ordenDeLaVenta).toBeLessThan(cobro)
    expect(cobro).toBeLessThan(sobre)
    expect(sobre).toBeLessThan(turno)
    expect(turno).toBeLessThan(orden(prismaMock.payment.create))
    expect(orden(prismaMock.payment.create)).toBeLessThan(orden(abonar))
    expect(prepararSobreDeSaldoAFavorEnTx).toHaveBeenCalledWith(txDeLaTransaccion, { venueId: VENUE, customerId: CUSTOMER })
  })

  it('con refundMethod se rechaza antes de abrir la transacción', async () => {
    await expect(reembolsar({ refundMethod: 'CASH' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'STORE_CREDIT_REFUND_METHOD_CONFLICT',
    })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  describe('desde un crédito de cambio', () => {
    /** El crédito de cambio de $500 de la venta nueva y su raíz con tarjeta procesada por Avoqado. */
    const raizConTarjeta = {
      id: ROOT,
      venueId: VENUE,
      method: 'CREDIT_CARD',
      source: 'TPV',
      fundsFlow: 'AVOQADO_PROCESSED',
      merchantAccountId: MERCHANT,
      ecommerceMerchantId: null,
      tenderTypeId: null,
      tenderRevision: null,
      tenderLabel: null,
      tenderCountsAsCash: null,
      tenderCaptureTip: null,
      tenderSatFormaPago: null,
      tenderType: null,
    }
    beforeEach(() => {
      prismaMock.exchangeCreditLink.findFirst.mockResolvedValue({
        exchangeId: EXCHANGE,
        originPaymentId: ROOT,
        creditPaymentId: CREDIT,
      } as never)
      prismaMock.venueTenderType.findFirst.mockResolvedValue({ systemKind: 'EXCHANGE_CREDIT' } as never)
      prismaMock.payment.findFirst.mockImplementation((async (a: any) => {
        if (a?.include?.tenderType) return raizConTarjeta
        if (a?.where?.id === ROOT) return { orderId: 'cmvixy2n0000f6kwa0root0rd', method: 'CREDIT_CARD' }
        return { orderId: ORDER, order: { updatedAt: new Date('2026-10-31T09:00:00.000Z') } }
      }) as never)
    })
    const conCredito = () =>
      conCobro({ id: CREDIT, method: 'OTHER', source: 'OTHER', fundsFlow: 'EXTERNAL_RECORDED', tenderTypeId: EC_TENDER, shiftId: null })
    const pasarASaldo = (amount: number) => reembolsar({ paymentId: CREDIT, amount })

    it('aparta la raíz ANTES que el cobro con crédito (Payments por id) y no pasa más de lo que la raíz respalda', async () => {
      ;(respaldoVigenteDeLaRaiz as jest.Mock).mockResolvedValue(0)
      conCredito()

      await expect(pasarASaldo(20000)).rejects.toMatchObject({ statusCode: 422, code: 'STORE_CREDIT_ROOT_ALREADY_REFUNDED' })

      expect(respaldoVigenteDeLaRaiz).toHaveBeenCalledWith(txDeLaTransaccion, ROOT, VENUE)
      // Las Orders (la del crédito y su ascendencia) primero; luego la raíz; luego el cobro con crédito.
      expect(orden(consultasDelCandado[0])).toBeLessThan(orden(respaldoVigenteDeLaRaiz as jest.Mock))
      expect(orden(respaldoVigenteDeLaRaiz as jest.Mock)).toBeLessThan(orden(prismaMock.$queryRaw))
      expect(abonar).not.toHaveBeenCalled()
      expect(prismaMock.payment.create).not.toHaveBeenCalled()
      expect(prismaMock.shift.updateMany).not.toHaveBeenCalled()
    })

    it('con respaldo suficiente, la fila apunta a la raíz y su origen fiscal es el método de la raíz', async () => {
      ;(respaldoVigenteDeLaRaiz as jest.Mock).mockResolvedValue(30000)
      conCredito()

      await pasarASaldo(20000)

      expect(filaCreada()).toMatchObject({ method: 'OTHER', tenderTypeId: SC_TENDER, tenderSatFormaPago: '17' })
      expect(filaCreada().merchantAccountId).toBeUndefined()
      expect(filaCreada().processorData).toMatchObject({
        originalPaymentId: CREDIT,
        rootPaymentId: ROOT,
        originalMethod: 'CREDIT_CARD',
        exchange: { exchangeId: EXCHANGE, role: 'CHAIN', rootPaymentId: ROOT },
      })
      expect(abonar).toHaveBeenCalledTimes(1)
    })

    it('un centavo más que el respaldo se rechaza', async () => {
      ;(respaldoVigenteDeLaRaiz as jest.Mock).mockResolvedValue(20000)
      conCredito()
      await expect(pasarASaldo(20001)).rejects.toMatchObject({ code: 'STORE_CREDIT_ROOT_ALREADY_REFUNDED' })
      expect(abonar).not.toHaveBeenCalled()
    })
  })
})

describe('writeRefundInTx con aSaldoAFavor', () => {
  const bloqueado = (o: Partial<CobroBloqueado['original']> = {}): CobroBloqueado => ({
    original: { ...(cobroEnEfectivo() as any), tenderSystemKind: null, ...o },
    existingRefunds: [],
    alreadyRefundedCents: 0,
    refundedSalesCents: 0,
    refundedTipsCents: 0,
    unclassifiedPriorRefundCents: 0,
    reservedByCardRefundsCents: 0,
    remainingBeforeCents: 50000,
  })
  const abonar = jest.fn(async () => abonoHecho(100))
  const entrada = (extra: Partial<WriteRefundInput> = {}, cobro = bloqueado()): WriteRefundInput =>
    ({
      originalPaymentId: cobro.original.id,
      venueId: VENUE,
      salesRefundCents: 10000,
      tipRefundCents: 0,
      refundedItems: [],
      reason: 'RETURNED_GOODS',
      staffId: STAFF,
      tenderCommission: 'NONE',
      shift: 'CLAIM_LIVE',
      provenance: 'MANUAL',
      bloqueado: cobro,
      aSaldoAFavor: { tender: semanticaDeSaldo, customerId: CUSTOMER, abonar },
      ...extra,
    }) as WriteRefundInput

  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.shift.findFirst.mockResolvedValue({ id: SHIFT, status: 'OPEN' } as never)
    prismaMock.shift.updateMany.mockResolvedValue({ count: 1 } as never)
    prismaMock.payment.create.mockResolvedValue({ id: REFUND } as never)
    prismaMock.payment.update.mockResolvedValue({ id: ORIGINAL } as never)
    ;(prepararSobreDeSaldoAFavorEnTx as jest.Mock).mockImplementation(async () => preparado())
  })

  it.each([
    ['moneyAs', { moneyAs: semanticaDeSaldo }],
    ['devolverCon', { devolverCon: 'BANK_TRANSFER' as const }],
  ])('es excluyente con %s', async (_n, extra) => {
    await expect(writeRefundInTx(tx as unknown as TxConReintento, entrada(extra))).rejects.toMatchObject({
      statusCode: 400,
      code: 'STORE_CREDIT_REFUND_METHOD_CONFLICT',
    })
    expect(prepararSobreDeSaldoAFavorEnTx).not.toHaveBeenCalled()
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
    expect(prismaMock.shift.updateMany).not.toHaveBeenCalled()
  })

  it('lo pagado con saldo de regalo sólo regresa a su saldo', async () => {
    const conSaldo = bloqueado({ method: 'OTHER', fundsFlow: 'EXTERNAL_RECORDED', tenderSystemKind: 'GIFT_CARD' })
    await expect(writeRefundInTx(tx as unknown as TxConReintento, entrada({}, conSaldo))).rejects.toMatchObject({
      code: 'GIFT_CARD_REFUND_TO_BALANCE_ONLY',
    })
    expect(prepararSobreDeSaldoAFavorEnTx).not.toHaveBeenCalled()
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('un crédito de cambio sin raíz no se manda a saldo (perdería su origen fiscal)', async () => {
    const credito = bloqueado({ method: 'OTHER', fundsFlow: 'EXTERNAL_RECORDED', tenderSystemKind: 'EXCHANGE_CREDIT' })
    await expect(writeRefundInTx(tx as unknown as TxConReintento, entrada({}, credito))).rejects.toMatchObject({ statusCode: 400 })
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('regresa el abono junto con la fila', async () => {
    const r = await writeRefundInTx(tx as unknown as TxConReintento, entrada())
    expect(r).toEqual({ refundPaymentId: REFUND, replay: false, abono: abonoHecho(100) })
    expect(abonar).toHaveBeenCalledWith(tx, REFUND, preparado(), { orderId: ORDER, montoCents: 10000 })
  })
})

describe('resolveChainRefund con destino STORE_CREDIT', () => {
  const raiz = (o: Partial<ChainRefundRoot> & Record<string, unknown> = {}) =>
    ({
      id: ROOT,
      venueId: VENUE,
      method: 'CREDIT_CARD',
      source: 'TPV',
      fundsFlow: 'AVOQADO_PROCESSED',
      merchantAccountId: MERCHANT,
      ecommerceMerchantId: null,
      tenderTypeId: null,
      tenderRevision: null,
      tenderLabel: null,
      tenderCountsAsCash: null,
      tenderCaptureTip: null,
      tenderSatFormaPago: null,
      tenderType: null,
      ...o,
    }) as unknown as ChainRefundRoot
  const link = { exchangeId: EXCHANGE }

  it('crédito de cambio con raíz en tarjeta bancaria acepta STORE_CREDIT; con raíz en tarjeta de regalo sigue bloqueado', () => {
    // Hoy (sin destino) la raíz en tarjeta se devuelve en la terminal: bloqueado.
    expect(resolveChainRefund(link, raiz())).toMatchObject({ kind: 'BLOCKED', error: { code: 'EXCHANGE_CHAIN_NEEDS_TERMINAL' } })
    expect(resolveChainRefund(link, raiz(), 'STORE_CREDIT')).toMatchObject({ kind: 'INHERIT', rootPaymentId: ROOT, exchangeId: EXCHANGE })
    // Efectivo y transferencia también.
    expect(
      resolveChainRefund(link, raiz({ method: 'CASH', fundsFlow: 'CASH_DRAWER', merchantAccountId: null }), 'STORE_CREDIT'),
    ).toMatchObject({
      kind: 'INHERIT',
    })
    const deRegalo = raiz({
      method: 'OTHER',
      fundsFlow: 'EXTERNAL_RECORDED',
      merchantAccountId: null,
      tenderType: { systemKind: 'GIFT_CARD' },
    })
    expect(resolveChainRefund(link, deRegalo, 'STORE_CREDIT')).toMatchObject({
      kind: 'BLOCKED',
      error: { code: 'EXCHANGE_CHAIN_GIFT_CARD_PENDING' },
    })
  })
})

describe('respaldoVigenteDeLaRaiz', () => {
  const { respaldoVigenteDeLaRaiz: real } = jest.requireActual('@/services/storeCredit/respaldoDeLaRaiz')
  beforeEach(() => prismaMock.$queryRaw.mockReset())

  it('aparta la raíz y resta sólo lo que salió de ella de verdad, sin el gemelo del crédito', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ cobradoCents: 50000n }]).mockResolvedValueOnce([{ devueltoCents: 30000n }])

    await expect(real(tx, ROOT, VENUE)).resolves.toBe(20000)

    const candado = consulta(prismaMock.$queryRaw.mock.calls[0])
    expect(candado.sql).toMatch(/FROM "Payment"[\s\S]*FOR UPDATE/)
    expect(candado.valores).toEqual(expect.arrayContaining([ROOT, VENUE]))
    const suma = consulta(prismaMock.$queryRaw.mock.calls[1])
    // Sus devoluciones por ORIGEN económico (la raíz de la cadena o el cobro devuelto), completadas, sin el papel CREDIT.
    expect(suma.sql).toContain(`COALESCE(r."processorData"->>'rootPaymentId', r."processorData"->>'originalPaymentId')`)
    expect(suma.sql).toContain(`r.status = 'COMPLETED'`)
    expect(suma.sql).toContain(`r."processorData"->'exchange'->>'role' IS DISTINCT FROM ?`)
    expect(suma.sql).not.toContain('refundedAmount')
    expect(suma.valores).toEqual(expect.arrayContaining([ROOT, VENUE, 'CREDIT']))
  })

  it('sin raíz en este negocio no adivina', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([])
    await expect(real(tx, ROOT, VENUE)).rejects.toMatchObject({ statusCode: 409 })
  })
})

describe('el costo del procesador de una devolución a saldo', () => {
  it('no se crea al momento: createRefundTransactionCost no copia el costo del cobro', async () => {
    prismaMock.transactionCost.findUnique.mockResolvedValueOnce({
      amount: new Decimal(500),
      providerCostAmount: new Decimal(10),
      providerFixedFee: new Decimal(1),
      venueChargeAmount: new Decimal(15),
      venueFixedFee: new Decimal(2),
      profitMargin: new Decimal(0.3),
      merchantAccountId: MERCHANT,
      transactionType: 'CREDIT',
    } as never)
    prismaMock.payment.findUnique.mockResolvedValueOnce({
      id: REFUND,
      amount: new Decimal(-200),
      tipAmount: new Decimal(0),
      tenderType: { systemKind: 'STORE_CREDIT' },
    } as never)

    await expect(createRefundTransactionCost(REFUND, ORIGINAL)).resolves.toBeNull()
    expect(prismaMock.transactionCost.create).not.toHaveBeenCalled()
  })

  it('ni cuando converge la obligación del cobro: la cuenta de reembolsos pendientes deja fuera el medio STORE_CREDIT', async () => {
    prismaMock.$transaction.mockImplementationOnce((async (cb: any) => cb(prismaMock)) as never)
    prismaMock.$queryRaw.mockReset()
    prismaMock.$queryRaw.mockResolvedValueOnce([]) // el cobro ya no está: NO_APLICA (sólo nos interesa la consulta)
    await convergerCostoDeTransaccion(ORIGINAL)
    const { sql } = consulta(prismaMock.$queryRaw.mock.calls[0])
    expect(sql).toMatch(/"systemKind" = 'EXCHANGE_CREDIT'/)
    expect(sql).toMatch(/"systemKind" = 'STORE_CREDIT'/)
  })
})
