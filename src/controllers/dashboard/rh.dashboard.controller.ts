import { NextFunction, Request, Response } from 'express'
import type { StaffRole } from '@prisma/client'
import { ctx } from './staffPay.dashboard.controller'
import * as puestos from '../../services/dashboard/rh/puestos.service'
import * as asign from '../../services/dashboard/rh/asignaciones.service'
import { resumenDePago } from '../../services/dashboard/rh/resumenDePago.service'
import { getUserAccess, hasPermission } from '../../services/access/access.service'
import logger from '../../config/logger'

const h =
  (fn: (req: Request) => Promise<unknown>, status = 200) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(status).json(await fn(req))
    } catch (e) {
      next(e)
    }
  }
const q = (req: Request) => req.query as Record<string, any>

export const listPositions = h(req =>
  puestos.listarPuestos(ctx(req).venueId, { incluirArchivados: q(req).includeArchived, limit: q(req).limit, offset: q(req).offset }),
)
export const suggestions = h(async req => ({ data: await puestos.puestosSugeridos(ctx(req).venueId) }))
export const createPosition = h(req => puestos.crearPuesto({ ...req.body, venueId: ctx(req).venueId, actorId: ctx(req).userId }), 201)
export const updatePosition = h(req =>
  puestos.editarPuesto({ ...req.body, venueId: ctx(req).venueId, actorId: ctx(req).userId, positionId: req.params.positionId }),
)
export const archivePosition = h(req =>
  puestos.archivarPuesto({ venueId: ctx(req).venueId, actorId: ctx(req).userId, positionId: req.params.positionId }),
)
export const history = h(req =>
  asign.historialDePersona(ctx(req).venueId, req.params.staffId, { limit: q(req).limit, offset: q(req).offset }),
)
export const assign = h(
  req => asign.asignarPuesto({ ...req.body, venueId: ctx(req).venueId, staffId: req.params.staffId, actorId: ctx(req).userId }),
  201,
)
export const change = h(req =>
  asign.cambiarAsignacion({ ...req.body, venueId: ctx(req).venueId, assignmentId: req.params.assignmentId, actorId: ctx(req).userId }),
)
export const end = h(req =>
  asign.terminarAsignacion({ ...req.body, venueId: ctx(req).venueId, assignmentId: req.params.assignmentId, actorId: ctx(req).userId }),
)

/**
 * Impersonación: el mismo override que arma verifyAccess.middleware.ts. Sin él, un SUPERADMIN que impersona un rol
 * recuperaría su bypass y vería tasas personales que ese rol no puede ver (Codex r2-B1).
 */
function overrideDeImpersonacion(req: Request) {
  const a = (req as any).authContext
  if (!a?.isImpersonating || !a.impersonation) return undefined
  return {
    isImpersonating: true as const,
    mode: a.impersonation.mode as 'user' | 'role',
    ...(a.impersonation.mode === 'role' ? { forcedRole: a.role as StaffRole } : {}),
  }
}

export const payOverview = h(async req => {
  const { venueId, userId } = ctx(req)
  let puede = { comisiones: false, pagoPorClase: false }
  try {
    const access = await getUserAccess(userId, venueId, undefined, overrideDeImpersonacion(req))
    puede = { comisiones: hasPermission(access, 'commissions:read'), pagoPorClase: hasPermission(access, 'staffpay:read') }
  } catch (error) {
    // Igual que staffPay/acceso.ts (permisoYAcceso): un error al resolver el acceso cuenta como «sin permiso».
    logger.warn('rh.payOverview: no se pudo resolver el acceso; se muestra sin permiso', { venueId, userId, error })
  }
  return resumenDePago(venueId, req.params.staffId, puede)
})
