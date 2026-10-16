/**
 * Quién puede cambiarle a quién las sucursales asignadas, en UN solo lugar.
 *
 * Lo usan las dos puertas que lo hacen:
 *   · `PATCH /dashboard/venues/:venueId/stores-analysis/team/:staffId/venues` (panel white-label de la sucursal)
 *   · `PATCH /dashboard/organizations/:orgId/team/:staffId/venues`             (panel de la organización)
 * La segunda no tenía ninguna de estas reglas: un OWNER de UNA sucursal se agregaba otras sucursales como OWNER
 * (auditoría de Codex de la rama, 15-oct-2026, P1-4). Dos copias de la misma regla es cómo una puerta se queda atrás.
 *
 * Todo se revisa ANTES de escribir:
 *   1. la persona tiene que ser de ESTA org (fila activa) — 404;
 *   2. al DUEÑO de la org sólo lo toca el dueño de la org (comprobación estricta: `StaffOrganization` OWNER) — 403;
 *   3. nadie toca a alguien de rol mayor que el suyo (cuenta el rol más alto que la persona tiene o TUVO en la org,
 *      porque el `upsert` reactiva filas, y su rol de org OWNER/ADMIN) — 403;
 *   4. nadie se quita su último acceso — 409;
 *   5. nadie se da sucursales a sí mismo, salvo el dueño de la org — 403;
 *   6. no se le devuelven sucursales a quien está dado de baja (`Staff.active=false`); quitárselas sí — 409.
 */
import prisma from '../../utils/prismaClient'
import { ROLE_HIERARCHY } from '../../lib/permissions'
import { esDuenoDeEstaOrganizacionOSuperadmin } from '../access/duenoDeEstaOrganizacion'

export interface RechazoDeSucursales {
  status: 403 | 404 | 409
  body: { success: false; error: string; message: string }
}

const rechazo = (status: RechazoDeSucursales['status'], error: string, message: string): RechazoDeSucursales => ({
  status,
  body: { success: false, error, message },
})

const nivelEnLaOrg = (rolDeOrg?: string | null) =>
  rolDeOrg === 'OWNER' ? ROLE_HIERARCHY.OWNER : rolDeOrg === 'ADMIN' ? ROLE_HIERARCHY.ADMIN : 0

/** `null` = puede seguir; si no, la respuesta HTTP que hay que devolver (nada se escribió). */
export async function revisarCambioDeSucursales(p: {
  orgId: string
  staffId: string
  sesion: { userId: string; role?: string }
  /** El nivel del que actúa por su sucursal (p. ej. el rol que `checkPermission` resolvió en la sucursal de la petición). */
  nivelDelActorEnSucursal: number
  /** Las filas `StaffVenue` de la persona en las sucursales de la org, activas o apagadas. */
  filasDelObjetivo: ReadonlyArray<{ venueId: string; role: string; active: boolean }>
  /** Las sucursales que quedarían, ya filtradas a las de la org. */
  sucursalesPedidas: readonly string[]
}): Promise<RechazoDeSucursales | null> {
  const { orgId, staffId, sesion } = p

  const [membresiaDelObjetivo, persona, membresiaDelActor, actorEsDuenoDeLaOrg] = await Promise.all([
    prisma.staffOrganization.findFirst({ where: { staffId, organizationId: orgId, isActive: true }, select: { role: true } }),
    prisma.staff.findUnique({ where: { id: staffId }, select: { active: true } }),
    prisma.staffOrganization.findFirst({
      where: { staffId: sesion.userId, organizationId: orgId, isActive: true },
      select: { role: true },
    }),
    esDuenoDeEstaOrganizacionOSuperadmin(sesion, orgId),
  ])
  if (!membresiaDelObjetivo || !persona) {
    return rechazo(404, 'not_found', 'Esa persona no es parte de esta organización.')
  }

  if (membresiaDelObjetivo.role === 'OWNER' && !actorEsDuenoDeLaOrg) {
    return rechazo(403, 'owner_required', 'Sólo el dueño de la organización puede cambiar las sucursales de un dueño de la organización.')
  }

  const nivelDelActor = Math.max(p.nivelDelActorEnSucursal, nivelEnLaOrg(membresiaDelActor?.role))
  const nivelDelObjetivo = Math.max(
    nivelEnLaOrg(membresiaDelObjetivo.role),
    ...p.filasDelObjetivo.map(f => ROLE_HIERARCHY[f.role as keyof typeof ROLE_HIERARCHY] ?? 0),
    0,
  )
  if (nivelDelObjetivo > nivelDelActor) {
    return rechazo(403, 'role_above', 'No puedes cambiar las sucursales de alguien con un rol mayor al tuyo.')
  }

  const activas = new Set(p.filasDelObjetivo.filter(f => f.active).map(f => f.venueId))
  const agrega = p.sucursalesPedidas.some(id => !activas.has(id))

  if (staffId === sesion.userId) {
    if (activas.size > 0 && p.sucursalesPedidas.length === 0) {
      return rechazo(409, 'last_access', 'No puedes quitarte tu último acceso a la organización.')
    }
    if (agrega && !actorEsDuenoDeLaOrg) {
      return rechazo(403, 'self_assignment', 'No puedes darte acceso a otras sucursales: pídeselo al dueño de la organización.')
    }
  }

  if (!persona.active && agrega) {
    return rechazo(409, 'staff_deactivated', 'Esa persona está dada de baja. Reactívala antes de asignarle sucursales.')
  }

  return null
}
