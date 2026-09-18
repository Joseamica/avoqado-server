/**
 * Campañas ligeras de lanzamiento — controlador de superadmin (spec 2026-09-17 § 3.4).
 *
 * 🔴 El guardia NO se repite aquí ni en la subruta: el router padre (`superadmin.routes.ts`)
 * ya aplica `authenticateTokenMiddleware` + `authorizeRole([StaffRole.SUPERADMIN])`. Hay una
 * prueba de supertest que comprueba que un OWNER y un ADMIN reciben 403 de verdad.
 */
import { NextFunction, Request, Response } from 'express'
import { z } from 'zod'
import { BadRequestError } from '../../errors/AppError'
import {
  activateBody,
  createLaunchCampaignBody,
  listQuery,
  offerFields,
  redemptionListQuery,
  statusReasonBody,
  updateLaunchCampaignBody,
} from '../../services/launchCampaigns/launchCampaign.schema'
import {
  createLaunchCampaign,
  endLaunchCampaign,
  getLaunchCampaignDetail,
  listLaunchCampaigns,
  listRedemptions,
  pauseLaunchCampaign,
  updateLaunchCampaign,
} from '../../services/launchCampaigns/launchCampaign.service'
import { activateLaunchCampaign, previewLaunchOffer } from '../../services/launchCampaigns/launchCampaignStripe.service'

/**
 * Traduce un `ZodError` a un 400 legible.
 *
 * 🔴 Sin esto, el compositor recibe el JSON crudo de Zod con un 500 — falla del servidor cuando
 * en realidad falta un dato del formulario. Es el mismo defecto que el founder encontró en los
 * anuncios el 2026-08-27; se cierra por adelantado aquí.
 */
function errorDeValidacion(error: unknown): BadRequestError | null {
  if (!(error instanceof z.ZodError)) return null
  const CAMPOS: Record<string, string> = {
    code: 'el código',
    name: 'el nombre',
    landingSlug: 'la dirección de la página',
    planTier: 'el plan',
    advertisedPriceCents: 'el precio anunciado',
    discountMonths: 'los meses de promoción',
    redemptionCap: 'el cupo',
    validFrom: 'la fecha de inicio',
    validUntil: 'la fecha de fin',
    reason: 'el motivo',
    expectedUpdatedAt: 'la versión de la ficha',
  }
  const detalles = error.issues.map(issue => {
    const campo = CAMPOS[String(issue.path[0])] ?? String(issue.path[0])
    return `${campo}: ${issue.message}`
  })
  return new BadRequestError(detalles.join('. '), 'LAUNCH_CAMPAIGN_INVALID')
}

const actor = (req: Request): string | null => (req as unknown as { authContext?: { userId?: string } }).authContext?.userId ?? null

export const list = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = listQuery.parse(req.query)
    const { data, meta } = await listLaunchCampaigns(query)
    res.json({ success: true, data, meta })
  } catch (error) {
    next(errorDeValidacion(error) ?? error)
  }
}

export const detail = async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: await getLaunchCampaignDetail(req.params.id) })
  } catch (error) {
    next(error)
  }
}

export const create = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = createLaunchCampaignBody.parse(req.body)
    res.status(201).json({ success: true, data: await createLaunchCampaign(body, actor(req)) })
  } catch (error) {
    next(errorDeValidacion(error) ?? error)
  }
}

export const update = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = updateLaunchCampaignBody.parse(req.body)
    res.json({ success: true, data: await updateLaunchCampaign(req.params.id, body, actor(req)) })
  } catch (error) {
    next(errorDeValidacion(error) ?? error)
  }
}

/** Vista previa de los montos. SOLO lee de Stripe: nunca crea un cupón. */
export const preview = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = offerFields.parse(req.body)
    res.json({ success: true, data: await previewLaunchOffer(body) })
  } catch (error) {
    next(errorDeValidacion(error) ?? error)
  }
}

export const activate = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { reason } = activateBody.parse(req.body ?? {})
    res.json({ success: true, data: await activateLaunchCampaign(req.params.id, actor(req), reason) })
  } catch (error) {
    next(errorDeValidacion(error) ?? error)
  }
}

export const pause = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { reason } = statusReasonBody.parse(req.body)
    res.json({ success: true, data: await pauseLaunchCampaign(req.params.id, reason, actor(req)) })
  } catch (error) {
    next(errorDeValidacion(error) ?? error)
  }
}

export const end = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { reason } = statusReasonBody.parse(req.body)
    res.json({ success: true, data: await endLaunchCampaign(req.params.id, reason, actor(req)) })
  } catch (error) {
    next(errorDeValidacion(error) ?? error)
  }
}

export const redemptions = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = redemptionListQuery.parse(req.query)
    const { data, meta } = await listRedemptions(req.params.id, query)
    res.json({ success: true, data, meta })
  } catch (error) {
    next(errorDeValidacion(error) ?? error)
  }
}
