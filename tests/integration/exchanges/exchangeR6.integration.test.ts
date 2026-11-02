import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { createExchange } from '@/services/exchanges/exchange.service'
import { ensureExchangeCreditTender } from '@/services/exchanges/exchangeCreditTender'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { getIncomeStatement } from '@/services/dashboard/accounting.dashboard.service'
import { leerCobradoDeLaOrden } from '@/services/fiscal/cobradoDeLaOrden'
import { recorrerLibros } from '@/services/fiscal/librosDeOrdenes'
import { keptMarkdownDiscountRow } from '@/services/shared/discount.service'
import { sincronizarRepartos } from '@/services/shared/repartoDescuentoTx'
import { lockExistingOrderForPayment } from '@/services/shared/paymentShiftClaim'
import { returnGiftBalanceAndCancelOrder } from '@/services/mobile/order.mobile.service'
import { bloquearLoteConOriginales } from '@/services/shared/candadosDelLote'
import * as protocolo from '@/services/shared/cobroDelProtocolo'
import * as ledger from '@/services/giftCards/giftCardLedger'
import { seedClothingSale } from './seedExchange'
import { sembrarVentaDeTarjetas, crearCobroConSaldoEnTx } from '../giftCards/sembrarTarjetasDeRegalo'
import { planear, procesarEfectos, netoVivo, type MundoComisiones } from '../commission/_mundoComisiones'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn(async () => undefined) }))
jest.setTimeout(60000)
type Seed = Awaited<ReturnType<typeof seedClothingSale>>
let s: Seed
beforeAll(() => {
  const u = new URL(process.env.TEST_DATABASE_URL!)
  expect(['localhost', '127.0.0.1']).toContain(u.hostname)
  expect(u.pathname).toMatch(/^\/avoqado_(?:h1a_test_\d{8}(?:_\d+)?|cambio_test_20261020)$/)
})
afterEach(async () => {
  jest.restoreAllMocks()
  if (s?.venueId) await s.cleanup()
})
afterAll(() => prisma.$disconnect())

it.each([false, true])('serializes two sales paid A+B with exact balances (tender initialized=%s)', async initialized => {
  s = await seedClothingSale({ list: 200 })
  // El caso con barrera observa sobres, no la serialización única del primer alta del tender.
  if (initialized) await ensureExchangeCreditTender(prisma, s.venueId)
  await prisma.payment.deleteMany({ where: { venueId: s.venueId } })
  const cards = await sembrarVentaDeTarjetas({ ...s, montos: [500, 500], metodo: 'CASH' })
  await prisma.product.update({ where: { id: s.products[3].id }, data: { price: 50 } })
  const second = await prisma.order.create({
    data: {
      venueId: s.venueId,
      orderNumber: 'SECOND-' + s.venueId,
      subtotal: 200,
      total: 200,
      taxAmount: 0,
      paidAmount: 200,
      paymentStatus: 'PAID',
      status: 'COMPLETED',
      contratoDePrecio: 'IVA_INCLUIDO',
      items: { create: { productId: s.products[0].id, quantity: 1, unitPrice: 200, total: 200, taxAmount: 0 } },
    },
    include: { items: true },
  })
  const payments: string[][] = []
  for (const orderId of [s.order.id, second.id]) {
    payments.push(
      await prisma.$transaction(async tx => {
        const ids: string[] = []
        for (const giftCardId of cards.giftCardIds) {
          const payment = await crearCobroConSaldoEnTx(tx, { ...s, orderId, monto: 100 })
          const locked = await ledger.lockGiftCardsForUpdate(tx, [giftCardId])
          await ledger.canjearSobresEnTx(tx, { ...s, orderId, paymentId: payment.id, amount: new Prisma.Decimal(100), cards: locked })
          ids.push(payment.id)
        }
        return ids
      }),
    )
  }
  const input = (i: number) =>
    s.input(
      s.body({
        originalPaymentId: payments[i][i],
        returned: [{ orderItemId: i ? second.items[0].id : s.order.items[0].id, quantity: 1, restock: true, reason: 'SIZE' }],
        taken: [{ productId: s.products[3].id, quantity: 1 }],
        settlement: { kind: 'PAYOUT', method: 'GIFT_CARD_BALANCE', expectedDifferenceCents: -15000 },
      }),
    )
  let ready!: () => void, release!: () => void, secondPidReady!: (pid: number) => void
  const firstLocked = new Promise<void>(r => (ready = r))
  const resume = new Promise<void>(r => (release = r))
  const secondPid = new Promise<number>(r => (secondPidReady = r))
  let firstPid = 0
  const real = ledger.lockGiftCardsForUpdate
  if (initialized)
    jest.spyOn(ledger, 'lockGiftCardsForUpdate').mockImplementation(async (tx, ids) => {
      const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
      const first = firstPid === 0
      if (first) firstPid = pid
      if (pid !== firstPid) secondPidReady(pid)
      const rows = await real(tx, ids)
      if (first) {
        ready()
        await resume
      }
      return rows
    })
  const a = Promise.allSettled([createExchange(input(0))])
  let b: typeof a | undefined
  try {
    if (initialized) {
      await Promise.race([
        firstLocked,
        a.then(() => {
          throw new Error('First payout never acquired an envelope')
        }),
      ])
      b = Promise.allSettled([createExchange(input(1))])
      const pid = await Promise.race([
        secondPid,
        b.then(results => {
          throw new Error(
            'Second payout never reached envelopes: ' +
              results.map(r => (r.status === 'rejected' ? String(r.reason) : r.status)).join('; '),
          )
        }),
      ])
      const until = Date.now() + 5000
      for (;;) {
        const [{ blocked }] = await prisma.$queryRaw<Array<{ blocked: boolean }>>`
        SELECT ${firstPid}::int = ANY(pg_blocking_pids(${pid}::int)) AS blocked`
        if (blocked) break
        if (Date.now() > until) throw new Error('Second payout never waited on the first envelope')
        await new Promise(r => setTimeout(r, 10))
      }
    } else b = Promise.allSettled([createExchange(input(1))])
    release()
    const results = [...(await a), ...(await b)]
    expect(results.map(r => (r.status === 'rejected' ? String(r.reason) : r.status))).toEqual(['fulfilled', 'fulfilled'])
    expect(
      (await prisma.giftCard.findMany({ where: { id: { in: cards.giftCardIds } }, orderBy: { id: 'asc' }, take: 2 })).map(c =>
        Number(c.balance),
      ),
    ).toEqual([450, 450])
    expect(await prisma.exchange.count({ where: { venueId: s.venueId } })).toBe(2)
  } finally {
    release()
    await a
    if (b) await b
  }
})

it('takes every Payment by id before returning multiple gift-card charges, even when their dates run backwards', async () => {
  s = await seedClothingSale()
  await prisma.payment.deleteMany({ where: { venueId: s.venueId } })
  const cards = await sembrarVentaDeTarjetas({ ...s, montos: [500], metodo: 'CASH' })
  const ids: string[] = []
  await prisma.$transaction(async tx => {
    for (let i = 0; i < 2; i++) {
      const p = await crearCobroConSaldoEnTx(tx, { ...s, orderId: s.order.id, monto: 100 })
      await ledger.canjearSobresEnTx(tx, {
        ...s,
        orderId: s.order.id,
        paymentId: p.id,
        amount: new Prisma.Decimal(100),
        cards: await ledger.lockGiftCardsForUpdate(tx, cards.giftCardIds),
      })
      ids.push(p.id)
    }
    await tx.order.update({ where: { id: s.order.id }, data: { paidAmount: 200, remainingBalance: 300, paymentStatus: 'PARTIAL' } })
    await tx.payment.update({ where: { id: ids[1] }, data: { createdAt: new Date(Date.now() - 60000) } })
  })
  let ready!: (pid: number) => void, release!: () => void
  const locked = new Promise<number>(r => (ready = r))
  const resume = new Promise<void>(r => (release = r))
  const blocker = Promise.allSettled([
    prisma.$transaction(
      async tx => {
        await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${ids[0]} FOR UPDATE`
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
        ready(pid)
        await resume
        await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${ids[1]} FOR UPDATE`
      },
      { timeout: 15000 },
    ),
  ])
  let work: ReturnType<typeof Promise.allSettled> | undefined
  try {
    const pid = await locked
    work = Promise.allSettled([
      returnGiftBalanceAndCancelOrder(s.venueId, s.order.id, { staffId: s.staffId, operationKey: 'r6-return-balance' }),
    ])
    const until = Date.now() + 5000
    for (;;) {
      const [{ n }] = await prisma.$queryRaw<
        Array<{ n: number }>
      >`SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`
      if (n) break
      if (Date.now() > until) throw new Error('Return never waited on the smaller Payment')
      await new Promise(r => setTimeout(r, 10))
    }
    release()
    const results = [...(await blocker), ...(await work)]
    expect(results.map(r => (r.status === 'rejected' ? String(r.reason) : r.status))).toEqual(['fulfilled', 'fulfilled'])
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: cards.giftCardIds[0] } })).balance.toNumber()).toBe(500)
  } finally {
    release()
    await blocker
    if (work) await work
  }
})

it('orders the union of original and candidate Payments before either group in concurrent administrative batches', async () => {
  s = await seedClothingSale({ payments: [250, 250] })
  const refunds: string[] = []
  for (const p of s.payments) {
    refunds.push(
      (
        await prisma.payment.create({
          data: {
            venueId: s.venueId,
            orderId: s.order.id,
            amount: -10,
            netAmount: -10,
            feeAmount: 0,
            feePercentage: 0,
            method: 'CASH',
            type: 'REFUND',
            processorData: { originalPaymentId: p.id },
          },
        })
      ).id,
    )
  }
  let entered = 0,
    ready!: () => void,
    release!: () => void
  const both = new Promise<void>(r => (ready = r)),
    resume = new Promise<void>(r => (release = r))
  const real = protocolo.bloquearPayments
  jest.spyOn(protocolo, 'bloquearPayments').mockImplementation(async (...args) => {
    if (++entered <= 2) {
      if (entered === 2) ready()
      await resume
    }
    return real(...args)
  })
  const work = Promise.allSettled([
    prisma.$transaction(tx => bloquearLoteConOriginales(tx, { venueId: s.venueId, paymentIds: [s.payments[1].id, refunds[0]] }), {
      timeout: 15000,
    }),
    prisma.$transaction(tx => bloquearLoteConOriginales(tx, { venueId: s.venueId, paymentIds: [s.payments[0].id, refunds[1]] }), {
      timeout: 15000,
    }),
  ])
  try {
    await Promise.race([
      both,
      work.then(() => {
        throw new Error('Batches did not reach both lock groups')
      }),
    ])
    release()
    const results = await work
    expect(results.map(r => (r.status === 'rejected' ? String(r.reason) : r.status))).toEqual(['fulfilled', 'fulfilled'])
  } finally {
    release()
    await work
  }
})

it('releases an excluded refund with a smaller id when its original is already busy', async () => {
  s = await seedClothingSale({ payments: [250, 250] })
  const [refund, root] = s.payments
  await prisma.payment.update({
    where: { id: refund.id },
    data: { type: 'REFUND', amount: -10, processorData: { originalPaymentId: root.id } },
  })
  let ready!: () => void, release!: () => void
  const locked = new Promise<void>(r => (ready = r)),
    resume = new Promise<void>(r => (release = r))
  const blocker = prisma.$transaction(
    async tx => {
      await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${root.id} FOR UPDATE`
      ready()
      await resume
    },
    { timeout: 15000 },
  )
  try {
    await locked
    await prisma.$transaction(
      async tx => {
        expect(await bloquearLoteConOriginales(tx, { venueId: s.venueId, paymentIds: [refund.id] })).toMatchObject({
          bloqueados: [],
          ocupados: [refund.id],
        })
        await prisma.$transaction(t => t.$queryRaw`SELECT id FROM "Payment" WHERE id = ${refund.id} FOR UPDATE NOWAIT`)
      },
      { timeout: 15000 },
    )
  } finally {
    release()
    await blocker
  }
})

it('locks the whole refund-original pair by id even when a historical refund has the smaller id', async () => {
  s = await seedClothingSale({ payments: [250, 250] })
  const [refund, root] = s.payments
  await prisma.payment.update({
    where: { id: refund.id },
    data: { type: 'REFUND', amount: -10, processorData: { originalPaymentId: root.id } },
  })
  let ready!: (pid: number) => void, release!: () => void
  const locked = new Promise<number>(r => (ready = r)),
    resume = new Promise<void>(r => (release = r))
  const blocker = Promise.allSettled([
    prisma.$transaction(
      async tx => {
        await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${refund.id} FOR UPDATE`
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
        ready(pid)
        await resume
        await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${root.id} FOR UPDATE`
      },
      { timeout: 15000 },
    ),
  ])
  let work: ReturnType<typeof Promise.allSettled> | undefined
  try {
    const pid = await locked
    work = Promise.allSettled([
      prisma.$transaction(tx => protocolo.bloquearConSuOriginal(tx, { venueId: s.venueId, paymentId: refund.id }), { timeout: 15000 }),
    ])
    const until = Date.now() + 5000
    for (;;) {
      const [{ n }] = await prisma.$queryRaw<
        Array<{ n: number }>
      >`SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`
      if (n) break
      if (Date.now() > until) throw new Error('Pair locker never waited on the smaller Payment')
      await new Promise(r => setTimeout(r, 10))
    }
    release()
    const results = [...(await blocker), ...(await work)]
    expect(results.map(r => (r.status === 'rejected' ? String(r.reason) : r.status))).toEqual(['fulfilled', 'fulfilled'])
  } finally {
    release()
    await blocker
    if (work) await work
  }
})

it('takes the union of taken and returned Product rows before nested foreign-key inserts', async () => {
  s = await seedClothingSale()
  const [low, high] = [s.products[3].id, s.products[4].id].sort()
  await prisma.product.updateMany({ where: { id: { in: [low, high] } }, data: { price: 300 } })
  let ready!: (pid: number) => void, release!: () => void
  const locked = new Promise<number>(r => (ready = r)),
    resume = new Promise<void>(r => (release = r))
  const blocker = Promise.allSettled([
    prisma.$transaction(
      async tx => {
        // El mismo orden global que el grafo de costos de recetas; la barrera pausa después de su primera fila.
        await tx.$queryRaw`SELECT id FROM "Product" WHERE id = ${low} FOR UPDATE`
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
        ready(pid)
        await resume
        await tx.$queryRaw`SELECT id FROM "Product" WHERE id = ${high} FOR UPDATE`
      },
      { timeout: 15000 },
    ),
  ])
  let work: ReturnType<typeof Promise.allSettled> | undefined
  try {
    const pid = await locked
    work = Promise.allSettled([
      createExchange(
        s.input(
          s.body({
            taken: [
              { productId: high, quantity: 1 },
              { productId: low, quantity: 1 },
            ],
            settlement: { kind: 'COLLECT', method: 'CASH', expectedDifferenceCents: 10000 },
          }),
        ),
      ),
    ])
    const until = Date.now() + 5000
    for (;;) {
      const [{ n }] = await prisma.$queryRaw<
        Array<{ n: number }>
      >`SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`
      if (n) break
      if (Date.now() > until) throw new Error('Exchange never waited on the smaller Product')
      await new Promise(r => setTimeout(r, 10))
    }
    release()
    const results = [...(await blocker), ...(await work)]
    expect(results.map(r => (r.status === 'rejected' ? String(r.reason) : r.status))).toEqual(['fulfilled', 'fulfilled'])
  } finally {
    release()
    await blocker
    if (work) await work
  }
})

it('groups 201 inherited pieces into one line and discount, preserving inheritance and subsequent item returns and fiscal attribution', async () => {
  s = await seedClothingSale({ list: 10, paid: 8, quantity: 201 })
  const config = await prisma.commissionConfig.findFirstOrThrow({ where: { venueId: s.venueId } })
  await prisma.commissionConfig.update({ where: { id: config.id }, data: { includeTax: true } })
  const m: MundoComisiones = {
    key: s.venueId,
    orgId: s.organizationId,
    venueId: s.venueId,
    owner: s.staffId,
    ana: s.seller.id,
    bea: s.staffId,
    configId: config.id,
  }
  await planear(s.payments[0].id)
  await procesarEfectos(m)
  expect(await netoVivo({ venueId: s.venueId })).toBe('80.40')
  const { exchange: e } = await createExchange(
    s.input(
      s.body({
        returned: [{ orderItemId: s.order.items[0].id, quantity: 201, restock: true, reason: 'SIZE' }],
        taken: [{ productId: s.products[1].id, quantity: 201 }],
      }),
    ),
  )
  const order = await prisma.order.findUniqueOrThrow({ where: { id: e.newOrderId }, include: { items: true, orderDiscounts: true } })
  expect(order.items).toHaveLength(1)
  expect(order.orderDiscounts).toHaveLength(1)
  expect(order.items[0]).toMatchObject({ quantity: 201, unitPrice: new Prisma.Decimal(10), discountAmount: new Prisma.Decimal(402) })
  expect(e.lines.taken[0].pieces).toEqual(
    Array.from({ length: 201 }, () => ({ priceCents: 800, inheritedFromOrderItemId: s.order.items[0].id })),
  )
  expect(e.lines.taken[0].newOrderItemIds).toEqual([order.items[0].id])
  expect((await leerCobradoDeLaOrden(prisma, e.newOrderId)).cobradoCents.get(order.items[0].id)).toBe(160800)
  const parts: Array<{ aproximada: boolean; netCents: number; taxCents: number }> = []
  await prisma.$transaction(tx =>
    recorrerLibros(tx, { venueId: s.venueId, orderIds: [e.newOrderId], hasta: new Date(Date.now() + 60000) }, (_, p) => {
      parts.push(p)
    }),
  )
  expect(parts).toHaveLength(1)
  expect(parts[0].aproximada).toBe(false)
  expect(parts[0].netCents + parts[0].taxCents).toBe(160800)
  const filters = {
    from: new Date(Date.now() - 864e5).toISOString().slice(0, 10),
    to: new Date(Date.now() + 864e5).toISOString().slice(0, 10),
  }
  expect((await getIncomeStatement(s.venueId, filters)).revenue).toMatchObject({
    grossSalesCents: 321600,
    refundsCents: 160800,
    netRevenueCents: 160800,
  })
  expect(await netoVivo({ venueId: s.venueId })).toBe('80.40')
  expect((await prisma.inventory.findUniqueOrThrow({ where: { productId: s.products[1].id } })).currentStock.toNumber()).toBe(-191)
  const next = await createExchange(
    s.input(
      s.body({
        originalPaymentId: e.paymentIds[0],
        returned: [{ orderItemId: order.items[0].id, quantity: 1, restock: true, reason: 'SIZE' }],
        taken: [{ productId: s.products[2].id, quantity: 1 }],
      }),
    ),
  )
  expect(next.exchange.takenCents).toBe(800)
  const refund = await issueRefund({
    venueId: s.venueId,
    staffId: s.staffId,
    paymentId: e.paymentIds[0],
    items: [{ orderItemId: order.items[0].id, quantity: 1 }],
    reason: 'RETURNED_GOODS',
  })
  expect(refund).toBeDefined()
  await procesarEfectos(m)
  expect(await netoVivo({ venueId: s.venueId })).toBe('80.00')
})

it('rejects an unrepresentable grouped sale without changing the source money, stock or orders', async () => {
  s = await seedClothingSale({ list: 10, quantity: 3 })
  await prisma.orderItem.deleteMany({ where: { orderId: s.order.id } })
  const returned: ReturnType<Seed['body']>['returned'] = []
  let totalCents = 0
  await prisma.$transaction(
    async tx => {
      for (let i = 1; i <= 100; i++) {
        const paidCents = 9 * i + 1
        totalCents += paidCents
        const discount = new Prisma.Decimal(3000 - paidCents).div(100)
        const item = await tx.orderItem.create({
          data: {
            orderId: s.order.id,
            productId: s.products[0].id,
            quantity: 3,
            unitPrice: 10,
            total: 30,
            taxAmount: 0,
            discountAmount: discount,
          },
        })
        await tx.orderDiscount.create({
          data: keptMarkdownDiscountRow({
            orderId: s.order.id,
            itemId: item.id,
            discountAmountPesos: discount.toNumber(),
            appliedById: null,
          }),
        })
        returned.push({ orderItemId: item.id, quantity: 3, restock: true, reason: 'SIZE' })
      }
      await tx.order.update({
        where: { id: s.order.id },
        data: {
          subtotal: 3000,
          discountAmount: new Prisma.Decimal(300000 - totalCents).div(100),
          total: new Prisma.Decimal(totalCents).div(100),
          paidAmount: new Prisma.Decimal(totalCents).div(100),
        },
      })
      await tx.payment.update({ where: { id: s.payments[0].id }, data: { amount: new Prisma.Decimal(totalCents).div(100) } })
      await sincronizarRepartos(tx, s.order.id)
    },
    { timeout: 15000 },
  )
  const snapshot = async () => ({
    orders: await prisma.order.findMany({ where: { venueId: s.venueId }, orderBy: { id: 'asc' } }),
    payments: await prisma.payment.findMany({ where: { venueId: s.venueId }, orderBy: { id: 'asc' } }),
    stock: await prisma.inventory.findMany({ where: { venueId: s.venueId }, orderBy: { id: 'asc' } }),
    shift: await prisma.shift.findUnique({ where: { id: s.shift.id } }),
    exchanges: await prisma.exchange.count({ where: { venueId: s.venueId } }),
  })
  const before = await snapshot()
  await expect(
    createExchange(
      s.input(
        s.body({
          returned,
          taken: Array.from({ length: 100 }, (_, i) => ({
            productId: s.products[1 + (i % 2)].id,
            quantity: i === 0 ? 2 : i === 99 ? 4 : 3,
          })),
        }),
      ),
    ),
  ).rejects.toMatchObject({ code: 'EXCHANGE_SALE_TOO_LARGE', statusCode: 409 })
  expect(await snapshot()).toEqual(before)
})

it.each([50, 51])('bounds the complete ancestor scope before any Order lock (%i distinct orders)', async count => {
  s = await seedClothingSale()
  let child = s.order.id
  // FK-valid graph, built in one transaction; the shared helper must count distinct Orders, not links.
  await prisma.$transaction(
    async tx => {
      for (let i = 1; i < count; i++) {
        const parent = await tx.order.create({
          data: { venueId: s.venueId, orderNumber: `PARENT-${i}-${s.venueId}`, subtotal: 1, total: 1, taxAmount: 0 },
        })
        const root = await tx.payment.create({
          data: { venueId: s.venueId, orderId: parent.id, amount: 1, netAmount: 1, feeAmount: 0, feePercentage: 0, method: 'CASH' },
        })
        const credit = await tx.payment.create({
          data: { venueId: s.venueId, orderId: child, amount: 1, netAmount: 1, feeAmount: 0, feePercentage: 0, method: 'OTHER' },
        })
        const refund = await tx.payment.create({
          data: {
            venueId: s.venueId,
            orderId: parent.id,
            amount: -1,
            netAmount: -1,
            feeAmount: 0,
            feePercentage: 0,
            method: 'OTHER',
            type: 'REFUND',
          },
        })
        const exchange = await tx.exchange.create({
          data: {
            venueId: s.venueId,
            idempotencyKey: `graph-${i}`,
            requestHash: 'graph',
            originalOrderId: parent.id,
            originalPaymentId: root.id,
            newOrderId: child,
            returnedAmount: 1,
            takenAmount: 1,
            differenceAmount: 0,
            settlementKind: 'EVEN',
            status: 'COMPLETED',
            staffId: s.staffId,
            deviceId: 'graph',
            createdAtLocal: new Date(),
            lines: {},
          },
        })
        await tx.exchangeCreditLink.create({
          data: {
            venueId: s.venueId,
            exchangeId: exchange.id,
            originPaymentId: root.id,
            creditPaymentId: credit.id,
            creditRefundPaymentId: refund.id,
            amount: 1,
          },
        })
        child = parent.id
      }
    },
    { timeout: 15000 },
  )
  const before = await prisma.order.findMany({ where: { venueId: s.venueId }, orderBy: { id: 'asc' } })
  const work = prisma.$transaction(async tx => {
    let ok: boolean
    try {
      ok = await lockExistingOrderForPayment(tx, { venueId: s.venueId, orderId: s.order.id })
    } catch (e) {
      // La transacción rechazada aún está abierta: otra conexión puede reclamar TODAS las órdenes sin esperar.
      await prisma.$transaction(t => t.$queryRaw`SELECT id FROM "Order" WHERE "venueId" = ${s.venueId} ORDER BY id FOR UPDATE NOWAIT`)
      throw e
    }
    await tx.order.update({ where: { id: s.order.id }, data: { version: { increment: 1 } } })
    return ok
  })
  if (count === 51) {
    await expect(work).rejects.toMatchObject({ statusCode: 409, code: 'ORDER_LOCK_SCOPE_TOO_LARGE' })
    expect(await prisma.order.findMany({ where: { venueId: s.venueId }, orderBy: { id: 'asc' } })).toEqual(before)
  } else expect(await work).toBe(true)
})
