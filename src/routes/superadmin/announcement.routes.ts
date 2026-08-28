/**
 * Anuncios de plataforma — rutas de superadmin.
 *
 * 🔴 El guardia NO se repite aquí: el router padre (`superadmin.routes.ts`) ya aplica
 * `authenticateTokenMiddleware` + `authorizeRole([StaffRole.SUPERADMIN])`. Pasarle a
 * `authorizeRole` un rol suelto en vez de un arreglo fue un hallazgo P1 de auditoría —
 * hay una prueba que falla si alguien lo reintroduce.
 */
import multer from 'multer'
import { Router } from 'express'
import * as controller from '../../controllers/superadmin/announcement.superadmin.controller'

const router = Router({ mergeParams: true })

// Fotos de los bloques del anuncio. En memoria y con tope de 8 MB: son fotos de producto,
// no archivos pesados, y el servicio revisa los BYTES antes de subir nada.
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
})

router.get('/', controller.list)
router.get('/capabilities', controller.capabilities)
router.post('/', controller.create)
router.post('/images', imageUpload.single('file'), controller.uploadImage)
router.post('/preview-audience', controller.previewAudience)
router.put('/:id', controller.update)
router.post('/:id/publish', controller.publish)
router.post('/:id/archive', controller.archive)
router.get('/:id/metrics', controller.metrics)

export default router
