import prisma from '../../../utils/prismaClient'
import { BadRequestError, ForbiddenError } from '../../../errors/AppError'
import { getUserAccess, hasPermission } from '../../access/access.service'
import { MODULE_CODES, moduleService } from '../../modules/module.service'

export async function venueHasServicePayAccess(venueId: string): Promise<boolean> {
  return moduleService.isModuleEnabled(venueId, MODULE_CODES.SERVICE_PAY)
}

/** Tope de sedes con el módulo por organización: el alcance de un periodo (y sus permisos) se resuelve completo en memoria. */
export const TOPE_SEDES_CON_MODULO = 500
const LOTE_SEDES = 500

/**
 * Sedes de la organización con el módulo activo: el alcance de toda operación de organización (spec §5.7, §9.2).
 * Recorre TODAS las sedes por páginas (cursor por id) y resuelve el módulo en lote (`venuesWithModule`, misma precedencia
 * que `isModuleEnabled`). Con más del tope se NIEGA (Codex bloque A #2): un recorte dejaba fuera del cierre, del alcance
 * guardado y del recibo el dinero de la sede 501 sin avisar.
 */
export async function sedesConServicePay(organizationId: string): Promise<string[]> {
  const activas: string[] = []
  let despuesDe: string | undefined
  for (;;) {
    const page = await prisma.venue.findMany({
      where: { organizationId, ...(despuesDe ? { id: { gt: despuesDe } } : {}) },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: LOTE_SEDES,
    })
    if (!page.length) break
    const conModulo = await moduleService.venuesWithModule(
      page.map(v => v.id),
      MODULE_CODES.SERVICE_PAY,
    )
    for (const v of page) if (conModulo.has(v.id)) activas.push(v.id)
    if (activas.length > TOPE_SEDES_CON_MODULO) {
      throw new BadRequestError(
        `Esta organización tiene más de ${TOPE_SEDES_CON_MODULO} sedes con el módulo: el cierre no puede continuar; contacta a Avoqado.`,
        'DEMASIADAS_SEDES',
      )
    }
    if (page.length < LOTE_SEDES) break
    despuesDe = page[page.length - 1].id
  }
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

export async function tienePermisoEn(userId: string, venueId: string, permiso: string): Promise<boolean> {
  return tienePermiso(userId, venueId, permiso)
}

/**
 * Lo HISTÓRICO se lee sobre el alcance del periodo, no sobre las sedes que hoy tienen el módulo (Codex R1-1): apagar
 * BSF no puede cambiar el recibo cerrado de Ana ni esconder sus diferencias.
 */
export async function sedesLegiblesDe(userId: string, venueIds: string[]): Promise<{ venueIds: string[]; parcial: boolean }> {
  const todas = [...new Set(venueIds)].sort()
  const legibles: string[] = []
  for (const v of todas) if (await tienePermiso(userId, v, 'staffpay:read')) legibles.push(v)
  return { venueIds: legibles, parcial: legibles.length < todas.length }
}

/**
 * Las sedes de `venueIds` donde `userId` tiene `permiso`. Para resolver el permiso ANTES de una transacción de escritura:
 * usa el cliente GLOBAL, y dentro de la transacción eso retendría su conexión mientras pide otra (la familia de Codex
 * R4-Nuevo 1). Dentro se compara contra este conjunto con `exigirPermisoEnSedes`.
 */
export async function sedesConPermiso(userId: string, venueIds: string[], permiso: string): Promise<string[]> {
  const permitidas: string[] = []
  for (const v of [...new Set(venueIds)].sort()) if (await tienePermiso(userId, v, permiso)) permitidas.push(v)
  return permitidas
}

/** La regla de `assertPermisoEnSedes` contra un conjunto ya resuelto (`sedesConPermiso`). Pura: va dentro de la transacción. */
export function exigirPermisoEnSedes(permitidas: ReadonlySet<string>, venueIds: string[], explicacion: string): void {
  if (venueIds.some(v => !permitidas.has(v))) throw new ForbiddenError(explicacion)
}

/** Exige `permiso` en CADA sede (spec §9.2: cerrar, liquidar, marcar pagado). Revisa en orden fijo. */
export async function assertPermisoEnSedes(userId: string, venueIds: string[], permiso: string, explicacion: string): Promise<void> {
  for (const venueId of [...new Set(venueIds)].sort()) {
    if (!(await tienePermiso(userId, venueId, permiso))) throw new ForbiddenError(explicacion)
  }
}
