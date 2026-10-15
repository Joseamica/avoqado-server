/**
 * Tarea B4, contra Postgres REAL (base desechable): la contabilidad de la fase 1 con las tres clases de cobro de un negocio.
 *  - la VENTA de una tarjeta ($500 con tarjeta, cuenta de tarjetas): no es ingreso (es un pasivo) ni lleva póliza;
 *  - el CANJE ($116 pagados con saldo, cuenta de mercancía): sí es ingreso en el estado de resultados (se vendió la mercancía), pero el
 *    motor no le inventa la póliza de «venta con entrada a banco»: queda «pendiente de revisión contable»;
 *  - una venta normal ($200 con tarjeta): igual que siempre.
 * Y la marca de B1 (`WHERE_PAGO_PENDIENTE_DE_REVISION_CONTABLE`, la que leerá el listado del contador) encuentra exactamente los cobros
 * que el motor saltó.
 *
 * Correr: source ../urls-tarjetas.sh && TZ=UTC npx jest --selectProjects integration \
 *   --runTestsByPath tests/integration/giftCards/contabilidadDeTarjetas.integration.test.ts --ci --runInBand
 */
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))

import { Prisma } from '@prisma/client'
import { formatInTimeZone } from 'date-fns-tz'
import prisma from '@/utils/prismaClient'
import { ensureGiftCardTender } from '@/services/giftCards/giftCardTender'
import { WHERE_PAGO_PENDIENTE_DE_REVISION_CONTABLE } from '@/services/giftCards/giftCardMarks'
import { WHERE_PAGO_CONTABILIZABLE, generatePoliciesForVenue, isEligible } from '@/services/fiscal/autoPosting.service'
import { seedBaseChart } from '@/services/fiscal/chartOfAccounts.service'
import { seedDefaultMappings } from '@/services/fiscal/accountMapping.service'
import { sqlDeOrdenesDelPeriodo } from '@/services/fiscal/librosDeOrdenes'
import { getBankAndCashSummary, getBusinessSummary, getIncomeStatement } from '@/services/dashboard/accounting.dashboard.service'
import { getIsrProvisional } from '@/services/fiscal/isr.service'
import { getIvaCashflow } from '@/services/fiscal/ivaFlujo.service'
import {
  crearCuentaDeMercancia,
  crearNegocioDePrueba,
  limpiarEfectosDePagoDelNegocio,
  sembrarCanje,
  sembrarVentaDeTarjetas,
} from './sembrarTarjetasDeRegalo'

jest.setTimeout(120000)

const D = (v: number) => new Prisma.Decimal(v)
const DIA = 86_400_000
const ymd = (d: Date) => d.toISOString().slice(0, 10)
/** El mes de hoy en la zona del negocio (la de fábrica de `Venue.timezone`): el periodo del ISR y del IVA en flujo. */
const MES = () => formatInTimeZone(new Date(), 'America/Mexico_City', 'yyyy-MM')
const RANGO = () => ({ from: ymd(new Date(Date.now() - DIA)), to: ymd(new Date(Date.now() + DIA)) })

let organizationId: string
let venueId: string
let staffId: string
let rfc: string
let venta: { orderId: string; pagoId: string }
let canje: { orderId: string; pagoId: string }
let normal: { orderId: string; pagoId: string }

beforeAll(async () => {
  ;({ organizationId, venueId, staffId } = await crearNegocioDePrueba('contabilidad'))
  // RFC único por corrida: el folio de las pólizas es consecutivo POR contribuyente.
  rfc = `GCB${Date.now().toString(36).toUpperCase().slice(-6)}XX0`
  await prisma.venue.update({ where: { id: venueId }, data: { rfc } })
  await prisma.giftCardSettings.create({ data: { venueId, enabled: true, suggestedAmounts: [500, 1000, 2000] } })
  await ensureGiftCardTender(prisma, venueId)
  await seedBaseChart(venueId, { staffId })
  await seedDefaultMappings(venueId, { staffId })

  const v = await sembrarVentaDeTarjetas({ venueId, organizationId, staffId, montos: [500], metodo: 'CREDIT_CARD' })
  venta = { orderId: v.orderId, pagoId: v.pagos[0].id }
  const c = await sembrarCanje({ venueId, staffId, giftCardIds: v.giftCardIds, total: 116, conSaldo: 116 })
  canje = { orderId: c.orderId, pagoId: c.pagoConSaldo.id }

  const { orderId } = await crearCuentaDeMercancia({ venueId, staffId, total: 200 })
  const pago = await prisma.payment.create({
    data: {
      venueId,
      orderId,
      amount: D(200),
      tipAmount: D(0),
      netAmount: D(200),
      feePercentage: 0,
      feeAmount: D(0),
      method: 'CREDIT_CARD',
      status: 'COMPLETED',
      type: 'REGULAR',
      splitType: 'FULLPAYMENT',
      source: 'TPV',
      fundsFlow: 'AVOQADO_PROCESSED',
      processedById: staffId,
    },
  })
  await prisma.order.update({
    where: { id: orderId },
    data: { status: 'COMPLETED', paymentStatus: 'PAID', paidAmount: D(200), remainingBalance: D(0), completedAt: new Date() },
  })
  normal = { orderId, pagoId: pago.id }
})

afterAll(async () => {
  if (!venueId) return
  await prisma.journalEntry.deleteMany({ where: { organizationId, rfc } }).catch(() => undefined)
  await prisma.accountMapping.deleteMany({ where: { organizationId, rfc } }).catch(() => undefined)
  await prisma.ledgerAccount.deleteMany({ where: { organizationId, rfc } }).catch(() => undefined)
  await limpiarEfectosDePagoDelNegocio(venueId)
})

describe('contabilidad de tarjetas de regalo · Postgres real', () => {
  it('🔴 la enumeración del estado de resultados corre en Postgres y deja fuera sólo la cuenta de tarjetas', async () => {
    const ids = await prisma.$queryRaw<Array<{ orderId: string }>>(
      sqlDeOrdenesDelPeriodo(venueId, new Date(Date.now() - DIA), new Date(Date.now() + DIA), 10),
    )
    expect(ids.map(r => r.orderId).sort()).toEqual([canje.orderId, normal.orderId].sort())
  })

  it('🔴 estado de resultados: el canje ($116) y la venta normal ($200) son ingreso; la carga de la tarjeta ($500) no', async () => {
    const r = await getIncomeStatement(venueId, { from: ymd(new Date(Date.now() - DIA)), to: ymd(new Date(Date.now() + DIA)) })
    expect([r.revenue.grossSalesCents, r.revenue.refundsCents, r.metrics.salesCount]).toEqual([31600, 0, 2])
    // Lo fiscal: los dos cobros quedan en el alcance (tarjeta sin comercio excluido; el tender de sistema no es efectivo).
    expect(r.fiscalRevenue.grossSalesCents).toBe(31600)
  })

  it('🔴 autoposteo: sólo la venta normal lleva póliza; la venta de la tarjeta y el canje quedan pendientes, y siguen pendientes al re-correr', async () => {
    const r = await generatePoliciesForVenue(venueId, { actorStaffId: staffId })
    expect(r).toMatchObject({
      needsFiscalSetup: false,
      missingMappings: [],
      candidates: 3,
      posted: 1,
      alreadyPosted: 0,
      skipped: 0,
      pendientesDeRevision: 2,
    })
    const polizas = await prisma.journalEntry.findMany({
      where: { organizationId, rfc },
      select: { sourceId: true, idempotencyKey: true },
      take: 10,
      orderBy: { id: 'asc' },
    })
    expect(polizas).toEqual([{ sourceId: normal.pagoId, idempotencyKey: `pay:${normal.pagoId}:v1` }])

    // No persiste nada: la siguiente corrida los vuelve a contar como pendientes (hasta la póliza de pasivo de la fase 2).
    const otra = await generatePoliciesForVenue(venueId, { actorStaffId: staffId })
    expect(otra).toMatchObject({ posted: 0, alreadyPosted: 1, pendientesDeRevision: 2 })
  })

  it('🔴 la marca de B1 (la del listado del contador) encuentra exactamente los cobros que el motor saltó', async () => {
    const marcados = await prisma.payment.findMany({
      where: { venueId, status: 'COMPLETED', ...WHERE_PAGO_PENDIENTE_DE_REVISION_CONTABLE },
      select: { id: true },
      take: 10,
      orderBy: { id: 'asc' },
    })
    expect(marcados.map(p => p.id).sort()).toEqual([venta.pagoId, canje.pagoId].sort())
  })

  it('🔴 B4 r1 (fix 1) · Bancos y cajas: lo pagado con saldo NO es dinero que llega al banco; la venta de la tarjeta con tarjeta sí', async () => {
    const b = await getBankAndCashSummary(venueId, RANGO())
    // Venta de la tarjeta $500 + venta normal $200, las dos con tarjeta. Sin el arreglo: $816 (el canje de $116 contaba como banco
    // aunque ese dinero ya había entrado al vender la tarjeta: dos veces el mismo peso, y un depósito que nunca llega).
    expect([b.totals.electronicInflowCents, b.totals.cashInflowCents, b.totals.netToBankCents]).toEqual([70000, 0, 70000])
    expect(b.accounts.map(a => a.key)).toEqual(['card'])
    const s = await getBusinessSummary(venueId, RANGO())
    expect(s.collection).toEqual({ cashCents: 0, electronicCents: 70000, cashPct: 0 })
  })

  it('🔴 B4 r1 (fix 4) · el IVA del canje está en el estado de resultados y en el IVA en flujo (la venta de la tarjeta no lleva IVA)', async () => {
    // Canje $116 al 16 % ⇒ IVA $16.00; venta normal $200 al 16 % ⇒ IVA $27.59. La carga de $500 no aporta IVA ni base.
    const r = await getIncomeStatement(venueId, RANGO())
    expect([r.fiscalRevenue.ivaCents, r.fiscalRevenue.taxByRate]).toEqual([1600 + 2759, { '0.16': 1600 + 2759 }])
    expect(r.fiscalRevenue.ingresosSinIvaCents).toBe(10000 + 17241)
    const iva = await getIvaCashflow(venueId, MES())
    expect([iva.ivaTrasladadoCobradoCents, iva.ivaTrasladadoPorTasaCents]).toEqual([1600 + 2759, { '0.16': 1600 + 2759 }])
  })

  it('🔴 B4 r1 (fix 2) · ISR: la base NO se recalcula; dice cuánto de tarjetas cobradas falta y cuánto pagado con saldo sobra', async () => {
    const r = await getIsrProvisional(venueId, MES(), 'RESICO')
    // La base es la del estado de resultados (sin la carga, con el canje): no cambia en la fase 1.
    expect(r.ingresosMesCents).toBe(10000 + 17241)
    expect([r.tarjetasCobradasNoIncluidasCents, r.pagadoConSaldoIncluidoCents]).toEqual([50000, 10000])
    expect(r.avisoTarjetasDeRegalo).toBe(
      'El ISR estimado no incluye $500.00 de tarjetas de regalo cobradas en el periodo y sí incluye $100.00 pagado con saldo de tarjetas; tu contador debe ajustarlo con el reporte de tarjetas.',
    )
  })

  it('control (fix 2) · un negocio SIN tarjetas: el ISR de siempre, importes en 0 y sin aviso', async () => {
    const otro = await crearNegocioDePrueba('isr-sin-tarjetas')
    try {
      await prisma.venue.update({ where: { id: otro.venueId }, data: { rfc: `GCS${Date.now().toString(36).toUpperCase().slice(-6)}XX0` } })
      const { orderId } = await crearCuentaDeMercancia({ venueId: otro.venueId, staffId: otro.staffId, total: 200 })
      await prisma.payment.create({
        data: {
          venueId: otro.venueId,
          orderId,
          amount: D(200),
          tipAmount: D(0),
          netAmount: D(200),
          feePercentage: 0,
          feeAmount: D(0),
          method: 'CREDIT_CARD',
          status: 'COMPLETED',
          type: 'REGULAR',
          splitType: 'FULLPAYMENT',
          source: 'TPV',
          fundsFlow: 'AVOQADO_PROCESSED',
          processedById: otro.staffId,
        },
      })
      const r = await getIsrProvisional(otro.venueId, MES(), 'RESICO')
      expect([r.ingresosMesCents, r.tarjetasCobradasNoIncluidasCents, r.pagadoConSaldoIncluidoCents, r.avisoTarjetasDeRegalo]).toEqual([
        17241,
        0,
        0,
        undefined,
      ])
    } finally {
      await limpiarEfectosDePagoDelNegocio(otro.venueId)
    }
  })
})

/**
 * B4 r1 (fix 3): el par que usará el listado del contador (C4). `WHERE_PAGO_CONTABILIZABLE` dice en Prisma lo mismo que el motor admite
 * (`isEligible` sobre lo que trae su consulta), y con la marca de B1 cuenta exactamente los cobros que el motor deja pendientes: sin el
 * fragmento, la marca sola también traería un cobro con saldo de PRUEBA y el cobro de una venta de tarjeta CANCELADA.
 */
describe('B4 r1 (fix 3) · WHERE_PAGO_CONTABILIZABLE = lo que el motor admite · Postgres real', () => {
  let org2: string
  let v2: string
  let staff2: string
  let rfc2: string
  const esperados: Record<string, string> = {}
  const noAdmitidos: Record<string, string> = {}

  /** Un cobro sembrado a mano sobre `orderId` (los campos que la tabla exige), con lo que cambie cada caso. */
  const cobro = (orderId: string, d: Partial<Prisma.PaymentUncheckedCreateInput>) =>
    prisma.payment.create({
      data: {
        venueId: v2,
        orderId,
        amount: D(100),
        tipAmount: D(0),
        netAmount: D(100),
        feePercentage: 0,
        feeAmount: D(0),
        method: 'CREDIT_CARD',
        status: 'COMPLETED',
        type: 'REGULAR',
        splitType: 'CUSTOMAMOUNT',
        source: 'TPV',
        fundsFlow: 'AVOQADO_PROCESSED',
        processedById: staff2,
        ...d,
      },
    })

  beforeAll(async () => {
    ;({ organizationId: org2, venueId: v2, staffId: staff2 } = await crearNegocioDePrueba('paridad'))
    rfc2 = `GCP${Date.now().toString(36).toUpperCase().slice(-6)}XX0`
    await prisma.venue.update({ where: { id: v2 }, data: { rfc: rfc2 } })
    await prisma.giftCardSettings.create({ data: { venueId: v2, enabled: true, suggestedAmounts: [500, 1000, 2000] } })
    const tender = await ensureGiftCardTender(prisma, v2)
    await seedBaseChart(v2, { staffId: staff2 })
    await seedDefaultMappings(v2, { staffId: staff2 })

    // Tarjetas: un canje normal (pendiente), un cobro con saldo de PRUEBA y una venta de tarjeta CANCELADA (el motor no los ve).
    const v = await sembrarVentaDeTarjetas({ venueId: v2, organizationId: org2, staffId: staff2, montos: [500], metodo: 'CREDIT_CARD' })
    esperados.canje = (
      await sembrarCanje({ venueId: v2, staffId: staff2, giftCardIds: v.giftCardIds, total: 116, conSaldo: 116 })
    ).pagoConSaldo.id
    // La venta de arriba también queda pendiente (es la primera carga): se cuenta.
    esperados.ventaDeTarjeta = v.pagos[0].id
    const { orderId: merc } = await crearCuentaDeMercancia({ venueId: v2, staffId: staff2, total: 100 })
    await prisma.order.update({ where: { id: merc }, data: { status: 'COMPLETED', paymentStatus: 'PAID' } })
    noAdmitidos.saldoDePrueba = (
      await cobro(merc, {
        type: 'TEST',
        method: 'OTHER',
        fundsFlow: 'EXTERNAL_RECORDED',
        tenderTypeId: tender.id,
        tenderRevision: tender.revision,
        tenderSatFormaPago: '01',
      })
    ).id
    const cancelada = await sembrarVentaDeTarjetas({
      venueId: v2,
      organizationId: org2,
      staffId: staff2,
      montos: [300],
      metodo: 'CREDIT_CARD',
    })
    await prisma.order.update({ where: { id: cancelada.orderId }, data: { status: 'CANCELLED' } })
    noAdmitidos.ventaCancelada = cancelada.pagos[0].id

    // Sin tarjetas: cada regla de `isEligible`, en una cuenta de mercancía pagada.
    esperados.normal = (await cobro(merc, {})).id
    esperados.sinTipo = (await cobro(merc, { type: null })).id // fila vieja: `type` NULL cuenta como venta (NULL-safe)
    esperados.soloPropina = (await cobro(merc, { amount: D(0), netAmount: D(10), tipAmount: D(10) })).id
    esperados.devolucion = (await cobro(merc, { type: 'REFUND', amount: D(-20), netAmount: D(-20) })).id
    noAdmitidos.prueba = (await cobro(merc, { type: 'TEST' })).id
    noAdmitidos.ajuste = (await cobro(merc, { type: 'ADJUSTMENT' })).id
    noAdmitidos.cripto = (await cobro(merc, { method: 'CRYPTOCURRENCY' })).id
    noAdmitidos.enCeros = (await cobro(merc, { amount: D(0), netAmount: D(0) })).id
    noAdmitidos.pendiente = (await cobro(merc, { status: 'PENDING' })).id
  })

  afterAll(async () => {
    if (!v2) return
    await prisma.journalEntry.deleteMany({ where: { organizationId: org2, rfc: rfc2 } }).catch(() => undefined)
    await prisma.accountMapping.deleteMany({ where: { organizationId: org2, rfc: rfc2 } }).catch(() => undefined)
    await prisma.ledgerAccount.deleteMany({ where: { organizationId: org2, rfc: rfc2 } }).catch(() => undefined)
    await limpiarEfectosDePagoDelNegocio(v2)
  })

  it('🔴 las mismas filas, por `isEligible` (sobre la consulta del motor) y por el fragmento: el mismo conjunto, el esperado', async () => {
    const delMotor = await prisma.payment.findMany({
      where: { venueId: v2, status: 'COMPLETED', order: { status: { not: 'CANCELLED' } } },
      select: { id: true, type: true, method: true, amount: true, tipAmount: true, order: { select: { status: true } } },
      take: 50,
      orderBy: { id: 'asc' },
    })
    const porElMotor = delMotor.filter(p => isEligible(p as unknown as Parameters<typeof isEligible>[0])).map(p => p.id)
    const porElFragmento = (
      await prisma.payment.findMany({
        where: { venueId: v2, AND: [WHERE_PAGO_CONTABILIZABLE] },
        select: { id: true },
        take: 50,
        orderBy: { id: 'asc' },
      })
    ).map(p => p.id)
    expect(porElFragmento).toEqual(porElMotor)
    expect([...porElFragmento].sort()).toEqual(Object.values(esperados).sort())
    expect(porElFragmento.filter(id => Object.values(noAdmitidos).includes(id))).toEqual([])
    expect(Object.keys(noAdmitidos)).toHaveLength(7) // las 7 filas que alguna regla deja fuera sí existen en la base
  })

  it('🔴 paridad con el motor: pendientesDeRevision = cobros con CONTABILIZABLE y la marca de B1; la marca sola trae dos de más', async () => {
    const r = await generatePoliciesForVenue(v2, { actorStaffId: staff2 })
    const conElPar = await prisma.payment.count({
      where: { venueId: v2, AND: [WHERE_PAGO_CONTABILIZABLE, WHERE_PAGO_PENDIENTE_DE_REVISION_CONTABLE] },
    })
    expect(r.pendientesDeRevision).toBe(conElPar)
    expect(conElPar).toBe(2) // la venta de la tarjeta y el canje
    const soloLaMarca = await prisma.payment.count({
      where: { venueId: v2, status: 'COMPLETED', ...WHERE_PAGO_PENDIENTE_DE_REVISION_CONTABLE },
    })
    expect(soloLaMarca).toBe(4) // + el cobro con saldo de prueba + la venta de tarjeta cancelada
  })
})
