/**
 * Product exchange · what the DATABASE guarantees on its own (block A, task 1), against a real Postgres:
 * - one `EXCHANGE_CREDIT` system tender per venue (unique index `VenueTenderType_venueId_systemKind_key`),
 *   living next to the `GIFT_CARD` one;
 * - the same idempotency key never creates two exchanges in a venue (`Exchange_venueId_idempotencyKey_key`);
 * - each credit portion is linked once, on both sides (`ExchangeCreditLink_creditPaymentId_key` and
 *   `ExchangeCreditLink_creditRefundPaymentId_key`);
 * - `VenueSettings.exchangesEnabled` is born null: "nobody decided", the server resolves the default by business type.
 *
 * Run (a disposable database only, never the shared av-db-25): export TEST_DATABASE_URL pointing to it, then
 *   TZ=UTC npx jest --selectProjects=integration --runTestsByPath tests/integration/exchanges/schema.integration.test.ts --runInBand --ci
 *
 * Las relaciones del crédito exigen pagos reales: la siembra crea órdenes y pagos del mismo negocio con ids cuid v1 de Prisma.
 * Cada corrida usa su propio negocio con nombre único y sólo limpia sus filas.
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { crearCuentaDeMercancia, crearNegocioDePrueba, limpiarNegocioDePrueba } from '../giftCards/sembrarTarjetasDeRegalo'

const D = (pesos: number) => new Prisma.Decimal(pesos)
const SUF = `cambio-esq-${process.pid}-${Date.now()}`
let venueId: string
let staffId: string
let n = 0

beforeAll(async () => {
  ;({ venueId, staffId } = await crearNegocioDePrueba('cambio-esq'))
})

afterAll(async () => {
  // Without a venue nothing is deleted: a filter with an undefined `venueId` would wipe whole tables.
  if (!venueId) return
  await prisma.exchange.deleteMany({ where: { venueId } }) // the credit links go with it (cascade)
  await limpiarNegocioDePrueba(venueId)
})

async function payment(orderId: string, type: 'REGULAR' | 'REFUND' = 'REGULAR'): Promise<string> {
  const amount = D(type === 'REFUND' ? -100 : 100)
  const row = await prisma.payment.create({
    data: {
      venueId,
      orderId,
      amount,
      netAmount: amount,
      feePercentage: D(0),
      feeAmount: D(0),
      method: 'OTHER',
      fundsFlow: 'EXTERNAL_RECORDED',
      status: 'COMPLETED',
      type,
      processedById: staffId,
    },
  })
  return row.id
}

async function exchangeData(extra: Partial<Prisma.ExchangeUncheckedCreateInput> = {}): Promise<Prisma.ExchangeUncheckedCreateInput> {
  const original = await crearCuentaDeMercancia({ venueId, staffId, total: 500 })
  const nueva = await crearCuentaDeMercancia({ venueId, staffId, total: 500 })
  const originalPaymentId = await payment(original.orderId)
  n += 1
  return {
    venueId,
    idempotencyKey: `${SUF}-k${n}`,
    requestHash: 'a'.repeat(64),
    status: 'COMPLETED',
    originalOrderId: original.orderId,
    originalPaymentId,
    newOrderId: nueva.orderId,
    returnedAmount: D(500),
    takenAmount: D(500),
    differenceAmount: D(0),
    settlementKind: 'EVEN',
    lines: [],
    staffId,
    ...extra,
  }
}

async function creditLink(exchangeId: string, extra: Partial<Prisma.ExchangeCreditLinkUncheckedCreateInput> = {}) {
  const exchange = await prisma.exchange.findFirstOrThrow({ where: { id: exchangeId, venueId } })
  const creditPaymentId = extra.creditPaymentId ?? (await payment(exchange.newOrderId!))
  const creditRefundPaymentId = extra.creditRefundPaymentId ?? (await payment(exchange.originalOrderId, 'REFUND'))
  return prisma.exchangeCreditLink.create({
    data: {
      venueId,
      exchangeId,
      originPaymentId: exchange.originalPaymentId,
      creditRefundPaymentId,
      creditPaymentId,
      amount: D(100),
      ...extra,
    },
  })
}

describe('exchange schema', () => {
  it('allows one EXCHANGE_CREDIT tender per venue and rejects a second one with P2002', async () => {
    const base = { venueId, baseMethod: 'OTHER' as const, isSystem: true, showOnPos: false }
    await prisma.venueTenderType.create({ data: { ...base, name: 'Credit A', normalizedName: `${SUF}-a`, systemKind: 'EXCHANGE_CREDIT' } })
    await expect(
      prisma.venueTenderType.create({ data: { ...base, name: 'Credit B', normalizedName: `${SUF}-b`, systemKind: 'EXCHANGE_CREDIT' } }),
    ).rejects.toMatchObject({ code: 'P2002', meta: { target: ['venueId', 'systemKind'] } })
    // It is a different kind from the gift card one: both system tenders live in the same venue.
    await prisma.venueTenderType.create({ data: { ...base, name: 'Gift card', normalizedName: `${SUF}-g`, systemKind: 'GIFT_CARD' } })
  })

  it('rejects a second Exchange with the same venueId and idempotencyKey with P2002', async () => {
    const first = await exchangeData()
    await prisma.exchange.create({ data: first })
    await expect(prisma.exchange.create({ data: await exchangeData({ idempotencyKey: first.idempotencyKey }) })).rejects.toMatchObject({
      code: 'P2002',
      meta: { target: ['venueId', 'idempotencyKey'] },
    })
  })

  it('rejects two ExchangeCreditLink rows for the same creditPaymentId with P2002', async () => {
    const exchange = await prisma.exchange.create({ data: await exchangeData() })
    const first = await creditLink(exchange.id)
    await expect(creditLink(exchange.id, { creditPaymentId: first.creditPaymentId })).rejects.toMatchObject({
      code: 'P2002',
      meta: { target: ['creditPaymentId'] },
    })
  })

  it('rejects two ExchangeCreditLink rows for the same creditRefundPaymentId with P2002', async () => {
    const exchange = await prisma.exchange.create({ data: await exchangeData() })
    const first = await creditLink(exchange.id)
    await expect(creditLink(exchange.id, { creditRefundPaymentId: first.creditRefundPaymentId })).rejects.toMatchObject({
      code: 'P2002',
      meta: { target: ['creditRefundPaymentId'] },
    })
  })

  it('leaves VenueSettings.exchangesEnabled null when nobody wrote it', async () => {
    await prisma.venueSettings.upsert({ where: { venueId }, create: { venueId }, update: {} })
    const settings = await prisma.venueSettings.findUniqueOrThrow({ where: { venueId }, select: { exchangesEnabled: true } })
    expect(settings.exchangesEnabled).toBeNull()
  })
})
