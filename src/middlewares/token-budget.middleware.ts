import { Request, Response, NextFunction } from 'express'
import { tokenBudgetService } from '@/services/dashboard/token-budget.service'
import logger from '@/config/logger'

/**
 * Token Budget Middleware
 *
 * Attaches token budget status to request and sets response headers
 * for frontend awareness of remaining tokens and any warnings.
 *
 * Headers set:
 * - X-Token-Budget-Available: Total tokens available (free + extra)
 * - X-Token-Budget-Warning: Warning message if in overage or low balance
 * - X-Token-Budget-Free-Remaining: Remaining free tokens this month
 * - X-Token-Budget-Extra-Balance: Purchased token balance
 */
export const tokenBudgetMiddleware = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authContext = (req as any).authContext
    const venueId = authContext?.venueId

    if (!venueId) {
      return next()
    }

    const status = await tokenBudgetService.getBudgetStatus(venueId)

    // Attach to request for use in controllers/services
    ;(req as any).tokenBudget = status

    // Set headers for frontend
    res.setHeader('X-Token-Budget-Available', String(status.totalAvailable))
    res.setHeader('X-Token-Budget-Free-Remaining', String(status.freeTokensRemaining))
    res.setHeader('X-Token-Budget-Extra-Balance', String(status.extraTokensBalance))

    if (status.warning) {
      res.setHeader('X-Token-Budget-Warning', status.warning)
    }

    // Log if budget is low or in overage
    if (status.isInOverage) {
      logger.warn('Venue in token overage', {
        venueId,
        overageTokens: status.overageTokensUsed,
        overageCost: status.overageCost,
      })
    } else if (status.percentageUsed >= 80) {
      logger.info('Venue token budget running low', {
        venueId,
        percentageUsed: status.percentageUsed,
        remaining: status.totalAvailable,
      })
    }

    next()
  } catch (error) {
    // Don't block the request if budget check fails
    logger.error('Token budget middleware error', { error })
    next()
  }
}

/**
 * Token Budget Check Middleware (Pre-flight)
 *
 * Use this BEFORE expensive operations to warn users about budget status.
 * Does NOT block requests (soft limit approach).
 */
export const tokenBudgetCheckMiddleware = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authContext = (req as any).authContext
    const venueId = authContext?.venueId

    if (!venueId) {
      return next()
    }

    // Estimate tokens for this request (conservative estimate)
    const estimatedTokens = 5000 // Average complex query

    const checkResult = await tokenBudgetService.checkTokensAvailable(venueId, estimatedTokens)

    // Attach check result to request
    ;(req as any).tokenBudgetCheck = checkResult

    // Set warning header if applicable
    if (checkResult.warning) {
      res.setHeader('X-Token-Budget-Warning', checkResult.warning)
    }

    // Always allow (soft limit) - just log warnings
    if (!checkResult.allowed) {
      logger.warn('Token budget exceeded, allowing with overage', {
        venueId,
        estimatedTokens,
        warning: checkResult.warning,
      })
    }

    next()
  } catch (error) {
    logger.error('Token budget check middleware error', { error })
    next()
  }
}
