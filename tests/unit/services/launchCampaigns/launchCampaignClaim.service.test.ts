/**
 * S6 — el reclamo de campaña (spec 2026-09-17 § 3.5).
 *
 * 🔴 Las dos reglas que estas pruebas guardan:
 *   1. reclamar NUNCA tumba el alta (código malo, ficha pausada, base caída → el alta sigue);
 *   2. el «último toque» sólo aplica MIENTRAS NO HAY COBRO.
 */
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))

import { claimLaunchCampaign } from '@/services/launchCampaigns/launchCampaignClaim.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { prismaMock } from '@tests/__helpers__/setup'

function fichaActiva() {
  return {
    id: 'lc-1',
    code: 'POS22',
    landingSlug: 'pos-22',
    status: 'ACTIVE',
    validFrom: new Date('2020-01-01T00:00:00Z'),
    validUntil: new Date('2099-01-01T00:00:00Z'),
    redemptionCap: 100,
    redemptionCount: 0,
    offerVersion: 1,
    vertical: 'ALL',
    planTier: 'PRO',
    advertisedPriceCents: 2200,
    discountMonths: 3,
    listPriceCentsSnapshot: 115884,
    discountAmountCents: 113684,
    headline: null,
    subheadline: null,
    bullets: [],
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.onboardingProgress.updateMany.mockResolvedValue({ count: 1 } as never)
})

describe('claimLaunchCampaign', () => {
  it('guarda la campaña, la fuente y los UTMs, y escribe la bitácora con la organización', async () => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(fichaActiva() as never)

    const r = await claimLaunchCampaign('org-1', 'pos22', 'landing_oferta', { utm_source: 'google' }, 'staff-1')

    expect(r).toEqual({ claimed: true, campaignId: 'lc-1', code: 'POS22' })
    expect(prismaMock.onboardingProgress.updateMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-1',
        completedAt: null,
        // 🔴 Las DOS condiciones que hacen seguro el «último toque».
        planActivationStatus: { in: ['NONE', 'DECLINED'] },
      },
      data: expect.objectContaining({
        launchCampaignId: 'lc-1',
        acquisitionSource: 'landing_oferta',
        acquisitionUtm: { utm_source: 'google' },
      }),
    })
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'LAUNCH_CAMPAIGN_CLAIMED', organizationId: 'org-1' }))
  })

  it('🔴 sin UTMs NO escribe la columna: un `{}` borraría los que ya había', async () => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(fichaActiva() as never)
    await claimLaunchCampaign('org-1', 'POS22', 'dashboard_attach', {})
    const data = prismaMock.onboardingProgress.updateMany.mock.calls[0][0].data
    expect(data).not.toHaveProperty('acquisitionUtm')
  })

  it('un código vacío no consulta nada', async () => {
    await expect(claimLaunchCampaign('org-1', undefined, 'dashboard_signup')).resolves.toEqual({
      claimed: false,
      campaignId: null,
      code: null,
    })
    expect(prismaMock.launchCampaign.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.onboardingProgress.updateMany).not.toHaveBeenCalled()
  })

  it('🔴 una ficha que no se puede reclamar deja el alta intacta, sin lanzar', async () => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue({ ...fichaActiva(), status: 'PAUSED' } as never)
    await expect(claimLaunchCampaign('org-1', 'POS22', 'landing_oferta')).resolves.toMatchObject({ claimed: false })
    expect(prismaMock.onboardingProgress.updateMany).not.toHaveBeenCalled()
  })

  it('🔴 si la base truena, el alta SIGUE: perder atribución < perder el cliente', async () => {
    prismaMock.launchCampaign.findUnique.mockRejectedValue(new Error('base caída'))
    await expect(claimLaunchCampaign('org-1', 'POS22', 'landing_oferta')).resolves.toEqual({
      claimed: false,
      campaignId: null,
      code: null,
    })
  })

  it('🔴 un alta ya terminada (o con cobro en curso) no se re-reclama, y se dice', async () => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(fichaActiva() as never)
    prismaMock.onboardingProgress.updateMany.mockResolvedValue({ count: 0 } as never)

    await expect(claimLaunchCampaign('org-1', 'POS22', 'dashboard_attach')).resolves.toMatchObject({ claimed: false })
    expect(logAction).not.toHaveBeenCalled()
  })
})
