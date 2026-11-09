import { NextFunction, Request, Response, Router } from 'express'
import { validateRequest } from '../../middlewares/validation'
import AppError from '../../errors/AppError'
import {
  desvincularCelularSchema,
  generarCodigosSchema,
  listarCelularesSchema,
  listarRetenidosSchema,
  resolverRetenidoSchema,
} from '../../schemas/dashboard/celularesDeCampo.schema'
import { listarCelularesDeCampo } from '../../services/tpv/campo/celular/celularesDeLaOrganizacion.service'
import { generarCodigos } from '../../services/tpv/campo/celular/codigoDeCelular.service'
import { desvincularCelular } from '../../services/tpv/campo/celular/desvincularCelular.service'
import { listarRetenidos, resolverRetenido } from '../../services/tpv/campo/celular/graciaDelCelular.service'

// Se monta en organizationDashboard.routes.ts detrás de authenticate + checkOrgAccess + requireOrgManager.
const router = Router({ mergeParams: true })

/** La lista de la organización: cada promotor con el estado de su celular. */
router.get('/', validateRequest(listarCelularesSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { q, venueId, estado, page, pageSize } = req.query as any
    const data = await listarCelularesDeCampo(req.params.orgId, { q, venueId, estado, page, pageSize })
    res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
})

router.post('/codigos', validateRequest(generarCodigosSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await generarCodigos({ organizationId: req.params.orgId, generadoPor: (req as any).authContext.userId, ...req.body })
    res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
})

router.post(
  '/:celularId/desvincular',
  validateRequest(desvincularCelularSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await desvincularCelular({
        celularId: req.params.celularId,
        organizationId: req.params.orgId,
        motivo: 'PANEL',
        porStaffId: (req as any).authContext.userId,
        perdidoORobado: req.body?.perdidoORobado === true,
      })
      res.json({ success: true, data })
    } catch (error) {
      next(error)
    }
  },
)

/** «Por revisar»: lo que un celular subió en su gracia y no se pudo aceptar solo. `estado` = uno o varios, separados por coma. */
router.get('/retenidos', validateRequest(listarRetenidosSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { staffId, venueId, estado, page, pageSize } = req.query as any
    const data = await listarRetenidos(req.params.orgId, { staffId, venueId, estado, page, pageSize })
    res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
})

/** Aplicar o descartar un retenido. Los rechazos con datos (`motivo`, `rechazo`) van al mismo nivel que `code`. */
router.post(
  '/retenidos/:retenidoId/resolver',
  validateRequest(resolverRetenidoSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await resolverRetenido({
        retenidoId: req.params.retenidoId,
        organizationId: req.params.orgId,
        accion: req.body.accion,
        nota: req.body.nota,
        porStaffId: (req as any).authContext.userId,
      })
      res.json({ success: true, data })
    } catch (error) {
      const d = error instanceof AppError ? error.details : undefined
      if (error instanceof AppError && d && typeof d === 'object' && !Array.isArray(d)) {
        return res.status(error.statusCode).json({ code: error.code, message: error.message, ...d })
      }
      next(error)
    }
  },
)

export default router
