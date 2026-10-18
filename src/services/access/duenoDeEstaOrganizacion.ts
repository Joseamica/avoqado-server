/**
 * La regla de `requireOrgOwner`, en un solo lugar: un superadmin de verdad, o una fila ACTIVA de
 * `StaffOrganization` con rol OWNER de ESTA organización, de una persona activa.
 *
 * A propósito más estrecha que `esDuenoDeLaOrganizacion` (que también acepta ser OWNER de una
 * sucursal): la usan las operaciones de organización que mueven dinero o destruyen (migrar una
 * terminal, cambiarle el comercio, borrarla de fábrica). Y a propósito independiente del rol que la
 * persona tenga en una sucursal: un dueño de la org que además es ADMIN en una tienda sigue siendo
 * el dueño.
 *
 * Vive en su propio módulo (y no en `rolVigente`) porque varias pruebas simulan `rolVigente` entero:
 * así esas pruebas siguen ejercitando esta regla real con su `esSuperadminDeLaSesion` simulado.
 */
import prisma from '../../utils/prismaClient'
import { esSuperadminDeLaSesion } from './rolVigente'

export async function esDuenoDeEstaOrganizacionOSuperadmin(
  sesion: { userId?: string; role?: string } | undefined | null,
  organizationId: string,
): Promise<boolean> {
  if (await esSuperadminDeLaSesion(sesion)) return true
  if (!sesion?.userId || !organizationId) return false

  const fila = await prisma.staffOrganization.findFirst({
    where: {
      staffId: sesion.userId,
      organizationId,
      isActive: true,
      role: 'OWNER',
      staff: { active: true },
    },
    select: { id: true },
  })
  return !!fila
}
