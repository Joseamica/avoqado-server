import { Request, Response } from 'express'
import { BadRequestError } from '../../errors/AppError'
import { uploadAnnouncementImage } from '../../services/announcements/announcementImage.service'
import { optOut } from '../../services/crm/email/optOut.service'
import * as campaigns from '../../services/crm/email/campaigns.service'
import * as templates from '../../services/crm/email/templates.service'

// Email templates, preview, «Envíame una prueba» and images (phase 2). `req.crmAccess` is the caller's own keys, read by
// `requireCrm` for this request; `validateRequest` already parsed the body and the query.

/** GET /api/v1/crm/templates */
export async function listTemplates(req: Request, res: Response): Promise<void> {
  const { rows, nextCursor, total } = await templates.listTemplates(req.query as unknown as templates.ListTemplatesQuery)
  res.json({ data: rows, meta: { total, nextCursor } })
}

/** GET /api/v1/crm/templates/:id */
export async function getTemplate(req: Request, res: Response): Promise<void> {
  res.json({ data: await templates.getTemplate(req.params.id) })
}

/** POST /api/v1/crm/templates */
export async function createTemplate(req: Request, res: Response): Promise<void> {
  res.status(201).json({ data: await templates.createTemplate(req.crmAccess!, req.body) })
}

/** PATCH /api/v1/crm/templates/:id */
export async function updateTemplate(req: Request, res: Response): Promise<void> {
  res.json({ data: await templates.updateTemplate(req.crmAccess!, req.params.id, req.body) })
}

/** POST /api/v1/crm/templates/:id/archive */
export async function archiveTemplate(req: Request, res: Response): Promise<void> {
  res.json({ data: await templates.archiveTemplate(req.crmAccess!, req.params.id) })
}

/** POST /api/v1/crm/templates/:id/unarchive */
export async function unarchiveTemplate(req: Request, res: Response): Promise<void> {
  res.json({ data: await templates.unarchiveTemplate(req.crmAccess!, req.params.id) })
}

/** POST /api/v1/crm/templates/preview — nothing is saved or sent. */
export async function previewTemplate(req: Request, res: Response): Promise<void> {
  res.json({ data: await templates.previewTemplate(req.body, req.crmAccess!) })
}

/** POST /api/v1/crm/templates/test — «Envíame una prueba». A refusal is a 200 with `ok: false` and why, never a 500. */
export async function sendTemplateTest(req: Request, res: Response): Promise<void> {
  res.json({ data: await templates.sendTestToSelf(req.crmAccess!, req.body) })
}

/** POST /api/v1/crm/uploads/image — a picture for an `image` block; its public URL. */
export async function uploadImage(req: Request, res: Response): Promise<void> {
  const file = req.file
  if (!file) throw new BadRequestError('No llegó ninguna imagen', 'CRM_IMAGEN_INVALIDA')
  res.json({ data: { url: await uploadAnnouncementImage(file.buffer, file.mimetype, file.originalname) } })
}

/**
 * POST /api/v1/crm/opt-outs — «Dar de baja este correo» desde la ficha (la oposición): ya no recibe nada de Avoqado. Sólo
 * `crm:admin`. Idempotente: darlo de baja otra vez contesta igual.
 */
export async function createOptOut(req: Request, res: Response): Promise<void> {
  await optOut(req.body.email, 'ADMIN', req.crmAccess!.staffId)
  res.json({ data: { ok: true } })
}

// Mass-email campaigns (phase 2, plan task 5). Every route is for «Campañas masivas» (`crm:campanas`) or the admin.

/** GET /api/v1/crm/campaigns */
export async function listCampaigns(req: Request, res: Response): Promise<void> {
  const { rows, nextCursor, total } = await campaigns.listCampaigns(req.query as unknown as campaigns.ListCampaignsQuery)
  res.json({ data: rows, meta: { total, nextCursor } })
}

/** GET /api/v1/crm/campaigns/:id — with its counters by delivery status. */
export async function getCampaign(req: Request, res: Response): Promise<void> {
  res.json({ data: await campaigns.getCampaign(req.params.id) })
}

/** POST /api/v1/crm/campaigns — a draft from a template. */
export async function createCampaign(req: Request, res: Response): Promise<void> {
  res.status(201).json({ data: await campaigns.createCampaign(req.crmAccess!, req.body) })
}

/** PATCH /api/v1/crm/campaigns/:id — only while it is a draft. */
export async function updateCampaign(req: Request, res: Response): Promise<void> {
  res.json({ data: await campaigns.updateCampaign(req.crmAccess!, req.params.id, req.body) })
}

/** POST /api/v1/crm/campaigns/:id/preview — how many get it now, and the token to confirm exactly that. */
export async function previewCampaign(req: Request, res: Response): Promise<void> {
  res.json({ data: await campaigns.previewSend(req.crmAccess!, req.params.id) })
}

/** POST /api/v1/crm/campaigns/:id/test — «Envíame una prueba» of this version. A refusal is a 200 with `ok: false` and why. */
export async function sendCampaignTest(req: Request, res: Response): Promise<void> {
  res.json({ data: await campaigns.sendCampaignTest(req.crmAccess!, req.params.id) })
}

/** POST /api/v1/crm/campaigns/:id/send — «Mandar a N personas». */
export async function sendCampaign(req: Request, res: Response): Promise<void> {
  res.json({ data: await campaigns.enqueueCampaign(req.crmAccess!, req.params.id, req.body.token) })
}

/** POST /api/v1/crm/campaigns/:id/cancel */
export async function cancelCampaign(req: Request, res: Response): Promise<void> {
  res.json({ data: await campaigns.cancelCampaign(req.crmAccess!, req.params.id) })
}
