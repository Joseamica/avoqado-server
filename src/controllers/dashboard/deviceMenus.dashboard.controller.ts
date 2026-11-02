/**
 * Menú del aparato — «Qué muestra cada aparato» del DASHBOARD. Controlador delgado: el servicio valida las reglas y escribe
 * el ActivityLog. Responde la forma del contrato tal cual (sin sobre `{ success, data }`), como el resto de `tpvs`.
 */
import { NextFunction, Request, Response } from 'express'
import * as venueService from '../../services/dashboard/venue.dashboard.service'
import { listDeviceMenuOptions, listDeviceMenus, setTerminalMenus } from '../../services/devices/deviceMenus.service'

/** El negocio de la URL es de la organización del token (SUPERADMIN entra a cualquiera), como `menu.dashboard.controller`. */
async function checkVenueAccess(req: Request): Promise<void> {
  const auth = (req as any).authContext as { orgId?: string; role?: string } | undefined
  if (!auth?.orgId) throw new Error('Authentication context not found. Organization ID is missing.')
  await venueService.assertVenueAccessible(auth.orgId, req.params.venueId, { skipOrgCheck: auth.role === 'SUPERADMIN' })
}

const h =
  (fn: (req: Request) => Promise<unknown>) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await checkVenueAccess(req)
      res.status(200).json(await fn(req))
    } catch (error) {
      next(error)
    }
  }

// `query` ya viene validada y con sus defaults (deviceMenus.schema).
export const listDeviceMenusHandler = h(req => {
  const { page, pageSize } = req.query as unknown as { page: number; pageSize: number }
  return listDeviceMenus(req.params.venueId, page, pageSize)
})

export const listDeviceMenuOptionsHandler = h(req => {
  const { search, page, pageSize } = req.query as unknown as { search?: string; page: number; pageSize: number }
  return listDeviceMenuOptions(req.params.venueId, { search, page, pageSize })
})

export const setTerminalMenusHandler = h(req =>
  setTerminalMenus(req.params.venueId, req.params.tpvId, req.body.menuIds, (req as any).authContext?.userId ?? null),
)
