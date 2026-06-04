import { Request, Response, NextFunction } from 'express'
import prisma from '@/utils/prismaClient'
import {
  getSubscriptionOverview,
  getSubscriptionsForSuperadmin,
  getVenueSubscription,
  adjustVenuePlanEndDate,
  type SubscriptionState,
} from '@/services/superadmin/subscription.service'
import { enableFeatureForVenue, disableFeatureForVenue, grantTrialForVenue } from '@/services/dashboard/superadmin.service'

const PLAN_PRO = 'PLAN_PRO'

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
    await enableFeatureForVenue(venueId, PLAN_PRO)
    await prisma.activityLog.create({
      data: {
        staffId: userId,
        venueId,
        action: 'SUPERADMIN_PLAN_ACTIVATED',
        entity: 'VenueFeature',
        entityId: venueId,
        data: { featureCode: PLAN_PRO },
      },
    })
    res.json({ success: true, data: await getVenueSubscription(venueId) })
  } catch (error) {
    next(error)
  }
}

/** POST /api/v1/superadmin/subscriptions/venues/:venueId/deactivate — turn the venue's PLAN_PRO off. */
export async function deactivate(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { userId } = (req as any).authContext
    await disableFeatureForVenue(venueId, PLAN_PRO)
    await prisma.activityLog.create({
      data: {
        staffId: userId,
        venueId,
        action: 'SUPERADMIN_PLAN_DEACTIVATED',
        entity: 'VenueFeature',
        entityId: venueId,
        data: { featureCode: PLAN_PRO },
      },
    })
    res.json({ success: true, data: await getVenueSubscription(venueId) })
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
    const { endDate } = await grantTrialForVenue(venueId, PLAN_PRO, days)
    await prisma.activityLog.create({
      data: {
        staffId: userId,
        venueId,
        action: 'SUPERADMIN_PLAN_TRIAL_GRANTED',
        entity: 'VenueFeature',
        entityId: venueId,
        data: { featureCode: PLAN_PRO, days, endDate: endDate.toISOString() },
      },
    })
    res.json({ success: true, data: await getVenueSubscription(venueId) })
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
    const data = await adjustVenuePlanEndDate(venueId, deltaDays)
    await prisma.activityLog.create({
      data: {
        staffId: userId,
        venueId,
        action: 'SUPERADMIN_PLAN_ENDDATE_ADJUSTED',
        entity: 'VenueFeature',
        entityId: venueId,
        data: { featureCode: PLAN_PRO, deltaDays },
      },
    })
    res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
}
