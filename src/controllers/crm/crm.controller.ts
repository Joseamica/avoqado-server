import { Request, Response } from 'express'
import { ValidationError } from '../../errors/AppError'
import { hubspotImportFilesSchema } from '../../schemas/crm.schema'
import * as accounts from '../../services/crm/accounts.service'
import { addActivity, completeActivity, rescheduleActivity } from '../../services/crm/activities.service'
import * as clients from '../../services/crm/clients.service'
import * as erase from '../../services/crm/erase.service'
import { applyHubspot, previewHubspot } from '../../services/crm/hubspotImport.service'
import * as reports from '../../services/crm/reports.service'
import { addTeamMember, listTeamMembers, listTeamOptions, removeTeamMember, updateTeamMember } from '../../services/crm/teamVenue.service'
import { DEFAULT_TIMEZONE, formatInVenueTimezone } from '../../utils/datetime'

/**
 * GET /api/v1/crm/me — the caller's own CRM keys, so the console shows only the sections they open.
 * `requireCrm` already read them from the database for this request.
 */
export function getMe(req: Request, res: Response): void {
  res.json({ data: req.crmAccess })
}

// «Equipo de ventas» (`crm:equipo`). `req.crmAccess` is the caller's own keys, read by `requireCrm` for this request.

/** GET /api/v1/crm/team */
export async function listTeam(req: Request, res: Response): Promise<void> {
  // `validateRequest(listTeamSchema)` already turned them into numbers.
  const { page, pageSize } = req.query as unknown as { page?: number; pageSize?: number }
  res.json(await listTeamMembers({ page, pageSize }))
}

/** POST /api/v1/crm/team */
export async function addTeam(req: Request, res: Response): Promise<void> {
  res.status(201).json({ data: await addTeamMember(req.crmAccess!, req.body) })
}

/** PATCH /api/v1/crm/team/:id */
export async function updateTeam(req: Request, res: Response): Promise<void> {
  res.json({ data: await updateTeamMember(req.crmAccess!, req.params.id, req.body.keys, req.body.expectedKeys) })
}

/** DELETE /api/v1/crm/team/:id */
export async function removeTeam(req: Request, res: Response): Promise<void> {
  res.json({ data: await removeTeamMember(req.crmAccess!, req.params.id, { reasignarA: req.body.reasignarA }) })
}

/** GET /api/v1/crm/team/options — the owner selector of the ficha; `[]` for whoever cannot reassign. */
export async function teamOptions(req: Request, res: Response): Promise<void> {
  res.json({ data: await listTeamOptions(req.crmAccess!) })
}

// The pipeline. Every handler receives the body and query `validateRequest` already parsed, and the caller's keys.

/** GET /api/v1/crm/pending — «Mis pendientes». */
export async function pending(req: Request, res: Response): Promise<void> {
  res.json({ data: await accounts.getPending(req.crmAccess!) })
}

/** GET /api/v1/crm/stages */
export async function listStages(_req: Request, res: Response): Promise<void> {
  res.json({ data: await accounts.listStages() })
}

/** POST /api/v1/crm/stages */
export async function createStage(req: Request, res: Response): Promise<void> {
  res.status(201).json({ data: await accounts.createStage(req.crmAccess!, req.body) })
}

/** PATCH /api/v1/crm/stages/:id */
export async function updateStage(req: Request, res: Response): Promise<void> {
  res.json({ data: await accounts.updateStage(req.crmAccess!, req.params.id, req.body) })
}

/** GET /api/v1/crm/lost-reasons */
export async function listLostReasons(_req: Request, res: Response): Promise<void> {
  res.json({ data: await accounts.listLostReasons() })
}

/** POST /api/v1/crm/lost-reasons */
export async function createLostReason(req: Request, res: Response): Promise<void> {
  res.status(201).json({ data: await accounts.createLostReason(req.crmAccess!, req.body) })
}

/** PATCH /api/v1/crm/lost-reasons/:id */
export async function updateLostReason(req: Request, res: Response): Promise<void> {
  res.json({ data: await accounts.updateLostReason(req.crmAccess!, req.params.id, req.body) })
}

/** GET /api/v1/crm/organizations/search?q= */
export async function searchOrganizations(req: Request, res: Response): Promise<void> {
  res.json({ data: await accounts.searchOrganizations(req.crmAccess!, String(req.query.q)) })
}

/** GET /api/v1/crm/accounts */
export async function listAccounts(req: Request, res: Response): Promise<void> {
  // `validateRequest(listAccountsSchema)` already turned the flags and the limit into booleans and a number.
  const { rows, nextCursor, total } = await accounts.listAccounts(req.crmAccess!, req.query as unknown as accounts.AccountFilters)
  res.json({ data: rows, meta: { total, nextCursor } })
}

/** POST /api/v1/crm/accounts */
export async function createAccount(req: Request, res: Response): Promise<void> {
  const { confirmarOtroNegocio, ...input } = req.body
  res.status(201).json({ data: await accounts.createManual(req.crmAccess!, input, { confirmarOtroNegocio }) })
}

/** GET /api/v1/crm/accounts/:id */
export async function getAccount(req: Request, res: Response): Promise<void> {
  res.json({ data: await accounts.getAccount(req.crmAccess!, req.params.id) })
}

/** POST /api/v1/crm/accounts/:id/take */
export async function takeAccount(req: Request, res: Response): Promise<void> {
  res.json({ data: await accounts.takeAccount(req.crmAccess!, req.params.id) })
}

/** POST /api/v1/crm/accounts/:id/reassign */
export async function reassignAccount(req: Request, res: Response): Promise<void> {
  res.json({ data: await accounts.reassign(req.crmAccess!, req.params.id, req.body.staffId) })
}

/** POST /api/v1/crm/accounts/:id/stage */
export async function moveStage(req: Request, res: Response): Promise<void> {
  res.json({ data: await accounts.moveStage(req.crmAccess!, req.params.id, req.body.stageId) })
}

/** POST /api/v1/crm/accounts/:id/lose */
export async function loseAccount(req: Request, res: Response): Promise<void> {
  res.json({ data: await accounts.lose(req.crmAccess!, req.params.id, req.body) })
}

/** POST /api/v1/crm/accounts/:id/win */
export async function winAccount(req: Request, res: Response): Promise<void> {
  res.json({ data: await accounts.win(req.crmAccess!, req.params.id, req.body) })
}

/** POST /api/v1/crm/accounts/:id/archive */
export async function archiveAccount(req: Request, res: Response): Promise<void> {
  res.json({ data: await accounts.archive(req.crmAccess!, req.params.id) })
}

/** POST /api/v1/crm/accounts/:id/delete — the real superadmin only; the service says so with a 403 to anyone else. */
export async function deleteAccount(req: Request, res: Response): Promise<void> {
  res.json({ data: await erase.deleteAccount(req.crmAccess!, req.params.id, req.body.confirmName) })
}

/** POST /api/v1/crm/accounts/:id/reactivate */
export async function reactivateAccount(req: Request, res: Response): Promise<void> {
  res.json({ data: await accounts.reactivate(req.crmAccess!, req.params.id) })
}

/** POST /api/v1/crm/accounts/:id/notes */
export async function addNote(req: Request, res: Response): Promise<void> {
  res.status(201).json({ data: await accounts.addNote(req.crmAccess!, req.params.id, req.body) })
}

/** POST /api/v1/crm/accounts/:id/activities */
export async function createActivity(req: Request, res: Response): Promise<void> {
  res.status(201).json({ data: await addActivity(req.crmAccess!, req.params.id, req.body) })
}

/** POST /api/v1/crm/activities/:id/done */
export async function markActivityDone(req: Request, res: Response): Promise<void> {
  res.json({ data: await completeActivity(req.crmAccess!, req.params.id, req.body) })
}

/** POST /api/v1/crm/activities/:id/reschedule — `{ dueAt }` (ruling 55). */
export async function rescheduleActivityHandler(req: Request, res: Response): Promise<void> {
  res.json({ data: await rescheduleActivity(req.crmAccess!, req.params.id, req.body) })
}

// Clients, what is live in Avoqado, reports and the CSV export (plan task 9).

/** GET /api/v1/crm/clients */
export async function listClients(req: Request, res: Response): Promise<void> {
  // `validateRequest(listClientsSchema)` already turned the limit into a number.
  const { rows, nextCursor, total, conteos, legible } = await clients.listClients(
    req.crmAccess!,
    req.query as unknown as clients.ClientFilters,
  )
  // `legible: 1` = this server filters and paints the C1 columns; a new SUPERADMIN sends no new filter before seeing it.
  res.json({ data: rows, meta: { total, nextCursor, legible, conteos } })
}

/** POST /api/v1/crm/clients/:organizationId/hide — «Ocultar de Clientes» (ruling 39). */
export async function hideClient(req: Request, res: Response): Promise<void> {
  res.json({ data: await clients.hideClient(req.crmAccess!, req.params.organizationId) })
}

/** POST /api/v1/crm/clients/:organizationId/unhide */
export async function unhideClient(req: Request, res: Response): Promise<void> {
  res.json({ data: await clients.unhideClient(req.crmAccess!, req.params.organizationId) })
}

/** POST /api/v1/crm/clients/:organizationId/cuenta — the client's CRM account, made once (C1, task 6). */
export async function ensureClientAccount(req: Request, res: Response): Promise<void> {
  res.json({ data: await clients.ensureClientAccount(req.crmAccess!, req.params.organizationId) })
}

/** POST /api/v1/crm/accounts/:id/usa — «✋ a mano» en Usa (C1, task 7). */
export async function setUsa(req: Request, res: Response): Promise<void> {
  res.json({ data: await clients.setUsa(req.crmAccess!, req.params.id, req.body) })
}

/** POST /api/v1/crm/accounts/:id/alta — «¿Por qué se quedó?» (C1, task 8). */
export async function setAltaMotivo(req: Request, res: Response): Promise<void> {
  res.json({ data: await clients.setAltaMotivo(req.crmAccess!, req.params.id, req.body) })
}

/** GET /api/v1/crm/accounts/:id/live — `{ ligada: false }` when the account has no Organization yet. */
export async function getLive(req: Request, res: Response): Promise<void> {
  res.json({ data: await clients.getLive(req.crmAccess!, req.params.id) })
}

/** GET /api/v1/crm/clients/:organizationId/live — the same answer for a client without a CRM account (ruling 47). */
export async function getClientLive(req: Request, res: Response): Promise<void> {
  res.json({ data: await clients.getClientLive(req.crmAccess!, req.params.organizationId) })
}

/** GET /api/v1/crm/reports?desde=&hasta= */
export async function getReports(req: Request, res: Response): Promise<void> {
  res.json({ data: await reports.getReports(req.crmAccess!, req.query as unknown as { desde: string; hasta: string }) })
}

/**
 * GET /api/v1/crm/export.csv — the file, with the real total and whether it was cut at 10,000 in headers the browser may
 * read. The BOM makes Excel read the accents as UTF-8.
 */
export async function exportAccountsCsv(req: Request, res: Response): Promise<void> {
  const { csv, total, truncado } = await reports.exportAccountsCsv(req.crmAccess!, req.query as unknown as reports.ExportFilters)
  const today = formatInVenueTimezone(new Date(), DEFAULT_TIMEZONE, 'yyyy-MM-dd')
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="negocios-crm-${today}.csv"`)
  res.setHeader('X-Total-Count', String(total))
  res.setHeader('X-Export-Truncated', String(truncado))
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Total-Count, X-Export-Truncated')
  res.send(`\uFEFF${csv}`)
}

// «Importar lo de HubSpot» (`crm:configurar`). Both receive the two CSVs multer read into memory.

/**
 * A file as text, only if it is UTF-8 (M-5). Re-saved by Excel as ANSI, «José» would decode to «Jos�» without a word; the
 * strict decoder refuses those bytes, while a «�» HubSpot already had in a name — valid UTF-8 — still comes in.
 */
function utf8(buffer: Buffer, archivo: 'contactos' | 'negocios'): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    throw new ValidationError(
      `El archivo de ${archivo} no está en UTF-8: guárdalo como «CSV UTF-8» o expórtalo de nuevo desde HubSpot`,
      'CRM_IMPORT_ARCHIVO_INVALIDO',
    )
  }
}

/** The contacts and deals files as text; 422 when one is missing or is not UTF-8. */
function hubspotCsvs(req: Request): { contactos: string; negocios: string } {
  const files = hubspotImportFilesSchema.safeParse(req.files)
  if (!files.success) throw new ValidationError(files.error.errors[0].message, 'CRM_IMPORT_ARCHIVO_INVALIDO')
  return { contactos: utf8(files.data.contactos[0].buffer, 'contactos'), negocios: utf8(files.data.negocios[0].buffer, 'negocios') }
}

/** POST /api/v1/crm/import/hubspot/preview — what importing would do. Writes nothing. */
export async function previewHubspotImport(req: Request, res: Response): Promise<void> {
  const { contactos, negocios } = hubspotCsvs(req)
  res.json({ data: await previewHubspot(contactos, negocios) })
}

/** POST /api/v1/crm/import/hubspot/apply */
export async function applyHubspotImport(req: Request, res: Response): Promise<void> {
  const { contactos, negocios } = hubspotCsvs(req)
  // A multipart FIELD, not a URL param: a SERVIDOR that does not know it refuses the upload (`fields: 0`) instead of
  // importing without the consent the person asked for.
  const box = req.body?.aceptaronCorreos
  if (box !== undefined && box !== 'true' && box !== 'false') {
    throw new ValidationError('La casilla de los correos no es válida', 'CRM_IMPORT_ARCHIVO_INVALIDO')
  }
  res.json({ data: await applyHubspot(req.crmAccess!, contactos, negocios, { aceptaronCorreos: box === 'true' }) })
}
