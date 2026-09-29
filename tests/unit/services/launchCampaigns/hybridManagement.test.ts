import { prismaMock } from '../../../__helpers__/setup'
const tier = jest.fn()
jest.mock('@/services/access/basePlan.service', () => ({
  getVenueBaseTier: (...args: unknown[]) => tier(...args),
  FREE_TIER_CODES: [],
  elPlanConcede: () => false,
}))
jest.mock('@/services/stripe.service', () => ({
  stripe: {
    subscriptions: { retrieve: jest.fn(), update: jest.fn() },
    subscriptionSchedules: { create: jest.fn(), retrieve: jest.fn(), update: jest.fn() },
  },
  STRIPE_DENTRO_DEL_CANDADO: {},
}))
jest.mock('@/services/launchCampaigns/hybridProvider', () => ({
  ...jest.requireActual('@/services/launchCampaigns/hybridProvider'),
  recordedStripeWrite: (_purchase: string, _step: string, request: unknown, perform: (saved: unknown, key: string) => unknown) =>
    perform(request, 'key'),
}))
jest.mock('@/services/launchCampaigns/hybridSchedule', () => ({
  ...jest.requireActual('@/services/launchCampaigns/hybridSchedule'),
  buildHybridCancellationPhases: jest.fn(),
  hybridScheduleReceipt: () => 'receipt',
}))
import logger from '@/config/logger'
import {
  scheduleHybridSelection,
  listHybridContracts,
  cancellationForAttempt,
  cancelHybridContract,
} from '@/services/launchCampaigns/hybridManagement.service'
const contract = {
  id: 'contract',
  venueId: 'venue',
  purchaseId: 'purchase',
  revision: 1,
  endedAt: null,
  cancelAt: null,
  paidThrough: new Date(Date.now() + 86400000),
  featureCodes: ['CFDI'],
  pendingFeatureCodes: null,
  pendingEffectiveAt: null,
  publication: {
    definition: {
      schemaVersion: 1,
      kind: 'CHOICE_BUNDLE',
      choiceCount: 1,
      eligibleFeatureCodes: ['CFDI', 'LOYALTY_PROGRAM'],
      terms: {
        currency: 'MXN',
        interval: 'MONTHLY',
        price: 379.5,
        taxIncluded: true,
        promotionCycles: null,
        renewal: { kind: 'SAME_PRICE' },
      },
    },
  },
}
beforeEach(() => {
  prismaMock.$transaction.mockImplementation(async (fn: any) => fn(prismaMock))
  prismaMock.$queryRaw.mockResolvedValue([{ taken: true }])
  prismaMock.hybridContract.findUnique.mockResolvedValue(contract)
  prismaMock.hybridContract.findMany.mockResolvedValue([])
  prismaMock.hybridContract.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.hybridPurchase.findFirst.mockResolvedValue(null)
  prismaMock.hybridBillingOperation.findFirst.mockResolvedValue(null)
  prismaMock.capabilityGrant.groupBy.mockResolvedValue([])
  prismaMock.venueFeature.findMany.mockResolvedValue([])
  tier.mockResolvedValue(null)
})
it.each([false, true])('rejects overlap with a continuing contract, including its pending next-period selection (%s)', pending => {
  prismaMock.hybridContract.findMany.mockResolvedValue([
    {
      ...contract,
      id: 'other',
      featureCodes: pending ? ['CFDI'] : ['LOYALTY_PROGRAM'],
      pendingFeatureCodes: pending ? ['LOYALTY_PROGRAM'] : null,
      pendingEffectiveAt: pending ? contract.paidThrough : null,
    },
  ])
  return expect(
    scheduleHybridSelection('venue', 'contract', 'staff', { expectedRevision: 1, featureCodes: ['LOYALTY_PROGRAM'] }),
  ).rejects.toMatchObject({ code: 'HYBRID_OFFER_COMPOSITION' })
})
it('keeps frozen renewing plan inclusions reserved at the next-period boundary', async () => {
  prismaMock.hybridContract.findMany.mockResolvedValue([{ ...contract, id: 'plan', planTier: 'PRO', featureCodes: ['LOYALTY_PROGRAM'] }])
  await expect(
    scheduleHybridSelection('venue', 'contract', 'staff', { expectedRevision: 1, featureCodes: ['LOYALTY_PROGRAM'] }),
  ).rejects.toMatchObject({ code: 'HYBRID_OFFER_COMPOSITION' })
})
it('does not withdraw a pending choice when another contract has since reserved the old selection', async () => {
  prismaMock.hybridContract.findUnique.mockResolvedValue({
    ...contract,
    pendingFeatureCodes: ['LOYALTY_PROGRAM'],
    pendingEffectiveAt: contract.paidThrough,
  })
  prismaMock.hybridContract.findMany.mockResolvedValue([{ ...contract, id: 'other' }])
  await expect(scheduleHybridSelection('venue', 'contract', 'staff', { expectedRevision: 1, featureCodes: null })).rejects.toMatchObject({
    code: 'HYBRID_OFFER_COMPOSITION',
  })
})
it('reserves another contract’s already scheduled selection even when its renewal is later', async () => {
  prismaMock.hybridContract.findMany.mockResolvedValue([
    {
      ...contract,
      id: 'other',
      pendingFeatureCodes: ['LOYALTY_PROGRAM'],
      pendingEffectiveAt: new Date(contract.paidThrough.getTime() + 1000),
    },
  ])
  await expect(
    scheduleHybridSelection('venue', 'contract', 'staff', { expectedRevision: 1, featureCodes: ['LOYALTY_PROGRAM'] }),
  ).rejects.toMatchObject({ code: 'HYBRID_OFFER_COMPOSITION' })
})
it('schedules exactly N from the frozen offer for the next paid period without changing current grants', async () => {
  const result = await scheduleHybridSelection('venue', 'contract', 'staff', { expectedRevision: 1, featureCodes: ['LOYALTY_PROGRAM'] })
  expect(result).toMatchObject({ pendingFeatureCodes: ['LOYALTY_PROGRAM'], effectiveAt: contract.paidThrough.toISOString() })
  expect(prismaMock.venueFeature.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: expect.objectContaining({ active: true, suspendedAt: null }) }),
  )
  expect(prismaMock.capabilityGrant.updateMany).not.toHaveBeenCalled()
  expect(prismaMock.hybridContract.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ venueId: 'venue', revision: 1 }),
      data: expect.objectContaining({ pendingFeatureCodes: ['LOYALTY_PROGRAM'], pendingEffectiveAt: contract.paidThrough }),
    }),
  )
})
it('rejects duplicate, missing, foreign or concurrently changed selections', async () => {
  for (const featureCodes of [[], ['CFDI', 'CFDI'], ['UNKNOWN']])
    await expect(scheduleHybridSelection('venue', 'contract', 'staff', { expectedRevision: 1, featureCodes })).rejects.toThrow()
  prismaMock.hybridContract.updateMany.mockResolvedValue({ count: 0 })
  await expect(
    scheduleHybridSelection('venue', 'contract', 'staff', { expectedRevision: 1, featureCodes: ['LOYALTY_PROGRAM'] }),
  ).rejects.toMatchObject({ code: 'HYBRID_CONTRACT_STALE' })
  prismaMock.hybridContract.findUnique.mockResolvedValue(null)
  await expect(scheduleHybridSelection('foreign', 'contract', 'staff', { expectedRevision: 1, featureCodes: ['CFDI'] })).rejects.toThrow()
})
it('lets the owner withdraw a future choice before renewal, preserving the current selection', async () => {
  prismaMock.hybridContract.findUnique.mockResolvedValue({
    ...contract,
    pendingFeatureCodes: ['LOYALTY_PROGRAM'],
    pendingEffectiveAt: contract.paidThrough,
  })
  await scheduleHybridSelection('venue', 'contract', 'staff', { expectedRevision: 1, featureCodes: null })
  expect(prismaMock.hybridContract.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ pendingEffectiveAt: null }) }),
  )
  expect(prismaMock.capabilityGrant.updateMany).not.toHaveBeenCalled()
})
it('returns bounded paginated contract totals, never per-feature invented bundle prices', async () => {
  prismaMock.hybridContract.count.mockResolvedValue(42)
  prismaMock.hybridContract.findMany.mockResolvedValue([
    { ...contract, purchase: { lastIssue: 'HYBRID_TRANSFER_REVERSED' }, publication: { ...contract.publication, name: 'Mi paquete' } },
  ])
  const result = await listHybridContracts('venue', { page: 1, pageSize: 10 })
  expect(result).toMatchObject({
    total: 42,
    page: 1,
    pageSize: 10,
    items: [expect.objectContaining({ price: 379.5, paymentIssue: 'HYBRID_TRANSFER_REVERSED' })],
  })
  expect(prismaMock.hybridContract.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: expect.objectContaining({ venueId: 'venue' }), take: 10, skip: 0 }),
  )
})
describe('cancellationForAttempt: a replay keeps the reason of the first attempt', () => {
  const fromOwner = { reason: 'TEMPORARY' as const, comment: 'Cerramos agosto' }

  it('a first attempt takes the reason it was given', () => {
    expect(cancellationForAttempt(fromOwner, [undefined, undefined])).toEqual(fromOwner)
  })

  it('the recovery (no reason) inherits the saved one', () => {
    expect(cancellationForAttempt({}, [{ from_subscription: 'sub', cancellation: fromOwner }, undefined])).toEqual(fromOwner)
  })

  it('a retry with another reason keeps the first one, so the saved request still hashes the same', () => {
    expect(cancellationForAttempt({ reason: 'OTHER' }, [{ from_subscription: 'sub', cancellation: fromOwner }])).toEqual(fromOwner)
  })

  it('an attempt saved before reasons existed stays without one', () => {
    expect(cancellationForAttempt({ reason: 'OTHER' }, [{ from_subscription: 'sub' }])).toBeUndefined()
  })

  it('nothing said, nothing kept', () => {
    expect(cancellationForAttempt({}, [])).toBeUndefined()
  })
})
describe('cancelHybridContract: the owner reason reaches Stripe only when the whole subscription ends', () => {
  const { stripe } = jest.requireMock('@/services/stripe.service')
  const { buildHybridCancellationPhases } = jest.requireMock('@/services/launchCampaigns/hybridSchedule')
  const cancel = () => cancelHybridContract('venue', 'contract', 'staff', { expectedRevision: 1, reason: 'TOO_EXPENSIVE', comment: 'Caro' })
  beforeEach(() => {
    prismaMock.hybridContract.findUnique.mockResolvedValue({
      ...contract,
      stripeSubscriptionId: 'sub',
      publication: { ...contract.publication, stripePriceId: 'price' },
      purchase: { status: 'COMPLETED', stripeCustomerId: 'cus' },
    })
    stripe.subscriptions.retrieve.mockResolvedValue({
      id: 'sub',
      customer: 'cus',
      metadata: { hybridPurchaseId: 'purchase' },
      items: { has_more: false },
      status: 'active',
    })
    stripe.subscriptionSchedules.create.mockResolvedValue({ id: 'sched', customer: 'cus', subscription: 'sub', phases: [] })
    stripe.subscriptionSchedules.update.mockImplementation(async (id: string, params: any) => ({
      id,
      customer: 'cus',
      subscription: 'sub',
      phases: [],
      metadata: params.metadata,
    }))
    stripe.subscriptions.update.mockResolvedValue({})
  })

  it('another contract keeps the subscription alive: the reason stays in the audit row and Stripe hears nothing', async () => {
    buildHybridCancellationPhases.mockReturnValue({ phases: [], end_behavior: 'release' })
    await cancel()
    expect(stripe.subscriptions.update).not.toHaveBeenCalled()
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityId: 'contract',
        action: 'HYBRID_RENEWAL_CANCELLED',
        data: expect.objectContaining({ reason: 'TOO_EXPENSIVE', comment: 'Caro' }),
      }),
    })
  })

  it('the last contract ends the subscription: Stripe gets the cancellation_details once', async () => {
    buildHybridCancellationPhases.mockReturnValue({ phases: [], end_behavior: 'cancel' })
    await cancel()
    expect(stripe.subscriptions.update).toHaveBeenCalledWith(
      'sub',
      { cancellation_details: { feedback: 'too_expensive', comment: 'Caro' } },
      expect.objectContaining({ idempotencyKey: 'hybrid-cancel-reason:contract:1' }),
    )
  })

  it('a refused Stripe update never undoes the cancellation and is logged with the contract', async () => {
    buildHybridCancellationPhases.mockReturnValue({ phases: [], end_behavior: 'cancel' })
    stripe.subscriptions.update.mockRejectedValue(new Error('stripe down'))
    await expect(cancel()).resolves.toEqual({ contractId: 'contract', revision: 2, cancelAt: contract.paidThrough.toISOString() })
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ contractId: 'contract', error: 'stripe down' }))
  })

  it.each([
    ['an unknown reason', { expectedRevision: 1, reason: 'BORED' }, 'El motivo de cancelación no es válido.'],
    ['a comment over 500 characters', { expectedRevision: 1, comment: 'x'.repeat(501) }, 'El comentario admite hasta 500 caracteres.'],
    ['a missing revision', { reason: 'OTHER' }, 'Revisa la selección y versión del contrato.'],
  ])('%s answers 400 with a message the owner can act on', (_label, input, message) =>
    expect(cancelHybridContract('venue', 'contract', 'staff', input)).rejects.toMatchObject({ statusCode: 400, message }),
  )
})
