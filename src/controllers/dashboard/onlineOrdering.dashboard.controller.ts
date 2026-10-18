import type { NextFunction, Request, Response } from 'express'
import { getOnlineMenuSummary, listOnlineMenuProducts } from '@/services/online-ordering/menuAdmin.service'
import { setOnlineAvailability } from '@/services/online-ordering/menuAvailability.service'
import { updateSettings } from '@/services/online-ordering/settings.service'
import { settingsView } from '@/services/online-ordering/settingsView.service'

const staffOf = (req: Request): string | null => (req as any).authContext?.userId ?? null

/** 1b: además de los ajustes, el estado de la tienda (el mismo cálculo que `/info`) y qué falta para poder encenderla (R18). */
export const getSettingsHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    return res.json({ success: true, data: await settingsView(req.params.venueId) })
  } catch (e) {
    return next(e)
  }
}

/** Ronda final (C1): responde la MISMA vista que el GET; el panel guarda esta respuesta en la caché del GET. */
export const updateSettingsHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const saved = await updateSettings(venueId, req.body, staffOf(req))
    return res.json({ success: true, data: await settingsView(venueId, saved) })
  } catch (e) {
    return next(e)
  }
}

export const setMenuAvailabilityHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { availableOnline, productIds, categoryIds, allProducts } = req.body
    const data = await setOnlineAvailability({
      venueId: req.params.venueId,
      availableOnline,
      productIds,
      categoryIds,
      allProducts,
      actorStaffId: staffOf(req),
    })
    return res.json({ success: true, data })
  } catch (e) {
    return next(e)
  }
}

/** 1b: el «menú en línea» del panel: conteos por categoría. */
export const getMenuCategoriesHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    return res.json({ success: true, data: await getOnlineMenuSummary(req.params.venueId) })
  } catch (e) {
    return next(e)
  }
}

/** 1b: una página de platillos vendibles. El query ya viene validado por `menuProductsSchema` (`limit` como número). */
export const listMenuProductsHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { categoryId, search, cursor, limit } = req.query as { categoryId?: string; search?: string; cursor?: string; limit?: number }
    return res.json({
      success: true,
      data: await listOnlineMenuProducts({ venueId: req.params.venueId, categoryId, search, cursor, limit }),
    })
  } catch (e) {
    return next(e)
  }
}
