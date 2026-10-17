import type { NextFunction, Request, Response } from 'express'
import { getOnlineMenuSummary, listOnlineMenuProducts } from '@/services/online-ordering/menuAdmin.service'
import { setOnlineAvailability } from '@/services/online-ordering/menuAvailability.service'
import { getAcceptingStatus, storeView } from '@/services/online-ordering/presence.service'
import { getSettings, storeRequirements, updateSettings } from '@/services/online-ordering/settings.service'

const staffOf = (req: Request): string | null => (req as any).authContext?.userId ?? null

/** 1b: además de los ajustes, el estado de la tienda (el mismo cálculo que `/info`) y qué falta para poder encenderla (R18). */
export const getSettingsHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const settings = await getSettings(venueId)
    const [state, requirements] = await Promise.all([getAcceptingStatus(venueId, new Date(), settings), storeRequirements(venueId)])
    const { lastInboxPollAt, ...config } = settings
    return res.json({
      success: true,
      data: {
        ...config,
        lastInboxPollAt: lastInboxPollAt ? lastInboxPollAt.toISOString() : null,
        store: storeView(state),
        requirements,
      },
    })
  } catch (e) {
    return next(e)
  }
}

export const updateSettingsHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await updateSettings(req.params.venueId, req.body, staffOf(req))
    return res.json({ success: true, data })
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
