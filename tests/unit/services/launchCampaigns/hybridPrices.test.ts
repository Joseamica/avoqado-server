import { prismaMock } from '../../../__helpers__/setup'
const list = jest.fn()
const create = jest.fn()
jest.mock('@/services/stripe.service', () => ({
  stripe: { prices: { list: (...args: unknown[]) => list(...args), create: (...args: unknown[]) => create(...args) } },
  STRIPE_DENTRO_DEL_CANDADO: { timeout: 15000, maxNetworkRetries: 0 },
}))
import { ensureHybridPublicationPrices } from '@/services/launchCampaigns/hybridPrices'
const pub = {
  id: 'pub_1',
  name: 'Paquete test',
  definitionHash: 'hash_1',
  definition: {
    schemaVersion: 1,
    kind: 'FEATURES',
    featureCodes: ['CFDI'],
    terms: {
      currency: 'MXN',
      interval: 'MONTHLY',
      price: 379.5,
      taxIncluded: true,
      promotionCycles: 4,
      renewal: { kind: 'REPRICE', price: 529 },
    },
  },
}
const price = (id: string, amount: number) => ({
  id,
  product: 'prod_hybrid',
  active: true,
  currency: 'mxn',
  unit_amount: amount,
  tax_behavior: 'inclusive',
  recurring: { interval: 'month', interval_count: 1 },
  metadata: { publicationId: pub.id, definitionHash: pub.definitionHash },
})
beforeEach(() => {
  list.mockReset().mockResolvedValue({ data: [], has_more: false })
  create.mockReset().mockImplementation(async (params: any) => price(params.lookup_key, params.unit_amount))
  prismaMock.hybridOfferPublication.findUniqueOrThrow.mockResolvedValue(pub as never)
  prismaMock.hybridOfferPublication.update.mockImplementation(async ({ data }: any) => ({ ...pub, ...data }) as never)
})
describe('immutable publication prices at the Stripe boundary', () => {
  it('converts pesos only at Stripe and provisions two prices on the same product', async () => {
    await ensureHybridPublicationPrices(pub.id)
    expect(create.mock.calls[0][0]).toMatchObject({ unit_amount: 37950, tax_behavior: 'inclusive', recurring: { interval: 'month' } })
    expect(create.mock.calls[1][0]).toMatchObject({ unit_amount: 52900, product: 'prod_hybrid' })
    expect(prismaMock.hybridOfferPublication.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ stripeProductId: 'prod_hybrid' }) }),
    )
  })
  it('recovers a response loss through the unique lookup key without making another price', async () => {
    list
      .mockResolvedValueOnce({ data: [price('price_initial', 37950)], has_more: false })
      .mockResolvedValueOnce({ data: [price('price_renewal', 52900)], has_more: false })
    await ensureHybridPublicationPrices(pub.id)
    expect(create).not.toHaveBeenCalled()
  })
  it('rejects provider price drift instead of silently changing the advertised total', async () => {
    list.mockResolvedValueOnce({ data: [price('price_wrong', 37951)], has_more: false })
    await expect(ensureHybridPublicationPrices(pub.id)).rejects.toThrow(/precio/i)
    expect(prismaMock.hybridOfferPublication.update).not.toHaveBeenCalled()
  })
})
