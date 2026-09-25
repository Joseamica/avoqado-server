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

  // Desde H2 (Codex, 24-sep) los resolutores preguntan además si la PERSONA sigue activa
  // (`staff.findUnique` con `select: { active: true }`). Quien declara un rol en el token es una persona
  // activa; sólo se contesta ESA pregunta y cualquier otra consulta a `staff` sigue como la prueba la dejó.
  const previa = prismaMock.staff.findUnique.getMockImplementation()
  prismaMock.staff.findUnique.mockImplementation((args: any) => {
    const soloActivo = args?.select && Object.keys(args.select).length === 1 && args.select.active === true
    if (soloActivo) return Promise.resolve({ active: true })
    return previa ? previa(args) : Promise.resolve(undefined)
  })

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

/**
 * Hace que la base confirme a un SUPERADMIN real (Codex H6/S5, 24-sep): los candados ya no le creen al
 * `role: 'SUPERADMIN'` del token y preguntan (a) si la persona sigue activa y (b) si tiene una fila
 * SUPERADMIN activa. Sólo contesta ESAS dos preguntas; cualquier otra consulta sigue como la dejó la prueba.
 *
 * Llámalo donde la prueba firma CADA token, con `esSuperadmin` según su rol: la respuesta del doble persiste
 * entre pruebas, y un token de otro rol no debe heredar «sí, eres superadmin».
 */
export function simularSuperadminReal(esSuperadmin = true): void {
  const staffPrevia = prismaMock.staff.findUnique.getMockImplementation()
  prismaMock.staff.findUnique.mockImplementation((args: any) => {
    const soloActivo = args?.select && Object.keys(args.select).length === 1 && args.select.active === true
    if (soloActivo) return Promise.resolve({ active: true })
    return staffPrevia ? staffPrevia(args) : Promise.resolve(undefined)
  })
  const filaPrevia = prismaMock.staffVenue.findFirst.getMockImplementation()
  prismaMock.staffVenue.findFirst.mockImplementation((args: any) => {
    if (args?.where?.role === 'SUPERADMIN') return Promise.resolve(esSuperadmin ? { id: 'fila-superadmin-real' } : null)
    return filaPrevia ? filaPrevia(args) : Promise.resolve(undefined)
  })
}
