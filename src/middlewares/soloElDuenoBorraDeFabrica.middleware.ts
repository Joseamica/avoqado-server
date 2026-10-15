// src/middlewares/soloElDuenoBorraDeFabrica.middleware.ts
//
// 🔴 Borrar de fábrica una terminal es del DUEÑO, en TODAS las puertas que lo encolan.
//
// Hallazgo 1 de la auditoría de Codex (14-oct-2026). El permiso `tpv-factory-reset:execute`
// existía (OWNER sí, ADMIN y MANAGER no), pero ninguna ruta lo pedía:
//   · `POST /dashboard/tpv/:terminalId/command` (y su gemela con `/venues/:venueId`) sólo exigía
//     `tpv:command`, que MANAGER tiene y ADMIN cubre con `tpv:*`;
//   · `POST /dashboard/organizations/:orgId/terminals/:terminalId/command` sólo exigía ser
//     MIEMBRO de la organización (un cajero de cualquier sucursal bastaba).
// El dashboard sólo le pinta el botón al dueño, pero eso no es un candado.
//
// Es un comando cuyo permiso depende del TIPO que viene en el cuerpo (regla
// «Endpoints with sub-actions» de `.claude/rules/permissions-policy.md`): el permiso genérico de
// la ruta se queda como está y, sólo si el comando es crítico, se exige además el candado.
//
// Dos candados, uno por eje:
//   · Rutas del VENUE: `tpv-factory-reset:execute` con el resolvedor canónico
//     (`tienePermisoEnElVenue`: las mismas piezas y el mismo orden que `checkPermission` —
//     superadmin de verdad, rol vigente en el venue con el dueño de la organización como
//     respaldo, conjunto de permisos, personalizaciones y EXCLUSIONES del venue). Nunca por
//     nombre de rol: un negocio puede dárselo a otro rol o quitárselo al dueño.
//   · Ruta de la ORGANIZACIÓN: FACTORY_RESET y UPDATE_MERCHANT son del DUEÑO DE LA ORGANIZACIÓN,
//     con la regla de `requireOrgOwner` (`esDuenoDeEstaOrganizacionOSuperadmin`), la misma del
//     asistente de migración (decisión del 15-oct). Un dueño de la org que además es ADMIN en una
//     tienda sigue siendo el dueño.
//
// Diferencia deliberada con `checkPermission`: NO honra el override por PIN de gerente. Ese PIN
// autoriza una acción del piso; borrar una terminal que cobra es decisión del dueño.

import { NextFunction, Request, Response } from 'express'
import { ForbiddenError, NotFoundError } from '../errors/AppError'
import { logAction } from '../services/dashboard/activity-log.service'
import { esDuenoDeEstaOrganizacionOSuperadmin } from '../services/access/duenoDeEstaOrganizacion'
import prisma from '../utils/prismaClient'
import { tienePermisoEnElVenue } from './permissionFlag.middleware'

export const PERMISO_BORRADO_DE_FABRICA = 'tpv-factory-reset:execute'
export const CODIGO_SOLO_EL_DUENO = 'FACTORY_RESET_OWNER_ONLY'
export const MENSAJE_SOLO_EL_DUENO =
  'Sólo el dueño del negocio puede borrar de fábrica una terminal. Pídeselo al dueño (o a quien tenga el permiso «Restablecer de fábrica»).'

/**
 * ¿El valor que mandó el cliente es un borrado de fábrica? Sin distinguir mayúsculas ni espacios
 * y aunque llegue como arreglo: ante la duda se exige el permiso (falla cerrado). Lo que no sea
 * exactamente `FACTORY_RESET` lo rechaza después la cola de comandos de todos modos.
 */
export function esBorradoDeFabrica(comando: unknown): boolean {
  return (
    String(comando ?? '')
      .trim()
      .toUpperCase() === 'FACTORY_RESET'
  )
}

/**
 * Exige `tpv-factory-reset:execute` en `venueId` (el venue de la TERMINAL). Si falta, deja la
 * denegación en la bitácora del dueño y lanza un 403 que dice quién sí puede.
 */
export async function exigirPermisoDeBorradoDeFabrica(req: Request, venueId: string): Promise<void> {
  if (await tienePermisoEnElVenue(req, venueId, PERMISO_BORRADO_DE_FABRICA)) return

  const authContext = (req as any).authContext
  void logAction({
    staffId: authContext?.userId ?? null,
    venueId,
    action: 'PERMISSION_DENIED',
    entity: 'permission',
    entityId: PERMISO_BORRADO_DE_FABRICA,
    data: {
      permission: PERMISO_BORRADO_DE_FABRICA,
      command: 'FACTORY_RESET',
      method: req.method,
      path: req.originalUrl,
    },
    ipAddress: req.ip,
    userAgent: typeof req.get === 'function' ? req.get('user-agent') : undefined,
  })
  throw new ForbiddenError(MENSAJE_SOLO_EL_DUENO, CODIGO_SOLO_EL_DUENO)
}

/**
 * Para las rutas del venue. Va DESPUÉS de su `checkPermission` (y de `validateRequest`, si la
 * ruta lo tiene). El venue es el de la terminal que ya ató `bindTpvCommandTarget`; en
 * `/venues/:venueId/tpv-commands` es el de la URL, y la cola rechaza una terminal de otro venue.
 */
export const soloElDuenoBorraDeFabrica =
  (leerComando: (req: Request) => unknown) =>
  async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!esBorradoDeFabrica(leerComando(req))) return next()
      const venueId = req.tpvCommandTarget?.venueId ?? req.params?.venueId
      if (!venueId) throw new ForbiddenError(MENSAJE_SOLO_EL_DUENO, CODIGO_SOLO_EL_DUENO)
      await exigirPermisoDeBorradoDeFabrica(req, venueId)
      next()
    } catch (error) {
      next(error)
    }
  }

/**
 * Lo que en la ruta de la ORGANIZACIÓN sólo manda el dueño de la organización: a qué comercio va el
 * dinero (UPDATE_MERCHANT) y el borrado de la terminal (FACTORY_RESET).
 */
const MENSAJES_SOLO_DUENO_DE_LA_ORG: Record<string, string> = {
  FACTORY_RESET: 'Sólo el dueño de la organización puede borrar de fábrica una terminal desde aquí. Pídeselo al dueño.',
  UPDATE_MERCHANT: 'Sólo el dueño de la organización puede cambiar el comercio con el que cobra una terminal. Pídeselo al dueño.',
}
export const COMANDOS_SOLO_DUENO_DE_LA_ORG = Object.keys(MENSAJES_SOLO_DUENO_DE_LA_ORG)
export const CODIGO_SOLO_DUENO_DE_LA_ORG = 'ORG_OWNER_REQUIRED'

/**
 * Para `POST /organizations/:orgId/terminals/:terminalId/command`, después de `requireOrgManager`
 * y del esquema. Si el comando es crítico: la terminal se acota a la organización (mismas
 * respuestas que `validateTerminalInOrg`) y sólo pasa el dueño de la org o un superadmin de
 * verdad; la denegación queda en la bitácora con el venue de la terminal.
 */
export async function soloElDuenoDeLaOrgEnComandosCriticos(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const comando = String(req.body?.command ?? '')
      .trim()
      .toUpperCase()
    const mensaje = MENSAJES_SOLO_DUENO_DE_LA_ORG[comando]
    if (!mensaje) return next()

    const terminal = await prisma.terminal.findUnique({
      where: { id: req.params.terminalId },
      select: { venueId: true, venue: { select: { organizationId: true } } },
    })
    if (!terminal) throw new NotFoundError('Terminal no encontrada')
    if (terminal.venue.organizationId !== req.params.orgId) throw new ForbiddenError('La terminal no pertenece a esta organización')

    const authContext = (req as any).authContext
    if (await esDuenoDeEstaOrganizacionOSuperadmin(authContext, req.params.orgId)) return next()

    void logAction({
      staffId: authContext?.userId ?? null,
      venueId: terminal.venueId,
      action: 'PERMISSION_DENIED',
      entity: 'organization-owner',
      entityId: comando,
      data: {
        required: 'organization-owner',
        command: comando,
        organizationId: req.params.orgId,
        terminalId: req.params.terminalId,
        method: req.method,
        path: req.originalUrl,
      },
      ipAddress: req.ip,
      userAgent: typeof req.get === 'function' ? req.get('user-agent') : undefined,
    })
    throw new ForbiddenError(mensaje, CODIGO_SOLO_DUENO_DE_LA_ORG)
  } catch (error) {
    next(error)
  }
}
