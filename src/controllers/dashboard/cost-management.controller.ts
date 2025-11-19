import type { Request, Response, NextFunction } from 'express'
import * as costManagementService from '../../services/dashboard/cost-management.service'
import logger from '../../config/logger'

/**
 * Get profit metrics with optional filtering
 */
export async function getProfitMetrics(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { startDate, endDate, venueId, providerId } = req.query

    logger.info('Getting profit metrics', {
      userId: req.authContext?.userId,
      params: { startDate, endDate, venueId, providerId },
    })

    const metrics = await costManagementService.getProfitMetrics({
      startDate: startDate as string,
      endDate: endDate as string,
      venueId: venueId as string,
      providerId: providerId as string,
    })

    res.json({
      success: true,
      data: metrics,
      message: 'Profit metrics retrieved successfully',
    })
  } catch (error) {
    logger.error('Error getting profit metrics', {
      error: error instanceof Error ? error.message : 'Unknown error',
      userId: req.authContext?.userId,
    })
    next(error)
  }
}

/**
 * Get monthly profit summaries
 */
export async function getMonthlyProfits(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { startDate, endDate, venueId, status } = req.query

    logger.info('Getting monthly profits', {
      userId: req.authContext?.userId,
      params: { startDate, endDate, venueId, status },
    })

    const monthlyProfits = await costManagementService.getMonthlyProfits({
      startDate: startDate as string,
      endDate: endDate as string,
      venueId: venueId as string,
      status: status as string,
    })

    res.json({
      success: true,
      data: monthlyProfits,
      message: 'Monthly profits retrieved successfully',
    })
  } catch (error) {
    logger.error('Error getting monthly profits', {
      error: error instanceof Error ? error.message : 'Unknown error',
      userId: req.authContext?.userId,
    })
    next(error)
  }
}

/**
 * Get cost structure analysis
 */
export async function getCostStructureAnalysis(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    logger.info('Getting cost structure analysis', { userId: req.authContext?.userId })

    const analysis = await costManagementService.getCostStructureAnalysis()

    res.json({
      success: true,
      data: analysis,
      message: 'Cost structure analysis retrieved successfully',
    })
  } catch (error) {
    logger.error('Error getting cost structure analysis', {
      error: error instanceof Error ? error.message : 'Unknown error',
      userId: req.authContext?.userId,
    })
    next(error)
  }
}

/**
 * Get detailed transaction costs
 */
export async function getTransactionCosts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { startDate, endDate, venueId, providerId, transactionType, limit, offset } = req.query

    logger.info('Getting transaction costs', {
      userId: req.authContext?.userId,
      params: { startDate, endDate, venueId, providerId, transactionType, limit, offset },
    })

    const result = await costManagementService.getTransactionCosts({
      startDate: startDate as string,
      endDate: endDate as string,
      venueId: venueId as string,
      providerId: providerId as string,
      transactionType: transactionType as string,
      limit: limit ? parseInt(limit as string) : undefined,
      offset: offset ? parseInt(offset as string) : undefined,
    })

    res.json({
      success: true,
      data: result,
      message: 'Transaction costs retrieved successfully',
    })
  } catch (error) {
    logger.error('Error getting transaction costs', {
      error: error instanceof Error ? error.message : 'Unknown error',
      userId: req.authContext?.userId,
    })
    next(error)
  }
}

/**
 * Recalculate profits for a specific period
 */
export async function recalculateProfits(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { startDate, endDate, venueId } = req.body

    logger.info('Recalculating profits', {
      userId: req.authContext?.userId,
      params: { startDate, endDate, venueId },
    })

    const result = await costManagementService.recalculateProfits({
      startDate,
      endDate,
      venueId,
    })

    res.json({
      success: true,
      data: result,
      message: 'Profits recalculated successfully',
    })
  } catch (error) {
    logger.error('Error recalculating profits', {
      error: error instanceof Error ? error.message : 'Unknown error',
      userId: req.authContext?.userId,
    })
    next(error)
  }
}

/**
 * Get provider cost structures
 */
export async function getProviderCostStructures(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { providerId, merchantAccountId, active } = req.query

    logger.info('Getting provider cost structures', {
      userId: req.authContext?.userId,
      params: { providerId, merchantAccountId, active },
    })

    const whereClause: any = {}

    if (providerId) whereClause.providerId = providerId
    if (merchantAccountId) whereClause.merchantAccountId = merchantAccountId
    if (active !== undefined) whereClause.active = active === 'true'

    const costStructures = await require('../../utils/prismaClient').default.providerCostStructure.findMany({
      where: whereClause,
      include: {
        provider: {
          select: { id: true, name: true, code: true },
        },
        merchantAccount: {
          select: { id: true, alias: true, ecommerceMerchantId: true },
        },
      },
      orderBy: [{ active: 'desc' }, { effectiveFrom: 'desc' }],
    })

    res.json({
      success: true,
      data: costStructures,
      message: 'Provider cost structures retrieved successfully',
    })
  } catch (error) {
    logger.error('Error getting provider cost structures', {
      error: error instanceof Error ? error.message : 'Unknown error',
      userId: req.authContext?.userId,
    })
    next(error)
  }
}

/**
 * Create or update provider cost structure
 */
export async function upsertProviderCostStructure(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const costData = req.body

    logger.info('Upserting provider cost structure', {
      userId: req.authContext?.userId,
      merchantAccountId: costData.merchantAccountId,
    })

    const prisma = require('../../utils/prismaClient').default

    // Deactivate existing cost structures for this merchant account
    await prisma.providerCostStructure.updateMany({
      where: {
        merchantAccountId: costData.merchantAccountId,
        active: true,
      },
      data: {
        active: false,
        effectiveTo: new Date(),
      },
    })

    // Create new cost structure
    const newCostStructure = await prisma.providerCostStructure.create({
      data: {
        providerId: costData.providerId,
        merchantAccountId: costData.merchantAccountId,
        debitRate: costData.debitRate,
        creditRate: costData.creditRate,
        amexRate: costData.amexRate,
        internationalRate: costData.internationalRate,
        fixedCostPerTransaction: costData.fixedCostPerTransaction,
        monthlyFee: costData.monthlyFee,
        minimumVolume: costData.minimumVolume,
        volumeDiscount: costData.volumeDiscount,
        effectiveFrom: new Date(costData.effectiveFrom),
        effectiveTo: costData.effectiveTo ? new Date(costData.effectiveTo) : null,
        active: true,
        proposalReference: costData.proposalReference,
        notes: costData.notes,
      },
      include: {
        provider: {
          select: { id: true, name: true, code: true },
        },
        merchantAccount: {
          select: { id: true, alias: true, ecommerceMerchantId: true },
        },
      },
    })

    res.json({
      success: true,
      data: newCostStructure,
      message: 'Provider cost structure created successfully',
    })
  } catch (error) {
    logger.error('Error upserting provider cost structure', {
      error: error instanceof Error ? error.message : 'Unknown error',
      userId: req.authContext?.userId,
    })
    next(error)
  }
}

/**
 * Get venue pricing structures
 */
export async function getVenuePricingStructures(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId, accountType, active } = req.query

    logger.info('Getting venue pricing structures', {
      userId: req.authContext?.userId,
      params: { venueId, accountType, active },
    })

    const whereClause: any = {}

    if (venueId) whereClause.venueId = venueId
    if (accountType) whereClause.accountType = accountType
    if (active !== undefined) whereClause.active = active === 'true'

    const pricingStructures = await require('../../utils/prismaClient').default.venuePricingStructure.findMany({
      where: whereClause,
      include: {
        venue: {
          select: { id: true, name: true, slug: true },
        },
      },
      orderBy: [{ active: 'desc' }, { effectiveFrom: 'desc' }],
    })

    res.json({
      success: true,
      data: pricingStructures,
      message: 'Venue pricing structures retrieved successfully',
    })
  } catch (error) {
    logger.error('Error getting venue pricing structures', {
      error: error instanceof Error ? error.message : 'Unknown error',
      userId: req.authContext?.userId,
    })
    next(error)
  }
}

/**
 * Create or update venue pricing structure
 */
export async function upsertVenuePricingStructure(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const pricingData = req.body

    logger.info('Upserting venue pricing structure', {
      userId: req.authContext?.userId,
      venueId: pricingData.venueId,
      accountType: pricingData.accountType,
    })

    const prisma = require('../../utils/prismaClient').default

    // Deactivate existing pricing structures for this venue and account type
    await prisma.venuePricingStructure.updateMany({
      where: {
        venueId: pricingData.venueId,
        accountType: pricingData.accountType,
        active: true,
      },
      data: {
        active: false,
        effectiveTo: new Date(),
      },
    })

    // Create new pricing structure
    const newPricingStructure = await prisma.venuePricingStructure.create({
      data: {
        venueId: pricingData.venueId,
        accountType: pricingData.accountType,
        debitRate: pricingData.debitRate,
        creditRate: pricingData.creditRate,
        amexRate: pricingData.amexRate,
        internationalRate: pricingData.internationalRate,
        fixedFeePerTransaction: pricingData.fixedFeePerTransaction,
        monthlyServiceFee: pricingData.monthlyServiceFee,
        minimumMonthlyVolume: pricingData.minimumMonthlyVolume,
        volumePenalty: pricingData.volumePenalty,
        effectiveFrom: new Date(pricingData.effectiveFrom),
        effectiveTo: pricingData.effectiveTo ? new Date(pricingData.effectiveTo) : null,
        active: true,
        contractReference: pricingData.contractReference,
        notes: pricingData.notes,
      },
      include: {
        venue: {
          select: { id: true, name: true, slug: true },
        },
      },
    })

    res.json({
      success: true,
      data: newPricingStructure,
      message: 'Venue pricing structure created successfully',
    })
  } catch (error) {
    logger.error('Error upserting venue pricing structure', {
      error: error instanceof Error ? error.message : 'Unknown error',
      userId: req.authContext?.userId,
    })
    next(error)
  }
}

/**
 * Update monthly profit status
 */
export async function updateMonthlyProfitStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { monthlyProfitId } = req.params
    const { status, notes } = req.body

    logger.info('Updating monthly profit status', {
      userId: req.authContext?.userId,
      monthlyProfitId,
      status,
    })

    const prisma = require('../../utils/prismaClient').default

    const updatedProfit = await prisma.monthlyVenueProfit.update({
      where: { id: monthlyProfitId },
      data: {
        status,
        ...(notes && { notes }),
      },
      include: {
        venue: {
          select: { id: true, name: true },
        },
      },
    })

    res.json({
      success: true,
      data: updatedProfit,
      message: 'Monthly profit status updated successfully',
    })
  } catch (error) {
    logger.error('Error updating monthly profit status', {
      error: error instanceof Error ? error.message : 'Unknown error',
      userId: req.authContext?.userId,
      monthlyProfitId: req.params.monthlyProfitId,
    })
    next(error)
  }
}

/**
 * Export profit data
 */
export async function exportProfitData(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { startDate, endDate, format, includeTransactionDetails } = req.query

    logger.info('Exporting profit data', {
      userId: req.authContext?.userId,
      params: { startDate, endDate, format, includeTransactionDetails },
    })

    // This would implement actual CSV/XLSX export logic
    // For now, return a simple response
    const exportData = {
      format: format || 'csv',
      startDate,
      endDate,
      includeTransactionDetails: includeTransactionDetails === 'true',
      exportUrl: `/api/v1/dashboard/superadmin/profit/download/${Date.now()}.${format || 'csv'}`,
      status: 'preparing',
    }

    res.json({
      success: true,
      data: exportData,
      message: 'Profit data export initiated successfully',
    })
  } catch (error) {
    logger.error('Error exporting profit data', {
      error: error instanceof Error ? error.message : 'Unknown error',
      userId: req.authContext?.userId,
    })
    next(error)
  }
}
