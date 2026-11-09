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
import { createSaleVerification } from '@/services/tpv/sale-verification.service'
import { editOrgSaleVerification } from '@/services/dashboard/sale-verification.org.dashboard.service'
import { applyManualDiscount } from '@/services/dashboard/discountEngine.service'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  socketManager: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn(), broadcastToUser: jest.fn() },
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn(), broadcastToUser: jest.fn() },
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
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn() }))
const mockCapturedAmounts = new Map<string, number>()
const state = (pi = 'pi_test') => ({
  sessionStatus: null,
  paymentIntentId: pi,
  piStatus: 'succeeded',
  amountCapturableCents: 0,
  amountReceivedCents: mockCapturedAmounts.get(pi) ?? 10000,
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
let editorId: string
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
  editorId = (
    await prisma.staff.create({
      data: { email: `${run}-editor@example.test`, firstName: 'Oficina', lastName: 'S3', venues: { create: { venueId, role: 'OWNER' } } },
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
afterEach(() => {
  jest.restoreAllMocks()
  mockCapturedAmounts.clear()
})
afterAll(async () => {
  if (!venueId || !orgId) return
  await prisma.saleVerification.deleteMany({ where: { venueId } })
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
  await prisma.staff.deleteMany({ where: { id: { in: [staffId, editorId] } } })
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

const abonoTpv = (orderId: string) =>
  recordOrderPayment(
    venueId!,
    orderId,
    {
      amount: 2500,
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

async function verificacionParcial(customerId: string) {
  const o = await folio(customerId)
  await prisma.orderItem.create({
    data: { orderId: o.id, productName: 'Artículo de prueba', quantity: 1, unitPrice: 100, total: 100, taxAmount: 0 },
  })
  const p = await createManualPayment(venueId!, staffId, { orderId: o.id, amount: '25', tipAmount: '0', method: 'CASH', source: 'OTHER' })
  const sv = await createSaleVerification(venueId!, { paymentId: p.id, staffId, photos: [], scannedProducts: [] })
  return { o, p, sv }
}
const corregir = (id: string, amount = 50) =>
  editOrgSaleVerification(orgId!, { saleVerificationId: id, editedById: editorId, amount, reason: 'Corrección S3 fixround1' })

describe('S3 fixround1 · ramas refutadas por revisión independiente', () => {
  it('I1 fixround1: TPV parcial real → HAS_PAYMENTS → liberación succeeded salda vivo y recupera una vez', async () => {
    const c = await cliente()
    const o = await folio(c.id, true)
    await abonoTpv(o.id)
    expect(await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({
      paymentStatus: 'PARTIAL',
      loyaltyEligibleAt: null,
    })
    expect(await acceptCardOnlineOrder({ venueId: venueId!, orderId: o.id, staffId })).toMatchObject({ outcome: 'HAS_PAYMENTS' })
    const row = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(row).toMatchObject({ status: 'PENDING', paymentStatus: 'PAID' })
    expect(Number(row.paidAmount)).toBe(125)
    expect((await prisma.onlineOrder.findUniqueOrThrow({ where: { orderId: o.id } })).status).toBe('PENDING_ACCEPTANCE')
    const card = await prisma.payment.findFirstOrThrow({ where: { orderId: o.id, source: 'WEB' } })
    expect(card.processedById).toBeNull()
    expect(row.loyaltyStaffId).toBe(card.processedById)
    expect(row.loyaltyEligibleAt).toBeInstanceOf(Date)
    const charge = await prisma.onlineOrderCharge.findFirstOrThrow({ where: { onlineOrder: { orderId: o.id } } })
    await releaseCharge(charge.id)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).loyaltyEligibleAt).toEqual(row.loyaltyEligibleAt)
    expect(await prisma.payment.count({ where: { orderId: o.id } })).toBe(2)
    await comprobar(o.id, c.id)
  })

  it('I2 fixround1: manual parcial → crear verificación REAL → editar salda folio y recupera con actor editor', async () => {
    const c = await cliente()
    const { o, p, sv } = await verificacionParcial(c.id)
    expect(await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({
      paymentStatus: 'PARTIAL',
      loyaltyEligibleAt: null,
    })
    await corregir(sv.id)
    const row = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(Number(row.total)).toBe(50)
    expect(Number(row.paidAmount)).toBe(50)
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).processedById).toBe(staffId)
    expect(row.loyaltyEligibleAt).toBeInstanceOf(Date)
    expect(row.loyaltyStaffId).toBe(editorId)
    await corregir(sv.id, 60)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).loyaltyEligibleAt).toEqual(row.loyaltyEligibleAt)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).loyaltyStaffId).toBe(editorId)
    await comprobar(o.id, c.id)
  })

  it.each([0, 0.001])(
    'R11 fixround1: corregir %s normalizado a cero conserva dinero/PAID y dos recuperaciones no crean premio ni visita',
    async importe => {
      const c = await cliente()
      const { o, p, sv } = await verificacionParcial(c.id)
      await corregir(sv.id, importe)
      const row = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
      expect(row.paymentStatus).toBe('PAID')
      expect(Number(row.total)).toBe(0)
      expect(row.loyaltyStaffId).toBeNull()
      expect(Number((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).amount)).toBe(0)
      await recuperador(o.id).runNow()
      await recuperador(o.id).runNow()
      const customer = await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })
      expect({
        marca: row.loyaltyEligibleAt,
        sellos: await prisma.stampEvent.count({ where: { orderId: o.id } }),
        puntos: customer.loyaltyPoints,
        visitas: customer.totalVisits,
      }).toEqual({ marca: null, sellos: 0, puntos: 0, visitas: 0 })
    },
  )

  it('R11 fixround1: CO ya pendiente tras descuento REAL a cero no crea premio ni visita', async () => {
    const c = await cliente()
    const o = await folio(c.id)
    await prisma.orderItem.create({
      data: { orderId: o.id, productName: 'Artículo descontable', quantity: 1, unitPrice: 100, total: 100, taxAmount: 0 },
    })
    const p = await pendienteCripto(o.id)
    const editor = await prisma.staffVenue.findFirstOrThrow({ where: { staffId: editorId, venueId }, select: { id: true } })
    const descuento = await applyManualDiscount(
      o.id,
      'PERCENTAGE',
      100,
      'Cortesía cero S3',
      editor.id,
      undefined,
      undefined,
      venueId,
      true,
      editor.id,
    )
    expect(descuento.success).toBe(true)
    const antes = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(Number(antes.total)).toBe(0)
    expect(antes.paymentStatus).toBe('PENDING')
    await confirmarCripto(p.id)
    const row = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(row.paymentStatus).toBe('PAID')
    expect(Number((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).amount)).toBe(100)
    expect(row.loyaltyStaffId).toBeNull()
    await recuperador(o.id).runNow()
    await recuperador(o.id).runNow()
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })
    expect({
      marca: row.loyaltyEligibleAt,
      sellos: await prisma.stampEvent.count({ where: { orderId: o.id } }),
      puntos: customer.loyaltyPoints,
      visitas: customer.totalVisits,
    }).toEqual({ marca: null, sellos: 0, puntos: 0, visitas: 0 })
  })

  // R13 es defensivo: filas persistidas y proveedor DOBLE permiten0. No simula un cobro0 real de Stripe.
  it.each(['capture', 'release'] as const)('R13 fixround1: %s con fixture/proveedor cero no crea obligación ni beneficio', async camino => {
    const c = await cliente()
    const o = await folio(c.id, true)
    await prisma.order.update({ where: { id: o.id }, data: { subtotal: 0, total: 0, remainingBalance: 0 } })
    const charge = await prisma.onlineOrderCharge.findFirstOrThrow({ where: { onlineOrder: { orderId: o.id } } })
    await prisma.onlineOrderCharge.update({
      where: { id: charge.id },
      data: { amount: 0, ...(camino === 'release' ? { status: 'RELEASING' as const } : {}) },
    })
    mockCapturedAmounts.set(charge.paymentIntentId!, 0)
    if (camino === 'capture')
      expect(await acceptCardOnlineOrder({ venueId: venueId!, orderId: o.id, staffId })).toMatchObject({ outcome: 'OK' })
    else expect(await releaseCharge(charge.id)).toBe('CAPTURED_OUTSIDE')
    const row = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(row.paymentStatus).toBe('PAID')
    expect(Number(row.total)).toBe(0)
    expect(Number(row.paidAmount)).toBe(0)
    expect(row.loyaltyStaffId).toBeNull()
    expect(Number((await prisma.payment.findFirstOrThrow({ where: { orderId: o.id } })).amount)).toBe(0)
    await recuperador(o.id).runNow()
    await recuperador(o.id).runNow()
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })
    expect({
      marca: row.loyaltyEligibleAt,
      sellos: await prisma.stampEvent.count({ where: { orderId: o.id } }),
      puntos: customer.loyaltyPoints,
      visitas: customer.totalVisits,
    }).toEqual({ marca: null, sellos: 0, puntos: 0, visitas: 0 })
  })

  it.each(['I1', 'I2'] as const)('%s fixround1: fallo DESPUÉS del update real revierte dinero y marca juntos', async caso => {
    const c = await cliente()
    const f = caso === 'I2' ? await verificacionParcial(c.id) : { o: await folio(c.id, true), p: null, sv: null }
    if (caso === 'I1') await abonoTpv(f.o.id)
    const original = prisma.$transaction.bind(prisma) as (...a: any[]) => Promise<any>
    let escritura: Record<string, unknown> | undefined
    const spy = jest.spyOn(prisma, '$transaction').mockImplementation(((fn: any, options: any) =>
      original(
        async (tx: any) =>
          fn(
            new Proxy(tx, {
              get(target, key) {
                if (key !== 'order') return target[key]
                return {
                  ...target.order,
                  update: async (args: any) => {
                    const r = await target.order.update(args)
                    if (args.where.id === f.o.id && args.data.paymentStatus === 'PAID') {
                      escritura = args.data
                      throw new Error('S3_FIX1_DESPUES_DEL_PAID')
                    }
                    return r
                  },
                }
              },
            }),
          ),
        options,
      )) as never)
    try {
      if (caso === 'I1')
        expect(await acceptCardOnlineOrder({ venueId: venueId!, orderId: f.o.id, staffId })).toMatchObject({ outcome: 'HAS_PAYMENTS' })
      else await expect(corregir(f.sv!.id)).rejects.toThrow('S3_FIX1_DESPUES_DEL_PAID')
    } finally {
      spy.mockRestore()
    }
    expect(escritura?.loyaltyEligibleAt).toBeInstanceOf(Date)
    expect(escritura?.loyaltyStaffId).toBe(caso === 'I1' ? null : editorId)
    const row = await prisma.order.findUniqueOrThrow({ where: { id: f.o.id } })
    expect(row).toMatchObject({ paymentStatus: 'PARTIAL', loyaltyEligibleAt: null, loyaltyStaffId: null })
    expect(Number(row.total)).toBe(100)
    expect(Number(row.paidAmount)).toBe(25)
    expect(await prisma.payment.count({ where: { orderId: f.o.id } })).toBe(1)
    if (caso === 'I1') {
      const charge = await prisma.onlineOrderCharge.findFirstOrThrow({ where: { onlineOrder: { orderId: f.o.id } } })
      expect(charge.status).toBe('RELEASING')
      expect(await releaseCharge(charge.id)).toBe('CAPTURED_OUTSIDE')
    } else {
      expect(Number((await prisma.payment.findUniqueOrThrow({ where: { id: f.p!.id } })).amount)).toBe(25)
      await corregir(f.sv!.id)
    }
    await comprobar(f.o.id, c.id)
  })

  it.each([
    ['CANCELLED', 'PENDING_ACCEPTANCE', 'PARTIAL', null],
    ['DELETED', 'PENDING_ACCEPTANCE', 'PARTIAL', null],
    ['PENDING', 'REJECTED', 'PARTIAL', null],
    ['PENDING', 'EXPIRED', 'PARTIAL', null],
    ['COMPLETED', 'COMPLETED', 'PAID', new Date('2026-11-08T05:58:00Z')],
    ['COMPLETED', 'COMPLETED', 'PAID', null],
  ] as const)('I1 fixround1: libera %s/%s/%s preservando marca %s', async (status, onlineStatus, paymentStatus, marca) => {
    const c = await cliente()
    const o = await folio(c.id, true)
    await prisma.order.update({
      where: { id: o.id },
      data: { status, paymentStatus, loyaltyEligibleAt: marca, loyaltyStaffId: marca ? staffId : null },
    })
    const online = await prisma.onlineOrder.update({ where: { orderId: o.id }, data: { status: onlineStatus } })
    const charge = await prisma.onlineOrderCharge.findUniqueOrThrow({ where: { onlineOrderId: online.id } })
    await prisma.onlineOrderCharge.update({ where: { id: charge.id }, data: { status: 'RELEASING' } })
    expect(await releaseCharge(charge.id)).toBe('CAPTURED_OUTSIDE')
    await releaseCharge(charge.id)
    const row = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(row.loyaltyEligibleAt).toEqual(marca)
    expect(row.loyaltyStaffId).toBe(marca ? staffId : null)
    expect(await prisma.payment.count({ where: { orderId: o.id } })).toBe(1)
    if (marca) await comprobar(o.id, c.id, marca)
    else {
      await recuperador(o.id).runNow()
      await recuperador(o.id).runNow()
      expect(await prisma.stampEvent.count({ where: { orderId: o.id } })).toBe(0)
      expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).totalVisits).toBe(0)
    }
  })

  it('I1 fixround1: cargo huérfano registra anomalía sin pagar ni marcar una Order vecina', async () => {
    const c = await cliente()
    const o = await folio(c.id, true)
    const charge = await prisma.onlineOrderCharge.findFirstOrThrow({ where: { onlineOrder: { orderId: o.id } } })
    await prisma.onlineOrderCharge.update({ where: { id: charge.id }, data: { onlineOrderId: null, status: 'RELEASING' } })
    expect(await releaseCharge(charge.id)).toBe('CAPTURED_OUTSIDE')
    await releaseCharge(charge.id)
    expect(await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({
      paymentStatus: 'PENDING',
      loyaltyEligibleAt: null,
    })
    expect(await prisma.payment.count({ where: { orderId: o.id } })).toBe(0)
    expect(await prisma.moneyAnomaly.count({ where: { stripeEventId: `ooc:CAPTURED_OUTSIDE:${charge.id}` } })).toBe(1)
  })

  it('I2 fixround1: la corrección genérica sin folio sigue sin nueva obligación', async () => {
    const c = await cliente()
    const { o, sv } = await verificacionParcial(c.id)
    await prisma.onlineOrder.delete({ where: { orderId: o.id } })
    await corregir(sv.id)
    expect(await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({
      paymentStatus: 'PAID',
      loyaltyEligibleAt: null,
      loyaltyStaffId: null,
    })
    await recuperador(o.id).runNow()
    await recuperador(o.id).runNow()
    expect(await prisma.stampEvent.count({ where: { orderId: o.id } })).toBe(0)
  })

  it.each([new Date('2026-11-08T05:58:00Z'), null])(
    'I2 fixround1: ya PAID conserva marca/actor previos, incluso legacy %s',
    async marca => {
      const c = await cliente()
      const { o, sv } = await verificacionParcial(c.id)
      await corregir(sv.id)
      await prisma.order.update({ where: { id: o.id }, data: { loyaltyEligibleAt: marca, loyaltyStaffId: marca ? staffId : null } })
      await corregir(sv.id, 60)
      expect(await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({
        loyaltyEligibleAt: marca,
        loyaltyStaffId: marca ? staffId : null,
      })
      if (marca) await comprobar(o.id, c.id, marca)
      else {
        await recuperador(o.id).runNow()
        expect(await prisma.stampEvent.count({ where: { orderId: o.id } })).toBe(0)
      }
    },
  )

  it.each(['CANCELLED', 'DELETED'] as const)('I2 fixround1: cuenta %s conserva rechazo y dinero intacto', async status => {
    const c = await cliente()
    const { o, p, sv } = await verificacionParcial(c.id)
    await prisma.order.update({ where: { id: o.id }, data: { status } })
    await expect(corregir(sv.id)).rejects.toMatchObject({ statusCode: 409 })
    expect(Number((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).amount)).toBe(25)
    expect(await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({
      status,
      paymentStatus: 'PARTIAL',
      loyaltyEligibleAt: null,
    })
  })
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
