import { Router, Request, Response, NextFunction } from 'express'

import { checkPermission } from '../../middlewares/checkPermission.middleware'
import { validateRequest } from '../../middlewares/validation'
import * as controller from '../../controllers/dashboard/birthdayAutomation.dashboard.controller'
import { obtenerAutomatizacionSchema, guardarAutomatizacionSchema } from '../../schemas/dashboard/birthdayAutomation.schema'

/**
 * Configuración de la felicitación automática de cumpleaños.
 *
 * Montada bajo `/venues/:venueId/birthday-automation`, detrás del mismo gate de plan
 * (`CUSTOMER_CAMPAIGNS`) que las campañas puntuales.
 *
 * 🔴 El permiso del PUT DEPENDE DEL CUERPO, y es deliberado: editar el texto es
 * `marketing:manage`, pero **ENCENDERLA es autorizar envíos recurrentes a los clientes del
 * negocio** — eso pide `marketing:send`, el mismo permiso que publicar una campaña. Es el
 * patrón que `.claude/rules/permissions-policy.md` documenta para endpoints con
 * sub-acciones: un permiso genérico dejaría que quien sólo puede redactar encienda el
 * envío. **Apagarla** se queda en `:manage`: parar nunca puede ser más difícil que
 * arrancar.
 */
const router = Router({ mergeParams: true })

export const permisoSegunElCuerpo = (req: Request, res: Response, next: NextFunction) => {
  const encendiendo = req.body?.activa === true
  return checkPermission(encendiendo ? 'marketing:send' : 'marketing:manage')(req, res, next)
}

router.get('/', checkPermission('marketing:manage'), validateRequest(obtenerAutomatizacionSchema), controller.getBirthdayAutomation)

// 🔴 `validateRequest` va ANTES del permiso SÓLO aquí, y por una razón concreta: el permiso
// se decide leyendo `activa` del cuerpo, así que el cuerpo tiene que estar validado antes
// —si no, un `activa: "true"` de texto se leería como distinto de `true` y bajaría el
// candado a `:manage`—. Es el orden que la propia regla de permisos del repo prescribe para
// endpoints con sub-acciones; el resto del repo valida después, y así se queda.
router.put('/', validateRequest(guardarAutomatizacionSchema), permisoSegunElCuerpo, controller.putBirthdayAutomation)

export default router
