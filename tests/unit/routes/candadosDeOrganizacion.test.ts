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
