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
import prisma from '@/utils/prismaClient'
import { ensureGiftCardTender } from '@/services/giftCards/giftCardTender'
import { WHERE_PAGO_PENDIENTE_DE_REVISION_CONTABLE } from '@/services/giftCards/giftCardMarks'
import { generatePoliciesForVenue } from '@/services/fiscal/autoPosting.service'
import { seedBaseChart } from '@/services/fiscal/chartOfAccounts.service'
import { seedDefaultMappings } from '@/services/fiscal/accountMapping.service'
import { sqlDeOrdenesDelPeriodo } from '@/services/fiscal/librosDeOrdenes'
import { getIncomeStatement } from '@/services/dashboard/accounting.dashboard.service'
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
})
