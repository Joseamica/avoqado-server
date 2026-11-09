/**
 * Quién es «promotor de campo» (App de campo, bloque 1, regla A8): persona activa con un `StaffVenue` activo de rol
 * WAITER o CASHIER en una sucursal de la organización que tiene el módulo SERIALIZED_INVENTORY.
 */
import { StaffRole } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { OPERATIONAL_VENUE_STATUSES } from '@/lib/venueStatus.constants'
import { MODULE_CODES, moduleService } from '@/services/modules/module.service'

export type SucursalDeLaPersona = { staffVenueId: string; venueId: string; nombre: string; role: StaffRole; pin: string | null }

const ROLES_DE_CAMPO: StaffRole[] = [StaffRole.WAITER, StaffRole.CASHIER]

/** Sucursales de la organización con inventario serializado. */
export async function sucursalesConCampo(organizationId: string): Promise<string[]> {
  const venues = await prisma.venue.findMany({ where: { organizationId }, select: { id: true } })
  const prendidas = await Promise.all(venues.map(v => moduleService.isModuleEnabled(v.id, MODULE_CODES.SERIALIZED_INVENTORY)))
  return venues.filter((_, i) => prendidas[i]).map(v => v.id)
}

/** Sucursales operativas de la organización donde la persona (activa) tiene un `StaffVenue` activo. */
export async function sucursalesDeLaPersona(staffId: string, organizationId: string): Promise<SucursalDeLaPersona[]> {
  const filas = await prisma.staffVenue.findMany({
    where: {
      staffId,
      active: true,
      staff: { active: true },
      venue: { organizationId, status: { in: OPERATIONAL_VENUE_STATUSES } },
    },
    select: { id: true, venueId: true, role: true, pin: true, venue: { select: { name: true } } },
    orderBy: [{ startDate: 'asc' }, { id: 'asc' }],
  })
  return filas.map(f => ({ staffVenueId: f.id, venueId: f.venueId, nombre: f.venue.name, role: f.role, pin: f.pin }))
}

export async function esPromotorDeCampo(staffId: string, organizationId: string): Promise<boolean> {
  const deCampo = (await sucursalesDeLaPersona(staffId, organizationId)).filter(s => ROLES_DE_CAMPO.includes(s.role))
  if (deCampo.length === 0) return false
  const conCampo = new Set(await sucursalesConCampo(organizationId))
  return deCampo.some(s => conCampo.has(s.venueId))
}
