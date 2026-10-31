/**
 * CRM routes — base path /api/v1/crm (spec 2026-10-30 §5.1).
 *
 * 🔴 Mounted OUTSIDE the superadmin router on purpose. A seller is a VIEWER of Avoqado's internal venue, so every
 * `/api/v1/superadmin/*` route keeps answering 403 to their token, and the only thing that opens a CRM route is the key
 * it asks for with `requireCrm` — re-read from the database on every request. The services then narrow every account
 * query to the caller's scope (`scopeWhere`).
 */
import express from 'express'
import * as crmController from '../controllers/crm/crm.controller'
import { CRM_KEYS } from '../lib/permissions'
import { authenticateTokenMiddleware } from '../middlewares/authenticateToken.middleware'
import { requireCrm } from '../middlewares/requireCrm.middleware'
import { validateRequest } from '../middlewares/validation'
import {
  accountIdSchema,
  addActivitySchema,
  addNoteSchema,
  addTeamMemberSchema,
  completeActivitySchema,
  createAccountSchema,
  createLostReasonSchema,
  createStageSchema,
  listAccountsSchema,
  listTeamSchema,
  loseAccountSchema,
  moveStageSchema,
  reassignAccountSchema,
  removeTeamMemberSchema,
  searchOrganizationsSchema,
  updateLostReasonSchema,
  updateStageSchema,
  updateTeamMemberSchema,
  winAccountSchema,
} from '../schemas/crm.schema'

const router = express.Router()

router.use(authenticateTokenMiddleware)

const ver = requireCrm('crm:ver')
const editar = requireCrm('crm:editar')
const admin = requireCrm('crm:admin')

// Any key opens it: 403 only for whoever holds none.
router.get('/me', requireCrm(CRM_KEYS), crmController.getMe)

// «Equipo de ventas»: who holds which key. The guard goes first, so nobody without `crm:admin` learns anything here.
router.get('/team', admin, validateRequest(listTeamSchema), crmController.listTeam)
router.post('/team', admin, validateRequest(addTeamMemberSchema), crmController.addTeam)
router.patch('/team/:id', admin, validateRequest(updateTeamMemberSchema), crmController.updateTeam)
router.delete('/team/:id', admin, validateRequest(removeTeamMemberSchema), crmController.removeTeam)
// The ficha's owner selector (ruling 13). The service hands the names only to whoever can reassign.
router.get('/team/options', requireCrm(['crm:admin', 'crm:editar']), crmController.teamOptions)

// «Mis pendientes», where the CRM opens.
router.get('/pending', ver, crmController.pending)

// Stages and lost reasons: whoever sees the pipeline reads them; an admin without «Ver negocios» still edits them.
router.get('/stages', requireCrm(['crm:ver', 'crm:admin']), crmController.listStages)
router.post('/stages', admin, validateRequest(createStageSchema), crmController.createStage)
router.patch('/stages/:id', admin, validateRequest(updateStageSchema), crmController.updateStage)
router.get('/lost-reasons', requireCrm(['crm:ver', 'crm:admin']), crmController.listLostReasons)
router.post('/lost-reasons', admin, validateRequest(createLostReasonSchema), crmController.createLostReason)
router.patch('/lost-reasons/:id', admin, validateRequest(updateLostReasonSchema), crmController.updateLostReason)

// What «Ganar» links an account to.
router.get('/organizations/search', editar, validateRequest(searchOrganizationsSchema), crmController.searchOrganizations)

// Accounts.
router.get('/accounts', ver, validateRequest(listAccountsSchema), crmController.listAccounts)
router.post('/accounts', editar, validateRequest(createAccountSchema), crmController.createAccount)
router.get('/accounts/:id', ver, validateRequest(accountIdSchema), crmController.getAccount)
router.post('/accounts/:id/take', editar, validateRequest(accountIdSchema), crmController.takeAccount)
// «Editar: todos» or admin: the service decides, so a «propios» seller gets a 403 that says why.
router.post(
  '/accounts/:id/reassign',
  requireCrm(['crm:editar', 'crm:admin']),
  validateRequest(reassignAccountSchema),
  crmController.reassignAccount,
)
router.post('/accounts/:id/stage', editar, validateRequest(moveStageSchema), crmController.moveStage)
router.post('/accounts/:id/lose', editar, validateRequest(loseAccountSchema), crmController.loseAccount)
router.post('/accounts/:id/win', editar, validateRequest(winAccountSchema), crmController.winAccount)
router.post('/accounts/:id/archive', editar, validateRequest(accountIdSchema), crmController.archiveAccount)
router.post('/accounts/:id/reactivate', editar, validateRequest(accountIdSchema), crmController.reactivateAccount)
router.post('/accounts/:id/notes', editar, validateRequest(addNoteSchema), crmController.addNote)
router.post('/accounts/:id/activities', editar, validateRequest(addActivitySchema), crmController.createActivity)

// Activities.
router.post('/activities/:id/done', editar, validateRequest(completeActivitySchema), crmController.markActivityDone)

export default router
