/**
 * Integration tests: the kitchen display list is BOUNDED (REAL PostgreSQL).
 *
 * Incident 2026-09-24 (Better Stack «Consulta gigante detectada»): Testarudo opened the kitchen
 * display once and `GET /mobile/venues/:id/kds/orders` read 3,068 comandas plus 3,060 ventas.
 * The POS creates a comanda for every sale and Testarudo never bumps them, so the "active" list
 * held a month of sales — and the screen polls every 10 s.
 *
 * The contract now:
 *   - at most KDS_LIST_MAX comandas per read, the NEWEST ones (a kitchen with a backlog must
 *     still see what just came in), returned oldest → newest as before;
 *   - the true total is available separately (`countKdsOrders`) so nothing is silently lost;
 *   - the linked sales are looked up only for the comandas returned.
 *
 * Run with:
 *   TEST_DATABASE_URL='postgresql://…/<a disposable test db>' \
 *     npx jest --selectProjects integration --testPathPattern kds-list-bounded
 */

import prisma from '@/utils/prismaClient'
import { countKdsOrders, KDS_LIST_MAX, listKdsOrders } from '@/services/mobile/kds.mobile.service'

const suffix = `kdstope-${Date.now()}`
const BASE = new Date('2026-09-01T12:00:00.000Z').getTime()

let orgId: string
let bigVenue: string
let smallVenue: string

async function comanda(venueId: string, n: number, status: 'NEW' | 'PREPARING' | 'READY' | 'COMPLETED' = 'NEW') {
  await prisma.kdsOrder.create({
    data: {
      venueId,
      orderNumber: `K${String(n).padStart(4, '0')}`,
      status,
      createdAt: new Date(BASE + n * 60_000),
      items: { create: [{ productName: `Café ${n}`, quantity: 1 }] },
    },
  })
}

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `KDS Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  bigVenue = (await prisma.venue.create({ data: { organizationId: orgId, name: `kds-big-${suffix}`, slug: `kds-big-${suffix}` } })).id
  smallVenue = (await prisma.venue.create({ data: { organizationId: orgId, name: `kds-small-${suffix}`, slug: `kds-small-${suffix}` } })).id

  // Big venue: KDS_LIST_MAX + 5 active comandas (a backlog), plus 2 completed ones.
  for (let n = 1; n <= KDS_LIST_MAX + 5; n++) {
    await comanda(bigVenue, n, n % 3 === 0 ? 'PREPARING' : 'NEW')
  }
  await comanda(bigVenue, 900, 'COMPLETED')
  await comanda(bigVenue, 901, 'COMPLETED')

  // Small venue: an ordinary kitchen — 3 active comandas.
  await comanda(smallVenue, 1)
  await comanda(smallVenue, 2, 'READY')
  await comanda(smallVenue, 3)
})

afterAll(async () => {
  if (!orgId) return
  const venues = [bigVenue, smallVenue].filter(Boolean)
  await prisma.kdsOrder.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.venue.deleteMany({ where: { id: { in: venues } } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

describe('listKdsOrders — bounded', () => {
  it('never reads comandas or sales without a bound', async () => {
    const kdsSpy = jest.spyOn(prisma.kdsOrder, 'findMany')
    const orderSpy = jest.spyOn(prisma.order, 'findMany')
    try {
      await listKdsOrders(bigVenue)
      for (const [args] of kdsSpy.mock.calls) {
        expect((args as { take?: number }).take).toBeLessThanOrEqual(KDS_LIST_MAX)
      }
      for (const [args] of orderSpy.mock.calls) {
        expect((args as { take?: number }).take).toBeLessThanOrEqual(KDS_LIST_MAX)
      }
    } finally {
      kdsSpy.mockRestore()
      orderSpy.mockRestore()
    }
  })

  it('with a backlog, returns the NEWEST KDS_LIST_MAX, oldest → newest', async () => {
    const list = await listKdsOrders(bigVenue)
    expect(list).toHaveLength(KDS_LIST_MAX)
    const numbers = list.map(o => o.orderNumber)
    // The 5 oldest (K0001..K0005) are the ones left out; the newest one is always visible.
    expect(numbers[0]).toBe('K0006')
    expect(numbers[numbers.length - 1]).toBe(`K${String(KDS_LIST_MAX + 5).padStart(4, '0')}`)
    const times = list.map(o => new Date(o.createdAt).getTime())
    expect([...times].sort((a, b) => a - b)).toEqual(times)
  })

  it('countKdsOrders tells the true total, so nothing is lost silently', async () => {
    expect(await countKdsOrders(bigVenue)).toBe(KDS_LIST_MAX + 5)
    expect(await countKdsOrders(bigVenue, 'COMPLETED')).toBe(2)
    expect(await countKdsOrders(smallVenue)).toBe(3)
  })

  // Regression: an ordinary kitchen sees exactly what it saw before.
  it('an ordinary kitchen still gets every active comanda, oldest first', async () => {
    const list = await listKdsOrders(smallVenue)
    expect(list.map(o => o.orderNumber)).toEqual(['K0001', 'K0002', 'K0003'])
    expect(list[0].items).toHaveLength(1)
  })

  it('the status filter still works, and stays scoped to the venue', async () => {
    const done = await listKdsOrders(bigVenue, 'COMPLETED')
    expect(done.map(o => o.orderNumber)).toEqual(['K0900', 'K0901'])
    expect(await listKdsOrders(smallVenue, 'COMPLETED')).toEqual([])
  })
})
