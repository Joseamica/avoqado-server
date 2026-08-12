import { Request, Response, NextFunction } from 'express'
import {
  activateVenuePlan,
  deactivateVenuePlan,
  grantVenuePlanTrial,
  getSubscriptionOverview,
  getSubscriptionsForSuperadmin,
  adjustVenuePlanEndDate,
  type SubscriptionState,
} from '@/services/superadmin/subscription.service'

/** GET /api/v1/superadmin/subscriptions/overview */
export async function overview(_req: Request, res: Response, next: NextFunction) {
  try {
    const data = await getSubscriptionOverview()
    res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

/** GET /api/v1/superadmin/subscriptions/venues?state=&q=&page=&pageSize= */
export async function venues(req: Request, res: Response, next: NextFunction) {
  try {
    const { state, q, page, pageSize } = req.query as { state?: SubscriptionState; q?: string; page?: unknown; pageSize?: unknown }
    const result = await getSubscriptionsForSuperadmin({ state, q, page: Number(page) || 1, pageSize: Number(pageSize) || 25 })
    res.json({ success: true, data: result.items, meta: { total: result.total, page: result.page, pageSize: result.pageSize } })
  } catch (error) {
    next(error)
  }
}

/** POST /api/v1/superadmin/subscriptions/venues/:venueId/activate — turn the venue's PLAN_PRO on. */
export async function activate(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { userId } = (req as any).authContext
    const data = await activateVenuePlan(venueId, userId)
    res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

/** POST /api/v1/superadmin/subscriptions/venues/:venueId/deactivate — turn the venue's PLAN_PRO off. */
export async function deactivate(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { userId } = (req as any).authContext
    const data = await deactivateVenuePlan(venueId, userId)
    res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

/** POST /api/v1/superadmin/subscriptions/venues/:venueId/grant-trial — grant a DB-only PLAN_PRO trial of `days`. */
export async function grantTrial(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { days } = req.body as { days: number }
    const { userId } = (req as any).authContext
    const data = await grantVenuePlanTrial(venueId, days, userId)
    res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

/** POST /api/v1/superadmin/subscriptions/venues/:venueId/adjust-end-date — shift the PLAN_PRO end date by `deltaDays`. */
export async function adjustEndDate(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { deltaDays } = req.body as { deltaDays: number }
    const { userId } = (req as any).authContext
    const data = await adjustVenuePlanEndDate(venueId, deltaDays, userId)
    res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
}
