import type Stripe from 'stripe'
import { Decimal } from '@prisma/client/runtime/library'
import prisma from '@/utils/prismaClient'
import { ConflictError } from '@/errors/AppError'
import { stripe, STRIPE_DENTRO_DEL_CANDADO as options } from '@/services/stripe.service'
import { fromStripeAmount } from '@/services/payments/providers/money'
import { invoiceFunding, resolveHybridPaymentDisputes } from './hybridInvoiceFunding'
import { unusedPaidCredit } from './hybridQuote'
import type { HybridQuoteSnapshot } from './hybridPurchase.service'

const idOf = (value: string | { id: string } | null) => (typeof value === 'string' ? value : value?.id)
const unverified = () => new ConflictError('El origen del saldo necesita revisión antes de usarlo.', 'HYBRID_FUNDING_UNVERIFIED')
type Funding = { funded: string; refunded: string; disputed: boolean; impaired: boolean; creditLoss: string }

/** One bounded provider observation shared by the invoice, its transfers and any balance it consumed. */
export function hybridFundingReader(venueId: string) {
  const completed = new Map<string, Funding>()
  const visiting = new Set<string>()
  let observed = 0
  const deadline = Date.now() + 45000
  const withinBudget = () => {
    if (++observed > 100 || Date.now() > deadline) throw unverified()
  }

  async function readInvoice(value: Stripe.Invoice): Promise<Funding> {
    if (!value?.id || visiting.has(value.id)) throw unverified()
    const cached = completed.get(value.id)
    if (cached) return cached
    withinBudget()
    visiting.add(value.id)
    try {
      const [paymentList, noteList, purchase] = await Promise.all([
        stripe.invoicePayments.list(
          { invoice: value.id, status: 'paid', limit: 100, expand: ['data.payment.charge', 'data.payment.payment_intent.latest_charge'] },
          options,
        ),
        stripe.creditNotes.list({ invoice: value.id, limit: 100 }, options),
        prisma.hybridPurchase.findUnique({
          where: { initialInvoiceId: value.id },
          select: { venueId: true, stripeCustomerId: true, quote: true },
        }),
      ])
      if (paymentList.has_more || noteList.has_more) throw unverified()
      if (purchase && (purchase.venueId !== venueId || purchase.stripeCustomerId !== idOf(value.customer))) throw unverified()
      const quote = purchase?.quote as unknown as HybridQuoteSnapshot | undefined
      let transfer = new Decimal(0)
      if (quote) {
        if (quote.sources.length > 8) throw unverified()
        for (const source of quote.sources) {
          const sourceInvoice = await stripe.invoices.retrieve(source.sourceInvoiceId, {}, options)
          if (idOf(sourceInvoice.customer) !== source.sourceCustomerId || source.sourceCustomerId !== idOf(value.customer))
            throw unverified()
          const funding = await readInvoice(sourceInvoice)
          const available = unusedPaidCredit({
            paid: funding.disputed ? '0' : Decimal.min(source.funded, funding.funded).toFixed(2),
            refunded: funding.refunded,
            alreadyCredited: source.alreadyCredited,
            start: Date.parse(source.startsAt) / 1000,
            end: Date.parse(source.endsAt) / 1000,
            effectiveAt: quote.effectiveAt,
          })
          transfer = transfer.add(Decimal.min(source.amount, available))
        }
      }
      const nominalTransfer = new Decimal(quote?.credit ?? '0')
      if (transfer.gt(nominalTransfer)) throw unverified()
      const applied = fromStripeAmount(Math.max(0, Math.max(0, -value.starting_balance) - Math.max(0, -(value.ending_balance ?? 0))))
      const balance = applied.gt(0)
        ? await readBalance(idOf(value.customer)!, value.id)
        : { nominal: new Decimal(0), valid: new Decimal(0) }
      if (!balance.nominal.eq(applied)) throw unverified()
      const loss = nominalTransfer.sub(transfer).add(applied.sub(balance.valid))
      const resolved = await resolveHybridPaymentDisputes(paymentList.data)
      const funding = invoiceFunding(value, resolved.payments, noteList.data, nominalTransfer.toFixed(2), loss.toFixed(2))
      const result = { ...funding, disputed: resolved.disputed, impaired: loss.gt(0), creditLoss: loss.toFixed(2) }
      completed.set(value.id, result)
      return result
    } finally {
      visiting.delete(value.id)
    }
  }

  async function readBalance(customerId: string, invoiceId?: string) {
    withinBudget()
    // ponytail: last 100 movements; persist funded balance lots if long-lived credit cycles exceed this ceiling.
    const response = await stripe.customers.listBalanceTransactions(customerId, { limit: 100 }, options)
    const chronological = [...response.data].reverse()
    let last = invoiceId ? -1 : chronological.length - 1
    if (invoiceId)
      chronological.forEach((row, index) => {
        if (row.type === 'applied_to_invoice' && idOf(row.invoice) === invoiceId) last = index
      })
    if (last < 0) throw unverified()
    const rows = chronological.slice(0, last + 1)
    const firstUse = invoiceId
      ? rows.findIndex(row => row.type === 'applied_to_invoice' && idOf(row.invoice) === invoiceId)
      : rows.length - 1
    // Start at the latest zero/debit balance before this use. Older closed cycles cannot fund it.
    let start = 0
    for (let index = 0; index <= firstUse; index++) if (rows[index].ending_balance - rows[index].amount >= 0) start = index
    if (rows[start].ending_balance - rows[start].amount < 0) throw unverified()
    const lots: Array<{ nominal: Decimal; valid: Decimal }> = []
    let nominalUsed = new Decimal(0),
      validUsed = new Decimal(0)
    let previous = rows[start].ending_balance - rows[start].amount
    for (const row of rows.slice(start)) {
      if (row.currency !== 'mxn' || idOf(row.customer) !== customerId || row.ending_balance - row.amount !== previous) throw unverified()
      previous = row.ending_balance
      if (row.amount < 0) {
        const nominal = fromStripeAmount(Math.min(-row.amount, Math.max(0, -row.ending_balance)))
        let loss = new Decimal(0)
        const originId = idOf(row.invoice)
        if (originId && ['invoice_too_small', 'invoice_overpaid', 'unapplied_from_invoice'].includes(row.type)) {
          const origin = await stripe.invoices.retrieve(originId, {}, options)
          if (idOf(origin.customer) !== customerId) throw unverified()
          const source = await readInvoice(origin)
          loss = new Decimal(source.creditLoss).add(source.refunded)
          if (source.disputed) loss = nominal
        }
        lots.push({ nominal, valid: Decimal.max(0, nominal.sub(loss)) })
      } else {
        let debit = fromStripeAmount(row.amount)
        while (debit.gt(0) && lots.length) {
          const lot = lots[0],
            used = Decimal.min(lot.nominal, debit),
            valid = Decimal.min(lot.valid, used)
          if (invoiceId && row.type === 'applied_to_invoice' && idOf(row.invoice) === invoiceId) {
            nominalUsed = nominalUsed.add(used)
            validUsed = validUsed.add(valid)
          }
          lot.nominal = lot.nominal.sub(used)
          lot.valid = lot.valid.sub(valid)
          debit = debit.sub(used)
          if (lot.nominal.isZero()) lots.shift()
        }
      }
    }
    return invoiceId
      ? { nominal: nominalUsed, valid: validUsed }
      : {
          nominal: lots.reduce((sum, lot) => sum.add(lot.nominal), new Decimal(0)),
          valid: lots.reduce((sum, lot) => sum.add(lot.valid), new Decimal(0)),
        }
  }
  return { invoice: readInvoice, balance: readBalance }
}

/** A reversed transfer is not a usable discount for another subscription. No automatic debt or new charge is created. */
export async function assertHybridBalanceUsable(venueId: string, customerId: string, balance: number) {
  if (balance >= 0) return
  const observed = await hybridFundingReader(venueId).balance(customerId)
  if (!observed.nominal.eq(fromStripeAmount(-balance))) throw unverified()
  if (!observed.valid.eq(observed.nominal))
    throw new ConflictError(
      'Una devolución afectó el saldo transferido. Revisaremos ese saldo antes de abrir otra compra.',
      'HYBRID_TRANSFER_REVERSED',
    )
}
