/**
 * R8 contra Postgres REAL: una cuenta de tarjetas pagada en efectivo (en vivo y por la cola sin red) o liquidada desde
 * el dashboard deja sus sobres ACTIVE con su ACTIVATE; si lo cobrado no cuadra con los sobres, no activa y deja un
 * MoneyAnomaly. Ruling A6: una cuenta CANCELADA (sobres DEACTIVATED) que recibe dinero tarde se reabre y queda pagada,
 * pero sus sobres NO se reviven y queda un MoneyAnomaly propio.
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

import prisma from '@/utils/prismaClient'
import { createGiftCardOrder } from '@/services/giftCards/giftCardOrder.service'
import { cancelOrder, payCashOrder } from '@/services/mobile/order.mobile.service'
import { settleOrder } from '@/services/dashboard/order.dashboard.service'

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

async function cuenta(llave: string, montos: number[]) {
  return createGiftCardOrder(venueId, staffId, {
    idempotencyKey: llave,
    sobres: montos.map(amount => ({ amount, deliveryChannel: 'HANDED_TO_BUYER' as const })),
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
    const anomalias = await prisma.moneyAnomaly.findMany({
      where: { stripeEventId: { startsWith: 'giftcard:' }, expectedState: { path: ['id'], equals: r.orderId } },
      take: 10,
    })
    expect(anomalias.map(a => [a.category, a.stripeEventId])).toEqual([
      ['GIFT_CARD_PAID_WITH_DEACTIVATED', `giftcard:PAID_WITH_DEACTIVATED:${r.orderId}`],
    ])
    expect(anomalias[0].observedState).toEqual({
      motivo: 'COBRO_CON_SOBRES_DESACTIVADOS',
      orderId: r.orderId,
      cobrado: '600.00',
      reembolsado: '0.00',
      sobres: [{ id: r.sobres[0].id, status: 'DEACTIVATED' }],
    })
  })
})
