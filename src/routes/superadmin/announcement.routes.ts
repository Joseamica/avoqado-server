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
import { preserveContext } from '@/observability/preserveContext'

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
// 🔴 `preserveContext` no es opcional: multer retoma la petición desde el stream del cuerpo,
// cuyo recurso asíncrono nació ANTES de que el logger abriera el contexto, así que el control
// vuelve fuera de él y todo lo de abajo loguea SIN negocio. Medido en producción: las 2 subidas
// de KYC fueron las únicas 2 de 139 peticiones sin tenant en el log. Hay un guardrail
// (`tests/unit/observability/multipartContext.test.ts`) que falla si alguien lo quita.
router.post('/images', preserveContext(imageUpload.single('file')), controller.uploadImage)
router.post('/preview-audience', controller.previewAudience)
router.put('/:id', controller.update)
router.post('/:id/publish', controller.publish)
router.post('/:id/archive', controller.archive)
router.get('/:id/metrics', controller.metrics)

export default router
