import prisma from '../../../utils/prismaClient'
import { ForbiddenError } from '../../../errors/AppError'
import { getUserAccess, hasPermission } from '../../access/access.service'
import { MODULE_CODES, moduleService } from '../../modules/module.service'

export async function venueHasServicePayAccess(venueId: string): Promise<boolean> {
  return moduleService.isModuleEnabled(venueId, MODULE_CODES.SERVICE_PAY)
}

/** Sedes de la organización con el módulo activo: el alcance de toda operación de organización (spec §5.7, §9.2). */
export async function sedesConServicePay(organizationId: string): Promise<string[]> {
  const venues = await prisma.venue.findMany({
    where: { organizationId },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: 500,
  })
  const activas: string[] = []
  for (const v of venues) if (await venueHasServicePayAccess(v.id)) activas.push(v.id)
  return activas
}

async function tienePermiso(userId: string, venueId: string, permiso: string): Promise<boolean> {
  try {
    return hasPermission(await getUserAccess(userId, venueId), permiso)
  } catch {
    return false
  }
}

export async function assertPermisoEnTodasLasSedes(userId: string, organizationId: string, permiso: string): Promise<void> {
  const sedes = await sedesConServicePay(organizationId)
  if (sedes.length === 0) throw new ForbiddenError('Pago por servicio no está activo en ninguna sede de esta organización')
  for (const venueId of sedes) {
    if (!(await tienePermiso(userId, venueId, permiso))) {
      throw new ForbiddenError(`Esta acción afecta a toda la organización: necesitas ${permiso} en todas las sedes`)
    }
  }
}

export async function sedesLegibles(userId: string, organizationId: string): Promise<{ venueIds: string[]; parcial: boolean }> {
  const sedes = await sedesConServicePay(organizationId)
  const venueIds: string[] = []
  for (const v of sedes) if (await tienePermiso(userId, v, 'staffpay:read')) venueIds.push(v)
  return { venueIds, parcial: venueIds.length < sedes.length }
}
