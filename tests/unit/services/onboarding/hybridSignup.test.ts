import { prismaMock } from '../../../__helpers__/setup'
import { crearNegocioNuevo, resolverAtribucionDelAlta } from '@/services/onboarding/nuevoNegocio'
jest.mock('@/services/launchCampaigns/launchCampaign.service', () => ({ findClaimableByCodeOrSlug: jest.fn() }))
it('persists a recommendation with the new organization for email and Google without reserving a price or place', async () => {
  const attribution = await resolverAtribucionDelAlta({ hybridOfferSlug: 'septiembre-flex' })
  prismaMock.organization.create.mockResolvedValue({ id: 'org' } as any)
  prismaMock.staff.create.mockResolvedValue({ id: 'staff' } as any)
  await crearNegocioNuevo(prismaMock as any, {
    email: 'a@b.test',
    hashedPassword: null,
    firstName: '',
    lastName: '',
    organizationName: '',
    emailVerified: true,
    wizardVersion: 2,
    acquisitionSource: 'dashboard_signup_google',
    atribucion: attribution,
  })
  expect(prismaMock.onboardingProgress.create).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ v2SetupData: { hybrid: { hybridOfferSlug: 'septiembre-flex' } } }) }),
  )
  expect(prismaMock.hybridRedemption.create).not.toHaveBeenCalled()
  expect((await resolverAtribucionDelAlta({ hybridOfferSlug: 'https://evil.test' })).hybridOfferSlug).toBeUndefined()
})
