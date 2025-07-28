// src/controllers/dashboard/review.dashboard.controller.ts
import { NextFunction, Request, Response } from 'express'
import * as reviewsDashboardService from '../../services/dashboard/review.dashboard.service'
import { DashboardWithDates } from '../../schemas/dashboard/home.schema'

export async function getReviewsData(
  req: Request<DashboardWithDates['params'], any, any, DashboardWithDates['query']>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const { fromDate, toDate } = req.query

    // Configurar fechas por defecto (últimos 7 días)
    const from = fromDate ? new Date(fromDate) : new Date(new Date().setDate(new Date().getDate() - 7))
    const to = toDate ? new Date(toDate) : new Date()

    const dateFilter = { from, to }

    // Llamada al servicio
    const reviewsData = await reviewsDashboardService.getReviewsData(venueId, dateFilter)

    res.status(200).json(reviewsData)
  } catch (error) {
    next(error)
  }
}
