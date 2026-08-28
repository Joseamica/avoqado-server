/**
 * Anuncios de plataforma — lectura desde el dashboard y desde las apps móviles.
 *
 * 🔴 Aditivo: el buzón (`/notifications`) NO se toca. El anuncio llega ahí como una
 * `Notification` normal; estas rutas sólo sirven el detalle y registran la interacción.
 */
import { Request, Response, NextFunction } from 'express'
import { getAnnouncementForStaff, getActiveForHome, recordOpen, recordCta } from '../../services/announcements/announcementRead.service'

export const getDetail = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = (req as any).authContext
    const announcement = await getAnnouncementForStaff(req.params.id, userId)
    res.json({ success: true, data: { announcement } })
  } catch (error) {
    next(error)
  }
}

/**
 * Lo que el inicio del dashboard pide de una sola vez: el banner y la ventana que
 * interrumpe. Reemplaza al endpoint `/banner`, que sólo daba la mitad.
 */
export const home = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = (req as any).authContext
    const data = await getActiveForHome(userId)
    res.json({ success: true, data })
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
