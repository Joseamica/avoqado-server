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

const router = express.Router()

router.use(authenticateTokenMiddleware)

// Any key opens it: 403 only for whoever holds none.
router.get('/me', requireCrm(CRM_KEYS), crmController.getMe)

export default router
