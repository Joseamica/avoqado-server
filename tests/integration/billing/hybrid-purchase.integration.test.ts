import prisma from '@/utils/prismaClient'

let venueId: string
const stamp = `${Date.now()}${process.pid}`
beforeAll(async () => {
  if (!/test|hybrid/i.test(new URL(process.env.TEST_DATABASE_URL!).pathname)) throw new Error('Disposable test DB required')
  const org = await prisma.organization.create({ data: { name: stamp, email: `${stamp}@example.test`, phone: '5550000000' } })
  venueId = (await prisma.venue.create({ data: { name: stamp, slug: `purchase-${stamp}`, organizationId: org.id } })).id
})

const quote = () => ({
  venueId,
  quotedById: 'test',
  quote: { total: '179.90' },
  quoteHash: 'hash',
  quoteExpiresAt: new Date(Date.now() + 300000),
})
describe('durable hybrid purchase invariants', () => {
  it('allows quotes side by side but only one accepted obligation for a venue', async () => {
    const a = await prisma.hybridPurchase.create({ data: quote() })
    const b = await prisma.hybridPurchase.create({ data: quote() })
    const accepted = await Promise.allSettled(
      [a, b].map(row => prisma.hybridPurchase.update({ where: { id: row.id }, data: { status: 'ACCEPTED', acceptedAt: new Date() } })),
    )
    expect(accepted.filter(x => x.status === 'fulfilled')).toHaveLength(1)
    const winner = accepted.find(x => x.status === 'fulfilled') as PromiseFulfilledResult<{ id: string }>
    await expect(prisma.hybridPurchase.update({ where: { id: winner.value.id }, data: { quote: { total: '0.01' } } })).rejects.toThrow(
      /immutable/i,
    )
    await prisma.hybridPurchase.update({ where: { id: winner.value.id }, data: { status: 'COMPLETED' } })
  })
  it('does not reuse a caller idempotency key for another quote in the same venue', async () => {
    await prisma.hybridPurchase.create({ data: { ...quote(), clientKey: `key-${stamp}` } })
    await expect(prisma.hybridPurchase.create({ data: { ...quote(), clientKey: `key-${stamp}` } })).rejects.toThrow()
  })
  it('preserves the exact provider request before the call and never changes it on replay', async () => {
    const purchase = await prisma.hybridPurchase.create({ data: { ...quote(), status: 'ACCEPTED', acceptedAt: new Date() } })
    const operation = await prisma.hybridBillingOperation.create({
      data: { purchaseId: purchase.id, step: 'CREATE_SUBSCRIPTION', request: { price: 'price_test' }, requestHash: 'request-hash' },
    })
    await expect(
      prisma.hybridBillingOperation.update({ where: { id: operation.id }, data: { request: { price: 'other' } } }),
    ).rejects.toThrow(/immutable/i)
    await expect(
      prisma.hybridBillingOperation.update({ where: { id: operation.id }, data: { providerId: 'sub_test', status: 'OBSERVED' } }),
    ).resolves.toMatchObject({ providerId: 'sub_test' })
  })
  it('cannot start a provider mutation after an unprovisioned intent was cancelled', async () => {
    const purchase = await prisma.hybridPurchase.create({ data: { ...quote(), status: 'CANCELLED' } })
    await expect(
      prisma.hybridBillingOperation.create({ data: { purchaseId: purchase.id, step: 'SUBSCRIPTION', request: {}, requestHash: 'hash' } }),
    ).rejects.toThrow(/closed/i)
  })
})

it('keeps the first confirmed schedule result immutable', async () => {
  const prior = await prisma.hybridPurchase.findFirstOrThrow({ where: { venueId, status: 'ACCEPTED' } })
  const operation = await prisma.hybridBillingOperation.create({
    data: { purchaseId: prior.id, step: 'SCHEDULE_CONFIGURE', request: {}, requestHash: 'body' },
  })
  await prisma.hybridBillingOperation.update({ where: { id: operation.id }, data: { resultHash: 'first' } })
  await expect(prisma.hybridBillingOperation.update({ where: { id: operation.id }, data: { resultHash: 'different' } })).rejects.toThrow(
    /immutable/i,
  )
})
