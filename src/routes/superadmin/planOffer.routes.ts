import { Router } from 'express'
import * as controller from '@/controllers/superadmin/planOffer.controller'
const router = Router()
// La oferta de los planes (planes editables B1, Task 9). Hereda el token y el rol SUPERADMIN del padre (superadmin.routes).
// Lo que escribe responde 409 PLAN_EDIT_DISABLED con el interruptor apagado, salvo descartar, el interruptor y los destinatarios.
router.get('/', controller.estado)
router.post('/preview', controller.vistaPrevia)
router.post('/publish', controller.publicar)
router.post('/pending/:versionId/retry', controller.reintentar)
router.post('/pending/:versionId/discard', controller.descartar)
router.post('/interruptor', controller.interruptor)
router.put('/recipients', controller.destinatarios)
export default router
