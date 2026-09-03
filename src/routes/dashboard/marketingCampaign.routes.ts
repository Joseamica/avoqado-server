// src/routes/dashboard/marketingCampaign.routes.ts
import { Router } from 'express'
import { checkPermission } from '../../middlewares/checkPermission.middleware'
import { validateRequest } from '../../middlewares/validation'
import * as controller from '../../controllers/dashboard/marketingCampaign.dashboard.controller'
import {
  listarCampanasSchema,
  campanaParamsSchema,
  crearCampanaSchema,
  editarCampanaSchema,
  publicarCampanaSchema,
} from '../../schemas/dashboard/marketingCampaign.schema'

/**
 * Rutas de campañas de correo a clientes — Fase 1C-A, Task 6.
 *
 * Montada bajo `/venues/:venueId/campaigns` en `dashboard.routes.ts`, con
 * `authenticateTokenMiddleware` puesto por el padre (mismo patrón que
 * `classSessionRoutes` / `creditPackRoutes`).
 *
 * 🔴 `marketing:send` NO se hereda de `marketing:manage` (`PERMISSION_DEPENDENCIES`
 * en `src/lib/permissions.ts` los declara independientes salvo por `marketing:read`).
 * Quien puede editar una campaña no puede necesariamente mandarla — mandar es
 * irreversible y le llega a los clientes del negocio. `publish` es la ÚNICA ruta que
 * exige `marketing:send`; las demás mutaciones se quedan en `marketing:manage`.
 *
 * Orden de middlewares: `checkPermission` ANTES de `validateRequest` — es el orden
 * real de TODO el repo (customerGroup, classSession, attendance, printStation…), no
 * al revés.
 */

const router = Router({ mergeParams: true })

router.get('/', checkPermission('marketing:read'), validateRequest(listarCampanasSchema), controller.listCampaigns)

router.post('/', checkPermission('marketing:manage'), validateRequest(crearCampanaSchema), controller.createCampaign)

router.get('/:id', checkPermission('marketing:read'), validateRequest(campanaParamsSchema), controller.getCampaign)

router.put('/:id', checkPermission('marketing:manage'), validateRequest(editarCampanaSchema), controller.updateCampaign)

// Vista previa: cuenta destinatarios y firma el token que `publish` va a exigir. No manda nada
// todavía, así que se queda en `:manage` — el mismo permiso con el que se prepara la campaña.
router.post('/:id/preview', checkPermission('marketing:manage'), validateRequest(campanaParamsSchema), controller.previewCampaign)

// 🔴 marketing:send, y SÓLO aquí. Enviar es irreversible y le llega a los clientes del negocio.
router.post('/:id/publish', checkPermission('marketing:send'), validateRequest(publicarCampanaSchema), controller.publishCampaign)

export default router
