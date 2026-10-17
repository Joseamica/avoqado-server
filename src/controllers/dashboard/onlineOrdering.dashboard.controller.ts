import type { NextFunction, Request, Response } from 'express'
import { setOnlineAvailability } from '@/services/online-ordering/menuAvailability.service'
import { getAcceptingStatus } from '@/services/online-ordering/presence.service'
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
        store: { status: state.status, reason: state.reason, pausedUntil: config.pausedUntil, manualPause: config.manualPause },
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
