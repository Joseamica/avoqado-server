/**
 * Role Permission Service — privilege-escalation guard (SECURITY)
 *
 * Regression for the permission-editor escalation: updateRolePermissions validated
 * hierarchy (canModifyRole) and self-lockout, but did NOT verify that the granted
 * permissions were a subset of the MODIFIER's own. An ADMIN (who can modify the
 * ADMIN role) could therefore add `system:manage` / `*:*` to the ADMIN role and
 * reach the /dashboard/superadmin/* namespace (gated by system:manage).
 *
 * The guard: a modifier can only grant permissions they themselves already hold.
 */
import { updateRolePermissions } from '@/services/dashboard/rolePermission.service'
import { prismaMock } from '@tests/__helpers__/setup'
import { StaffRole } from '@prisma/client'
import { DEFAULT_PERMISSIONS } from '@/lib/permissions'

const VENUE_ID = 'venue-1'

describe('updateRolePermissions — grant-subset guard', () => {
  beforeEach(() => {
    prismaMock.venue.findUnique.mockResolvedValue({ id: VENUE_ID } as any)
    prismaMock.staff.findUnique.mockResolvedValue({ id: 'modifier-staff' } as any)
    // No custom row for the modifier's own role → falls back to DEFAULT_PERMISSIONS.
    prismaMock.venueRolePermission.findUnique.mockResolvedValue(null as any)
    prismaMock.venueRolePermission.deleteMany.mockResolvedValue({ count: 0 } as any)
  })

  it('blocks an ADMIN from granting system:manage (superadmin-namespace escalation)', async () => {
    await expect(
      updateRolePermissions(VENUE_ID, StaffRole.ADMIN, ['teams:read', 'system:manage'], 'modifier-staff', StaffRole.ADMIN),
    ).rejects.toThrow(/No puedes otorgar permisos que tú no posees/i)
  })

  it('blocks an ADMIN from granting the *:* wildcard', async () => {
    await expect(updateRolePermissions(VENUE_ID, StaffRole.ADMIN, ['*:*'], 'modifier-staff', StaffRole.ADMIN)).rejects.toThrow(
      /No puedes otorgar permisos que tú no posees/i,
    )
  })

  it('allows an OWNER (holds *:*) to edit a lower role without the escalation error', async () => {
    // OWNER holds *:* so any grant is within their own set. Using the MANAGER
    // defaults hits the deterministic "revert to defaults" branch (deleteMany),
    // proving the subset guard did not over-block a legitimate edit.
    const result = await updateRolePermissions(
      VENUE_ID,
      StaffRole.MANAGER,
      [...DEFAULT_PERMISSIONS[StaffRole.MANAGER]],
      'owner-staff',
      StaffRole.OWNER,
    )
    expect(result.isCustom).toBe(false)
  })

  /**
   * 🔴 Hermano del P1 #2 de Codex (B3b, código r1): la guarda leía los permisos PROPIOS del que edita sin
   * `deniedPermissions`. Si el negocio le dio `system:manage` al rol ADMIN y después se lo QUITÓ, `checkPermission`
   * ya no se lo reconoce — pero aquí seguía contando como suyo, y ese ADMIN podía otorgárselo a otro rol.
   */
  it('🔴 un permiso que el negocio le QUITÓ al rol del que edita ya no cuenta como suyo: no lo puede otorgar', async () => {
    prismaMock.venueRolePermission.findUnique.mockResolvedValue({
      permissions: ['system:manage'],
      deniedPermissions: ['system:manage'],
    } as any)
    await expect(
      updateRolePermissions(VENUE_ID, StaffRole.MANAGER, ['teams:read', 'system:manage'], 'modifier-staff', StaffRole.ADMIN),
    ).rejects.toThrow(/No puedes otorgar permisos que tú no posees: system:manage/i)
    expect(prismaMock.venueRolePermission.upsert).not.toHaveBeenCalled()
  })

  it('control: con el mismo permiso SIN quitar, la guarda lo reconoce como suyo y deja guardar', async () => {
    prismaMock.venueRolePermission.findUnique.mockResolvedValue({ permissions: ['system:manage'], deniedPermissions: [] } as any)
    prismaMock.venueRolePermission.upsert.mockResolvedValue({
      role: StaffRole.MANAGER,
      permissions: ['teams:read', 'system:manage'],
      deniedPermissions: [],
      modifier: null,
    } as any)
    await expect(
      updateRolePermissions(VENUE_ID, StaffRole.MANAGER, ['teams:read', 'system:manage'], 'modifier-staff', StaffRole.ADMIN),
    ).resolves.toBeDefined()
    expect(prismaMock.venueRolePermission.upsert).toHaveBeenCalledTimes(1)
  })
})
