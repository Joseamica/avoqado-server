import { NextFunction, Request, Response, Router } from 'express'
import { validateRequest } from '../../middlewares/validation'
import { generarCodigosSchema } from '../../schemas/dashboard/celularesDeCampo.schema'
import { generarCodigos } from '../../services/tpv/campo/celular/codigoDeCelular.service'
import { desvincularCelular } from '../../services/tpv/campo/celular/desvincularCelular.service'

// Se monta en organizationDashboard.routes.ts detrás de authenticate + checkOrgAccess + requireOrgManager.
const router = Router({ mergeParams: true })

router.post('/codigos', validateRequest(generarCodigosSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await generarCodigos({ organizationId: req.params.orgId, generadoPor: (req as any).authContext.userId, ...req.body })
    res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
})

router.post('/:celularId/desvincular', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await desvincularCelular({
      celularId: req.params.celularId,
      organizationId: req.params.orgId,
      motivo: 'PANEL',
      porStaffId: (req as any).authContext.userId,
    })
    res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
})

export default router
