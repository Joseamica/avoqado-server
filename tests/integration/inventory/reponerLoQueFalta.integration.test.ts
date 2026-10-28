import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { createExchange } from '@/services/exchanges/exchange.service'
import { recordRefund } from '@/services/tpv/refund.tpv.service'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { seedClothingSale } from '../exchanges/seedExchange'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { broadcastToUser: jest.fn(), getBroadcastingService: jest.fn(() => null) },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn(async () => undefined) }))

// «Regresa al almacén lo que salió menos lo que ya regresó» (decisión «A» del founder, 28-oct). Los 6 casos de Codex rM4
// (docs/audit/2026-10-20-cambio-de-producto/codex-rM4.md) y las regresiones contra hoy. Promesa y plan:
// docs/audit/2026-10-28-inventario-reponer-lo-que-falta/
jest.setTimeout(90000)
type Seed = Awaited<ReturnType<typeof seedClothingSale>>
const fixtures: Seed[] = []
const seed = async (opts?: Parameters<typeof seedClothingSale>[0]) => {
  const s = await seedClothingSale(opts)
  fixtures.push(s)
  return s
}
beforeAll(() => {
  expect(new URL(process.env.TEST_DATABASE_URL!).pathname).toMatch(/^\/avoqado_(?:cambio_(?:fix_|r5_)?test_\d{8}|h1a_test_\d{8}(?:_\d+)?)$/)
})
afterAll(async () => {
  for (const s of fixtures) await s.cleanup()
  await prisma.$disconnect()
})

let ref = 0
const terminal = (s: Seed, cents: number) =>
  recordRefund(
    s.venueId,
    {
      venueId: s.venueId,
      originalPaymentId: s.payments[0].id,
      originalOrderId: s.order.id,
      amount: cents,
      reason: 'CUSTOMER_REQUEST',
      merchantAccountId: s.payments[0].merchantAccountId,
      authorizationNumber: `AUT${++ref}`,
      referenceNumber: `REF${ref}`,
      isPartialRefund: false,
      currency: 'MXN',
      processor: 'angelpay',
      idempotencyKey: `${s.venueId}-inv-${ref}`,
    } as Parameters<typeof recordRefund>[1],
    s.staffId,
  )
const stock = async (productId: string) => Number((await prisma.inventory.findUniqueOrThrow({ where: { productId } })).currentStock)
// El aplicador corre después del commit; se espera a que no quede ningún regreso por aplicar de la venta.
const asentado = async (orderId: string) => {
  for (let i = 0; i < 40; i++) {
    const pendientes = await prisma.inventoryPosting.count({
      where: { orderId, effectKind: 'CUSTOMER_RETURN', status: { in: ['PENDING', 'APPLYING'] } },
    })
    if (pendientes === 0) return
    await new Promise(r => setTimeout(r, 100))
  }
}

describe('reponer lo que falta — los 6 casos de rM4', () => {
  it('1. cambio de 1 de 2 piezas y la TPV devuelve toda la tarjeta: entran 2, no 1', async () => {
    const s = await seed({ card: true, quantity: 2 })
    const antes = await stock(s.products[0].id)
    await createExchange(s.input())
    await terminal(s, 100000)
    await asentado(s.order.id)
    expect(await stock(s.products[0].id)).toBe(antes + 2)
  })

  it('2. la TPV devuelve una parte y después un cambio consume el resto: entran 2, no 1', async () => {
    const s = await seed({ card: true, quantity: 2 })
    const antes = await stock(s.products[0].id)
    await terminal(s, 50000)
    await asentado(s.order.id)
    expect(await stock(s.products[0].id)).toBe(antes)
    const { exchange } = await createExchange(s.input())
    expect(exchange.status).toBe('COMPLETED')
    await asentado(s.order.id)
    expect(await stock(s.products[0].id)).toBe(antes + 2)
  })

  it('3. la venta nueva de un cambio cancelado (nunca salió) no regresa nada al devolverla', async () => {
    const s = await seed({ card: true })
    const nueva = await prisma.order.create({
      data: {
        venueId: s.venueId,
        orderNumber: `NUEVA-${s.venueId}`,
        type: 'TAKEOUT',
        source: 'AVOQADO_IOS',
        status: 'COMPLETED',
        paymentStatus: 'PAID',
        contratoDePrecio: 'IVA_INCLUIDO',
        subtotal: 100,
        taxAmount: 0,
        total: 100,
        paidAmount: 100,
        remainingBalance: 0,
        items: { create: { productId: s.products[1].id, productName: 'Falda L', quantity: 1, unitPrice: 100, taxAmount: 0, total: 100 } },
      },
      include: { items: true },
    })
    const cobro = await prisma.payment.create({
      data: {
        venueId: s.venueId,
        orderId: nueva.id,
        amount: 100,
        tipAmount: 0,
        netAmount: 100,
        feeAmount: 0,
        feePercentage: 0,
        method: 'CASH',
        source: 'POS',
        fundsFlow: 'CASH_DRAWER',
        status: 'COMPLETED',
        type: 'REGULAR',
        splitType: 'FULLPAYMENT',
      },
    })
    await prisma.exchange.create({
      data: {
        venueId: s.venueId,
        idempotencyKey: `${s.venueId}-cancelado`,
        requestHash: 'x'.repeat(64),
        status: 'CANCELLED',
        originalOrderId: s.order.id,
        originalPaymentId: s.payments[0].id,
        newOrderId: nueva.id,
        returnedAmount: 0,
        takenAmount: 100,
        differenceAmount: 100,
        settlementKind: 'COLLECT',
        lines: { returned: [], taken: [] },
        staffId: s.staffId,
      },
    })
    const antes = await stock(s.products[1].id)
    await issueRefund({
      venueId: s.venueId,
      staffId: s.staffId,
      paymentId: cobro.id,
      reason: 'RETURNED_GOODS',
      items: [{ orderItemId: nueva.items[0].id, quantity: 1 }],
      restockItemIds: [nueva.items[0].id],
    })
    await asentado(nueva.id)
    expect(await stock(s.products[1].id)).toBe(antes)
  })

  it('4. una prenda de $0 ya regresada por la devolución total no vuelve a entrar con un cambio', async () => {
    const s = await seed({ card: true })
    await prisma.product.update({ where: { id: s.products[3].id }, data: { price: new Prisma.Decimal(0) } })
    const gratis = await prisma.orderItem.create({
      data: { orderId: s.order.id, productId: s.products[2].id, productName: 'Falda XL', quantity: 1, unitPrice: 0, taxAmount: 0, total: 0 },
    })
    const antes = await stock(s.products[2].id)
    await terminal(s, 50000)
    await asentado(s.order.id)
    expect(await stock(s.products[2].id)).toBe(antes + 1)
    // Codex c1: la prueba no debe tragarse un rechazo del cambio; si no termina, no demuestra nada.
    const { exchange } = await createExchange(
      s.input(
        s.body({
          returned: [{ orderItemId: gratis.id, quantity: 1, restock: true, reason: 'SIZE' }],
          taken: [{ productId: s.products[3].id, quantity: 1 }],
        }),
      ),
    )
    expect(exchange.status).toBe('COMPLETED')
    await asentado(s.order.id)
    expect(await stock(s.products[2].id)).toBe(antes + 1)
  })

  it('5. el panel repone una pieza y la TPV devuelve el resto: entran 2, no 3', async () => {
    const s = await seed({ card: true, quantity: 2 })
    const antes = await stock(s.products[0].id)
    await issueRefund({
      venueId: s.venueId,
      staffId: s.staffId,
      paymentId: s.payments[0].id,
      reason: 'RETURNED_GOODS',
      items: [{ orderItemId: s.order.items[0].id, quantity: 1 }],
      restockItemIds: [s.order.items[0].id],
    })
    await asentado(s.order.id)
    expect(await stock(s.products[0].id)).toBe(antes + 1)
    await terminal(s, 50000)
    await asentado(s.order.id)
    expect(await stock(s.products[0].id)).toBe(antes + 2)
  })

  it('6. dos devoluciones de la TPV al mismo tiempo: entran 2, no 4', async () => {
    const s = await seed({ card: true, quantity: 2 })
    const antes = await stock(s.products[0].id)
    await Promise.all([terminal(s, 50000), terminal(s, 50000)])
    await asentado(s.order.id)
    expect(await stock(s.products[0].id)).toBe(antes + 2)
  })
})

// Codex c1 (auditoría del código): los tres que rompían la promesa.
describe('reponer lo que falta — Codex c1', () => {
  const panel = (s: Seed, cantidad: number, reponer = true) =>
    issueRefund({
      venueId: s.venueId,
      staffId: s.staffId,
      paymentId: s.payments[0].id,
      reason: 'RETURNED_GOODS',
      items: [{ orderItemId: s.order.items[0].id, quantity: cantidad }],
      ...(reponer ? { restockItemIds: [s.order.items[0].id] } : {}),
    })

  it('#1 el panel devuelve 1 de 1 con reponer: entra 1 (no se cuenta a sí mismo)', async () => {
    const s = await seed({ card: true })
    const antes = await stock(s.products[0].id)
    await panel(s, 1)
    await asentado(s.order.id)
    expect(await stock(s.products[0].id)).toBe(antes + 1)
  })

  it('#1 dos devoluciones del panel sobre el mismo renglón: entran 2', async () => {
    const s = await seed({ card: true, quantity: 2 })
    const antes = await stock(s.products[0].id)
    await panel(s, 1)
    await panel(s, 1)
    await asentado(s.order.id)
    expect(await stock(s.products[0].id)).toBe(antes + 2)
  })

  it('#1 un cambio de una pieza y el panel devuelve la otra: entran 2', async () => {
    const s = await seed({ card: true, quantity: 2 })
    const antes = await stock(s.products[0].id)
    await createExchange(s.input())
    await panel(s, 1)
    await asentado(s.order.id)
    expect(await stock(s.products[0].id)).toBe(antes + 2)
  })

  it('#2 una devolución vieja que pidió reponer pero no movió el almacén no cuenta como regresada', async () => {
    const s = await seed({ card: true, quantity: 2 })
    const antes = await stock(s.products[0].id)
    const { refundId } = await panel(s, 1)
    await asentado(s.order.id)
    // Como antes del arreglo, y con la reposición fallida: sin posting y sin movimiento; el almacén no se movió.
    await prisma.inventoryPosting.deleteMany({ where: { orderId: s.order.id, effectKind: 'CUSTOMER_RETURN' } })
    await prisma.inventoryMovement.deleteMany({ where: { reference: refundId } })
    await prisma.inventory.update({ where: { productId: s.products[0].id }, data: { currentStock: antes } })
    await terminal(s, 50000)
    await asentado(s.order.id)
    expect(await stock(s.products[0].id)).toBe(antes + 2)
  })
})

describe('reponer lo que falta — igual que hoy', () => {
  it('la TPV devuelve toda una venta sin cambios: entran todas sus piezas', async () => {
    const s = await seed({ card: true, quantity: 2 })
    const antes = await stock(s.products[0].id)
    await terminal(s, 100000)
    await asentado(s.order.id)
    expect(await stock(s.products[0].id)).toBe(antes + 2)
  })

  it('el panel devuelve sin reponer: esa pieza ya está resuelta y la TPV sólo regresa la otra', async () => {
    const s = await seed({ card: true, quantity: 2 })
    const antes = await stock(s.products[0].id)
    await issueRefund({
      venueId: s.venueId,
      staffId: s.staffId,
      paymentId: s.payments[0].id,
      reason: 'RETURNED_GOODS',
      items: [{ orderItemId: s.order.items[0].id, quantity: 1 }],
    })
    await asentado(s.order.id)
    expect(await stock(s.products[0].id)).toBe(antes)
    await terminal(s, 50000)
    await asentado(s.order.id)
    expect(await stock(s.products[0].id)).toBe(antes + 1)
  })

  it('una devolución vieja del panel que repuso sin anotación cuenta como resuelta', async () => {
    const s = await seed({ card: true, quantity: 2 })
    const antes = await stock(s.products[0].id)
    await issueRefund({
      venueId: s.venueId,
      staffId: s.staffId,
      paymentId: s.payments[0].id,
      reason: 'RETURNED_GOODS',
      items: [{ orderItemId: s.order.items[0].id, quantity: 1 }],
      restockItemIds: [s.order.items[0].id],
    })
    await asentado(s.order.id)
    // Como antes del arreglo: sin posting, sólo el movimiento de stock.
    await prisma.inventoryPosting.deleteMany({ where: { orderId: s.order.id, effectKind: 'CUSTOMER_RETURN' } })
    await terminal(s, 50000)
    await asentado(s.order.id)
    expect(await stock(s.products[0].id)).toBe(antes + 2)
  })
})
