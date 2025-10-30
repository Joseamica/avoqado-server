// src/controllers/dashboard/review.dashboard.controller.ts
import { NextFunction, Request, Response } from 'express'
import * as reviewsDashboardService from '../../services/dashboard/review.dashboard.service'
import { DashboardWithDates } from '../../schemas/dashboard/home.schema'
import { parseDateRange } from '@/utils/datetime'

export async function getReviewsData(
  req: Request<DashboardWithDates['params'], any, any, DashboardWithDates['query']>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const { fromDate, toDate } = req.query

    // Parse date range using standardized utility (defaults to last 7 days)
    const dateFilter = parseDateRange(fromDate, toDate, 7)

    // Llamada al servicio
    const reviewsData = await reviewsDashboardService.getReviewsData(venueId, dateFilter)

    res.status(200).json(reviewsData)
  } catch (error) {
    next(error)
  }
}
