/**
 * Aviso de privacidad del venue — thin HTTP layer.
 * Lee authContext, delega en el servicio, mapea la respuesta. Sin lógica de negocio aquí.
 */
import { Request, Response, NextFunction } from 'express'
import * as privacyNoticeService from '@/services/customer/privacyNotice.service'

/** GET /dashboard/venues/:venueId/privacy-notice */
export async function getPrivacyNotice(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const notice = await privacyNoticeService.getCurrentPrivacyNotice(venueId)
    res.json({ data: { notice } })
  } catch (error) {
    next(error)
  }
}

/** PUT /dashboard/venues/:venueId/privacy-notice */
export async function upsertPrivacyNotice(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { content, language } = req.body
    const { userId } = (req as any).authContext
    const notice = await privacyNoticeService.createPrivacyNoticeVersion(venueId, content, language, userId)
    res.json({ data: { notice } })
  } catch (error) {
    next(error)
  }
}
