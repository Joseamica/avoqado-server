/**
 * CRM routes — base path /api/v1/crm (spec 2026-10-30 §5.1).
 *
 * 🔴 Mounted OUTSIDE the superadmin router on purpose. A seller is a VIEWER of Avoqado's internal venue, so every
 * `/api/v1/superadmin/*` route keeps answering 403 to their token, and the only thing that opens a CRM route is the key
 * it asks for with `requireCrm` — re-read from the database on every request.
 */
import express from 'express'
import * as crmController from '../controllers/crm/crm.controller'
import { CRM_KEYS } from '../lib/permissions'
import { authenticateTokenMiddleware } from '../middlewares/authenticateToken.middleware'
import { requireCrm } from '../middlewares/requireCrm.middleware'
import { validateRequest } from '../middlewares/validation'
import { addTeamMemberSchema, listTeamSchema, removeTeamMemberSchema, updateTeamMemberSchema } from '../schemas/crm.schema'

const router = express.Router()

router.use(authenticateTokenMiddleware)

// Any key opens it: 403 only for whoever holds none.
router.get('/me', requireCrm(CRM_KEYS), crmController.getMe)

// «Equipo de ventas»: who holds which key. The guard goes first, so nobody without `crm:admin` learns anything here.
router.get('/team', requireCrm('crm:admin'), validateRequest(listTeamSchema), crmController.listTeam)
router.post('/team', requireCrm('crm:admin'), validateRequest(addTeamMemberSchema), crmController.addTeam)
router.patch('/team/:id', requireCrm('crm:admin'), validateRequest(updateTeamMemberSchema), crmController.updateTeam)
router.delete('/team/:id', requireCrm('crm:admin'), validateRequest(removeTeamMemberSchema), crmController.removeTeam)

export default router
