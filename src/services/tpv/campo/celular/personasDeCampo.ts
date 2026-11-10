/**
 * Quién es «promotor de campo» (App de campo, bloque 1, regla A8): persona activa con un `StaffVenue` activo de rol
 * WAITER o CASHIER en una sucursal de la organización que tiene el módulo SERIALIZED_INVENTORY.
 */
import { StaffRole } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { OPERATIONAL_VENUE_STATUSES } from '@/lib/venueStatus.constants'
import { MODULE_CODES, moduleService } from '@/services/modules/module.service'

export type SucursalDeLaPersona = { staffVenueId: string; venueId: string; nombre: string; role: StaffRole; pin: string | null }

export const ROLES_DE_CAMPO: StaffRole[] = [StaffRole.WAITER, StaffRole.CASHIER]

/**
 * Páginas de las consultas que recorren TODO (R3-5): ningún tope corta candidatos antes de filtrar. Se recorre con cursor
 * hasta el final; el tamaño sólo acota cada consulta.
 */
const PAGINA_DE_SUCURSALES_DE_LA_ORG = 2000
const PAGINA_DE_SUCURSALES_DE_LA_PERSONA = 200

/** UNA sola definición de «promotor» (A8) para las dos rutas: `esPromotorDeCampo` y la búsqueda de todos los sin celular. */
export const filtroDePromotor = (venueIds: string[]) => ({
  active: true,
  role: { in: ROLES_DE_CAMPO },
  venueId: { in: venueIds },
  venue: { status: { in: OPERATIONAL_VENUE_STATUSES } },
})

/** Sucursales de la organización con inventario serializado: todas, página por página (una consulta de módulo por página). */
export async function sucursalesConCampo(organizationId: string): Promise<string[]> {
  const conCampo: string[] = []
  let cursor: string | undefined
  for (;;) {
    const ids = (
      await prisma.venue.findMany({
        where: { organizationId },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: PAGINA_DE_SUCURSALES_DE_LA_ORG,
        ...(cursor && { skip: 1, cursor: { id: cursor } }),
      })
    ).map(v => v.id)
    if (ids.length > 0) {
      const prendidas = await moduleService.venuesWithModule(ids, MODULE_CODES.SERIALIZED_INVENTORY)
      conCampo.push(...ids.filter(id => prendidas.has(id)))
    }
    if (ids.length < PAGINA_DE_SUCURSALES_DE_LA_ORG) return conCampo
    cursor = ids[ids.length - 1]
  }
}

/** Las asignaciones activas de la persona en sucursales operativas de la org; `roles` va EN la consulta (antes del tope). */
async function asignaciones(staffId: string, organizationId: string, roles?: StaffRole[]): Promise<SucursalDeLaPersona[]> {
  const todas: SucursalDeLaPersona[] = []
  let cursor: string | undefined
  for (;;) {
    const filas = await prisma.staffVenue.findMany({
      where: {
        staffId,
        active: true,
        ...(roles && { role: { in: roles } }),
        staff: { active: true },
        venue: { organizationId, status: { in: OPERATIONAL_VENUE_STATUSES } },
      },
      select: { id: true, venueId: true, role: true, pin: true, venue: { select: { name: true } } },
      orderBy: [{ startDate: 'asc' }, { id: 'asc' }],
      take: PAGINA_DE_SUCURSALES_DE_LA_PERSONA,
      ...(cursor && { skip: 1, cursor: { id: cursor } }),
    })
    todas.push(...filas.map(f => ({ staffVenueId: f.id, venueId: f.venueId, nombre: f.venue.name, role: f.role, pin: f.pin })))
    if (filas.length < PAGINA_DE_SUCURSALES_DE_LA_PERSONA) return todas
    cursor = filas[filas.length - 1].id
  }
}

/** Sucursales operativas de la organización donde la persona (activa) tiene un `StaffVenue` activo: todas (la baja, A6). */
export const sucursalesDeLaPersona = (staffId: string, organizationId: string): Promise<SucursalDeLaPersona[]> =>
  asignaciones(staffId, organizationId)

/**
 * Las sucursales donde la persona trabaja COMO PROMOTORA de campo (A8: rol de promotor y sucursal con el módulo). Es lo único
 * que usan activar, entrar y la lista de sucursales que recibe el celular: una sucursal donde es gerente, o sin el módulo, no.
 */
export async function sucursalesDeCampoDeLaPersona(staffId: string, organizationId: string): Promise<SucursalDeLaPersona[]> {
  const deCampo = await asignaciones(staffId, organizationId, ROLES_DE_CAMPO)
  if (deCampo.length === 0) return []
  const conModulo = await moduleService.venuesWithModule(
    deCampo.map(s => s.venueId),
    MODULE_CODES.SERIALIZED_INVENTORY,
  )
  return deCampo.filter(s => conModulo.has(s.venueId))
}

/** `conCampo` opcional: quien llama en bucle lo calcula UNA vez y lo pasa. */
export async function esPromotorDeCampo(staffId: string, organizationId: string, conCampo?: Set<string>): Promise<boolean> {
  const deCampo = await asignaciones(staffId, organizationId, ROLES_DE_CAMPO)
  if (deCampo.length === 0) return false
  const campo = conCampo ?? new Set(await sucursalesConCampo(organizationId))
  return deCampo.some(s => campo.has(s.venueId))
}
