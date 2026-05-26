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
import { logAction } from '@/services/dashboard/activity-log.service'

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

/**
 * DELETE /api/v1/dashboard/superadmin/ecommerce-merchants/:id
 *
 * Borra un canal e-commerce SÓLO si no tiene historial (pagos, sesiones de
 * checkout, links de pago ni reservaciones). Si lo tiene, devuelve 400 con el
 * detalle. Pensado para el flujo de borrado guiado de un payment provider.
 */
export async function deleteEcommerceMerchant(req: Request, res: Response) {
  try {
    const { id } = req.params
    const merchant = await prisma.ecommerceMerchant.findUnique({
      where: { id },
      include: {
        _count: {
          select: { checkoutSessions: true, paymentLinks: true, payments: true, reservations: true },
        },
      },
    })
    if (!merchant) {
      res.status(404).json({ success: false, error: 'Ecommerce merchant not found' })
      return
    }
    const c = merchant._count
    const blockers: string[] = []
    if (c.payments > 0) blockers.push(`${c.payments} pago(s)`)
    if (c.checkoutSessions > 0) blockers.push(`${c.checkoutSessions} sesión(es) de checkout`)
    if (c.paymentLinks > 0) blockers.push(`${c.paymentLinks} link(s) de pago`)
    if (c.reservations > 0) blockers.push(`${c.reservations} reservación(es)`)
    if (blockers.length > 0) {
      res.status(400).json({
        success: false,
        error: `No se puede borrar el canal e-commerce: tiene ${blockers.join(', ')}. Sólo se puede borrar uno sin historial.`,
      })
      return
    }
    await prisma.ecommerceMerchant.delete({ where: { id } })
    await logAction({
      // El staff id vive en req.authContext.userId (req.user.uid es undefined).
      staffId: req.authContext?.userId ?? null,
      action: 'ECOMMERCE_MERCHANT_DELETED',
      entity: 'EcommerceMerchant',
      entityId: id,
      data: { venueId: merchant.venueId, providerId: merchant.providerId },
      ipAddress: req.ip,
      userAgent: req.headers?.['user-agent'],
    })
    logger.warn('Ecommerce merchant deleted via superadmin', { id })
    res.json({ success: true, message: 'Canal e-commerce borrado' })
  } catch (error: any) {
    logger.error('Error deleting ecommerce merchant:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to delete ecommerce merchant',
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
