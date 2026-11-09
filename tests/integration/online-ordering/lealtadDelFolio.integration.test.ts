/** S3: dinero y obligación en Postgres, cadena real de sellos y recuperador (sólo proveedores/avisos simulados). */
import '../../__helpers__/integration-setup'
import cuid from 'cuid'
import prisma from '@/utils/prismaClient'
import * as loyalty from '@/services/shared/loyaltyOnPaidOrder'
import { LoyaltyReconciliationJob } from '@/jobs/loyalty-reconciliation.job'
import { createManualPayment } from '@/services/dashboard/manualPayment.service'
import { settleCustomerBalance } from '@/services/dashboard/customer.dashboard.service'
import { payCashOrder } from '@/services/mobile/order.mobile.service'
import { processIntents } from '@/services/mobile/sync.mobile.service'
import { recordOrderPayment } from '@/services/tpv/payment.tpv.service'
import { acceptCardOnlineOrder } from '@/services/online-ordering/card/capture.service'
import { releaseCharge } from '@/services/online-ordering/card/release.service'
import { processWebhook } from '@/services/b4bit/b4bit.service'
import { grantStamp } from '@/services/wallet/stampLedger.service'
import { venueStartOfDay } from '@/utils/datetime'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  socketManager: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn(async () => undefined) }))
jest.mock('@/services/tpv/digitalReceipt.tpv.service', () => ({ generateDigitalReceipt: jest.fn(async () => null) }))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({ notifyCustomerPassUpdated: jest.fn() }))
jest.mock('@/services/wallet/firstStampEmail.service', () => ({ sendFirstStampEmailIfDue: jest.fn() }))
jest.mock('@/services/kds/kitchenTicketAuthoring.service', () => ({
  ...jest.requireActual('@/services/kds/kitchenTicketAuthoring.service'),
  armarComandasTrasCommit: jest.fn(),
}))
jest.mock('@/services/online-ordering/notifications.service', () => ({ notifyOrderEvent: jest.fn() }))
const state = (pi = 'pi_test') => ({
  sessionStatus: null,
  paymentIntentId: pi,
  piStatus: 'succeeded',
  amountCapturableCents: 0,
  amountReceivedCents: 10000,
  captureBefore: null,
  card: { brand: 'visa', last4: '4242', funding: 'credit' },
  paymentMethodType: 'card',
})
jest.mock('@/services/payments/provider-registry', () => ({
  getProvider: () => ({
    capture: async (_m: unknown, a: any) => state(a.paymentIntentId),
    voidAuthorization: async (_m: unknown, a: any) => state(a.paymentIntentId),
    getAuthorization: async (_m: unknown, a: any) => state(a.paymentIntentId),
  }),
}))

let venueId: string | undefined
let orgId: string | undefined
let staffId: string
let merchantId: string
let serial: string
const run = cuid()

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: run, email: `${run}@example.test`, phone: '5550000000' } })).id
  venueId = (
    await prisma.venue.create({
      data: { organizationId: orgId, name: run, slug: run, status: 'LIVE_DEMO', timezone: 'America/Mexico_City' },
    })
  ).id
  staffId = (
    await prisma.staff.create({
      data: { email: `${run}-staff@example.test`, firstName: 'Caja', lastName: 'S3', venues: { create: { venueId, role: 'MANAGER' } } },
    })
  ).id
  serial = `AVQD-${cuid()}`
  await prisma.terminal.create({ data: { venueId, name: 'TPV de S3', serialNumber: serial, type: 'TPV_ANDROID' } })
  await prisma.loyaltyConfig.create({
    data: { venueId, active: true, pointsPerDollar: 1, pointsPerVisit: 5, stampsEnabled: true, stampsRequired: 100, maxStampsPerDay: 1 },
  })
  const provider = await prisma.paymentProvider.upsert({
    where: { code: 'STRIPE_CONNECT' },
    update: {},
    create: { code: 'STRIPE_CONNECT', name: 'Stripe Connect', type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] },
  })
  merchantId = (
    await prisma.ecommerceMerchant.create({
      data: {
        venueId,
        businessName: run,
        contactEmail: `${run}@example.test`,
        publicKey: cuid(),
        secretKeyHash: cuid(),
        providerId: provider.id,
        providerCredentials: { connectAccountId: 'acct_test' },
      },
    })
  ).id
})
afterEach(() => jest.restoreAllMocks())
afterAll(async () => {
  if (!venueId || !orgId) return
  await prisma.onlineOrderCharge.deleteMany({ where: { venueId } })
  await prisma.payment.deleteMany({ where: { venueId } })
  await prisma.ecommerceMerchant.deleteMany({ where: { venueId } })
  await prisma.stampEvent.deleteMany({ where: { venueId } })
  await prisma.stampCard.deleteMany({ where: { venueId } })
  await prisma.customerOrderMetric.deleteMany({ where: { venueId } })
  await prisma.loyaltyTransaction.deleteMany({ where: { customer: { venueId } } })
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.customer.deleteMany({ where: { venueId } })
  await prisma.terminal.deleteMany({ where: { venueId } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  await prisma.venue.delete({ where: { id: venueId } })
  await prisma.staff.deleteMany({ where: { id: staffId } })
  await prisma.organization.delete({ where: { id: orgId } })
  await prisma.$disconnect()
})

async function cliente() {
  return prisma.customer.create({ data: { venueId: venueId!, firstName: 'Ana' } })
}
async function folio(customerId: string, card = false) {
  const o = await prisma.order.create({
    data: {
      venueId: venueId!,
      orderNumber: cuid(),
      source: 'WEB',
      type: 'PICKUP',
      customerId,
      subtotal: 100,
      taxAmount: 0,
      total: 100,
      remainingBalance: 100,
      createdById: staffId,
      status: 'PENDING',
      paymentStatus: 'PENDING',
      orderCustomers: { create: { customerId, isPrimary: true } },
    },
  })
  const online = await prisma.onlineOrder.create({
    data: {
      venueId: venueId!,
      orderId: o.id,
      trackingToken: cuid(),
      paymentMode: card ? 'CARD_ONLINE' : 'PAY_AT_PICKUP',
      requiresAcceptance: card,
      status: 'PENDING_ACCEPTANCE',
      acceptDeadlineAt: new Date(Date.now() + 30 * 60000),
    },
  })
  if (card)
    await prisma.onlineOrderCharge.create({
      data: {
        venueId: venueId!,
        onlineOrderId: online.id,
        ecommerceMerchantId: merchantId,
        idempotencyKey: cuid(),
        trackingToken: cuid(),
        customerPhone: '+525555000000',
        request: {},
        requestHash: cuid(),
        checkoutExpiresAt: new Date(Date.now() + 30 * 60000),
        platformFeeBps: 0,
        applicationFeeCents: 0,
        amount: 100,
        paymentIntentId: `pi_${cuid()}`,
        status: 'AUTHORIZED',
        merchantSnapshot: { connectAccountId: 'acct_test', sandboxMode: true, providerCode: 'STRIPE_CONNECT' },
      },
    })
  return o
}
function recuperador(orderId: string) {
  const scoped = (a: any) => ({ ...a, where: { AND: [a.where, { id: orderId, venueId }] } })
  return new LoyaltyReconciliationJob({
    prisma: {
      ...prisma,
      order: {
        ...prisma.order,
        findMany: (a: any) => prisma.order.findMany(scoped(a)),
        updateMany: (a: any) => prisma.order.updateMany(scoped(a)),
      },
    } as unknown as typeof prisma,
    cron: { start: jest.fn(), stop: jest.fn() },
    barrerCupones: async () => 0,
  })
}
async function comprobar(orderId: string, customerId: string, fecha?: Date) {
  const row = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
  expect(row.paymentStatus).toBe('PAID')
  expect(row.loyaltyEligibleAt).toBeInstanceOf(Date)
  await recuperador(orderId).runNow()
  await recuperador(orderId).runNow()
  const events = await prisma.stampEvent.findMany({ where: { venueId, orderId, type: 'EARN' }, take: 3 })
  expect(events).toHaveLength(1)
  if (fecha) expect(events[0].createdAt).toEqual(fecha)
  expect(await prisma.loyaltyTransaction.count({ where: { orderId, customerId, type: 'EARN' } })).toBe(1)
  expect((await prisma.customer.findUniqueOrThrow({ where: { id: customerId } })).totalVisits).toBe(1)
  expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).loyaltyProcessedAt).toBeInstanceOf(Date)
}

// Se siembra el Payment ya PENDING: S9 bloqueará el inicio nuevo, pero no puede perder esta confirmación tardía.
async function pendienteCripto(orderId: string, amount = 100) {
  return prisma.payment.create({
    data: {
      venueId: venueId!,
      orderId,
      amount,
      tipAmount: 0,
      method: 'CRYPTOCURRENCY',
      source: 'TPV',
      status: 'PENDING',
      type: 'FAST',
      processor: 'B4BIT',
      processedById: staffId,
      feePercentage: 0,
      feeAmount: 0,
      netAmount: amount,
    },
  })
}
const confirmarCripto = (id: string, amount = 100) =>
  processWebhook({
    identifier: cuid(),
    reference: id,
    fiat_amount: amount,
    fiat_currency: 'MXN',
    crypto_amount: '0.001',
    currency: 'BTC',
    status: 'CO',
    tx_hash: cuid(),
    confirmations: 3,
  })

describe('S3 · folio con cliente por cada camino real de cobro', () => {
  it.each(['card', 'manual', 'cash', 'tpv', 'saldo', 'crypto'] as const)(
    '%s guarda pendiente con el dinero; caída postcommit se recupera una sola vez',
    async canal => {
      const c = await cliente()
      const o = await folio(c.id, canal === 'card')
      const fail = jest.spyOn(loyalty, 'awardLoyaltyForPaidOrder').mockRejectedValue(new Error('caída antes de otorgar'))
      try {
        if (canal === 'card')
          expect(await acceptCardOnlineOrder({ venueId: venueId!, orderId: o.id, staffId })).toMatchObject({ outcome: 'OK' })
        if (canal === 'manual')
          await createManualPayment(venueId!, staffId, { orderId: o.id, amount: '100', tipAmount: '0', method: 'CASH', source: 'OTHER' })
        if (canal === 'cash') await payCashOrder(venueId!, o.id, { amount: 10000, tip: 0, staffId })
        if (canal === 'saldo') await settleCustomerBalance(venueId!, c.id, undefined, staffId)
        if (canal === 'crypto') {
          const p = await pendienteCripto(o.id)
          await confirmarCripto(p.id)
          const marca = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
          await confirmarCripto(p.id)
          const repetida = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
          expect(repetida.loyaltyEligibleAt).toEqual(marca.loyaltyEligibleAt)
          expect(repetida.loyaltyStaffId).toBe(staffId)
        }
        if (canal === 'tpv')
          await recordOrderPayment(
            venueId!,
            o.id,
            {
              amount: 10000,
              tip: 0,
              method: 'CASH',
              source: 'TPV',
              status: 'COMPLETED',
              splitType: 'FULLPAYMENT',
              staffId,
              idempotencyKey: cuid(),
              paidProductsId: [],
              deviceSerialNumber: serial,
              currency: 'MXN',
              isInternational: false,
            } as any,
            staffId,
          )
      } finally {
        fail.mockRestore()
      }
      expect(await prisma.stampEvent.count({ where: { orderId: o.id } })).toBe(0)
      await comprobar(o.id, c.id)
      expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).loyaltyPoints).toBe(105)
    },
  )

  it.each(['loyaltySaleAt', 'loyaltyEligibleAt'] as const)(
    'cadena REAL y recuperador usan %s de ayer aunque ya haya sello hoy',
    async marca => {
      const c = await cliente()
      const hoy = await folio(c.id)
      await prisma.order.update({
        where: { id: hoy.id },
        data: { status: 'COMPLETED', paymentStatus: 'PAID', loyaltyEligibleAt: new Date() },
      })
      expect(
        (await loyalty.awardLoyaltyForPaidOrder({ venueId: venueId!, orderId: hoy.id, orderTotal: 100, legacyCustomer: c })).complete,
      ).toBe(true)
      const ayer = new Date(venueStartOfDay('America/Mexico_City').getTime() - 120000)
      const o = await folio(c.id)
      await prisma.order.update({
        where: { id: o.id },
        data: {
          status: 'COMPLETED',
          paymentStatus: 'PAID',
          loyaltyEligibleAt: marca === 'loyaltyEligibleAt' ? ayer : new Date(),
          loyaltySaleAt: marca === 'loyaltySaleAt' ? ayer : null,
        },
      })
      await recuperador(o.id).runNow()
      await recuperador(o.id).runNow()
      const e = await prisma.stampEvent.findMany({ where: { orderId: o.id, type: 'EARN' }, take: 2 })
      expect(e).toHaveLength(1)
      expect(e[0].createdAt).toEqual(ayer)
      expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).totalVisits).toBe(2)
    },
  )

  it('PAY_CASH: dos días distintos de la cola, tope1, dos sellos con su fecha y sin duplicados al repetir intent', async () => {
    const c = await cliente()
    // Dentro de la ventana de clampSoldAt y a lados distintos de la medianoche local.
    const ahora = Date.now()
    const medianoche = venueStartOfDay('America/Mexico_City').getTime()
    const fechas = [medianoche - 1, ahora]
    expect(fechas[0]).toBeLessThan(medianoche)
    for (const createdAtLocal of fechas) {
      const o = await folio(c.id)
      const intent = { id: cuid(), type: 'PAY_CASH' as const, createdAtLocal, payload: { orderId: o.id, amountCents: 10000, tipCents: 0 } }
      const args = { venueId: venueId!, staffId, deviceId: cuid(), intents: [intent], authorizeIntent: () => true }
      expect((await processIntents(args))[0].status).toBe('ACKED')
      expect((await processIntents(args))[0].status).toBe('ACKED')
      await recuperador(o.id).runNow()
      const row = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
      expect(row.loyaltySaleAt).toEqual(new Date(createdAtLocal))
      expect(await prisma.stampEvent.count({ where: { orderId: o.id, createdAt: new Date(createdAtLocal) } })).toBe(1)
      expect(await prisma.payment.count({ where: { orderId: o.id, type: 'REGULAR' } })).toBe(1)
    }
  })

  it('legacy con Order válida y ambas marcas null sigue otorgando en el intento actual', async () => {
    const c = await cliente()
    const o = await folio(c.id)
    const antes = new Date()
    expect((await grantStamp(venueId!, c.id, o.id)).granted).toBe(true)
    const e = await prisma.stampEvent.findFirstOrThrow({ where: { orderId: o.id } })
    expect(e.createdAt.getTime()).toBeGreaterThanOrEqual(antes.getTime())
    expect(e.createdAt.getTime()).toBeLessThanOrEqual(Date.now())
  })

  it.each(['primary', 'legacy'] as const)('manual %s A + inputB conserva beneficiario persistido tras fallo y recuperación', async modo => {
    const a = await cliente()
    const b = await cliente()
    const o = await folio(a.id)
    if (modo === 'legacy') await prisma.orderCustomer.deleteMany({ where: { orderId: o.id } })
    const fail = jest.spyOn(loyalty, 'awardLoyaltyForPaidOrder').mockRejectedValueOnce(new Error('caída'))
    try {
      await createManualPayment(venueId!, staffId, {
        orderId: o.id,
        amount: '100',
        tipAmount: '0',
        method: 'CASH',
        source: 'OTHER',
        customerId: b.id,
      })
    } finally {
      fail.mockRestore()
    }
    await comprobar(o.id, a.id)
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: b.id } })).totalVisits).toBe(0)
    expect(await prisma.loyaltyTransaction.count({ where: { orderId: o.id, customerId: b.id } })).toBe(0)
  })

  it('R-P2-S3-2: conciliar liberación capturada de cancelada no crea elegibilidad; yaPAID conserva marca', async () => {
    for (const cancelada of [true, false]) {
      const c = await cliente()
      const o = await folio(c.id, true)
      const marca = cancelada ? null : new Date(Date.now() - 60000)
      await prisma.order.update({
        where: { id: o.id },
        data: { status: cancelada ? 'CANCELLED' : 'COMPLETED', paymentStatus: cancelada ? 'PENDING' : 'PAID', loyaltyEligibleAt: marca },
      })
      const charge = await prisma.onlineOrderCharge.findUniqueOrThrow({
        where: { onlineOrderId: (await prisma.onlineOrder.findUniqueOrThrow({ where: { orderId: o.id } })).id },
      })
      await prisma.onlineOrderCharge.update({ where: { id: charge.id }, data: { status: 'RELEASING' } })
      expect(await releaseCharge(charge.id)).toBe('CAPTURED_OUTSIDE')
      await releaseCharge(charge.id)
      const after = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
      expect(after.status).toBe(cancelada ? 'CANCELLED' : 'COMPLETED')
      expect(after.loyaltyEligibleAt).toEqual(marca)
      expect(await prisma.payment.count({ where: { orderId: o.id } })).toBe(1)
      if (cancelada) {
        await recuperador(o.id).runNow()
        expect(await prisma.stampEvent.count({ where: { orderId: o.id } })).toBe(0)
      }
    }
  })
  it.each(['partial', 'generic'] as const)('S3-4: crypto %s conserva ausencia de obligación', async caso => {
    const c = await cliente()
    const o = await folio(c.id)
    if (caso === 'generic') await prisma.onlineOrder.delete({ where: { orderId: o.id } })
    const amount = caso === 'partial' ? 25 : 100
    const p = await pendienteCripto(o.id, amount)
    await confirmarCripto(p.id, amount)
    const row = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(row.paymentStatus).toBe(caso === 'partial' ? 'PARTIAL' : 'PAID')
    expect(row.loyaltyEligibleAt).toBeNull()
    expect(row.loyaltyStaffId).toBeNull()
  })

  it('S3-4: fallo tras escribir PAID revierte dinero y marca juntos; reintento real se recupera', async () => {
    const c = await cliente()
    const o = await folio(c.id)
    const p = await pendienteCripto(o.id)
    const original = prisma.$transaction.bind(prisma) as (...a: any[]) => Promise<any>
    let vioMarca = false
    const spy = jest.spyOn(prisma, '$transaction').mockImplementation(((fn: any, options: any) =>
      original(async (tx: any) => {
        const scoped = new Proxy(tx, {
          get(target, key) {
            if (key !== 'order') return target[key]
            return {
              ...target.order,
              updateMany: async (args: any) => {
                const r = await target.order.updateMany(args)
                if (args.data.loyaltyEligibleAt) {
                  vioMarca = true
                  throw new Error('S3_DESPUES_DEL_PAID')
                }
                return r
              },
            }
          },
        })
        return fn(scoped)
      }, options)) as never)
    try {
      await expect(confirmarCripto(p.id)).rejects.toThrow('S3_DESPUES_DEL_PAID')
    } finally {
      spy.mockRestore()
    }
    expect(vioMarca).toBe(true)
    const row = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(row.paymentStatus).toBe('PENDING')
    expect(row.loyaltyEligibleAt).toBeNull()
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('PENDING')
    await confirmarCripto(p.id)
    await comprobar(o.id, c.id)
  })
})
