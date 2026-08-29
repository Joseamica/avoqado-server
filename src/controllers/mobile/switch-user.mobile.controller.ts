/**
 * Cambiar de usuario por PIN — «como un logout/login, pero con PIN» (founder, 2026-08-29).
 *
 * Responde con la MISMA forma que el login para que la app reuse su camino de guardado y refresque
 * la UI entera con los permisos de quien entra.
 */
import { NextFunction, Request, Response } from 'express'

import logger from '../../config/logger'
import { switchUserByPin } from '../../services/mobile/switch-user.mobile.service'

/**
 * @route POST /api/v1/mobile/venues/:venueId/auth/switch-user
 */
export const switchUser = async (req: Request, res: Response, next: NextFunction) => {
  const { venueId } = req.params
  const { pin } = req.body as { pin: string }
  const ctx = (req as any).authContext

  try {
    // 🔴 El `sid` de la sesión ACTUAL es lo que hace segura esta operación: sin él el servicio
    // rechaza, porque un PIN nunca puede abrir una tablet donde nadie inició sesión. Viaja en el
    // authContext desde que se expuso en `security.ts`; un token legacy no lo trae y cae al
    // mismo rechazo genérico, que es el comportamiento correcto: esa app debe re-loguearse.
    const resultado = await switchUserByPin({
      venueId,
      pin,
      sesionActualId: ctx?.sid ?? null,
      staffSalienteId: ctx?.userId ?? null,
      deviceId: typeof req.headers['x-device-id'] === 'string' ? req.headers['x-device-id'] : null,
    })

    logger.info('Cambio de usuario por PIN', { venueId, entra: resultado.user.id, sale: ctx?.userId ?? null })

    // Sin envolver en `{ data: ... }`: la respuesta ES la del login, para que el cliente reuse su
    // mismo camino de guardado. Ver el docstring del servicio.
    res.status(200).json(resultado)
  } catch (error) {
    next(error)
  }
}
