/**
 * El alta de un negocio nuevo — la función que comparten el alta por correo y el alta con Google.
 *
 * 🔴 Lo que se fija aquí es lo que cuesta dinero si se pierde: la campaña del anuncio (sin ella el
 * cliente paga precio de lista), los UTM (sin ellos el clic pagado no se atribuye) y el
 * consentimiento legal con su versión.
 */
jest.mock('@/services/launchCampaigns/launchCampaign.service', () => ({ findClaimableByCodeOrSlug: jest.fn() }))

import { OrgRole } from '@prisma/client'
import { crearNegocioNuevo, resolverAtribucionDelAlta } from '@/services/onboarding/nuevoNegocio'
import { findClaimableByCodeOrSlug } from '@/services/launchCampaigns/launchCampaign.service'
import { LEGAL_VERSIONS } from '@/config/legal'

const LEGAL_DOCS_VERSION = LEGAL_VERSIONS.current

const buscar = findClaimableByCodeOrSlug as jest.Mock

function txFalso() {
  return {
    organization: { create: jest.fn().mockResolvedValue({ id: 'org-1', name: 'Nuevo Negocio' }) },
    staff: { create: jest.fn().mockResolvedValue({ id: 'staff-1', email: 'dueno@test.mx' }) },
    staffOrganization: { create: jest.fn().mockResolvedValue({}) },
    onboardingProgress: { create: jest.fn().mockResolvedValue({}) },
  }
}

beforeEach(() => jest.clearAllMocks())

describe('resolverAtribucionDelAlta', () => {
  it('resuelve la campaña por código o slug y conserva los UTM', async () => {
    buscar.mockResolvedValue({ id: 'lc-1', code: 'POS22MX' })
    const r = await resolverAtribucionDelAlta({
      launchCampaignCode: 'pos-22-mx',
      utm: { utm_source: 'google' },
      legalVersion: LEGAL_DOCS_VERSION,
    })
    expect(buscar).toHaveBeenCalledWith('pos-22-mx')
    expect(r).toEqual({ campanaId: 'lc-1', utm: { utm_source: 'google' }, legalVersion: LEGAL_DOCS_VERSION })
  })

  it('🔴 si resolver la campaña FALLA, el alta sigue sin campaña (nunca al revés)', async () => {
    buscar.mockRejectedValue(new Error('sin red'))
    await expect(resolverAtribucionDelAlta({ launchCampaignCode: 'POS22MX' })).resolves.toMatchObject({ campanaId: null })
  })

  it('🔴 una versión legal DESCONOCIDA se ignora: nunca se guarda un consentimiento contra un texto que nadie identifica', async () => {
    const r = await resolverAtribucionDelAlta({ legalVersion: 'v-inventada' })
    expect(r.legalVersion).toBeUndefined()
  })

  it('UTM vacíos no se guardan como {}', async () => {
    expect((await resolverAtribucionDelAlta({ utm: {} })).utm).toBeUndefined()
  })
})

describe('crearNegocioNuevo', () => {
  const base = {
    email: 'Dueno@Test.mx',
    hashedPassword: null,
    firstName: 'Ana',
    lastName: 'Pérez',
    organizationName: '',
    emailVerified: true,
    googleId: 'g-1',
    photoUrl: 'https://foto',
    wizardVersion: 2,
    acquisitionSource: 'dashboard_signup_google',
    atribucion: { campanaId: 'lc-1', utm: { utm_source: 'google' }, legalVersion: LEGAL_DOCS_VERSION },
    ipAddress: '1.2.3.4',
  }

  it('🔴 crea organización + DUEÑO (OWNER de la organización) + progreso con campaña, UTM y consentimiento', async () => {
    const tx = txFalso()
    await crearNegocioNuevo(tx as never, base)

    // el correo de la organización ES el del dueño: así el login lo reconoce como dueño del alta
    expect(tx.organization.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ email: 'dueno@test.mx', name: 'Nuevo Negocio' }),
    })
    expect(tx.staff.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ email: 'dueno@test.mx', emailVerified: true, googleId: 'g-1', photoUrl: 'https://foto' }),
    })
    expect(tx.staff.create.mock.calls[0][0].data).not.toHaveProperty('password')
    expect(tx.staffOrganization.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ staffId: 'staff-1', organizationId: 'org-1', role: OrgRole.OWNER, isPrimary: true }),
    })
    expect(tx.onboardingProgress.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org-1',
        wizardVersion: 2,
        acquisitionSource: 'dashboard_signup_google',
        acquisitionUtm: { utm_source: 'google' },
        launchCampaignId: 'lc-1',
        launchCampaignClaimedAt: expect.any(Date),
        termsVersion: LEGAL_DOCS_VERSION,
        termsAcceptedAt: expect.any(Date),
        privacyAcceptedAt: expect.any(Date),
        termsIpAddress: '1.2.3.4',
      }),
    })
  })

  it('sin campaña ni consentimiento, el progreso nace sin esas llaves (el asistente pide la casilla)', async () => {
    const tx = txFalso()
    await crearNegocioNuevo(tx as never, { ...base, atribucion: { campanaId: null, utm: undefined, legalVersion: undefined } })
    const data = tx.onboardingProgress.create.mock.calls[0][0].data
    for (const k of ['launchCampaignId', 'acquisitionUtm', 'termsVersion', 'termsAcceptedAt']) expect(data).not.toHaveProperty(k)
  })

  it('el alta por correo guarda el hash de la contraseña', async () => {
    const tx = txFalso()
    await crearNegocioNuevo(tx as never, { ...base, hashedPassword: '$2a$12$hash', googleId: null, photoUrl: null, emailVerified: false })
    expect(tx.staff.create.mock.calls[0][0].data).toMatchObject({ password: '$2a$12$hash', emailVerified: false })
  })
})
