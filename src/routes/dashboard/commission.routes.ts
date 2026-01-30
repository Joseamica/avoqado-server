/**
 * Commission Dashboard Routes
 *
 * Routes for managing staff commissions including:
 * - Commission configs (OWNER/ADMIN)
 * - Staff overrides (OWNER/ADMIN)
 * - Tiers and milestones (OWNER/ADMIN)
 * - Summaries approval (OWNER/ADMIN)
 * - Payouts (OWNER only)
 * - Staff self-service (view own commissions)
 */

import express from 'express'
import { checkPermission } from '@/middlewares/checkPermission.middleware'
import * as controller from '@/controllers/dashboard/commission.dashboard.controller'

const router = express.Router()

// ==========================================
// COMMISSION CONFIGS
// Routes: /api/v1/dashboard/commissions/venues/:venueId/configs
// ==========================================

/**
 * GET /venues/:venueId/configs
 * List all commission configs for a venue
 * @permission commissions:read
 */
router.get('/venues/:venueId/configs', checkPermission('commissions:read'), controller.getConfigs)

/**
 * GET /venues/:venueId/configs/:configId
 * Get single commission config
 * @permission commissions:read
 */
router.get('/venues/:venueId/configs/:configId', checkPermission('commissions:read'), controller.getConfigById)

/**
 * POST /venues/:venueId/configs
 * Create commission config
 * @permission commissions:create
 */
router.post('/venues/:venueId/configs', checkPermission('commissions:create'), controller.createConfig)

/**
 * PUT /venues/:venueId/configs/:configId
 * Update commission config
 * @permission commissions:update
 */
router.put('/venues/:venueId/configs/:configId', checkPermission('commissions:update'), controller.updateConfig)

/**
 * DELETE /venues/:venueId/configs/:configId
 * Soft delete commission config
 * @permission commissions:delete
 */
router.delete('/venues/:venueId/configs/:configId', checkPermission('commissions:delete'), controller.deleteConfig)

/**
 * POST /venues/:venueId/configs/:configId/copy
 * Copy commission config
 * @permission commissions:create
 */
router.post('/venues/:venueId/configs/:configId/copy', checkPermission('commissions:create'), controller.copyConfig)

// ==========================================
// COMMISSION OVERRIDES
// Routes: /api/v1/dashboard/commissions/venues/:venueId/...
// ==========================================

/**
 * GET /venues/:venueId/configs/:configId/overrides
 * List overrides for a config
 * @permission commissions:read
 */
router.get('/venues/:venueId/configs/:configId/overrides', checkPermission('commissions:read'), controller.getOverrides)

/**
 * POST /venues/:venueId/configs/:configId/overrides
 * Create override for staff
 * @permission commissions:create
 */
router.post('/venues/:venueId/configs/:configId/overrides', checkPermission('commissions:create'), controller.createOverride)

/**
 * POST /venues/:venueId/configs/:configId/bulk-exclude
 * Bulk exclude staff from commission
 * @permission commissions:update
 */
router.post('/venues/:venueId/configs/:configId/bulk-exclude', checkPermission('commissions:update'), controller.bulkExcludeStaff)

/**
 * GET /venues/:venueId/staff/:staffId/overrides
 * List overrides for a staff member
 * @permission commissions:read
 */
router.get('/venues/:venueId/staff/:staffId/overrides', checkPermission('commissions:read'), controller.getStaffOverrides)

/**
 * GET /venues/:venueId/overrides/:overrideId
 * Get single override
 * @permission commissions:read
 */
router.get('/venues/:venueId/overrides/:overrideId', checkPermission('commissions:read'), controller.getOverrideById)

/**
 * PUT /venues/:venueId/overrides/:overrideId
 * Update override
 * @permission commissions:update
 */
router.put('/venues/:venueId/overrides/:overrideId', checkPermission('commissions:update'), controller.updateOverride)

/**
 * DELETE /venues/:venueId/overrides/:overrideId
 * Delete override
 * @permission commissions:delete
 */
router.delete('/venues/:venueId/overrides/:overrideId', checkPermission('commissions:delete'), controller.deleteOverride)

// ==========================================
// COMMISSION TIERS
// Routes: /api/v1/dashboard/commissions/venues/:venueId/...
// ==========================================

/**
 * GET /venues/:venueId/configs/:configId/tiers
 * List tiers for a config
 * @permission commissions:read
 */
router.get('/venues/:venueId/configs/:configId/tiers', checkPermission('commissions:read'), controller.getTiers)

/**
 * POST /venues/:venueId/configs/:configId/tiers
 * Create tier
 * @permission commissions:create
 */
router.post('/venues/:venueId/configs/:configId/tiers', checkPermission('commissions:create'), controller.createTier)

/**
 * POST /venues/:venueId/configs/:configId/tiers/batch
 * Create multiple tiers
 * @permission commissions:create
 */
router.post('/venues/:venueId/configs/:configId/tiers/batch', checkPermission('commissions:create'), controller.createTiersBatch)

/**
 * PUT /venues/:venueId/tiers/:tierId
 * Update tier
 * @permission commissions:update
 */
router.put('/venues/:venueId/tiers/:tierId', checkPermission('commissions:update'), controller.updateTier)

/**
 * DELETE /venues/:venueId/tiers/:tierId
 * Delete tier
 * @permission commissions:delete
 */
router.delete('/venues/:venueId/tiers/:tierId', checkPermission('commissions:delete'), controller.deleteTier)

/**
 * GET /venues/:venueId/staff/:staffId/tier-progress
 * Get staff tier progress
 * @permission commissions:read
 */
router.get('/venues/:venueId/staff/:staffId/tier-progress', checkPermission('commissions:read'), controller.getStaffTierProgress)

// ==========================================
// MILESTONES
// Routes: /api/v1/dashboard/commissions/venues/:venueId/...
// ==========================================

/**
 * GET /venues/:venueId/configs/:configId/milestones
 * List milestones for a config
 * @permission commissions:read
 */
router.get('/venues/:venueId/configs/:configId/milestones', checkPermission('commissions:read'), controller.getMilestones)

/**
 * POST /venues/:venueId/configs/:configId/milestones
 * Create milestone
 * @permission commissions:create
 */
router.post('/venues/:venueId/configs/:configId/milestones', checkPermission('commissions:create'), controller.createMilestone)

/**
 * GET /venues/:venueId/milestones/:milestoneId
 * Get single milestone
 * @permission commissions:read
 */
router.get('/venues/:venueId/milestones/:milestoneId', checkPermission('commissions:read'), controller.getMilestoneById)

/**
 * PUT /venues/:venueId/milestones/:milestoneId
 * Update milestone
 * @permission commissions:update
 */
router.put('/venues/:venueId/milestones/:milestoneId', checkPermission('commissions:update'), controller.updateMilestone)

/**
 * DELETE /venues/:venueId/milestones/:milestoneId
 * Deactivate milestone
 * @permission commissions:delete
 */
router.delete('/venues/:venueId/milestones/:milestoneId', checkPermission('commissions:delete'), controller.deleteMilestone)

/**
 * GET /venues/:venueId/staff/:staffId/milestone-progress
 * Get staff milestone progress
 * @permission commissions:read
 */
router.get('/venues/:venueId/staff/:staffId/milestone-progress', checkPermission('commissions:read'), controller.getStaffMilestoneProgress)

/**
 * GET /venues/:venueId/staff/:staffId/achievements
 * Get staff achievements
 * @permission commissions:read
 */
router.get('/venues/:venueId/staff/:staffId/achievements', checkPermission('commissions:read'), controller.getStaffAchievements)

// ==========================================
// COMMISSION CALCULATIONS (ADMIN VIEW)
// Routes: /api/v1/dashboard/commissions/venues/:venueId/...
// ==========================================

/**
 * GET /venues/:venueId/staff/:staffId/commissions
 * Get staff commissions
 * @permission commissions:read
 */
router.get('/venues/:venueId/staff/:staffId/commissions', checkPermission('commissions:read'), controller.getStaffCommissions)

/**
 * GET /venues/:venueId/staff/:staffId/commission-stats
 * Get staff commission stats
 * @permission commissions:read
 */
router.get('/venues/:venueId/staff/:staffId/commission-stats', checkPermission('commissions:read'), controller.getStaffCommissionStats)

/**
 * POST /venues/:venueId/calculations/:calculationId/void
 * Void a commission calculation
 * @permission commissions:update
 */
router.post('/venues/:venueId/calculations/:calculationId/void', checkPermission('commissions:update'), controller.voidCalculation)

/**
 * POST /venues/:venueId/calculations/manual
 * Create manual commission calculation
 * @permission commissions:create
 */
router.post('/venues/:venueId/calculations/manual', checkPermission('commissions:create'), controller.createManualCommission)

/**
 * POST /venues/:venueId/payments/commissions/batch
 * Get commissions for multiple payments in a single request
 * @permission commissions:read
 */
router.post('/venues/:venueId/payments/commissions/batch', checkPermission('commissions:read'), controller.getCommissionsByPaymentsBatch)

/**
 * GET /venues/:venueId/payments/:paymentId/commission
 * Get commission calculation for a specific payment
 * @permission commissions:read
 */
router.get('/venues/:venueId/payments/:paymentId/commission', checkPermission('commissions:read'), controller.getCommissionByPayment)

// ==========================================
// SELF-SERVICE (view own commissions)
// Routes: /api/v1/dashboard/commissions/venues/:venueId/my-*
// ==========================================

/**
 * GET /venues/:venueId/my-commissions
 * Get current user's commissions
 * @permission commissions:view_own
 */
router.get('/venues/:venueId/my-commissions', checkPermission('commissions:view_own'), controller.getMyCommissions)

/**
 * GET /venues/:venueId/my-commission-stats
 * Get current user's commission stats
 * @permission commissions:view_own
 */
router.get('/venues/:venueId/my-commission-stats', checkPermission('commissions:view_own'), controller.getMyCommissionStats)

// ==========================================
// VENUE COMMISSION STATS
// Routes: /api/v1/dashboard/commissions/venues/:venueId/stats
// ==========================================

/**
 * GET /venues/:venueId/stats
 * Get venue-wide commission statistics
 * @permission commissions:read
 */
router.get('/venues/:venueId/stats', checkPermission('commissions:read'), controller.getVenueStats)

// ==========================================
// COMMISSION SUMMARIES
// Routes: /api/v1/dashboard/commissions/venues/:venueId/summaries
// ==========================================

/**
 * GET /venues/:venueId/summaries
 * Get all commission summaries
 * @permission commissions:read
 */
router.get('/venues/:venueId/summaries', checkPermission('commissions:read'), controller.getSummaries)

/**
 * GET /venues/:venueId/summaries/:summaryId
 * Get single summary
 * @permission commissions:read
 */
router.get('/venues/:venueId/summaries/:summaryId', checkPermission('commissions:read'), controller.getSummaryById)

/**
 * POST /venues/:venueId/summaries/:summaryId/approve
 * Approve a summary
 * @permission commissions:approve
 */
router.post('/venues/:venueId/summaries/:summaryId/approve', checkPermission('commissions:approve'), controller.approveSummary)

/**
 * POST /venues/:venueId/summaries/:summaryId/dispute
 * Dispute a summary
 * @permission commissions:view_own
 */
router.post('/venues/:venueId/summaries/:summaryId/dispute', checkPermission('commissions:view_own'), controller.disputeSummary)

/**
 * POST /venues/:venueId/summaries/:summaryId/recalculate
 * Recalculate a summary
 * @permission commissions:update
 */
router.post('/venues/:venueId/summaries/:summaryId/recalculate', checkPermission('commissions:update'), controller.recalculateSummary)

/**
 * POST /venues/:venueId/summaries/:summaryId/deduction
 * Apply deduction to summary
 * @permission commissions:update
 */
router.post('/venues/:venueId/summaries/:summaryId/deduction', checkPermission('commissions:update'), controller.applyDeduction)

/**
 * POST /venues/:venueId/summaries/bulk-approve
 * Bulk approve summaries
 * @permission commissions:approve
 */
router.post('/venues/:venueId/summaries/bulk-approve', checkPermission('commissions:approve'), controller.bulkApproveSummaries)

/**
 * POST /venues/:venueId/aggregate
 * Trigger manual aggregation
 * @permission commissions:update
 */
router.post('/venues/:venueId/aggregate', checkPermission('commissions:update'), controller.triggerAggregation)

// ==========================================
// COMMISSION PAYOUTS (OWNER ONLY)
// Routes: /api/v1/dashboard/commissions/venues/:venueId/payouts
// ==========================================

/**
 * GET /venues/:venueId/payouts
 * Get all payouts
 * @permission commissions:payout
 */
router.get('/venues/:venueId/payouts', checkPermission('commissions:payout'), controller.getPayouts)

/**
 * GET /venues/:venueId/payouts/stats
 * Get payout statistics
 * @permission commissions:payout
 */
router.get('/venues/:venueId/payouts/stats', checkPermission('commissions:payout'), controller.getPayoutStats)

/**
 * GET /venues/:venueId/payouts/:payoutId
 * Get single payout
 * @permission commissions:payout
 */
router.get('/venues/:venueId/payouts/:payoutId', checkPermission('commissions:payout'), controller.getPayoutById)

/**
 * GET /venues/:venueId/staff/:staffId/payouts
 * Get staff payouts
 * @permission commissions:payout
 */
router.get('/venues/:venueId/staff/:staffId/payouts', checkPermission('commissions:payout'), controller.getStaffPayouts)

/**
 * POST /venues/:venueId/payouts
 * Create payout
 * @permission commissions:payout
 */
router.post('/venues/:venueId/payouts', checkPermission('commissions:payout'), controller.createPayout)

/**
 * POST /venues/:venueId/payouts/:payoutId/approve
 * Approve payout
 * @permission commissions:payout
 */
router.post('/venues/:venueId/payouts/:payoutId/approve', checkPermission('commissions:payout'), controller.approvePayout)

/**
 * POST /venues/:venueId/payouts/:payoutId/process
 * Start processing payout
 * @permission commissions:payout
 */
router.post('/venues/:venueId/payouts/:payoutId/process', checkPermission('commissions:payout'), controller.startPayoutProcessing)

/**
 * POST /venues/:venueId/payouts/:payoutId/complete
 * Complete payout
 * @permission commissions:payout
 */
router.post('/venues/:venueId/payouts/:payoutId/complete', checkPermission('commissions:payout'), controller.completePayout)

/**
 * POST /venues/:venueId/payouts/:payoutId/fail
 * Mark payout as failed
 * @permission commissions:payout
 */
router.post('/venues/:venueId/payouts/:payoutId/fail', checkPermission('commissions:payout'), controller.failPayout)

/**
 * POST /venues/:venueId/payouts/:payoutId/cancel
 * Cancel payout
 * @permission commissions:payout
 */
router.post('/venues/:venueId/payouts/:payoutId/cancel', checkPermission('commissions:payout'), controller.cancelPayout)

// ==========================================
// CLAWBACKS
// Routes: /api/v1/dashboard/commissions/venues/:venueId/clawbacks
// ==========================================

/**
 * GET /venues/:venueId/clawbacks
 * Get all clawbacks
 * @permission commissions:read
 */
router.get('/venues/:venueId/clawbacks', checkPermission('commissions:read'), controller.getClawbacks)

/**
 * GET /venues/:venueId/clawbacks/stats
 * Get clawback stats
 * @permission commissions:read
 */
router.get('/venues/:venueId/clawbacks/stats', checkPermission('commissions:read'), controller.getClawbackStats)

/**
 * GET /venues/:venueId/clawbacks/:clawbackId
 * Get single clawback
 * @permission commissions:read
 */
router.get('/venues/:venueId/clawbacks/:clawbackId', checkPermission('commissions:read'), controller.getClawbackById)

/**
 * GET /venues/:venueId/staff/:staffId/pending-clawbacks
 * Get pending clawbacks for staff
 * @permission commissions:read
 */
router.get('/venues/:venueId/staff/:staffId/pending-clawbacks', checkPermission('commissions:read'), controller.getPendingClawbacksForStaff)

/**
 * POST /venues/:venueId/calculations/:calculationId/clawback
 * Create clawback
 * @permission commissions:update
 */
router.post('/venues/:venueId/calculations/:calculationId/clawback', checkPermission('commissions:update'), controller.createClawback)

/**
 * DELETE /venues/:venueId/clawbacks/:clawbackId
 * Void clawback
 * @permission commissions:update
 */
router.delete('/venues/:venueId/clawbacks/:clawbackId', checkPermission('commissions:update'), controller.voidClawback)

// ==========================================
// AGGREGATION JOB (OWNER ONLY)
// Routes: /api/v1/dashboard/commissions/venues/:venueId/job
// ==========================================

/**
 * GET /venues/:venueId/job-status
 * Get aggregation job status
 * @permission commissions:payout
 */
router.get('/venues/:venueId/job-status', checkPermission('commissions:payout'), controller.getJobStatus)

/**
 * POST /venues/:venueId/run-job
 * Manually trigger aggregation job
 * @permission commissions:payout
 */
router.post('/venues/:venueId/run-job', checkPermission('commissions:payout'), controller.runAggregationJob)

// ==========================================
// SALES GOALS
// Routes: /api/v1/dashboard/commissions/venues/:venueId/goals
// ==========================================

/**
 * GET /venues/:venueId/goals
 * List all sales goals for a venue
 * @permission commissions:read
 */
router.get('/venues/:venueId/goals', checkPermission('commissions:read'), controller.getSalesGoals)

/**
 * GET /venues/:venueId/goals/:goalId
 * Get single sales goal
 * @permission commissions:read
 */
router.get('/venues/:venueId/goals/:goalId', checkPermission('commissions:read'), controller.getSalesGoalById)

/**
 * POST /venues/:venueId/goals
 * Create a new sales goal
 * @permission commissions:create
 */
router.post('/venues/:venueId/goals', checkPermission('commissions:create'), controller.createSalesGoal)

/**
 * PATCH /venues/:venueId/goals/:goalId
 * Update a sales goal
 * @permission commissions:update
 */
router.patch('/venues/:venueId/goals/:goalId', checkPermission('commissions:update'), controller.updateSalesGoal)

/**
 * DELETE /venues/:venueId/goals/:goalId
 * Delete a sales goal
 * @permission commissions:delete
 */
router.delete('/venues/:venueId/goals/:goalId', checkPermission('commissions:delete'), controller.deleteSalesGoal)

export default router
