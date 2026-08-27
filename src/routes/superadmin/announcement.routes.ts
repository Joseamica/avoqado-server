/**
 * Anuncios de plataforma — rutas de superadmin.
 *
 * 🔴 El guardia NO se repite aquí: el router padre (`superadmin.routes.ts`) ya aplica
 * `authenticateTokenMiddleware` + `authorizeRole([StaffRole.SUPERADMIN])`. Pasarle a
 * `authorizeRole` un rol suelto en vez de un arreglo fue un hallazgo P1 de auditoría —
 * hay una prueba que falla si alguien lo reintroduce.
 */
import { Router } from 'express'
import * as controller from '../../controllers/superadmin/announcement.superadmin.controller'

const router = Router({ mergeParams: true })

router.get('/', controller.list)
router.get('/capabilities', controller.capabilities)
router.post('/', controller.create)
router.post('/preview-audience', controller.previewAudience)
router.put('/:id', controller.update)
router.post('/:id/publish', controller.publish)
router.post('/:id/archive', controller.archive)
router.get('/:id/metrics', controller.metrics)

export default router
