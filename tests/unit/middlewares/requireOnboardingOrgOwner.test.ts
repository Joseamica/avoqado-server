/**
 * S7 — la guarda de pertenencia del alta (spec 2026-09-17 § 7.7).
 *
 * 🔴 Lo que impide: leer (o escribir) el alta de OTRA organización. La lectura del progreso
 * devuelve `v2SetupData`, que trae la CLABE del negocio.
 */
import { requireOnboardingOrgOwner, requireOnboardingVenueOwner } from '@/middlewares/requireOnboardingOrgOwner.middleware'
import { prismaMock } from '@tests/__helpers__/setup'

function ctx(authContext: unknown, params: Record<string, string>) {
  const req = { authContext, params } as never
  const next = jest.fn()
  return { req, res: {} as never, next }
}

beforeEach(() => jest.clearAllMocks())

describe('requireOnboardingOrgOwner', () => {
  it('sin token → 401, y NUNCA consulta la base', async () => {
    const { req, res, next } = ctx(undefined, { organizationId: 'org-1' })
    await requireOnboardingOrgOwner(req, res, next)
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }))
    expect(prismaMock.staffOrganization.findFirst).not.toHaveBeenCalled()
  })

  it('🔴 OWNER de OTRA organización → 403 ORG_OWNER_REQUIRED', async () => {
    prismaMock.staffOrganization.findFirst.mockResolvedValue(null as never)
    const { req, res, next } = ctx({ userId: 'staff-otro', role: 'OWNER' }, { organizationId: 'org-ajena' })

    await requireOnboardingOrgOwner(req, res, next)

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403, code: 'ORG_OWNER_REQUIRED' }))
    // La consulta exige las cuatro condiciones: quién, cuál organización, activo y OWNER.
    expect(prismaMock.staffOrganization.findFirst).toHaveBeenCalledWith({
      where: { staffId: 'staff-otro', organizationId: 'org-ajena', isActive: true, role: 'OWNER' },
      select: { id: true },
    })
  })

  it('OWNER activo de ESA organización pasa', async () => {
    prismaMock.staffOrganization.findFirst.mockResolvedValue({ id: 'so-1' } as never)
    const { req, res, next } = ctx({ userId: 'staff-1', role: 'OWNER' }, { organizationId: 'org-1' })
    await requireOnboardingOrgOwner(req, res, next)
    expect(next).toHaveBeenCalledWith()
  })

  it('SUPERADMIN pasa sin consultar', async () => {
    const { req, res, next } = ctx({ userId: 'sa', role: 'SUPERADMIN' }, { organizationId: 'org-1' })
    await requireOnboardingOrgOwner(req, res, next)
    expect(next).toHaveBeenCalledWith()
    expect(prismaMock.staffOrganization.findFirst).not.toHaveBeenCalled()
  })

  it('🔴 un miembro NO-OWNER de la misma organización también recibe 403', async () => {
    // La consulta filtra por `role: 'OWNER'`, así que la membresía de un empleado no basta.
    prismaMock.staffOrganization.findFirst.mockResolvedValue(null as never)
    const { req, res, next } = ctx({ userId: 'cajero', role: 'CASHIER' }, { organizationId: 'org-1' })
    await requireOnboardingOrgOwner(req, res, next)
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }))
  })
})

describe('requireOnboardingVenueOwner', () => {
  it('resuelve la organización del local y deja pasar a su OWNER', async () => {
    prismaMock.venue.findUnique.mockResolvedValue({ organizationId: 'org-1' } as never)
    prismaMock.staffOrganization.findFirst.mockResolvedValue({ id: 'so-1' } as never)
    const { req, res, next } = ctx({ userId: 'staff-1', role: 'OWNER' }, { venueId: 'venue-1' })

    await requireOnboardingVenueOwner(req, res, next)
    expect(next).toHaveBeenCalledWith()
  })

  it('🔴 un local que no existe responde 403, no 404: un 404 confirmaría qué ids son reales', async () => {
    prismaMock.venue.findUnique.mockResolvedValue(null as never)
    const { req, res, next } = ctx({ userId: 'staff-1', role: 'OWNER' }, { venueId: 'no-existe' })

    await requireOnboardingVenueOwner(req, res, next)
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403, code: 'ORG_OWNER_REQUIRED' }))
  })

  it('el local de OTRA organización → 403', async () => {
    prismaMock.venue.findUnique.mockResolvedValue({ organizationId: 'org-ajena' } as never)
    prismaMock.staffOrganization.findFirst.mockResolvedValue(null as never)
    const { req, res, next } = ctx({ userId: 'staff-1', role: 'OWNER' }, { venueId: 'venue-ajeno' })

    await requireOnboardingVenueOwner(req, res, next)
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }))
  })
})
