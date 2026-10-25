import prisma from '@/utils/prismaClient'
import { createExchange } from '@/services/exchanges/exchange.service'
import { chainRefundSemanticsInTx, prepareExchangeInTx } from '@/services/exchanges/exchangeTx'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { ensureGiftCardTender } from '@/services/giftCards/giftCardTender'
import { enqueueRefundPaymentEffectsInTx } from '@/services/tpv/paymentEffects.service'
import { metodoParaAlcanceFiscal, paymentInFiscalScope } from '@/services/fiscal/fiscalScope'
import { seedClothingSale } from './seedExchange'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn(async () => undefined) }))
jest.mock('@/services/tpv/paymentEffects.service', () => ({
  ...jest.requireActual('@/services/tpv/paymentEffects.service'),
  enqueueRefundPaymentEffectsInTx: jest.fn((...args: unknown[]) =>
    jest.requireActual('@/services/tpv/paymentEffects.service').enqueueRefundPaymentEffectsInTx(...args),
  ),
}))
jest.setTimeout(60000)
type Seed = Awaited<ReturnType<typeof seedClothingSale>>
const fixtures: Seed[] = []
async function seed(opts?: Parameters<typeof seedClothingSale>[0]) {
  const s = await seedClothingSale(opts)
  fixtures.push(s)
  return s
}
async function exchange(s: Seed) {
  const { exchange: e } = await createExchange(s.input())
  return { e, creditId: e.paymentIds[0] }
}
const refund = (s: Seed, paymentId: string, amount = 50000) =>
  issueRefund({ venueId: s.venueId, staffId: s.staffId, paymentId, amount, reason: 'RETURNED_GOODS' })
beforeAll(() => expect(new URL(process.env.TEST_DATABASE_URL!).pathname).toMatch(/^\/avoqado_cambio_(r5_)?test_202610(20|24)$/))
beforeEach(() => jest.clearAllMocks())
afterAll(async () => {
  for (const s of fixtures) await s.cleanup()
  await prisma.$disconnect()
})

describe('exchange chain refunds', () => {
  it('resolves one or four credits with the same batched queries and no per-credit resolution reads', async () => {
    const counts = []
    for (const credits of [1, 4]) {
      const s = await seed({ payments: Array<number>(credits).fill(500 / credits) })
      const { e } = await exchange(s)
      expect(e.paymentIds).toHaveLength(credits)
      const body = s.body({
        originalPaymentId: e.paymentIds[0],
        returned: [{ orderItemId: e.lines.taken[0].newOrderItemIds[0], quantity: 1, restock: false, reason: 'SIZE' }],
        taken: [{ productId: s.products[2].id, quantity: 1 }],
      })
      const queries = { batch: 0, single: 0 }
      await prisma.$transaction(
        async tx => {
          const observed = new Proxy(tx, {
            get(target, property) {
              if (property !== 'exchangeCreditLink') return Reflect.get(target, property)
              return new Proxy(target.exchangeCreditLink, {
                get(delegate, operation) {
                  if (operation === 'findMany')
                    return (...args: Parameters<typeof delegate.findMany>) => {
                      queries.batch++
                      return delegate.findMany(...args)
                    }
                  if (operation === 'findFirst')
                    return (...args: Parameters<typeof delegate.findFirst>) => {
                      queries.single++
                      return delegate.findFirst(...args)
                    }
                  return Reflect.get(delegate, operation)
                },
              })
            },
          })
          const prepared = await prepareExchangeInTx(observed, {
            ...s.input(body),
            originalOrderId: e.newOrderId,
            requestHash: 'f'.repeat(64),
          })
          expect(prepared).not.toHaveProperty('replay')
        },
        { timeout: 15000 },
      )
      counts.push(queries)
    }
    expect(counts).toEqual([
      { batch: 1, single: 0 },
      { batch: 1, single: 0 },
    ])
  })

  it('refunds cash credit as cash, posts one PAY_OUT and caps refunds by the credit payment', async () => {
    const s = await seed()
    const { e, creditId } = await exchange(s)
    const rootBefore = await prisma.payment.findUniqueOrThrow({ where: { id: s.payments[0].id } })
    const input = {
      venueId: s.venueId,
      paymentId: creditId,
      staffId: s.staffId,
      amount: 20000,
      reason: 'RETURNED_GOODS' as const,
      idempotencyKey: `${creditId}-refund`,
    }
    const r = await issueRefund(input)
    expect(await issueRefund(input)).toEqual(r)
    expect(r).toMatchObject({ amount: 200, remainingRefundable: 300 })
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: r.refundId } })
    expect(row).toMatchObject({ method: 'CASH', fundsFlow: 'CASH_DRAWER', merchantAccountId: null, tenderTypeId: null })
    expect(Number(row.amount)).toBe(-200)
    expect(row.processorData).toMatchObject({
      originalPaymentId: creditId,
      originalMethod: 'CASH',
      rootPaymentId: s.payments[0].id,
      exchange: { exchangeId: e.id, role: 'CHAIN', rootPaymentId: s.payments[0].id },
    })
    const events = await prisma.cashDrawerEvent.findMany({ where: { venueId: s.venueId }, take: 10 })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'PAY_OUT', sessionId: s.drawer.id })
    expect(Number(events[0].amount)).toBe(200)
    expect(enqueueRefundPaymentEffectsInTx).toHaveBeenCalledWith(expect.anything(), r.refundId, s.payments[0].id)
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'REFUND_CREATED',
        entityId: r.refundId,
        data: expect.objectContaining({ originalPaymentId: creditId, originalMethod: 'CASH', rootPaymentId: s.payments[0].id }),
      }),
    )
    await expect(refund(s, creditId, 30001)).rejects.toMatchObject({ statusCode: 400 })
    expect((await refund(s, creditId, 30000)).remainingRefundable).toBe(0)
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: s.payments[0].id } })).processorData).toEqual(rootBefore.processorData)
    await expect(refund(s, s.payments[0].id, 1)).rejects.toMatchObject({ statusCode: 400 })
    // La póliza usa este mismo predicado: el efectivo excluido no reaparece como OTHER por el crédito intermedio.
    expect(paymentInFiscalScope(metodoParaAlcanceFiscal(row.method, row.processorData), null, false)).toBe(false)
  })

  it('serializes concurrent chain refunds without paying more than the credit', async () => {
    const s = await seed()
    const { creditId } = await exchange(s)
    const results = await Promise.allSettled([refund(s, creditId, 30000), refund(s, creditId, 30000)])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1)
    const rows = await prisma.payment.findMany({
      where: { venueId: s.venueId, type: 'REFUND', processorData: { path: ['originalPaymentId'], equals: creditId } },
      take: 10,
    })
    expect(rows.map(p => Number(p.amount))).toEqual([-300])
  })

  it('inherits a transfer root and its frozen tender without moving drawer cash', async () => {
    const s = await seed()
    await prisma.payment.update({
      where: { id: s.payments[0].id },
      data: { method: 'BANK_TRANSFER', fundsFlow: 'EXTERNAL_RECORDED', source: 'APP', tenderSatFormaPago: '03' },
    })
    const { creditId } = await exchange(s)
    const r = await refund(s, creditId)
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: r.refundId } })
    expect(row).toMatchObject({ method: 'BANK_TRANSFER', fundsFlow: 'EXTERNAL_RECORDED', source: 'APP', tenderSatFormaPago: '03' })
    expect(await prisma.cashDrawerEvent.count({ where: { venueId: s.venueId } })).toBe(0)
  })

  it.each([false, true])('rejects refundMethod CASH on exchange credit with 400 (terminal root=%s)', async card => {
    const s = await seed({ card })
    const { creditId } = await exchange(s)
    await expect(
      issueRefund({ venueId: s.venueId, paymentId: creditId, amount: 100, reason: 'OTHER', refundMethod: 'CASH' }),
    ).rejects.toMatchObject({ statusCode: 400, message: 'Este cobro sólo se devuelve por el mismo medio con que se pagó.' })
  })

  it.each(['terminal', 'gift', 'merchant', 'settled'] as const)('blocks a %s root with 422 and writes no refund', async kind => {
    const s = await seed({ card: kind === 'terminal' || kind === 'merchant' })
    if (kind === 'merchant')
      await prisma.payment.update({ where: { id: s.payments[0].id }, data: { method: 'CASH', source: 'POS', fundsFlow: 'CASH_DRAWER' } })
    if (kind === 'settled') await prisma.payment.update({ where: { id: s.payments[0].id }, data: { fundsFlow: 'AVOQADO_PROCESSED' } })
    if (kind === 'gift') {
      const tender = await ensureGiftCardTender(prisma, s.venueId)
      await prisma.payment.update({
        where: { id: s.payments[0].id },
        data: { method: 'OTHER', fundsFlow: 'EXTERNAL_RECORDED', tenderTypeId: tender.id },
      })
    }
    const { creditId } = await exchange(s)
    const before = await prisma.payment.count({ where: { venueId: s.venueId } })
    await expect(refund(s, creditId)).rejects.toMatchObject({
      statusCode: 422,
      code: kind === 'gift' ? 'EXCHANGE_CHAIN_GIFT_CARD_PENDING' : 'EXCHANGE_CHAIN_NEEDS_TERMINAL',
      message:
        kind === 'gift'
          ? 'Esto se pagó con un crédito que salió de una tarjeta de regalo; regresarlo al saldo todavía no está disponible.'
          : 'Esto se pagó con un crédito que salió de una tarjeta: se devuelve a esa tarjeta en la terminal, y eso todavía no está disponible.',
      ...(['merchant', 'settled'].includes(kind) ? { details: { reason: 'PROCESSOR_ROOT' } } : {}),
    })
    expect(await prisma.payment.count({ where: { venueId: s.venueId } })).toBe(before)
    expect(await prisma.cashDrawerEvent.count({ where: { venueId: s.venueId } })).toBe(0)
  })

  it('a second exchange links its new credit directly to the root and caps the intermediate credit', async () => {
    const s = await seed()
    const first = await exchange(s)
    const item = first.e.lines.taken[0].newOrderItemIds[0]
    const b = s.body({
      originalPaymentId: first.creditId,
      returned: [{ orderItemId: item, quantity: 1, restock: true, reason: 'SIZE' }],
      taken: [{ productId: s.products[2].id, quantity: 1, inheritsFromOrderItemId: item }],
    })
    const { exchange: second } = await createExchange(s.input(b))
    expect(await prisma.exchangeCreditLink.findUniqueOrThrow({ where: { creditPaymentId: second.paymentIds[0] } })).toMatchObject({
      originPaymentId: s.payments[0].id,
    })
    await expect(refund(s, first.creditId, 1)).rejects.toMatchObject({ statusCode: 400 })
    const r = await refund(s, second.paymentIds[0])
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: r.refundId } })).processorData).toMatchObject({
      originalPaymentId: second.paymentIds[0],
      rootPaymentId: s.payments[0].id,
      originalMethod: 'CASH',
    })
  })

  it('does not resolve another venue credit or a missing link', async () => {
    const s = await seed()
    const other = await seed()
    const { creditId } = await exchange(s)
    await expect(prisma.$transaction(tx => chainRefundSemanticsInTx(tx, other.venueId, creditId))).rejects.toMatchObject({
      statusCode: 422,
    })
    await prisma.exchangeCreditLink.delete({ where: { creditPaymentId: creditId } })
    await expect(refund(s, creditId)).rejects.toMatchObject({ statusCode: 422, code: 'EXCHANGE_SETTLEMENT_UNAVAILABLE' })
  })
})
