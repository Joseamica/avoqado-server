import { Router } from 'express'
import * as paymentAnalyticsController from '../../controllers/superadmin/paymentAnalytics.controller'

const router = Router()

/**
 * PaymentAnalytics Routes
 * Base path: /api/v1/superadmin/payment-analytics
 *
 * All routes require SUPERADMIN role (enforced by parent router middleware)
 */

// GET /api/v1/superadmin/payment-analytics/profit-metrics
// Query params: ?startDate=2024-01-01&endDate=2024-12-31
router.get('/profit-metrics', paymentAnalyticsController.getProfitMetrics)

// GET /api/v1/superadmin/payment-analytics/venue/:venueId
// Query params: ?startDate=2024-01-01&endDate=2024-12-31
router.get('/venue/:venueId', paymentAnalyticsController.getVenueProfitMetrics)

// GET /api/v1/superadmin/payment-analytics/time-series
// Query params: ?startDate=2024-01-01&endDate=2024-12-31&granularity=daily
router.get('/time-series', paymentAnalyticsController.getProfitTimeSeries)

// GET /api/v1/superadmin/payment-analytics/provider-comparison
// Query params: ?startDate=2024-01-01&endDate=2024-12-31
router.get('/provider-comparison', paymentAnalyticsController.getProviderComparison)

// GET /api/v1/superadmin/payment-analytics/export
// Query params: ?startDate=2024-01-01&endDate=2024-12-31&format=json
router.get('/export', paymentAnalyticsController.exportProfitData)

export default router
