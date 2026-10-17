/**
 * Reportes de tarjetas de regalo contra Postgres real (base desechable): la antigüedad por LATERAL (saldo al CIERRE del día
 * del negocio, no a medianoche UTC), el resumen con las fronteras del día en America/Mexico_City, la búsqueda y la
 * paginación estable, y los pendientes de revisión contable (sin NOT: los pagos sin tender no se pierden).
 * Sin limpieza de tarjetas: la libreta sólo inserta (su trigger impide borrar renglones) y cada corrida usa su propio negocio
 * (`crearNegocioDePrueba`); sólo se borran los `PaymentEffect` de esos negocios.
 *
 * Correr: source ../urls-tarjetas.sh && npx jest --selectProjects integration --runInBand \
 *   --runTestsByPath tests/integration/giftCards/giftCardReports.integration.test.ts --ci
 */
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))

import { randomUUID } from 'crypto'
import { Prisma, type GiftCardActivityType } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { ensureGiftCardTender } from '@/services/giftCards/giftCardTender'
import {
  getGiftCardDetail,
  getGiftCardLiabilityAging,
  getGiftCardSummary,
  listGiftCards,
  listPendingAccountingReview,
} from '@/services/giftCards/giftCardReports.service'
import { crearNegocioDePrueba, limpiarEfectosDePagoDelNegocio, sembrarVentaDeTarjetas } from './sembrarTarjetasDeRegalo'

jest.setTimeout(120000)

const stamp = `${Date.now()}${process.pid}`
const D = (v: string | number) => new Prisma.Decimal(v)
let organizationId: string
let venueId: string
let staffId: string
let customerId: string
const ids: Record<'A' | 'B' | 'C' | 'D' | 'E', string> = { A: '', B: '', C: '', D: '', E: '' }
let n = 0
const negocios: string[] = []

async function sobre(
  datos: Omit<
    Prisma.GiftCardUncheckedCreateInput,
    'venueId' | 'organizationId' | 'codeHash' | 'codeEnc' | 'codeLast4' | 'pageToken' | 'termsVersion' | 'deliveryChannel'
  >,
) {
  n++
  return prisma.giftCard.create({
    data: {
      venueId,
      organizationId,
      codeHash: `hash-${stamp}-${n}`,
      codeEnc: 'no-se-descifra-en-esta-prueba',
      codeLast4: `T${String(n).padStart(3, '0')}`,
      pageToken: `page-${stamp}-${n}`,
      termsVersion: '2026-10-14',
      deliveryChannel: 'PRINTED',
      ...datos,
    },
  })
}

async function renglon(
  giftCardId: string,
  type: GiftCardActivityType,
  amount: string,
  balanceAfter: string,
  createdAt: string,
  extra: { reason?: 'SUSPICIOUS_ACTIVITY' | 'CASHIER_ERROR'; note?: string } = {},
) {
  await prisma.giftCardActivity.create({
    data: {
      giftCardId,
      venueId,
      type,
      amount: D(amount),
      balanceAfter: D(balanceAfter),
      createdAt: new Date(createdAt),
      staffId,
      ...extra,
    },
  })
}

beforeAll(async () => {
  if (!/test/i.test(new URL(process.env.TEST_DATABASE_URL!).pathname)) {
    throw new Error('Se requiere la base desechable')
  }
  ;({ organizationId, venueId, staffId } = await crearNegocioDePrueba('reportes'))
  negocios.push(venueId)
  // Las fronteras del día que miden estas pruebas son las de America/Mexico_City: se fijan, no se suponen de la de fábrica.
  await prisma.venue.update({ where: { id: venueId }, data: { timezone: 'America/Mexico_City' } })
  customerId = (
    await prisma.customer.create({ data: { venueId, firstName: 'Brenda', lastName: 'Saldaña', phone: `55${stamp.slice(-8)}` } })
  ).id

  // A: activa, 24 días antes del corte del 14-oct. Un cobro a las 23:30 del 14 (hora del negocio: ENTRA) y otro a las
  // 00:30 del 15 (NO entra al 14).
  const A = await sobre({
    initialAmount: D(1000),
    balance: D(400),
    status: 'ACTIVE',
    activatedAt: new Date('2026-09-20T18:00:00.000Z'),
    recipientName: 'Ana Regalo',
  })
  await renglon(A.id, 'ACTIVATE', '1000', '1000', '2026-09-20T18:00:00.000Z')
  await renglon(A.id, 'REDEEM', '300', '700', '2026-10-01T18:00:00.000Z')
  await renglon(A.id, 'REDEEM', '200', '500', '2026-10-15T05:30:00.000Z')
  await renglon(A.id, 'REDEEM', '100', '400', '2026-10-15T06:30:00.000Z')
  // B: bloqueada (se sigue debiendo), 135 días, guardada a una clienta.
  const B = await sobre({
    initialAmount: D(500),
    balance: D(500),
    status: 'BLOCKED',
    activatedAt: new Date('2026-06-01T18:00:00.000Z'),
    customerId,
  })
  await renglon(B.id, 'ACTIVATE', '500', '500', '2026-06-01T18:00:00.000Z')
  // C: vendida y cancelada en el periodo (saldo 0: fuera del saldo vivo).
  const C = await sobre({
    initialAmount: D(100),
    balance: D(0),
    status: 'DEACTIVATED',
    activatedAt: new Date('2026-10-01T18:00:00.000Z'),
    deactivatedAt: new Date('2026-10-02T18:00:00.000Z'),
  })
  await renglon(C.id, 'ACTIVATE', '100', '100', '2026-10-01T18:00:00.000Z')
  await renglon(C.id, 'DEACTIVATE', '100', '0', '2026-10-02T18:00:00.000Z')
  // D: sin cobrar (PENDING, nace en $0: A5): todavía no es deuda.
  const Dd = await sobre({ initialAmount: D(700), balance: D(0), status: 'PENDING' })
  // E: 408 días, vencida el 1-sep: saldo vivo vencido.
  const E = await sobre({
    initialAmount: D(250),
    balance: D(250),
    status: 'ACTIVE',
    activatedAt: new Date('2025-09-01T18:00:00.000Z'),
    expiresAt: new Date('2026-09-01T18:00:00.000Z'),
  })
  await renglon(E.id, 'ACTIVATE', '250', '250', '2025-09-01T18:00:00.000Z')
  Object.assign(ids, { A: A.id, B: B.id, C: C.id, D: Dd.id, E: E.id })
})

afterAll(async () => {
  for (const v of negocios) await limpiarEfectosDePagoDelNegocio(v)
})

describe('reportes de tarjetas de regalo contra Postgres', () => {
  it('antigüedad al 14-oct: el saldo de la libreta al CIERRE del día del negocio, por días desde la activación', async () => {
    const r = await getGiftCardLiabilityAging(venueId, '2026-10-14')
    expect(r.buckets).toEqual([
      { bucket: '0-30', cards: 1, amount: 500 }, // A: el cobro de las 00:30 del 15 no cuenta
      { bucket: '31-90', cards: 0, amount: 0 },
      { bucket: '91-180', cards: 1, amount: 500 }, // B
      { bucket: '181-365', cards: 0, amount: 0 },
      { bucket: '366+', cards: 1, amount: 250 }, // E (sin «vencido al corte»: auditoría r1 C-4)
    ])
    expect(r.total).toEqual({ cards: 3, amount: 1250 })
  })

  it('antigüedad al 30-sep: A todavía tenía $1,000 y C ni existía', async () => {
    const r = await getGiftCardLiabilityAging(venueId, '2026-09-30')
    expect(r.total).toEqual({ cards: 3, amount: 1750 })
  })

  it('resumen del 1 al 14-oct con las fronteras del día del negocio', async () => {
    const r = await getGiftCardSummary(venueId, { from: '2026-10-01', to: '2026-10-14' })
    expect(r.sold).toEqual({ cards: 1, amount: 100 }) // C
    expect(r.redeemed).toEqual({ movements: 2, amount: 500, reversed: 0, net: 500 }) // A: 300 + 200 (23:30 del 14)
    expect(r.cancelled).toEqual({ cards: 1, amount: 100 })
    expect(r.liveBalance).toMatchObject({ cards: 3, amount: 1150, expiredAmount: 250 }) // hoy: A 400 + B 500 + E 250
  })

  it('busca por la clienta, por quien la recibe y por los últimos 4', async () => {
    expect((await listGiftCards(venueId, { search: 'brenda' })).items.map(t => t.id)).toEqual([ids.B])
    expect((await listGiftCards(venueId, { search: 'ana regalo' })).items.map(t => t.id)).toEqual([ids.A])
    const last4 = (await prisma.giftCard.findUniqueOrThrow({ where: { id: ids.E }, select: { codeLast4: true } })).codeLast4
    expect((await listGiftCards(venueId, { last4 })).items.map(t => t.id)).toEqual([ids.E])
  })

  it('⭐ (D3 menor 6) «Activa» = se puede usar hoy: trae A y no E (vencida); la lista, el total y el saldo cuadran con la misma frontera', async () => {
    const activas = await listGiftCards(venueId, { status: ['ACTIVE'] })
    expect([activas.items.map(t => t.id), activas.total, activas.totalBalance]).toEqual([[ids.A], 1, 400])
    const vencidas = await listGiftCards(venueId, { status: ['EXPIRED'] })
    expect([vencidas.items.map(t => t.id), vencidas.total, vencidas.totalBalance]).toEqual([[ids.E], 1, 250])
    const lasDos = await listGiftCards(venueId, { status: ['ACTIVE', 'EXPIRED'] })
    expect([[...lasDos.items.map(t => t.id)].sort(), lasDos.total, lasDos.totalBalance]).toEqual([[ids.A, ids.E].sort(), 2, 650])
  })

  it('pagina en orden estable con el total real: tres páginas de 2 traen las 5 sin repetir', async () => {
    const paginas = await Promise.all([1, 2, 3].map(page => listGiftCards(venueId, { page, pageSize: 2 })))
    expect(paginas.map(p => p.total)).toEqual([5, 5, 5])
    expect(new Set(paginas.flatMap(p => p.items.map(t => t.id))).size).toBe(5)
  })

  it('pendientes de revisión contable: la venta de la tarjeta, el cobro con saldo y su reverso; el efectivo normal no', async () => {
    const tender = await ensureGiftCardTender(prisma, venueId)
    const orden = async (total: number) =>
      (
        await prisma.order.create({
          data: {
            venueId,
            orderNumber: `gc-${randomUUID()}`,
            source: 'TPV',
            createdById: staffId,
            subtotal: D(total),
            taxAmount: D(0),
            total: D(total),
            remainingBalance: D(0),
          },
        })
      ).id
    const cuentaDeTarjetas = await orden(700)
    await prisma.orderItem.create({
      data: {
        orderId: cuentaDeTarjetas,
        productName: 'Tarjeta de regalo',
        quantity: 1,
        unitPrice: D(700),
        taxAmount: D(0),
        total: D(700),
        ivaTratamiento: 'NO_OBJETO',
        giftCardId: ids.D,
      },
    })
    const mercancia = await orden(500)
    const pago = (orderId: string, amount: number, extra: Partial<Prisma.PaymentUncheckedCreateInput> = {}) =>
      prisma.payment.create({
        data: {
          venueId,
          orderId,
          amount: D(amount),
          method: 'CASH',
          status: 'COMPLETED',
          feePercentage: D(0),
          feeAmount: D(0),
          netAmount: D(amount),
          processedById: staffId,
          createdAt: new Date('2026-10-10T18:00:00.000Z'),
          ...extra,
        },
      })
    const venta = await pago(cuentaDeTarjetas, 700)
    const conSaldo = await pago(mercancia, 300, { method: 'OTHER', tenderTypeId: tender.id, fundsFlow: 'EXTERNAL_RECORDED' })
    const reverso = await pago(mercancia, -100, {
      method: 'OTHER',
      tenderTypeId: tender.id,
      fundsFlow: 'EXTERNAL_RECORDED',
      type: 'REFUND',
      createdAt: new Date('2026-10-11T18:00:00.000Z'),
    })
    const efectivoNormal = await pago(mercancia, 200)

    const r = await listPendingAccountingReview(venueId, { from: '2026-10-01', to: '2026-10-14' })
    expect(r.total).toBe(3)
    expect(r.items[0].paymentId).toBe(reverso.id) // el más reciente primero
    expect(new Map(r.items.map(p => [p.paymentId, p.kind]))).toEqual(
      new Map([
        [venta.id, 'VENTA_DE_TARJETAS'],
        [conSaldo.id, 'COBRO_CON_SALDO'],
        [reverso.id, 'REVERSO_DE_SALDO'],
      ]),
    )
    expect(r.items.map(p => p.paymentId)).not.toContain(efectivoNormal.id)
    expect(r.totals).toEqual({
      VENTA_DE_TARJETAS: { count: 1, amount: 700, tipAmount: 0 },
      CANCELACION_DE_VENTA: { count: 0, amount: 0, tipAmount: 0 },
      COBRO_CON_SALDO: { count: 1, amount: 300, tipAmount: 0 },
      REVERSO_DE_SALDO: { count: 1, amount: -100, tipAmount: 0 },
    })
  })

  // Las dos que siguen crean sobres nuevos: van al FINAL para no mover los totales de las de arriba.
  it('🔴 r1 C-3: la búsqueda por cliente no se trunca en 50 — la tarjeta del cliente 51 sale en la página y en el total', async () => {
    await prisma.customer.createMany({
      data: Array.from({ length: 51 }, (_, i) => ({
        venueId,
        firstName: 'Karla',
        lastName: `Busqueda${String(i).padStart(2, '0')}`,
        phone: `56${stamp.slice(-6)}${String(i).padStart(2, '0')}`,
      })),
    })
    const ultima = await prisma.customer.findFirstOrThrow({ where: { venueId, lastName: 'Busqueda50' }, select: { id: true } })
    const F = await sobre({
      initialAmount: D(300),
      balance: D(300),
      status: 'ACTIVE',
      activatedAt: new Date('2026-10-12T18:00:00.000Z'),
      customerId: ultima.id,
    })
    const r = await listGiftCards(venueId, { search: 'karla busqueda' })
    expect(r.items.map(t => t.id)).toEqual([F.id])
    expect(r).toMatchObject({ total: 1, totalBalance: 300 })
  })

  it('🔴 r1 D-2: bloqueada y con más ajustes que una página, el detalle trae el bloqueo VIGENTE aparte de la libreta', async () => {
    const G = await sobre({ initialAmount: D(1000), balance: D(970), status: 'BLOCKED', activatedAt: new Date('2026-10-05T18:00:00.000Z') })
    await renglon(G.id, 'ACTIVATE', '1000', '1000', '2026-10-05T18:00:00.000Z')
    await renglon(G.id, 'BLOCK', '0', '1000', '2026-10-06T18:00:00.000Z', {
      reason: 'SUSPICIOUS_ACTIVITY',
      note: 'Varios intentos fallidos',
    })
    for (let i = 0; i < 3; i++)
      await renglon(G.id, 'ADJUST_DECREMENT', '10', String(990 - i * 10), `2026-10-0${7 + i}T18:00:00.000Z`, { reason: 'CASHIER_ERROR' })
    const r = await getGiftCardDetail(venueId, G.id, { limit: 2 })
    expect(r.activities.items.map(a => a.type)).toEqual(['ADJUST_DECREMENT', 'ADJUST_DECREMENT'])
    expect(r.currentBlock).toEqual({ reason: 'SUSPICIOUS_ACTIVITY', note: 'Varios intentos fallidos', at: '2026-10-06T18:00:00.000Z' })
    expect((await getGiftCardDetail(venueId, ids.A, {})).currentBlock).toBeNull()
  })

  it('🔴 nota 1: una venta de tarjetas devuelta entera (orden CANCELLED) sigue en su periodo; netea a $0; TEST y $0 no aparecen', async () => {
    // Negocio aparte: sus sobres no mueven las cifras de las pruebas de arriba.
    const otro = await crearNegocioDePrueba('reportes-devuelta')
    negocios.push(otro.venueId)
    const v = await sembrarVentaDeTarjetas({ ...otro, montos: [700], metodo: 'CASH', cobradaEn: new Date('2026-10-01T18:00:00.000Z') })
    const cobro = (d: Partial<Prisma.PaymentUncheckedCreateInput>) =>
      prisma.payment.create({
        data: {
          venueId: otro.venueId,
          orderId: v.orderId,
          amount: D(700),
          tipAmount: D(0),
          netAmount: D(700),
          feePercentage: 0,
          feeAmount: D(0),
          method: 'CASH',
          status: 'COMPLETED',
          type: 'REGULAR',
          splitType: 'FULLPAYMENT',
          source: 'POS',
          fundsFlow: 'CASH_DRAWER',
          processedById: otro.staffId,
          createdAt: new Date('2026-10-02T18:00:00.000Z'),
          ...d,
        },
      })
    const devolucion = await cobro({ type: 'REFUND', amount: D(-700), netAmount: D(-700), createdAt: new Date('2026-10-03T18:00:00.000Z') })
    await prisma.order.update({ where: { id: v.orderId }, data: { status: 'CANCELLED' } })
    const prueba = await cobro({ type: 'TEST' })
    const enCeros = await cobro({ amount: D(0), netAmount: D(0) })

    const r = await listPendingAccountingReview(otro.venueId, { from: '2026-10-01', to: '2026-10-03' })
    expect(new Map(r.items.map(p => [p.paymentId, p.kind]))).toEqual(
      new Map([
        [devolucion.id, 'CANCELACION_DE_VENTA'],
        [v.pagos[0].id, 'VENTA_DE_TARJETAS'],
      ]),
    )
    expect(r.items.map(p => p.paymentId)).not.toEqual(expect.arrayContaining([prueba.id]))
    expect(r.items.map(p => p.paymentId)).not.toEqual(expect.arrayContaining([enCeros.id]))
    expect(r.total).toBe(2)
    expect(r.totals).toEqual({
      VENTA_DE_TARJETAS: { count: 1, amount: 700, tipAmount: 0 },
      CANCELACION_DE_VENTA: { count: 1, amount: -700, tipAmount: 0 },
      COBRO_CON_SALDO: { count: 0, amount: 0, tipAmount: 0 },
      REVERSO_DE_SALDO: { count: 0, amount: 0, tipAmount: 0 },
    })
    expect(Object.values(r.totals).reduce((t, x) => t + x.amount, 0)).toBe(0)
    expect(r.notice).toMatch(/costo de ventas/)
  })
})
