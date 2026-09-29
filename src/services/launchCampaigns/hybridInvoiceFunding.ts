import type Stripe from 'stripe'
import { Decimal } from '@prisma/client/runtime/library'
import { ConflictError } from '@/errors/AppError'
import { fromStripeAmount } from '@/services/payments/providers/money'

/** A charge stays marked disputed after winning; consult the current disputes before revoking its coverage. */
export async function resolveHybridPaymentDisputes(payments: Stripe.InvoicePayment[]) {
  const { stripe, STRIPE_DENTRO_DEL_CANDADO: options } = await import('@/services/stripe.service')
  let disputed = false
  const normalized: Stripe.InvoicePayment[] = []
  for (const payment of payments) {
    const intent = payment.payment.payment_intent
    const charge = payment.payment.type === 'charge' ? payment.payment.charge : typeof intent === 'object' ? intent?.latest_charge : null
    if (charge && typeof charge !== 'string' && charge.disputed) {
      const disputes = await stripe.disputes.list({ charge: charge.id, limit: 100 }, options)
      if (disputes.has_more || !disputes.data.length)
        throw new ConflictError('No pudimos verificar el estado de la disputa.', 'HYBRID_FUNDING_UNVERIFIED')
      disputed ||= disputes.data.some(d => !['won', 'warning_closed', 'prevented'].includes(d.status))
      normalized.push({ ...payment, payment: { type: 'charge', charge: { ...charge, disputed: false } } })
    } else normalized.push(payment)
  }
  return { disputed, payments: normalized }
}

/** Stripe boundary. Return major units, and never infer real funding from a subscription's active status. */
export function invoiceFunding(
  invoice: Stripe.Invoice,
  payments: Stripe.InvoicePayment[],
  notes: Stripe.CreditNote[],
  transferredCredit: string,
  unavailableCredit = '0',
) {
  const unverifiable = () =>
    new ConflictError('No pudimos verificar el pago y sus devoluciones para calcular el crédito.', 'HYBRID_FUNDING_UNVERIFIED')
  if (invoice.currency !== 'mxn') throw unverifiable()
  if (invoice.status !== 'paid') return { funded: '0.00', refunded: '0.00' }
  let settled = new Decimal(0)
  let refunded = new Decimal(0)
  const seenCharges = new Set<string>()
  for (const payment of payments) {
    if (payment.status !== 'paid') continue
    const intent = payment.payment.payment_intent
    const charge = payment.payment.type === 'charge' ? payment.payment.charge : typeof intent === 'object' ? intent.latest_charge : null
    if (
      !charge ||
      typeof charge === 'string' ||
      charge.disputed ||
      !charge.paid ||
      charge.currency !== 'mxn' ||
      payment.currency !== 'mxn' ||
      payment.amount_paid !== charge.amount ||
      seenCharges.has(charge.id)
    )
      throw unverifiable()
    seenCharges.add(charge.id)
    settled = settled.add(fromStripeAmount(payment.amount_paid))
    refunded = refunded.add(fromStripeAmount(charge.amount_refunded))
  }
  const issued = notes.filter(note => note.status === 'issued')
  const noteTotal = issued.reduce((sum, note) => sum.add(fromStripeAmount(note.post_payment_amount)), new Decimal(0))
  if (!noteTotal.eq(fromStripeAmount(invoice.post_payment_credit_notes_amount))) throw unverifiable()
  const linkedRefunds = issued.reduce(
    (sum, note) => sum.add(note.refunds.reduce((total, refund) => total.add(fromStripeAmount(refund.amount_refunded)), new Decimal(0))),
    new Decimal(0),
  )
  if (linkedRefunds.gt(refunded)) throw unverifiable()
  refunded = refunded.add(noteTotal.sub(linkedRefunds))
  if (invoice.starting_balance !== 0 && invoice.ending_balance === null) throw unverifiable()
  const appliedBalance = fromStripeAmount(Math.max(0, Math.max(0, -invoice.starting_balance) - Math.max(0, -(invoice.ending_balance ?? 0))))
  const transferred = new Decimal(transferredCredit)
  const unavailable = new Decimal(unavailableCredit)
  if (!transferred.isFinite() || transferred.isNegative() || !unavailable.isFinite() || unavailable.isNegative()) throw unverifiable()
  // A negative invoice leaves excess transfer in the customer's balance; it cannot also fund this period.
  const funded = Decimal.max(
    0,
    Decimal.min(
      fromStripeAmount(Math.abs(invoice.total)).mul(Math.sign(invoice.total)).add(transferred),
      settled.add(appliedBalance).add(transferred).sub(unavailable),
    ),
  )
  return { funded: funded.toFixed(2), refunded: Decimal.min(funded, refunded).toFixed(2) }
}
