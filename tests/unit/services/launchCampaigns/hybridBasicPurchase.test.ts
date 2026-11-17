/**
 * Task 5 del Plan Básico: contratarlo con UN clic desde Gratis, por la compra híbrida de hoy. La tarjeta se resuelve y se
 * congela en la cotización (`quote.paymentMethodId`, dentro del `quoteHash`); `provisionHybridPurchase` la lee del snapshot
 * guardado; crea sin cobrar (`default_incomplete`), certifica la factura y sólo entonces la cobra con esa tarjeta (paso
 * `PAY_INVOICE`). Cualquier otra compra sigue igual que hoy.
 */
import { prismaMock } from '../../../__helpers__/setup'
const inventory = jest.fn()
const customers = jest.fn()
const subsList = jest.fn()
const subsCreate = jest.fn()
const subsRetrieve = jest.fn()
const paymentMethod = jest.fn()
const invoicePay = jest.fn()
const invoiceRetrieve = jest.fn()
jest.mock('@/services/access/inventarioDeObligaciones', () => ({ inventarioDeObligaciones: (...a: unknown[]) => inventory(...a) }))
jest.mock('@/services/stripe.service', () => ({
  stripe: {
    customers: {
      retrieve: (...a: unknown[]) => customers(...a),
      listBalanceTransactions: jest.fn().mockResolvedValue({ data: [], has_more: true }),
    },
    subscriptions: {
      list: (...a: unknown[]) => subsList(...a),
      create: (...a: unknown[]) => subsCreate(...a),
      retrieve: (...a: unknown[]) => subsRetrieve(...a),
    },
    paymentMethods: { retrieve: (...a: unknown[]) => paymentMethod(...a) },
    invoices: { pay: (...a: unknown[]) => invoicePay(...a), retrieve: (...a: unknown[]) => invoiceRetrieve(...a) },
  },
  getOrCreateStripeCustomer: jest.fn(),
  STRIPE_DENTRO_DEL_CANDADO: { timeout: 15000, maxNetworkRetries: 0 },
}))
const autorizar = jest.fn()
jest.mock('@/services/access/autorizarObligacionNueva', () => ({ autorizarObligacionNueva: (...a: unknown[]) => autorizar(...a) }))
jest.mock('@/services/dashboard/seatReconciliation.service', () => ({ assertKeepSelection: jest.fn() }))
jest.mock('@/services/launchCampaigns/hybridSources', () => ({ readHybridCreditSource: jest.fn() }))
import {
  acceptHybridQuote,
  createHybridQuote,
  hybridPurchaseView,
  resolveBasicPaymentMethod,
} from '@/services/launchCampaigns/hybridPurchase.service'
import { provisionHybridPurchase } from '@/services/launchCampaigns/hybridProvision.service'
import { listPublicHybridOffers } from '@/services/launchCampaigns/hybridCampaign.service'
import { hybridHash } from '@/services/launchCampaigns/hybridProvider'

const BASIC_CODES = ['ADVANCED_REPORTS', 'CFDI', 'LOYALTY_PROGRAM', 'PROMOTIONS', 'RESERVATIONS']
const basicPubId = 'cm123456789012345678901234'
const basicCampaignId = 'cm223456789012345678901234'
const otherPubId = 'cm323456789012345678901234'
const otherCampaignId = 'cm423456789012345678901234'
const now = Date.now()
const terms = {
  currency: 'MXN',
  interval: 'MONTHLY',
  price: 578.84,
  taxIncluded: true,
  promotionCycles: null,
  renewal: { kind: 'SAME_PRICE' },
}
const basicPublication = {
  id: basicPubId,
  campaignId: basicCampaignId,
  name: 'Plan Básico',
  version: 1,
  definitionHash: 'b'.repeat(64),
  includedFeatureCodes: BASIC_CODES,
  stripePriceId: 'price_basic',
  stripeRenewalPriceId: null,
  stripeProductId: 'prod_basic',
  definition: { schemaVersion: 1, kind: 'FEATURES', basicPlan: true, seatCap: 3, featureCodes: BASIC_CODES, terms },
  campaign: {
    id: basicCampaignId,
    purpose: 'LIST',
    listProductKey: 'PLAN:BASICO',
    status: 'ACTIVE',
    startsAt: new Date(now - 10000),
    endsAt: null,
    capacity: null,
    reservedCount: 0,
    redeemedCount: 0,
    audience: 'ALL',
    eligibleOrganizationIds: [],
    currentPublicationId: basicPubId,
    promotionGroupId: null,
  },
}
const otherPublication = {
  ...basicPublication,
  id: otherPubId,
  campaignId: otherCampaignId,
  name: 'CFDI suelto',
  definitionHash: 'c'.repeat(64),
  includedFeatureCodes: ['CFDI'],
  definition: { schemaVersion: 1, kind: 'FEATURES', featureCodes: ['CFDI'], terms: { ...terms, price: 199 } },
  campaign: { ...basicPublication.campaign, id: otherCampaignId, listProductKey: 'FEATURE:CFDI', currentPublicationId: otherPubId },
}
const basicInput = { lines: [{ publicationId: basicPubId, selectedFeatureCodes: [] }] }
const card = (id: string, customer: string | null = 'cus_test', last4 = '4242') => ({
  id,
  type: 'card',
  customer,
  card: { last4, brand: 'visa' },
})
type Contract = { venueId: string; endedAt: Date | null; basic: boolean }
let contracts: Contract[] = []
const proTrial = {
  vivas: [{ subscriptionId: 'sub_pro', proyecciones: [{ tipo: 'PLAN', tier: 'PRO' }] }],
  detalle: {
    sub_pro: {
      status: 'trialing',
      customerId: 'cus_test',
      variosItems: false,
      pausaDeCobranza: false,
      metodoDeCobro: 'charge_automatically',
      terminaEn: '2026-12-17T18:00:00.000Z',
    },
  },
  conCambiosProgramados: [],
}

beforeEach(() => {
  process.env.HYBRID_BILLING_ENABLED = 'true'
  contracts = []
  customers.mockReset().mockResolvedValue({
    id: 'cus_test',
    balance: 0,
    currency: 'mxn',
    invoice_settings: { default_payment_method: 'pm_saved' },
  })
  subsList.mockReset().mockResolvedValue({ data: [], has_more: false })
  paymentMethod.mockReset().mockImplementation(async (id: string) => card(id))
  autorizar.mockReset().mockResolvedValue({ id: 'quote', status: 'ACCEPTED' })
  prismaMock.venue.findUnique.mockResolvedValue({
    id: 'venue',
    organizationId: 'org',
    stripeCustomerId: 'cus_test',
    timezone: 'America/Mexico_City',
    organization: { id: 'org', createdAt: new Date(now), email: 'test@example.test', name: 'Test' },
  })
  prismaMock.hybridOfferPublication.findMany.mockResolvedValue([basicPublication])
  prismaMock.hybridCampaign.count.mockResolvedValue(0)
  prismaMock.venueFeature.findMany.mockResolvedValue([])
  prismaMock.capabilityGrant.findMany.mockResolvedValue([])
  prismaMock.hybridContract.findMany.mockResolvedValue([])
  prismaMock.hybridContract.findFirst.mockImplementation(async ({ where }: any) => {
    const hit = contracts.find(
      c =>
        c.venueId === where.venueId &&
        (where.endedAt === null ? c.endedAt === null : true) &&
        (where.publication?.definition?.path?.[0] === 'basicPlan' ? c.basic : true),
    )
    return hit ? { id: 'contract' } : null
  })
  prismaMock.hybridRedemption.findMany.mockResolvedValue([])
  prismaMock.hybridPaymentPeriod.findFirst.mockResolvedValue(null)
  inventory.mockReset().mockResolvedValue({ vivas: [], detalle: {}, conCambiosProgramados: [] })
  prismaMock.hybridPurchase.create.mockImplementation(async ({ data }: any) => ({ id: 'quote', ...data }))
})
afterEach(() => {
  delete process.env.HYBRID_BILLING_ENABLED
})

describe('cotizar el Básico desde Gratis', () => {
  it('congela la tarjeta predeterminada del cliente en el snapshot (dentro del hash) y enseña su terminación', async () => {
    const quote = await createHybridQuote('venue', 'staff', basicInput)
    const saved = quote.quote as any
    expect(saved).toMatchObject({ total: '578.84', dueNow: '578.84', paymentMethodId: 'pm_saved', featureCodes: BASIC_CODES })
    // No en `input`: la aceptación vuelve a validar `input` con el esquema público estricto.
    expect(saved.input.paymentMethodId).toBeUndefined()
    expect(quote.quoteHash).toBe(hybridHash(saved))
    expect(hybridPurchaseView(quote)).toMatchObject({ paymentCard: { last4: '4242', brand: 'visa' } })
    // Ningún dato de la tarjeta más allá del id queda guardado.
    expect(JSON.stringify(saved)).not.toContain('4242')
  })

  it('sin predeterminada, encuentra la tarjeta de la suscripción de plan más reciente (la prueba ya terminada)', async () => {
    customers.mockResolvedValue({ id: 'cus_test', balance: 0, invoice_settings: { default_payment_method: null } })
    subsList.mockResolvedValue({
      data: [
        { id: 'sub_otra', status: 'active', metadata: { kind: 'HYBRID_PURCHASE' }, default_payment_method: 'pm_hibrida' },
        { id: 'sub_trial', status: 'canceled', metadata: { featureCode: 'PLAN_PRO' }, default_payment_method: 'pm_trial' },
        { id: 'sub_vieja', status: 'canceled', metadata: { featureCode: 'PLAN_PRO' }, default_payment_method: 'pm_vieja' },
      ],
      has_more: false,
    })
    await expect(resolveBasicPaymentMethod('cus_test')).resolves.toBe('pm_trial')
    const quote = await createHybridQuote('venue', 'staff', basicInput)
    expect((quote.quote as any).paymentMethodId).toBe('pm_trial')
    expect(subsList).toHaveBeenCalledWith(expect.objectContaining({ customer: 'cus_test', status: 'all' }), expect.anything())
  })

  it('sin tarjeta (o con una que ya no es del cliente) no congela ninguna: queda el camino de hoy', async () => {
    customers.mockResolvedValue({ id: 'cus_test', balance: 0, invoice_settings: { default_payment_method: null } })
    await expect(resolveBasicPaymentMethod('cus_test')).resolves.toBeNull()
    const sinTarjeta = await createHybridQuote('venue', 'staff', basicInput)
    expect((sinTarjeta.quote as any).paymentMethodId).toBeUndefined()
    expect(hybridPurchaseView(sinTarjeta)).not.toHaveProperty('paymentCard')
    customers.mockResolvedValue({ id: 'cus_test', balance: 0, invoice_settings: { default_payment_method: 'pm_suelta' } })
    paymentMethod.mockImplementation(async (id: string) => card(id, null))
    await expect(resolveBasicPaymentMethod('cus_test')).resolves.toBeNull()
  })

  it('con Pro en prueba → 409 con la fecha en que termina, en la zona del negocio', async () => {
    inventory.mockResolvedValue(proTrial)
    await expect(createHybridQuote('venue', 'staff', basicInput)).rejects.toMatchObject({
      statusCode: 409,
      message: 'Tu Pro sigue activo hasta el 17 de diciembre de 2026. Ese día podrás contratar el Básico.',
    })
    expect(prismaMock.hybridPurchase.create).not.toHaveBeenCalled()
  })

  it('replaceSubscriptionIds apuntando al Pro → 409 (el Básico nunca reemplaza un plan)', async () => {
    inventory.mockResolvedValue(proTrial)
    await expect(createHybridQuote('venue', 'staff', { ...basicInput, replaceSubscriptionIds: ['sub_pro'] })).rejects.toMatchObject({
      statusCode: 409,
      message: 'Tu Pro sigue activo hasta el 17 de diciembre de 2026. Ese día podrás contratar el Básico.',
    })
    expect(prismaMock.hybridPurchase.create).not.toHaveBeenCalled()
  })

  it('segundo Básico (aunque sea de otra publicación) → 409 «Ya tienes el Básico»', async () => {
    contracts = [{ venueId: 'venue', endedAt: null, basic: true }]
    await expect(createHybridQuote('venue', 'staff', basicInput)).rejects.toMatchObject({
      statusCode: 409,
      message: 'Ya tienes el Básico',
    })
    expect(prismaMock.hybridContract.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { venueId: 'venue', endedAt: null, publication: { definition: { path: ['basicPlan'], equals: true } } },
      }),
    )
  })

  it('cancelar y volver a comprar es válido; otra sucursal compra el suyo', async () => {
    contracts = [
      { venueId: 'venue', endedAt: new Date(now - 1000), basic: true },
      { venueId: 'otra-sucursal', endedAt: null, basic: true },
    ]
    await expect(createHybridQuote('venue', 'staff', basicInput)).resolves.toMatchObject({ status: 'QUOTED' })
  })

  it('el Básico combinado con otra línea (p. ej. CFDI) → 400 «El Básico se contrata solo», también reemplazando el Pro', async () => {
    prismaMock.hybridOfferPublication.findMany.mockResolvedValue([basicPublication, otherPublication])
    inventory.mockResolvedValue(proTrial)
    const combined = {
      lines: [...basicInput.lines, { publicationId: otherPubId, selectedFeatureCodes: [] }],
      replaceSubscriptionIds: ['sub_pro'],
    }
    await expect(createHybridQuote('venue', 'staff', combined)).rejects.toMatchObject({
      statusCode: 400,
      message: 'El Básico se contrata solo',
    })
    expect(prismaMock.hybridPurchase.create).not.toHaveBeenCalled()
  })

  it('regresión: una oferta que no es el Básico no lee ninguna tarjeta ni cambia la forma de su snapshot', async () => {
    prismaMock.hybridOfferPublication.findMany.mockResolvedValue([otherPublication])
    prismaMock.hybridContract.findFirst.mockClear()
    const quote = await createHybridQuote('venue', 'staff', { lines: [{ publicationId: otherPubId, selectedFeatureCodes: [] }] })
    expect(quote.quote as any).not.toHaveProperty('paymentMethodId')
    expect(paymentMethod).not.toHaveBeenCalled()
    expect(subsList).not.toHaveBeenCalled()
    expect(prismaMock.hybridContract.findFirst).not.toHaveBeenCalled()
  })
})

describe('aceptar el Básico', () => {
  async function quoted() {
    const row = await createHybridQuote('venue', 'staff', basicInput)
    const purchase = { ...row, id: 'quote', venueId: 'venue', quoteExpiresAt: new Date(now + 60000) }
    prismaMock.hybridPurchase.findUnique.mockImplementation(async ({ where }: any) => (where.id === 'quote' ? purchase : null))
    return purchase
  }

  it('si la tarjeta cambió entre cotizar y aceptar → HYBRID_QUOTE_STALE «Cambió tu tarjeta; revisa de nuevo»', async () => {
    const purchase = await quoted()
    customers.mockResolvedValue({ id: 'cus_test', balance: 0, invoice_settings: { default_payment_method: 'pm_nueva' } })
    await expect(
      acceptHybridQuote('venue', 'staff', 'quote', { quoteHash: purchase.quoteHash, clientKey: 'clave-intento-1' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'HYBRID_QUOTE_STALE', message: 'Cambió tu tarjeta; revisa de nuevo' })
    expect(autorizar).not.toHaveBeenCalled()
  })

  it('bajo el candado: un Pro dado sin suscripción entre cotizar y aceptar → 409, sin aceptar el intento', async () => {
    const purchase = await quoted()
    autorizar.mockImplementation(async (_venue: string, _customer: string, _intent: unknown, crear: any) => {
      // Granted by superadmin after the re-observation: only the read under the lock can see it.
      prismaMock.venueFeature.findMany.mockResolvedValue([
        { stripeSubscriptionId: null, endDate: new Date('2026-12-17T18:00:00.000Z'), feature: { code: 'PLAN_PRO' } },
      ])
      return crear(prismaMock, { vivas: [], detalle: {}, conCambiosProgramados: [] })
    })
    await expect(
      acceptHybridQuote('venue', 'staff', 'quote', { quoteHash: purchase.quoteHash, clientKey: 'clave-intento-1' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'HYBRID_BASIC_PLAN_ALIVE' })
    expect(prismaMock.hybridPurchase.updateMany).not.toHaveBeenCalled()
  })

  it('bajo el candado: otro Básico entregado entre cotizar y aceptar → 409 «Ya tienes el Básico»', async () => {
    const purchase = await quoted()
    autorizar.mockImplementation(async (_venue: string, _customer: string, _intent: unknown, crear: any) => {
      contracts = [{ venueId: 'venue', endedAt: null, basic: true }]
      return crear(prismaMock, { vivas: [], detalle: {}, conCambiosProgramados: [] })
    })
    await expect(
      acceptHybridQuote('venue', 'staff', 'quote', { quoteHash: purchase.quoteHash, clientKey: 'clave-intento-1' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'HYBRID_BASIC_ALREADY' })
    expect(prismaMock.hybridPurchase.updateMany).not.toHaveBeenCalled()
  })

  it('con la misma tarjeta pasa a la regla común; el reintento de un intento ya aceptado no vuelve a leer la tarjeta', async () => {
    const purchase = await quoted()
    await acceptHybridQuote('venue', 'staff', 'quote', { quoteHash: purchase.quoteHash, clientKey: 'clave-intento-1' })
    expect(autorizar).toHaveBeenCalledTimes(1)
    prismaMock.hybridPurchase.findUnique.mockResolvedValue({ ...purchase, status: 'PROVISIONING' })
    customers.mockClear()
    await expect(
      acceptHybridQuote('venue', 'staff', 'quote', { quoteHash: purchase.quoteHash, clientKey: 'clave-intento-1' }),
    ).resolves.toMatchObject({ status: 'PROVISIONING' })
    expect(customers).not.toHaveBeenCalled()
  })
})

describe('el clic cobra: provisionar el Básico con la tarjeta congelada', () => {
  const basicLine = {
    publicationId: basicPubId,
    definitionHash: basicPublication.definitionHash,
    planTier: null,
    featureCodes: BASIC_CODES,
  }
  const accepted = (quote: object) => ({
    id: 'purchase',
    venueId: 'venue',
    status: 'ACCEPTED',
    acceptedAt: new Date(),
    stripeCustomerId: 'cus_test',
    stripeSubscriptionId: null,
    quoteHash: 'quote-hash',
    quote: { schemaVersion: 1, total: '578.84', credit: '0.00', dueNow: '578.84', sources: [], lines: [basicLine], ...quote },
  })
  const subscription = (invoice: object) => ({
    id: 'sub_basic',
    customer: 'cus_test',
    status: 'active',
    metadata: { kind: 'HYBRID_PURCHASE', hybridPurchaseId: 'purchase', venueId: 'venue', quoteHash: 'quote-hash' },
    items: { has_more: false, data: [{ id: 'si_basic', quantity: 1, price: { id: 'price_basic' }, current_period_start: 100 }] },
    latest_invoice: {
      id: 'in_basic',
      customer: 'cus_test',
      currency: 'mxn',
      total: 57884,
      amount_due: 57884,
      status: 'paid',
      hosted_invoice_url: 'https://invoice.stripe.com/i/basic',
      ...invoice,
    },
  })
  const paidInvoice = { ...subscription({}).latest_invoice, status: 'paid', attempted: true }
  const openInvoice = { ...subscription({}).latest_invoice, status: 'open', attempted: false }
  // The journal survives between calls, like the rows: one operation per step, the second attempt sees the first's request.
  let ops: Record<string, any>
  beforeEach(() => {
    ops = {}
    prismaMock.hybridPurchase.findUnique.mockResolvedValue(accepted({ paymentMethodId: 'pm_saved' }))
    prismaMock.hybridPurchase.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.hybridOfferPublication.findMany.mockResolvedValue([
      { id: basicPubId, definitionHash: basicPublication.definitionHash, stripePriceId: 'price_basic', stripeProductId: 'prod_basic' },
    ])
    prismaMock.hybridBillingOperation.upsert.mockImplementation(async ({ create: data }: any) => {
      ops[data.step] ??= { id: `op-${data.step}`, ...data, createdAt: new Date(), providerId: null }
      return ops[data.step]
    })
    prismaMock.hybridBillingOperation.update.mockImplementation(async ({ where, data }: any) => {
      const hit = Object.values(ops).find(o => o.id === where.id)
      if (hit) Object.assign(hit, data)
      return hit
    })
    prismaMock.$transaction.mockImplementation(async (fn: any) => fn(prismaMock))
    prismaMock.hybridContract.createMany.mockResolvedValue({ count: 1 })
    prismaMock.hybridContract.findMany.mockResolvedValue([
      { publicationId: basicPubId, stripeItemId: 'si_basic', featureCodes: BASIC_CODES, planTier: null },
    ])
    prismaMock.activityLog.create.mockResolvedValue({})
    subsList.mockResolvedValue({ data: [], has_more: false })
    // `default_incomplete` never charges: the subscription comes back with its invoice still open.
    subsCreate.mockReset().mockResolvedValue({ ...subscription({ status: 'open' }), status: 'incomplete' })
    subsRetrieve.mockReset().mockResolvedValue({ ...subscription({ status: 'open' }), status: 'incomplete' })
    invoicePay.mockReset().mockResolvedValue(paidInvoice)
    invoiceRetrieve.mockReset().mockResolvedValue(openInvoice)
  })

  it('crea sin cobrar, certifica la factura y SÓLO después cobra $578.84 con la tarjeta del snapshot: pagada, sin enlace', async () => {
    await expect(provisionHybridPurchase('venue', 'purchase')).resolves.toEqual({
      purchaseId: 'purchase',
      status: 'ACTIVATION_PENDING',
      paymentUrl: null,
    })
    expect(subsCreate).toHaveBeenCalledTimes(1)
    expect(subsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'cus_test',
        default_payment_method: 'pm_saved',
        payment_behavior: 'default_incomplete',
        items: [{ price: 'price_basic', quantity: 1 }],
      }),
      expect.objectContaining({ idempotencyKey: 'hybrid:op-SUBSCRIPTION' }),
    )
    expect(invoicePay).toHaveBeenCalledTimes(1)
    expect(invoicePay).toHaveBeenCalledWith(
      'in_basic',
      { payment_method: 'pm_saved' },
      expect.objectContaining({ idempotencyKey: 'hybrid:op-PAY_INVOICE' }),
    )
    expect(subsCreate.mock.invocationCallOrder[0]).toBeLessThan(invoicePay.mock.invocationCallOrder[0])
    // The card comes from the stored snapshot, never from the customer again.
    expect(customers).not.toHaveBeenCalled()
    const [{ data }] = prismaMock.hybridContract.createMany.mock.calls[0] as any
    expect(data).toEqual([expect.objectContaining({ featureCodes: BASIC_CODES, publicationId: basicPubId })])
    expect(data[0]).not.toHaveProperty('cancelAt')
    expect(prismaMock.hybridPurchase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PAID' }) }),
    )
  })

  it('el saldo aceptado ya no está (la factura pide otro monto) → HYBRID_INVOICE_MISMATCH SIN haber cobrado', async () => {
    // Accepted $378.84 thanks to a $200 balance; another renewal consumed it, so Stripe now asks for $578.84.
    prismaMock.hybridPurchase.findUnique.mockResolvedValue(accepted({ paymentMethodId: 'pm_saved', dueNow: '378.84' }))
    await expect(provisionHybridPurchase('venue', 'purchase')).rejects.toMatchObject({ cause: { code: 'HYBRID_INVOICE_MISMATCH' } })
    expect(subsCreate).toHaveBeenCalledWith(expect.objectContaining({ payment_behavior: 'default_incomplete' }), expect.anything())
    expect(invoicePay).not.toHaveBeenCalled()
    expect(prismaMock.hybridContract.createMany).not.toHaveBeenCalled()
  })

  it('respuesta perdida al crear, cambio de tarjeta predeterminada y reintento → mismos parámetros, una sola suscripción y un solo cobro', async () => {
    subsCreate.mockRejectedValueOnce(new Error('socket hang up')) // Stripe created it; the answer never arrived
    await expect(provisionHybridPurchase('venue', 'purchase')).rejects.toMatchObject({ code: 'HYBRID_PROVIDER_UNKNOWN' })
    expect(invoicePay).not.toHaveBeenCalled()
    const firstRequest = ops.SUBSCRIPTION.request
    const firstHash = ops.SUBSCRIPTION.requestHash
    customers.mockResolvedValue({ id: 'cus_test', balance: 0, invoice_settings: { default_payment_method: 'pm_otra' } })
    subsList.mockResolvedValue({ data: [{ ...subscription({ status: 'open' }), status: 'incomplete' }], has_more: false })
    await expect(provisionHybridPurchase('venue', 'purchase')).resolves.toMatchObject({ status: 'ACTIVATION_PENDING' })
    expect(subsCreate).toHaveBeenCalledTimes(1)
    expect(invoicePay).toHaveBeenCalledTimes(1)
    expect(firstRequest).toMatchObject({ default_payment_method: 'pm_saved', payment_behavior: 'default_incomplete' })
    expect(hybridHash(firstRequest)).toBe(firstHash)
    expect(subsRetrieve).toHaveBeenCalledWith('sub_basic', expect.anything(), expect.anything())
  })

  it('respuesta perdida al cobrar → el reintento lee la factura ya pagada y NO vuelve a cobrar', async () => {
    invoicePay.mockRejectedValueOnce(new Error('socket hang up')) // charged; the answer never arrived
    await expect(provisionHybridPurchase('venue', 'purchase')).rejects.toMatchObject({ code: 'HYBRID_PROVIDER_UNKNOWN' })
    prismaMock.hybridPurchase.findUnique.mockResolvedValue({
      ...accepted({ paymentMethodId: 'pm_saved' }),
      status: 'PROVISIONING',
      stripeSubscriptionId: 'sub_basic',
    })
    invoiceRetrieve.mockResolvedValue(paidInvoice)
    await expect(provisionHybridPurchase('venue', 'purchase')).resolves.toMatchObject({ status: 'ACTIVATION_PENDING' })
    expect(invoicePay).toHaveBeenCalledTimes(1)
  })

  it('tarjeta que pide 3DS (o rechazada) → el enlace «Pagar» de hoy, sin un segundo intento de cobro', async () => {
    invoicePay.mockRejectedValue(
      Object.assign(new Error('requires action'), { type: 'StripeCardError', code: 'invoice_payment_intent_requires_action' }),
    )
    // Before the attempt Stripe reports it unattempted; after the failed charge, attempted and still open.
    invoiceRetrieve.mockResolvedValueOnce(openInvoice).mockResolvedValue({ ...openInvoice, attempted: true })
    await expect(provisionHybridPurchase('venue', 'purchase')).resolves.toEqual({
      purchaseId: 'purchase',
      status: 'PAYMENT_PENDING',
      paymentUrl: 'https://invoice.stripe.com/i/basic',
    })
    // Polling again recovers the attempt and keeps the link; it never charges the card twice.
    prismaMock.hybridPurchase.findUnique.mockResolvedValue({
      ...accepted({ paymentMethodId: 'pm_saved' }),
      status: 'PAYMENT_PENDING',
      stripeSubscriptionId: 'sub_basic',
    })
    await expect(provisionHybridPurchase('venue', 'purchase')).resolves.toMatchObject({ status: 'PAYMENT_PENDING' })
    expect(invoicePay).toHaveBeenCalledTimes(1)
  })

  it('sin tarjeta congelada el Básico sigue el camino de hoy (default_incomplete y enlace, sin cobro)', async () => {
    prismaMock.hybridPurchase.findUnique.mockResolvedValue(accepted({}))
    await provisionHybridPurchase('venue', 'purchase')
    const [params] = subsCreate.mock.calls[0]
    expect(params).toMatchObject({ payment_behavior: 'default_incomplete' })
    expect(params).not.toHaveProperty('default_payment_method')
    expect(invoicePay).not.toHaveBeenCalled()
  })

  it('regresión: una oferta híbrida que no es el Básico sigue con default_incomplete', async () => {
    prismaMock.hybridPurchase.findUnique.mockResolvedValue(
      accepted({ total: '199.00', dueNow: '199.00', lines: [{ ...basicLine, publicationId: otherPubId, definitionHash: 'c'.repeat(64) }] }),
    )
    prismaMock.hybridOfferPublication.findMany.mockResolvedValue([
      { id: otherPubId, definitionHash: 'c'.repeat(64), stripePriceId: 'price_other', stripeProductId: 'prod_other' },
    ])
    subsCreate.mockRejectedValue(new Error('stop after params'))
    await expect(provisionHybridPurchase('venue', 'purchase')).rejects.toThrow()
    const [params] = subsCreate.mock.calls[0]
    expect(params).toMatchObject({ payment_behavior: 'default_incomplete' })
    expect(params).not.toHaveProperty('default_payment_method')
  })
})

describe('la lista de ofertas que ve el negocio incluye el Básico vigente', () => {
  const basicCampaign = {
    ...basicPublication.campaign,
    slug: 'plan-basico',
    code: 'L_PLAN_BASICO',
    revision: 1,
  }
  const promo = (n: number) => ({
    code: `P${n}`,
    slug: `promo-${n}`,
    startsAt: new Date(now - 1000),
    endsAt: new Date(now + 86400000),
    audience: 'ALL',
    capacity: 10,
    reservedCount: 0,
    redeemedCount: 0,
    currentPublicationId: `pub_${n}`,
    promotionGroupId: null,
  })
  beforeEach(() => {
    prismaMock.hybridCampaign.findFirst.mockResolvedValue({ slug: 'plan-basico' })
    prismaMock.hybridCampaign.findUnique.mockResolvedValue(basicCampaign)
    prismaMock.hybridOfferPublication.findUnique.mockResolvedValue(basicPublication)
    prismaMock.hybridCampaign.count.mockResolvedValue(7)
    prismaMock.hybridCampaign.findMany.mockImplementation(async ({ take, skip }: any) =>
      Array.from({ length: 7 }, (_, n) => promo(n)).slice(skip, skip + take),
    )
    prismaMock.hybridOfferPublication.findMany.mockImplementation(async ({ where }: any) =>
      where.id.in.map((id: string) => ({ ...otherPublication, id })),
    )
  })

  it('con includeBasic, el Básico va primero en la página 1 y cuenta en el total, sin perder ni repetir promociones', async () => {
    const first = await listPublicHybridOffers({ page: '1', pageSize: '6', includeBasic: 'true' })
    expect(first.total).toBe(8)
    expect(first.items[0]).toMatchObject({ slug: 'plan-basico', placesRemaining: null, endsAt: null })
    expect(first.items.map(item => item.slug)).toEqual(['plan-basico', 'promo-0', 'promo-1', 'promo-2', 'promo-3', 'promo-4'])
    const second = await listPublicHybridOffers({ page: '2', pageSize: '6', includeBasic: 'true' })
    expect(second.items.map(item => item.slug)).toEqual(['promo-5', 'promo-6'])
  })

  it('una búsqueda que no lo nombra no lo trae; sin includeBasic la lista queda como hoy (clientes viejos)', async () => {
    const searched = await listPublicHybridOffers({ page: '1', pageSize: '6', q: 'cfdi', includeBasic: 'true' })
    expect(searched.items.map(item => item.slug)).not.toContain('plan-basico')
    const legacy = await listPublicHybridOffers({ page: '1', pageSize: '6' })
    expect(legacy.total).toBe(7)
    expect(legacy.items.map(item => item.slug)).not.toContain('plan-basico')
  })

  it('sin Básico en venta, la lista es la de hoy', async () => {
    prismaMock.hybridCampaign.findFirst.mockResolvedValue(null)
    const page = await listPublicHybridOffers({ page: '1', pageSize: '6', includeBasic: 'true' })
    expect(page.total).toBe(7)
    expect(page.items).toHaveLength(6)
  })
})
