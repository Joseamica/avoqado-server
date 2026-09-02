import { env } from '@/config/env'
import { prismaCommercialPublicationDependencies } from '@/services/commercial/commercialPublication.service'

describe('commercial publication production dependencies', () => {
  it('uses the startup-validated signing secret with no empty fallback', () => {
    expect(env.COMMERCIAL_PREVIEW_SIGNING_SECRET).toHaveLength(48)
    expect(prismaCommercialPublicationDependencies.signingSecret).toBe(env.COMMERCIAL_PREVIEW_SIGNING_SECRET)
  })
})
