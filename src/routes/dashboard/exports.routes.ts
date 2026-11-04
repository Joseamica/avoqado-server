import { Router, type Request, type Response, type NextFunction } from 'express'
import prisma from '@/utils/prismaClient'
import { checkPermission } from '@/middlewares/checkPermission.middleware'
import { obtenerExportador } from '@/services/exports/exportadores/registry'
import {
  descargarExporte,
  estadoExporte,
  listarExportes,
  pedirExporte,
  reintentarExporte,
} from '@/controllers/dashboard/exports.dashboard.controller'

const router = Router({ mergeParams: true })

/**
 * El permiso es el del EXPORTE (cobros: payments:read; ventas detalladas: reports:read), venga de la URL, del ?kind= o del
 * pedido guardado. Con un permiso fijo, quien sólo tiene payments:read (VIEWER, WAITER, CASHIER) recibía 202 y luego 403.
 * `checkPermission` también autoriza el negocio de la URL (`resolveRequestVenueId`) ANTES de que el controller llame a `pedir`.
 */
function conPermisoDelExporte(kindDe: (req: Request) => Promise<string | null>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const kind = await kindDe(req)
      const exp = kind ? obtenerExportador(kind) : null
      if (!exp) return res.status(404).json({ success: false, message: 'Exporte no encontrado' })
      return checkPermission(exp.permiso)(req, res, next)
    } catch (e) {
      next(e)
    }
  }
}

const delParametro = async (req: Request) => req.params.kind
const deLaQuery = async (req: Request) => (typeof req.query.kind === 'string' ? req.query.kind : null)
const delPedido = async (req: Request) =>
  (await prisma.exportRun.findFirst({ where: { id: req.params.runId, venueId: req.params.venueId }, select: { kind: true } }))?.kind ?? null

router.get('/', conPermisoDelExporte(deLaQuery), listarExportes)
router.post('/:kind', conPermisoDelExporte(delParametro), pedirExporte)
router.get('/:runId/status', conPermisoDelExporte(delPedido), estadoExporte)
router.get('/:runId/download', conPermisoDelExporte(delPedido), descargarExporte)
router.post('/:runId/retry', conPermisoDelExporte(delPedido), reintentarExporte)

export default router
