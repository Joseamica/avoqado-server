import { Request, Response, NextFunction } from 'express'
import { getSubscriptionOverview, getSubscriptionsForSuperadmin, type SubscriptionState } from '@/services/superadmin/subscription.service'

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
