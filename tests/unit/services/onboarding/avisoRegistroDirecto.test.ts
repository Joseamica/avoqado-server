/**
 * Aviso del registro directo (27-oct): correo interno + HubSpot, nunca para cuentas de la landing y nunca lanza.
 */
import prisma from '../../../../src/utils/prismaClient'
import * as resendService from '../../../../src/services/resend.service'
import { sendLeadToHubspot } from '../../../../src/services/integrations/hubspot.client'
import { avisarRegistroDirecto } from '../../../../src/services/onboarding/avisoRegistroDirecto'

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: { staff: { findUnique: jest.fn() }, onboardingProgress: { findUnique: jest.fn() } },
}))
jest.mock('../../../../src/services/resend.service', () => ({ sendDirectSignupNotice: jest.fn().mockResolvedValue(true) }))
jest.mock('../../../../src/services/integrations/hubspot.client', () => ({ sendLeadToHubspot: jest.fn().mockResolvedValue(true) }))
jest.mock('../../../../src/services/staffOrganization.service', () => ({ getPrimaryOrganizationId: jest.fn().mockResolvedValue('org-1') }))
jest.mock('../../../../src/config/logger', () => ({ __esModule: true, default: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }))

beforeEach(() => {
  jest.clearAllMocks()
  ;(prisma.staff.findUnique as jest.Mock).mockResolvedValue({ email: 'rigo@example.com', firstName: '', lastName: '' })
})

describe('avisarRegistroDirecto', () => {
  it('registro directo: avisa al equipo con su origen y lo manda a HubSpot', async () => {
    ;(prisma.onboardingProgress.findUnique as jest.Mock).mockResolvedValue({
      acquisitionSource: 'dashboard_signup',
      acquisitionUtm: { utm_source: 'google', utm_medium: 'cpc' },
      launchCampaign: null,
    })

    await avisarRegistroDirecto('staff-1', 'correo')

    expect(resendService.sendDirectSignupNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'rigo@example.com',
        metodo: 'correo',
        origen: 'dashboard_signup',
        campanaUtm: 'utm_source=google · utm_medium=cpc',
      }),
    )
    expect(sendLeadToHubspot).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'rigo@example.com', pageName: 'Registro directo (dashboard)' }),
    )
  })

  it('una cuenta de la landing ya avisó al crearse: aquí no se vuelve a anunciar', async () => {
    ;(prisma.onboardingProgress.findUnique as jest.Mock).mockResolvedValue({
      acquisitionSource: 'landing_oferta',
      acquisitionUtm: null,
      launchCampaign: null,
    })

    await avisarRegistroDirecto('staff-1', 'correo')

    expect(resendService.sendDirectSignupNotice).not.toHaveBeenCalled()
    expect(sendLeadToHubspot).not.toHaveBeenCalled()
  })

  it('si el correo o HubSpot fallan, no lanza (el registro ya quedó hecho)', async () => {
    ;(prisma.onboardingProgress.findUnique as jest.Mock).mockResolvedValue({
      acquisitionSource: 'dashboard_signup_google',
      acquisitionUtm: null,
      launchCampaign: null,
    })
    ;(resendService.sendDirectSignupNotice as jest.Mock).mockRejectedValueOnce(new Error('resend caído'))

    await expect(avisarRegistroDirecto('staff-1', 'google')).resolves.toBeUndefined()
  })
})
