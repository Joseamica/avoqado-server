import { prismaMock } from '../../../__helpers__/setup'
import * as stripeService from '@/services/stripe.service'
import { BadRequestError } from '@/errors/AppError'
import { removeFeatureFromVenue } from '@/services/dashboard/venueFeature.dashboard.service'

jest.mock('@/services/stripe.service')
const mockStripe = stripeService as jest.Mocked<typeof stripeService>

describe('removeFeatureFromVenue — PLAN_PRO guard', () => {
  it('rejects deleting the PLAN_PRO base plan with a BadRequestError pointing to /plan/cancel', async () => {
    prismaMock.venueFeature.findFirst.mockResolvedValue({
      id: 'vf_pro',
      venueId: 'venue_1',
      featureId: 'feat_pro',
      active: true,
      stripeSubscriptionId: 'sub_123',
      feature: { code: 'PLAN_PRO', name: 'Plan Avoqado Pro' },
    })

    await expect(removeFeatureFromVenue('venue_1', 'feat_pro')).rejects.toThrow(BadRequestError)
    await expect(removeFeatureFromVenue('venue_1', 'feat_pro')).rejects.toThrow('flujo de plan')
    // The dangerous immediate-cancel must NOT run, and the row must NOT be deactivated.
    expect(mockStripe.cancelSubscription).not.toHaveBeenCalled()
    expect(prismaMock.venueFeature.update).not.toHaveBeenCalled()
  })

  // REGRESSION: à-la-carte features still cancel normally.
  it('still cancels and deactivates an à-la-carte feature (CHATBOT)', async () => {
    prismaMock.venueFeature.findFirst.mockResolvedValue({
      id: 'vf_chat',
      venueId: 'venue_1',
      featureId: 'feat_chat',
      active: true,
      stripeSubscriptionId: 'sub_chat',
      feature: { code: 'CHATBOT', name: 'Chatbot' },
    })
    prismaMock.venueFeature.update.mockResolvedValue({ id: 'vf_chat', active: false })
    mockStripe.cancelSubscription.mockResolvedValue(undefined as any)

    await removeFeatureFromVenue('venue_1', 'feat_chat')

    expect(mockStripe.cancelSubscription).toHaveBeenCalledWith('sub_chat')
    expect(prismaMock.venueFeature.update).toHaveBeenCalledWith({
      where: { id: 'vf_chat' },
      data: { active: false },
    })
  })
})
