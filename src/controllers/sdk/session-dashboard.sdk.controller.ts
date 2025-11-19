/**
 * Session Dashboard Controller - Development Tool
 *
 * Provides endpoints for viewing and managing checkout sessions during development.
 *
 * ⚠️ DEVELOPMENT ONLY: These endpoints should NOT be exposed in production.
 *
 * Features:
 * - List all sessions with filters
 * - View session details
 * - Reset failed sessions
 * - Manually expire sessions
 * - Clear old test sessions
 *
 * @module controllers/sdk/session-dashboard
 */

import { Request, Response } from 'express'
import logger from '@/config/logger'
import { BadRequestError, NotFoundError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'
import { CheckoutStatus } from '@prisma/client'

/**
 * Get all checkout sessions with optional filters
 *
 * Query params:
 * - status: Filter by status (PENDING, PROCESSING, COMPLETED, FAILED, EXPIRED)
 * - merchantId: Filter by ecommerce merchant
 * - limit: Number of sessions to return (default: 50)
 * - offset: Pagination offset (default: 0)
 *
 * @route GET /api/v1/sdk/dashboard/sessions
 */
export async function listSessions(req: Request, res: Response) {
  try {
    const { status, merchantId, limit = '50', offset = '0' } = req.query

    logger.info('📊 [SESSION-DASHBOARD] Listing checkout sessions', {
      status,
      merchantId,
      limit,
      offset,
    })

    // Build filters
    const where: any = {}

    if (status) {
      where.status = status as CheckoutStatus
    }

    if (merchantId) {
      where.ecommerceMerchantId = merchantId as string
    }

    // Fetch sessions
    const [sessions, total] = await Promise.all([
      prisma.checkoutSession.findMany({
        where,
        include: {
          ecommerceMerchant: {
            select: {
              id: true,
              sandboxMode: true,
              venue: {
                select: {
                  name: true,
                },
              },
            },
          },
        },
        orderBy: {
          createdAt: 'desc',
        },
        take: parseInt(limit as string),
        skip: parseInt(offset as string),
      }),
      prisma.checkoutSession.count({ where }),
    ])

    // Calculate stats
    const stats = await prisma.checkoutSession.groupBy({
      by: ['status'],
      _count: true,
    })

    const statusCounts = stats.reduce(
      (acc, stat) => {
        acc[stat.status] = stat._count
        return acc
      },
      {} as Record<string, number>,
    )

    res.status(200).json({
      success: true,
      sessions: sessions.map(session => ({
        id: session.id,
        sessionId: session.sessionId,
        status: session.status,
        amount: session.amount,
        currency: session.currency,
        description: session.description,
        customerEmail: session.customerEmail,
        merchant: session.ecommerceMerchant,
        createdAt: session.createdAt,
        completedAt: session.completedAt,
        failedAt: session.failedAt,
        expiresAt: session.expiresAt,
        errorMessage: session.errorMessage,
        metadata: session.metadata,
      })),
      pagination: {
        total,
        limit: parseInt(limit as string),
        offset: parseInt(offset as string),
        hasMore: parseInt(offset as string) + sessions.length < total,
      },
      stats: {
        total,
        byStatus: statusCounts,
      },
    })
  } catch (error: any) {
    logger.error('❌ [SESSION-DASHBOARD] Failed to list sessions', {
      error: error.message,
    })

    res.status(500).json({
      success: false,
      error: error.message || 'Failed to list sessions',
    })
  }
}

/**
 * Get single session details
 *
 * @route GET /api/v1/sdk/dashboard/sessions/:sessionId
 */
export async function getSessionDetails(req: Request, res: Response) {
  try {
    const { sessionId } = req.params

    logger.info('📋 [SESSION-DASHBOARD] Getting session details', {
      sessionId,
    })

    const session = await prisma.checkoutSession.findUnique({
      where: { sessionId },
      include: {
        ecommerceMerchant: {
          include: {
            provider: true,
          },
        },
      },
    })

    if (!session) {
      throw new NotFoundError('Checkout session not found')
    }

    res.status(200).json({
      success: true,
      session: {
        ...session,
        // Don't expose sensitive credentials
        ecommerceMerchant: {
          ...session.ecommerceMerchant,
          providerCredentials: '***REDACTED***',
        },
      },
    })
  } catch (error: any) {
    logger.error('❌ [SESSION-DASHBOARD] Failed to get session details', {
      sessionId: req.params.sessionId,
      error: error.message,
    })

    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to get session details',
    })
  }
}

/**
 * Reset session to PENDING (for retrying failed payments)
 *
 * @route POST /api/v1/sdk/dashboard/sessions/:sessionId/reset
 */
export async function resetSession(req: Request, res: Response) {
  try {
    const { sessionId } = req.params

    logger.info('🔄 [SESSION-DASHBOARD] Resetting session', {
      sessionId,
    })

    const session = await prisma.checkoutSession.findUnique({
      where: { sessionId },
    })

    if (!session) {
      throw new NotFoundError('Checkout session not found')
    }

    // Only allow resetting FAILED or EXPIRED sessions
    if (session.status !== CheckoutStatus.FAILED && session.status !== CheckoutStatus.EXPIRED) {
      throw new BadRequestError(`Cannot reset session with status: ${session.status}`)
    }

    // Reset session
    const updated = await prisma.checkoutSession.update({
      where: { sessionId },
      data: {
        status: CheckoutStatus.PENDING,
        errorMessage: null,
        failedAt: null,
        completedAt: null,
        metadata: {
          ...(session.metadata as any),
          resetAt: new Date().toISOString(),
          previousStatus: session.status,
        },
      },
    })

    logger.info('✅ [SESSION-DASHBOARD] Session reset successfully', {
      sessionId,
      previousStatus: session.status,
    })

    res.status(200).json({
      success: true,
      session: updated,
      message: `Session reset from ${session.status} to PENDING`,
    })
  } catch (error: any) {
    logger.error('❌ [SESSION-DASHBOARD] Failed to reset session', {
      sessionId: req.params.sessionId,
      error: error.message,
    })

    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to reset session',
    })
  }
}

/**
 * Manually expire a session
 *
 * @route POST /api/v1/sdk/dashboard/sessions/:sessionId/expire
 */
export async function expireSession(req: Request, res: Response) {
  try {
    const { sessionId } = req.params

    logger.info('⏰ [SESSION-DASHBOARD] Expiring session', {
      sessionId,
    })

    const session = await prisma.checkoutSession.findUnique({
      where: { sessionId },
    })

    if (!session) {
      throw new NotFoundError('Checkout session not found')
    }

    // Only allow expiring PENDING or PROCESSING sessions
    if (session.status === CheckoutStatus.COMPLETED) {
      throw new BadRequestError('Cannot expire a completed session')
    }

    if (session.status === CheckoutStatus.EXPIRED) {
      throw new BadRequestError('Session is already expired')
    }

    // Expire session
    const updated = await prisma.checkoutSession.update({
      where: { sessionId },
      data: {
        status: CheckoutStatus.EXPIRED,
        expiresAt: new Date(), // Set to now
        metadata: {
          ...(session.metadata as any),
          manuallyExpiredAt: new Date().toISOString(),
          previousStatus: session.status,
        },
      },
    })

    logger.info('✅ [SESSION-DASHBOARD] Session expired successfully', {
      sessionId,
      previousStatus: session.status,
    })

    res.status(200).json({
      success: true,
      session: updated,
      message: `Session expired from ${session.status}`,
    })
  } catch (error: any) {
    logger.error('❌ [SESSION-DASHBOARD] Failed to expire session', {
      sessionId: req.params.sessionId,
      error: error.message,
    })

    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to expire session',
    })
  }
}

/**
 * Delete old test sessions
 *
 * Query params:
 * - olderThan: Delete sessions older than X hours (default: 24)
 * - status: Only delete sessions with specific status (optional)
 *
 * @route DELETE /api/v1/sdk/dashboard/sessions/cleanup
 */
export async function cleanupSessions(req: Request, res: Response) {
  try {
    const { olderThan = '24', status } = req.query

    const hoursAgo = parseInt(olderThan as string)
    const cutoffDate = new Date(Date.now() - hoursAgo * 60 * 60 * 1000)

    logger.info('🗑️  [SESSION-DASHBOARD] Cleaning up old sessions', {
      olderThan: hoursAgo,
      cutoffDate,
      status,
    })

    // Build where clause
    const where: any = {
      createdAt: {
        lt: cutoffDate,
      },
    }

    if (status) {
      where.status = status as CheckoutStatus
    }

    // Delete sessions
    const result = await prisma.checkoutSession.deleteMany({
      where,
    })

    logger.info('✅ [SESSION-DASHBOARD] Cleanup completed', {
      deleted: result.count,
    })

    res.status(200).json({
      success: true,
      deleted: result.count,
      message: `Deleted ${result.count} sessions older than ${hoursAgo} hours`,
    })
  } catch (error: any) {
    logger.error('❌ [SESSION-DASHBOARD] Failed to cleanup sessions', {
      error: error.message,
    })

    res.status(500).json({
      success: false,
      error: error.message || 'Failed to cleanup sessions',
    })
  }
}

/**
 * Get dashboard statistics
 *
 * @route GET /api/v1/sdk/dashboard/stats
 */
export async function getDashboardStats(req: Request, res: Response) {
  try {
    logger.info('📈 [SESSION-DASHBOARD] Getting dashboard stats')

    // Get counts by status
    const statusCounts = await prisma.checkoutSession.groupBy({
      by: ['status'],
      _count: true,
    })

    // Get recent activity (last 24 hours)
    const last24Hours = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const recentSessions = await prisma.checkoutSession.count({
      where: {
        createdAt: {
          gte: last24Hours,
        },
      },
    })

    // Get success rate (completed vs total non-pending)
    const completedCount = await prisma.checkoutSession.count({
      where: { status: CheckoutStatus.COMPLETED },
    })

    const failedCount = await prisma.checkoutSession.count({
      where: { status: CheckoutStatus.FAILED },
    })

    const successRate = completedCount + failedCount > 0 ? (completedCount / (completedCount + failedCount)) * 100 : 0

    // Get merchants
    const merchants = await prisma.ecommerceMerchant.findMany({
      select: {
        id: true,
        sandboxMode: true,
        venue: {
          select: {
            name: true,
          },
        },
        _count: {
          select: {
            checkoutSessions: true,
          },
        },
      },
    })

    res.status(200).json({
      success: true,
      stats: {
        byStatus: statusCounts.reduce(
          (acc, stat) => {
            acc[stat.status] = stat._count
            return acc
          },
          {} as Record<string, number>,
        ),
        recentActivity: recentSessions,
        successRate: Math.round(successRate * 100) / 100,
        merchants: merchants.map(m => ({
          id: m.id,
          name: m.venue.name,
          sandboxMode: m.sandboxMode,
          sessionCount: m._count.checkoutSessions,
        })),
      },
    })
  } catch (error: any) {
    logger.error('❌ [SESSION-DASHBOARD] Failed to get stats', {
      error: error.message,
    })

    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get dashboard stats',
    })
  }
}
