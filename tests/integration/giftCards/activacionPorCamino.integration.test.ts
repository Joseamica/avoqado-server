/**
 * R8 contra Postgres REAL: una cuenta de tarjetas pagada en efectivo (en vivo y por la cola sin red) o liquidada desde
 * el dashboard deja sus sobres ACTIVE con su ACTIVATE; si lo cobrado no cuadra con los sobres, no activa y deja un
 * MoneyAnomaly. Ruling A6: una cuenta CANCELADA (sobres DEACTIVATED) que recibe dinero tarde se reabre y queda pagada,
 * pero sus sobres NO se reviven y queda un MoneyAnomaly propio; también si la venta pagada se devolvió y luego llega un cobro
 * tardío de la terminal (r1), y repetirlo no duplica la fila. S0.3: el efectivo tardío de la cola sobre una venta de tarjetas YA
 * cerrada (devuelta) también deja su anomalía en la transacción del cobro, sin esperar a la revisión nocturna.
 *
 * Correr: source ../urls-tarjetas.sh && TZ=UTC npx jest --selectProjects integration \
 *   --runTestsByPath tests/integration/giftCards/activacionPorCamino.integration.test.ts --ci --runInBand
 */
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))
jest.mock('@/services/shared/cashDrawerPosting', () => ({
  ...jest.requireActual('@/services/shared/cashDrawerPosting'),
  postCashSaleToDrawer: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasFeatureAccess: jest.fn().mockResolvedValue(true),
}))
// C1 (cierre): el comando a SoftRestaurant que manda `recordOrderPayment` a una integrada, contado (nunca sale a RabbitMQ).
jest.mock('@/communication/rabbitmq/publisher', () => ({
  ...jest.requireActual('@/communication/rabbitmq/publisher'),
  publishCommand: jest.fn().mockResolvedValue(undefined),
}))

import { Prisma } from '@prisma/client'
import { publishCommand } from '@/communication/rabbitmq/publisher'
import { recordOrderPayment } from '@/services/tpv/payment.tpv.service'
import prisma from '@/utils/prismaClient'
import { createGiftCardOrder } from '@/services/giftCards/giftCardOrder.service'
import { activarSobresDeCuentaPagadaEnTx } from '@/services/giftCards/giftCardLedger'
import { cancelOrder, payCashOrder } from '@/services/mobile/order.mobile.service'
import { settleOrder } from '@/services/dashboard/order.dashboard.service'
import { lockExistingOrderForPayment } from '@/services/shared/paymentShiftClaim'
import { settleStandalonePaymentInTx } from '@/services/tpv/payment.tpv.service'
import { limpiarNegocioDePrueba } from './sembrarTarjetasDeRegalo'

jest.setTimeout(60000)

const SUF = `activa-${process.pid}-${Date.now()}`
let orgId: string
let venueId: string
let staffId: string

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: SUF, email: `${SUF}@example.test`, phone: '5500000000' } })).id
  venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: SUF, slug: SUF } })).id
  staffId = (await prisma.staff.create({ data: { email: `${SUF}@staff.test`, firstName: 'Caja', lastName: 'QA', active: true } })).id
  await prisma.staffVenue.create({ data: { staffId, venueId, role: 'CASHIER', active: true } })
  await prisma.giftCardSettings.create({ data: { venueId, enabled: true, suggestedAmounts: [500, 1000, 2000], validityMonths: 12 } })
})

// B1 r1 (fix 7): los `PaymentEffect` de ESTE negocio no se quedan para el worker de otra suite que barre toda la base.
// La libreta (`GiftCardActivity`) nunca se borra.
afterAll(async () => {
  await limpiarNegocioDePrueba(venueId)
})

async function cuenta(llave: string, montos: number[]) {
  return createGiftCardOrder(venueId, staffId, {
    idempotencyKey: llave,
    sobres: montos.map(amount => ({ amount, deliveryChannel: 'HANDED_TO_BUYER' as const })),
  })
}

/** Las anomalías de tarjetas de UNA cuenta (la llave determinista lleva su id en `expectedState.id`). */
async function anomaliasDe(orderId: string) {
  return prisma.moneyAnomaly.findMany({
    where: { stripeEventId: { startsWith: 'giftcard:' }, expectedState: { path: ['id'], equals: orderId } },
    orderBy: { id: 'asc' },
    take: 10,
  })
}

async function estadoDe(ids: string[]) {
  const sobres = await prisma.giftCard.findMany({ where: { venueId, id: { in: ids } }, orderBy: { id: 'asc' }, take: 20 })
  const activaciones = await prisma.giftCardActivity.count({ where: { venueId, giftCardId: { in: ids }, type: 'ACTIVATE' } })
  return { sobres: sobres.map(s => [s.status, s.balance.toFixed(2), s.expiresAt !== null]), activaciones }
}

describe('R8 · activación de sobres · Postgres real', () => {
  it('efectivo en vivo: la cuenta pagada deja sus sobres ACTIVE, con saldo, vigencia congelada y su ACTIVATE', async () => {
    const r = await cuenta(`${SUF}-vivo`, [500, 1000])
    await payCashOrder(venueId, r.orderId, { amount: 150000, tip: 0, staffId, idempotencyKey: `${SUF}-cobro-vivo` })
    const ids = r.sobres.map(s => s.id).sort()
    expect(await estadoDe(ids)).toEqual({
      sobres: [
        ['ACTIVE', r.sobres.find(s => s.id === ids[0])!.monto.toFixed(2), true],
        ['ACTIVE', r.sobres.find(s => s.id === ids[1])!.monto.toFixed(2), true],
      ],
      activaciones: 2,
    })
  })

  it('🔴 C1 (cierre): creada SIN source y cobrada en la TERMINAL (`recordOrderPayment`) ⇒ sobres ACTIVE y ningún comando a SoftRestaurant', async () => {
    const r = await cuenta(`${SUF}-terminal`, [400])
    const orden = await prisma.order.findUniqueOrThrow({ where: { id: r.orderId }, select: { source: true, externalId: true } })
    expect(orden.source).not.toBe('POS')
    expect(orden.externalId).toBe(`giftcard:${SUF}-terminal`)
    jest.mocked(publishCommand).mockClear()

    await recordOrderPayment(
      venueId,
      r.orderId,
      {
        venueId,
        amount: 40000,
        tip: 0,
        status: 'COMPLETED',
        method: 'CASH',
        source: 'TPV',
        splitType: 'CUSTOMAMOUNT',
        tpvId: `tpv-${SUF}`,
        staffId,
        paidProductsId: [],
        idempotencyKey: `${SUF}-cobro-terminal`,
        currency: 'MXN',
        isInternational: false,
      } as never,
      staffId,
    )

    expect(await estadoDe([r.sobres[0].id])).toEqual({ sobres: [['ACTIVE', '400.00', true]], activaciones: 1 })
    expect(await prisma.order.findUniqueOrThrow({ where: { id: r.orderId }, select: { paymentStatus: true } })).toEqual({
      paymentStatus: 'PAID',
    })
    const aSoftRestaurant = jest.mocked(publishCommand).mock.calls.filter(([canal]) => String(canal).startsWith('command.softrestaurant.'))
    expect(aSoftRestaurant).toEqual([])
  })

  it('🔴 PAY_CASH reproducido de una app vieja (dinero real cobrado sin red): se acepta y activa', async () => {
    const r = await cuenta(`${SUF}-cola`, [700])
    await payCashOrder(venueId, r.orderId, { amount: 70000, tip: 0, staffId, idempotencyKey: `${SUF}-intent`, isOfflineReplay: true })
    expect(await estadoDe([r.sobres[0].id])).toEqual({ sobres: [['ACTIVE', '700.00', true]], activaciones: 1 })
  })

  it('🔴 liquidar desde el dashboard activa los sobres en la misma transacción', async () => {
    const r = await cuenta(`${SUF}-liquida`, [800])
    await settleOrder(venueId, r.orderId, 'Pagó en caja', staffId)
    expect(await estadoDe([r.sobres[0].id])).toEqual({ sobres: [['ACTIVE', '800.00', true]], activaciones: 1 })
  })

  it('si lo cobrado no cuadra (cobro externo de más), NO activa y deja un MoneyAnomaly', async () => {
    const r = await cuenta(`${SUF}-descuadre`, [500])
    await payCashOrder(venueId, r.orderId, {
      amount: 70000,
      tip: 0,
      staffId,
      idempotencyKey: `${SUF}-cobro-de-mas`,
      method: 'CREDIT_CARD',
      externalSource: 'Terminal externa',
    })
    expect(await estadoDe([r.sobres[0].id])).toEqual({ sobres: [['PENDING', '0.00', false]], activaciones: 0 })
    const anomalia = await prisma.moneyAnomaly.findFirst({
      where: { category: 'GIFT_CARD_ACTIVATION_AMOUNT_MISMATCH', stripeEventId: `giftcard:ACTIVATION_AMOUNT_MISMATCH:${r.orderId}` },
    })
    expect(anomalia?.observedState).toMatchObject({ cobrado: '700.00', esperado: '500.00' })
  })

  it('🔴 ruling A6: cancelada (sobres DEACTIVATED) y luego cobrada por la cola sin red: se reabre y queda pagada, los sobres siguen DEACTIVATED y queda UN MoneyAnomaly', async () => {
    const r = await cuenta(`${SUF}-cancelada`, [600])
    await cancelOrder(venueId, r.orderId, 'El cliente ya no la quiso', staffId)
    expect(await estadoDe([r.sobres[0].id])).toEqual({ sobres: [['DEACTIVATED', '0.00', false]], activaciones: 0 })

    // El efectivo ya se cobró sin red antes de que llegara la cancelación: la cola lo reproduce y la cuenta se reabre.
    await payCashOrder(venueId, r.orderId, { amount: 60000, tip: 0, staffId, idempotencyKey: `${SUF}-tardio`, isOfflineReplay: true })

    const venta = await prisma.order.findUniqueOrThrow({ where: { id: r.orderId }, select: { status: true, paymentStatus: true } })
    expect(venta).toEqual({ status: 'COMPLETED', paymentStatus: 'PAID' })
    expect(await estadoDe([r.sobres[0].id])).toEqual({ sobres: [['DEACTIVATED', '0.00', false]], activaciones: 0 })
    const anomalias = await anomaliasDe(r.orderId)
    expect(anomalias.map(a => [a.category, a.stripeEventId])).toEqual([
      ['GIFT_CARD_PAID_WITH_DEACTIVATED', `giftcard:PAID_WITH_DEACTIVATED:${r.orderId}`],
    ])
    expect(anomalias[0].observedState).toEqual({
      motivo: 'COBRO_CON_SOBRES_DESACTIVADOS',
      orderId: r.orderId,
      cobrado: '600.00',
      reembolsado: '0.00',
      // B7 r1: la medición compartida con la noche dice también lo conservado, lo que canjearon los desactivados y el respaldo.
      conservado: '600.00',
      canjeado: '0.00',
      respaldo: '0.00',
      sobres: [{ id: r.sobres[0].id, status: 'DEACTIVATED' }],
    })

    // A6 r1: la activación se vuelve a pedir (otro cierre, la revisión) sobre la MISMA cuenta: sigue UNA sola anomalía.
    await prisma.$transaction(tx => activarSobresDeCuentaPagadaEnTx(tx, { venueId, orderId: r.orderId, staffId }))
    expect((await anomaliasDe(r.orderId)).map(a => a.category)).toEqual(['GIFT_CARD_PAID_WITH_DEACTIVATED'])
    expect(await estadoDe([r.sobres[0].id])).toEqual({ sobres: [['DEACTIVATED', '0.00', false]], activaciones: 0 })
  })

  it('🔴 r1: pagada, devuelta completa y con su sobre DEACTIVATED; un cobro tardío de la terminal NO lo revive y deja UNA anomalía (también al volver a saldar)', async () => {
    const r = await cuenta(`${SUF}-devuelta`, [900])
    await payCashOrder(venueId, r.orderId, { amount: 90000, tip: 0, staffId, idempotencyKey: `${SUF}-cobro-devuelta` })
    const sobreId = r.sobres[0].id
    expect(await estadoDe([sobreId])).toEqual({ sobres: [['ACTIVE', '900.00', true]], activaciones: 1 })

    // El estado que deja «Cancelar venta» con su reembolso (R2). Su camino (B1/B2) aún no existe: las filas se escriben a mano,
    // igual que las escribiría `desactivarSobresDeCuentaEnTx` (REFUND negativo, sobre en 0 y su DEACTIVATE ligado al reembolso).
    const reembolso = await prisma.payment.create({
      data: {
        venueId,
        orderId: r.orderId,
        amount: new Prisma.Decimal(-900),
        tipAmount: 0,
        method: 'CASH',
        source: 'OTHER',
        status: 'COMPLETED',
        type: 'REFUND',
        feePercentage: 0,
        feeAmount: 0,
        netAmount: new Prisma.Decimal(-900),
      },
    })
    await prisma.giftCard.update({ where: { id: sobreId }, data: { status: 'DEACTIVATED', balance: 0, deactivatedAt: new Date() } })
    await prisma.giftCardActivity.create({
      data: {
        giftCardId: sobreId,
        venueId,
        type: 'DEACTIVATE',
        amount: 900,
        balanceAfter: 0,
        reason: 'SALE_CANCELLED',
        refundPaymentId: reembolso.id,
        orderId: r.orderId,
        staffId,
      },
    })

    // Un cobro tardío (o duplicado) de la terminal sobre la cuenta ya saldada: el mismo cierre que `recordOrderPayment`.
    const cobroDeTerminal = (llave: string) =>
      prisma.$transaction(async tx => {
        await lockExistingOrderForPayment(tx, { venueId, orderId: r.orderId })
        const pago = await tx.payment.create({
          data: {
            venueId,
            orderId: r.orderId,
            amount: 900,
            tipAmount: 0,
            method: 'CREDIT_CARD',
            source: 'TPV',
            status: 'COMPLETED',
            type: 'REGULAR',
            feePercentage: 0,
            feeAmount: 0,
            netAmount: 900,
            idempotencyKey: llave,
          },
        })
        return settleStandalonePaymentInTx(tx, venueId, r.orderId, pago, staffId)
      })

    expect(await cobroDeTerminal(`${SUF}-terminal-1`)).toMatchObject({ firstSettlement: false })
    expect(await estadoDe([sobreId])).toEqual({ sobres: [['DEACTIVATED', '0.00', true]], activaciones: 1 })
    const anomalias = await anomaliasDe(r.orderId)
    expect(anomalias.map(a => [a.category, a.stripeEventId])).toEqual([
      ['GIFT_CARD_PAID_WITH_DEACTIVATED', `giftcard:PAID_WITH_DEACTIVATED:${r.orderId}`],
    ])
    expect(anomalias[0].observedState).toEqual({
      motivo: 'COBRO_CON_SOBRES_DESACTIVADOS',
      orderId: r.orderId,
      cobrado: '1800.00',
      reembolsado: '900.00',
      // B7 r1: la medición compartida con la noche dice también lo conservado, lo que canjearon los desactivados y el respaldo.
      conservado: '900.00',
      canjeado: '0.00',
      respaldo: '0.00',
      sobres: [{ id: sobreId, status: 'DEACTIVATED' }],
    })

    // A6 r1: volver a saldar (otro cobro duplicado) re-entra a la misma rama: sigue UNA sola fila.
    await cobroDeTerminal(`${SUF}-terminal-2`)
    expect((await anomaliasDe(r.orderId)).map(a => a.category)).toEqual(['GIFT_CARD_PAID_WITH_DEACTIVATED'])
    expect(await estadoDe([sobreId])).toEqual({ sobres: [['DEACTIVATED', '0.00', true]], activaciones: 1 })
  })

  it('🔴 S1: efectivo tardío sobre una venta de tarjetas devuelta deja la anomalía al momento', async () => {
    const r = await cuenta(`${SUF}-s1-devuelta`, [500])
    await payCashOrder(venueId, r.orderId, { amount: 50000, tip: 0, staffId, idempotencyKey: `${SUF}-s1-cobro` })
    const sobreId = r.sobres[0].id

    // Cancelada y devuelta: REFUND negativo, el sobre en 0 con su DEACTIVATE ligado al reembolso y la venta REFUNDED.
    const reembolso = await prisma.payment.create({
      data: {
        venueId,
        orderId: r.orderId,
        amount: new Prisma.Decimal(-500),
        tipAmount: 0,
        method: 'CASH',
        source: 'OTHER',
        status: 'COMPLETED',
        type: 'REFUND',
        feePercentage: 0,
        feeAmount: 0,
        netAmount: new Prisma.Decimal(-500),
      },
    })
    await prisma.giftCard.update({ where: { id: sobreId }, data: { status: 'DEACTIVATED', balance: 0, deactivatedAt: new Date() } })
    await prisma.giftCardActivity.create({
      data: {
        giftCardId: sobreId,
        venueId,
        type: 'DEACTIVATE',
        amount: 500,
        balanceAfter: 0,
        reason: 'SALE_CANCELLED',
        refundPaymentId: reembolso.id,
        orderId: r.orderId,
        staffId,
      },
    })
    await prisma.order.update({ where: { id: r.orderId }, data: { paymentStatus: 'REFUNDED' } })
    expect(await anomaliasDe(r.orderId)).toEqual([])

    // La cola sin red reproduce el efectivo que se cobró antes de la devolución.
    await payCashOrder(venueId, r.orderId, { amount: 50000, tip: 0, staffId, idempotencyKey: `${SUF}-s1-tardio`, isOfflineReplay: true })

    // S1: la venta sigue cerrada; la anomalía ya está, sin correr la revisión nocturna; el sobre NO revive.
    expect(await prisma.order.findUniqueOrThrow({ where: { id: r.orderId }, select: { paymentStatus: true } })).toEqual({
      paymentStatus: 'REFUNDED',
    })
    const anomalias = await anomaliasDe(r.orderId)
    expect(anomalias.map(a => [a.category, a.stripeEventId])).toEqual([
      ['GIFT_CARD_PAID_WITH_DEACTIVATED', `giftcard:PAID_WITH_DEACTIVATED:${r.orderId}`],
    ])
    expect(anomalias[0].observedState).toMatchObject({ cobrado: '1000.00', reembolsado: '500.00', conservado: '500.00', respaldo: '0.00' })
    expect(await estadoDe([sobreId])).toEqual({ sobres: [['DEACTIVATED', '0.00', true]], activaciones: 1 })
  })
})
