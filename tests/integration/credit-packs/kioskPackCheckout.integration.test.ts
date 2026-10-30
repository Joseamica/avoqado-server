/**
 * Integración (base REAL desechable) — compra de paquete por QR en el kiosco, de punta a punta (D3 del pizarrón).
 *
 * Kiosco → `createKioskPackCheckout` → (la clienta paga en Stripe) → webhook de Connect → `fulfillPurchase` → clases suyas
 * → el kiosco ve `PAID`. Sólo Stripe y el correo se simulan; la búsqueda por teléfono, la entrega, los candados del webhook
 * y las constraints únicas son reales.
 *
 * 🔴 Antes de esto, la sesión salía sin contacto: Stripe cobraba y la entrega reventaba («Se requiere email o telefono»).
 */
import '../../__helpers__/integration-setup'

const stripeSessions = new Map<string, any>()
const mockStripeCreate = jest.fn(async (params: any) => {
  const id = `cs_kiosk_${Math.random().toString(36).slice(2, 12)}`
  const session = { id, url: `https://checkout.stripe.com/c/${id}`, expires_at: Math.floor(Date.now() / 1000) + 86_400, ...params }
  stripeSessions.set(id, session)
  return session
})
const mockStripeRetrieve = jest.fn(async (id: string) => {
  const s = stripeSessions.get(id)
  if (!s) throw Object.assign(new Error('No such checkout.session'), { code: 'resource_missing' })
  return { ...s, status: 'complete', payment_status: 'paid', amount_total: 150000, payment_intent: `pi_${id}` }
})
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    checkout: { sessions: { create: mockStripeCreate, retrieve: mockStripeRetrieve } },
    webhooks: { constructEvent: jest.fn() },
  })),
)
jest.mock('@/services/payments/ecommerceCapability', () => ({
  ...jest.requireActual('@/services/payments/ecommerceCapability'),
  resolveChargeableStripeMerchant: jest.fn(async () => ({
    id: 'ecm_itest_kiosk',
    platformFeeBps: 100,
    providerCredentials: { connectAccountId: 'acct_test' },
  })),
}))
jest.mock('@/services/superadmin/platformSettings.service', () => ({
  ...jest.requireActual('@/services/superadmin/platformSettings.service'),
  getVatRateBps: jest.fn(async () => 1600),
}))
jest.mock('@/services/email.service', () => ({
  __esModule: true,
  default: new Proxy({}, { get: () => jest.fn(async () => true) }),
}))

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { createKioskPackCheckout, getKioskPackCheckoutStatus } from '@/services/dashboard/creditPack.public.service'
import { processStripeConnectWebhookEvent } from '@/services/payments/reservation-deposit-webhook.service'
import { exigirBaseDesechable } from '../payments/webhookCheckpoint.fixture'

const RUN = Date.now()

const evento = (id: string, sessionId: string) => ({
  id,
  type: 'checkout.session.completed',
  account: 'acct_test',
  livemode: false,
  data: { id: sessionId, payment_status: 'paid', metadata: { type: 'credit_pack_purchase' } },
})

describe('Kiosco · compra de paquete por QR (integración, base real)', () => {
  let orgId: string | undefined
  let venueId: string | undefined
  let packId: string

  beforeAll(async () => {
    exigirBaseDesechable()
    const org = await prisma.organization.create({
      data: { name: 'ITEST Kiosco QR', email: `itest-kiosk-qr-${RUN}@test.com`, phone: '5550000000' },
    })
    orgId = org.id
    const venue = await prisma.venue.create({
      data: {
        name: 'ITEST Kiosco QR',
        slug: `itest-kiosk-qr-${RUN}`,
        organizationId: org.id,
        address: 'X',
        city: 'X',
        state: 'X',
        country: 'MX',
        zipCode: '00000',
        timezone: 'America/Mexico_City',
        status: 'TRIAL' as any,
      },
      select: { id: true },
    })
    venueId = venue.id
    const category = await prisma.menuCategory.create({ data: { venueId, name: 'Clases', slug: `clases-${RUN}` } })
    const product = await prisma.product.create({
      data: { venueId, sku: `KQR-${RUN}`, name: 'Pilates', categoryId: category.id, price: new Prisma.Decimal(200) },
    })
    const pack = await prisma.creditPack.create({
      data: { venueId, name: '10 clases', price: new Prisma.Decimal(1500), validityDays: 30 },
    })
    packId = pack.id
    await prisma.creditPackItem.create({ data: { creditPackId: pack.id, productId: product.id, quantity: 10 } })
  })

  afterAll(async () => {
    if (!venueId) return
    const step = (fn: () => Promise<unknown>) => fn().catch(() => {})
    await step(() => prisma.creditTransaction.deleteMany({ where: { venueId } }))
    await step(() => prisma.creditItemBalance.deleteMany({ where: { creditPackPurchase: { venueId } } }))
    await step(() => prisma.creditPackPurchase.deleteMany({ where: { venueId } }))
    await step(() => prisma.creditPackItem.deleteMany({ where: { creditPack: { venueId } } }))
    await step(() => prisma.creditPack.deleteMany({ where: { venueId } }))
    await step(() => prisma.product.deleteMany({ where: { venueId } }))
    await step(() => prisma.menuCategory.deleteMany({ where: { venueId } }))
    await step(() => prisma.customer.deleteMany({ where: { venueId } }))
    await step(() => prisma.activityLog.deleteMany({ where: { venueId } }))
    await step(() => prisma.processedStripeEvent.deleteMany({ where: { stripeEventId: { startsWith: `evt_kqr_${RUN}` } } }))
    await step(() => prisma.venue.deleteMany({ where: { id: venueId } }))
    if (orgId) await step(() => prisma.organization.deleteMany({ where: { id: orgId } }))
    await prisma.$disconnect()
  })

  it('el teléfono tecleado encuentra a la clienta guardada con otro formato y el webhook le entrega una sola vez', async () => {
    const ana = await prisma.customer.create({ data: { venueId: venueId!, firstName: 'Ana', phone: '55 1234 5678' } })

    const out = await createKioskPackCheckout({ venueId: venueId!, packId, phone: '+525512345678' })
    expect(out.url).toMatch(/^https:\/\/checkout\.stripe\.com\//)
    await expect(getKioskPackCheckoutStatus({ venueId: venueId!, sessionId: out.sessionId })).resolves.toBe('OPEN')

    await processStripeConnectWebhookEvent(evento(`evt_kqr_${RUN}_1`, out.sessionId) as any)
    // Stripe reintenta la entrega con OTRO evento de la misma sesión.
    await processStripeConnectWebhookEvent(evento(`evt_kqr_${RUN}_2`, out.sessionId) as any)

    const compras = await prisma.creditPackPurchase.findMany({ where: { venueId }, include: { itemBalances: true } })
    expect(compras).toHaveLength(1)
    expect(compras[0].customerId).toBe(ana.id)
    expect(compras[0].amountPaid.toString()).toBe('1500')
    expect(compras[0].itemBalances).toHaveLength(1)
    expect(compras[0].itemBalances[0].remainingQuantity).toBe(10)
    expect(await prisma.customer.count({ where: { venueId } })).toBe(1)
    await expect(getKioskPackCheckoutStatus({ venueId: venueId!, sessionId: out.sessionId })).resolves.toBe('PAID')
  })

  it('teléfono nuevo: el webhook crea UNA ficha con ese teléfono y le entrega', async () => {
    const out = await createKioskPackCheckout({ venueId: venueId!, packId, phone: '+525598765432' })

    await processStripeConnectWebhookEvent(evento(`evt_kqr_${RUN}_3`, out.sessionId) as any)

    const compra = await prisma.creditPackPurchase.findFirstOrThrow({
      where: { venueId, stripeCheckoutSessionId: out.sessionId },
      include: { customer: true, itemBalances: true },
    })
    expect(compra.customer.phone).toBe('+525598765432')
    expect(compra.itemBalances[0].remainingQuantity).toBe(10)
    expect(await prisma.customer.count({ where: { venueId, phone: '+525598765432' } })).toBe(1)
  })

  it('el estado de una sesión se pregunta sólo desde su negocio', async () => {
    const out = await createKioskPackCheckout({ venueId: venueId!, packId, phone: '+525511112222' })

    await expect(getKioskPackCheckoutStatus({ venueId: 'otro-negocio', sessionId: out.sessionId })).rejects.toMatchObject({
      statusCode: 404,
    })
  })
})
