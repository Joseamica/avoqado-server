import { Router } from 'express'
import * as controller from '../../controllers/superadmin/masterCatalog.superadmin.controller'

const router = Router({ mergeParams: true })

router.get('/organizations', controller.listOrganizations)
router.get('/organizations/:organizationId', controller.getOrganization)
router.put('/organizations/:organizationId/entitlement', controller.updateEntitlement)
router.put('/organizations/:organizationId/module', controller.updateModule)
router.put('/organizations/:organizationId/config', controller.updateConfig)
router.put('/organizations/:organizationId/venues/:venueId/governance', controller.updateGovernance)

export default router
