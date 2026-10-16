import type { NextFunction, Request, Response } from 'express'
import { setOnlineAvailability } from '@/services/online-ordering/menuAvailability.service'
import { getSettings, updateSettings } from '@/services/online-ordering/settings.service'

const staffOf = (req: Request): string | null => (req as any).authContext?.userId ?? null

export const getSettingsHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { lastInboxPollAt, ...config } = await getSettings(req.params.venueId)
    return res.json({ success: true, data: { ...config, lastInboxPollAt: lastInboxPollAt ? lastInboxPollAt.toISOString() : null } })
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
