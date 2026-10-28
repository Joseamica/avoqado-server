import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { crearCuentaDeMercancia, crearNegocioDePrueba, limpiarNegocioDePrueba } from '../giftCards/sembrarTarjetasDeRegalo'

let venueId: string
let staffId: string
let originalOrderId: string
let originalPaymentId: string
let sequence = 0
const suffix = `cambio-card-schema-${process.pid}-${Date.now()}`

beforeAll(async () => {
  expect(new URL(process.env.TEST_DATABASE_URL!).pathname).toMatch(/^\/avoqado_(?:cambio_(?:fix_|r5_)?test_\d{8}|h1a_test_\d{8}(?:_\d+)?)$/)
  ;({ venueId, staffId } = await crearNegocioDePrueba('cambio-card-schema'))
  ;({ orderId: originalOrderId } = await crearCuentaDeMercancia({ venueId, staffId, total: 100 }))
  originalPaymentId = (
    await prisma.payment.create({
      data: {
        venueId,
        orderId: originalOrderId,
        amount: new Prisma.Decimal(100),
        netAmount: new Prisma.Decimal(100),
        feePercentage: new Prisma.Decimal(0),
        feeAmount: new Prisma.Decimal(0),
        method: 'CREDIT_CARD',
        status: 'COMPLETED',
        processedById: staffId,
      },
    })
  ).id
})

afterAll(async () => {
  if (!venueId) return
  await prisma.exchange.deleteMany({ where: { venueId } })
  await limpiarNegocioDePrueba(venueId)
})

async function exchangeData(extra: Partial<Prisma.ExchangeUncheckedCreateInput> = {}): Promise<Prisma.ExchangeUncheckedCreateInput> {
  const { orderId: newOrderId } = await crearCuentaDeMercancia({ venueId, staffId, total: 100 })
  return {
    venueId,
    idempotencyKey: `${suffix}-${++sequence}`,
    requestHash: 'a'.repeat(64),
    status: 'PENDING_PAYMENT',
    originalOrderId,
    originalPaymentId,
    newOrderId,
    returnedAmount: new Prisma.Decimal(100),
    takenAmount: new Prisma.Decimal(100),
    differenceAmount: new Prisma.Decimal(0),
    settlementKind: 'COLLECT',
    settlementMethod: 'CARD_TERMINAL',
    lines: [],
    staffId,
    ...extra,
  }
}

describe('exchange schema (block D)', () => {
  it('stores an Exchange with status CANCELLED', async () => {
    const exchange = await prisma.exchange.create({ data: await exchangeData({ status: 'CANCELLED' }) })
    expect((await prisma.exchange.findFirstOrThrow({ where: { id: exchange.id, venueId } })).status).toBe('CANCELLED')
  })

  it('rejects two Exchanges with the same chargePaymentId with P2002', async () => {
    await prisma.exchange.create({ data: await exchangeData({ chargePaymentId: originalPaymentId }) })
    await expect(prisma.exchange.create({ data: await exchangeData({ chargePaymentId: originalPaymentId }) })).rejects.toMatchObject({
      code: 'P2002',
      meta: { target: ['chargePaymentId'] },
    })
  })

  it('defaults resultRevision to zero and allows multiple exchanges without a charge seal', async () => {
    const first = await prisma.exchange.create({ data: await exchangeData() })
    const second = await prisma.exchange.create({ data: await exchangeData() })
    expect([first.resultRevision, second.resultRevision]).toEqual([0, 0])
    expect([first.chargePaymentId, second.chargePaymentId]).toEqual([null, null])
  })
})
