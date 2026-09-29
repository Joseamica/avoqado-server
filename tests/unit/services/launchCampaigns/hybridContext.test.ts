import { prismaMock } from '../../../__helpers__/setup'
jest.mock('@/services/access/inventarioDeObligaciones', () => ({ inventarioDeObligaciones: jest.fn() }))
import {
  getCurrentHybridPurchase,
  assertHybridOnboardingPurchase,
  getHybridReplacementOptions,
} from '@/services/launchCampaigns/hybridPurchase.service'
import { inventarioDeObligaciones } from '@/services/access/inventarioDeObligaciones'
beforeEach(() => {
  prismaMock.venueFeature.findMany.mockResolvedValue([])
  prismaMock.capabilityGrant.groupBy.mockResolvedValue([])
})
describe('hybrid browser recovery and onboarding boundary', () => {
  it('does not bypass another unresolved purchase by supplying a previously completed one', async () => {
    prismaMock.hybridPurchase.findFirst.mockResolvedValueOnce({ id: 'pending' })
    await expect(assertHybridOnboardingPurchase('org', 'previously-completed')).rejects.toThrow()
  })
  it('keeps manual and complimentary access outside bundle slots', async () => {
    jest.mocked(inventarioDeObligaciones).mockResolvedValue({ vivas: [], detalle: {}, conCambiosProgramados: [] })
    prismaMock.venueFeature.findMany.mockResolvedValue([{ feature: { code: 'CFDI' } }] as any)
    prismaMock.capabilityGrant.groupBy.mockResolvedValue([{ featureCode: 'LOYALTY_PROGRAM' }] as any)
    const result = await getHybridReplacementOptions('venue')
    expect(result.standaloneFeatureCodes).toEqual(expect.arrayContaining(['CHATBOT', 'CFDI', 'LOYALTY_PROGRAM']))
  })
  it('blocks finishing as Free while a hybrid payment is unresolved', async () => {
    prismaMock.hybridPurchase.findFirst.mockResolvedValue({ id: 'pending' })
    await expect(assertHybridOnboardingPurchase('org')).rejects.toThrow()
    expect(prismaMock.hybridPurchase.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { venue: { organizationId: 'org' }, status: { notIn: ['QUOTED', 'COMPLETED', 'CANCELLED', 'EXPIRED'] } },
      }),
    )
  })
  it('recovers only an accepted unresolved purchase for this venue', async () => {
    prismaMock.hybridPurchase.findFirst.mockResolvedValue(null)
    expect(await getCurrentHybridPurchase('venue')).toBeNull()
    expect(prismaMock.hybridPurchase.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId: 'venue', status: { notIn: ['QUOTED', 'COMPLETED', 'CANCELLED', 'EXPIRED'] } } }),
    )
  })
  it('rejects a foreign or unfunded purchase before completing onboarding', async () => {
    prismaMock.hybridPurchase.findFirst.mockResolvedValue(null)
    await expect(assertHybridOnboardingPurchase('org', 'purchase')).rejects.toThrow()
    expect(prismaMock.hybridPurchase.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'purchase', status: 'COMPLETED', venue: { organizationId: 'org' } } }),
    )
    prismaMock.hybridPurchase.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'purchase' })
    await expect(assertHybridOnboardingPurchase('org', 'purchase')).resolves.toBeUndefined()
  })
  it('does not publish customer/provider internals in replacement choices', async () => {
    jest.mocked(inventarioDeObligaciones).mockResolvedValue({
      vivas: [{ subscriptionId: 'sub_a', proyecciones: [{ tipo: 'FUNCION', featureCode: 'CFDI' }] }],
      detalle: { sub_a: { customerId: 'secret' } },
      conCambiosProgramados: [],
    } as any)
    const result = await getHybridReplacementOptions('venue')
    expect(result.items).toEqual([{ subscriptionId: 'sub_a', featureCodes: ['CFDI'], replaceable: true }])
    expect(JSON.stringify(result)).not.toContain('secret')
  })
})
