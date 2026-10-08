/**
 * F02 — dos aperturas de la MISMA mesa al mismo tiempo, contra Postgres REAL.
 *
 * `assignTable` leía la mesa y su cuenta FUERA de una transacción: la segunda apertura, con la lectura vieja, hacía
 * `updateMany` poniendo `tableId=null` a la cuenta de la primera (que ya tenía renglones aceptados), creaba otra orden y
 * se quedaba con `currentOrderId`. Aquí se prueba la admisión serializada (`Table FOR UPDATE`) y que separar/crear/apuntar
 * es atómico.
 *
 * Correr (base desechable; nunca la de producción):
 *   TEST_DATABASE_URL='postgresql://…/avoqado_mesas40_test_20261006' \
 *   npx jest --selectProjects=integration --runInBand --runTestsByPath tests/integration/mesas/tableAdmission.integration.test.ts
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { assignTable } from '@/services/tpv/table.tpv.service'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))

// Crea órdenes y mesas reales: sólo corre en una base de prueba local y desechable.
const target = new URL(process.env.TEST_DATABASE_URL ?? '')
if (!['localhost', '127.0.0.1'].includes(target.hostname) || !/^\/(codex_testarudo_test_|avoqado_[a-z0-9]+_test_)/.test(target.pathname)) {
  throw new Error('Exige una base de prueba local y desechable (p. ej. avoqado_mesas40_test_20261006).')
}
const venueId = `audit40-${randomUUID()}`
let staffId: string
function gate() {
  let release!: () => void
  const ready = new Promise<void>(resolve => {
    release = resolve
  })
  return { ready, release }
}
async function table() {
  return prisma.table.create({ data: { venueId, number: randomUUID(), capacity: 4, qrCode: randomUUID() } })
}
async function account(total = 100) {
  return prisma.order.create({
    data: {
      venueId,
      orderNumber: randomUUID(),
      servedById: staffId,
      subtotal: total,
      taxAmount: 0,
      total,
      remainingBalance: total,
      contratoDePrecio: 'IVA_INCLUIDO',
      items: { create: { productName: 'Primera ronda', quantity: 1, unitPrice: total, total, taxAmount: 0 } },
    },
  })
}
beforeAll(async () => {
  await prisma.organization.create({
    data: { id: venueId, name: 'Audit restaurant', email: `${venueId}@example.test`, phone: '5500000000' },
  })
  await prisma.venue.create({ data: { id: venueId, organizationId: venueId, name: 'Audit restaurant', slug: venueId } })
  staffId = (await prisma.staff.create({ data: { email: `${venueId}@staff.test`, firstName: 'Audit', lastName: 'Waiter' } })).id
  await prisma.staffVenue.create({ data: { venueId, staffId, role: 'WAITER' } })
})
afterEach(() => jest.restoreAllMocks())
afterAll(async () => {
  await prisma.$disconnect()
}) // Retain unique audit fixtures as evidence; no shared data cleanup.

describe('Table admission invariant — real PostgreSQL', () => {
  it('concurrent open requests return the same account without detaching accepted items', async () => {
    const t = await table()
    const barrier = gate()
    let reads = 0
    const originalRead = prisma.table.findFirst.bind(prisma.table)
    jest.spyOn(prisma.table, 'findFirst').mockImplementation((async (args: any) => {
      const value = await originalRead(args)
      if (args.where.id === t.id) {
        if (++reads === 2) barrier.release()
        await barrier.ready
      }
      return value
    }) as any)
    const [a, b] = await Promise.all([assignTable(venueId, t.id, staffId, 2), assignTable(venueId, t.id, staffId, 3)])
    expect(a.order.id).toBe(b.order.id)
    expect([a.isNewOrder, b.isNewOrder].filter(Boolean)).toHaveLength(1)
    expect(await prisma.order.count({ where: { venueId, tableId: t.id } })).toBe(1)
    await prisma.orderItem.create({
      data: { orderId: a.order.id, productName: 'Accepted item', quantity: 1, unitPrice: 50, total: 50, taxAmount: 0 },
    })
    const c = await assignTable(venueId, t.id, staffId, 2)
    expect(c.order.id).toBe(a.order.id)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: a.order.id } })).tableId).toBe(t.id)
  })
  it('rolls back order creation and old-account detach if linking the table fails', async () => {
    const t = await table()
    const old = await account(50)
    await prisma.order.update({ where: { id: old.id }, data: { tableId: t.id } })
    const beforeOrderCount = await prisma.order.count({ where: { venueId } })
    const originalUpdate = prisma.table.update.bind(prisma.table)
    jest.spyOn(prisma.table, 'update').mockImplementation((args: any) => {
      if (args.where.id === t.id) throw new Error('AUDIT fault at pointer write')
      return originalUpdate(args)
    })
    const originalTx = prisma.$transaction.bind(prisma) as any
    jest.spyOn(prisma, '$transaction').mockImplementation(((callback: any, options: any) =>
      originalTx(async (tx: any) => {
        const update = tx.table.update.bind(tx.table)
        tx.table.update = (args: any) => {
          if (args.where.id === t.id) throw new Error('AUDIT fault at pointer write')
          return update(args)
        }
        return callback(tx)
      }, options)) as any)
    await expect(assignTable(venueId, t.id, staffId, 2)).rejects.toThrow('AUDIT fault')
    expect(await prisma.order.count({ where: { venueId, tableId: t.id } })).toBe(1)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: old.id } })).tableId).toBe(t.id)
    expect((await prisma.table.findUniqueOrThrow({ where: { id: t.id } })).currentOrderId).toBeNull()
    expect(await prisma.order.count({ where: { venueId } })).toBe(beforeOrderCount)
  })
  it('preserves reserved, missing venue/staff guards and existing seating semantics', async () => {
    const t = await table()
    await prisma.table.update({ where: { id: t.id }, data: { status: 'RESERVED' } })
    await expect(assignTable(venueId, t.id, staffId, 2)).rejects.toThrow('Mesa reservada')
    await expect(assignTable('other-venue', t.id, staffId, 2)).rejects.toThrow('Table not found')
    await expect(assignTable(venueId, t.id, 'unknown-staff', 2)).rejects.toThrow('Staff member not found')
    expect(await prisma.order.count({ where: { venueId, tableId: t.id } })).toBe(0)
  })
})
