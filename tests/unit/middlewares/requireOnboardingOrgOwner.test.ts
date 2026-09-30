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

  it('SUPERADMIN real (fila activa en la base) pasa sin consultar la organización', async () => {
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'fila-sa' } as never)
    const { req, res, next } = ctx({ userId: 'sa', role: 'SUPERADMIN' }, { organizationId: 'org-1' })
    await requireOnboardingOrgOwner(req, res, next)
    expect(next).toHaveBeenCalledWith()
    expect(prismaMock.staffOrganization.findFirst).not.toHaveBeenCalled()
  })

  it('🔴 un token que DICE SUPERADMIN sin fila activa en la base NO pasa (Codex H6)', async () => {
    prismaMock.staffVenue.findFirst.mockResolvedValue(null as never)
    prismaMock.staffOrganization.findFirst.mockResolvedValue(null as never)
    const { req, res, next } = ctx({ userId: 'ex-sa', role: 'SUPERADMIN' }, { organizationId: 'org-1' })
    await requireOnboardingOrgOwner(req, res, next)
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }))
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

// ─── Auditoría (hallazgo del /full-testing del 25-sep): un 403 del alta no dejaba rastro ─────────
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn(async () => undefined) }))
import { logAction } from '@/services/dashboard/activity-log.service'

describe('auditoría de los rechazos del alta', () => {
  function ctxHttp(authContext: unknown, params: Record<string, string>) {
    const req = {
      authContext,
      params,
      method: 'PUT',
      originalUrl: '/api/v1/onboarding/organizations/org-ajena/step/1',
      ip: '1.2.3.4',
      get: () => 'ua',
    } as never
    return { req, res: {} as never, next: jest.fn() }
  }

  const alTerminarLaBitacora = () => new Promise(r => setImmediate(r))

  it('🔴 el 403 de un OWNER ajeno queda en ActivityLog como PERMISSION_DENIED', async () => {
    prismaMock.staffOrganization.findFirst.mockResolvedValue(null as never)
    prismaMock.organization.findUnique.mockResolvedValue({ id: 'org-ajena' } as never)
    const { req, res, next } = ctxHttp({ userId: 'staff-otro', role: 'OWNER' }, { organizationId: 'org-ajena' })

    await requireOnboardingOrgOwner(req, res, next)
    await alTerminarLaBitacora()

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }))
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: 'staff-otro',
        // Codex ronda 7, P2: en la COLUMNA, o la bitácora del negocio atacado no lo muestra.
        organizationId: 'org-ajena',
        action: 'PERMISSION_DENIED',
        entity: 'onboarding',
        data: expect.objectContaining({ reason: 'ORG_OWNER_REQUIRED', organizationId: 'org-ajena', method: 'PUT' }),
      }),
    )
  })

  it('🔴 el 403 por venue ajeno también', async () => {
    prismaMock.venue.findUnique.mockResolvedValue({ organizationId: 'org-ajena' } as never)
    prismaMock.staffOrganization.findFirst.mockResolvedValue(null as never)
    const { req, res, next } = ctxHttp({ userId: 'staff-otro', role: 'OWNER' }, { venueId: 'v-ajeno' })

    await requireOnboardingVenueOwner(req, res, next)
    await alTerminarLaBitacora()

    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'PERMISSION_DENIED',
        venueId: 'v-ajeno',
        organizationId: 'org-ajena',
        data: expect.objectContaining({ venueId: 'v-ajeno' }),
      }),
    )
  })

  it('🔴 un id inventado NO va a las columnas (rompería la llave foránea): sólo al detalle', async () => {
    prismaMock.staffOrganization.findFirst.mockResolvedValue(null as never)
    prismaMock.organization.findUnique.mockResolvedValue(null as never)
    const { req, res, next } = ctxHttp({ userId: 'staff-otro', role: 'OWNER' }, { organizationId: 'org-inventada' })

    await requireOnboardingOrgOwner(req, res, next)
    await alTerminarLaBitacora()

    const asiento = (logAction as jest.Mock).mock.calls.at(-1)[0]
    expect(asiento.organizationId ?? null).toBeNull()
    expect(asiento.data).toMatchObject({ organizationId: 'org-inventada' })
  })

  it('sin sesión (401) o con acceso, no se escribe nada', async () => {
    ;(logAction as jest.Mock).mockClear()
    const anon = ctxHttp(undefined, { organizationId: 'org-1' })
    await requireOnboardingOrgOwner(anon.req, anon.res, anon.next)
    prismaMock.staffOrganization.findFirst.mockResolvedValue({ id: 'so-1' } as never)
    const ok = ctxHttp({ userId: 'staff-1', role: 'OWNER' }, { organizationId: 'org-1' })
    await requireOnboardingOrgOwner(ok.req, ok.res, ok.next)
    expect(logAction).not.toHaveBeenCalled()
  })
})
