/**
 * El rol REAL de una sesión, leído de la base — nunca el que viene escrito en el token.
 *
 * 🔴 Por qué (Codex gpt-6-astra, 24-sep): el token vive 24 h y lleva el rol congelado al emitirse.
 * Un token de DUEÑO emitido por el defecto del cambio de sucursal, o el de alguien a quien ya dieron
 * de baja, seguía pasando todo candado que sólo mirara `authContext.role` — y la compra de tokens
 * de IA cobra con la tarjeta guardada del negocio.
 *
 * Misma prioridad que al emitir el token (`switchVenueForStaff`): superadmin → dueño de ESA
 * organización → su fila en ESA sucursal.
 */
import { StaffRole } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { esDuenoDeLaOrganizacion } from '../staffOrganization.service'

interface SesionParaRol {
  userId: string
  orgId?: string
  venueId?: string
  role: StaffRole | string
  isImpersonating?: boolean
  realUserId?: string
}

/** Superadmin DE VERDAD: fila SUPERADMIN activa de una persona activa (no lo que diga un token). */
export async function esSuperadminReal(staffId: string): Promise<boolean> {
  const fila = await prisma.staffVenue.findFirst({
    where: { staffId, active: true, role: StaffRole.SUPERADMIN, staff: { active: true } },
    select: { id: true },
  })
  return !!fila
}

/**
 * ¿La sesión pide pasar como superadmin Y lo es de verdad? Para los candados que antes se fiaban
 * de `authContext.role === 'SUPERADMIN'`: el token dice lo que ERA al emitirse (24 h), la base dice
 * lo que ES. Sin el rol en el token no se consulta nada (cero costo para el resto de los roles).
 */
export async function esSuperadminDeLaSesion(sesion: { userId?: string; role?: string } | undefined | null): Promise<boolean> {
  if (!sesion?.userId || sesion.role !== StaffRole.SUPERADMIN) return false
  return esSuperadminReal(sesion.userId)
}

export async function rolVigente(sesion: SesionParaRol): Promise<StaffRole | null> {
  // Impersonación: el rol del token lo eligió A PROPÓSITO un superadmin (y las reglas de
  // impersonación ya la acotan). Vale sólo si quien actúa sigue siendo superadmin de verdad.
  if (sesion.isImpersonating) {
    const actor = sesion.realUserId ?? sesion.userId
    return (await esSuperadminReal(actor)) ? (sesion.role as StaffRole) : null
  }

  const staff = await prisma.staff.findUnique({ where: { id: sesion.userId }, select: { active: true } })
  if (!staff?.active) return null

  if (await esSuperadminReal(sesion.userId)) return StaffRole.SUPERADMIN

  const venue = sesion.venueId ? await prisma.venue.findUnique({ where: { id: sesion.venueId }, select: { organizationId: true } }) : null

  if (venue) {
    if (await esDuenoDeLaOrganizacion(sesion.userId, venue.organizationId)) return StaffRole.OWNER
    const fila = await prisma.staffVenue.findFirst({
      where: { staffId: sesion.userId, venueId: sesion.venueId, active: true },
      select: { role: true },
    })
    return fila?.role ?? null
  }

  // Sin sucursal real (el alta: `venueId = 'pending'`): sólo el dueño de su organización.
  if (sesion.orgId && (await esDuenoDeLaOrganizacion(sesion.userId, sesion.orgId))) return StaffRole.OWNER
  return null
}
