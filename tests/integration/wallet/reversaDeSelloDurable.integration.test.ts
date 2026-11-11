/** S4: reembolso y libreta reales; se omite sólo la vía rápida para representar la caída tras el commit. */
import '../../__helpers__/integration-setup'
import cuid from 'cuid'
import prisma from '@/utils/prismaClient'
import { Prisma } from '@prisma/client'
import * as stamps from '@/services/wallet/stampLedger.service'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { PaymentEffectsJob } from '@/jobs/payment-effects.job'
import { enqueueLoyaltyReversalsInTx, type PaymentEffectClaim } from '@/services/tpv/paymentEffects.service'
import { abrirTurno, sembrarCobro } from '../dashboard/sembrarCobroParaReembolso'
import { crearNegocioDePrueba, limpiarNegocioDePrueba } from '../giftCards/sembrarTarjetasDeRegalo'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { broadcastToUser: jest.fn(), getBroadcastingService: jest.fn(() => null) },
}))
jest.mock('@/communication/sockets/managers/socketManager', () => {
  const sm = { getServer: jest.fn(), getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() }
  return { __esModule: true, default: sm, socketManager: sm }
})
jest.mock('@/services/tpv/digitalReceipt.tpv.service', () => ({ generateDigitalReceipt: jest.fn().mockResolvedValue(null) }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn().mockResolvedValue(null) }))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({ notifyCustomerPassUpdated: jest.fn() }))
jest.mock('@/services/wallet/firstStampEmail.service', () => ({ sendFirstStampEmailIfDue: jest.fn() }))
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasFeatureAccess: jest.fn().mockResolvedValue(true),
}))

let venueId: string
let staffId: string

beforeAll(async () => {
  ;({ venueId, staffId } = await crearNegocioDePrueba('reversa-sello-durable'))
  await abrirTurno(venueId, staffId)
  await prisma.loyaltyConfig.create({ data: { venueId, active: true, stampsEnabled: true, stampsRequired: 100, maxStampsPerDay: 1 } })
})
afterAll(async () => {
  jest.restoreAllMocks()
  if (!venueId) return
  await prisma.stampEvent.deleteMany({ where: { venueId } })
  await prisma.stampCard.deleteMany({ where: { venueId } })
  await limpiarNegocioDePrueba(venueId)
  await prisma.shift.deleteMany({ where: { venueId } })
  await prisma.customer.deleteMany({ where: { venueId } })
  await prisma.loyaltyConfig.deleteMany({ where: { venueId } })
  await prisma.$disconnect()
})

async function ventaSellada() {
  const customer = await prisma.customer.create({ data: { venueId, firstName: 'Ana S4' } })
  const { order, pago } = await sembrarCobro({ venueId, staffId, saleCents: 10000, commissionPercent: null })
  await prisma.order.update({ where: { id: order.id }, data: { customerId: customer.id } })
  await prisma.onlineOrder.create({
    data: {
      venueId,
      orderId: order.id,
      trackingToken: cuid(),
      paymentMode: 'PAY_AT_PICKUP',
      requiresAcceptance: false,
      status: 'ACCEPTED',
      acceptDeadlineAt: new Date(Date.now() + 30 * 60000),
    },
  })
  expect((await stamps.grantStamp(venueId, customer.id, order.id)).granted).toBe(true)
  return { orderId: order.id, paymentId: pago.id, customerId: customer.id }
}

async function reembolsarSinViaRapida(paymentId: string, amount: number, key = cuid()) {
  const fast = jest.spyOn(stamps, 'reverseStampForOrder').mockResolvedValue({ reversed: false })
  try {
    const r = await issueRefund({ venueId, paymentId, amount, reason: 'RETURNED_GOODS', staffId, idempotencyKey: key })
    expect(fast).toHaveBeenCalledTimes(1)
    return r
  } finally {
    fast.mockRestore()
  }
}

/** Sólo reclama la fila de ESTE ensayo; el worker, consumidor, fence de cierre y fail son los de producción. */
async function trabajador(refundPaymentId: string) {
  const row = await prisma.paymentEffect.findFirstOrThrow({ where: { venueId, paymentId: refundPaymentId, kind: 'STAMP_REVERSAL' } })
  const claimToken = cuid()
  const leaseUntil = new Date(Date.now() + 120000)
  await prisma.paymentEffect.update({
    where: { id: row.id },
    data: { status: 'PROCESSING', claimToken, leaseUntil, attempts: { increment: 1 } },
  })
  const claim = { ...row, claimToken, leaseUntil, attempts: row.attempts + 1 } as PaymentEffectClaim
  const job = new PaymentEffectsJob({ cron: { start: jest.fn(), stop: jest.fn() }, claim: async () => [claim] })
  expect(await job.runNow()).toEqual({ applied: 1, failed: 0, skipped: 0 })
  return prisma.paymentEffect.findUniqueOrThrow({ where: { id: row.id } })
}

describe('reversa de sello durable · Postgres', () => {
  it('reembolso total sin vía rápida deja ambos efectos con el dinero; el worker quita el sello y termina DONE', async () => {
    const s = await ventaSellada()
    const r = await reembolsarSinViaRapida(s.paymentId, 10000)
    expect(await prisma.payment.count({ where: { venueId, id: r.refundId, type: 'REFUND', status: 'COMPLETED' } })).toBe(1)
    const pending = await prisma.paymentEffect.findMany({ where: { venueId, paymentId: r.refundId }, take: 10 })
    expect(pending.map(e => e.kind)).toEqual(expect.arrayContaining(['LOYALTY_POINTS_REVERSAL', 'STAMP_REVERSAL']))
    expect(await prisma.stampEvent.count({ where: { orderId: s.orderId, type: 'REVERSAL' } })).toBe(0)
    const e = await trabajador(r.refundId)
    expect(e).toMatchObject({ status: 'DONE', completedAt: expect.any(Date), claimToken: null })
    expect(await prisma.stampEvent.count({ where: { orderId: s.orderId, type: 'REVERSAL' } })).toBe(1)
    const card = await prisma.stampCard.findFirstOrThrow({ where: { venueId, customerId: s.customerId } })
    expect(card.stampsEarned).toBe(0)
  })

  it('dos reembolsos parciales de la misma venta quitan un sello; repetir la llave no crea efectos ni cambia snapshot', async () => {
    const s = await ventaSellada()
    const key = cuid()
    const r1 = await reembolsarSinViaRapida(s.paymentId, 4000, key)
    const original = await prisma.paymentEffect.findFirstOrThrow({ where: { venueId, paymentId: r1.refundId, kind: 'STAMP_REVERSAL' } })
    const replay = await issueRefund({
      venueId,
      paymentId: s.paymentId,
      amount: 4000,
      reason: 'RETURNED_GOODS',
      staffId,
      idempotencyKey: key,
    })
    expect(replay.refundId).toBe(r1.refundId)
    expect(await prisma.paymentEffect.findFirstOrThrow({ where: { id: original.id } })).toEqual(original)
    const r2 = await reembolsarSinViaRapida(s.paymentId, 6000)
    await trabajador(r1.refundId)
    await trabajador(r2.refundId)
    expect(await prisma.stampEvent.count({ where: { orderId: s.orderId, type: 'REVERSAL' } })).toBe(1)
    expect((await prisma.stampCard.findFirstOrThrow({ where: { venueId, customerId: s.customerId } })).stampsEarned).toBe(0)
  })

  it('un fallo DESPUÉS de escribir las dos obligaciones revierte también el dinero; sin refund no queda obligación', async () => {
    const { order, pago } = await sembrarCobro({ venueId, staffId, saleCents: 10000, commissionPercent: null })
    const refundId = cuid()
    await expect(
      prisma.$transaction(async tx => {
        await tx.payment.create({
          data: {
            id: refundId,
            venueId,
            orderId: order.id,
            type: 'REFUND',
            status: 'COMPLETED',
            method: 'CASH',
            source: 'TPV',
            amount: new Prisma.Decimal(-100),
            netAmount: new Prisma.Decimal(-100),
            feePercentage: 0,
            feeAmount: 0,
            splitType: 'FULLPAYMENT',
            processorData: { originalPaymentId: pago.id },
          },
        })
        await enqueueLoyaltyReversalsInTx(tx, { venueId, refundPaymentId: refundId, orderId: order.id })
        expect(
          await tx.paymentEffect.count({ where: { paymentId: refundId, kind: { in: ['LOYALTY_POINTS_REVERSAL', 'STAMP_REVERSAL'] } } }),
        ).toBe(2)
        throw new Error('S4 fallo después de las dos obligaciones')
      }),
    ).rejects.toThrow('S4 fallo después de las dos obligaciones')
    expect(await prisma.payment.count({ where: { id: refundId, venueId } })).toBe(0)
    expect(await prisma.paymentEffect.count({ where: { paymentId: refundId, venueId } })).toBe(0)
  })
})
