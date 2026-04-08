/**
 * Organization Stock Control Routes
 *
 * Org-level endpoints for the Control de Stock dashboard.
 * Mounted at /dashboard/organizations/:orgId from dashboard.routes.ts
 *
 * Access control:
 * - Authenticated user (authenticateTokenMiddleware)
 * - User is OWNER+ in the target org (requireOrgOwner — SUPERADMIN bypass)
 * - Org has at least one venue with WHITE_LABEL_DASHBOARD enabled (checked in controller)
 */
import { Router, Request, Response, NextFunction } from 'express'
import { authenticateTokenMiddleware } from '../../middlewares/authenticateToken.middleware'
import prisma from '../../utils/prismaClient'
import { StaffRole } from '@prisma/client'
import { getOrgStockOverview, exportOrgStockExcel } from '../../controllers/dashboard/organizationStockControl.controller'

const router = Router({ mergeParams: true })

async function requireOrgOwner(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId, role } = (req as any).authContext ?? {}
    const { orgId } = req.params

    if (role === 'SUPERADMIN') return next()

    if (!userId) {
      return res.status(401).json({ success: false, error: 'unauthorized', message: 'Autenticación requerida' })
    }

    const ownerVenue = await prisma.staffVenue.findFirst({
      where: {
        staffId: userId,
        venue: { organizationId: orgId },
        role: StaffRole.OWNER,
      },
    })

    if (!ownerVenue) {
      return res.status(403).json({
        success: false,
        error: 'forbidden',
        message: 'Solo los propietarios de la organización pueden ver esta sección',
      })
    }

    next()
  } catch (err) {
    next(err)
  }
}

router.get('/stock-control/overview', authenticateTokenMiddleware, requireOrgOwner, getOrgStockOverview)
router.get('/stock-control/export.xlsx', authenticateTokenMiddleware, requireOrgOwner, exportOrgStockExcel)

export default router
