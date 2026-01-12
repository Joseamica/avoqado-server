/**
 * Commission Dashboard Controller
 *
 * Thin controller layer - orchestrates HTTP, delegates to service.
 * Contains NO business logic, only:
 * - Request/response handling
 * - Calling service functions
 * - Error responses
 *
 * @see CLAUDE.md - Layered Architecture section
 */

import { Request, Response, NextFunction } from 'express'
import * as configService from '@/services/dashboard/commission/commission-config.service'
import * as overrideService from '@/services/dashboard/commission/commission-override.service'
import * as tierService from '@/services/dashboard/commission/commission-tier.service'
import * as milestoneService from '@/services/dashboard/commission/commission-milestone.service'
import * as calculationService from '@/services/dashboard/commission/commission-calculation.service'
import * as aggregationService from '@/services/dashboard/commission/commission-aggregation.service'
import * as payoutService from '@/services/dashboard/commission/commission-payout.service'
import * as clawbackService from '@/services/dashboard/commission/commission-clawback.service'
import { commissionAggregationJob } from '@/jobs/commission-aggregation.job'
import { TierPeriod } from '@prisma/client'

// ==========================================
// COMMISSION CONFIG CRUD
// ==========================================

/**
 * GET /api/v1/dashboard/venues/:venueId/commission-configs
 * List all commission configs for a venue
 */
export async function getConfigs(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const includeInactive = req.query.includeInactive === 'true'

    const configs = await configService.getCommissionConfigs(venueId, {
      active: includeInactive ? undefined : true,
    })

    res.json({ data: configs })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/commission-configs/:configId
 * Get single commission config
 */
export async function getConfigById(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, configId } = req.params

    const config = await configService.getCommissionConfigById(configId, venueId)

    res.json(config)
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/commission-configs
 * Create a new commission config
 */
export async function createConfig(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const authContext = (req as any).authContext

    const config = await configService.createCommissionConfig(venueId, req.body, authContext?.userId)

    res.status(201).json(config)
  } catch (error) {
    next(error)
  }
}

/**
 * PUT /api/v1/dashboard/venues/:venueId/commission-configs/:configId
 * Update commission config
 */
export async function updateConfig(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, configId } = req.params

    const config = await configService.updateCommissionConfig(configId, venueId, req.body)

    res.json(config)
  } catch (error) {
    next(error)
  }
}

/**
 * DELETE /api/v1/dashboard/venues/:venueId/commission-configs/:configId
 * Soft delete commission config
 */
export async function deleteConfig(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, configId } = req.params
    const authContext = (req as any).authContext

    await configService.softDeleteCommissionConfig(configId, venueId, authContext?.userId)

    res.status(204).send()
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/commission-configs/:configId/copy
 * Copy commission config
 */
export async function copyConfig(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, configId } = req.params
    const authContext = (req as any).authContext
    const { name } = req.body

    const config = await configService.copyCommissionConfig(configId, venueId, authContext?.userId, name)

    res.status(201).json(config)
  } catch (error) {
    next(error)
  }
}

// ==========================================
// COMMISSION OVERRIDES
// ==========================================

/**
 * GET /api/v1/dashboard/venues/:venueId/commission-configs/:configId/overrides
 * List all overrides for a config
 */
export async function getOverrides(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, configId } = req.params
    const includeInactive = req.query.includeInactive === 'true'

    const overrides = await overrideService.getOverridesForConfig(configId, venueId, includeInactive)

    res.json({ data: overrides })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/staff/:staffId/commission-overrides
 * List all overrides for a staff member
 */
export async function getStaffOverrides(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, staffId } = req.params

    const overrides = await overrideService.getOverridesForStaff(staffId, venueId)

    res.json({ data: overrides })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/commission-overrides/:overrideId
 * Get single override
 */
export async function getOverrideById(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, overrideId } = req.params

    const override = await overrideService.getOverrideById(overrideId, venueId)

    res.json(override)
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/commission-configs/:configId/overrides
 * Create override for staff
 */
export async function createOverride(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, configId } = req.params
    const authContext = (req as any).authContext

    const override = await overrideService.createCommissionOverride(configId, venueId, req.body, authContext?.userId)

    res.status(201).json(override)
  } catch (error) {
    next(error)
  }
}

/**
 * PUT /api/v1/dashboard/venues/:venueId/commission-overrides/:overrideId
 * Update override
 */
export async function updateOverride(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, overrideId } = req.params

    const override = await overrideService.updateCommissionOverride(overrideId, venueId, req.body)

    res.json(override)
  } catch (error) {
    next(error)
  }
}

/**
 * DELETE /api/v1/dashboard/venues/:venueId/commission-overrides/:overrideId
 * Delete override
 */
export async function deleteOverride(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, overrideId } = req.params

    await overrideService.deleteOverride(overrideId, venueId)

    res.status(204).send()
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/commission-configs/:configId/bulk-exclude
 * Bulk exclude staff from commission
 */
export async function bulkExcludeStaff(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, configId } = req.params
    const authContext = (req as any).authContext
    const { staffIds, reason } = req.body

    const count = await overrideService.bulkExcludeStaff(configId, venueId, staffIds, authContext?.userId, reason)

    res.json({ excluded: count })
  } catch (error) {
    next(error)
  }
}

// ==========================================
// COMMISSION TIERS
// ==========================================

/**
 * GET /api/v1/dashboard/venues/:venueId/commission-configs/:configId/tiers
 * List all tiers for a config
 */
export async function getTiers(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, configId } = req.params

    const tiers = await tierService.getTiersForConfig(configId, venueId)

    res.json({ data: tiers })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/commission-configs/:configId/tiers
 * Create tier
 */
export async function createTier(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, configId } = req.params

    const tier = await tierService.createCommissionTier(configId, venueId, req.body)

    res.status(201).json(tier)
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/commission-configs/:configId/tiers/batch
 * Create multiple tiers at once
 */
export async function createTiersBatch(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, configId } = req.params
    const { tiers } = req.body

    const created = await tierService.createTiersBatch(configId, venueId, tiers)

    res.status(201).json({ data: created })
  } catch (error) {
    next(error)
  }
}

/**
 * PUT /api/v1/dashboard/venues/:venueId/commission-tiers/:tierId
 * Update tier
 */
export async function updateTier(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, tierId } = req.params

    const tier = await tierService.updateCommissionTier(tierId, venueId, req.body)

    res.json(tier)
  } catch (error) {
    next(error)
  }
}

/**
 * DELETE /api/v1/dashboard/venues/:venueId/commission-tiers/:tierId
 * Delete tier
 */
export async function deleteTier(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, tierId } = req.params

    await tierService.deleteTier(tierId, venueId)

    res.status(204).send()
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/staff/:staffId/tier-progress
 * Get staff tier progress
 */
export async function getStaffTierProgress(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, staffId } = req.params
    const { configId } = req.query

    if (!configId || typeof configId !== 'string') {
      return res.status(400).json({ error: 'configId query parameter is required' })
    }

    const progress = await tierService.getStaffTierProgress(configId, staffId, venueId)

    res.json({ data: progress })
  } catch (error) {
    next(error)
  }
}

// ==========================================
// MILESTONES
// ==========================================

/**
 * GET /api/v1/dashboard/venues/:venueId/commission-configs/:configId/milestones
 * List all milestones for a config
 */
export async function getMilestones(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, configId } = req.params
    const includeInactive = req.query.includeInactive === 'true'

    const milestones = await milestoneService.getMilestonesForConfig(configId, venueId, includeInactive)

    res.json({ data: milestones })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/milestones/:milestoneId
 * Get single milestone
 */
export async function getMilestoneById(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, milestoneId } = req.params

    const milestone = await milestoneService.getMilestoneById(milestoneId, venueId)

    res.json(milestone)
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/commission-configs/:configId/milestones
 * Create milestone
 */
export async function createMilestone(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, configId } = req.params

    const milestone = await milestoneService.createMilestone(configId, venueId, req.body)

    res.status(201).json(milestone)
  } catch (error) {
    next(error)
  }
}

/**
 * PUT /api/v1/dashboard/venues/:venueId/milestones/:milestoneId
 * Update milestone
 */
export async function updateMilestone(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, milestoneId } = req.params

    const milestone = await milestoneService.updateMilestone(milestoneId, venueId, req.body)

    res.json(milestone)
  } catch (error) {
    next(error)
  }
}

/**
 * DELETE /api/v1/dashboard/venues/:venueId/milestones/:milestoneId
 * Deactivate milestone
 */
export async function deleteMilestone(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, milestoneId } = req.params

    await milestoneService.deactivateMilestone(milestoneId, venueId)

    res.status(204).send()
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/staff/:staffId/milestone-progress
 * Get staff milestone progress
 */
export async function getStaffMilestoneProgress(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, staffId } = req.params
    const { configId } = req.query

    const progress = await milestoneService.getStaffMilestoneProgress(staffId, venueId, configId as string | undefined)

    res.json({ data: progress })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/staff/:staffId/achievements
 * Get staff achievements
 */
export async function getStaffAchievements(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, staffId } = req.params
    const { startDate, endDate } = req.query

    const achievements = await milestoneService.getStaffAchievements(
      staffId,
      venueId,
      startDate ? new Date(startDate as string) : undefined,
      endDate ? new Date(endDate as string) : undefined,
    )

    res.json({ data: achievements })
  } catch (error) {
    next(error)
  }
}

// ==========================================
// COMMISSION CALCULATIONS (READ ONLY)
// ==========================================

/**
 * GET /api/v1/dashboard/venues/:venueId/staff/:staffId/commissions
 * Get staff commissions
 */
export async function getStaffCommissions(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, staffId } = req.params
    const { startDate, endDate, status } = req.query

    const commissions = await calculationService.getStaffCommissions(staffId, venueId, {
      startDate: startDate ? new Date(startDate as string) : undefined,
      endDate: endDate ? new Date(endDate as string) : undefined,
      status: status as any,
    })

    res.json({ data: commissions })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/staff/:staffId/commission-stats
 * Get staff commission statistics
 */
export async function getStaffCommissionStats(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, staffId } = req.params
    const { startDate, endDate } = req.query

    if (!startDate || !endDate) {
      res.status(400).json({ error: 'startDate and endDate are required' })
      return
    }

    const stats = await calculationService.getStaffCommissionStats(
      staffId,
      venueId,
      new Date(startDate as string),
      new Date(endDate as string),
    )

    res.json(stats)
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/my-commissions
 * Get current user's commissions
 */
export async function getMyCommissions(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const authContext = (req as any).authContext
    const { startDate, endDate } = req.query

    const commissions = await calculationService.getStaffCommissions(authContext?.userId, venueId, {
      startDate: startDate ? new Date(startDate as string) : undefined,
      endDate: endDate ? new Date(endDate as string) : undefined,
    })

    res.json({ data: commissions })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/my-commission-stats
 * Get current user's commission stats
 */
export async function getMyCommissionStats(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const authContext = (req as any).authContext
    const { startDate, endDate } = req.query

    if (!startDate || !endDate) {
      res.status(400).json({ error: 'startDate and endDate are required' })
      return
    }

    const stats = await calculationService.getStaffCommissionStats(
      authContext?.userId,
      venueId,
      new Date(startDate as string),
      new Date(endDate as string),
    )

    res.json(stats)
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/commission-calculations/:calculationId/void
 * Void a commission calculation
 */
export async function voidCalculation(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, calculationId } = req.params
    const authContext = (req as any).authContext
    const { reason } = req.body

    await calculationService.voidCommissionCalculation(calculationId, venueId, authContext?.userId, reason)

    res.status(204).send()
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/commission-calculations/manual
 * Create manual commission calculation
 */
export async function createManualCommission(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const authContext = (req as any).authContext
    const { staffId, amount, reason, orderId, shiftId } = req.body

    const calculation = await calculationService.createManualCommission(
      venueId,
      staffId,
      amount,
      reason,
      authContext?.userId,
      orderId,
      shiftId,
    )

    res.status(201).json(calculation)
  } catch (error) {
    next(error)
  }
}

// ==========================================
// COMMISSION SUMMARIES
// ==========================================

/**
 * GET /api/v1/dashboard/venues/:venueId/commission-summaries
 * Get all commission summaries for venue
 */
export async function getSummaries(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { staffId, status, periodStart, periodEnd } = req.query

    const summaries = await aggregationService.getCommissionSummaries(venueId, {
      staffId: staffId as string,
      status: status as any,
      periodStart: periodStart ? new Date(periodStart as string) : undefined,
      periodEnd: periodEnd ? new Date(periodEnd as string) : undefined,
    })

    res.json({ data: summaries })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/commission-summaries/:summaryId
 * Get single summary with details
 */
export async function getSummaryById(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, summaryId } = req.params

    const summary = await aggregationService.getSummaryById(summaryId, venueId)

    res.json(summary)
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/commission-summaries/:summaryId/approve
 * Approve a summary
 */
export async function approveSummary(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, summaryId } = req.params
    const authContext = (req as any).authContext

    const summary = await aggregationService.approveSummary(summaryId, venueId, authContext?.userId)

    res.json(summary)
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/commission-summaries/:summaryId/dispute
 * Dispute a summary
 */
export async function disputeSummary(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, summaryId } = req.params
    const authContext = (req as any).authContext
    const { reason } = req.body

    const summary = await aggregationService.disputeSummary(summaryId, venueId, authContext?.userId, reason)

    res.json(summary)
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/commission-summaries/:summaryId/recalculate
 * Recalculate a summary
 */
export async function recalculateSummary(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, summaryId } = req.params

    const summary = await aggregationService.recalculateSummary(summaryId, venueId)

    res.json(summary)
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/commission-summaries/:summaryId/deduction
 * Apply deduction to summary
 */
export async function applyDeduction(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, summaryId } = req.params
    const { amount, reason } = req.body

    const summary = await aggregationService.applyDeduction(summaryId, venueId, amount, reason)

    res.json(summary)
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/commission-summaries/bulk-approve
 * Bulk approve summaries
 */
export async function bulkApproveSummaries(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const authContext = (req as any).authContext
    const { summaryIds } = req.body

    const count = await aggregationService.bulkApproveSummaries(summaryIds, venueId, authContext?.userId)

    res.json({ approved: count })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/aggregate-commissions
 * Trigger manual aggregation
 */
export async function triggerAggregation(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { period } = req.body

    const result = await aggregationService.aggregateVenueCommissions(venueId, (period as TierPeriod) || TierPeriod.WEEKLY)

    res.json(result)
  } catch (error) {
    next(error)
  }
}

// ==========================================
// COMMISSION PAYOUTS
// ==========================================

/**
 * GET /api/v1/dashboard/venues/:venueId/commission-payouts
 * Get all payouts for venue
 */
export async function getPayouts(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { staffId, status, startDate, endDate } = req.query

    const payouts = await payoutService.getPayouts(venueId, {
      staffId: staffId as string,
      status: status as any,
      startDate: startDate ? new Date(startDate as string) : undefined,
      endDate: endDate ? new Date(endDate as string) : undefined,
    })

    res.json({ data: payouts })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/commission-payouts/:payoutId
 * Get single payout
 */
export async function getPayoutById(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, payoutId } = req.params

    const payout = await payoutService.getPayoutById(payoutId, venueId)

    res.json(payout)
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/staff/:staffId/commission-payouts
 * Get staff payouts
 */
export async function getStaffPayouts(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, staffId } = req.params
    const limit = parseInt(req.query.limit as string) || 10

    const payouts = await payoutService.getStaffPayouts(staffId, venueId, limit)

    res.json({ data: payouts })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/commission-payouts
 * Create payout
 */
export async function createPayout(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const authContext = (req as any).authContext

    const payouts = await payoutService.createPayouts(venueId, req.body, authContext?.userId)

    res.status(201).json({ data: payouts })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/commission-payouts/:payoutId/approve
 * Approve payout
 */
export async function approvePayout(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, payoutId } = req.params
    const authContext = (req as any).authContext

    const payout = await payoutService.approvePayout(payoutId, venueId, authContext?.userId)

    res.json(payout)
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/commission-payouts/:payoutId/process
 * Start processing payout
 */
export async function startPayoutProcessing(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, payoutId } = req.params
    const authContext = (req as any).authContext

    const payout = await payoutService.processPayout(payoutId, venueId, authContext?.userId)

    res.json(payout)
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/commission-payouts/:payoutId/complete
 * Complete payout
 */
export async function completePayout(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, payoutId } = req.params
    const { paymentReference } = req.body

    const payout = await payoutService.completePayout(payoutId, venueId, paymentReference)

    res.json(payout)
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/commission-payouts/:payoutId/fail
 * Mark payout as failed
 */
export async function failPayout(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, payoutId } = req.params
    const { reason } = req.body

    const payout = await payoutService.failPayout(payoutId, venueId, reason)

    res.json(payout)
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/commission-payouts/:payoutId/cancel
 * Cancel payout
 */
export async function cancelPayout(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, payoutId } = req.params
    const { reason } = req.body

    const payout = await payoutService.cancelPayout(payoutId, venueId, reason)

    res.json(payout)
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/commission-payouts/stats
 * Get payout statistics
 */
export async function getPayoutStats(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params

    const stats = await payoutService.getPayoutStats(venueId)

    res.json(stats)
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/stats
 * Get venue-wide commission statistics
 */
export async function getVenueStats(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params

    const stats = await calculationService.getVenueCommissionStats(venueId)

    res.json(stats)
  } catch (error) {
    next(error)
  }
}

// ==========================================
// CLAWBACKS
// ==========================================

/**
 * GET /api/v1/dashboard/venues/:venueId/commission-clawbacks
 * Get all clawbacks
 */
export async function getClawbacks(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { staffId, reason, startDate, endDate, applied } = req.query

    const clawbacks = await clawbackService.getClawbacks(venueId, {
      staffId: staffId as string,
      reason: reason as any,
      startDate: startDate ? new Date(startDate as string) : undefined,
      endDate: endDate ? new Date(endDate as string) : undefined,
      applied: applied !== undefined ? applied === 'true' : undefined,
    })

    res.json({ data: clawbacks })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/commission-clawbacks/:clawbackId
 * Get single clawback
 */
export async function getClawbackById(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, clawbackId } = req.params

    const clawback = await clawbackService.getClawbackById(clawbackId, venueId)

    res.json(clawback)
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/staff/:staffId/pending-clawbacks
 * Get pending clawbacks for staff
 */
export async function getPendingClawbacksForStaff(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, staffId } = req.params

    const result = await clawbackService.getPendingClawbacksForStaff(staffId, venueId)

    res.json(result)
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/commission-calculations/:calculationId/clawback
 * Create clawback for calculation
 */
export async function createClawback(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, calculationId } = req.params
    const authContext = (req as any).authContext

    const clawback = await clawbackService.createClawback(calculationId, venueId, req.body, authContext?.userId)

    res.status(201).json(clawback)
  } catch (error) {
    next(error)
  }
}

/**
 * DELETE /api/v1/dashboard/venues/:venueId/commission-clawbacks/:clawbackId
 * Void clawback
 */
export async function voidClawback(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, clawbackId } = req.params
    const authContext = (req as any).authContext
    const { reason } = req.body

    await clawbackService.voidClawback(clawbackId, venueId, authContext?.userId, reason)

    res.status(204).send()
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/commission-clawbacks/stats
 * Get clawback statistics
 */
export async function getClawbackStats(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { startDate, endDate } = req.query

    if (!startDate || !endDate) {
      res.status(400).json({ error: 'startDate and endDate are required' })
      return
    }

    const stats = await clawbackService.getClawbackStats(venueId, new Date(startDate as string), new Date(endDate as string))

    res.json(stats)
  } catch (error) {
    next(error)
  }
}

// ==========================================
// AGGREGATION JOB STATUS (OWNER ONLY)
// ==========================================

/**
 * GET /api/v1/dashboard/venues/:venueId/commission-job-status
 * Get aggregation job status
 */
export async function getJobStatus(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({
      isRunning: commissionAggregationJob.isJobRunning(),
      nextRun: commissionAggregationJob.getNextRun(),
    })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/run-aggregation-job
 * Manually trigger aggregation job
 */
export async function runAggregationJob(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await commissionAggregationJob.runNow()

    res.json(result)
  } catch (error) {
    next(error)
  }
}
