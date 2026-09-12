/** Each session has exactly one connection; fixtures use Prisma-written UTC timestamps. */
import { randomUUID } from 'crypto'
import { PrismaClient } from '@prisma/client'
import { claimPaymentEffects } from '@/services/tpv/paymentEffects.service'

const fixture = 'effect-timezone-' + randomUUID()
const now = new Date('2026-09-09T22:00:00.000Z')

it.each(['UTC', 'America/Mexico_City'])('claim and lease preserve UTC instants in %s', async zone => {
  const url = new URL(process.env.TEST_DATABASE_URL ?? '')
  expect(['localhost', '127.0.0.1']).toContain(url.hostname)
  // La base de este trabajo en la Mac, o la de CI (`avoqado_*_test_*`): nunca otra.
  // 🔴 Con el prefijo ÚNICO de una sola sesión, estas suites fallaban SIEMPRE en CI
  // (su base es `avoqado_h1a_test_20260808`): 38 pruebas en rojo el 12-sep. La guarda
  // debe cerrar el paso a una base real, no a la del CI.
  expect(url.pathname).toMatch(/^\/(codex_testarudo_test_|avoqado_[a-z0-9]+_test_)/)
  url.searchParams.set('connection_limit', '1')
  const db = new PrismaClient({ datasources: { db: { url: url.toString() } } })
  let venueId: string | undefined
  const organizationId = fixture + '-' + zone.split('/').join('-')
  try {
    await db.$executeRawUnsafe(zone === 'UTC' ? "SET TIME ZONE 'UTC'" : "SET TIME ZONE 'America/Mexico_City'")
    expect(await db.$queryRawUnsafe('SHOW TIME ZONE')).toEqual([{ TimeZone: zone }])
    await db.organization.create({
      data: { id: organizationId, name: fixture, email: organizationId + '@example.test', phone: '5500000000' },
    })
    venueId = (await db.venue.create({ data: { organizationId, name: fixture, slug: organizationId } })).id
    const order = await db.order.create({ data: { venueId, orderNumber: randomUUID(), subtotal: 100, taxAmount: 0, total: 100 } })
    const payment = await db.payment.create({
      data: {
        venueId,
        orderId: order.id,
        amount: 100,
        method: 'CASH',
        status: 'COMPLETED',
        feePercentage: 0,
        feeAmount: 0,
        netAmount: 100,
      },
    })
    const effect = await db.paymentEffect.create({
      data: {
        venueId,
        orderId: order.id,
        paymentId: payment.id,
        kind: 'RECEIPT',
        dedupeKey: 'receipt:' + payment.id,
        payload: {},
        nextAttemptAt: now,
      },
    })
    expect((await claimPaymentEffects({ now: new Date(now.getTime() - 1), db })).find(row => row.id === effect.id)).toBeUndefined()
    const first = (await claimPaymentEffects({ now, db })).find(row => row.id === effect.id)
    expect(first).toBeDefined()
    expect(first?.leaseUntil.toISOString()).toBe('2026-09-09T22:02:00.000Z')
    expect((await db.paymentEffect.findUniqueOrThrow({ where: { id: effect.id } })).updatedAt.toISOString()).toBe(now.toISOString())
    expect((await claimPaymentEffects({ now: new Date('2026-09-09T22:01:59.999Z'), db })).find(row => row.id === effect.id)).toBeUndefined()
    const reclaimed = (await claimPaymentEffects({ now: new Date('2026-09-09T22:02:00.000Z'), db })).find(row => row.id === effect.id)
    expect(reclaimed).toBeDefined()
    expect(reclaimed?.attempts).toBe(2)
    expect(reclaimed?.claimToken).not.toBe(first?.claimToken)
    expect(reclaimed?.leaseUntil.toISOString()).toBe('2026-09-09T22:04:00.000Z')
  } finally {
    if (venueId) {
      await db.paymentEffect.deleteMany({ where: { venueId } })
      await db.payment.deleteMany({ where: { venueId } })
      await db.order.deleteMany({ where: { venueId } })
      await db.venue.deleteMany({ where: { id: venueId } })
    }
    await db.organization.deleteMany({ where: { id: organizationId } })
    await db.$disconnect()
  }
})
