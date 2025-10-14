import { Request, Response, NextFunction } from 'express'
import * as reportService from '../../../services/dashboard/report.service'
import AppError from '../../../errors/AppError'

/**
 * Get PMIX report - Product Mix analysis
 */
export async function getPMIXReport(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { startDate, endDate, limit, offset } = req.query

    if (!startDate || !endDate) {
      throw new AppError('startDate and endDate are required', 400)
    }

    const report = await reportService.getPMIXReport(venueId, new Date(startDate as string), new Date(endDate as string), {
      limit: limit ? parseInt(limit as string) : undefined,
      offset: offset ? parseInt(offset as string) : undefined,
    })

    res.json({
      success: true,
      data: report,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get profitability report
 */
export async function getProfitabilityReport(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { categoryId, limit, offset } = req.query

    const report = await reportService.getProfitabilityReport(venueId, {
      categoryId: categoryId as string | undefined,
      limit: limit ? parseInt(limit as string) : undefined,
      offset: offset ? parseInt(offset as string) : undefined,
    })

    res.json({
      success: true,
      data: report,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get ingredient usage report
 */
export async function getIngredientUsageReport(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { startDate, endDate, rawMaterialId, limit, offset } = req.query

    if (!startDate || !endDate) {
      throw new AppError('startDate and endDate are required', 400)
    }

    const report = await reportService.getIngredientUsageReport(venueId, new Date(startDate as string), new Date(endDate as string), {
      rawMaterialId: rawMaterialId as string | undefined,
      limit: limit ? parseInt(limit as string) : undefined,
      offset: offset ? parseInt(offset as string) : undefined,
    })

    res.json({
      success: true,
      data: report,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get cost variance report
 */
export async function getCostVarianceReport(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { startDate, endDate } = req.query

    if (!startDate || !endDate) {
      throw new AppError('startDate and endDate are required', 400)
    }

    const report = await reportService.getCostVarianceReport(venueId, new Date(startDate as string), new Date(endDate as string))

    res.json({
      success: true,
      data: report,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get inventory valuation report
 */
export async function getInventoryValuation(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { limit, offset } = req.query

    const report = await reportService.getInventoryValuation(venueId, {
      limit: limit ? parseInt(limit as string) : undefined,
      offset: offset ? parseInt(offset as string) : undefined,
    })

    res.json({
      success: true,
      data: report,
    })
  } catch (error) {
    next(error)
  }
}
