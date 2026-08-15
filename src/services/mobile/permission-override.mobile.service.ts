/**
 * PIN de autorización de gerente (manager override).
 *
 * Cambia un PIN + un permiso por un TOKEN de un solo uso, 60 s de vida, atado a
 * ESE permiso y ESE venue. `checkPermission` lo consume desde el header
 * `X-Permission-Override` y deja pasar la acción una vez.
 *
 * 🔴 El PIN se compara en TEXTO PLANO. Es una decisión explícita del founder
 * (2026-08-15) y no se re-propone. Consecuencia honesta: quien tenga lectura de
 * la base puede usar el PIN de un gerente y la bitácora diría su nombre igual.
 * La auditoría sirve para reconstruir qué pasó, NO como prueba de quién autorizó.
 */

import { randomUUID } from 'crypto'
import { StaffRole } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { evaluatePermissionList, hasPermission } from '@/lib/permissions'

/** Vida del token. Suficiente para reintentar la request, corto para no dejar la terminal elevada. */
export const OVERRIDE_TTL_MS = 60_000

export class OverrideInvalidPinError extends Error {
  readonly code = 'OVERRIDE_INVALID_PIN' as const
  constructor() {
    super('Código incorrecto')
    this.name = 'OverrideInvalidPinError'
  }
}

export class OverrideInsufficientError extends Error {
  readonly code = 'OVERRIDE_INSUFFICIENT' as const
  /**
   * Quién es el dueño del PIN que se tecleó. NO se serializa al cliente: sirve
   * para que el controlador lo deje escrito en `ActivityLog`. Un PIN válido sin
   * el permiso es la señal clásica de fraude interno (alguien probando códigos
   * ajenos) y el rate limiter sólo lo frena, no lo deja registrado.
   */
  constructor(readonly authorizer?: { staffVenueId: string; role: StaffRole }) {
    super('Ese código tampoco tiene este permiso')
    this.name = 'OverrideInsufficientError'
  }
}

/**
 * Resuelve el permiso efectivo por el MISMO camino que checkPermission:
 * permissionSet asignado > VenueRolePermission + rol. Divergir aquí produciría
 * un PIN que se acepta y luego la acción falla igual (o al revés).
 *
 * 🔴 El Json de `StaffVenue.permissions` NO participa: hoy `checkPermission`
 * tampoco lo mira, así que tomarlo en cuenta aceptaría PINs para acciones que
 * el middleware seguiría rechazando.
 */
async function staffVenueCan(params: {
  venueId: string
  role: StaffRole
  permissionSet: { permissions: unknown } | null
  requiredPermission: string
}): Promise<boolean> {
  const { venueId, role, permissionSet, requiredPermission } = params

  if (permissionSet) {
    return evaluatePermissionList(permissionSet.permissions as string[], requiredPermission)
  }

  const venueRolePermission = await prisma.venueRolePermission.findUnique({
    where: { venueId_role: { venueId, role } },
    select: { permissions: true },
  })

  const customPermissions = venueRolePermission ? (venueRolePermission.permissions as string[]) : null
  return hasPermission(role, customPermissions, requiredPermission)
}

export async function createPermissionOverride(params: {
  venueId: string
  pin: string
  permission: string
  requestedById?: string | null
  now?: Date
}): Promise<{ token: string; expiresAt: Date; authorizedBy: { id: string; name: string } }> {
  const { venueId, pin, permission, requestedById = null } = params
  const now = params.now ?? new Date()

  const staffVenue = await prisma.staffVenue.findFirst({
    where: { venueId, pin, active: true },
    select: {
      id: true,
      role: true,
      permissionSetId: true,
      permissionSet: true,
      staff: { select: { firstName: true, lastName: true } },
    },
  })

  if (!staffVenue) {
    logger.warn('Override rechazado: ningún empleado activo de este venue tiene ese PIN', { venueId, permission })
    throw new OverrideInvalidPinError()
  }

  const can = await staffVenueCan({
    venueId,
    role: staffVenue.role,
    permissionSet: staffVenue.permissionSetId ? (staffVenue.permissionSet as any) : null,
    requiredPermission: permission,
  })

  if (!can) {
    // Auto-autorizarse es imposible por construcción: si TU PIN tuviera el
    // permiso, nunca habría habido 403 y este endpoint no se habría llamado.
    logger.warn('Override rechazado: ese PIN tampoco tiene el permiso', {
      venueId,
      permission,
      authorizerRole: staffVenue.role,
    })
    throw new OverrideInsufficientError({ staffVenueId: staffVenue.id, role: staffVenue.role })
  }

  const token = randomUUID()
  const expiresAt = new Date(now.getTime() + OVERRIDE_TTL_MS)

  await prisma.permissionOverride.create({
    data: {
      venueId,
      token,
      permission,
      authorizedById: staffVenue.id,
      requestedById,
      expiresAt,
    },
  })

  return {
    token,
    expiresAt,
    authorizedBy: {
      id: staffVenue.id,
      name: `${staffVenue.staff.firstName} ${staffVenue.staff.lastName}`.trim(),
    },
  }
}

/**
 * Consumo ATÓMICO. El `updateMany` con `consumedAt: null` en el WHERE es lo que
 * garantiza UN solo uso aunque dos requests lleguen a la vez: la base decide, y
 * sólo una recibe count 1. Nunca separes esto en un read + un write.
 *
 * 🔴 NUNCA lanza: corre dentro del camino de un 403 y un fallo de base no puede
 * convertir un "no tienes permiso" en un 500. Sin token válido → null → 403.
 */
export async function consumePermissionOverride(params: {
  token: string
  venueId: string
  permission: string
  route: string
  now?: Date
}): Promise<{ authorizedById: string } | null> {
  const { token, venueId, permission, route } = params
  const now = params.now ?? new Date()

  try {
    const claimed = await prisma.permissionOverride.updateMany({
      where: { token, venueId, permission, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now, consumedRoute: route },
    })

    if (claimed.count !== 1) return null

    const row = await prisma.permissionOverride.findUnique({
      where: { token },
      select: { authorizedById: true },
    })

    return row ? { authorizedById: row.authorizedById } : null
  } catch (error) {
    logger.error('No se pudo consumir el token de override — se trata como no autorizado', { venueId, permission, error })
    return null
  }
}

/**
 * ¿El venue activó el PIN de autorización? Nace OFF.
 * 🔴 NUNCA lanza: se llama en el camino de un 403 y un fallo de base no puede
 * convertir un "no tienes permiso" en un 500.
 */
export async function isManagerPinOverrideEnabled(venueId: string): Promise<boolean> {
  try {
    const settings = await prisma.venueSettings.findUnique({
      where: { venueId },
      select: { managerPinOverrideEnabled: true },
    })
    return settings?.managerPinOverrideEnabled === true
  } catch (error) {
    logger.error('No se pudo leer managerPinOverrideEnabled — se asume apagado', { venueId, error })
    return false
  }
}
