// tests/integration/online-ordering/cardGuards.integration.test.ts
/**
 * Integration (Postgres REAL) — pedidos en línea fase 2, tarea 8: un pedido pagado (o apartado) con tarjeta en línea no se cobra
 * en caja, no se le cambia el dinero, no se cancela a media captura y la terminal no lo ve para cobrarlo. Pagar al recoger, igual
 * que hoy. Sólo crea filas propias (sufijo único) y las borra en `afterAll`, falle o no.
 */
import { OnlineOrderChargeStatus, Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { applyOrderDiscount, cancelOrder, payCashOrder } from '@/services/mobile/order.mobile.service'
import { addCustomerToOrder, addItemsToOrder, getOrder as getTpvOrder, getOrders as getTpvOrders } from '@/services/tpv/order.tpv.service'
import { settleCustomerBalance } from '@/services/dashboard/customer.dashboard.service'
import { createManualPayment } from '@/services/dashboard/manualPayment.service'
import { settleOrder } from '@/services/dashboard/order.dashboard.service'
import { initiateCryptoPayment } from '@/services/b4bit/b4bit.service'
import { applyCouponCode } from '@/services/tpv/discount.tpv.service'

jest.setTimeout(60_000)

// El guardia global rechaza `av-db-25` y hosts remotos; esta suite exige además una base desechable o la propia de la fase.
const database = new URL(process.env.TEST_DATABASE_URL ?? '')
if (
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
  !/^\/(avoqado_[a-z0-9_]+_test_[a-z0-9_]+|av-db-25-[a-z0-9-]+)$/.test(database.pathname)
) {
  throw new Error('Esta suite sólo corre contra una base desechable (avoqado_<tarea>_test_<fecha> o av-db-25-<fase>) en localhost.')
}

jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  socketManager: { broadcastToVenue: jest.fn(), getBroadcastingService: jest.fn(() => null) },
}))
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/kds/kitchenTicketAuthoring.service', () => ({
  ...jest.requireActual('@/services/kds/kitchenTicketAuthoring.service'),
  armarComandasTrasCommit: jest.fn(async () => undefined),
}))

const RUN = `${Date.now()}${Math.floor(Math.random() * 1e4)}`

describe('Pedidos en línea con tarjeta — guardas de caja, terminal y panel (integration, real DB)', () => {
  let orgId: string | undefined
  let venueId: string | undefined
  let staffId: string | undefined
  let productId: string
  let merchantId: string
  let discountId: string
  let n = 0

  beforeAll(async () => {
    orgId = (
      await prisma.organization.create({
        data: { name: `ITEST guardas tarjeta ${RUN}`, slug: `itest-cg-org-${RUN}`, email: `itest-cg-${RUN}@t.mx`, phone: '5550000000' },
      })
    ).id
    venueId = (
      await prisma.venue.create({
        data: { organizationId: orgId, name: `ITEST guardas tarjeta ${RUN}`, slug: `itest-cg-${RUN}`, timezone: 'America/Mexico_City' },
      })
    ).id
    staffId = (await prisma.staff.create({ data: { email: `itest-cg-${RUN}@t.mx`, firstName: 'Gerente', lastName: 'Tarjeta' } })).id
    await prisma.staffVenue.create({ data: { venueId, staffId, role: 'OWNER' } })
    const category = await prisma.menuCategory.create({ data: { venueId, name: 'Flautas', slug: `flautas-cg-${RUN}` } })
    productId = (
      await prisma.product.create({ data: { venueId, name: 'Orden grande', sku: `CG-${RUN}`, price: 250, categoryId: category.id } })
    ).id
    discountId = (
      await prisma.discount.create({ data: { venueId, name: 'Diez pesos', type: 'FIXED_AMOUNT', value: 10, scope: 'ORDER', active: true } })
    ).id
    const provider = await prisma.paymentProvider.upsert({
      where: { code: 'STRIPE_CONNECT' },
      update: {},
      create: { code: 'STRIPE_CONNECT', name: 'Stripe Connect', type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] },
    })
    merchantId = (
      await prisma.ecommerceMerchant.create({
        data: {
          venueId,
          businessName: 'ITEST guardas',
          contactEmail: `itest-cg-merchant-${RUN}@t.mx`,
          publicKey: `pk_test_cg_${RUN}`,
          secretKeyHash: `itest-cg-hash-${RUN}`,
          providerId: provider.id,
          providerCredentials: { connectAccountId: 'acct_itest_cg' },
          chargesEnabled: true,
          platformFeeBps: 100,
          sandboxMode: true,
        },
      })
    ).id
  })

  afterAll(async () => {
    // Limpieza acotada: sin venueId NO se borra nada.
    if (!venueId) return
    const v = { venueId }
    try {
      const ids = (await prisma.order.findMany({ where: v, select: { id: true }, take: 500 })).map(o => o.id)
      await prisma.activityLog.deleteMany({ where: v })
      await prisma.paymentEffect.deleteMany({ where: v })
      await prisma.inventoryPosting.deleteMany({ where: v })
      await prisma.venueTransaction.deleteMany({ where: v })
      await prisma.payment.deleteMany({ where: v })
      await prisma.onlineOrderCharge.deleteMany({ where: v })
      await prisma.onlineOrder.deleteMany({ where: v })
      await prisma.orderDiscount.deleteMany({ where: { orderId: { in: ids } } })
      await prisma.kdsOrder.deleteMany({ where: v })
      await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } })
      await prisma.orderCustomer.deleteMany({ where: { orderId: { in: ids } } })
      await prisma.order.deleteMany({ where: v })
      await prisma.customer.deleteMany({ where: v })
      await prisma.ecommerceMerchant.deleteMany({ where: v })
      await prisma.discount.deleteMany({ where: v })
      await prisma.product.deleteMany({ where: v })
      await prisma.menuCategory.deleteMany({ where: v })
      await prisma.staffVenue.deleteMany({ where: v })
      if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
      await prisma.venue.deleteMany({ where: { id: venueId } })
      if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
    } catch (e) {
      console.error(`cardGuards ${RUN}: la limpieza falló (quedaron filas propias)`, e)
    }
  })

  /** Una cuenta de $250 con un renglón; con pedido en línea (tarjeta con su cargo, o al recoger) o sin él. */
  async function cuenta(modo: 'CARD_ONLINE' | 'PAY_AT_PICKUP' | null, chargeStatus: OnlineOrderChargeStatus = 'AUTHORIZED') {
    const k = ++n
    const order = await prisma.order.create({
      data: {
        venueId: venueId!,
        orderNumber: `CG-${RUN}-${k}`,
        type: 'PICKUP',
        source: modo ? 'WEB' : 'TPV',
        status: 'PENDING',
        paymentStatus: 'PENDING',
        subtotal: 250,
        discountAmount: 0,
        taxAmount: 0,
        tipAmount: 0,
        total: 250,
        paidAmount: 0,
        remainingBalance: 250,
        items: { create: [{ productId, productName: 'Orden grande', quantity: 1, unitPrice: 250, total: 250, taxAmount: 0 }] },
      },
    })
    if (!modo) return { orderId: order.id, chargeId: null as string | null }
    const online = await prisma.onlineOrder.create({
      data: {
        orderId: order.id,
        venueId: venueId!,
        paymentMode: modo,
        trackingToken: `cg-${RUN}-${k}`.padEnd(40, 't'),
        acceptDeadlineAt: new Date(Date.now() + 10 * 60_000),
      },
    })
    if (modo === 'PAY_AT_PICKUP') return { orderId: order.id, chargeId: null as string | null }
    const charge = await prisma.onlineOrderCharge.create({
      data: {
        venueId: venueId!,
        onlineOrderId: online.id,
        ecommerceMerchantId: merchantId,
        idempotencyKey: `cg-${RUN}-${k}`,
        trackingToken: `cg-${RUN}-${k}`.padEnd(40, 't'),
        customerPhone: '+525500000000',
        request: {},
        requestHash: `h-${RUN}-${k}`,
        checkoutExpiresAt: new Date(Date.now() + 30 * 60_000),
        paymentIntentId: `pi_cg_${RUN}_${k}`,
        amount: new Prisma.Decimal('250.00'),
        platformFeeBps: 100,
        applicationFeeCents: 290,
        status: chargeStatus,
        merchantSnapshot: { connectAccountId: 'acct_itest_cg', sandboxMode: true, providerCode: 'STRIPE_CONNECT' },
      },
    })
    return { orderId: order.id, chargeId: charge.id }
  }

  const rechazo = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: any) => e,
    )
  const pagadoConTarjeta = { statusCode: 409, code: 'ONLINE_ORDER_PAID_BY_CARD' }
  const sinCobros = async (orderId: string) => {
    expect(await prisma.payment.count({ where: { orderId } })).toBe(0)
    const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(o.paymentStatus).toBe('PENDING')
    expect(o.total.toFixed(2)).toBe('250.00')
  }
  const chargeStatus = async (id: string) => (await prisma.onlineOrderCharge.findUniqueOrThrow({ where: { id } })).status

  it('cancelar la cuenta desde el POS con el cargo CAPTURING → 409 ONLINE_ORDER_CONFIRMING_PAYMENT y nada cambia', async () => {
    const { orderId, chargeId } = await cuenta('CARD_ONLINE', 'CAPTURING')
    expect(await rechazo(cancelOrder(venueId!, orderId))).toMatchObject({ statusCode: 409, code: 'ONLINE_ORDER_CONFIRMING_PAYMENT' })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('PENDING')
    expect(await chargeStatus(chargeId!)).toBe('CAPTURING')
  })

  it('con el cargo AUTHORIZED → se cancela y el cargo queda RELEASING (lo libera el conciliador)', async () => {
    const { orderId, chargeId } = await cuenta('CARD_ONLINE', 'AUTHORIZED')
    await cancelOrder(venueId!, orderId)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('CANCELLED')
    expect(await chargeStatus(chargeId!)).toBe('RELEASING')
  })

  it('aplicar un descuento a un pedido de tarjeta sin capturar → 409 y el total no cambia', async () => {
    const { orderId } = await cuenta('CARD_ONLINE')
    expect(await rechazo(applyOrderDiscount(venueId!, orderId, discountId, staffId))).toMatchObject(pagadoConTarjeta)
    await sinCobros(orderId)
    expect(await prisma.orderDiscount.count({ where: { orderId } })).toBe(0)
  })

  it('agregar un renglón a un pedido de tarjeta sin capturar → 409 y los renglones no cambian', async () => {
    const { orderId } = await cuenta('CARD_ONLINE')
    const { version } = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(await rechazo(addItemsToOrder(venueId!, orderId, [{ productId, quantity: 1 }] as any, version))).toMatchObject(pagadoConTarjeta)
    expect(await prisma.orderItem.count({ where: { orderId } })).toBe(1)
    await sinCobros(orderId)
  })

  it('aplicar un cupón desde la TPV a un pedido de tarjeta sin capturar → 409 y el total no cambia', async () => {
    const { orderId } = await cuenta('CARD_ONLINE')
    expect(await rechazo(applyCouponCode(venueId!, orderId, 'NOEXISTE', 'sv-x'))).toMatchObject(pagadoConTarjeta)
    await sinCobros(orderId)
    expect(await prisma.orderDiscount.count({ where: { orderId } })).toBe(0)
  })

  it('payCashOrder sobre un pedido CARD_ONLINE → 409 ONLINE_ORDER_PAID_BY_CARD y ningún Payment', async () => {
    const { orderId } = await cuenta('CARD_ONLINE')
    const e = await rechazo(payCashOrder(venueId!, orderId, { amount: 25_000, tip: 0, idempotencyKey: `cg-pay-${orderId}` }))
    expect(e).toMatchObject(pagadoConTarjeta)
    await sinCobros(orderId)
  })

  it('el pago manual del panel y «liquidar» sobre un pedido de tarjeta → 409, nada escrito', async () => {
    const { orderId } = await cuenta('CARD_ONLINE')
    expect(await rechazo(createManualPayment(venueId!, staffId!, { orderId, amount: '250.00', method: 'CASH' } as any))).toMatchObject(
      pagadoConTarjeta,
    )
    expect(await rechazo(settleOrder(venueId!, orderId, 'qa', staffId!))).toMatchObject(pagadoConTarjeta)
    await sinCobros(orderId)
  })

  it('Codex r1 C1: ligar un cliente desde la TPV y «Liquidar saldo del cliente» no cobra en efectivo un pedido de tarjeta', async () => {
    const tarjeta = await cuenta('CARD_ONLINE')
    const recoger = await cuenta('PAY_AT_PICKUP')
    const customerId = (await prisma.customer.create({ data: { venueId: venueId!, phone: `+5255${RUN.slice(-8)}`, firstName: 'Ana' } })).id
    await addCustomerToOrder(venueId!, tarjeta.orderId, customerId, staffId)
    await addCustomerToOrder(venueId!, recoger.orderId, customerId, staffId)

    const r = await settleCustomerBalance(venueId!, customerId, 'qa', staffId!)
    // Sólo la de pagar al recoger (fiado de siempre) se liquida; la de tarjeta ni se toca.
    expect(r).toMatchObject({ settledOrderCount: 1, settledAmount: 250 })
    await sinCobros(tarjeta.orderId)
    expect(await prisma.payment.count({ where: { orderId: recoger.orderId, status: 'COMPLETED' } })).toBe(1)
  })

  it('cobrar con cripto un pedido de tarjeta → 409 antes de crear el cobro', async () => {
    const { orderId } = await cuenta('CARD_ONLINE')
    const e = await rechazo(initiateCryptoPayment({ venueId: venueId!, amount: 25_000, tip: 0, staffId: staffId!, orderId } as any))
    expect(e).toMatchObject(pagadoConTarjeta)
    await sinCobros(orderId)
  })

  it('el listado de órdenes de la TPV no trae pedidos de tarjeta y sí los al recoger (y las cuentas normales)', async () => {
    const tarjeta = await cuenta('CARD_ONLINE')
    const recoger = await cuenta('PAY_AT_PICKUP')
    const normal = await cuenta(null)
    const ids = (await getTpvOrders(venueId!)).map(o => o.id)
    expect(ids).toEqual(expect.arrayContaining([recoger.orderId, normal.orderId]))
    expect(ids).not.toContain(tarjeta.orderId)
  })

  it('la TPV pide un pedido de tarjeta para cobrarlo → 409; uno al recoger se lee como hoy', async () => {
    const tarjeta = await cuenta('CARD_ONLINE')
    const recoger = await cuenta('PAY_AT_PICKUP')
    expect(await rechazo(getTpvOrder(venueId!, tarjeta.orderId))).toMatchObject(pagadoConTarjeta)
    await expect(getTpvOrder(venueId!, recoger.orderId)).resolves.toMatchObject({ id: recoger.orderId })
  })

  it('un pedido PAY_AT_PICKUP se cobra en efectivo igual que hoy (regresión)', async () => {
    const { orderId } = await cuenta('PAY_AT_PICKUP')
    await payCashOrder(venueId!, orderId, { amount: 25_000, tip: 0, idempotencyKey: `cg-pay-${orderId}` })
    expect(await prisma.payment.count({ where: { orderId, status: 'COMPLETED' } })).toBe(1)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus).toBe('PAID')
  })
})
