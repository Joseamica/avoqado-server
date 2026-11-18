/**
 * Los tres puntos de la entrega que mueven al equipo cuando el contrato es un Plan Básico (Task 3): el contrato termina,
 * el periodo se revierte (devolución o disputa) y cada factura pagada que se entrega (no sólo la primera).
 */
import { Prisma } from '@prisma/client'
import { prismaMock } from '../../../__helpers__/setup'

const retrieveSub = jest.fn()
const retrieveInvoice = jest.fn()
jest.mock('@/services/stripe.service', () => ({
  stripe: {
    subscriptions: { retrieve: (...a: unknown[]) => retrieveSub(...a) },
    invoices: { retrieve: (...a: unknown[]) => retrieveInvoice(...a) },
  },
  STRIPE_DENTRO_DEL_CANDADO: {},
}))
const funding = jest.fn()
jest.mock('@/services/launchCampaigns/hybridFundingGraph', () => ({
  hybridFundingReader: () => ({ invoice: (...a: unknown[]) => funding(...a) }),
}))
const execute = jest.fn()
jest.mock('@/services/dashboard/seatReconciliation.service', () => ({
  executeSeatReconciliation: (...a: unknown[]) => execute(...a),
}))
const settle = jest.fn()
const restore = jest.fn()
jest.mock('@/services/launchCampaigns/hybridSeats', () => ({
  settleSeatsAfterHybridDelivery: (...a: unknown[]) => settle(...a),
  unsettledCheckoutSeatChoice: jest.fn().mockResolvedValue(undefined),
  restoreBasicSeats: (...a: unknown[]) => restore(...a),
}))
import { reconcileHybridInvoice } from '@/services/launchCampaigns/hybridDelivery.service'

const basicDefinition = { kind: 'FEATURES', basicPlan: true, seatCap: 5 }
const featuresDefinition = { kind: 'FEATURES' }
const start = 1_790_000_000
const end = start + 30 * 86400

function purchaseWith(definition: object, planTier: string | null = null) {
  return {
    id: 'purchase',
    venueId: 'venue',
    quotedById: 'staff',
    status: 'COMPLETED',
    stripeSubscriptionId: 'sub',
    stripeCustomerId: 'cus',
    initialInvoiceId: 'in_first',
    quoteHash: 'qh',
    lastIssue: null,
    quote: { replaces: [], lines: [{ publicationId: 'pub', featureCodes: ['A'] }], input: {} },
    contracts: [{ id: 'c1', planTier, endedAt: null, revision: 1, publicationId: 'pub', publication: { definition } }],
  }
}
const sub = (status: string) => ({
  id: 'sub',
  customer: 'cus',
  status,
  metadata: { hybridPurchaseId: 'purchase', venueId: 'venue', quoteHash: 'qh' },
  items: { has_more: false },
})
const invoice = {
  id: 'in_renewal',
  customer: 'cus',
  currency: 'mxn',
  status: 'paid',
  amount_remaining: 0,
  parent: { subscription_details: { subscription: 'sub' } },
  lines: {
    has_more: false,
    data: [
      {
        parent: { subscription_item_details: { subscription_item: 'si_1', proration: false } },
        quantity: 1,
        amount: 57884,
        period: { start, end },
        pricing: { price_details: { price: 'price_1' } },
      },
    ],
  },
}
const period = {
  id: 'period',
  stripeInvoiceId: 'in_renewal',
  startsAt: new Date(start * 1000),
  endsAt: new Date(end * 1000),
  disputed: false,
  fundedAmount: new Prisma.Decimal('578.84'),
  composition: [{ contractId: 'c1', itemId: 'si_1', featureCodes: ['A'], priceId: 'price_1', amount: '578.84' }],
}

function arrange(definition: object, planTier: string | null = null) {
  const purchase = purchaseWith(definition, planTier)
  prismaMock.$transaction.mockImplementation(async (fn: any) => fn(prismaMock))
  prismaMock.$queryRaw.mockResolvedValue([])
  prismaMock.hybridPurchase.findUnique.mockResolvedValue(purchase)
  prismaMock.hybridPurchase.findUniqueOrThrow.mockResolvedValue(purchase)
  prismaMock.hybridPurchase.update.mockResolvedValue({})
  prismaMock.hybridContract.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.hybridContract.findMany.mockResolvedValue(purchase.contracts)
  prismaMock.capabilityGrant.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.capabilityGrant.createMany.mockResolvedValue({ count: 1 })
  prismaMock.hybridPaymentPeriod.findUnique.mockResolvedValue(period)
  prismaMock.hybridPaymentPeriod.upsert.mockResolvedValue(period)
  prismaMock.activityLog.create.mockResolvedValue({})
  retrieveInvoice.mockResolvedValue(invoice)
  execute.mockReset().mockResolvedValue(3)
  settle.mockReset().mockResolvedValue(undefined)
  restore.mockReset().mockResolvedValue(3)
}

describe('la entrega mueve al equipo de un Plan Básico', () => {
  it('contrato terminado (suscripción cancelada) → vuelve el tope de Gratis', async () => {
    arrange(basicDefinition)
    retrieveSub.mockResolvedValue(sub('canceled'))
    await expect(reconcileHybridInvoice('venue', 'purchase', 'in_renewal')).resolves.toEqual({ status: 'ENDED' })
    expect(execute).toHaveBeenCalledWith('venue')
  })

  it('grants revocados por devolución → vuelve el tope de Gratis, después del commit', async () => {
    arrange(basicDefinition)
    retrieveSub.mockResolvedValue(sub('active'))
    funding.mockResolvedValue({ funded: '578.84', refunded: '578.84', disputed: false, impaired: false, creditLoss: '0' })
    await expect(reconcileHybridInvoice('venue', 'purchase', 'in_renewal')).resolves.toMatchObject({ status: 'PAYMENT_REVERSED' })
    expect(prismaMock.capabilityGrant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId: 'venue', paymentPeriodId: 'period', revokedAt: null } }),
    )
    expect(execute).toHaveBeenCalledWith('venue')
    expect(restore).not.toHaveBeenCalled()
  })

  it('cada factura pagada del Básico que se entrega (no sólo la primera) regresa al equipo; el sello SEATS sigue sólo en la primera', async () => {
    arrange(basicDefinition)
    retrieveSub.mockResolvedValue(sub('active'))
    funding.mockResolvedValue({ funded: '578.84', refunded: '0', disputed: false, impaired: false, creditLoss: '0' })
    await expect(reconcileHybridInvoice('venue', 'purchase', 'in_renewal')).resolves.toMatchObject({ status: 'ACTIVE' })
    expect(restore).toHaveBeenCalledWith('venue')
    expect(settle).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('regresión: un contrato de funciones sin Básico no toca al equipo en ninguno de los tres puntos', async () => {
    arrange(featuresDefinition)
    retrieveSub.mockResolvedValue(sub('active'))
    funding.mockResolvedValue({ funded: '578.84', refunded: '0', disputed: false, impaired: false, creditLoss: '0' })
    await reconcileHybridInvoice('venue', 'purchase', 'in_renewal')
    funding.mockResolvedValue({ funded: '578.84', refunded: '578.84', disputed: false, impaired: false, creditLoss: '0' })
    await reconcileHybridInvoice('venue', 'purchase', 'in_renewal')
    retrieveSub.mockResolvedValue(sub('canceled'))
    await reconcileHybridInvoice('venue', 'purchase', 'in_renewal')
    expect(restore).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('regresión: un contrato con planTier que termina sigue conciliando como antes', async () => {
    arrange(featuresDefinition, 'PRO')
    retrieveSub.mockResolvedValue(sub('canceled'))
    await reconcileHybridInvoice('venue', 'purchase', 'in_renewal')
    expect(execute).toHaveBeenCalledWith('venue')
  })
})
