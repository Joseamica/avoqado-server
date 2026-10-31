/**
 * La devolución a saldo a favor contra Postgres REAL (spec 2026-10-30-saldo-a-favor §5.3–§5.4, tarea S3). Lo que un mock no prueba:
 * - el abono va en la MISMA transacción que la devolución: si lanza, no queda ni la fila, ni el acumulado del cobro, ni el turno;
 * - el orden de candados (cobro → clienta + sobre → turno): un reembolso a saldo y un cobro con saldo del mismo sobre a la vez
 *   terminan los dos, sin interbloqueo;
 * - la cadena de un Cambio REAL con raíz en tarjeta: el crédito sí se pasa a saldo, pero nunca más de lo que la raíz todavía respalda
 *   (la terminal pudo devolver la compra original después del Cambio);
 * - el costo del procesador: una devolución a saldo nunca crea costo negativo, ni al momento ni al converger la obligación del cobro;
 * - el estado de resultados: con el comercio fuera de la contabilidad, su venta devuelta a saldo no resta.
 *
 * Correr (en la nube, con su propia base; el veredicto está en el CUERPO, no en el exit):
 *   cd /Users/amieva/Documents/Programming/Avoqado && AVQ_TREE=$HOME/.claude/worktrees/saldo-a-favor/avoqado-server \
 *     ./scripts/avq-verify.sh avoqado-server npx jest --selectProjects integration --testPathPattern "reembolsoASaldo" --ci
 *
 * La libreta no se puede borrar (trigger): los sobres se quedan en la base desechable; cada negocio es único.
 */
import { Prisma } from '@prisma/client'
import cuid from 'cuid'
import { formatInTimeZone } from 'date-fns-tz'
import prisma from '@/utils/prismaClient'
import { issueRefund, type AbonarSaldoAFavor } from '@/services/dashboard/refund.dashboard.service'
import { abonarSaldoAFavorEnTx } from '@/services/giftCards/giftCardLedger'
import { decryptGiftCardCode } from '@/services/giftCards/giftCardCode'
import { prepararMediosDeSaldoAFavor } from '@/services/storeCredit/storeCreditTender'
import { createExchange } from '@/services/exchanges/exchange.service'
import { recordRefund } from '@/services/tpv/refund.tpv.service'
import { payGiftCardBalanceOnOrder } from '@/services/mobile/order.mobile.service'
import { convergerCostoDeTransaccion, costearYProyectarReembolso } from '@/services/payments/deferredTransactionCost.service'
import { getIncomeStatement } from '@/services/dashboard/accounting.dashboard.service'
import { seedClothingSale } from '../exchanges/seedExchange'
import { crearCuentaDeMercancia, esperarAQueAlguienEspereA, pidDe } from '../giftCards/sembrarTarjetasDeRegalo'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { broadcastToUser: jest.fn(), getBroadcastingService: jest.fn(() => null) },
}))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn(async () => undefined) }))
jest.setTimeout(90000)

type Seed = Awaited<ReturnType<typeof seedClothingSale>>
const fixtures: Seed[] = []
const D = (v: number | string) => new Prisma.Decimal(v)
let n = 0

/** Una venta de ropa de $500 (efectivo o tarjeta procesada por Avoqado), su clienta con teléfono y los medios de saldo a favor. */
async function seed(opts: Parameters<typeof seedClothingSale>[0] = {}, conTelefono = true) {
  const s = await seedClothingSale(opts)
  fixtures.push(s)
  if (conTelefono)
    await prisma.customer.update({
      where: { id: s.customer.id },
      data: { phone: `55${String(10_000_000 + ((process.pid * 97 + ++n * 7919 + Date.now()) % 89_999_999)).padStart(8, '0')}` },
    })
  // Con el cliente global y FUERA de la transacción de dinero, como el Reembolso del POS (S4).
  await prepararMediosDeSaldoAFavor(s.venueId)
  return s
}

const abonarSaldo =
  (staffId: string): AbonarSaldoAFavor =>
  (tx, refundPaymentId, preparado, fila) =>
    abonarSaldoAFavorEnTx(tx, {
      preparado,
      monto: D(fila.montoCents).div(100),
      staffId,
      origen: { orderId: fila.orderId, refundPaymentId },
      folio: refundPaymentId.slice(-6),
      tipo: 'REEMBOLSO',
    })
const aSaldo = (s: Seed, paymentId: string, amount: number) =>
  issueRefund({
    venueId: s.venueId,
    staffId: s.staffId,
    paymentId,
    amount,
    reason: 'RETURNED_GOODS',
    aSaldoAFavor: { customerId: s.customer.id, abonar: abonarSaldo(s.staffId) },
  })
const sobreDe = (s: Seed) =>
  prisma.giftCard.findFirst({ where: { venueId: s.venueId, customerId: s.customer.id }, orderBy: { createdAt: 'asc' } })

let ref = 0
/** La terminal ya devolvió a la tarjeta y AVISA (`recordRefund`), como en `exchangeTerminalRefund.integration.test.ts`. */
const devolucionDeLaTerminal = (s: Seed, cents: number) =>
  recordRefund(
    s.venueId,
    {
      venueId: s.venueId,
      originalPaymentId: s.payments[0].id,
      originalOrderId: s.order.id,
      amount: cents,
      reason: 'CUSTOMER_REQUEST',
      merchantAccountId: s.payments[0].merchantAccountId,
      authorizationNumber: `AUT${++ref}`,
      referenceNumber: `REF${ref}`,
      isPartialRefund: cents < 50000,
      currency: 'MXN',
      processor: 'angelpay',
      idempotencyKey: `${s.venueId}-devolucion-${ref}`,
    } as Parameters<typeof recordRefund>[1],
    s.staffId,
  )

afterAll(async () => {
  for (const s of fixtures) {
    await prisma.transactionCost.deleteMany({ where: { payment: { venueId: s.venueId } } })
    await prisma.merchantFiscalConfig.deleteMany({ where: { fiscalEmisor: { venueId: s.venueId } } })
    await prisma.fiscalEmisor.deleteMany({ where: { venueId: s.venueId } })
    await s.cleanup()
  }
  await prisma.$disconnect()
})

describe('la devolución a saldo a favor · Postgres real', () => {
  it('una venta en efectivo devuelta a saldo: la fila lleva el medio STORE_CREDIT y el origen CASH, el sobre recibe $200 y el cajón no se mueve', async () => {
    const s = await seed()
    const r = await aSaldo(s, s.payments[0].id, 20000)

    expect(r).toMatchObject({ amount: 200, remainingRefundable: 300 })
    expect(r.abono!.abonado.toFixed(2)).toBe('200.00')
    const fila = await prisma.payment.findUniqueOrThrow({ where: { id: r.refundId }, include: { tenderType: true } })
    expect(fila).toMatchObject({ method: 'OTHER', fundsFlow: 'EXTERNAL_RECORDED', merchantAccountId: null, tenderSatFormaPago: '17' })
    expect(fila.tenderType?.systemKind).toBe('STORE_CREDIT')
    expect(fila.processorData).toMatchObject({ originalPaymentId: s.payments[0].id, originalMethod: 'CASH' })
    expect((await sobreDe(s))!.balance.toFixed(2)).toBe('200.00')
    expect(await prisma.cashDrawerEvent.count({ where: { venueId: s.venueId } })).toBe(0)
  })

  it('si abonar lanza (sin teléfono), no queda devolución, ni acumulado reembolsado, ni movimiento de turno', async () => {
    const s = await seed({}, false)
    const cobroAntes = await prisma.payment.findUniqueOrThrow({ where: { id: s.payments[0].id } })
    const turnoAntes = await prisma.shift.findUniqueOrThrow({ where: { id: s.shift.id } })

    await expect(aSaldo(s, s.payments[0].id, 20000)).rejects.toMatchObject({
      code: 'STORE_CREDIT_CUSTOMER_PHONE_REQUIRED',
      statusCode: 400,
    })

    expect(await prisma.payment.count({ where: { venueId: s.venueId, type: 'REFUND' } })).toBe(0)
    expect(await prisma.venueTransaction.count({ where: { venueId: s.venueId, type: 'REFUND' } })).toBe(0)
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: s.payments[0].id } })).processorData).toEqual(cobroAntes.processorData)
    const turno = await prisma.shift.findUniqueOrThrow({ where: { id: s.shift.id } })
    expect(turno.totalSales.toFixed(2)).toBe(turnoAntes.totalSales.toFixed(2))
    expect(await sobreDe(s)).toBeNull()
  })

  it('🔴 un reembolso a saldo y un cobro con saldo del mismo sobre a la vez terminan los dos, sin interbloqueo', async () => {
    const s = await seed()
    await aSaldo(s, s.payments[0].id, 10000) // la clienta ya tiene su sobre con $100
    const sobre = (await sobreDe(s))!
    const codigo = decryptGiftCardCode(sobre.codeEnc!)
    const { orderId: cuentaNueva } = await crearCuentaDeMercancia({ venueId: s.venueId, staffId: s.staffId, total: 50 })

    // Una tercera sesión sostiene el TURNO: el reembolso llega a él con el sobre ya apartado; el cobro con saldo espera el sobre.
    // Si el reembolso apartara el turno ANTES que el sobre, al soltar se abrazarían (40P01) y uno de los dos fallaría.
    let soltar!: () => void
    const suelta = new Promise<void>(resolve => (soltar = resolve))
    let avisar!: (pid: number) => void
    const pidDelTurno = new Promise<number>(resolve => (avisar = resolve))
    const turno = prisma.$transaction(
      async tx => {
        await tx.$queryRaw`SELECT id FROM "Shift" WHERE id = ${s.shift.id} FOR UPDATE`
        avisar(await pidDe(tx))
        await suelta
      },
      { timeout: 30_000, maxWait: 5_000 },
    )
    const pid = await pidDelTurno
    const reembolso = aSaldo(s, s.payments[0].id, 10000)
    await esperarAQueAlguienEspereA(pid) // el reembolso ya espera el turno
    const cobro = payGiftCardBalanceOnOrder(s.venueId, cuentaNueva, {
      idempotencyKey: `saldo-${s.venueId.slice(-12)}-cobro`,
      proof: { kind: 'CODE' as const, code: codigo },
      amount: D(50),
      tip: D(0),
      staffId: s.staffId,
      deviceId: null,
    })
    // El cobro con saldo llega al sobre, que tiene el reembolso (espera a OTRA sesión que no es la del turno).
    for (let i = 0; i < 200; i++) {
      const [fila] = await prisma.$queryRaw<Array<{ pid: number }>>`
        SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0 AND NOT (${pid}::int = ANY(pg_blocking_pids(pid)))
        LIMIT 1`
      if (fila) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    soltar()

    const [r, c] = await Promise.allSettled([reembolso, cobro])
    await turno
    expect(r).toMatchObject({ status: 'fulfilled' })
    expect(c).toMatchObject({ status: 'fulfilled' })
    // $100 + $100 del segundo reembolso − $50 del cobro.
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: sobre.id } })).balance.toFixed(2)).toBe('150.00')
  })

  describe('desde el crédito de un Cambio REAL con raíz en tarjeta', () => {
    it('compra con tarjeta $500 procesada por Avoqado → Cambio parejo REAL (con su gemelo CREDIT y su refundedAmount) → Reembolso de $200 del crédito a saldo SÍ se abona', async () => {
      const s = await seed({ card: true })
      const { exchange } = await createExchange(s.input())
      const creditId = exchange.paymentIds[0]
      // El gemelo del crédito ya subió el acumulado de la raíz a $500: no es dinero que haya salido.
      const raiz = await prisma.payment.findUniqueOrThrow({ where: { id: s.payments[0].id } })
      expect((raiz.processorData as { refundedAmountCents?: number }).refundedAmountCents ?? 0).toBeGreaterThanOrEqual(50000)

      const r = await aSaldo(s, creditId, 20000)

      expect(r.abono!.abonado.toFixed(2)).toBe('200.00')
      const fila = await prisma.payment.findUniqueOrThrow({ where: { id: r.refundId } })
      expect(fila).toMatchObject({ method: 'OTHER', merchantAccountId: null, tenderSatFormaPago: '17' })
      expect(fila.processorData).toMatchObject({
        originalPaymentId: creditId,
        rootPaymentId: s.payments[0].id,
        originalMethod: 'CREDIT_CARD',
        exchange: { exchangeId: exchange.id, role: 'CHAIN', rootPaymentId: s.payments[0].id },
      })
      expect((await sobreDe(s))!.balance.toFixed(2)).toBe('200.00')
    })

    it('compra con tarjeta $500 → Cambio parejo → la terminal devuelve la compra original → vence la marca de 3 min → el Reembolso del crédito a saldo se rechaza con STORE_CREDIT_ROOT_ALREADY_REFUNDED y no hay abono', async () => {
      const s = await seed({ card: true })
      const { exchange } = await createExchange(s.input())
      await devolucionDeLaTerminal(s, 50000)
      // (La marca de «devolución en terminal en curso» llega con S7; vencida o sin ella, lo que frena es el respaldo de la raíz.)
      const antes = await prisma.payment.count({ where: { venueId: s.venueId, type: 'REFUND' } })

      await expect(aSaldo(s, exchange.paymentIds[0], 20000)).rejects.toMatchObject({
        statusCode: 422,
        code: 'STORE_CREDIT_ROOT_ALREADY_REFUNDED',
        message: 'La compra original ya se devolvió.',
      })
      expect(await prisma.payment.count({ where: { venueId: s.venueId, type: 'REFUND' } })).toBe(antes)
      expect(await sobreDe(s)).toBeNull()
    })

    it('la terminal devolvió $300 de la raíz: del crédito se pueden pasar a saldo $200 y no $201', async () => {
      const s = await seed({ card: true })
      const { exchange } = await createExchange(s.input())
      await devolucionDeLaTerminal(s, 30000)

      await expect(aSaldo(s, exchange.paymentIds[0], 20100)).rejects.toMatchObject({
        code: 'STORE_CREDIT_ROOT_ALREADY_REFUNDED',
        details: { maxCents: 20000 },
      })
      expect(await sobreDe(s)).toBeNull()
      const r = await aSaldo(s, exchange.paymentIds[0], 20000)
      expect(r.abono!.saldoNuevo.toFixed(2)).toBe('200.00')
      // Y ya no queda respaldo: ni un centavo más.
      await expect(aSaldo(s, exchange.paymentIds[0], 1)).rejects.toMatchObject({ code: 'STORE_CREDIT_ROOT_ALREADY_REFUNDED' })
    })
  })

  it('una compra con tarjeta que ya tiene costo del procesador, devuelta a saldo: no aparece costo negativo, ni al momento ni cuando converge la obligación pendiente después, y la proyección financiera no cambia', async () => {
    const s = await seed({ card: true })
    const raiz = s.payments[0]
    await prisma.transactionCost.create({
      data: {
        paymentId: raiz.id,
        merchantAccountId: raiz.merchantAccountId!,
        transactionType: 'CREDIT',
        amount: 500,
        providerRate: 0.02,
        providerCostAmount: 10,
        venueRate: 0.025,
        venueChargeAmount: 12.5,
        venueFixedFee: 0.5,
        grossProfit: 3,
        profitMargin: 0.23,
      },
    })
    // Su fila financiera, ya con su liquidación: así la convergencia llega a recorrer las devoluciones (lo que se prueba aquí).
    await prisma.venueTransaction.create({
      data: {
        venueId: s.venueId,
        paymentId: raiz.id,
        type: 'PAYMENT',
        grossAmount: 500,
        feeAmount: 0,
        netAmount: 500,
        netSettlementAmount: 500,
        estimatedSettlementDate: new Date(),
        settlementConfigId: cuid(),
      },
    })

    const r = await aSaldo(s, raiz.id, 20000)
    // El intento después del commit (el de `issueRefund` va sin esperar; éste es el mismo, idempotente).
    await costearYProyectarReembolso(r.refundId, raiz.id)
    expect(await prisma.transactionCost.count({ where: { paymentId: r.refundId } })).toBe(0)

    // La obligación del cobro converge después y recorre sus devoluciones: tampoco la toma, y no se queda pendiente para siempre.
    await expect(convergerCostoDeTransaccion(raiz.id)).resolves.toBe('CONVERGIO')
    expect(await prisma.transactionCost.count({ where: { paymentId: r.refundId } })).toBe(0)

    const fila = await prisma.payment.findUniqueOrThrow({ where: { id: r.refundId } })
    expect([fila.feeAmount.toFixed(2), fila.netAmount.toFixed(2)]).toEqual(['0.00', '-200.00'])
    const vt = await prisma.venueTransaction.findFirstOrThrow({ where: { paymentId: r.refundId } })
    expect([vt.feeAmount.toFixed(2), vt.netAmount.toFixed(2)]).toEqual(['0.00', '-200.00'])
    expect(
      ((await prisma.payment.findUniqueOrThrow({ where: { id: raiz.id } })).processorData as { costPending?: boolean }).costPending,
    ).not.toBe(true)
  })

  it('comercio con includeInAccounting=false: su venta devuelta a saldo no resta en el estado de resultados', async () => {
    const s = await seed({ card: true })
    const emisor = await prisma.fiscalEmisor.create({
      data: {
        venueId: s.venueId,
        rfc: 'AAA010101AAA',
        legalName: 'Fiscal de prueba',
        regimenFiscal: '601',
        lugarExpedicion: '01000',
        includeCashInAccounting: true,
      },
    })
    await prisma.merchantFiscalConfig.create({
      data: { merchantAccountId: s.payments[0].merchantAccountId!, fiscalEmisorId: emisor.id, includeInAccounting: false },
    })
    await aSaldo(s, s.payments[0].id, 20000)

    const tz = (await prisma.venue.findUniqueOrThrow({ where: { id: s.venueId } })).timezone || 'America/Mexico_City'
    const hoy = formatInTimeZone(new Date(), tz, 'yyyy-MM-dd')
    const r = await getIncomeStatement(s.venueId, { from: hoy, to: hoy })
    expect(r.revenue).toMatchObject({ grossSalesCents: 50000, refundsCents: 20000 })
    expect(r.fiscalRevenue).toMatchObject({ grossSalesCents: 0, refundsCents: 0, netRevenueCents: 0 })
  })
})
