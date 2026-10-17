/**
 * La regla de `requireOrgManager`, en un solo lugar: «supervisor o más» en una organización.
 *
 * Pasa un superadmin de verdad, quien tenga una fila ACTIVA de sucursal de esa organización con
 * rol MANAGER, ADMIN, OWNER o SUPERADMIN (los supervisores de PlayTelecom son MANAGER de
 * sucursal y MEMBER de la org: un candado sólo por `OrgRole` los dejaría fuera), o quien sea
 * OWNER o ADMIN de la organización (fila activa). El piso (cajero, mesero/promotor, hostess,
 * cocina, viewer) nunca pasa.
 *
 * La comparten la puerta de la organización (`requireOrgManager`, que la recibe por `:orgId`) y
 * la de la sucursal (`storesAnalysis`, que saca la organización de su `:venueId`). Vive en su propio
 * módulo, sin efectos, como `duenoDeEstaOrganizacion.ts`.
 */
import prisma from '../../utils/prismaClient'
import { esSuperadminDeLaSesion } from './rolVigente'

export const ROLES_DE_SUPERVISOR_EN_SUCURSAL = ['SUPERADMIN', 'OWNER', 'ADMIN', 'MANAGER'] as const
export const ROLES_DE_SUPERVISOR_EN_LA_ORG = ['OWNER', 'ADMIN'] as const
export const MENSAJE_SE_REQUIERE_SUPERVISOR = 'Se requiere rol de supervisor o superior'

export async function esSupervisorOMasDeLaOrganizacion(
  sesion: { userId?: string; role?: string } | undefined | null,
  organizationId: string | null | undefined,
): Promise<boolean> {
  if (await esSuperadminDeLaSesion(sesion)) return true
  if (!sesion?.userId || !organizationId) return false

  const [filaDeSucursal, filaDeLaOrg] = await Promise.all([
    prisma.staffVenue.findFirst({
      where: {
        staffId: sesion.userId,
        active: true,
        venue: { organizationId },
        role: { in: [...ROLES_DE_SUPERVISOR_EN_SUCURSAL] },
      },
      select: { id: true },
    }),
    prisma.staffOrganization.findFirst({
      where: {
        staffId: sesion.userId,
        organizationId,
        isActive: true,
        role: { in: [...ROLES_DE_SUPERVISOR_EN_LA_ORG] },
      },
      select: { id: true },
    }),
  ])

  return !!filaDeSucursal || !!filaDeLaOrg
}
