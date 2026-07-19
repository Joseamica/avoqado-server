import { Request, Response, NextFunction } from 'express'
import * as menuMobileService from '../../services/mobile/menu.mobile.service'

/**
 * GET /mobile/venues/:venueId/menus
 * Menús con su horario, categorías y cuál aplica AHORA (hora del venue).
 */
export const listMenus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const data = await menuMobileService.listMenus(venueId)
    return res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
}
