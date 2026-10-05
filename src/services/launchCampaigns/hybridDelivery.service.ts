import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { ConflictError, NotFoundError } from '@/errors/AppError'
import { stripe, STRIPE_DENTRO_DEL_CANDADO } from '@/services/stripe.service'
import { fromStripeAmount } from '@/services/payments/providers/money'
import { hybridHash, recordedStripeWrite } from './hybridProvider'
import { hybridFundingReader } from './hybridFundingGraph'
import { readHybridCreditSource } from './hybridSources'
import type { HybridQuoteSnapshot } from './hybridPurchase.service'
import { ensureHybridSchedule } from './hybridSchedule'
import { hybridOfferDefinition } from './hybridOffer.schema'
import { executeSeatReconciliation } from '@/services/dashboard/seatReconciliation.service'
import { settleSeatsAfterHybridDelivery, unsettledCheckoutSeatChoice } from './hybridSeats'

const idOf = (value: string | { id: string } | null | undefined) => (typeof value === 'string' ? value : value?.id)
const mismatch = () =>
  new ConflictError('No pudimos verificar la cobertura pagada. Conservamos tu compra para revisarla.', 'HYBRID_DELIVERY_UNVERIFIED')
type Composition = Array<{ contractId: string; itemId: string; featureCodes: string[]; priceId: string; amount: string }>

/**
 * The delivery's one «not paid» criterion for a period: open dispute, fully refunded, or funded below the sum of its lines
 * (`expected`). The price-gap report repeats it in SQL (`periodFundedSql`); its integration test checks both agree.
 */
export function hybridPeriodInvalid(
  funding: { funded: Prisma.Decimal.Value; refunded: Prisma.Decimal.Value; disputed: boolean },
  expected: Prisma.Decimal,
) {
  return funding.disputed || new Prisma.Decimal(funding.refunded).gte(funding.funded) || new Prisma.Decimal(funding.funded).lt(expected)
}

/** Always reads live provider state; webhook order and browser success redirects are never payment authority. */
export async function reconcileHybridInvoice(venueId: string, purchaseId: string, invoiceId: string) {
  const deadline = Date.now() + 550000
  // ponytail: one connection per in-flight purchase; move to fenced leases only if this becomes material load.
  return prisma.$transaction(
    async lock => {
      await lock.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`hybrid-delivery:${purchaseId}`}))::text`
      const assertLive = async () => {
        if (Date.now() >= deadline) throw mismatch()
        await lock.$queryRaw`SELECT 1`
      }
      return reconcileInvoice(venueId, purchaseId, invoiceId, assertLive)
    },
    { timeout: 600000, maxWait: 5000 },
  )
}

async function reconcileInvoice(venueId: string, purchaseId: string, invoiceId: string, assertLive: () => Promise<void>) {
  const purchase = await prisma.hybridPurchase.findUnique({
    where: { id: purchaseId, venueId },
    include: { contracts: { include: { publication: true }, orderBy: { id: 'asc' }, take: 9 } },
  })
  if (!purchase) throw new NotFoundError('Compra no encontrada.')
  if (
    !purchase.stripeSubscriptionId ||
    !purchase.stripeCustomerId ||
    !purchase.contracts.length ||
    purchase.contracts.length > 8 ||
    ['QUOTED', 'EXPIRED', 'CANCELLED'].includes(purchase.status)
  )
    throw mismatch()
  const quote = purchase.quote as unknown as HybridQuoteSnapshot
  const [sub, invoice] = await Promise.all([
    stripe.subscriptions.retrieve(purchase.stripeSubscriptionId, {}, STRIPE_DENTRO_DEL_CANDADO),
    stripe.invoices.retrieve(invoiceId, {}, STRIPE_DENTRO_DEL_CANDADO),
  ])
  if (
    sub.id !== purchase.stripeSubscriptionId ||
    idOf(sub.customer) !== purchase.stripeCustomerId ||
    sub.metadata.hybridPurchaseId !== purchaseId ||
    sub.metadata.venueId !== venueId ||
    sub.metadata.quoteHash !== purchase.quoteHash ||
    idOf(invoice.customer) !== purchase.stripeCustomerId ||
    idOf(invoice.parent?.subscription_details?.subscription) !== sub.id ||
    invoice.currency !== 'mxn'
  )
    throw mismatch()
  if (['canceled', 'incomplete_expired'].includes(sub.status)) {
    await assertLive()
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "HybridPurchase" WHERE id = ${purchaseId} FOR UPDATE`
      const changed = await tx.hybridContract.updateMany({ where: { purchaseId, venueId, endedAt: null }, data: { endedAt: new Date() } })
      await tx.capabilityGrant.updateMany({
        where: { venueId, contractId: { in: purchase.contracts.map(c => c.id) }, revokedAt: null },
        data: { revokedAt: new Date() },
      })
      if (changed.count)
        await tx.activityLog.create({
          data: {
            venueId,
            action: 'HYBRID_ACCESS_ENDED',
            entity: 'HybridPurchase',
            entityId: purchaseId,
            data: { subscriptionId: sub.id },
          },
        })
    })
    // A plan that dies with its subscription leaves the venue on Free unless something else pays for one (spec §4.3). So
    // does a replacement that dies before delivering: its REPLACE step may already have cancelled the classic plan, whose
    // webhook left the cap to this delivery. Safe while that origin lives (the cap is null, a no-op). After the commit,
    // so the revoked grants are what the cap sees; idempotent, so a replayed webhook is harmless. A replacement that never
    // settled its team applies the owner's «who stays» choice from checkout, as the paid path does.
    if (quote.replaces.length > 0)
      await executeSeatReconciliation(venueId, { keepStaffVenueIds: await unsettledCheckoutSeatChoice(purchaseId, quote) })
    else if (purchase.contracts.some(contract => contract.planTier)) await executeSeatReconciliation(venueId)
    return { status: 'ENDED' }
  }
  if (invoice.status !== 'paid') return { status: 'PAYMENT_PENDING' }
  if (invoice.lines.has_more || sub.items.has_more || invoice.amount_remaining !== 0) throw mismatch()
  const previous = await prisma.hybridPaymentPeriod.findUnique({ where: { stripeInvoiceId: invoiceId } })
  const recurring = invoice.lines.data.filter(line => line.parent?.subscription_item_details?.subscription_item)
  if (
    !recurring.length ||
    recurring.length > 8 ||
    recurring.some(line => line.parent?.subscription_item_details?.proration || line.quantity !== 1 || line.amount <= 0)
  )
    throw mismatch()
  if (invoiceId === purchase.initialInvoiceId && recurring.length !== quote.lines.length) throw mismatch()
  const start = recurring[0].period.start
  const end = recurring[0].period.end
  if (end <= start || recurring.some(line => line.period.start !== start || line.period.end !== end)) throw mismatch()
  const history = previous
    ? []
    : await prisma.hybridContract.findMany({
        where: { purchaseId, venueId },
        select: {
          id: true,
          selections: { where: { effectiveAt: { lte: new Date(start * 1000) } }, orderBy: { effectiveAt: 'desc' }, take: 1 },
        },
        orderBy: { id: 'asc' },
        take: 9,
      })
  const composition: Composition = previous
    ? (previous.composition as unknown as Composition)
    : recurring.map(line => {
        const priceId = idOf(line.pricing?.price_details?.price)
        const contract = purchase.contracts.find(
          c => c.publication.stripePriceId === priceId || c.publication.stripeRenewalPriceId === priceId,
        )
        if (!contract || contract.endedAt) throw mismatch()
        const definition = hybridOfferDefinition.parse(contract.publication.definition)
        const price =
          priceId === contract.publication.stripePriceId
            ? definition.terms.price
            : definition.terms.renewal.kind === 'REPRICE'
              ? definition.terms.renewal.price
              : null
        if (price === null || !fromStripeAmount(line.amount).eq(price)) throw mismatch()
        const featureCodes =
          contract.pendingEffectiveAt &&
          contract.pendingEffectiveAt.getTime() <= start * 1000 &&
          Array.isArray(contract.pendingFeatureCodes)
            ? (contract.pendingFeatureCodes as string[])
            : (history.find(row => row.id === contract.id)?.selections[0]?.featureCodes ??
              quote.lines.find(line => line.publicationId === contract.publicationId)!.featureCodes)
        return {
          contractId: contract.id,
          itemId: line.parent!.subscription_item_details!.subscription_item,
          featureCodes,
          priceId: priceId!,
          amount: fromStripeAmount(line.amount).toFixed(2),
        }
      })
  if (
    new Set(composition.map(c => c.contractId)).size !== composition.length ||
    composition.length !== recurring.length ||
    composition.some(
      c =>
        !recurring.some(
          line =>
            line.parent?.subscription_item_details?.subscription_item === c.itemId &&
            idOf(line.pricing?.price_details?.price) === c.priceId &&
            fromStripeAmount(line.amount).eq(c.amount),
        ),
    )
  )
    throw mismatch()
  const funding = await hybridFundingReader(venueId).invoice(invoice)
  const { disputed } = funding
  const expected = composition.reduce((sum, line) => sum.add(line.amount), new Prisma.Decimal(0))
  const underfunded = new Prisma.Decimal(funding.funded).lt(expected)
  if (underfunded && !funding.impaired) throw mismatch()
  const invalid = hybridPeriodInvalid(funding, expected)
  // Configure the agreed future price before activating a paid purchase; recovery repeats the same recorded operation.
  if (!invalid && invoiceId === purchase.initialInvoiceId && purchase.status !== 'COMPLETED') {
    await assertLive()
    await ensureHybridSchedule(purchase, sub)
    for (const source of quote.sources) {
      await recordedStripeWrite(
        purchaseId,
        `REPLACE:${source.sourceSubscriptionId}`,
        { subscriptionId: source.sourceSubscriptionId, customerId: source.sourceCustomerId },
        async (saved, idempotencyKey) => {
          await assertLive()
          const funding = await readHybridCreditSource(
            venueId,
            source.sourceSubscriptionId,
            source.sourceCustomerId,
            quote.effectiveAt,
            purchaseId,
          )
          if (hybridHash(funding) !== hybridHash(source)) throw mismatch()
          const current = await stripe.subscriptions.retrieve(saved.subscriptionId, {}, STRIPE_DENTRO_DEL_CANDADO)
          if (idOf(current.customer) !== saved.customerId) throw mismatch()
          return stripe.subscriptions.cancel(
            saved.subscriptionId,
            { invoice_now: false, prorate: false },
            { ...STRIPE_DENTRO_DEL_CANDADO, idempotencyKey },
          )
        },
        async () => {
          const current = await stripe.subscriptions.retrieve(source.sourceSubscriptionId, {}, STRIPE_DENTRO_DEL_CANDADO)
          if (idOf(current.customer) !== source.sourceCustomerId) throw mismatch()
          return current.status === 'canceled' ? current : null
        },
      )
    }
  }
  await assertLive()
  const delivered = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "HybridPurchase" WHERE id = ${purchaseId} FOR UPDATE`
    const current = await tx.hybridPurchase.findUniqueOrThrow({ where: { id: purchaseId, venueId } })
    if (['CANCELLED', 'EXPIRED'].includes(current.status)) throw mismatch()
    const before = await tx.hybridPaymentPeriod.findUnique({ where: { stripeInvoiceId: invoiceId } })
    const period = await tx.hybridPaymentPeriod.upsert({
      where: { stripeInvoiceId: invoiceId },
      create: {
        venueId,
        stripeSubscriptionId: sub.id,
        stripeInvoiceId: invoiceId,
        startsAt: new Date(start * 1000),
        endsAt: new Date(end * 1000),
        fundedAmount: funding.funded,
        refundedAmount: funding.refunded,
        disputed,
        composition: composition as Prisma.InputJsonValue,
      },
      update: { fundedAmount: funding.funded, refundedAmount: funding.refunded, disputed },
    })
    if (invalid) {
      const revoked = await tx.capabilityGrant.updateMany({
        where: { venueId, paymentPeriodId: period.id, revokedAt: null },
        data: { revokedAt: new Date() },
      })
      if (revoked.count || !before)
        await tx.activityLog.create({
          data: {
            venueId,
            action: 'HYBRID_PAYMENT_REVERSED',
            entity: 'HybridPurchase',
            entityId: purchaseId,
            data: { invoiceId, disputed, refunded: funding.refunded, transferredFundingLost: funding.creditLoss },
          },
        })
      await tx.hybridPurchase.update({
        where: { id: purchaseId },
        data: { lastIssue: funding.impaired ? 'HYBRID_TRANSFER_REVERSED' : 'HYBRID_PAYMENT_REVERSED' },
      })
      return { status: 'PAYMENT_REVERSED', issue: funding.impaired ? 'HYBRID_TRANSFER_REVERSED' : 'HYBRID_PAYMENT_REVERSED' }
    }
    const contracts = await tx.hybridContract.findMany({ where: { purchaseId, venueId }, orderBy: { id: 'asc' }, take: 9 })
    if (composition.some(line => !contracts.some(c => c.id === line.contractId && !c.endedAt))) return { status: 'ENDED' }
    if (!previous && contracts.some(c => c.revision !== purchase.contracts.find(original => original.id === c.id)?.revision))
      throw mismatch()
    const inserted = await tx.capabilityGrant.createMany({
      data: composition.flatMap(line =>
        line.featureCodes.map(featureCode => ({
          venueId,
          featureCode,
          sourceId: `${period.id}:${line.contractId}`,
          contractId: line.contractId,
          paymentPeriodId: period.id,
          startsAt: period.startsAt,
          endsAt: period.endsAt,
        })),
      ),
      skipDuplicates: true,
    })
    const restored =
      before && (before.disputed || before.fundedAmount.lt(expected))
        ? await tx.capabilityGrant.updateMany({
            where: {
              venueId,
              paymentPeriodId: period.id,
              contractId: { in: composition.map(c => c.contractId) },
              revokedAt: { not: null },
            },
            data: { revokedAt: null },
          })
        : { count: 0 }
    for (const line of composition) {
      const contract = contracts.find(c => c.id === line.contractId)!
      if (contract.pendingEffectiveAt && contract.pendingEffectiveAt <= period.startsAt && Array.isArray(contract.pendingFeatureCodes)) {
        await tx.hybridContractSelection.create({
          data: { contractId: contract.id, effectiveAt: contract.pendingEffectiveAt, featureCodes: line.featureCodes },
        })
        await tx.hybridContract.update({
          where: { id: contract.id },
          data: { featureCodes: line.featureCodes, pendingFeatureCodes: Prisma.DbNull, pendingEffectiveAt: null },
        })
      }
      await tx.hybridContract.updateMany({
        where: { id: line.contractId, venueId, OR: [{ paidThrough: null }, { paidThrough: { lt: period.endsAt } }] },
        data: { paidThrough: period.endsAt, stripeItemId: line.itemId },
      })
    }
    if (invoiceId === purchase.initialInvoiceId && current.status !== 'COMPLETED') {
      const replaced = quote.replaces
      await tx.venueFeature.updateMany({
        where: { venueId, stripeSubscriptionId: { in: replaced } },
        data: { active: false, endDate: new Date() },
      })
      await tx.hybridContract.updateMany({
        where: { venueId, stripeSubscriptionId: { in: replaced }, endedAt: null },
        data: { endedAt: new Date() },
      })
      await tx.capabilityGrant.updateMany({
        where: { venueId, contract: { stripeSubscriptionId: { in: replaced } }, revokedAt: null },
        data: { revokedAt: new Date() },
      })
      await tx.hybridCreditAllocation.updateMany({ where: { purchaseId, status: 'RESERVED' }, data: { status: 'CONSUMED' } })
      const redemptions = await tx.hybridRedemption.findMany({
        where: { purchaseId, status: 'RESERVED' },
        orderBy: { campaignId: 'asc' },
        take: 9,
      })
      if (redemptions.length > 8) throw mismatch()
      for (const redemption of redemptions) {
        const campaign = await tx.hybridCampaign.updateMany({
          where: { id: redemption.campaignId, reservedCount: { gt: 0 } },
          data: { reservedCount: { decrement: 1 }, redeemedCount: { increment: 1 } },
        })
        if (!campaign.count) throw mismatch()
        await tx.hybridRedemption.update({ where: { id: redemption.id }, data: { status: 'REDEEMED' } })
      }
      await tx.hybridPurchase.update({ where: { id: purchaseId }, data: { status: 'COMPLETED', lastIssue: null } })
    }
    if (inserted.count || restored.count)
      await tx.activityLog.create({
        data: {
          venueId,
          staffId: purchase.quotedById,
          action: 'HYBRID_ACCESS_DELIVERED',
          entity: 'HybridPurchase',
          entityId: purchaseId,
          data: { invoiceId, featureCodes: [...new Set(composition.flatMap(line => line.featureCodes))], fundedAmount: funding.funded },
        },
      })
    if (current.lastIssue === 'HYBRID_TRANSFER_REVERSED' || current.lastIssue === 'HYBRID_PAYMENT_REVERSED')
      await tx.hybridPurchase.update({ where: { id: purchaseId }, data: { lastIssue: null } })
    return { status: 'ACTIVE', paidThrough: period.endsAt.toISOString() }
  })
  // The team follows the FIRST paid invoice, after the commit: the new grants must be visible to the cap (spec §4.3).
  if (delivered.status === 'ACTIVE' && invoiceId === purchase.initialInvoiceId)
    await settleSeatsAfterHybridDelivery(venueId, purchaseId, quote)
  return delivered
}
