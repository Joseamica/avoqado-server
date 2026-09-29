import prisma from '@/utils/prismaClient'
const subscriptions = new Map<string, any>()
const invoices = new Map<string, any>()
const payments = new Map<string, any>()
const disputes = new Map<string, any[]>()
const schedules = new Map<string, any>()
jest.mock('@/services/stripe.service', () => ({
  stripe: {
    subscriptions: {
      retrieve: jest.fn(async (id: string) => subscriptions.get(id)),
      update: jest.fn(async (id: string, params: any) => Object.assign(subscriptions.get(id), params)),
    },
    subscriptionSchedules: {
      retrieve: jest.fn(async (id: string) => schedules.get(id)),
      create: jest.fn(async ({ from_subscription }: any) => {
        const sub = subscriptions.get(from_subscription)
        const schedule = {
          id: `sched_${from_subscription}`,
          customer: sub.customer,
          subscription: sub.id,
          end_behavior: 'release',
          phases: [
            {
              start_date: sub.items.data[0].current_period_start,
              end_date: sub.items.data[0].current_period_end,
              items: sub.items.data.map((item: any) => ({ price: item.price.id, quantity: item.quantity })),
            },
          ],
        }
        schedules.set(schedule.id, schedule)
        sub.schedule = schedule.id
        return schedule
      }),
      update: jest.fn(async (id: string, params: any) => {
        const schedule = { ...schedules.get(id), ...params }
        schedules.set(id, schedule)
        return schedule
      }),
    },
    invoices: { retrieve: jest.fn(async (id: string) => invoices.get(id)) },
    invoicePayments: {
      list: jest.fn(async ({ invoice }: { invoice: string }) => ({ has_more: false, data: payments.get(invoice) ?? [] })),
    },
    disputes: { list: jest.fn(async ({ charge }: { charge: string }) => ({ data: disputes.get(charge) ?? [], has_more: false })) },
    creditNotes: { list: jest.fn(async () => ({ has_more: false, data: [] })) },
  },
  STRIPE_DENTRO_DEL_CANDADO: { timeout: 15000, maxNetworkRetries: 0 },
}))
import { reconcileHybridInvoice } from '@/services/launchCampaigns/hybridDelivery.service'
import { reconcileHybridPurchase } from '@/services/launchCampaigns/hybridLifecycle.service'
import { cancelHybridContract } from '@/services/launchCampaigns/hybridManagement.service'
import { grantedCapabilityCodes } from '@/services/access/capabilityGrants.service'
import { hybridHash } from '@/services/launchCampaigns/hybridProvider'
const stamp = `${Date.now()}${process.pid}`
let count = 0
let organizationId: string
let staffId: string
beforeAll(async () => {
  if (!/^\/(avq_hybrid_|avoqado_h1a_test_)/.test(new URL(process.env.TEST_DATABASE_URL!).pathname))
    throw new Error('Disposable DB required')
  organizationId = (await prisma.organization.create({ data: { name: stamp, email: `${stamp}@example.test`, phone: '5550000000' } })).id
  staffId = (await prisma.staff.create({ data: { email: `${stamp}@example.test`, firstName: 'Hybrid', lastName: 'Test' } })).id
})
async function fixture(paid = true, actor = staffId, withTransfer = false, input?: { keepStaffVenueIds: string[] }) {
  const key = `${stamp}${++count}`
  const now = Math.floor(Date.now() / 1000)
  const venueId = (await prisma.venue.create({ data: { name: key, slug: key, organizationId } })).id
  const definition = {
    schemaVersion: 1,
    kind: 'FEATURES',
    featureCodes: ['CFDI', 'LOYALTY_PROGRAM'],
    terms: {
      currency: 'MXN',
      interval: 'MONTHLY',
      price: 379.5,
      taxIncluded: true,
      promotionCycles: null,
      renewal: { kind: 'SAME_PRICE' },
    },
  }
  const campaign = await prisma.hybridCampaign.create({
    data: {
      code: key,
      slug: key,
      name: key,
      draftDefinition: definition,
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 86400000),
      capacity: 2,
      audience: 'ALL',
      reservedCount: 1,
      createdById: actor,
    },
  })
  const publication = await prisma.hybridOfferPublication.create({
    data: {
      campaignId: campaign.id,
      version: 1,
      name: key,
      definition,
      definitionHash: 'a'.repeat(64),
      includedFeatureCodes: definition.featureCodes,
      createdById: actor,
      stripePriceId: `price_${key}`,
      stripeProductId: `prod_${key}`,
    },
  })
  const line = {
    publicationId: publication.id,
    name: key,
    definitionHash: 'a'.repeat(64),
    kind: 'FEATURES',
    planTier: null,
    featureCodes: definition.featureCodes,
    terms: definition.terms,
  }
  const quote = {
    schemaVersion: 1,
    lines: [line],
    featureCodes: definition.featureCodes,
    total: '379.50',
    credit: withTransfer ? '379.50' : '0.00',
    dueNow: withTransfer ? '0.00' : '379.50',
    sources: withTransfer
      ? [
          {
            sourceSubscriptionId: `sub_origin_${key}`,
            sourceInvoiceId: `in_origin_${key}`,
            sourceCustomerId: `cus_${key}`,
            funded: '759.00',
            refunded: '0.00',
            alreadyCredited: '0.00',
            amount: '379.50',
            startsAt: new Date((now - 30 * 86400) * 1000).toISOString(),
            endsAt: new Date((now + 30 * 86400) * 1000).toISOString(),
          },
        ]
      : [],
    replaces: withTransfer ? [`sub_origin_${key}`] : [],
    effectiveAt: now,
    ...(input ? { input } : {}),
  }
  const purchase = await prisma.hybridPurchase.create({
    data: {
      venueId,
      quotedById: actor,
      quote,
      quoteHash: key,
      quoteExpiresAt: new Date(Date.now() + 300000),
      status: 'PAYMENT_PENDING',
      stripeCustomerId: `cus_${key}`,
      stripeSubscriptionId: `sub_${key}`,
      initialInvoiceId: `in_${key}`,
    },
  })
  const contract = await prisma.hybridContract.create({
    data: {
      venueId,
      purchaseId: purchase.id,
      publicationId: publication.id,
      stripeSubscriptionId: `sub_${key}`,
      stripeItemId: `si_${key}`,
      featureCodes: definition.featureCodes,
      startsAt: new Date(now * 1000),
    },
  })
  await prisma.hybridRedemption.create({ data: { purchaseId: purchase.id, campaignId: campaign.id, organizationId } })
  const invoice = {
    id: `in_${key}`,
    customer: `cus_${key}`,
    parent: { subscription_details: { subscription: `sub_${key}` } },
    status: paid ? 'paid' : 'open',
    currency: 'mxn',
    total: 37950,
    amount_remaining: paid ? 0 : 37950,
    starting_balance: 0,
    ending_balance: 0,
    post_payment_credit_notes_amount: 0,
    lines: {
      has_more: false,
      data: [
        {
          id: `il_${key}`,
          amount: 37950,
          quantity: 1,
          pricing: { price_details: { price: `price_${key}` } },
          parent: { subscription_item_details: { subscription_item: `si_${key}`, proration: false } },
          period: { start: now, end: now + 30 * 86400 },
        },
      ],
    },
  }
  const subscription = {
    id: `sub_${key}`,
    customer: invoice.customer,
    status: paid ? 'active' : 'incomplete',
    metadata: { kind: 'HYBRID_PURCHASE', hybridPurchaseId: purchase.id, venueId, quoteHash: key },
    schedule: null,
    items: {
      has_more: false,
      data: [
        { id: `si_${key}`, price: { id: `price_${key}` }, quantity: 1, current_period_start: now, current_period_end: now + 30 * 86400 },
      ],
    },
    latest_invoice: invoice,
  }
  subscriptions.set(subscription.id, subscription)
  invoices.set(invoice.id, invoice)
  payments.set(invoice.id, [
    {
      status: 'paid',
      currency: 'mxn',
      amount_paid: 37950,
      payment: {
        type: 'charge',
        charge: { id: `ch_${key}`, amount: 37950, amount_refunded: 0, currency: 'mxn', paid: true, disputed: false },
      },
    },
  ])
  if (withTransfer) {
    const originId = `in_origin_${key}`
    invoices.set(originId, {
      ...invoice,
      id: originId,
      total: 75900,
      parent: { subscription_details: { subscription: `sub_origin_${key}` } },
    })
    payments.set(originId, [
      {
        status: 'paid',
        currency: 'mxn',
        amount_paid: 75900,
        payment: {
          type: 'charge',
          charge: { id: `ch_origin_${key}`, amount: 75900, amount_refunded: 0, currency: 'mxn', paid: true, disputed: false },
        },
      },
    ])
    subscriptions.set(`sub_origin_${key}`, { id: `sub_origin_${key}`, customer: invoice.customer, status: 'canceled' })
    invoice.total = 0
    payments.set(invoice.id, [])
    await prisma.hybridCreditAllocation.create({
      data: { purchaseId: purchase.id, sourceInvoiceId: originId, sourceSubscriptionId: `sub_origin_${key}`, amount: '379.50' },
    })
  }
  return { venueId, purchase, contract, campaign, invoice, subscription }
}
async function team(venueId: string, members: Array<['OWNER' | 'MANAGER' | 'WAITER', Date | null, string?]>) {
  const rows = []
  for (const [role, lastLoginAt, id] of members) {
    const key = `${stamp}${++count}`
    const staff = await prisma.staff.create({ data: { email: `${key}@example.test`, firstName: role, lastName: key, lastLoginAt } })
    rows.push(await prisma.staffVenue.create({ data: { id, venueId, staffId: staff.id, role } }))
  }
  return rows
}
describe('confirmed paid periods and atomic delivery', () => {
  it('a replacement that leaves the venue on Free settles the team once, with the choice made at checkout', async () => {
    // The quote is immutable (DB trigger), so the checkout choice travels in it from the start, with known seat ids.
    const [ownerId, anaId, betoId] = ['owner', 'ana', 'beto'].map(name => `sv_${stamp}${++count}_${name}`)
    const f = await fixture(true, staffId, true, { keepStaffVenueIds: [ownerId, anaId] })
    const origin = (f.purchase.quote as any).replaces[0] as string
    const [owner, ana, beto] = await team(f.venueId, [
      ['OWNER', null, ownerId],
      ['MANAGER', new Date('2026-09-01T12:00:00Z'), anaId],
      ['WAITER', new Date('2026-09-27T12:00:00Z'), betoId],
      ['WAITER', null],
    ])
    const planPro = await prisma.feature.upsert({
      where: { code: 'PLAN_PRO' },
      update: {},
      create: { code: 'PLAN_PRO', name: 'Plan Pro', category: 'OPERATIONS', monthlyPrice: 999 },
    })
    await prisma.venueFeature.create({
      data: { venueId: f.venueId, featureId: planPro.id, monthlyPrice: 999, stripeSubscriptionId: origin },
    })

    await reconcileHybridInvoice(f.venueId, f.purchase.id, f.invoice.id)

    const active = await prisma.staffVenue.findMany({ where: { venueId: f.venueId, active: true }, select: { id: true } })
    expect(active.map(row => row.id).sort()).toEqual([owner.id, ana.id].sort())
    expect(await prisma.staffVenue.count({ where: { venueId: f.venueId, deactivatedBySeatCap: true } })).toBe(2)
    expect(
      await prisma.hybridBillingOperation.findUnique({ where: { purchaseId_step: { purchaseId: f.purchase.id, step: 'SEATS' } } }),
    ).toMatchObject({ resultHash: expect.stringMatching(/^[a-f0-9]{64}$/) })

    // Days later the owner swapped Ana for Beto; a replayed delivery must not re-apply the checkout choice.
    await prisma.staffVenue.update({ where: { id: ana.id }, data: { active: false } })
    await prisma.staffVenue.update({ where: { id: beto.id }, data: { active: true, deactivatedBySeatCap: false } })
    await reconcileHybridInvoice(f.venueId, f.purchase.id, f.invoice.id)
    expect(await prisma.staffVenue.findUniqueOrThrow({ where: { id: beto.id } })).toMatchObject({ active: true })
  })

  it('when a plan contract dies with its subscription, the team is settled to the Free cap', async () => {
    const f = await fixture()
    await reconcileHybridInvoice(f.venueId, f.purchase.id, f.invoice.id)
    await prisma.hybridContract.update({ where: { id: f.contract.id }, data: { planTier: 'PRO' } })
    const [owner, manager, waiter] = await team(f.venueId, [
      ['OWNER', null],
      ['MANAGER', new Date('2026-09-20T12:00:00Z')],
      ['WAITER', null],
    ])
    f.subscription.status = 'canceled'
    await reconcileHybridInvoice(f.venueId, f.purchase.id, f.invoice.id)
    const active = await prisma.staffVenue.findMany({ where: { venueId: f.venueId, active: true }, select: { id: true } })
    expect(active.map(row => row.id).sort()).toEqual([owner.id, manager.id].sort())
    expect(await prisma.staffVenue.findUniqueOrThrow({ where: { id: waiter.id } })).toMatchObject({
      active: false,
      deactivatedBySeatCap: true,
    })
  })

  it('a functions-only replacement whose new subscription dies before delivering leaves the team at the Free cap, with the choice made at checkout', async () => {
    // The owner chose the never-logged-in waiter: Shopify's order alone would keep the recently active manager instead.
    const [ownerId, managerId, waiterId, chosenId] = ['owner', 'manager', 'waiter', 'chosen'].map(name => `sv_${stamp}${++count}_${name}`)
    const f = await fixture(true, staffId, true, { keepStaffVenueIds: [ownerId, chosenId] })
    const origin = (f.purchase.quote as any).replaces[0] as string
    const planPro = await prisma.feature.upsert({
      where: { code: 'PLAN_PRO' },
      update: {},
      create: { code: 'PLAN_PRO', name: 'Plan Pro', category: 'OPERATIONS', monthlyPrice: 999 },
    })
    // The REPLACE step already cancelled the classic Pro and its webhook deactivated the row (the cap was left to delivery).
    await prisma.venueFeature.create({
      data: { venueId: f.venueId, featureId: planPro.id, monthlyPrice: 999, stripeSubscriptionId: origin, active: false },
    })
    await team(f.venueId, [
      ['OWNER', null, ownerId],
      ['MANAGER', new Date('2026-09-27T12:00:00Z'), managerId],
      ['WAITER', new Date('2026-09-01T12:00:00Z'), waiterId],
      ['WAITER', null, chosenId],
    ])
    f.subscription.status = 'canceled'

    await expect(reconcileHybridInvoice(f.venueId, f.purchase.id, f.invoice.id)).resolves.toEqual({ status: 'ENDED' })

    const active = await prisma.staffVenue.findMany({ where: { venueId: f.venueId, active: true }, select: { id: true } })
    expect(active.map(row => row.id).sort()).toEqual([ownerId, chosenId].sort())
    expect(await prisma.staffVenue.count({ where: { id: { in: [managerId, waiterId] }, active: false, deactivatedBySeatCap: true } })).toBe(
      2,
    )
  })

  it('once a replacement settled its team, its subscription dying later never re-applies the checkout choice', async () => {
    const [ownerId, managerId, chosenId] = ['owner', 'manager', 'chosen'].map(name => `sv_${stamp}${++count}_${name}`)
    const f = await fixture(true, staffId, true, { keepStaffVenueIds: [ownerId, chosenId] })
    const origin = (f.purchase.quote as any).replaces[0] as string
    const planPro = await prisma.feature.upsert({
      where: { code: 'PLAN_PRO' },
      update: {},
      create: { code: 'PLAN_PRO', name: 'Plan Pro', category: 'OPERATIONS', monthlyPrice: 999 },
    })
    await prisma.venueFeature.create({
      data: { venueId: f.venueId, featureId: planPro.id, monthlyPrice: 999, stripeSubscriptionId: origin, active: false },
    })
    await team(f.venueId, [
      ['OWNER', null, ownerId],
      ['MANAGER', new Date('2026-09-27T12:00:00Z'), managerId],
      ['WAITER', null, chosenId],
    ])
    await reconcileHybridInvoice(f.venueId, f.purchase.id, f.invoice.id)
    expect(await prisma.staffVenue.findUniqueOrThrow({ where: { id: managerId } })).toMatchObject({ active: false })

    // Months later the owner swapped the waiter for the manager (the team fits the cap), then the subscription ends.
    await prisma.staffVenue.update({ where: { id: chosenId }, data: { active: false, deactivatedBySeatCap: false } })
    await prisma.staffVenue.update({ where: { id: managerId }, data: { active: true, deactivatedBySeatCap: false } })
    f.subscription.status = 'canceled'
    await expect(reconcileHybridInvoice(f.venueId, f.purchase.id, f.invoice.id)).resolves.toEqual({ status: 'ENDED' })

    const active = await prisma.staffVenue.findMany({ where: { venueId: f.venueId, active: true }, select: { id: true } })
    expect(active.map(row => row.id).sort()).toEqual([ownerId, managerId].sort())
  })

  it('a plan contract whose cancellation took effect ends on the next sweep and the team is settled, while the subscription lives on', async () => {
    const f = await fixture()
    // Its paid period is already over: the delivery itself writes the grants with endsAt = the paid boundary.
    const boundary = Math.floor(Date.now() / 1000) - 60
    f.invoice.lines.data[0].period = { start: boundary - 30 * 86400, end: boundary }
    await reconcileHybridInvoice(f.venueId, f.purchase.id, f.invoice.id)
    // The renewal was cancelled at that same boundary (what cancelHybridContract records), on a plan contract.
    await prisma.hybridContract.update({ where: { id: f.contract.id }, data: { planTier: 'PREMIUM', cancelAt: new Date(boundary * 1000) } })
    const grants = await prisma.capabilityGrant.findMany({
      where: { contractId: f.contract.id },
      select: { endsAt: true, revokedAt: true },
    })
    expect(grants.length).toBeGreaterThan(0)
    expect(grants.every(grant => grant.endsAt.getTime() === boundary * 1000 && grant.revokedAt === null)).toBe(true)
    const [owner, ana, carlos] = await team(f.venueId, [
      ['OWNER', null],
      ['MANAGER', new Date('2026-09-20T12:00:00Z')],
      ['WAITER', null],
    ])

    await reconcileHybridPurchase(f.venueId, f.purchase.id)

    expect(await prisma.hybridContract.findUniqueOrThrow({ where: { id: f.contract.id } })).toMatchObject({ endedAt: expect.any(Date) })
    expect(f.subscription.status).toBe('active')
    const active = await prisma.staffVenue.findMany({ where: { venueId: f.venueId, active: true }, select: { id: true } })
    expect(active.map(row => row.id).sort()).toEqual([owner.id, ana.id].sort())
    expect(await prisma.staffVenue.findUniqueOrThrow({ where: { id: carlos.id } })).toMatchObject({
      active: false,
      deactivatedBySeatCap: true,
    })
    expect(await prisma.activityLog.count({ where: { venueId: f.venueId, action: 'SEAT_CAP_ENFORCED' } })).toBe(1)
  })

  it('revokes only credit-funded coverage after a source refund or dispute, and restores it after a won dispute', async () => {
    const f = await fixture(true, staffId, true)
    await reconcileHybridInvoice(f.venueId, f.purchase.id, f.invoice.id)
    await prisma.capabilityGrant.create({
      data: {
        venueId: f.venueId,
        featureCode: 'CFDI',
        sourceId: 'independent',
        startsAt: new Date(Date.now() - 1000),
        endsAt: new Date(Date.now() + 86400000),
      },
    })
    const source = (f.purchase.quote as any).sources[0]
    const charge = payments.get(source.sourceInvoiceId)[0].payment.charge
    charge.disputed = true
    disputes.set(charge.id, [{ status: 'under_review' }])
    await reconcileHybridInvoice(f.venueId, f.purchase.id, f.invoice.id)
    expect(await grantedCapabilityCodes(f.venueId)).toEqual(['CFDI'])
    disputes.set(charge.id, [{ status: 'won' }])
    await reconcileHybridInvoice(f.venueId, f.purchase.id, f.invoice.id)
    expect(await grantedCapabilityCodes(f.venueId)).toEqual(['CFDI', 'LOYALTY_PROGRAM'])
    charge.amount_refunded = 7590
    await reconcileHybridInvoice(f.venueId, f.purchase.id, f.invoice.id)
    expect(await grantedCapabilityCodes(f.venueId)).toEqual(['CFDI'])
  })
  it('cancels renewal at the paid boundary, replays the same operation and preserves paid access', async () => {
    const f = await fixture()
    await reconcileHybridInvoice(f.venueId, f.purchase.id, f.invoice.id)
    const body = { expectedRevision: 1 }
    const result = await cancelHybridContract(f.venueId, f.contract.id, staffId, body)
    expect(result.cancelAt).toBe(new Date(f.invoice.lines.data[0].period.end * 1000).toISOString())
    await expect(cancelHybridContract(f.venueId, f.contract.id, staffId, body)).resolves.toEqual(result)
    expect(await grantedCapabilityCodes(f.venueId)).toEqual(['CFDI', 'LOYALTY_PROGRAM'])
    expect(schedules.get(f.subscription.schedule!)).toMatchObject({ end_behavior: 'cancel' })
    expect(await prisma.activityLog.count({ where: { entityId: f.contract.id, action: 'HYBRID_RENEWAL_CANCELLED' } })).toBe(1)
    const op = await prisma.hybridBillingOperation.findFirstOrThrow({
      where: { purchaseId: f.purchase.id, step: { startsWith: 'SCHEDULE_CONFIGURE:' } },
    })
    expect(op.resultHash).toMatch(/^[a-f0-9]{64}$/)
  })
  it('keeps the owner reason: in the attempt, in the audit row and, when the whole subscription ends, in Stripe', async () => {
    const f = await fixture()
    await reconcileHybridInvoice(f.venueId, f.purchase.id, f.invoice.id)
    await cancelHybridContract(f.venueId, f.contract.id, staffId, { expectedRevision: 1, reason: 'TOO_EXPENSIVE', comment: 'Caro' })
    const log = await prisma.activityLog.findFirstOrThrow({ where: { entityId: f.contract.id, action: 'HYBRID_RENEWAL_CANCELLED' } })
    expect(log.data).toMatchObject({ reason: 'TOO_EXPENSIVE', comment: 'Caro' })
    const saved = await prisma.hybridBillingOperation.findFirstOrThrow({
      where: { purchaseId: f.purchase.id, step: { startsWith: 'SCHEDULE_CANCEL_CREATE:' } },
    })
    expect(saved.request).toMatchObject({ cancellation: { reason: 'TOO_EXPENSIVE', comment: 'Caro' } })
    const { stripe } = jest.requireMock('@/services/stripe.service')
    expect(stripe.subscriptionSchedules.create).toHaveBeenCalledWith({ from_subscription: f.subscription.id }, expect.anything())
    expect(stripe.subscriptions.update).toHaveBeenCalledWith(
      f.subscription.id,
      { cancellation_details: { feedback: 'too_expensive', comment: 'Caro' } },
      expect.objectContaining({ idempotencyKey: `hybrid-cancel-reason:${f.contract.id}:1` }),
    )
  })

  it('a replay without a reason (the recovery) keeps the reason of the first attempt', async () => {
    const f = await fixture()
    await reconcileHybridInvoice(f.venueId, f.purchase.id, f.invoice.id)
    const request = { from_subscription: f.subscription.id, cancellation: { reason: 'TEMPORARY', comment: 'Cerramos agosto' } }
    await prisma.hybridBillingOperation.create({
      data: { purchaseId: f.purchase.id, step: `SCHEDULE_CANCEL_CREATE:${f.contract.id}:1`, request, requestHash: hybridHash(request) },
    })
    await cancelHybridContract(f.venueId, f.contract.id, staffId, { expectedRevision: 1 })
    const log = await prisma.activityLog.findFirstOrThrow({ where: { entityId: f.contract.id, action: 'HYBRID_RENEWAL_CANCELLED' } })
    expect(log.data).toMatchObject({ reason: 'TEMPORARY', comment: 'Cerramos agosto' })
  })
  it('applies a scheduled selection once and retains exact composition for later renewals and late invoice replay', async () => {
    const f = await fixture()
    await reconcileHybridInvoice(f.venueId, f.purchase.id, f.invoice.id)
    const start = f.invoice.lines.data[0].period.end
    await prisma.hybridContract.update({
      where: { id: f.contract.id },
      data: { pendingFeatureCodes: ['ADVANCED_REPORTS', 'LOYALTY_PROGRAM'], pendingEffectiveAt: new Date(start * 1000), revision: 2 },
    })
    for (let cycle = 0; cycle < 2; cycle++) {
      const next = {
        ...f.invoice,
        id: `${f.invoice.id}_${cycle}`,
        lines: {
          ...f.invoice.lines,
          data: f.invoice.lines.data.map((line: any) => ({
            ...line,
            period: { start: start + cycle * 86400, end: start + (cycle + 1) * 86400 },
          })),
        },
      }
      invoices.set(next.id, next)
      payments.set(next.id, payments.get(f.invoice.id))
      await reconcileHybridInvoice(f.venueId, f.purchase.id, next.id)
      const period = await prisma.hybridPaymentPeriod.findUniqueOrThrow({ where: { stripeInvoiceId: next.id } })
      expect(period.composition).toEqual([expect.objectContaining({ featureCodes: ['ADVANCED_REPORTS', 'LOYALTY_PROGRAM'] })])
    }
    expect(await prisma.hybridContract.findUnique({ where: { id: f.contract.id } })).toMatchObject({
      featureCodes: ['ADVANCED_REPORTS', 'LOYALTY_PROGRAM'],
      pendingFeatureCodes: null,
      pendingEffectiveAt: null,
    })
    await reconcileHybridInvoice(f.venueId, f.purchase.id, f.invoice.id)
    const first = await prisma.hybridPaymentPeriod.findUniqueOrThrow({ where: { stripeInvoiceId: f.invoice.id } })
    expect(first.composition).toEqual([expect.objectContaining({ featureCodes: ['CFDI', 'LOYALTY_PROGRAM'] })])
  })
  it('creates all N grants, consumes one place and audits once under concurrent replay', async () => {
    const f = await fixture()
    await Promise.all([1, 2].map(() => reconcileHybridInvoice(f.venueId, f.purchase.id, f.invoice.id)))
    expect(await grantedCapabilityCodes(f.venueId)).toEqual(['CFDI', 'LOYALTY_PROGRAM'])
    expect(await prisma.hybridPaymentPeriod.count({ where: { venueId: f.venueId } })).toBe(1)
    expect(await prisma.hybridCampaign.findUnique({ where: { id: f.campaign.id } })).toMatchObject({ reservedCount: 0, redeemedCount: 1 })
    expect(await prisma.activityLog.count({ where: { entityId: f.purchase.id, action: 'HYBRID_ACCESS_DELIVERED' } })).toBe(1)
    expect(await prisma.capabilityGrant.count({ where: { venueId: f.venueId, contractId: f.contract.id } })).toBe(2)
  })
  it('never grants from an unpaid invoice, a paid status without funding or a foreign customer', async () => {
    const f = await fixture(false)
    await reconcileHybridInvoice(f.venueId, f.purchase.id, f.invoice.id)
    expect(await grantedCapabilityCodes(f.venueId)).toEqual([])
    f.invoice.status = 'paid'
    payments.set(f.invoice.id, [])
    await expect(reconcileHybridInvoice(f.venueId, f.purchase.id, f.invoice.id)).rejects.toThrow()
    f.invoice.customer = 'cus_foreign'
    await expect(reconcileHybridInvoice(f.venueId, f.purchase.id, f.invoice.id)).rejects.toThrow()
    expect(await grantedCapabilityCodes(f.venueId)).toEqual([])
  })
  it('rolls back the entire delivery if the final audit fails', async () => {
    const f = await fixture(true, 'missing-actor')
    await expect(reconcileHybridInvoice(f.venueId, f.purchase.id, f.invoice.id)).rejects.toThrow()
    expect(await grantedCapabilityCodes(f.venueId)).toEqual([])
    expect(await prisma.hybridPaymentPeriod.count({ where: { venueId: f.venueId } })).toBe(0)
    expect(await prisma.hybridCampaign.findUnique({ where: { id: f.campaign.id } })).toMatchObject({ reservedCount: 1, redeemedCount: 0 })
  })
  it('a refunded period is revoked without deleting another valid origin, including on stale replay', async () => {
    const f = await fixture()
    await reconcileHybridInvoice(f.venueId, f.purchase.id, f.invoice.id)
    await prisma.capabilityGrant.create({
      data: {
        venueId: f.venueId,
        featureCode: 'CFDI',
        sourceId: 'manual',
        startsAt: new Date(Date.now() - 1000),
        endsAt: new Date(Date.now() + 86400000),
      },
    })
    payments.get(f.invoice.id)[0].payment.charge.amount_refunded = 37950
    await reconcileHybridInvoice(f.venueId, f.purchase.id, f.invoice.id)
    await reconcileHybridInvoice(f.venueId, f.purchase.id, f.invoice.id)
    expect(await grantedCapabilityCodes(f.venueId)).toEqual(['CFDI'])
  })
  it('restores only the affected paid origin after a won dispute, never after a full refund', async () => {
    const f = await fixture()
    await reconcileHybridInvoice(f.venueId, f.purchase.id, f.invoice.id)
    const charge = payments.get(f.invoice.id)[0].payment.charge
    charge.disputed = true
    disputes.set(charge.id, [{ status: 'under_review' }])
    await reconcileHybridInvoice(f.venueId, f.purchase.id, f.invoice.id)
    expect(await grantedCapabilityCodes(f.venueId)).toEqual([])
    disputes.set(charge.id, [{ status: 'won' }])
    await reconcileHybridInvoice(f.venueId, f.purchase.id, f.invoice.id)
    expect(await grantedCapabilityCodes(f.venueId)).toEqual(['CFDI', 'LOYALTY_PROGRAM'])
    charge.amount_refunded = charge.amount
    await reconcileHybridInvoice(f.venueId, f.purchase.id, f.invoice.id)
    expect(await grantedCapabilityCodes(f.venueId)).toEqual([])
  })
  it('does not resurrect an immediately canceled contract from a delayed paid event', async () => {
    const f = await fixture()
    await reconcileHybridInvoice(f.venueId, f.purchase.id, f.invoice.id)
    f.subscription.status = 'canceled'
    await reconcileHybridInvoice(f.venueId, f.purchase.id, f.invoice.id)
    expect(await grantedCapabilityCodes(f.venueId)).toEqual([])
  })
  it('does not rewrite an already delivered period composition or cross its venue', async () => {
    const f = await fixture()
    await reconcileHybridInvoice(f.venueId, f.purchase.id, f.invoice.id)
    const period = await prisma.hybridPaymentPeriod.findUniqueOrThrow({ where: { stripeInvoiceId: f.invoice.id } })
    await expect(prisma.hybridPaymentPeriod.update({ where: { id: period.id }, data: { composition: [] } })).rejects.toThrow(/immutable/i)
    const other = await fixture()
    await expect(
      prisma.capabilityGrant.create({
        data: {
          venueId: other.venueId,
          featureCode: 'CFDI',
          sourceId: 'cross-venue',
          contractId: f.contract.id,
          paymentPeriodId: period.id,
          startsAt: period.startsAt,
          endsAt: period.endsAt,
        },
      }),
    ).rejects.toThrow()
  })
  it('requires the published line amount and every initially purchased contract', async () => {
    const f = await fixture()
    f.invoice.lines.data[0].amount = 100
    f.invoice.total = 100
    payments.get(f.invoice.id)[0].amount_paid = 100
    payments.get(f.invoice.id)[0].payment.charge.amount = 100
    await expect(reconcileHybridInvoice(f.venueId, f.purchase.id, f.invoice.id)).rejects.toThrow()
    expect(await grantedCapabilityCodes(f.venueId)).toEqual([])
  })
})
