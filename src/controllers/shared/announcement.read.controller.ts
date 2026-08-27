/**
 * Anuncios de plataforma — lectura desde el dashboard y desde las apps móviles.
 *
 * 🔴 Aditivo: el buzón (`/notifications`) NO se toca. El anuncio llega ahí como una
 * `Notification` normal; estas rutas sólo sirven el detalle y registran la interacción.
 */
import { Request, Response, NextFunction } from 'express'
import { getAnnouncementForStaff, getActiveBanner, recordOpen, recordCta } from '../../services/announcements/announcementRead.service'

export const getDetail = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = (req as any).authContext
    const announcement = await getAnnouncementForStaff(req.params.id, userId)
    res.json({ success: true, data: { announcement } })
  } catch (error) {
    next(error)
  }
}

export const banner = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = (req as any).authContext
    res.json({ success: true, data: { announcement: await getActiveBanner(userId) } })
  } catch (error) {
    next(error)
  }
}

export const open = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, venueId } = (req as any).authContext
    await recordOpen(req.params.id, userId, venueId)
    res.json({ success: true })
  } catch (error) {
    next(error)
  }
}

export const cta = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, venueId } = (req as any).authContext
    await recordCta(req.params.id, userId, venueId)
    res.json({ success: true })
  } catch (error) {
    next(error)
  }
}
