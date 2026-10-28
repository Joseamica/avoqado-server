import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { createExchange } from '@/services/exchanges/exchange.service'
import { getOrders } from '@/services/tpv/order.tpv.service'
import { listOrders } from '@/services/mobile/order.mobile.service'
import { seedCardSale } from './seedExchange'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { broadcastToUser: jest.fn(), getBroadcastingService: jest.fn(() => null) },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn(async () => undefined) }))

// MKT_26_oct (codex-apps-viejas-r2, 28-oct): mientras un cambio espera el cobro de la diferencia con tarjeta, su venta nueva es una
// cuenta CONFIRMED/PENDING por el precio COMPLETO (el crédito se aplica al cerrar). La lista «Órdenes» de una TPV vieja y la lista del
// POS la ofrecían para cobrar: $150 en vez de los $50 de diferencia. Esa cuenta no se ofrece en listas cobrables.
jest.setTimeout(60000)
let s: Awaited<ReturnType<typeof seedCardSale>> | undefined
beforeAll(() => {
  expect(new URL(process.env.TEST_DATABASE_URL!).pathname).toMatch(/^\/avoqado_(?:cambio_(?:fix_|r5_)?test_\d{8}|h1a_test_\d{8}(?:_\d+)?)$/)
})
afterAll(async () => {
  if (s) await s.cleanup()
  await prisma.$disconnect()
})

describe('la cuenta apartada de un cambio no se ofrece para cobrar', () => {
  it('no sale en «Órdenes» de la TPV ni en las cuentas por cobrar del POS; una cuenta abierta normal sí', async () => {
    s = await seedCardSale({ provider: 'ANGELPAY', amounts: [500] })
    await prisma.product.update({ where: { id: s.products[3].id }, data: { price: new Prisma.Decimal(600) } })
    const { exchange } = await createExchange(
      s.input(
        s.body({
          taken: [{ productId: s.products[3].id, quantity: 1 }],
          settlement: { kind: 'COLLECT', method: 'CARD_TERMINAL', expectedDifferenceCents: 10000 },
        }),
      ),
    )
    expect(exchange.status).toBe('PENDING_PAYMENT')
    const abierta = await prisma.order.create({
      data: {
        venueId: s.venueId,
        orderNumber: `ABIERTA-${s.venueId}`,
        type: 'TAKEOUT',
        source: 'AVOQADO_IOS',
        status: 'CONFIRMED',
        paymentStatus: 'PENDING',
        contratoDePrecio: 'IVA_INCLUIDO',
        subtotal: 100,
        taxAmount: 0,
        total: 100,
        remainingBalance: 100,
      },
    })

    const tpv = (await getOrders(s.venueId)).map(o => o.id)
    expect(tpv).toContain(abierta.id)
    expect(tpv).not.toContain(exchange.newOrderId)

    const pos = (await listOrders(s.venueId, { page: 1, pageSize: 50, paymentStatus: 'PENDING,PARTIAL' })).data.map(o => o.id)
    expect(pos).toContain(abierta.id)
    expect(pos).not.toContain(exchange.newOrderId)
  })
})
