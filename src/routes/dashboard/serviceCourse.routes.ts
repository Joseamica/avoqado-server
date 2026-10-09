import { Router } from 'express'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
import { checkPermission } from '@/middlewares/checkPermission.middleware'
import { checkFeatureAccess } from '@/middlewares/checkFeatureAccess.middleware'
import { checkOrgAccess, requireOrgOwner } from './organizationDashboard.routes'
import * as controller from '@/controllers/dashboard/serviceCourse.controller'

const router = Router()
// Reads remain visible on Free, with enabled=false. A teaser must not look like
// an empty catalog; writes use the same TABLE_SERVICE gate as Mesas.
router.get('/venues/:venueId/service-courses', authenticateTokenMiddleware, checkPermission('settings:read'), controller.getVenue)
router.put(
  '/venues/:venueId/service-courses',
  authenticateTokenMiddleware,
  checkPermission('settings:manage'),
  checkFeatureAccess('TABLE_SERVICE'),
  controller.putVenue,
)
// StaffOrganization OWNER is authoritative, never a branch's venue OWNER.
router.get(
  '/organizations/:orgId/service-courses',
  authenticateTokenMiddleware,
  checkOrgAccess,
  requireOrgOwner,
  controller.getOrganization,
)
router.put(
  '/organizations/:orgId/service-courses',
  authenticateTokenMiddleware,
  checkOrgAccess,
  requireOrgOwner,
  controller.putOrganization,
)

export default router
