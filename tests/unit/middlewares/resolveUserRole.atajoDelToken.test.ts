/**
 * `resolveUserRoleForVenue` — el atajo del token (P1, auditoría con Codex 2026-08-18).
 *
 * La función tenía un `return` temprano: si el venue del token coincidía con el de la
 * petición —que es el caso NORMAL de la TPV y del POS— devolvía el rol que venía dentro
 * del JWT sin tocar la base. Dos consecuencias, las dos verificadas:
 *
 *   1. `permissionSet` salía `undefined` SIEMPRE. O sea que la lista de permisos propia
 *      de un empleado (`StaffVenue.permissionSetId`, el ÚNICO camino del producto que
 *      permite RECORTAR) se ignoraba en línea. Pero el replay offline sí la carga
 *      (`access.service.ts`), así que la misma acción pasaba con internet y se rechazaba
 *      sin internet — y el intent terminaba en cuarentena. Es el mismo patrón que
 *      arreglamos en a2c0c739, una capa más abajo.
 *
 *   2. `active` no se miraba nunca. Un empleado dado de baja seguía trabajando hasta que
 *      caducara su token.
 *
 * El arreglo quita el atajo. Para que eso no cueste 3 consultas por request —la función
 * la llaman `validateVenueAccess`, `checkPermission` y `checkTableOwnership` en la misma
 * cadena— se memoiza en el propio objeto `req`.
 */

import { StaffRole, OrgRole } from '@prisma/client'
import { resolveUserRoleForVenue } from '@/middlewares/checkPermission.middleware'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staffVenue: { findUnique: jest.fn(), findFirst: jest.fn() },
    venue: { findUnique: jest.fn() },
    staffOrganization: { findUnique: jest.fn() },
  },
}))

const STAFF = 'staff-1'
const VENUE = 'venue-1'

const PERMISSION_SET = {
  id: 'ps-1',
  name: 'Mesero recortado',
  permissions: ['orders:read'],
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('el permiso propio del empleado (PermissionSet) NO se puede ignorar en línea', () => {
  it('🔴 lo devuelve aunque el venue del token sea el mismo de la petición', async () => {
    ;(prisma.staffVenue.findUnique as jest.Mock).mockResolvedValue({
      role: StaffRole.WAITER,
      active: true,
      permissionSetId: PERMISSION_SET.id,
      permissionSet: PERMISSION_SET,
    })

    const r = await resolveUserRoleForVenue({
      userId: STAFF,
      targetVenueId: VENUE,
      tokenVenueId: VENUE, // <- el caso normal de la TPV: coinciden
      tokenRole: StaffRole.WAITER,
    })

    expect(r.role).toBe(StaffRole.WAITER)
    // Lo que fallaba: con el atajo esto era `undefined` y el recorte no se aplicaba.
    expect(r.permissionSet).toEqual(PERMISSION_SET)
    expect(prisma.staffVenue.findUnique).toHaveBeenCalled()
  })
})

describe('un empleado dado de baja deja de trabajar de inmediato', () => {
  it('🔴 active:false no resuelve rol, aunque su token siga vigente y diga otra cosa', async () => {
    ;(prisma.staffVenue.findUnique as jest.Mock).mockResolvedValue({
      role: StaffRole.MANAGER,
      active: false, // <- dado de baja
      permissionSetId: null,
      permissionSet: null,
    })
    ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ organizationId: 'org-1' })
    ;(prisma.staffOrganization.findUnique as jest.Mock).mockResolvedValue(null)

    const r = await resolveUserRoleForVenue({
      userId: STAFF,
      targetVenueId: VENUE,
      tokenVenueId: VENUE,
      tokenRole: StaffRole.MANAGER, // el token todavía lo cree MANAGER
    })

    expect(r.role).toBeNull()
    expect(r.source).toBe('none')
  })
})

describe('lo que NO se debe romper al quitar el atajo', () => {
  it('el dueño de la organización sigue entrando a un venue donde no tiene fila propia', async () => {
    ;(prisma.staffVenue.findUnique as jest.Mock).mockResolvedValue(null)
    ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ organizationId: 'org-1' })
    ;(prisma.staffOrganization.findUnique as jest.Mock).mockResolvedValue({
      role: OrgRole.OWNER,
      isActive: true,
    })

    const r = await resolveUserRoleForVenue({
      userId: STAFF,
      targetVenueId: VENUE,
      tokenVenueId: VENUE,
      tokenRole: StaffRole.OWNER,
    })

    expect(r.role).toBe(StaffRole.OWNER)
    expect(r.source).toBe('orgOwner')
    expect(prisma.staffOrganization.findUnique).toHaveBeenCalledWith({
      where: {
        staffId_organizationId: { staffId: STAFF, organizationId: 'org-1' },
        isActive: true,
        role: OrgRole.OWNER,
        staff: { active: true },
      },
      select: { role: true, isActive: true },
    })
  })

  it('una cuenta Staff desactivada no revive por una membresía OWNER activa', async () => {
    ;(prisma.staffVenue.findUnique as jest.Mock).mockResolvedValue(null)
    ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ organizationId: 'org-1' })
    // PostgreSQL devuelve null porque la consulta debe filtrar staff.active=true.
    ;(prisma.staffOrganization.findUnique as jest.Mock).mockResolvedValue(null)

    const r = await resolveUserRoleForVenue({
      userId: STAFF,
      targetVenueId: VENUE,
      tokenVenueId: VENUE,
      tokenRole: StaffRole.OWNER,
    })

    expect(r).toMatchObject({ role: null, source: 'none' })
    expect(prisma.staffOrganization.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ staff: { active: true } }),
      }),
    )
  })

  it('el staff activo sin PermissionSet resuelve por su rol, como siempre', async () => {
    ;(prisma.staffVenue.findUnique as jest.Mock).mockResolvedValue({
      role: StaffRole.CASHIER,
      active: true,
      permissionSetId: null,
      permissionSet: null,
    })

    const r = await resolveUserRoleForVenue({
      userId: STAFF,
      targetVenueId: VENUE,
      tokenVenueId: VENUE,
      tokenRole: StaffRole.CASHIER,
    })

    expect(r.role).toBe(StaffRole.CASHIER)
    expect(r.source).toBe('staffVenue')
    expect(r.permissionSet ?? null).toBeNull()
  })
})

describe('el costo: una consulta por request, no una por middleware', () => {
  it('🔴 tres llamadas con el MISMO req consultan la base UNA vez', async () => {
    ;(prisma.staffVenue.findUnique as jest.Mock).mockResolvedValue({
      role: StaffRole.WAITER,
      active: true,
      permissionSetId: null,
      permissionSet: null,
    })

    // La cadena real de la ruta PATCH /items: validateVenueAccess -> checkPermission
    // -> checkTableOwnership. Sin memoizar serían 3 consultas donde antes había 0.
    const req = {} as any
    const args = { userId: STAFF, targetVenueId: VENUE, tokenVenueId: VENUE, tokenRole: StaffRole.WAITER, req }

    const a = await resolveUserRoleForVenue(args)
    const b = await resolveUserRoleForVenue(args)
    const c = await resolveUserRoleForVenue(args)

    expect(a.role).toBe(StaffRole.WAITER)
    expect(b).toEqual(a)
    expect(c).toEqual(a)
    expect(prisma.staffVenue.findUnique).toHaveBeenCalledTimes(1)
  })

  it('la memoria NO se comparte entre requests distintos', async () => {
    ;(prisma.staffVenue.findUnique as jest.Mock).mockResolvedValue({
      role: StaffRole.WAITER,
      active: true,
      permissionSetId: null,
      permissionSet: null,
    })

    await resolveUserRoleForVenue({ userId: STAFF, targetVenueId: VENUE, tokenVenueId: VENUE, tokenRole: StaffRole.WAITER, req: {} as any })
    await resolveUserRoleForVenue({ userId: STAFF, targetVenueId: VENUE, tokenVenueId: VENUE, tokenRole: StaffRole.WAITER, req: {} as any })

    expect(prisma.staffVenue.findUnique).toHaveBeenCalledTimes(2)
  })

  it('la memoria distingue venue: el mismo req contra OTRO venue vuelve a consultar', async () => {
    ;(prisma.staffVenue.findUnique as jest.Mock).mockResolvedValue({
      role: StaffRole.WAITER,
      active: true,
      permissionSetId: null,
      permissionSet: null,
    })

    const req = {} as any
    await resolveUserRoleForVenue({ userId: STAFF, targetVenueId: VENUE, tokenVenueId: VENUE, tokenRole: StaffRole.WAITER, req })
    await resolveUserRoleForVenue({ userId: STAFF, targetVenueId: 'venue-2', tokenVenueId: VENUE, tokenRole: StaffRole.WAITER, req })

    expect(prisma.staffVenue.findUnique).toHaveBeenCalledTimes(2)
  })
})
