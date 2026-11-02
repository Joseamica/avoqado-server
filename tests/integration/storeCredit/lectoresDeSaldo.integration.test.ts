/**
 * La pasada de lectores del saldo a favor contra Postgres REAL (spec 2026-10-30-saldo-a-favor §5.3, tarea S8b). Lo que un mock no
 * prueba: la SQL de la clasificación por canje (EL predicado del sobre, `REDEEM` por cobro y `REDEEM_REVERSAL` por devolución), el
 * ISR, el resumen de ventas y la lista del contador con datos de verdad, y la paridad de la lista con el autoposteo.
 *
 * El caso (Review Focus 3 del plan): una clienta devuelve $200 de una venta en efectivo a su saldo a favor; luego paga $500 con UN cobro
 * que canjea su sobre de saldo a favor ($200) y una tarjeta de regalo que le regalaron ($300); después devuelve $100 de esa compra.
 *
 * Correr (en la nube, con su propia base; el veredicto está en el CUERPO, no en el exit):
 *   cd /Users/amieva/Documents/Programming/Avoqado && AVQ_TREE=$HOME/.claude/worktrees/saldo-a-favor/avoqado-server \
 *     ./scripts/avq-verify.sh avoqado-server npx jest --selectProjects integration --testPathPattern "lectoresDeSaldo" --ci
 *
 * La libreta no se puede borrar (trigger): los sobres se quedan en la base desechable; el negocio es único.
 */
import { Prisma, type Payment } from '@prisma/client'
import { formatInTimeZone } from 'date-fns-tz'
import prisma from '@/utils/prismaClient'
import { issueRefund, type AbonarSaldoAFavor } from '@/services/dashboard/refund.dashboard.service'
import { abonarSaldoAFavorEnTx } from '@/services/giftCards/giftCardLedger'
import { prepararMediosDeSaldoAFavor } from '@/services/storeCredit/storeCreditTender'
import { montoSaldoAFavorSql, saldoAFavorPorFila } from '@/services/storeCredit/saldoAFavorEnLectores'
import { tarjetasDeRegaloEnFoto } from '@/services/fiscal/tarjetasDeRegaloEnElIsr'
import { recorrerLibros } from '@/services/fiscal/librosDeOrdenes'
import { LIMITES_DEL_REPORTE } from '@/services/dashboard/accounting.dashboard.service'
import { computeGiftCardFigures, getSalesSummary } from '@/services/dashboard/sales-summary.dashboard.service'
import { listPendingAccountingReview } from '@/services/giftCards/giftCardReports.service'
import { WHERE_PAGO_PENDIENTE_DE_REVISION_CONTABLE } from '@/services/giftCards/giftCardMarks'
import { WHERE_PAGO_CONTABILIZABLE, generatePoliciesForVenue } from '@/services/fiscal/autoPosting.service'
import { seedBaseChart } from '@/services/fiscal/chartOfAccounts.service'
import { seedDefaultMappings } from '@/services/fiscal/accountMapping.service'
import { seedClothingSale } from '../exchanges/seedExchange'
import { sembrarCanje, sembrarVentaDeTarjetas } from '../giftCards/sembrarTarjetasDeRegalo'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { broadcastToUser: jest.fn(), getBroadcastingService: jest.fn(() => null) },
}))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn(async () => undefined) }))
jest.mock('@/services/tpv/digitalReceipt.tpv.service', () => ({ generateDigitalReceipt: jest.fn().mockResolvedValue(null) }))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))
jest.setTimeout(120000)

type Seed = Awaited<ReturnType<typeof seedClothingSale>>
const D = (v: number | string) => new Prisma.Decimal(v)
const TZ = 'America/Mexico_City'
const HOY = () => formatInTimeZone(new Date(), TZ, 'yyyy-MM-dd')

let s: Seed
let rfc: string
let sobreDeSaldoId: string
let devolucionASaldoId: string
let pagoMixto: Payment
let devolucionParcialId: string
/** Lo que el reverso de la devolución parcial regresó al sobre de saldo a favor, en centavos (lo decide la libreta). */
let parcialASaldoCents: number

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

beforeAll(async () => {
  s = await seedClothingSale()
  await prisma.venue.update({ where: { id: s.venueId }, data: { timezone: TZ } })
  await prisma.customer.update({
    where: { id: s.customer.id },
    data: { phone: `55${String(10_000_000 + ((process.pid * 97 + Date.now()) % 89_999_999)).padStart(8, '0')}` },
  })
  await prepararMediosDeSaldoAFavor(s.venueId)

  // 1. $200 de la venta en efectivo, a su saldo a favor.
  const aSaldo = await issueRefund({
    venueId: s.venueId,
    staffId: s.staffId,
    paymentId: s.payments[0].id,
    amount: 20000,
    reason: 'RETURNED_GOODS',
    aSaldoAFavor: { customerId: s.customer.id, abonar: abonarSaldo(s.staffId) },
  })
  devolucionASaldoId = aSaldo.refundId
  sobreDeSaldoId = aSaldo.abono!.giftCardId

  // 2. Una tarjeta de regalo VENDIDA de $300 (se la regalaron) y UN cobro de $500 que canjea las dos.
  const regalada = await sembrarVentaDeTarjetas({
    venueId: s.venueId,
    organizationId: s.organizationId,
    staffId: s.staffId,
    montos: [300],
    metodo: 'CASH',
  })
  const canje = await sembrarCanje({
    venueId: s.venueId,
    staffId: s.staffId,
    giftCardIds: [regalada.giftCardIds[0], sobreDeSaldoId],
    total: 500,
    conSaldo: 500,
  })
  pagoMixto = canje.pagoConSaldo

  // 3. Devuelve $100 de esa compra: regresa a los sobres por sus REDEEM_REVERSAL (la libreta decide a cuál).
  devolucionParcialId = (
    await issueRefund({ venueId: s.venueId, paymentId: pagoMixto.id, amount: 10000, reason: 'RETURNED_GOODS', staffId: s.staffId })
  ).refundId
  const aSaldoDelParcial = await prisma.giftCardActivity.aggregate({
    where: { refundPaymentId: devolucionParcialId, type: 'REDEEM_REVERSAL', giftCardId: sobreDeSaldoId },
    _sum: { amount: true },
  })
  parcialASaldoCents = Math.round(Number(aSaldoDelParcial._sum.amount ?? 0) * 100)

  // Contabilidad para la paridad con el autoposteo (RFC único por corrida: el folio de pólizas es por contribuyente).
  rfc = `SAF${Date.now().toString(36).toUpperCase().slice(-6)}XX0`
  await prisma.venue.update({ where: { id: s.venueId }, data: { rfc } })
  await seedBaseChart(s.venueId, { staffId: s.staffId })
  await seedDefaultMappings(s.venueId, { staffId: s.staffId })
})

/** S10 r2 (familia B): un negocio aparte, para que sus cobros no se mezclen con el caso de arriba. */
let s2: Seed | undefined

afterAll(async () => {
  if (s2) {
    await prisma.transactionCost.deleteMany({ where: { payment: { venueId: s2.venueId } } })
    await s2.cleanup().catch(error => console.warn('lectoresDeSaldo: la limpieza del segundo negocio no terminó', String(error)))
  }
  if (s) {
    await prisma.journalEntry.deleteMany({ where: { organizationId: s.organizationId, rfc } }).catch(() => undefined)
    await prisma.accountMapping.deleteMany({ where: { organizationId: s.organizationId, rfc } }).catch(() => undefined)
    await prisma.ledgerAccount.deleteMany({ where: { organizationId: s.organizationId, rfc } }).catch(() => undefined)
    await prisma.transactionCost.deleteMany({ where: { payment: { venueId: s.venueId } } })
    await s.cleanup()
  }
  await prisma.$disconnect()
})

describe('S8b · los lectores del saldo a favor · Postgres real', () => {
  it('🔴 la clasificación por canje: el cobro por sus REDEEM, la devolución por sus REDEEM_REVERSAL; el abono a saldo no cuenta', async () => {
    const mapa = await saldoAFavorPorFila(prisma, [
      { id: pagoMixto.id, type: 'REGULAR' },
      { id: devolucionParcialId, type: 'REFUND' },
      { id: devolucionASaldoId, type: 'REFUND' },
    ])
    expect(mapa.get(pagoMixto.id)).toBe(20000)
    expect(mapa.get(devolucionParcialId) ?? 0).toBe(parcialASaldoCents)
    // La devolución A saldo no canjeó ni revirtió nada: su ACTIVATE (el abono) no es un REDEEM_REVERSAL.
    expect(mapa.has(devolucionASaldoId)).toBe(false)

    const porSql = await prisma.$queryRaw<Array<{ id: string; monto: string }>>(Prisma.sql`
      SELECT p.id, ${montoSaldoAFavorSql('p')}::text AS monto FROM "Payment" p
      WHERE p.id IN (${Prisma.join([pagoMixto.id, devolucionParcialId, devolucionASaldoId])})`)
    const monto = new Map(porSql.map(r => [r.id, Math.round(Number(r.monto) * 100)]))
    expect(monto.get(pagoMixto.id)).toBe(20000)
    expect(monto.get(devolucionParcialId)).toBe(parcialASaldoCents)
    expect(monto.get(devolucionASaldoId)).toBe(0)
  })

  it('🔴 ISR: del cobro mixto sólo los $300 de la tarjeta vendida van al aviso; la devolución parcial resta por sus REDEEM_REVERSAL', async () => {
    const venue = { id: s.venueId, timezone: TZ }
    const r = await prisma.$transaction(tx => tarjetasDeRegaloEnFoto(tx, venue, { from: HOY(), to: HOY() }, LIMITES_DEL_REPORTE))
    // Lo esperado, del mismo libro: cada movimiento sin su parte de saldo a favor.
    const net = new Map<string, number>()
    await prisma.$transaction(tx =>
      recorrerLibros(tx, { venueId: s.venueId, orderIds: [pagoMixto.orderId!], hasta: new Date(Date.now() + 60_000) }, (m, parte) => {
        net.set(m.id, parte.netCents)
      }),
    )
    // Se redondea la MAGNITUD (una venta y su devolución completa se cancelan exacto).
    const sinSaldo = (id: string, canjeadoCents: number, saldoCents: number) => {
      const n = net.get(id)!
      return n - Math.sign(n) * Math.round(Math.abs(n) * (saldoCents / canjeadoCents))
    }
    expect(r.cargasCents).toBe(0)
    expect(r.pagadoConSaldoSinIvaCents).toBe(
      sinSaldo(pagoMixto.id, 50000, 20000) + sinSaldo(devolucionParcialId, 10000, parcialASaldoCents),
    )
  })

  it('🔴 resumen de ventas: «pagado con saldo» sólo de tarjetas vendidas; las patas del saldo a favor van como venta (OTHER) y fuera del dinero', async () => {
    const inicio = new Date(Date.now() - 86_400_000)
    const fin = new Date(Date.now() + 86_400_000)
    const f = await computeGiftCardFigures(s.venueId, inicio, fin)
    // S10 r3: POR PATA. El cobro mixto ($300 de tarjeta, $200 de saldo a favor) cuenta en GIFT_CARD Y en OTHER; la devolución a saldo
    // cuenta en OTHER; la devolución parcial cuenta en OTHER si algo regresó al sobre de saldo (los reversos de tarjeta van aparte).
    const parcialEnOtro = parcialASaldoCents > 0 ? 1 : 0
    expect(f).toMatchObject({
      balancePaid: 300,
      balanceCount: 1,
      balanceTips: 0,
      balanceReversals: (10000 - parcialASaldoCents) / 100,
      // −$200 de la devolución a saldo, +$200 del canje, − lo que regresó al sobre en la devolución parcial.
      storeCreditNet: -parcialASaldoCents / 100,
      storeCreditCount: 2 + parcialEnOtro,
    })

    const r = await getSalesSummary(s.venueId, {
      startDate: inicio.toISOString(),
      endDate: fin.toISOString(),
      groupBy: 'paymentMethod',
      timezone: TZ,
    })
    expect(r.summary.paidWithGiftCardBalance).toBe(300 - (10000 - parcialASaldoCents) / 100)
    // Dinero: ninguna pata del saldo a favor movió caja ni banco (antes salía un «Otro» con −$200 devueltos).
    expect(r.byPaymentMethodDetailed?.find(b => b.bucket === 'OTHER')).toBeUndefined()
    expect(r.byPaymentMethod?.find(m => m.method === 'OTHER')).toBeUndefined()
    // Ventas: las dos patas con su método, para que la barra cuadre con las ventas del periodo.
    const otro = r.salesByPaymentMethod?.find(m => m.method === 'OTHER')
    expect(otro).toMatchObject({ amount: -parcialASaldoCents / 100, count: 2 + parcialEnOtro })
    expect(r.salesByPaymentMethod?.find(m => m.method === 'GIFT_CARD')).toMatchObject({
      amount: r.summary.paidWithGiftCardBalance,
      count: 1,
    })
    // S10 r3: la suma de los conteos de la barra es de PATAS, no de cobros: la venta en efectivo (1), el cobro mixto en sus dos medios
    // (2), la devolución a saldo (1) y, si algo regresó al sobre de saldo, la parcial (1). El total de COBROS es `transactionCount`.
    expect(r.salesByPaymentMethod?.reduce((n, m) => n + m.count, 0)).toBe(4 + parcialEnOtro)
  })

  it('🔴 lista del contador: la devolución a saldo es un reverso de saldo, y la lista y el autoposteo dicen lo mismo', async () => {
    const lista = await listPendingAccountingReview(s.venueId, { from: HOY(), to: HOY() })
    const clase = new Map(lista.items.map(i => [i.paymentId, i.kind]))
    expect(clase.get(devolucionASaldoId)).toBe('REVERSO_DE_SALDO')
    expect(clase.get(pagoMixto.id)).toBe('COBRO_CON_SALDO')
    expect(clase.get(devolucionParcialId)).toBe('REVERSO_DE_SALDO')
    expect(lista.totals.REVERSO_DE_SALDO).toEqual({ count: 2, amount: -300, tipAmount: 0 })
    expect(lista.totals.CANCELACION_DE_VENTA.count).toBe(0)

    const r = await generatePoliciesForVenue(s.venueId, { actorStaffId: s.staffId })
    const conLaMarca = await prisma.payment.count({
      where: { venueId: s.venueId, AND: [WHERE_PAGO_CONTABILIZABLE, WHERE_PAGO_PENDIENTE_DE_REVISION_CONTABLE] },
    })
    expect(r.pendientesDeRevision).toBe(conLaMarca)
    // La venta de la tarjeta, el canje, la devolución parcial y la devolución a saldo.
    expect(conLaMarca).toBe(4)
  })
})

describe('🔴 S10 r2 (familia B, Codex r2 P2-b): el saldo a favor es la parte MENOR de un cobro y no hubo abono en el periodo', () => {
  it('ayer se abonaron $200; hoy UN cobro de $500 mezcla $300 de una tarjeta vendida y esos $200: la barra de ventas suma los $500', async () => {
    s2 = await seedClothingSale()
    await prisma.venue.update({ where: { id: s2.venueId }, data: { timezone: TZ } })
    await prisma.customer.update({
      where: { id: s2.customer.id },
      data: { phone: `55${String(10_000_000 + ((process.pid * 89 + Date.now()) % 89_999_999)).padStart(8, '0')}` },
    })
    await prepararMediosDeSaldoAFavor(s2.venueId)
    const aSaldo = await issueRefund({
      venueId: s2.venueId,
      staffId: s2.staffId,
      paymentId: s2.payments[0].id,
      amount: 20000,
      reason: 'RETURNED_GOODS',
      aSaldoAFavor: { customerId: s2.customer.id, abonar: abonarSaldo(s2.staffId) },
    })
    // «Ayer»: la venta original y su devolución a saldo quedan fuera del periodo (hoy no hay ningún abono a saldo).
    const ayer = new Date(Date.now() - 2 * 86_400_000)
    await prisma.payment.updateMany({ where: { id: { in: [s2.payments[0].id, aSaldo.refundId] } }, data: { createdAt: ayer } })
    const regalada = await sembrarVentaDeTarjetas({
      venueId: s2.venueId,
      organizationId: s2.organizationId,
      staffId: s2.staffId,
      montos: [300],
      metodo: 'CASH',
    })
    await sembrarCanje({
      venueId: s2.venueId,
      staffId: s2.staffId,
      giftCardIds: [regalada.giftCardIds[0], aSaldo.abono!.giftCardId],
      total: 500,
      conSaldo: 500,
    })

    const inicio = new Date(Date.now() - 3_600_000)
    const fin = new Date(Date.now() + 3_600_000)
    // Por pata (S10 r3): el cobro cuenta en la tarjeta vendida y en el saldo a favor; cada importe con el suyo.
    expect(await computeGiftCardFigures(s2.venueId, inicio, fin)).toMatchObject({
      balancePaid: 300,
      balanceCount: 1,
      storeCreditNet: 200,
      storeCreditCount: 1,
    })
    const r = await getSalesSummary(s2.venueId, {
      startDate: inicio.toISOString(),
      endDate: fin.toISOString(),
      groupBy: 'paymentMethod',
      timezone: TZ,
    })
    // Los $200 salen en OTHER con su pata; el cobro cuenta en los dos medios (la suma de conteos es de patas: 2 para 1 cobro).
    expect(r.salesByPaymentMethod?.find(m => m.method === 'GIFT_CARD')).toMatchObject({ amount: 300, count: 1 })
    expect(r.salesByPaymentMethod?.find(m => m.method === 'OTHER')).toMatchObject({ amount: 200, count: 1 })
    expect(r.salesByPaymentMethod?.reduce((suma, m) => suma + m.amount, 0)).toBe(500)
    expect(r.salesByPaymentMethod?.reduce((patas, m) => patas + m.count, 0)).toBe(2)
    // El total de COBROS no suma conteos por método: es su propia cuenta (sin la venta de la tarjeta, como las ventas brutas).
    expect(r.summary.transactionCount).toBe(1)
  })
})
