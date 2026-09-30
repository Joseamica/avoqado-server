import { Decimal } from '@prisma/client/runtime/library'
import prisma from '@/utils/prismaClient'
import { ConflictError } from '@/errors/AppError'
import { stripe, STRIPE_DENTRO_DEL_CANDADO } from '@/services/stripe.service'
import { unusedPaidCredit } from './hybridQuote'
import { hybridFundingReader } from './hybridFundingGraph'
import { fromStripeAmount } from '@/services/payments/providers/money'

const idOf = (value: string | { id: string } | null) => (typeof value === 'string' ? value : value?.id)

/** Called only for subscriptions already found in this venue's complete obligation inventory. */
export async function readHybridCreditSource(
  venueId: string,
  subscriptionId: string,
  customerId: string,
  effectiveAt: number,
  excludingPurchaseId?: string,
) {
  const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['latest_invoice'] }, STRIPE_DENTRO_DEL_CANDADO)
  if (sub.id !== subscriptionId || idOf(sub.customer) !== customerId)
    throw new ConflictError('La suscripción no coincide con el negocio.', 'HYBRID_SOURCE_MISMATCH')
  const invoice = sub.latest_invoice
  if (!invoice || typeof invoice === 'string' || idOf(invoice.customer) !== customerId)
    throw new ConflictError('No pudimos verificar la factura de origen.', 'HYBRID_FUNDING_UNVERIFIED')
  if (invoice.status !== 'paid')
    throw new ConflictError('Resuelve la factura pendiente antes de reemplazar esta suscripción.', 'HYBRID_SOURCE_UNPAID')
  if (invoice.lines.has_more || sub.items.has_more || !sub.items.data.length)
    throw new ConflictError('La factura de origen requiere revisión.', 'HYBRID_FUNDING_UNVERIFIED')
  const periods = invoice.lines.data.filter(line => line.parent?.subscription_item_details?.subscription_item)
  const start = periods[0]?.period.start
  const end = periods[0]?.period.end
  if (
    !start ||
    !end ||
    end <= start ||
    periods.some(
      line =>
        line.period.start !== start || line.period.end !== end || line.amount < 0 || line.parent?.subscription_item_details?.proration,
    ) ||
    sub.items.data.some(item => item.current_period_start !== start || item.current_period_end !== end)
  )
    throw new ConflictError('La cobertura de la factura no coincide con la suscripción.', 'HYBRID_FUNDING_UNVERIFIED')
  // default_incomplete remains payable for up to 23h. Do not allow the source to renew while that confirmation is open.
  if (end <= effectiveAt + 24 * 3600)
    throw new ConflictError('Esta suscripción está por renovar. Haz el cambio después de resolver su renovación.', 'HYBRID_SOURCE_RENEWING')
  const [funding, previousCredits] = await Promise.all([
    hybridFundingReader(venueId).invoice(invoice),
    prisma.hybridCreditAllocation.aggregate({
      where: {
        sourceInvoiceId: invoice.id,
        status: { not: 'RELEASED' },
        ...(excludingPurchaseId ? { purchaseId: { not: excludingPurchaseId } } : {}),
      },
      _sum: { amount: true },
    }),
  ])
  if (funding.disputed) throw new ConflictError('El pago de origen está en disputa.', 'HYBRID_FUNDING_UNVERIFIED')
  const recurringAmount = periods.reduce((sum, line) => sum.add(fromStripeAmount(line.amount)), new Decimal(0))
  funding.funded = Decimal.min(funding.funded, recurringAmount).toFixed(2)
  funding.refunded = Decimal.min(funding.refunded, funding.funded).toFixed(2)
  const alreadyCredited = previousCredits._sum.amount?.toString() ?? '0'
  const amount = unusedPaidCredit({ paid: funding.funded, refunded: funding.refunded, alreadyCredited, start, end, effectiveAt })
  return {
    sourceSubscriptionId: subscriptionId,
    sourceInvoiceId: invoice.id,
    sourceCustomerId: customerId,
    startsAt: new Date(start * 1000).toISOString(),
    endsAt: new Date(end * 1000).toISOString(),
    funded: funding.funded,
    refunded: funding.refunded,
    alreadyCredited: new Decimal(alreadyCredited).toFixed(2),
    amount,
  }
}
