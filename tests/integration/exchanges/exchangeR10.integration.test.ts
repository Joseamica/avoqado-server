import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { createExchange } from '@/services/exchanges/exchange.service'
import { lockExistingOrderForPayment } from '@/services/shared/paymentShiftClaim'
import { writeRefundInTx } from '@/services/shared/writeRefundInTx'
import { recorrerLibros } from '@/services/fiscal/librosDeOrdenes'
import type { ParteDelLibro } from '@/services/fiscal/libroDeLaOrden'
import { applyCustomerReturnPosting, rearmCustomerReturnPostingsInTx } from '@/services/inventory/inventoryPosting.service'
import { seedClothingSale } from './seedExchange'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn(async () => undefined) }))
jest.setTimeout(90000)
type Seed = Awaited<ReturnType<typeof seedClothingSale>>
let s: Seed | undefined
let other: Seed | undefined

beforeAll(() => {
  const u = new URL(process.env.TEST_DATABASE_URL!)
  expect(['localhost', '127.0.0.1']).toContain(u.hostname)
  expect(u.pathname).toMatch(/^\/avoqado_h1a_test_\d{8}(?:_\d+)?$/)
})
afterEach(async () => {
  jest.useRealTimers()
  jest.restoreAllMocks()
  if (s?.venueId) await s.cleanup()
  if (other?.venueId) await other.cleanup()
  s = undefined
  other = undefined
})
afterAll(() => prisma.$disconnect())

async function mixedSale() {
  s = await seedClothingSale({ list: 100, quantity: 3 })
  await prisma.venue.update({ where: { id: s.venueId }, data: { seatCapExempt: true } })
  await prisma.orderItem.update({ where: { id: s.order.items[0].id }, data: { unitPrice: 33.33, total: 100, ivaTratamiento: 'IVA_16' } })
  await prisma.orderItem.create({
    data: {
      orderId: s.order.id,
      productId: s.products[3].id,
      productName: 'Exento',
      quantity: 1,
      unitPrice: 1000,
      total: 1000,
      taxAmount: 0,
      ivaTratamiento: 'EXENTO',
    },
  })
  await prisma.order.update({ where: { id: s.order.id }, data: { subtotal: 1100, total: 1100, paidAmount: 1100 } })
  await prisma.payment.update({
    where: { id: s.payments[0].id },
    data: { amount: 1100, netAmount: 1100, createdAt: new Date(Date.now() - 60000) },
  })
  return s
}

function ordinaryRefund(tx: Prisma.TransactionClient, sale: Seed, at: Date) {
  return writeRefundInTx(tx, {
    venueId: sale.venueId,
    originalPaymentId: sale.payments[0].id,
    salesRefundCents: 3334,
    tipRefundCents: 0,
    refundedItems: [{ orderItemId: sale.order.items[0].id, quantity: 1, amountCents: 3334 }],
    reason: 'RETURNED_GOODS',
    staffId: sale.staffId,
    tenderCommission: 'NONE',
    shift: 'CLAIM_LIVE',
    createdAt: at,
  })
}

async function checkBook(sale: Seed, refundId: string, e: Awaited<ReturnType<typeof createExchange>>['exchange'], at: Date) {
  const parts: Array<{ id: string; at: Date; part: ParteDelLibro }> = []
  await prisma.$transaction(tx =>
    recorrerLibros(tx, { venueId: sale.venueId, orderIds: [sale.order.id], hasta: new Date(at.getTime() + 60000) }, (m, part) => {
      if (m.type === 'REFUND') parts.push({ id: m.id, at: m.createdAt, part })
    }),
  )
  console.log('R10 libro real', JSON.stringify(parts))
  expect(parts.map(p => p.id)).toEqual([refundId, ...e.refundPaymentIds])
  expect(parts.map(p => ({ treatment: p.part.porTratamiento, approximate: p.part.aproximada }))).toEqual([
    { treatment: { IVA_16: { baseCents: -2874, ivaCents: -460 } }, approximate: false },
    { treatment: { IVA_16: { baseCents: -2873, ivaCents: -460 } }, approximate: false },
  ])
  expect(parts[1].at.getTime()).toBeGreaterThan(at.getTime())
  const payments = await prisma.payment.findMany({
    where: { venueId: sale.venueId, id: { in: [...e.refundPaymentIds, ...e.paymentIds] } },
    take: 10,
  })
  const order = await prisma.order.findUniqueOrThrow({ where: { id: e.newOrderId } })
  const exchange = await prisma.exchange.findUniqueOrThrow({ where: { id: e.id } })
  const links = await prisma.exchangeCreditLink.findMany({ where: { venueId: sale.venueId, exchangeId: e.id }, take: 10 })
  const audit = await prisma.activityLog.findFirstOrThrow({ where: { venueId: sale.venueId, entityId: e.id, action: 'EXCHANGE_CREATED' } })
  expect(new Set([...payments, order, exchange, ...links, audit].map(p => p.createdAt.getTime())).size).toBe(1)
}

describe('R10: un instante contable posterior a lo confirmado', () => {
  it.each(['reloj atrasado', 'empate exacto'] as const)('%s no invierte devoluciones ni su IVA', async mode => {
    const sale = await mixedSale()
    const at = new Date(Date.now() + 60000)
    const refund = await prisma.$transaction(tx => ordinaryRefund(tx, sale, at))
    const input = sale.input()
    if (mode === 'empate exacto') {
      // Sólo el reloj del dueño; Prisma y Postgres conservan sus relojes reales.
      jest.useFakeTimers({
        now: at,
        doNotFake: [
          'hrtime',
          'nextTick',
          'performance',
          'queueMicrotask',
          'setTimeout',
          'clearTimeout',
          'setInterval',
          'clearInterval',
          'setImmediate',
          'clearImmediate',
        ],
      })
    }
    const { exchange: e } = await createExchange(input)
    await checkBook(sale, refund.refundPaymentId, e, at)
    expect((await createExchange(input)).exchange.id).toBe(e.id)
  })

  it('la conexión que espera ve la devolución confirmada aunque tenga fecha futura', async () => {
    const sale = await mixedSale()
    const at = new Date(Date.now() + 60000)
    let entered!: (pid: number) => void
    let release!: () => void
    const locked = new Promise<number>(resolve => (entered = resolve))
    const resume = new Promise<void>(resolve => (release = resolve))
    const ordinary = Promise.allSettled([
      prisma.$transaction(
        async tx => {
          await lockExistingOrderForPayment(tx, { venueId: sale.venueId, orderId: sale.order.id })
          const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
          entered(pid)
          await resume
          return ordinaryRefund(tx, sale, at)
        },
        { timeout: 30000 },
      ),
    ])
    let exchange: Promise<PromiseSettledResult<Awaited<ReturnType<typeof createExchange>>>[]> | undefined
    try {
      const pid = await Promise.race([locked, ordinary.then(() => Promise.reject(new Error('No tomó el candado')))])
      exchange = Promise.allSettled([createExchange(sale.input())])
      const deadline = Date.now() + 10000
      for (;;) {
        const waiters = await prisma.$queryRaw<
          Array<{ pid: number }>
        >`SELECT pid FROM pg_stat_activity WHERE pg_blocking_pids(pid) @> ARRAY[${pid}::int]`
        if (waiters.length) {
          console.log('R10 conexiones bloqueadas', pid, waiters)
          break
        }
        if (Date.now() > deadline) throw new Error('El cambio no esperó al reembolso')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      release()
      const [refunded] = await ordinary
      const [changed] = await exchange
      if (refunded.status === 'rejected') throw refunded.reason
      if (changed.status === 'rejected') throw changed.reason
      await checkBook(sale, refunded.value.refundPaymentId, changed.value.exchange, at)
    } finally {
      release()
      await ordinary
      if (exchange) await exchange
    }
  })

  it('incluye pagos confirmados de la ascendencia, no sólo la venta que se cambia', async () => {
    s = await seedClothingSale()
    await prisma.venue.update({ where: { id: s.venueId }, data: { seatCapExempt: true } })
    const first = (await createExchange(s.input())).exchange
    const at = new Date(Date.now() + 60000)
    await prisma.payment.update({ where: { id: s.payments[0].id }, data: { createdAt: at } })
    const second = (
      await createExchange(
        s.input(
          s.body({
            originalPaymentId: first.paymentIds[0],
            returned: [{ orderItemId: first.lines.taken[0].newOrderItemIds[0], quantity: 1, restock: true, reason: 'SIZE' }],
            taken: [{ productId: s.products[2].id, quantity: 1 }],
          }),
        ),
      )
    ).exchange
    expect((await prisma.order.findUniqueOrThrow({ where: { id: second.newOrderId } })).createdAt.getTime()).toBeGreaterThan(at.getTime())
  })
})

describe('R10: la elegibilidad del regreso pertenece a la decisión del cambio', () => {
  it('una referencia histórica cruzada no permite llevarse un producto de otra sucursal', async () => {
    s = await seedClothingSale()
    other = await seedClothingSale()
    await prisma.venue.update({ where: { id: s.venueId }, data: { seatCapExempt: true } })
    await prisma.orderItem.update({ where: { id: s.order.items[0].id }, data: { productId: other.products[0].id } })
    await expect(createExchange(s.input(s.body({ taken: [{ productId: other.products[0].id, quantity: 1 }] })))).rejects.toMatchObject({
      code: 'EXCHANGE_TAKEN_NOT_SELLABLE',
      details: { productId: other.products[0].id, reason: 'NOT_FOUND' },
    })
    expect(await prisma.exchange.count({ where: { venueId: s.venueId } })).toBe(0)
  })

  it('el mismo producto conserva su rebaja si la lista cambia entre las dos lecturas del catálogo', async () => {
    s = await seedClothingSale({ list: 100, paid: 50 })
    const sale = s
    await prisma.venue.update({ where: { id: sale.venueId }, data: { seatCapExempt: true } })
    const transaction = prisma.$transaction.bind(prisma)
    jest.spyOn(prisma, '$transaction').mockImplementationOnce(((fn: (tx: Prisma.TransactionClient) => Promise<unknown>, opts: object) =>
      transaction(async tx => {
        const observed = new Proxy(tx, {
          get(target, property) {
            if (property !== 'orderItem') return Reflect.get(target, property)
            return new Proxy(target.orderItem, {
              get(delegate, operation) {
                if (operation !== 'findMany') return Reflect.get(delegate, operation)
                return async (args: Prisma.OrderItemFindManyArgs) => {
                  const rows = await delegate.findMany(args)
                  if (args.include?.product) {
                    // Otra conexión cambia la lista después de la foto que decidió la rebaja.
                    await prisma.product.update({ where: { id: sale.products[0].id }, data: { price: 200 } })
                  }
                  return rows
                }
              },
            })
          },
        })
        return fn(observed)
      }, opts)) as typeof prisma.$transaction)
    const { exchange: e } = await createExchange(sale.input(sale.body({ taken: [{ productId: sale.products[0].id, quantity: 1 }] })))
    expect(e).toMatchObject({ returnedCents: 5000, takenCents: 5000, differenceCents: 0 })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: e.newOrderId } })).total.toString()).toBe('50')
    expect((await prisma.product.findUniqueOrThrow({ where: { id: sale.products[0].id } })).price.toString()).toBe('200')
  })

  it('apagar entre la lectura y la obligación conserva la pieza pendiente; reactivar la aplica una sola vez', async () => {
    s = await seedClothingSale()
    const sale = s
    await prisma.venue.update({ where: { id: sale.venueId }, data: { seatCapExempt: true } })
    await prisma.inventory.update({ where: { productId: sale.products[0].id }, data: { currentStock: 5 } })
    const transaction = prisma.$transaction.bind(prisma)
    jest.spyOn(prisma, '$transaction').mockImplementationOnce(((fn: (tx: Prisma.TransactionClient) => Promise<unknown>, opts: object) =>
      transaction(async tx => {
        const [{ pid: reader }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
        const observed = new Proxy(tx, {
          get(target, property) {
            if (property !== 'order') return Reflect.get(target, property)
            return new Proxy(target.order, {
              get(delegate, operation) {
                if (operation !== 'create') return Reflect.get(delegate, operation)
                return async (args: Prisma.OrderCreateArgs) => {
                  const order = await delegate.create(args)
                  await transaction(async other => {
                    const [{ pid: writer }] = await other.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
                    expect(writer).not.toBe(reader)
                    await other.product.update({ where: { id: sale.products[0].id }, data: { trackInventory: false } })
                    console.log('R10 inventario: lector y escritor', reader, writer)
                  })
                  return order
                }
              },
            })
          },
        })
        return fn(observed)
      }, opts)) as typeof prisma.$transaction)
    const { exchange: e } = await createExchange(sale.input())
    const posting = await prisma.inventoryPosting.findFirstOrThrow({
      where: { venueId: sale.venueId, sourceId: e.refundPaymentIds[0], effectKind: 'CUSTOMER_RETURN' },
      include: { lines: true },
    })
    console.log('R10 regreso pendiente', JSON.stringify(posting))
    expect((await prisma.inventory.findUniqueOrThrow({ where: { productId: sale.products[0].id } })).currentStock.toString()).toBe('5')
    expect(posting).toMatchObject({ status: 'PARTIAL_FAILED', lastError: 'INVENTORY_DISABLED_AFTER_EXCHANGE' })
    expect(posting.lines[0]).toMatchObject({ status: 'PENDING', reason: 'INVENTORY_DISABLED_AFTER_EXCHANGE' })
    await transaction(async tx => {
      const product = await tx.product.update({ where: { id: sale.products[0].id }, data: { trackInventory: true } })
      await rearmCustomerReturnPostingsInTx(tx, product)
    })
    expect(await applyCustomerReturnPosting(posting.id)).toEqual({ postingId: posting.id, applied: true })
    expect((await prisma.inventory.findUniqueOrThrow({ where: { productId: sale.products[0].id } })).currentStock.toString()).toBe('6')
    expect(await applyCustomerReturnPosting(posting.id)).toBeNull()
  })
})
