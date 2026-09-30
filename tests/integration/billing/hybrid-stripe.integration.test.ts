/** Opt-in only: real Stripe TEST + an explicitly disposable local database. Never run against LIVE. */
import Stripe from 'stripe'
import prisma from '@/utils/prismaClient'
const key = process.env.HYBRID_STRIPE_TEST_SECRET
const enabled = Boolean(key)
jest.mock('@/services/stripe.service', () => {
  const StripeClient = require('stripe')
  return {
    stripe: new StripeClient(process.env.HYBRID_STRIPE_TEST_SECRET ?? 'sk_test_not_configured', { timeout: 15000, maxNetworkRetries: 0 }),
    STRIPE_DENTRO_DEL_CANDADO: { timeout: 15000, maxNetworkRetries: 0 },
  }
})
import { ensureHybridPublicationPrices } from '@/services/launchCampaigns/hybridPrices'
import { provisionHybridPurchase } from '@/services/launchCampaigns/hybridProvision.service'
import { reconcileHybridInvoice } from '@/services/launchCampaigns/hybridDelivery.service'
import { stripe } from '@/services/stripe.service'
import { hybridHash } from '@/services/launchCampaigns/hybridProvider'
import { cancelHybridContract } from '@/services/launchCampaigns/hybridManagement.service'
import { readHybridCreditSource } from '@/services/launchCampaigns/hybridSources'
import { buildHybridQuote } from '@/services/launchCampaigns/hybridQuote'
import { compileHybridPublication } from '@/services/launchCampaigns/hybridOffer.service'
import { FREE_TIER_CODES } from '@/services/access/basePlan.service'
import { Decimal } from '@prisma/client/runtime/library'
import { grantedCapabilityCodes } from '@/services/access/capabilityGrants.service'
const suite = enabled ? describe : describe.skip
suite('actual Stripe TEST hybrid purchase and renewal', () => {
  let clockId: string
  let customerId: string
  let subId: string
  let publicationId: string
  const publications: string[] = []
  const subscriptions: string[] = []
  beforeAll(() => {
    if (!key?.startsWith('sk_test_')) throw new Error('Only Stripe TEST is permitted')
    const url = new URL(process.env.TEST_DATABASE_URL!)
    if (url.hostname !== 'localhost' || !url.pathname.startsWith('/avq_hybrid_'))
      throw new Error('Only the disposable local database is permitted')
  })
  afterAll(async () => {
    for (const id of subscriptions) {
      const sub = await stripe.subscriptions.retrieve(id)
      const schedule = typeof sub.schedule === 'string' ? sub.schedule : sub.schedule?.id
      if (schedule && sub.status !== 'canceled') await stripe.subscriptionSchedules.cancel(schedule, { invoice_now: false, prorate: false })
      else if (sub.status !== 'canceled') await stripe.subscriptions.cancel(id, { invoice_now: false, prorate: false })
    }
    for (const id of publications) {
      const publication = await prisma.hybridOfferPublication.findUniqueOrThrow({ where: { id } })
      if (publication.stripeProductId) {
        const product = await stripe.products.update(publication.stripeProductId, { active: false })
        const defaultPrice = typeof product.default_price === 'string' ? product.default_price : product.default_price?.id
        for (const price of [publication.stripePriceId, publication.stripeRenewalPriceId].filter(
          (id): id is string => Boolean(id) && id !== defaultPrice,
        ))
          await stripe.prices.update(price, { active: false })
      }
    }
    if (customerId) await stripe.customers.del(customerId)
    if (clockId) await stripe.testHelpers.testClocks.del(clockId)
  })
  it('retains the test card, grants N capabilities once, and charges the agreed next-period price', async () => {
    const stamp = `hybrid${Date.now()}${process.pid}`
    const frozen = Math.floor(Date.now() / 1000)
    const clock = await stripe.testHelpers.testClocks.create({ frozen_time: frozen, name: stamp })
    clockId = clock.id
    const customer = await stripe.customers.create({ test_clock: clockId, name: stamp, metadata: { isolatedHybridTest: stamp } })
    customerId = customer.id
    const org = await prisma.organization.create({ data: { name: stamp, email: `${stamp}@example.test`, phone: '5550000000' } })
    const staff = await prisma.staff.create({ data: { email: `${stamp}@example.test`, firstName: 'Stripe', lastName: 'Test' } })
    const venue = await prisma.venue.create({ data: { name: stamp, slug: stamp, organizationId: org.id, stripeCustomerId: customerId } })
    const definition = {
      schemaVersion: 1,
      kind: 'FEATURES',
      featureCodes: ['CFDI', 'LOYALTY_PROGRAM'],
      terms: {
        currency: 'MXN',
        interval: 'MONTHLY',
        price: 379.5,
        taxIncluded: true,
        promotionCycles: 1,
        renewal: { kind: 'REPRICE', price: 499 },
      },
    }
    const campaign = await prisma.hybridCampaign.create({
      data: {
        code: stamp,
        slug: stamp,
        name: stamp,
        draftDefinition: definition,
        startsAt: new Date(),
        endsAt: new Date(Date.now() + 86400000),
        capacity: 1,
        reservedCount: 1,
        audience: 'ALL',
        createdById: staff.id,
      },
    })
    const hash = hybridHash(definition)
    const pub = await prisma.hybridOfferPublication.create({
      data: {
        campaignId: campaign.id,
        version: 1,
        name: stamp,
        definition,
        definitionHash: hash,
        includedFeatureCodes: definition.featureCodes,
        createdById: staff.id,
      },
    })
    publicationId = pub.id
    publications.push(pub.id)
    await ensureHybridPublicationPrices(publicationId)
    const quote = {
      schemaVersion: 1,
      total: '379.50',
      credit: '0.00',
      dueNow: '379.50',
      effectiveAt: frozen,
      replaces: [],
      sources: [],
      lines: [
        {
          publicationId: pub.id,
          definitionHash: hash,
          name: stamp,
          kind: 'FEATURES',
          planTier: null,
          featureCodes: definition.featureCodes,
          terms: definition.terms,
        },
      ],
    }
    const purchase = await prisma.hybridPurchase.create({
      data: {
        venueId: venue.id,
        quotedById: staff.id,
        quote,
        quoteHash: hybridHash(quote),
        quoteExpiresAt: new Date(Date.now() + 300000),
        status: 'ACCEPTED',
        acceptedAt: new Date(),
        paymentExpiresAt: new Date(Date.now() + 23 * 3600000),
        stripeCustomerId: customerId,
      },
    })
    await prisma.hybridRedemption.create({ data: { campaignId: campaign.id, organizationId: org.id, purchaseId: purchase.id } })
    const ready = await provisionHybridPurchase(venue.id, purchase.id)
    expect(ready.status).toBe('PAYMENT_PENDING')
    expect(await grantedCapabilityCodes(venue.id)).toEqual([])
    const saved = await prisma.hybridPurchase.findUniqueOrThrow({ where: { id: purchase.id } })
    subId = saved.stripeSubscriptionId!
    subscriptions.push(subId)
    const pm = await stripe.paymentMethods.attach('pm_card_visa', { customer: customerId })
    await stripe.invoices.pay(saved.initialInvoiceId!, { payment_method: pm.id })
    await reconcileHybridInvoice(venue.id, purchase.id, saved.initialInvoiceId!)
    expect(await grantedCapabilityCodes(venue.id)).toEqual(['CFDI', 'LOYALTY_PROGRAM'])
    let sub = await stripe.subscriptions.retrieve(subId)
    expect(sub.default_payment_method).toBeTruthy()
    expect(sub.schedule).toBeTruthy()
    const end = sub.items.data[0].current_period_end
    await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: end + 7200 })
    for (let i = 0; i < 60; i++) {
      if ((await stripe.testHelpers.testClocks.retrieve(clockId)).status === 'ready') break
      await new Promise(resolve => setTimeout(resolve, 1500))
    }
    expect((await stripe.testHelpers.testClocks.retrieve(clockId)).status).toBe('ready')
    sub = await stripe.subscriptions.retrieve(subId, { expand: ['latest_invoice'] })
    let invoice = sub.latest_invoice as Stripe.Invoice
    // A test-clock recurring invoice follows Stripe's one-hour finalization delay.
    if (invoice.status === 'draft') invoice = await stripe.invoices.finalizeInvoice(invoice.id)
    if (invoice.status === 'open') invoice = await stripe.invoices.pay(invoice.id)
    expect(invoice.id).not.toBe(saved.initialInvoiceId)
    expect(invoice.status).toBe('paid')
    expect(invoice.amount_paid).toBe(49900)
    await reconcileHybridInvoice(venue.id, purchase.id, invoice.id)
    expect(await prisma.hybridPaymentPeriod.count({ where: { venueId: venue.id } })).toBe(2)
    expect(await prisma.capabilityGrant.count({ where: { venueId: venue.id } })).toBe(4)
    expect(await prisma.hybridCampaign.findUnique({ where: { id: campaign.id } })).toMatchObject({ reservedCount: 0, redeemedCount: 1 })
    // Replace the full old package: PRO absorbs loyalty, CFDI remains a separately priced line.
    const effectiveAt = end + 7200
    const createOffer = async (definition: any, suffix: string) => {
      const compiled = compileHybridPublication(definition)
      const campaign = await prisma.hybridCampaign.create({
        data: {
          code: stamp + suffix,
          slug: stamp + suffix,
          name: stamp + suffix,
          draftDefinition: definition,
          startsAt: new Date(),
          endsAt: new Date(Date.now() + 86400000),
          capacity: 1,
          reservedCount: 1,
          audience: 'ALL',
          createdById: staff.id,
        },
      })
      const row = await prisma.hybridOfferPublication.create({
        data: { campaignId: campaign.id, version: 1, name: stamp + suffix, ...compiled, createdById: staff.id },
      })
      publications.push(row.id)
      await ensureHybridPublicationPrices(row.id)
      return { ...row, definition: compiled.definition }
    }
    const terms = {
      currency: 'MXN',
      interval: 'MONTHLY',
      price: 629.9,
      taxIncluded: true,
      promotionCycles: null,
      renewal: { kind: 'SAME_PRICE' },
    }
    const plan = await createOffer({ schemaVersion: 1, kind: 'PLAN', planTier: 'PRO', terms }, 'plan')
    const extra = await createOffer(
      { schemaVersion: 1, kind: 'FEATURES', featureCodes: ['CFDI'], terms: { ...terms, price: 89.9 } },
      'extra',
    )
    const replace = async (sourceSub: string, oldCodes: string[], offers: (typeof plan)[], dropped: string[] = []) => {
      const source = await readHybridCreditSource(venue.id, sourceSub, customerId, effectiveAt)
      const composition = buildHybridQuote({
        lines: offers.map(publication => ({ publication })),
        retainedFeatureCodes: [],
        existing: [{ subscriptionId: sourceSub, featureCodes: oldCodes }],
        dropFeatureCodes: dropped,
      })
      const quote = {
        ...composition,
        effectiveAt,
        sources: [source],
        credit: source.amount,
        dueNow: Decimal.max(0, new Decimal(composition.total).sub(source.amount)).toFixed(2),
      }
      const purchase = await prisma.hybridPurchase.create({
        data: {
          venueId: venue.id,
          quotedById: staff.id,
          quote,
          quoteHash: hybridHash(quote),
          quoteExpiresAt: new Date(Date.now() + 300000),
          status: 'ACCEPTED',
          acceptedAt: new Date(),
          paymentExpiresAt: new Date(Date.now() + 23 * 3600000),
          stripeCustomerId: customerId,
        },
      })
      await prisma.hybridCreditAllocation.create({
        data: { purchaseId: purchase.id, sourceSubscriptionId: sourceSub, sourceInvoiceId: source.sourceInvoiceId, amount: source.amount },
      })
      for (const offer of offers)
        await prisma.hybridRedemption.create({ data: { campaignId: offer.campaignId, organizationId: org.id, purchaseId: purchase.id } })
      await provisionHybridPurchase(venue.id, purchase.id)
      const saved = await prisma.hybridPurchase.findUniqueOrThrow({ where: { id: purchase.id } })
      subscriptions.push(saved.stripeSubscriptionId!)
      let invoice = await stripe.invoices.retrieve(saved.initialInvoiceId!)
      expect(invoice.total).toBe(new Decimal(quote.total).sub(quote.credit).mul(100).toNumber())
      if (invoice.status === 'open') invoice = await stripe.invoices.pay(invoice.id, { payment_method: pm.id })
      expect(invoice.amount_paid).toBe(new Decimal(quote.dueNow).mul(100).toNumber())
      await reconcileHybridInvoice(venue.id, purchase.id, invoice.id)
      await reconcileHybridInvoice(venue.id, purchase.id, invoice.id)
      expect((await stripe.subscriptions.retrieve(sourceSub)).status).toBe('canceled')
      expect(
        await prisma.hybridCreditAllocation.findUniqueOrThrow({
          where: { purchaseId_sourceInvoiceId: { purchaseId: purchase.id, sourceInvoiceId: source.sourceInvoiceId } },
        }),
      ).toMatchObject({ status: 'CONSUMED' })
      expect(await prisma.hybridPaymentPeriod.count({ where: { stripeInvoiceId: invoice.id } })).toBe(1)
      return { purchase: saved, invoice, quote }
    }
    const replacement = await replace(subId, definition.featureCodes, [plan, extra])
    expect(replacement.quote.total).toBe('719.80')
    expect(new Decimal(replacement.quote.credit).gt(0)).toBe(true)
    const small = await createOffer(
      { schemaVersion: 1, kind: 'FEATURES', featureCodes: ['CFDI', 'LOYALTY_PROGRAM'], terms: { ...terms, price: 99 } },
      'small',
    )
    const excess = await replace(
      replacement.purchase.stripeSubscriptionId!,
      replacement.quote.featureCodes,
      [small],
      replacement.quote.featureCodes.filter(
        code => !small.includedFeatureCodes.includes(code) && !(FREE_TIER_CODES as readonly string[]).includes(code),
      ),
    )
    expect(excess.quote.dueNow).toBe('0.00')
    expect(excess.invoice.ending_balance).toBeLessThan(0)
    const reusable = await readHybridCreditSource(venue.id, excess.purchase.stripeSubscriptionId!, customerId, effectiveAt)
    expect(reusable.funded).toBe('99.00')
    expect(new Decimal(reusable.amount).lte(99)).toBe(true)
    const contract = await prisma.hybridContract.findFirstOrThrow({ where: { purchaseId: excess.purchase.id } })
    const update = stripe.subscriptionSchedules.update.bind(stripe.subscriptionSchedules)
    const lost = jest.spyOn(stripe.subscriptionSchedules, 'update').mockImplementationOnce(async (...args: Parameters<typeof update>) => {
      await update(...args)
      throw new Error('Simulated response lost after Stripe accepted schedule change')
    })
    await expect(cancelHybridContract(venue.id, contract.id, staff.id, { expectedRevision: contract.revision })).rejects.toMatchObject({
      code: 'HYBRID_PROVIDER_UNKNOWN',
    })
    expect((await prisma.hybridContract.findUniqueOrThrow({ where: { id: contract.id } })).cancelAt).toBeNull()
    const cancelled = await cancelHybridContract(venue.id, contract.id, staff.id, { expectedRevision: contract.revision })
    expect(cancelled.cancelAt).toBe(contract.paidThrough!.toISOString())
    expect(lost).toHaveBeenCalledTimes(1)
    lost.mockRestore()
    const ending = await stripe.subscriptions.retrieve(excess.purchase.stripeSubscriptionId!)
    const endingSchedule = await stripe.subscriptionSchedules.retrieve(
      typeof ending.schedule === 'string' ? ending.schedule : ending.schedule!.id,
    )
    expect(endingSchedule.end_behavior).toBe('cancel')
    expect(endingSchedule.phases.at(-1)!.end_date).toBe(contract.paidThrough!.getTime() / 1000)
    console.log(
      JSON.stringify({
        stripeTest: true,
        initialPaidPesos: '379.50',
        renewalPaidPesos: '499.00',
        retainedCard: true,
        cancellationResponseLossRecovered: true,
        partialReplacement: { total: replacement.quote.total, credit: replacement.quote.credit, paid: replacement.quote.dueNow },
        fullReplacementWithExcess: {
          total: excess.quote.total,
          credit: excess.quote.credit,
          paid: excess.quote.dueNow,
          balancePesos: new Decimal(excess.invoice.ending_balance!).div(100).toFixed(2),
          reusableFunding: reusable.funded,
        },
      }),
    )
  }, 240000)
})
