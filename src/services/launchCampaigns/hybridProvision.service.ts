import type Stripe from 'stripe'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { ConflictError, NotFoundError } from '@/errors/AppError'
import { stripe, STRIPE_DENTRO_DEL_CANDADO } from '@/services/stripe.service'
import { toStripeAmount } from '@/services/payments/providers/money'
import { hybridHash, recordedStripeWrite } from './hybridProvider'
import { readHybridCreditSource } from './hybridSources'
import type { HybridQuoteSnapshot } from './hybridPurchase.service'

const idOf = (value: string | { id: string } | null) => (typeof value === 'string' ? value : value?.id)

/** Creates no access. The payment link is exposed only after its exact amount and ownership are verified. */
export async function provisionHybridPurchase(venueId: string, purchaseId: string) {
  const purchase = await prisma.hybridPurchase.findUnique({ where: { id: purchaseId, venueId } })
  if (!purchase) throw new NotFoundError('Intento no encontrado.')
  if (!['ACCEPTED', 'PROVISIONING', 'PAYMENT_PENDING', 'PAID', 'DELIVERING'].includes(purchase.status) || !purchase.stripeCustomerId)
    throw new ConflictError('Este intento no está disponible para abrir un pago.', 'HYBRID_PURCHASE_NOT_ACCEPTED')
  if (purchase.paymentExpiresAt && purchase.paymentExpiresAt <= new Date() && !purchase.stripeSubscriptionId) {
    const operation = await prisma.hybridBillingOperation.findUnique({ where: { purchaseId_step: { purchaseId, step: 'SUBSCRIPTION' } } })
    if (!operation) {
      // Cancellation rechecks under the row lock shared by provider-operation insertion.
      const { cancelHybridPurchase } = await import('./hybridLifecycle.service')
      return { purchaseId, ...(await cancelHybridPurchase(venueId, purchaseId, purchase.quotedById, true)), paymentUrl: null }
    }
  }
  const quote = purchase.quote as unknown as HybridQuoteSnapshot
  const publications = await prisma.hybridOfferPublication.findMany({
    where: { id: { in: quote.lines.map(line => line.publicationId) } },
    orderBy: { id: 'asc' },
    take: 8,
  })
  if (
    publications.length !== quote.lines.length ||
    publications.some(
      pub =>
        !pub.stripePriceId ||
        !pub.stripeProductId ||
        pub.definitionHash !== quote.lines.find(line => line.publicationId === pub.id)?.definitionHash,
    )
  )
    throw new ConflictError('No pudimos verificar los precios aceptados.', 'HYBRID_PRICE_MISMATCH')
  const metadata = { kind: 'HYBRID_PURCHASE', hybridPurchaseId: purchaseId, venueId, quoteHash: purchase.quoteHash }
  const credit = toStripeAmount(new Prisma.Decimal(quote.credit))
  const params: Stripe.SubscriptionCreateParams = {
    customer: purchase.stripeCustomerId,
    items: quote.lines.map(line => ({ price: publications.find(pub => pub.id === line.publicationId)!.stripePriceId!, quantity: 1 })),
    metadata,
    payment_behavior: 'default_incomplete',
    payment_settings: { save_default_payment_method: 'on_subscription', payment_method_types: ['card'] },
    automatic_tax: { enabled: false },
    default_tax_rates: [],
    discounts: '',
    ...(credit
      ? {
          add_invoice_items: [
            {
              price_data: { product: publications[0].stripeProductId!, currency: 'mxn', unit_amount: -credit, tax_behavior: 'inclusive' },
              quantity: 1,
            },
          ],
        }
      : {}),
    expand: ['latest_invoice'],
  }
  const certify = (sub: Stripe.Subscription): Stripe.Subscription => {
    const invoice = sub.latest_invoice
    const matchesItems =
      !sub.items.has_more &&
      sub.items.data.length === params.items!.length &&
      params.items!.every(wanted => sub.items.data.filter(item => item.quantity === 1 && wanted.price === item.price.id).length === 1)
    if (
      idOf(sub.customer) !== purchase.stripeCustomerId ||
      Object.entries(metadata).some(([key, value]) => sub.metadata[key] !== value) ||
      sub.items.has_more ||
      !matchesItems ||
      !invoice ||
      typeof invoice === 'string' ||
      idOf(invoice.customer) !== purchase.stripeCustomerId ||
      invoice.currency !== 'mxn' ||
      invoice.total !== toStripeAmount(new Prisma.Decimal(quote.total)) - credit ||
      invoice.amount_due !== toStripeAmount(new Prisma.Decimal(quote.dueNow))
    )
      throw new ConflictError(
        'La factura no coincide con la compra aceptada; conservamos el intento para revisarlo.',
        'HYBRID_INVOICE_MISMATCH',
      )
    return sub
  }
  const read = async (id: string) =>
    certify(await stripe.subscriptions.retrieve(id, { expand: ['latest_invoice'] }, STRIPE_DENTRO_DEL_CANDADO))
  await prisma.hybridPurchase.updateMany({ where: { id: purchaseId, venueId, status: 'ACCEPTED' }, data: { status: 'PROVISIONING' } })
  const subscription = await recordedStripeWrite(
    purchaseId,
    'SUBSCRIPTION',
    params,
    async (saved, idempotencyKey) => {
      // Once journaled, recovery may replay the SAME key within its 23h retention guard.
      for (const source of quote.sources) {
        const current = await readHybridCreditSource(
          venueId,
          source.sourceSubscriptionId,
          source.sourceCustomerId,
          quote.effectiveAt,
          purchaseId,
        )
        if (hybridHash(current) !== hybridHash(source))
          throw new ConflictError('El pago de origen cambió. No abrimos otro cobro.', 'HYBRID_QUOTE_STALE')
      }
      return certify(await stripe.subscriptions.create(saved, { ...STRIPE_DENTRO_DEL_CANDADO, idempotencyKey }))
    },
    async providerId => {
      if (providerId || purchase.stripeSubscriptionId) return read(providerId ?? purchase.stripeSubscriptionId!)
      const matches: string[] = []
      let after: string | undefined
      let count = 0
      const deadline = Date.now() + 45000
      do {
        if (Date.now() > deadline) throw new ConflictError('No pudimos revisar los intentos previos a tiempo.')
        const page = await stripe.subscriptions.list(
          { customer: purchase.stripeCustomerId!, status: 'all', limit: 100, ...(after ? { starting_after: after } : {}) },
          STRIPE_DENTRO_DEL_CANDADO,
        )
        count += page.data.length
        matches.push(...page.data.filter(sub => sub.metadata?.hybridPurchaseId === purchaseId).map(sub => sub.id))
        if (count > 1000 || matches.length > 1) throw new ConflictError('El intento requiere revisión antes de continuar.')
        after = page.has_more ? page.data.at(-1)?.id : undefined
        if (page.has_more && !after) throw new ConflictError('No pudimos revisar todos los intentos anteriores.')
      } while (after)
      return matches[0] ? read(matches[0]) : null
    },
  )
  const invoice = subscription.latest_invoice as Stripe.Invoice
  const status = invoice.status === 'paid' ? 'PAID' : 'PAYMENT_PENDING'
  await prisma.$transaction(async tx => {
    await tx.hybridContract.createMany({
      data: quote.lines.map(line => {
        const publication = publications.find(pub => pub.id === line.publicationId)!
        const item = subscription.items.data.find(item => item.price.id === publication.stripePriceId)!
        return {
          venueId,
          purchaseId,
          publicationId: publication.id,
          stripeSubscriptionId: subscription.id,
          stripeItemId: item.id,
          featureCodes: line.featureCodes,
          planTier: line.planTier,
          startsAt: new Date(item.current_period_start * 1000),
        }
      }),
      skipDuplicates: true,
    })
    const contracts = await tx.hybridContract.findMany({ where: { purchaseId, venueId }, orderBy: { id: 'asc' }, take: 9 })
    if (
      contracts.length !== quote.lines.length ||
      quote.lines.some(line => {
        const publication = publications.find(pub => pub.id === line.publicationId)!
        const item = subscription.items.data.find(item => item.price.id === publication.stripePriceId)!
        const contract = contracts.find(contract => contract.publicationId === line.publicationId)
        return (
          !contract ||
          contract.stripeItemId !== item.id ||
          contract.planTier !== line.planTier ||
          hybridHash(contract.featureCodes) !== hybridHash(line.featureCodes)
        )
      })
    )
      throw new ConflictError('Los contratos guardados no coinciden con la compra.', 'HYBRID_CONTRACT_MISMATCH')
    const updated = await tx.hybridPurchase.updateMany({
      where: { id: purchaseId, venueId, status: { in: ['ACCEPTED', 'PROVISIONING', 'PAYMENT_PENDING'] } },
      data: { stripeSubscriptionId: subscription.id, initialInvoiceId: invoice.id, status },
    })
    if (
      updated.count &&
      (purchase.status !== status || purchase.stripeSubscriptionId !== subscription.id || purchase.initialInvoiceId !== invoice.id)
    )
      await tx.activityLog.create({
        data: {
          venueId,
          action: 'HYBRID_PAYMENT_READY',
          entity: 'HybridPurchase',
          entityId: purchaseId,
          data: { subscriptionId: subscription.id, invoiceId: invoice.id },
        },
      })
  })
  return {
    purchaseId,
    status: status === 'PAID' ? 'ACTIVATION_PENDING' : 'PAYMENT_PENDING',
    paymentUrl: invoice.status === 'open' ? invoice.hosted_invoice_url : null,
  }
}
