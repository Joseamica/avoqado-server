/**
 * H1 (Codex gpt-6-astra, 2ª pasada): los candados de ORGANIZACIÓN le creían al token cuando decía
 * SUPERADMIN, y aceptaban filas (o personas) desactivadas. Un exsuperadmin con token vigente podía,
 * entre otras cosas, llegar al reset de contraseñas de cualquier organización.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { checkOrgAccess, requireOrgOwner as ownerDashboard } from '@/routes/dashboard/organizationDashboard.routes'
import { requireOrgOwner as ownerConfig, requireOrgStaff } from '@/routes/dashboard/organizationConfig.routes'

function correr(mw: any, authContext: Record<string, unknown>) {
  const res: any = { status: jest.fn(() => res), json: jest.fn(() => res) }
  const next = jest.fn()
  return Promise.resolve(mw({ authContext, params: { orgId: 'org-1' } }, res, next)).then(() => ({ res, next }))
}
const pasa = (r: { next: jest.Mock }) => r.next.mock.calls.length === 1 && r.next.mock.calls[0].length === 0

const superadminFalso = { userId: 'u', orgId: 'org-X', role: 'SUPERADMIN' }

beforeEach(() => jest.clearAllMocks())

describe.each([
  ['checkOrgAccess', checkOrgAccess],
  ['requireOrgOwner (dashboard)', ownerDashboard],
  ['requireOrgOwner (config)', ownerConfig],
  ['requireOrgStaff', requireOrgStaff],
])('%s', (_nombre, mw) => {
  it('🔴 un token que DICE superadmin sin fila activa de superadmin NO pasa', async () => {
    prismaMock.staffVenue.findFirst.mockResolvedValue(null as any)
    prismaMock.staffOrganization.findFirst.mockResolvedValue(null as any)
    expect(pasa(await correr(mw, superadminFalso))).toBe(false)
  })

  it('un superadmin real pasa (regresión)', async () => {
    prismaMock.staffVenue.findFirst.mockResolvedValueOnce({ id: 'sv-sa' } as any)
    expect(pasa(await correr(mw, superadminFalso))).toBe(true)
  })
})

it('🔴 checkOrgAccess: un token de ESTA organización cuya membresía ya no está activa NO pasa', async () => {
  prismaMock.staffOrganization.findFirst.mockResolvedValueOnce(null as any)
  expect(pasa(await correr(checkOrgAccess, { userId: 'u', orgId: 'org-1', role: 'MANAGER' }))).toBe(false)
})

it('checkOrgAccess: miembro activo de esta organización pasa (regresión)', async () => {
  prismaMock.staffOrganization.findFirst.mockResolvedValueOnce({ id: 'so' } as any)
  expect(pasa(await correr(checkOrgAccess, { userId: 'u', orgId: 'org-1', role: 'MANAGER' }))).toBe(true)
})

it('🔴 las consultas de dueño/personal exigen fila y persona ACTIVAS', async () => {
  prismaMock.staffOrganization.findFirst.mockResolvedValueOnce({ id: 'so' } as any)
  await correr(ownerDashboard, { userId: 'u', orgId: 'org-1', role: 'OWNER' })
  expect(prismaMock.staffOrganization.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({ where: expect.objectContaining({ isActive: true, staff: { active: true } }) }),
  )
  prismaMock.staffVenue.findFirst.mockResolvedValueOnce({ id: 'sv' } as any)
  await correr(ownerConfig, { userId: 'u', orgId: 'org-1', role: 'OWNER' })
  expect(prismaMock.staffVenue.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({ where: expect.objectContaining({ active: true, staff: { active: true }, role: 'OWNER' }) }),
  )
})

// Codex ronda 3, G1: H1 dejó fuera a quien antes pasaba legítimamente.
describe('checkOrgAccess · sin regresiones de H1 (Codex G1)', () => {
  const rolImpersonado = {
    userId: 'sa-real',
    orgId: 'org-1',
    role: 'MANAGER',
    isImpersonating: true,
    realUserId: 'sa-real',
    impersonation: { mode: 'role', impersonatedUserId: null, impersonatedRole: 'MANAGER' },
  }

  it('🔴 un superadmin REAL impersonando un rol en esta organización pasa', async () => {
    prismaMock.staffVenue.findFirst.mockResolvedValueOnce({ id: 'sv-sa' } as any)
    expect(pasa(await correr(checkOrgAccess, rolImpersonado))).toBe(true)
    expect(prismaMock.staffVenue.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ staffId: 'sa-real', role: 'SUPERADMIN', active: true }) }),
    )
  })

  it('🔴 la impersonación de rol de un exsuperadmin NO pasa', async () => {
    prismaMock.staffVenue.findFirst.mockResolvedValue(null as any)
    prismaMock.staffOrganization.findFirst.mockResolvedValue(null as any)
    expect(pasa(await correr(checkOrgAccess, rolImpersonado))).toBe(false)
  })

  it('la impersonación de rol NO sirve para OTRA organización', async () => {
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-sa' } as any)
    prismaMock.staffOrganization.findFirst.mockResolvedValue(null as any)
    expect(pasa(await correr(checkOrgAccess, { ...rolImpersonado, orgId: 'org-OTRA' }))).toBe(false)
  })

  it('🔴 quien trabaja ACTIVO en una sucursal de la organización pasa aunque no tenga fila de organización', async () => {
    prismaMock.staffOrganization.findFirst.mockResolvedValueOnce(null as any)
    prismaMock.staffVenue.findFirst.mockResolvedValueOnce({ id: 'sv' } as any)
    expect(pasa(await correr(checkOrgAccess, { userId: 'u', orgId: 'org-1', role: 'MANAGER' }))).toBe(true)
    expect(prismaMock.staffVenue.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ staffId: 'u', active: true, staff: { active: true }, venue: { organizationId: 'org-1' } }),
      }),
    )
  })
})

// Codex ronda 3, S3 y hermanos: más candados que le creían a `role === 'SUPERADMIN'` del token.
import { requireOrgStockRole } from '@/routes/dashboard/organizationStockControl.routes'

describe('requireOrgStockRole (exportación de inventario de la organización) · Codex S3', () => {
  it('🔴 un token que DICE superadmin sin fila activa NO pasa', async () => {
    prismaMock.staffVenue.findFirst.mockResolvedValue(null as any)
    expect(pasa(await correr(requireOrgStockRole, superadminFalso))).toBe(false)
  })

  it('un superadmin real pasa (regresión)', async () => {
    prismaMock.staffVenue.findFirst.mockResolvedValueOnce({ id: 'sv-sa' } as any)
    expect(pasa(await correr(requireOrgStockRole, superadminFalso))).toBe(true)
  })
})
