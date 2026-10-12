import { Router } from 'express'
import { checkPermission } from '../../middlewares/checkPermission.middleware'
import { validateRequest } from '../../middlewares/validation'
import * as c from '../../controllers/dashboard/rh.dashboard.controller'
import * as s from '../../schemas/dashboard/rh.schema'
import { asegurarSedeNoMarcaBlanca } from '../../services/dashboard/rh/marcaBlanca'

// RH fase 1a (spec RH §6-7): puestos y asignaciones. Gratis: sin candado de plan.
const router = Router({ mergeParams: true })

// Marca blanca: TODO /rh (lecturas incluidas) responde 403 en español (spec §5.3).
router.use(async (req, _res, next) => {
  try {
    await asegurarSedeNoMarcaBlanca(req.params.venueId)
    next()
  } catch (e) {
    next(e)
  }
})

router.get('/positions', checkPermission('teams:read'), validateRequest(s.listarPuestosSchema), c.listPositions)
router.get('/positions/suggestions', checkPermission('teams:read'), c.suggestions)
router.post('/positions', checkPermission('teams:update'), validateRequest(s.crearPuestoSchema), c.createPosition)
router.patch('/positions/:positionId', checkPermission('teams:update'), validateRequest(s.editarPuestoSchema), c.updatePosition)
router.post('/positions/:positionId/archive', checkPermission('teams:update'), validateRequest(s.archivarPuestoSchema), c.archivePosition)
router.get('/staff/:staffId/assignments', checkPermission('teams:read'), validateRequest(s.historialSchema), c.history)
router.post('/staff/:staffId/assignments', checkPermission('teams:update'), validateRequest(s.asignarSchema), c.assign)
router.post('/assignments/:assignmentId/change', checkPermission('teams:update'), validateRequest(s.cambiarSchema), c.change)
router.post('/assignments/:assignmentId/end', checkPermission('teams:update'), validateRequest(s.terminarSchema), c.end)
router.get('/staff/:staffId/pay-overview', checkPermission('teams:read'), validateRequest(s.personaSchema), c.payOverview)

export default router
