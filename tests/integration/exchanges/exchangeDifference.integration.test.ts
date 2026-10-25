import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { createExchange, type CreateExchangeBody } from '@/services/exchanges/exchange.service'
import { createTenderType } from '@/services/dashboard/tenderType.dashboard.service'
import { postCashRefundToDrawer, postCashSaleToDrawer } from '@/services/shared/cashDrawerPosting'
import { ensureExchangeCreditTender } from '@/services/exchanges/exchangeCreditTender'
import { ensureGiftCardTender, resolveGiftCardTenderForChargeInTx } from '@/services/giftCards/giftCardTender'
import { canjearSobresEnTx, lockGiftCardsForUpdate } from '@/services/giftCards/giftCardLedger'
import { bloquearSobresDelReembolsoEnTx, alRegistrarReembolsoEnTx } from '@/services/giftCards/giftCardCancel.service'
import { enqueuePaymentCommissionInTx, runClaimedPaymentEffect } from '@/services/tpv/paymentEffects.service'
import { WHERE_PAYMENT_IS_NOT_EXCHANGE_CREDIT } from '@/services/exchanges/exchangeMarks'
import { metodoParaAlcanceFiscal, paymentInFiscalScope } from '@/services/fiscal/fiscalScope'
import { writeRefundInTx } from '@/services/shared/writeRefundInTx'
import { seedClothingSale } from './seedExchange'
import { sembrarVentaDeTarjetas } from '../giftCards/sembrarTarjetasDeRegalo'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn(async () => undefined) }))
jest.mock('@/services/shared/cashDrawerPosting', () => {
  const real = jest.requireActual('@/services/shared/cashDrawerPosting')
  return {
    ...real,
    postCashRefundToDrawer: jest.fn((...args: unknown[]) => real.postCashRefundToDrawer(...args)),
    postCashSaleToDrawer: jest.fn((...args: unknown[]) => real.postCashSaleToDrawer(...args)),
  }
})
jest.mock('@/services/shared/writeRefundInTx', () => ({
  ...jest.requireActual('@/services/shared/writeRefundInTx'),
  writeRefundInTx: jest.fn((...args: unknown[]) => jest.requireActual('@/services/shared/writeRefundInTx').writeRefundInTx(...args)),
}))
jest.mock('@/services/giftCards/giftCardCancel.service', () => {
  const real = jest.requireActual('@/services/giftCards/giftCardCancel.service')
  return {
    ...real,
    bloquearSobresDelReembolsoEnTx: jest.fn((...args: unknown[]) => real.bloquearSobresDelReembolsoEnTx(...args)),
    alRegistrarReembolsoEnTx: jest.fn((...args: unknown[]) => real.alRegistrarReembolsoEnTx(...args)),
  }
})

jest.setTimeout(60000)
type Seed = Awaited<ReturnType<typeof seedClothingSale>>
const fixtures: Seed[] = []
async function seed(opts?: Parameters<typeof seedClothingSale>[0]) {
  const s = await seedClothingSale(opts)
  fixtures.push(s)
  await ensureExchangeCreditTender(prisma, s.venueId)
  return s
}
async function difference(s: Seed, taken: number, method: CreateExchangeBody['settlement']['method'] = 'CASH') {
  await prisma.product.update({ where: { id: s.products[3].id }, data: { price: new Prisma.Decimal(taken) } })
  const delta = new Prisma.Decimal(taken)
    .minus(s.payments.reduce((sum, p) => sum.plus(p.amount), new Prisma.Decimal(0)))
    .mul(100)
    .toNumber()
  return s.body({
    taken: [{ productId: s.products[3].id, quantity: 1 }],
    settlement: { kind: delta > 0 ? 'COLLECT' : 'PAYOUT', method, expectedDifferenceCents: delta, cashDrawerSessionId: s.drawer.id },
  })
}
const paymentsOf = (s: Seed, orderId: string) =>
  prisma.payment.findMany({ where: { venueId: s.venueId, orderId }, take: 20, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
const eventsOf = (s: Seed) => prisma.cashDrawerEvent.findMany({ where: { venueId: s.venueId }, take: 20 })
async function expectNoExchange(s: Seed, before: number) {
  expect(await prisma.exchange.count({ where: { venueId: s.venueId } })).toBe(0)
  expect(await prisma.payment.count({ where: { venueId: s.venueId } })).toBe(before)
  expect(await prisma.order.count({ where: { venueId: s.venueId } })).toBe(1)
  expect(await prisma.inventoryPosting.count({ where: { venueId: s.venueId } })).toBe(0)
  expect(await eventsOf(s)).toEqual([])
}
beforeAll(() => expect(new URL(process.env.TEST_DATABASE_URL!).pathname).toMatch(/^\/avoqado_cambio_(r5_)?test_202610(20|24)$/))
beforeEach(() => jest.clearAllMocks())
afterEach(() => jest.restoreAllMocks())
afterAll(async () => {
  for (const s of fixtures) await s.cleanup()
  await prisma.$disconnect()
})

describe('exchange difference without a terminal (RF2)', () => {
  it('V4 COLLECT CASH +100: EC 350 then cash 100, one drawer sale and commission, points only on 100 without stamps or referral', async () => {
    const s = await seed({ paid: 350 })
    await prisma.venue.update({ where: { id: s.venueId }, data: { seatCapExempt: true } })
    const b = await difference(s, 450)
    const input = s.input(b)
    const { exchange: e } = await createExchange(input)
    expect(e).toMatchObject({ status: 'COMPLETED', settlement: { kind: 'COLLECT', method: 'CASH', amountCents: 10000 } })
    const rows = await paymentsOf(s, e.newOrderId)
    expect(rows.map(p => [p.method, Number(p.amount), p.fundsFlow])).toEqual([
      ['OTHER', 350, 'EXTERNAL_RECORDED'],
      ['CASH', 100, 'CASH_DRAWER'],
    ])
    expect((await prisma.order.findUniqueOrThrow({ where: { id: e.newOrderId } })).paymentStatus).toBe('PAID')
    expect((await eventsOf(s)).map(p => [p.type, Number(p.amount), p.sessionId])).toEqual([['CASH_SALE', 100, s.drawer.id]])
    expect(Number((await prisma.shift.findUniqueOrThrow({ where: { id: s.shift.id } })).totalSales)).toBe(450)
    expect((await prisma.paymentEffect.findMany({ where: { venueId: s.venueId }, take: 20 })).map(p => [p.kind, p.paymentId])).toEqual([
      ['COMMISSION', rows[1].id],
    ])
    expect(await prisma.stampEvent.count({ where: { venueId: s.venueId } })).toBe(0)
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: s.customer.id } })
    expect([customer.loyaltyPoints, customer.totalVisits, Number(customer.totalSpent)]).toEqual([120, 3, 600])
    expect(await createExchange(input)).toEqual({ exchange: e, replay: true })
    expect(await eventsOf(s)).toHaveLength(1)
    expect(bloquearSobresDelReembolsoEnTx).not.toHaveBeenCalled()
    expect(alRegistrarReembolsoEnTx).not.toHaveBeenCalled()
  })

  it('COLLECT BANK_TRANSFER records external money without a drawer event', async () => {
    const s = await seed()
    const { exchange: e } = await createExchange(s.input(await difference(s, 600, 'BANK_TRANSFER')))
    const rows = await paymentsOf(s, e.newOrderId)
    expect(rows[1]).toMatchObject({ method: 'BANK_TRANSFER', fundsFlow: 'EXTERNAL_RECORDED', tenderTypeId: null })
    expect(Number(rows[1].amount)).toBe(100)
    expect(await eventsOf(s)).toEqual([])
  })

  it.each([false, true])('COLLECT TENDER keeps its frozen snapshot and physical-cash semantics (%s)', async countsAsPhysicalCash => {
    const s = await seed()
    const tender = await createTenderType(
      s.venueId,
      { name: 'Vale local', countsAsPhysicalCash, captureTip: false, satFormaPago: '01' },
      s.staffId,
    )
    const b = await difference(s, 600, 'TENDER')
    b.settlement.tenderTypeId = tender.id
    b.settlement.tenderRevision = tender.revision
    const { exchange: e } = await createExchange(s.input(b))
    const rows = await paymentsOf(s, e.newOrderId)
    expect(rows[1]).toMatchObject({
      method: 'OTHER',
      tenderTypeId: tender.id,
      tenderRevision: 1,
      tenderLabel: 'Vale local',
      tenderCountsAsCash: countsAsPhysicalCash,
      tenderCaptureTip: false,
      tenderSatFormaPago: '01',
    })
    expect((await eventsOf(s)).map(p => [p.type, Number(p.amount)])).toEqual(countsAsPhysicalCash ? [['CASH_SALE', 100]] : [])
  })

  it('COLLECT TENDER rejects the system credit tender and rolls back the refund and new sale', async () => {
    const s = await seed()
    const tender = await ensureExchangeCreditTender(prisma, s.venueId)
    const b = await difference(s, 600, 'TENDER')
    b.settlement.tenderTypeId = tender.id
    b.settlement.tenderRevision = tender.revision
    await expect(createExchange(s.input(b))).rejects.toMatchObject({ statusCode: 400 })
    await expectNoExchange(s, 1)
  })

  it.each([
    ['COLLECT', 'GIFT_CARD_BALANCE', 'GIFT_CARD_COLLECT_NOT_AVAILABLE'],
    ['COLLECT', 'CARD_TERMINAL', 'CARD_TERMINAL_NOT_ENABLED'],
    ['PAYOUT', 'CARD_TERMINAL', 'CARD_TERMINAL_NOT_ENABLED'],
  ] as const)('%s %s is unavailable and writes no exchange', async (kind, method, reason) => {
    const s = await seed()
    const b = await difference(s, kind === 'COLLECT' ? 600 : 400, method)
    await expect(createExchange(s.input(b))).rejects.toMatchObject({
      code: 'EXCHANGE_SETTLEMENT_UNAVAILABLE',
      statusCode: 422,
      details: { reason },
    })
    await expectNoExchange(s, 1)
  })

  it.each([
    [100, 100.01],
    [0.01, 100],
  ])('COLLECT handles one-cent credit or difference (%s to %s)', async (paid, taken) => {
    const s = await seed({ paid, list: paid })
    const { exchange: e } = await createExchange(s.input(await difference(s, taken)))
    expect(e.status).toBe('COMPLETED')
    expect(e.paymentIds).toHaveLength(2)
    const order = await prisma.order.findUniqueOrThrow({ where: { id: e.newOrderId } })
    expect(order.paymentStatus).toBe('PAID')
    expect(Number(order.paidAmount)).toBe(taken)
  })

  it('V5 PAYOUT CASH -110: only 110 leaves the drawer and reverses commission, original referral stays qualified', async () => {
    const s = await seed()
    await prisma.commissionConfig.updateMany({ where: { venueId: s.venueId }, data: { includeTax: true } })
    await prisma.$transaction(tx => enqueuePaymentCommissionInTx(tx, s.payments[0].id))
    const originalEffect = await prisma.paymentEffect.findFirstOrThrow({ where: { paymentId: s.payments[0].id, kind: 'COMMISSION' } })
    const token = `test-${originalEffect.id}`
    const leaseUntil = new Date(Date.now() + 60000)
    await prisma.paymentEffect.update({ where: { id: originalEffect.id }, data: { status: 'PROCESSING', claimToken: token, leaseUntil } })
    await runClaimedPaymentEffect({
      ...originalEffect,
      payload: originalEffect.payload as Prisma.InputJsonValue,
      kind: 'COMMISSION',
      claimToken: token,
      leaseUntil,
    })
    const referrer = await prisma.customer.create({ data: { venueId: s.venueId, firstName: 'Referente' } })
    const referral = await prisma.referral.create({
      data: {
        venueId: s.venueId,
        referrerCustomerId: referrer.id,
        referredCustomerId: s.customer.id,
        qualifyingOrderId: s.order.id,
        status: 'QUALIFIED',
        qualifiedAt: new Date(),
      },
    })
    const { exchange: e } = await createExchange(s.input(await difference(s, 390)))
    expect(e.settlement).toMatchObject({ kind: 'PAYOUT', method: 'CASH', amountCents: 11000 })
    const refunds = (await paymentsOf(s, s.order.id)).filter(p => p.type === 'REFUND')
    expect(refunds.map(p => [p.method, Number(p.amount), (p.processorData as any).exchange.role])).toEqual([
      ['CASH', -110, 'DIFFERENCE'],
      ['OTHER', -390, 'CREDIT'],
    ])
    expect((await eventsOf(s)).map(p => [p.type, Number(p.amount), p.orderId])).toEqual([['PAY_OUT', 110, s.order.id]])
    expect(Number((await prisma.shift.findUniqueOrThrow({ where: { id: s.shift.id } })).totalSales)).toBe(390)
    const effects = await prisma.paymentEffect.findMany({ where: { venueId: s.venueId, paymentId: { in: e.refundPaymentIds } }, take: 10 })
    expect(effects.find(p => p.kind === 'COMMISSION')).toMatchObject({ paymentId: refunds[0].id, payload: { netCommission: '-5.5' } })
    expect(effects.every(p => p.paymentId === refunds[0].id)).toBe(true)
    for (const effect of effects.filter(p => p.kind === 'REFERRAL')) {
      const claimToken = `test-${effect.id}`
      await prisma.paymentEffect.update({ where: { id: effect.id }, data: { status: 'PROCESSING', claimToken, leaseUntil } })
      await runClaimedPaymentEffect({
        ...effect,
        payload: effect.payload as Prisma.InputJsonValue,
        kind: 'REFERRAL',
        claimToken,
        leaseUntil,
      })
    }
    expect((await prisma.referral.findUniqueOrThrow({ where: { id: referral.id } })).status).toBe('QUALIFIED')
    expect(await prisma.stampEvent.count({ where: { venueId: s.venueId } })).toBe(0)
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: s.customer.id } })).loyaltyPoints).toBe(20)
  })

  it('PAYOUT CASH from transfer requires cashFromNonCash and then writes actual CASH semantics', async () => {
    const s = await seed()
    await prisma.payment.update({ where: { id: s.payments[0].id }, data: { method: 'BANK_TRANSFER', fundsFlow: 'EXTERNAL_RECORDED' } })
    const b = await difference(s, 400)
    await expect(createExchange(s.input(b))).rejects.toMatchObject({ statusCode: 422, details: { reason: 'NEEDS_REFUND_TO_CASH' } })
    await expectNoExchange(s, 1)
    b.settlement.cashFromNonCash = true
    const { exchange: e } = await createExchange(s.input(b))
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: e.refundPaymentIds[0] } })).toMatchObject({
      method: 'CASH',
      fundsFlow: 'CASH_DRAWER',
      tenderTypeId: null,
    })
    expect((await eventsOf(s)).map(p => [p.type, Number(p.amount)])).toEqual([['PAY_OUT', 100]])
  })

  it('PAYOUT BANK_TRANSFER from cash writes external semantics without moving the drawer', async () => {
    const s = await seed()
    const { exchange: e } = await createExchange(s.input(await difference(s, 400, 'BANK_TRANSFER')))
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: e.refundPaymentIds[0] } })).toMatchObject({
      method: 'BANK_TRANSFER',
      fundsFlow: 'EXTERNAL_RECORDED',
    })
    expect(await eventsOf(s)).toEqual([])
  })

  it('PAYOUT GIFT_CARD_BALANCE returns only D to the original card, credit calls no gift-card hook', async () => {
    const s = await seed()
    const sale = await sembrarVentaDeTarjetas({
      venueId: s.venueId,
      organizationId: s.organizationId,
      staffId: s.staffId,
      montos: [500],
      metodo: 'CASH',
    })
    await ensureGiftCardTender(prisma, s.venueId)
    await prisma.$transaction(async tx => {
      const tender = await resolveGiftCardTenderForChargeInTx(tx, s.venueId)
      await tx.payment.update({ where: { id: s.payments[0].id }, data: tender })
      const cards = await lockGiftCardsForUpdate(tx, sale.giftCardIds)
      await canjearSobresEnTx(tx, {
        venueId: s.venueId,
        orderId: s.order.id,
        paymentId: s.payments[0].id,
        amount: new Prisma.Decimal(500),
        cards,
        staffId: s.staffId,
      })
    })
    jest.clearAllMocks()
    const { exchange: e } = await createExchange(s.input(await difference(s, 390, 'GIFT_CARD_BALANCE')))
    const card = await prisma.giftCard.findUniqueOrThrow({ where: { id: sale.giftCardIds[0] } })
    expect(Number(card.balance)).toBe(110)
    expect(bloquearSobresDelReembolsoEnTx).toHaveBeenCalledTimes(1)
    expect(alRegistrarReembolsoEnTx).toHaveBeenCalledTimes(1)
    expect(jest.mocked(bloquearSobresDelReembolsoEnTx).mock.invocationCallOrder[0]).toBeLessThan(
      jest.mocked(writeRefundInTx).mock.invocationCallOrder[0],
    )
    expect(alRegistrarReembolsoEnTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ refundPaymentId: e.refundPaymentIds[0] }),
    )
    const reversals = await prisma.giftCardActivity.findMany({ where: { venueId: s.venueId, type: 'REDEEM_REVERSAL' }, take: 10 })
    expect(reversals.map(r => [r.refundPaymentId, Number(r.amount)])).toEqual([[e.refundPaymentIds[0], 110]])
    expect(await eventsOf(s)).toEqual([])
  })

  it('RF2 cash 400 + card 600: pays out 300 cash, credits 100 cash + 600 card without a card money refund', async () => {
    const s = await seed({ list: 1000, payments: [400, 600], card: true })
    await prisma.payment.update({
      where: { id: s.payments[0].id },
      data: { method: 'CASH', source: 'POS', fundsFlow: 'CASH_DRAWER', merchantAccountId: null },
    })
    const b = await difference(s, 700)
    b.originalPaymentId = s.payments[1].id
    const { exchange: e } = await createExchange(s.input(b))
    const refunds = (await paymentsOf(s, s.order.id)).filter(p => p.type === 'REFUND')
    expect(
      refunds.map(p => [Number(p.amount), (p.processorData as any).originalPaymentId, (p.processorData as any).exchange.role]),
    ).toEqual([
      [-300, s.payments[0].id, 'DIFFERENCE'],
      [-600, s.payments[1].id, 'CREDIT'],
      [-100, s.payments[0].id, 'CREDIT'],
    ])
    expect(refunds.filter(p => p.method === 'CREDIT_CARD')).toEqual([])
    expect((await eventsOf(s)).map(p => [p.type, Number(p.amount)])).toEqual([['PAY_OUT', 300]])
    for (const root of s.payments) {
      expect(
        refunds.filter(p => (p.processorData as any).originalPaymentId === root.id).reduce((sum, p) => sum - Number(p.amount), 0),
      ).toBeLessThanOrEqual(Number(root.amount))
    }
    expect(e.settlement.sources).toHaveLength(3)
  })

  it('RF2 rejects 700 cash when only 400 cash is refundable, with payoutOptions and no writes', async () => {
    const s = await seed({ list: 1000, payments: [400, 600], card: true })
    await prisma.payment.update({
      where: { id: s.payments[0].id },
      data: { method: 'CASH', fundsFlow: 'CASH_DRAWER', source: 'POS', merchantAccountId: null },
    })
    await expect(createExchange(s.input(await difference(s, 300)))).rejects.toMatchObject({
      statusCode: 422,
      details: {
        reason: 'INSUFFICIENT_FOR_METHOD',
        payoutOptions: expect.arrayContaining([expect.objectContaining({ method: 'CASH', maxCents: 40000 })]),
      },
    })
    await expectNoExchange(s, 2)
  })

  it('rolls back the money-moving PAYOUT and its effects when the following credit refund fails', async () => {
    const s = await seed()
    const real = jest.requireActual('@/services/shared/writeRefundInTx').writeRefundInTx
    jest.mocked(writeRefundInTx).mockImplementationOnce(real).mockRejectedValueOnce(new Error('SECOND_REFUND_FAILURE'))
    await expect(createExchange(s.input(await difference(s, 400)))).rejects.toThrow('SECOND_REFUND_FAILURE')
    await expectNoExchange(s, 1)
    expect(await prisma.paymentEffect.count({ where: { venueId: s.venueId } })).toBe(0)
    expect(Number((await prisma.shift.findUniqueOrThrow({ where: { id: s.shift.id } })).totalSales)).toBe(500)
  })

  it('second exchange PAYOUT inherits cash root, fiscal method and economic source; readers count the real refund', async () => {
    const s = await seed()
    const { exchange: first } = await createExchange(s.input())
    const b = await difference(s, 400)
    b.originalPaymentId = first.paymentIds[0]
    b.returned[0].orderItemId = first.lines.taken[0].newOrderItemIds[0]
    const { exchange: second } = await createExchange(s.input(b))
    const refund = await prisma.payment.findUniqueOrThrow({ where: { id: second.refundPaymentIds[0] } })
    expect(refund).toMatchObject({ method: 'CASH', fundsFlow: 'CASH_DRAWER', tenderTypeId: null })
    expect(refund.processorData).toMatchObject({
      originalPaymentId: first.paymentIds[0],
      originalMethod: 'CASH',
      rootPaymentId: s.payments[0].id,
      exchange: { role: 'DIFFERENCE', rootPaymentId: s.payments[0].id },
    })
    expect((await eventsOf(s)).map(p => [p.type, Number(p.amount)])).toEqual([['PAY_OUT', 100]])
    expect(await prisma.payment.count({ where: { venueId: s.venueId, id: refund.id, AND: [WHERE_PAYMENT_IS_NOT_EXCHANGE_CREDIT] } })).toBe(
      1,
    )
    expect(paymentInFiscalScope(metodoParaAlcanceFiscal(refund.method, refund.processorData), null, false)).toBe(false)
  })

  it.each(['transfer', 'other', 'terminal', 'merchant', 'settled', 'gift'] as const)(
    'second exchange cannot pay CASH from a %s root, even with cashFromNonCash',
    async kind => {
      const s = await seed({ card: kind === 'terminal' || kind === 'merchant' })
      if (kind === 'transfer' || kind === 'other')
        await prisma.payment.update({
          where: { id: s.payments[0].id },
          data: { method: kind === 'transfer' ? 'BANK_TRANSFER' : 'OTHER', fundsFlow: 'EXTERNAL_RECORDED' },
        })
      if (kind === 'merchant')
        await prisma.payment.update({ where: { id: s.payments[0].id }, data: { method: 'CASH', fundsFlow: 'CASH_DRAWER', source: 'POS' } })
      if (kind === 'settled') await prisma.payment.update({ where: { id: s.payments[0].id }, data: { fundsFlow: 'AVOQADO_PROCESSED' } })
      if (kind === 'gift') {
        const tender = await ensureGiftCardTender(prisma, s.venueId)
        await prisma.payment.update({
          where: { id: s.payments[0].id },
          data: { method: 'OTHER', fundsFlow: 'EXTERNAL_RECORDED', tenderTypeId: tender.id },
        })
      }
      const { exchange: first } = await createExchange(s.input())
      const b = await difference(s, 400)
      b.originalPaymentId = first.paymentIds[0]
      b.returned[0].orderItemId = first.lines.taken[0].newOrderItemIds[0]
      b.settlement.cashFromNonCash = true
      const before = await prisma.payment.count({ where: { venueId: s.venueId } })
      await expect(createExchange(s.input(b))).rejects.toMatchObject({ statusCode: 422, details: { reason: 'INSUFFICIENT_FOR_METHOD' } })
      expect(await prisma.payment.count({ where: { venueId: s.venueId } })).toBe(before)
      expect(await prisma.exchange.count({ where: { venueId: s.venueId } })).toBe(1)
    },
  )

  it('second exchange PAYOUT BANK_TRANSFER keeps the transfer root snapshot without cash or chosen-method authority', async () => {
    const s = await seed()
    await prisma.payment.update({
      where: { id: s.payments[0].id },
      data: { method: 'BANK_TRANSFER', source: 'APP', fundsFlow: 'EXTERNAL_RECORDED', tenderSatFormaPago: '03' },
    })
    const { exchange: first } = await createExchange(s.input())
    const b = await difference(s, 400, 'BANK_TRANSFER')
    b.originalPaymentId = first.paymentIds[0]
    b.returned[0].orderItemId = first.lines.taken[0].newOrderItemIds[0]
    const { exchange: second } = await createExchange(s.input(b))
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: second.refundPaymentIds[0] } })).toMatchObject({
      method: 'BANK_TRANSFER',
      source: 'APP',
      tenderSatFormaPago: '03',
      fundsFlow: 'EXTERNAL_RECORDED',
      processorData: { rootPaymentId: s.payments[0].id, originalMethod: 'BANK_TRANSFER' },
    })
    expect(await eventsOf(s)).toEqual([])
  })

  it('cash PAYOUT posts to S1 after S1 closes and S2 opens between commit and the effect', async () => {
    const s = await seed()
    let nextId = ''
    const real = jest.requireActual('@/services/shared/cashDrawerPosting').postCashRefundToDrawer
    jest.mocked(postCashRefundToDrawer).mockImplementationOnce(async posting => {
      await prisma.cashDrawerSession.update({
        where: { id: s.drawer.id },
        data: { status: 'CLOSED', closedAt: new Date(), actualAmount: 100, overShort: 0 },
      })
      nextId = (
        await prisma.cashDrawerSession.create({
          data: { venueId: s.venueId, openedByStaffId: s.staffId, openedByName: 'Otra caja', startingAmount: 200 },
        })
      ).id
      return real(posting)
    })
    await createExchange(s.input(await difference(s, 400)))
    expect((await eventsOf(s)).map(p => [p.type, p.sessionId, Number(p.amount)])).toEqual([['PAY_OUT', s.drawer.id, 100]])
    expect(await prisma.cashDrawerEvent.count({ where: { sessionId: nextId } })).toBe(0)
    expect(Number((await prisma.cashDrawerSession.findUniqueOrThrow({ where: { id: s.drawer.id } })).overShort)).toBe(100)
  })

  it('does not route COLLECT cash to a drawer opened after commit', async () => {
    const s = await seed()
    const real = jest.requireActual('@/services/shared/cashDrawerPosting').postCashSaleToDrawer
    jest.mocked(postCashSaleToDrawer).mockImplementationOnce(async posting => {
      await prisma.cashDrawerSession.update({ where: { id: s.drawer.id }, data: { status: 'CLOSED', closedAt: new Date() } })
      await prisma.cashDrawerSession.create({
        data: { venueId: s.venueId, openedByStaffId: s.staffId, openedByName: 'Otra', startingAmount: 0 },
      })
      return real(posting)
    })
    await createExchange(s.input(await difference(s, 600)))
    expect(postCashSaleToDrawer).toHaveBeenCalledWith(expect.objectContaining({ targetSessionId: s.drawer.id, exigirAbierta: true }))
    expect(await eventsOf(s)).toEqual([])
  })

  it('rejects a foreign or closed drawer supplied for cash PAYOUT with no writes', async () => {
    const s = await seed()
    const other = await seed()
    const b = await difference(s, 400)
    b.settlement.cashDrawerSessionId = other.drawer.id
    await expect(createExchange(s.input(b))).rejects.toMatchObject({ statusCode: 422 })
    await expectNoExchange(s, 1)
    b.settlement.cashDrawerSessionId = s.drawer.id
    await prisma.cashDrawerSession.update({ where: { id: s.drawer.id }, data: { status: 'CLOSED', closedAt: new Date() } })
    await expect(createExchange(s.input(b))).rejects.toMatchObject({ statusCode: 422 })
    await expectNoExchange(s, 1)
  })

  it.each([
    [0, 100],
    [100, 0],
  ])('independent zero values: R %s, N %s preserve stock postings and credit neutrality', async (paid, taken) => {
    const s = await seed({ paid, list: paid })
    const { exchange: e } = await createExchange(s.input(await difference(s, taken)))
    expect(e.status).toBe('COMPLETED')
    expect(await prisma.exchangeCreditLink.count({ where: { venueId: s.venueId } })).toBe(0)
    const newPayments = await paymentsOf(s, e.newOrderId)
    expect(newPayments.map(p => [p.method, Number(p.amount)])).toEqual([['CASH', taken]])
    expect((await prisma.inventoryPosting.findMany({ where: { venueId: s.venueId }, take: 10 })).map(p => p.effectKind).sort()).toEqual([
      'CUSTOMER_RETURN',
      'SALE',
    ])
    const refunds = (await paymentsOf(s, s.order.id)).filter(p => p.type === 'REFUND')
    expect(refunds.map(p => [Number(p.amount), (p.processorData as any).exchange.role])).toEqual(
      paid === 0 ? [[0, 'CREDIT']] : [[-100, 'DIFFERENCE']],
    )
  })
})
