jest.mock('@/services/staffOrganization.service', () => ({
  getPrimaryOrganizationId: jest.fn(),
}))

import prisma from '@/utils/prismaClient'
import { getPrimaryOrganizationId } from '@/services/staffOrganization.service'
import { ofertaReclamadaEnTexto, parametrosDeCampanaDelStaff } from '@/services/onboarding/campanaDelCorreo.service'

const findUnique = prisma.onboardingProgress.findUnique as jest.Mock
const mockPrimaryOrg = getPrimaryOrganizationId as jest.Mock

const DIA = 24 * 60 * 60 * 1000

/** La ficha de la campaña de $10 tal como vive en la base (importes en centavos). */
function fichaDiezPesos(cambios: Record<string, unknown> = {}) {
  return {
    code: 'POS-10-REST',
    landingSlug: 'pos-10-rest',
    offerVersion: 1,
    vertical: 'FOOD_SERVICE',
    planTier: 'PRO',
    status: 'ACTIVE',
    validFrom: new Date(Date.now() - 10 * DIA),
    validUntil: new Date(Date.now() + 60 * DIA),
    redemptionCap: 100,
    redemptionCount: 0,
    advertisedPriceCents: 1000,
    discountMonths: 3,
    listPriceCentsSnapshot: 115884,
    discountAmountCents: 114884,
    headline: null,
    subheadline: null,
    bullets: [],
    ...cambios,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  findUnique.mockReset()
  mockPrimaryOrg.mockReset()
})

describe('ofertaReclamadaEnTexto — la oferta en el correo de bienvenida', () => {
  it('describe la oferta que la cuenta tiene reclamada, con precio, meses y lo que cuesta después', async () => {
    findUnique.mockResolvedValue({ launchCampaign: fichaDiezPesos() })

    const texto = await ofertaReclamadaEnTexto('org-1')

    expect(texto).toBe('Avoqado Pro a $10.00 al mes, IVA incluido, por 3 meses; después $1,158.84 al mes')
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: 'org-1' } }))
  })

  it('devuelve null si la cuenta no reclamó ninguna campaña (el correo usa el texto genérico)', async () => {
    findUnique.mockResolvedValue({ launchCampaign: null })

    expect(await ofertaReclamadaEnTexto('org-1')).toBeNull()
  })

  it('devuelve null si la ficha ya no está disponible: nunca promete un precio que no se va a cobrar', async () => {
    findUnique.mockResolvedValue({ launchCampaign: fichaDiezPesos({ status: 'PAUSED' }) })

    expect(await ofertaReclamadaEnTexto('org-1')).toBeNull()
  })

  it('usa «1 mes» en singular', async () => {
    findUnique.mockResolvedValue({ launchCampaign: fichaDiezPesos({ discountMonths: 1 }) })

    expect(await ofertaReclamadaEnTexto('org-1')).toContain('por 1 mes;')
  })
})

describe('parametrosDeCampanaDelStaff — la campaña y las UTM en el enlace del correo', () => {
  it('lleva el slug de la oferta y las UTM con las que llegó la persona', async () => {
    mockPrimaryOrg.mockResolvedValue('org-1')
    findUnique.mockResolvedValue({
      acquisitionUtm: { utm_source: 'meta', utm_campaign: 'pos10_rest_v1', utm_content: '123' },
      launchCampaign: { landingSlug: 'pos-10-rest' },
    })

    const q = new URLSearchParams(await parametrosDeCampanaDelStaff('staff-1'))

    expect(mockPrimaryOrg).toHaveBeenCalledWith('staff-1')
    expect(q.get('oferta')).toBe('pos-10-rest')
    expect(q.get('utm_source')).toBe('meta')
    expect(q.get('utm_campaign')).toBe('pos10_rest_v1')
    expect(q.get('utm_content')).toBe('123')
  })

  it('descarta llaves fuera de la lista permitida y valores vacíos', async () => {
    mockPrimaryOrg.mockResolvedValue('org-1')
    findUnique.mockResolvedValue({
      acquisitionUtm: { utm_source: 'meta', utm_medium: '   ', evil: '<script>' },
      launchCampaign: null,
    })

    const q = new URLSearchParams(await parametrosDeCampanaDelStaff('staff-1'))

    expect(q.get('utm_source')).toBe('meta')
    expect(q.has('utm_medium')).toBe(false)
    expect(q.has('evil')).toBe(false)
    expect(q.has('oferta')).toBe(false)
  })

  it('devuelve vacío si la cuenta no trae campaña ni UTM', async () => {
    mockPrimaryOrg.mockResolvedValue('org-1')
    findUnique.mockResolvedValue({ acquisitionUtm: null, launchCampaign: null })

    expect(await parametrosDeCampanaDelStaff('staff-1')).toBe('')
  })

  it('devuelve vacío si no hay progreso de alta', async () => {
    mockPrimaryOrg.mockResolvedValue('org-1')
    findUnique.mockResolvedValue(null)

    expect(await parametrosDeCampanaDelStaff('staff-1')).toBe('')
  })
})
