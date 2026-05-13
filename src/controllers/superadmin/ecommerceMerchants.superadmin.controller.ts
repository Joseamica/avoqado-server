/**
 * Cross-venue e-commerce merchants listing for SUPERADMIN.
 *
 * Mounted at GET /api/v1/dashboard/superadmin/ecommerce-merchants. Auth +
 * permission (`system:manage`) are enforced by the parent superadmin router.
 *
 * Returns every EcommerceMerchant across every venue with the columns the
 * Superadmin dashboard needs to manage Avoqado's fee + revenue:
 *   - venue: id, name, slug
 *   - provider: code, name
 *   - status: onboardingStatus, chargesEnabled, active
 *   - revenue: paymentCount, totalCollected (aggregated from CheckoutSession)
 *   - fee: platformFeeBps
 *
 * @module controllers/superadmin/ecommerceMerchants.superadmin
 */

import { Request, Response } from 'express'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'

/**
 * GET /api/v1/dashboard/superadmin/ecommerce-merchants/:id/fee-history
 *
 * Returns the chronological history of platform-fee changes for a single
 * EcommerceMerchant. Sourced from `ActivityLog` rows logged whenever
 * `updatePlatformFeeBps` runs — see ecommerceMerchant.service.ts.
 *
 * Returned shape (per row):
 *   { id, oldFeeBps, newFeeBps, staff: { id, firstName, lastName }|null, createdAt }
 *
 * Newest first. Caps at 100 rows — fee changes are infrequent enough that
 * pagination here is YAGNI.
 */
export async function getMerchantFeeHistory(req: Request, res: Response) {
  try {
    const { id } = req.params

    const events = await prisma.activityLog.findMany({
      where: {
        action: 'ECOMMERCE_MERCHANT_PLATFORM_FEE_UPDATED',
        entity: 'EcommerceMerchant',
        entityId: id,
      },
      include: {
        staff: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })

    const history = events.map(e => {
      const data = (e.data ?? {}) as { oldFeeBps?: number; newFeeBps?: number }
      return {
        id: e.id,
        oldFeeBps: data.oldFeeBps ?? null,
        newFeeBps: data.newFeeBps ?? null,
        staff: e.staff,
        createdAt: e.createdAt,
      }
    })

    res.json({ success: true, data: history, meta: { count: history.length } })
  } catch (error: any) {
    logger.error('Error fetching merchant fee history:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to fetch fee history',
    })
  }
}

export async function listAllEcommerceMerchants(_req: Request, res: Response) {
  try {
    const merchants = await prisma.ecommerceMerchant.findMany({
      include: {
        venue: { select: { id: true, name: true, slug: true } },
        provider: { select: { code: true, name: true } },
      },
      orderBy: [{ active: 'desc' }, { createdAt: 'desc' }],
    })

    // Aggregate revenue per merchant. groupBy on CheckoutSession is fast even
    // at scale because (ecommerceMerchantId, status) is indexed.
    const aggregates = await prisma.checkoutSession.groupBy({
      by: ['ecommerceMerchantId'],
      where: { status: 'COMPLETED' },
      _count: { _all: true },
      _sum: { amount: true },
    })
    const aggByMerchant = new Map(
      aggregates.map(a => [a.ecommerceMerchantId, { paymentCount: a._count._all, totalCollected: a._sum.amount }]),
    )

    const enriched = merchants.map(m => {
      const agg = aggByMerchant.get(m.id)
      return {
        id: m.id,
        channelName: m.channelName,
        businessName: m.businessName,
        contactEmail: m.contactEmail,
        active: m.active,
        sandboxMode: m.sandboxMode,
        onboardingStatus: m.onboardingStatus,
        chargesEnabled: m.chargesEnabled,
        platformFeeBps: m.platformFeeBps,
        venue: m.venue,
        provider: m.provider,
        paymentCount: agg?.paymentCount ?? 0,
        totalCollected: agg?.totalCollected?.toString() ?? '0',
        createdAt: m.createdAt,
      }
    })

    res.json({ success: true, data: enriched, meta: { count: enriched.length } })
  } catch (error: any) {
    logger.error('Error listing all e-commerce merchants:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to list e-commerce merchants',
    })
  }
}
