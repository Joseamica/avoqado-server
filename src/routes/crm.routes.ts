/**
 * CRM routes — base path /api/v1/crm (spec 2026-10-30 §5.1).
 *
 * 🔴 Mounted OUTSIDE the superadmin router on purpose. A seller is a VIEWER of Avoqado's internal venue, so every
 * `/api/v1/superadmin/*` route keeps answering 403 to their token, and the only thing that opens a CRM route is the key
 * it asks for with `requireCrm` — re-read from the database on every request. The services then narrow every account
 * query to the caller's scope (`scopeWhere`).
 */
import express, { type NextFunction, type Request, type Response } from 'express'
import multer from 'multer'
import logger from '../config/logger'
import * as crmController from '../controllers/crm/crm.controller'
import * as crmEmailController from '../controllers/crm/crmEmail.controller'
import { BadRequestError, ValidationError } from '../errors/AppError'
import { CRM_KEYS } from '../lib/permissions'
import { authenticateTokenMiddleware } from '../middlewares/authenticateToken.middleware'
import { autenticacionOpcional } from '../middlewares/autenticacionOpcional.middleware'
import { requireCrm } from '../middlewares/requireCrm.middleware'
import { validateRequest } from '../middlewares/validation'
import { preserveContext } from '../observability/preserveContext'
import { assertFormaNuevaDeLlaves } from '../services/crm/teamVenue.service'
import {
  accountIdSchema,
  addActivitySchema,
  addNoteSchema,
  addTeamMemberSchema,
  campaignIdSchema,
  completeActivitySchema,
  createAccountSchema,
  createCampaignSchema,
  createLostReasonSchema,
  createOptOutSchema,
  createStageSchema,
  createTemplateSchema,
  deleteAccountSchema,
  exportAccountsSchema,
  hideClientSchema,
  listAccountsSchema,
  listCampaignsSchema,
  listClientsSchema,
  listTeamSchema,
  listTemplatesSchema,
  loseAccountSchema,
  moveStageSchema,
  previewTemplateSchema,
  reassignAccountSchema,
  reportsSchema,
  removeTeamMemberSchema,
  rescheduleActivitySchema,
  searchOrganizationsSchema,
  sendAccountEmailSchema,
  sendCampaignSchema,
  sendTemplateTestSchema,
  templateIdSchema,
  updateCampaignSchema,
  updateLostReasonSchema,
  updateStageSchema,
  updateTeamMemberSchema,
  updateTemplateSchema,
  winAccountSchema,
} from '../schemas/crm.schema'

const router = express.Router()

// Google's return from «Conectar mi Gmail». Declared BEFORE the auth below on purpose: a missing or foreign session must
// land on «Mi Gmail» with `?error=otra-sesion`, not on a bare 401. The session, if any, is read with the same token check
// as every other route, and `completarConexion` demands it be the person who asked for the link (and re-reads their key).
router.get('/gmail/callback', autenticacionOpcional, crmEmailController.gmailCallback)

router.use(authenticateTokenMiddleware)

const ver = requireCrm('crm:ver')
const editar = requireCrm('crm:editar')
const admin = requireCrm('crm:admin')
const exportar = requireCrm('crm:exportar')
// «Campañas masivas» (`crm:campanas`) or the admin: whoever writes the templates and sends the campaigns. It stands alone, without «Ver negocios».
const campanas = requireCrm(['crm:campanas', 'crm:admin'])
// Whoever may use a template reads it: the seller who mails one by one, the campaign owner and the admin.
const leerPlantillas = requireCrm(['crm:contactar', 'crm:campanas', 'crm:admin'])

// Any key opens it: 403 only for whoever holds none.
router.get('/me', requireCrm(CRM_KEYS), crmController.getMe)

// «Equipo de ventas»: who holds which key. The guard goes first, so nobody without `crm:admin` learns anything here.
router.get('/team', admin, validateRequest(listTeamSchema), crmController.listTeam)
// L10: la pantalla vieja (manda `campanas`/`admin`) recibe 409 «recarga la página» antes del esquema, sin escribir nada.
const sinPantallaVieja = (req: Request, _res: Response, next: NextFunction) => {
  assertFormaNuevaDeLlaves(req.body)
  next()
}
router.post('/team', admin, sinPantallaVieja, validateRequest(addTeamMemberSchema), crmController.addTeam)
router.patch('/team/:id', admin, sinPantallaVieja, validateRequest(updateTeamMemberSchema), crmController.updateTeam)
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
// «Eliminar», forever (D7): the real superadmin only — founder, 2-nov — which the service checks; the key is the door.
router.post('/accounts/:id/delete', admin, validateRequest(deleteAccountSchema), crmController.deleteAccount)
router.post('/accounts/:id/notes', editar, validateRequest(addNoteSchema), crmController.addNote)
router.post('/accounts/:id/activities', editar, validateRequest(addActivitySchema), crmController.createActivity)

// What is live in Avoqado for one account; «Ver ventas» is decided inside, so without it the ficha says it is hidden.
router.get('/accounts/:id/live', ver, validateRequest(accountIdSchema), crmController.getLive)

// «Clientes», the reports and the CSV of the filtered list (plan task 9).
router.get('/clients', ver, validateRequest(listClientsSchema), crmController.listClients)
// Prime or any internal or test organization never listed as a client (ruling 39): the admin hides it and brings it back.
router.post('/clients/:organizationId/hide', admin, validateRequest(hideClientSchema), crmController.hideClient)
router.post('/clients/:organizationId/unhide', admin, validateRequest(hideClientSchema), crmController.unhideClient)
// What is live for a client without a CRM account (ruling 47): the same answer and locks as `/accounts/:id/live`.
router.get('/clients/:organizationId/live', ver, validateRequest(hideClientSchema), crmController.getClientLive)
router.get('/reports', ver, validateRequest(reportsSchema), crmController.getReports)
router.get('/export.csv', exportar, validateRequest(exportAccountsSchema), crmController.exportAccountsCsv)

// Activities.
router.post('/activities/:id/done', editar, validateRequest(completeActivitySchema), crmController.markActivityDone)
router.post('/activities/:id/reschedule', editar, validateRequest(rescheduleActivitySchema), crmController.rescheduleActivityHandler)

// Email templates (phase 2). Reading and the preview are for whoever uses them; writing, the test and the pictures are for «Campañas masivas».
router.get('/templates', leerPlantillas, validateRequest(listTemplatesSchema), crmEmailController.listTemplates)
router.post('/templates', campanas, validateRequest(createTemplateSchema), crmEmailController.createTemplate)
router.post('/templates/preview', leerPlantillas, validateRequest(previewTemplateSchema), crmEmailController.previewTemplate)
router.post('/templates/test', campanas, validateRequest(sendTemplateTestSchema), crmEmailController.sendTemplateTest)
router.get('/templates/:id', leerPlantillas, validateRequest(templateIdSchema), crmEmailController.getTemplate)
router.patch('/templates/:id', campanas, validateRequest(updateTemplateSchema), crmEmailController.updateTemplate)
router.post('/templates/:id/archive', campanas, validateRequest(templateIdSchema), crmEmailController.archiveTemplate)
router.post('/templates/:id/unarchive', campanas, validateRequest(templateIdSchema), crmEmailController.unarchiveTemplate)

// Mass-email campaigns (phase 2): all of it for «Campañas masivas» or the admin. Sending is confirmed with the preview's token.
router.get('/campaigns', campanas, validateRequest(listCampaignsSchema), crmEmailController.listCampaigns)
router.post('/campaigns', campanas, validateRequest(createCampaignSchema), crmEmailController.createCampaign)
router.get('/campaigns/:id', campanas, validateRequest(campaignIdSchema), crmEmailController.getCampaign)
router.patch('/campaigns/:id', campanas, validateRequest(updateCampaignSchema), crmEmailController.updateCampaign)
router.post('/campaigns/:id/preview', campanas, validateRequest(campaignIdSchema), crmEmailController.previewCampaign)
router.post('/campaigns/:id/test', campanas, validateRequest(campaignIdSchema), crmEmailController.sendCampaignTest)
router.post('/campaigns/:id/send', campanas, validateRequest(sendCampaignSchema), crmEmailController.sendCampaign)
router.post('/campaigns/:id/cancel', campanas, validateRequest(campaignIdSchema), crmEmailController.cancelCampaign)

// A picture for an `image` block: in memory, at most 5 MB, only the three types `uploadAnnouncementImage` accepts.
const IMAGE_MAX_BYTES = 5 * 1024 * 1024
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const imageUpload = multer({
  storage: multer.memoryStorage(),
  // `+ 1`, as in the HubSpot upload: busboy cuts a file that REACHES the limit, so exactly 5 MB would not pass with the bare number.
  limits: { fileSize: IMAGE_MAX_BYTES + 1, files: 1, fields: 0 },
  // Another type is an error, not a skipped file: otherwise the answer would be «no image arrived».
  fileFilter: (_req, file, accept) =>
    IMAGE_TYPES.includes(file.mimetype) ? accept(null, true) : accept(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname)),
})
const readImage = preserveContext(imageUpload.single('file'))
/** Whatever goes wrong reading the picture — too big, another type, a second file — is the file the client sent, never a 500. */
function imageFile(req: Request, res: Response, next: NextFunction) {
  readImage(req, res, (error?: unknown) => {
    if (!error) return next()
    const multerCode = error instanceof multer.MulterError ? error.code : null
    if (!multerCode)
      logger.warn('[CRM] The image upload could not be read', { error: error instanceof Error ? error.message : String(error) })
    return next(
      new BadRequestError(
        multerCode === 'LIMIT_FILE_SIZE' ? 'La imagen puede pesar hasta 5 MB' : 'Sube una sola imagen PNG, JPG o WEBP',
        'CRM_IMAGEN_INVALIDA',
      ),
    )
  })
}
// The key first: whoever is not allowed never gets 5 MB read into memory.
router.post('/uploads/image', campanas, imageFile, crmEmailController.uploadImage)

// The seller's own Gmail (phase 2, plan task 7): connect it, see it, disconnect it, and «Mandar correo» from the ficha.
// `crm:contactar` only counts on top of «Ver negocios» (`effectiveKeys`), so whoever holds only «Campañas masivas» gets 403.
const contactar = requireCrm('crm:contactar')
router.get('/gmail', contactar, crmEmailController.gmailStatus)
router.get('/gmail/connect', contactar, crmEmailController.gmailConnect)
router.post('/gmail/disconnect', contactar, crmEmailController.gmailDisconnect)
router.post('/accounts/:id/emails', contactar, validateRequest(sendAccountEmailSchema), crmEmailController.sendAccountEmail)

// «Dar de baja este correo» (the opposition, from the ficha): the person stops receiving anything from Avoqado. Only the CRM admin.
router.post('/opt-outs', admin, validateRequest(createOptOutSchema), crmEmailController.createOptOut)

// «Importar lo de HubSpot», once: the contacts CSV and the deals CSV, in memory, at most 5 MB each.
const HUBSPOT_FILE_MAX_BYTES = 5 * 1024 * 1024
// `+ 1`: busboy cuts a file that REACHES the limit, so a file of exactly 5 MB would not pass with the bare number.
// `fields: 0`: nothing but the two files.
const hubspotUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: HUBSPOT_FILE_MAX_BYTES + 1, files: 2, fields: 0 } })
const readHubspotFiles = preserveContext(
  hubspotUpload.fields([
    { name: 'contactos', maxCount: 1 },
    { name: 'negocios', maxCount: 1 },
  ]),
)
/**
 * Whatever goes wrong reading the upload — too big, a third file, a field, a broken multipart — is the file the client
 * sent, never a 500: the storage is memory, there is nothing of ours that can fail here.
 */
function hubspotFiles(req: Request, res: Response, next: NextFunction) {
  readHubspotFiles(req, res, (error?: unknown) => {
    if (!error) return next()
    const multerCode = error instanceof multer.MulterError ? error.code : null
    // A broken multipart is busboy's, not multer's: without this line nobody could tell why that upload failed.
    if (!multerCode)
      logger.warn('[CRM] The HubSpot upload could not be read', { error: error instanceof Error ? error.message : String(error) })
    const message =
      multerCode === 'LIMIT_FILE_SIZE'
        ? 'Cada archivo puede pesar hasta 5 MB'
        : 'Sube sólo los dos archivos de HubSpot: contactos y negocios'
    return next(new ValidationError(message, 'CRM_IMPORT_ARCHIVO_INVALIDO', multerCode ? { multerCode } : undefined))
  })
}
// The key first: whoever is not an admin of the CRM never gets 10 MB read into memory.
router.post('/import/hubspot/preview', admin, hubspotFiles, crmController.previewHubspotImport)
router.post('/import/hubspot/apply', admin, hubspotFiles, crmController.applyHubspotImport)

export default router
