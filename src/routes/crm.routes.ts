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
  campaignTestSchema,
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
  listRecipientsSchema,
  searchCampaignPeopleSchema,
  listClientsSchema,
  listTeamSchema,
  listTemplatesSchema,
  loseAccountSchema,
  moveStageSchema,
  previewCampaignSchema,
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

// Las llaves finas (plan 2026-11-04, L4–L9). 🔴 Ninguna ruta pide `crm:campanas` ni `crm:admin`: son sólo el espejo que
// `/me` y `/team` le siguen mandando a la pantalla vieja, y no autorizan nada.
const ver = requireCrm('crm:ver')
const editar = requireCrm('crm:editar')
const exportar = requireCrm('crm:exportar')
// L9: ganar y perder. Sólo vale encima de «Editar» y en su alcance (L1). Reabrir por `stage` lo decide el servicio.
// «Regresar al embudo» (`reactivate`) desarchiva, no reabre un cierre: pide «Editar», igual que archivar.
const cerrar = requireCrm('crm:cerrar')
// L6: el equipo de ventas y sus llaves.
const equipo = requireCrm('crm:equipo')
// L7: ordenar el archivero (etapas, motivos, ocultos, importar) y la puerta de «Eliminar».
const configurar = requireCrm('crm:configurar')
// L4: escribir plantillas, archivarlas y su correo de prueba. Va sola, sin «Ver negocios».
const plantillas = requireCrm('crm:plantillas')
// L4: lee las plantillas quien las usa: el uno a uno, quien las escribe y quien arma campañas.
const leerPlantillas = requireCrm(['crm:contactar', 'crm:plantillas', 'crm:preparar'])
// L5: lista, detalle y conteo de campañas. «Ver campañas» es la efectiva: también la traen «Preparar» y «Mandar» (L1).
const verCampanas = requireCrm('crm:ver-campanas')
// L5: crear, editar y probar una campaña.
const preparar = requireCrm('crm:preparar')
// L5: mandarla y cancelarla. Mandar exige la prueba de esa versión, que es de quien prepara.
const mandar = requireCrm('crm:mandar')

// Any key opens it: 403 only for whoever holds none.
router.get('/me', requireCrm(CRM_KEYS), crmController.getMe)

// «Equipo de ventas»: who holds which key. The guard goes first, so nobody without «Equipo y llaves» learns anything here.
router.get('/team', equipo, validateRequest(listTeamSchema), crmController.listTeam)
// L10: la pantalla vieja (manda `campanas`/`admin`) recibe 409 «recarga la página» antes del esquema, sin escribir nada.
const sinPantallaVieja = (req: Request, _res: Response, next: NextFunction) => {
  assertFormaNuevaDeLlaves(req.body)
  next()
}
router.post('/team', equipo, sinPantallaVieja, validateRequest(addTeamMemberSchema), crmController.addTeam)
router.patch('/team/:id', equipo, sinPantallaVieja, validateRequest(updateTeamMemberSchema), crmController.updateTeam)
router.delete('/team/:id', equipo, validateRequest(removeTeamMemberSchema), crmController.removeTeam)
// The ficha's owner selector (ruling 13). The service hands the names only to whoever can reassign (equipo o «Editar: todos»).
router.get('/team/options', requireCrm(['crm:equipo', 'crm:editar']), crmController.teamOptions)

// «Mis pendientes», where the CRM opens.
router.get('/pending', ver, crmController.pending)

// Stages and lost reasons: whoever sees the pipeline reads them; «Configurar el CRM» edits them even without «Ver negocios» (L7).
router.get('/stages', requireCrm(['crm:ver', 'crm:configurar']), crmController.listStages)
router.post('/stages', configurar, validateRequest(createStageSchema), crmController.createStage)
router.patch('/stages/:id', configurar, validateRequest(updateStageSchema), crmController.updateStage)
router.get('/lost-reasons', requireCrm(['crm:ver', 'crm:configurar']), crmController.listLostReasons)
router.post('/lost-reasons', configurar, validateRequest(createLostReasonSchema), crmController.createLostReason)
router.patch('/lost-reasons/:id', configurar, validateRequest(updateLostReasonSchema), crmController.updateLostReason)

// What «Ganar» links an account to.
router.get('/organizations/search', editar, validateRequest(searchOrganizationsSchema), crmController.searchOrganizations)

// Accounts.
router.get('/accounts', ver, validateRequest(listAccountsSchema), crmController.listAccounts)
router.post('/accounts', editar, validateRequest(createAccountSchema), crmController.createAccount)
router.get('/accounts/:id', ver, validateRequest(accountIdSchema), crmController.getAccount)
router.post('/accounts/:id/take', editar, validateRequest(accountIdSchema), crmController.takeAccount)
// «Editar: todos» o «Equipo y llaves» (L6): the service decides, so a «propios» seller gets a 403 that says why.
router.post(
  '/accounts/:id/reassign',
  requireCrm(['crm:editar', 'crm:equipo']),
  validateRequest(reassignAccountSchema),
  crmController.reassignAccount,
)
// Mover uno abierto pide «Editar»; reabrir uno GANADO o PERDIDO pide además «Cerrar negocios» (lo revisa `moveStage`, L9).
router.post('/accounts/:id/stage', editar, validateRequest(moveStageSchema), crmController.moveStage)
router.post('/accounts/:id/lose', cerrar, validateRequest(loseAccountSchema), crmController.loseAccount)
router.post('/accounts/:id/win', cerrar, validateRequest(winAccountSchema), crmController.winAccount)
router.post('/accounts/:id/archive', editar, validateRequest(accountIdSchema), crmController.archiveAccount)
router.post('/accounts/:id/reactivate', editar, validateRequest(accountIdSchema), crmController.reactivateAccount)
// «Eliminar», forever (D7): the real superadmin only — founder, 2-nov — which the service checks; «Configurar» is the door (L7).
router.post('/accounts/:id/delete', configurar, validateRequest(deleteAccountSchema), crmController.deleteAccount)
router.post('/accounts/:id/notes', editar, validateRequest(addNoteSchema), crmController.addNote)
router.post('/accounts/:id/activities', editar, validateRequest(addActivitySchema), crmController.createActivity)

// What is live in Avoqado for one account; «Ver ventas» is decided inside, so without it the ficha says it is hidden.
router.get('/accounts/:id/live', ver, validateRequest(accountIdSchema), crmController.getLive)

// «Clientes», the reports and the CSV of the filtered list (plan task 9).
router.get('/clients', ver, validateRequest(listClientsSchema), crmController.listClients)
// Prime or any internal or test organization never listed as a client (ruling 39): «Configurar el CRM» hides it and brings it back.
router.post('/clients/:organizationId/hide', configurar, validateRequest(hideClientSchema), crmController.hideClient)
router.post('/clients/:organizationId/unhide', configurar, validateRequest(hideClientSchema), crmController.unhideClient)
// The CRM account of a client that has none, made once (C1): «Editar» with its scope; the service reads it through «Ver».
router.post('/clients/:organizationId/cuenta', editar, validateRequest(hideClientSchema), crmController.ensureClientAccount)
// What is live for a client without a CRM account (ruling 47): the same answer and locks as `/accounts/:id/live`.
router.get('/clients/:organizationId/live', ver, validateRequest(hideClientSchema), crmController.getClientLive)
router.get('/reports', ver, validateRequest(reportsSchema), crmController.getReports)
router.get('/export.csv', exportar, validateRequest(exportAccountsSchema), crmController.exportAccountsCsv)

// Activities.
router.post('/activities/:id/done', editar, validateRequest(completeActivitySchema), crmController.markActivityDone)
router.post('/activities/:id/reschedule', editar, validateRequest(rescheduleActivitySchema), crmController.rescheduleActivityHandler)

// Email templates (phase 2, L4). Reading is for whoever uses them; writing and the test, for «Plantillas». The preview also
// for whoever sees campaigns (`VistaPrevia` inside a campaign): with `contexto` it reads the account with the «Ver» scope.
router.get('/templates', leerPlantillas, validateRequest(listTemplatesSchema), crmEmailController.listTemplates)
router.post('/templates', plantillas, validateRequest(createTemplateSchema), crmEmailController.createTemplate)
router.post(
  '/templates/preview',
  requireCrm(['crm:contactar', 'crm:plantillas', 'crm:preparar', 'crm:ver-campanas']),
  validateRequest(previewTemplateSchema),
  crmEmailController.previewTemplate,
)
router.post('/templates/test', plantillas, validateRequest(sendTemplateTestSchema), crmEmailController.sendTemplateTest)
router.get('/templates/:id', leerPlantillas, validateRequest(templateIdSchema), crmEmailController.getTemplate)
router.patch('/templates/:id', plantillas, validateRequest(updateTemplateSchema), crmEmailController.updateTemplate)
router.post('/templates/:id/archive', plantillas, validateRequest(templateIdSchema), crmEmailController.archiveTemplate)
router.post('/templates/:id/unarchive', plantillas, validateRequest(templateIdSchema), crmEmailController.unarchiveTemplate)

// Mass-email campaigns (phase 2, L5): see, prepare, send. Sending is confirmed with the preview's token.
router.get('/campaigns', verCampanas, validateRequest(listCampaignsSchema), crmEmailController.listCampaigns)
router.post('/campaigns', preparar, validateRequest(createCampaignSchema), crmEmailController.createCampaign)
router.get('/campaigns/:id', verCampanas, validateRequest(campaignIdSchema), crmEmailController.getCampaign)
// «Ver quiénes»: la lista de a quién le llega un borrador, una consulta por página y sin total.
router.get('/campaigns/:id/recipients', verCampanas, validateRequest(listRecipientsSchema), crmEmailController.listRecipients)
// «Agregar»: busca a quién sumar a un borrador, sólo entre personas visibles del CRM. Sólo quien edita el público.
router.get('/campaign-people', preparar, validateRequest(searchCampaignPeopleSchema), crmEmailController.searchCampaignPeople)
router.patch('/campaigns/:id', preparar, validateRequest(updateCampaignSchema), crmEmailController.updateCampaign)
router.post('/campaigns/:id/preview', verCampanas, validateRequest(previewCampaignSchema), crmEmailController.previewCampaign)
router.post('/campaigns/:id/test', preparar, validateRequest(campaignTestSchema), crmEmailController.sendCampaignTest)
router.post('/campaigns/:id/send', mandar, validateRequest(sendCampaignSchema), crmEmailController.sendCampaign)
router.post('/campaigns/:id/cancel', mandar, validateRequest(campaignIdSchema), crmEmailController.cancelCampaign)
// A quién se le puede mandar la prueba: sólo nombres (nunca correos); la ven quienes pueden pedirla.
router.get('/test-recipients', requireCrm(['crm:plantillas', 'crm:preparar']), crmEmailController.testRecipients)

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
// The key first: whoever is not allowed never gets 5 MB read into memory. Plantillas y campañas llevan imágenes (L4).
router.post('/uploads/image', requireCrm(['crm:plantillas', 'crm:preparar']), imageFile, crmEmailController.uploadImage)

// The seller's own Gmail (phase 2, plan task 7): connect it, see it, disconnect it, and «Mandar correo» from the ficha.
// `crm:contactar` only counts on top of «Ver negocios» (`effectiveKeys`), so whoever holds only the mass-email keys gets 403.
const contactar = requireCrm('crm:contactar')
router.get('/gmail', contactar, crmEmailController.gmailStatus)
router.get('/gmail/connect', contactar, crmEmailController.gmailConnect)
router.post('/gmail/disconnect', contactar, crmEmailController.gmailDisconnect)
router.post('/accounts/:id/emails', contactar, validateRequest(sendAccountEmailSchema), crmEmailController.sendAccountEmail)

// «Dar de baja este correo» (the opposition, from the ficha): the person stops receiving anything from Avoqado. «Bajas de
// correo», que va sola (L1, L8).
router.post('/opt-outs', requireCrm('crm:bajas'), validateRequest(createOptOutSchema), crmEmailController.createOptOut)

// «Importar lo de HubSpot», once: the contacts CSV and the deals CSV, in memory, at most 5 MB each.
const HUBSPOT_FILE_MAX_BYTES = 5 * 1024 * 1024
// `+ 1`: busboy cuts a file that REACHES the limit, so a file of exactly 5 MB would not pass with the bare number.
// `fields: 1`: the two files and the box `aceptaronCorreos` (an older SERVIDOR has 0: it refuses the field, so no import
// goes without the consent that was asked for).
const hubspotUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: HUBSPOT_FILE_MAX_BYTES + 1, files: 2, fields: 1 } })
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
// The key first: whoever does not configure the CRM never gets 10 MB read into memory (L7).
router.post('/import/hubspot/preview', configurar, hubspotFiles, crmController.previewHubspotImport)
router.post('/import/hubspot/apply', configurar, hubspotFiles, crmController.applyHubspotImport)

export default router
