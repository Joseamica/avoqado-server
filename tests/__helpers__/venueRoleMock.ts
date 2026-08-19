/**
 * tests/__helpers__/venueRoleMock.ts
 *
 * Espeja en `StaffVenue` el rol que declara el token de una prueba HTTP.
 *
 * Desde 2026-08-18 (`7bdbac01`) `resolveUserRoleForVenue` YA NO confía en el rol que viaja
 * dentro del JWT: lo lee de `StaffVenue`, para poder aplicar el `PermissionSet` del empleado
 * y para que dar de baja a alguien surta efecto de inmediato. Las suites que firman un token
 * real y dejan `staffVenue.findUnique` en `null` dejaron de medir lo que creían medir: el
 * middleware corta antes con 403 "No access to this venue" y la regla de permisos que la
 * prueba quería ejercitar nunca llega a evaluarse.
 *
 * Este helper es el equivalente, para las suites de `tests/api-tests/` (que usan el
 * `authenticateTokenMiddleware` REAL), del espejo que el commit de seguridad puso dentro del
 * mock de autenticación en las suites unitarias.
 *
 * La membresía se espeja SOLO para el venue del token: una petición dirigida a otro venue
 * sigue resolviendo `null`, así que las pruebas de aislamiento por tenant (403 "No access to
 * this venue") se mantienen intactas — y siguen fallando si alguien rompe ese candado.
 */
import { prismaMock } from './setup'

export interface MirrorTokenRoleOptions {
  /** `StaffVenue.active`. Ponlo en `false` para ejercitar a un empleado dado de baja. */
  active?: boolean
  /** Lista propia del empleado (`StaffVenue.permissionSetId`). `null` = sin recorte. */
  permissionSet?: { id: string; permissions: string[] } | null
}

/**
 * Hace que `prisma.staffVenue.findUnique` devuelva `role` para `tokenVenueId`, y `null` para
 * cualquier otro venue.
 *
 * Llámalo donde la prueba declara "quién soy" (normalmente su `makeToken`), para que el token
 * y la base nunca puedan contradecirse.
 */
export function mirrorTokenRoleOnStaffVenue(role: string, tokenVenueId: string, options: MirrorTokenRoleOptions = {}): void {
  const { active = true, permissionSet = null } = options

  prismaMock.staffVenue.findUnique.mockImplementation((args: any) => {
    const requestedVenueId = args?.where?.staffId_venueId?.venueId
    if (requestedVenueId !== tokenVenueId) return Promise.resolve(null)

    return Promise.resolve({
      role,
      active,
      permissionSetId: permissionSet?.id ?? null,
      permissionSet,
    })
  })
}
