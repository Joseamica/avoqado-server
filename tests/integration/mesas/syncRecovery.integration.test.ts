import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { lookupSyncRecovery } from '@/services/mobile/sync-recovery.mobile.service'

const target = new URL(process.env.TEST_DATABASE_URL ?? '')
if (
  !['localhost', '127.0.0.1'].includes(target.hostname) ||
  (!/^\/avoqado_mesasq16_test_\d+$/.test(target.pathname) && target.pathname !== '/avoqado_h1a_test_20260808')
) {
  throw new Error('Q16 requiere una base local desechable avoqado_mesasq16_test_<fecha> o avoqado_h1a_test_20260808 de CI.')
}
const fixture = `q16-${randomUUID()}`
const venue = `${fixture}-A`
const otherVenue = `${fixture}-B`
const device = 'original-device'
const result = { orderId: 'original-result-order', paymentId: 'original-result-payment', amount: 4000, tipAmount: 500 }
let initialState: unknown

async function state() {
  const scope = { in: [venue, otherVenue] }
  return {
    intents: await prisma.posSyncIntent.findMany({ where: { venueId: scope }, orderBy: { id: 'asc' }, take: 110 }),
    orders: await prisma.order.findMany({ where: { venueId: scope }, orderBy: { id: 'asc' }, take: 110 }),
    payments: await prisma.payment.count({ where: { venueId: scope } }),
    items: await prisma.orderItem.count({ where: { order: { venueId: scope } } }),
  }
}

beforeAll(async () => {
  await prisma.organization.create({
    data: { id: fixture, name: 'Q16 disposable fixture', email: `${fixture}@example.test`, phone: '5500000000' },
  })
  await prisma.venue.createMany({ data: [venue, otherVenue].map(id => ({ id, organizationId: fixture, name: 'Q16 fixture', slug: id })) })
  await prisma.order.createMany({
    data: [
      ...Array.from({ length: 100 }, (_, i) => ({
        venueId: venue,
        orderNumber: `${fixture}-${i}`,
        externalId: `external-${i}`,
        subtotal: 40,
        total: 40,
        remainingBalance: 40,
        taxAmount: 0,
        contratoDePrecio: 'IVA_INCLUIDO' as const,
      })),
      {
        venueId: otherVenue,
        orderNumber: `${fixture}-foreign`,
        externalId: 'external-0',
        subtotal: 90,
        total: 90,
        remainingBalance: 90,
        taxAmount: 0,
        contratoDePrecio: 'IVA_INCLUIDO' as const,
      },
    ],
  })
  await prisma.posSyncIntent.createMany({
    data: [
      {
        venueId: venue,
        deviceId: device,
        seq: 10,
        idempotencyKey: 'original-terminal',
        type: 'PAY_CASH',
        localRef: 'local-original',
        status: 'ACKED',
        resultJson: result,
      },
      {
        venueId: otherVenue,
        deviceId: device,
        seq: 10,
        idempotencyKey: 'original-terminal',
        type: 'PAY_CASH',
        status: 'ACKED',
        resultJson: { paymentId: 'foreign-payment' },
      },
      {
        venueId: venue,
        deviceId: 'other-device',
        seq: 10,
        idempotencyKey: 'other-device-terminal',
        type: 'PAY_CASH',
        status: 'ACKED',
        resultJson: { paymentId: 'other-device-payment' },
      },
      {
        venueId: venue,
        deviceId: device,
        seq: 11,
        idempotencyKey: 'original-processing',
        type: 'ADD_ITEMS',
        localRef: 'local-processing',
        status: 'PROCESSING',
        createdAt: new Date('2020-01-01T00:00:00Z'),
      },
      {
        venueId: venue,
        deviceId: device,
        seq: 12,
        idempotencyKey: 'original-rejected',
        type: 'OPEN_TABLE',
        status: 'REJECTED',
        errorCode: 'STALE_DEVICE_SEQUENCE',
        resultJson: { details: { latestSeq: 99 } },
      },
      {
        venueId: venue,
        deviceId: device,
        seq: 13,
        idempotencyKey: 'unsupported-create',
        type: 'CREATE_ORDER',
        status: 'ACKED',
        resultJson: { orderId: 'must-not-leak' },
      },
    ],
  })
  initialState = await state()
})
afterEach(async () => {
  expect(await state()).toEqual(initialState)
})
// Fixtures remain for root's evidence capture; root drops only this disposable database.

describe('Q16 recovery — actual PostgreSQL, no financial effects', () => {
  it('returns the stored original payment result exactly, under its original device and venue', async () => {
    expect(await lookupSyncRecovery(venue, { deviceId: device, intentIds: ['original-terminal'] })).toEqual({
      intents: [
        {
          id: 'original-terminal',
          type: 'PAY_CASH',
          deviceId: device,
          seq: 10,
          localRef: 'local-original',
          status: 'ACKED',
          errorCode: null,
          result,
        },
      ],
      orders: [],
    })
  })
  it('cannot return the other device payment', async () => {
    expect(await lookupSyncRecovery(venue, { deviceId: device, intentIds: ['other-device-terminal'] })).toEqual({ intents: [], orders: [] })
  })
  it('the other venue receives only its own evidence for the same key', async () => {
    const recovered = await lookupSyncRecovery(otherVenue, {
      deviceId: device,
      intentIds: ['original-terminal'],
      externalOrderIds: ['external-0'],
    })
    expect(recovered.intents[0].result).toEqual({ paymentId: 'foreign-payment' })
    expect(recovered.orders).toEqual([
      {
        externalId: 'external-0',
        orderId: (await prisma.order.findFirstOrThrow({ where: { venueId: otherVenue, externalId: 'external-0' } })).id,
      },
    ])
  })
  it('does not expire or reexecute an old PROCESSING row', async () => {
    const recovered = await lookupSyncRecovery(venue, { deviceId: device, intentIds: ['original-processing'] })
    expect(recovered.intents).toEqual([
      {
        id: 'original-processing',
        type: 'ADD_ITEMS',
        deviceId: device,
        seq: 11,
        localRef: 'local-processing',
        status: 'PROCESSING',
        errorCode: null,
        result: null,
      },
    ])
  })
  it('returns a rejection unchanged, including its stored sequence evidence', async () => {
    const recovered = await lookupSyncRecovery(venue, { deviceId: device, intentIds: ['original-rejected'] })
    expect(recovered.intents).toEqual([
      {
        id: 'original-rejected',
        type: 'OPEN_TABLE',
        deviceId: device,
        seq: 12,
        localRef: null,
        status: 'REJECTED',
        errorCode: 'STALE_DEVICE_SEQUENCE',
        result: { details: { latestSeq: 99 } },
      },
    ])
  })
  it('does not expose unsupported CREATE_ORDER or invent missing identities', async () => {
    expect(
      await lookupSyncRecovery(venue, { deviceId: device, intentIds: ['unsupported-create', 'missing'], externalOrderIds: ['missing'] }),
    ).toEqual({ intents: [], orders: [] })
  })
  it('returns all 100 requested existing orders without truncating any match or leaking the other venue', async () => {
    const recovered = await lookupSyncRecovery(venue, { externalOrderIds: Array.from({ length: 100 }, (_, i) => `external-${i}`) })
    expect(recovered.orders).toHaveLength(100)
    const actual = await prisma.order.findMany({ where: { venueId: venue }, select: { id: true, externalId: true }, take: 100 })
    expect(recovered.orders.map(row => row.orderId).sort()).toEqual(actual.map(row => row.id).sort())
    expect(new Set(recovered.orders.map(row => row.externalId)).size).toBe(100)
    expect(recovered.intents).toEqual([])
  })
})
